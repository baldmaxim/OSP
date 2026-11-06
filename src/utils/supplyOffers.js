// Цены документа поставщика «в похожие цены» (29.10.2026, без миграции): распознанные строки счёта / КП хранятся
// вместе с файлом — JSON в s3_documents.notes (как паспорт ДГП), файл — документ поставщика основного тендера
// (doc_category supply_doc). Расценка читает строки всех таких файлов тендера и показывает их у похожих позиций ВОР
// («похожие цены», «цены поставщиков»); «Взять» ставит цену и прикладывает файл документом позиции. Удалили файл —
// пропали и его цены. Только разбор и запись JSON, без запросов.
//
// Строка: n — наименование, u — ед. изм., q — количество, c — артикул, p — цена в расценку за единицу документа (с НДС
// и доставкой, как её посчитало окно), d / dv — цена в документе и её НДС ('net' | 'gross' | null), k — позиция,
// выбранная в окне (ключ наименования normName), ka — ещё позиции той же строки, kn — позиции, для которых строку отвергли
// («нет в счетах»), pm — сколько единиц позиции в единице строки, указал человек (ключ наименования → число), x — 1, если
// строку не сопоставлять, so — 1: цена × количество не сходится с суммой, pq — сколько в упаковке. Файл не распознался — вместо
// строк причина (failed): его не скачиваем при каждом открытии расценки. При файле: date — дата документа, currency — цены
// не в рублях, total — сверка с итогом документа { ok, read, doc }, ocr — строки со скана (распознаны, а не прочитаны), rv —
// версия чтения. У строки со скана un — 1, если её цифры не сошлись между собой и цену надо сверить с файлом.
import { roundMoney } from './money.js'

export const OFFER_KIND = 'supply_offer'
export const OFFER_VERSION = 1
// Версия чтения файлов: растёт, когда чтение научилось новому. Файл, отвергнутый прежней версией, читается заново один раз:
// причина записана при файле, и иначе он так и остался бы непрочитанным (тендер № 902: скан — «failed: scan», счёт 1С со
// шапкой в 50-й строке — «failed: no_table»). 2 — распознавание сканов и шапка глубже 40-й строки.
export const READER_VERSION = 2
// Отказы, которые новая версия чтения может исправить. Пароль и испорченный файл от чтения не зависят.
const RETRY_FAILED = new Set(['scan', 'no_table', 'empty'])
// Скан распознаётся секунды на страницу: «читаем…» без хода выглядело бы как зависание.
export const scanProgressText = (page, pages) => (pages > 1 ? `распознаём скан: страница ${page} из ${pages}…` : 'распознаём скан…')
export const offerNeedsReread = (offer) => !!offer?.failed && !offer.lines.length && RETRY_FAILED.has(offer.failed) && (offer.rv || 0) < READER_VERSION
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

// JSON для notes. lines — [{ name, unit, qty, code, price, docPrice, docVat, k, also, no, packs, skip, unsure }]; строки без цены не
// хранятся. source — 'pdf' | 'sheet' | 'image'; vat — { mode, rate } (как посчитаны цены); delivery — множитель доставки.
export function offerNotes({ source = null, vat = null, delivery = 1, lines, date = null, currency = null, total = null, ocr = false }) {
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
    if (l.also?.length) row.ka = l.also.map(String)
    if (l.no?.length) row.kn = l.no.map(String)
    if (l.packs && Object.keys(l.packs).length) row.pm = l.packs
    if (l.sumOff) row.so = 1
    if (num(l.packQty) != null) row.pq = num(l.packQty)
    if (l.skip) row.x = 1
    if (l.unsure) row.un = 1
    out.push(row)
    if (out.length >= OFFER_LINES_MAX) break
  }
  return JSON.stringify({
    kind: OFFER_KIND, v: OFFER_VERSION, rv: READER_VERSION, at: new Date().toISOString(), source,
    vat: vat ? { mode: vat.mode || null, rate: num(vat.rate) } : null,
    delivery: num(delivery) && num(delivery) > 1 ? Math.round(num(delivery) * 10000) / 10000 : 1,
    ...(date ? { date } : {}), ...(currency ? { currency } : {}), ...(total ? { total } : {}), ...(ocr ? { ocr: true } : {}),
    lines: out,
  })
}

