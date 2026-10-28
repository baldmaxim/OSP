// Шаблоны разделов (миграция 20261107_section_templates): файлы, которые раздел даёт скачать всем, —
// «Шаблон Было-Стало» в «Документах» заявок на ДС. «Понятийное соглашение» (тендеры ОС и договоры) с 27.10.2026
// и «Шаблон ДП» в «Документах» договоров (28.10.2026, вместо файла «Шаблон ДГП») — не файлы, а ссылки: см. ниже.
//
// Строка section_templates — постоянный якорь шаблона (строки заводит миграция, код знает страница); сам
// файл — s3_documents (owner_type 'general', owner_id = id строки, doc_category 'section_template').
// Новый файл заменяет прежний: сначала загружается новый, потом удаляется старый — сбой не оставляет
// шаблон без файла. Прикрепить и удалить файл может только администратор (osp-api: WRITE_RULES).
import { db } from '../api'
import { deleteDocument, requestDownloadUrl, uploadFile } from './s3'

export const SECTION_TEMPLATES_TABLE = 'section_templates'
export const SECTION_TEMPLATE_CATEGORY = 'section_template'

export const SECTION_TEMPLATES_MIGRATION = '20261107_section_templates'
export const sectionTemplatesMigrationHint = (migration = SECTION_TEMPLATES_MIGRATION) =>
  `Прикрепить файл можно будет после обновления базы (миграция ${migration}).`

// Коды — те же, что в миграциях (20261107, contracts_dgp — 20261109). contracts_dgp — строка прежнего файла
// «Шаблон ДГП»: шаблон договоров теперь ссылка «Шаблон ДП», а строка нужна, чтобы показать файл, если его успели
// прикрепить.
export const SECTION_TEMPLATE = {
  conceptAgreement: 'tenders_concept_agreement',
  wasBecame: 'dc_was_became',
  contractsDgp: 'contracts_dgp',
}

// ── Шаблон-ссылка ─────────────────────────────────────────────────────────────────────────────────────
// Ссылка на документ (http(s)) или сетевой путь (\\сервер\папка), а не файл. «Понятийное соглашение» — одна
// ссылка на «Тендеры — Основное строительство» и «Договоры и ДС» (правка в одном разделе видна в другом),
// «Шаблон ДП» (договор подряда) — только в «Договорах и ДС». Хранится в app_settings (key/value), как путь к
// общей папке раздела; миграция не нужна. Указывает и меняет администратор. Файл, прикреплённый к шаблону
// раньше, плитка показывает, пока администратор его не удалит.
export const SECTION_TEMPLATE_LINK_KEY = {
  conceptAgreement: 'concept_agreement_template_link',
  contractsDp: 'contracts_dp_template_link',
}

export const isWebLink = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())
export const isNetworkPath = (v) => /^\\\\[^\\\s]+\\\S/.test(String(v || '').trim())

// Ссылка из поля ввода → { value } (пустое — null: ссылку убрали) или { error }.
export function parseTemplateLink(raw) {
  const value = String(raw || '').trim()
  if (!value) return { value: null }
  if (value.length > 2000) return { error: 'Ссылка слишком длинная — не больше 2000 знаков.' }
  if (isWebLink(value) || isNetworkPath(value)) return { value }
  return { error: 'Укажите ссылку целиком, начиная с https://, или сетевой путь вида \\\\сервер\\папка\\файл.docx.' }
}

// → Map(ключ → ссылка); ключа нет в app_settings — нет и в Map.
export async function fetchTemplateLinks(keys) {
  if (!keys.length) return new Map()
  const { data, error } = await db.from('app_settings').select('key, value').in('key', keys)
  if (error) throw error
  return new Map((data || []).filter(r => r.value).map(r => [r.key, r.value]))
}

export async function saveTemplateLink(key, value) {
  const { error } = await db
    .from('app_settings')
    .upsert({ key, value: value || null, updated_at: new Date().toISOString() })
  if (error) throw error
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
