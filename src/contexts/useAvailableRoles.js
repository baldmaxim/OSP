import { useCallback, useEffect, useRef, useState } from 'react'
import { ROLE_LABELS } from './roleConstants'

// Справочник ролей (таблица roles) — подписи и списки выбора роли.
// Читать его может только вошедший (правило базы roles_select_auth): гостю база отдаёт пустой список без
// ошибки. Поэтому справочник читается при входе и при смене пользователя, а до входа, при ошибке и при пустом
// ответе — встроенные роли (ROLE_LABELS). Раньше он читался один раз при открытии сайта: кто открывал сайт на
// форме входа, после входа видел «0 ролей» и пустые списки до перезагрузки страницы.
// load — запрос справочника, ответ как у db.from(...): { data, error }.
export const builtinRoles = () => Object.entries(ROLE_LABELS).map(([key, label]) => ({ key, label, is_system: true }))

export function useAvailableRoles(userId, load) {
  const [roles, setRoles] = useState(builtinRoles)
  // Ответ на запрос прежнего пользователя (вышел, вошёл другой) не перезаписывает справочник нового.
  const latest = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++latest.current
    const apply = (next) => { if (request === latest.current) setRoles(next) }
    if (!userId) { apply(builtinRoles()); return }
    try {
      const { data, error } = await load()
      if (error) throw error
      apply(data?.length ? data : builtinRoles())
    } catch (err) {
      console.warn('Не удалось загрузить справочник ролей (таблица roles?):', err?.message)
      apply(builtinRoles())
    }
  }, [userId, load])

  useEffect(() => { refresh() }, [refresh])

  return [roles, refresh]
}
