// Цены для позиции расценки снабжением — окно «Цены» позиции (26.11.2026, жалоба по тендеру № 1158: «Извещатель пожарный дымовой» не
// находил в похожих «Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ» ни среди цен других тендеров, ни в реестре СУ-10).
// Только решения, без запросов — tests/supply/price-search.test.mjs.
//
// Где ищем (всё — в браузере, базе считать нечего):
//  • tender — свои (не скопированные) цены снабжения других тендеров и других ВОР этого (кроме самой позиции): services/supplyPricing
//    .loadOtherTenderRates, тот же ответ, что у «в другой ед. изм.»;
//  • import — загрузки реестра СУ-10 из Excel; doc — строки счетов и КП других тендеров в реестре (services/supplyPriceSources).
//    Строка счёта, чья цена уже стоит ценой того же тендера (то же наименование и цена), — один раз, как цена тендера.
// Как ищем — так же, как строке счёта ищутся позиции ВОР (utils/supplyDocMatch.itemCandidates), с пересчётом единиц и ступенями
// похожести (graded: та же позиция → очень похожие → уточнение → похожие → отдалённо). Цены старше 3 месяцев тоже предлагаются
// (решение пользователя 26.11.2026), с пометкой stale; сами не подставляются никогда (подстановка — supply_autofill, только свежие).
// Указатель большого реестра строится порциями (buildPriceIndex), поиск позиции — один раз на наименование и ед. изм. (memo).
import { canonUnit } from './supplySimilarity.js'
import { freshSince, moscowToday, normName } from './supplyRateHelpers.js'
import {
  GRADE_RANK, MATCH_CANDIDATES, gradeNames, groupUnitOk, itemCandidates, linePack, matchIndexInSlices, pickedGroups, primeGroupFeatures,
} from './supplyDocMatch.js'
import { roundMoney } from './money.js'

export { GRADES } from './supplyDocMatch.js'

// Сколько найденных наименований у позиции (с ценами каждого): общее «Извещатель» в реестре — десятки моделей.
export const PRICE_CANDIDATES = 60
const SLICE_MS = 40
const nextTurn = () => new Promise((resolve) => { setTimeout(resolve, 0) })

// День расценки по Москве: у цены тендера — уже день, у строки реестра — полночь дня по Москве (timestamptz).
export function moscowDay(value) {
  const s = String(value || '')
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10) : ''
}

// ── Строки цен ──────────────────────────────────────────────────────────────────────────────────────
// Строка: { id, source, name, unit, price, day, stale, tenderId, tenderNumber, objectName, estimateName, materialKey, tenderDesc,
// sourceName, contractor, docId, docName, invoiceUrl }. price — за единицу строки, с НДС (как в расценке и реестре).
// Граница «свежей» цены считается один раз на весь список (moscowToday — Intl, на 25 тыс. строк реестра это секунда).
const staleBefore = (today) => freshSince(today || moscowToday())
export function tenderPriceRows(rates, today) {
  const since = staleBefore(today)
  const out = []
  for (const r of rates || []) {
    const price = Number(r.price ?? r.supply_price_exact ?? r.supply_price)
    if (!(price > 0) || !r.material_name) continue
    const day = moscowDay(r.price_date)
    out.push({
      id: r.id, source: 'tender', name: r.material_name, unit: r.unit || null, price, day, stale: !day || day < since,
      tenderId: r.tender_id, tenderNumber: r.tender_number ?? null, objectName: r.object_name || null, estimateName: r.estimate_name,
      materialKey: r.material_key,
    })
  }
  return out
}

