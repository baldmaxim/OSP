import { useRef, useState } from 'react'
import {
  deleteDocument,
  requestDownloadUrl,
  uploadFile,
} from '../services/s3'
import S3DocumentPreview from './S3DocumentPreview'
import './CounterpartyCardChip.css'

// «Карточка компании» одного контрагента — компактный чип под наименованием
// ООО в реестре контрагентов (task 302). Хранится в s3_documents с
// owner_type='counterparty', owner_id=counterparty.id; логически — один файл,
// при замене старый удаляется до загрузки нового.

// Lucide-style inline SVG icons (currentColor, stroke-width 2). Унифицированный
// стиль с ObjectDocumentFileSlot.jsx.
const Icon = ({ children, className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >{children}</svg>
)

const IconPlus = (props) => (
  <Icon {...props}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Icon>
)
const IconFile = (props) => (
  <Icon {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </Icon>
)
const IconEye = (props) => (
  <Icon {...props}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)
const IconDownload = (props) => (
  <Icon {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
)
const IconRefresh = (props) => (
  <Icon {...props}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </Icon>
)
const IconTrash = (props) => (
  <Icon {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </Icon>
)

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

export default function CounterpartyCardChip({ counterparty, card, canEdit, onChange }) {
  const fileInputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const handleDownload = async (e) => {
    e.stopPropagation()
    if (!card) return
    try {
      const { presigned_url } = await requestDownloadUrl(card.s3_key, { fileName: card.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = card.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const handlePreview = (e) => {
    e.stopPropagation()
    if (card) setPreviewOpen(true)
  }

  const handlePick = (e) => {
    e.stopPropagation()
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      // Заменяем: сначала старый, потом новый. Если delete упал —
      // прерываемся, чтобы не плодить orphan.
      if (card) {
        try { await deleteDocument(card) } catch { /* best effort */ }
      }
      const newDoc = await uploadFile({
        file,
        ownerType: 'counterparty',
        ownerId: counterparty.id,
      })
      onChange(newDoc)
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (e) => {
    e.stopPropagation()
    if (!card) return
    if (!window.confirm(`Удалить карточку компании «${counterparty.name}»?`)) return
    setBusy(true)
    try {
      await deleteDocument(card)
      onChange(null)
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cp-card-chip" onClick={(e) => e.stopPropagation()}>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      {card ? (
        <span className={`cp-card-chip-filled${busy ? ' cp-card-chip-busy' : ''}`}>
          <IconFile className="cp-card-chip-icon-file" />
          <span className="cp-card-chip-label">Карточка:</span>
          <span className="cp-card-chip-name" title={card.file_name}>{card.file_name}</span>
          {card.created_at && (
            <span className="cp-card-chip-date" title={`Загружено ${formatDate(card.created_at)}`}>
              · {formatDate(card.created_at)}
            </span>
          )}
          <span className="cp-card-chip-actions">
            <button
              type="button"
              className="cp-card-chip-btn"
              onClick={handlePreview}
              title="Просмотр"
              disabled={busy}
            ><IconEye /></button>
            <button
              type="button"
              className="cp-card-chip-btn"
              onClick={handleDownload}
              title="Скачать"
              disabled={busy}
            ><IconDownload /></button>
            {canEdit && (
              <>
                <button
                  type="button"
                  className="cp-card-chip-btn"
                  onClick={handlePick}
                  title="Заменить"
                  disabled={busy}
                ><IconRefresh /></button>
                <button
                  type="button"
                  className="cp-card-chip-btn cp-card-chip-btn-danger"
                  onClick={handleDelete}
                  title="Удалить"
                  disabled={busy}
                ><IconTrash /></button>
              </>
            )}
          </span>
        </span>
      ) : canEdit ? (
        <button
          type="button"
          className="cp-card-chip-empty"
          onClick={handlePick}
          disabled={busy}
          title="Загрузить карточку компании"
        >
          <IconPlus className="cp-card-chip-icon-plus" />
          {busy ? 'Загрузка…' : 'Карточка компании'}
        </button>
      ) : null}

      {previewOpen && card && (
        <S3DocumentPreview doc={card} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  )
}
