// Подмена клиента Supabase для UI-стенда ПСДЦ: RPC и простые чтения таблиц идут в
// тестовый прокси (tests/psdc/ui/api-server.mjs), хранилище S3 недоступно.
const params = new URLSearchParams(window.location.search)
const API = window.__PSDC_API__
const UID = params.get('uid')

async function call(payload) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify({ uid: UID, ...payload }) })
  const data = await res.json()
  if (!res.ok) return { data: null, error: { message: data.message } }
  return { data, error: null }
}

function tableQuery(table) {
  const query = { table, select: '*', filters: [], order: [] }
  let single = false
  const builder = {
    select(columns) { query.select = columns; return builder },
    eq(column, value) { query.filters.push({ op: 'eq', column, value }); return builder },
    is(column, value) { query.filters.push({ op: 'is', column, value }); return builder },
    order(column, opts = {}) { query.order.push({ column, ascending: opts.ascending !== false }); return builder },
    range(from, to) { query.range = [from, to]; return builder },
    limit(n) { query.limit = n; return builder },
    single() { single = true; return builder },
    then(resolve, reject) {
      return call({ query }).then(({ data, error }) => {
        if (error) return { data: null, error }
        if (single) return data?.length ? { data: data[0], error: null } : { data: null, error: { message: 'Строка не найдена' } }
        return { data, error: null }
      }).then(resolve, reject)
    },
  }
  return builder
}

export const supabase = {
  rpc: (fn, args) => call({ fn, args }),
  from: (table) => tableQuery(table),
  functions: {
    invoke: async () => ({ data: null, error: { message: 'Хранилище недоступно в тестовом стенде' } }),
  },
  auth: {
    getUser: async () => ({ data: { user: { id: UID } } }),
  },
}

export default supabase
