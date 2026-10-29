// Ключи API для смежных систем: «Администрирование» → «Доступ к API» (маршруты — src/routes/apiKeys.js, таблицы —
// migration/yandex/20261111_api_keys.sql). В базе — только sha256 ключа: сам ключ администратор видит один раз, при
// выпуске; восстановить его нельзя, только выпустить новый.
//
// Ключи из RATES_API_KEYS (настройки сервера) действуют как раньше и заносятся в тот же список (source = 'env'):
// права у них — из строки, администратор может их переименовать и отозвать; убранный из строки ключ не действует.
//
// Проверка ключа на запросе к /api/rates/*:
//   • отпечаток есть в базе — решает строка: отозван или удалён — отказ; срок истёк — отказ; ключ из настроек
//     сервера, которого в строке уже нет, — отказ; иначе права строки (у ключа из настроек — права из строки);
//   • в базе отпечатка нет (миграция не применена, служба ещё не занесла ключи из настроек) — ключ из настроек
//     сервера, как до раздела. База не ответила — так же; ключу из портала тогда — 503 (решает вызывающий).
// Журнал вызовов пишется после ответа и его не задерживает; при барьере записи не пишется. В журнал службы — только
// код ошибки базы: в тексте бывают значения (отпечаток ключа в сообщении о нарушении уникальности).
import { createHash, randomBytes } from 'node:crypto'

export const API_RESOURCES = [
  { code: 'kp', label: 'Расценки от подрядчиков (КП)', path: '/api/rates/kp', hint: 'Цены подрядчиков из КП по тендерам ОСП: материалы и работы' },
  { code: 'supply', label: 'Расценки от снабжения СУ-10', path: '/api/rates/supply', hint: 'Цены снабжения по материалам ВОР тендеров' },
  { code: 'larix', label: 'Договорные расценки (Larix)', path: '/api/rates/larix', hint: 'Цены материалов и работ из ВОР договоров Larix.CPM' },
]
export const RESOURCE_CODES = API_RESOURCES.map((r) => r.code)

export const KEY_PREFIX = 'osp_'
// Сколько первых знаков ключа видно в списке: у выпущенного — «osp_» и 8 знаков (48 бит из 256), у ключа из
// настроек сервера — 4 знака (строку на сервере мог задать человек, и ключ бывает короче).
const SHOWN_PORTAL = KEY_PREFIX.length + 8
const SHOWN_ENV = 4
export const CALLS_KEEP_DAYS = 90
// Отказы сохраняются кодом, текст — у интерфейса и в ответе API.
export const REFUSALS = {
  revoked: 'Ключ отозван администратором портала — запросите новый',
  expired: 'Срок действия ключа истёк — запросите новый',
  removed: 'Ключ отключён на сервере — запросите новый',
}
// Нет таблиц (миграция не применена): проверяем снова не раньше чем через 5 минут, без перезапуска.
const MISSING_CODES = new Set(['42P01', '3F000'])
const RECHECK_MS = 5 * 60_000
// Записей журнала в работе одновременно: больше — новые пропускаются (ответ API важнее журнала).
const MAX_PENDING = 20

export const hashKey = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex')
export const newKey = () => KEY_PREFIX + randomBytes(32).toString('base64url')

export class ApiKeyError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}
const NO_DB = () => new ApiKeyError(503, 'OSP_API_KEYS_NO_DB', 'Ключи API хранятся в базе нового портала: у сервера нет подключения к ней (OSP_DB_URL)')
const NO_TABLE = () => new ApiKeyError(503, 'OSP_API_KEYS_MISSING', 'Ключи API ещё не настроены: не применена миграция 20261111_api_keys')
const NOT_FOUND = () => new ApiKeyError(404, 'OSP_API_KEY_NOT_FOUND', 'Ключ не найден — обновите список')

// Строка ключа для списка: без отпечатка. Состояние считает база (срок — по Москве).
const KEY_COLUMNS = `k.id, k.name, k.key_prefix, k.scopes, k.source, k.note, k.expires_on::text as expires_on,
  k.created_at, k.created_by_name, k.updated_at, k.updated_by_name, k.revoked_at, k.revoked_by_name, k.revoke_reason,
  k.env_missing_at, k.last_used_at,
  case when k.revoked_at is not null then 'revoked'
       when k.source = 'env' and k.env_missing_at is not null then 'removed'
       when k.source = 'portal' and k.expires_on < (now() at time zone 'Europe/Moscow')::date then 'expired'
       else 'active' end as status,
  (select count(*) from osp_private.api_key_calls c where c.key_id = k.id and c.at > now() - interval '1 day')::int as calls_day,
  (select count(*) from osp_private.api_key_calls c where c.key_id = k.id and c.at > now() - interval '1 day' and c.status >= 400)::int as errors_day`
