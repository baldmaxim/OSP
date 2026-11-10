// Сессии своего входа (osp_session.sessions). В cookie — случайный id (32 байта), в базе — только его sha256:
// ни копия базы, ни журнал не дают войти чужой сессией. id не пишется ни в журнал, ни в ответы.
//
// Два вида (auth_source, миграция 20270112):
//   password — вход паролем ОСП (AUTH_MODE own | both). Сроки: без активности — idleMs (14 дней), всего — absoluteMs (30);
//              продлевается любым запросом, не чаще раза в touchMs (10 минут) — как было;
//   keycloak — вход через СУ-10 (AUTH_MODE keycloak). Без действий — не больше kcIdleMs (48 ч, как SSO контура), всего —
//              absoluteMs. Продлевает только действие пользователя (activity: заголовок X-OSP-Activity, src/lib/principal.js),
//              не чаще раза в activityMs: брошенная вкладка с опросом таблиц сессию не держит. Токены Keycloak (refresh,
//              id_token) — шифром ключа сервера, AAD — «kc:<id_hash>»: строку одной сессии нельзя переставить другой.
//              Отзыв затирает их триггером базы, каким бы путём ни отзывали.
//
// Вход и смена пароля выдают новый id. Отзыв: выход, «выйти везде», смена и сброс пароля (той же транзакцией),
// блокировка и снятие одобрения (триггер базы), удаление учётки (каскад), перепроверка и сверка СУ-10.
//
// Поиск сессии кэшируется в памяти не дольше cacheMs (5 с): отзыв из другой службы или триггером действует не позже чем
// через 5 с; отзыв в этой службе — сразу. Токены Keycloak в память не попадают: их читает только перепроверка.
//
// Поиск не продлевает сессию сам: продление зависит от вида сессии и запроса, решает src/lib/principal.js.
// База без миграции 20270112 (служба выложена раньше миграции): все сессии — парольные, как раньше.
import { createHash, randomBytes } from 'node:crypto'

const DAY = 24 * 60 * 60 * 1000
export const SESSION_DEFAULTS = {
  idleMs: 14 * DAY, absoluteMs: 30 * DAY, kcIdleMs: 2 * DAY,
  cacheMs: 5000, touchMs: 10 * 60_000, activityMs: 60_000, maxEntries: 5000,
}
const UNDEFINED_COLUMN = '42703'

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex')
export const kcAad = (idHash) => `kc:${idHash}`
const newToken = () => randomBytes(32).toString('base64url')
const ms = (v) => (v == null ? null : new Date(v).getTime())

const SELECT_FULL = `select s.user_id, u.email, s.csrf, s.must_change, s.created_at, s.last_used_at, s.idle_expires_at,
    s.absolute_expires_at, s.revoked_at, s.auth_source, s.kc_issuer, s.kc_subject, s.kc_checked_at, s.kc_retry_after,
    s.last_activity_at
  from osp_session.sessions s join auth.users u on u.id = s.user_id where s.id_hash = $1`
const SELECT_LEGACY = `select s.user_id, u.email, s.csrf, s.must_change, s.created_at, s.last_used_at, s.idle_expires_at,
    s.absolute_expires_at, s.revoked_at
  from osp_session.sessions s join auth.users u on u.id = s.user_id where s.id_hash = $1`

