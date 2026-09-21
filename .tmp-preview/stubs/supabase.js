// Фейковый клиент Supabase для стенда: вместо сети — таблицы из seed.mjs.
//
// Подменяется на уровне сборки (esbuild-плагин в build.mjs): всё, что в коде
// импортирует '../supabase', получает этот модуль. Реальный @supabase/supabase-js
// в бандл не попадает.
//
// Поддержан ровно тот кусок PostgREST-строителя, который дёргает реестр тендеров:
// select/eq/neq/in/is/or/gt/lt/order/range/limit/single/maybeSingle + count, а
// также insert/update/upsert/delete по памяти (чтобы клики не падали).
import { buildTables, RPC_RESULTS, FAKE_USER } from '../seed.mjs'

let TABLES = null
function tables() {
  // Лениво: seed считает «текущую неделю», а Date подменяется в index.html
  // до загрузки бандла.
  if (!TABLES) TABLES = buildTables()
  return TABLES
}

function rowsOf(name) {
  const t = tables()
  if (!t[name]) t[name] = []
  return t[name]
}

// Значение поля: поддержан и путь через точку (на всякий случай).
function valueOf(row, col) {
  if (!col.includes('.')) return row?.[col]
  return col.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), row)
}

function coerce(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function matchOp(row, col, op, value) {
  const v = valueOf(row, col)
  switch (op) {
    case 'eq': return String(v) === String(value)
    case 'neq': return String(v) !== String(value)
    case 'gt': return v > value
    case 'gte': return v >= value
    case 'lt': return v < value
    case 'lte': return v <= value
    case 'is': return value === null ? (v === null || v === undefined) : v === value
    case 'in': return value.some((x) => String(x) === String(v))
    case 'like': return new RegExp(`^${String(value).replace(/%/g, '.*')}$`).test(String(v ?? ''))
    case 'ilike': return new RegExp(`^${String(value).replace(/%/g, '.*')}$`, 'i').test(String(v ?? ''))
    case 'not.is': return !(value === null ? (v === null || v === undefined) : v === value)
    default: return true
  }
}

// 'department.eq.construction,department.is.null' → true, если подходит хоть одно.
function matchOr(row, expr) {
  return String(expr).split(',').some((term) => {
    const [col, op, ...rest] = term.trim().split('.')
    return matchOp(row, col, op, coerce(rest.join('.')))
  })
}

function compare(a, b) {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return a > b ? 1 : -1
}

class FakeQuery {
  constructor(table) {
    this.table = table
    this.op = 'select'
    this.filters = []
    this.orders = []
    this.rangeFrom = null
    this.rangeTo = null
    this.limitN = null
    this.countMode = null
    this.headOnly = false
    this.single = null // 'one' | 'maybe'
    this.payload = null
  }

  // ── select / мутации ─────────────────────────────────────────────────────
  select(_cols, opts) {
    if (this.op === 'select') this.op = 'select'
    if (opts?.count) this.countMode = opts.count
    if (opts?.head) this.headOnly = true
    return this
  }

  insert(payload) { this.op = 'insert'; this.payload = payload; return this }
  update(payload) { this.op = 'update'; this.payload = payload; return this }
  upsert(payload) { this.op = 'upsert'; this.payload = payload; return this }
  delete() { this.op = 'delete'; return this }

  // ── фильтры ──────────────────────────────────────────────────────────────
  eq(col, value) { this.filters.push((r) => matchOp(r, col, 'eq', value)); this._eq = this._eq || {}; this._eq[col] = value; return this }
  neq(col, value) { this.filters.push((r) => matchOp(r, col, 'neq', value)); return this }
  gt(col, value) { this.filters.push((r) => matchOp(r, col, 'gt', value)); return this }
  gte(col, value) { this.filters.push((r) => matchOp(r, col, 'gte', value)); return this }
  lt(col, value) { this.filters.push((r) => matchOp(r, col, 'lt', value)); return this }
  lte(col, value) { this.filters.push((r) => matchOp(r, col, 'lte', value)); return this }
  is(col, value) { this.filters.push((r) => matchOp(r, col, 'is', value)); return this }
  in(col, values) { this.filters.push((r) => matchOp(r, col, 'in', values || [])); return this }
  like(col, value) { this.filters.push((r) => matchOp(r, col, 'like', value)); return this }
  ilike(col, value) { this.filters.push((r) => matchOp(r, col, 'ilike', value)); return this }
  contains() { return this }
  not(col, op, value) { this.filters.push((r) => !matchOp(r, col, op, value)); return this }
  filter(col, op, value) { this.filters.push((r) => matchOp(r, col, op, coerce(value))); return this }
  or(expr) { this.filters.push((r) => matchOr(r, expr)); return this }
  match(obj) { Object.entries(obj || {}).forEach(([k, v]) => this.eq(k, v)); return this }

  // ── сортировка и срез ────────────────────────────────────────────────────
  order(col, opts = {}) { this.orders.push({ col, asc: opts.ascending !== false }); return this }
  range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this }
  limit(n) { this.limitN = n; return this }
  maybeSingle() { this.single = 'maybe'; return this }
  single() { this.single = 'one'; return this }
  abortSignal() { return this }
  throwOnError() { this.shouldThrow = true; return this }
  csv() { this.asCsv = true; return this }

  // ── выполнение ───────────────────────────────────────────────────────────
  _apply() {
    const store = rowsOf(this.table)
    const matches = (row) => this.filters.every((f) => f(row))

    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload]
      const created = list.map((row) => ({ id: row.id || `gen-${Math.random().toString(36).slice(2, 10)}`, ...row }))
      created.forEach((row) => {
        const i = store.findIndex((r) => r.id === row.id || (row.key && r.key === row.key))
        if (i >= 0 && this.op === 'upsert') store[i] = { ...store[i], ...row }
        else store.push(row)
      })
      return { data: created, count: created.length }
    }

    if (this.op === 'update') {
      const changed = []
      store.forEach((row, i) => {
        if (!matches(row)) return
        store[i] = { ...row, ...this.payload }
        changed.push(store[i])
      })
      return { data: changed, count: changed.length }
    }

    if (this.op === 'delete') {
      const removed = store.filter(matches)
      const kept = store.filter((r) => !matches(r))
      tables()[this.table] = kept
      return { data: removed, count: removed.length }
    }

    let rows = store.filter(matches)
    const total = rows.length
    if (this.orders.length) {
      rows = rows.slice().sort((a, b) => {
        for (const { col, asc } of this.orders) {
          const av = valueOf(a, col)
          const bv = valueOf(b, col)
          const c = compare(av, bv)
          if (c !== 0) return asc ? c : -c
        }
        return 0
      })
    }
    if (this.rangeFrom !== null) rows = rows.slice(this.rangeFrom, this.rangeTo + 1)
    if (this.limitN !== null) rows = rows.slice(0, this.limitN)
    return { data: rows.map((r) => ({ ...r })), count: total }
  }

  then(resolve, reject) {
    let result
    // Журнал обращений к «базе» — для замеров (сколько запросов и строк стоит
    // то или иное действие). Читается из Playwright: window.__STAND_QUERIES__.
    const logQuery = (rows) => {
      try {
        const log = (window.__STAND_QUERIES__ = window.__STAND_QUERIES__ || [])
        log.push({ table: this.table, op: this.op, rows })
      } catch { /* нет window — не страшно */ }
    }
    try {
      const { data, count } = this._apply()
      logQuery(Array.isArray(data) ? data.length : data ? 1 : 0)
      let out = this.headOnly ? null : data
      if (this.single) {
        if (this.headOnly) out = null
        else if (data.length === 0) {
          out = null
          if (this.single === 'one') {
            result = { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count: null, status: 406 }
          }
        } else out = data[0]
      }
      if (!result) {
        result = {
          data: out,
          error: null,
          count: this.countMode ? count : null,
          status: 200,
          statusText: 'OK',
        }
      }
    } catch (err) {
      result = { data: null, error: { message: String(err?.message || err), code: 'STAND' }, count: null, status: 500 }
    }
    if (result.error && this.shouldThrow) return Promise.reject(result.error).then(resolve, reject)
    return Promise.resolve(result).then(resolve, reject)
  }

  catch(fn) { return this.then((r) => r).catch(fn) }
  finally(fn) { return this.then((r) => r).finally(fn) }
}