// Строки реестра СУ-10 (supply_rates_registry: загрузки и строки счетов). Строки счетов самого тендера — уже «цены поставщиков» окна;
// строка счёта, чья цена стоит ценой того же тендера с тем же наименованием, — повтор цены тендера.
export function registryPriceRows(rows, { mainId = null, tenderRows = [], today } = {}) {
  const since = staleBefore(today)
  const tendersWithDocs = new Set((rows || []).filter((r) => r.source_type === 'supply_doc' && r.tender_id).map((r) => r.tender_id))
  const applied = new Set(tenderRows.filter((t) => tendersWithDocs.has(t.tenderId)).map((t) => `${t.tenderId}|${normName(t.name)}|${roundMoney(t.price)}`))
  const out = []
  for (const r of rows || []) {
    const price = Number(r.price)
    if (!(price > 0) || !r.item_name) continue
    const source = r.source_type === 'supply_doc' ? 'doc' : 'import'
    if (source === 'doc' && r.tender_id && (r.tender_id === mainId || applied.has(`${r.tender_id}|${normName(r.item_name)}|${roundMoney(price)}`))) continue
    const day = moscowDay(r.rate_date)
    out.push({
      id: `reg:${r.id}`, source, name: r.item_name, unit: r.unit || null, price, day, stale: !day || day < since,
      tenderId: r.tender_id || null, tenderNumber: null, objectName: r.object_name || null, tenderDesc: r.tender_desc || null,
      sourceName: r.source_name || null, contractor: r.contractor_label || null, docId: r.doc_id || null, docName: r.source_file || null,
      invoiceUrl: r.invoice_url || null,
    })
  }
  return out
}

// ── Указатель ───────────────────────────────────────────────────────────────────────────────────────
// Группа — одно наименование в одной ед. изм. (как позиции ВОР в окне счетов): { key, k, name, unit, units, targets, rows }.
function addRow(byKey, r) {
  const k = normName(r.name)
  if (!k) return
  const key = `${k}|${canonUnit(r.unit) || ''}`
  let g = byKey.get(key)
  if (!g) {
    g = { key, k, name: r.name, unit: r.unit, units: null, targets: [], rows: [] }
    byKey.set(key, g)
  }
  g.rows.push(r)
}

// Указатель цен порциями по SLICE_MS (между порциями — pause, по умолчанию следующий ход): реестр — 25 тыс. строк, одним куском
// страница замерла бы на секунду-две. alive() — false: бросить (ответ null).
export async function buildPriceIndex(rows, { pause = nextTurn, alive = () => true } = {}) {
  const byKey = new Map()
  let at = performance.now()
  for (let i = 0; i < rows.length; i++) {
    addRow(byKey, rows[i])
    if ((i & 255) === 255 && performance.now() - at > SLICE_MS) {
      await pause()
      if (!alive()) return null
      at = performance.now()
    }
  }
  const groups = [...byKey.values()]
  for (const g of groups) {
    primeGroupFeatures(g)
    if (performance.now() - at > SLICE_MS) {
      await pause()
      if (!alive()) return null
      at = performance.now()
    }
  }
  const ix = await matchIndexInSlices(groups, { pause, alive, sliceMs: SLICE_MS })
  if (!ix) return null
  return { groups, ix, memo: new Map(), rowCount: rows.length }
}

// ── Поиск для позиции ───────────────────────────────────────────────────────────────────────────────
// Найденное для позиции { name, unit }: [{ key, group, grade, score, exact, pack, points }] по ступеням, лучшие первыми; points — цены
// за единицу позиции ({ row, price, stale }: свежие первыми, затем новые, затем дешёвые). Только подходящая ед. изм. (или пересчёт);
// другая — раздел «в другой ед. изм.» (supplyAutoPick.otherUnitPrices). skip(row) — строки, которые не показывать (сама позиция).
const byPoint = (a, b) => Number(a.stale) - Number(b.stale) || String(b.row.day).localeCompare(String(a.row.day)) || a.price - b.price
export function positionPrices(position, index, { skip = null } = {}) {
  if (!index || !position?.name || position.units) return []
  const memoKey = `${position.name}\u0001${position.unit || ''}`
  let found = index.memo.get(memoKey)
  if (!found) {
    const item = { name: position.name, unit: position.unit || null }
    found = itemCandidates(item, index.groups, index.ix, PRICE_CANDIDATES, { packs: true, graded: true }).filter((c) => c.unitOk)
    index.memo.set(memoKey, found)
  }
  const out = []
  for (const c of found) {
    const factor = c.pack || 1
    const points = []
    for (const row of c.group.rows) {
      if (skip?.(row)) continue
      points.push({ row, price: roundMoney(row.price * factor), stale: row.stale })
    }
    if (!points.length) continue
    points.sort(byPoint)
    out.push({ key: c.group.key, group: c.group, grade: c.grade, score: c.score, exact: c.exact, pack: c.pack, points })
  }
  return out
}

