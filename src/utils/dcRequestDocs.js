// Файлы «Заявок на ДС» (s3_documents, owner_type='dc_request'): разделы и ссылка на файл для выгрузки в Excel.

// Категории файлов заявки, у которых свой блок в колонке «Документы»:
// final — итоговые документы, check_report — отчёт по документам с этапа
// «Итог проверки». Всё остальное — рабочие файлы.
export const SPECIAL_DOC_CATEGORIES = new Set(['final', 'check_report'])

// Разделы — в том же порядке и с теми же подписями, что счётчики основного листа выгрузки.
export const DOC_SECTIONS = [
  { key: 'general', label: 'Документы', has: d => !SPECIAL_DOC_CATEGORIES.has(d.doc_category) },
  { key: 'check_report', label: 'Отчёт по документам', has: d => d.doc_category === 'check_report' },
  { key: 'final', label: 'Итоговые документы', has: d => d.doc_category === 'final' },
]

// Ссылка на файл ведёт на портал, а не в хранилище: подписанная ссылка cloud.ru живёт час, а файл Excel — годами.
// Портал открывает файл тому, кто вошёл и видит заявку в реестре (права — те же, что на странице).
export const DC_FILE_PARAM = 'file'
export const dcRequestFileLink = (docId, origin) =>
  `${origin}/dc-requests?${DC_FILE_PARAM}=${encodeURIComponent(docId)}`

// Строки листа «Документы»: заявки — в порядке выгрузки, внутри — по разделам, в разделе — по дате загрузки
// (docsByReq уже хронологический).
export function dcRequestDocRows(requests, docsByReq) {
  const rows = []
  for (const req of requests) {
    const docs = docsByReq.get(req.id) || []
    for (const section of DOC_SECTIONS) {
      for (const doc of docs.filter(section.has)) rows.push({ req, section, doc })
    }
  }
  return rows
}
