import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'

// task 433: справочник сотрудников для выбора исполнителя задачи.
//
// Читаем вью employee_directory, а не user_roles напрямую: политика
// user_roles_select_self_or_admin отдаёт обычному сотруднику ТОЛЬКО его строку,
// поэтому без вью список исполнителей был бы пуст у всех, кроме админа.
// Вью создаётся миграцией 20260818_tasks_foundation.sql.
export async function fetchEmployees() {
  return fetchAllRows((from, to) => supabase
    .from('employee_directory')
    .select('user_id, display_name, full_name, email, role')
    .order('display_name', { ascending: true })
    .order('user_id', { ascending: true })
    .range(from, to))
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
