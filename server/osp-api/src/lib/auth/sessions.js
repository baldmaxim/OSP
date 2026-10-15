// Сессии своего входа (osp_session.sessions). В cookie — случайный id (32 байта), в базе — только его sha256:
// ни копия базы, ни журнал не дают войти чужой сессией. id не пишется ни в журнал, ни в ответы.
//
// Сроки: без активности — idleMs (14 дней), в любом случае — absoluteMs (30 дней). Вход и смена пароля выдают
// новый id. Отзыв: выход, «выйти везде», смена и сброс пароля (той же транзакцией), блокировка и снятие
// одобрения (триггер базы), удаление учётки (каскад).
//
// Поиск сессии кэшируется в памяти не дольше cacheMs (5 с): отзыв из другой службы или триггером действует не
// позже чем через 5 с; отзыв в этой службе — сразу. last_used_at пишется не чаще раза в touchMs (минуту).
import { createHash, randomBytes } from 'node:crypto'

const DAY = 24 * 60 * 60 * 1000
export const SESSION_DEFAULTS = { idleMs: 14 * DAY, absoluteMs: 30 * DAY, cacheMs: 5000, touchMs: 60_000, maxEntries: 5000 }

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')

export function createSessions({ db, now = Date.now, idleMs = SESSION_DEFAULTS.idleMs, absoluteMs = SESSION_DEFAULTS.absoluteMs,
  cacheMs = SESSION_DEFAULTS.cacheMs, touchMs = SESSION_DEFAULTS.touchMs, maxEntries = SESSION_DEFAULTS.maxEntries, logger = null } = {}) {
  if (!db) throw new Error('osp-api: сессии своего входа хранятся в базе — подключение не задано')
  if (!(idleMs > 0 && absoluteMs >= idleMs)) throw new Error('osp-api: срок сессии без активности должен быть не больше общего')
  const cache = new Map() // id_hash → { value, at }

  // Внутри транзакции вызывающего (отметка internal уже стоит). → { token, csrf, maxAgeSec }
  async function createInTx(tx, { userId, mustChange = false }) {
    const token = newToken()
    const csrf = randomBytes(24).toString('base64url')
    const t = now()
    const absolute = new Date(t + absoluteMs)
    await tx.query(`insert into osp_session.sessions (id_hash, user_id, csrf, must_change, created_at, last_used_at, idle_expires_at, absolute_expires_at)
      values ($1, $2, $3, $4, $5, $5, $6, $7)`, [tokenHash(token), userId, csrf, mustChange, new Date(t), new Date(Math.min(t + idleMs, absolute.getTime())), absolute])
    return { token, csrf, maxAgeSec: Math.floor(absoluteMs / 1000) }
  }

  // → { idHash, userId, email, csrf, mustChange } | null (нет, отозвана, истекла)
  async function lookup(token) {
    const idHash = tokenHash(token)
    const hit = cache.get(idHash)
    const t = now()
    if (hit && t - hit.at < cacheMs) return valid(hit.value, t)
    const row = await db.read(null, async (tx) => {
      const { rows } = await tx.query(`select s.user_id, u.email, s.csrf, s.must_change, s.last_used_at, s.idle_expires_at,
          s.absolute_expires_at, s.revoked_at
        from osp_session.sessions s join auth.users u on u.id = s.user_id where s.id_hash = $1`, [idHash])
      return rows[0] || null
    })
    const value = row ? {
      idHash, userId: row.user_id, email: row.email || '', csrf: row.csrf, mustChange: row.must_change,
      lastUsedAt: new Date(row.last_used_at).getTime(), idleExpiresAt: new Date(row.idle_expires_at).getTime(),
      absoluteExpiresAt: new Date(row.absolute_expires_at).getTime(), revoked: Boolean(row.revoked_at),
    } : null
    cache.delete(idHash)
    cache.set(idHash, { value, at: t })
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    const live = valid(value, t)
    if (live && t - value.lastUsedAt >= touchMs) touch(value, t)
    return live
  }

  function valid(value, t) {
    if (!value || value.revoked || t >= value.idleExpiresAt || t >= value.absoluteExpiresAt) return null
    return { idHash: value.idHash, userId: value.userId, email: value.email, csrf: value.csrf, mustChange: value.mustChange }
  }

  // Продление «без активности» — в фоне: сбой записи не мешает запросу, просто продлится в следующий раз.
  function touch(value, t) {
    value.lastUsedAt = t
    const idle = Math.min(t + idleMs, value.absoluteExpiresAt)
    value.idleExpiresAt = idle
    db.write(null, (tx) => tx.query(`update osp_session.sessions set last_used_at = $2, idle_expires_at = $3
      where id_hash = $1 and revoked_at is null`, [value.idHash, new Date(t), new Date(idle)]))
      .catch((err) => logger?.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'session touch'))
  }

  // Отзыв одной сессии (выход). Внутри своей транзакции.
  async function revoke(token, reason = 'logout') {
    const idHash = tokenHash(token)
    cache.delete(idHash)
    await db.write(null, (tx) => tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2
      where id_hash = $1 and revoked_at is null`, [idHash, reason]))
  }

  // Отзыв всех сессий пользователя, кроме keepHash, — внутри транзакции вызывающего (отметка internal).
  async function revokeAllInTx(tx, userId, reason, keepHash = null) {
    for (const [hash, entry] of cache) if (entry.value?.userId === userId && hash !== keepHash) cache.delete(hash)
    await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2
      where user_id = $1 and revoked_at is null and ($3::text is null or id_hash <> $3)`, [userId, reason, keepHash])
  }

  return { createInTx, lookup, revoke, revokeAllInTx, forget: (idHash) => cache.delete(idHash), size: () => cache.size }
}
