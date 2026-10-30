// Реестр расценок → «Расценки от подрядчиков (КП)»: расценки, добавленные вручную (kp_manual_rates, миграция
// 20261122), документ строки реестра и поиск похожих расценок для проверки файла (kp_rates_lookup).
//
// Права — в базе: читает читатель реестра (сотрудник), добавляет, меняет и удаляет право правки «Реестра расценок».
// Файл документа ручной расценки — s3_documents: owner_type 'general', owner_id — строка kp_manual_rates (первая, если
// файл один на несколько строк — «Добавить в реестр» из проверки файла), doc_category 'kp_manual_rate'.
import { db } from '../api'
import { uploadFile, deleteDocument } from './s3'
import { fetchAllRows } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { chunks } from '../utils/kpRateCheck'

export const MANUAL_TABLE = 'kp_manual_rates'
export const MANUAL_DOC_CATEGORY = 'kp_manual_rate'
const MANUAL_FIELDS = 'id, item_type, item_name, unit, price, counterparty_id, object_id, tender_id, rate_date, doc_url, '
  + 's3_document_id, note, created_by_name, created_at, updated_at'
const DOC_FIELDS = 'id, file_name, s3_key, mime_type, size_bytes, created_at, uploaded_by_name'
const INSERT_CHUNK = 200

// Нет таблицы или функции (миграция 20261122 не применена, шлюз их ещё не знает).
export function isMissingManual(err) {
  const msg = String(err?.message || '')
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(err?.code)
    || /kp_manual_rates|kp_rates_lookup/.test(msg) && /does not exist|schema cache|could not find/i.test(msg)
}

function fail(err, text) {
  if (err?.code === '42501') throw new Error('Нет права правки реестра расценок')
  throw new Error(`${text}: ${err?.message || err}`)
}

// Справочники окна: подрядчики (не удалённые), объекты, тендеры (кроме тендеров на материалы).
export async function loadManualOptions() {
  const [counterparties, objects, tenders] = await Promise.all([
    fetchAllRows((from, to) => db.from('counterparties').select('id, name').is('deleted_at', null)
      .order('name').order('id').range(from, to)),
    fetchAllRows((from, to) => db.from('objects').select('id, name').order('name').order('id').range(from, to)),
    fetchAllRows((from, to) => db.from('tenders').select('id, work_description, object_id, public_tender_number')
      .is('deleted_at', null).or('tender_type.is.null,tender_type.neq.materials')
      .order('created_at', { ascending: false }).order('id').range(from, to)),
  ])
  return { counterparties, objects, tenders }
}

export async function loadManualRate(id) {
  const { data, error } = await db.from(MANUAL_TABLE).select(MANUAL_FIELDS).eq('id', id).maybeSingle()
  if (error) fail(error, 'Расценка не прочитана')
  return data
}

