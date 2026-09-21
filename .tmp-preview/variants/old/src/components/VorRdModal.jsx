import TenderVorRdPanel from './TenderVorRdPanel'
import './S3DocumentList.css'
import './TenderVorRdPanel.css'

// Окно «ВОРы и РД» для реестров (страница «ВОРы и РД», реестр тендеров): та же
// панель, что во вкладке карточки тендера, — РД в PDF с шифрами и ВОР.
// Клик по подложке и Escape окно НЕ закрывают: случайный промах не должен
// прерывать выбор файлов и шифров. Закрытие — крестиком.
export default function VorRdModal({ tenderId, title, canEdit = false, onClose, onChange }) {
  return (
    <div className="s3-doc-modal-overlay">
      <div className="s3-doc-modal tvr-modal" role="dialog" aria-modal="true" style={{ height: 'auto', maxHeight: '92vh' }}>
        <div className="s3-doc-modal-header">
          <span className="s3-doc-modal-title">{title || 'ВОРы и РД'}</span>
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body" style={{ display: 'block', padding: '1rem', background: 'var(--bg-primary)' }}>
          <TenderVorRdPanel tenderId={tenderId} canEdit={canEdit} onChange={onChange} />
        </div>
      </div>
    </div>
  )
}
