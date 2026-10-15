// Свой вход портала (AUTH_MODE both | own) — /api/auth/*. Устройство и гарантии — src/lib/auth/service.js,
// src/lib/principal.js, migration/CUTOVER.md («Свой вход tender.su10.ru»).
//
//   GET  /api/auth/config                — режим входа: фронт решает, какую форму показать (открытый);
//   POST /api/auth/login                 — почта + пароль → своя сессия в cookie (открытый);
//   POST /api/auth/logout                — выход; { all: true } — на всех устройствах (открытый: стирает только своё);
//   POST /api/auth/password              — смена своего пароля (в том числе временного);
//   GET  /api/auth/me                    — кто вошёл;
//   POST /api/auth/admin/users           — администратор заводит учётку, временный пароль — один раз;
//   POST /api/auth/admin/reset-password  — администратор выдаёт временный пароль.
// Самостоятельной регистрации нет (решение владельца портала 15.10: писем нет — учётки заводит администратор).
// В режиме supabase маршруты, кроме config и me, отвечают 404: вход и учётки — в Supabase Auth.
// Тела запросов в журнал не попадают (app.js пишет только метод, шаблон маршрута, код и время).
import { z } from 'zod'
import { access } from '../lib/access.js'
import { originProblem, csrfProblem, clearSessionCookies } from '../lib/principal.js'
import { CSRF_COOKIE, SESSION_COOKIE, readToken, sessionCookies, serializeCookie } from '../lib/auth/cookies.js'

export const AUTH_CONFIG_REASON = 'Режим входа портала: какую форму входа показать; данных и учёток не отдаёт'
export const AUTH_LOGIN_REASON = 'Вход по почте и паролю: до входа сессии нет; только запрос с самого портала (Origin, Sec-Fetch-Site, JSON), лимиты по адресу и по почте'
export const AUTH_LOGOUT_REASON = 'Выход: стирает только свою сессию; чужую отозвать нельзя — нужен её идентификатор и CSRF'

const LOGIN_BODY = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(1024) })
const LOGOUT_BODY = z.object({ all: z.boolean().optional() })
const PASSWORD_BODY = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(4096) })
const CREATE_BODY = z.object({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(64),
  counterpartyId: z.string().uuid().nullable().optional(),
  objectIds: z.array(z.string().uuid()).max(500).optional(),
})
const RESET_BODY = z.object({ userId: z.string().uuid() })

const isJson = (request) => /^application\/json(\s*;|$)/i.test(String(request.headers['content-type'] || ''))

