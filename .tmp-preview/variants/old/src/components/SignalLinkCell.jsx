import { useState } from 'react'
import { copyToClipboard } from '../utils/clipboard'
import './FolderPathCell.css'

// «Путь к Signal» у записи реестра — ссылка на документы в общем хранилище.
// Внешне и по правке — как FolderPathCell (те же классы .fpath*), разница одна:
// веб-ссылку браузер открыть может, поэтому http(s) открывается кликом в новой
// вкладке. Если записан путь (не ссылка) — его можно скопировать, как путь к папке.
//
// В href попадает только http(s): значение вводит человек, и javascript:… выполнился
// бы по клику.
//
// onSave(nextValue) должен вернуть промис; пустая строка означает «очистить».

const isWebUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())

const Svg = ({ children, size = 14, width = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
// Облако — «общее хранилище», отличается от иконки папки у соседнего пути.
const IconCloud = ({ size }) => <Svg size={size}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></Svg>
const IconCopy = () => <Svg><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
const IconCheck = () => <Svg width={2.4}><path d="M20 6 9 17l-5-5" /></Svg>
const IconPencil = () => <Svg><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>

// Короткая подпись ссылки для узкой ячейки: «Signal · домен/…/хвост».
function shortLabel(value) {
  if (isWebUrl(value)) {
    try {
      const u = new URL(value)
      const parts = u.pathname.split('/').filter(Boolean)
      const tail = parts.length ? decodeURIComponent(parts[parts.length - 1]) : ''
      return tail ? `${u.hostname} › ${tail}` : u.hostname
    } catch {
      return value
    }
  }
  const segments = String(value).split(/[\\/]/).filter(Boolean)
  return segments.length > 2 ? '…\\' + segments.slice(-2).join('\\') : value
}

export default function SignalLinkCell({
  value,
  canEdit = false,
  onSave,
  addLabel = 'путь к Signal',
  placeholder = 'https://… ссылка на папку договора в Signal',
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const startEdit = () => { setDraft(value || ''); setEditing(true) }

  const handleCopy = async () => {
    const ok = await copyToClipboard(value)
    if (!ok) { alert('Не удалось скопировать. Выделите значение и скопируйте вручную.'); return }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const save = async () => {
    if (draft.trim() === (value || '').trim()) { setEditing(false); return }
    setSaving(true)
    try {
      await onSave(draft.trim())
      setEditing(false)
    } catch {
      // Сообщение показывает вызывающий код; поле остаётся открытым, чтобы
      // набранное не пропало.
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="fpath fpath-edit">
        <IconCloud />
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
      ><IconCloud /> {addLabel}</button>
    )
  }

  const web = isWebUrl(value)
  return (
    <div className="fpath fpath-signal" title={value}>
      <IconCloud />
      {web ? (
        <a
          className="fpath-text fpath-link"
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`Открыть в Signal: ${value}`}
        >{shortLabel(value)}</a>
      ) : (
        <span className="fpath-text">{shortLabel(value)}</span>
      )}
      <button
        type="button"
        className="fpath-icon"
        onClick={(e) => { e.stopPropagation(); handleCopy() }}
        title={web ? 'Скопировать ссылку' : 'Скопировать путь'}
        aria-label="Скопировать путь к Signal"
      >{copied ? <IconCheck /> : <IconCopy />}</button>
      {canEdit && (
        <button
          type="button"
          className="fpath-icon"
          onClick={(e) => { e.stopPropagation(); startEdit() }}
          title="Изменить путь к Signal"
          aria-label="Изменить путь к Signal"
        ><IconPencil /></button>
      )}
    </div>
  )
}
