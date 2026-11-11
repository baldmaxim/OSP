// «Организации СУ-10» без сервера: маршруты /api/admin/su10-orgs*, /api/admin/counterparties/:id/su10-org,
// /api/admin/su10-org-exceptions* и /api/admin/identity-requests* отвечают из памяти так же, как
// server/osp-api/src/routes/orgAdmin.js и identityAdmin.js (проверки сервера и базы — tests/osp-api/su10-orgs.test.mjs).
//   su10View=tab|requests|card|drawer — что показать (по умолчанию вкладка «Организации СУ-10»);
//   su10Mode=own                      — вход через СУ-10 ещё не включён (связи готовят заранее);
//   su10Super=1                        — вошёл суперадминистратор (исключения сотрудникам);
//   su10Down=1                         — СУ-10 не ответил на сверку реестра (список — из прежней);
//   su10Off=1                          — вкладка на сервере не включена (404 без кода).
// window.__su10 — состояние «сервера»: организации, контрагенты, полученные запросы.
import '../../../src/pages/AdminPage.css'
import { useState } from 'react'
import Su10OrgsTab from '../../../src/components/admin/Su10OrgsTab'
import IdentityRequestsTab from '../../../src/components/admin/IdentityRequestsTab'
import CounterpartySu10Org from '../../../src/components/counterparty/CounterpartySu10Org'
import UserEditDrawer from '../../../src/components/admin/UserEditDrawer'

const params = new URLSearchParams(window.location.search)
const view = params.get('su10View') || 'tab'
const CP = {
  a: { id: 'cp-a', number: 12, name: 'ООО «Альфа»', inn: '7707083893', status: 'active' },
  b: { id: 'cp-b', number: 13, name: 'ООО «Бета»', inn: null, status: 'active' },
  bl: { id: 'cp-bl', number: 14, name: 'ООО «Бета-Чёрный»', inn: null, status: 'blacklist' },
  c: { id: 'cp-c', number: 15, name: 'ООО «Гамма»', inn: '9909202642', status: 'active' },
  x: { id: 'cp-x', number: 16, name: 'ООО «Каппа»', inn: null, status: 'active' },
}
const org = (over) => ({ inn: null, state: 'active', kind: 'contractor', invalidReason: null, counterparty: null, usable: false, accounts: 0,
  requests: 0, employees: [], contractorsAffected: 0, firstSeenAt: '2026-11-11T08:00:00Z', seenAt: '2026-11-11T08:00:00Z', missingSince: null, ...over })
const linkOf = (cp, extra = {}) => ({ ...cp, deleted: false, source: 'admin', match: 'admin', linkedAt: '2026-11-11T09:00:00Z', ...extra })
const state = {
  orgs: [
    org({ id: 'o-a', name: 'Альфа ООО', inn: '7707083893', counterparty: linkOf(CP.a), usable: true, accounts: 2, contractorsAffected: 2 }),
    org({ id: 'o-b', name: 'Бета ООО', accounts: 1, requests: 1,
      employees: [{ userId: 'u-e', subject: 's-e', fullName: 'Иванов Иван', exception: false }] }),
    org({ id: 'o-c', name: 'Гамма ООО', inn: '9909202642' }),
    org({ id: 'o-own', name: 'СУ-10', kind: 'own', employees: 3 }),
    org({ id: 'o-x', name: 'Каппа ООО', state: 'missing', missingSince: '2026-11-10T08:00:00Z', counterparty: linkOf(CP.x), usable: false, contractorsAffected: 1 }),
  ],
  exceptions: [],
  counterparties: Object.values(CP),
  created: [],
  requests: [],
  createUserBodies: [],
}
window.__su10 = state

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const orgById = (id) => state.orgs.find((o) => o.id === id)
const linkedTo = (cpId) => state.orgs.find((o) => o.counterparty?.id === cpId)?.id || null
const err = (status, code, error, extra = {}) => json(status, { error, code, ...extra })

function candidatesFor(o, q) {
  if (q) {
    const s = q.toLowerCase()
    return state.counterparties.filter((c) => c.name.toLowerCase().includes(s) || (c.inn || '').includes(s))
      .map((c) => ({ counterparty: c, reasons: [], flags: c.status === 'blacklist' ? ['blacklist'] : [], confident: false, linkedTo: linkedTo(c.id) }))
  }
  if (o.id === 'o-b') {
    return [
      { counterparty: CP.b, reasons: ['name'], flags: [], confident: false, linkedTo: linkedTo(CP.b.id) },
      { counterparty: CP.bl, reasons: ['name_similar'], flags: ['blacklist'], confident: false, linkedTo: null },
    ]
  }
  if (o.id === 'o-c') return [{ counterparty: CP.c, reasons: ['inn'], flags: [], confident: true, linkedTo: linkedTo(CP.c.id) }]
  return []
}

