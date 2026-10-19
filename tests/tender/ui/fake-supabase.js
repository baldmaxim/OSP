// Клиент Supabase в памяти браузера для стенда карточки тендера.
// Реализует ровно те части PostgREST-построителя, которые использует карточка:
// select (с count/head), eq/in/is, or (только eq и is.null), order, range/limit, single/maybeSingle,
// insert/upsert/update/delete с .select(). Встраивания (objects(name)…) не
// разбираются — нужные поля заранее лежат в данных. Каждый запрос ждёт
// искусственную «сетевую» задержку и учитывается в window.__supabaseStats.
// window.__fakeTriggers[таблица](строка, прежняя) — подмена триггера «до записи» (расчёт в базе);
// window.__fakeErrors[таблица] — ответ ошибкой на любой запрос к таблице (например, «таблицы нет»).
// window.__fakeUnique[таблица] — колонки уникального ключа: вставка дубля отвечает 23505, как база.
// window.__fakeAfter[таблица](op, строка, прежняя) — триггер «после записи» (журнал расценок).
// window.__fakeGenerated[таблица](строка) — вычисляемые колонки (GENERATED): считаются до проверки ключа.
// window.__fakeFiles[s3_key] — содержимое файла (data: URL): хранилище отдаёт его по ссылке на скачивание;
// window.__fakeFileRequests — какие файлы запрашивали.
// window.__fakeRpc[имя](аргументы) → { data, error } — функции базы (db.rpc); функции нет — пустой ответ, как
// раньше. Вызов учитывается в window.__supabaseStats как { table: 'rpc:<имя>', op: 'rpc' }.
const LATENCY_MS = Number(new URLSearchParams(window.location.search).get('latency') || 120)

const db = window.__fakeDb
const stats = window.__supabaseStats = { requests: [], active: 0, maxActive: 0 }

const channels = new Set()
window.__realtime = {
  emit(table, payload) {
    for (const channel of channels) for (const h of channel.handlers) if (h.table === table) h.handler(payload)
  },
  subscriptions: () => [...channels].flatMap((c) => c.handlers.map((h) => h.table)),
}

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
    if (f.op === 'gt') return r[f.col] > f.val
    if (f.op === 'or') return f.conds.some((c) => (c.op === 'is' ? r[c.col] == null : String(r[c.col]) === c.val))
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
    gt(col, val) { q.filters.push({ op: 'gt', col, val }); return self },
    neq() { return self },
    not() { return self },
    // «a.eq.1,b.is.null» — как PostgREST; прочие операторы стенду не нужны.
    or(expr) {
      const conds = String(expr).split(',').map((part) => {
        const [col, op, ...rest] = part.split('.')
        return { col, op, val: rest.join('.') }
      })
      if (conds.every((c) => c.op === 'eq' || (c.op === 'is' && c.val === 'null'))) q.filters.push({ op: 'or', conds })
      return self
    },
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
  // ids — сколько значений в фильтре .in(...): по нему видно, перечитан один тендер или все.
  const inFilter = q.filters.find((f) => f.op === 'in')
  stats.requests.push({ table: q.table, op: q.op, range: q.range || null, count: q.count, ids: inFilter ? inFilter.val.map(String) : null })
  await new Promise((r) => setTimeout(r, LATENCY_MS))
  stats.active--
  const fakeError = window.__fakeErrors?.[q.table]
  if (fakeError) return { data: null, count: null, error: fakeError }
  const rows = tableRows(q.table)
  const now = new Date().toISOString()
  const trigger = window.__fakeTriggers?.[q.table]
  const after = window.__fakeAfter?.[q.table]

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

  // Запись могла задеть и другие таблицы (триггер «после записи» пишет журнал) — кэш выборок сбрасывается весь.
  if (q.op !== 'select') { touch(q.table); sortedCache.clear() }

  if (q.op === 'insert' || q.op === 'upsert') {
    const keys = q.onConflict ? q.onConflict.split(',').map((s) => s.trim()) : null
    const affected = []
    const generated = window.__fakeGenerated?.[q.table]
    for (const raw of q.payload) {
      const input = generated ? { ...raw, ...generated(raw) } : raw
      const existing = keys ? rows.find((r) => keys.every((k) => String(r[k]) === String(input[k]))) : null
      if (existing) {
        const old = { ...existing }
        Object.assign(existing, input, { updated_at: now })
        trigger?.(existing, old)
        after?.('update', existing, old)
        affected.push(existing)
      } else {
        const unique = window.__fakeUnique?.[q.table]
        if (unique && rows.some((r) => unique.every((k) => String(r[k]) === String(input[k])))) {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${unique.join(', ')})` } }
        }
        const row = { id: uuid(), created_at: now, updated_at: now, ...input }
        trigger?.(row, null)
        rows.push(row)
        after?.('insert', row, null)
        affected.push(row)
      }
    }
    return { data: q.returning ? affected.map((r) => ({ ...r })) : null, error: null }
  }

  if (q.op === 'update') {
    const affected = applyFilters(rows, q.filters)
    for (const r of affected) {
      const old = { ...r }
      Object.assign(r, q.patch, { updated_at: now })
      trigger?.(r, old)
      after?.('update', r, old)
    }
    return { data: q.returning ? affected.map((r) => ({ ...r })) : null, error: null }
  }

  if (q.op === 'delete') {
    const doomed = new Set(applyFilters(rows, q.filters))
    db[q.table] = rows.filter((r) => !doomed.has(r))
    for (const r of doomed) after?.('delete', null, r)
    return { data: q.returning ? [...doomed].map((r) => ({ ...r })) : null, error: null }
  }
  return { data: null, error: null }
}

export const supabase = {
  from: (table) => builder(table),
  rpc: async (name, args = {}) => {
    stats.active++
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    stats.requests.push({ table: `rpc:${name}`, op: 'rpc', range: null, count: null, ids: null, args })
    await new Promise((r) => setTimeout(r, LATENCY_MS))
    stats.active--
    const handler = window.__fakeRpc?.[name]
    if (!handler) return { data: null, error: null }
    // Функция могла писать в таблицы — кэш выборок сбрасывается весь.
    sortedCache.clear()
    return handler(args)
  },
  functions: {
    invoke: async (name, opts = {}) => {
      const key = opts.body?.s3_key
      if (name === 's3-presign' && key && window.__fakeFiles?.[key]) {
        window.__fakeFileRequests ||= []
        window.__fakeFileRequests.push(key)
        return { data: { presigned_url: window.__fakeFiles[key] }, error: null }
      }
      return { data: null, error: { message: 'Хранилище недоступно в стенде' } }
    },
  },
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  // Онлайн-обновления: подписки запоминаются, событие «с сервера» подаёт тест —
  // window.__realtime.emit('таблица', { eventType, new, old }).
  channel: () => {
    const channel = {
      handlers: [],
      on(_kind, opts, handler) { channel.handlers.push({ table: opts.table, handler }); return channel },
      subscribe(onStatus) { channels.add(channel); onStatus?.('SUBSCRIBED'); return channel },
    }
    return channel
  },
  removeChannel: (channel) => { channels.delete(channel) },
}

export default supabase
