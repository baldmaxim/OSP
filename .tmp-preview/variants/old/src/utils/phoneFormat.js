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
