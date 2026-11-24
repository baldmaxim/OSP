// Автовыбор цен по документам всего тендера: счета и КП прикрепляют к тендеру целиком, а не к позициям, расценка сама
// находит каждой позиции ВОР цену. Только решения, без запросов: панель даёт документы и что сейчас в расценке, окно
// показывает выбор и пишет цены по одному нажатию (каждую цену человек видит и может снять).
//
// Какая цена (решения пользователя 05.11.2026). Внутри документа одна позиция — одной строке (utils/supplyDocMatch.matchDocItems),
// выбор человека важнее. Между документами:
//  1) только с подходящей ед. изм. (или понятно, сколько её в упаковке, и после пересчёта количество похоже на объём ВОР),
//     цена × количество сходится с суммой, не в валюте;
//  2) есть та же позиция (то же наименование, артикул, выбрано человеком, похожа от 90 %) — из самого свежего документа: новая цена
//     заменяет прежнюю сама; иначе — самая похожая строка, при равной похожести — из более свежего документа. Дешёвый аналог
//     не перебивает ту же позицию.
// Что показывать (18.11.2026, решения пользователя: «цены, выставленные вручную, должны иметь приоритет», окно — по группам). Цена
// уже стоит правильно — строки нет. Остальные строки — четырьмя блоками по тому, что цена заменит (replacedBy):
//  • не расценены — позиции без цены;
//  • подставленные автоматически — цена другого тендера, которую расценка поставила сама (supply_autofill, source_kind auto);
//    видно, из какого тендера;
//  • цены из документов — своя цена совпадает с ценой строки документа (файл документа позиции или любой документ тендера), в том
//    числе с другим НДС: человек поменял НДС у уже применённого документа — цена «из этого же документа» предлагается заново и
//    отмечена;
//  • введённые вручную — своя цена не из документов, взятая из меню похожих цен другого тендера, загруженная из Excel: такая
//    строка показывается, только если в документе та же позиция (или цена похожа на ошибку), и сама НЕ отмечается никогда.
// Документ, у которого итог не сошёлся со строками (часть строк могла прочитаться неверно, тендер № 546: 223 506 496 ₽ за
// торшер), и строка дороже итога всего документа сами не отмечаются. Одна и та же цена из двух документов (тот же файл загрузили
// дважды) — одна строка (dedupeOffers), одинаковые документы целиком — uniqueOfferDocs.
import { roundMoney } from './money.js'
import { AUTO_MIN, SAME_POSITION_MIN, groupUnitOk, lineManualPack, linePack, lineSameAsGroup, matchDocItems, matchIndex, pickedGroups, offerPrice, packQtyFar, thicknessM, docPack } from './supplyDocMatch.js'
import { canonUnit, isSimilar, nameParts, normUnit } from './supplySimilarity.js'
import { normName } from './supplyRateHelpers.js'

const SPREAD = 3
// Своя цена позиции подозрительна: совпала с ценой упаковки в документе или в FAR_FROM раз и больше от надёжных цен.
const SAME_AS_PACK = 0.03
const FAR_FROM = 5

export const isSure = (o) => o.exact || o.picked || o.article || o.same
// Дата документа: из него самого, иначе день загрузки файла. Дата дальше месяца вперёд — прочитана неверно (у копий спецификаций
// ЭТМ тендера № 704 — 2054 год, такой документ был бы «самым свежим» всегда): день загрузки.
const FUTURE_DAYS = 31
export function offerDate(offer, doc, today = new Date()) {
  const latest = new Date(today.getTime() + FUTURE_DAYS * 86400000).toISOString().slice(0, 10)
  const own = offer?.date && offer.date <= latest ? offer.date : null
  return own || String(doc?.created_at || '').slice(0, 10) || null
}
const DEFAULT_VAT = 22
// Строка дороже итога всего документа (с запасом на НДС сверху) — прочитана неверно: так склеивались две цены одной ячейки.
const OVER_TOTAL = 1.25
// Что известно о документе для его строк: ставка НДС (цены строки с другим НДС — чтобы узнать «цену из этого документа» после
// смены НДС), итог сошёлся ли, со скана ли.
const docInfo = (offer) => ({
  vatK: 1 + (offer.vat?.rate ?? DEFAULT_VAT) / 100,
  docOk: !offer.total || offer.total.ok !== false,
  total: offer.total?.doc > 0 ? offer.total.doc : null,
  ocr: !!offer.ocr,
})
const entry = (doc, date, line, c, info) => {
  const price = roundMoney(line.price / (c.pack || 1))
  return {
    id: `${doc.id}:${line.name}:${c.group.key}`, doc, date, line, group: c.group, exact: !!c.exact, picked: !!c.picked, article: !!c.article,
    score: c.score ?? 1, same: (c.score ?? 1) >= SAME_POSITION_MIN && lineSameAsGroup(line, c.group),
    pack: c.pack ?? null, unitOk: c.unitOk, price,
    alts: [roundMoney(price * info.vatK), roundMoney(price / info.vatK)],
    qtyFar: lineManualPack(line, c.group) == null && packQtyFar(line, c.group, c.pack),
    docOk: info.docOk, ocr: info.ocr,
    over: !!info.total && line.price * Math.max(1, Number(line.qty) || 1) > info.total * OVER_TOTAL,
  }
}

