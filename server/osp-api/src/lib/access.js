// Права объявляются на маршруте, а не в теле обработчика.
//   • Закрыто по умолчанию: маршрут без config.access не регистрируется — сервер не стартует.
//   • Маршруты без входа пользователя — только из утверждённого списка (src/open-routes.js).
//   • Вошедший пользователь: токен → лимит, если объявлен → требование к учётке → схема тела.
//   • Тело — по схеме zod с явным перечнем полей; лишние поля отбрасываются.
// Право на конкретную запись (чей договор, чей файл) решает обработчик: для него нужны данные записи.
//
// Объявление: app.route({ method, url, config: { access: access.user({...}), body: z.object({...}) }, handler }).
// Обработчик получает request.auth = { supabase, user, roleRow }.

// Строка user_roles нужна и требованию, и обработчику — читается один раз.
const ROLE_COLUMNS = 'role, counterparty_id, is_approved, is_blocked, full_name'

// Сотрудник — одобрен, не заблокирован, без организации-контрагента и не с ролью подрядчика (правило
// osp_is_employee из миграции 20261010). Администратор одобрен и без организации.
export function isEmployeeRole(row) {
  return !!row && row.is_approved === true && row.is_blocked !== true && !row.counterparty_id && row.role !== 'contractor'
}

// Требования к учётке вошедшего. Имя требования попадает в снимок прав (tests/osp-api/baseline).
export const REQUIREMENTS = {
  // Есть строка ролей, не отклонён и не заблокирован: сотрудник или подрядчик.
  approved: (row) => !!row && row.is_approved !== false && row.is_blocked !== true,
  employee: isEmployeeRole,
}

export const access = {
  // Без входа. Причина обязательна и должна совпасть с утверждённым списком.
  open: (reason) => ({ kind: 'open', reason }),
  // Межсистемный ключ. check(request, reply) → true либо сам отправил отказ.
  apiKey: ({ reason, check }) => ({ kind: 'apiKey', reason, check }),
  // Вошедший пользователь. require — имя из REQUIREMENTS; deny — текст отказа 403;
  // rate — { limiter: имя лимита, deny: текст 429 }, проверяется до обращения к базе за ролью.
  user: ({ require, deny = 'Forbidden', rate = null }) => ({ kind: 'user', require, deny, rate }),
}

const routeKey = (method, url) => `${method === 'HEAD' ? 'GET' : method} ${url}`

export function installAccess(app, { authenticate, limiters, openRoutes }) {
  const table = []
  const approved = new Map(openRoutes.map((r) => [routeKey(r.method, r.url), r]))
  app.decorate('accessTable', table)
  app.decorateRequest('auth', null)

  app.addHook('onRoute', (route) => {
    const methods = [].concat(route.method)
    const where = `${methods.join(',')} ${route.url}`
    const declared = route.config?.access
    if (!declared || !['open', 'apiKey', 'user'].includes(declared.kind)) {
      throw new Error(`osp-api: у маршрута ${where} не объявлены права — закрыто по умолчанию, маршрут не регистрируется`)
    }
    const schema = route.config.body ?? null
    if (schema && typeof schema.safeParse !== 'function') {
      throw new Error(`osp-api: у маршрута ${where} схема тела — не схема zod`)
    }

    const guards = []
    if (declared.kind === 'user') {
      const requirement = REQUIREMENTS[declared.require]
      if (!requirement) throw new Error(`osp-api: у маршрута ${where} неизвестное требование к учётке: ${declared.require}`)
      if (declared.rate && !limiters[declared.rate.limiter]) {
        throw new Error(`osp-api: у маршрута ${where} неизвестный лимит: ${declared.rate.limiter}`)
      }
      guards.push(async (request, reply) => {
        const auth = await authenticate(request, reply)
        if (!auth) return reply
        if (declared.rate && !limiters[declared.rate.limiter].take(auth.user.id)) {
          return reply.code(429).send({ error: declared.rate.deny })
        }
        const { data } = await auth.supabase.from('user_roles').select(ROLE_COLUMNS).eq('user_id', auth.user.id).maybeSingle()
        const roleRow = data || null
        if (!requirement(roleRow)) return reply.code(403).send({ error: declared.deny })
        request.auth = { ...auth, roleRow }
      })
    } else {
      for (const method of methods) {
        const listed = approved.get(routeKey(method, route.url))
        if (!listed || listed.kind !== declared.kind) {
          throw new Error(`osp-api: маршрут ${method} ${route.url} открыт без входа, но его нет в утверждённом списке (src/open-routes.js)`)
        }
      }
      if (declared.kind === 'apiKey') {
        if (typeof declared.check !== 'function') throw new Error(`osp-api: у маршрута ${where} нет проверки ключа`)
        guards.push(async (request, reply) => {
          if (!await declared.check(request, reply)) return reply
        })
      }
    }
    if (schema) {
      guards.push(async (request, reply) => {
        const parsed = schema.safeParse(request.body)
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' })
        request.body = parsed.data
      })
    }
    route.preHandler = [...guards, ...[].concat(route.preHandler ?? [])]

    for (const method of methods) {
      if (method === 'HEAD') continue // HEAD создаётся сам из GET — отдельной строкой не ведём
      table.push({
        method,
        url: route.url,
        kind: declared.kind,
        require: declared.kind === 'user' ? declared.require : null,
        reason: declared.reason ?? null,
        body: schema?.shape ? Object.keys(schema.shape).sort() : null,
      })
    }
  })
}
