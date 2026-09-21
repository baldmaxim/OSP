// ПСДЦ / ВОР: обращения к базе и файловому хранилищу.
//
// Все изменения идут через функции базы (supabase/migrations/20260908_psdc.sql):
// там проверяются права, статус документа, выполняется расчёт и атомарное
// применение. Здесь — только транспорт и сборка файлов.
import { saveAs } from 'file-saver'
import { supabase } from '../supabase'
import { requestDownloadUrl, uploadFile, deleteS3Object } from './s3'
import { fetchAllRows } from '../utils/fetchAllRows'
import {
  readPsdcWorkbook, buildErrorCopy, buildPsdcWorkbook, buildPsdcTemplate, PSDC_LIMITS,
} from '../utils/psdcWorkbook'

const ROWS_PER_REQUEST = 1000
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) {
    const err = new Error(error.message || 'Ошибка запроса')
    err.code = error.code
    err.hint = error.hint
    throw err
  }
  return data
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Загрузка одного XLSX во временную версию и проверка.
// documentId — из карточки документа; для массовой загрузки null + batchId.
// Исходный файл сохраняется в хранилище (нужен для копии с ошибками), но его
// недоступность загрузку не останавливает.
export async function stagePsdcFile(file, { documentId = null, batchId = null } = {}) {
  let parsed
  let bytes = null
  if (file.size > PSDC_LIMITS.fileBytes) {
    parsed = { fatal: [`Файл больше ${Math.round(PSDC_LIMITS.fileBytes / 1024 / 1024)} МБ`], sheetName: null, hasU: false, header: [], rows: [], totals: {} }
  } else {
    bytes = new Uint8Array(await file.arrayBuffer())
    parsed = await readPsdcWorkbook(bytes)
  }

  const meta = {
    source_filename: file.name,
    source_hash: bytes ? await sha256Hex(bytes) : null,
    source_size: file.size,
    sheet_name: parsed.sheetName,
    has_u: parsed.hasU,
    header: parsed.header,
    totals: parsed.totals,
    fatal: parsed.fatal,
  }
  const psdcId = await rpc('psdc_create', { p_document_id: documentId, p_batch_id: batchId, p_meta: meta })

  for (let i = 0; i < parsed.rows.length; i += ROWS_PER_REQUEST) {
    await rpc('psdc_add_rows', { p_psdc_id: psdcId, p_rows: parsed.rows.slice(i, i + ROWS_PER_REQUEST) })
  }

  let sourceWarning = null
  if (bytes) {
    try {
      const stored = await uploadFile({ file, ownerType: 'general', ownerId: psdcId, category: 'psdc_source' })
      try {
        await rpc('psdc_set_source_file', { p_psdc_id: psdcId, p_s3_document_id: stored.id })
      } catch (linkError) {
        try { await deleteS3Object(stored.s3_key) } catch { /* лучшее усилие */ }
        throw linkError
      }
    } catch (e) {
      sourceWarning = `Исходный файл не сохранён в хранилище (${e.message}). Копию с ошибками можно скачать до обновления страницы.`
    }
  }

  const summary = await rpc('psdc_validate', { p_psdc_id: psdcId })
  return { psdcId, summary, bytes, sheetName: parsed.sheetName, sourceWarning }
}

export const getDocumentPsdcState = (documentId) => rpc('psdc_document_state', { p_document_id: documentId })
export const getPsdc = (psdcId) => rpc('psdc_get', { p_psdc_id: psdcId })
export const getPsdcRows = (psdcId) => rpc('psdc_get_rows', { p_psdc_id: psdcId })
export const comparePsdc = (psdcId) => rpc('psdc_compare', { p_psdc_id: psdcId })
export const validatePsdc = (psdcId) => rpc('psdc_validate', { p_psdc_id: psdcId })
export const applyPsdc = (psdcId) => rpc('psdc_apply', { p_psdc_id: psdcId })
export const cancelPsdc = (psdcId) => rpc('psdc_cancel', { p_psdc_id: psdcId })
export const deletePsdc = (psdcId) => rpc('psdc_delete', { p_psdc_id: psdcId })

export const createPsdcBatch = (title) => rpc('psdc_batch_create', { p_title: title })
export const getBatchItems = (batchId) => rpc('psdc_batch_items', { p_batch_id: batchId })
export const getBatchIssues = (batchId, severity = 'error') => rpc('psdc_batch_issues', { p_batch_id: batchId, p_severity: severity })

