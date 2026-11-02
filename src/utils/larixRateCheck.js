// Проверка цен файла по договорным расценкам (реестр расценок → «Договорные расценки (Larix)» → «Проверить по файлу»).
// Только решения, без запросов — tests/tender/larix-rate-check.test.mjs.
//
// Файл распознаётся тем же разбором, что и проверка в реестре КП (utils/bidImport), а похожесть — своя: у договорных
// расценок другие данные, и общий расчёт (utils/supplyDocMatch) на них ошибался. Замер — ниже, у ANALOG_MIN. Что другое:
//  • ищем по всем строкам, а не среди первых найденных: в браузере весь реестр (loadContractIndex), поэтому нужный
//    размер не вытесняют соседние, у которых больше общих букв;
//  • вес слова — по редкости в реестре: общее «монтаж» или «шкаф» почти ничего не решают, «ВВГнг» — решает;
//  • слово только у одной стороны — уточнение («Кабель силовой…»), разные слова у обеих — другая вещь (ППГнг и ВВГнг);
//  • разные размеры, числа или марки у обеих сторон (DN100 и DN65, 3х6 и 4х4, М-50 и М150) — не аналог, как бы ни были
//    похожи слова; «Ду 25» и «Ду 25*3,2» — один размер. Размер только у одной стороны («Лоток 200х100» и «Лоток»),
//    работа против материала («Сетка» и «Монтаж сетки») и другое главное слово («Грунтовка под штукатурку» и
//    «Штукатурка») — тоже не сам: такие строки видны как «возможные», человек включает их сам;
//  • записи одного и того же: «ВВГ нг LS» = «ВВГнг(А)-LS», «ц/п» = «цементно-песчаная»;
//  • приписки версии прайса «(04.24г)», «(июнь)» не считаются числами и не мешают совпадению, «(шт)» в конце — тоже;
//  • ед. изм. шире, чем в базе: «комплекс», «к-с», «компл» — одно, «тн» = «т», кг и т пересчитываются.
//
// Цены Larix считаются с НДС: ставку он не отдаёт, но у того же подрядчика и наименования они совпадают с ценами КП (с
// НДС) до копейки, а совпадений с ценой без НДС почти нет (947 пар, замер 02.11.2026).
// Сравнение цен: у строки Larix две цены, материалов и работ, — со строкой файла сравнивается та, что ей соответствует
// (lineMode). Прежняя цена не считается вторым мнением: одна и та же позиция повторяется в договоре и его ДС, поэтому
// от подрядчика на объекте по одному наименованию берётся цена самого свежего документа (pricePoints).
import { normName } from './supplyRateHelpers.js'
import { nameParts, normUnit } from './supplySimilarity.js'
import { codeTokens, expandName } from './supplyDocMatch.js'
import { unitPriceWithVat } from './supplierDoc.js'
import { DEFAULT_TOLERANCE, deviation, median, round2, verdictOf } from './kpRateCheck.js'

// Аналог — от ANALOG_MIN (сам входит в сравнение), возможный — от POSSIBLE_MIN (виден, человек включает сам). Пороги и
// веса подобраны 02.11.2026 на настоящих данных: 2 500 строк реестра КП против 45 тыс. строк Larix; мерка — медиана
// договоров расходится с ценой строки больше чем в 3 раза. У строк только с похожими: общий расчёт — 24,7 % из 801,
// этот — 12,3 % из 325 (остальные — «возможные»), как у того же наименования: ниже не опуститься, цены тоже бывают
// разные. Меняете — повторите замер на копии.
export const ANALOG_MIN = 0.75
export const POSSIBLE_MIN = 0.45
// Есть то же наименование — кроме него в сравнение идут только почти такие же («Бетон В25» и «Бетон В25 (М350)»).
const SAME_LEVEL_MIN = 0.9
// Сколько строк реестра кандидатов считаем точно на строку файла: самые редкие слова — первыми, частые, если редких
// уже хватает, не перебираем.
const POOL_ENOUGH = 1500
const COMMON_HEAD = 300
// Сколько групп наименований оставлять у строки файла и сколько строк в другой ед. изм. показывать.
const CANDIDATES_MAX = 40
const OTHER_UNIT_MAX = 5
// Артикул — у стольких наименований реестра, не больше: чаще — это серия, а не артикул.
const CODE_GROUPS_MAX = 8
// Вес совпавшего и лишнего: уточнение одной стороны мягче, чем замена с обеих (см. pairScore).
const EXTRA_WEIGHT = 0.35
const REPLACED_WEIGHT = 1.5
// Слова нет в реестре: важно, но не решающе (новая марка в файле не должна отменять всё остальное совпадение).
const UNSEEN_WEIGHT_MAX = 6.5

