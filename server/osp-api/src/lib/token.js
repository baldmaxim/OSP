// Проверка токена входа на сервере — без обращения к Supabase на каждый запрос.
//
// Токен Supabase Auth подписан секретом проекта (HS256). Проверяются подпись, срок и назначение:
//   • алгоритм — только HS256: «none», другие HS* и асимметричные отклоняются;
//   • издатель — Auth этого проекта, назначение и роль — вошедший пользователь. Публичный ключ сайта и
//     служебный ключ подписаны тем же секретом, но токеном пользователя не являются — отклоняются;
//   • sub — идентификатор пользователя (uuid); анонимный вход не принимается.
// Чего проверка не видит: выход пользователя и блокировку до истечения токена (до часа). Блокировку и
// отзыв одобрения закрывает статус учётки из базы (src/lib/userStatus.js, не старше минуты).
//
// Секрет подписи равен по силе служебному ключу: им можно выпустить токен любого пользователя.
// Хранится только в файле окружения службы, в журнал и ответы не попадает.
import { jwtVerify, decodeProtectedHeader } from 'jose'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALGORITHMS = ['HS256']
// Расхождение часов сервера и Supabase.
export const CLOCK_TOLERANCE_S = 10
export const MIN_SECRET_LENGTH = 32

export function createTokenVerifier({ secret, supabaseUrl }) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`osp-api: секрет подписи токенов (SUPABASE_JWT_SECRET) короче ${MIN_SECRET_LENGTH} символов`)
  }
  if (!supabaseUrl) throw new Error('osp-api: для проверки токенов нужен адрес Supabase (SUPABASE_URL)')
  const key = new TextEncoder().encode(secret)
  const issuer = `${String(supabaseUrl).replace(/\/+$/, '')}/auth/v1`

  // → { id, email } либо исключение (причина — для журнала, пользователю всегда 401).
  async function verify(token) {
    const { payload } = await jwtVerify(String(token), key, {
      algorithms: ALGORITHMS,
      issuer,
      audience: 'authenticated',
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ['exp', 'sub'],
    })
    if (payload.role !== 'authenticated') throw new Error('token: role')
    if (payload.is_anonymous === true) throw new Error('token: anonymous')
    if (!UUID.test(String(payload.sub))) throw new Error('token: sub')
    return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' }
  }

  // Самопроверка настройки (для /api/ready): публичный ключ сайта подписан тем же секретом проекта.
  // true — секрет от этого проекта; false — от другого (любой вход получил бы 401); null — ключ нового
  // вида, не токен: проверить нечем.
  async function matchesProjectKey(projectKey) {
    const text = String(projectKey || '')
    if (text.split('.').length !== 3) return null
    try {
      if (decodeProtectedHeader(text).alg !== 'HS256') return false
      await jwtVerify(text, key, { algorithms: ALGORITHMS })
      return true
    } catch (err) {
      // Подпись верна, но ключ просрочен — секрет всё равно тот.
      return err?.code === 'ERR_JWT_EXPIRED'
    }
  }

  return { verify, matchesProjectKey }
}