// Документы тендера → по позициям. docs — [{ doc, offer }] (строки в notes файла; цены в валюте ждут курса и сюда не идут).
// Ответ — Map ключ группы → цены документов [{ id, doc, date, line, group, exact, picked, article, score, pack, unitOk, price }].
// Дата документа — из него самого, иначе день загрузки файла. index — готовый указатель групп (supplyDocMatch.sharedMatchIndex:
// строки, уже сопоставленные таблицей, второй раз не ищутся).
export function offersByGroup(docs, groups, given = null) {
  const index = given || matchIndex(groups)
  const out = new Map()
  const put = (e) => {
    const list = out.get(e.group.key)
    if (list) list.push(e)
    else out.set(e.group.key, [e])
  }
  for (const { doc, offer } of docs || []) {
    if (offer.currency) continue
    const date = offerDate(offer, doc)
    const info = docInfo(offer)
    const taken = new Set()
    for (const line of offer.lines) {
      if (line.skip || !line.k) continue
      for (const g of pickedGroups(line, index)) {
        const pack = g.units ? null : linePack(line, g)
        taken.add(g.key)
        put(entry(doc, date, line, { group: g, picked: true, pack, unitOk: pack != null || groupUnitOk(line.unit, g) }, info))
      }
    }
    const free = offer.lines.filter((l) => !l.skip && !l.k)
    for (const m of matchDocItems(free, groups, { packs: true, index })) {
      for (const c of m.match ? [m.match, ...m.also] : []) {
        if (!taken.has(c.group.key)) put(entry(doc, date, m.item, c, info))
      }
    }
  }
  for (const [key, list] of out) out.set(key, dedupeOffers(list))
  return out
}

// Одна и та же цена позиции из разных документов (тот же счёт загрузили дважды, КП и счёт одного поставщика) — одна: выбранная
// человеком, иначе из более свежего документа; у неё twins — остальные документы с этой ценой (показать «также в …»).
const lineSign = (o) => `${normName(o.line.name)}|${canonUnit(o.line.unit)}|${o.price}`
export function dedupeOffers(list) {
  if (list.length < 2) return list
  const order = [...list].sort((a, b) => Number(b.picked) - Number(a.picked) || newer(a, b)
    || String(b.doc.created_at || '').localeCompare(String(a.doc.created_at || '')))
  const kept = new Map()
  for (const o of order) {
    const sign = lineSign(o)
    const first = kept.get(sign)
    if (!first) kept.set(sign, { ...o, twins: [] })
    else if (first.doc.id !== o.doc.id && !first.twins.some((d) => d.id === o.doc.id)) first.twins.push(o.doc)
  }
  return list.map((o) => kept.get(lineSign(o))).filter((o, i, all) => all.indexOf(o) === i)
}

// Документы с одинаковыми строками (тот же счёт загрузили дважды — в тендере № 704 так семь спецификаций ЭТМ, у копий другой размер
// файла): цены считаются один раз. Остаётся тот, у которого больше выбора человека (выбранные и отвергнутые строки, пересчёт,
// убранные позиции), при равных — документ позиций (weightOf), затем более ранний. Ответ: { docs, dupes: [{ doc, of }] }.
const docSign = (offer) => `${offer.currency || ''}#` + offer.lines
  .map((l) => `${normName(l.name)}|${canonUnit(l.unit)}|${l.docPrice ?? l.price}|${l.qty ?? ''}`).sort().join('\n')