// ── Наименование ────────────────────────────────────────────────────────────────────────────────────
const MONTHS = 'январ[ья]?|феврал[ья]?|март[а]?|апрел[ья]?|ма[йя]|июн[ья]?|июл[ья]?|август[а]?|сентябр[ья]?|октябр[ья]?|ноябр[ья]?|декабр[ья]?'
const VERSION_RE = new RegExp(`\\(\\s*(?:[0-9]{1,2}[./][0-9]{2,4}\\s*г?\\.?|(?:${MONTHS})(?:\\s*[0-9]{2,4}\\s*г?\\.?)?)\\s*\\)`, 'gi')
const UNIT_TAIL_RE = /\(\s*(?:шт|штук|м|пм|м\.?\s*п|п\.?\s*м|м\.?\s*пог|пог\.?\s*м|м2|м3|м²|м³|кг|т|тн|л|уп|компл|комплект|к-т)\.?\s*\)\s*$/i

// Без приписок, которые к самой позиции не относятся: «(04.24г)», «( 07.2020г )», «(июнь)»; «(шт)» в конце.
export const cleanRateName = (name) => String(name ?? '').replace(VERSION_RE, ' ').replace(/\s+/g, ' ').trim()
  .replace(UNIT_TAIL_RE, '').trim()

// Записи одного и того же (только здесь: разбор наименований общий и с базой).
const SPELLINGS = [
  // «ВВГ нг LS», «ВВГнг(А)-LS», «ВВГнгLS», «ВВГ-нг(А)-FRLS» → «ВВГнг LS», «ВВГнг FRLS»
  [/(^|[^a-zа-яё])([а-яё]{1,5}) ?-? ?нг ?(?:\( ?[аa] ?(?:-[а-яa-z]+)? ?\))? ?-? ?(frls|frhf|ls|hf|ltx)?(?![a-zа-яё])/gi, (_, pre, mark, kind) => `${pre}${mark}нг ${kind || ''}`],
  [/(^|[^a-zа-яё])ц[/.]п\.?(?![a-zа-яё])/gi, '$1цементно-песчаная'],
  [/(^|[^a-zа-яё])цпс(?![a-zа-яё])/gi, '$1цементно-песчаная стяжка'],
  [/(^|[^a-zа-яё])цпр(?![a-zа-яё])/gi, '$1цементно-песчаный раствор'],
  [/(^|[^a-zа-яё])р-р(а|ом)?(?![a-zа-яё])/gi, '$1раствор'],
]
const spell = (name) => SPELLINGS.reduce((s, [re, to]) => s.replace(re, to), name)

// Марка и обозначение: буква и число («М-50», «В25», «F100», «Ду 32», «PN16», «IP54»), один ключ — одно значение.
const GRADE_RE = /(^|[^a-zа-яё0-9])(ду|дн|pn|ру|ip|[мmвbfwdпа])\s*[-=.]?\s*([0-9]+(?:[.,][0-9]+)?)(?![0-9]*[xх×*])/gi
const GRADE_KEY = { m: 'м', b: 'в' }
function gradeTokens(name) {
  const out = new Map()
  for (const m of name.matchAll(GRADE_RE)) {
    const low = m[2].toLowerCase()
    const key = GRADE_KEY[low] || low
    if (!out.has(key)) out.set(key, new Set())
    out.get(key).add(m[3].replace(',', '.').replace(/\.0+$/, ''))
  }
  return out
}
function gradesApart(a, b) {
  for (const [key, values] of a) {
    const other = b.get(key)
    if (other && ![...values].some((v) => other.has(v))) return true
  }
  return false
}

