// Фильтр «Контрагент» реестра «Договоры и ДС» (/contracts). Документ подходит, если выбранный контрагент — его сторона.
// ДС сверяется только со своими сторонами: на базе 05.11 у всех 839 ДС они те же, что у договора.
import { searchKey } from './counterpartySearch.js'

// Все стороны договора (может быть несколько — трёхсторонний договор), по порядку.
// Старые договоры без строк в contract_counterparties → fallback на основного контрагента.
export function contractParties(contract) {
  const rows = contract?.contract_counterparties || []
  if (rows.length > 0) {
    return [...rows]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map(r => r.counterparties)
      .filter(Boolean)
  }
  return contract?.counterparties ? [contract.counterparties] : []
}

export function hasCounterparty(doc, ids) {
  return contractParties(doc).some(p => ids.has(String(p.id)))
}

// Варианты фильтра: контрагенты строк docs, по алфавиту. Выбранный остаётся в списке, даже если строк с ним сейчас нет
// (другой отдел, вкладка или объект): иначе фильтр действовал бы невидимо и реестр был бы пуст без видимой причины.
// allDocs — откуда взять название выбранного. Одинаковые названия (на базе 05.11 такая пара одна) различает ИНН.
export function counterpartyFilterOptions(docs, selectedIds, allDocs) {
  const byId = new Map()
  const add = (doc, only) => {
    for (const p of contractParties(doc)) {
      const id = String(p.id)
      if ((!only || only.has(id)) && !byId.has(id)) byId.set(id, p)
    }
  }
  docs.forEach(doc => add(doc))
  const missing = new Set(selectedIds.map(String).filter(id => !byId.has(id)))
  if (missing.size > 0) allDocs.forEach(doc => add(doc, missing))

  const nameCount = new Map()
  for (const p of byId.values()) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1)
  return [...byId.entries()]
    .map(([value, p]) => ({
      value,
      inn: p.inn || '',
      label: nameCount.get(p.name) > 1 && p.inn ? `${p.name} · ИНН ${p.inn}` : (p.name || ''),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

// Поиск в списке — как в реестре контрагентов: регистр, ё / й, пробелы, кавычки и дефисы не важны, слова в любом порядке
// («проматомстрой» и «атом пром» находят «ООО Пром Атом Строй»); ещё — по ИНН.
export function matchCounterpartyOption(option, query) {
  const text = searchKey(`${option.label} ${option.inn || ''}`)
  return String(query).trim().split(/\s+/).every(word => text.includes(searchKey(word)))
}