const LIST_SQL = `select ${KEY_COLUMNS} from osp_private.api_keys k
  where k.deleted_at is null and ($1::uuid is null or k.id = $1)
  order by (k.revoked_at is null) desc, k.created_at desc, k.id`
const LOOKUP_SQL = `select id, name, scopes, source, (revoked_at is not null or deleted_at is not null) as revoked,
  coalesce(expires_on < (now() at time zone 'Europe/Moscow')::date, false) as expired
  from osp_private.api_keys where key_hash = $1`
const ENV_UPSERT_SQL = `insert into osp_private.api_keys (name, key_prefix, key_hash, scopes, source, created_by_name)
  select format('Ключ из настроек сервера № %s', u.n), u.p, u.h, string_to_array(u.s, '+'), 'env', 'Настройки сервера'
  from unnest($1::text[], $2::text[], $3::text[], $4::int[]) as u(h, p, s, n)
  on conflict (key_hash) do update set scopes = excluded.scopes, env_missing_at = null
  where osp_private.api_keys.source = 'env'`
const ENV_MISSING_SQL = `update osp_private.api_keys set env_missing_at = now()
  where source = 'env' and env_missing_at is null and not (key_hash = any($1::text[]))`
const CALL_SQL = `insert into osp_private.api_key_calls (key_id, resource, status, row_count, ms, ip, reason)
  values ($1, $2, $3, $4, $5, $6, $7)`
const CALLS_SQL = `select c.id, c.at, c.key_id, k.name as key_name, k.key_prefix, (k.deleted_at is not null) as key_deleted,
  c.resource, c.status, c.row_count, c.ms, c.ip, c.reason
  from osp_private.api_key_calls c join osp_private.api_keys k on k.id = c.key_id
  where ($1::uuid is null or c.key_id = $1) and (not $2::boolean or c.status >= 400) and ($3::bigint is null or c.id < $3)
  order by c.id desc limit $4`

const iso = (v) => (v ? new Date(v).toISOString() : null)

export function keyView(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: RESOURCE_CODES.filter((r) => (row.scopes || []).includes(r)),
    source: row.source,
    note: row.note || '',
    expiresOn: row.expires_on || null,
    status: row.status,
    createdAt: iso(row.created_at),
    createdByName: row.created_by_name || '',
    updatedAt: iso(row.updated_at),
    updatedByName: row.updated_by_name || '',
    revokedAt: iso(row.revoked_at),
    revokedByName: row.revoked_by_name || '',
    revokeReason: row.revoke_reason || '',
    envMissingAt: iso(row.env_missing_at),
    lastUsedAt: iso(row.last_used_at),
    callsDay: row.calls_day ?? 0,
    errorsDay: row.errors_day ?? 0,
  }
}

// Сегодня по Москве — «ГГГГ-ММ-ДД»: срок действия ключа считается по московским дням.
export function moscowToday(now = Date.now()) {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10)
}

