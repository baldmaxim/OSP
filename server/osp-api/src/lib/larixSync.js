// Загрузка договорных расценок из Larix.CPM в базу портала — раз в день, в одну или две базы.
//
//   const sync = createLarixSync({ client, targets: [dbTarget(db), supabaseTarget(supabase)], log })
//   const stop = sync.start({ isReadOnly })        // такт: первый через минуту, далее каждые 5 минут
//   await sync.runOnce({ startedBy: 'cli', force }) // ручной запуск (src/larix-cli.js)
//
// Когда загружать, решает база (larix_sync_begin, supabase/migrations/20261018_larix_contract_rates.sql):
// после 05:00 по Москве, один удачный прогон в день, повтор после сбоя через 30 минут. Такт лишь
// спрашивает. Если хоть одна база ответила «пора» — один запрос в Larix (вне транзакций базы), проверка
// строк, порции по 1000, замена одной транзакцией (larix_sync_finish). Сбой Larix или базы — запись в
// журнал загрузок с понятной причиной; прежние расценки остаются.
//
// Базы-цели (LARIX_SYNC_TARGETS):
//   db       — своя база (OSP_DB_URL; база Яндекса): служебная операция, отметка osp:internal;
//   supabase — база прежнего портала через служебный ключ: только четыре функции larix_sync_*.
// Пока копия данных в базе Яндекса — репетиция, запись в Supabase — сознательное исключение из правила
// «сервер не меняет общее с рабочим порталом» (src/lib/loadStatus.js): расценки Larix — не данные людей,
// их источник — Larix, и прежний портал без этой записи вкладку не увидит. После переноса — убрать цель.
import { LarixError, redact } from './larixClient.js'

export const LARIX_FUNCTIONS = ['larix_sync_begin', 'larix_sync_add_rows', 'larix_sync_finish', 'larix_sync_fail']
export const LARIX_TARGETS = ['db', 'supabase']
export const LARIX_SYNC_DEFAULTS = {
  chunk: 1000,
  intervalMs: 5 * 60_000,
  firstDelayMs: 60_000,
  // Доля строк, не прошедших проверку, выше которой загрузка считается сломанной (формат ответа сменился).
  maxInvalidShare: 0.05,
  finishTimeoutMs: 120_000,
}

const TEXT_LIMITS = {
  work_title: 2000, measure_title: 100, materials_used: 2000, comment: 2000, project_name: 500,
  contractor_short_name: 500, contract_number: 200, contract_state: 100, object_type: 100,
}
const ID_FIELDS = ['project_id', 'contractor_id', 'contract_id']
const PRICE_FIELDS = ['price_material', 'price_work']
// Ставка НДС в описании метода нет; если Larix её отдаёт — под одним из этих имён (первое найденное).
const VAT_KEYS = ['vat_rate', 'vat', 'nds', 'nds_rate', 'vat_percent', 'nds_percent']
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/

const INVALID = Symbol('invalid')

function num(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : INVALID
  if (typeof v === 'string') {
    const s = v.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.')
    if (!/^-?\d+(\.\d+)?$/.test(s)) return INVALID
    const n = Number(s)
    return Number.isFinite(n) ? n : INVALID
  }
  return INVALID
}

function int(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : INVALID
  if (typeof v === 'string' && /^\d{1,15}$/.test(v.trim())) return Number(v.trim())
  return INVALID
}

function text(v, max) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') v = String(v)
  if (typeof v !== 'string') return INVALID
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

function vat(v) {
  if (v === null || v === undefined || v === '') return null
  const n = num(typeof v === 'string' ? v.replace('%', '') : v)
  if (n === INVALID || n === null || n < 0) return null
  // 0.2 — доля, 20 — проценты: храним проценты.
  return n > 0 && n < 1 ? Math.round(n * 10000) / 100 : n
}

// Одна позиция Larix → строка для larix_sync_add_rows (те же имена полей) или null, если не годится.
export function normalizeBoqRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = {}
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    const v = text(raw[k], max)
    if (v === INVALID) return null
    row[k] = v
  }
  if (!row.work_title) return null
  for (const k of ID_FIELDS) {
    const v = int(raw[k])
    if (v === INVALID) return null
    row[k] = v
  }
  for (const k of PRICE_FIELDS) {
    const v = num(raw[k])
    if (v === INVALID) return null
    row[k] = v
  }
  const date = raw.contract_date
  if (date === null || date === undefined || date === '') row.contract_date = null
  else if (typeof date === 'string' && DATE_RE.test(date.trim()) && !Number.isNaN(Date.parse(date.trim()))) row.contract_date = date.trim()
  else return null
  const vatKey = VAT_KEYS.find((k) => k in raw)
  row.vat_rate = vatKey ? vat(raw[vatKey]) : null
  return row
}

// Весь ответ: годные строки, число отброшенных и имена полей (без значений) — для журнала загрузок.
export function normalizeBoq(rawRows) {
  const rows = []
  let skipped = 0
  const keys = new Set()
  for (const raw of rawRows) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && keys.size < 200) {
      for (const k of Object.keys(raw)) if (keys.size < 200 && KEY_RE.test(k)) keys.add(k)
    }
    const row = normalizeBoqRow(raw)
    if (row) rows.push(row); else skipped++
  }
  return { rows, skipped, keys: [...keys].sort() }
}

const shortError = (err) => String(err?.message || err || 'сбой').replace(/\s+/g, ' ').slice(0, 200)

