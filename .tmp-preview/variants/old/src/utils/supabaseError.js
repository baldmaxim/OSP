// Разбор ошибок Supabase/PostgREST для показа пользователю.
//
// supabase-js не бросает исключение — ошибка приезжает объектом { message, code,
// details, hint }. Раньше в UI попадал только message, а без code/details понять,
// что именно отвергла БД, невозможно (особенно когда ошибка есть только у одного
// сотрудника и воспроизвести её на своей машине не получается).

export const SESSION_EXPIRED_MESSAGE =
  'Сессия истекла. Обновите страницу (F5) и войдите заново — изменения не сохранены.'

// Ошибка авторизации: протухший или отсутствующий JWT.
export function isAuthError(error) {
  if (!error) return false
  if (error.status === 401 || error.code === 'PGRST301' || error.code === '401') return true
  return /jwt|token|not authenticated/i.test(error.message || '')
}

// Известные коды Postgres, для которых есть понятное объяснение.
const KNOWN_CODES = {
  '22P05': 'в тексте есть служебные символы, которые база не принимает (обычно приходят при копировании из Word, PDF или 1С)',
  '23505': 'такая запись уже существует',
  '23503': 'связанная запись не найдена или удалена',
  '57014': 'база не успела выполнить запрос за отведённое время — попробуйте ещё раз',
}

// Строка для alert/console: понятная причина, если код известен, плюс технические
// подробности, которые можно переслать разработчику.
export function describeSupabaseError(error) {
  if (!error) return 'неизвестная ошибка'
  const parts = []
  if (error.code && KNOWN_CODES[error.code]) parts.push(KNOWN_CODES[error.code])
  if (error.message) parts.push(error.message)
  if (error.details) parts.push(error.details)
  if (error.hint) parts.push(error.hint)
  if (error.code) parts.push(`код ${error.code}`)
  return parts.length ? parts.join(' · ') : 'неизвестная ошибка'
}
