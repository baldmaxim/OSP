/**
 * Форматирует телефон в формат +7(XXX)XXX-XX-XX по мере ввода
 */
export function formatPhone(value) {
  // Оставляем только цифры
  let digits = value.replace(/\D/g, '')

  // Если начинается с 8, заменяем на 7
  if (digits.startsWith('8') && digits.length > 1) {
    digits = '7' + digits.slice(1)
  }

  // Если нет 7 в начале, добавляем
  if (digits.length > 0 && !digits.startsWith('7')) {
    digits = '7' + digits
  }

  // Ограничиваем 11 цифрами
  digits = digits.slice(0, 11)

  // Форматируем
  let result = ''
  if (digits.length > 0) result += '+' + digits[0]
  if (digits.length > 1) result += '(' + digits.slice(1, 4)
  if (digits.length > 4) result += ')' + digits.slice(4, 7)
  if (digits.length > 7) result += '-' + digits.slice(7, 9)
  if (digits.length > 9) result += '-' + digits.slice(9, 11)

  return result
}

// Добавочный номер хранится в той же строке, что и номер: «+7(916)712-69-10 доб. 123».
// У контакта контрагента несколько номеров через «;» — у каждого свой добавочный.
// Читаем и прежние записи из Excel: «доб.», «доп.», «вн.», «ext».
const EXT_RE = /[\s,]*(?:доб|доп|вн|ext)\.?\s*(\d+)\s*$/i
export const PHONE_EXT_MAX = 6

/** «+7(916)712-69-10 доб. 123» → { number: '+7(916)712-69-10', ext: '123' } */
export function splitPhoneExt(value) {
  const s = String(value ?? '').trim()
  const m = s.match(EXT_RE)
  return m ? { number: s.slice(0, m.index).trim(), ext: m[1] } : { number: s, ext: '' }
}

/** Номер и добавочный (только цифры) — обратно в одну строку. */
export function joinPhoneExt(number, ext) {
  const n = String(number ?? '').trim()
  const e = String(ext ?? '').replace(/\D/g, '').slice(0, PHONE_EXT_MAX)
  if (!e) return n
  return n ? `${n} доб. ${e}` : `доб. ${e}`
}

/** Номер в виде +7(XXX)XXX-XX-XX, добавочный — как есть. */
export function formatPhoneEntry(value) {
  const { number, ext } = splitPhoneExt(value)
  return joinPhoneExt(number && formatPhone(number), ext)
}

/** Ссылка для звонка: добавочный — после паузы («,»), телефон наберёт его сам. Без цифр — undefined. */
export function phoneHref(value) {
  const { number, ext } = splitPhoneExt(value)
  const dial = number.replace(/[^\d+]/g, '')
  if (!/\d/.test(dial)) return undefined
  return `tel:${dial}${ext ? ',' + ext : ''}`
}
