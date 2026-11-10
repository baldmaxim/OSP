// Заявки на доступ и связи с СУ-10 — «Администрирование» (AUTH_MODE=keycloak; в других режимах — 404). Только администратор,
// CSRF (src/app.js, authenticate), тело — по схеме, каждое решение — событие в osp_auth.events. Не прямой записью через шлюз.
//
//   GET  /api/admin/identity-requests?status=pending|rejected|linked — заявки и похожие учётки без связи;
//   POST /api/admin/identity-requests/sync                            — сверить группу СУ-10 сейчас (кнопка «Проверить СУ-10»);
//   POST /api/admin/identity-requests/:id/create-user                 — новая учётка по заявке (роль, объекты, организация);
//   POST /api/admin/identity-requests/:id/link                        — привязать к существующему пользователю;
//   POST /api/admin/identity-requests/:id/reject | reopen             — отклонить, открыть заново;
//   GET  /api/admin/identities                                        — связи всех пользователей (колонка «СУ-10»);
//   DELETE /api/admin/users/:id/identity                              — отвязать и сразу закрыть сессии СУ-10.
// Роль «Администратор» и связи администраторов — только суперадминистратор (src/lib/auth/identity.js и триггер базы).
import { z } from 'zod'
import { access } from '../lib/access.js'

const ADMIN = { require: 'admin', deny: 'Только администратор' }
const WRITE = { ...ADMIN, rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }
const CREATE_BODY = z.object({
  role: z.string().trim().min(1).max(64),
  objectIds: z.array(z.string().uuid()).max(500).optional(),
  counterpartyId: z.string().uuid().nullable().optional(),
  fullName: z.string().trim().max(200).nullable().optional(),
})
const LINK_BODY = z.object({ userId: z.string().uuid() })
const EMPTY_BODY = z.object({})
const STATUSES = new Set(['pending', 'rejected', 'linked'])

export function registerIdentityAdmin(app, ctx) {
  const { config, identity, accessSync, isSuperadmin } = ctx
  const on = config.authMode === 'keycloak' && Boolean(identity)
  const notFound = (reply) => reply.code(404).send({ error: 'Not found' })
  const answer = (reply, r) => (r.ok === false
    ? reply.code(r.status).send({ error: r.message, code: r.code, ...(r.userId ? { userId: r.userId } : {}) })
    : r)
  const actorOf = (request) => ({ userId: request.auth.user.id, email: request.auth.user.email || '' })

  app.route({
    method: 'GET', url: '/api/admin/identity-requests',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      const status = STATUSES.has(request.query?.status) ? request.query.status : 'pending'
      const list = await identity.listRequests({ status })
      return { ...list, syncConfigured: Boolean(accessSync), isSuperadmin: await isSuperadmin(request.auth.user.id) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/identity-requests/sync',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      if (!accessSync) return reply.code(409).send({ error: 'Сверка с СУ-10 не настроена', code: 'kc_sync_unavailable' })
      try {
        const r = await accessSync.run({ throttle: true })
        if (r.busy) return { busy: true }
        return r
      } catch (err) {
        request.log.warn({ code: err?.code, status: err?.status }, 'kc access sync')
        return reply.code(503).send({ error: 'СУ-10 не ответил — сверка не выполнена, повторите позже', code: 'kc_sync_failed' })
      }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/identity-requests/:id/create-user',
    config: { access: access.user(WRITE), body: CREATE_BODY },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      const b = request.body
      return answer(reply, await identity.createUser({
        actor: actorOf(request), requestId: request.params.id, role: b.role,
        objectIds: b.objectIds || [], counterpartyId: b.counterpartyId || null, fullName: b.fullName || null,
      }))
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/identity-requests/:id/link',
    config: { access: access.user(WRITE), body: LINK_BODY },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      return answer(reply, await identity.link({ actor: actorOf(request), requestId: request.params.id, userId: request.body.userId }))
    },
  })

  for (const action of ['reject', 'reopen']) {
    app.route({
      method: 'POST', url: `/api/admin/identity-requests/:id/${action}`,
      config: { access: access.user(WRITE), body: EMPTY_BODY },
      handler: async (request, reply) => {
        if (!on) return notFound(reply)
        return answer(reply, await identity[action]({ actor: actorOf(request), requestId: request.params.id }))
      },
    })
  }

  app.route({
    method: 'GET', url: '/api/admin/identities',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      return { links: await identity.listLinks() }
    },
  })

  app.route({
    method: 'DELETE', url: '/api/admin/users/:id/identity',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      if (!on) return notFound(reply)
      return answer(reply, await identity.unlink({ actor: actorOf(request), userId: request.params.id }))
    },
  })
}
