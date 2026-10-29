// Суммы договоров в отчётах. Договоры бывают в разных валютах (RUB/CNY/USD/EUR): складывать их в одно
// число нельзя, поэтому суммы копятся по каждой валюте отдельно ({ RUB: n, CNY: n, … }), а общий итог —
// приблизительный пересчёт в рубли, в интерфейсе всегда со знаком «≈».
import { currencySymbol } from './estimateImport.js'

export const CURRENCY_ORDER = ['RUB', 'CNY', 'USD', 'EUR']

// Ориентировочные курсы к рублю — обновляйте вручную под актуальный курс.
export const APPROX_RATES_TO_RUB = { RUB: 1, CNY: 12, USD: 85, EUR: 95 }

export const fmtInt = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n)

// Записи { cur, amt } в стабильном порядке (RUB, CNY, USD, EUR, затем прочие).
export function currencyEntries(map) {
  if (!map) return []
  const known = CURRENCY_ORDER.filter((c) => map[c])
  const extra = Object.keys(map).filter((c) => !CURRENCY_ORDER.includes(c) && map[c])
  return [...known, ...extra].map((c) => ({ cur: c, amt: map[c] }))
}

export const fmtCur = (amt, cur) => `${fmtInt(amt)} ${currencySymbol(cur)}`
export const toRub = (amt, cur) => amt * (APPROX_RATES_TO_RUB[cur] ?? 0)
// Итог по всем валютам, приведённый к рублю (приблизительно).
export const totalRub = (map) => currencyEntries(map).reduce((s, e) => s + toRub(e.amt, e.cur), 0)

// Подсказка с используемыми курсами (для title).
export const RATE_NOTE = 'Курс (ориентировочно): '
  + ['CNY', 'USD', 'EUR'].map((c) => `${currencySymbol(c)} ${APPROX_RATES_TO_RUB[c]} ₽`).join(' · ')