// Файл не распознался: notes с причиной вместо строк (error чтения: scan, no_table, empty, encrypted, broken).
export const unreadableOfferNotes = (reason) => JSON.stringify({
  kind: OFFER_KIND, v: OFFER_VERSION, rv: READER_VERSION, at: new Date().toISOString(), failed: String(reason), lines: [],
})

// notes файла → { at, source, vat, delivery, failed, date, currency, total, ocr, rv, lines: [{ name, unit, qty, code, price, docPrice,
// docVat, k, also, no, packs, skip, sumOff, packQty, unsure }] } или null (не документ «в похожие цены», испорченный JSON, другая версия).
// also, no, packs, sumOff, packQty, unsure — только если есть.
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
      ...(Array.isArray(r.ka) && r.ka.length ? { also: r.ka.map(String) } : {}),
      ...(Array.isArray(r.kn) && r.kn.length ? { no: r.kn.map(String) } : {}),
      ...(r.pm && typeof r.pm === 'object' ? { packs: r.pm } : {}),
      ...(r.so === 1 ? { sumOff: true } : {}),
      ...(num(r.pq) != null ? { packQty: num(r.pq) } : {}),
      ...(r.un === 1 ? { unsure: true } : {}),
    })
  }
  return {
    at: o.at || null, source: o.source || null, vat: o.vat || null, delivery: num(o.delivery) || 1, failed: o.failed || null, date: o.date || null,
    currency: o.currency || null, total: o.total || null, ocr: o.ocr === true, rv: num(o.rv) || 0, lines,
  }
}

// Какие цены в документе: 'net' — без НДС, в расценку прибавлен НДС; иначе 'gross' (с НДС или как есть). По самим строкам: колонка
// «Цена без НДС» и надпись над таблицей считаются одинаково, а в notes лежит итог.
export function offerVatMode(offer) {
  const line = offer?.lines?.find((l) => l.docPrice > 0 && l.price > 0)
  if (!line) return offer?.vat?.mode === 'net' ? 'net' : 'gross'
  return line.price / (line.docPrice * (offer.delivery || 1)) > 1.005 ? 'net' : 'gross'
}
const DEFAULT_RATE = 22
// Те же строки с другим НДС (человек видит, что документ понят неверно): цены пересчитываются. Тот же режим — без изменений.
export function offerWithVat(offer, mode) {
  if (offerVatMode(offer) === mode) return offer
  const k = 1 + (offer.vat?.rate ?? DEFAULT_RATE) / 100
  return {
    ...offer,
    vat: { mode, rate: offer.vat?.rate ?? DEFAULT_RATE },
    lines: offer.lines.map((l) => ({ ...l, price: roundMoney(mode === 'net' ? l.price * k : l.price / k) })),
  }
}
// Те же строки в рублях: человек указал курс.
export const offerInRoubles = (offer, rate) => ({
  ...offer, currency: null, lines: offer.lines.map((l) => ({ ...l, price: roundMoney(l.price * rate) })),
})
// Строка выбрана для позиции (keys — ключи её наименований): остальные позиции строки остаются, отказ снимается.
export const lineForGroup = (line, keys, current = []) => {
  const picks = [...new Set([...(line.k ? [line.k] : []), ...(line.also || []), ...current, keys[0]])]
  const no = (line.no || []).filter((k) => !keys.includes(k))
  return { ...line, k: picks[0], also: picks.slice(1), no }
}
// Строка — не эта позиция: снимается с неё и больше не предлагается. Других выбранных позиций нет — строка снова ищет сама.
export const lineNotForGroup = (line, keys) => {
  const picks = [...(line.k ? [line.k] : []), ...(line.also || [])].filter((k) => !keys.includes(k))
  return { ...line, k: picks[0] || null, also: picks.slice(1), no: [...new Set([...(line.no || []), ...keys])] }
}
