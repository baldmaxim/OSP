// Смета КП / ПЗ объекта: дерево строк, объёмы и распределения, свод по разделам, поиск и фильтры. Модуль чистый —
// tests/tender/kp-estimate.test.mjs. Разбор файлов — kpEstimateImport.js, выгрузка — kpEstimateExport.js.
//
// Объёмы позиции:
//   • исходный — «Кол-во ГП» КП (по нему посчитана цена; нет его — «Кол-во заказчика»);
//   • актуальный — уточнённый экономистом (kp_estimate_marks.actual_qty), не задан — исходный; разница и причина;
//   • распределения (kp_estimate_allocations): тендер и объём, взятый в расчёт ПЗ; подрядчик, договор и закреплённый
//     объём. Объём тендера и объём договоров по этому же тендеру — один и тот же объём (договор заключают по итогам
//     тендера), поэтому в распределённом он учитывается один раз — по большему из двух. Строки без тендера (договор
//     напрямую) — каждая сама по себе. Так позицию можно делить между тендерами и подрядчиками без двойного списания;
//   • свободный остаток = актуальный − распределённый. Меньше нуля — превышение (подсвечивается, не запрещается).
// Изменение актуального объёма распределений и договоров не трогает: превышение станет видно, решает человек.

export const FILL_COLORS = [
  { key: '#fff3bf', label: 'Жёлтый' },
  { key: '#d3f9d8', label: 'Зелёный' },
  { key: '#d0ebff', label: 'Голубой' },
  { key: '#ffe3e3', label: 'Красный' },
  { key: '#ffe8cc', label: 'Оранжевый' },
  { key: '#e5dbff', label: 'Сиреневый' },
  { key: '#e9ecef', label: 'Серый' },
]
export const FILL_KEYS = new Set(FILL_COLORS.map((c) => c.key))
export const NOTE_MAX = 4000
export const REASON_MAX = 2000

export const STATUS_LABELS = {
  empty: 'Нет объёма',
  none: 'Не распределено',
  partial: 'Частично',
  full: 'Распределено',
  over: 'Превышение',
}

// Строки, у которых есть объём и могут быть распределения.
export const isPosition = (row) => row?.kind === 'position' || row?.kind === 'adjust'
// Строки с единицей — им можно уточнить объём (позиция и укрупнённая позиция).
export const hasVolume = (row) => !!row?.unit && (row.kind === 'position' || row.kind === 'aggregate')
export const isGroupKind = (kind) => kind === 'section' || kind === 'group' || kind === 'aggregate'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)))
const eps = (v) => 1e-6 * Math.max(1, Math.abs(v || 0))
export const round6 = (v) => Math.round(v * 1e6) / 1e6
export const round2 = (v) => Math.round(v * 100) / 100

// Исходный объём и цена за единицу коммерции (как «Цена за ед. коммерч.» листа «Смета»: итог / Кол-во ГП, иначе /
// Кол-во заказчика).
export function originalQty(row) {
  const gp = num(row?.kp?.qty_gp ?? row?.pz?.qty_gp)
  if (gp) return gp
  return num(row?.kp?.qty_customer ?? row?.pz?.qty_customer) || 0
}
export const rowTotal = (row) => num(row?.pz?.comm_total ?? row?.kp?.total) || 0
export function unitPrice(row) {
  const q = originalQty(row)
  return q ? rowTotal(row) / q : 0
}

// ── Дерево ──────────────────────────────────────────────────────────────────
// rows — строки сметы из базы (id, row_no, parent_row_no, kind…). Порядок — row_no.
export function buildTree(rows) {
  const ordered = [...(rows || [])].sort((a, b) => a.row_no - b.row_no)
  const byId = new Map()
  const byNo = new Map()
  for (const r of ordered) { byId.set(r.id, r); byNo.set(r.row_no, r) }
  const parentOf = new Map()
  const children = new Map()
  const roots = []
  for (const r of ordered) {
    const parent = r.parent_row_no ? byNo.get(r.parent_row_no) : null
    if (parent) {
      parentOf.set(r.id, parent.id)
      if (!children.has(parent.id)) children.set(parent.id, [])
      children.get(parent.id).push(r.id)
    } else {
      roots.push(r.id)
    }
  }
  // Есть ли в ветке позиции ПЗ (вид «ПЗ» показывает только такие ветки).
  const hasPz = new Set()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i]
    if (r.pz || hasPz.has(r.id)) {
      hasPz.add(r.id)
      const p = parentOf.get(r.id)
      if (p) hasPz.add(p)
    }
  }
  return { rows: ordered, byId, byNo, parentOf, children, roots, hasPz }
}

