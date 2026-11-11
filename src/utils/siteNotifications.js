// Уведомления руководителя строительства и экономиста объекта (11.11.2026, решение пользователя: «в уведах должны видеть
// только статус по своим тендерам, что там идёт; проверка КП им не нужна, а что с их заявкой на проверку ДП/ДС и ДП —
// должно падать»). Вместо сроков тендеров и договоров и проверки КП у них три списка:
//   • тендеры своих объектов (`user_roles.object_ids`) — текущий статус;
//   • заявки на проверку ДП/ДС своих объектов, кто бы их ни подал («их заявка — это все заявки объекта и статус по ним»,
//     11.11.2026) — колонка доски; в архиве — нет;
//   • заявки на заключение ДП своих объектов и свои без объекта (объект вносит отдел позже) — статус.
// Ключ уведомления — с текущим статусом: сменился статус — уведомление снова непрочитанное (как у проверки КП). Закрытое
// (тендер завершён, заявка завершена) видно RECENT_DAYS дней после последнего изменения, дальше пропадает.
// Расчёт здесь — чистые функции, запросы — в NotificationsContext.
import { ROLES } from '../contexts/roleConstants.js'
import { isClosedMainStatus, shownMainTenderStatus } from './tenderStatuses.js'
import { DOC_CHECK_STATUS_LABEL } from './docCheckHelpers.js'
import { DP_STATUS_LABEL } from './dpRequests.js'

// Роли «со стройки»: у них уведомления о своём, а не о работе отдела. Экономист объекта — не «Экономист ОСП» (economist).
export const SITE_STAFF_ROLES = new Set([ROLES.CONSTRUCTION_MANAGER, 'economist_object'])
export const isSiteStaffRole = (role) => SITE_STAFF_ROLES.has(role)

export const RECENT_DAYS = 14

// Тендер больше не идёт: завершён, перезапущен другим тендером или принят в работу (другие направления).
const TENDER_CLOSED = new Set(['Завершён', 'Принято в работу'])
const tenderClosed = (status) => isClosedMainStatus(status) || TENDER_CLOSED.has(status)
const TENDER_PAUSED = 'Приостановка тендера'

const time = (v) => {
  const t = v ? new Date(v).getTime() : NaN
  return Number.isFinite(t) ? t : 0
}
const recent = (v, since) => time(v) >= since.getTime()

// Тендеры своих объектов. Тендер на материалы — часть основного, отдельной строкой не показывается.
export function tenderStatusNotifications(tenders, { since }) {
  const out = []
  for (const t of tenders || []) {
    if (t.tender_type && t.tender_type !== 'main') continue
    const status = shownMainTenderStatus(t.status, t.department) || 'Статус не указан'
    const closed = tenderClosed(t.status)
    if (closed && !recent(t.updated_at, since)) continue
    out.push({
      kind: 'tender',
      id: t.id,
      key: `tender_status:${t.id}:${status}`,
      objectName: t.objects?.name || 'Тендер',
      subtitle: t.work_description || '',
      badge: t.public_tender_number != null ? `№${t.public_tender_number}` : null,
      statusLabel: status,
      statusTone: closed ? 'closed' : status === TENDER_PAUSED ? 'paused' : 'active',
      date: t.tender_end_date || t.updated_at || null,
      dateLabel: t.tender_end_date ? 'Окончание процедуры' : 'Изменён',
      sortAt: time(t.updated_at),
      days: 0,
      to: `/tenders/${t.id}`,
    })
  }
  return out.sort((a, b) => b.sortAt - a.sortAt)
}

const DOC_TYPE = { dp: 'ДП', ds: 'ДС' }

// Заявки на проверку ДП/ДС: «Завершено» — пока свежее; «Ожидаем скан» — ещё в работе (бумага не вернулась); убранные в
// архив — уже не на доске.
export function docCheckNotifications(requests, { since }) {
  const out = []
  for (const r of requests || []) {
    if (r.deleted_at || r.archived_at) continue
    const done = r.status === 'done'
    if (done && !recent(r.updated_at, since)) continue
    const doc = [DOC_TYPE[r.doc_type] || 'Документ', r.doc_number ? `№ ${r.doc_number}` : ''].filter(Boolean).join(' ')
    out.push({
      kind: 'doc_check',
      id: r.id,
      key: `doc_check:${r.id}:${r.status}`,
      objectName: r.objects?.name || 'Объект не указан',
      subtitle: [doc, r.counterparties?.name].filter(Boolean).join(' — '),
      author: r.created_by_name || '',
      badge: null,
      statusLabel: DOC_CHECK_STATUS_LABEL[r.status] || r.status,
      statusTone: done ? 'closed' : r.status === 'new' ? 'new' : 'active',
      date: r.updated_at || r.created_at || null,
      dateLabel: 'Изменена',
      sortAt: time(r.updated_at || r.created_at),
      days: 0,
      to: `/doc-check-requests?request=${r.id}`,
    })
  }
  return out.sort((a, b) => b.sortAt - a.sortAt)
}

// Заявки на заключение ДП. Черновик (идёт загрузка файлов) — ещё не подан.
export function dpRequestNotifications(requests, { since }) {
  const out = []
  for (const r of requests || []) {
    if (r.deleted_at || !r.status || r.status === 'draft') continue
    const changedAt = r.status_changed_at || r.created_at
    const done = r.status === 'completed'
    if (done && !recent(changedAt, since)) continue
    const number = r.request_number != null ? `Заявка № ${r.request_number}` : 'Заявка'
    out.push({
      kind: 'dp_request',
      id: r.id,
      key: `dp_request:${r.id}:${r.status}`,
      objectName: r.objects?.name || 'Объект не указан',
      subtitle: [number, r.contract_title].filter(Boolean).join(' — '),
      author: r.created_by_name || '',
      badge: r.request_number != null ? `№${r.request_number}` : null,
      statusLabel: DP_STATUS_LABEL[r.status] || r.status,
      statusTone: done ? 'closed' : r.status === 'new' ? 'new' : 'active',
      date: changedAt || null,
      dateLabel: r.status_changed_at ? 'Статус с' : 'Подана',
      sortAt: time(changedAt),
      days: 0,
      to: `/dp-requests?request=${r.id}`,
    })
  }
  return out.sort((a, b) => b.sortAt - a.sortAt)
}
