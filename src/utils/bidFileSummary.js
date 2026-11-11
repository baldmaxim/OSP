// Свой ВОР подрядчика с расценками → сводка сумм ведомости (миграция 20270113, решение пользователя 11.11.2026).
//
// Новый разбор не пишется: цены читает тот же код, что «Цены из файла» кабинета и счета / КП снабжения (readBidPriceDoc: заполненный
// ВОР — листы «Материалы» / «Работы» со своим видом, иначе таблица «наименование + цена / сумма» любого листа или PDF), сопоставление с
// позициями ведомости — тот же расчёт (matchBidItems: сначала точно по наименованию, затем самые похожие; строки листа «Материалы» —
// только среди материалов, «Работы» — среди работ; одна позиция — одной строке).
//
// Сумма позиции — цена файла × объём ведомости отдела (подрядчик мог поправить объём у себя; так же считала расценка на сайте), сумма
// ведомости — материалы и работы. НДС: цена с НДС, как в ВОР; документ сказал «без НДС» — НДС сверху (ставка из документа, иначе из
// анкеты, иначе 22 %); подрядчик без НДС — цены как есть.
import { readBidPriceDoc, bidGroups, matchBidItems } from './bidImport.js'
import { unitPriceWithVat, DEFAULT_VAT_RATE } from './supplierDoc.js'
import { roundMoney2 } from './bidVor.js'

export function bidFileVat(doc, ownVat = null) {
  if (ownVat?.exempt) return { mode: 'gross', force: true, rate: 0, exempt: true }
  return { ...(doc?.vat || {}), rate: doc?.vat?.rate ?? ownVat?.rate ?? DEFAULT_VAT_RATE }
}

// doc — ответ readBidPriceDoc, positions — позиции ведомости ([...materials, ...works] разбора ВОР), ownVat — ставка из анкеты.
// → { v, materials, works, total, items, priced, rows, unmatched, vat, rate, sheet? } | { v, error }.
export function summarizeBidFile(doc, positions, ownVat = null) {
  if (!doc || doc.error) return { v: 1, error: doc?.error || 'broken' }
  if (!positions?.length) return { v: 1, error: 'no_vor', rows: doc.items?.length || 0 }
  const vat = bidFileVat(doc, ownVat)
  const prices = new Map()
  let unmatched = 0
  matchBidItems(doc.items, bidGroups(positions)).forEach((m, i) => {
    if (!m?.match) { unmatched += 1; return }
    const price = unitPriceWithVat(doc.items[i], vat)
    if (price != null && Number.isFinite(price) && price >= 0) prices.set(m.match.group.key, roundMoney2(price))
  })
  const out = { v: 1, materials: 0, works: 0, items: { material: 0, work: 0 }, priced: { material: 0, work: 0 } }
  for (const p of positions) {
    const kind = p.kind === 'work' ? 'work' : 'material'
    out.items[kind] += 1
    const price = prices.get(p.key)
    if (price == null) continue
    out.priced[kind] += 1
    if (p.volume != null && Number.isFinite(Number(p.volume))) out[kind === 'work' ? 'works' : 'materials'] += price * Number(p.volume)
  }
  out.materials = roundMoney2(out.materials)
  out.works = roundMoney2(out.works)
  out.total = roundMoney2(out.materials + out.works)
  out.rows = doc.items.length
  out.unmatched = unmatched
  out.vat = vat.exempt ? 'exempt' : doc.vat?.mode === 'net' ? 'net' : 'gross'
  out.rate = vat.exempt ? 0 : vat.rate
  if (doc.sheetName) out.sheet = String(doc.sheetName).slice(0, 200)
  if (!out.priced.material && !out.priced.work) out.error = 'no_prices'
  return out
}

// Файл с компьютера → сводка по ведомости. positions — как выше.
export async function readBidFileSummary(file, positions, ownVat = null) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return summarizeBidFile(await readBidPriceDoc(bytes, file.name), positions, ownVat)
}
