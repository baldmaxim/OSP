// Клиент Supabase в памяти браузера для стенда карточки тендера.
// Реализует ровно те части PostgREST-построителя, которые использует карточка:
// select (с count/head), eq/in/is, order, range/limit, single/maybeSingle,
// insert/upsert/update/delete с .select(). Встраивания (objects(name)…) не
// разбираются — нужные поля заранее лежат в данных. Каждый запрос ждёт
// искусственную «сетевую» задержку и учитывается в window.__supabaseStats.
const LATENCY_MS = Number(new URLSearchParams(window.location.search).get('latency') || 120)

const db = window.__fakeDb
const stats = window.__supabaseStats = { requests: [], active: 0, maxActive: 0 }

const uuid = () => crypto.randomUUID()
const sortedCache = new Map()
const versions = {}
const touch = (table) => { versions[table] = (versions[table] || 0) + 1 }
const tableRows = (name) => (db[name] ||= [])

function applyFilters(rows, filters) {
  return rows.filter((r) => filters.every((f) => {
    if (f.op === 'eq') return String(r[f.col]) === String(f.val)
    if (f.op === 'is') return f.val === null ? r[f.col] == null : r[f.col] === f.val
    if (f.op === 'in') return f.val.map(String).includes(String(r[f.col]))
    return true
  }))
}

function applyOrder(rows, orders) {
  if (!orders.length) return rows
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      const av = a[o.col]
      const bv = b[o.col]
      if (av === bv) continue
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = av < bv ? -1 : 1
      return o.asc ? cmp : -cmp
    }
    return 0
  })
}

function builder(table) {
  const q = { table, filters: [], orders: [], op: 'select', count: null, head: false }
  const self = {
    select(_cols, opts = {}) {
      if (q.op === 'select') { q.count = opts.count || null; q.head = !!opts.head } else { q.returning = true }
      return self
    },
    eq(col, val) { q.filters.push({ op: 'eq', col, val }); return self },
    is(col, val) { q.filters.push({ op: 'is', col, val }); return self },
    in(col, val) { q.filters.push({ op: 'in', col, val }); return self },
    neq() { return self },
    not() { return self },
    or() { return self },
    order(col, opts = {}) { q.orders.push({ col, asc: opts.ascending !== false }); return self },
    range(from, to) { q.range = [from, to]; return self },
    limit(n) { q.limit = n; return self },
    single() { q.single = true; return self },
    maybeSingle() { q.single = true; q.maybe = true; return self },
    insert(rows) { q.op = 'insert'; q.payload = Array.isArray(rows) ? rows : [rows]; return self },
    upsert(rows, opts = {}) { q.op = 'upsert'; q.payload = Array.isArray(rows) ? rows : [rows]; q.onConflict = opts.onConflict; return self },
    update(patch) { q.op = 'update'; q.patch = patch; return self },
    delete() { q.op = 'delete'; return self },
    then(resolve, reject) { return run(q).then(resolve, reject) },
  }
  return self
}

async function run(q) {
  stats.active++
  stats.maxActive = Math.max(stats.maxActive, stats.active)
  stats.requests.push({ table: q.table, op: q.op, range: q.range || null, count: q.count })
  await new Promise((r) => setTimeout(r, LATENCY_MS))
  stats.active--
  const rows = tableRows(q.table)
  const now = new Date().toISOString()

  if (q.op === 'select') {
    // Отфильтрованный и отсортированный набор кэшируется до следующей записи в
    // таблицу — в настоящей базе страницы отдаёт индекс, и стенд не должен
    // мерить собственную сортировку вместо приложения.
    const cacheKey = JSON.stringify([q.table, q.filters, q.orders, versions[q.table] || 0])
    let sorted = sortedCache.get(cacheKey)
    if (!sorted) {
      sorted = applyOrder(applyFilters(rows, q.filters), q.orders)
      sortedCache.set(cacheKey, sorted)
    }
    let result = sorted
    const count = q.count ? result.length : null
    if (q.range) result = result.slice(q.range[0], q.range[1] + 1)
    if (q.limit != null) result = result.slice(0, q.limit)
    if (q.head) return { data: null, count, error: null }
    const data = result.map((r) => ({ ...r }))
    if (q.single) {
      if (!data.length) return q.maybe ? { data: null, error: null } : { data: null, error: { message: 'Строка не найдена', code: 'PGRST116' } }
      return { data: data[0], error: null }
    }
    return { data, count, error: null }
  }

  if (q.op !== 'select') touch(q.table)

  if (q.op === 'insert' || q.op === 'upsert') {
    const keys = q.onConflict ? q.onConflict.split(',').map((s) => s.trim()) : null
    const affected = []
    for (const input of q.payload) {
      const existing = keys ? rows.find((r) => keys.every((k) => String(r[k]) === String(input[k]))) : null
      if (existing) {
        Object.assign(existing, input, { updated_at: now })
        affected.push(existing)
      } else {
        const row = { id: uuid(), created_at: now, updated_at: now, ...input }
        rows.push(row)
        affected.push(row)
      }
    }
    return { data: q.returning ? affected.map((r) => ({ ...r })) : null, error: null }
  }

  if (q.op === 'update') {
    const affected = applyFilters(rows, q.filters)
    for (const r of affected) Object.assign(r, q.patch, { updated_at: now })
    return { data: q.returning ? affected.map((r) => ({ ...r })) : null, error: null }
  }

  if (q.op === 'delete') {
    const doomed = new Set(applyFilters(rows, q.filters))
    db[q.table] = rows.filter((r) => !doomed.has(r))
    return { data: null, error: null }
  }
  return { data: null, error: null }
}

export const supabase = {
  from: (table) => builder(table),
  rpc: async () => ({ data: null, error: null }),
  functions: { invoke: async () => ({ data: null, error: { message: 'Хранилище недоступно в стенде' } }) },
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  channel: () => ({ on() { return this }, subscribe() { return this } }),
  removeChannel: () => {},
}

export default supabase
