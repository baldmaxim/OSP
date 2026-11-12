// Смета КП / ПЗ объекта — запросы к базе (миграция 20270215). Таблицы: kp_estimates (документ и его версии),
// kp_estimate_rows (строки, только чтение после загрузки), kp_estimate_marks (отметки), kp_estimate_allocations
// (распределения), kp_estimate_log (история, пишут триггеры). Правила — utils/kpEstimate.js, разбор файлов —
// utils/kpEstimateImport.js.
import { db } from '../api'
import { fetchAllRows, fetchAllRowsParallel } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { uploadFile } from './s3'

export const ESTIMATE_COLUMNS = 'id, object_id, status, title, kp_file_name, pz_file_name, kp_s3_document_id, pz_s3_document_id, meta, row_count, replaced_estimate_id, transfer, created_by_name, created_at, activated_at, updated_at'
export const ROW_COLUMNS = 'id, estimate_id, row_no, parent_row_no, level, kind, row_key, code, pos_no, name, unit, customer_note, gp_note, kp, pz'
export const MARK_COLUMNS = 'id, estimate_id, row_id, note, fill, cell_fills, actual_qty, actual_reason, responsible_id, responsible_name, row_version, updated_at, updated_by, updated_by_name'
export const ALLOC_COLUMNS = 'id, estimate_id, row_id, tender_id, tender_label, pz_qty, counterparty_id, counterparty_name, contract_id, contract_label, contract_qty, note, row_version, created_by_name, created_at, updated_at, updated_by, updated_by_name'
export const LOG_COLUMNS = 'id, estimate_id, row_id, row_label, entity, action, changes, changed_by, changed_by_name, changed_at'

// Таблиц ещё нет (база раньше миграции) или шлюз их не знает.
export const isMissingTable = (error) => ['PGRST205', '42P01', 'PGRST202', '42883'].includes(error?.code)
  || /does not exist|could not find the table/i.test(String(error?.message || ''))

const ROWS_CHUNK = 250

function check({ data, error }) {
  if (error) throw error
  return data
}

// Действующая смета объекта и список версий. { estimate, versions, missing }.
export async function loadEstimateInfo(objectId) {
  const { data, error } = await db.from('kp_estimates').select(ESTIMATE_COLUMNS)
    .eq('object_id', objectId).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 49)
  if (error) {
    if (isMissingTable(error)) return { estimate: null, versions: [], missing: true }
    throw error
  }
  const versions = data || []
  return { estimate: versions.find((v) => v.status === 'active') || null, versions, missing: false }
}

export const loadRows = (estimateId) => fetchAllRowsParallel((from, to, withCount) => db.from('kp_estimate_rows')
  .select(ROW_COLUMNS, withCount ? { count: 'exact' } : undefined)
  .eq('estimate_id', estimateId).order('row_no', { ascending: true }).range(from, to))

export const loadMarks = (estimateId) => fetchAllRows((from, to) => db.from('kp_estimate_marks')
  .select(MARK_COLUMNS).eq('estimate_id', estimateId).order('id', { ascending: true }).range(from, to))

export const loadAllocations = (estimateId) => fetchAllRows((from, to) => db.from('kp_estimate_allocations')
  .select(ALLOC_COLUMNS).eq('estimate_id', estimateId).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to))

// Отметки и распределения строк — после правки коллеги (по истории).
export async function reloadForRows(rowIds) {
  const marks = []
  const allocs = []
  for (const part of chunkList([...new Set(rowIds)], 100)) {
    const [m, a] = await Promise.all([
      db.from('kp_estimate_marks').select(MARK_COLUMNS).in('row_id', part),
      db.from('kp_estimate_allocations').select(ALLOC_COLUMNS).in('row_id', part).order('created_at', { ascending: true }).order('id', { ascending: true }),
    ])
    marks.push(...check(m) || [])
    allocs.push(...check(a) || [])
  }
  return { marks, allocs }
}

