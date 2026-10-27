// Клиент Supabase в памяти браузера для стенда карточки тендера.
// Реализует ровно те части PostgREST-построителя, которые использует карточка:
// select (с count/head), eq/in/is, or (логическое дерево: eq, in, is, not., and/or), order, range/limit, single/maybeSingle,
// insert/upsert/update/delete с .select(). Встраивания (objects(name)…) не
// разбираются — нужные поля заранее лежат в данных. Каждый запрос ждёт
// искусственную «сетевую» задержку и учитывается в window.__supabaseStats.
// window.__fakeTriggers[таблица](строка, прежняя) — подмена триггера «до записи» (расчёт в базе);
// window.__fakeErrors[таблица] — ответ ошибкой на любой запрос к таблице (например, «таблицы нет»).
// window.__fakeHold({ table, op, filters }) → { delay?, error? } — задержать или уронить отдельный запрос
// (например, одну из двух частей очереди «Проверки КП»).
// window.__fakeMissingColumns[таблица] — колонок ещё нет (миграция не применена): выборка, где они названы,
// отвечает 42703, как PostgREST.
// window.__fakeUnique[таблица] — колонки уникального ключа: вставка дубля отвечает 23505, как база.
// window.__fakeAfter[таблица](op, строка, прежняя) — триггер «после записи» (журнал расценок).
// window.__fakeGenerated[таблица](строка) — вычисляемые колонки (GENERATED): считаются до проверки ключа.
// window.__fakeFiles[s3_key] — содержимое файла (data: URL): хранилище отдаёт его по ссылке на скачивание;
// window.__fakeFileRequests — какие файлы запрашивали.
// window.__fakeRpc[имя](аргументы) → { data, error } — функции базы (db.rpc); функции нет — пустой ответ, как
// раньше. Вызов учитывается в window.__supabaseStats как { table: 'rpc:<имя>', op: 'rpc' }.
// Загрузка файла (s3-presign upload → PUT по ссылке): ссылка ведёт в «хранилище» стенда — PUT перехватывается здесь,
// файл ложится в window.__fakeFiles[s3_key] (data: URL) и отдаётся потом по ссылке на скачивание;
// window.__fakeUploads — что загружали ({ s3_key, size, type }).
const LATENCY_MS = Number(new URLSearchParams(window.location.search).get('latency') || 120)
const FAKE_S3 = 'https://fake-s3.invalid/'
const realFetch = window.fetch.bind(window)
window.fetch = async (url, init = {}) => {
  const href = String(url?.url || url)
  if (!href.startsWith(FAKE_S3)) return realFetch(url, init)
  const key = decodeURIComponent(href.slice(FAKE_S3.length))
  if ((init.method || 'GET').toUpperCase() === 'PUT') {
    const blob = init.body instanceof Blob ? init.body : new Blob([init.body ?? ''])
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.readAsDataURL(blob)
    })
    window.__fakeFiles = { ...(window.__fakeFiles || {}), [key]: dataUrl }
    ;(window.__fakeUploads ||= []).push({ s3_key: key, size: blob.size, type: blob.type })
    return new Response(null, { status: 200 })
  }
  return new Response(null, { status: 404 })
}

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
    if (f.op === 'or') return f.conds.some((c) => testCond(r, c))
    return true
  }))
}

// Логическое дерево .or() как у PostgREST: «a.eq.1,b.not.in.(x,y),and(c.is.true,or(d.is.false,e.eq.2))».
// Операторы — eq, in, is (null / true / false), любой с not.; прочие стенду не нужны — тогда
// всё условие пропускается, как раньше.
function splitTop(expr) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

function parseCond(part) {
  const logic = /^(and|or)\((.*)\)$/.exec(part)
  if (logic) {
    const kids = splitTop(logic[2]).map(parseCond)
    return kids.includes(null) ? null : { logic: logic[1], kids }
  }
  const [col, first, ...rest] = part.split('.')
  const neg = first === 'not'
  const op = neg ? rest.shift() : first
  const val = rest.join('.')
  if (op === 'in') return { col, op, neg, val: val.replace(/^\(|\)$/g, '').split(',') }
  if (op === 'eq' || (op === 'is' && ['null', 'true', 'false'].includes(val))) return { col, op, neg, val }
  return null
}

