// «Организации СУ-10» — «Администрирование» и карточка контрагента (сервер — server/osp-api/src/routes/orgAdmin.js).
// Ответ — данные или исключение: error.message — текст сервера, error.status — код ответа, error.code — код отказа; у
// «ИНН уже есть» — error.counterpartyId и error.number, у «контрагент связан с другой» — error.orgId. 404 без кода —
// error.unavailable: вкладка на этом сервере не включена (нет миграции 20270201 или служебного клиента СУ-10).
// Модуль чистый: fetch передаётся извне.
function failure(status, body) {
  const error = new Error(body?.error || (status ? `Сервер ответил ${status}` : 'Сервер недоступен'))
  error.status = status
  error.code = body?.code || null
  error.orgId = body?.orgId ?? null
  error.counterpartyId = body?.counterpartyId ?? null
  error.number = body?.number ?? null
  error.result = body?.result ?? null
  error.unavailable = status === 404 && !body?.code
  return error
}

export function createSu10OrgsClient({ fetchImpl }) {
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
  const org = (id) => `/api/admin/su10-orgs/${encodeURIComponent(id)}`
  return {
    // { orgs: [...], exceptions: [...], registry: { generation, at, error, held, configured }, mode, isSuperadmin }
    list: () => call('/api/admin/su10-orgs'),
    refresh: () => call('/api/admin/su10-orgs/refresh', { method: 'POST', body: {} }),
    candidates: (orgId, q = '') => call(`${org(orgId)}/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    link: (orgId, counterpartyId) => call(`${org(orgId)}/link`, { method: 'POST', body: { counterpartyId } }),
    unlink: (orgId) => call(`${org(orgId)}/link`, { method: 'DELETE', body: {} }),
    createCounterparty: (orgId, { name = null, inn = null } = {}) => call(`${org(orgId)}/create-counterparty`, { method: 'POST', body: { name, inn } }),
    ofCounterparty: (counterpartyId) => call(`/api/admin/counterparties/${encodeURIComponent(counterpartyId)}/su10-org`),
    addException: (subject, reason) => call('/api/admin/su10-org-exceptions', { method: 'POST', body: { subject, reason } }),
    removeException: (subject) => call(`/api/admin/su10-org-exceptions/${encodeURIComponent(subject)}`, { method: 'DELETE', body: {} }),
  }
}
