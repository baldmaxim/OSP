import { lazy, Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { previewKind } from '../../utils/filePreview'
import { IconDownload } from '../icons/ActionIcons'
import '../S3DocumentList.css'

const SheetPreview = lazy(() => import('../SheetPreview'))

// Просмотр счёта снабжения в кабинете подрядчика (просьба пользователя 25.11.2026: «столбец со счётом и возможностью его посмотреть»).
// Ключа хранилища у подрядчика нет, поэтому окно не S3DocumentPreview, а своё на его каркасе и стилях:
//   • PDF и картинка — по ссылке «показать» (getView → { url, inline }); inline: false — служба подписала ссылку на скачивание
//     (прежняя служба) — тогда «Скачать», а не пустое окно;
//   • Excel — листами (SheetPreview, байты приносит loadBytes);
//   • прочее — «Скачать».
// Окно — в <body>, чтобы таблица его не обрезала. getView, loadBytes и onDownload — свои у каждого открытого файла.
export default function BidSupplyDocViewer({ doc, getView, loadBytes, onDownload, onClose }) {
  const kind = previewKind(null, doc.file_name)
  const linked = kind === 'pdf' || kind === 'image'
  const [view, setView] = useState(null) // { url, inline }
  const [error, setError] = useState('')
  const [dlError, setDlError] = useState('')

  useEffect(() => {
    if (!linked) return undefined
    let cancelled = false
    setView(null)
    setError('')
    getView()
      .then((v) => { if (!cancelled) setView(v) })
      .catch((e) => { if (!cancelled) setError(e.message || 'Файл не открылся') })
    return () => { cancelled = true }
  }, [linked, getView])

  // Escape закрывает; страница позади не прокручивается, пока окно открыто (как у S3DocumentPreview).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const { body } = document
    const prev = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      body.style.overflow = prev
    }
  }, [onClose])

  const download = () => {
    setDlError('')
    Promise.resolve().then(onDownload).catch((e) => setDlError(e.message || String(e)))
  }
  const shown = linked && view?.inline ? view.url : null
  const fallback = (!linked && kind !== 'sheet') || (linked && view && !view.inline)

  return createPortal(
    <div className="s3-doc-modal-overlay s3-doc-preview-overlay" onClick={onClose}>
      <div className="s3-doc-modal s3-doc-preview" role="dialog" aria-modal="true" aria-label={`Счёт снабжения «${doc.file_name}»`}
        onClick={(e) => e.stopPropagation()}>
        <div className="s3-doc-modal-header">
          <div className="s3-doc-preview-name">
            <span className="s3-doc-modal-title" title={doc.file_name}>{doc.file_name}</span>
            <button type="button" className="s3-doc-rename-btn" onClick={download}>
              <IconDownload size={14} /> Скачать
            </button>
            {dlError && <span className="s3-doc-rename-error" role="alert">Не скачался: {dlError}</span>}
          </div>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body">
          {kind === 'sheet' && (
            <Suspense fallback={<div className="s3-doc-empty" style={{ margin: 'auto' }}>Открываем…</div>}>
              <SheetPreview loadBytes={loadBytes} />
            </Suspense>
          )}
          {linked && error && <div className="s3-doc-error" style={{ margin: 'auto' }}>Файл не открылся: {error}</div>}
          {linked && !view && !error && <div className="s3-doc-empty" style={{ margin: 'auto' }}>Открываем…</div>}
          {shown && kind === 'pdf' && <iframe src={shown} className="s3-doc-modal-frame" title={doc.file_name} />}
          {shown && kind === 'image' && <img src={shown} className="s3-doc-modal-img" alt={doc.file_name} />}
          {fallback && (
            <div className="s3-doc-preview-fallback">
              <p>Предпросмотр этого файла здесь недоступен.</p>
              <button type="button" className="s3-doc-btn-primary" onClick={download}>
                <IconDownload /> Скачать «{doc.file_name}»
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
