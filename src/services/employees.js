import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'

// task 433: справочник сотрудников для выбора исполнителя задачи.
//
// Читаем вью employee_directory, а не user_roles напрямую: политика
// user_roles_select_self_or_admin отдаёт обычному сотруднику ТОЛЬКО его строку,
// поэтому без вью список исполнителей был бы пуст у всех, кроме админа.
// Вью создаётся миграцией 20260818_tasks_foundation.sql.
export async function fetchEmployees() {
  return fetchAllRows((from, to) => db
    .from('employee_directory')
    .select('user_id, display_name, full_name, email, role')
    .order('display_name', { ascending: true })
    .order('user_id', { ascending: true })
    .range(from, to))
}

// Действующие юристы ОСП (функция list_osp_lawyers, миграция 20270226): юрист договора в реестре, карточке договора, импорте и
// отчёте по юристам. Справочник выше шлюз отдаёт не всем, кто видит договоры, — поэтому узкая функция: только id и ФИО юристов.
// До миграции функции нет — пусто (юриста в реестре тогда и так нет). → [{ user_id, display_name, full_name, role: 'lawyer' }]
export async function fetchOspLawyers() {
  const { data, error } = await db.rpc('list_osp_lawyers')
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883' || /list_osp_lawyers/.test(error.message || '')) return []
    throw error
  }
  return data || []
}

// Мапа user_id → сотрудник, чтобы резолвить ФИО в списках без join'ов
// (в БД имена исполнителей намеренно не денормализованы).
export function employeesById(list) {
  const map = new Map()
  for (const e of list || []) map.set(e.user_id, e)
  return map
}

// Отображаемое имя: ФИО, иначе почта, иначе заглушка.
export function employeeName(map, userId, fallback = 'Не назначен') {
  if (!userId) return fallback
  const e = map.get(userId)
  return e?.display_name || e?.full_name || e?.email || 'Пользователь удалён'
}