// Работа, а не материал — по первому слову.
const WORK_RE = /^(монтаж|демонтаж|устройств|установк|прокладк|укладк|сборк|разборк|пуско|пнр|наладк|изготовлен|сварк|окраск|покраск|оштукатур|ремонт|разработк|засыпк|обратн|бетонирован|армирован|герметизац|программирован|подключен|испытан|обвязк|облицовк|сдача|промывк|зачистк|огрунтовк|грунтован|нанесен|выполнен|работ|услуг|погрузк|разгрузк|вывоз|доставк|подготовк|заделк|пробивк|сверлен|бурен|резк|шпатлевк|шпаклевк)/
export const isWorkName = (name) => WORK_RE.test(String(name ?? '').trim().toLowerCase().replace(/ё/g, 'е'))

// Сокращение — слово с точкой: «оцинк.», «оц.», но не «ЩАО.4.2».
const ABBR_RE = /([а-яёa-z]{2,})\.(?![0-9])/gi
// Части размера: «Ду 25» и «25*3,2» — не разные числа.
const atomsOf = (nums) => new Set(nums.flatMap((t) => t.split('×')))
function nameFeatures(raw, code = null) {
  const clean = cleanRateName(raw)
  const expanded = spell(expandName(clean))
  const abbr = new Set()
  for (const m of expanded.matchAll(ABBR_RE)) for (const w of nameParts(m[1]).words) abbr.add(w)
  const parts = nameParts(code ? `${expanded} ${code}` : expanded)
  return {
    k: normName(clean), parts, abbr, atoms: atomsOf(parts.nums), grades: gradeTokens(expanded), first: nameParts(expanded).words.length ? firstWord(expanded) : null,
    codes: codeTokens(clean, code), work: isWorkName(clean),
  }
}
// Первое слово наименования (основа, как в nameParts): обычно — что это за вещь.
function firstWord(name) {
  for (const raw of name.split(/[^a-zа-яёA-ZА-ЯЁ]+/)) {
    const w = nameParts(raw).words[0]
    if (w) return w
  }
  return null
}

// Слово то же: совпало, короткое — сокращение длинного («оцинк.», «оц.»; с точкой в самом наименовании: «вентил» и
// «вентилятор» — разные слова), расходятся только хвосты («чугунных» и «чугунная») или опечатка в длинном слове
// («безраструбнных»).
const COMMON_PREFIX_MIN = 6
const TAIL_MAX = 2
const TYPO_WORD_MIN = 7
function sameWord(x, y, abbrX, abbrY) {
  if (x === y) return true
  const [short, long, abbr] = x.length <= y.length ? [x, y, abbrX] : [y, x, abbrY]
  if (long.startsWith(short) && abbr.has(short)) return true
  let i = 0
  while (i < short.length && short[i] === long[i]) i += 1
  if (i >= COMMON_PREFIX_MIN && short.length - i <= TAIL_MAX && long.length - i <= TAIL_MAX) return true
  if (short.length < TYPO_WORD_MIN || long.length - short.length > 1 || i < 3) return false
  // Одна лишняя или другая буква: хвосты после первого расхождения совпадают.
  return short.slice(i) === long.slice(long.length - short.length + i) || short.slice(i + 1) === long.slice(i + 1)
}

