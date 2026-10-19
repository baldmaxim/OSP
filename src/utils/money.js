// Ввод и показ денежных сумм (task 370/371, «Заявка на ДС»; теперь и расценка снабжения).

const MINUS = '−'
// Знак минуса при вводе: дефис, «−» (U+2212) и «–» (U+2013) — одно и то же.
const MINUS_CHARS = /[−–]/g

// Разбор введённой суммы → число | null. Терпим пробелы, ₽ и запятую.
// Минус учитывается только первым символом: «−1 000,50» → -1000.5.
export function parseAmount(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  // \s в JS-регулярках уже покрывает все юникод-пробелы (вкл. U+00A0/U+2007/U+202F).
  const str = String(raw)
    .replace(/[₽\s]/g, '')
    .replace(MINUS_CHARS, '-')
    .replace(',', '.')
  const negative = str.startsWith('-')
  const num = parseFloat(str.replace(/[^\d.]/g, ''))
  if (!Number.isFinite(num)) return null
  return negative && num !== 0 ? -num : num
}

// Всегда 2 знака после запятой + разрядность пробелами (ru-RU): 1000000 → «1 000 000,00».
const AMOUNT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
// Отрицательная — со знаком минуса «−», а не дефисом (Intl для ru-RU ставит дефис).
// «−0,00» не бывает: -0 и суммы меньше копейки по модулю — просто ноль.
export function formatAmount(num) {
  if (num == null || !Number.isFinite(num)) return ''
  const s = AMOUNT_FORMATTER.format(num)
  if (!s.startsWith('-')) return s
  return /[1-9]/.test(s) ? MINUS + s.slice(1) : s.slice(1)
}

// «Живое» форматирование во время ввода — группировка разрядов пробелами
//   («1000000» → «1 000 000», «1000,5» → «1 000,5»). Десятичная часть до 2 знаков.
// allowNegative — минус первым символом остаётся («-1000» → «−1 000»); без него
//   (цены снабжения) минус отбрасывается, как и любой другой символ.
export function formatAmountLive(raw, { allowNegative = false } = {}) {
  if (raw == null) return ''
  let s = String(raw).replace(/\s/g, '').replace(MINUS_CHARS, '-')
  const negative = allowNegative && s.startsWith('-')
  s = s.replace('.', ',').replace(/[^\d,]/g, '')
  const i = s.indexOf(',')
  let intPart = i === -1 ? s : s.slice(0, i)
  const decPart = i === -1 ? null : s.slice(i + 1).replace(/,/g, '').slice(0, 2)
  intPart = intPart.replace(/^0+(?=\d)/, '')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const body = decPart === null ? grouped : `${grouped || '0'},${decPart}`
  return negative ? MINUS + body : body
}

// Округление до копеек «как в базе» (round(x, 2), половина — от нуля): 2.675 → 2.68.
export function roundMoney(num) {
  if (num == null || !Number.isFinite(num)) return null
  const sign = num < 0 ? -1 : 1
  return sign * Math.round((Math.abs(num) + Number.EPSILON) * 100) / 100
}

// Изменение суммы «подано → утверждено» («Заявка на ДС», task 370).
//   diff = подано − утверждено, до копеек: > 0 — удешевление, < 0 — удорожание.
//   pct — изменение утверждённой относительно поданной, со знаком: < 0 — утверждено меньше.
// Суммы бывают отрицательными (ДС на уменьшение стоимости), поэтому процент считается от
// модуля поданной: «−1 000 000 → −1 200 000» — удешевление на 200 000, то есть −20 %, а не +20 %.
// Нет одной из сумм — { diff: null, pct: null }; подано 0 — процента нет.
export function amountChange(before, after) {
  if (before == null || after == null) return { diff: null, pct: null }
  const b = Number(before)
  const a = Number(after)
  if (!Number.isFinite(b) || !Number.isFinite(a)) return { diff: null, pct: null }
  return {
    diff: roundMoney(b - a) || 0,
    pct: b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null,
  }
}
