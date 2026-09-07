// Общие константы раздела «Заявки на проверку ДП/ДС».
// Держим здесь всё, что нужно и доске, и реестру, и карточке — чтобы статусы,
// подписи и цвета не разъезжались между тремя видами (как в taskHelpers.js).

// Порядок в массиве = порядок колонок канбана. «Ожидаем скан» стоит ПОСЛЕ
// «Завершено» намеренно: по системе документ готов, но подписанный бумажный
// оригинал ещё не вернулся.
export const DOC_CHECK_STATUSES = [
  { value: 'new', label: 'Новая заявка', className: 'dcs-new' },
  { value: 'in_progress', label: 'В работе', className: 'dcs-progress' },
  { value: 'edo', label: 'Выгрузка по ЭДО', className: 'dcs-edo' },
  { value: 'signal', label: 'Загрузка в Signal', className: 'dcs-signal' },
  { value: 'accounting', label: 'Занесение в 1С', className: 'dcs-accounting' },
  { value: 'done', label: 'Завершено', className: 'dcs-done' },
  { value: 'awaiting_scan', label: 'Ожидаем скан ДП/ДС (бумага)', className: 'dcs-scan' },
]
export const DOC_CHECK_STATUS_LABEL = Object.fromEntries(DOC_CHECK_STATUSES.map(s => [s.value, s.label]))
export const DOC_CHECK_STATUS_CLASS = Object.fromEntries(DOC_CHECK_STATUSES.map(s => [s.value, s.className]))

// Статусы, в которых заявка считается отработанной. «Ожидаем скан» сюда НЕ
// входит: пока бумага не пришла, заявку рано убирать из работы.
export const CLOSED_DOC_CHECK_STATUSES = new Set(['done'])

export const DOC_TYPES = [
  { value: 'dp', label: 'ДП', title: 'Договор подряда' },
  { value: 'ds', label: 'ДС', title: 'Дополнительное соглашение' },
]
export const DOC_TYPE_LABEL = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.label]))
export const DOC_TYPE_TITLE = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.title]))

// Дата в формате дд.мм.гггг; пустое значение отдаём как пустую строку, чтобы
// вызывающий сам решал, ставить ли прочерк.
export function fmtDocDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU')
}

// «ДП № 12 от 01.03.2026» — одна строка-подпись документа для карточки и списка.
export function docTitle(req) {
  const parts = [DOC_TYPE_LABEL[req?.doc_type] || 'Документ']
  if (req?.doc_number) parts.push(`№ ${req.doc_number}`)
  const date = fmtDocDate(req?.doc_date)
  if (date) parts.push(`от ${date}`)
  return parts.join(' ')
}

// Порядок карточек внутри колонки доски: сначала заданный перетаскиванием
// sort_order, при равенстве — старые сверху (порядок поступления заявок).
export function compareForBoard(a, b) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return new Date(a.created_at) - new Date(b.created_at)
}