function testCond(r, c) {
  if (c.logic) return c.logic === 'and' ? c.kids.every((k) => testCond(r, k)) : c.kids.some((k) => testCond(r, k))
  const v = r[c.col]
  const hit = c.op === 'in' ? c.val.includes(String(v))
    : c.op === 'is' ? (c.val === 'null' ? v == null : v === (c.val === 'true'))
      : String(v) === c.val
  return c.neg ? !hit : hit
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
    select(cols, opts = {}) {
      if (q.op === 'select') { q.cols = cols; q.count = opts.count || null; q.head = !!opts.head } else { q.returning = true }
      return self
    },
    eq(col, val) { q.filters.push({ op: 'eq', col, val }); return self },
    is(col, val) { q.filters.push({ op: 'is', col, val }); return self },
    in(col, val) { q.filters.push({ op: 'in', col, val }); return self },
    gt(col, val) { q.filters.push({ op: 'gt', col, val }); return self },
    neq() { return self },
    not() { return self },
    // Таймаут запроса (окно «ВОРы и РД») — стенд отвечает сам, отменять нечего.
    abortSignal() { return self },
    // Логическое дерево — parseCond выше; условие с незнакомым оператором пропускается целиком.
    or(expr) {
      const conds = splitTop(String(expr)).map(parseCond)
      if (!conds.includes(null)) q.filters.push({ op: 'or', conds })
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

// Ответ записи с .select(): массив строк, с .single() — одна строка (как PostgREST).
function written(q, affected) {
  if (!q.returning) return { data: null, error: null }
  const data = affected.map((r) => ({ ...r }))
  if (q.single) return data.length ? { data: data[0], error: null } : { data: null, error: { message: 'Строка не найдена', code: 'PGRST116' } }
  return { data, error: null }
}

async function run(q) {
  stats.active++
  stats.maxActive = Math.max(stats.maxActive, stats.active)
  // ids — сколько значений в фильтре .in(...): по нему видно, перечитан один тендер или все.
  const inFilter = q.filters.find((f) => f.op === 'in')
  stats.requests.push({ table: q.table, op: q.op, range: q.range || null, count: q.count, ids: inFilter ? inFilter.val.map(String) : null })
  const hold = window.__fakeHold?.({ table: q.table, op: q.op, filters: q.filters }) || {}
  await new Promise((r) => setTimeout(r, LATENCY_MS + (hold.delay || 0)))
  stats.active--
  const fakeError = hold.error || window.__fakeErrors?.[q.table]
  if (fakeError) return { data: null, count: null, error: fakeError }
  const missing = q.op === 'select' && window.__fakeMissingColumns?.[q.table]
  if (missing) {
    const asked = String(q.cols || '*').split(',').map((c) => c.trim())
    const absent = missing.find((c) => asked.includes(c))
    if (absent) return { data: null, count: null, error: { code: '42703', message: `column ${q.table}.${absent} does not exist` } }
  }
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
    return written(q, affected)
  }

  if (q.op === 'update') {
    const affected = applyFilters(rows, q.filters)
    for (const r of affected) {
      const old = { ...r }
      Object.assign(r, q.patch, { updated_at: now })
      trigger?.(r, old)
      after?.('update', r, old)
    }
    return written(q, affected)
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
      const action = opts.body?.action
      if (name === 's3-presign' && action === 'upload') {
        const b = opts.body
        const s3Key = `tenders/${b.owner_id}/${uuid()}-${b.file_name}`
        return { data: { s3_key: s3Key, presigned_url: FAKE_S3 + encodeURIComponent(s3Key), expires_in: 900 }, error: null }
      }
      if (name === 's3-presign' && action === 'delete') {
        if (window.__fakeFiles) delete window.__fakeFiles[opts.body.s3_key]
        return { data: { ok: true }, error: null }
      }
      const key = opts.body?.s3_key
      // Все попытки скачать файл (и те, что хранилище стенда не отдаст) — для проверки «не скачивает».
      if (name === 's3-presign' && key) {
        window.__fakePresignRequests ||= []
        window.__fakePresignRequests.push(key)
        window.__fakeLastPresign = opts.body // с параметрами: на скачивание (download, file_name) или для просмотра
      }
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