// Файл документа (для просмотра): s3_documents по id; нет строки (файл удалён) — null.
export async function loadDocument(id) {
  if (!id) return null
  const { data, error } = await db.from('s3_documents').select(DOC_FIELDS).eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

// Поля строки. Адрес документа и файл — одно из двух (ограничение базы): адрес снимает файл. Ключи у всех строк одной
// вставки одинаковые (PostgREST иначе отказывает).
const rowPayload = (r) => {
  const out = {
    item_type: r.item_type,
    item_name: r.item_name,
    unit: r.unit || null,
    price: r.price,
    counterparty_id: r.counterparty_id,
    object_id: r.object_id || null,
    tender_id: r.tender_id || null,
    rate_date: r.rate_date,
    note: r.note || null,
    doc_url: r.doc_url || null,
  }
  if (out.doc_url) out.s3_document_id = null
  return out
}

// Прикрепить файл к строкам: файл — у первой строки (owner_id), ссылка у всех строк — на него, адрес снимается.
export async function attachManualFile(ids, file) {
  const doc = await uploadFile({ file, ownerType: 'general', ownerId: ids[0], category: MANUAL_DOC_CATEGORY })
  for (const part of chunkList(ids)) {
    const { error } = await db.from(MANUAL_TABLE).update({ s3_document_id: doc.id, doc_url: null }).in('id', part)
    if (error) fail(error, 'Файл загружен, но не прикреплён к расценкам')
  }
  return doc
}

// Файл больше не нужен ни одной строке — удалить (лучшее усилие: строки уже сохранены).
async function dropDocumentIfUnused(docId) {
  if (!docId) return
  const { count, error } = await db.from(MANUAL_TABLE).select('id', { count: 'exact', head: true }).eq('s3_document_id', docId)
  if (error || count > 0) return
  const doc = await loadDocument(docId).catch(() => null)
  if (doc) await deleteDocument(doc).catch(() => {})
}

// Одна расценка (окно «Добавить расценку» / правка): rate — поля формы; file — новый файл документа (вместо адреса и
// прежнего файла), removeFile — снять файл. Ответ — { id, fileError }: строка сохранена, файл не прикрепился —
// fileError (текст), строка остаётся без файла.
export async function saveManualRate(rate, { id = null, file = null, removeFile = false, previousDocId = null } = {}) {
  const payload = rowPayload(rate)
  if (removeFile || file) payload.s3_document_id = null
  let savedId = id
  if (id) {
    const { data, error } = await db.from(MANUAL_TABLE).update(payload).eq('id', id).select('id')
    if (error) fail(error, 'Расценка не сохранена')
    if (!data?.length) throw new Error('Расценка не сохранена: её удалили или нет права правки реестра')
  } else {
    const { data, error } = await db.from(MANUAL_TABLE).insert(payload).select('id').single()
    if (error) fail(error, 'Расценка не добавлена')
    savedId = data.id
  }
  let fileError = null
  if (file) {
    try {
      await attachManualFile([savedId], file)
    } catch (e) {
      fileError = e.message || 'файл не загрузился'
    }
  }
  if (previousDocId && (file || removeFile || payload.doc_url)) await dropDocumentIfUnused(previousDocId)
  return { id: savedId, fileError }
}

// Несколько расценок разом (строки файла → «Добавить в реестр»): rows — поля как у saveManualRate, file — документ
// всех строк. Ответ — { ids, fileError }.
export async function insertManualRates(rows, { file = null, onProgress } = {}) {
  const ids = []
  for (const part of chunks(rows, INSERT_CHUNK)) {
    const { data, error } = await db.from(MANUAL_TABLE).insert(part.map(rowPayload)).select('id')
    if (error) fail(error, ids.length ? `Добавлено ${ids.length} из ${rows.length}, остальные — нет` : 'Расценки не добавлены')
    ids.push(...(data || []).map((r) => r.id))
    onProgress?.(ids.length, rows.length)
  }
  let fileError = null
  if (file && ids.length) {
    try {
      await attachManualFile(ids, file)
    } catch (e) {
      fileError = e.message || 'файл не загрузился'
    }
  }
  return { ids, fileError }
}

// rate — строка реестра (manual_id, source_doc_id) или строка kp_manual_rates (id, s3_document_id). Правила по строкам
// не дают удалить без права молча (0 строк, без ошибки) — это тоже отказ.
export async function deleteManualRate(rate) {
  const id = rate.manual_id ?? rate.id
  const docId = rate.manual_id ? rate.source_doc_id : rate.s3_document_id
  const { data, error } = await db.from(MANUAL_TABLE).delete().eq('id', id).select('id')
  if (error) fail(error, 'Расценка не удалена')
  if (!data?.length) throw new Error('Расценка не удалена: её уже удалили или нет права правки реестра')
  await dropDocumentIfUnused(docId)
}

// Похожие расценки реестра для строк файла: names — наименования (индекс в списке = индекс строки), kinds — вид
// каждой строки ('material' / 'work' / null). Порциями по LOOKUP_CHUNK, строки одного вида — одним вызовом.
// Ответ — Map индекс строки → строки реестра (лучшие первыми). onProgress(сделано, всего).
export async function lookupSimilarRates(names, kinds, { onProgress, signal } = {}) {
  const byKind = new Map()
  names.forEach((name, i) => {
    const k = kinds[i] || ''
    if (!byKind.has(k)) byKind.set(k, [])
    byKind.get(k).push(i)
  })
  const out = new Map()
  let done = 0
  for (const [kind, idxs] of byKind) {
    for (const part of chunks(idxs)) {
      if (signal?.aborted) return out
      const { data, error } = await db.rpc('kp_rates_lookup', { p_names: part.map((i) => names[i]), p_kind: kind || null })
      if (error) throw error
      for (const r of data || []) {
        const i = part[r.idx - 1]
        if (i == null) continue
        if (!out.has(i)) out.set(i, [])
        out.get(i).push(r)
      }
      done += part.length
      onProgress?.(done, names.length)
    }
  }
  return out
}
