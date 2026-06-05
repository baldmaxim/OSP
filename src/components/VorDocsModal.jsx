import { useEffect } from 'react'
import S3DocumentList from './S3DocumentList'
import './S3DocumentList.css'

// task 393: модалка с документами «ВОРы и РД» для тендера.
// Использует общий S3-стек (owner_type='tender', категория 'vor'), переиспользует
// стили модалки из S3DocumentList.css.
export default function VorDocsModal({ tenderId, title = 'Документы ВОР и РД', onClose, onChange }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="s3-doc-modal-overlay" onClick={onClose}>
      <div
        className="s3-doc-modal"
        style={{ height: 'auto', maxHeight: '92vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="s3-doc-modal-header">
          <span className="s3-doc-modal-title">{title}</span>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body" style={{ display: 'block', padding: '1rem', background: 'var(--bg-secondary)' }}>
          <S3DocumentList
            ownerType="tender"
            ownerId={tenderId}
            category="vor"
            title="Файлы"
            onChange={onChange}
          />
        </div>
      </div>
    </div>
  )
}
