// Договоры и ДС контрагента для вкладки «Общая информация» его карточки: плоский список документов
// (договоры и все их ДС) → группы «договор и его ДС». Правила дерева и сумм — utils/contractAmendments.
import {
  COMPLETED_STATUS, DOC_TYPE, DOC_TYPE_LABEL, buildDocIndex, contractActualAmount, effectiveDocumentAmount, flattenTree,
} from './contractAmendments.js'

const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('ru-RU') : '')

// Подпись документа: вид, номер, дата.
export function docTitle(doc) {
  const kind = doc.record_type === DOC_TYPE.CONTRACT ? 'Договор' : (DOC_TYPE_LABEL[doc.record_type] || 'ДС')
  const num = doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'
  return { kind, num, date: fmtDate(doc.contract_date) }
}

// Выбор договора для «Прикрепить договор»: каждое слово запроса — в номере, предмете, объекте или контрагенте
// договора (в любом порядке: «П-15 северный»); уже показанные в разделе — не предлагаются.
export function searchContractChoices(choices, query, excludeIds, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const out = []
  for (const c of choices) {
    if (excludeIds.has(c.id)) continue
    const hay = [c.contract_number, c.work_name, c.objects?.name, c.counterparties?.name].join(' ').toLowerCase()
    if (!words.every(w => hay.includes(w))) continue
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}

// Группы: корень (договор; ДС, чей родитель не загружен, — тоже корень, чтобы не потерялось) и его ДС
// сверху вниз с глубиной. Свежие договоры — выше. actual — сумма договора с завершёнными ДС, только если
// она отличается от суммы самого договора.
export function groupCounterpartyDocs(docs) {
  const index = buildDocIndex(docs)
  const roots = docs
    .filter(d => !d.parent_contract_id || !index.byId.has(d.parent_contract_id))
    .sort((a, b) => String(b.contract_date || '').localeCompare(String(a.contract_date || ''))
      || Number(b.display_id) - Number(a.display_id))
  return roots.map(root => {
    const original = effectiveDocumentAmount(root)
    const actual = root.record_type === DOC_TYPE.CONTRACT ? contractActualAmount(root, index) : null
    return {
      root,
      children: flattenTree(root, index),
      actual: actual != null && original != null && Math.abs(actual - original) >= 0.005 ? actual : null,
    }
  })
}

const isContractRoot = (g) => g.root.record_type === DOC_TYPE.CONTRACT
const dayOf = (value) => String(value || '').slice(0, 10)

// Дерево низа «Общей информации»: объект → договоры → ДС и заявки на ДС. В нём только объекты, где у контрагента
// есть договор или заявка: других объектов контрагент не касался.
//   docs — договоры и ДС контрагента плоским списком (loadCounterpartyDocs);
//   requests — его заявки на ДС; requestDocs — Map(id → договор / ДС), на которые ссылаются заявки.
// Заявка стоит под своим договором; договор заявки, где контрагент не сторона (или у пользователя нет раздела
// «Договоры и ДС», и docs пуст), становится строкой дерева. Договор удалён или не указан — заявка в `loose` своего
// объекта. ДС — всегда под договором, какой бы объект ни стоял у самого ДС. Положение задаёт договор, поэтому объект
// заявки может отличаться от объекта договора.
//   → [{ key, name, groups: [{ root, children, actual, requests }], loose: [заявка], counts }]:
// свежие объекты выше (по последнему документу или заявке), без объекта (key = '') — в конце.
export function buildObjectTree(docs = [], requests = [], requestDocs = null) {
  const known = new Set(docs.map(d => d.id))
  const extra = []
  for (const r of requests) {
    const c = r.contract_id ? requestDocs?.get(r.contract_id) : null
    if (c && !c.deleted_at && !known.has(c.id)) { known.add(c.id); extra.push(c) }
  }

  const groups = groupCounterpartyDocs([...docs, ...extra]).map(g => ({ ...g, requests: [] }))
  const groupByDoc = new Map()
  for (const g of groups) {
    groupByDoc.set(g.root.id, g)
    for (const { doc } of g.children) groupByDoc.set(doc.id, g)
  }

  const objects = new Map()
  const objectOf = (id, name) => {
    const key = id || ''
    let o = objects.get(key)
    if (!o) objects.set(key, o = { key, name: '', groups: [], loose: [], latest: '' })
    if (!o.name && name) o.name = name
    return o
  }
  const touch = (o, day) => { if (day > o.latest) o.latest = day }

  for (const g of groups) {
    const o = objectOf(g.root.object_id, g.root.objects?.name)
    o.groups.push(g)
    touch(o, dayOf(g.root.contract_date))
    for (const { doc } of g.children) touch(o, dayOf(doc.contract_date))
  }
  for (const r of requests) {
    const g = groupByDoc.get(r.contract_id) || groupByDoc.get(r.amendment_id)
    if (g) g.requests.push(r)
    else objectOf(r.object_id, r.objects?.name).loose.push(r)
  }
  for (const o of objects.values()) {
    for (const g of o.groups) for (const r of g.requests) touch(o, dayOf(r.created_at))
    for (const r of o.loose) touch(o, dayOf(r.created_at))
    const contracts = o.groups.filter(isContractRoot).length
    o.counts = {
      contracts,
      // ДС без загруженного договора — корень группы, но всё равно ДС.
      amendments: o.groups.reduce((n, g) => n + g.children.length, 0) + o.groups.length - contracts,
      requests: o.groups.reduce((n, g) => n + g.requests.length, 0) + o.loose.length,
    }
  }
  return [...objects.values()].sort((a, b) => (a.key === '') - (b.key === '')
    || b.latest.localeCompare(a.latest)
    || a.name.localeCompare(b.name, 'ru'))
}

// Заключённый договор — галочка «Договор» и фильтр «С договором» реестра контрагентов: договор (не ДС), не
// удалён, со статусом «Завершено» или с датой подписания.
export const isConcludedContract = (c) => !!c && !c.deleted_at && c.record_type === DOC_TYPE.CONTRACT
  && (c.status === COMPLETED_STATUS || !!c.signed_date)

// → Map(id контрагента → число заключённых договоров). Контрагент — основная сторона (contracts.counterparty_id),
// другая сторона (contract_counterparties) или договор прикреплён к нему вручную (counterparty_contract_links) —
// как в разделе «Договоры и ДС» его карточки. Договор считается у контрагента один раз.
export function concludedContractsByCounterparty(contracts, parties = [], links = []) {
  const concluded = new Map()
  for (const c of contracts) if (isConcludedContract(c)) concluded.set(c.id, c)
  const byCp = new Map()
  const add = (counterpartyId, contractId) => {
    if (!counterpartyId || !concluded.has(contractId)) return
    let ids = byCp.get(counterpartyId)
    if (!ids) byCp.set(counterpartyId, ids = new Set())
    ids.add(contractId)
  }
  for (const c of concluded.values()) add(c.counterparty_id, c.id)
  for (const p of parties) add(p.counterparty_id, p.contract_id)
  for (const l of links) add(l.counterparty_id, l.contract_id)
  return new Map([...byCp].map(([id, ids]) => [id, ids.size]))
}
