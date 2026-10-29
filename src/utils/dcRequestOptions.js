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

// «Статус ОКС» — подаётся ли ДС заказчику (миграция 20261108). У всех заявок по умолчанию «Не проверено»; кто и когда
// сменил — ставит база (submission_by_name / submission_at). hint — что написать в «Комментарии» к этому варианту.
export const SUBMISSION_DEFAULT = 'not_checked'
export const SUBMISSION_OPTIONS = [
  { value: 'submitted', label: 'Подано заказчику', hint: 'Номер письма', className: 'dcr-sub-submitted' },
  { value: 'accepted', label: 'Принято в работу (будет подаваться)', hint: 'Срок подачи', className: 'dcr-sub-accepted' },
  { value: 'not_submitted', label: 'Не будет подаваться', hint: 'Причина', className: 'dcr-sub-not-submitted' },
  { value: 'incomplete', label: 'Неполный комплект', hint: 'Чего не хватает', className: 'dcr-sub-incomplete' },
  { value: SUBMISSION_DEFAULT, label: 'Не проверено', hint: '', className: 'is-empty' },
]
export const SUBMISSION_LABEL = Object.fromEntries(SUBMISSION_OPTIONS.map(o => [o.value, o.label]))
export const SUBMISSION_HINT = Object.fromEntries(SUBMISSION_OPTIONS.map(o => [o.value, o.hint]))
export const SUBMISSION_CLASS = Object.fromEntries(SUBMISSION_OPTIONS.map(o => [o.value, o.className]))
// Колонок нет (миграция не применена) — столбцов «Статус ОКС» и «Комментарий» в реестре нет.
export const hasSubmissionColumns = (requests) => (requests || []).some(r => r.submission_check !== undefined)
export const submissionOf = (req) => req?.submission_check || SUBMISSION_DEFAULT
// Вариант требует пояснения, а комментария нет — поле подсвечивается.
export const submissionNeedsComment = (req) => !!SUBMISSION_HINT[submissionOf(req)] && !req?.submission_comment?.trim()

// Ответственный за статус ОКС (миграция 20261117) — только сотрудник с ролью «Отдел по удорожанию» (ключ роли в базе —
// udorojanie, роли заводит администратор: ищем и по ключу, и по названию). В заявке — submission_resp_user_id и
// ФИО на момент назначения (submission_resp_name). Колонок нет — выбора и фильтра нет.
export const NO_SUBMISSION_RESP = '__none__'
export const hasSubmissionRespColumns = (requests) => (requests || []).some(r => r.submission_resp_user_id !== undefined)
export const isCostIncreaseRole = (key, label) => /^udoroj/i.test(key || '') || /удорож/i.test(label || '')
// Сотрудники «Отдела по удорожанию» из справочника employee_directory (role — ключ роли) по алфавиту.
export function costIncreaseEmployees(employees, roleLabels = {}) {
  return (employees || [])
    .filter(e => e?.user_id && isCostIncreaseRole(e.role, roleLabels?.[e.role]))
    .sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), 'ru'))
}
// Ключ заявки для фильтра «Ответственный ОКС»: id сотрудника или «не назначен».
export const submissionRespKey = (req) => req?.submission_resp_user_id || NO_SUBMISSION_RESP

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
