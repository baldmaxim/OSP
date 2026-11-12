// «Дерево договоров» (/contracts/tree; эксперимент 12.11.2026, виден только администратору): договор — ствол, его ДС и
// заявки трёх разделов — ветки.
//
// Связи с договором:
//   • заявка на ДС — contract_id / amendment_id (в базе с миграции 20261109);
//   • проверка ДП/ДС и заявка на ДП — своего поля договора в базе пока нет (по плану — contract_id новой миграцией).
//     Есть поле (пример страницы, будущая база) — берём его. Нет — договор ищется здесь же, в браузере, и только
//     однозначно: контрагент, объект, вид документа и номер; у проверки ДС — ещё номер договора из текста
//     («ДС № 2 к ДП № СУ2-…»); у заявки на ДП — номер договора, вписанный отделом;
//   • привязка вручную в эксперименте — localStorage этого браузера (links: ключ заявки → id договора или ДС).
// Не нашлось — заявка «без договора»: для неё подсказки (suggestTargets).
//
// Модуль без React и запросов: его проверяет tests/contracts/contract-tree.test.mjs.
import { DOC_TYPE, DOC_TYPE_SHORT, effectiveDocumentAmount } from './contractAmendments.js'
import { dsRoots } from './contractRegistryTabs.js'
import { contractChoicesFor, dsNumberKey, normalizeDocNumber } from './dcRequestContracts.js'
import { STATUS_OPTIONS as DC_STATUS_OPTIONS } from './dcRequestOptions.js'
import { requestTotals } from './dcRequestAmounts.js'
import { DOC_CHECK_STATUSES, dueState } from './docCheckHelpers.js'
import { DP_STATUS_OPTIONS } from './dpRequests.js'
import { amountChange } from './money.js'

export const KIND = { DC: 'dc', CHECK: 'check', DP: 'dp' }

// Цвета — как у карточек этих разделов на странице «Договоры и ДС» (/contracts): узнаётся сразу.
export const KIND_META = {
  dc: { label: 'Заявка на ДС', short: 'Заявка на ДС', tone: 'green' },
  check: { label: 'Проверка ДП/ДС', short: 'Проверка', tone: 'slate' },
  dp: { label: 'Заявка на ДП', short: 'Заявка на ДП', tone: 'violet' },
}

// Статусы договора и ДС — как STATUS_OPTIONS в ContractsPage (там они не вынесены). state — цвет плашки.
const CONTRACT_STATUS = {
  new_request: { label: 'Новая заявка', state: 'new' },
  in_work: { label: 'В работе', state: 'work' },
  awaiting_paper_sign: { label: 'Ожидание подписания', state: 'work' },
  paused: { label: 'Приостановка', state: 'paused' },
  completed: { label: 'Завершено', state: 'done' },
}
export function contractStatus(doc) {
  if (doc?.deleted_at) return { label: 'Удалён', state: 'paused' }
  return CONTRACT_STATUS[doc?.status || 'new_request'] || { label: doc.status, state: 'work' }
}

