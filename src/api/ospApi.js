// Вызов маршрутов своего API (osp-api, server/osp-api) с тем же ответом, что у functions.invoke
// supabase-js: { data, error }. При ответе не 2xx error.context — объект Response: сервисы
// (services/s3.js, services/aiAssist.js) достают из его тела текст ошибки. При сбое сети — error
// без context. Модуль чистый: токен и fetch передаются извне (проверяется в tests/osp-api).
// options.timeoutMs — предел ожидания ответа (запросы загрузки файлов, 19.11.2026: загрузка «зависала»): истёк — запрос
// обрывается и возвращается как сбой сети (error без context), загрузка его повторяет. Без него — ждём, как прежде.
export const OSP_API_BASE = '/api'

const ABORTED = Symbol('aborted')

function fail(message, name, context) {
  const error = new Error(message)
  error.name = name
  if (context) error.context = context
  return { data: null, error }
}

export async function callOspFunction(name, options = {}, { getToken, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  // Предел — на весь вызов, и на получение токена (продление сессии) тоже.
  const timeoutMs = Number(options.timeoutMs) || 0
  const abort = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null
  const timer = abort ? setTimeout(() => abort.abort(), timeoutMs) : null
  const timedOut = () => fail(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} с`, 'FunctionsFetchError')
  const aborted = abort ? new Promise((resolve) => abort.signal.addEventListener('abort', () => resolve(ABORTED))) : null
  let token = null
  try {
    token = getToken ? await (aborted ? Promise.race([getToken(), aborted]) : getToken()) : null
  } catch {
    token = null // без токена сервер ответит 401 — как функция Supabase без сессии
  }
  if (token === ABORTED) {
    clearTimeout(timer)
    return timedOut()
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    let res
    try {
      res = await fetchImpl(`${OSP_API_BASE}/fn/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body ?? {}),
        ...(abort ? { signal: abort.signal } : {}),
      })
    } catch (err) {
      if (abort?.signal.aborted) return timedOut()
      return fail(`Сервер недоступен: ${err?.message || err}`, 'FunctionsFetchError')
    }

    if (!res.ok) return fail('Edge Function returned a non-2xx status code', 'FunctionsHttpError', res)
    try {
      return { data: await res.json(), error: null }
    } catch {
      if (abort?.signal.aborted) return timedOut()
      return fail('Некорректный ответ сервера', 'FunctionsHttpError', res)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
