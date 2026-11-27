// Документ цен сметы КП / ПЗ (окно «Цены по документу», миграция 20270308): файл в раскладке сметы (К14, «Лот 31», «Алия»,
// «King & Sons», «Событие 6.2» — с выбором этапа ДГП / ДС) или любой счёт, КП, ПСДЦ, ВОР (общий разбор цен, utils/bidImport).
// Строки сопоставляются с позициями сметы по ступеням: тот же ключ строки (номер позиции + наименование, раскладка сметы) →
// тот же код раздела → наименование тем же расчётом похожести, что строки счёта с позициями ВОР в тендерах на материалы
// (utils/supplyDocMatch: слова и числа с раскрытыми сокращениями, текст целиком, ступени same / close / refine / near / far).
// Сама ставится только уверенная пара: одинаковые наименования у нескольких позиций сметы («Демонтаж бытового городка
// (модуля)» × 8) и другая ед. изм. — только человеком. Одна позиция — одной строке документа. Модуль чистый —
// tests/tender/kp-estimate.test.mjs; действующие цены — utils/kpEstimatePrices.js.
import { isPosition, originalQty, round2, unitPrice } from './kpEstimate.js'
import { buildEstimateRows, nameKey } from './kpEstimateImport.js'
import { MONEY_EPS, changePct } from './kpEstimatePrices.js'
import { normName } from './supplyRateHelpers.js'
import { canonUnit, nameParts } from './supplySimilarity.js'
import { AUTO_MIN, itemCandidates, matchIndex, matchIndexInSlices, searchGroups } from './supplyDocMatch.js'
import { unitPriceWithVat } from './supplierDoc.js'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// ── Строки документа ────────────────────────────────────────────────────────────────────────────────
// Строка: { i, key, code, pos, name, unit, qty, unitPrice, unitMaterials, unitWorks, total, sheetRow, group }. unitPrice —
// за единицу с НДС, total — сумма строки; group — строка документа со вложенными (её сумма — сумма состава; в смету идут
// строки без вложенных).

// Документ в раскладке сметы (parseKpWorkbook): строки без вложенных. stage — номер этапа файла (ДГП, ДС …) или null —
// «КП до перекидок». Кол-во этапа в файле не указано — то же «Кол-во (ГП)» строки.
export function estimateDocLines(parsed, stage = null) {
  const built = buildEstimateRows({ kp: parsed })
  if (built.error) return []
  const parents = new Set(built.rows.map((r) => r.parent_row_no).filter(Boolean))
  const out = []
  for (const r of built.rows) {
    if (parents.has(r.row_no) || r.kind === 'title' || r.kind === 'note' || !r.kp) continue
    const item = parsed.items[r.row_no - 1]
    const src = stage === null || stage === undefined ? r.kp : item?.stages?.[stage]
    if (!src) continue
    const total = num(src.total) ?? (num(src.materials) === null && num(src.works) === null ? null : (num(src.materials) || 0) + (num(src.works) || 0))
    const qty = num(r.kp.qty_gp)
    out.push({
      i: out.length, key: r.row_key, code: r.code || '', pos: r.pos_no || '', name: r.name, unit: r.unit || '', qty,
      unitPrice: qty ? (total ?? 0) / qty : null,
      unitMaterials: qty && num(src.materials) !== null ? num(src.materials) / qty : null,
      unitWorks: qty && num(src.works) !== null ? num(src.works) / qty : null,
      total, sheetRow: r.kp.sheet_row ?? null,
    })
  }
  return out
}

// Любой документ с ценами (счёт, КП, ПСДЦ, ВОР: utils/bidImport → readBidPriceDoc) — цена с НДС, как у сметы (КП — с НДС).
// Строки без цены и доставка не идут.
export function genericDocLines(items, vat = null) {
  const out = []
  for (const it of items || []) {
    if (!it || it.delivery || !String(it.name || '').trim()) continue
    const qty = num(it.qty)
    const part = (p) => (p && (p.price != null || p.sum != null) ? unitPriceWithVat({ ...it, price: p.price, priceVat: p.priceVat, sum: p.sum, sumVat: p.sumVat }, vat) : null)
    const m = part(it.parts?.material)
    const w = part(it.parts?.work)
    const unit = m !== null || w !== null ? (m || 0) + (w || 0) : unitPriceWithVat(it, vat)
    if (unit === null || !Number.isFinite(unit)) continue
    out.push({
      i: out.length, key: null, code: String(it.code || ''), pos: '', name: String(it.name).trim(), unit: it.unit || '', qty,
      unitPrice: unit, unitMaterials: m, unitWorks: w, total: qty ? unit * qty : null, sheetRow: it.row ?? null,
    })
  }
  return out
}

