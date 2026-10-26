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
