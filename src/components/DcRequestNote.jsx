import { useRef, useState } from 'react'
import AutoGrowTextarea from './AutoGrowTextarea'
import { DC_NOTE_MAX, notePreview } from '../utils/dcRequestNotes'

// Примечание заявки на ДС — выпадающая полоса под заявкой (05.11.2026; образец — примечание юриста в реестре
// договоров): заметки по ходу рассмотрения. Свёрнуто — текст одной строкой, раскрыто — поле: сохраняется при уходе
// из поля и по Ctrl+Enter, Esc отменяет правку. Не сохранилось — текст остаётся в поле, повтор — при следующем уходе.
// onSave(text) → { saved, text } — text отличается от написанного, если коллега успел изменить примечание.
export default function DcRequestNote({ value, open, onToggle, canEdit, onSave }) {
  const [unsaved, setUnsaved] = useState(null)
  const [saving, setSaving] = useState(false)
  const [merged, setMerged] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const [focusOnOpen, setFocusOnOpen] = useState(false)
  const cancelRef = useRef(false)
  const note = value || ''
  const shown = unsaved ?? note
  const preview = notePreview(shown)

  const handleToggle = () => {
    // Пустое поле открывают, чтобы писать; заполненное — чаще чтобы прочитать.
    setFocusOnOpen(!open && canEdit && !preview)
    onToggle()
  }

  const handleBlur = async (e) => {
    setFocusOnOpen(false)
    const typed = e.target.value
    if (cancelRef.current) {
      cancelRef.current = false
      setUnsaved(null)
      setResetKey(k => k + 1)
      return
    }
    if (typed.trim() === note) { setUnsaved(null); return }
    setSaving(true)
    setMerged(false)
    const result = await onSave(typed)
    if (result.saved) {
      setUnsaved(null)
      setMerged((result.text || '') !== typed.trim())
    } else {
      setUnsaved(typed)
    }
    setSaving(false)
  }

  return (
    <div className={`dcr-note${open ? ' is-open' : ''}`}>
      <div className="dcr-note-head">
        <button type="button" className="dcr-note-toggle" onClick={handleToggle} aria-expanded={open}>
          <span className="dcr-docs-chev" aria-hidden>{open ? '▼' : '▶'}</span>
          <span className="dcr-note-title">Примечание</span>
          {!open && (preview
            ? <span className="dcr-note-preview">{preview}</span>
            : <span className="dcr-note-add">добавить</span>)}
        </button>
        {saving ? <span className="dcr-note-status">Сохранение…</span>
          : unsaved !== null ? <span className="dcr-note-status is-error">Не сохранено</span>
            : merged ? <span className="dcr-note-status is-warn">Коллега изменил примечание, пока вы писали: сохранены оба текста</span>
              : null}
      </div>
      {open && (canEdit ? (
        <AutoGrowTextarea
          key={`${resetKey}:${shown}`}
          className="dcr-note-input"
          minHeight={52}
          rows={2}
          maxLength={DC_NOTE_MAX}
          defaultValue={shown}
          readOnly={saving}
          autoFocus={focusOnOpen}
          placeholder="Заметки по ходу рассмотрения ДС"
          aria-label="Примечание к заявке"
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur() }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
          }}
        />
      ) : (
        <div className="dcr-note-text">{note}</div>
      ))}
    </div>
  )
}
