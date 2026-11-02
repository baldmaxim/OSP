// Автовыбор цен по документам всего тендера: счета и КП прикрепляют к тендеру целиком, а не к позициям, расценка сама
// находит каждой позиции ВОР цену. Только решения, без запросов: панель даёт документы и что сейчас в расценке, окно
// показывает выбор и пишет цены по одному нажатию (каждую цену человек видит и может снять).
//
// Какая цена. Внутри документа одна позиция — одной строке (utils/supplyDocMatch.matchDocItems), выбор человека из окна
// проверки строк важнее. Между документами:
//  1) только с подходящей ед. изм. (или понятно, сколько её в упаковке, и после пересчёта количество похоже на объём ВОР),
//     цена × количество сходится с суммой, не в валюте;
//  2) сначала надёжные — то же наименование, артикул, выбрано человеком; похожие — только если надёжных нет: дешёвый
//     аналог не должен перебивать то же самое наименование;
//  3) среди них — по правилу окна: самая низкая цена или самый свежий документ.
// Разброс цен в SPREAD раз и больше — пометка «проверить»: так выглядит цена за бухту среди цен за метр.
import { roundMoney } from './money.js'
import { matchDocItems, matchIndex, docPack, groupUnitOk, offerPrice, packQtyFar, thicknessM } from './supplyDocMatch.js'
import { canonUnit, isSimilar, nameParts, normUnit } from './supplySimilarity.js'

export const RULE_CHEAPEST = 'cheapest'
export const RULE_NEWEST = 'newest'
const SPREAD = 3
// Своя цена позиции подозрительна: совпала с ценой упаковки в документе или в FAR_FROM раз и больше от надёжных цен.
const SAME_AS_PACK = 0.03
const FAR_FROM = 5

const isSure = (o) => o.exact || o.picked || o.article
const entry = (doc, date, line, c) => ({
  id: `${doc.id}:${line.name}:${c.group.key}`, doc, date, line, group: c.group, exact: !!c.exact, picked: !!c.picked, article: !!c.article,
  score: c.score ?? 1, pack: c.pack ?? null, unitOk: c.unitOk, price: roundMoney(line.price / (c.pack || 1)), qtyFar: packQtyFar(line, c.group, c.pack),
})

// Документы тендера → по позициям. docs — [{ doc, offer }] (строки в notes файла; цены в валюте ждут курса в окне проверки
// строк и сюда не идут). Ответ — Map ключ группы → цены документов [{ id, doc, date, line, group, exact, picked, article,
// score, pack, unitOk, price }]. Дата документа — из него самого, иначе день загрузки файла.
export function offersByGroup(docs, groups) {
  const index = matchIndex(groups)
  const out = new Map()
  const put = (e) => {
    const list = out.get(e.group.key)
    if (list) list.push(e)
    else out.set(e.group.key, [e])
  }
  for (const { doc, offer } of docs || []) {
    if (offer.currency) continue
    const date = offer.date || String(doc.created_at || '').slice(0, 10) || null
    const taken = new Set()
    for (const line of offer.lines) {
      if (line.skip || !line.k) continue
      for (const g of [line.k, ...(line.also || [])].flatMap((k) => index.byKey.get(k) || [])) {
        const pack = g.units ? null : docPack(line, g.unit, g.name)
        taken.add(g.key)
        put(entry(doc, date, line, { group: g, picked: true, pack, unitOk: pack != null || groupUnitOk(line.unit, g) }))
      }
    }
    const free = offer.lines.filter((l) => !l.skip && !l.k)
    for (const m of matchDocItems(free, groups, { packs: true, index })) {
      for (const c of m.match ? [m.match, ...m.also] : []) {
        if (!taken.has(c.group.key)) put(entry(doc, date, m.item, c))
      }
    }
  }
  return out
}

const newer = (a, b) => String(b.date || '').localeCompare(String(a.date || ''))

