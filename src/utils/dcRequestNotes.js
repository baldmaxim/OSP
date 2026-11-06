// Примечание заявки на ДС (dc_requests.notes, миграция 20261230): заметки по ходу рассмотрения, одно поле на заявку.

export const DC_NOTE_MAX = 5000 // ограничение в базе

// select('*') отдаёт колонку, только когда миграция применена.
export const hasNoteColumn = (requests) => (requests || []).some(r => r.notes !== undefined)

// Текст примечания одной строкой — для свёрнутой полосы.
export const notePreview = (text) => String(text || '').replace(/\s+/g, ' ').trim()

// Что записать в базу. seen — текст, который человек видел, mine — что написал, current — что в базе сейчас.
// Реестр сам не перечитывается: коллега мог написать своё после открытия страницы, и запись поверх стёрла бы его
// заметку. Поэтому его текст остаётся, а к нему дописывается своё: дописанное в конце — только оно, иначе весь свой
// текст. Человек стёр примечание, а коллега написал новое — новое остаётся.
export function mergeNote(seen, mine, current) {
  const base = seen ?? ''
  const typed = mine ?? ''
  const now = current ?? ''
  if (now === base || now === typed) return mine ?? null
  const added = typed.startsWith(base) ? typed.slice(base.length).trim() : typed
  if (!added) return current
  return now ? `${now}\n${added}` : added
}
