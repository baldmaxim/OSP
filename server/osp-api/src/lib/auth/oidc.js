// Вход через Keycloak su10 (OIDC, код + PKCE, BFF): браузер видит только cookie сессии портала, токены Keycloak — только
// здесь (src/lib/auth/sessions.js хранит refresh и id_token шифром). Библиотеки — openid-client (поток, проверка ответа
// авторизации и id_token) и jose (подпись access token по JWKS realm).
//
// Что проверяется (tests/osp-api/keycloak.test.mjs):
//   • ответ авторизации: state — своей cookie (отдельная на каждую вкладку со входом), iss (RFC 9207), код — с PKCE S256;
//   • id_token: iss, aud, nonce, срок (openid-client);
//   • access token: подпись RS256 ключом realm, iss, aud ∋ клиент (у Keycloak aud бывает строкой и массивом), azp = клиент,
//     срок; sub — UUID; почта, имя и роли — строгих типов и длин. Роль доступа к порталу — resource_access.<клиент>.roles;
//   • адрес возврата — только из настройки (OIDC_REDIRECT_URI), returnUrl — только свой путь (не «//», не «/\», не /api/).
// Сырые параметры ответа (code, state), токены и тела ошибок Keycloak не попадают ни в журнал, ни в ответы.
import { createHash, randomBytes } from 'node:crypto'
import * as oidcClient from 'openid-client'
import { createRemoteJWKSet, jwtVerify, customFetch as joseCustomFetch } from 'jose'
import { parseCookies, serializeCookie } from './cookies.js'

export const OIDC_STATE_PREFIX = '__Host-osp_oidc_'
// Состояние входа живёт, пока открыта форма входа Keycloak (30 минут); вкладок со входом — не больше трёх.
export const STATE_TTL_MS = 30 * 60_000
export const STATE_MAX = 3
export const RETURN_URL_MAX = 512
export const ACCESS_ROLE = 'access'
export const OIDC_TIMEOUT_MS = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_COOKIE_RE = /^__Host-osp_oidc_([0-9a-f]{16})$/
const BLOB_RE = /^v1:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}$/

// Ошибка входа с кодом для /login?sso_error=<код> — без подробностей ответа Keycloak.
export class OidcError extends Error {
  constructor(code, cause) {
    super(`oidc: ${code}`)
    this.code = code
    if (cause) this.detail = errorCode(cause)
  }
}

// Код ошибки для журнала: имя класса и код, без текста (в тексте бывают фрагменты ответа).
export function errorCode(err) {
  if (!err) return null
  const parts = [err.name, err.code, err.error].filter((v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(v))
  return parts.join(':').slice(0, 120) || 'error'
}

// Путь SPA после входа. Иное (абсолютный адрес, «//хост», «/\хост», API, управляющие знаки, длиннее 512 байт) — «/».
// Адрес нормализуется так, как его отдаст URL: не-ASCII — в %-кодировке (иначе заголовок Location не собрать).
export function safeReturnUrl(raw) {
  const v = typeof raw === 'string' ? raw : ''
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || Buffer.byteLength(v) > RETURN_URL_MAX) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return '/'
  let u
  try { u = new URL(v, 'https://portal.invalid') } catch { return '/' }
  if (u.origin !== 'https://portal.invalid') return '/'
  const out = `${u.pathname}${u.search}${u.hash}`
  if (out === '/api' || out.startsWith('/api/') || out.startsWith('/api?')) return '/'
  if (Buffer.byteLength(out) > RETURN_URL_MAX || !/^[\u0021-\u007e]+$/.test(out)) return '/'
  return out
}

export const stateKey = (state) => createHash('sha256').update(String(state)).digest('hex').slice(0, 16)

// Почта, имя, роли — строгие типы и длины: токен с чужим видом — не вход, а ошибка.
function strictClaims(payload, clientId) {
  const sub = payload.sub
  if (typeof sub !== 'string' || !UUID.test(sub)) throw new OidcError('claims')
  const email = payload.email
  if (email !== undefined && (typeof email !== 'string' || email.length > 254)) throw new OidcError('claims')
  for (const key of ['name', 'given_name', 'family_name', 'preferred_username']) {
    const v = payload[key]
    if (v !== undefined && (typeof v !== 'string' || v.length > 200)) throw new OidcError('claims')
  }
  const sid = payload.sid
  if (sid !== undefined && (typeof sid !== 'string' || sid.length > 200)) throw new OidcError('claims')
  const roles = payload.resource_access?.[clientId]?.roles
  if (roles !== undefined && (!Array.isArray(roles) || roles.length > 50 || roles.some((r) => typeof r !== 'string' || r.length > 100))) {
    throw new OidcError('claims')
  }
  return { subject: sub.toLowerCase(), email: email ? email.trim().toLowerCase() : null, sid: sid || null, roles: roles || [] }
}

