// Подразделения видов работ и контрагентов (миграция 20261115, решение пользователя 29.10.2026).
// Подразделение — у вида работ (work_types.division, коды подразделений ВОР — utils/vorDivisions.js) и у договора
// (contracts.division, «Договоры и ДС»). Своего поля у контрагента нет: его подразделения — подразделения его видов работ
// (counterparties.work_type — названия через запятую) и его договоров (03.11.2026: несколько договоров с разными
// подразделениями дополняют контрагента), поэтому вручную у контрагентов ничего не ставится. Вид работ без подразделения
// или не из справочника подразделения не даёт; контрагент без единого подразделения — «Не указано» (NO_VOR_DIVISION) в фильтре.
import { VOR_DIVISIONS, NO_VOR_DIVISION } from './vorDivisions.js'

// «Прочее» — только у видов работ (миграция 20261119, решение пользователя 30.10.2026): аренда, охрана, клининг,
// проектирование и всё, что не относится ни к одному подразделению ВОР. У тендеров, договоров и заявок на ДС его нет.
export const OTHER_WORK_DIVISION = 'other'
export const WORK_TYPE_DIVISIONS = [...VOR_DIVISIONS, { value: OTHER_WORK_DIVISION, label: 'Прочее' }]
export const WORK_TYPE_DIVISION_LABEL = Object.fromEntries(WORK_TYPE_DIVISIONS.map(d => [d.value, d.label]))

const ORDER = new Map(WORK_TYPE_DIVISIONS.map((d, i) => [d.value, i]))

export const splitWorkTypes = (value) => (value || '').split(',').map(wt => wt.trim()).filter(Boolean)

// Колонка есть, если справочник её отдаёт (select('*')); пустой справочник — подразделений показывать не из чего.
export const hasDivisionColumn = (directory) =>
  Array.isArray(directory) && directory.some(wt => Object.prototype.hasOwnProperty.call(wt, 'division'))

// Название вида работ → код подразделения (только известные коды).
export function divisionByWorkType(directory) {
  const map = new Map()
  for (const wt of directory || []) {
    if (wt?.name && ORDER.has(wt.division)) map.set(wt.name.trim(), wt.division)
  }
  return map
}

// Подразделения по строке видов работ контрагента — без повторов, в порядке WORK_TYPE_DIVISIONS.
export function workTypesDivisions(workType, byName) {
  const set = new Set()
  for (const wt of splitWorkTypes(workType)) {
    const d = byName.get(wt)
    if (d) set.add(d)
  }
  return [...set].sort((a, b) => ORDER.get(a) - ORDER.get(b))
}

// Подразделения контрагента из нескольких списков — без повторов, в порядке WORK_TYPE_DIVISIONS, только известные коды.
export function mergeDivisions(...lists) {
  const set = new Set()
  for (const list of lists) for (const d of list || []) if (ORDER.has(d)) set.add(d)
  return [...set].sort((a, b) => ORDER.get(a) - ORDER.get(b))
}

// → Map(id контрагента → подразделения его договоров). Контрагент договора — основная сторона, другая сторона или договор
// прикреплён к нему вручную: те же договоры, что в его карточке. Удалённые договоры и ДС (у них своего подразделения нет)
// выбирает запрос — здесь только то, что пришло.
export function contractDivisionsByCounterparty(contracts, parties = [], links = []) {
  const divisionOf = new Map()
  for (const c of contracts || []) if (c.division) divisionOf.set(c.id, c.division)
  const sets = new Map()
  const add = (counterpartyId, contractId) => {
    const division = divisionOf.get(contractId)
    if (!counterpartyId || !division) return
    if (!sets.has(counterpartyId)) sets.set(counterpartyId, new Set())
    sets.get(counterpartyId).add(division)
  }
  for (const c of contracts || []) add(c.counterparty_id, c.id)
  for (const p of parties) add(p.counterparty_id, p.contract_id)
  for (const l of links) add(l.counterparty_id, l.contract_id)
  return new Map([...sets].map(([id, set]) => [id, mergeDivisions(set)]))
}

// Проходит ли контрагент фильтр: пустой фильтр — все; иначе хотя бы одно подразделение из выбранных,
// а без подразделений — если выбрано «Не указано».
export function matchesDivisions(divisions, filter) {
  if (!filter?.length) return true
  if (!divisions?.length) return filter.includes(NO_VOR_DIVISION)
  return divisions.some(d => filter.includes(d))
}

// Число контрагентов на каждое подразделение (контрагент с видами разных подразделений считается в каждом).
export function divisionCounts(list, divisionsOf) {
  const counts = new Map()
  for (const item of list) {
    const divs = divisionsOf(item)
    if (!divs.length) counts.set(NO_VOR_DIVISION, (counts.get(NO_VOR_DIVISION) || 0) + 1)
    for (const d of divs) counts.set(d, (counts.get(d) || 0) + 1)
  }
  return counts
}

// База ещё без колонки (миграция 20261115 не применена): PostgREST — 42703 или PGRST204 «нет колонки division».
export const isMissingWorkTypeDivision = (err) =>
  (err?.code === '42703' || err?.code === 'PGRST204') && /division/.test(String(err?.message || ''))

export const WORK_TYPE_DIVISION_HINT = 'Подразделение вида работ появится после обновления базы (миграция 20261115).'

// Текст отказа при записи подразделения вида работ: нет колонки — 20261115; нарушение CHECK — «Прочее» в базе,
// где 20261119 ещё не применена.
export function workTypeDivisionSaveError(err) {
  if (isMissingWorkTypeDivision(err)) return WORK_TYPE_DIVISION_HINT
  if (err?.code === '23514' && /division/.test(String(err?.message || ''))) {
    return '«Прочее» станет доступно после обновления базы (миграция 20261119).'
  }
  return null
}
