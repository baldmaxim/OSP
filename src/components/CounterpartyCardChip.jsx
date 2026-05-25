import { useRef, useState } from 'react'
import {
  deleteDocument,
  requestDownloadUrl,
  uploadFile,
} from '../services/s3'
import './CounterpartyCardChip.css'

// «Карточка компании» одного контрагента — компактный чип под наименованием
// ООО в реестре контрагентов (task 302). Хранится в s3_documents с
// owner_type='counterparty', owner_id=counterparty.id; логически — один файл,
// при замене старый удаляется до загрузки нового.
//
// Props:
//   counterparty — { id, name }
//   card         — текущая s3_documents-запись (объект) или null
//   canEdit      — boolean, разрешать ли загрузку/удаление
//   onChange     — (newCard | null) => void: вызывается после успешной операции
export default function CounterpartyCardChip({ counterparty, card, canEdit, onChange }) {
  const fileInputRef = useRef(null)
  const [busy, setBusy] = useState(false)

  const handleDownload = async (e) => {
    e.stopPropagation()
    if (!card) return
    try {
      const { presigned_url } = await requestDownloadUrl(card.s3_key)
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
          <span className="cp-card-chip-icon" aria-hidden>📎</span>
          <span className="cp-card-chip-label">Карточка:</span>
          <span className="cp-card-chip-name" title={card.file_name}>{card.file_name}</span>
          <button
            type="button"
            className="cp-card-chip-btn"
            onClick={handleDownload}
            title="Скачать"
            disabled={busy}
          >⬇</button>
          {canEdit && (
            <>
              <button
                type="button"
                className="cp-card-chip-btn"
                onClick={handlePick}
                title="Заменить"
                disabled={busy}
              >↻</button>
              <button
                type="button"
                className="cp-card-chip-btn cp-card-chip-btn-danger"
                onClick={handleDelete}
                title="Удалить"
                disabled={busy}
              >×</button>
            </>
          )}
        </span>
      ) : canEdit ? (
        <button
          type="button"
          className="cp-card-chip-empty"
          onClick={handlePick}
          disabled={busy}
          title="Загрузить карточку компании"
        >
          <span aria-hidden>📎</span>
          {busy ? 'Загрузка…' : '+ Карточка компании'}
        </button>
      ) : null}
    </div>
  )
}
