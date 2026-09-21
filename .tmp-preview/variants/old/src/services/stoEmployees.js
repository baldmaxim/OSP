// «Ответственный СТО» за ВОРы и РД (миграция 20260922).
//
// Выбирается только среди пользователей реестра «Администрирование» с ролью
// сметно-технического отдела. Список отдаёт SECURITY DEFINER-функция
// list_sto_employees: сотрудник не может читать чужие строки user_roles.
//
// В тендере хранится vor_sto_user_id + vor_sto_name (ФИО на момент назначения).
// Прежнее поле vor_responsible_id (справочник «Сотрудники») не удалено: пока СТО
// не назначен, показываем его с пометкой.
import { supabase } from '../supabase'

// Колонки СТО для явных select'ов. До применения миграции их нет — запрос
// повторяется без них (см. isMissingStoColumnError).
export const STO_TENDER_COLUMNS = 'vor_sto_user_id, vor_sto_name'

export function isMissingStoColumnError(err) {
  const msg = String(err?.message || '')
  return (err?.code === '42703' || err?.code === 'PGRST204' || err?.code === 'PGRST200')
    && /vor_sto_/.test(msg)
}

export const STO_MIGRATION_HINT = 'Ответственный СТО недоступен: в базе не применена миграция 20260922_tender_vor_sto_responsible.'

let cache = null

// → [{ user_id, display_name, role, role_label }]
export async function fetchStoEmployees({ force = false } = {}) {
  if (cache && !force) return cache
  const { data, error } = await supabase.rpc('list_sto_employees')
  if (error) {
    const missing = error.code === 'PGRST202' || /list_sto_employees/.test(error.message || '')
    const e = new Error(missing ? STO_MIGRATION_HINT : error.message)
    e.cause = error
    throw e
  }
  cache = data || []
  return cache
}

// Кто отвечает за ВОРы и РД: СТО из реестра, иначе прежний контакт.
// → { name, fromRegistry }
export function vorResponsibleOf(t) {
  if (t?.vor_sto_user_id) return { name: t.vor_sto_name || 'Сотрудник СТО', fromRegistry: true }
  if (t?.vor_responsible?.full_name) return { name: t.vor_responsible.full_name, fromRegistry: false }
  return { name: '', fromRegistry: false }
}

export function vorResponsibleName(t) {
  return vorResponsibleOf(t).name
}

// Выполнить построитель запроса с колонками СТО; если их ещё нет — без них.
// build(extraColumns) должен вернуть промис результата ({ data, error }) или
// выбросить ошибку (например, через fetchAllRows).
export async function withStoColumns(build) {
  try {
    return await build(`, ${STO_TENDER_COLUMNS}`)
  } catch (err) {
    if (isMissingStoColumnError(err)) return build('')
    throw err
  }
}
