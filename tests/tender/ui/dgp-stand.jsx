// Блок ДГП вкладки «Смета» карточки объекта — отдельно от страницы объекта (у неё десятки запросов).
// ?canEdit=0 — без права правки объекта.
import '../../../src/pages/ObjectDetailPage.css'
import ObjectDgpFiles from '../../../src/components/ObjectDgpFiles'

const canEdit = new URLSearchParams(window.location.search).get('canEdit') !== '0'

export default function DgpStand() {
  return (
    <div className="object-detail-page" style={{ padding: '1rem' }}>
      <div className="tab-content estimate-content">
        <ObjectDgpFiles objectId="11111111-1111-4111-8111-111111111111" canEdit={canEdit} />
      </div>
    </div>
  )
}
