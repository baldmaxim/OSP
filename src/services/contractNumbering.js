// Нумерация договоров по объектам (миграция 20270110): счётчики номеров и коды объектов. Правила — utils/contractNumbering.js.
//
// Права — в базе: счётчик читает сотрудник, пишет только триггер договоров; код объекта меняет только администратор
// (триггер objects_contract_code_guard). Миграции нет — счётчика нет (supported: false), страница работает по-прежнему.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { cleanCode } from '../utils/contractNumbering'

export const NUMBER_COUNTERS_TABLE = 'contract_number_counters'

export function isMissingNumbering(err) {
  const msg = String(err?.message || '')
  return ['42P01', 'PGRST205', '42703'].includes(err?.code)
    || (/contract_number_counters|contract_code/.test(msg) && /does not exist|schema cache/.test(msg))
}

// Все счётчики разом: строка — код объекта и год, их десятки. → { counters, supported }.
export async function loadNumberCounters() {
  try {
    const counters = await fetchAllRows((from, to) => db
      .from(NUMBER_COUNTERS_TABLE)
      .select('code_key, year, last_number')
      .order('code_key', { ascending: true })
      .order('year', { ascending: true })
      .range(from, to))
    return { counters, supported: true }
  } catch (err) {
    if (isMissingNumbering(err)) return { counters: [], supported: false }
    throw err
  }
}

// Код объекта; пустой — снять код. Запись, не задевшая строку (нет права, объект удалён), — ошибка, а не молчание.
export async function saveObjectContractCode(objectId, code) {
  const { data, error } = await db
    .from('objects')
    .update({ contract_code: cleanCode(code) })
    .eq('id', objectId)
    .select('id, contract_code')
  if (error) throw error
  if (!data?.length) throw new Error('Код не сохранён: объект не найден или нет права')
  return data[0]
}
