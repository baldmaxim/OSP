// «Дежурный по тендерам» — еженедельная ротация (task 419+).
//
// Ротация считается детерминированно на фронте (без cron): якорь + число недель % N.
// Ручная замена админом на текущую неделю хранится в app_settings под
// DUTY_OVERRIDE_KEY как JSON { week, name }. Показывается в «Тендерах»
// (там же меняется) и в «ВОРах и РД» (только чтение).
import { mondayOf, weekKey } from './weeks'

export const TENDER_DUTY_NAMES = [
  'Крюкова Юлия Денисовна',
  'Архипов Антон Михайлович',
  'Савостенко Владислав Андреевич',
]
// Понедельник недели, когда дежурит Крюкова (index 0).
const ROTATION_ANCHOR_MONDAY = '2026-07-06'
export const DUTY_OVERRIDE_KEY = 'tender_responsible_override'

// Дежурный по расписанию (без учёта ручной замены).
export function scheduledDuty(dateInput) {
  const anchor = mondayOf(ROTATION_ANCHOR_MONDAY)
  const weeks = Math.round((mondayOf(dateInput) - anchor) / (7 * 24 * 60 * 60 * 1000))
  const n = TENDER_DUTY_NAMES.length
  return TENDER_DUTY_NAMES[((weeks % n) + n) % n]
}

// Значение app_settings → { week, name } | null.
export function parseDutyOverride(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// → { name, overridden } на дату (по умолчанию — сейчас).
export function currentDuty(override, date = new Date()) {
  const overridden = !!(override && override.week === weekKey(date) && override.name)
  return { name: overridden ? override.name : scheduledDuty(date), overridden }
}
