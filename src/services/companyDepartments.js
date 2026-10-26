// Отделы компании (миграция 20261104_company_departments): «Общая информация» → «Отделы».
// Строка — отдел: блок, название, основные функции, примечание, руководители и контакты.
//
// Права — в базе: читает сотрудник, правит только администратор (is_admin()). Список контактов чистит
// триггер; здесь он только приводится к трём полям (utils/companyDepartments.js).
import { db } from '../api'
import { cleanContacts } from '../utils/companyDepartments'

export const DEPARTMENTS_TABLE = 'company_departments'

const COLUMNS = 'id, sort_order, block, name, duties, note, contacts, updated_at'

export function isMissingDepartmentsTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(DEPARTMENTS_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Отделов десятки — одним запросом. → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchDepartments() {
  const { data, error } = await db
    .from(DEPARTMENTS_TABLE)
    .select(COLUMNS)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
  if (error) {
    if (isMissingDepartmentsTable(error)) return { rows: [], supported: false }
    throw error
  }
  return { rows: (data || []).map(r => ({ ...r, contacts: Array.isArray(r.contacts) ? r.contacts : [] })), supported: true }
}

const payloadOf = (form) => ({
  block: String(form.block ?? '').trim(),
  name: String(form.name ?? '').trim(),
  duties: String(form.duties ?? '').trim(),
  note: String(form.note ?? '').trim() || null,
  contacts: cleanContacts(form.contacts),
})

// Новый отдел — в конец списка (sortOrder задаёт страница).
export async function createDepartment(form, sortOrder) {
  const { error } = await db.from(DEPARTMENTS_TABLE).insert([{ ...payloadOf(form), sort_order: sortOrder }])
  if (error) throw error
}

export async function updateDepartment(id, form) {
  const { error } = await db.from(DEPARTMENTS_TABLE).update(payloadOf(form)).eq('id', id)
  if (error) throw error
}

export async function deleteDepartment(id) {
  const { error } = await db.from(DEPARTMENTS_TABLE).delete().eq('id', id)
  if (error) throw error
}

// Порядок: правки sort_order разом (их единицы).
export async function saveDepartmentOrder(updates) {
  const results = await Promise.all(updates.map(u => db
    .from(DEPARTMENTS_TABLE).update({ sort_order: u.sort_order }).eq('id', u.id)))
  const failed = results.find(r => r.error)
  if (failed) throw failed.error
}

// «Руководители списком»: каждому упомянутому отделу — ровно его контакты. Map<id, контакты>.
export async function saveDepartmentContacts(updates) {
  const results = await Promise.all([...updates].map(([id, contacts]) => db
    .from(DEPARTMENTS_TABLE).update({ contacts: cleanContacts(contacts) }).eq('id', id)))
  const failed = results.find(r => r.error)
  if (failed) throw failed.error
}