// Цена для позиции по правилу (см. начало файла) или null. rule — RULE_CHEAPEST | RULE_NEWEST.
export function bestOffer(offers, rule = RULE_CHEAPEST) {
  const usable = (offers || []).filter((o) => o.unitOk && o.price > 0 && !o.line.sumOff && !o.qtyFar)
  const sure = usable.filter(isSure)
  const list = sure.length ? sure : usable
  if (!list.length) return null
  const byPrice = (a, b) => a.price - b.price || newer(a, b)
  const byDate = (a, b) => newer(a, b) || a.price - b.price
  return [...list].sort(rule === RULE_NEWEST ? byDate : byPrice)[0]
}

// Что сейчас в расценке против новой цены: своя другая цена — { kind: 'replace', prices } (заменяет только человек); цена из
// другого тендера — 'copy'; пусто хотя бы где-то — 'new'; везде та же — 'same'. cur — { own: [цены], copies, empty }.
export function priceStatus(cur, price) {
  const differ = [...new Set(cur.own.map(roundMoney).filter((p) => p !== price))]
  if (differ.length) return { kind: 'replace', prices: differ }
  return cur.copies ? { kind: 'copy' } : cur.empty ? { kind: 'new' } : { kind: 'same' }
}

// Строки окна автовыбора — по одной на позицию (группу) с ценами: { group, offers, choice, spread, sure, status, auto }.
// chosen — Map ключ группы → id цены, выбранной человеком; currentOf(group) — что сейчас в расценке. auto — отметить
// сразу: есть цена и своя другая цена позиции не заменяется. withoutOffers — позиции, цен на которые в документах нет.
export function autoPickRows(byGroup, groups, { rule = RULE_CHEAPEST, chosen = null, currentOf }) {
  const rows = []
  const withoutOffers = []
  for (const group of groups) {
    const offers = byGroup.get(group.key)
    if (!offers?.length) { withoutOffers.push(group); continue }
    const sorted = [...offers].sort((a, b) => a.price - b.price || newer(a, b))
    const picked = chosen?.get(group.key)
    const choice = (picked && offers.find((o) => o.id === picked)) || bestOffer(offers, rule)
    const prices = offers.filter((o) => o.unitOk && o.price > 0).map((o) => o.price)
    const spread = prices.length > 1 && Math.max(...prices) / Math.min(...prices) >= SPREAD ? Math.round(Math.max(...prices) / Math.min(...prices)) : null
    const status = choice ? priceStatus(currentOf(group), choice.price) : null
    rows.push({ group, offers: sorted, choice, spread, sure: !!choice && isSure(choice), status, auto: !!choice && !!status && status.kind !== 'replace' && status.kind !== 'same' })
  }
  return { rows, withoutOffers }
}