function requestList() {
  const describe = (orgId) => {
    const o = orgById(orgId)
    const counterparty = o.counterparty && o.usable ? { id: o.counterparty.id, number: o.counterparty.number, name: o.counterparty.name, status: 'active', deleted: false } : null
    return { known: true, orgIds: [orgId], source: 'token', org: { id: o.id, name: o.name, kind: o.kind, inn: o.inn, state: o.state },
      counterparty, result: o.kind === 'own' ? 'own' : counterparty ? 'counterparty' : 'unmapped' }
  }
  return [
    { id: 'r-1', subject: 's-1', email: 'petrov@beta.ru', fullName: 'Петров Пётр', status: 'pending', origin: 'kc_sync', similar: [], org: describe('o-b') },
    { id: 'r-2', subject: 's-2', email: 'sidorov@alfa.ru', fullName: 'Сидоров Сидор', status: 'pending', origin: 'login',
      firstSeenAt: '2026-11-11T09:00:00Z', lastSeenAt: '2026-11-11T09:00:00Z', similar: [], org: describe('o-a') },
  ].filter((r) => !state.createUserBodies.some((b) => b.id === r.id && b.ok))
}

async function handle(url, init) {
  const u = new URL(url, window.location.origin)
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(init.body) : undefined
  state.requests.push({ method, path: u.pathname + u.search, body })
  if (params.get('su10Off') === '1') return json(404, { error: 'Not found' })
  const p = u.pathname
  if (p === '/api/admin/su10-orgs' && method === 'GET') {
    return json(200, { orgs: state.orgs, exceptions: state.exceptions, mode: params.get('su10Mode') || 'keycloak',
      isSuperadmin: params.get('su10Super') === '1',
      registry: { generation: 3, at: '2026-11-11T08:00:00Z', lastAttemptAt: '2026-11-11T08:00:00Z', error: params.get('su10Down') === '1' ? 'network' : null, held: false, heldReasons: [], configured: true } })
  }
  if (p === '/api/admin/su10-orgs/refresh') {
    if (params.get('su10Down') === '1') return err(503, 'org_registry_unavailable', 'СУ-10 не ответил — реестр организаций не обновлён, список — из прежней сверки')
    return json(200, { orgs: state.orgs.length, held: false, reasons: [], generation: 3, cached: false })
  }
  let m = /^\/api\/admin\/su10-orgs\/([^/]+)\/(candidates|link|create-counterparty)$/.exec(p)
  if (m) {
    const o = orgById(decodeURIComponent(m[1]))
    if (!o) return err(404, 'org_not_found', 'Организации нет в реестре СУ-10 — обновите список')
    if (m[2] === 'candidates') return json(200, { org: { id: o.id, name: o.name, kind: o.kind, inn: o.inn, state: o.state }, candidates: candidatesFor(o, u.searchParams.get('q') || '') })
    if (m[2] === 'link' && method === 'DELETE') {
      if (!o.counterparty) return err(404, 'org_not_linked', 'Организация не связана — обновите список')
      const revoked = o.contractorsAffected
      Object.assign(o, { counterparty: null, usable: false, contractorsAffected: 0 })
      return json(200, { ok: true, revoked })
    }
    if (m[2] === 'link') {
      const cp = state.counterparties.find((c) => c.id === body.counterpartyId)
      if (o.kind === 'own') return err(409, 'org_own', 'Это своя организация СУ-10 — с контрагентом она не связывается')
      if (o.counterparty) return err(409, 'org_linked', 'Организация уже связана с контрагентом — сначала отвяжите')
      if (cp.status === 'blacklist') return err(409, 'counterparty_blacklisted', 'Контрагент в чёрном списке — связать нельзя')
      if (linkedTo(cp.id)) return err(409, 'counterparty_linked', 'Контрагент уже связан с другой организацией СУ-10', { orgId: linkedTo(cp.id) })
      Object.assign(o, { counterparty: linkOf(cp), usable: true })
      return json(200, { ok: true, revoked: o.accounts })
    }
    // create-counterparty
    if (body.inn && state.counterparties.some((c) => c.inn === body.inn)) {
      const same = state.counterparties.find((c) => c.inn === body.inn)
      return err(409, 'inn_taken', 'Контрагент с таким ИНН уже есть — сопоставьте организацию с ним', { counterpartyId: same.id, number: same.number })
    }
    const cp = { id: `cp-new-${state.created.length + 1}`, number: 99 + state.created.length, name: body.name || o.name, inn: body.inn || null, status: 'active' }
    state.counterparties.push(cp)
    state.created.push(cp)
    Object.assign(o, { counterparty: linkOf(cp), usable: true })
    return json(200, { ok: true, counterparty: { id: cp.id, number: cp.number, name: cp.name }, revoked: 0 })
  }
  m = /^\/api\/admin\/counterparties\/([^/]+)\/su10-org$/.exec(p)
  if (m) {
    const cp = state.counterparties.find((c) => c.id === decodeURIComponent(m[1]))
    const linked = state.orgs.find((o) => o.counterparty?.id === cp.id)
    const free = state.orgs.filter((o) => o.kind === 'contractor' && o.state === 'active' && !o.counterparty)
      .map((o) => ({ id: o.id, name: o.name, inn: o.inn, reasons: o.inn && o.inn === cp.inn ? ['inn'] : [], score: o.inn && o.inn === cp.inn ? 100 : 0 }))
      .sort((a, b) => b.score - a.score)
    return json(200, { counterparty: cp, link: linked ? { orgId: linked.id, name: linked.name, inn: linked.inn, kind: linked.kind, state: linked.state, source: 'admin' } : null, orgs: free })
  }
  if (p === '/api/admin/su10-org-exceptions' && method === 'POST') {
    if (params.get('su10Super') !== '1') return err(403, 'superadmin_only', 'Исключения вносит только суперадминистратор')
    state.exceptions.push({ subject: body.subject, orgId: 'o-b', reason: body.reason, fullName: 'Иванов Иван' })
    for (const o of state.orgs) if (Array.isArray(o.employees)) for (const e of o.employees) if (e.subject === body.subject) e.exception = true
    return json(200, { ok: true, orgId: 'o-b' })
  }
  m = /^\/api\/admin\/su10-org-exceptions\/([^/]+)$/.exec(p)
  if (m && method === 'DELETE') {
    state.exceptions = state.exceptions.filter((e) => e.subject !== decodeURIComponent(m[1]))
    return json(200, { ok: true, revoked: 0 })
  }
  if (p === '/api/admin/identity-requests' && method === 'GET') {
    const list = requestList()
    return json(200, { requests: list, pending: list.length, orgsEnabled: true, syncConfigured: true, isSuperadmin: false })
  }
  if (p === '/api/admin/identity-requests/sync') return json(200, { created: 0, withdrawn: 0 })
  m = /^\/api\/admin\/identity-requests\/([^/]+)\/create-user$/.exec(p)
  if (m) {
    const id = decodeURIComponent(m[1])
    const r = requestList().find((x) => x.id === id)
    if (body.role === 'contractor' && r.org.result !== 'counterparty') {
      state.createUserBodies.push({ id, body, ok: false })
      return err(409, 'org_unmapped', 'Сначала сопоставьте организацию СУ-10 этого человека с контрагентом', { orgId: r.org.org.id, result: r.org.result })
    }
    state.createUserBodies.push({ id, body, ok: true })
    return json(200, { ok: true, user: { id: `u-${id}`, email: r.email } })
  }
  return json(404, { error: 'Not found' })
}

