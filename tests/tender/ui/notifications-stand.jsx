// Стенд «Уведомлений» (route=/notifications): провайдер и страница, данные — здесь (подгружаются вместе со стендом, другим
// страницам не мешают). Вид рукстроя и экономиста объекта — asRole=construction_manager&asUser=boss-1&scope=obj-1.
//   docCheck=1 — заявки на проверку ДП/ДС добавляются к данным доски (seed.js): переход из уведомления открывает заявку;
//   notifEdo=1 — заявка dc-n1 перешла в «Выгрузку по ЭДО» (смена статуса — уведомление снова непрочитанное).
// Люди и объекты вымышленные.
import { NotificationsProvider } from '../../../src/contexts/NotificationsContext'
import NotificationsPage from '../../../src/pages/NotificationsPage'

const params = new URLSearchParams(window.location.search)
const fdb = window.__fakeDb
const me = params.get('asUser') || 'user-1'
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const dayAhead = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
const objectName = (id) => fdb.objects.find((o) => o.id === id)?.name || null

const tender = (id, n, o) => ({
  id, public_tender_number: n, object_id: 'obj-1', objects: { name: objectName(o.object_id || 'obj-1') },
  work_description: `Работы по тендеру № ${n}`, status: 'Идет тендерная процедура', department: 'construction', tender_type: 'main',
  tender_end_date: null, updated_at: ago(5), deleted_at: null, ...o,
})
fdb.tenders = [
  tender('t-n1', 101, { work_description: 'Монолитные работы', tender_end_date: dayAhead(3), updated_at: ago(1) }),
  tender('t-n2', 102, { status: 'Завершен', updated_at: ago(2) }),
  tender('t-n3', 103, { status: 'Завершен', updated_at: ago(40) }),
  tender('t-n4', 104, { tender_type: 'materials', status: 'В работе', updated_at: ago(1) }),
  tender('t-n5', 105, { object_id: 'obj-2', status: 'Подведение итогов', updated_at: ago(1) }),
  tender('t-n6', 106, { status: 'Заявка на тендер', updated_at: ago(3) }),
  tender('t-n7', 107, { deleted_at: ago(1), updated_at: ago(1) }),
]

// Заявки на проверку ДП/ДС: с docCheck=1 — поверх строк доски (те же поля), иначе — только свои.
const base = fdb.doc_check_requests?.[0] || {}
const docCheck = (id, o) => ({
  ...base, id, object_id: 'obj-1', counterparty_id: 'cp-1', doc_type: 'ds', doc_number: null, status: 'new', deleted_at: null,
  created_by: me, created_at: ago(10), updated_at: ago(10), archived_at: null, ...o,
})
const mine = [
  docCheck('dc-n1', { status: params.get('notifEdo') === '1' ? 'edo' : 'in_progress', doc_number: '7', updated_at: ago(1) }),
  docCheck('dc-n2', { status: 'done', doc_type: 'dp', doc_number: 'СУ-12', updated_at: ago(3) }),
  docCheck('dc-n3', { status: 'done', doc_number: '3', updated_at: ago(30) }),
  // Заявка коллеги по тому же объекту — видна («их заявка — это все заявки объекта»); чужой объект и архив — нет.
  docCheck('dc-n4', { created_by: 'someone-else', created_by_name: 'Экономов А. П.', doc_number: '4', updated_at: ago(2) }),
  docCheck('dc-n5', { doc_number: '5', deleted_at: ago(1), updated_at: ago(1) }),
  docCheck('dc-n6', { created_by: 'someone-else', object_id: 'obj-2', doc_number: '6', updated_at: ago(1) }),
  docCheck('dc-n7', { status: 'done', doc_number: '77', archived_at: ago(1), updated_at: ago(1) }),
]
for (const r of mine) {
  r.objects = { id: r.object_id, name: objectName(r.object_id) }
  r.counterparties = { id: r.counterparty_id, name: fdb.counterparties?.find((c) => c.id === r.counterparty_id)?.name || 'ООО «Монолит»' }
}
fdb.doc_check_requests = [...(fdb.doc_check_requests || []), ...mine]

const dp = (id, n, o) => ({
  id, request_number: n, object_id: 'obj-1', objects: { name: objectName('obj-1') }, contract_title: null, status: 'new',
  status_changed_at: null, created_by: me, created_at: ago(2), deleted_at: null, ...o,
})
fdb.dp_requests = [
  dp('dp-n1', 12, { object_id: null, objects: null }),
  dp('dp-n2', 13, { status: 'in_work', status_changed_at: ago(1), contract_title: 'Договор на монолит', created_at: ago(4) }),
  dp('dp-n3', 14, { status: 'completed', status_changed_at: ago(60), created_at: ago(70) }),
  dp('dp-n4', null, { status: 'draft' }),
  dp('dp-n5', 16, { created_by: 'someone-else', created_by_name: 'Экономов А. П.', created_at: ago(3) }),
  dp('dp-n6', 17, { created_by: 'someone-else', object_id: 'obj-2', objects: { name: objectName('obj-2') } }),
  dp('dp-n7', 18, { created_by: 'someone-else', object_id: null, objects: null }),
]

export default function NotificationsStand() {
  return (
    <NotificationsProvider>
      <NotificationsPage />
    </NotificationsProvider>
  )
}
