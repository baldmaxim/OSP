// Стенд «Заявки на заключение ДП» (route=/dp-requests) и большого окна на посторонней странице (route=/stand/dp-alert: стилей реестра нет).
// Данные — здесь, а не в seed.js: подгружаются вместе со стендом, другим страницам не мешают. Люди и объекты вымышленные.
//   dpMissing=1   — базы без миграции 20261227 (таблицы и функций нет);
//   dpRecipient=0 — вошедший не в списке получателей;
//   dpAlerts=N    — у вошедшего N непрочитанных уведомлений;
//   dpFailUpload=1 — загрузка файла падает (заявка не должна появиться).
// Триггер стенда повторяет запрет базы dp_requests_guard: без понятийного соглашения заявка не подаётся, поля отдела автор не меняет.
import { lazy, Suspense } from 'react'
import DpRequestAlert from '../../../src/components/dpRequests/DpRequestAlert'
import DpRequestCreateButton from '../../../src/components/dpRequests/DpRequestCreateButton'

const DpRequestsPage = lazy(() => import('../../../src/pages/DpRequestsPage'))

const params = new URLSearchParams(window.location.search)
const fdb = window.__fakeDb
const me = params.get('asUser') || 'user-1'
const canWork = !(params.get('noEdit') || '').split(',').includes('dp_requests')
const WORK_FIELDS = ['object_id', 'contract_title', 'amount', 'responsible_contact_id', 'responsible_name', 'responsible_role']

const ECON = { full_name: 'Экономов Андрей Петрович', position: 'Экономист' }
const BOSS = { full_name: 'Строев Борис Иванович', position: 'Руководитель строительства' }
const OTHER = { full_name: 'Дальний Олег Сергеевич', position: 'Экономист' }

fdb.objects = [
  { id: 'obj-1', name: 'ЖК «Северный квартал»', status: 'main_construction' },
  { id: 'obj-2', name: 'Бизнес-центр «Нурлы»', status: 'main_construction' },
  { id: 'obj-3', name: 'Склад без сотрудников', status: 'warranty_service' },
]
fdb.object_staff = [
  { id: 'st-1', object_id: 'obj-1', contact_id: 'ct-econ', staff_role: 'economist', sort_order: 0, contacts: ECON },
  { id: 'st-2', object_id: 'obj-1', contact_id: 'ct-boss', staff_role: 'construction_manager', sort_order: 0, contacts: BOSS },
  { id: 'st-3', object_id: 'obj-2', contact_id: 'ct-other', staff_role: 'economist', sort_order: 0, contacts: OTHER },
]

const objectRef = (id) => ({ name: fdb.objects.find((o) => o.id === id)?.name || null })
const request = (id, n, o) => ({
  id, request_number: n, object_id: 'obj-1', objects: objectRef(o.object_id || 'obj-1'), contract_title: `Договор № ${n}`, amount: 1000000 + n,
  responsible_contact_id: 'ct-econ', responsible_name: ECON.full_name, responsible_role: 'economist', reason: `Причина заявки ${n}`,
  status: 'new', created_by: 'author-1', created_by_name: 'Автор Заявки', created_at: `2026-11-0${n}T09:00:00Z`, updated_at: `2026-11-0${n}T09:00:00Z`,
  deleted_at: null, ...o,
})
fdb.dp_requests = [
  request('dp-1', 1, {}),
  request('dp-2', 2, { status: 'in_work', object_id: 'obj-2', objects: objectRef('obj-2'), responsible_contact_id: 'ct-other', responsible_name: OTHER.full_name }),
  request('dp-3', 3, { status: 'completed', created_by: me }),
  request('dp-4', 4, { created_by: me, contract_title: 'Мой новый договор' }),
  request('dp-5', 5, { deleted_at: '2026-11-04T10:00:00Z', deleted_by_name: 'Удалов У. У.' }),
]
const file = (id, owner, category, name) => ({
  id, owner_type: 'dp_request', owner_id: owner, doc_category: category, s3_key: `dp-requests/${owner}/${id}-${name}`, file_name: name,
  mime_type: 'application/pdf', size_bytes: 10, created_at: '2026-11-01T09:00:00Z',
})
fdb.s3_documents = [...(fdb.s3_documents || []),
  file('f-1', 'dp-1', 'dp_concept_agreement', 'Понятийка 1.pdf'),
  file('f-2', 'dp-1', 'dp_contract_doc', 'Договор 1.docx'),
  file('f-3', 'dp-2', 'dp_concept_agreement', 'Понятийка 2.pdf'),
  file('f-3d', 'dp-2', 'dp_contract_doc', 'Договор 2.docx'),
  file('f-4', 'dp-3', 'dp_concept_agreement', 'Понятийка 3.pdf'),
  file('f-4d', 'dp-3', 'dp_contract_doc', 'Договор 3.docx'),
  file('f-5', 'dp-4', 'dp_concept_agreement', 'Понятийка 4.pdf'),
  file('f-6', 'dp-4', 'dp_concept_agreement', 'Понятийка 4б.pdf'),
  file('f-6d', 'dp-4', 'dp_contract_doc', 'Договор 4.docx'),
  file('f-7', 'dp-5', 'dp_concept_agreement', 'Понятийка 5.pdf'),
  file('f-7d', 'dp-5', 'dp_contract_doc', 'Договор 5.docx'),
]
fdb.dp_request_alert_recipients = params.get('dpRecipient') === '0' ? [] : [{ user_id: me, added_at: '2026-11-01T09:00:00Z' }]
fdb.employee_directory = [
  { user_id: me, display_name: 'Стендов Стенд Стендович', full_name: 'Стендов Стенд Стендович', email: 'st@example.invalid', role: 'admin' },
  { user_id: 'user-2', display_name: 'Коллегова Мария Андреевна', full_name: 'Коллегова Мария Андреевна', email: 'm@example.invalid', role: 'lawyer' },
]

