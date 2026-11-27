// HTTP-клиент SIGNAL: токен и чтение. Всё, что знает о протоколе (какие пути и какие поля), — в signalApi.js.
//
//   const client = createSignalClient({ baseUrl, hosts, clientId, clientSecret, scopes })
//   await client.request({ method: 'GET', path: <известный путь из signalApi.js>, query }, { signal })
//
// Что гарантирует (tests/osp-api/signal-client.test.mjs):
//   • в SIGNAL ничего не пишется: методы — только GET и POST, а POST принимают лишь получение токена и поиск
//     элементов (он читает); любой другой метод или путь клиент отвергает до обращения к сети;
//   • адрес строится только из базового URL и известного пути; хост проверяется точным сравнением по списку,
//     схема — https (http и любой порт — только к этой же машине и только при allowLoopback, для тестов),
//     без учётки, пути, параметров и нестандартного порта; перенаправления запрещены (redirect: 'error'),
//     поэтому токен и секрет не уйдут на чужой адрес;
//   • токен живёт только в памяти, обновляется за минуту до срока; секрет клиента, токен и идентификатор клиента
//     не попадают ни в тексты ошибок, ни в журнал;
//   • у каждой попытки предел времени, у ответа — предел размера (до разбора, по мере чтения);
//   • 429 — ожидание Retry-After: не короче retryAfterMinMs (по умолчанию 1 с: «Retry-After: 0» не даёт десять повторов подряд
//     за доли секунды) и не дольше двух минут; 401 — один повтор с новым токеном, 5xx и 550 — несколько повторов с задержкой,
//     403 и 450 — без повтора; чужой «следующий» адрес из ответа не используется нигде.
// Ошибка — SignalError с кодом: auth | scope | http | timeout | too_large | invalid | rate_limited | not_configured
// (и aborted — вызвавший сам отменил запрос; это не сбой SIGNAL). У ошибки HTTP есть status.
export const SIGNAL_TOKEN_PATH = '/public/v1/auth/token'
// POST разрешён ровно двум путям: токен и поиск элементов (он читает, тело — условие поиска).
const POST_PATHS = new Set([SIGNAL_TOKEN_PATH, '/public/v1/items/search'])
const PATH_RE = /^\/public\/v1\/[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)*$/
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const TOKEN_RE = /^[\x21-\x7e]{8,8192}$/

export const SIGNAL_DEFAULT_URL = 'https://api.sgnl.pro'
export const SIGNAL_DEFAULT_SCOPES = ['project:list', 'docs:folder:read', 'docs:item:list']
export const SIGNAL_CLIENT_DEFAULTS = {
  timeoutMs: 30_000,
  // Дерево проекта приходит одним ответом: предел — защита памяти (384 МБ на весь портал), не удобство.
  maxBytes: 16 * 1024 * 1024,
  tokenSkewMs: 60_000,
  maxRetryAfterMs: 120_000,
  // Нижняя граница ожидания 429 (С-61): сервер пишет целые секунды, «0» — не «повторяйте сразу», а «меньше секунды».
  retryAfterMinMs: 1_000,
  defaultRetryAfterMs: 2_000,
  maxRateRetries: 10,
  retries: 3,
  backoffMs: [500, 1_500, 4_000],
}

export class SignalError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SignalError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
  }
}

// Убирает из текста значения секретов (на случай, если они попали в ответ сервера или в текст сбоя сети).
export function redact(text, secrets) {
  let out = String(text ?? '')
  for (const s of secrets) if (s && String(s).length >= 3) out = out.split(String(s)).join('***')
  return out
}

// Адрес SIGNAL из настройки: только origin. Хост — из списка (точное сравнение), по умолчанию — хост самого адреса.
export function signalBaseUrl(raw, { hosts = [], allowLoopback = false } = {}) {
  let u
  try { u = new URL(String(raw || '')) } catch { throw new Error('SIGNAL_BASE_URL: адрес не разобран') }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = allowLoopback && LOOPBACK.has(host)
  if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) throw new Error('SIGNAL_BASE_URL: только https://')
  const list = (hosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean)
  if (!(list.length ? list : [host]).includes(host)) throw new Error('SIGNAL_BASE_URL: адрес не из списка SIGNAL_HOSTS')
  if (u.username || u.password) throw new Error('SIGNAL_BASE_URL: учётка в адресе не допускается')
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('SIGNAL_BASE_URL: только адрес сервера, без пути и параметров')
  if (u.port && !loopback) throw new Error('SIGNAL_BASE_URL: нестандартный порт не допускается')
  return { origin: u.origin, host, hosts: list.length ? list : [host] }
}

function toScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(/[\s,]+/)
  const out = list.map((s) => String(s).trim()).filter(Boolean)
  return out.length ? out : [...SIGNAL_DEFAULT_SCOPES]
}

// Ожидание, которое отменяется вместе с запуском.
function abortedError(signal) {
  const err = new SignalError('aborted', 'SIGNAL: запрос отменён')
  err.reason = signal?.reason
  return err
}
export function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedError(signal)); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, Math.max(0, ms))
    const onAbort = () => { clearTimeout(timer); reject(abortedError(signal)) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Retry-After: целые секунды или дата HTTP; нет или непонятно — запасное значение; не короче minMs и не дольше maxMs.
// Ожидание клиента — минимум retryAfterMinMs (С-61); сама функция без minMs возвращает значение сервера как есть.
export function parseRetryAfter(value, { now = Date.now(), minMs = 0, maxMs, defaultMs }) {
  const v = String(value ?? '').trim()
  let ms = null
  if (/^\d{1,9}$/.test(v)) ms = Number(v) * 1000
  else if (/[A-Za-z]/.test(v)) {
    const at = Date.parse(v)
    if (Number.isFinite(at)) ms = at - now
  }
  if (ms === null || !Number.isFinite(ms)) ms = defaultMs
  return Math.min(Math.max(0, ms, Math.min(minMs, maxMs)), maxMs)
}

// Настройка-интервал: конечное число не меньше нуля, иначе значение по умолчанию.
const msOr = (v, fallback) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback)

async function drain(res) {
  try { await res.body?.cancel() } catch { /* уже закрыт */ }
}