export function ancestorsOf(tree, id) {
  const out = []
  let p = tree.parentOf.get(id)
  while (p) { out.push(p); p = tree.parentOf.get(p) }
  return out
}

export function descendantsOf(tree, id) {
  const out = []
  const stack = [...(tree.children.get(id) || [])].reverse()
  while (stack.length) {
    const cur = stack.pop()
    out.push(cur)
    const ch = tree.children.get(cur)
    if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i])
  }
  return out
}

// Связанные строки для перехода КП ↔ ПЗ. Из КП: сама строка, если у неё есть ПЗ, иначе все подробные позиции ПЗ
// внутри (у укрупнённой позиции и группы). Из ПЗ: сама строка и укрупнённая позиция КП над ней, если она есть.
export function linkedPzIds(tree, id) {
  const row = tree.byId.get(id)
  if (!row) return []
  if (row.pz) return [id]
  return descendantsOf(tree, id).filter((d) => tree.byId.get(d)?.pz)
}
export function linkedKpIds(tree, id) {
  const out = [id]
  const parent = tree.byId.get(tree.parentOf.get(id))
  if (parent?.kind === 'aggregate') out.unshift(parent.id)
  return out
}

// ── Распределения ───────────────────────────────────────────────────────────
// Группа распределения: один тендер (по id, иначе по подписи); строка без тендера — сама по себе.
export function allocationGroupKey(a) {
  if (a.tender_id) return `t:${a.tender_id}`
  const label = String(a.tender_label || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (label) return `l:${label}`
  return `a:${a.id}`
}

export function positionState(row, mark, allocations) {
  const original = originalQty(row)
  const actualSet = mark?.actual_qty !== null && mark?.actual_qty !== undefined && mark?.actual_qty !== ''
  const actual = actualSet ? Number(mark.actual_qty) : original
  const diff = round6(actual - original)
  const groupsMap = new Map()
  for (const a of allocations || []) {
    const key = allocationGroupKey(a)
    if (!groupsMap.has(key)) groupsMap.set(key, { key, tender_id: a.tender_id || null, tender_label: a.tender_label || '', pzQty: 0, contractQty: 0, items: [] })
    const g = groupsMap.get(key)
    g.pzQty += num(a.pz_qty) || 0
    g.contractQty += num(a.contract_qty) || 0
    g.items.push(a)
  }
  const groups = [...groupsMap.values()].map((g) => ({
    ...g,
    pzQty: round6(g.pzQty),
    contractQty: round6(g.contractQty),
    volume: round6(Math.max(g.pzQty, g.contractQty)),
    // По договорам тендера закреплено больше, чем взято в расчёт ПЗ этого тендера.
    contractOver: g.pzQty > 0 && g.contractQty > g.pzQty + eps(g.pzQty),
  }))
  const distributed = round6(groups.reduce((s, g) => s + g.volume, 0))
  const takenPz = round6(groups.reduce((s, g) => s + g.pzQty, 0))
  const contracted = round6(groups.reduce((s, g) => s + g.contractQty, 0))
  const free = round6(actual - distributed)
  const price = unitPrice(row)
  let status
  if (!actual && !distributed) status = 'empty'
  else if (free < -eps(actual)) status = 'over'
  else if (distributed <= eps(actual)) status = 'none'
  else if (Math.abs(free) <= eps(actual)) status = 'full'
  else status = 'partial'
  return {
    original, actual, actualSet, diff, changed: actualSet && Math.abs(diff) > eps(original),
    groups, distributed, takenPz, contracted, free, status, price,
    contractOver: groups.some((g) => g.contractOver),
    budget: rowTotal(row),
    distributedMoney: round2(distributed * price),
    freeMoney: round2(free * price),
    actualMoney: round2(actual * price),
  }
}

// Состояние всех позиций и свод по группам (снизу вверх). marks — Map(row_id → отметка), allocs — Map(row_id → [..]).
export function computeStates(tree, marks, allocs) {
  const states = new Map()
  for (const r of tree.rows) {
    if (!isPosition(r)) continue
    states.set(r.id, positionState(r, marks.get(r.id), allocs.get(r.id)))
  }
  const sums = new Map()
  const empty = () => ({
    positions: 0, total: 0, materials: 0, works: 0, direct: 0, directMain: 0, directAux: 0, directWorks: 0,
    commMaterials: 0, commWorks: 0, commTotal: 0,
    distributedMoney: 0, freeMoney: 0, overMoney: 0,
    counts: { empty: 0, none: 0, partial: 0, full: 0, over: 0 }, changed: 0, contractOver: 0, notes: 0, fills: 0,
  })
  for (let i = tree.rows.length - 1; i >= 0; i--) {
    const r = tree.rows[i]
    const ch = tree.children.get(r.id)
    if (!ch) {
      if (!isPosition(r)) continue
      const s = states.get(r.id)
      const agg = empty()
      agg.positions = 1
      agg.total = num(r.kp?.total) || 0
      agg.materials = num(r.kp?.materials) || 0
      agg.works = num(r.kp?.works) || 0
      agg.direct = num(r.pz?.direct) || 0
      agg.directMain = num(r.pz?.direct_main) || 0
      agg.directAux = num(r.pz?.direct_aux) || 0
      agg.directWorks = num(r.pz?.direct_works) || 0
      agg.commMaterials = num(r.pz?.comm_materials) || 0
      agg.commWorks = num(r.pz?.comm_works) || 0
      agg.commTotal = num(r.pz?.comm_total) || 0
      agg.distributedMoney = s.distributedMoney
      agg.freeMoney = Math.max(0, s.freeMoney)
      agg.overMoney = Math.max(0, -s.freeMoney)
      agg.counts[s.status]++
      if (s.changed) agg.changed++
      if (s.contractOver) agg.contractOver++
      sums.set(r.id, agg)
      continue
    }
    const agg = empty()
    for (const c of ch) {
      const s = sums.get(c)
      if (!s) continue
      for (const k of ['positions', 'total', 'materials', 'works', 'direct', 'directMain', 'directAux', 'directWorks', 'commMaterials', 'commWorks', 'commTotal', 'distributedMoney', 'freeMoney', 'overMoney', 'changed', 'contractOver']) agg[k] += s[k]
      for (const k of Object.keys(agg.counts)) agg.counts[k] += s.counts[k]
    }
    sums.set(r.id, agg)
  }
  const total = empty()
  for (const id of tree.roots) {
    const s = sums.get(id)
    if (!s) continue
    for (const k of ['positions', 'total', 'materials', 'works', 'direct', 'directMain', 'directAux', 'directWorks', 'commMaterials', 'commWorks', 'commTotal', 'distributedMoney', 'freeMoney', 'overMoney', 'changed', 'contractOver']) total[k] += s[k]
    for (const k of Object.keys(total.counts)) total.counts[k] += s.counts[k]
  }
  // Отметки — тоже итогом (сколько с примечанием и заливкой).
  for (const m of marks.values()) {
    if (m.note) total.notes++
    if (m.fill || (m.cell_fills && Object.keys(m.cell_fills).length)) total.fills++
  }
  return { states, sums, total }
}

// Состояние строки-группы для показа: превышение — если есть внутри, иначе по долям.
export function groupStatus(sum) {
  if (!sum || !sum.positions) return 'empty'
  const c = sum.counts
  if (c.over) return 'over'
  const live = sum.positions - c.empty
  if (!live) return 'empty'
  if (c.full === live) return 'full'
  if (c.full || c.partial) return 'partial'
  return 'none'
}

// ── Поиск и фильтры ─────────────────────────────────────────────────────────
const fold = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е')
export const searchTokens = (q) => fold(q).split(/\s+/).map((t) => t.trim()).filter(Boolean)

export function rowHaystack(row, mark, allocations) {
  const parts = [row.code, row.pos_no, row.name, row.unit, row.customer_note, row.gp_note, row.pz?.note, row.pz?.code]
  if (mark) parts.push(mark.note, mark.actual_reason, mark.responsible_name)
  for (const a of allocations || []) parts.push(a.tender_label, a.counterparty_name, a.contract_label, a.note)
  return fold(parts.filter(Boolean).join(' \u0001 '))
}

export const EMPTY_FILTERS = Object.freeze({
  statuses: [], changed: false, withNote: false, withFill: false, contractOver: false, noResponsible: false,
  responsible: '', tender: '', counterparty: '',
})
export const filtersActive = (f) => !!f && (f.statuses?.length || f.changed || f.withNote || f.withFill || f.contractOver ||
  f.noResponsible || f.responsible || f.tender || f.counterparty)

// Подходит ли строка под фильтры (поиск — отдельно). Фильтры по состоянию и распределениям — только для позиций;
// примечание, заливка, ответственный — для любой строки.
export function rowMatchesFilters(row, mark, allocations, state, f) {
  if (!filtersActive(f)) return true
  const pos = isPosition(row)
  if (f.statuses?.length && !(pos && state && f.statuses.includes(state.status))) return false
  if (f.changed && !(state ? state.changed : false)) return false
  if (f.contractOver && !(state?.contractOver)) return false
  if (f.withNote && !mark?.note) return false
  if (f.withFill && !(mark?.fill || (mark?.cell_fills && Object.keys(mark.cell_fills).length))) return false
  if (f.noResponsible && (mark?.responsible_id || mark?.responsible_name || !pos)) return false
  if (f.responsible && (mark?.responsible_id || `n:${mark?.responsible_name || ''}`) !== f.responsible) return false
  if (f.tender && !(allocations || []).some((a) => allocationGroupKey(a) === f.tender)) return false
  if (f.counterparty && !(allocations || []).some((a) => counterpartyKey(a) === f.counterparty)) return false
  return true
}

export const counterpartyKey = (a) => (a.counterparty_id ? `c:${a.counterparty_id}` : (a.counterparty_name ? `n:${String(a.counterparty_name).toLowerCase().trim()}` : ''))

// Какие строки показать. view: 'kp' — все строки КП; 'pz' — только ветки с позициями ПЗ. scope — id ветки дерева
// разделов (только она). match — Set id, подошедших под поиск/фильтры (null — без отбора): показываются они и их
// предки, свёрнутость тогда не действует. collapsed — Set свёрнутых id.
export function visibleRowIds(tree, { view = 'kp', scope = null, match = null, collapsed = null } = {}) {
  const inScope = scope ? new Set([scope, ...descendantsOf(tree, scope)]) : null
  let keep = null
  if (match) {
    keep = new Set()
    for (const id of match) {
      if (inScope && !inScope.has(id)) continue
      keep.add(id)
      for (const a of ancestorsOf(tree, id)) keep.add(a)
    }
    if (scope) for (const a of ancestorsOf(tree, scope)) keep.delete(a)
  }
  const out = []
  const hidden = new Set()
  for (const r of tree.rows) {
    if (inScope && !inScope.has(r.id)) continue
    if (view === 'pz' && !tree.hasPz.has(r.id)) continue
    if (keep && !keep.has(r.id)) continue
    const parent = tree.parentOf.get(r.id)
    if (parent && hidden.has(parent)) { hidden.add(r.id); continue }
    out.push(r.id)
    if (!keep && collapsed?.has(r.id)) hidden.add(r.id)
  }
  return out
}

// Уровни свёртки: «до уровня N» — свернуть все группы уровня N (видны уровни 1…N).
export function collapseToLevel(tree, level) {
  const out = new Set()
  for (const r of tree.rows) if (tree.children.has(r.id) && r.level >= level) out.add(r.id)
  return out
}

// Дерево разделов слева: группы (без позиций) с отбором по названию и коду.
export function sectionTree(tree, query = '', view = 'kp') {
  const tokens = searchTokens(query)
  const groups = tree.rows.filter((r) => tree.children.has(r.id) && r.kind !== 'aggregate' && (view !== 'pz' || tree.hasPz.has(r.id)))
  if (!tokens.length) return { ids: groups.map((r) => r.id), matched: null }
  const matched = new Set()
  const keep = new Set()
  for (const r of groups) {
    const hay = fold(`${r.code || ''} ${r.name}`)
    if (tokens.every((t) => hay.includes(t))) {
      matched.add(r.id)
      keep.add(r.id)
      for (const a of ancestorsOf(tree, r.id)) keep.add(a)
    }
  }
  return { ids: groups.filter((r) => keep.has(r.id)).map((r) => r.id), matched }
}

// ── Подписи ────────────────────────────────────────────────────────────────
export const rowLabel = (row) => [row?.code || (row?.pos_no ? `№ ${row.pos_no}` : ''), row?.name].filter(Boolean).join(' ')

export function fmtQty(v) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return ''
  return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 })
}
export function fmtMoney(v) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return ''
  return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// Короткая сумма для итогов: 15,80 млрд, 329,99 млн.
