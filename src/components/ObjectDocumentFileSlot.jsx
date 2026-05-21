import { useEffect, useRef, useState } from 'react'
import { deleteDocument, requestDownloadUrl, uploadFile } from '../services/s3'
import './ObjectDocumentFileSlot.css'

// Один слот файла для документа объекта (подписанный либо редактируемый).
// Используется внутри модалки добавления/редактирования object_documents.
// Файл сразу заливается в S3 — родитель получает s3_documents-запись через
// onUploaded и сам решает, когда привязать её FK к object_documents.
//
// При замене файла предыдущая S3-запись удаляется тут же.
// Удаление при отмене формы — обязанность родителя (он знает, какие записи
// были pending, а какие уже были привязаны до открытия формы).

function formatBytes(bytes) {
  if (bytes == null) return ''
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default function ObjectDocumentFileSlot({
  slot,                  // 'signed' | 'editable' — для подписей/стилей
  currentDoc,            // s3_documents запись или null
  ownerId,               // object_id
  onUploaded,            // (newS3Doc) => void
  onRemoved,             // () => void — после успешного удаления
  onUploadingChange,     // (bool) => void — родителю, чтобы дизейблить Save
  disabled = false,
}) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    onUploadingChange?.(uploading)
  }, [uploading, onUploadingChange])

  const label = slot === 'signed' ? 'Подписанный' : 'Редактируемый'
  const accentClass = slot === 'signed' ? 'doc-slot-signed' : 'doc-slot-editable'

  const handlePick = () => {
    if (disabled || uploading) return
    inputRef.current?.click()
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return

    setUploading(true)
    setError(null)
    let newDoc = null
    try {
      newDoc = await uploadFile({ file, ownerType: 'object', ownerId })
    } catch (err) {
      setError(err.message || 'Ошибка загрузки')
      setUploading(false)
      return
    }

    // Если был старый файл — удаляем его (после успешной загрузки нового).
    if (currentDoc) {
      try { await deleteDocument(currentDoc) } catch { /* лучшее усилие */ }
    }

    setUploading(false)
    onUploaded(newDoc)
  }

  const handleDownload = async () => {
    if (!currentDoc) return
    try {
      const { presigned_url } = await requestDownloadUrl(currentDoc.s3_key)
      // Принудительное скачивание в новой вкладке/без навигации.
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = currentDoc.file_name || ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      setError(err.message || 'Ошибка скачивания')
    }
  }

  const handleRemove = async () => {
    if (!currentDoc || disabled || uploading) return
    if (!window.confirm(`Удалить файл «${currentDoc.file_name}»?`)) return
    setUploading(true)
    setError(null)
    try {
      await deleteDocument(currentDoc)
      onRemoved()
    } catch (err) {
      setError(err.message || 'Ошибка удаления')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={`doc-slot ${accentClass}`}>
      <div className="doc-slot-header">
        <span className="doc-slot-label">{label}</span>
        {uploading && <span className="doc-slot-status">Загрузка…</span>}
      </div>

      <input
        ref={inputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />

      {!currentDoc ? (
        <button
          type="button"
          className="doc-slot-upload-btn"
          onClick={handlePick}
          disabled={disabled || uploading}
        >
          {uploading ? 'Загрузка…' : '⬆ Загрузить файл'}
        </button>
      ) : (
        <div className="doc-slot-file">
          <div className="doc-slot-file-info">
            <span className="doc-slot-file-name" title={currentDoc.file_name}>
              📄 {currentDoc.file_name}
            </span>
            {currentDoc.size_bytes != null && (
              <span className="doc-slot-file-size">{formatBytes(currentDoc.size_bytes)}</span>
            )}
          </div>
          <div className="doc-slot-file-actions">
            <button
              type="button"
              className="doc-slot-action"
              onClick={handleDownload}
              disabled={uploading}
              title="Скачать"
            >
              ⬇
            </button>
            <button
              type="button"
              className="doc-slot-action"
              onClick={handlePick}
              disabled={disabled || uploading}
              title="Заменить"
            >
              🔄
            </button>
            <button
              type="button"
              className="doc-slot-action doc-slot-action-remove"
              onClick={handleRemove}
              disabled={disabled || uploading}
              title="Удалить файл"
            >
              🗑
            </button>
          </div>
        </div>
      )}

      {error && <div className="doc-slot-error">{error}</div>}
    </div>
  )
}
