// «Администрирование» → «Доступ к API» без сервера: маршруты /api/admin/api-keys* отвечают из памяти так же, как
// server/osp-api/src/routes/apiKeys.js (проверки сервера — tests/osp-api/api-keys.test.mjs).
//   apiKeys=missing — сервера раздела нет (прежний портал: на /api отвечает страница сайта);
//   apiKeysMany=N   — ещё N ключей в списке.
// window.__apiKeys — состояние «сервера»: ключи, журнал, полученные запросы (тело выпуска — без ключа).
import '../../../src/pages/AdminPage.css'
import { useState } from 'react'
import ApiKeysTab from '../../../src/components/admin/ApiKeysTab'

const params = new URLSearchParams(window.location.search)
const RESOURCES = [
  { code: 'kp', label: 'Расценки от подрядчиков (КП)', path: '/api/rates/kp', hint: 'Цены подрядчиков из КП по тендерам ОСП: материалы и работы' },
  { code: 'supply', label: 'Расценки от снабжения СУ-10', path: '/api/rates/supply', hint: 'Цены снабжения по материалам ВОР тендеров' },
  { code: 'larix', label: 'Договорные расценки (Larix)', path: '/api/rates/larix', hint: 'Цены материалов и работ из ВОР договоров Larix.CPM' },
]
const TODAY = '2026-10-29'
const at = (min) => new Date(Date.UTC(2026, 9, 29, 7, 0) - min * 60_000).toISOString()
const base = (over) => ({
  note: '', expiresOn: null, status: 'active', updatedAt: null, updatedByName: '', revokedAt: null, revokedByName: '', revokeReason: '',
  envMissingAt: null, lastUsedAt: null, callsDay: 0, errorsDay: 0, source: 'portal', createdByName: 'Админов А. А.', ...over,
})
const state = {
  keys: [
    base({ id: 'k-tender', name: 'Тендерный отдел', prefix: 'osp_Ab12Cd34', scopes: ['kp', 'larix'], createdAt: at(3000), lastUsedAt: at(5), callsDay: 702, errorsDay: 3, note: 'Петров, доб. 214' }),
    base({ id: 'k-env', name: 'Ключ из настроек сервера № 1', prefix: 'a1b2', scopes: ['kp', 'supply'], source: 'env', createdByName: 'Настройки сервера', createdAt: at(9000), lastUsedAt: at(60), callsDay: 12 }),
    base({ id: 'k-old', name: 'Старый расчётчик', prefix: 'osp_Zz99Yy88', scopes: ['supply'], status: 'revoked', revokedAt: at(2000), revokedByName: 'Админов А. А.', revokeReason: 'Сотрудник уволился', createdAt: at(20000) }),
  ],
  calls: [],
  requests: [],
}
for (let i = 0; i < Number(params.get('apiKeysMany') || 0); i++) {
  state.keys.push(base({ id: `k-many-${i}`, name: `Система ${i + 1}`, prefix: `osp_M${String(i).padStart(7, '0')}`, scopes: ['kp'], createdAt: at(30000 + i) }))
}
let callId = 1000
for (let i = 0; i < 130; i++) {
  const forbidden = i % 10 === 3
  state.calls.push({ id: callId--, at: at(i * 3), keyId: 'k-tender', keyName: 'Тендерный отдел', keyPrefix: 'osp_Ab12Cd34', keyDeleted: false,
    resource: forbidden ? 'supply' : 'kp', status: forbidden ? 403 : 200, rows: forbidden ? null : 1000, ms: 120 + i, ip: '10.0.0.15', reason: forbidden ? 'forbidden_resource' : '' })
}
state.calls.push({ id: 1, at: at(5000), keyId: 'k-old', keyName: 'Старый расчётчик', keyPrefix: 'osp_Zz99Yy88', keyDeleted: false,
  resource: 'kp', status: 401, rows: null, ms: 4, ip: '10.0.0.77', reason: 'revoked' })
window.__apiKeys = state

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const keyById = (id) => state.keys.find((k) => k.id === id)
let issued = 0

async function handle(url, init) {
  const u = new URL(url, window.location.origin)
  const method = (init?.method || 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(init.body) : undefined
  state.requests.push({ method, path: u.pathname + u.search, body })
  if (params.get('apiKeys') === 'missing') return new Response('<!doctype html><title>ОСП</title>', { status: 200, headers: { 'content-type': 'text/html' } })
  const path = u.pathname.replace('/api/admin/api-keys', '')
  if (method === 'GET' && path === '') return json(200, { resources: RESOURCES, keys: state.keys, today: TODAY })
  if (method === 'GET' && path === '/calls') {
    const key = u.searchParams.get('key')
    const before = Number(u.searchParams.get('before') || 0)
    const limit = Number(u.searchParams.get('limit') || 100)
    const rows = state.calls.filter((c) => (!key || c.keyId === key) && (u.searchParams.get('errors') !== '1' || c.status >= 400) && (!before || c.id < before))
    return json(200, { calls: rows.slice(0, limit), hasMore: rows.length > limit })
  }
  if (method === 'POST' && path === '') {
    if (body.expiresOn && body.expiresOn < TODAY) return json(400, { error: 'Срок действия — сегодня или позже', code: 'OSP_API_KEY_DATE' })
    issued += 1
    const secret = `osp_StandSecret${issued}xxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    const key = base({ id: `k-new-${issued}`, name: body.name, prefix: secret.slice(0, 12), scopes: RESOURCES.map((r) => r.code).filter((c) => body.scopes.includes(c)),
      expiresOn: body.expiresOn || null, note: body.note || '', createdAt: new Date().toISOString() })
    state.keys.unshift(key)
    return json(200, { key, secret })
  }
  const m = /^\/([^/]+)(\/revoke|\/delete)?$/.exec(path)
  const key = m && keyById(decodeURIComponent(m[1]))
  if (!key) return json(404, { error: 'Ключ не найден — обновите список', code: 'OSP_API_KEY_NOT_FOUND' })
  if (m[2] === '/revoke') {
    if (key.status !== 'revoked') Object.assign(key, { status: 'revoked', revokedAt: new Date().toISOString(), revokedByName: 'Админов А. А.', revokeReason: body.reason || '' })
    return json(200, { key })
  }
  if (m[2] === '/delete') {
    state.keys = state.keys.filter((k) => k !== key)
    return json(200, { ok: true })
  }
  if ((body.scopes || body.expiresOn !== undefined) && key.source === 'env') {
    return json(409, { error: 'Права ключа из настроек сервера задаёт строка RATES_API_KEYS', code: 'OSP_API_KEY_ENV' })
  }
  Object.assign(key, body, { note: body.note === null ? '' : body.note ?? key.note, updatedAt: new Date().toISOString(), updatedByName: 'Админов А. А.' })
  return json(200, { key })
}

const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.includes('/api/admin/api-keys')) return handle(url, init)
  return realFetch(input, init)
}

export default function ApiKeysStand() {
  const [toast, setToast] = useState(null)
  return (
    <div className="admin-page" style={{ padding: '1rem' }}>
      <div className="admin-panel">
        <div className="admin-tabpane">
          <ApiKeysTab notify={(kind, text) => setToast({ kind, text })} />
        </div>
      </div>
      {toast && <div className={`admin-toast ${toast.kind === 'ok' ? 'toast-ok' : 'toast-err'}`} role="status">{toast.text}</div>}
    </div>
  )
}
