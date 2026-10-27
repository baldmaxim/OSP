// Экономисты ОСП по объектам (миграция 20261110_cost_plan_economists): строка — объект (одна на объект) и
// сотрудник справочника contacts. Вкладка «Экономисты ОСП» в «Документах» планов затрат и отделов показывает
// сводку; форма нового тендера основного строительства подставляет экономиста объекта ответственным за план
// затрат.
//
// Права — в базе: читает сотрудник, назначает только администратор (is_admin()).
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'

export const COST_PLAN_ECONOMISTS_TABLE = 'cost_plan_economists'

const COLUMNS = 'id, object_id, contact_id, updated_at, contacts(id, full_name, position, phone)'

export function isMissingCostPlanEconomistsTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(COST_PLAN_ECONOMISTS_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Все назначения разом — их не больше, чем объектов.
// → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchCostPlanEconomists() {
  try {
    const rows = await fetchAllRows((from, to) => db
      .from(COST_PLAN_ECONOMISTS_TABLE)
      .select(COLUMNS)
      .order('id', { ascending: true })
      .range(from, to))
    return { rows, supported: true }
  } catch (err) {
    if (isMissingCostPlanEconomistsTable(err)) return { rows: [], supported: false }
    throw err
  }
}

// Объекты для сводки и назначения: название и статус (основное строительство / гарантия).
export async function fetchEconomistObjects() {
  return fetchAllRows((from, to) => db
    .from('objects')
    .select('id, name, status')
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}

// Справочник сотрудников для выбора экономиста (с отделом — ОСП показываем первыми).
export async function fetchEconomistCandidates() {
  return fetchAllRows((from, to) => db
    .from('contacts')
    .select('id, full_name, position, phone, departments(name)')
    .order('full_name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}

// Назначить или сменить экономиста объекта (одна строка на объект).
export async function saveCostPlanEconomist(objectId, contactId) {
  const { data, error } = await db
    .from(COST_PLAN_ECONOMISTS_TABLE)
    .upsert({ object_id: objectId, contact_id: contactId }, { onConflict: 'object_id' })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteCostPlanEconomist(objectId) {
  const { error } = await db.from(COST_PLAN_ECONOMISTS_TABLE).delete().eq('object_id', objectId)
  if (error) throw error
}
