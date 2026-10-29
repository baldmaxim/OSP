// Строки документа поставщика (счёт, КП, УПД) → позиции ВОР расценки снабжением. Только решения, без запросов.
//
// Позиции всех ВОР тендера складываются в группы одинаковых — то же наименование (ключ normName) и те же ед. изм.:
// одна цена из документа ставится всем позициям группы (как подстановка в одинаковые позиции при вводе руками).
// Строка документа сопоставляется сначала точно (тот же ключ наименования — с артикулом или без), затем по
// похожести. Похожесть документа — своя, только в браузере (каждое сопоставление видит человек), из трёх признаков:
//  • слова и числа — тот же расчёт, что у «похожих цен» в базе (utils/supplySimilarity), поверх раскрытых сокращений
//    («ВГП» — водогазопроводная, «2-лапковая» — двухлапковая, «DN» — Ду);
//  • текст целиком — доля общих сочетаний из трёх букв (как pg_trgm): ловит другой порядок слов, слитное написание
//    («гофротруба»), опечатки и разницу в длине наименования, где отдельные слова не совпали;
//  • артикул — код, который в тендере есть только у одной позиции (91920, 51020R, 221-413, РЗ-ЦХ-10): совпал —
//    почти наверняка та же позиция, даже если поставщик назвал её по-своему («Клемма WAGO 221-413 3-проводная»).
// Разные числа (размер, сечение, диаметр) у обоих — уже другой материал: такая пара в список попадает, но сама не
// выбирается. Одна группа — одной строке документа: сначала точные, затем самые похожие (другая ед. изм. — чуть ниже).
import { normName } from './supplyRateHelpers.js'
import { nameParts, prepareName, scoreParts, unitsCompatible } from './supplySimilarity.js'
import { unitSignature } from './supplyAutoImport.js'

// Сколько кандидатов у строки документа (в окне видно первые несколько, остальные — «ещё»).
export const MATCH_CANDIDATES = 12
// Сопоставляется сама — не ниже этого; в списке выбора — не ниже LIST_MIN.
export const AUTO_MIN = 0.6
export const LIST_MIN = 0.3
// Другая ед. изм. — кандидат чуть ниже: штуки и упаковки поставщики пишут как попало, но при равной похожести
// позиция с той же ед. изм. вернее.
const UNIT_PENALTY = 0.08

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

