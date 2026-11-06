// Статусы основного тендера (tenders.status — текст, не перечисление базы).
//
// У основного строительства статуса «Заявка на тендер» нет (решение 28.10.2026): тендер ОС с создания —
// «Подготовка ВОР». Прежние тендеры ОС с «Заявкой на тендер» в базе не переписывались — реестр и карточка
// показывают и считают их «Подготовкой ВОР», а первая же правка статуса или формы запишет новое значение.
// Остальные направления (ГО, совместные, прочее) статус сохраняют.
export const TENDER_REQUEST_STATUS = 'Заявка на тендер'
export const VOR_PREP_STATUS = 'Подготовка ВОР'
// «Перезапуск» (решение пользователя 06.11.2026): тендер перезапущен новым тендером — например, у № 984 в описании
// «перезапуск тендера №40», значит у № 40 этот статус. Процедура по нему закончена, как у «Завершен»: сроки не горят,
// уведомлений нет; победителя и понятийного соглашения не требует. Уже перезапущенные отмечает разовый скрипт
// migration/data/20261106_tenders_restart_status.sql.
export const RESTART_STATUS = 'Перезапуск'
export const COMPLETED_MAIN_STATUS = 'Завершен'

const MAIN_STATUSES = [
  TENDER_REQUEST_STATUS, VOR_PREP_STATUS, 'Идет тендерная процедура', 'Подведение итогов', COMPLETED_MAIN_STATUS,
  'Приостановка тендера', RESTART_STATUS,
]

// Процедура основного тендера закончена: завершён или перезапущен другим тендером.
export const isClosedMainStatus = (status) => status === COMPLETED_MAIN_STATUS || status === RESTART_STATUS

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
