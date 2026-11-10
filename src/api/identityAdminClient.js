// Заявки на доступ и связи с СУ-10 — «Администрирование» (вход через Keycloak; сервер — server/osp-api/src/routes/identityAdmin.js).
// Ответ — данные или исключение: error.message — текст сервера, error.status — код ответа, error.code — код отказа (у «почта
// занята» — ещё error.userId: кого предложить «привязать»). Модуль чистый: fetch передаётся извне.
function failure(status, body) {
  const error = new Error(body?.error || (status ? `Сервер ответил ${status}` : 'Сервер недоступен'))
  error.status = status
  error.code = body?.code || null
  error.userId = body?.userId || null
  return error
}

export function createIdentityAdminClient({ fetchImpl }) {
  async function call(path, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetchImpl(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw failure(0, null)
    }
    let data = null
    try { data = await res.json() } catch { /* пусто */ }
    if (!res.ok) throw failure(res.status, data)
    return data || {}
  }
  const req = (id) => `/api/admin/identity-requests/${encodeURIComponent(id)}`
  return {
    // { requests: [{ id, email, fullName, origin, firstSeenAt, lastSeenAt, similar: [...] }], pending, syncConfigured, isSuperadmin }
    list: (status = 'pending') => call(`/api/admin/identity-requests?status=${encodeURIComponent(status)}`),
    sync: () => call('/api/admin/identity-requests/sync', { method: 'POST', body: {} }),
    createUser: (id, input) => call(`${req(id)}/create-user`, { method: 'POST', body: input }),
    link: (id, userId) => call(`${req(id)}/link`, { method: 'POST', body: { userId } }),
    reject: (id) => call(`${req(id)}/reject`, { method: 'POST', body: {} }),
    reopen: (id) => call(`${req(id)}/reopen`, { method: 'POST', body: {} }),
    // { links: [{ userId, source, linkedAt, lastLoginAt }] }
    links: () => call('/api/admin/identities'),
    unlink: (userId) => call(`/api/admin/users/${encodeURIComponent(userId)}/identity`, { method: 'DELETE', body: {} }),
  }
}
