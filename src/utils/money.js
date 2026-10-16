// Ввод и показ денежных сумм (task 370/371, «Заявка на ДС»; теперь и расценка снабжения).

// Разбор введённой суммы → число | null. Терпим пробелы, ₽ и запятую.
export function parseAmount(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  // \s в JS-регулярках уже покрывает все юникод-пробелы (вкл. U+00A0/U+2007/U+202F).
  const str = String(raw)
    .replace(/[₽\s]/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '')
  const num = parseFloat(str)
  return Number.isFinite(num) ? num : null
}

// Всегда 2 знака после запятой + разрядность пробелами (ru-RU): 1000000 → «1 000 000,00».
const AMOUNT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
export function formatAmount(num) {
  if (num == null || !Number.isFinite(num)) return ''
  return AMOUNT_FORMATTER.format(num)
}

// «Живое» форматирование во время ввода — группировка разрядов пробелами
//   («1000000» → «1 000 000», «1000,5» → «1 000,5»). Десятичная часть до 2 знаков.
export function formatAmountLive(raw) {
  if (raw == null) return ''
  let s = String(raw).replace(/\s/g, '').replace('.', ',').replace(/[^\d,]/g, '')
  const i = s.indexOf(',')
  let intPart = i === -1 ? s : s.slice(0, i)
  const decPart = i === -1 ? null : s.slice(i + 1).replace(/,/g, '').slice(0, 2)
  intPart = intPart.replace(/^0+(?=\d)/, '')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  if (decPart === null) return grouped
  return `${grouped || '0'},${decPart}`
}

// Округление до копеек «как в базе» (round(x, 2), половина — от нуля): 2.675 → 2.68.
export function roundMoney(num) {
  if (num == null || !Number.isFinite(num)) return null
  const sign = num < 0 ? -1 : 1
  return sign * Math.round((Math.abs(num) + Number.EPSILON) * 100) / 100
}
