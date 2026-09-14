import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'

// Загрузка данных для выгрузки объектов в Excel (построение листов —
// utils/objectsExport.js).
//
// objectIds — объекты, которые пользователь видит (с учётом привязки к объектам).
// Пустой массив = без ограничения.
//
// Дочерние таблицы тянем ПОСТРАНИЧНО (потолок PostgREST — 1000 строк: смета
// одного объекта его превышает) и фильтруем по объектам на клиенте. Длинный
// .in('object_id', …) по сотне UUID упирается в длину URL (см. task 402), поэтому
// фильтр в запрос ставим, только когда объектов немного.
const IN_FILTER_LIMIT = 50

async function loadTable(table, select, objectIds, order) {
  return fetchAllRows((from, to) => {
    let q = supabase.from(table).select(select)
    if (objectIds.length > 0 && objectIds.length <= IN_FILTER_LIMIT) q = q.in('object_id', objectIds)
    for (const col of order) q = q.order(col, { ascending: true })
    return q.order('id', { ascending: true }).range(from, to)
  })
}

// Необязательные таблицы (площади, ответственные) появились поздними миграциями:
// если их нет, выгрузка всё равно собирается, а в отчёте о них — предупреждение.
async function optional(label, promise, warnings) {
  try {
    return await promise
  } catch (error) {
    warnings.push(`${label}: ${error.message}`)
    return []
  }
}

export async function loadObjectsExportData(objectIds = []) {
  let q = supabase.from('objects').select('*').order('name', { ascending: true })
  if (objectIds.length > 0) q = q.in('id', objectIds)
  const { data: objects, error } = await q
  if (error) throw error

  const warnings = []
  const [documents, estimateItems, warranties, retentions, areas, staff] = await Promise.all([
    loadTable('object_documents',
      'id, object_id, parent_document_id, document_type, name, document_number, document_date, notes, order_number, created_at, signed:s3_documents!signed_s3_document_id(file_name), editable:s3_documents!editable_s3_document_id(file_name)',
      objectIds, ['object_id']),
    loadTable('object_estimate_items', '*', objectIds, ['object_id', 'row_number']),
    optional('Гарантия',
      // Связь с файлом акта — поздняя миграция; без неё берём строки без файла.
      loadTable('object_warranties', '*, actual_start_doc:s3_documents!actual_start_document_id(file_name)', objectIds, ['object_id'])
        .catch(() => loadTable('object_warranties', '*', objectIds, ['object_id'])),
      warnings),
    optional('Гарантийные удержания',
      loadTable('object_warranty_retentions', '*, payments:object_warranty_retention_payments(*)', objectIds, ['object_id']),
      warnings),
    optional('Площади', loadTable('object_areas', '*', objectIds, ['object_id']), warnings),
    optional('Ответственные',
      loadTable('object_staff', 'id, object_id, staff_role, sort_order, contacts(full_name)', objectIds, ['object_id']),
      warnings),
  ])

  return { data: { objects: objects || [], documents, estimateItems, warranties, retentions, areas, staff }, warnings }
}