// Тело ответа с пределом размера: объявленный размер проверяется сразу, фактический — по мере чтения.
async function readText(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drain(res)
    throw new SignalError('too_large', `Ответ SIGNAL больше предела ${maxBytes} байт (SIGNAL_MAX_BYTES)`)
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
        throw new SignalError('too_large', `Ответ SIGNAL больше предела ${maxBytes} байт (SIGNAL_MAX_BYTES)`)
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createSignalClient({
  baseUrl = SIGNAL_DEFAULT_URL, hosts = [], clientId = '', clientSecret = '', scopes = SIGNAL_DEFAULT_SCOPES,
  timeoutMs = SIGNAL_CLIENT_DEFAULTS.timeoutMs, maxBytes = SIGNAL_CLIENT_DEFAULTS.maxBytes,
  fetch: fetchImpl = globalThis.fetch, log = null, allowLoopback = false, now = Date.now, sleep = sleepAbortable,
  retries = SIGNAL_CLIENT_DEFAULTS.retries, backoffMs = SIGNAL_CLIENT_DEFAULTS.backoffMs,
  maxRateRetries = SIGNAL_CLIENT_DEFAULTS.maxRateRetries, maxRetryAfterMs = SIGNAL_CLIENT_DEFAULTS.maxRetryAfterMs,
  retryAfterMinMs = SIGNAL_CLIENT_DEFAULTS.retryAfterMinMs, retryAfterMaxMs,
} = {}) {
  const base = signalBaseUrl(baseUrl, { hosts, allowLoopback })
  const { origin } = base
  const originUrl = new URL(origin)
  const configured = Boolean(clientId && clientSecret)
  const scopeList = toScopes(scopes)
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : SIGNAL_CLIENT_DEFAULTS.timeoutMs
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : SIGNAL_CLIENT_DEFAULTS.maxBytes
  // retryAfterMaxMs (SIGNAL_RETRY_AFTER_MAX_MS) — имя настройки; maxRetryAfterMs — прежнее имя параметра, действует, если новое не задано.
  const retryMaxMs = msOr(retryAfterMaxMs, msOr(maxRetryAfterMs, SIGNAL_CLIENT_DEFAULTS.maxRetryAfterMs))
  const retryMinMs = msOr(retryAfterMinMs, SIGNAL_CLIENT_DEFAULTS.retryAfterMinMs)

  // Токен — только здесь и только в памяти.
  let token = null
  let tokenExpiresAt = 0
  let tokenFlight = null
  const secrets = () => [clientSecret, clientId, token]
  const clean = (text) => redact(text, secrets()).replace(/\s+/g, ' ').slice(0, 280)
  const note = (level, obj, msg) => { try { log?.[level]?.(JSON.parse(redact(JSON.stringify(obj), secrets())), msg) } catch { /* журнал не должен ронять запрос */ } }

  function buildUrl(path, query) {
    if (typeof path !== 'string' || !PATH_RE.test(path)) throw new SignalError('invalid', 'SIGNAL: недопустимый адрес запроса')
    const url = new URL(path, origin)
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }
    // Точная проверка адреса каждого запроса: тот же хост, схема и порт, что у базового.
    if (url.protocol !== originUrl.protocol || url.hostname !== originUrl.hostname || url.port !== originUrl.port
      || url.username || url.password || !base.hosts.includes(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())) {
      throw new SignalError('invalid', 'SIGNAL: адрес запроса не из списка разрешённых')
    }
    return url.toString()
  }

  const transient = (e) => e.code === 'http' && (e.status === undefined || e.status >= 500)

  // Один обмен с повторами по правилам: 429, 401, 5xx и 550, обрыв связи. Возвращает { status, text }.
  async function exchange({ method, path, query, body, auth, detail422 }, signal) {
    if (method !== 'GET' && method !== 'POST') throw new SignalError('invalid', 'SIGNAL: метод запроса не разрешён')
    if (method === 'POST' && !POST_PATHS.has(path)) throw new SignalError('invalid', 'SIGNAL: этот запрос не разрешён')
    const url = buildUrl(path, query)
    let attempts = 0
    let rate = 0
    let reauthed = false
    for (;;) {
      if (signal?.aborted) throw abortedError(signal)
      const headers = { accept: 'application/json' }
      let used = null
      if (auth) { used = await ensureToken(signal); headers.authorization = `Bearer ${used}` }
      let payload
      if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
      const timer = AbortSignal.timeout(timeout)
      const attemptSignal = signal ? AbortSignal.any([signal, timer]) : timer
      const fail = (err) => {
        if (signal?.aborted) return abortedError(signal)
        if (timer.aborted) return new SignalError('timeout', `SIGNAL не ответил за ${Math.round(timeout / 1000)} с`)
        if (err instanceof SignalError) return err
        const text = `${err?.cause?.message || ''} ${err?.message || ''}`
        if (/redirect/i.test(text)) return new SignalError('http', 'SIGNAL: перенаправление не разрешено')
        const code = err?.cause?.code || err?.code || ''
        return new SignalError('http', `SIGNAL недоступен${code ? `: ${String(code).slice(0, 40)}` : ''}`)
      }
      let res
      try {
        res = await fetchImpl(url, { method, headers, body: payload, redirect: 'error', signal: attemptSignal })
      } catch (err) {
        const e = fail(err)
        if (transient(e) && !/перенаправление/.test(e.message) && attempts < retries) {
          attempts += 1
          note('warn', { code: e.code, attempt: attempts }, 'signal retry')
          await sleep(backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 1000, signal)
          continue
        }
        throw e
      }
      const status = res.status
      if (status >= 200 && status < 300) {
        try {
          return { status, text: await readText(res, limit) }
        } catch (err) {
          const e = fail(err)
          if (e.code === 'http' && attempts < retries) {
            attempts += 1
            note('warn', { code: 'body', attempt: attempts }, 'signal retry')
            await sleep(backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 1000, signal)
            continue
          }
          throw e
        }
      }
      // Не успех: тело — только для выбора причины (422 при получении токена), в текст ошибки оно не идёт.
      let errorText = ''
      if (detail422 && status === 422) { try { errorText = (await readText(res, 2048)).trim() } catch { errorText = '' } } else await drain(res)
      if (status >= 300 && status < 400) throw new SignalError('http', 'SIGNAL: перенаправление не разрешено', { status })
      if (status === 401) {
        if (auth && !reauthed) {
          reauthed = true
          if (token === used) { token = null; tokenExpiresAt = 0 }
          note('warn', { status }, 'signal reauth')
          continue
        }
        throw new SignalError('auth', 'SIGNAL отклонил токен или учётные данные (HTTP 401)', { status })
      }
      if (status === 403) throw new SignalError('scope', 'SIGNAL: нет прав на запрос (HTTP 403)', { status })
      if (status === 450) throw new SignalError('rate_limited', 'SIGNAL: исчерпана квота (HTTP 450)', { status })
      if (status === 429) {
        if (rate >= maxRateRetries) throw new SignalError('rate_limited', 'SIGNAL: слишком много запросов (HTTP 429)', { status })
        rate += 1
        const wait = parseRetryAfter(res.headers.get('retry-after'), {
          now: now(), minMs: retryMinMs, maxMs: retryMaxMs, defaultMs: SIGNAL_CLIENT_DEFAULTS.defaultRetryAfterMs,
        })
        note('warn', { status, waitMs: wait, attempt: rate }, 'signal rate limit')
        await sleep(wait, signal)
        continue
      }
      if (status >= 500) {
        if (attempts < retries) {
          attempts += 1
          note('warn', { status, attempt: attempts }, 'signal retry')
          await sleep(backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 1000, signal)
          continue
        }
        throw new SignalError('http', `SIGNAL недоступен (HTTP ${status})`, { status })
      }
      if (detail422 && status === 422) throw detail422(errorText, status)
      throw new SignalError('http', `SIGNAL: запрос не выполнен (HTTP ${status})`, { status })
    }
  }

  function parseJson(text) {
    try { return JSON.parse(text) } catch { throw new SignalError('invalid', 'SIGNAL: ответ — не JSON') }
  }

  // 422 при получении токена — одна строка-причина из набора спецификации.
  function tokenReason(text, status) {
    let reason = text
    try { reason = JSON.parse(text) } catch { /* не JSON — берём как есть */ }
    if (reason === 'ScopeError') return new SignalError('scope', 'SIGNAL: запрошенные права не выданы (ScopeError)', { status })
    if (reason === 'CredentialError') return new SignalError('auth', 'SIGNAL отклонил идентификатор или секрет клиента (CredentialError)', { status })
    if (reason === 'LicenseError') return new SignalError('auth', 'SIGNAL: лицензия не позволяет доступ (LicenseError)', { status })
    return new SignalError('http', 'SIGNAL: токен не выдан (HTTP 422)', { status })
  }

  async function fetchToken(signal) {
    const { text } = await exchange({
      method: 'POST', path: SIGNAL_TOKEN_PATH, auth: false, detail422: tokenReason,
      body: { clientId, clientSecret, scopes: scopeList },
    }, signal)
    const data = parseJson(text)
    const t = data?.token
    const expiresIn = data?.expiresIn
    if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw new SignalError('invalid', 'SIGNAL: в ответе нет токена')
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 31 * 86_400) throw new SignalError('invalid', 'SIGNAL: срок токена не число секунд')
    token = t
    tokenExpiresAt = now() + expiresIn * 1000
    return { expiresInSec: expiresIn }
  }

  // Токен обновляется за tokenSkewMs до срока; параллельные запросы ждут один и тот же обмен.
  async function ensureToken(signal) {
    if (!configured) throw new SignalError('not_configured', 'SIGNAL не настроен: нужны SIGNAL_CLIENT_ID и SIGNAL_CLIENT_SECRET')
    if (token && now() < tokenExpiresAt - SIGNAL_CLIENT_DEFAULTS.tokenSkewMs) return token
    if (!tokenFlight) tokenFlight = fetchToken(signal).finally(() => { tokenFlight = null })
    await tokenFlight
    return token
  }

  // Последний рубеж: какой бы ни была ошибка, секрета и токена в её тексте нет.
  async function guarded(fn) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof SignalError) {
        const out = new SignalError(err.code, clean(err.message), { status: err.status })
        if (err.reason !== undefined) out.reason = err.reason
        throw out
      }
      throw new SignalError('http', clean(err?.message || 'SIGNAL: сбой'))
    }
  }

  return {
    configured,
    origin,
    // Получить (или обновить) токен; сам токен наружу не отдаётся.
    ensureToken: ({ signal } = {}) => guarded(async () => {
      await ensureToken(signal)
      return { expiresInSec: Math.max(0, Math.round((tokenExpiresAt - now()) / 1000)) }
    }),
    // Запрос к известному пути: { method: 'GET'|'POST', path, query, body } → разобранный JSON.
    request: ({ method = 'GET', path, query, body }, { signal } = {}) => guarded(async () => {
      if (!configured) throw new SignalError('not_configured', 'SIGNAL не настроен: нужны SIGNAL_CLIENT_ID и SIGNAL_CLIENT_SECRET')
      const { text } = await exchange({ method, path, query, body, auth: true }, signal)
      return parseJson(text)
    }),
    close() {
      token = null
      tokenExpiresAt = 0
    },
  }
}