// Последняя запись истории — с неё начинается слежение за правками коллег.
export async function loadLatestLogId(estimateId) {
  const data = check(await db.from('kp_estimate_log').select('id').eq('estimate_id', estimateId).order('id', { ascending: false }).limit(1))
  return data?.[0]?.id || 0
}

// Новые записи истории (правки коллег) — строки, которые нужно перечитать.
export async function loadLogSince(estimateId, afterId) {
  return check(await db.from('kp_estimate_log').select(LOG_COLUMNS).eq('estimate_id', estimateId).gt('id', afterId)
    .order('id', { ascending: true }).limit(500)) || []
}

// История: по смете или по строке, порциями от новых к старым.
export async function loadLog(estimateId, { rowId = null, beforeId = null, limit = 100 } = {}) {
  let q = db.from('kp_estimate_log').select(LOG_COLUMNS).eq('estimate_id', estimateId)
  if (rowId) q = q.eq('row_id', rowId)
  if (beforeId) q = q.lt('id', beforeId)
  return check(await q.order('id', { ascending: false }).limit(limit)) || []
}

// ── Запись отметок и распределений ──────────────────────────────────────────
// Отметка: правка — только если версия строки та же (иначе коллега успел раньше: { conflict: true }).
export async function saveMark({ estimateId, objectId, rowId, mark, patch }) {
  if (mark?.id) {
    const { data, error } = await db.from('kp_estimate_marks').update(patch)
      .eq('id', mark.id).eq('row_version', mark.row_version).select(MARK_COLUMNS)
    if (error) throw error
    if (!data?.length) return { conflict: true }
    return { mark: data[0] }
  }
  const { data, error } = await db.from('kp_estimate_marks')
    .insert({ estimate_id: estimateId, object_id: objectId, row_id: rowId, ...patch }).select(MARK_COLUMNS)
  if (error) {
    if (error.code === '23505') return { conflict: true }
    throw error
  }
  return { mark: data?.[0] }
}

export async function fetchMark(rowId) {
  const data = check(await db.from('kp_estimate_marks').select(MARK_COLUMNS).eq('row_id', rowId).limit(1))
  return data?.[0] || null
}

export async function insertAllocations(estimateId, objectId, items) {
  const out = []
  for (const part of chunkList(items, 200)) {
    const data = check(await db.from('kp_estimate_allocations')
      .insert(part.map((a) => ({ estimate_id: estimateId, object_id: objectId, ...a }))).select(ALLOC_COLUMNS))
    out.push(...(data || []))
  }
  return out
}

export async function updateAllocation(alloc, patch) {
  const { data, error } = await db.from('kp_estimate_allocations').update(patch)
    .eq('id', alloc.id).eq('row_version', alloc.row_version).select(ALLOC_COLUMNS)
  if (error) throw error
  if (!data?.length) return { conflict: true }
  return { allocation: data[0] }
}

export async function deleteAllocation(id) {
  check(await db.from('kp_estimate_allocations').delete().eq('id', id))
}

// ── Загрузка новой версии документа ─────────────────────────────────────────
// Черновик → строки порциями → исходные файлы → действующая (kp_estimate_activate переносит отметки прежней).
export async function uploadEstimate({ objectId, built, files, onProgress = () => {} }) {
  const { rows, meta } = built
  const estimate = check(await db.from('kp_estimates').insert({
    object_id: objectId, status: 'draft', title: meta.title || '',
    kp_file_name: files.kp?.name || null, pz_file_name: files.pz?.name || null, meta, row_count: rows.length,
  }).select(ESTIMATE_COLUMNS).single())
  try {
    let done = 0
    for (const part of chunkList(rows, ROWS_CHUNK)) {
      check(await db.from('kp_estimate_rows').insert(part.map((r) => ({ ...r, estimate_id: estimate.id, object_id: objectId }))))
      done += part.length
      onProgress({ stage: 'rows', done, total: rows.length })
    }
    // Исходные файлы — к объекту; не загрузились (нет права на файлы, сеть) — смета всё равно рабочая.
    const fileIds = {}
    const fileErrors = []
    for (const kind of ['kp', 'pz']) {
      const file = files[kind]
      if (!file) continue
      onProgress({ stage: 'file', kind })
      try {
        const doc = await uploadFile({ file, ownerType: 'object', ownerId: objectId, category: `kp_estimate_${kind}`, notes: `Смета КП / ПЗ: ${meta.title || ''}`.trim() })
        if (doc?.id) fileIds[`${kind}_s3_document_id`] = doc.id
      } catch (e) {
        fileErrors.push(`${file.name}: ${e.message || e}`)
      }
    }
    if (Object.keys(fileIds).length) check(await db.from('kp_estimates').update(fileIds).eq('id', estimate.id))
    onProgress({ stage: 'activate' })
    const { data: transfer, error } = await db.rpc('kp_estimate_activate', { p_estimate: estimate.id })
    if (error) throw error
    return { estimate: { ...estimate, ...fileIds, status: 'active' }, transfer, fileErrors }
  } catch (e) {
    // Сбой посреди загрузки — черновик убираем (строки уходят с ним), прежняя версия остаётся действующей.
    await db.from('kp_estimates').delete().eq('id', estimate.id).eq('status', 'draft')
    throw e
  }
}

