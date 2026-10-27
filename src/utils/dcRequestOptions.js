// Справочники «Заявок на ДС»: этапы, исход проверки по договору, тип ДС, тип материала.
// Общие для реестра (pages/DcRequestsPage.jsx) и отчёта «Отчёты → Заявки на ДС».

// Этапы заявки: сверка с договором → итог проверки → работа → готово
// (миграции 20260823, 20260907).
export const STATUS_OPTIONS = [
  { value: 'contract_check', label: 'Проверка по договору', className: 'status-contract-check' },
  { value: 'check_result', label: 'Итог проверки', className: 'status-check-result' },
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'completed', label: 'Завершено', className: 'status-completed' },
]
export const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(o => [o.value, o.label]))

// Исход сверки заявки с договором (миграции 20260824 + 20260912). Фиксируется
// в окне «Результат проверки» вместе с заключением юриста и файлами отчёта;
// без него заявку нельзя увести со стадии «Проверка по договору».
export const CHECK_STATUS_OPTIONS = [
  { value: 'matches', label: 'Соответствует', short: 'Соответствует', className: 'dcr-verdict-ok' },
  { value: 'matches_with_remarks', label: 'Соответствует с замечаниями', short: 'С замечаниями', className: 'dcr-verdict-warn' },
  { value: 'not_matches', label: 'Не соответствует', short: 'Не соответствует', className: 'dcr-verdict-bad' },
]
// 'not_checked' остаётся только меткой: в истории правок такие записи уже есть.
export const CHECK_STATUS_LABEL = {
  not_checked: 'Не проверено',
  ...Object.fromEntries(CHECK_STATUS_OPTIONS.map(o => [o.value, o.label])),
}
export const CHECK_STATUS_SHORT = Object.fromEntries(CHECK_STATUS_OPTIONS.map(o => [o.value, o.short]))
export const CHECK_STATUS_CLASS = Object.fromEntries(CHECK_STATUS_OPTIONS.map(o => [o.value, o.className]))
export const hasVerdict = (req) => !!req?.check_status && req.check_status !== 'not_checked'

// Тип дополнительного соглашения (миграции 20260824, 20260923).
export const DS_TYPE_OPTIONS = [
  { value: 'psdc_change', label: 'Изменение ПСДЦ', className: 'dstype-rd' },
  { value: 'extra_in_contract', label: 'Доп. работы по текущему договору', className: 'dstype-in' },
  { value: 'extra_out_contract', label: 'Доп. работы вне договора', className: 'dstype-out' },
  { value: 'tender_ds', label: 'ДС по тендеру', className: 'dstype-tender' },
]
export const DS_TYPE_LABEL = {
  // До миграции 20260923 в базе может оставаться прежнее значение.
  rd_change: 'Изменение РД',
  ...Object.fromEntries(DS_TYPE_OPTIONS.map(o => [o.value, o.label])),
}
export const DS_TYPE_CLASS = Object.fromEntries(DS_TYPE_OPTIONS.map(o => [o.value, o.className]))

// task 370: тип материала по ДС.
export const MATERIAL_OPTIONS = [
  { value: 'tolling', label: 'Давальческие (М-15)', className: 'material-tolling' },
  { value: 'realization', label: 'Реализация', className: 'material-realization' },
]
export const MATERIAL_LABEL = Object.fromEntries(MATERIAL_OPTIONS.map(o => [o.value, o.label]))
export const MATERIAL_CLASS = Object.fromEntries(MATERIAL_OPTIONS.map(o => [o.value, o.className]))

// Постоянный «№» заявки — request_number (миграция 20261106): присваивается при создании и не зависит от вкладки
// и фильтров. Пока колонки нет, номер считается здесь тем же порядком, что в миграции: сначала не удалённые, затем
// удалённые, внутри — по дате создания. Список возвращается по номеру: в любой вкладке номера идут по возрастанию.
const byCreation = (a, b) =>
  (a.deleted_at != null) - (b.deleted_at != null)
  || (a.created_at == null) - (b.created_at == null)
  || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function withRequestNumbers(requests) {
  const list = requests || []
  const fallback = list.some(r => r.request_number == null)
    ? new Map([...list].sort(byCreation).map((r, i) => [r.id, i + 1]))
    : new Map()
  return list
    .map(r => ({ ...r, requestNo: r.request_number ?? fallback.get(r.id) }))
    .sort((a, b) => a.requestNo - b.requestNo)
}

// Поиск по номеру заявки: «12» или «№ 12» — ровно эта заявка (подстрокой — № ДС и тексты).
export const matchesRequestNo = (req, query) => {
  const m = /^№?\s*(\d+)$/.exec(String(query || '').trim())
  return !!m && Number(m[1]) === req?.requestNo
}
