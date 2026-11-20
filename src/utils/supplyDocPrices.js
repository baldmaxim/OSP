// Цены, поставленные из файла счёта или КП, — чтобы снять их вместе с файлом или после его удаления (19.11.2026, просьба
// пользователя: «когда убираю счёт, как снять цены, которые из него проставлялись»). Только решения, без запросов.
//
// Цена «из файла» — то же правило, что у блока «Заменят цены из документов» окна «Счета и КП» (utils/supplyAutoPick.offerOfPrice):
// файл — документ позиции (его прикрепляют «Применить» и «Взять»), цена своя (не копия другого тендера и не из Excel) и совпала
// с его строкой — как есть или с другим НДС. Файл приложен к позиции, а цену ввели сами — цена ручная, её не трогаем.
//
// Связь цены с файлом живёт только в документе позиции (tender_supply_links.s3_document_id) и пропадает вместе с файлом,
// поэтому перед удалением файла его цены записываются следом (tender_supply_removed_docs, миграция 20270223): цена за единицу
// на момент удаления. След жив, пока цену не трогали: она та же, своя, и у позиции не появился другой документ.
import { roundMoney } from './money.js'
import { offerOfPrice } from './supplyAutoPick.js'
import { rateUnitPrice } from './supplyRateHelpers.js'

const near = (a, b) => a != null && b != null && Math.abs(roundMoney(a) - roundMoney(b)) <= 0.011

// Позиции, чья цена поставлена из файла docId. groups — позиции тендера (positionGroups / mergeSamePositions); byGroup — цены
// всех документов по позициям (offersByGroup; убранное из окна тоже считается); at(target) → { key, rate, docId } — цена позиции
// и файл её документа, как он записан у позиции (не «оставленный повтор»). Повтор документа (uniqueOfferDocs) своих строк не
// показывает — у него цен нет: те же строки остаются у оставленного файла. Ответ — [{ key, rate, price, name, estimate, unit }].
export function pricesOfDoc(docId, groups, byGroup, at) {
  const out = []
  const seen = new Set()
  for (const g of groups || []) {
    const all = byGroup?.get(g.key) || []
    if (!all.length) continue
    for (const t of g.targets || []) {
      const cur = at(t)
      if (!cur || cur.docId !== docId || !cur.rate || seen.has(cur.key)) continue
      seen.add(cur.key)
      const r = cur.rate
      if (r.source_kind || r.price_input === 'import') continue
      const price = rateUnitPrice(r)
      if (offerOfPrice({ docId, price }, all)) {
        out.push({ key: cur.key, rate: r, price, name: t.position.name, estimate: t.doc, unit: t.position.unit || r.unit || null })
      }
    }
  }
  return out
}

// Цену после удаления файла не трогали: та же цена за единицу и она своя.
export const tracePriceSame = (trace, rate) => !!rate && !rate.source_kind && near(rateUnitPrice(rate), Number(trace.price))

// Удалённые файлы, чьи цены ещё стоят. traces — строки tender_supply_removed_docs; rateById — Map id → цена расценки;
// hasDoc(rate) — у позиции уже есть документ (цена теперь от него); alive — Set id файлов, которые у тендера есть (файл не
// удалился — след не считается). Ответ — [{ docId, name, at, rows: [{ trace, rate }] }], недавно удалённые первыми.
export function removedDocPrices(traces, rateById, { hasDoc = () => false, alive = null } = {}) {
  const byDoc = new Map()
  for (const t of traces || []) {
    if (alive?.has(t.doc_id)) continue
    const rate = rateById.get(t.rate_id)
    if (!tracePriceSame(t, rate) || hasDoc(rate)) continue
    let d = byDoc.get(t.doc_id)
    if (!d) {
      d = { docId: t.doc_id, name: t.doc_name, at: t.removed_at || '', rows: [] }
      byDoc.set(t.doc_id, d)
    }
    if (String(t.removed_at || '') > d.at) d.at = t.removed_at
    d.rows.push({ trace: t, rate })
  }
  return [...byDoc.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.name).localeCompare(String(b.name), 'ru'))
}
