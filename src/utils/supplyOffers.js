// Цены документа поставщика «в похожие цены» (29.10.2026, без миграции): распознанные строки счёта / КП хранятся
// вместе с файлом — JSON в s3_documents.notes (как паспорт ДГП), файл — документ поставщика основного тендера
// (doc_category supply_doc). Расценка читает строки всех таких файлов тендера и показывает их у похожих позиций ВОР
// («похожие цены», «цены поставщиков»); «Взять» ставит цену и прикладывает файл документом позиции. Удалили файл —
// пропали и его цены. Только разбор и запись JSON, без запросов.
//
// Строка: n — наименование, u — ед. изм., q — количество, c — артикул, p — цена в расценку за единицу (с НДС и
// доставкой, как её посчитало окно), d / dv — цена в документе и её НДС ('net' | 'gross' | null), k — позиция,
// выбранная в окне (ключ наименования normName), x — 1, если в окне выбрали «не сопоставлять».
import { roundMoney } from './money.js'

export const OFFER_KIND = 'supply_offer'
export const OFFER_VERSION = 1
// Больше строк в одном документе не храним (счёт на тысячи строк — уже не документ к позициям); наименование —
// не длиннее NAME_MAX. Так notes даже в худшем случае (кириллица — 2 байта) меньше 1 МБ: запрос записи файла в
// osp-api ограничен 2 МБ (BODY_LIMIT).
export const OFFER_LINES_MAX = 1500
const NAME_MAX = 250

const text = (v, max = NAME_MAX) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// JSON для notes. lines — [{ name, unit, qty, code, price, docPrice, docVat, k, skip }]; строки без цены не
// хранятся. source — 'pdf' | 'sheet'; vat — { mode, rate } (как посчитаны цены); delivery — множитель доставки.
export function offerNotes({ source = null, vat = null, delivery = 1, lines }) {
  const out = []
  for (const l of lines || []) {
    const p = num(l.price)
    const n = text(l.name)
    if (!n || p == null || p <= 0) continue
    const row = { n, p: roundMoney(p) }
    const u = text(l.unit, 40)
    if (u) row.u = u
    if (num(l.qty) != null) row.q = num(l.qty)
    const c = text(l.code, 80)
    if (c) row.c = c
    if (num(l.docPrice) != null) row.d = roundMoney(num(l.docPrice))
    if (l.docVat === 'net' || l.docVat === 'gross') row.dv = l.docVat
    if (l.k) row.k = String(l.k)
    if (l.skip) row.x = 1
    out.push(row)
    if (out.length >= OFFER_LINES_MAX) break
  }
  return JSON.stringify({
    kind: OFFER_KIND, v: OFFER_VERSION, at: new Date().toISOString(), source,
    vat: vat ? { mode: vat.mode || null, rate: num(vat.rate) } : null,
    delivery: num(delivery) && num(delivery) > 1 ? Math.round(num(delivery) * 10000) / 10000 : 1,
    lines: out,
  })
}

// notes файла → { at, source, vat, delivery, lines: [{ name, unit, qty, code, price, docPrice, docVat, k, skip }] }
// или null (не документ «в похожие цены», испорченный JSON, другая версия).
export function readOffer(notes) {
  if (!notes || typeof notes !== 'string' || !notes.includes(OFFER_KIND)) return null
  let o
  try {
    o = JSON.parse(notes)
  } catch {
    return null
  }
  if (!o || o.kind !== OFFER_KIND || o.v !== OFFER_VERSION || !Array.isArray(o.lines)) return null
  const lines = []
  for (const r of o.lines) {
    const name = text(r?.n)
    const price = num(r?.p)
    if (!name || price == null || price <= 0) continue
    lines.push({
      name, price, unit: text(r.u, 40), qty: num(r.q), code: text(r.c, 80), docPrice: num(r.d),
      docVat: r.dv === 'net' || r.dv === 'gross' ? r.dv : null, k: r.k ? String(r.k) : null, skip: r.x === 1,
    })
  }
  return { at: o.at || null, source: o.source || null, vat: o.vat || null, delivery: num(o.delivery) || 1, lines }
}
