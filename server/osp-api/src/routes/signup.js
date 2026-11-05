// Регистрация подрядчика на сайте (устройство и гарантии — src/lib/auth/signup.js). В режиме «вручную» писем нет: остаются
// задача на вычисление, заявка и маршруты администратора, остальные открытые адреса отвечают 404.
//
//   GET  /api/auth/register/challenge  — задача на вычисление перед заявкой (открытый);
//   POST /api/auth/register            — заявка, без пароля; ответ один, есть учётка с этой почтой или нет (открытый);
//   POST /api/auth/register/preview    — что подтверждается: по ссылке из письма (открытый);
//   POST /api/auth/register/confirm    — хозяин почты подтверждает и задаёт пароль (открытый);
//   POST /api/auth/register/claim      — подтверждение или отказ с почты компании (открытый);
//   POST /api/auth/password/forgot     — письмо для нового пароля: только учётки с регистрации, ответ один (открытый);
//   POST /api/auth/password/reset      — новый пароль по ссылке (открытый);
//   GET  /api/admin/contractor-signups — заявки: администратор;
//   POST /api/admin/contractor-signups/:id/decision — решение по заявке: администратор.
//
// Регистрация закрыта (AUTH_MODE не own, нет почты, OSP_CONTRACTOR_SIGNUP не задан) — открытые маршруты отвечают 404, и
// /api/auth/config не предлагает её странице. Меняющие запросы — только JSON и только с самого портала (Origin,
// Sec-Fetch-Site), как вход. Отпечаток пароля считается только по настоящей ссылке из письма: поток заявок не занимает
// процессор, на котором работает вход сотрудников. Тела в журнал не попадают.
import { z } from 'zod'
import { access } from '../lib/access.js'
import { originProblem } from '../lib/principal.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'

export const SIGNUP_CHALLENGE_REASON = 'Задача на вычисление перед заявкой на регистрацию: данных не отдаёт, лимит по адресу'
export const SIGNUP_REGISTER_REASON = 'Заявка подрядчика на регистрацию: до входа сессии нет; только с портала, задача на вычисление, лимиты; учётка появляется только после подтверждения почты или решения администратора'
export const SIGNUP_PREVIEW_REASON = 'Что подтверждается: только по одноразовой ссылке из письма, сведения самой заявки и организации из её карточки'
export const SIGNUP_CONFIRM_REASON = 'Подтверждение почты и пароль по одноразовой ссылке из письма: учётки ещё нет, вход не выдаётся'
export const SIGNUP_CLAIM_REASON = 'Подтверждение представителя компании по одноразовой ссылке, отправленной на почту из её карточки: учётки ещё нет'
export const PASSWORD_FORGOT_REASON = 'Письмо для нового пароля: ответ один для любой почты, только учётки с регистрации, задача на вычисление, лимиты'
export const PASSWORD_RESET_REASON = 'Новый пароль по одноразовой ссылке из письма: сессии нет, вход не выдаётся, остальные входы завершаются'

