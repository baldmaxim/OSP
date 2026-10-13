// Токены для тестов osp-api — подписаны так же, как токены Supabase Auth (HS256 секретом проекта).
// Подпись собирается здесь вручную, а не библиотекой сервера: проверка не должна сверяться сама с собой.
// Секреты и пользователи синтетические.
import crypto from 'node:crypto'

export const SECRET = 'test-project-jwt-secret-0123456789-abcdefghijklmnop'
export const OTHER_SECRET = 'other-project-jwt-secret-9876543210-zyxwvutsrqponm'

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const HMAC = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }

// Подписанный токен с произвольными полями и заголовком (в том числе негодными — для отказов).
export function signToken(payload, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
  const head = b64(header)
  const body = b64(payload)
  const algo = HMAC[header.alg]
  const signature = algo ? crypto.createHmac(algo, secret).update(`${head}.${body}`).digest('base64url') : ''
  return `${head}.${body}.${signature}`
}

const nowS = () => Math.floor(Date.now() / 1000)

// Токен вошедшего пользователя — как выдаёт Supabase Auth проекта supabaseUrl.
export function userToken(supabaseUrl, userId, over = {}, secret = SECRET) {
  return signToken({
    iss: `${supabaseUrl}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: userId,
    email: `${String(userId).slice(0, 8)}@example.ru`, iat: nowS() - 10, exp: nowS() + 3600,
    session_id: crypto.randomUUID(), is_anonymous: false, ...over,
  }, secret)
}

// Публичный и служебный ключи проекта: подписаны тем же секретом, но это не токены пользователя.
export const projectKey = (role, secret = SECRET) =>
  signToken({ iss: 'supabase', ref: 'testproject', role, iat: nowS() - 1000, exp: nowS() + 10 * 365 * 86400 }, secret)
