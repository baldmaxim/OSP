// Смета КП / ПЗ объекта: дерево строк, объёмы и распределения, свод по разделам, поиск и отбор. Модуль чистый —
// tests/tender/kp-estimate.test.mjs. Разбор файлов — kpEstimateImport.js, выгрузка — kpEstimateExport.js.
//
// Объём позиции (13.11.2026, решение пользователя: «ориентируемся только на Количество (ГП), кол-во заказчика не
// важно; исходный объём и кол-во заказчика — это разное»):
//   • исходный — «Количество (ГП)» КП до перекидок, и только оно (у К14 324 позиции с кол-вом заказчика без ГП — все
//     с нулевой стоимостью: учтены в других строках);
//   • актуальный — уточнённый экономистом (kp_estimate_marks.actual_qty), не задан — исходный;
//   • распределение (kp_estimate_allocations) — одно окно: тендер (может не быть) + подрядчик, который его выиграл, +
//     объём. Объём строки — pz_qty; у строк, записанных до 13.11 (тендер и договор с двумя объёмами), — больший из
//     pz_qty и contract_qty. Строки складываются: тендер с двумя победителями — две строки;
//   • свободно = актуальный − распределённый. Меньше нуля — превышение (подсвечивается, не запрещается).
// Изменение актуального объёма распределений не трогает: превышение станет видно, решает человек.

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

// Исходный объём — «Количество (ГП)» (у строки КП — из КП, у строки только сметы ПЗ — «Кол-во ГП» сметы).
export function originalQty(row) {
  return num(row?.kp?.qty_gp ?? row?.pz?.qty_gp) || 0
}
// Стоимость строки: коммерция ПЗ (у К14 она равна стоимости КП), иначе стоимость КП.
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
  return { rows: ordered, byId, byNo, parentOf, children, roots }
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

// ── Распределения ───────────────────────────────────────────────────────────
// Объём строки распределения (строки до 13.11 — тендер и договор с двумя объёмами — по большему).
export const allocQty = (a) => round6(Math.max(num(a?.pz_qty) || 0, num(a?.contract_qty) || 0))

// Пара «тендер + подрядчик» — как уникальный индекс базы kp_estimate_allocations_pair.
const labelKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
export const tenderKey = (a) => (a?.tender_id ? `t:${a.tender_id}` : (labelKey(a?.tender_label) ? `l:${labelKey(a.tender_label)}` : ''))
export const counterpartyKey = (a) => (a?.counterparty_id ? `c:${a.counterparty_id}` : (labelKey(a?.counterparty_name) ? `n:${labelKey(a.counterparty_name)}` : ''))
export const pairKey = (a) => `${tenderKey(a)}|${counterpartyKey(a)}`

// Подпись распределения: «№ 501 · ООО «Монолит-Строй»» (без тендера — только подрядчик).
export const allocationText = (a) => [a?.tender_label, a?.counterparty_name].filter(Boolean).join(' · ') || 'без тендера и подрядчика'

export function positionState(row, mark, allocations) {
  const original = originalQty(row)
  const actualSet = mark?.actual_qty !== null && mark?.actual_qty !== undefined && mark?.actual_qty !== ''
  const actual = actualSet ? Number(mark.actual_qty) : original
  const diff = round6(actual - original)
  const distributed = round6((allocations || []).reduce((s, a) => s + allocQty(a), 0))
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
    distributed, free, status, price,
    budget: rowTotal(row),
    distributedMoney: round2(distributed * price),
    freeMoney: round2(free * price),
    actualMoney: round2(actual * price),
  }
}

// Состояние всех позиций и свод по группам (снизу вверх). marks — Map(row_id → отметка), allocs — Map(row_id → [..]).
const SUM_KEYS = ['positions', 'total', 'materials', 'works', 'direct', 'directMain', 'directAux', 'directWorks',
  'distributedMoney', 'freeMoney', 'overMoney', 'changed']
