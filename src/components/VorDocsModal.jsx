import S3DocumentList from './S3DocumentList'
import { useRole } from '../contexts/RoleContext'
import './S3DocumentList.css'

// Кто удаляет файл тендера — как сервер (server/osp-api/src/routes/s3Presign.js, CHANGE_RULES): правка «Тендеров» или
// «Тендеров на материалы», у ВОР и РД — ещё и правка «ВОРов и РД».
const VOR_CATEGORIES = new Set(['vor', 'vor_statement', 'rd'])

// task 393: модалка с документами тендера на общем S3-стеке (owner_type='tender').
// Категория задаётся пропом `category`: 'vor' — «ВОРы и РД» (393/396),
// 'tender_package' — «Тендерный пакет» (397). Переиспользует стили из S3DocumentList.css.
// Клик по подложке и Escape окно НЕ закрывают — закрытие только крестиком, чтобы
// случайный промах не прерывал загрузку документов.
export default function VorDocsModal({ tenderId, title = 'Документы ВОР и РД', category = 'vor', onClose, onChange }) {
  const { canEdit } = useRole()
  const canDelete = canEdit('tenders') || canEdit('tenders_materials') || (VOR_CATEGORIES.has(category) && canEdit('vors'))
  return (
    <div className="s3-doc-modal-overlay">
      <div
        className="s3-doc-modal"
        style={{ height: 'auto', maxHeight: '92vh' }}
      >
        <div className="s3-doc-modal-header">
          <span className="s3-doc-modal-title">{title}</span>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body" style={{ display: 'block', padding: '1rem', background: 'var(--bg-secondary)' }}>
          <S3DocumentList
            ownerType="tender"
            ownerId={tenderId}
            category={category}
            title="Файлы"
            canDelete={canDelete}
            onChange={onChange}
          />
        </div>
      </div>
    </div>
  )
}