const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.includes('/api/admin/su10-org') || url.includes('/api/admin/identity-requests') || /\/api\/admin\/counterparties\/[^/]+\/su10-org/.test(url)) return handle(url, init)
  return realFetch(input, init)
}

export default function Su10OrgsStand() {
  const [toast, setToast] = useState(null)
  const notify = (kind, text) => setToast({ kind, text })
  return (
    <div className="admin-page" style={{ padding: '1rem' }}>
      <div className="admin-panel">
        <div className="admin-tabpane">
          {view === 'tab' && <Su10OrgsTab notify={notify} isSuperAdmin={params.get('su10Super') === '1'} />}
          {view === 'requests' && (
            <IdentityRequestsTab roleOptions={[{ key: 'engineer', label: 'Инженер' }]} objectOptions={[]} counterpartyOptions={[]}
              onNeedCounterparties={() => {}} users={[]} isSuperAdmin={false} notify={notify} onChanged={() => {}} onPendingCount={() => {}} />
          )}
          {view === 'card' && <div className="cp-card-stand"><CounterpartySu10Org counterpartyId={params.get('su10Cp') || 'cp-c'} /></div>}
          {view === 'drawer' && (
            <UserEditDrawer user={{ user_id: 'u-1', email: 'con@alfa.ru', full_name: 'Подрядов Пётр', role: 'contractor', counterparty_id: 'cp-a', is_approved: true }}
              roleOptions={[{ key: 'contractor', label: 'Подрядчик' }, { key: 'engineer', label: 'Инженер' }]} objectOptions={[]}
              counterpartyOptions={[{ id: 'cp-a', name: 'ООО «Альфа»' }, { id: 'cp-b', name: 'ООО «Бета»' }]}
              counterpartyLocked={params.get('su10Locked') !== '0'} onClose={() => {}} onSave={async () => {}} />
          )}
        </div>
      </div>
      {toast && <div className={`admin-toast ${toast.kind === 'ok' ? 'toast-ok' : 'toast-err'}`} role="status">{toast.text}</div>}
    </div>
  )
}