export function computeStates(tree, marks, allocs) {
  const states = new Map()
  for (const r of tree.rows) {
    if (!isPosition(r)) continue
    states.set(r.id, positionState(r, marks.get(r.id), allocs.get(r.id)))
  }
  const sums = new Map()
  const empty = () => {
    const o = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]))
    o.counts = { empty: 0, none: 0, partial: 0, full: 0, over: 0 }
    o.notes = 0
    o.fills = 0
    return o
  }
  const add = (agg, s) => {
    for (const k of SUM_KEYS) agg[k] += s[k]
    for (const k of Object.keys(agg.counts)) agg.counts[k] += s.counts[k]
  }
  for (let i = tree.rows.length - 1; i >= 0; i--) {
    const r = tree.rows[i]
    const ch = tree.children.get(r.id)
    if (!ch) {
      if (!isPosition(r)) continue
      const s = states.get(r.id)
      const agg = empty()
      agg.positions = 1
      // Стоимость КП — только строки КП: «Округление до копеек» сметы ПЗ в итог КП не входит (у К14 −0,32 ₽).
      agg.total = num(r.kp?.total) || 0
      agg.materials = num(r.kp?.materials) || 0
      agg.works = num(r.kp?.works) || 0
      agg.direct = num(r.pz?.direct) || 0
      agg.directMain = num(r.pz?.direct_main) || 0
      agg.directAux = num(r.pz?.direct_aux) || 0
      agg.directWorks = num(r.pz?.direct_works) || 0
      agg.distributedMoney = s.distributedMoney
      agg.freeMoney = Math.max(0, s.freeMoney)
      agg.overMoney = Math.max(0, -s.freeMoney)
      agg.counts[s.status]++
      if (s.changed) agg.changed++
      sums.set(r.id, agg)
      continue
    }
    const agg = empty()
    for (const c of ch) {
      const s = sums.get(c)
      if (s) add(agg, s)
    }
    sums.set(r.id, agg)
  }
  const total = empty()
  for (const id of tree.roots) {
    const s = sums.get(id)
    if (s) add(total, s)
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

// ── Поиск и отбор ───────────────────────────────────────────────────────────
const fold = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е')
export const searchTokens = (q) => fold(q).split(/\s+/).map((t) => t.trim()).filter(Boolean)

// Поиск — по коду, наименованию, примечаниям, тендерам и подрядчикам (отдельных фильтров по ним нет).
export function rowHaystack(row, mark, allocations) {
  const parts = [row.code, row.pos_no, row.name, row.unit, row.customer_note, row.gp_note, row.pz?.note, row.pz?.code]
  if (mark) parts.push(mark.note, mark.actual_reason)
  for (const a of allocations || []) parts.push(a.tender_label, a.counterparty_name, a.note)
  return fold(parts.filter(Boolean).join(' \u0001 '))
}

// «Показать»: один выбор вместо панели фильтров и плиток-счётчиков.
export const SHOW_OPTIONS = [
  { key: 'all', label: 'Все строки' },
  { key: 'none', label: 'Не распределено', count: (t) => t.counts.none },
  { key: 'partial', label: 'Частично', count: (t) => t.counts.partial },
  { key: 'full', label: 'Распределено', count: (t) => t.counts.full },
  { key: 'over', label: 'Превышение', count: (t) => t.counts.over },
  { key: 'changed', label: 'Объём изменён', count: (t) => t.changed },
  { key: 'note', label: 'С примечанием', count: (t) => t.notes },
  { key: 'fill', label: 'С заливкой', count: (t) => t.fills },
]
export const showActive = (show) => !!show && show !== 'all'

// Подходит ли строка под «Показать». Состояния — только у позиций; примечание и заливка — у любой строки.
export function rowMatchesShow(row, mark, state, show) {
  if (!showActive(show)) return true
  if (show === 'note') return !!mark?.note
  if (show === 'fill') return !!(mark?.fill || (mark?.cell_fills && Object.keys(mark.cell_fills).length))
  if (!isPosition(row) || !state) return false
  if (show === 'changed') return state.changed
  return state.status === show
}

// Какие строки показать. match — Set id, подошедших под поиск / «Показать» (null — без отбора): показываются они и
// их предки, свёрнутость тогда не действует. collapsed — Set свёрнутых id.
export function visibleRowIds(tree, { match = null, collapsed = null } = {}) {
  let keep = null
  if (match) {
    keep = new Set()
    for (const id of match) {
      keep.add(id)
      for (const a of ancestorsOf(tree, id)) keep.add(a)
    }
  }
  const out = []
  const hidden = new Set()
  for (const r of tree.rows) {
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

// Отметка → поля записи (только допустимые, нормализованные). Ответственного с 13.11 нет — его поля не пишутся.
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
  return out
}

// Распределить свободный остаток выбранных позиций: тендер (может не быть) и подрядчик. Позиция без остатка
// пропускается; у позиции уже есть эта пара — её объём растёт на остаток (вторая строка той же пары — отказ базы).
export function planTenderAllocation({ rowIds, tree, states, allocsByRow, target }) {
  const key = pairKey(target)
  const inserts = []
  const updates = []
  const skipped = []
  for (const id of rowIds) {
    const row = tree.byId.get(id)
    if (!isPosition(row)) continue
    const s = states.get(id)
    if (!s || s.free <= eps(s.actual)) { skipped.push(id); continue }
    const existing = (allocsByRow.get(id) || []).find((a) => pairKey(a) === key)
    if (existing) {
      updates.push({ id: existing.id, row_id: id, row_version: existing.row_version, pz_qty: round6(allocQty(existing) + s.free) })
    } else {
      inserts.push({
        row_id: id, tender_id: target.tender_id || null, tender_label: target.tender_label || null,
        counterparty_id: target.counterparty_id || null, counterparty_name: target.counterparty_name || null, pz_qty: round6(s.free),
      })
    }
  }
  return { inserts, updates, skipped }
}

// Победители тендера из справочника (tender_winners → контрагенты): первым — единственный победитель.
export function tenderWinners(pickers, tenderId) {
  if (!tenderId || !pickers) return []
  const ids = new Set((pickers.winners || []).filter((w) => w.tender_id === tenderId).map((w) => w.counterparty_id))
  return (pickers.counterparties || []).filter((c) => ids.has(c.id))
}
export const tenderLabel = (t) => `№ ${t?.public_tender_number ?? '—'}`
export const tenderOptionLabel = (t) => `${tenderLabel(t)}${t?.work_description ? ` — ${String(t.work_description).slice(0, 90)}` : ''}`