export const isContractDoc = (doc) => (doc?.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT
export const docKindLabel = (doc) => (isContractDoc(doc) ? 'Договор' : 'ДС')
export const docTypeShort = (doc) => DOC_TYPE_SHORT[doc?.record_type] || ''
export const docAmount = (doc) => effectiveDocumentAmount(doc)

// ── Этапы ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Шаги — для точек в строке и полоски этапов в карточке справа. Проверка: шесть колонок доски; «Ожидаем скан» —
// бумажная подпись вместо ЭДО, поэтому стоит на месте третьего шага.
const CHECK_SHORT = { new: 'Новая', in_progress: 'В работе', edo: 'ЭДО', signal: 'Signal', accounting: '1С', done: 'Завершено' }
const CHECK_STEPS = ['new', 'in_progress', 'edo', 'signal', 'accounting', 'done'].map((value) => ({
  value,
  short: CHECK_SHORT[value],
  label: DOC_CHECK_STATUSES.find((s) => s.value === value)?.label || value,
}))
const DC_STEPS = DC_STATUS_OPTIONS.map((o) => ({ value: o.value, short: o.label, label: o.label }))
const DP_STEPS = DP_STATUS_OPTIONS.map((o) => ({ value: o.value, short: o.label, label: o.label }))
const STEPS = { dc: DC_STEPS, check: CHECK_STEPS, dp: DP_STEPS }

// → { steps, index, label }. index −1 — статус вне справочника: точки пустые, подпись — как в базе.
export function stepsOf(kind, status) {
  const steps = STEPS[kind]
  if (kind === KIND.CHECK && status === 'awaiting_scan') {
    return { steps, index: 2, label: 'Ожидаем скан (бумага)' }
  }
  const index = steps.findIndex((s) => s.value === status)
  return { steps, index, label: index >= 0 ? steps[index].label : (status || '—') }
}

export function isActiveRequest(kind, raw) {
  if (!raw || raw.deleted_at) return false
  if (kind === KIND.DC) return (raw.status || 'contract_check') !== 'completed'
  if (kind === KIND.CHECK) return raw.status !== 'done' && !raw.archived_at
  return raw.status === 'new' || raw.status === 'in_work'
}

// Номер заявки так, как его пишет её раздел: у проверки — «ID», у заявок — «№».
export function requestNumber(kind, raw) {
  const n = raw?.request_number
  if (n == null || n === '') return ''
  return kind === KIND.CHECK ? `ID ${n}` : `№ ${n}`
}

// Изменение суммы заявки на ДС: было (ПСДЦ + ВОР подрядчика) → согласовано (ДС ОСП + ВОР ОСП), как в отчёте.
export function dcAmounts(raw) {
  const { before, after } = requestTotals(raw)
  const { pct } = amountChange(before, after)
  return { before, after, pct }
}

function requestItem(kind, raw) {
  const st = stepsOf(kind, raw.status)
  return {
    kind,
    key: `${kind}:${raw.id}`,
    id: raw.id,
    raw,
    number: requestNumber(kind, raw),
    active: isActiveRequest(kind, raw),
    overdue: kind === KIND.CHECK && dueState(raw) === 'overdue' && !raw.archived_at,
    ...st,
    link: null,
  }
}

// ── Поиск договора ───────────────────────────────────────────────────────────────────────────────────────────────

// Номер договора из текста заявки: «ДС № 1 к Договору № 261П-26 от 25.05.26», «ДС№8 к ДП №152/22-ГК».
export function contractRefOf(text) {
  const m = String(text || '').match(/(?:^|[\s/(])(?:к|по)\s*(?:ДП|договору|договора|дог\.?)\s*(?:подряда\s*)?№\s*([^\s,;)]+)/iu)
  return m ? m[1].replace(/[.,]+$/, '') : ''
}

// Договоры и ДС: живые, договор каждого ДС (dsRoots), стороны (договор с несколькими контрагентами), ДС по договору.
export function indexContracts(contracts = []) {
  const live = contracts.filter((c) => c && !c.deleted_at)
  const byId = new Map(live.map((c) => [c.id, c]))
  const roots = dsRoots(live)
  const own = new Map()
  for (const c of live) {
    const set = new Set()
    if (c.counterparty_id) set.add(c.counterparty_id)
    for (const p of c.contract_counterparties || []) if (p?.counterparty_id) set.add(p.counterparty_id)
    own.set(c.id, set)
  }
  // У ДС контрагент часто не заполнен — стороны договора.
  const parties = new Map()
  for (const c of live) {
    const set = new Set(own.get(c.id))
    const root = roots.get(c.id)
    if (root) for (const p of own.get(root) || []) set.add(p)
    parties.set(c.id, set)
  }
  const dsOf = new Map()
  for (const c of live) {
    if (isContractDoc(c)) continue
    const root = roots.get(c.id)
    if (!root) continue
    if (!dsOf.has(root)) dsOf.set(root, [])
    dsOf.get(root).push(c)
  }
  for (const list of dsOf.values()) {
    list.sort((a, b) => String(a.contract_date || '').localeCompare(String(b.contract_date || ''))
      || Number(a.display_id || 0) - Number(b.display_id || 0))
  }
  return { live, byId, roots, parties, dsOf }
}

const objectFits = (c, objectId) => !objectId || !c.object_id || c.object_id === objectId
const partyFits = (idx, c, cpId) => !!cpId && !!idx.parties.get(c.id)?.has(cpId)
const one = (list, how, extra = {}) => (list.length === 1 ? { targetId: list[0].id, how, ...extra } : null)

// Проверка ДП/ДС → договор или ДС.
export function matchCheck(check, idx) {
  if (check.contract_id) return idx.byId.has(check.contract_id) ? { targetId: check.contract_id, how: 'field' } : null
  const cp = check.counterparty_id
  if (!cp) return null
  const fits = (c) => partyFits(idx, c, cp) && objectFits(c, check.object_id)
  if (check.doc_type === 'dp') {
    const num = normalizeDocNumber(check.doc_number)
    if (!num) return null
    return one(idx.live.filter((c) => isContractDoc(c) && fits(c) && normalizeDocNumber(c.contract_number) === num), 'number')
  }
  const key = dsNumberKey(check.doc_number)
  const ref = contractRefOf(`${check.doc_number || ''} ${check.notes || ''}`)
  if (ref) {
    const refNum = normalizeDocNumber(ref)
    const parents = idx.live.filter((c) => isContractDoc(c) && fits(c) && normalizeDocNumber(c.contract_number) === refNum)
    if (parents.length === 1) {
      const ds = key ? (idx.dsOf.get(parents[0].id) || []).filter((d) => dsNumberKey(d.contract_number) === key) : []
      if (ds.length === 1) return { targetId: ds[0].id, how: 'notes' }
      // Договор нашёлся, а ДС с таким номером в реестре нет — проверка висит на договоре.
      return { targetId: parents[0].id, how: 'notes', missingDs: check.doc_number || '' }
    }
  }
  if (!key) return null
  return one(idx.live.filter((d) => !isContractDoc(d) && fits(d) && dsNumberKey(d.contract_number) === key), 'number')
}

// Заявка на ДС → ДС (занесена) или договор. ДС с тем же номером у договора — заявка считается занесённой в него.
export function matchDc(req, idx) {
  if (req.amendment_id && idx.byId.has(req.amendment_id)) return { targetId: req.amendment_id, how: 'field' }
  if (!req.contract_id || !idx.byId.has(req.contract_id)) return null
  const key = dsNumberKey(req.ds_number)
  const ds = key ? (idx.dsOf.get(req.contract_id) || []).filter((d) => dsNumberKey(d.contract_number) === key) : []
  if (ds.length === 1) return { targetId: ds[0].id, how: 'number' }
  return { targetId: req.contract_id, how: 'field' }
}

// Заявка на ДП → договор, оформленный по ней.
export function matchDp(req, idx) {
  if (req.contract_id) return idx.byId.has(req.contract_id) ? { targetId: req.contract_id, how: 'field' } : null
  const num = normalizeDocNumber(req.contract_title)
  if (!num) return null
  return one(idx.live.filter((c) => isContractDoc(c) && objectFits(c, req.object_id)
    && normalizeDocNumber(c.contract_number) === num), 'title')
}

const MATCHERS = { dc: matchDc, check: matchCheck, dp: matchDp }

export const LINK_HOW = {
  field: 'Связь указана в заявке',
  number: 'Найдено по контрагенту, объекту и номеру документа',
  notes: 'Найдено по номеру договора в тексте заявки',
  title: 'Найдено по номеру договора, вписанному в заявку',
  local: 'Привязано вручную — пока только в этом браузере (эксперимент)',
}

// ── Дерево ───────────────────────────────────────────────────────────────────────────────────────────────────────

const byCreated = (a, b) => String(a.raw.created_at || '').localeCompare(String(b.raw.created_at || ''))
const laterOf = (a, b) => (String(b || '') > String(a || '') ? b : a)

// → {
//   roots: [{ key, doc, node, ds: [node], stats }]  — договоры (и ДС, чей договор не загружен);
//   node = { doc, requests: [заявка], basis: [заявка на ДП] };
//   loose: { dp, dc, check } — заявки без договора;
//   items: Map(ключ → заявка), nodes: Map(id документа → node), rootOf: Map(id документа → корень), idx, totals
// }
// Заявка: { kind, key, id, raw, number, active, overdue, steps, index, label, link: { targetId, how, missingDs? } | null }.
export function buildContractTree({ contracts = [], dcRequests = [], checks = [], dpRequests = [], links = {} } = {}) {
  const idx = indexContracts(contracts)
  const nodes = new Map(idx.live.map((c) => [c.id, { doc: c, requests: [], basis: [] }]))
  const loose = { dp: [], dc: [], check: [] }
  const items = new Map()

  const add = (kind, raw) => {
    const item = requestItem(kind, raw)
    const local = links?.[item.key]
    item.link = local && idx.byId.has(local) ? { targetId: local, how: 'local' } : MATCHERS[kind](raw, idx)
    items.set(item.key, item)
    const node = item.link && nodes.get(item.link.targetId)
    if (!node) { item.link = null; loose[kind].push(item); return }
    if (kind === KIND.DP) node.basis.push(item)
    else node.requests.push(item)
  }
  for (const r of dcRequests) if (r && !r.deleted_at) add(KIND.DC, r)
  // tax_clause — 106 копий заявок из «Завершено»: миграция 20270202 уводит их в «Удалённые».
  for (const r of checks) if (r && !r.deleted_at && r.status !== 'tax_clause') add(KIND.CHECK, r)
  for (const r of dpRequests) if (r && !r.deleted_at && r.status !== 'draft') add(KIND.DP, r)

  for (const n of nodes.values()) { n.requests.sort(byCreated); n.basis.sort(byCreated) }
  for (const list of Object.values(loose)) list.sort((a, b) => (b.active - a.active) || -byCreated(a, b))

  const roots = []
  const rootOf = new Map()
  for (const c of idx.live) {
    const rootId = isContractDoc(c) ? null : idx.roots.get(c.id)
    if (rootId && nodes.has(rootId)) continue
    const ds = isContractDoc(c) ? (idx.dsOf.get(c.id) || []).map((d) => nodes.get(d.id)) : []
    const root = { key: c.id, doc: c, node: nodes.get(c.id), ds }
    root.stats = rootStats(root)
    roots.push(root)
    rootOf.set(c.id, root)
    for (const n of ds) rootOf.set(n.doc.id, root)
  }

  const totals = { dc: 0, check: 0, dp: 0 }
  for (const it of items.values()) if (it.active) totals[it.kind]++
  return { roots, loose, items, nodes, rootOf, idx, totals }
}

// Все заявки ветки: основание, заявки договора, заявки ДС.
export function rootRequests(root) {
  return [...root.node.basis, ...root.node.requests, ...root.ds.flatMap((n) => n.requests)]
}

function rootStats(root) {
  const reqs = rootRequests(root)
  const byKind = { dc: 0, check: 0, dp: 0 }
  let active = 0
  let overdue = 0
  let latest = root.doc.contract_date || root.doc.created_at || ''
  for (const r of reqs) {
    byKind[r.kind]++
    if (r.active) active++
    if (r.active && r.overdue) overdue++
    latest = laterOf(latest, r.raw.updated_at || r.raw.created_at)
  }
  for (const n of root.ds) latest = laterOf(latest, n.doc.contract_date)
  return { total: reqs.length, byKind, active, overdue, ds: root.ds.length, latest }
}

// ── Подсказки для заявок без договора ────────────────────────────────────────────────────────────────────────────

// → [{ doc, exact }] — куда привязать: сначала совпадение номера, затем договоры того же контрагента и объекта.
export function suggestTargets(item, idx, limit = 4) {
  const r = item.raw
  const out = []
  const seen = new Set()
  const push = (doc, exact = false) => {
    if (!doc || seen.has(doc.id) || out.length >= limit) return
    seen.add(doc.id)
    out.push({ doc, exact })
  }
  if (item.kind === KIND.DC) {
    for (const c of contractChoicesFor(idx.live, r.counterparty_id, r.object_id, idx.parties)) push(c)
    return out
  }
  if (item.kind === KIND.DP) {
    const num = normalizeDocNumber(r.contract_title)
    const onObject = idx.live.filter((c) => isContractDoc(c) && (!r.object_id || c.object_id === r.object_id))
      .sort((a, b) => String(b.contract_date || '').localeCompare(String(a.contract_date || '')))
    for (const c of onObject) if (num && normalizeDocNumber(c.contract_number) === num) push(c, true)
    for (const c of onObject) push(c)
    return out
  }
  const fits = (c) => partyFits(idx, c, r.counterparty_id) && objectFits(c, r.object_id)
  const contracts = idx.live.filter((c) => isContractDoc(c) && fits(c))
    .sort((a, b) => String(b.contract_date || '').localeCompare(String(a.contract_date || '')))
  if (r.doc_type === 'dp') {
    const num = normalizeDocNumber(r.doc_number)
    for (const c of contracts) if (num && normalizeDocNumber(c.contract_number) === num) push(c, true)
    for (const c of contracts) push(c)
    return out
  }
  const key = dsNumberKey(r.doc_number)
  const ds = idx.live.filter((d) => !isContractDoc(d) && fits(d))
  for (const d of ds) if (key && dsNumberKey(d.contract_number) === key) push(d, true)
  for (const c of contracts) push(c)
  return out
}

// Поиск договора или ДС вручную: номер, ID, контрагент, объект, работы.
export function searchTargets(idx, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length < 2) return []
  const hits = []
  for (const c of idx.live) {
    const text = [
      c.contract_number, c.display_id != null ? `id ${c.display_id}` : '', c.counterparties?.name,
      c.objects?.name, c.work_name,
    ].filter(Boolean).join(' ').toLowerCase()
    if (text.includes(q)) hits.push(c)
    if (hits.length >= limit) break
  }
  return hits
}

// Текст ветки для поиска на странице: договор, его ДС и заявки.
export function rootHaystack(root) {
  const docs = [root.doc, ...root.ds.map((n) => n.doc)]
  const parts = []
  for (const d of docs) {
    parts.push(d.contract_number, d.counterparties?.name, d.objects?.name, d.work_name)
    if (d.display_id != null) parts.push(`id ${d.display_id}`)
  }
  for (const r of rootRequests(root)) {
    parts.push(r.number, r.raw.ds_number, r.raw.doc_number, r.raw.contract_title, r.raw.works_description)
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

// Подпись документа одной строкой: «Договор № 12 от 01.03.26» / «ДС № 2».
export function docTitle(doc) {
  const num = doc?.contract_number ? `№ ${doc.contract_number}` : 'без номера'
  return `${docKindLabel(doc)} ${num}`
}
