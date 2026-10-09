// Вызов маршрутов своего API (osp-api, server/osp-api) с тем же ответом, что у functions.invoke
// supabase-js: { data, error }. При ответе не 2xx error.context — объект Response: сервисы
// (services/s3.js, services/aiAssist.js) достают из его тела текст ошибки. При сбое сети — error
// без context. Модуль чистый: токен и fetch передаются извне (проверяется в tests/osp-api).
export const OSP_API_BASE = '/api'

function fail(message, name, context) {
  const error = new Error(message)
  error.name = name
  if (context) error.context = context
  return { data: null, error }
}

export async function callOspFunction(name, options = {}, { getToken, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  let token = null
  try {
    token = getToken ? await getToken() : null
  } catch {
    token = null // без токена сервер ответит 401 — как функция Supabase без сессии
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetchImpl(`${OSP_API_BASE}/fn/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? {}),
    })
  } catch (err) {
    return fail(`Сервер недоступен: ${err?.message || err}`, 'FunctionsFetchError')
  }

  if (!res.ok) return fail('Edge Function returned a non-2xx status code', 'FunctionsHttpError', res)
  try {
    return { data: await res.json(), error: null }
  } catch {
    return fail('Некорректный ответ сервера', 'FunctionsHttpError', res)
  }
}
