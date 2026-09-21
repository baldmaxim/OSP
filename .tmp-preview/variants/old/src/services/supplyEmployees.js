// Ответственный за тендер на материалы — пользователь реестра «Администрирование»
// с ролью снабжения (миграция 20260925). Устроено так же, как «Ответственный
// СТО» (stoEmployees.js): список отдаёт SECURITY DEFINER-функция, в тендере
// хранятся materials_resp_user_id + materials_resp_name.
import { supabase } from '../supabase'

export const SUPPLY_MIGRATION_HINT =
  'Недоступно: в базе не применена миграция 20260925_tender_materials_priority_supply.'

export function isMissingMaterialsColumnError(err) {
  const msg = String(err?.message || '')
  return ['42703', 'PGRST204', '23514'].includes(err?.code)
    && /materials_(priority|resp_)/.test(msg)
}

let cache = null

// → [{ user_id, display_name, role, role_label }]
export async function fetchSupplyEmployees({ force = false } = {}) {
  if (cache && !force) return cache
  const { data, error } = await supabase.rpc('list_supply_employees')
  if (error) {
    const missing = error.code === 'PGRST202' || /list_supply_employees/.test(error.message || '')
    throw new Error(missing ? SUPPLY_MIGRATION_HINT : error.message)
  }
  cache = data || []
  return cache
}

// Кто отвечает за тендер на материалы: снабженец из реестра, иначе прежний контакт.
export function materialsResponsibleOf(t) {
  if (t?.materials_resp_user_id) return { name: t.materials_resp_name || 'Сотрудник снабжения', fromRegistry: true }
  if (t?.responsible_contact?.full_name) return { name: t.responsible_contact.full_name, fromRegistry: false }
  return { name: '', fromRegistry: false }
}

export const MATERIALS_PRIORITY_OPTIONS = [
  { value: 'low', label: 'Низкий' },
  { value: 'medium', label: 'Средний' },
  { value: 'high', label: 'Высокий' },
]
export const MATERIALS_PRIORITY_LABEL = Object.fromEntries(MATERIALS_PRIORITY_OPTIONS.map(o => [o.value, o.label]))

export function personInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}
