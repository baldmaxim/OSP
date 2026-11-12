// Данные «Дерева договоров» (/contracts/tree, эксперимент, только администратор): договоры и ДС, заявки на ДС, заявки на
// проверку ДП/ДС, заявки на ДП и справочник сотрудников (исполнители проверок). Только чтение: эксперимент ничего не
// пишет в базу. Всё — постранично (потолок PostgREST — 1000 строк; проверок уже около 900).
// Таблицы раздела нет (база раньше миграции) — пустой список и пометка в missing, страница работает с остальным.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { isMissingRelation } from '../utils/ratesRegistry'

const SOURCES = {
  contracts: (from, to) => db.from('contracts')
    .select('*, objects(name, status), counterparties(id, name), contract_counterparties(counterparty_id), responsible:contacts!responsible_contact_id(full_name)')
    .order('id', { ascending: true })
    .range(from, to),
  dcRequests: (from, to) => db.from('dc_requests')
    .select('*, objects(name), counterparties(name)')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, to),
  checks: (from, to) => db.from('doc_check_requests')
    .select('*, objects(name), counterparties(name)')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, to),
  dpRequests: (from, to) => db.from('dp_requests')
    .select('*, objects(name)')
    .is('deleted_at', null)
    .neq('status', 'draft')
    .order('id', { ascending: true })
    .range(from, to),
  employees: (from, to) => db.from('employee_directory')
    .select('user_id, display_name, full_name, email')
    .order('user_id', { ascending: true })
    .range(from, to),
}

// → { contracts, dcRequests, checks, dpRequests, employees, missing: [ключ] }. Другая ошибка — исключение.
export async function loadContractTreeData() {
  const keys = Object.keys(SOURCES)
  const missing = []
  const results = await Promise.all(keys.map(async (key) => {
    try {
      return await fetchAllRows(SOURCES[key])
    } catch (err) {
      if (key !== 'contracts' && isMissingRelation(err)) { missing.push(key); return [] }
      throw err
    }
  }))
  return { ...Object.fromEntries(keys.map((k, i) => [k, results[i]])), missing }
}
