// Ключи API для смежных систем — «Администрирование» → «Доступ к API» (сервер — server/osp-api/src/routes/apiKeys.js).
// Ответ — данные или исключение: error.message — текст сервера, error.status — код ответа, error.code — код отказа.
// Раздела нет у сервера (прежний портал без своего API, сборка сервера старее) — error.unavailable = true.
// Модуль чистый: fetch и токен передаются извне (tests/tender/api-keys.test.mjs).
const BASE = '/api/admin/api-keys'

function failure(status, body) {
  const error = new Error(body?.error || (status ? `Сервер ответил ${status}` : 'Сервер недоступен'))
  error.status = status
  error.code = body?.code || null
  error.unavailable = status === 0 || (status === 404 && !body?.code) || status === 502 || status === 504
  return error
}

export function createApiKeysClient({ fetchImpl, getToken = async () => null }) {
  async function call(path, { method = 'GET', body } = {}) {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' }
    let token = null
    try { token = await getToken() } catch { token = null }
    if (token) headers.authorization = `Bearer ${token}`
    let res
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw failure(0, null)
    }
    let data = null
    try { data = await res.json() } catch { /* не JSON — страница nginx или пусто */ }
    if (!res.ok) throw failure(res.status, data)
    if (!data || typeof data !== 'object') throw failure(res.status === 200 ? 404 : res.status, null)
    return data
  }
  const id = (keyId) => `/${encodeURIComponent(keyId)}`

  return {
    // { resources: [{ code, label, path, hint }], keys: [...], today: 'ГГГГ-ММ-ДД' }
    list: () => call(''),
    // { key, secret } — сам ключ приходит только здесь.
    issue: (input) => call('', { method: 'POST', body: input }),
    update: (keyId, patch) => call(id(keyId), { method: 'POST', body: patch }).then((d) => d.key),
    revoke: (keyId, reason) => call(`${id(keyId)}/revoke`, { method: 'POST', body: reason ? { reason } : {} }).then((d) => d.key),
    remove: (keyId) => call(`${id(keyId)}/delete`, { method: 'POST', body: {} }),
    // { calls: [...], hasMore }
    calls: ({ keyId = null, errorsOnly = false, before = null, limit = 100 } = {}) => {
      const q = new URLSearchParams()
      if (keyId) q.set('key', keyId)
      if (errorsOnly) q.set('errors', '1')
      if (before) q.set('before', String(before))
      q.set('limit', String(limit))
      return call(`/calls?${q}`)
    },
  }
}
