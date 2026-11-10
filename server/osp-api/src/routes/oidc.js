// Вход через Keycloak su10 (AUTH_MODE=keycloak) — два открытых адреса; в других режимах — 404.
//
//   GET /api/auth/oidc/login?returnUrl=  — начало входа: cookie состояния этой вкладки и переход на страницу входа СУ-10.
//                                          Имя адреса задано контуром: на него ведёт «Войдите заново» темы входа.
//   GET /api/auth/oidc/callback          — возврат из СУ-10: state своей cookie, обмен кода, проверка токенов, связь учётки,
//                                          новая сессия портала. Параметры ответа (code, state) до маршрута снимает rewriteUrl
//                                          (src/app.js): в журнал и тексты ошибок Fastify они не попадают.
// Устройство и проверки — src/lib/auth/oidc.js, src/lib/auth/identity.js.
import { access } from '../lib/access.js'
import { OidcError, errorCode } from '../lib/auth/oidc.js'
import { SESSION_COOKIE, readToken, sessionCookies } from '../lib/auth/cookies.js'

export const OIDC_LOGIN_REASON = 'Начало входа через СУ-10 (Keycloak): сессии ещё нет; отвечает только переходом страницы, ставит лишь зашифрованную cookie состояния входа'
export const OIDC_CALLBACK_REASON = 'Возврат из СУ-10 после входа: сессии ещё нет; сам проверяет state своей cookie, код с PKCE, подпись и адресатов токенов'
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback'
const SSO_ERRORS = new Set(['state', 'unavailable', 'exchange', 'token', 'claims', 'disabled', 'navigation', 'config', 'error', 'access_denied',
  'login_required', 'temporarily_unavailable', 'server_error', 'invalid_request'])
const ssoErrorCode = (code) => (SSO_ERRORS.has(code) ? code : 'error')

// rewriteUrl сервера: у возврата из СУ-10 строка запроса (code, state, session_state, iss) уходит в закрытое поле запроса,
// адрес — без неё. Так её нет ни в журнале, ни в текстах ошибок Fastify, ни у лимитов и проверок.
export function rewriteOidcUrl(req) {
  const url = req.url || '/'
  const q = url.indexOf('?')
  if (q < 0) return url
  const path = url.slice(0, q)
  if (path === OIDC_CALLBACK_PATH) {
    Object.defineProperty(req, 'ospOidcQuery', { value: url.slice(q + 1), enumerable: false, configurable: true })
    return path
  }
  return url
}

export function registerOidc(app, ctx) {
  const { config, oidc, identity, sessions, limiters, principal } = ctx
  const on = config.authMode === 'keycloak' && Boolean(oidc)
  const origin = config.auth?.publicOrigin || ''
  const notFound = (reply) => reply.code(404).send({ error: 'Not found' })
  const toLogin = (reply, code, cookies = []) => {
    if (cookies.length) reply.header('set-cookie', cookies)
    return reply.redirect(`/login?sso_error=${ssoErrorCode(code)}`, 302)
  }
  // Браузер прислал Sec-Fetch-* — только переход страницы. Старые браузеры их не шлют (Safari до 16.4) — пускаем: cookie состояния
  // всё равно не больше трёх (каждое начало входа гасит лишние).
  const navigation = (request) => {
    const mode = request.headers['sec-fetch-mode']
    const dest = request.headers['sec-fetch-dest']
    if (mode === undefined && dest === undefined) return true
    return mode === 'navigate' && dest === 'document'
  }
  const limited = (request, reply) => {
    if (limiters.oidcPerIp.take(request.ip)) return false
    reply.header('retry-after', '60').code(429).send({ error: 'Слишком много попыток входа с этого адреса — повторите через минуту' })
    return true
  }

  app.route({
    method: 'GET', url: '/api/auth/oidc/login',
    config: { access: access.open(OIDC_LOGIN_REASON) },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      if (limited(request, reply)) return reply
      // Только переход страницы: картинка или запрос с чужой страницы *.su10.ru иначе набивали бы cookie состояния.
      if (!navigation(request)) return reply.code(400).send({ error: 'Вход — только переходом по ссылке', code: 'OSP_SSO_NAVIGATION' })
      let started
      try {
        started = await oidc.begin({ returnUrl: request.query?.returnUrl })
      } catch (err) {
        request.log.warn({ code: err?.detail || err?.code }, 'oidc login')
        return toLogin(reply, err?.code === 'OSP_OIDC_ISSUER' ? 'config' : 'unavailable')
      }
      reply.header('set-cookie', [...oidc.cookiesToClear(request.headers.cookie), started.cookie])
      return reply.redirect(started.url, 302)
    },
  })

  app.route({
    method: 'GET', url: OIDC_CALLBACK_PATH,
    config: { access: access.open(OIDC_CALLBACK_REASON) },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      if (limited(request, reply)) return reply
      const raw = request.raw.ospOidcQuery || ''
      const params = new URLSearchParams(raw)
      const pending = oidc.stateFor(request.headers.cookie, params.get('state'))
      if (!pending) {
        // Вход уже завершён в другой вкладке — у браузера есть сессия: на главную.
        const p = await principal.resolve(request).catch(() => null)
        if (p?.kind === 'user') return reply.redirect(`${origin}/`, 302)
        return toLogin(reply, 'state')
      }
      const clearState = oidc.clearStateCookie(pending.name)
      const kcError = params.get('error')
      if (kcError) return toLogin(reply, /^[a-z_]{1,40}$/.test(kcError) ? kcError : 'error', [clearState])

      let r
      try {
        r = await oidc.finish({ rawQuery: raw, pendingState: pending })
      } catch (err) {
        request.log.warn({ code: err instanceof OidcError ? err.code : 'error', detail: err?.detail || errorCode(err) }, 'oidc callback')
        return toLogin(reply, err instanceof OidcError ? err.code : 'exchange', [clearState])
      }
      if (!r.access.hasAccess) {
        reply.header('set-cookie', [clearState])
        return reply.redirect('/no-access', 302)
      }

      const outcome = await identity.completeLogin({
        subject: r.access.subject, email: r.email, fullName: r.fullName,
        keycloak: { sid: r.sid, refreshToken: r.refreshToken, idToken: r.idToken },
      })
      if (outcome.kind === 'requested') { reply.header('set-cookie', [clearState]); return reply.redirect('/access-requested', 302) }
      if (outcome.kind === 'rejected') { reply.header('set-cookie', [clearState]); return reply.redirect('/no-access', 302) }
      if (outcome.kind === 'disabled') return toLogin(reply, 'disabled', [clearState])

      // Прежняя сессия этого браузера — другого человека: отозвать (защита от подмены сессии). Своя — её и так заменит cookie.
      const old = readToken(request.headers.cookie, SESSION_COOKIE)
      if (old.value) {
        const prev = await sessions.lookup(old.value).catch(() => null)
        if (prev && prev.userId !== outcome.userId) await sessions.revoke(old.value, 'replaced').catch(() => {})
      }
      reply.header('set-cookie', [...sessionCookies({ sessionToken: outcome.session.token, csrf: outcome.session.csrf, maxAgeSec: outcome.session.maxAgeSec }), clearState])
      return reply.redirect(`${origin}${pending.returnUrl}`, 302)
    },
  })
}
