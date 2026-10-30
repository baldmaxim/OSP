// «Расчёт ПЗ» в «Документах» планов затрат (миграции 20261116_cost_plan_calc, 20261121_cost_plan_calc_objects):
//  • общие инструкции «Прямые затраты» и «КП до перекидок» — s3_documents (owner_type 'general', owner_id = строка
//    section_templates вида, doc_category 'cost_plan_calc');
//  • документы объекта по расчёту — s3_documents объекта (owner_type 'object', doc_category — вид:
//    cost_plan_direct_costs / cost_plan_kp_before_transfers);
//  • cost_plan_compensation — компенсация НДС и инфляции по объекту (одна строка на объект): да / нет, процент,
//    подтверждающий документ из object_documents объекта, примечание.
//
// Права — в базе и osp-api: читает сотрудник; сведения пишет и файлы (инструкции и документы объекта) загружает и
// удаляет только администратор (osp-api: WRITE_RULES.section_templates, CATEGORY_RULES).
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { COST_PLAN_CALC_CATEGORY, COST_PLAN_CALC_SECTIONS } from '../utils/costPlanCalc'
import { uploadFile } from './s3'
import { SECTION_TEMPLATES_TABLE, isMissingSectionTemplatesTable } from './sectionTemplates'

export const COST_PLAN_COMPENSATION_TABLE = 'cost_plan_compensation'

// Якоря инструкций: → { supported, ids: Map<code, id> }. supported=false — таблицы шаблонов нет; строки кода нет
// (миграция расчёта ПЗ не применена) — нет и в Map.
export async function fetchCalcAnchors(codes) {
  const { data, error } = await db.from(SECTION_TEMPLATES_TABLE).select('id, code').in('code', codes)
  if (error) {
    if (isMissingSectionTemplatesTable(error)) return { supported: false, ids: new Map() }
    throw error
  }
  return { supported: true, ids: new Map((data || []).map(r => [r.code, r.id])) }
}

const BASE_COLUMNS = 'id, object_id, vat_note, inflation_note, updated_at'
const DETAIL_COLUMNS = `${BASE_COLUMNS}, vat_compensated, vat_percent, vat_document_id, inflation_compensated, inflation_percent, inflation_document_id`

export function isMissingCompensationTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(COST_PLAN_COMPENSATION_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}
// Колонок 20261121 ещё нет: 42703 (база) / PGRST204 (кэш схемы шлюза).
function isMissingDetailColumns(err) {
  return err?.code === '42703' || err?.code === 'PGRST204'
}

// Все строки разом — их не больше, чем объектов. → { rows, supported, detailed }: supported=false — таблицы ещё нет,
// detailed=false — нет полей «да / нет», процента и документа (только примечания).
export async function fetchCompensation() {
  const read = (columns) => fetchAllRows((from, to) => db
    .from(COST_PLAN_COMPENSATION_TABLE)
    .select(columns)
    .order('id', { ascending: true })
    .range(from, to))
  try {
    return { rows: await read(DETAIL_COLUMNS), supported: true, detailed: true }
  } catch (err) {
    // Сначала «нет колонки»: её текст («column cost_plan_compensation.… does not exist») похож и на «нет таблицы».
    if (!isMissingDetailColumns(err)) {
      if (isMissingCompensationTable(err)) return { rows: [], supported: false, detailed: false }
      throw err
    }
  }
  return { rows: await read(BASE_COLUMNS), supported: true, detailed: false }
}

// Внести или изменить сведения объекта (одна строка на объект). value — поля из parseCompensation.
export async function saveCompensation(objectId, value, { detailed = true } = {}) {
  const { data, error } = await db
    .from(COST_PLAN_COMPENSATION_TABLE)
    .upsert({ object_id: objectId, ...value }, { onConflict: 'object_id' })
    .select(detailed ? DETAIL_COLUMNS : BASE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteCompensation(objectId) {
  const { error } = await db.from(COST_PLAN_COMPENSATION_TABLE).delete().eq('object_id', objectId)
  if (error) throw error
}

// ── Файлы ───────────────────────────────────────────────────────────────────────────────────────────
const FILE_COLUMNS = 'id, owner_type, owner_id, doc_category, s3_key, file_name, mime_type, size_bytes, uploaded_by_name, created_at'
const filesQuery = () => db.from('s3_documents').select(FILE_COLUMNS)
const newestFirst = (q, from, to) => q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)

// Инструкции (по якорям) и документы всех объектов по расчёту — двумя запросами. → { instructions, objects }.
export async function fetchCalcFiles(anchorIds = []) {
  const categories = COST_PLAN_CALC_SECTIONS.map(s => s.category)
  const [instructions, objects] = await Promise.all([
    anchorIds.length
      ? fetchAllRows((from, to) => newestFirst(filesQuery()
        .eq('owner_type', 'general').in('owner_id', anchorIds).eq('doc_category', COST_PLAN_CALC_CATEGORY), from, to))
      : [],
    fetchAllRows((from, to) => newestFirst(filesQuery()
      .eq('owner_type', 'object').in('doc_category', categories), from, to)),
  ])
  return { instructions, objects }
}

export function uploadInstructionFile(file, anchorId) {
  return uploadFile({ file, ownerType: 'general', ownerId: anchorId, category: COST_PLAN_CALC_CATEGORY })
}

// category — вид документа (COST_PLAN_CALC_SECTIONS[].category).
export function uploadObjectCalcFile(file, objectId, category) {
  return uploadFile({ file, ownerType: 'object', ownerId: objectId, category })
}

// ── Документы объектов (подтверждающий ДС) ─────────────────────────────────────────────────────────
const OBJECT_DOC_COLUMNS = 'id, object_id, name, document_number, document_date, document_type, parent_document_id, notes, order_number, created_at'

// Договор генподряда и ДС объекта — варианты подтверждающего документа (без приложений).
export async function fetchObjectDocOptions(objectId) {
  return fetchAllRows((from, to) => db
    .from('object_documents')
    .select(OBJECT_DOC_COLUMNS)
    .eq('object_id', objectId)
    .is('parent_document_id', null)
    .in('document_type', ['general_contract', 'additional_agreement'])
    .order('order_number', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}

// Названия выбранных документов для показа. Не видна строка (нет права на документы объекта) — её просто нет.
export async function fetchObjectDocsByIds(ids = []) {
  const parts = await Promise.all(chunkList([...new Set(ids)]).map(async (part) => {
    const { data, error } = await db.from('object_documents').select(OBJECT_DOC_COLUMNS).in('id', part)
    if (error) throw error
    return data || []
  }))
  return parts.flat()
}
