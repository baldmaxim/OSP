// Кто это — одна проверка для всех маршрутов: функции (/api/fn), шлюз данных (/api/db), /api/auth/*, обложки.
// Пользователь здесь не создаётся никогда.
//
// Источник входа зависит от режима (AUTH_MODE):
//   supabase — только токен Supabase в заголовке Authorization (как раньше); cookie своего входа не читаются;
//   both     — токен Supabase или своя сессия; своя — только пилоту (OSP_AUTH_PILOT_IDS);
//   own      — только своя сессия; запрос с заголовком Authorization — 401 OSP_AUTH_MODE (старая вкладка
//              перезагрузится и покажет форму входа).
// Заголовок важнее cookie: есть Authorization — используется только он.
//
// Своя сессия действует, только пока учётка одобрена и не заблокирована (или это суперадминистратор): иначе —
// 403 OSP_ACCOUNT_DISABLED, и сессия отзывается. Блокировка из «Администрирования» отзывает сессии и сама
// (триггер базы), кэш поиска сессии — не дольше 5 с.
import { SESSION_COOKIE, CSRF_HEADER, readToken, clearedCookies } from './auth/cookies.js'
import { bearerToken, safeEqual } from './keys.js'

export const AUTH_MODES = ['supabase', 'both', 'own']
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const err = (status, code, message, clear = false) => ({ kind: 'error', status, code, message, clear })
// База не ответила — это не «прав нет»: клиент повторит.
const unavailable = () => err(503, 'OSP_UNAVAILABLE', 'Сервис временно недоступен, повторите запрос')

export function createPrincipalResolver({ mode, verifyBearer, sessions, userStatus, isSuperadmin, pilotIds = [] }) {
  if (!AUTH_MODES.includes(mode)) throw new Error(`osp-api: неизвестный режим входа ${mode}`)

  // → { kind: 'anon' } | { kind: 'user', source, user: { id, email }, session? } | { kind: 'error', status, code, message, clear }
  async function resolve(request) {
    const header = request.headers.authorization
    if (header) {
      if (mode === 'own') return err(401, 'OSP_AUTH_MODE', 'Вход изменился — обновите страницу')
      const token = bearerToken(header)
      const user = token ? await verifyBearer(token) : null
      if (!user) return err(401, 'PGRST301', 'JWT expired or invalid')
      // Заблокированный не проходит и с ещё живым токеном Supabase.
      let row
      try { row = await userStatus.get(user.id) } catch { return unavailable() }
      if (row?.is_blocked === true) return err(403, 'OSP_ACCOUNT_DISABLED', 'Учётная запись заблокирована')
      return { kind: 'user', source: 'supabase', user: { id: user.id, email: user.email || '' } }
    }
    if (mode === 'supabase') return { kind: 'anon' }
    const cookie = readToken(request.headers.cookie, SESSION_COOKIE)
    if (cookie.duplicate) return err(400, 'OSP_COOKIE_DUPLICATE', 'Повреждённые cookie входа — войдите заново', true)
    if (!cookie.value) return { kind: 'anon' }
    let session
    try { session = await sessions.lookup(cookie.value) } catch { return unavailable() }
    if (!session) return err(401, 'OSP_SESSION_REVOKED', 'Сессия завершена — войдите заново', true)
    if (mode === 'both' && !pilotIds.includes(session.userId)) {
      return err(401, 'OSP_SESSION_REVOKED', 'Вход через портал пока только для проверки', true)
    }
    let row
    let active
    try {
      row = await userStatus.get(session.userId)
      active = Boolean(row && row.is_approved === true && row.is_blocked !== true) || await isSuperadmin(session.userId)
    } catch {
      return unavailable()
    }
    if (!active) {
      await sessions.revoke(cookie.value, 'status').catch(() => {})
      return err(403, 'OSP_ACCOUNT_DISABLED', 'Учётная запись заблокирована или ожидает одобрения', true)
    }
    return {
      kind: 'user', source: 'own', user: { id: session.userId, email: session.email },
      session: { token: cookie.value, idHash: session.idHash, csrf: session.csrf, mustChange: session.mustChange },
      roleRow: row,
    }
  }

  return { resolve, mode }
}

// Запрос со своей сессией, меняющий данные: заголовок X-OSP-CSRF равен CSRF сессии, источник — сам портал.
// → null или текст отказа.
export function csrfProblem(request, principal, publicOrigin) {
  if (principal?.source !== 'own' || SAFE_METHODS.has(request.method)) return null
  const header = request.headers[CSRF_HEADER]
  if (typeof header !== 'string' || !safeEqual(header, principal.session.csrf)) return 'Нет отметки защиты запроса — обновите страницу'
  return originProblem(request, publicOrigin)
}

// Источник запроса — сам портал: Origin совпадает с адресом портала; Sec-Fetch-Site, если браузер его прислал, —
// same-origin (соседний портал *.su10.ru для браузера «тот же сайт», но не «тот же источник»).
export function originProblem(request, publicOrigin) {
  if (!publicOrigin || request.headers.origin !== publicOrigin) return 'Запрос не с портала'
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return 'Запрос не с портала'
  return null
}

export const clearSessionCookies = (reply) => reply.header('set-cookie', clearedCookies())
