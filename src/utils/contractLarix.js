// Путь к Larix.CPM у договора или ДС — ссылка на карточку документа в Larix.
//
// Значение одно и хранится в одной колонке: contracts.document_link (раньше в
// интерфейсе — «Ссылка на документ» / «Документ»). Состояние «внесён в Larix»
// отдельно НЕ хранится — оно выводится из того, заполнен ли путь. Поэтому отметка
// и ссылка не могут разойтись: ссылку вписали — договор внесён, стёрли — «не в Larix».
//
// Колонки contracts.larix_entered / larix_number / larix_entered_at / larix_entered_by
// (миграция 20260805) интерфейс больше не читает и не пишет.
//
// Все места, где нужно имя поля, подпись или состояние, берут их отсюда.

export const LARIX_LINK_FIELD = 'document_link'
export const LARIX_NAME = 'Larix.CPM'
export const LARIX_LINK_LABEL = `Путь к ${LARIX_NAME}`

export const larixLink = (doc) => String(doc?.[LARIX_LINK_FIELD] ?? '').trim()

export const isInLarix = (doc) => larixLink(doc) !== ''

// Карточка договора в Larix по его номеру (contract_id из «ВОР по договорам»). Тот же вид ссылки, что
// вписывают в «Путь к Larix.CPM»; по ней загрузка Larix находит наш договор (larix_sync_finish).
export const LARIX_WEB_URL = 'https://cpm.su10.larix.ru'
export const larixContractUrl = (contractId) =>
  (Number.isSafeInteger(Number(contractId)) && Number(contractId) > 0 ? `${LARIX_WEB_URL}/contract/${Number(contractId)}` : null)
