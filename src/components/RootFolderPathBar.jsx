import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import FolderPathCell from './FolderPathCell'
import './RootFolderPathBar.css'

// Путь к ОБЩЕЙ папке раздела — одна на весь реестр, в отличие от пути у
// конкретной записи (FolderPathCell в строке таблицы). Показывается полосой под
// шапкой страницы.
//
// Хранится в таблице `app_settings` (key/value), как и ссылка на общую таблицу в
// заявках на ДС. Отдельная колонка тут не нужна: значение одно на весь раздел, а
// не на запись, и миграции не требует — таблица уже есть.
//
// Открыть проводник кликом нельзя (браузер блокирует file:// и UNC со страницы
// по https), поэтому путь копируется — см. комментарий в FolderPathCell.

export default function RootFolderPathBar({
  settingKey,
  label = 'Общая папка раздела',
  canEdit = false,
  placeholder,
  addLabel = 'Указать путь к общей папке',
}) {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle()
        if (error) throw error
        if (!cancelled) setValue(data?.value || '')
      } catch (err) {
        console.warn(`Не удалось загрузить настройку ${settingKey} (app_settings?):`, err.message)
        if (!cancelled) setValue('')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [settingKey])

  const handleSave = useCallback(async (next) => {
    const nextValue = next.trim() || null
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: settingKey, value: nextValue, updated_at: new Date().toISOString() })
    if (error) {
      alert('Не удалось сохранить путь к общей папке: ' + error.message)
      throw error
    }
    setValue(nextValue || '')
  }, [settingKey])

  // Пока настройка не пришла — полосы нет: иначе на секунду мигает кнопка
  // «Указать путь», как будто путь не задан.
  if (!loaded) return null
  // Путь не задан, а прав задать его нет — полосу не показываем вовсе.
  if (!value && !canEdit) return null

  return (
    <div className="root-fpath">
      <span className="root-fpath-label">{label}</span>
      <FolderPathCell
        variant="banner"
        value={value}
        canEdit={canEdit}
        onSave={handleSave}
        addLabel={addLabel}
        placeholder={placeholder}
      />
    </div>
  )
}