// ФИО «Фамилия Имя» — как при сверке группы (src/lib/auth/accessSync.js).
export function fullNameOf({ family_name: family, given_name: given, name } = {}) {
  const joined = [family, given].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join(' ')
  const out = (joined || (typeof name === 'string' ? name.trim() : '')).replace(/\s+/g, ' ')
  return out ? out.slice(0, 200) : null
}

// fetch с пределом времени — для всех обращений к Keycloak (вход, JWKS, refresh, выход).
export function timedFetch(fetchImpl, timeoutMs) {
  return (url, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  }
}

export function createOidc({ oidc, publicOrigin, box, fetch: fetchImpl = globalThis.fetch, log = null, now = Date.now }) {
  const http = timedFetch(fetchImpl, OIDC_TIMEOUT_MS)
  let configuration = null
  let jwks = null
  let pending = null
  let failedAt = 0
  let lastProblem = null
  const RETRY_MS = 30_000

  // Discovery — при первой нужде и с повтором: недоступный Keycloak не мешает службе запуститься и работать.
  async function load() {
    const cfg = await oidcClient.discovery(new URL(oidc.issuer), oidc.clientId, undefined,
      oidcClient.ClientSecretBasic(oidc.clientSecret), { [oidcClient.customFetch]: http, timeout: OIDC_TIMEOUT_MS / 1000 })
    const meta = cfg.serverMetadata()
    if (meta.issuer !== oidc.issuer) throw Object.assign(new Error('oidc: issuer discovery не совпал с OIDC_ISSUER'), { code: 'OSP_OIDC_ISSUER' })
    if (!meta.jwks_uri || !meta.authorization_endpoint || !meta.token_endpoint) throw Object.assign(new Error('oidc: discovery неполный'), { code: 'OSP_OIDC_DISCOVERY' })
    cfg[oidcClient.customFetch] = http
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri), {
      [joseCustomFetch]: http, timeoutDuration: OIDC_TIMEOUT_MS, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000,
    })
    return cfg
  }

  async function ready() {
    if (configuration) return configuration
    if (!pending) {
      if (now() - failedAt < RETRY_MS && lastProblem) throw lastProblem
      pending = load().then((cfg) => {
        configuration = cfg
        lastProblem = null
        return cfg
      }, (err) => {
        failedAt = now()
        // issuer discovery не тот, что в настройке: openid-client сверяет его сам (ClientError с attribute issuer).
        const mismatch = err?.code === 'OSP_OIDC_ISSUER' || (err?.code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED' && err?.cause?.attribute === 'issuer')
        lastProblem = mismatch ? Object.assign(new Error('oidc: issuer discovery не совпал с OIDC_ISSUER'), { code: 'OSP_OIDC_ISSUER' }) : new OidcError('unavailable', err)
        log?.warn({ code: errorCode(err) }, 'oidc discovery')
        throw lastProblem
      }).finally(() => { pending = null })
    }
    return pending
  }

  // Проверка access token: подпись, iss, aud ∋ клиент, azp = клиент, срок, строгие claims.
  async function verifyAccess(token) {
    if (typeof token !== 'string' || !token) throw new OidcError('token')
    await ready()
    let payload
    try {
      payload = (await jwtVerify(token, jwks, { issuer: oidc.issuer, audience: oidc.clientId, algorithms: ['RS256'], clockTolerance: 30 })).payload
    } catch (err) {
      throw new OidcError(String(err?.code || '').startsWith('ERR_JWKS') ? 'unavailable' : 'token', err)
    }
    if (payload.azp !== oidc.clientId) throw new OidcError('token')
    const claims = strictClaims(payload, oidc.clientId)
    return { ...claims, hasAccess: claims.roles.includes(ACCESS_ROLE) }
  }

  // Начало входа → адрес Keycloak и cookie состояния этой вкладки.
  async function begin({ returnUrl }) {
    const cfg = await ready()
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const verifier = oidcClient.randomPKCECodeVerifier()
    const challenge = await oidcClient.calculatePKCECodeChallenge(verifier)
    const url = oidcClient.buildAuthorizationUrl(cfg, {
      redirect_uri: oidc.redirectUri, scope: oidc.scopes, response_type: 'code',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    })
    const k = stateKey(state)
    const value = box.encrypt(JSON.stringify({ s: state, n: nonce, v: verifier, r: safeReturnUrl(returnUrl), t: now() }), `oidc-login:${k}`)
    return { url: url.href, cookie: serializeCookie(OIDC_STATE_PREFIX + k, value, { maxAgeSec: STATE_TTL_MS / 1000, httpOnly: true }) }
  }

  // Cookie состояния входа из заголовка: { k, value: { s, n, v, r, t } | null }[] (null — не расшифровалась или истекла).
  function stateCookies(cookieHeader) {
    const out = []
    for (const [name, raw] of parseCookies(cookieHeader).values) {
      const m = STATE_COOKIE_RE.exec(name)
      if (!m) continue
      let value = null
      if (BLOB_RE.test(raw)) {
        try {
          const v = JSON.parse(box.decrypt(raw, `oidc-login:${m[1]}`))
          if (v && typeof v.s === 'string' && stateKey(v.s) === m[1] && typeof v.t === 'number' && now() - v.t < STATE_TTL_MS) value = v
        } catch { /* чужая или старая — как истекшая */ }
      }
      out.push({ k: m[1], name, value })
    }
    return out
  }

  // Новая вкладка со входом: старые и негодные cookie состояния — стереть, чтобы их было не больше STATE_MAX вместе с новой.
  function cookiesToClear(cookieHeader) {
    const all = stateCookies(cookieHeader)
    const bad = all.filter((c) => !c.value)
    const good = all.filter((c) => c.value).sort((a, b) => a.value.t - b.value.t)
    const extra = good.slice(0, Math.max(0, good.length - (STATE_MAX - 1)))
    return [...bad, ...extra].map((c) => clearStateCookie(c.name))
  }

  const clearStateCookie = (name) => serializeCookie(name, '', { maxAgeSec: 0, httpOnly: true })

  // Состояние для ответа авторизации с этим state → { name, returnUrl, nonce, verifier, state } | null
  function stateFor(cookieHeader, state) {
    if (typeof state !== 'string' || state.length < 16 || state.length > 200) return null
    const k = stateKey(state)
    const found = stateCookies(cookieHeader).find((c) => c.k === k && c.value?.s === state)
    if (!found) return null
    return { name: found.name, returnUrl: safeReturnUrl(found.value.r), nonce: found.value.n, verifier: found.value.v, state }
  }

  // Ответ авторизации → токены и кто это. Ошибка — OidcError с кодом для страницы входа.
  async function finish({ rawQuery, pendingState }) {
    const cfg = await ready()
    const current = new URL(oidc.redirectUri)
    current.search = rawQuery
    let tokens
    try {
      tokens = await oidcClient.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: pendingState.verifier, expectedState: pendingState.state, expectedNonce: pendingState.nonce, idTokenExpected: true,
      }, undefined, { redirectUri: oidc.redirectUri })
    } catch (err) {
      throw new OidcError(isUnavailable(err) ? 'unavailable' : 'exchange', err)
    }
    if (!tokens.refresh_token) throw new OidcError('exchange')
    const access = await verifyAccess(tokens.access_token)
    const id = tokens.claims() || {}
    if (typeof id.sub !== 'string' || id.sub.toLowerCase() !== access.subject) throw new OidcError('token')
    const idClaims = strictClaims({ ...id, resource_access: undefined }, oidc.clientId)
    return {
      access,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token || null,
      email: idClaims.email || access.email,
      fullName: fullNameOf(id),
      sid: access.sid || idClaims.sid,
    }
  }

  // Перепроверка: refresh grant → { refreshToken, idToken, access }. Исход: 'invalid_grant' | 'unavailable' (OidcError.code).
  async function refresh(refreshToken) {
    let cfg
    try { cfg = await ready() } catch (err) { throw new OidcError('unavailable', err) }
    let tokens
    try {
      tokens = await oidcClient.refreshTokenGrant(cfg, refreshToken)
    } catch (err) {
      if (err?.error === 'invalid_grant') throw new OidcError('invalid_grant', err)
      throw new OidcError('unavailable', err)
    }
    let access
    try {
      access = await verifyAccess(tokens.access_token)
    } catch (err) {
      // Токен не прошёл проверку — это не «доступ отозван»: настройка или ключи. Сессию не трогаем, считаем сбоем.
      throw new OidcError('unavailable', err)
    }
    return { refreshToken: tokens.refresh_token || refreshToken, idToken: tokens.id_token || null, access }
  }

  // Адрес выхода из СУ-10 (вход во все порталы в этом браузере). Без id_token — с client_id: Keycloak спросит подтверждение.
  async function endSessionUrl(idToken) {
    let cfg
    try { cfg = await ready() } catch { return null }
    if (!cfg.serverMetadata().end_session_endpoint) return null
    const params = { post_logout_redirect_uri: oidc.postLogoutRedirectUri, client_id: oidc.clientId }
    if (idToken) params.id_token_hint = idToken
    return oidcClient.buildEndSessionUrl(cfg, params).href
  }

  // Готовность: discovery отвечает (справочно — на готовность службы не влияет).
  async function check() {
    await ready()
    return 'ok'
  }

  return {
    ready, check, begin, stateFor, cookiesToClear, clearStateCookie, finish, refresh, verifyAccess, endSessionUrl,
    issuer: oidc.issuer, clientId: oidc.clientId, publicOrigin,
    status: () => (configuration ? 'ok' : lastProblem?.code === 'OSP_OIDC_ISSUER' ? 'issuer_mismatch' : lastProblem ? 'unavailable' : 'unknown'),
  }
}

function isUnavailable(err) {
  const name = String(err?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError' || err instanceof TypeError) return true
  const status = Number(err?.status || err?.response?.status || 0)
  return status >= 500
}
