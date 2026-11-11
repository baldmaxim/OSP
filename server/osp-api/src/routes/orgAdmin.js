// «Организации СУ-10» — «Администрирование» (src/lib/auth/orgAdmin.js). Работает в режимах своего входа (own, keycloak), если
// настроены OIDC_ISSUER и служебный клиент KC_ADMIN_* и в базе есть таблицы (migration/yandex/20270201): так связи готовят до
// переключения на вход через СУ-10 (решение пользователя 11.11.2026). В режиме own связи ни на что не влияют. Иначе — 404.
// Только администратор, CSRF (src/app.js), тело — по схеме; каждое решение — событие в osp_auth.events. Не через шлюз данных.
//
//   GET    /api/admin/su10-orgs                          — реестр, связи, учётки, заявки, исключения, состояние реестра;
//   POST   /api/admin/su10-orgs/refresh                  — перечитать реестр СУ-10 (не чаще раза в 15 с);
//   GET    /api/admin/su10-orgs/:id/candidates?q=        — подсказки «какой это контрагент» или поиск;
//   POST   /api/admin/su10-orgs/:id/link                 — связать с контрагентом;
//   DELETE /api/admin/su10-orgs/:id/link                 — отвязать (сессии подрядчиков закрываются сразу);
//   POST   /api/admin/su10-orgs/:id/create-counterparty  — создать контрагента из реестра и связать;
//   GET    /api/admin/counterparties/:id/su10-org        — организация контрагента (карточка контрагента);
//   POST   /api/admin/su10-org-exceptions                — исключение сотруднику с «не своей» организацией (суперадминистратор);
//   DELETE /api/admin/su10-org-exceptions/:subject       — снять исключение (суперадминистратор).
import { z } from 'zod'
import { access } from '../lib/access.js'

const ADMIN = { require: 'admin', deny: 'Только администратор' }
const WRITE = { ...ADMIN, rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }
const EMPTY_BODY = z.object({})
const LINK_BODY = z.object({ counterpartyId: z.string().uuid() })
const CREATE_BODY = z.object({
  name: z.string().trim().min(1).max(255).nullable().optional(),
  inn: z.string().trim().regex(/^(\d{10}|\d{12})?$/).nullable().optional(),
})
const EXCEPTION_BODY = z.object({ subject: z.string().uuid(), reason: z.string().trim().min(3).max(500) })
const SUPERADMIN_ONLY = { status: 403, code: 'superadmin_only', message: 'Исключения вносит только суперадминистратор' }

export function registerOrgAdmin(app, ctx) {
  const { orgs, orgAdmin, isSuperadmin, config } = ctx
  const notFound = (reply) => reply.code(404).send({ error: 'Not found' })
  const on = async () => Boolean(orgAdmin && orgs?.configured()) && await orgs.enabled()
  const answer = (reply, r) => {
    if (r?.ok !== false) return r
    const { status, code, message, ...extra } = r
    delete extra.ok
    return reply.code(status).send({ error: message, code, ...extra })
  }
  const actorOf = (request) => ({ userId: request.auth.user.id, email: request.auth.user.email || '' })
  const superOnly = async (request, reply) => {
    if (await isSuperadmin(request.auth.user.id)) return false
    reply.code(SUPERADMIN_ONLY.status).send({ error: SUPERADMIN_ONLY.message, code: SUPERADMIN_ONLY.code })
    return true
  }

  app.route({
    method: 'GET', url: '/api/admin/su10-orgs',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      const list = await orgAdmin.list()
      return { ...list, mode: config.authMode, isSuperadmin: await isSuperadmin(request.auth.user.id) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/su10-orgs/refresh',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      try {
        const r = await orgs.refreshRegistry({ throttle: true })
        return { orgs: r.orgs, held: Boolean(r.held), reasons: r.reasons || [], generation: r.generation, cached: Boolean(r.cached) }
      } catch (err) {
        request.log.warn({ code: err?.code, status: err?.status }, 'org registry refresh')
        return reply.code(503).send({ error: 'СУ-10 не ответил — реестр организаций не обновлён, список — из прежней сверки', code: 'org_registry_unavailable' })
      }
    },
  })

  app.route({
    method: 'GET', url: '/api/admin/su10-orgs/:id/candidates',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      const q = typeof request.query?.q === 'string' ? request.query.q.slice(0, 100) : ''
      return answer(reply, await orgAdmin.candidates({ orgId: String(request.params.id).toLowerCase(), q }))
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/su10-orgs/:id/link',
    config: { access: access.user(WRITE), body: LINK_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      return answer(reply, await orgAdmin.link({ actor: actorOf(request), orgId: String(request.params.id).toLowerCase(), counterpartyId: request.body.counterpartyId }))
    },
  })

  app.route({
    method: 'DELETE', url: '/api/admin/su10-orgs/:id/link',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      return answer(reply, await orgAdmin.unlink({ actor: actorOf(request), orgId: String(request.params.id).toLowerCase() }))
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/su10-orgs/:id/create-counterparty',
    config: { access: access.user(WRITE), body: CREATE_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      const b = request.body
      return answer(reply, await orgAdmin.createCounterparty({
        actor: actorOf(request), orgId: String(request.params.id).toLowerCase(), name: b.name ?? null, inn: b.inn ?? null,
      }))
    },
  })

  app.route({
    method: 'GET', url: '/api/admin/counterparties/:id/su10-org',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      return answer(reply, await orgAdmin.ofCounterparty({ counterpartyId: String(request.params.id).toLowerCase() }))
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/su10-org-exceptions',
    config: { access: access.user(WRITE), body: EXCEPTION_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      if (await superOnly(request, reply)) return reply
      return answer(reply, await orgAdmin.addException({ actor: actorOf(request), subject: request.body.subject, reason: request.body.reason }))
    },
  })

  app.route({
    method: 'DELETE', url: '/api/admin/su10-org-exceptions/:subject',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      if (!(await on())) return notFound(reply)
      if (await superOnly(request, reply)) return reply
      return answer(reply, await orgAdmin.removeException({ actor: actorOf(request), subject: request.params.subject }))
    },
  })
}
