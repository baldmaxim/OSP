// Отметка «ТГ» у тендера (публикация в Telegram-канале): три состояния по кругу —
// не опубликовано → опубликовано → не публиковать → не опубликовано.
// «Не публиковать» хранится в tenders.tg_skip (миграция 20261017). Пока колонки нет
// (миграция не применена), реестр её не получает — состояний два, как раньше,
// и в запрос поля tg_skip* не попадают.
export const TG_NONE = 'none'
export const TG_PUBLISHED = 'published'
export const TG_SKIP = 'skip'

// Реестр читает tenders через select('*'): колонка есть в базе — есть и в строке.
export const tgSkipSupported = (tender) => tender != null && Object.hasOwn(tender, 'tg_skip')

export function tgState(tender) {
  if (tender?.tg_published) return TG_PUBLISHED
  if (tender?.tg_skip) return TG_SKIP
  return TG_NONE
}

export function nextTgState(state, skipSupported = true) {
  if (state === TG_NONE) return TG_PUBLISHED
  if (state === TG_PUBLISHED && skipSupported) return TG_SKIP
  return TG_NONE
}

// Поля tenders для нового состояния: «кто / когда» — у выставленного, у прочих пусто.
export function tgPatch(state, by, at = new Date().toISOString(), skipSupported = true) {
  const published = state === TG_PUBLISHED
  const patch = {
    tg_published: published,
    tg_published_at: published ? at : null,
    tg_published_by: published ? by : null,
  }
  if (!skipSupported) return patch
  const skip = state === TG_SKIP
  return { ...patch, tg_skip: skip, tg_skip_at: skip ? at : null, tg_skip_by: skip ? by : null }
}

// Запись в журнал тендера.
export function tgEventDescription(prev, next) {
  if (next === TG_PUBLISHED) return 'Отмечена публикация в ТГ-канале'
  if (next === TG_SKIP) return 'Отмечено: не публиковать в ТГ-канале'
  return prev === TG_SKIP
    ? 'Снята отметка «Не публиковать в ТГ-канале»'
    : 'Снята отметка о публикации в ТГ-канале'
}
