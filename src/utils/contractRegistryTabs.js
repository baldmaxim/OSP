// «Реестр по договорам» (/contracts/registry): что попадает во вкладку статуса и что стоит на счётчиках.
// Вид «Документ»: «Договоры и ДС» (all) — весь реестр, «Договоры» (contracts), «ДС» (amendments). Документ — договор или ДС — попадает во вкладку по СВОЕМУ статусу и отметке
// удаления, в «Наши договоры» — по своему handled_by_us, в отдел ОС / ГО — по своему объекту. Поэтому на любой вкладке
// «Договоры и ДС» = договоры + ДС; раньше они считали одни договоры.
import { DOC_TYPE } from './contractAmendments.js'

// Набор id для фильтра «Сверка Signal» (registryRows → only): документы с предложением, противоречием, пропавшей папкой.
export { signalReviewIds } from './signalReview.js'

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

// Числа на вкладках вида документа (11.11.2026, решение пользователя: вкладки «Все» больше нет — «Договоры и ДС» и есть
// весь реестр): сколько документов каждого вида при выбранном статусе (tab, 'all' — любой, кроме удалённых), отделе и
// «Наших договорах». «Договоры и ДС» = договоры + ДС, как счётчики статусов.
export function kindCounts(docs, { scope, dept = 'all', tab = 'all' }) {
  const out = { all: 0, contracts: 0, amendments: 0 }
  for (const d of docs) {
    if (!inScope(d, scope) || !inDept(d, dept) || !inTab(d, tab)) continue
    out.all++
    out[docKindOf(d)]++
  }
  return out
}

// Строки вкладки. В «Договорах» и «ДС» — документы своего вида. В «Договорах и ДС» строка — договор,
// ДС этой вкладки — под ним (nested: id договора → его ДС по порядку). Договор, который сам во вкладку
// не попадает, но у него есть ДС на ней, — тоже строка (context): иначе ДС «В работе» к завершённому
// договору или удалённое ДС живого договора видно только в виде «ДС». ДС без договора — своей строкой.
// only — необязательный набор id (фильтр «Сверка Signal», 23.11.2026): документ вне набора на вкладку не попадает, как будто
// он в другом статусе. Применяется ДО построения дерева и не по массиву docs: так ДС с замечанием остаётся под своим
// договором, а договор без замечаний показан строкой ради него (context) один раз.
export function registryRows(docs, { docKind, scope, tab, dept = 'all', only = null }) {
  const nested = new Map()
  const context = new Set()
  const shown = (d) => inScope(d, scope) && inDept(d, dept) && inTab(d, tab) && (!only || only.has(d.id))
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

// Сколько документов вкладки в наборе only (число на «Сверке Signal») — без фильтров реестра: сами документы — договоры и ДС, без
// договоров, показанных только ради ДС (context). Вид документа, отдел, «Наши договоры» и статус — как у строк.
export function signalReviewCount(docs, only, { docKind, scope, tab, dept = 'all' }) {
  if (!only || only.size === 0) return 0
  let n = 0
  for (const d of docs) {
    if (only.has(d.id) && ofKind(d, docKind) && inScope(d, scope) && inDept(d, dept) && inTab(d, tab)) n++
  }
  return n
}

// То же число, но с фильтрами реестра (С-8, объект, поиск, контрагент, юрист…): по строкам view = registryRows(…, only) — тем
// самым, что покажет реестр при включённом переключателе. rowOk(строка) — прошла ли строка остальные фильтры страницы (без самого
// переключателя). Считаются документы: сама строка, если она в наборе (не договор «ради ДС»), и её ДС этой вкладки (nested) — а
// ДС показан, только если прошла фильтры строка его договора.
export function signalReviewCountShown(view, only, rowOk = () => true) {
  if (!view || !only || only.size === 0) return 0
  let n = 0
  for (const row of view.rows) {
    if (!rowOk(row)) continue
    if (only.has(row.id) && !view.context.has(row.id)) n++
    n += (view.nested.get(row.id) || []).length
  }
  return n
}