export function createSessions({ db, box = null, now = Date.now, idleMs = SESSION_DEFAULTS.idleMs, absoluteMs = SESSION_DEFAULTS.absoluteMs,
  kcIdleMs = SESSION_DEFAULTS.kcIdleMs, cacheMs = SESSION_DEFAULTS.cacheMs, touchMs = SESSION_DEFAULTS.touchMs,
  activityMs = SESSION_DEFAULTS.activityMs, maxEntries = SESSION_DEFAULTS.maxEntries, logger = null } = {}) {
  if (!db) throw new Error('osp-api: сессии своего входа хранятся в базе — подключение не задано')
  if (!(idleMs > 0 && absoluteMs >= idleMs)) throw new Error('osp-api: срок сессии без активности должен быть не больше общего')
  const cache = new Map() // id_hash → { value, at }
  // Ненайденные сессии — отдельно и короче: поток случайных cookie не вытесняет из памяти сессии работающих.
  const misses = new Map() // id_hash → at
  const MISS_MAX = 1000
  let legacy = false // в базе ещё нет колонок 20270112
  const kcIdle = Math.min(kcIdleMs, idleMs)

  // Внутри транзакции вызывающего (отметка internal уже стоит). keycloak — { issuer, subject, sid, refreshToken, idToken }.
  // → { token, csrf, maxAgeSec, idHash }
  async function createInTx(tx, { userId, mustChange = false, keycloak = null }) {
    const token = newToken()
    const idHash = tokenHash(token)
    const csrf = randomBytes(24).toString('base64url')
    const t = now()
    const absolute = new Date(t + absoluteMs)
    if (!keycloak) {
      await tx.query(`insert into osp_session.sessions (id_hash, user_id, csrf, must_change, created_at, last_used_at, idle_expires_at, absolute_expires_at)
        values ($1, $2, $3, $4, $5, $5, $6, $7)`, [idHash, userId, csrf, mustChange, new Date(t), new Date(Math.min(t + idleMs, absolute.getTime())), absolute])
    } else {
      if (!box) throw new Error('osp-api: сессии Keycloak без ключа шифрования')
      const aad = kcAad(idHash)
      await tx.query(`insert into osp_session.sessions (id_hash, user_id, csrf, must_change, created_at, last_used_at, idle_expires_at,
          absolute_expires_at, auth_source, kc_issuer, kc_subject, kc_sid, kc_refresh_enc, kc_id_token_enc, kc_checked_at, last_activity_at)
        values ($1, $2, $3, false, $4, $4, $5, $6, 'keycloak', $7, $8, $9, $10, $11, $4, $4)`,
      [idHash, userId, csrf, new Date(t), new Date(Math.min(t + kcIdle, absolute.getTime())), absolute,
        keycloak.issuer, keycloak.subject, keycloak.sid || null, box.encrypt(keycloak.refreshToken, aad),
        keycloak.idToken ? box.encrypt(keycloak.idToken, aad) : null])
    }
    return { token, csrf, maxAgeSec: Math.floor(absoluteMs / 1000), idHash }
  }

  // Ошибка запроса обрывает транзакцию: прежний вид читается уже в новой.
  async function readRow(idHash) {
    if (!legacy) {
      try {
        return await db.read(null, async (tx) => (await tx.query(SELECT_FULL, [idHash])).rows[0] || null)
      } catch (err) {
        if (err?.code !== UNDEFINED_COLUMN) throw err
        legacy = true
        logger?.warn({}, 'sessions: в базе нет колонок 20270112 — все сессии парольные (миграция ещё не применена)')
      }
    }
    return db.read(null, async (tx) => (await tx.query(SELECT_LEGACY, [idHash])).rows[0] || null)
  }

  const toValue = (idHash, row) => (row ? {
    idHash, userId: row.user_id, email: row.email || '', csrf: row.csrf, mustChange: row.must_change,
    createdAt: ms(row.created_at), lastUsedAt: ms(row.last_used_at), idleExpiresAt: ms(row.idle_expires_at),
    absoluteExpiresAt: ms(row.absolute_expires_at), revoked: Boolean(row.revoked_at),
    authSource: row.auth_source || 'password', kcIssuer: row.kc_issuer || null, kcSubject: row.kc_subject || null,
    kcCheckedAt: ms(row.kc_checked_at), kcRetryAfter: ms(row.kc_retry_after),
    lastActivityAt: ms(row.last_activity_at) ?? ms(row.created_at),
  } : null)

  // → сессия (см. valid) | null (нет, отозвана, истекла)
  async function lookup(token) {
    const idHash = tokenHash(token)
    const hit = cache.get(idHash)
    const t = now()
    if (hit && t - hit.at < cacheMs) return valid(hit.value, t)
    const missAt = misses.get(idHash)
    if (missAt !== undefined && t - missAt < cacheMs) return null
    const value = toValue(idHash, await readRow(idHash))
    cache.delete(idHash)
    misses.delete(idHash)
    if (value) {
      cache.set(idHash, { value, at: t })
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    } else {
      misses.set(idHash, t)
      while (misses.size > MISS_MAX) misses.delete(misses.keys().next().value)
    }
    return valid(value, t)
  }

  function valid(value, t) {
    if (!value || value.revoked || t >= value.idleExpiresAt || t >= value.absoluteExpiresAt) return null
    return {
      idHash: value.idHash, userId: value.userId, email: value.email, csrf: value.csrf, mustChange: value.mustChange,
      authSource: value.authSource, kcIssuer: value.kcIssuer, kcSubject: value.kcSubject, kcCheckedAt: value.kcCheckedAt,
      kcRetryAfter: value.kcRetryAfter, lastActivityAt: value.lastActivityAt, createdAt: value.createdAt,
    }
  }

  const stored = (session) => cache.get(session.idHash)?.value || null
  const background = (fn, what) => db.write(null, fn)
    .catch((err) => logger?.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, what))

  // Парольная сессия: продление «без активности» любым запросом, в фоне и не чаще раза в touchMs (как было).
  function touch(session) {
    const value = stored(session)
    const t = now()
    if (!value || session.authSource !== 'password' || t - value.lastUsedAt < touchMs) return
    value.lastUsedAt = t
    const idle = Math.min(t + idleMs, value.absoluteExpiresAt)
    value.idleExpiresAt = idle
    background((tx) => tx.query(`update osp_session.sessions set last_used_at = $2, idle_expires_at = $3
      where id_hash = $1 and revoked_at is null`, [value.idHash, new Date(t), new Date(idle)]), 'session touch')
  }

  // Сессия Keycloak: действие пользователя продлевает её на kcIdleMs (не дальше общего срока), не чаще раза в activityMs.
  function activity(session) {
    const value = stored(session)
    const t = now()
    if (!value || session.authSource !== 'keycloak' || t - (value.lastActivityAt ?? 0) < activityMs) return
    value.lastActivityAt = t
    value.lastUsedAt = t
    const idle = Math.min(t + kcIdle, value.absoluteExpiresAt)
    value.idleExpiresAt = idle
    background((tx) => tx.query(`update osp_session.sessions set last_activity_at = $2, last_used_at = $2, idle_expires_at = $3
      where id_hash = $1 and revoked_at is null`, [value.idHash, new Date(t), new Date(idle)]), 'session activity')
  }

  // Перепроверка СУ-10 обновила строку: память — следом, чтобы следующий запрос не перепроверял заново.
  function patch(idHash, fields) {
    const hit = cache.get(idHash)
    if (hit) Object.assign(hit.value, fields)
  }

  // Отзыв одной сессии (выход). Внутри своей транзакции.
  async function revoke(token, reason = 'logout') {
    await revokeHash(tokenHash(token), reason)
  }

  async function revokeHash(idHash, reason) {
    cache.delete(idHash)
    await db.write(null, (tx) => tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2
      where id_hash = $1 and revoked_at is null`, [idHash, reason]))
  }

  // Выход с выходом из СУ-10: id_token нужен для адреса выхода Keycloak — читается до отзыва (отзыв его затирает),
  // одной транзакцией. all — «выйти везде»: все сессии пользователя. → id_token | null
  async function revokeForLogout(token, { all = false, userId = null } = {}) {
    const idHash = tokenHash(token)
    cache.delete(idHash)
    if (all && userId) for (const [hash, entry] of cache) if (entry.value?.userId === userId) cache.delete(hash)
    return db.write(null, async (tx) => {
      let enc = null
      if (!legacy && box) {
        try {
          enc = (await tx.query(`select kc_id_token_enc from osp_session.sessions where id_hash = $1 and revoked_at is null for update`,
            [idHash])).rows[0]?.kc_id_token_enc ?? null
        } catch (err) {
          if (err?.code !== UNDEFINED_COLUMN) throw err
          legacy = true
          throw Object.assign(new Error('retry'), { retryLegacy: true })
        }
      }
      if (all && userId) {
        await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = 'logout_all'
          where user_id = $1 and revoked_at is null`, [userId])
      } else {
        await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = 'logout'
          where id_hash = $1 and revoked_at is null`, [idHash])
      }
      if (!enc) return null
      try { return box.decrypt(enc, kcAad(idHash)) } catch { return null }
    }).catch((err) => (err?.retryLegacy ? revokeForLogout(token, { all, userId }) : Promise.reject(err)))
  }

  // Отзыв всех сессий пользователя, кроме keepHash, — внутри транзакции вызывающего (отметка internal).
  async function revokeAllInTx(tx, userId, reason, keepHash = null) {
    for (const [hash, entry] of cache) if (entry.value?.userId === userId && hash !== keepHash) cache.delete(hash)
    await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2
      where user_id = $1 and revoked_at is null and ($3::text is null or id_hash <> $3)`, [userId, reason, keepHash])
  }

  // Сессии СУ-10 пользователя (доступ отозван в СУ-10, связь снята) — внутри транзакции вызывающего (отметка internal).
  // → сколько отозвано
  async function revokeKeycloakInTx(tx, userId, reason) {
    for (const [hash, entry] of cache) if (entry.value?.userId === userId && entry.value.authSource === 'keycloak') cache.delete(hash)
    const r = await tx.query(`update osp_session.sessions set revoked_at = now(), revoke_reason = $2
      where user_id = $1 and revoked_at is null and auth_source = 'keycloak'`, [userId, reason])
    return r.rowCount
  }

  // Действующая сессия уже в памяти — проверка без обращения к базе (её не задевает лимит неверных cookie).
  function cached(token) {
    const hit = cache.get(tokenHash(token))
    const t = now()
    return Boolean(hit && t - hit.at < cacheMs && valid(hit.value, t))
  }

  return {
    createInTx, lookup, cached, touch, activity, patch, revoke, revokeHash, revokeForLogout, revokeAllInTx, revokeKeycloakInTx,
    forget: (idHash) => cache.delete(idHash), size: () => cache.size, kcIdleMs: kcIdle, isLegacy: () => legacy,
  }
}