const humanMarks = (offer) => offer.lines.reduce((n, l) => n + (l.k ? 1 : 0) + (l.also?.length || 0) + (l.no?.length || 0)
  + (l.packs ? Object.keys(l.packs).length : 0) + (l.skip ? 1 : 0), 0) + (offer.hidden?.length || 0)
export function uniqueOfferDocs(docs, weightOf = () => 0) {
  const groups = new Map()
  for (const x of docs || []) {
    if (!x.offer?.lines?.length) continue
    const sign = docSign(x.offer)
    const list = groups.get(sign)
    if (list) list.push(x)
    else groups.set(sign, [x])
  }
  const dupes = []
  const drop = new Set()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const best = [...list].sort((a, b) => humanMarks(b.offer) - humanMarks(a.offer) || weightOf(b.doc) - weightOf(a.doc)
      || String(a.doc.created_at || '').localeCompare(String(b.doc.created_at || '')))[0]
    for (const x of list) if (x !== best) { drop.add(x); dupes.push({ doc: x.doc, of: best.doc }) }
  }
  return { docs: drop.size ? (docs || []).filter((x) => !drop.has(x)) : (docs || []), dupes }
}

// Сопоставление строк документов с позициями — секунды на больших тендерах (№ 704, 20.11.2026: 2 тыс. строк, 2 тыс. позиций — 2,3 с на
// быстром компьютере), поэтому страница расценки не пересчитывает его, пока документы по сути те же (SupplyPricingPanel).
const sameList = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]))
// Повторы документов (uniqueOfferDocs) те же: те же оставленные документы, те же пары «повтор — оставленный». Вес документа (сколько
// позиций с ним) меняется при каждом «Взять» и «Применить», но решает только, какой из повторов оставить.
export const sameOfferView = (a, b) => sameList(a.docs, b.docs) && a.dupes.length === b.dupes.length
  && a.dupes.every((x, i) => x.doc === b.dupes[i].doc && x.of === b.dupes[i].of)
// Документы для сопоставления ([{ doc, offer }]) те же: тот же файл, те же объекты строк (keepSameLines) и то, что сопоставление
// читает у документа (offersByGroup, docInfo, offerDate). Убранные из окна позиции (offer.hidden) цен не меняют: «Убрать
// неотмеченные» у 24 документов (24.11.2026) пересчитывало сопоставление всех строк с позициями по разу на каждый документ.
const sameJson = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const sameForMatch = (a, b) => a === b || (a.currency === b.currency && a.date === b.date && a.ocr === b.ocr
  && sameJson(a.vat, b.vat) && sameJson(a.total, b.total) && sameList(a.lines, b.lines))
export const sameMatchDocs = (a, b) => a === b || (!!a && !!b && a.length === b.length
  && a.every((x, i) => x.doc === b[i].doc && sameForMatch(x.offer, b[i].offer)))
// Документы, перечитанные из базы ([{ doc, offer, notes }], возврат на вкладку браузера): тот же файл с теми же строками (notes —
// строкой, как в базе) — прежняя запись; ничего не изменилось — прежний список. Запись без notes (не из базы) заменяется.
export function keepSameOffers(prev, next) {
  if (!prev) return next
  const byId = new Map(prev.map((x) => [x.doc.id, x]))
  const out = next.map((x) => {
    const was = byId.get(x.doc.id)
    if (!was) return x
    if (was.notes != null && was.notes === x.notes && JSON.stringify(was.doc) === JSON.stringify(x.doc)) return was
    // Файл правили (выбор в окне у коллеги): неизменённые строки — прежние объекты.
    const offer = keepSameLines(x.offer, was.offer)
    return offer === x.offer ? x : { ...x, offer }
  })
  return sameList(prev, out) ? prev : out
}

// Строки документа после правки (выбор строки в окне, НДС документа, правка коллеги): строка, которая не изменилась, — прежний
// объект. Позиции для строки запоминаются по объекту (supplyDocMatch.sharedMatchIndex) — иначе каждый выбор в окне заново искал бы
// позиции для всех строк файла (у прайса — сотни). Одинаковые строки остаются разными объектами, как были.
export function keepSameLines(next, prev) {
  if (!next?.lines?.length || !prev?.lines?.length || next === prev) return next
  const pool = new Map()
  for (const l of prev.lines) {
    const sign = JSON.stringify(l)
    const list = pool.get(sign)
    if (list) list.push(l)
    else pool.set(sign, [l])
  }
  let kept = 0
  const lines = next.lines.map((l) => {
    const old = pool.get(JSON.stringify(l))?.shift()
    if (!old) return l
    kept += 1
    return old
  })
  return kept ? { ...next, lines } : next
}

