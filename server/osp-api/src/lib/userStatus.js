// Статус учётки вошедшего (строка user_roles) — из базы, с коротким кэшем.
//
// Токен живёт до часа и сам о блокировке не знает. Поэтому на каждом запросе проверяется статус:
// одобрен, не заблокирован, роль, организация. Чтобы не ходить в базу на каждый запрос, статус
// хранится в памяти не дольше ttlMs (предел — минута): блокировка, отзыв одобрения и удаление
// учётки начинают действовать не позже чем через это время.
//   • одновременные запросы одного пользователя ждут одно чтение, а не делают несколько;
//   • сбой базы не кэшируется и не превращается в «прав нет»: вызывающий отвечает 503;
//   • записей не больше maxEntries: старые вытесняются.
// Читает служебная операция (без пользователя): строка нужна до того, как известны его права.
export const STATUS_TTL_MAX_MS = 60_000
export const STATUS_DEFAULTS = { ttlMs: 30_000, maxEntries: 2000 }

const QUERY = `select role, counterparty_id, is_approved, is_blocked, full_name
  from public.user_roles where user_id = $1 limit 2`

export function createUserStatus({ db, ttlMs = STATUS_DEFAULTS.ttlMs, maxEntries = STATUS_DEFAULTS.maxEntries, now = Date.now }) {
  if (!db) throw new Error('osp-api: статус учётки читается из базы — подключение не задано')
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > STATUS_TTL_MAX_MS) {
    throw new Error(`osp-api: статус учётки хранится не дольше ${STATUS_TTL_MAX_MS / 1000} с`)
  }
  const cache = new Map() // userId → { row, at }; порядок — по времени чтения
  const pending = new Map() // userId → чтение, которое уже идёт

  // Строк должно быть ровно одна: нет строки или их несколько — статуса нет (отказ).
  const load = (userId) => db.read(null, async (tx) => {
    const { rows } = await tx.query(QUERY, [userId])
    return rows.length === 1 ? rows[0] : null
  })

  function get(userId) {
    const hit = cache.get(userId)
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.row)
    let reading = pending.get(userId)
    if (!reading) {
      reading = load(userId).then((row) => {
        cache.delete(userId)
        cache.set(userId, { row, at: now() })
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
        return row
      }).finally(() => pending.delete(userId))
      pending.set(userId, reading)
    }
    return reading
  }

  return { get, forget: (userId) => cache.delete(userId), size: () => cache.size }
}
