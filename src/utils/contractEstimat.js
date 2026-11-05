// Отметка «Загружено в Estimat» у договора и ДС (contracts.estimat_status, миграция 20261211, обе базы):
// три состояния по кругу, как «ТГ» у тендеров ОС (utils/tgPublish.js) —
// не загружено → загружено → не загружать → не загружено. У каждого документа своя, ДС от договора не наследует.
export const ESTIMAT_NONE = 'none'
export const ESTIMAT_UPLOADED = 'uploaded'
export const ESTIMAT_SKIP = 'skip'

const STATE_LABEL = {
  [ESTIMAT_NONE]: 'Не загружено в Estimat',
  [ESTIMAT_UPLOADED]: 'Загружено в Estimat',
  [ESTIMAT_SKIP]: 'Не загружать в Estimat',
}

// Реестр читает contracts через select('*'): колонка есть в базе — есть и в строке. Миграции нет — плашки нет.
export const estimatSupported = (doc) => doc != null && Object.hasOwn(doc, 'estimat_status')

export function estimatState(doc) {
  const state = doc?.estimat_status
  return state === ESTIMAT_UPLOADED || state === ESTIMAT_SKIP ? state : ESTIMAT_NONE
}

export function nextEstimatState(state) {
  if (state === ESTIMAT_NONE) return ESTIMAT_UPLOADED
  if (state === ESTIMAT_UPLOADED) return ESTIMAT_SKIP
  return ESTIMAT_NONE
}

// Поля contracts для нового состояния: «кто / когда» — только у выставленного.
export function estimatPatch(state, by, at = new Date().toISOString()) {
  const marked = state !== ESTIMAT_NONE
  return { estimat_status: state, estimat_status_at: marked ? at : null, estimat_status_by: marked ? by : null }
}

const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d.getTime()) ? d.toLocaleDateString('ru-RU') : ''
}

// Подсказка плашки: что выставлено, кто и когда.
export function estimatTitle(doc, canEdit = false) {
  const state = estimatState(doc)
  if (state === ESTIMAT_NONE) return canEdit ? 'Отметить загрузку документа в Estimat' : STATE_LABEL[ESTIMAT_NONE]
  return [STATE_LABEL[state], doc.estimat_status_by, fmtDate(doc.estimat_status_at)].filter(Boolean).join(' · ')
}

// Запись в журнал документа: подписями, а не кодами — история читается людьми.
export function estimatEvent(prev, next) {
  return {
    fieldName: 'estimat_status',
    oldValue: STATE_LABEL[prev],
    newValue: STATE_LABEL[next],
    description: `Отметка Estimat: ${STATE_LABEL[next]}`,
  }
}
