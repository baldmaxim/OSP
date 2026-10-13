import { timingSafeEqual } from 'node:crypto'

// Сравнение секретов в постоянном времени: обычное === выдаёт длину совпавшего префикса
// через время ответа.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

// Токен из заголовка Authorization: «Bearer <jwt>». Только знаки, допустимые в токене (RFC 6750):
// иное токеном быть не может, а в заголовке запроса к Supabase вызвало бы ошибку вместо отказа 401.
export function bearerToken(header) {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(String(header || '').trim())
  return m ? m[1] : ''
}
