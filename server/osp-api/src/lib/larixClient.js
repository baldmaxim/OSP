// Клиент Larix.CPM: вход и «ВОР по договорам» (GET /api/contract/data/project_contract_boq).
//
//   const larix = createLarixClient({ baseUrl, username, password, appCode })
//   const { count, bytes } = await larix.fetchBoq({ onRow })  // каждая позиция — в onRow по мере чтения
//
// Что гарантирует (tests/osp-api/larix-client.test.mjs, память — tests/deploy/larix-memory.test.mjs):
//   • только https и только хост из списка (LARIX_HOSTS); http — лишь к этой же машине (тесты);
//   • перенаправления не выполняются: иначе тело входа (с паролем) ушло бы по чужому адресу;
//   • логин, пароль и токен не попадают ни в тексты ошибок, ни в журнал; токен живёт только в памяти
//     одного вызова fetchBoq и не сохраняется;
//   • у входа и у запроса — предел времени, у ответа — предел размера (до разбора, по мере чтения);
//   • ответ — только JSON-массив; иное — ошибка 'invalid';
//   • ответ разбирается потоком: в памяти — текущая позиция, а не весь ответ. «ВОР по договорам» — десятки
//     МБ, загрузка идёт внутри API с потолком памяти 384 МБ (deploy/docker/compose.yml): разбор целиком дал бы
//     пик в несколько размеров ответа и мог бы уронить весь портал.
// Ошибка — LarixError с кодом из набора журнала загрузок: login | http | timeout | too_large | invalid.
export const LARIX_HOSTS = ['cpm.su10.larix.ru']
export const LARIX_DEFAULT_URL = 'https://cpm.su10.larix.ru'
// Вход — как у веб-приложения Larix: POST <адрес>/api/login, тело { username, password } (UserLoginSchema;
// лишнее app_code сервер пропускает), ответ { token, user, … }. Адрес /api-acs/users/login отвечает 404.
export const LARIX_LOGIN_PATH = '/api/login'
export const LARIX_BOQ_PATH = '/api/contract/data/project_contract_boq'
export const LARIX_DEFAULTS = {
  loginTimeoutMs: 15_000,
  dataTimeoutMs: 120_000,
  // Предел всего ответа — защита от бесконечного ответа, а не от памяти: память держит потоковый разбор.
  maxBytes: 256 * 1024 * 1024,
  // Одна позиция — в знаках; больше — ответ не тот, что ждём.
  maxItemChars: 1024 * 1024,
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

const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0xfeff])
const JSON_START = /^[{"\-0-9tfn]/

// Разбор JSON-массива по мере чтения. push(текст) — очередной кусок (после TextDecoder в потоковом режиме),
// end() — конец ответа, вернёт число элементов. Каждый элемент верхнего уровня — JSON.parse своего текста и
// сразу onItem(значение); весь массив не собирается. Строки, экранирование и вложенность учитываются,
// граница куска может пройти где угодно.
export function createJsonArrayParser({ onItem, maxItemChars = LARIX_DEFAULTS.maxItemChars }) {
  let state = 'start' // start → first (после «[») → item → after → next → item … → done
  let kind = ''       // элемент: nest — объект или массив, str — строка, lit — число, true, false, null
  let depth = 0
  let inStr = false
  let esc = false
  let parts = []      // текст текущего элемента из прошлых кусков
  let partsLen = 0
  let count = 0
  const invalid = (why) => new LarixError('invalid', `Larix: ВОР по договорам — ${why}`)
  const tooLarge = () => new LarixError('too_large', `Larix: позиция ответа больше ${maxItemChars} знаков`)

  const finishItem = (chunk, from, to) => {
    if (partsLen + (to - from) > maxItemChars) throw tooLarge()
    const piece = chunk.slice(from, to)
    const text = parts.length ? parts.join('') + piece : piece
    parts = []
    partsLen = 0
    let value
    try { value = JSON.parse(text) } catch { throw invalid('не JSON') }
    count++
    onItem(value)
  }

  function push(chunk) {
    const n = chunk.length
    let start = state === 'item' ? 0 : -1
    let i = 0
    while (i < n) {
      const c = chunk.charCodeAt(i)
      if (state === 'item') {
        if (kind === 'lit') {
          if (c === 0x2c || c === 0x5d || WS.has(c)) { finishItem(chunk, start, i); state = 'after'; continue }
        } else if (inStr) {
          if (esc) esc = false
          else if (c === 0x5c) esc = true
          else if (c === 0x22) {
            inStr = false
            if (kind === 'str') { finishItem(chunk, start, i + 1); state = 'after' }
          }
        } else if (c === 0x22) inStr = true
        else if (c === 0x7b || c === 0x5b) depth++
        else if (c === 0x7d || c === 0x5d) {
          depth--
          if (depth === 0) { finishItem(chunk, start, i + 1); state = 'after' }
        }
        i++
        continue
      }
      if (WS.has(c)) { i++; continue }
      if (state === 'start') {
        if (c !== 0x5b) throw invalid(JSON_START.test(chunk[i]) ? 'не массив' : 'не JSON')
        state = 'first'
      } else if (state === 'after') {
        if (c === 0x2c) state = 'next'
        else if (c === 0x5d) state = 'done'
        else throw invalid('не JSON')
      } else if (state === 'first' && c === 0x5d) {
        state = 'done'
      } else if (state === 'first' || state === 'next') {
        state = 'item'
        start = i
        depth = 0
        inStr = false
        esc = false
        if (c === 0x7b || c === 0x5b) { kind = 'nest'; depth = 1 } else if (c === 0x22) { kind = 'str'; inStr = true } else kind = 'lit'
      } else {
        throw invalid('не JSON') // после закрывающей «]» — только пробелы
      }
      i++
    }
    if (state === 'item') {
      partsLen += n - start
      if (partsLen > maxItemChars) throw tooLarge()
      parts.push(chunk.slice(start))
    }
  }

  function end() {
    if (state !== 'done') throw invalid(state === 'start' ? 'не JSON' : 'не JSON (ответ неполный)')
    return count
  }

  return { push, end }
}

function pickToken(body) {
  const candidates = [body?.access_token, body?.accessToken, body?.token, body?.data?.access_token, body?.data?.accessToken, body?.data?.token]
  return candidates.find((t) => typeof t === 'string' && TOKEN_RE.test(t)) || null
}

export function createLarixClient({ baseUrl = LARIX_DEFAULT_URL, username, password, appCode = 'cpm', hosts = LARIX_HOSTS,
  fetchImpl = fetch, loginTimeoutMs = LARIX_DEFAULTS.loginTimeoutMs, dataTimeoutMs = LARIX_DEFAULTS.dataTimeoutMs,
  maxBytes = LARIX_DEFAULTS.maxBytes, maxItemChars = LARIX_DEFAULTS.maxItemChars } = {}) {
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

  // Ответ «ВОР по договорам» — потоком в разбор: предел всего ответа (объявленный размер — сразу), позиции — в
  // onItem по одной. Сетевой обрыв и истёкшее время — понятной ошибкой.
  async function streamRows(res, onItem) {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw new LarixError('too_large', `Ответ Larix больше предела: ${declared} байт (LARIX_MAX_BYTES ${maxBytes})`)
    }
    const parser = createJsonArrayParser({ onItem, maxItemChars })
    const decoder = new TextDecoder('utf-8')
    const reader = res.body?.getReader()
    let total = 0
    try {
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) throw new LarixError('too_large', `Ответ Larix больше предела ${maxBytes} байт (LARIX_MAX_BYTES)`)
          parser.push(decoder.decode(value, { stream: true }))
        }
      }
      parser.push(decoder.decode())
      return { count: parser.end(), bytes: total }
    } catch (err) {
      await reader?.cancel().catch(() => {})
      if (err instanceof LarixError) throw err
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LarixError('timeout', `Larix не отдал ВОР за ${Math.round(dataTimeoutMs / 1000)} с`)
      throw new LarixError('http', 'Larix: ответ оборвался')
    }
  }

  // onRow(позиция) — для каждой позиции по мере чтения; без него позиции собираются в rows (тесты, небольшие
  // ответы). Загрузка и проверка (larixSync.js, larix-cli.js) передают onRow.
  async function fetchBoq({ onRow } = {}) {
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
      const rows = onRow ? null : []
      const { count, bytes } = await streamRows(res, onRow || ((row) => rows.push(row)))
      return { rows, count, bytes }
    } catch (err) {
      // Последний рубеж: какой бы ни была ошибка, логина, пароля и токена в её тексте нет.
      const code = err instanceof LarixError ? err.code : 'http'
      throw new LarixError(code, redact(err?.message || 'Larix: сбой', [token, ...secrets()]).slice(0, 280))
    }
  }

  return { fetchBoq, origin }
}