const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const POW = { challenge: z.string().max(200), answer: z.string().max(20) }
export const REGISTER_BODY = z.object({
  email: z.string().trim().min(3).max(254),
  companyName: z.string().max(1000),
  inn: z.string().max(40),
  kpp: z.string().max(40).nullable().optional(),
  contactName: z.string().max(1000),
  phone: z.string().max(60),
  consent: z.boolean(),
  // Поле-ловушка: человек его не видит и не заполняет.
  website: z.string().max(1000).optional(),
  ...POW,
})
const PREVIEW_BODY = z.object({ token: TOKEN, kind: z.enum(['confirm', 'claim']) })
const CONFIRM_BODY = z.object({ token: TOKEN, password: z.string().min(1).max(1024) })
const CLAIM_BODY = z.object({ token: TOKEN, decision: z.enum(['approve', 'deny']) })
const FORGOT_BODY = z.object({ email: z.string().trim().min(3).max(254), website: z.string().max(1000).optional(), ...POW })
const RESET_BODY = z.object({ token: TOKEN, newPassword: z.string().min(1).max(1024) })
const DECISION_BODY = z.object({ decision: z.enum(['approve', 'refuse']), counterpartyId: z.string().uuid().optional() })
const LIST_STATUS = new Set(['claim', 'review', 'active', 'refused'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Тело заявки — меньше 8 КБ: длинный запрос без входа не разбирается.
export const SIGNUP_BODY_LIMIT = 8 * 1024
const ACCEPTED = 202

const isJson = (request) => /^application\/json(\s*;|$)/i.test(String(request.headers['content-type'] || ''))

export function registerSignup(app, ctx) {
  const { config, signup, pow, limiters, isReadOnly = () => false } = ctx
  const open = Boolean(signup && pow)
  // Ссылки из писем и письмо о пароле — только когда портал отправляет письма.
  const mailFlow = open && signup.mode === 'email'
  const publicOrigin = config.auth?.publicOrigin
  const ipOf = (request) => String(request.ip || '').slice(0, 64)
  const notFound = (reply) => reply.code(404).send({ error: 'Not found' })
  const tooMany = (reply, message = 'Слишком много запросов — повторите позже', retryAfterSec = 600) => {
    reply.header('retry-after', String(retryAfterSec))
    return reply.code(429).send({ error: message, code: 'too_many_attempts', retryAfterSec })
  }
  const refuse = (reply, r) => {
    if (r.retryAfterSec) reply.header('retry-after', String(r.retryAfterSec))
    return reply.code(r.status).send({ error: r.message, code: r.code, ...(r.field ? { field: r.field } : {}), ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) })
  }
  // → true, если запрос остановлен.
  const gate = (request, reply, limiter) => {
    if (!open) { notFound(reply); return true }
    if (!isJson(request)) { reply.code(415).send({ error: 'Только JSON' }); return true }
    const bad = originProblem(request, publicOrigin)
    if (bad) { reply.code(403).send({ error: bad, code: 'OSP_ORIGIN' }); return true }
    if (isReadOnly()) { reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE }); return true }
    if (!limiter.take(ipOf(request))) { tooMany(reply); return true }
    return false
  }

  app.route({
    method: 'GET', url: '/api/auth/register/challenge',
    config: { access: access.open(SIGNUP_CHALLENGE_REASON) },
    handler: async (request, reply) => {
      if (!open) return notFound(reply)
      if (!limiters.signupChallenge.take(ipOf(request))) return tooMany(reply)
      return pow.issue()
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/register', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(SIGNUP_REGISTER_REASON), body: REGISTER_BODY },
    handler: async (request, reply) => {
      if (gate(request, reply, limiters.signupIp)) return reply
      const b = request.body
      // Ловушка: боту отвечаем как обычно, чтобы он не учился обходить её.
      if (b.website) return reply.code(ACCEPTED).send({ ok: true })
      if (!pow.verify(b.challenge, b.answer)) return reply.code(400).send({ error: 'Проверка устарела — отправьте форму ещё раз', code: 'OSP_POW' })
      if (!limiters.signupTotal.take('all')) return tooMany(reply, 'Сейчас слишком много заявок — повторите через несколько минут')
      try {
        const result = await signup.register(b, { ip: ipOf(request) })
        if (!result.ok) return refuse(reply, result)
      } catch (err) {
        if (err?.code === '42P01' || err?.code === '42703') return reply.code(503).send({ error: 'Регистрация временно закрыта', code: 'OSP_SIGNUP_CLOSED' })
        throw err
      }
      return reply.code(ACCEPTED).send({ ok: true })
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/register/preview', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(SIGNUP_PREVIEW_REASON), body: PREVIEW_BODY },
    handler: async (request, reply) => {
      if (!mailFlow) return notFound(reply)
      if (gate(request, reply, limiters.signupToken)) return reply
      const { ok, ...data } = await signup.preview({ token: request.body.token, kind: request.body.kind })
      if (!ok) return refuse(reply, { ...data, ok })
      return data
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/register/confirm', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(SIGNUP_CONFIRM_REASON), body: CONFIRM_BODY },
    handler: async (request, reply) => {
      if (!mailFlow) return notFound(reply)
      if (gate(request, reply, limiters.signupToken)) return reply
      const result = await signup.confirm({ token: request.body.token, password: request.body.password })
      if (!result.ok) return refuse(reply, result)
      return { status: result.status }
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/register/claim', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(SIGNUP_CLAIM_REASON), body: CLAIM_BODY },
    handler: async (request, reply) => {
      if (!mailFlow) return notFound(reply)
      if (gate(request, reply, limiters.signupToken)) return reply
      const result = await signup.decideClaim({ token: request.body.token, decision: request.body.decision })
      if (!result.ok) return refuse(reply, result)
      return { status: result.status }
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/password/forgot', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(PASSWORD_FORGOT_REASON), body: FORGOT_BODY },
    handler: async (request, reply) => {
      if (!mailFlow) return notFound(reply)
      if (gate(request, reply, limiters.signupIp)) return reply
      const b = request.body
      if (b.website) return reply.code(ACCEPTED).send({ ok: true })
      if (!pow.verify(b.challenge, b.answer)) return reply.code(400).send({ error: 'Проверка устарела — отправьте форму ещё раз', code: 'OSP_POW' })
      await signup.forgot({ email: b.email })
      return reply.code(ACCEPTED).send({ ok: true })
    },
  })

  app.route({
    method: 'POST', url: '/api/auth/password/reset', bodyLimit: SIGNUP_BODY_LIMIT,
    config: { access: access.open(PASSWORD_RESET_REASON), body: RESET_BODY },
    handler: async (request, reply) => {
      if (!mailFlow) return notFound(reply)
      if (gate(request, reply, limiters.signupToken)) return reply
      const result = await signup.resetPassword({ token: request.body.token, newPassword: request.body.newPassword })
      if (!result.ok) return refuse(reply, result)
      return { ok: true }
    },
  })

  // ── Администратор ────────────────────────────────────────────────────────────────────────────────
  const ADMIN = { require: 'admin', deny: 'Заявки на регистрацию решает только администратор' }
  const WRITE = { ...ADMIN, rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }
  // Вкладка работает и при закрытой регистрации: заявки могли остаться. Таблиц нет (миграция не применена) — подсказка.
  const service = ctx.signupAdmin
  const noTables = (reply) => reply.code(503).send({ error: 'Не применена миграция 20261203 (регистрация подрядчиков)', code: 'OSP_SIGNUP_MIGRATION' })

  app.route({
    method: 'GET', url: '/api/admin/contractor-signups',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!service) return notFound(reply)
      const q = request.query || {}
      const status = LIST_STATUS.has(String(q.status)) ? String(q.status) : null
      const before = q.before && !Number.isNaN(Date.parse(String(q.before))) ? new Date(String(q.before)).toISOString() : null
      try {
        return { open, mode: service.mode, ...(await service.adminList({ status, before, limit: Number(q.limit) || 100 })) }
      } catch (err) {
        if (err?.code === '42P01') return noTables(reply)
        throw err
      }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/contractor-signups/:id/decision',
    config: { access: access.user(WRITE), body: DECISION_BODY },
    handler: async (request, reply) => {
      if (!service) return notFound(reply)
      if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'Заявка не найдена', code: 'OSP_SIGNUP_NOT_FOUND' })
      if (isReadOnly()) return reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })
      try {
        const result = await service.adminDecide({
          id: request.params.id, decision: request.body.decision, counterpartyId: request.body.counterpartyId ?? null, actorId: request.auth.user.id,
        })
        if (!result.ok) return refuse(reply, result)
        return { status: result.status, ...(result.temporaryPassword ? { temporaryPassword: result.temporaryPassword } : {}) }
      } catch (err) {
        if (err?.code === '42P01') return noTables(reply)
        throw err
      }
    },
  })
}
