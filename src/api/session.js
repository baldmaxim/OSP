// Запросы к своему серверу при своём входе: сессия — в httpOnly-cookie (браузер шлёт её сам), меняющий
// запрос несёт отметку защиты X-OSP-CSRF — значение cookie __Host-osp_csrf (не HttpOnly, стабильна весь срок
// сессии). Ответы сервера о сессии превращаются в события:
//   401 OSP_SESSION_REVOKED — сессия закончилась (окно повторного входа поверх страницы);
//   401 OSP_AUTH_MODE       — вход изменился (вкладка старой сборки перезагружается);
//   403 OSP_PASSWORD_CHANGE_REQUIRED — сначала сменить временный пароль.
// Касается только своего адреса (/api/* того же источника): запросы к хранилищу по подписанной ссылке идут как
// были — без cookie и без отметки. Модуль чистый — tests/osp-api/client-auth.test.mjs.
export const CSRF_COOKIE = '__Host-osp_csrf'
export const CSRF_HEADER = 'X-OSP-CSRF'
export const SESSION_EVENTS = ['OSP_SESSION_REVOKED', 'OSP_AUTH_MODE', 'OSP_PASSWORD_CHANGE_REQUIRED']
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

// fetchImpl — нижний fetch (с наблюдением за отказами); getCookies() — document.cookie; onEvent(code) — события.
export function createSessionFetch({ fetchImpl, origin, getCookies, onEvent = () => {} }) {
  return async (input, init = {}) => {
    const path = ownApiPath(input, origin)
    if (!path) return fetchImpl(input, init)
    const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
    const headers = new Headers(init.headers || (typeof input === 'object' ? input?.headers : undefined) || {})
    if (!SAFE.has(method)) {
      const csrf = readCookie(CSRF_COOKIE, getCookies())
      if (csrf) headers.set(CSRF_HEADER, csrf)
    }
    const res = await fetchImpl(input, { ...init, headers, credentials: 'same-origin' })
    if (res.status === 401 || res.status === 403) {
      try {
        const body = await res.clone().json()
        if (body && SESSION_EVENTS.includes(body.code)) onEvent(body.code)
      } catch { /* не JSON */ }
    }
    return res
  }
}