// envEntries — разобранная строка RATES_API_KEYS: [{ key, resources }].
export function createApiKeyStore({ db, envEntries = [], log = null, isReadOnly = () => false, now = Date.now }) {
  const env = new Map() // отпечаток → { index, resources, prefix }
  envEntries.forEach((k, i) => {
    const hash = hashKey(k.key)
    if (!env.has(hash)) env.set(hash, { index: i + 1, resources: k.resources, prefix: String(k.key).slice(0, SHOWN_ENV) })
  })
  let missingUntil = 0
  const tableMissing = () => now() < missingUntil
  const noteMissing = (err) => {
    if (!MISSING_CODES.has(String(err?.code || ''))) return false
    missingUntil = now() + RECHECK_MS
    return true
  }
  const pending = new Set()
  let dropped = 0

  const envKey = (hash) => {
    const e = env.get(hash)
    return e ? { id: null, limitKey: `env${e.index}`, name: `Ключ из настроек сервера № ${e.index}`, source: 'env', resources: e.resources } : null
  }

  // Ключ из запроса → { ok: true, key } | { ok: false, key, reason } | null (неизвестен). Бросает, только если база
  // не ответила, а в настройках сервера такого ключа нет: вызывающий отвечает 503.
  async function resolve(provided) {
    const hash = hashKey(provided)
    const fromEnv = envKey(hash)
    const fallback = fromEnv ? { ok: true, key: fromEnv } : null
    if (!db || tableMissing()) return fallback
    let row
    try {
      row = await db.read(null, async (tx) => (await tx.query(LOOKUP_SQL, [hash])).rows[0] || null)
    } catch (err) {
      if (noteMissing(err) || fromEnv) {
        if (fromEnv && !MISSING_CODES.has(String(err?.code || ''))) log?.warn({ code: err?.code }, 'api key lookup failed, server key used')
        return fallback
      }
      throw err
    }
    if (!row) return fallback
    const key = { id: row.id, limitKey: row.id, name: row.name, source: row.source }
    if (row.revoked) return { ok: false, key, reason: 'revoked' }
    if (row.source === 'env') {
      if (!fromEnv) return { ok: false, key, reason: 'removed' }
      return { ok: true, key: { ...key, resources: fromEnv.resources } }
    }
    if (row.expired) return { ok: false, key, reason: 'expired' }
    return { ok: true, key: { ...key, resources: RESOURCE_CODES.filter((r) => row.scopes.includes(r)) } }
  }

  // Запись журнала — после ответа, без ожидания. Ключа нет в базе (только в настройках сервера) — не пишется.
  function logCall({ keyId, resource, status, rows = null, ms = null, ip = null, reason = null }) {
    if (!db || !keyId || tableMissing() || isReadOnly()) return
    if (pending.size >= MAX_PENDING) {
      dropped += 1
      if (dropped === 1 || dropped % 100 === 0) log?.warn({ dropped }, 'api key calls: journal is behind, entries skipped')
      return
    }
    const job = db.write(null, async (tx) => {
      await tx.query(CALL_SQL, [keyId, String(resource).slice(0, 40), status, rows, ms === null ? null : Math.max(0, Math.round(ms)),
        ip ? String(ip).slice(0, 64) : null, reason])
      await tx.query('update osp_private.api_keys set last_used_at = now() where id = $1', [keyId])
    }).catch((err) => {
      if (!noteMissing(err)) log?.warn({ code: err?.code || err?.name }, 'api key call log')
    }).finally(() => pending.delete(job))
    pending.add(job)
  }

  // Ключи из настроек сервера — в список (при запуске; не вышло — повторит служба).
  async function syncEnv() {
    if (!db) return { skipped: 'no_db' }
    if (isReadOnly()) return { skipped: 'readonly' }
    const list = [...env.entries()]
    try {
      return await db.write(null, async (tx) => {
        if (list.length) {
          await tx.query(ENV_UPSERT_SQL, [list.map(([h]) => h), list.map(([, e]) => e.prefix),
            list.map(([, e]) => e.resources.join('+')), list.map(([, e]) => e.index)])
        }
        const gone = await tx.query(ENV_MISSING_SQL, [list.map(([h]) => h)])
        return { registered: list.length, removed: gone.rowCount }
      })
    } catch (err) {
      if (noteMissing(err)) return { skipped: 'missing' }
      throw err
    }
  }

  async function cleanup() {
    if (!db || tableMissing() || isReadOnly()) return 0
    try {
      return await db.write(null, async (tx) =>
        (await tx.query(`delete from osp_private.api_key_calls where at < now() - make_interval(days => $1)`, [CALLS_KEEP_DAYS])).rowCount)
    } catch (err) {
      if (noteMissing(err)) return 0
      throw err
    }
  }

  // Действия администратора: права проверил маршрут, здесь — служебная операция с именем того, кто сделал.
  async function admin(kind, fn) {
    if (!db) throw NO_DB()
    try {
      return await db[kind](null, fn)
    } catch (err) {
      if (noteMissing(err)) throw NO_TABLE()
      throw err
    }
  }
  const readKey = async (tx, id) => {
    const row = (await tx.query(LIST_SQL, [id])).rows[0]
    if (!row) throw NOT_FOUND()
    return keyView(row)
  }

  const list = () => admin('read', async (tx) => (await tx.query(LIST_SQL, [null])).rows.map(keyView))

  // Новый ключ: сам ключ — только в ответе этого вызова.
  async function issue({ actor, name, scopes, expiresOn = null, note = null }) {
    const secret = newKey()
    const key = await admin('write', async (tx) => {
      const { rows } = await tx.query(`insert into osp_private.api_keys (name, key_prefix, key_hash, scopes, source, note, expires_on,
          created_by, created_by_name) values ($1, $2, $3, $4::text[], 'portal', $5, $6::date, $7, $8) returning id`,
      [name, secret.slice(0, SHOWN_PORTAL), hashKey(secret), scopes, note || null, expiresOn || null, actor.id, actor.name])
      return readKey(tx, rows[0].id)
    })
    return { key, secret }
  }

  // Правка: название и примечание — у любого ключа; права и срок — только у выпущенного в портале и действующего.
  async function update(id, patch, actor) {
    return admin('write', async (tx) => {
      const { rows } = await tx.query('select source, revoked_at from osp_private.api_keys where id = $1 and deleted_at is null for update', [id])
      if (!rows[0]) throw NOT_FOUND()
      const touchesAccess = patch.scopes !== undefined || patch.expiresOn !== undefined
      if (touchesAccess && rows[0].source === 'env') {
        throw new ApiKeyError(409, 'OSP_API_KEY_ENV', 'Права ключа из настроек сервера задаёт строка RATES_API_KEYS. Чтобы управлять ключом здесь — выпустите новый, а прежний отзовите')
      }
      if (touchesAccess && rows[0].revoked_at) {
        throw new ApiKeyError(409, 'OSP_API_KEY_REVOKED', 'Ключ отозван: права и срок не меняются — выпустите новый')
      }
      const sets = []
      const args = [id]
      const set = (column, value, cast = '') => { args.push(value); sets.push(`${column} = $${args.length}${cast}`) }
      if (patch.name !== undefined) set('name', patch.name)
      if (patch.note !== undefined) set('note', patch.note || null)
      if (patch.scopes !== undefined) set('scopes', patch.scopes, '::text[]')
      if (patch.expiresOn !== undefined) set('expires_on', patch.expiresOn || null, '::date')
      if (sets.length) {
        set('updated_by', actor.id)
        set('updated_by_name', actor.name)
        await tx.query(`update osp_private.api_keys set ${sets.join(', ')}, updated_at = now() where id = $1`, args)
      }
      return readKey(tx, id)
    })
  }

  // Отзыв — сразу и навсегда; повторный отзыв ничего не меняет.
  async function revoke(id, actor, reason = null) {
    return admin('write', async (tx) => {
      await tx.query(`update osp_private.api_keys set revoked_at = now(), revoked_by = $2, revoked_by_name = $3, revoke_reason = $4
        where id = $1 and deleted_at is null and revoked_at is null`, [id, actor.id, actor.name, reason || null])
      return readKey(tx, id)
    })
  }

  // Удаление — из списка; ключ при этом отзывается, строка с отпечатком и журнал остаются.
  async function remove(id, actor) {
    return admin('write', async (tx) => {
      const { rowCount } = await tx.query(`update osp_private.api_keys set
          revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2), revoked_by_name = coalesce(revoked_by_name, $3),
          deleted_at = now(), deleted_by = $2, deleted_by_name = $3
        where id = $1 and deleted_at is null`, [id, actor.id, actor.name])
      if (!rowCount) throw NOT_FOUND()
      return { ok: true }
    })
  }

  async function calls({ keyId = null, errorsOnly = false, before = null, limit = 100 }) {
    return admin('read', async (tx) => {
      const { rows } = await tx.query(CALLS_SQL, [keyId, errorsOnly, before, limit + 1])
      return {
        calls: rows.slice(0, limit).map((r) => ({
          id: Number(r.id), at: iso(r.at), keyId: r.key_id, keyName: r.key_name, keyPrefix: r.key_prefix, keyDeleted: r.key_deleted,
          resource: r.resource, status: r.status, rows: r.row_count, ms: r.ms, ip: r.ip || '', reason: r.reason || '',
        })),
        hasMore: rows.length > limit,
      }
    })
  }

  return {
    resolve, logCall, syncEnv, cleanup, list, issue, update, revoke, remove, calls,
    // Дождаться записей журнала (тесты, остановка службы).
    idle: () => Promise.allSettled([...pending]),
  }
}