export function registerAuth(app, ctx) {
  const { config, authService, sessions, isSuperadmin, limiters } = ctx
  const mode = config.authMode || 'supabase'
  const own = mode !== 'supabase'
  const maxAgeSec = Math.floor((config.auth?.absoluteDays ?? 30) * 86400)
  const notFound = (reply) => reply.code(404).send({ error: 'Not found' })
  const refuse = (reply, r) => {
    if (r.retryAfterSec) reply.header('retry-after', String(r.retryAfterSec))
    return reply.code(r.status).send({ error: r.message, code: r.code, ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) })
  }
  const setSession = (reply, session) => reply.header('set-cookie', sessionCookies({ sessionToken: session.token, csrf: session.csrf, maxAgeSec: session.maxAgeSec }))
  // Отказ своей сессии (вход изменился, сессия отозвана): своё стираем, чтобы браузер не повторял.
  const sessionRefused = (reply) => clearSessionCookies(reply).code(401).send({ error: 'Сессия завершена — войдите заново', code: 'OSP_SESSION_REVOKED' })

  app.route({
    method: 'GET', url: '/api/auth/config',
    config: { access: access.open(AUTH_CONFIG_REASON) },
    handler: async () => ({ mode, ownLogin: mode === 'own' }),
  })

  app.route({
    method: 'POST', url: '/api/auth/login',
    config: { access: access.open(AUTH_LOGIN_REASON), body: LOGIN_BODY },
    handler: async (request, reply) => {
      if (!own) return notFound(reply)
      if (!isJson(request)) return reply.code(415).send({ error: 'Только JSON' })
      const bad = originProblem(request, config.auth.publicOrigin)
      if (bad) return reply.code(403).send({ error: bad, code: 'OSP_ORIGIN' })
      if (!limiters.loginIp.take(request.ip)) {
        return refuse(reply, { status: 429, code: 'too_many_attempts', message: 'Слишком много попыток входа с этого адреса — повторите позже', retryAfterSec: 60 })
      }
      const result = await authService.login({ email: request.body.email, password: request.body.password })
      if (!result.ok) return refuse(reply, result)
      setSession(reply, result.session)
      return { user: result.user, mustChange: result.mustChange }
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/logout',
    config: { access: access.open(AUTH_LOGOUT_REASON), body: LOGOUT_BODY },
    handler: async (request, reply) => {
      if (!own) return notFound(reply)
      const cookie = readToken(request.headers.cookie, SESSION_COOKIE)
      if (cookie.value) {
        const session = await sessions.lookup(cookie.value)
        if (session) {
          const bad = csrfProblem(request, { source: 'own', session }, config.auth.publicOrigin)
          if (bad) return reply.code(403).send({ error: bad, code: 'OSP_CSRF' })
          if (request.body?.all) await authService.logoutAll(session.userId)
          else await sessions.revoke(cookie.value, 'logout')
        }
      }
      clearSessionCookies(reply).code(204)
      return reply.send()
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/password',
    config: { access: access.user({ require: 'signedIn', deny: 'Нет доступа', allowMustChange: true }), body: PASSWORD_BODY },
    handler: async (request, reply) => {
      if (!own) return notFound(reply)
      const { session } = request.auth
      if (!session) return reply.code(400).send({ error: 'Пароль меняется в своём входе портала', code: 'OSP_AUTH_MODE' })
      const result = await authService.changePassword({
        session: { userId: request.auth.user.id, idHash: session.idHash },
        currentPassword: request.body.currentPassword, newPassword: request.body.newPassword,
      })
      if (!result.ok) {
        if (result.status === 401) return sessionRefused(reply)
        return refuse(reply, result)
      }
      setSession(reply, result.session)
      return { ok: true }
    },
  })

  app.route({
    method: 'GET', url: '/api/auth/me',
    config: { access: access.user({ require: 'signedIn', deny: 'Нет доступа', allowMustChange: true }) },
    handler: async (request, reply) => {
      const { user, session } = request.auth
      // CSRF-cookie пропала (её можно стереть, она не HttpOnly) — то же значение заново: оно стабильно на сессию.
      if (session && !readToken(request.headers.cookie, CSRF_COOKIE).value) {
        reply.header('set-cookie', serializeCookie(CSRF_COOKIE, session.csrf, { maxAgeSec, httpOnly: false }))
      }
      return {
        user: { id: user.id, email: user.email || '' },
        isSuperadmin: isSuperadmin ? await isSuperadmin(user.id) : false,
        mustChange: Boolean(session?.mustChange),
      }
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/admin/users',
    config: {
      access: access.user({ require: 'admin', deny: 'Заводить учётки может только администратор', rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }),
      body: CREATE_BODY,
    },
    handler: async (request, reply) => {
      if (!own) return notFound(reply)
      const b = request.body
      const result = await authService.adminCreateUser({
        actorId: request.auth.user.id, email: b.email, fullName: b.fullName, role: b.role,
        counterpartyId: b.counterpartyId || null, objectIds: b.objectIds || [],
      })
      if (!result.ok) return refuse(reply, result)
      return { user: result.user, temporaryPassword: result.temporaryPassword }
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/admin/reset-password',
    config: {
      access: access.user({ require: 'admin', deny: 'Сбрасывать пароль может только администратор', rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }),
      body: RESET_BODY,
    },
    handler: async (request, reply) => {
      if (!own) return notFound(reply)
      const result = await authService.adminResetPassword({ actorId: request.auth.user.id, userId: request.body.userId })
      if (!result.ok) return refuse(reply, result)
      return { temporaryPassword: result.temporaryPassword }
    },
  })
}