// Цены других тендеров в другой ед. изм. — в меню похожих цен, с пометкой (решение пользователя 02.11.2026, тендер № 821: сами
// не подставляются — правильно, но и не должны пропадать: база отбирает только ту же ед. изм., «Утеплитель толщ. 50 мм» в м2 не
// видел ту же позицию в м3 из № 845). Расчёт в браузере, миграции нет. rates — свежие цены других тендеров.
const OTHER_UNIT_LIMIT = 8
export function otherUnitIndex(rates) {
  const byKey = new Map()
  const byHead = new Map()
  const add = (map, k, r) => { const list = map.get(k); if (list) list.push(r); else map.set(k, [r]) }
  for (const rate of rates || []) {
    const parts = nameParts(rate.material_name)
    add(byKey, rate.material_key, { rate, parts })
    for (const head of new Set(parts.words.map((w) => w.slice(0, 4)))) add(byHead, head, { rate, parts })
  }
  return { byKey, byHead }
}
// Цены для одной позиции: то же наименование первым, затем похожие (тот же порог, что у базы), новые выше. Каждая: { rate,
// sameName, spelled, cubic, converted }:
//  • spelled — ед. изм. та же, записана иначе («т» и «тн», «комп» и «компл»): цена как есть;
//  • cubic — { area, thickness }: в позиции написано м2, а объём равен площади соседней позиции × толщину, то есть объём в м3
//    и ошибка в ед. изм. ВОР (27,838 = 278,38 м2 × 0,1 м): цена за м3 как есть, пересчёт на м2 занизил бы итог в 10–20 раз;
//  • converted — { price, pack }: пересчёт по docPack (км и м, т и кг, м3 и м2 через толщину).
export function otherUnitPrices(position, index, siblings = []) {
  if (!index || position.units || !position.unit) return []
  const u = normUnit(position.unit)
  const parts = nameParts(position.name)
  const seen = new Set()
  const out = []
  const push = ({ rate }, sameName) => {
    if (seen.has(rate.id) || normUnit(rate.unit) === u) return
    seen.add(rate.id)
    const spelled = canonUnit(rate.unit) === canonUnit(position.unit)
    let cubic = null
    const t = thicknessM(position.name)
    if (!spelled && canonUnit(position.unit) === 'м2' && canonUnit(rate.unit) === 'м3' && t && position.volume > 0) {
      // Площадь — соседняя позиция в м2, ближайшая к объём ÷ толщина (сверху — запас до 25 %).
      const ratio = (s) => position.volume / (s.volume * t)
      const area = siblings.filter((s) => s !== position && canonUnit(s.unit) === 'м2' && s.volume > 0 && ratio(s) >= 0.95 && ratio(s) <= 1.25)
        .sort((a, b) => Math.abs(ratio(a) - 1) - Math.abs(ratio(b) - 1))[0]
      if (area) cubic = { area: Number(area.volume), thickness: t }
    }
    const pack = spelled || cubic ? null : docPack({ name: rate.material_name, unit: rate.unit }, position.unit, position.name)
    out.push({ rate, sameName, spelled, cubic, converted: pack ? { price: roundMoney(rate.price / pack), pack } : null })
  }
  for (const x of index.byKey.get(position.k) || []) push(x, true)
  const tried = new Set()
  for (const head of new Set(parts.words.map((w) => w.slice(0, 4)))) {
    for (const x of index.byHead.get(head) || []) {
      if (tried.has(x.rate.id)) continue
      tried.add(x.rate.id)
      if (isSimilar(parts, x.parts)) push(x, false)
    }
  }
  const newer2 = (p, q) => String(q.rate.price_date || '').localeCompare(String(p.rate.price_date || ''))
  return out.sort((p, q) => Number(q.sameName) - Number(p.sameName) || newer2(p, q)).slice(0, OTHER_UNIT_LIMIT)
}

// Своя цена позиции не похожа на цены документов: { kind: 'pack', offer } — совпала с ценой упаковки или бухты («16 764,53 за
// метр» при бухте 305 м); { kind: 'far', offer, times } — в 5 и больше раз от цены с тем же наименованием или артикулом.
// offers — цены поставщиков позиции (offerMatches: { line, pack, unitOk, exact, picked, article }). Иначе null.
export function suspectPrice(own, offers) {
  if (!(own > 0) || !offers?.length) return null
  for (const o of offers) {
    if (o.pack > 1 && Math.abs(own / o.line.price - 1) <= SAME_AS_PACK) return { kind: 'pack', offer: o }
  }
  const sure = offers.filter((o) => isSure(o) && o.unitOk && !o.line.sumOff)
  if (!sure.length) return null
  const nearest = [...sure].sort((a, b) => Math.abs(offerPrice(a) - own) - Math.abs(offerPrice(b) - own))[0]
  const p = offerPrice(nearest)
  const times = own > p ? own / p : p / own
  return times >= FAR_FROM ? { kind: 'far', offer: nearest, times: Math.round(times), higher: own > p } : null
}