// ── Сопоставление ───────────────────────────────────────────────────────────────────────────────────
// Позиции сметы → группы для поиска (как bidGroups): одна строка — одна группа; объём — «Кол-во (ГП)» (количество строки
// документа, совпавшее с ним, чуть поднимает похожесть).
export function estimateGroups(tree) {
  return tree.rows.filter((r) => r.kind !== 'title' && r.kind !== 'note' && String(r.name || '').trim()).map((r) => ({
    key: r.id, k: normName(r.name), name: r.name, unit: r.unit || null, units: null, parts: nameParts(r.name),
    targets: originalQty(r) > 0 ? [{ position: { volume: originalQty(r) } }] : [], row: r,
  }))
}

const codeKey = (c) => String(c ?? '').trim().replace(/\.+$/, '').toLowerCase()
// Числа наименований (размеры, толщины, марки бетона) — те же: множества чисел совпадают (числа есть хотя бы у одного).
const numsOf = (name) => (nameParts(String(name ?? '')).nums || []).map(String).sort()
function sameNumbers(a, b) {
  const x = numsOf(a)
  const y = numsOf(b)
  if (!x.length && !y.length) return true
  return x.length === y.length && x.every((v, i) => v === y[i])
}
const VIA_RANK = { key: 3, code: 2, name: 1, manual: 4 }
const unitsDiffer = (a, b) => !!a && !!b && canonUnit(a) !== canonUnit(b)
export const CANDIDATES_SHOWN = 8

// Указатель сметы: группы, поиск по ключу строки, коду и наименованию. pause — порциями (окно не замирает).
export async function priceMatchIndex(tree, { pause = null, alive = () => true } = {}) {
  const groups = estimateGroups(tree)
  const ix = pause ? await matchIndexInSlices(groups, { pause, alive }) : matchIndex(groups)
  if (!ix) return null
  const byId = new Map(groups.map((g) => [g.key, g]))
  const byRowKey = new Map()
  const byCode = new Map()
  const nameCount = new Map()
  for (const g of groups) {
    byRowKey.set(g.row.row_key, g)
    const ck = codeKey(g.row.code)
    if (ck) { if (!byCode.has(ck)) byCode.set(ck, []); byCode.get(ck).push(g) }
    nameCount.set(g.k, (nameCount.get(g.k) || 0) + 1)
  }
  return { groups, ix, byId, byRowKey, byCode, nameCount }
}

// Кандидаты строки документа: [{ group, score, via, grade, exact, unitOk, dup }], лучшие первыми; auto — пара, которая
// ставится сама (или null).
export function lineCandidates(line, index) {
  const { groups, ix, byRowKey, byCode, nameCount } = index
  const out = new Map()
  const put = (c) => {
    const was = out.get(c.group.key)
    if (!was || VIA_RANK[c.via] > VIA_RANK[was.via] || (c.via === was.via && c.score > was.score)) out.set(c.group.key, c)
  }
  const unitOk = (g) => !unitsDiffer(line.unit, g.unit)
  const dup = (g) => (nameCount.get(g.k) || 0) > 1
  const keyHit = line.key ? byRowKey.get(line.key) : null
  // Тот же ключ строки или единственная позиция с тем же кодом и наименованием — та же позиция: похожесть не ищется (документ
  // в раскладке сметы — тысячи строк, так окно отвечает сразу).
  const lineName = nameKey(line.name)
  const sameCode = (byCode.get(codeKey(line.code)) || []).filter((g) => nameKey(g.name) === lineName)
  const sure = keyHit || (sameCode.length === 1 ? sameCode[0] : null)
  if (sure && unitOk(sure)) {
    const c = { group: sure, score: 1, via: keyHit ? 'key' : 'code', grade: 'same', exact: true, unitOk: true, dup: false }
    return { list: [c], auto: c }
  }
  if (keyHit) put({ group: keyHit, score: 1, via: 'key', grade: 'same', exact: true, unitOk: unitOk(keyHit), dup: false })
  const named = itemCandidates({ name: line.name, unit: line.unit || null, qty: line.qty || null }, groups, ix, 12, { graded: true })
  const byName = new Map(named.map((c) => [c.group.key, c]))
  for (const g of byCode.get(codeKey(line.code)) || []) {
    const c = byName.get(g.key)
    const same = nameKey(g.name) === lineName
    put({ group: g, score: same ? 1 : (c?.score ?? 0), via: 'code', grade: same ? 'same' : (c?.grade ?? 'far'), exact: same, unitOk: unitOk(g), dup: dup(g) })
  }
  for (const c of named) {
    put({ group: c.group, score: c.score, via: 'name', grade: c.grade || 'far', exact: !!c.exact, unitOk: unitOk(c.group), dup: dup(c.group), nums: sameNumbers(line.name, c.group.name) })
  }
  const list = [...out.values()].sort((a, b) => VIA_RANK[b.via] - VIA_RANK[a.via] || b.score - a.score)
  return { list: list.slice(0, CANDIDATES_SHOWN), auto: autoPick(list) }
}