// ── Указатель реестра ───────────────────────────────────────────────────────────────────────────────
// rows — строки larix_rates_registry. Группа — одно наименование (без приписок): { key, name, parts, abbr, codes, work,
// rows }. Строится один раз на загрузку реестра.
export function contractIndex(rows) {
  const byKey = new Map()
  for (const r of rows || []) {
    const k = normName(cleanRateName(r.item_name))
    let g = byKey.get(k)
    if (!g) {
      g = { key: k, name: r.item_name, ...nameFeatures(r.item_name), rows: [] }
      byKey.set(k, g)
    }
    g.rows.push(r)
  }
  const groups = [...byKey.values()]
  const df = new Map()
  const heads = new Map()
  const codes = new Map()
  const add = (map, key, g) => { let s = map.get(key); if (!s) { s = new Set(); map.set(key, s) } s.add(g) }
  for (const g of groups) {
    for (const w of g.parts.words) {
      df.set(w, (df.get(w) || 0) + 1)
      add(heads, w.slice(0, 4), g)
    }
    for (const c of g.codes) add(codes, c, g)
  }
  const weights = new Map()
  const weight = (w) => {
    let v = weights.get(w)
    if (v == null) {
      const d = df.get(w)
      v = d ? Math.log(1 + groups.length / d) : Math.min(UNSEEN_WEIGHT_MAX, Math.log(1 + groups.length))
      weights.set(w, v)
    }
    return v
  }
  return { byKey, groups, heads, codes, weight, rowCount: (rows || []).length }
}

// Похожесть строки файла и группы реестра: { score, apart, weak }. score — 0…1: совпавшие слова против лишних, с весом
// по редкости. apart — числа у обеих сторон разные; weak — размер только у одной стороны или работа против материала.
const isSize = (t) => t.includes('×')
export function pairScore(a, g, weight) {
  let matched = 0
  let onlyA = 0
  let onlyB = 0
  const hit = new Set()
  for (const x of a.parts.words) {
    let found = false
    for (const y of g.parts.words) if (sameWord(x, y, a.abbr, g.abbr)) { found = true; hit.add(y) }
    if (found) matched += weight(x); else onlyA += weight(x)
  }
  for (const y of g.parts.words) { if (hit.has(y)) matched += weight(y); else onlyB += weight(y) }
  matched /= 2
  const score = matched ? matched / (matched + EXTRA_WEIGHT * Math.max(onlyA, onlyB) + REPLACED_WEIGHT * Math.min(onlyA, onlyB)) : 0
  const numsA = a.parts.nums
  const numsB = g.parts.nums
  const setB = new Set(numsB)
  const sharedSize = numsA.some((t) => isSize(t) && setB.has(t))
  const sizesApart = numsA.some(isSize) && numsB.some(isSize) && !sharedSize
  const numsApart = numsA.some((t) => t.split('×').some((d) => !g.atoms.has(d))) && numsB.some((t) => t.split('×').some((d) => !a.atoms.has(d))) && !sharedSize
  // Главное слово строки файла (что это за вещь) должно быть в наименовании реестра: «Техноэласт Барьер» и
  // «Гидроизоляция Техноэласт Барьер» — да, «Грунтовка под штукатурку» и «Штукатурка» — нет.
  const headMissing = !a.work && !g.work && a.first && !g.parts.words.some((y) => sameWord(a.first, y, a.abbr, g.abbr))
  const weak = (numsA.length > 0) !== (numsB.length > 0) || a.work !== g.work || !!headMissing
  return { score: Math.round(score * 1000) / 1000, apart: sizesApart || numsApart || gradesApart(a.grades, g.grades), weak }
}