// Позиция, убранная из окна у документа (13.11.2026, просьба пользователя: «разом убрать позиции, которые я не захотел
// расценивать, чтобы они не мешались с ценами нового документа»). Ключи — группы и всех сложенных в неё записей: так убранное
// остаётся убранным, если человек разделит или сложит записи. Убрано при файле (notes, xh): новый документ предлагает эти позиции
// заново — убранное касается только цен тех документов, которые были в окне.
export const groupHideKeys = (g) => [g.key, ...(g.sameAs || []).map((s) => s.key)]
const hiddenIn = (set, g) => !!set && groupHideKeys(g).some((k) => set.has(k))

// Цены окна «Счета и КП тендера»: byGroup (offersByGroup) без убранных человеком и только документов docIds (Set; null — всех).
// Ответ: { byGroup, hidden } — hidden: у скольких позиций убрана хоть одна цена выбранных документов (их можно вернуть).
export function windowOffers(byGroup, docs, docIds = null) {
  const hiddenByDoc = new Map()
  for (const { doc, offer } of docs || []) if (offer?.hidden?.length) hiddenByDoc.set(doc.id, new Set(offer.hidden))
  if (!hiddenByDoc.size && !docIds) return { byGroup, hidden: 0 }
  const out = new Map()
  let hidden = 0
  for (const [key, list] of byGroup) {
    // Та же цена из выбранного документа могла остаться у другого (dedupeOffers): показывается от имени выбранного.
    const inView = docIds ? list.flatMap((o) => {
      if (docIds.has(o.doc.id)) return [o]
      const twin = (o.twins || []).find((d) => docIds.has(d.id))
      return twin ? [{ ...o, doc: twin, twins: [o.doc, ...o.twins.filter((d) => d !== twin)] }] : []
    }) : list
    if (!inView.length) continue
    const keep = hiddenByDoc.size ? inView.filter((o) => !hiddenIn(hiddenByDoc.get(o.doc.id), o.group)) : inView
    if (keep.length < inView.length) hidden += 1
    if (keep.length) out.set(key, keep)
  }
  return { byGroup: out, hidden }
}
// Позиция убрана у документа (docs — [{ doc, offer }]).
export const isHiddenAt = (docs, docId, group) => {
  const offer = (docs || []).find((x) => x.doc.id === docId)?.offer
  return !!offer?.hidden?.length && hiddenIn(new Set(offer.hidden), group)
}
// Убрать позиции строк окна: какие ключи дописать каким документам — Map id документа → ключи. Убираются цены всех документов
// окна у позиции (rows — строки autoPickRows, offers — уже только документов окна): иначе на месте убранной цены всплыла бы
// цена другого документа.
export function hideKeysByDoc(rows) {
  const out = new Map()
  for (const r of rows) {
    for (const o of r.offers) {
      for (const doc of [o.doc, ...(o.twins || [])]) {
        const keys = out.get(doc.id) || new Set()
        for (const k of groupHideKeys(r.group)) keys.add(k)
        out.set(doc.id, keys)
      }
    }
  }
  return out
}

const newer = (a, b) => String(b.date || '').localeCompare(String(a.date || ''))
const bySimilarity = (a, b) => Number(isSure(b)) - Number(isSure(a)) || b.score - a.score || newer(a, b) || a.price - b.price
// Цифры строки со скана не сошлись между собой (unsure) — как цена × кол-во ≠ сумма: видно, но сама не берётся.
const usable = (o) => o.unitOk && o.price > 0 && !o.line.sumOff && !o.line.unsure && !o.qtyFar && !o.over

// Цена для позиции (см. начало файла) или null.
export function bestOffer(offers) {
  const list = (offers || []).filter(usable)
  const sure = list.filter(isSure)
  if (sure.length) return [...sure].sort((a, b) => newer(a, b) || Number(b.picked) - Number(a.picked) || b.score - a.score || a.price - b.price)[0]
  return [...list].sort(bySimilarity)[0] || null
}

