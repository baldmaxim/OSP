// Строки документа поставщика (счёт, КП, УПД) → позиции ВОР расценки снабжением. Только решения, без запросов.
//
// Позиции всех ВОР тендера складываются в группы одинаковых — то же наименование (ключ normName) и те же ед. изм.:
// одна цена из документа ставится всем позициям группы (как подстановка в одинаковые позиции при вводе руками).
// Строка документа сопоставляется сначала точно (тот же ключ наименования — с артикулом или без), затем по
// похожести (utils/supplySimilarity: тот же расчёт, что у «похожих цен» в базе, порог ниже — каждое сопоставление
// видит человек). Одна группа — одной строке документа: сначала точные, затем с той же ед. изм., затем самые похожие.
import { normName } from './supplyRateHelpers.js'
import { MATCH_MIN, MATCH_WORDS_MIN, nameParts, scoreParts, unitsCompatible } from './supplySimilarity.js'
import { unitSignature } from './supplyAutoImport.js'

export const MATCH_CANDIDATES = 5

// docViews — [{ name, positions }] (позиции списков ВОР). Ответ — группы { key, k, name, unit, units, parts, targets }.
export function positionGroups(docViews) {
  const map = new Map()
  for (const d of docViews || []) {
    for (const p of d.positions || []) {
      if (!p.k) continue
      const key = `${p.k}|${unitSignature(p)}`
      let g = map.get(key)
      if (!g) {
        g = { key, k: p.k, name: p.name, unit: p.units ? null : (p.unit || null), units: p.units ? p.units.map((u) => u.unit) : null, parts: nameParts(p.name), targets: [] }
        map.set(key, g)
      }
      g.targets.push({ doc: d.name, position: p })
    }
  }
  return [...map.values()]
}

// Ед. изм. строки документа подходит позиции: та же (шт. = штук, м = м.п.), не указана — подходит.
export const groupUnitOk = (unit, g) => (g.units ? g.units.some((u) => unitsCompatible(unit, u)) : unitsCompatible(unit, g.unit))

// Поиск кандидатов — по первым четырём буквам основ слов (как GIN по name_heads в базе), дальше — точный расчёт.
function headIndex(groups) {
  const index = new Map()
  for (const g of groups) {
    for (const w of g.parts.words) {
      const h = w.slice(0, 4)
      if (!index.has(h)) index.set(h, new Set())
      index.get(h).add(g)
    }
  }
  return index
}

const byRank = (a, b) => (b.exact - a.exact) || (b.unitOk - a.unitOk) || (b.score - a.score)

// Кандидаты одной строки документа: [{ group, score, exact, unitOk, sameNums }] — лучшие первыми.
export function itemCandidates(item, groups, { byKey, index } = {}, limit = MATCH_CANDIDATES) {
  const keys = byKey || groupsByKey(groups)
  const heads = index || headIndex(groups)
  const names = [item.name, item.code ? `${item.name} ${item.code}` : null].filter(Boolean)
  const out = new Map()
  for (const n of names) {
    for (const g of keys.get(normName(n)) || []) out.set(g.key, { group: g, score: 1, exact: true, sameNums: true })
  }
  const parts = names.map(nameParts)
  const pool = new Set()
  for (const p of parts) for (const w of p.words) for (const g of heads.get(w.slice(0, 4)) || []) pool.add(g)
  for (const g of pool) {
    if (out.has(g.key)) continue
    let best = null
    for (const p of parts) {
      const r = scoreParts(p, g.parts)
      if (!best || r.score > best.score) best = r
    }
    if (best.words >= MATCH_WORDS_MIN && best.score >= MATCH_MIN) out.set(g.key, { group: g, score: best.score, exact: false, sameNums: best.sameNums })
  }
  return [...out.values()].map((c) => ({ ...c, unitOk: groupUnitOk(item.unit, c.group) })).sort(byRank).slice(0, limit)
}

function groupsByKey(groups) {
  const out = new Map()
  for (const g of groups) {
    if (!out.has(g.k)) out.set(g.k, [])
    out.get(g.k).push(g)
  }
  return out
}

// Все строки документа: { item, match, candidates }. match — выбранная группа (или null), одна группа — одной строке.
export function matchDocItems(items, groups) {
  const ctx = { byKey: groupsByKey(groups), index: headIndex(groups) }
  const candidates = items.map((item) => itemCandidates(item, groups, ctx))
  const pairs = []
  candidates.forEach((list, i) => list.forEach((c) => pairs.push({ i, c })))
  pairs.sort((a, b) => byRank(a.c, b.c) || a.i - b.i)
  const chosen = new Array(items.length).fill(null)
  const used = new Set()
  for (const { i, c } of pairs) {
    if (chosen[i] || used.has(c.group.key)) continue
    chosen[i] = c
    used.add(c.group.key)
  }
  return items.map((item, i) => ({ item, match: chosen[i], candidates: candidates[i] }))
}

// Поиск позиции вручную (строка не сопоставилась или сопоставилась не с той): сколько слов запроса входят в
// наименование (как поиск в таблице), при равенстве — похожесть; лучшие первыми.
const searchText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')
export function searchGroups(query, groups, limit = 20) {
  const q = searchText(query).trim()
  if (!q) return []
  const words = q.split(/\s+/).filter(Boolean)
  const parts = nameParts(q)
  return groups.map((g) => {
    const name = searchText(g.name)
    const hits = words.filter((w) => name.includes(w)).length + (name.includes(q) ? 1 : 0)
    return { group: g, hits, score: scoreParts(parts, g.parts).score }
  }).filter((x) => x.hits > 0 || x.score > 0)
    .sort((a, b) => b.hits - a.hits || b.score - a.score)
    .slice(0, limit).map((x) => x.group)
}

// Доставка в документе (строки «Доставка», «Транспортные услуги»): её доля к цене каждой позиции — пропорционально
// сумме. goodsTotal — сумма всех строк документа, кроме доставки; ответ — множитель цены (1 — доставки нет).
export function deliveryFactor(items, priceOf) {
  let delivery = 0
  let goods = 0
  for (const it of items) {
    const p = priceOf(it)
    if (p == null) continue
    const total = it.qty > 0 ? p * it.qty : p
    if (it.delivery) delivery += total
    else goods += total
  }
  return { delivery, goods, factor: goods > 0 && delivery > 0 ? 1 + delivery / goods : 1 }
}