const alerts = new Map()
const addAlert = (req) => alerts.set(req.id, {
  request_id: req.id, request_number: req.request_number, object_name: req.objects?.name, contract_title: req.contract_title, amount: req.amount,
  responsible_name: req.responsible_name, responsible_role: req.responsible_role, reason: req.reason, created_by_name: req.created_by_name,
  alerted_at: new Date().toISOString(),
})
for (const req of fdb.dp_requests.slice(0, Number(params.get('dpAlerts') || 0))) addAlert(req)
window.__dpAlerts = alerts
window.__dpAcks = []

window.__fakeRpc = {
  ...(window.__fakeRpc || {}),
  dp_request_my_alerts: () => ({ data: [...alerts.values()], error: null }),
  dp_request_alerts_ack: ({ p_requests: ids }) => {
    window.__dpAcks.push(ids)
    for (const id of ids) alerts.delete(id)
    return { data: ids.length, error: null }
  },
}

// Запрет и отметки базы: на подаче — понятийное соглашение, номер, уведомления получателям.
let nextNumber = 100
window.__fakeTriggers = {
  ...(window.__fakeTriggers || {}),
  dp_requests: (row, old) => {
    row.objects = objectRef(row.object_id)
    if (!old) {
      // Правило вставки dp_requests_insert: объект — пусто или из привязки вошедшего (?scope).
      const scope = (params.get('scope') || '').split(',').filter(Boolean)
      if (scope.length && row.object_id && !scope.includes(row.object_id)) {
        const refused = { code: '42501', message: 'new row violates row-level security policy for table "dp_requests"' }
        throw refused
      }
      row.status = 'draft'
      row.created_by = me
      row.created_by_name = params.get('asName') || 'Тест'
      row.deleted_at = null
      return
    }
    if (!canWork && WORK_FIELDS.some((f) => (row[f] ?? null) !== (old[f] ?? null))) {
      const refused = { code: '42501', hint: 'dp_work_fields', message: 'Объект, договор, сумму и ответственного заполняет сотрудник, работающий с заявками' }
      throw refused
    }
    if (old.status === 'draft' && row.status === 'new') {
      const has = (category) => (fdb.s3_documents || []).some((d) => d.owner_id === row.id && d.doc_category === category)
      const refuse = (hint, what) => {
        row.status = 'draft'
        const refused = { code: 'P0001', hint, message: `Заявку на ДП нельзя создать без ${what}: загрузите его файл` }
        throw refused
      }
      if (!has('dp_concept_agreement')) refuse('dp_concept_agreement_required', 'понятийного соглашения')
      row.request_number = nextNumber++
      if (fdb.dp_request_alert_recipients.length) addAlert(row)
    }
  },
}

if (params.get('dpFailUpload') === '1') {
  window.__fakeHold = ({ table, op }) => (table === 's3_documents' && op === 'insert' ? { error: { message: 'Хранилище не ответило' } } : {})
}

if (params.get('dpMissing') === '1') {
  const missing = (table) => ({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` })
  window.__fakeErrors = { ...(window.__fakeErrors || {}), dp_requests: missing('dp_requests'), dp_request_alert_recipients: missing('dp_request_alert_recipients') }
  delete window.__fakeRpc.dp_request_my_alerts
}

export default function DpStand({ page = false }) {
  return (
    <>
      <DpRequestAlert />
      {/* Подают только из «Реестра по договорам» — здесь та же кнопка, без самого реестра. */}
      {page && <div data-testid="registry-button"><DpRequestCreateButton /></div>}
      {page
        ? <Suspense fallback={null}><DpRequestsPage /></Suspense>
        : <div data-testid="other-page">Посторонняя страница</div>}
    </>
  )
}
