// Cookie своего входа. Приставка __Host- — браузер принимает такую cookie только с Secure, Path=/ и без Domain:
// соседние порталы *.su10.ru не могут подложить свою (Domain=.su10.ru). Запрос, где имя встретилось дважды, —
// признак подкладывания: отказ, а не «первая попавшаяся».
export const SESSION_COOKIE = '__Host-osp_session'
export const CSRF_COOKIE = '__Host-osp_csrf'
export const CSRF_HEADER = 'x-osp-csrf'
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

// → { values: Map(имя → значение), duplicates: Set(имя) }. Значения своих cookie — только base64url.
export function parseCookies(header) {
  const values = new Map()
  const duplicates = new Set()
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (values.has(name)) duplicates.add(name)
    else values.set(name, value)
  }
  return { values, duplicates }
}

// Своя cookie из заголовка: { value } | { duplicate: true } | {} (нет или негодный вид).
export function readToken(header, name) {
  const { values, duplicates } = parseCookies(header)
  if (duplicates.has(name)) return { duplicate: true }
  const v = values.get(name)
  return v && TOKEN.test(v) ? { value: v } : {}
}

export function serializeCookie(name, value, { maxAgeSec, httpOnly }) {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`, 'Secure', 'SameSite=Lax']
  if (httpOnly) parts.push('HttpOnly')
  return parts.join('; ')
}

export function sessionCookies({ sessionToken, csrf, maxAgeSec }) {
  return [
    serializeCookie(SESSION_COOKIE, sessionToken, { maxAgeSec, httpOnly: true }),
    serializeCookie(CSRF_COOKIE, csrf, { maxAgeSec, httpOnly: false }),
  ]
}

export const clearedCookies = () => [
  serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, httpOnly: true }),
  serializeCookie(CSRF_COOKIE, '', { maxAgeSec: 0, httpOnly: false }),
]
