import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { copyToClipboard } from '../utils/clipboard'
import { IconFolder } from './icons/ToolbarIcons'
import './RootFolderPathButton.css'

// Путь к ОБЩЕЙ папке раздела — одна на весь реестр, в отличие от пути у
// конкретной записи (FolderPathCell в строке таблицы). В шапке страницы занимает
// одну иконку: путь длинный, разворачивать его в полосу над реестром — терять
// строку экрана ради значения, которое нужно раз в день.
//
// Хранится в таблице `app_settings` (key/value), как и ссылка на общую таблицу в
// заявках на ДС. Миграции не требует — таблица уже есть.
//
// Открыть проводник кликом нельзя: Chrome и Edge молча блокируют переход на
// file:// и на UNC-путь со страницы, загруженной по https. Поэтому путь
// копируется, а человек вставляет его в адресную строку проводника.

const IconCopy = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const IconCheck = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const IconPencil = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

export default function RootFolderPathButton({
  settingKey,
  title = 'Общая папка раздела',
  label = 'Путь к общей папке',
  canEdit = false,
  placeholder = '\\\\192.168.2.55\\SharA_Tender\\СУБПОДРЯДЫ ДОГОВОРА И ДС',
  // Ключ, из которого берётся значение, пока у `settingKey` своего нет. Нужен
  // после разделения одной общей настройки на несколько (у тендеров путь стал
  // отдельным на каждое направление): старый путь не пропадает с экрана, а
  // первое же сохранение записывает его в собственный ключ вкладки.
  fallbackKey,
  // Необязательный колбэк: сообщает странице текущий путь (нужен, например,
  // схеме хранения документов, которая показывает корень).
  onValueChange,
}) {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef(null)
  // Через ref, чтобы колбэк не приходилось мемоизировать на стороне страницы:
  // иначе новая функция на каждый рендер перезапускала бы загрузку настройки.
  const onValueChangeRef = useRef(onValueChange)
  onValueChangeRef.current = onValueChange

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Оба ключа одним запросом: свой ключ вкладки и запасной общий.
        const keys = fallbackKey ? [settingKey, fallbackKey] : [settingKey]
        const { data, error } = await supabase
          .from('app_settings')
          .select('key, value')
          .in('key', keys)
        if (error) throw error
        const own = data?.find(r => r.key === settingKey)?.value
        const fallback = fallbackKey ? data?.find(r => r.key === fallbackKey)?.value : ''
        const next = own || fallback || ''
        if (!cancelled) { setValue(next); onValueChangeRef.current?.(next) }
      } catch (err) {
        console.warn(`Не удалось загрузить настройку ${settingKey} (app_settings?):`, err.message)
        if (!cancelled) setValue('')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [settingKey, fallbackKey])

  // Закрытие по клику вне и по Escape.
  useEffect(() => {
    if (!open) return
    const onMousedown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setEditing(false) }
    }
    const onKeydown = (e) => { if (e.key === 'Escape' && !editing) { setOpen(false) } }
    document.addEventListener('mousedown', onMousedown)
    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('mousedown', onMousedown)
      document.removeEventListener('keydown', onKeydown)
    }
  }, [open, editing])

  const handleCopy = async () => {
    const ok = await copyToClipboard(value)
    if (!ok) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => { setDraft(value || ''); setEditing(true) }

  const save = useCallback(async () => {
    const nextValue = draft.trim() || null
    if ((nextValue || '') === (value || '')) { setEditing(false); return }
    setSaving(true)
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: settingKey, value: nextValue, updated_at: new Date().toISOString() })
      if (error) throw error
      setValue(nextValue || '')
      onValueChangeRef.current?.(nextValue || '')
      setEditing(false)
    } catch (err) {
      // Поле оставляем открытым: иначе набранный путь молча пропадёт.
      alert('Не удалось сохранить путь к общей папке: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }, [draft, value, settingKey])

  // Пока настройка не пришла — кнопки нет: иначе на секунду мигает «путь не указан».
  if (!loaded) return null
  // Путь не задан, а прав задать его нет — показывать нечего.
  if (!value && !canEdit) return null

  return (
    <div className="rfpath" ref={wrapRef}>
      {/* Составной элемент: слева — раскрытие карточки, справа — копирование
          сразу. Копирование здесь единственное частое действие (проводник из
          браузера не открыть), ради него незачем открывать карточку. */}
      <div className={`rfpath-group${value ? ' has-copy' : ''}`}>
        <button
          type="button"
          className={`rfpath-btn${label ? ' has-label' : ''}${open ? ' is-open' : ''}${value ? '' : ' is-empty'}`}
          onClick={() => setOpen(o => !o)}
          title={value ? `${title}: ${value}` : `${title} — путь не указан`}
          aria-label={label || title}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <IconFolder size={16} />
          {label && <span className="rfpath-btn-label">{label}</span>}
        </button>
        {value && (
          <button
            type="button"
            className="rfpath-copy"
            onClick={handleCopy}
            title="Скопировать путь и вставить в адресную строку проводника"
            aria-label="Скопировать путь к общей папке"
          >
            {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
          </button>
        )}
      </div>

      {open && (
        <div className="rfpath-pop" role="dialog" aria-label={title}>
          <div className="rfpath-pop-head">{title}</div>

          {editing ? (
            <>
              <input
                type="text"
                className="rfpath-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); save() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
                }}
                placeholder={placeholder}
                disabled={saving}
              />
              <div className="rfpath-actions">
                <button type="button" className="rfpath-act is-primary" onClick={save} disabled={saving}>
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button type="button" className="rfpath-act" onClick={() => setEditing(false)} disabled={saving}>
                  Отмена
                </button>
              </div>
            </>
          ) : value ? (
            <>
              <div className="rfpath-path">{value}</div>
              <div className="rfpath-actions">
                <button type="button" className="rfpath-act is-primary" onClick={handleCopy}>
                  {copied ? <IconCheck /> : <IconCopy />}
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
                {canEdit && (
                  <button type="button" className="rfpath-act" onClick={startEdit}>
                    <IconPencil /> Изменить
                  </button>
                )}
              </div>
              <div className="rfpath-hint">
                Вставьте путь в адресную строку проводника: Win+E → Ctrl+L → Ctrl+V.
                Открыть папку прямо из браузера нельзя.
              </div>
            </>
          ) : (
            <>
              <div className="rfpath-hint">Путь к общей папке ещё не указан.</div>
              <div className="rfpath-actions">
                <button type="button" className="rfpath-act is-primary" onClick={startEdit}>
                  <IconPencil /> Указать путь
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
