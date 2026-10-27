// Реестр «Договоры и ДС» (/contracts): что попадает во вкладку статуса и что стоит на счётчиках.
// Вид «Документ»: «Договоры и ДС» (all), «Договоры» (contracts), «ДС» (amendments). Документ — договор
// или ДС — попадает во вкладку по СВОЕМУ статусу и отметке удаления, в «Наши договоры» — по своему
// handled_by_us. Поэтому на любой вкладке «Договоры и ДС» = «Договоры» + «ДС»; раньше «Договоры и ДС»
// считали одни договоры и показывали то же число, что «Договоры».
import { DOC_TYPE } from './contractAmendments.js'

export const TAB_KEYS = ['all', 'requests', 'in_work', 'awaiting_paper_sign', 'paused', 'completed', 'deleted']

export const docKindOf = (c) => ((c.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT ? 'contracts' : 'amendments')

// Вкладки взаимоисключающие: «Общий реестр» — все не удалённые, «Заявки на заключение» — «Новая заявка»,
// дальше — по статусу, «Удаленные» — с отметкой удаления.
export function inTab(doc, tab) {
  const deleted = !!doc.deleted_at
  if (tab === 'deleted') return deleted
  if (deleted) return false
  if (tab === 'all') return true
  const status = doc.status || 'new_request'
  if (tab === 'requests') return status === 'new_request'
  return status === tab
}

export const inScope = (doc, scope) => scope !== 'ours' || !!doc.handled_by_us
const ofKind = (doc, docKind) => docKind === 'all' || docKindOf(doc) === docKind

// Договор каждого ДС: root_contract_id (заполняет триггер), без него — вверх по родителям.
// ДС, договор которого не загружен, — null.
export function dsRoots(docs) {
  const byId = new Map(docs.map(d => [d.id, d]))
  const roots = new Map()
  for (const d of docs) {
    if (docKindOf(d) !== 'amendments') continue
    let root = d.root_contract_id && d.root_contract_id !== d.id ? byId.get(d.root_contract_id) : null
    if (!root) {
      let cur = d
      for (let i = 0; i < 50 && cur?.parent_contract_id; i++) cur = byId.get(cur.parent_contract_id)
      root = cur && cur !== d ? cur : null
    }
    roots.set(d.id, root && docKindOf(root) === 'contracts' ? root.id : null)
  }
  return roots
}

// Счётчики охвата («Все договоры» / «Наши договоры» — живые документы) и вкладок (в выбранном охвате).
export function registryCounts(docs, { docKind, scope }) {
  const tabs = Object.fromEntries(TAB_KEYS.map(k => [k, 0]))
  const scopes = { all: 0, ours: 0 }
  for (const d of docs) {
    if (!ofKind(d, docKind)) continue
    if (!d.deleted_at) {
      scopes.all++
      if (d.handled_by_us) scopes.ours++
    }
    if (!inScope(d, scope)) continue
    for (const k of TAB_KEYS) if (inTab(d, k)) tabs[k]++
  }
  return { tabs, scopes }
}

// Строки вкладки. В «Договорах» и «ДС» — документы своего вида. В «Договорах и ДС» строка — договор,
// ДС этой вкладки — под ним (nested: id договора → его ДС по порядку). Договор, который сам во вкладку
// не попадает, но у него есть ДС на ней, — тоже строка (context): иначе ДС «В работе» к завершённому
// договору или удалённое ДС живого договора видно только в виде «ДС». ДС без договора — своей строкой.
export function registryRows(docs, { docKind, scope, tab }) {
  const nested = new Map()
  const context = new Set()
  if (docKind !== 'all') {
    return { rows: docs.filter(d => ofKind(d, docKind) && inScope(d, scope) && inTab(d, tab)), nested, context }
  }
  const byId = new Map(docs.map(d => [d.id, d]))
  const roots = dsRoots(docs)
  const rows = []
  const seen = new Set()
  const addRow = (d) => {
    if (seen.has(d.id)) return
    seen.add(d.id)
    rows.push(d)
  }
  for (const d of docs) {
    if (!inScope(d, scope) || !inTab(d, tab)) continue
    if (docKindOf(d) === 'contracts') { addRow(d); continue }
    const root = byId.get(roots.get(d.id))
    if (!root) { addRow(d); continue }
    if (!nested.has(root.id)) nested.set(root.id, [])
    nested.get(root.id).push(d)
    addRow(root)
  }
  for (const list of nested.values()) list.sort((a, b) => Number(a.display_id) - Number(b.display_id))
  for (const r of rows) {
    if (docKindOf(r) === 'contracts' && !(inScope(r, scope) && inTab(r, tab))) context.add(r.id)
  }
  return { rows, nested, context }
}