// Сколько цен показать в строке таблицы («похожие цены: N»): всех, кроме отдалённых; exclude — id цены, которую не считать (источник
// скопированной цены позиции: она уже стоит).
export function countPrices(entries, exclude = null) {
  let n = 0
  for (const e of entries) {
    if (e.grade === 'far') continue
    for (const p of e.points) if (p.row.id !== exclude) n += 1
  }
  return n
}

// ── Цены поставщиков этого тендера по ступеням ──────────────────────────────────────────────────────
// Строки счетов и КП тендера (docs — [{ doc, offer }], как у таблицы), похожие на группу позиции (группа указателя index — та же, что
// в groups): выбранные человеком, сопоставленные сами и те, что у строки только в списке выбора (ниже порога), — со ступенью похожести
// (искомое — позиция, найденное — строка документа). Кандидаты строк — из памяти общего указателя (sharedMatchIndex: таблица и окно
// «Счета и КП» нашли их раньше; вызывающий зовёт только после первого поиска). Ответ — [{ line (с doc), group, score, exact, picked,
// article, unitOk, pack, grade }], лучшие первыми, при равенстве — дешевле; та же строка с той же ценой в двух документах — один раз
// (из более свежего: документы идут новыми вперёд).
export function groupOffers(group, docs, groups, index) {
  if (!group) return []
  const out = []
  const seen = new Set()
  for (const { doc, offer } of docs || []) {
    if (offer.currency) continue
    for (const line of offer.lines) {
      if (line.skip) continue
      const sign = `${normName(line.name)}|${canonUnit(line.unit)}|${line.price}`
      if (seen.has(sign)) continue
      let entry = null
      const picked = pickedGroups(line, index)
      if (picked.length) {
        if (picked.includes(group)) {
          const pack = group.units ? null : linePack(line, group)
          entry = { score: 1, exact: false, picked: true, article: false, unitOk: pack != null || groupUnitOk(line.unit, group), pack, grade: 'same' }
        }
      } else {
        const c = itemCandidates(line, groups, index, MATCH_CANDIDATES, { packs: true }).find((x) => x.group === group)
        if (c) {
          entry = { score: c.score, words: c.words, exact: c.exact, picked: false, article: !!c.article, apart: !!c.apart, unitOk: c.unitOk, pack: c.pack }
          entry.grade = gradeNames(group.name, line.name, entry)
        }
      }
      if (!entry) continue
      seen.add(sign)
      out.push({ ...entry, group, line: { ...line, doc } })
    }
  }
  const unitPrice = (o) => o.line.price / (o.pack || 1)
  return out.sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade] || Number(b.picked) - Number(a.picked) || Number(b.exact) - Number(a.exact)
    || b.score - a.score || unitPrice(a) - unitPrice(b))
}

// ── Сводка ступени ──────────────────────────────────────────────────────────────────────────────────
// Цены ступени: { n, min, max, median } (по свежей цене каждого найденного наименования и каждой цене поставщика) или null.
export function gradeSummary(prices) {
  const list = prices.filter((p) => p > 0).sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  const median = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
  return { n: list.length, min: list[0], max: list[list.length - 1], median: roundMoney(median) }
}

// Подписи ступеней — окно цен позиции и проверка по файлу реестра.
export const GRADE_INFO = {
  same: { title: 'Та же позиция', hint: 'то же наименование, тот же артикул или выбрано вручную' },
  close: { title: 'Очень похожие', hint: 'почти то же наименование' },
  refine: { title: 'Уточнённые модели', hint: 'есть всё наименование позиции и ещё модель или марка — цены моделей бывают очень разными' },
  near: { title: 'Похожие', hint: 'совпадает часть наименования — проверьте, та ли это вещь' },
  far: { title: 'Отдалённо похожие', hint: 'другой размер, другой вид или мало общего' },
}
