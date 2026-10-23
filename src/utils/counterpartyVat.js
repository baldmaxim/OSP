// НДС контрагента (миграция 20261026): ставка в процентах (vat_rate) либо «без НДС» (vat_exempt).
// Одна реализация выпадающего списка и подписи на вкладку «Общая информация», журнал правок и тест.

// Ставки на выбор: общая 22 % (с 2026 года), УСН с НДС — 5 и 7 %, 0 %. 20 %, 10 % и «Без НДС» из выбора убраны
// (решение пользователя 23.10.2026); у кого они уже записаны — показываются как есть, пока их не сменят.
// «Без НДС» (УСН без НДС, освобождение) — не ставка 0 %, а отдельный признак.
export const VAT_RATES = [22, 7, 5, 0]
export const VAT_NONE = ''
export const VAT_EXEMPT = 'exempt'

const PERCENT_FORMATTER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
export const formatPercent = (n) => PERCENT_FORMATTER.format(Number(n))

// Значение выпадающего списка по строке контрагента.
export function vatSelectValue(cp) {
  if (cp?.vat_exempt) return VAT_EXEMPT
  if (cp?.vat_rate == null || cp.vat_rate === '') return VAT_NONE
  const n = Number(cp.vat_rate)
  return Number.isFinite(n) ? String(n) : VAT_NONE
}

// Поля базы по значению выпадающего списка.
export function vatFromSelect(value) {
  if (value === VAT_EXEMPT) return { vat_rate: null, vat_exempt: true }
  const n = value === VAT_NONE || value == null ? NaN : Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 100
    ? { vat_rate: n, vat_exempt: false }
    : { vat_rate: null, vat_exempt: false }
}

// «22 %», «Без НДС», «не указан» — для вкладки и журнала правок.
export function vatText(cp) {
  if (cp?.vat_exempt) return 'Без НДС'
  const value = vatSelectValue(cp)
  return value === VAT_NONE ? 'не указан' : `${formatPercent(value)} %`
}
