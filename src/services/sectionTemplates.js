// Шаблоны разделов (миграция 20261107_section_templates): файлы, которые раздел даёт скачать всем, —
// «Понятийное соглашение» в «Документах раздела» тендеров (вкладка «Материалы») и «Шаблон Было-Стало» в
// «Документах» заявок на ДС.
//
// Строка section_templates — постоянный якорь шаблона (строки заводит миграция, код знает страница); сам
// файл — s3_documents (owner_type 'general', owner_id = id строки, doc_category 'section_template').
// Новый файл заменяет прежний: сначала загружается новый, потом удаляется старый — сбой не оставляет
// шаблон без файла. Прикрепить и удалить файл может только администратор (osp-api: WRITE_RULES).
import { db } from '../api'
import { deleteDocument, requestDownloadUrl, uploadFile } from './s3'

export const SECTION_TEMPLATES_TABLE = 'section_templates'
export const SECTION_TEMPLATE_CATEGORY = 'section_template'

export const SECTION_TEMPLATES_MIGRATION_HINT =
  'Прикрепить файл можно будет после обновления базы (миграция 20261107_section_templates).'

// Коды — те же, что в миграции.
export const SECTION_TEMPLATE = {
  conceptAgreement: 'tenders_concept_agreement',
  wasBecame: 'dc_was_became',
}

// Шаблон — документ: Word, а для «Было-Стало» бывает и таблица.
export const SECTION_TEMPLATE_ACCEPT = '.doc,.docx,.rtf,.odt,.xls,.xlsx,.pdf'

export function isMissingSectionTemplatesTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(SECTION_TEMPLATES_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// → { supported, templates: Map<code, { id, code, files }> }; files — новые первыми.
// supported=false — таблицы ещё нет; кода нет в таблице — его нет и в Map.
export async function fetchSectionTemplates(codes) {
  const { data, error } = await db
    .from(SECTION_TEMPLATES_TABLE)
    .select('id, code')
    .in('code', codes)
  if (error) {
    if (isMissingSectionTemplatesTable(error)) return { supported: false, templates: new Map() }
    throw error
  }
  const rows = data || []
  let docs = []
  if (rows.length) {
    const res = await db
      .from('s3_documents')
      .select('*')
      .eq('owner_type', 'general')
      .in('owner_id', rows.map(r => r.id))
      .eq('doc_category', SECTION_TEMPLATE_CATEGORY)
      .order('created_at', { ascending: false })
    if (res.error) throw res.error
    docs = res.data || []
  }
  const templates = new Map(rows.map(r => [r.code, { id: r.id, code: r.code, files: docs.filter(d => d.owner_id === r.id) }]))
  return { supported: true, templates }
}

// Новый файл шаблона; прежние удаляются после загрузки. → имена прежних, которые удалить не удалось.
export async function attachSectionTemplateFile(template, file) {
  await uploadFile({ file, ownerType: 'general', ownerId: template.id, category: SECTION_TEMPLATE_CATEGORY })
  const failed = []
  for (const old of template.files) {
    try {
      await deleteDocument(old)
    } catch (err) {
      console.error('Прежний файл шаблона не удалён:', old.file_name, err?.message)
      failed.push(old.file_name)
    }
  }
  return failed
}

export const removeSectionTemplateFile = (doc) => deleteDocument(doc)

// Скачать под исходным именем (Word в окне просмотра не открывается).
export async function downloadSectionTemplateFile(doc) {
  const { presigned_url } = await requestDownloadUrl(doc.s3_key, { fileName: doc.file_name, download: true })
  const a = document.createElement('a')
  a.href = presigned_url
  a.download = doc.file_name || ''
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