// Что ставится само: тот же ключ строки; тот же код (один с таким кодом — от похожести 0,3, несколько — то же наименование
// у одного); наименование — от AUTO_MIN без соперника ближе 0,05, не одинаковое у нескольких позиций сметы, не «отдалённо» и с
// теми же числами (размер, толщина, сечение: «Плита … толщ. 250 мм» — не «… 200 мм», для цены это другая позиция). Везде — та
// же ед. изм.
function autoPick(list) {
  const key = list.find((c) => c.via === 'key')
  if (key) return key.unitOk ? key : null
  const code = list.filter((c) => c.via === 'code')
  if (code.length) {
    const same = code.filter((c) => c.exact)
    if (same.length === 1 && same[0].unitOk) return same[0]
    if (code.length === 1 && code[0].score >= 0.3 && code[0].unitOk && !code[0].dup) return code[0]
  }
  const named = list.filter((c) => c.via === 'name' || c.via === 'code')
  const best = named[0]
  if (!best || !best.unitOk || best.dup || !(best.exact || best.score >= AUTO_MIN)) return null
  if (!best.exact && (best.grade === 'far' || best.nums === false)) return null
  const rival = named.find((c) => c !== best && best.score - c.score <= 0.05)
  return rival && !best.exact ? null : best
}

// Все строки документа: { line, cands, auto, match } — одна позиция одной строке (сначала ключ, затем код, затем самые
// похожие). pause — порциями; onProgress(done, total).
export async function matchPriceLines(lines, index, { pause = null, alive = () => true, onProgress = null, sliceMs = 40 } = {}) {
  const found = []
  let at = Date.now()
  for (let i = 0; i < lines.length; i++) {
    found.push(lineCandidates(lines[i], index))
    if (pause && Date.now() - at > sliceMs) {
      onProgress?.(i + 1, lines.length)
      await pause()
      if (!alive()) return null
      at = Date.now()
    }
  }
  const pairs = []
  found.forEach((f, i) => { if (f.auto) pairs.push({ i, c: f.auto }) })
  pairs.sort((a, b) => VIA_RANK[b.c.via] - VIA_RANK[a.c.via] || b.c.score - a.c.score || a.i - b.i)
  const used = new Set()
  const match = new Array(lines.length).fill(null)
  for (const { i, c } of pairs) {
    if (used.has(c.group.key)) continue
    used.add(c.group.key)
    match[i] = c
  }
  onProgress?.(lines.length, lines.length)
  return lines.map((line, i) => ({ line, cands: found[i].list, auto: found[i].auto, match: match[i] }))
}

// Поиск позиции сметы вручную (строка не нашлась или нашлась не та).
export const searchEstimate = (query, index, limit = 20) => searchGroups(query, index.groups, limit)

