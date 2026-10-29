// «Расчёт ПЗ» в «Документах» планов затрат (миграция 20261116_cost_plan_calc):
//  • файлы подвкладок «Прямые затраты» и «КП до перекидок» — s3_documents (owner_type 'general', owner_id = строка
//    section_templates подвкладки, doc_category 'cost_plan_calc'); список и загрузка — S3DocumentList, здесь только
//    якоря списков;
//  • cost_plan_compensation — компенсация НДС и инфляции по объекту: строка = объект (одна на объект), текстом.
//
// Права — в базе: читает сотрудник; сведения о компенсации пишет и файлы загружает только администратор (файлы —
// osp-api, WRITE_RULES.section_templates).
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { SECTION_TEMPLATES_TABLE, isMissingSectionTemplatesTable } from './sectionTemplates'

export const COST_PLAN_COMPENSATION_TABLE = 'cost_plan_compensation'

// Якоря списков файлов: → { supported, ids: Map<code, id> }. supported=false — таблицы шаблонов нет; строки кода
// нет (миграция расчёта ПЗ не применена) — нет и в Map.
export async function fetchCalcAnchors(codes) {
  const { data, error } = await db.from(SECTION_TEMPLATES_TABLE).select('id, code').in('code', codes)
  if (error) {
    if (isMissingSectionTemplatesTable(error)) return { supported: false, ids: new Map() }
    throw error
  }
  return { supported: true, ids: new Map((data || []).map(r => [r.code, r.id])) }
}

const COLUMNS = 'id, object_id, vat_note, inflation_note, updated_at'

export function isMissingCompensationTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(COST_PLAN_COMPENSATION_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Все строки разом — их не больше, чем объектов. → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchCompensation() {
  try {
    const rows = await fetchAllRows((from, to) => db
      .from(COST_PLAN_COMPENSATION_TABLE)
      .select(COLUMNS)
      .order('id', { ascending: true })
      .range(from, to))
    return { rows, supported: true }
  } catch (err) {
    if (isMissingCompensationTable(err)) return { rows: [], supported: false }
    throw err
  }
}

// Внести или изменить сведения объекта (одна строка на объект). value — { vat_note, inflation_note }.
export async function saveCompensation(objectId, value) {
  const { data, error } = await db
    .from(COST_PLAN_COMPENSATION_TABLE)
    .upsert({ object_id: objectId, vat_note: value.vat_note, inflation_note: value.inflation_note }, { onConflict: 'object_id' })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteCompensation(objectId) {
  const { error } = await db.from(COST_PLAN_COMPENSATION_TABLE).delete().eq('object_id', objectId)
  if (error) throw error
}