const noopChannel = () => {
  const ch = {
    on() { return ch },
    subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return ch },
    unsubscribe() { return Promise.resolve('ok') },
    send() { return Promise.resolve('ok') },
  }
  return ch
}

export const supabase = {
  from(table) { return new FakeQuery(table) },
  rpc(name) {
    const data = RPC_RESULTS[name] ?? []
    return Promise.resolve({ data, error: null, count: null, status: 200 })
  },
  channel() { return noopChannel() },
  removeChannel() { return Promise.resolve('ok') },
  removeAllChannels() { return Promise.resolve('ok') },
  auth: {
    getSession: async () => ({ data: { session: { user: FAKE_USER, access_token: 'stand-token' } }, error: null }),
    getUser: async () => ({ data: { user: FAKE_USER }, error: null }),
    refreshSession: async () => ({ data: { session: { user: FAKE_USER, access_token: 'stand-token' } }, error: null }),
    signInWithPassword: async () => ({ data: { user: FAKE_USER }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  storage: {
    from: () => ({
      upload: async () => ({ data: null, error: { message: 'Стенд: загрузка файлов отключена' } }),
      download: async () => ({ data: null, error: { message: 'Стенд: скачивание отключено' } }),
      remove: async () => ({ data: null, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }),
    }),
  },
  functions: {
    invoke: async () => ({ data: null, error: { message: 'Стенд: edge-функции отключены' } }),
  },
}

// Совместимость с обоими вариантами импорта (index.js и client.js).
export default supabase
export const useSupabase = () => supabase
export function resetStandData() { TABLES = null }
