// Запросы к своему серверу при своём входе: сессия — в httpOnly-cookie (браузер шлёт её сам), меняющий
// запрос несёт отметку защиты X-OSP-CSRF — значение cookie __Host-osp_csrf (не HttpOnly, стабильна весь срок
// сессии). Ответы сервера о сессии превращаются в события:
//   401 OSP_SESSION_REVOKED — сессия закончилась (окно повторного входа поверх страницы);
//   401 OSP_AUTH_MODE       — вход изменился (вкладка старой сборки перезагружается);
//   403 OSP_PASSWORD_CHANGE_REQUIRED — сначала сменить временный пароль;
//   401 OSP_SSO_REQUIRED    — вход в СУ-10 закончился (окно повторного входа через СУ-10);
//   403 OSP_NO_PORTAL_ACCESS — доступ к порталу отозван в СУ-10 (страница «Нет доступа»);
//   401 OSP_IDLE            — вкладка простаивает: фоновые запросы на паузе до первого действия.
// Действие пользователя (вход через СУ-10): заголовок X-OSP-Activity со значением CSRF сессии — в течение 10 с после ввода,
// загрузки страницы или возврата на вкладку (markActivity). Без него запрос фоновый: сессию не продлевает, а брошенная
// вкладка не держит единый вход контура открытым неделями.
// Касается только своего адреса (/api/* того же источника): запросы к хранилищу по подписанной ссылке идут как
// были — без cookie и без отметки. Модуль чистый — tests/osp-api/client-auth.test.mjs.
export const CSRF_COOKIE = '__Host-osp_csrf'
export const CSRF_HEADER = 'X-OSP-CSRF'
export const ACTIVITY_HEADER = 'X-OSP-Activity'
export const ACTIVITY_WINDOW_MS = 10_000
export const SESSION_EVENTS = ['OSP_SESSION_REVOKED', 'OSP_AUTH_MODE', 'OSP_PASSWORD_CHANGE_REQUIRED', 'OSP_SSO_REQUIRED', 'OSP_NO_PORTAL_ACCESS', 'OSP_IDLE',
  'OSP_ORG_UNMAPPED', 'OSP_ORG_DENIED', 'OSP_ORG_CHANGED']
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export function readCookie(name, cookieString) {
  for (const part of String(cookieString || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function ownApiPath(input, origin) {
  try {
    const url = new URL(typeof input === 'string' ? input : input?.url, origin)
    return url.origin === origin && url.pathname.startsWith('/api/') ? url.pathname : null
  } catch {
    return null
  }
}

// fetchImpl — нижний fetch (с наблюдением за отказами); getCookies() — document.cookie; onEvent(code) — события;
// now() — часы (тесты). → fetch с полем markActivity(): «пользователь что-то сделал».
export function createSessionFetch({ fetchImpl, origin, getCookies, onEvent = () => {}, now = () => Date.now() }) {
  let activeUntil = 0
  // Сервер ответил OSP_IDLE: фоновые запросы (без действия) — на паузе, сеть не трогаем до первого действия.
  let idle = false
  const idleResponse = () => new Response(JSON.stringify({ error: 'Вкладка простаивает — продолжите работу', code: 'OSP_IDLE' }),
    { status: 401, headers: { 'content-type': 'application/json' } })
  const sessionFetch = async (input, init = {}) => {
    const path = ownApiPath(input, origin)
    if (!path) return fetchImpl(input, init)
    // Вход и «кто я» (/api/auth/*) не ставятся на паузу: после входа в соседнем окне вкладка должна увидеть новую сессию.
    if (idle && now() >= activeUntil && !path.startsWith('/api/auth/')) return idleResponse()
    const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
    const headers = new Headers(init.headers || (typeof input === 'object' ? input?.headers : undefined) || {})
    const csrf = readCookie(CSRF_COOKIE, getCookies())
    if (!SAFE.has(method) && csrf) headers.set(CSRF_HEADER, csrf)
    if (csrf && now() < activeUntil) headers.set(ACTIVITY_HEADER, csrf)
    const res = await fetchImpl(input, { ...init, headers, credentials: 'same-origin' })
    if (res.status === 401 || res.status === 403) {
      try {
        const body = await res.clone().json()
        if (body?.code === 'OSP_IDLE') idle = true
        if (body && SESSION_EVENTS.includes(body.code)) onEvent(body.code)
      } catch { /* не JSON */ }
    } else if (res.ok && idle && headers.has(ACTIVITY_HEADER)) {
      idle = false
    }
    return res
  }
  // → true, если вкладка простаивала: вызывающему стоит сразу сходить на сервер с действием (продлить сессию).
  sessionFetch.markActivity = () => {
    activeUntil = now() + ACTIVITY_WINDOW_MS
    return idle
  }
  sessionFetch.isActive = () => now() < activeUntil
  sessionFetch.isIdle = () => idle
  return sessionFetch
}