export async function deleteEstimate(estimateId) {
  const data = check(await db.from('kp_estimates').delete().eq('id', estimateId).select('id'))
  if (!data?.length) throw new Error('Смету удалить нельзя: действующую и прежние удаляет только администратор')
}

// Строки прежней версии с оставшимися отметками и распределениями (позиций нет в новом файле).
export async function loadLeftovers(estimateId) {
  const [marks, allocs] = await Promise.all([loadMarks(estimateId), loadAllocations(estimateId)])
  const ids = [...new Set([...marks.map((m) => m.row_id), ...allocs.map((a) => a.row_id)])]
  const rows = []
  for (const part of chunkList(ids, 100)) rows.push(...(check(await db.from('kp_estimate_rows').select(ROW_COLUMNS).in('id', part)) || []))
  return { rows, marks, allocs }
}

// ── Справочники для распределения (только с правом правки сметы) ─────────────
export async function loadPickers(objectId) {
  const settle = async (p) => { try { return await p } catch { return [] } }
  const [tenders, contracts, counterparties, employees] = await Promise.all([
    settle(fetchAllRows((from, to) => db.from('tenders')
      .select('id, object_id, public_tender_number, parent_tender_id, work_description, status, deleted_at')
      .eq('object_id', objectId).order('public_tender_number', { ascending: false }).order('id', { ascending: true }).range(from, to))),
    settle(fetchAllRows((from, to) => db.from('contracts')
      .select('id, object_id, counterparty_id, contract_number, contract_date, record_type, deleted_at, tender_id, status, display_id, work_name')
      .eq('object_id', objectId).order('contract_date', { ascending: false }).order('id', { ascending: true }).range(from, to))),
    settle(fetchAllRows((from, to) => db.from('counterparties')
      .select('id, name, inn, status, deleted_at').order('name', { ascending: true }).order('id', { ascending: true }).range(from, to))),
    settle(fetchAllRows((from, to) => db.from('employee_directory')
      .select('user_id, display_name, full_name, email, role').order('display_name', { ascending: true }).order('user_id', { ascending: true }).range(from, to))),
  ])
  const liveTenders = tenders.filter((t) => !t.deleted_at && !t.parent_tender_id)
  let winners = []
  if (liveTenders.length) {
    for (const part of chunkList(liveTenders.map((t) => t.id), 100)) {
      winners.push(...await settle(db.from('tender_winners').select('tender_id, counterparty_id').in('tender_id', part).then(check)))
    }
  }
  return {
    tenders: liveTenders,
    contracts: contracts.filter((c) => !c.deleted_at),
    counterparties: counterparties.filter((c) => !c.deleted_at),
    employees,
    winners,
  }
}

// Исходные файлы версии (для «Скачать»): строки s3_documents по id.
export async function loadSourceFiles(ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return []
  return check(await db.from('s3_documents').select('id, s3_key, file_name').in('id', list)) || []
}