// Что сейчас в расценке против новой цены: своя другая цена — { kind: 'replace', prices }; цена из другого тендера — 'copy'; пусто
// хотя бы где-то — 'new'; везде та же — 'same'. cur — { own: [цены], copies, empty, ownAt } (ownAt — последняя правка своей цены).
export function priceStatus(cur, price) {
  const targets = Array.isArray(cur.targets) ? cur.targets : null
  const own = cur.own || (targets || []).filter((t) => t.kind === 'own').map((t) => t.price)
  const copies = cur.copies ?? (targets || []).filter((t) => t.kind === 'auto' || t.kind === 'pick').length
  const empty = cur.empty ?? (targets || []).filter((t) => t.kind === 'empty').length
  const differ = [...new Set(own.map(roundMoney).filter((p) => p !== price))]
  if (differ.length) return { kind: 'replace', prices: differ }
  return copies ? { kind: 'copy' } : empty ? { kind: 'new' } : { kind: 'same' }
}

// Блоки окна: что заменит цена строки. Порядок — как в окне; введённые вручную — последними и сами не отмечаются.
export const PICK_BLOCKS = [
  { key: 'empty', title: 'Не расценены' },
  { key: 'auto', title: 'Заменят цены, подставленные автоматически' },
  { key: 'doc', title: 'Заменят цены из документов' },
  { key: 'manual', title: 'Заменят цены, введённые вручную' },
]
const BLOCK_RANK = { empty: 0, auto: 1, doc: 2, manual: 3 }
// Позиции группы сейчас: [{ kind: 'empty' | 'auto' | 'pick' | 'own', price, input, docId, origin }] (панель — currentOf.targets);
// прежний вид ({ own, copies, empty }) — тоже понимаем.
function targetsOf(cur) {
  if (Array.isArray(cur.targets)) return cur.targets
  return [
    ...(cur.own || []).map((price) => ({ kind: 'own', price })),
    ...Array.from({ length: cur.copies || 0 }, () => ({ kind: 'auto', price: null })),
    ...Array.from({ length: cur.empty || 0 }, () => ({ kind: 'empty', price: null })),
  ]
}
const near = (a, b) => a != null && b != null && Math.abs(roundMoney(a) - roundMoney(b)) <= 0.011
const pricesOf = (o) => [o.price, ...(o.alts || [])]
// Документ, из которого своя цена: только файл документа позиции (его прикрепляет «Применить» и «Взять»), и только если цена
// совпала с его строкой — как есть или с другим НДС. Совпала с ценой другого файла — всё равно ручная: человек мог ввести ту же
// цену (тендер № 860, 13.11: ручные правки совпадали с ценами «ВОР для заполнения» и снова отметились бы сами). Та же цена,
// оставленная у другого документа (dedupeOffers), — тоже этот файл.
export function offerOfPrice(t, all) {
  if (t.docId == null) return null
  const isFile = (o) => o.doc.id === t.docId || (o.twins || []).some((d) => d.id === t.docId)
  return all.find((o) => isFile(o) && pricesOf(o).some((p) => near(p, t.price))) || null
}
// Что заменит цена price у позиций группы: { block, items: [{ kind: 'empty' | 'auto' | 'doc' | 'manual', price, how, origin,
// offer }] } — только позиции, где цена другая или её нет. how у введённых вручную: 'typed' | 'pick' (взята из меню похожих
// цен другого тендера) | 'import' (загружена из Excel). all — цены всех документов этой позиции (и убранные из окна).
export function replacedBy(cur, price, all) {
  const items = []
  for (const t of targetsOf(cur)) {
    if (t.kind === 'empty') { items.push({ kind: 'empty', price: null }); continue }
    if (t.price != null && near(t.price, price)) continue
    if (t.kind === 'auto') items.push({ kind: 'auto', price: t.price, origin: t.origin || null })
    else if (t.kind === 'pick') items.push({ kind: 'manual', how: 'pick', price: t.price, origin: t.origin || null })
    else if (t.input === 'import') items.push({ kind: 'manual', how: 'import', price: t.price })
    else {
      const offer = offerOfPrice(t, all || [])
      items.push(offer ? { kind: 'doc', price: t.price, offer } : { kind: 'manual', how: 'typed', price: t.price })
    }
  }
  const block = items.reduce((b, x) => (BLOCK_RANK[x.kind] > BLOCK_RANK[b] ? x.kind : b), 'empty')
  return { block, items }
}

