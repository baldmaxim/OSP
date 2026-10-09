import { timingSafeEqual } from 'node:crypto'

// Сравнение секретов в постоянном времени: обычное === выдаёт длину совпавшего префикса
// через время ответа.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

// Токен из заголовка Authorization: «Bearer <jwt>».
export function bearerToken(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim())
  return m ? m[1].trim() : ''
}
