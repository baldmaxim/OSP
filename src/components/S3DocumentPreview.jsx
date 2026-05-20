import { useEffect, useState } from 'react'
import { requestDownloadUrl } from '../services/s3'

// Модалка просмотра S3-документа. PDF и изображения рендерятся прямо в окне
// (iframe / <img>). Для остальных типов — fallback с кнопкой скачать.
// Стили — общий файл S3DocumentList.css.

function isPdf(mime, name) {
  if (mime === 'application/pdf') return true
  return /\.pdf$/i.test(name || '')
}

function isImage(mime, name) {
  if (mime && mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || '')
}

export default function S3DocumentPreview({ doc, onClose }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    requestDownloadUrl(doc.s3_key)
      .then(({ presigned_url }) => { if (!cancelled) setUrl(presigned_url) })
      .catch(e => { if (!cancelled) setError(e.message || 'Не удалось получить ссылку') })
    return () => { cancelled = true }
  }, [doc.s3_key])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const pdf = isPdf(doc.mime_type, doc.file_name)
  const img = isImage(doc.mime_type, doc.file_name)

  return (
    <div className="s3-doc-modal-overlay" onClick={onClose}>
      <div className="s3-doc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="s3-doc-modal-header">
          <span className="s3-doc-modal-title" title={doc.file_name}>{doc.file_name}</span>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body">
          {error && <div className="s3-doc-error" style={{ margin: 'auto' }}>Ошибка: {error}</div>}
          {!url && !error && <div className="s3-doc-empty" style={{ margin: 'auto' }}>Получение ссылки…</div>}
          {url && pdf && (
            <iframe src={url} className="s3-doc-modal-frame" title={doc.file_name} />
          )}
          {url && !pdf && img && (
            <img src={url} className="s3-doc-modal-img" alt={doc.file_name} />
          )}
          {url && !pdf && !img && (
            <div className="s3-doc-preview-fallback">
              <p>Предпросмотр для этого типа файла не поддерживается.</p>
              <a className="s3-doc-btn-primary" href={url} target="_blank" rel="noopener noreferrer">
                ⬇️ Скачать «{doc.file_name}»
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
