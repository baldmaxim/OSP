// Реестр контрагентов (/general/counterparties): постоянный номер и все фильтры страницы — одним расчётом, поэтому они
// работают вместе (05.11.2026). Вкладка, вид работ, подразделение, «С договором», «С регистрацией» и поиск сужают один и тот
// же список; число на кнопке и в списке подразделений — сколько строк будет, если её нажать, при всех остальных фильтрах.
import { matchesDivisions, splitWorkTypes } from './workTypeDivisions.js'

const collator = new Intl.Collator('ru')

// Вкладка, на которой показан контрагент. Удаление важнее статуса: удалённый из чёрного списка — в «Удалённых».
export const counterpartyTab = (cp) => (cp.deleted_at ? 'deleted' : cp.status === 'blacklist' ? 'blacklist' : 'active')

// Порядок, которым расставлены номера (миграция 20261225): удалённые внизу, в каждой части чёрный список ниже остальных,
// внутри — по названию. Строки реестра идут не им, а по номеру (compareByNumber).
const isBlacklist = (cp) => cp.status === 'blacklist'
export const compareCounterparties = (a, b) => Boolean(a.deleted_at) - Boolean(b.deleted_at)
  || isBlacklist(a) - isBlacklist(b)
  || collator.compare(a.name || '', b.name || '')

// Постоянный «№» — counterparty_number (миграция 20261225): присваивается при создании и не зависит от вкладки и фильтров.
// Пока колонки нет, номер считается здесь тем же порядком, что в миграции, и всегда по всему реестру, а не по выборке.
// → Map(id контрагента → номер).
export function counterpartyNumbers(list) {
  const items = list || []
  if (items.every((cp) => cp.counterparty_number != null)) return new Map(items.map((cp) => [cp.id, cp.counterparty_number]))
  const byOrder = [...items].sort((a, b) => compareCounterparties(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return new Map(byOrder.map((cp, i) => [cp.id, cp.counterparty_number ?? i + 1]))
}

// Строки реестра на всех вкладках — по «№», от меньшего к большему (05.11.2026, решение пользователя: по названию номера шли
// вразнобой). numbers — Map из counterpartyNumbers.
export const compareByNumber = (numbers) => (a, b) => numbers.get(a.id) - numbers.get(b.id) || compareCounterparties(a, b)

// Функции ещё нет (база раньше миграции, шлюз её не знает): фильтра нет, страница работает как раньше.
export function isMissingSiteAccounts(err) {
  const code = String(err?.code || '')
  return ['42883', 'PGRST202'].includes(code) || err?.status === 404
    || /counterparty_site_accounts/.test(String(err?.message || '')) && /does not exist|schema cache|Could not find/.test(String(err?.message || ''))
}

// Фильтры страницы:
//   tab — 'active' | 'blacklist' | 'deleted'; workType — вид работ или ''; divisions — коды подразделений (пусто — все),
//   divisionsById — Map(id → подразделения); onlyContract / contractCounts и onlySite / siteAccounts — кнопка и Map(id → число).
// skip — какой фильтр не применять: так считается, что он может предложить при всех остальных.
export function filterCounterparties(list, filters, skip = null) {
  const { tab, workType, divisions, divisionsById, onlyContract, contractCounts, onlySite, siteAccounts } = filters
  const byDivision = skip !== 'division' && divisions?.length > 0 && divisionsById
  return list.filter((cp) => counterpartyTab(cp) === tab
    && (skip === 'workType' || !workType || splitWorkTypes(cp.work_type).includes(workType))
    && (!byDivision || matchesDivisions(divisionsById.get(cp.id), divisions))
    && (skip === 'contract' || !onlyContract || !!contractCounts?.get(cp.id))
    && (skip === 'site' || !onlySite || !!siteAccounts?.get(cp.id)))
}

// Что предлагают фильтры при всех остальных и поиске (search(items) → найденные):
//   contract / site — число на кнопке, null — данные ещё не загружены; divisionItems — контрагенты для счётчиков
//   подразделений; workTypes — виды работ, с которыми что-то останется.
// Кнопка считается отдельным поиском по её выборке: ничего не найдя как набрано, поиск переходит к другой раскладке и
// опечаткам, поэтому число совпадает с тем, что покажет нажатие.
export function counterpartyFacets(list, filters, search) {
  const count = (on) => search(filterCounterparties(list, { ...filters, ...on })).length
  const workTypes = new Set()
  for (const cp of search(filterCounterparties(list, filters, 'workType'))) {
    for (const wt of splitWorkTypes(cp.work_type)) workTypes.add(wt)
  }
  return {
    contract: filters.contractCounts ? count({ onlyContract: true }) : null,
    site: filters.siteAccounts ? count({ onlySite: true }) : null,
    divisionItems: search(filterCounterparties(list, filters, 'division')),
    workTypes: [...workTypes].sort(collator.compare),
  }
}
