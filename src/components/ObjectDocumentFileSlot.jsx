import { useEffect, useRef, useState } from 'react'
import { uploadFile, deleteDocument } from '../services/s3'
import { downloadS3File } from './FileDownload'
import './ObjectDocumentFileSlot.css'

// Один слот файла для документа объекта (подписанный либо редактируемый).
// Используется внутри модалки добавления/редактирования object_documents.
// Файл сразу заливается в S3 — родитель получает s3_documents-запись через
// onUploaded и сам решает, когда привязать её FK к object_documents.
//
// Слот сам ничего не удаляет: при замене и удалении он сообщает родителю прежнюю запись
// (onUploaded(новая, прежняя), onRemoved(прежняя)). Родитель знает, какие записи загружены в этой
// форме, а какие уже привязаны к документу: привязанный файл удаляется только после сохранения формы,
// иначе «Заменить» и затем «Отмена» оставляли документ без файла (прежний удалялся сразу, новый — при отмене).
//
// Окно закрыли, пока файл грузился, — догрузившийся файл ни к чему не привязан и удаляется здесь же (раньше оставался
// в хранилище, а ответ приходил в уже закрытую форму). Ход загрузки — в процентах: большой файл не выглядит зависшим.

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
  onUploaded,            // (newS3Doc, previousS3Doc | null) => void
  onRemoved,             // (previousS3Doc) => void — файл убран из формы (удаляет родитель)
  onUploadingChange,     // (bool) => void — родителю, чтобы дизейблить Save
  disabled = false,
}) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [percent, setPercent] = useState(null)
  const [error, setError] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Родителю — только смена «идёт / не идёт». Обработчик берётся последний, но в зависимостях его нет: родитель,
  // передающий новую функцию на каждый рендер, иначе крутил бесконечный цикл перерисовок.
  const onUploadingChangeRef = useRef(onUploadingChange)
  useEffect(() => { onUploadingChangeRef.current = onUploadingChange })
  useEffect(() => {
    onUploadingChangeRef.current?.(uploading)
  }, [uploading])

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
    setPercent(null)
    setError(null)
    let newDoc = null
    try {
      newDoc = await uploadFile({
        file,
        ownerType: 'object',
        ownerId,
        onProgress: ({ stage, loaded, total }) => {
          if (alive.current && stage === 'send' && total > 0) setPercent(Math.min(99, Math.round((loaded / total) * 100)))
        },
      })
    } catch (err) {
      if (!alive.current) return
      setError(err.message || 'Ошибка загрузки')
      setUploading(false)
      return
    }

    if (!alive.current) {
      deleteDocument(newDoc).catch(() => { /* лучшее усилие: файл ни к чему не привязан */ })
      return
    }
    setUploading(false)
    onUploaded(newDoc, currentDoc || null)
  }

  const handleDownload = async () => {
    if (!currentDoc) return
    try {
      await downloadS3File(currentDoc.s3_key, currentDoc.file_name)
    } catch (err) {
      setError(err.message || 'Ошибка скачивания')
    }
  }

  const handleRemove = () => {
    if (!currentDoc || disabled || uploading) return
    if (!window.confirm(`Убрать файл «${currentDoc.file_name}» из документа? Файл удалится при сохранении.`)) return
    setError(null)
    onRemoved(currentDoc)
  }

  return (
    <div className={`doc-slot ${accentClass}`}>
      <div className="doc-slot-header">
        <span className="doc-slot-label">{label}</span>
        {uploading && <span className="doc-slot-status">Загрузка…{percent != null ? ` ${percent} %` : ''}</span>}
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
          {uploading ? (
            `Загрузка…${percent != null ? ` ${percent} %` : ''}`
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Загрузить файл</span>
            </>
          )}
        </button>
      ) : (
        <div className="doc-slot-file">
          <div className="doc-slot-file-info">
            <span className="doc-slot-file-name" title={currentDoc.file_name}>
              <svg className="doc-slot-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              {currentDoc.file_name}
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
              aria-label="Скачать"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
            <button
              type="button"
              className="doc-slot-action"
              onClick={handlePick}
              disabled={disabled || uploading}
              title="Заменить"
              aria-label="Заменить"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
            <button
              type="button"
              className="doc-slot-action doc-slot-action-remove"
              onClick={handleRemove}
              disabled={disabled || uploading}
              title="Удалить файл"
              aria-label="Удалить файл"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {error && <div className="doc-slot-error">{error}</div>}
    </div>
  )
}
