// Клиент Larix.CPM: вход и «ВОР по договорам» (GET /api/contract/data/project_contract_boq).
//
//   const larix = createLarixClient({ baseUrl, username, password, appCode })
//   const { rows, bytes } = await larix.fetchBoq()     // массив позиций как отдал Larix
//
// Что гарантирует (tests/osp-api/larix-client.test.mjs):
//   • только https и только хост из списка (LARIX_HOSTS); http — лишь к этой же машине (тесты);
//   • перенаправления не выполняются: иначе тело входа (с паролем) ушло бы по чужому адресу;
//   • логин, пароль и токен не попадают ни в тексты ошибок, ни в журнал; токен живёт только в памяти
//     одного вызова fetchBoq и не сохраняется;
//   • у входа и у запроса — предел времени, у ответа — предел размера (до разбора, по мере чтения);
//   • ответ — только JSON-массив; иное — ошибка 'invalid'.
// Ошибка — LarixError с кодом из набора журнала загрузок: login | http | timeout | too_large | invalid.
export const LARIX_HOSTS = ['cpm.su10.larix.ru']
export const LARIX_DEFAULT_URL = 'https://cpm.su10.larix.ru'
export const LARIX_LOGIN_PATH = '/api-acs/users/login'
export const LARIX_BOQ_PATH = '/api/contract/data/project_contract_boq'
export const LARIX_DEFAULTS = {
  loginTimeoutMs: 15_000,
  dataTimeoutMs: 120_000,
  maxBytes: 40 * 1024 * 1024,
}
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const TOKEN_RE = /^[\x21-\x7e]{8,8192}$/

export class LarixError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LarixError'
    this.code = code
  }
}

// Адрес Larix из настройки: только origin (схема, хост, порт), без учётки, параметров и пути.
export function larixBaseUrl(raw, { hosts = LARIX_HOSTS } = {}) {
  let u
  try { u = new URL(String(raw || '')) } catch { throw new Error('LARIX_BASE_URL: адрес не разобран') }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = LOOPBACK.has(host)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('LARIX_BASE_URL: только https://')
  if (!loopback && !hosts.includes(host)) throw new Error(`LARIX_BASE_URL: адрес не из списка (${hosts.join(', ')})`)
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) {
    throw new Error('LARIX_BASE_URL: только адрес сервера, без учётки, пути и параметров')
  }
  return u.origin
}

// Убирает из текста значения секретов (на случай, если сервер Larix вернул их в ответе об ошибке).
export function redact(text, secrets) {
  let out = String(text ?? '')
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('***')
  return out
}

async function readBody(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new LarixError('too_large', `Ответ Larix больше предела: ${declared} байт (LARIX_MAX_BYTES ${maxBytes})`)
  }
  const chunks = []
  let total = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new LarixError('too_large', `Ответ Larix больше предела ${maxBytes} байт (LARIX_MAX_BYTES)`)
      }
      chunks.push(value)
    }
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8'), bytes: total }
}

function pickToken(body) {
  const candidates = [body?.access_token, body?.accessToken, body?.token, body?.data?.access_token, body?.data?.accessToken, body?.data?.token]
  return candidates.find((t) => typeof t === 'string' && TOKEN_RE.test(t)) || null
}

export function createLarixClient({ baseUrl = LARIX_DEFAULT_URL, username, password, appCode = 'cpm', hosts = LARIX_HOSTS,
  fetchImpl = fetch, loginTimeoutMs = LARIX_DEFAULTS.loginTimeoutMs, dataTimeoutMs = LARIX_DEFAULTS.dataTimeoutMs,
  maxBytes = LARIX_DEFAULTS.maxBytes } = {}) {
  const origin = larixBaseUrl(baseUrl, { hosts })
  if (!username || !password) throw new Error('Larix: не заданы LARIX_USERNAME / LARIX_PASSWORD')
  const secrets = () => [password, username]

  // Сетевой сбой и истёкший предел времени — без адреса, учётки и тела запроса в тексте.
  async function call(path, init, timeoutMs, what) {
    try {
      return await fetchImpl(`${origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LarixError('timeout', `Larix не ответил за ${Math.round(timeoutMs / 1000)} с (${what})`)
      const code = err?.cause?.code || err?.code || ''
      throw new LarixError('http', `Larix недоступен (${what})${code ? `: ${String(code).slice(0, 40)}` : ''}`)
    }
  }

  async function login() {
    const res = await call(LARIX_LOGIN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username, password, app_code: appCode }),
    }, loginTimeoutMs, 'вход')
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {})
      throw new LarixError('login', `Larix отклонил вход: неверный логин или пароль (HTTP ${res.status})`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new LarixError('http', `Larix: вход не выполнен (HTTP ${res.status})`)
    }
    let body
    try {
      body = JSON.parse((await readBody(res, 1024 * 1024)).text)
    } catch (err) {
      if (err instanceof LarixError) throw err
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LarixError('timeout', `Larix не ответил за ${Math.round(loginTimeoutMs / 1000)} с (вход)`)
      throw new LarixError('invalid', 'Larix: ответ на вход — не JSON')
    }
    const token = pickToken(body)
    if (!token) throw new LarixError('invalid', 'Larix: в ответе на вход нет токена')
    return token
  }

  async function fetchBoq() {
    let token = ''
    try {
      token = await login()
      const res = await call(LARIX_BOQ_PATH, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      }, dataTimeoutMs, 'ВОР по договорам')
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {})
        throw new LarixError('login', `Larix не принял токен входа (HTTP ${res.status}) — проверьте права учётки на ВОР по договорам`)
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new LarixError('http', `Larix: ВОР по договорам не получены (HTTP ${res.status})`)
      }
      let read
      try {
        read = await readBody(res, maxBytes)
      } catch (err) {
        if (err instanceof LarixError) throw err
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LarixError('timeout', `Larix не отдал ВОР за ${Math.round(dataTimeoutMs / 1000)} с`)
        throw new LarixError('http', 'Larix: ответ оборвался')
      }
      let rows
      try { rows = JSON.parse(read.text) } catch { throw new LarixError('invalid', 'Larix: ВОР по договорам — не JSON') }
      if (!Array.isArray(rows)) throw new LarixError('invalid', 'Larix: ВОР по договорам — не массив')
      return { rows, bytes: read.bytes }
    } catch (err) {
      // Последний рубеж: какой бы ни была ошибка, логина, пароля и токена в её тексте нет.
      const code = err instanceof LarixError ? err.code : 'http'
      throw new LarixError(code, redact(err?.message || 'Larix: сбой', [token, ...secrets()]).slice(0, 280))
    }
  }

  return { fetchBoq, origin }
}
