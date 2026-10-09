// Все места загрузки файлов в интерфейсе (src/): тип владельца и таблица, из которой берётся owner_id.
// Рецензия 2: файлы вкладки «Документы» тендера шли с типом tender, но с id строки tender_docs, а сервер
// искал владельца только в tenders. Таблица сверена с кодом по каждому вызову. Сканер
// (tests/osp-api/upload-sites.test.mjs) роняет тест, если место загрузки появилось или поменяло тип
// владельца, а здесь — нет; server.test.mjs загружает по каждой паре «тип → таблица».

// Прямые вызовы uploadFile({ …, ownerType: '…' }).
export const UPLOAD_SITES = [
  { file: 'src/components/TenderDocumentsTab.jsx', calls: 1, owner: 'tender', table: 'tender_docs' }, // id из вставки tender_docs
  { file: 'src/components/TenderFinalDocBlock.jsx', calls: 1, owner: 'tender', table: 'tender_docs' }, // ensureTenderFinalDoc → tender_docs
  { file: 'src/services/tenderProposalFiles.js', calls: 2, owner: 'tender', table: 'tenders' }, // КП и файл замечаний
  { file: 'src/services/tenderVorRd.js', calls: 1, owner: 'tender', table: 'tenders' },
  { file: 'src/services/psdc.js', calls: 1, owner: 'general', table: 'psdc' },
  { file: 'src/pages/GeneralDocumentsPage.jsx', calls: 1, owner: 'general_document', table: 'general_documents' },
  { file: 'src/pages/ObjectDetailPage.jsx', calls: 1, owner: 'object', table: 'objects' },
  { file: 'src/components/ObjectDocumentFileSlot.jsx', calls: 1, owner: 'object', table: 'objects' },
  { file: 'src/components/WarrantyActSignModal.jsx', calls: 1, owner: 'object', table: 'objects' },
  { file: 'src/components/CounterpartyCardChip.jsx', calls: 1, owner: 'counterparty', table: 'counterparties' },
  { file: 'src/pages/DcRequestsPage.jsx', calls: 1, owner: 'dc_request', table: 'dc_requests' },
  { file: 'src/components/ConceptAgreementCell.jsx', calls: 1, owner: 'contract', table: 'contracts' },
  { file: 'src/components/ContractClausesTab.jsx', calls: 1, owner: 'contract', table: 'contracts' },
]

// Компонент S3DocumentList грузит сам (uploadFile с его ownerType / ownerId) — места его использования.
export const LIST_SITES = [
  { file: 'src/components/TenderVorRdPanel.jsx', count: 2, owner: 'tender', table: 'tenders' },
  { file: 'src/components/VorDocsModal.jsx', count: 1, owner: 'tender', table: 'tenders' },
  { file: 'src/pages/ContractDetailPage.jsx', count: 1, owner: 'contract', table: 'contracts' },
  { file: 'src/pages/CounterpartiesPage.jsx', count: 2, owner: 'counterparty', table: 'counterparties' },
  { file: 'src/components/doccheck/DocCheckDetailModal.jsx', count: 1, owner: 'doc_check_request', table: 'doc_check_requests' },
  { file: 'src/components/VorRequestModal.jsx', count: 2, owner: 'general', table: 'vor_requests' }, // REQUEST_OWNER_TYPE
  { file: 'src/components/tasks/TaskDetailModal.jsx', count: 1, owner: 'task', table: 'tasks' },
]

// Сам S3DocumentList: uploadFile с типом из props.
export const GENERIC_UPLOADERS = ['src/components/S3DocumentList.jsx']

// Различные пары «тип владельца → таблица».
export const UPLOAD_PAIRS = [...new Map(
  [...UPLOAD_SITES, ...LIST_SITES].map(({ owner, table }) => [`${owner}:${table}`, { owner, table }]),
).values()]
