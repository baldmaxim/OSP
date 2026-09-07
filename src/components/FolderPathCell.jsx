import { useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './FolderPathCell.css'

// Путь к папке с документами в файловом хранилище: показ + копирование +
// правка на месте. Используется в реестрах, где документы физически лежат в
// сетевой папке, а на сайте хранится только ссылка на неё.
//
// ПОЧЕМУ КОПИРОВАНИЕ, А НЕ ССЫЛКА. Открыть проводник по клику со страницы
// нельзя: Chrome и Edge блокируют переход на file:// и на UNC-путь со страницы,
// загруженной по https, причём молча. Это политика браузера, обойти её со
// стороны сайта невозможно. Поэтому путь копируется, а человек вставляет его в
// адресную строку проводника (Win+E → Ctrl+L → Ctrl+V).
//
// onSave(nextValue) должен вернуть промис; пустая строка означает «очистить».

const IconFolder = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)
const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const IconPencil = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

export default function FolderPathCell({
  value,
  canEdit = false,
  onSave,
  addLabel = 'Указать путь к папке',
  placeholder = '\\\\su10-fs\\Тендеры\\ЖК Алия\\Фасады',
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const startEdit = () => { setDraft(value || ''); setEditing(true) }

  const handleCopy = async () => {
    const ok = await copyToClipboard(value)
    if (!ok) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const save = async () => {
    if (draft.trim() === (value || '').trim()) { setEditing(false); return }
    setSaving(true)
    try {
      await onSave(draft.trim())
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="fpath fpath-edit">
        <IconFolder />
        <input
          type="text"
          className="fpath-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save() }
            if (e.key === 'Escape') setEditing(false)
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder={placeholder}
          disabled={saving}
        />
        <button type="button" className="fpath-btn" onClick={save} disabled={saving}>
          {saving ? '…' : 'ОК'}
        </button>
        <button type="button" className="fpath-btn is-cancel" onClick={() => setEditing(false)} disabled={saving}>
          Отмена
        </button>
      </div>
    )
  }

  if (!value) {
    if (!canEdit) return null
    return (
      <button
        type="button"
        className="fpath-add"
        onClick={(e) => { e.stopPropagation(); startEdit() }}
      ><IconFolder /> {addLabel}</button>
    )
  }

  return (
    <div className="fpath" title={value}>
      <IconFolder />
      <span className="fpath-text">{value}</span>
      <button
        type="button"
        className="fpath-icon"
        onClick={(e) => { e.stopPropagation(); handleCopy() }}
        title="Скопировать путь и вставить в адресную строку проводника"
        aria-label="Скопировать путь к папке"
      >{copied ? <IconCheck /> : <IconCopy />}</button>
      {canEdit && (
        <button
          type="button"
          className="fpath-icon"
          onClick={(e) => { e.stopPropagation(); startEdit() }}
          title="Изменить путь"
          aria-label="Изменить путь к папке"
        ><IconPencil /></button>
      )}
    </div>
  )
}