export function fmtMoneyShort(v) {
  const n = Number(v) || 0
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млрд ₽`
  if (a >= 1e6) return `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн ₽`
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`
}

// Число из поля ввода: «1 234,5» → 1234.5; пусто → null; не число → NaN.
export function parseQtyInput(s) {
  const t = String(s ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

// Подпись ответственного для фильтра: id, иначе ФИО.
export const responsibleKey = (m) => (m?.responsible_id ? m.responsible_id : (m?.responsible_name ? `n:${m.responsible_name}` : ''))

// Отметка → поля записи (только допустимые, нормализованные).
export function markPayload(patch) {
  const out = {}
  if ('note' in patch) out.note = patch.note ? String(patch.note).slice(0, NOTE_MAX) : null
  if ('actual_reason' in patch) out.actual_reason = patch.actual_reason ? String(patch.actual_reason).slice(0, REASON_MAX) : null
  if ('actual_qty' in patch) out.actual_qty = patch.actual_qty === null || patch.actual_qty === '' ? null : Number(patch.actual_qty)
  if ('fill' in patch) out.fill = patch.fill && FILL_KEYS.has(patch.fill) ? patch.fill : null
  if ('cell_fills' in patch) {
    const cf = {}
    for (const [k, v] of Object.entries(patch.cell_fills || {})) if (FILL_KEYS.has(v) && /^[a-z_]{1,32}$/.test(k)) cf[k] = v
    out.cell_fills = cf
  }
  if ('responsible_id' in patch) out.responsible_id = patch.responsible_id || null
  if ('responsible_name' in patch) out.responsible_name = patch.responsible_name ? String(patch.responsible_name).slice(0, 200) : null
  return out
}

// Пустая ли отметка (строку можно удалить).
export const markIsEmpty = (m) => !m || (!m.note && !m.fill && !(m.cell_fills && Object.keys(m.cell_fills).length) &&
  (m.actual_qty === null || m.actual_qty === undefined) && !m.actual_reason && !m.responsible_id && !m.responsible_name)

// Распределить в тендер свободный остаток выбранных позиций: строки для записи (без превышения; позиция без
// остатка пропускается). Уже есть строка этого тендера без подрядчика — её объём увеличивается.
export function planTenderAllocation({ rowIds, tree, states, allocsByRow, tender }) {
  const key = tender.tender_id ? `t:${tender.tender_id}` : `l:${String(tender.tender_label || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
  const inserts = []
  const updates = []
  const skipped = []
  for (const id of rowIds) {
    const row = tree.byId.get(id)
    if (!isPosition(row)) continue
    const s = states.get(id)
    if (!s || s.free <= eps(s.actual)) { skipped.push(id); continue }
    const existing = (allocsByRow.get(id) || []).find((a) => allocationGroupKey(a) === key && !a.counterparty_id && !a.counterparty_name)
    if (existing) {
      updates.push({ id: existing.id, row_id: id, row_version: existing.row_version, pz_qty: round6((num(existing.pz_qty) || 0) + s.free) })
    } else {
      inserts.push({ row_id: id, tender_id: tender.tender_id || null, tender_label: tender.tender_label || null, pz_qty: round6(s.free) })
    }
  }
  return { inserts, updates, skipped }
}
