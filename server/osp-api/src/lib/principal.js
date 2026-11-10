// Кто это — одна проверка для всех маршрутов: функции (/api/fn), шлюз данных (/api/db), /api/auth/*, обложки.
// Пользователь здесь не создаётся никогда.
//
// Источник входа зависит от режима (AUTH_MODE):
//   supabase — только токен Supabase в заголовке Authorization (как раньше); cookie своего входа не читаются;
//   both     — токен Supabase или парольная сессия; парольная — только пилоту (OSP_AUTH_PILOT_IDS);
//   own      — только парольная сессия (вход «через Яндекс»);
//   keycloak — только сессия СУ-10 (вход через Keycloak).
// Чужой вид входа (токен Supabase в own и keycloak, сессия СУ-10 в own и both, парольная — в keycloak) — 401 OSP_AUTH_MODE:
// его понимает и старая вкладка (перезагрузится и покажет вход нового режима). Отказ стоит здесь, а не только в команде
// переключения: даже если отзыв сессий при переключении не прошёл, чужая сессия не принимается.
// Заголовок важнее cookie: есть Authorization — используется только он.
//
// Сессия действует, только пока учётка одобрена и не заблокирована (или это суперадминистратор): иначе — 403
// OSP_ACCOUNT_DISABLED, и сессия отзывается. Блокировка из «Администрирования» отзывает сессии и сама (триггер базы), кэш
// поиска сессии — не дольше 5 с. Сессию СУ-10, кроме того, перепроверяет Keycloak (src/lib/auth/oidcRecheck.js).
//
// Cookie на отказах не стираются (кроме повторённой cookie — её иначе не исправить): поздний ответ запроса, ушедшего до
// входа в соседнем окне, стёр бы только что выданную сессию. Новый вход и выход и так перезаписывают cookie.
//
// Продление. Парольная сессия — любым запросом (как было). Сессия СУ-10 — только действием пользователя: заголовок
// X-OSP-Activity, равный CSRF сессии (его ставит страница в течение 10 с после ввода, загрузки или возврата на вкладку;
// чужой сайт не прочтёт CSRF и не пройдёт предварительный CORS-запрос). Без заголовка запрос — фоновый.
import { SESSION_COOKIE, CSRF_HEADER, readToken, clearedCookies } from './auth/cookies.js'
import { bearerToken, safeEqual } from './keys.js'
import { AUTH_MODES, isSessionMode } from '../config.js'

export { AUTH_MODES }
export const ACTIVITY_HEADER = 'x-osp-activity'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// Какой вид сессии принимает режим.
const SESSION_KIND = { both: 'password', own: 'password', keycloak: 'keycloak' }
const modeChanged = () => err(401, 'OSP_AUTH_MODE', 'Вход изменился — обновите страницу')

const err = (status, code, message, clear = false) => ({ kind: 'error', status, code, message, clear })
// База не ответила — это не «прав нет»: клиент повторит.
const unavailable = () => err(503, 'OSP_UNAVAILABLE', 'Сервис временно недоступен, повторите запрос')
const tooMany = () => err(429, 'OSP_RATE_LIMIT', 'Слишком много запросов — повторите через минуту')

// failLimit — лимит неверных cookie и токенов по адресу клиента (src/lib/limits.js, authFailPerIp): каждая такая попытка — запрос
// к базе или к Supabase, и без лимита поток случайных cookie занимал бы подключения к базе всего портала.
// recheck — перепроверка сессий СУ-10 (src/lib/auth/oidcRecheck.js), только в режиме keycloak.
export function createPrincipalResolver({ mode, verifyBearer, sessions, userStatus, isSuperadmin, pilotIds = [], failLimit = null, recheck = null }) {
  if (!AUTH_MODES.includes(mode)) throw new Error(`osp-api: неизвестный режим входа ${mode}`)
  if (mode === 'keycloak' && !recheck) throw new Error('osp-api: вход через СУ-10 без перепроверки сессий')

  // → { kind: 'anon' } | { kind: 'user', source, user: { id, email }, session? } | { kind: 'error', status, code, message, clear }
  async function resolve(request) {
    const header = request.headers.authorization
    if (header) {
      if (isSessionMode(mode)) return modeChanged()
      if (failLimit?.blocked(request.ip)) return tooMany()
      const token = bearerToken(header)
      const user = token ? await verifyBearer(token) : null
      if (!user) {
        failLimit?.take(request.ip)
        return err(401, 'PGRST301', 'JWT expired or invalid')
      }
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
    if (failLimit?.blocked(request.ip) && !sessions.cached?.(cookie.value)) return tooMany()
    let session
    try { session = await sessions.lookup(cookie.value) } catch { return unavailable() }
    if (!session) {
      failLimit?.take(request.ip)
      return err(401, 'OSP_SESSION_REVOKED', 'Сессия завершена — войдите заново')
    }
    if (session.authSource !== SESSION_KIND[mode]) return modeChanged()
    if (mode === 'both' && !pilotIds.includes(session.userId)) {
      return err(401, 'OSP_SESSION_REVOKED', 'Вход через портал пока только для проверки')
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
      return err(403, 'OSP_ACCOUNT_DISABLED', 'Учётная запись заблокирована или ожидает одобрения')
    }
    const activity = isActivity(request, session)
    if (session.authSource === 'keycloak') {
      let check
      try { check = await recheck.ensure(session, { active: activity }) } catch { return unavailable() }
      if (!check.ok) return err(check.status, check.code, check.message)
      if (activity) sessions.activity(session)
    } else {
      sessions.touch?.(session)
    }
    return {
      kind: 'user', source: session.authSource === 'keycloak' ? 'keycloak' : 'own', user: { id: session.userId, email: session.email },
      session: { token: cookie.value, idHash: session.idHash, csrf: session.csrf, mustChange: session.mustChange, authSource: session.authSource },
      roleRow: row,
    }
  }

  return { resolve, mode }
}

// Действие пользователя: X-OSP-Activity равен CSRF сессии.
export function isActivity(request, session) {
  const header = request.headers[ACTIVITY_HEADER]
  return typeof header === 'string' && Boolean(session?.csrf) && safeEqual(header, session.csrf)
}

// Запрос со своей сессией (любого вида), меняющий данные: заголовок X-OSP-CSRF равен CSRF сессии, источник — сам портал.
// → null или текст отказа.
export function csrfProblem(request, principal, publicOrigin) {
  if (!principal?.session || SAFE_METHODS.has(request.method)) return null
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
