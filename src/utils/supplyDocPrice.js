// Цена строки документа поставщика в расценку и строки документа для «похожих цен». Отдельно от supplyOffers.js: тот
// подключён к реестру тендеров, а здесь — разбор счёта (supplierDoc), он нужен только при чтении файла.
import { roundMoney } from './money.js'
import { deliveryUnitWithVat, unitPriceWithVat } from './supplierDoc.js'
import { deliveryFactor } from './supplyDocMatch.js'
import { offerNotes } from './supplyOffers.js'

// Почему файл не прочитан — для окна файлов тендера.
export const DOC_READ_PROBLEM = {
  unsupported: 'файл прикреплён, но цены из него не прочитать: читаются Excel и PDF с текстом. Word сохраните в PDF.',
  scan: 'скан или фото: в PDF нет текста, цены не прочитать. Попросите у поставщика Excel или PDF из 1С.',
  no_table: 'не нашли таблицу с ценами: нужна шапка с колонками «Наименование» и «Цена» или «Сумма».',
  empty: 'таблица есть, а строк с ценой нет.',
  encrypted: 'PDF защищён паролем — попросите у поставщика файл без пароля.',
  broken: 'файл не читается: откройте его и сохраните заново.',
  big: 'файл больше 30 МБ — такой не читаем, цены внесите вручную.',
  unavailable: 'файл сейчас не прочитался: повторите позже.',
}

export const docPriceOf = (item) => item.price ?? (item.sum != null && item.qty > 0 ? item.sum / item.qty : null)
export const docVatOf = (item) => (item.price != null ? item.priceVat : item.sumVat) || null

// Цена строки за её единицу: price — с НДС, delivery — доставка за единицу с НДС (колонка доставки строки и доля строки
// доставки — пропорционально сумме, если её разносить; нет — null), full — цена с доставкой. В базе без колонки
// доставки (до миграции 20261120) доставка — в самой цене, как раньше.
export function linePrice(item, vat, factor, deliveryOn) {
  const base = unitPriceWithVat(item, vat)
  if (base == null || !(base > 0)) return { price: null, delivery: null, full: null }
  const d = (deliveryUnitWithVat(item, vat) || 0) + base * (factor - 1)
  if (!deliveryOn) {
    const price = roundMoney(base + d)
    return { price, delivery: null, full: price }
  }
  const price = roundMoney(base)
  const delivery = d > 0 ? roundMoney(d) : null
  return { price, delivery, full: roundMoney(price + (delivery || 0)) }
}

// Строки распознанного документа «в похожие цены» как есть — НДС как в документе, доставка — к ценам (файл без окна
// сопоставления): позиции расценка найдёт сама. Цена поставщика — с доставкой. Ответ: { notes, lines } — lines: сколько
// строк с ценой.
export function offerNotesOfDoc(r) {
  const priceOf = (it) => unitPriceWithVat(it, r.vat)
  const { factor } = deliveryFactor(r.items, priceOf)
  const lines = r.items.filter((it) => !it.delivery).map((it) => {
    const { full } = linePrice(it, r.vat, factor, false)
    return { name: it.name, unit: it.unit, qty: it.qty, code: it.code, price: full, docPrice: docPriceOf(it), docVat: docVatOf(it), sumOff: it.sumOff, packQty: it.packQty }
  })
  return { notes: offerNotes({ source: r.kind, vat: r.vat, delivery: factor, lines, date: r.date, currency: r.currency, total: r.total }), lines: lines.filter((l) => l.price != null).length }
}
