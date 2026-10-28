// Статусы основного тендера (tenders.status — текст, не перечисление базы).
//
// У основного строительства статуса «Заявка на тендер» нет (решение 28.10.2026): тендер ОС с создания —
// «Подготовка ВОР». Прежние тендеры ОС с «Заявкой на тендер» в базе не переписывались — реестр и карточка
// показывают и считают их «Подготовкой ВОР», а первая же правка статуса или формы запишет новое значение.
// Остальные направления (ГО, совместные, прочее) статус сохраняют.
export const TENDER_REQUEST_STATUS = 'Заявка на тендер'
export const VOR_PREP_STATUS = 'Подготовка ВОР'

const MAIN_STATUSES = [
  TENDER_REQUEST_STATUS, VOR_PREP_STATUS, 'Идет тендерная процедура', 'Подведение итогов', 'Завершен', 'Приостановка тендера',
]

const isConstruction = (department) => (department || 'construction') === 'construction'

// Варианты статуса основного тендера направления.
export function mainTenderStatuses(department) {
  return isConstruction(department) ? MAIN_STATUSES.filter(s => s !== TENDER_REQUEST_STATUS) : MAIN_STATUSES
}

// Статус нового основного тендера направления.
export function initialMainTenderStatus(department) {
  return isConstruction(department) ? VOR_PREP_STATUS : TENDER_REQUEST_STATUS
}

// Статус основного тендера, как его показывать и считать: у ОС прежняя «Заявка на тендер» — «Подготовка ВОР».
// Пустое направление — старые записи до tenders.department, это основное строительство.
export function shownMainTenderStatus(status, department) {
  return status === TENDER_REQUEST_STATUS && isConstruction(department) ? VOR_PREP_STATUS : status
}
