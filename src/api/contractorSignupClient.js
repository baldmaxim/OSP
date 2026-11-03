// Регистрация подрядчика на сайте и восстановление пароля — запросы к своему серверу (server/osp-api/src/routes/signup.js).
// Ответ — данные или исключение: error.message — текст сервера, error.code, error.field (какое поле исправить),
// error.status, error.retryAfterSec. Модуль чистый: fetch передаётся извне (tests/osp-api/client-signup.test.mjs).

// ── Задача на вычисление ─────────────────────────────────────────────────────────────────────────────
// Свой SHA-256 здесь, а не crypto.subtle: тот обещанием на каждый расчёт в десятки раз медленнее, а расчётов сотни тысяч.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const W = new Uint32Array(64)
const rotr = (x, n) => (x >>> n) | (x << (32 - n))

// Строка ASCII → первые 4 байта SHA-256 как число и дальше по запросу: для проверки хватает начала хэша.
export function sha256Ascii(text) {
  const n = text.length
  const blocks = ((n + 8) >> 6) + 1
  const m = new Uint32Array(blocks * 16)
  for (let i = 0; i < n; i++) m[i >> 2] |= (text.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8)
  m[n >> 2] |= 0x80 << (24 - (n % 4) * 8)
  m[blocks * 16 - 1] = n * 8
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  for (let b = 0; b < blocks; b++) {
    for (let t = 0; t < 16; t++) W[t] = m[b * 16 + t]
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15]
      const c = W[t - 2]
      W[t] = (W[t - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[t - 7] + (rotr(c, 17) ^ rotr(c, 19) ^ (c >>> 10))) | 0
    }
    let a = h0, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7, bb = h1
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x >>> 0)
}

const leadingZeroBits = (words) => {
  let bits = 0
  for (const w of words) {
    if (w === 0) { bits += 32; continue }
    return bits + Math.clz32(w)
  }
  return bits
}

// Число, с которым хэш строки «задача:число» начинается с нужного количества нулевых бит. Порциями: страница не замирает.
export async function solveChallenge(challenge, bits, { batch = 20_000, pause = () => new Promise((r) => setTimeout(r)) } = {}) {
  for (let n = 0; ; n += batch) {
    for (let i = n; i < n + batch; i++) {
      if (leadingZeroBits(sha256Ascii(`${challenge}:${i}`)) >= bits) return String(i)
    }
    await pause()
  }
}

// ── Запросы ──────────────────────────────────────────────────────────────────────────────────────────
function failure(status, body) {
  const error = new Error(body?.error || (status ? `Сервер ответил ${status}` : 'Сервер недоступен — проверьте связь и повторите'))
  error.status = status
  error.code = body?.code || null
  error.field = body?.field || null
  error.retryAfterSec = body?.retryAfterSec ?? null
  return error
}

export function createSignupClient({ fetchImpl, solve = solveChallenge }) {
  async function call(path, { method = 'POST', body } = {}) {
    let res
    try {
      res = await fetchImpl(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw failure(0, null)
    }
    let data = null
    try { data = await res.json() } catch { /* не JSON — страница nginx */ }
    if (!res.ok) throw failure(res.status, data)
    return data
  }

  // Задача действует один раз и недолго: устарела, пока заполняли форму, — одна повторная попытка с новой.
  async function withProof(path, body) {
    for (let attempt = 0; ; attempt++) {
      const { challenge, bits } = await call('/api/auth/register/challenge', { method: 'GET' })
      const answer = await solve(challenge, bits)
      try {
        return await call(path, { body: { ...body, challenge, answer } })
      } catch (err) {
        if (err.code !== 'OSP_POW' || attempt >= 1) throw err
      }
    }
  }

  return {
    register: (form) => withProof('/api/auth/register', form),
    preview: (token, kind) => call('/api/auth/register/preview', { body: { token, kind } }),
    confirm: (token, password) => call('/api/auth/register/confirm', { body: { token, password } }),
    claim: (token, decision) => call('/api/auth/register/claim', { body: { token, decision } }),
    forgot: (email, website = '') => withProof('/api/auth/password/forgot', { email, ...(website ? { website } : {}) }),
    reset: (token, newPassword) => call('/api/auth/password/reset', { body: { token, newPassword } }),
  }
}

// Заявки на регистрацию — «Администрирование»: при своём входе сессия в cookie и отметка защиты (sessionFetch).
export function createSignupAdminClient({ fetchImpl }) {
  async function call(path, { method = 'GET', body } = {}) {
    let res
    try {
      res = await fetchImpl(`/api/admin/contractor-signups${path}`, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw failure(0, null)
    }
    let data = null
    try { data = await res.json() } catch { /* не JSON */ }
    if (!res.ok) {
      const err = failure(res.status, data)
      err.unavailable = res.status === 404 || res.status === 502 || res.status === 504 || data?.code === 'OSP_SIGNUP_MIGRATION'
      throw err
    }
    return data
  }
  return {
    // { open, items: [...], hasMore }
    list: ({ status = null, before = null } = {}) => {
      const q = new URLSearchParams()
      if (status) q.set('status', status)
      if (before) q.set('before', before)
      const text = q.toString()
      return call(text ? `?${text}` : '')
    },
    decide: (id, decision) => call(`/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision } }),
  }
}
