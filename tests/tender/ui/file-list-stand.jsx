// Список файлов (S3DocumentList) с окном просмотра — отдельно от страниц: на нём проверяется переименование в окне.
// Файлы — заявки d2 из ?dcStats=1. ?canEdit=0 — без права правки.
// ?versions=1 — список ВОР с версиями (tests/tender/doc-versions-ui.test.mjs): ведомость фасада в двух версиях, отдельная
// ведомость кровли и «ВОР ОВ»; ?versions=nocol — те же файлы в базе без колонки версий (миграция 20270307 не применена).
import S3DocumentList from '../../../src/components/S3DocumentList'

const params = new URLSearchParams(window.location.search)
const canEdit = params.get('canEdit') !== '0'
const versions = params.get('versions')

if (versions) {
  const row = (id, name, at, group) => ({
    id, owner_type: 'tender', owner_id: 'tender-v', doc_category: 'vor_statement', file_name: name,
    s3_key: `tenders/tender-v/${id}-${name}`, mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size_bytes: 89000, uploaded_by_name: 'Сметова С. С.', created_at: at,
    ...(versions === 'nocol' ? {} : { version_group_id: group }),
  })
  window.__fakeDb.s3_documents.push(
    row('vf-1', 'ВОР фасад 2026-10-09.xlsx', '2026-10-09T10:00:00Z', 'grp-fasad'),
    row('vf-2', 'ВОР фасад 2026-10-23.xlsx', '2026-10-23T11:39:00Z', 'grp-fasad'),
    row('vk-1', 'ВОР кровля.xlsx', '2026-10-15T09:00:00Z', null),
    row('vo-1', 'ВОР ОВ.xlsx', '2026-10-01T08:00:00Z', null),
  )
}

export default function FileListStand() {
  return (
    <div style={{ padding: '1rem' }}>
      {versions
        ? <S3DocumentList ownerType="tender" ownerId="tender-v" category="vor_statement" title="Файлы ВОР" canEdit={canEdit} versions />
        : <S3DocumentList ownerType="dc_request" ownerId="d2" title="Файлы" canEdit={canEdit} />}
    </div>
  )
}