// Строки окна — только те, где человеку есть что решать: { group, offers, choice, shown, spread, sure, status, wrong, auto, check,
// block, replaced, sameDoc }. offers — цены позиции, самые похожие первыми; choice — выбранная цена или null (ни одну нельзя взять
// как есть); shown — что показать (choice или самая похожая); auto — отметить сразу; check — проверить глазами: похоже не наверняка,
// ед. изм., разброс цен, итог документа не сошёлся; block — блок окна (PICK_BLOCKS), replaced — что заменится (replacedBy.items),
// sameDoc — заменится цена из этого же документа (другой НДС, пересчёт). chosen — Map ключ группы → id цены, выбранной человеком;
// currentOf(group) — что сейчас в расценке; allByGroup — цены всех документов (узнать документ своей цены, когда окно показывает
// один документ). hidden — сколько позиций с ценами из документов не показано: цена уже стоит правильно; held — из них те, где стоит
// другая цена, а строка документа похожа не наверняка (не та же позиция, не тот же артикул): окно говорит о них, а не «цены уже
// стоят» (24.11.2026, тендер № 704: счёт с четырьмя позициями — «ставить больше нечего», хотя три цены были другими).
export function autoPickRows(byGroup, groups, { chosen = null, currentOf, allByGroup = null }) {
  const rows = []
  let hidden = 0
  let held = 0
  for (const group of groups) {
    const offers = byGroup.get(group.key)
    if (!offers?.length) continue
    const sorted = [...offers].sort(bySimilarity)
    const picked = chosen?.get(group.key)
    const byPerson = picked ? offers.find((o) => o.id === picked) || null : null
    const choice = byPerson || bestOffer(offers)
    const shown = choice || sorted[0]
    const cur = currentOf(group)
    const status = priceStatus(cur, shown.price)
    const { block, items } = replacedBy(cur, shown.price, allByGroup?.get(group.key) || offers)
    if (!items.length) { hidden += 1; continue }
    const sure = isSure(shown)
    const wrong = items.some((x) => (x.kind === 'doc' || x.kind === 'manual') && suspectPrice(roundMoney(x.price), offers))
    const docItems = items.filter((x) => x.kind === 'doc')
    const sameDoc = docItems.length > 0 && docItems.every((x) => x.offer.doc.id === shown.doc.id)
    // Документ позиции новее (по дате документа) того, из которого стоит цена.
    const fresher = docItems.every((x) => !x.offer.date || !shown.date || shown.date >= x.offer.date)
    const show = block === 'empty' || block === 'auto' ? true
      : block === 'doc' ? !!byPerson || sameDoc || sure || wrong
        : !!byPerson || sure || wrong
    if (!show) { hidden += 1; held += 1; continue }
    const sureOthers = offers.filter((o) => usable(o) && isSure(o)).map((o) => o.price)
    const prices = sure && usable(shown) ? [shown.price, ...sureOthers] : []
    const times = prices.length > 1 ? Math.max(...prices) / Math.min(...prices) : 1
    const spread = times >= SPREAD ? Math.round(times) : null
    const ready = !!choice && !spread && shown.docOk !== false
    const auto = byPerson ? !!byPerson.unitOk
      : block === 'manual' ? false
        : block === 'doc' ? ready && (sameDoc || (sure && fresher))
          : ready && (sure || choice.score >= AUTO_MIN)
    rows.push({ group, offers: sorted, choice, shown, spread, sure, status, wrong, auto, check: !choice || !sure || !!spread || shown.docOk === false,
      block, replaced: items, sameDoc })
  }
  const order = (r) => BLOCK_RANK[r.block] * 2 + (r.check ? 0 : 1)
  rows.sort((a, b) => order(a) - order(b))
  return { rows, hidden, held }
}

// Строки документов, которым не нашлась позиция ВОР: [{ doc, line }]. Цены в валюте ждут курса и сюда не идут.
export function unplacedLines(docs, byGroup) {
  const used = new Set()
  for (const list of byGroup.values()) for (const o of list) used.add(o.line)
  const out = []
  for (const { doc, offer } of docs || []) {
    if (offer.currency) continue
    for (const line of offer.lines) if (!line.skip && !used.has(line)) out.push({ doc, line })
  }
  return out
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
  const sure = offers.filter((o) => isSure(o) && o.unitOk && !o.line.sumOff && !o.line.unsure)
  if (!sure.length) return null
  const nearest = [...sure].sort((a, b) => Math.abs(offerPrice(a) - own) - Math.abs(offerPrice(b) - own))[0]
  const p = offerPrice(nearest)
  const times = own > p ? own / p : p / own
  return times >= FAR_FROM ? { kind: 'far', offer: nearest, times: Math.round(times), higher: own > p } : null
}