// Сопоставление перепроверяет каждый файл в базе, поэтому идёт небольшими
// порциями — один запрос не должен упираться в лимит времени выполнения.
// items: [{ psdc_id, document_id | display_id | null, method, note }]
const MAP_CHUNK = 20
export async function setBatchDocuments(items, onProgress) {
  const results = []
  for (let i = 0; i < items.length; i += MAP_CHUNK) {
    results.push(...(await rpc('psdc_batch_set_documents', { p_items: items.slice(i, i + MAP_CHUNK) })))
    onProgress?.(Math.min(items.length, i + MAP_CHUNK), items.length)
  }
  return results
}

export async function setBatchNotes(items) {
  for (let i = 0; i < items.length; i += 2000) {
    await rpc('psdc_batch_set_notes', { p_items: items.slice(i, i + 2000) })
  }
}

// Применение порциями; каждый файл применяется атомарно и независимо.
const APPLY_CHUNK = 20
export async function applyBatch(psdcIds, onProgress) {
  const results = []
  for (let i = 0; i < psdcIds.length; i += APPLY_CHUNK) {
    results.push(...(await rpc('psdc_batch_apply', { p_psdc_ids: psdcIds.slice(i, i + APPLY_CHUNK) })))
    onProgress?.(Math.min(psdcIds.length, i + APPLY_CHUNK), psdcIds.length)
  }
  return results
}

export async function listPsdcBatches() {
  const { data, error } = await supabase
    .from('psdc_batches')
    .select('id, title, created_by_name, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data || []
}

// Документы для ручного сопоставления и автопоиска (весь реестр, постранично).
export function fetchMatchableDocuments() {
  return fetchAllRows((from, to) => supabase
    .from('contracts')
    .select('id, display_id, record_type, contract_number, parent_contract_id, root_contract_id, status, deleted_at, object_id, counterparties(name)')
    .is('deleted_at', null)
    .order('display_id', { ascending: true })
    .range(from, to))
}

// Исходные байты загруженного XLSX из хранилища.
export async function downloadSourceBytes(s3DocumentId) {
  const { data, error } = await supabase.from('s3_documents').select('s3_key, file_name').eq('id', s3DocumentId).single()
  if (error) throw error
  const { presigned_url } = await requestDownloadUrl(data.s3_key)
  const res = await fetch(presigned_url)
  if (!res.ok) throw new Error(`Не удалось получить исходный файл (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

const errorCopyName = (fileName) => fileName.replace(/(\.xlsx)?$/i, ' — ошибки.xlsx')

// Копия исходного файла с подсветкой ошибочных ячеек.
export async function buildPsdcErrorCopy(psdc, cachedBytes = null) {
  const bytes = cachedBytes || (psdc.source_s3_document_id ? await downloadSourceBytes(psdc.source_s3_document_id) : null)
  if (!bytes) throw new Error('Исходный файл недоступен — загрузите его заново')
  const full = await getPsdc(psdc.id)
  const errors = (full.issues || []).filter((i) => i.severity === 'error')
  const sheetName = full.sheet_name
  if (!sheetName) throw new Error('Лист ведомости в файле не найден — подсвечивать нечего, причина указана в ошибках')
  return { bytes: buildErrorCopy(bytes, sheetName, errors), fileName: errorCopyName(full.source_filename) }
}

export async function downloadPsdcErrorCopy(psdc, cachedBytes = null) {
  const { bytes, fileName } = await buildPsdcErrorCopy(psdc, cachedBytes)
  saveAs(new Blob([bytes], { type: XLSX_MIME }), fileName)
}

export async function exportPsdc(psdc, { documentDisplayId = null } = {}) {
  const rows = await getPsdcRows(psdc.id)
  const bytes = buildPsdcWorkbook({ rows, psdc })
  const date = new Date().toISOString().slice(0, 10)
  saveAs(new Blob([bytes], { type: XLSX_MIME }), `ВОР${documentDisplayId ? `_ID${documentDisplayId}` : ''}_${date}.xlsx`)
  await rpc('psdc_log_export', { p_psdc_id: psdc.id })
}

export function downloadPsdcTemplate() {
  saveAs(new Blob([buildPsdcTemplate()], { type: XLSX_MIME }), 'Шаблон_ПСДЦ.xlsx')
}

export function saveBytes(bytes, fileName, mime = XLSX_MIME) {
  saveAs(new Blob([bytes], { type: mime }), fileName)
}
