// Список файлов (S3DocumentList) с окном просмотра — отдельно от страниц: на нём проверяется переименование в окне.
// Файлы — заявки d2 из ?dcStats=1. ?canEdit=0 — без права правки.
import S3DocumentList from '../../../src/components/S3DocumentList'

const canEdit = new URLSearchParams(window.location.search).get('canEdit') !== '0'

export default function FileListStand() {
  return (
    <div style={{ padding: '1rem' }}>
      <S3DocumentList ownerType="dc_request" ownerId="d2" title="Файлы" canEdit={canEdit} />
    </div>
  )
}
