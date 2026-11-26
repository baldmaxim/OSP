// КОПИЯ src/utils/bidPrice.js — не править здесь: правка в оригинале, затем node scripts/sync-osp-api-shared.mjs
// Цены подрядчика по позициям ВОР — ключи, суммы и структура КП с ценами (миграция 20261102). Без библиотеки Excel: модуль берут
// кабинет подрядчика (расценка на сайте), выгрузка и служба osp-api (копия в server/osp-api/src/shared, scripts/sync-osp-api-shared.mjs).
// Разбор книги ВОР — bidVor.js.
import { normName } from './supplyRateHelpers.js'
import { normUnit } from './supplySimilarity.js'

export const BID_KINDS = ['material', 'work']
export const BID_KIND_LABEL = { material: 'Материалы', work: 'Работы' }

// Ключи позиции — те же, что пишет bid_rates_save.
export const bidItemKey = (name) => normName(String(name ?? '').replace(/\s+/g, ' ').trim())
export const bidUnitKey = (unit) => normUnit(unit)
export const bidKey = (kind, name, unit) => `${kind}|${bidItemKey(name)}|${bidUnitKey(unit)}`
export const rateKey = (r) => `${r.kind}|${r.item_key}|${r.unit_key || ''}`

// ── Суммы ────────────────────────────────────────────────────────────────────────────────────────────
export const roundMoney2 = (n) => Math.round(n * 100) / 100

// Сумма позиции: цена × объём; нет цены или объёма — null.
export function lineTotal(price, volume) {
  const p = Number(price)
  const v = Number(volume)
  if (price == null || volume == null || !Number.isFinite(p) || !Number.isFinite(v)) return null
  return roundMoney2(p * v)
}

// Уровень раздела «КП»: без номера — 0 (заголовок системы), «1» — 1, «1.2» — 2.
export const sectionLevel = (num) => {
  const n = String(num ?? '').trim().replace(/\.$/, '')
  return n ? n.split('.').length : 0
}

// Структура «КП» с ценами: строки + суммы работ и материалов по каждому разделу и всему ВОР.
// prices — Map(bidKey → цена за единицу). Раздел копит суммы своих строк до следующего раздела того же или более
// высокого уровня; вложенные разделы входят в суммы старших.
export function priceStructure(rows, prices) {
  const out = []
  const totals = { materials: 0, works: 0, priced: 0, items: 0 }
  const open = []
  for (const r of rows) {
    if (r.type === 'section') {
      const level = sectionLevel(r.num)
      while (open.length && open[open.length - 1].level >= level) open.pop()
      const section = { ...r, level, materials: 0, works: 0 }
      open.push(section)
      out.push(section)
      continue
    }
    const kind = r.type === 'work' ? 'work' : 'material'
    const price = prices.get(bidKey(kind, r.name, r.unit))
    const total = price == null ? null : lineTotal(price, r.volume)
    totals.items += 1
    if (price != null) totals.priced += 1
    if (total != null) {
      const field = kind === 'work' ? 'works' : 'materials'
      totals[field] += total
      for (const s of open) s[field] += total
    }
    out.push({ ...r, kind, price: price ?? null, total })
  }
  for (const s of out) {
    if (s.type !== 'section') continue
    s.materials = roundMoney2(s.materials)
    s.works = roundMoney2(s.works)
  }
  totals.materials = roundMoney2(totals.materials)
  totals.works = roundMoney2(totals.works)
  return { rows: out, totals }
}