// Кандидаты строки файла: [{ group, score, exact, code, apart, weak, analog }] — лучшие первыми.
export function lineCandidates(item, ix) {
  const a = nameFeatures(item.name, item.code)
  const pool = new Set()
  const lists = [...new Set(a.parts.words.map((w) => w.slice(0, 4)))].map((h) => ix.heads.get(h)).filter(Boolean)
    .sort((x, y) => x.size - y.size)
  let seen = 0
  for (const s of lists) {
    if (seen > POOL_ENOUGH && s.size > COMMON_HEAD) break
    seen += s.size
    for (const g of s) pool.add(g)
  }
  const byCode = new Set()
  const byStrongCode = new Set()
  for (const c of a.codes) {
    const s = ix.codes.get(c)
    if (!s || s.size > CODE_GROUPS_MAX) continue
    const strong = /^[0-9]+$/.test(c) ? c.length >= 5 : c.length >= 6
    for (const g of s) { byCode.add(g); if (strong) byStrongCode.add(g); pool.add(g) }
  }
  const same = ix.byKey.get(a.k)
  if (same) pool.add(same)
  const out = []
  for (const g of pool) {
    const exact = g === same
    const r = exact ? { score: 1, apart: false, weak: false } : pairScore(a, g, ix.weight)
    // Артикул сам по себе не довод: «L=1015», «3000К» и серии выглядят как коды, поэтому нужны и общие слова — хоть
    // одно у настоящего артикула (от 5 цифр или от 6 знаков с буквами), как у возможного — у всего остального.
    const code = !exact && (byStrongCode.has(g) ? r.score > 0 : byCode.has(g) && r.score >= POSSIBLE_MIN)
    if (!exact && !code && r.score < POSSIBLE_MIN) continue
    out.push({ group: g, ...r, exact, code, analog: exact || code || (!r.apart && !r.weak && r.score >= ANALOG_MIN) })
  }
  return out.sort((x, y) => Number(y.exact) - Number(x.exact) || Number(y.analog) - Number(x.analog)
    || Number(x.apart) - Number(y.apart) || y.score - x.score).slice(0, CANDIDATES_MAX)
}

// ── Ед. изм. ────────────────────────────────────────────────────────────────────────────────────────
const UNIT_MORE = { комплекс: 'компл', 'к-с': 'компл', комп: 'компл', кмпл: 'компл', кт: 'компл', тн: 'т', тонна: 'т', тонн: 'т', м: 'мп', '1 точка': 'точка' }
const contractUnit = (u) => { const s = normUnit(u); return UNIT_MORE[s] || s }
// Множитель цены строки реестра к ед. изм. строки файла: 1 — та же (или не указана), 1000 / 0,001 — кг и т, null — другая.
export function unitFactor(lineUnit, rowUnit) {
  const a = contractUnit(lineUnit)
  const b = contractUnit(rowUnit)
  if (!a || !b || a === b) return 1
  if (a === 'т' && b === 'кг') return 1000
  if (a === 'кг' && b === 'т') return 0.001
  return null
}

// ── Какая цена сравнивается ─────────────────────────────────────────────────────────────────────────
// Выбор в окне: auto — по строке, material / work — только эта цена договора, total — материалы + работы.
export const PRICE_MODES = [
  ['auto', 'по строке: работа — обе цены, иначе материалы'],
  ['material', 'цена материалов'],
  ['work', 'цена работ'],
  ['total', 'материалы + работы'],
]
export const PRICE_MODE_TEXT = { material: 'цена материалов', work: 'цена работ', total: 'материалы + работы', position: 'цена материалов, нет её — работ' }

// Режим строки файла: вид из файла важнее всего (листы «Материалы» / «Работы», две колонки цены); иначе выбор в окне;
// «по строке»: работа — вся цена позиции (материалы + работы), остальное — position: цена материалов, а если её нет —
// работ (огнезащита, кабеленесущие системы: слово не глагол, а цена — работ).
export function lineMode(item, setting = 'auto') {
  if (item.kindHint) return item.kindHint
  if (setting !== 'auto') return setting
  return isWorkName(item.name) ? 'total' : 'position'
}

// Цена строки реестра в этом режиме или null: у строки может быть только одна из двух цен.
export function rowPrice(row, mode) {
  const pm = row.price_material != null ? Number(row.price_material) : null
  const pw = row.price_work != null ? Number(row.price_work) : null
  if (mode === 'material') return pm
  if (mode === 'work') return pw
  if (mode === 'position') return pm ?? pw
  return pm == null && pw == null ? null : (pm ?? 0) + (pw ?? 0)
}

