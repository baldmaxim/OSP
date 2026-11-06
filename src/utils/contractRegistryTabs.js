// «Реестр по договорам» (/contracts/registry): что попадает во вкладку статуса и что стоит на счётчиках.
// Вид «Документ»: «Договоры и ДС» (all) — весь реестр, «Договоры» (contracts), «ДС» (amendments). Документ — договор или ДС — попадает во вкладку по СВОЕМУ статусу и отметке
// удаления, в «Наши договоры» — по своему handled_by_us, в отдел ОС / ГО — по своему объекту. Поэтому на любой вкладке
// «Договоры и ДС» = договоры + ДС; раньше они считали одни договоры.
import { DOC_TYPE } from './contractAmendments.js'

export const TAB_KEYS = ['all', 'in_work', 'paused', 'completed', 'deleted']

// Отдел — по объекту документа (objects.status): основное строительство или гарантийное обслуживание.
export const DEPT_KEYS = ['all', 'main_construction', 'warranty_service']

export const docKindOf = (c) => ((c.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT ? 'contracts' : 'amendments')

// «Все» — все не удалённые. «В работе» — всё, что ещё не закончено и не приостановлено: новая заявка, в работе,
// ожидание подписания на бумаге (03.11 — объединены: на сайте 0, 16 и 2 документа; точный статус виден в строке). Сюда же
// статус вне справочника: иначе документ был бы виден только во вкладке «Все». «Удаленные» — с отметкой удаления.
export function inTab(doc, tab) {
  const deleted = !!doc.deleted_at
  if (tab === 'deleted') return deleted
  if (deleted) return false
  if (tab === 'all') return true
  const status = doc.status || 'new_request'
  if (tab === 'paused' || tab === 'completed') return status === tab
  return tab === 'in_work' && status !== 'paused' && status !== 'completed'
}

export const inScope = (doc, scope) => scope !== 'ours' || !!doc.handled_by_us
export const inDept = (doc, dept) => !dept || dept === 'all' || doc.objects?.status === dept
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

// Счётчики живых документов: отделы — с учётом «Наших договоров», «Наши договоры» — в выбранном отделе; вкладки — и в том,
// и в другом.
export function registryCounts(docs, { docKind, scope, dept = 'all' }) {
  const tabs = Object.fromEntries(TAB_KEYS.map(k => [k, 0]))
  const scopes = { all: 0, ours: 0 }
  const depts = Object.fromEntries(DEPT_KEYS.map(k => [k, 0]))
  for (const d of docs) {
    if (!ofKind(d, docKind)) continue
    if (!d.deleted_at) {
      if (inDept(d, dept)) {
        scopes.all++
        if (d.handled_by_us) scopes.ours++
      }
      if (inScope(d, scope)) for (const k of DEPT_KEYS) if (inDept(d, k)) depts[k]++
    }
    if (!inScope(d, scope) || !inDept(d, dept)) continue
    for (const k of TAB_KEYS) if (inTab(d, k)) tabs[k]++
  }
  return { tabs, scopes, depts }
}

// Строки вкладки. В «Договорах» и «ДС» — документы своего вида. В «Договорах и ДС» строка — договор,
// ДС этой вкладки — под ним (nested: id договора → его ДС по порядку). Договор, который сам во вкладку
// не попадает, но у него есть ДС на ней, — тоже строка (context): иначе ДС «В работе» к завершённому
// договору или удалённое ДС живого договора видно только в виде «ДС». ДС без договора — своей строкой.
export function registryRows(docs, { docKind, scope, tab, dept = 'all' }) {
  const nested = new Map()
  const context = new Set()
  const shown = (d) => inScope(d, scope) && inDept(d, dept) && inTab(d, tab)
  if (docKind !== 'all') {
    return { rows: docs.filter(d => ofKind(d, docKind) && shown(d)), nested, context }
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
    if (!shown(d)) continue
    if (docKindOf(d) === 'contracts') { addRow(d); continue }
    const root = byId.get(roots.get(d.id))
    if (!root) { addRow(d); continue }
    if (!nested.has(root.id)) nested.set(root.id, [])
    nested.get(root.id).push(d)
    addRow(root)
  }
  for (const list of nested.values()) list.sort((a, b) => Number(a.display_id) - Number(b.display_id))
  for (const r of rows) {
    if (docKindOf(r) === 'contracts' && !shown(r)) context.add(r.id)
  }
  return { rows, nested, context }
}