// ── Признаки наименования ───────────────────────────────────────────────────────────────────────────
// Сокращения и другие записи того же — раскрываются до сравнения (только здесь: в базе их нет).
const NUMERAL = { 1: 'одно', 2: 'двух', 3: 'трех', 4: 'четырех', 5: 'пяти' }
const EXPAND = [
  // «2-лапковая», «3-х проводная», «4-жильный» → «двухлапковая», «трехпроводная», «четырехжильный» (только через
  // дефис: «5 штук» — не числительное)
  [/(^|[\s,;(«"])([1-5])-(?:х ?-? ?)?(?=[а-яё]{3})/gi, (_, pre, n) => `${pre}${NUMERAL[n]}`],
  [/(^|[^a-zа-яё])вгп(?![a-zа-яё])/gi, '$1водогазопроводная'],
  [/(^|[^a-zа-яё])гофротруб/gi, '$1труба гофрированная '],
  [/(^|[^a-zа-яё])гофра(?![a-zа-яё])/gi, '$1труба гофрированная'],
  [/(^|[^a-zа-яё])(?:с )?зонд[а-яё]*/gi, '$1с протяжкой'],
  [/(^|[^a-zа-яё])dn(?= ?[0-9])/gi, '$1ду '],
  [/(^|[^a-zа-яё])стяжк/gi, '$1хомут стяжк'],
  [/(^|[^a-zа-яё])рукав металлическ/gi, '$1металлорукав '],
]
export const expandName = (name) => EXPAND.reduce((s, [re, to]) => s.replace(re, to), String(name ?? ''))

// Сочетания из трёх букв по словам (как pg_trgm: слово с двумя пробелами впереди и одним сзади). Кириллические
// двойники латиницы — латиницей (СК-712 = CK-712, «Р» = «P»).
const TRI_LATIN = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' }
function trigrams(name) {
  const out = new Set()
  for (const w of prepareName(name).split(/[^a-zа-я0-9]+/)) {
    if (!w) continue
    const p = `  ${w.replace(/[авекмнорстух]/g, (c) => TRI_LATIN[c])} `
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3))
  }
  return out
}
const dice = (shared, a, b) => (a + b ? (2 * shared) / (a + b) : 0)

// Артикулы и коды наименования: от 4 цифр (91920, 2785193, 221-413) или буквы с цифрами от 4 знаков (51020R,
// CMAT11-10-100, SK-712/d-2-1,5, РЗ-ЦХ-10, У-136). Не коды: размеры и диапазоны с единицей (2х2х0,75, d20мм,
// 0,2-4мм2), ГОСТ / ТУ, слова с цифрой («3-проводная» — в коде нет слов длиннее пяти букв). Разделители внутри кода
// не важны: «221-413» = «221413».
const UNIT_TAIL = '(?:мм2|мм|см|м2|м3|м|mm|кг|г|л|мл|шт|вт|квт|ква|в|а|ч|бар|атм)'
const SIZE_RE = new RegExp(`^(?:[a-zа-я]{1,2}=?)?[0-9]+(?:\\.[0-9]+)?${UNIT_TAIL}?$`)
const UNIT_END_RE = new RegExp(`[0-9]${UNIT_TAIL}$`)
const WORD_IN_CODE_RE = /[a-zа-я]{6,}/
export function codeTokens(...texts) {
  const out = new Set()
  const s = texts.filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е')
    .replace(/(^|[^a-zа-я])(гост|ту|сто|снип|сп|din|iso|en) ?(р ?)?[0-9][0-9.–—/-]*/g, '$1 ')
    .replace(/([0-9]),(?=[0-9])/g, '$1.')
    .replace(/([0-9]) ?[xх×*] ?(?=[0-9])/g, '$1 ')
  for (let raw of s.split(/[\s,;:()«»"'+№#]+/)) {
    raw = raw.replace(/^[a-zа-я]{1,4}[.=]+/, '').replace(/^[-./=]+|[-./=]+$/g, '')
    if (!/[0-9]/.test(raw) || WORD_IN_CODE_RE.test(raw)) continue
    if ((SIZE_RE.test(raw) || UNIT_END_RE.test(raw)) && !/^[0-9]{4,}$/.test(raw)) continue
    const t = raw.replace(/[-./=]/g, '')
    const digits = t.replace(/[^0-9]/g, '').length
    if (/^[0-9]+$/.test(t) ? digits >= 4 : t.length >= 4 && /[a-zа-я]/.test(t)) out.add(t)
  }
  return out
}

// Признаки группы считаются один раз (группы снабжения и кабинета подрядчика устроены одинаково, свои поля
// не нужны).
const FEATURES = new WeakMap()
function features(g) {
  let f = FEATURES.get(g)
  if (!f) {
    const name = expandName(g.name)
    f = { parts: nameParts(name), tri: trigrams(name), codes: codeTokens(g.name) }
    FEATURES.set(g, f)
  }
  return f
}
function itemFeatures(item) {
  const names = [item.name, item.code ? `${item.name} ${item.code}` : null].filter(Boolean)
  const name = expandName(item.name)
  return { names, parts: [nameParts(name), ...(item.code ? [nameParts(`${name} ${item.code}`)] : [])], tri: trigrams(name), codes: codeTokens(item.name, item.code) }
}

// Похожесть строки документа и группы: { score, words, text, code, sameNums, apart }. score — 0…1 (1 — только
// точное совпадение наименования, его считает вызывающий); apart — числа у обоих разные (размер, сечение).
export function pairScore(a, g, shared = null) {
  const b = features(g)
  let base = null
  for (const p of a.parts) {
    const r = scoreParts(p, b.parts)
    if (!base || r.score > base.score) base = r
  }
  let common = shared
  if (common == null) {
    common = 0
    for (const t of a.tri) if (b.tri.has(t)) common += 1
  }
  const text = dice(common, a.tri.size, b.tri.size)
  const code = a.code ?? false
  let score = Math.max(base.score, 0.5 * base.score + 0.5 * text)
  // Числа есть у обоих, а общих нет (сечение, диаметр), или размеры «AxB» у обоих, а общего нет, — другой
  // материал, как бы ни был похож текст: в список, но не сам.
  const na = a.parts[0].nums
  const nb = b.parts.nums
  const apart = (x, y) => x.length > 0 && y.length > 0 && !x.some((t) => y.includes(t))
  const isSize = (t) => t.includes('×')
  const numsApart = apart(na, nb) || apart(na.filter(isSize), nb.filter(isSize))
  if (code) score = Math.max(score, 0.8 + 0.15 * Math.max(base.score, text))
  else if (numsApart) score = Math.min(score, 0.5)
  return { score: Math.min(0.99, Math.round(score * 1000) / 1000), words: base.words, text: Math.round(text * 1000) / 1000, code, sameNums: base.sameNums, apart: !code && numsApart }
}

// Указатели по группам: ключ наименования, первые буквы основ слов, сочетания букв, артикулы (только те, что в
// тендере у одной позиции: «RS485» или «IP55» у нескольких — признак, а не артикул).
export function matchIndex(groups) {
  const byKey = new Map()
  const heads = new Map()
  const tri = new Map()
  const codeKeys = new Map()
  const add = (map, k, g) => { let s = map.get(k); if (!s) { s = []; map.set(k, s) } s.push(g) }
  for (const g of groups) {
    add(byKey, g.k, g)
    const f = features(g)
    const seen = new Set()
    for (const w of f.parts.words) { const h = w.slice(0, 4); if (!seen.has(h)) { seen.add(h); add(heads, h, g) } }
    for (const t of f.tri) add(tri, t, g)
    for (const c of f.codes) { let s = codeKeys.get(c); if (!s) { s = new Map(); codeKeys.set(c, s) } add(s, g.k, g) }
  }
  const codes = new Map()
  for (const [c, byK] of codeKeys) if (byK.size === 1) codes.set(c, [...byK.values()][0])
  return { byKey, heads, tri, codes }
}

const rankOf = (c) => (c.exact ? 2 : c.score) - (c.unitOk ? 0 : UNIT_PENALTY)
const byRank = (a, b) => rankOf(b) - rankOf(a)

// Кандидаты одной строки документа: [{ group, score, exact, unitOk, code, sameNums }] — лучшие первыми, не ниже
// LIST_MIN.
export function itemCandidates(item, groups, index = null, limit = MATCH_CANDIDATES) {
  const ix = index || matchIndex(groups)
  const a = itemFeatures(item)
  const out = new Map()
  for (const n of a.names) {
    for (const g of ix.byKey.get(normName(n)) || []) out.set(g.key, { group: g, score: 1, exact: true, code: false, sameNums: true })
  }
  // Кандидаты — общие сочетания букв (сразу и их число), начала слов и артикулы.
  const shared = new Map()
  for (const t of a.tri) for (const g of ix.tri.get(t) || []) shared.set(g, (shared.get(g) || 0) + 1)
  const pool = new Set()
  for (const [g, n] of shared) if (dice(n, a.tri.size, features(g).tri.size) >= LIST_MIN) pool.add(g)
  for (const p of a.parts) for (const w of p.words) for (const g of ix.heads.get(w.slice(0, 4)) || []) pool.add(g)
  const byCode = new Set()
  for (const c of a.codes) for (const g of ix.codes.get(c) || []) { byCode.add(g); pool.add(g) }
  for (const g of pool) {
    if (out.has(g.key)) continue
    const r = pairScore({ ...a, code: byCode.has(g) }, g, shared.get(g) || 0)
    if (r.score >= LIST_MIN) out.set(g.key, { group: g, ...r, exact: false })
  }
  return [...out.values()].map((c) => ({ ...c, unitOk: groupUnitOk(item.unit, c.group) })).sort(byRank).slice(0, limit)
}

// Сопоставляется сама: точно или не ниже AUTO_MIN.
export const autoMatch = (c) => !!c && (c.exact || c.score >= AUTO_MIN)

// Все строки документа: { item, match, candidates }. match — выбранная группа (или null), одна группа — одной строке.
export function matchDocItems(items, groups) {
  const index = matchIndex(groups)
  const candidates = items.map((item) => itemCandidates(item, groups, index))
  const pairs = []
  candidates.forEach((list, i) => list.forEach((c) => { if (autoMatch(c)) pairs.push({ i, c }) }))
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

// Цены документа как похожие цены позиций (документ, добавленный «в похожие цены»): строке — позиция, выбранная
// в окне (k), иначе лучшие кандидаты не ниже AUTO_MIN (до двух, если вторая почти так же похожа); «не сопоставлять»
// в окне (skip) — никуда. Позиции могли смениться (новая версия ВОР) — выбранной нет, ищем заново.
// lines — [{ name, unit, code, k, skip, … }]; ответ — Map ключ группы → [{ line, group, score, exact, picked, unitOk }].
export function offerMatches(lines, groups, index = null) {
  const ix = index || matchIndex(groups)
  const out = new Map()
  const put = (g, entry) => {
    let list = out.get(g.key)
    if (!list) { list = []; out.set(g.key, list) }
    list.push({ ...entry, group: g })
  }
  for (const line of lines) {
    if (line.skip) continue
    const picked = line.k ? ix.byKey.get(line.k) || [] : []
    if (picked.length) {
      for (const g of picked) put(g, { line, score: 1, exact: false, picked: true, unitOk: groupUnitOk(line.unit, g) })
      continue
    }
    const cands = itemCandidates(line, groups, ix, 3).filter(autoMatch)
    if (!cands.length) continue
    const best = rankOf(cands[0])
    for (const c of cands.slice(0, 2)) {
      if (c !== cands[0] && (cands[0].exact || best - rankOf(c) > 0.05)) continue
      put(c.group, { line, score: c.score, exact: c.exact, picked: false, unitOk: c.unitOk })
    }
  }
  return out
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
