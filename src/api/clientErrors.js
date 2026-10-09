// Наблюдение за отказами сервера для телеметрии ошибок (services/telemetry.js).
//
// Обёртка над fetch клиента Supabase: запрос уходит как есть, ответ возвращается
// как есть. Если ответ — отказ или сбой, слушателю передаётся только раздел (имя
// таблицы / RPC / функции из пути адреса), код и HTTP-статус. Ни тела запроса, ни
// параметров фильтров (в них бывают email и id), ни текста ошибки.
//
// Что считается поломкой, а не ошибкой ввода: 401/403, код 42501 (нет прав),
// PGRST* (ошибки PostgREST), 57014 (таймаут запроса), любые 5xx. Нарушения
// уникальности и прочие 4xx-ошибки данных — нормальная работа, их не шлём.

let listener = null

export function onClientError(fn) {
  listener = fn
}

// Раздел по пути: /rest/v1/<таблица>, /rest/v1/rpc/<функция>, /functions/v1/<функция>, /api/fn/<функция>.
function sectionOf(url) {
  let path
  try {
    path = new URL(url, window.location.origin).pathname
  } catch {
    return null
  }
  let m = path.match(/^\/api\/fn\/([^/]+)/) // свой API (osp-api) — те же разделы, что у функций
  if (m) return `fn:${m[1]}`
  m = path.match(/\/rest\/v1\/rpc\/([^/]+)/)
  if (m) return `rpc:${m[1]}`
  m = path.match(/\/rest\/v1\/([^/]+)/)
  if (m) return m[1]
  m = path.match(/\/functions\/v1\/([^/]+)/)
  if (m) return `fn:${m[1]}`
  if (/\/storage\/v1\//.test(path)) return 'storage'
  return null // вход (/auth/v1) не наблюдаем: неверный пароль — не поломка
}

// Сами отчёты не наблюдаем — иначе отказ отчёта породил бы новый отчёт.
const SELF = new Set(['rpc:report_client_error', 'rpc:report_client_version'])

async function inspect(url, res) {
  const section = sectionOf(url)
  if (!section || SELF.has(section)) return
  let code = null
  try {
    const body = await res.clone().json()
    if (body && typeof body.code === 'string') code = body.code
  } catch { /* тело не JSON */ }
  const status = res.status
  const broken = status === 401 || status === 403 || status >= 500 ||
    code === '42501' || code === '57014' || (code && code.startsWith('PGRST'))
  if (!broken) return
  listener({ section: section.slice(0, 100), code: (code || `http_${status}`).slice(0, 40), status })
}

export function observingFetch(input, init) {
  return fetch(input, init).then((res) => {
    if (!res.ok && listener) {
      const url = typeof input === 'string' ? input : input?.url
      inspect(url, res).catch(() => { /* телеметрия не должна мешать работе */ })
    }
    return res
  })
}