// ── Цены одной группы ───────────────────────────────────────────────────────────────────────────────
// Точка сравнения — цена подрядчика по объекту из самого свежего документа, в котором есть это наименование: договор и
// его ДС повторяют позицию, а прежняя цена — не второе мнение. Разные цены в одном свежем документе остаются (разные
// участки). Ответ: { points: [{ row, price, older }], otherUnit: [row] }; since — самая ранняя дата договора.
export function pricePoints(rows, { unit, mode, since = null }) {
  const owners = new Map()
  const otherUnit = []
  for (const r of rows) {
    if (since && r.contract_date && r.contract_date < since) continue
    const factor = unitFactor(unit, r.unit)
    if (factor == null) { otherUnit.push(r); continue }
    const p = rowPrice(r, mode)
    if (!(p > 0)) continue
    const key = `${r.contractor_id ?? `r${r.id}`}|${r.project_id ?? ''}`
    let list = owners.get(key)
    if (!list) { list = []; owners.set(key, list) }
    list.push({ row: r, price: round2(p * factor), factor })
  }
  const points = []
  for (const list of owners.values()) {
    let newest = ''
    for (const x of list) if ((x.row.contract_date || '') > newest) newest = x.row.contract_date
    const seen = new Set()
    for (const x of list) {
      if ((x.row.contract_date || '') !== newest || seen.has(x.price)) continue
      seen.add(x.price)
      points.push({ ...x, older: list.filter((y) => (y.row.contract_date || '') !== newest).length })
    }
  }
  return { points: points.sort((a, b) => (b.row.contract_date || '').localeCompare(a.row.contract_date || '') || a.price - b.price), otherUnit }
}

// Цены точек: { n, min, max, median, exact, contractors } или null.
export function contractStats(points) {
  const prices = points.map((p) => p.price).filter((p) => p > 0).sort((a, b) => a - b)
  if (!prices.length) return null
  return {
    n: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    median: round2(median(prices)),
    exact: points.filter((p) => p.exact).length,
    contractors: new Set(points.map((p) => p.row.contractor_id ?? p.row.contractor_name)).size,
  }
}

export const VERDICT_TEXT = {
  ok: 'в рынке',
  high: 'дороже договоров',
  low: 'дешевле договоров',
  none: 'нет аналогов',
  noprice: 'нет цены',
}

// Строки файла → строки проверки: [{ i, item, mode, price, analogs, possible, otherUnit, stats, dev, verdict }].
// candidates — Map индекс строки → lineCandidates; настройки: vat — НДС файла, priceMode — выбор в окне, since —
// самая ранняя дата договора, choices — выбор человека: Map `${i}|${id строки реестра}` → учитывать или нет. Есть то же
// наименование — сравниваем с ним и почти такими же; просто похожие остаются видны и включаются галочкой.
export function checkContractLines(items, candidates, { vat = null, tolerance = DEFAULT_TOLERANCE, priceMode = 'auto', since = null, choices = null } = {}) {
  return (items || []).map((item, i) => {
    const raw = item.delivery ? null : unitPriceWithVat(item, vat)
    const price = raw != null && raw > 0 ? round2(raw) : null
    const mode = lineMode(item, priceMode)
    const analogs = []
    const possible = []
    const otherUnit = []
    const cands = (item.delivery ? [] : candidates?.get(i) || [])
      .map((c) => ({ c, ...pricePoints(c.group.rows, { unit: item.unit, mode, since }) }))
    const hasSame = cands.some((x) => x.c.exact && x.points.length > 0)
    for (const { c, points, otherUnit: other } of cands) {
      for (const row of other.slice(0, 2)) if (otherUnit.length < OTHER_UNIT_MAX) otherUnit.push({ row, score: c.score, exact: c.exact })
      const auto = c.analog && (c.exact || c.code || !hasSame || c.score >= SAME_LEVEL_MIN)
      for (const p of points) {
        const on = choices?.get(`${i}|${p.row.id}`) ?? auto
        ;(auto ? analogs : possible).push({ ...p, score: c.score, exact: c.exact, code: c.code, apart: c.apart, weak: c.weak, auto, on })
      }
    }
    const stats = contractStats([...analogs, ...possible].filter((p) => p.on))
    return {
      i, item, mode, price, analogs, possible, otherUnit, stats,
      dev: deviation(price, stats),
      verdict: item.delivery ? 'delivery' : verdictOf(price, stats, tolerance),
    }
  })
}

