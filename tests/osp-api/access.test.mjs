// Права на маршрутах osp-api (server/osp-api/src/lib/access.js).
//   • закрыто по умолчанию: маршрут без объявленных прав не регистрируется;
//   • открытые адреса — только из утверждённого списка; новый открытый адрес валит набор;
//   • снимок «маршрут → права» и замер «кто → маршрут → код ответа» лежат в репозитории
//     (tests/osp-api/baseline): любое расширение доступа видно строкой в diff;
//   • тело запроса — по схеме: лишние поля до обработчика не доходят.
// Новый эталон после намеренного изменения: UPDATE_BASELINE=1 npm run test:api.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeSupabase, startFakeS3 } from './lib/fakes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const BASELINE = path.join(HERE, 'baseline')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'fastify')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const UPDATE = process.env.UPDATE_BASELINE === '1'

// Классы пользователей — как в tests/db: по одному представителю.
const U = {
  employee: { token: 'tok-emp', id: '11111111-1111-4111-8111-111111111111' },
  admin: { token: 'tok-admin', id: '22222222-2222-4222-8222-222222222222' },
  unapproved: { token: 'tok-unapproved', id: '33333333-3333-4333-8333-333333333333' },
  contractor: { token: 'tok-contractor', id: '44444444-4444-4444-8444-444444444444' },
  contractor_noorg: { token: 'tok-cnoorg', id: '55555555-5555-4555-8555-555555555555' },
  no_user_roles: { token: 'tok-norole', id: '66666666-6666-4666-8666-666666666666' },
  blocked: { token: 'tok-blocked', id: '88888888-8888-4888-8888-888888888888' },
}
const roles = {
  [U.employee.id]: { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Инженер' },
  [U.admin.id]: { role: 'admin', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Админ' },
  [U.unapproved.id]: { role: 'engineer', counterparty_id: null, is_approved: false },
  [U.contractor.id]: { role: 'contractor', counterparty_id: 'cp-1', is_approved: true },
  [U.contractor_noorg.id]: { role: 'contractor', counterparty_id: null, is_approved: true },
  [U.blocked.id]: { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: true },
}

function compareWithBaseline(name, actual) {
  const file = path.join(BASELINE, name)
  const text = JSON.stringify(actual, null, 2) + '\n'
  if (UPDATE) {
    fs.mkdirSync(BASELINE, { recursive: true })
    fs.writeFileSync(file, text)
    return
  }
  assert.ok(fs.existsSync(file), `нет эталона ${name}: UPDATE_BASELINE=1 npm run test:api`)
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')),
    `права изменились против эталона ${name}. Если так задумано — UPDATE_BASELINE=1 npm run test:api и коммит эталона`)
}

describe('osp-api: права объявлены на маршруте, закрыто по умолчанию', { skip }, () => {
  let buildApp
  let access
  let installAccess
  let OPEN_ROUTES
  let z
  let supa
  let s3
  let app

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ access, installAccess } = await import(path.join(SERVER, 'src', 'lib', 'access.js')))
    ;({ OPEN_ROUTES } = await import(path.join(SERVER, 'src', 'open-routes.js')))
    ;({ z } = await import(path.join(SERVER, 'node_modules', 'zod', 'index.js')))
    supa = await startFakeSupabase({
      users: Object.fromEntries(Object.values(U).map((u) => [u.token, { id: u.id }])),
      roles, docs: {}, can: { [U.admin.id]: 'all' }, myContracts: {}, owners: {},
      views: { kp_rates_registry: [], supply_rates_registry: [] }, viewTotal: 0,
    })
    s3 = await startFakeS3()
    app = buildApp({
      logger: false,
      config: {
        host: '127.0.0.1', port: 0, supabaseUrl: supa.url, supabaseAnonKey: 'anon-test-key', supabaseServiceKey: 'service-test-key',
        s3: { endpoint: s3.url, region: 'ru-central-1', bucket: 'osp', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' },
        anthropicApiKey: 'anthropic-test-key', ratesApiKeys: ['rk-one'],
      },
    })
  })
  after(async () => {
    await app?.close()
    await supa?.close()
    await s3?.close()
  })

  it('маршрут без объявленных прав не регистрируется; открытый не из списка — тоже', () => {
    const handler = async () => ({ ok: true })
    assert.throws(() => app.get('/api/new', handler), /не объявлены права — закрыто по умолчанию/)
    assert.throws(() => app.route({ method: 'POST', url: '/api/new', config: {}, handler }), /не объявлены права/)
    assert.throws(() => app.route({ method: 'GET', url: '/api/new-open', config: { access: access.open('так удобнее') }, handler }),
      /открыт без входа, но его нет в утверждённом списке/)
    // Адрес из списка, но другого вида (ключ вместо «без входа») — тоже отказ.
    assert.throws(() => app.route({ method: 'GET', url: '/api/rates', config: { access: access.open('без ключа') }, handler }),
      /нет в утверждённом списке/)
    assert.throws(() => app.route({ method: 'GET', url: '/api/x', config: { access: access.user({ require: 'кто угодно' }) }, handler }),
      /неизвестное требование к учётке/)
    assert.throws(() => app.route({ method: 'GET', url: '/api/y', config: { access: access.user({ require: 'employee' }), body: {} }, handler }),
      /схема тела — не схема zod/)
    assert.ok(!app.accessTable.some((r) => r.url.startsWith('/api/new') || r.url === '/api/x' || r.url === '/api/y'), 'отказанные маршруты в таблицу не попали')
  })

  it('снимок «маршрут → права»: новый маршрут, новое открытое право или новое поле тела видны в diff', async () => {
    await app.ready() // шлюз данных регистрируется со своим разбором тела — виден после запуска
    const table = [...app.accessTable].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`))
    compareWithBaseline('routes.json', table)
    // Утверждённый список и зарегистрированные открытые маршруты совпадают в обе стороны.
    const open = table.filter((r) => r.kind !== 'user').map((r) => `${r.method} ${r.url} ${r.kind}`).sort()
    assert.deepEqual(open, OPEN_ROUTES.map((r) => `${r.method} ${r.url} ${r.kind}`).sort())
    for (const r of OPEN_ROUTES) assert.ok(r.reason && r.reason.length > 20, `у открытого маршрута нет обоснования: ${r.method} ${r.url}`)
    // Шлюз данных передаёт запрос в PostgREST как есть: схемы тела у него нет, зато есть список
    // разрешённого (allow.json) и правила по строкам в базе — принятое исключение, docs/API_RULES.md.
    for (const r of table.filter((x) => x.method === 'POST' && x.url !== '/api/db/*')) assert.ok(Array.isArray(r.body), `у ${r.url} нет схемы тела`)
  })

  it('замер «кто → маршрут → код ответа»: каждый класс пользователей на каждом маршруте, включая запрос без входа', async () => {
    await app.ready()
    const who = {
      'без токена': {},
      'неверный токен': { authorization: 'Bearer tok-unknown' },
      ...Object.fromEntries(Object.entries(U).map(([name, u]) => [name, { authorization: `Bearer ${u.token}` }])),
    }
    // Запросы — без полезной нагрузки: пропущенный правами получает 400 «не хватает полей», отказ — 401 / 403.
    const requests = {
      'POST /api/fn/ai-assist clause_suggest': { method: 'POST', url: '/api/fn/ai-assist', payload: { action: 'clause_suggest' } },
      'POST /api/fn/s3-presign upload': { method: 'POST', url: '/api/fn/s3-presign', payload: { action: 'upload' } },
      'POST /api/fn/s3-presign confirm': { method: 'POST', url: '/api/fn/s3-presign', payload: { action: 'confirm' } },
      'POST /api/fn/s3-presign download': { method: 'POST', url: '/api/fn/s3-presign', payload: { action: 'download' } },
      'POST /api/fn/s3-presign delete': { method: 'POST', url: '/api/fn/s3-presign', payload: { action: 'delete' } },
      'POST /api/fn/cover-upload': { method: 'POST', url: '/api/fn/cover-upload', payload: {} },
      'GET /api/health': { method: 'GET', url: '/api/health' },
      'GET /api/ready через nginx': { method: 'GET', url: '/api/ready', headers: { 'x-forwarded-for': '203.0.113.7' } },
    }
    const measured = {}
    for (const [title, req] of Object.entries(requests)) {
      measured[title] = {}
      for (const [name, headers] of Object.entries(who)) {
        const res = await app.inject({ ...req, headers: { ...headers, ...(req.headers || {}) } })
        measured[title][name] = res.statusCode
      }
    }
    // Реестр расценок — по ключу, вход пользователя не при чём.
    const code = async (method, url, headers = {}) => (await app.inject({ method, url, headers })).statusCode
    measured['GET /api/rates/*'] = {
      'без ключа': await code('GET', '/api/rates/kp'),
      'неверный ключ': await code('GET', '/api/rates/kp', { 'x-api-key': 'rk-wrong' }),
      'токен пользователя вместо ключа': await code('GET', '/api/rates/kp', { authorization: `Bearer ${U.admin.token}` }),
      'верный ключ': await code('GET', '/api/rates/kp', { 'x-api-key': 'rk-one' }),
    }
    measured['GET /api/rates'] = {
      'без ключа': await code('GET', '/api/rates'),
      'верный ключ': await code('GET', '/api/rates', { 'x-api-key': 'rk-one' }),
    }
    // Шлюз данных здесь не настроен (данные в Supabase): маршрут закрыт для всех. Права самого шлюза —
    // tests/osp-api/db-gateway.test.mjs.
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      measured[`${method} /api/db/*`] = {
        'без токена': await code(method, '/api/db/tenders?select=id'),
        'администратор': await code(method, '/api/db/tenders?select=id', { authorization: `Bearer ${U.admin.token}` }),
      }
    }
    // Обложки: картинку показывает <img> без токена — открыто, но только имя «UUID.расширение».
    measured['GET /api/covers/:name'] = {
      'без токена': await code('GET', '/api/covers/0f0e0d0c-0b0a-4908-8706-050403020100.jpg'),
      'имя не по шаблону': await code('GET', '/api/covers/..%2Fcontracts%2Fx.docx'),
    }
    measured['OPTIONS /api/rates/*'] = { 'без ключа': await code('OPTIONS', '/api/rates/kp') }
    measured['OPTIONS /api/rates'] = { 'без ключа': await code('OPTIONS', '/api/rates') }
    compareWithBaseline('access.json', measured)

    // Замер покрывает каждый зарегистрированный маршрут — маршрут без теста прав считается незаконченным.
    const covered = new Set(Object.keys(measured).map((title) => title.split(' ').slice(0, 2).join(' ')))
    for (const r of app.accessTable) assert.ok(covered.has(`${r.method} ${r.url}`), `маршрут без замера прав: ${r.method} ${r.url}`)

    // Инварианты, не зависящие от эталона: без входа и с чужим токеном закрыто всё, кроме списка открытых.
    for (const [title, row] of Object.entries(measured)) {
      if (!title.startsWith('POST /api/fn/')) continue
      assert.equal(row['без токена'], 401, title)
      assert.equal(row['неверный токен'], 401, title)
      for (const denied of ['unapproved', 'blocked', 'no_user_roles']) assert.equal(row[denied], 403, `${title}: ${denied}`)
    }
    assert.equal(measured['POST /api/fn/ai-assist clause_suggest'].contractor, 403)
    assert.equal(measured['POST /api/fn/cover-upload'].contractor, 403, 'обложку загружает только сотрудник')
    assert.equal(measured['GET /api/covers/:name']['имя не по шаблону'], 404)
    for (const action of ['upload', 'confirm', 'delete']) {
      assert.equal(measured[`POST /api/fn/s3-presign ${action}`].contractor, 403, action)
      // Роль подрядчика без организации — тот же подрядчик, а не сотрудник.
      assert.equal(measured[`POST /api/fn/s3-presign ${action}`].contractor_noorg, 403, action)
    }
  })

  it('тело запроса — по схеме: лишние поля до обработчика не доходят, права проверяются раньше тела', async () => {
    const { default: Fastify } = await import(path.join(SERVER, 'node_modules', 'fastify', 'fastify.js'))
    const mini = Fastify()
    const calls = []
    const fakeSupabase = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: roles[U.employee.id] }) }) }) }) }
    installAccess(mini, {
      openRoutes: [],
      limiters: { tight: { take: () => calls.push('limit') < 3 } },
      authenticate: async (request, reply) => {
        if (!request.headers.authorization) { reply.code(401).send({ error: 'Unauthorized' }); return null }
        return { supabase: fakeSupabase, user: { id: U.employee.id } }
      },
    })
    mini.route({ method: 'POST', url: '/api/echo', config: {
      access: access.user({ require: 'employee', rate: { limiter: 'tight', deny: 'слишком часто' } }),
      body: z.object({ title: z.string(), count: z.number().int().optional() }),
    }, handler: async (request) => ({ body: request.body, user: request.auth.user.id, role: request.auth.roleRow.role }) })
    await mini.ready()
    const post = (payload, headers = { authorization: 'Bearer x' }) => mini.inject({ method: 'POST', url: '/api/echo', payload, headers })

    const ok = await post({ title: 'План', count: 2, role: 'admin', created_by: 'чужой', is_approved: true })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json(), { body: { title: 'План', count: 2 }, user: U.employee.id, role: 'engineer' }, 'роль и авторство из тела отброшены')
    assert.equal((await post({ title: 5 })).statusCode, 400, 'не тот тип — отказ')
    assert.equal((await post({ title: 'x' }, {})).statusCode, 401, 'без входа до схемы дело не доходит')
    assert.equal((await post({ title: 'x' })).statusCode, 429, 'лимит объявлен на маршруте и срабатывает до обработчика')
    await mini.close()
  })
})