// Своя база: каждая функция — служебная операция (who = null → отметка osp:internal).
export function dbTarget(db, { finishTimeoutMs = LARIX_SYNC_DEFAULTS.finishTimeoutMs } = {}) {
  const call = async (sql, params, opts) => db.write(null, async (tx) => (await tx.query(sql, params)).rows[0]?.r ?? null, opts)
  return {
    name: 'db',
    begin: (startedBy) => call('select public.larix_sync_begin($1) as r', [startedBy]),
    addRows: (run, chunk, rows) => call('select public.larix_sync_add_rows($1, $2, $3::jsonb) as r', [run, chunk, JSON.stringify(rows)]),
    finish: (run, expected, skipped, keys, force) => call('select public.larix_sync_finish($1, $2, $3, $4::text[], $5) as r',
      [run, expected, skipped, keys, force], { statementTimeoutMs: finishTimeoutMs }),
    fail: (run, code, message) => call('select public.larix_sync_fail($1, $2, $3) as r', [run, code, message]),
  }
}

// База прежнего портала (Supabase): вызов функций через PostgREST служебным ключом. Только четыре функции
// загрузки — адаптер отказывает в любом другом имени.
export function supabaseTarget(client) {
  const call = async (fn, args) => {
    if (!LARIX_FUNCTIONS.includes(fn)) throw new Error(`supabase: функция ${fn} не из набора загрузки Larix`)
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new Error(`supabase ${fn}: ${String(error.code || '')} ${String(error.message || '').slice(0, 160)}`.trim())
    return data ?? null
  }
  return {
    name: 'supabase',
    begin: (startedBy) => call('larix_sync_begin', { p_started_by: startedBy }),
    addRows: (run, chunk, rows) => call('larix_sync_add_rows', { p_run: run, p_chunk: chunk, p_rows: rows }),
    finish: (run, expected, skipped, keys, force) => call('larix_sync_finish',
      { p_run: run, p_expected: expected, p_skipped: skipped, p_keys: keys, p_force: force }),
    fail: (run, code, message) => call('larix_sync_fail', { p_run: run, p_code: code, p_text: message }),
  }
}

export function createLarixSync({ client, targets, log, secrets = [], options = {} }) {
  const o = { ...LARIX_SYNC_DEFAULTS, ...options }
  const clean = (err) => redact(shortError(err), secrets)
  let running = null

  async function failAll(started, code, message) {
    for (const s of started) {
      await s.target.fail(s.run, code, message).catch((err) => log.warn({ target: s.target.name, msg: clean(err) }, 'larix fail'))
    }
  }

  async function load(target, run, rows, skipped, keys, force) {
    for (let i = 0, chunk = 0; i < rows.length; i += o.chunk, chunk++) {
      const part = rows.slice(i, i + o.chunk)
      // Порция идемпотентна (повтор той же порции ничего не меняет) — один повтор при сбое сети или базы.
      try { await target.addRows(run, chunk, part) } catch { await target.addRows(run, chunk, part) }
    }
    return target.finish(run, rows.length, skipped, keys, force)
  }

  async function runOnceInner({ startedBy, force, only }) {
    const started = []
    for (const target of targets) {
      if (only && target.name !== only) continue
      try {
        const run = await target.begin(startedBy)
        if (run !== null && run !== undefined) started.push({ target, run })
      } catch (err) {
        log.warn({ target: target.name, msg: clean(err) }, 'larix begin')
      }
    }
    if (!started.length) return { started: 0, results: {} }

    let fetched
    try {
      fetched = await client.fetchBoq()
    } catch (err) {
      const code = err instanceof LarixError ? err.code : 'http'
      const message = clean(err)
      log.warn({ code, msg: message }, 'larix fetch')
      await failAll(started, code, message)
      return { started: started.length, results: Object.fromEntries(started.map((s) => [s.target.name, { status: 'failed', code }])) }
    }
    const { rows, skipped, keys } = normalizeBoq(fetched.rows)
    fetched = null
    const total = rows.length + skipped
    if (total > 0 && skipped / total > o.maxInvalidShare) {
      const message = `Larix: не прошли проверку ${skipped} из ${total} позиций — формат ответа изменился?`
      log.warn({ skipped, total }, 'larix invalid')
      await failAll(started, 'invalid', message)
      return { started: started.length, results: Object.fromEntries(started.map((s) => [s.target.name, { status: 'failed', code: 'invalid' }])) }
    }

    const results = {}
    for (const s of started) {
      try {
        results[s.target.name] = await load(s.target, s.run, rows, skipped, keys, force)
        log.info({ target: s.target.name, positions: rows.length, skipped, status: results[s.target.name]?.status }, 'larix sync')
      } catch (err) {
        const message = clean(err)
        log.warn({ target: s.target.name, msg: message }, 'larix load')
        await failAll([s], 'db', message)
        results[s.target.name] = { status: 'failed', code: 'db' }
      }
    }
    return { started: started.length, positions: rows.length, skipped, keys, results }
  }

  // Один прогон за раз в этом процессе; между процессами и серверами — уникальный индекс в базе.
  function runOnce({ startedBy = 'schedule', force = false, only = null } = {}) {
    if (running) return Promise.resolve({ busy: true })
    running = runOnceInner({ startedBy, force, only }).finally(() => { running = null })
    return running
  }

  // Такт по расписанию. Барьер записи на время переноса — пропуск такта.
  function start({ isReadOnly = () => false } = {}) {
    let interval = null
    const tick = () => {
      if (isReadOnly()) return
      runOnce().catch((err) => log.warn({ msg: clean(err) }, 'larix tick'))
    }
    const first = setTimeout(() => {
      tick()
      interval = setInterval(tick, o.intervalMs)
      interval.unref?.()
    }, o.firstDelayMs)
    first.unref?.()
    return () => {
      clearTimeout(first)
      if (interval) clearInterval(interval)
    }
  }

  return { runOnce, start }
}
