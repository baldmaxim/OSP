// Независимая десятичная арифметика для ожидаемых значений в тестах.
// BigInt с явным масштабом, округление половины от нуля (как Excel ROUND).
// Специально не использует ни движок ПСДЦ, ни Number.

export function dec(value) {
  let s = String(value).trim().replace(/[\s\u00A0]/g, '').replace(',', '.')
  const neg = s.startsWith('-')
  if (neg || s.startsWith('+')) s = s.slice(1)
  const [int, frac = ''] = s.split('.')
  const n = BigInt((int || '0') + frac) * (neg ? -1n : 1n)
  return { n, s: frac.length }
}

function pow10(k) {
  return 10n ** BigInt(k)
}

function align(a, b) {
  const s = Math.max(a.s, b.s)
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s]
}

export function add(a, b) {
  const [x, y, s] = align(a, b)
  return { n: x + y, s }
}

export function mul(a, b) {
  return { n: a.n * b.n, s: a.s + b.s }
}

export function round(a, scale) {
  if (a.s <= scale) return { n: a.n * pow10(scale - a.s), s: scale }
  const div = pow10(a.s - scale)
  const neg = a.n < 0n
  const abs = neg ? -a.n : a.n
  let q = abs / div
  if ((abs % div) * 2n >= div) q += 1n
  return { n: neg ? -q : q, s: scale }
}

export function fixed(a, scale = 2) {
  const r = round(a, scale)
  const neg = r.n < 0n
  const digits = (neg ? -r.n : r.n).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const frac = digits.slice(digits.length - scale)
  return `${neg ? '-' : ''}${int}${scale ? '.' + frac : ''}`
}

export const ZERO = { n: 0n, s: 0 }

export function sum(list) {
  return list.reduce((acc, x) => add(acc, x), ZERO)
}