// ── Что запишется ───────────────────────────────────────────────────────────────────────────────────
// matched — matchPriceLines; picks — Map номер строки → группа (выбор человека; null — «не применять»); effective —
// effectivePrices; states — computeStates().states (актуальный объём). withVolumes — объём документа в «Актуальный».
// Ответ: строки предпросмотра { i, line, group, row, isGroup, before, after, pct, changed, volume, item } и items для
// kp_estimate_price_apply (только изменившиеся).
export function planPriceChanges(matched, { tree, effective, states = null, marks = null, picks = null, withVolumes = false, docTitle = '' } = {}) {
  const lines = []
  const items = []
  const seen = new Set()
  for (const m of matched || []) {
    const i = m.line.i
    const group = picks?.has(i) ? picks.get(i) : (m.match?.group || null)
    if (!group || seen.has(group.key)) { lines.push({ i, line: m.line, group: null }); continue }
    seen.add(group.key)
    const row = group.row
    const isGroup = tree.children.has(row.id)
    const eff = effective?.get(row.id)
    let before
    let after
    const item = { row_id: row.id, doc_qty: m.line.qty ?? null }
    if (isGroup) {
      before = eff ? eff.total : rowSum(tree, row.id)
      after = m.line.total ?? (m.line.unitPrice !== null && (m.line.qty ?? originalQty(row)) ? m.line.unitPrice * (m.line.qty ?? originalQty(row)) : null)
      if (after !== null) item.total = round2(after)
    } else if (isPosition(row) && !originalQty(row)) {
      // Позиция без «Кол-ва (ГП)»: цены за единицу нет — новая сумма строки документа.
      before = eff ? eff.total : (num(row.kp?.total) ?? num(row.pz?.comm_total))
      after = m.line.total ?? null
      if (after !== null) item.total = round2(after)
    } else if (isPosition(row)) {
      before = eff?.unit ?? unitPrice(row)
      after = m.line.unitPrice
      if (after !== null) {
        item.unit_price = roundPrice(after)
        if (m.line.unitMaterials !== null && m.line.unitWorks !== null && m.line.unitMaterials !== undefined && m.line.unitWorks !== undefined) {
          item.unit_materials = roundPrice(m.line.unitMaterials)
          item.unit_works = roundPrice(m.line.unitWorks)
        }
      }
    } else {
      after = null
    }
    const changed = after !== null && (before === null || before === undefined || Math.abs(after - before) > MONEY_EPS)
    // Объём документа → «Актуальный», где отличается от действующего (актуального или «Кол-ва (ГП)»).
    let volume = null
    if (withVolumes && m.line.qty !== null && m.line.qty !== undefined && row.unit && (row.kind === 'position' || row.kind === 'aggregate' || row.kind === 'adjust')) {
      const actual = states?.get(row.id)?.actual ?? (marks?.get(row.id)?.actual_qty ?? originalQty(row))
      if (Math.abs(Number(actual) - m.line.qty) > 1e-9 * Math.max(1, Math.abs(m.line.qty))) volume = { from: Number(actual), to: m.line.qty }
    }
    if (volume) {
      item.actual_qty = volume.to
      item.actual_reason = `По документу «${String(docTitle).slice(0, 200)}»`
    }
    lines.push({ i, line: m.line, group, row, isGroup, before: before ?? null, after, pct: changePct(after, before), changed, volume })
    if ((changed && (item.unit_price !== undefined || item.total !== undefined)) || volume) items.push(item)
  }
  return { lines, items }
}
const roundPrice = (v) => Math.round(v * 1e6) / 1e6
function rowSum(tree, id) {
  let s = 0
  const stack = [...(tree.children.get(id) || [])]
  while (stack.length) {
    const cur = stack.pop()
    const ch = tree.children.get(cur)
    if (ch) stack.push(...ch)
    else s += num(tree.byId.get(cur)?.kp?.total) || 0
  }
  return s
}

// Итог по смете до и после (по «Кол-ву (ГП)»): сумма строк верхнего уровня; без изменений — из файла.
const baseOf = (tree, id) => (tree.children.has(id) ? rowSum(tree, id) : num(tree.byId.get(id)?.kp?.total) || 0)
export function estimateTotals(tree, before, after) {
  let a = 0
  let b = 0
  for (const id of tree.roots) {
    const base = baseOf(tree, id)
    b += before?.get(id)?.total ?? base
    a += after?.get(id)?.total ?? base
  }
  return { before: b, after: a }
}

// Цены после применения (для предпросмотра итога): действующие записи + новые.
export function pricesAfter(prices, items) {
  const next = new Map(prices || [])
  for (const it of items || []) {
    if (it.unit_price === undefined && it.total === undefined) continue
    next.set(it.row_id, { ...(next.get(it.row_id) || {}), unit_price: it.unit_price ?? null, unit_materials: it.unit_materials ?? null, unit_works: it.unit_works ?? null, total: it.total ?? null })
  }
  return next
}
