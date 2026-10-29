// «Администрирование» → «Доступ к API»: ключи для смежных систем (устройство — src/lib/apiKeys.js).
//
//   GET  /api/admin/api-keys              — ключи (без отпечатков) и перечень ресурсов, которые можно открыть;
//   POST /api/admin/api-keys              — выпустить ключ: сам ключ — только в этом ответе;
//   POST /api/admin/api-keys/:id          — название, права, срок, примечание;
//   POST /api/admin/api-keys/:id/revoke   — отозвать (сразу и навсегда);
//   POST /api/admin/api-keys/:id/delete   — убрать из списка (ключ отзывается, журнал остаётся);
//   GET  /api/admin/api-keys/calls        — журнал вызовов: ?key=<id>&errors=1&before=<id>&limit=100.
// Только администратор (как is_admin() в базе). Ключ в журнал службы не попадает: app.js пишет только метод, шаблон
// маршрута, код и время.
import { z } from 'zod'
import { access } from '../lib/access.js'
import { API_RESOURCES, RESOURCE_CODES, ApiKeyError, moscowToday } from '../lib/apiKeys.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const realDate = (s) => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

const name = z.string().trim().min(1).max(200)
const scopes = z.array(z.enum(RESOURCE_CODES)).min(1).max(RESOURCE_CODES.length).transform((list) => RESOURCE_CODES.filter((r) => list.includes(r)))
const expiresOn = z.string().refine(realDate).nullable()
const note = z.string().trim().max(1000).nullable()

const ISSUE_BODY = z.object({ name, scopes, expiresOn: expiresOn.optional(), note: note.optional() })
const UPDATE_BODY = z.object({ name: name.optional(), scopes: scopes.optional(), expiresOn: expiresOn.optional(), note: note.optional() })
const REVOKE_BODY = z.object({ reason: z.string().trim().max(500).optional() })
const EMPTY_BODY = z.object({})

const ADMIN = { require: 'admin', deny: 'Ключи API выдаёт только администратор' }
const WRITE = { ...ADMIN, rate: { limiter: 'authAdmin', deny: 'Слишком часто — повторите через минуту' } }

export function registerApiKeys(app, { apiKeys, isReadOnly }) {
  const actorOf = (request) => ({
    id: request.auth.user.id,
    name: request.auth.roleRow?.full_name || request.auth.user.email || '',
  })
  const fail = (reply, err) => {
    if (err instanceof ApiKeyError) return reply.code(err.status).send({ error: err.message, code: err.code })
    throw err
  }
  const keyId = (request, reply) => {
    if (UUID.test(request.params.id)) return request.params.id
    reply.code(404).send({ error: 'Ключ не найден — обновите список', code: 'OSP_API_KEY_NOT_FOUND' })
    return null
  }
  const readOnly = (reply) => {
    if (!isReadOnly()) return false
    reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })
    return true
  }
  // Срок — не раньше сегодняшнего дня по Москве: ключ «до вчера» выпускать незачем.
  const pastDate = (reply, value) => {
    if (!value || value >= moscowToday()) return false
    reply.code(400).send({ error: 'Срок действия — сегодня или позже', code: 'OSP_API_KEY_DATE' })
    return true
  }

  app.route({
    method: 'GET', url: '/api/admin/api-keys',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      try {
        return { resources: API_RESOURCES, keys: await apiKeys.list(), today: moscowToday() }
      } catch (err) { return fail(reply, err) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/api-keys',
    config: { access: access.user(WRITE), body: ISSUE_BODY },
    handler: async (request, reply) => {
      if (readOnly(reply) || pastDate(reply, request.body.expiresOn)) return reply
      try {
        const { key, secret } = await apiKeys.issue({ actor: actorOf(request), ...request.body })
        request.log.info({ keyId: key.id, scopes: key.scopes }, 'api key issued')
        return { key, secret }
      } catch (err) { return fail(reply, err) }
    },
  })

  app.route({
    method: 'GET', url: '/api/admin/api-keys/calls',
    config: { access: access.user(ADMIN) },
    handler: async (request, reply) => {
      const q = request.query || {}
      const key = typeof q.key === 'string' && q.key ? q.key : null
      if (key && !UUID.test(key)) return reply.code(400).send({ error: 'Параметр key — идентификатор ключа' })
      const before = /^\d{1,15}$/.test(String(q.before || '')) ? Number(q.before) : null
      const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit, 10) || 100))
      try {
        return await apiKeys.calls({ keyId: key, errorsOnly: q.errors === '1', before, limit })
      } catch (err) { return fail(reply, err) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/api-keys/:id',
    config: { access: access.user(WRITE), body: UPDATE_BODY },
    handler: async (request, reply) => {
      const id = keyId(request, reply)
      if (!id || readOnly(reply) || pastDate(reply, request.body.expiresOn)) return reply
      try {
        const key = await apiKeys.update(id, request.body, actorOf(request))
        request.log.info({ keyId: id, fields: Object.keys(request.body) }, 'api key updated')
        return { key }
      } catch (err) { return fail(reply, err) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/api-keys/:id/revoke',
    config: { access: access.user(WRITE), body: REVOKE_BODY },
    handler: async (request, reply) => {
      const id = keyId(request, reply)
      if (!id || readOnly(reply)) return reply
      try {
        const key = await apiKeys.revoke(id, actorOf(request), request.body.reason)
        request.log.info({ keyId: id }, 'api key revoked')
        return { key }
      } catch (err) { return fail(reply, err) }
    },
  })

  app.route({
    method: 'POST', url: '/api/admin/api-keys/:id/delete',
    config: { access: access.user(WRITE), body: EMPTY_BODY },
    handler: async (request, reply) => {
      const id = keyId(request, reply)
      if (!id || readOnly(reply)) return reply
      try {
        await apiKeys.remove(id, actorOf(request))
        request.log.info({ keyId: id }, 'api key deleted')
        return { ok: true }
      } catch (err) { return fail(reply, err) }
    },
  })
}