// Итоги проверки: счётчики по итогам и суммы по строкам, где есть и цена, и количество, и аналоги.
export function contractSummary(lines) {
  const out = { total: 0, ok: 0, high: 0, low: 0, none: 0, noprice: 0, withStats: 0, fileSum: 0, medianSum: 0 }
  for (const l of lines) {
    if (l.verdict === 'delivery') continue
    out.total += 1
    out[l.verdict] = (out[l.verdict] || 0) + 1
    if (l.stats) out.withStats += 1
    if (l.price != null && l.stats && l.item.qty > 0) {
      out.fileSum += l.price * l.item.qty
      out.medianSum += l.stats.median * l.item.qty
    }
  }
  out.fileSum = round2(out.fileSum)
  out.medianSum = round2(out.medianSum)
  return out
}

// Самая ранняя дата договора для «за N месяцев» (0 — за всё время). today — ГГГГ-ММ-ДД.
export function periodSince(months, today) {
  if (!months) return null
  const [y, m, d] = today.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1 - months, 1))
  const last = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  shifted.setUTCDate(Math.min(d, last))
  return shifted.toISOString().slice(0, 10)
}

// Строка с двумя ценами (две колонки: материалы и работы) → две строки проверки, каждая со своим видом.
export function splitPriceParts(items) {
  const out = []
  for (const it of items || []) {
    const kinds = it.parts ? ['material', 'work'].filter((kind) => it.parts[kind].price != null || it.parts[kind].sum != null) : []
    if (!kinds.length) { out.push(it); continue }
    for (const kind of kinds) {
      const p = it.parts[kind]
      out.push({ ...it, price: p.price, priceVat: p.priceVat, sum: p.sum, sumVat: p.sumVat, kindHint: kind, parts: null })
    }
  }
  return out
}

// Выгрузка в Excel (шапка — CONTRACT_EXPORT_HEADERS).
export const CONTRACT_EXPORT_HEADERS = [
  '№', 'Наименование в файле', 'Ед. изм.', 'Кол-во', 'Цена в файле с НДС, ₽', 'Сравнивается', 'Цен договоров', 'Подрядчиков', 'Мин., ₽', 'Медиана, ₽', 'Макс., ₽',
  'Отклонение от медианы, %', 'Сумма в файле, ₽', 'Сумма по медиане, ₽', 'Итог', 'Ближайшая расценка', 'Подрядчик', 'Объект', 'Договор', 'Дата договора', 'Цена расценки, ₽',
]
export function contractExportRows(lines) {
  return lines.filter((l) => l.verdict !== 'delivery').map((l, n) => {
    const best = [...l.analogs, ...l.possible].find((p) => p.on) || null
    const r = best?.row
    const qty = l.item.qty
    return [
      n + 1, l.item.name, l.item.unit || '', qty ?? '', l.price ?? '', PRICE_MODE_TEXT[l.mode] || '', l.stats?.n ?? 0, l.stats?.contractors ?? 0,
      l.stats?.min ?? '', l.stats?.median ?? '', l.stats?.max ?? '', l.dev ?? '',
      l.price != null && qty > 0 ? round2(l.price * qty) : '', l.stats && qty > 0 ? round2(l.stats.median * qty) : '',
      l.verdict === 'noprice' && l.stats ? 'цены в файле нет' : VERDICT_TEXT[l.verdict] || '',
      r?.item_name || '', r?.contractor_name || '', r?.project_name || '', r?.contract_number || '', r?.contract_date || '', best?.price ?? '',
    ]
  })
}
