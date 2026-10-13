// Шлюз данных osp-api: /api/db/* → PostgREST (server/osp-api/src/routes/dbGateway.js).
// PostgREST здесь — подделка, которая запоминает, что до неё дошло: проверяем именно работу шлюза —
//   • кто это: токен входа проверяется, без токена — аноним, негодный токен — отказ до PostgREST;
//   • что можно: таблица, действие, функция и связанные таблицы в select — по списку (allow.json);
//   • в PostgREST уходит свой короткоживущий токен, токен браузера дальше шлюза не идёт;
//   • запрос и ответ передаются как есть (тело — байт в байт, диапазоны, коды и ошибки PostgREST);
//   • барьер записи; действия с учётками входа; сбой PostgREST — понятный отказ.
// Права по строкам (их держит база) проверяются на копии прода: tests/db и migration/target.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'jose')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const GATEWAY_SECRET = 'internal-gateway-secret-0123456789-abcdefghij'
const SUPABASE_URL = 'https://testproject.supabase.co'
const ADMIN = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'

// Список разрешённого — как у прода по форме: полный доступ, только чтение, только вошедшему.
const ALLOW = {
  tables: {
    tenders: { anon: ['select'], authenticated: ['delete', 'insert', 'select', 'update'] },
    objects: { anon: ['select'], authenticated: ['delete', 'insert', 'select', 'update'] },
    counterparties: { authenticated: ['delete', 'insert', 'select', 'update'] },
    psdc_rows: { authenticated: ['select'] },
    employee_directory: { authenticated: ['select'] },
    write_only_log: { authenticated: ['insert'] },
  },
  rpc: { is_admin: ['authenticated'], admin_delete_user: ['authenticated'], admin_confirm_user_email: ['authenticated'], psdc_validate: ['authenticated'] },
}

describe('osp-api: разбор select и решение по списку', { skip }, () => {
  let embeddedRelations
  let decide
  before(async () => {
    ;({ embeddedRelations, decide } = await import(path.join(SERVER, 'src', 'routes', 'dbGateway.js')))
  })

  it('связанные таблицы в select: псевдонимы, подсказки, вложенность, разворот', () => {
    assert.deepEqual(embeddedRelations('*'), [])
    assert.deepEqual(embeddedRelations('id, title, amount::text, data->>key'), [])
    assert.deepEqual(embeddedRelations('*, objects(name), counterparties(name)'), ['objects', 'counterparties'])
    assert.deepEqual(embeddedRelations('*, winner:counterparties!winner_counterparty_id(id, name)'), ['counterparties'])
    assert.deepEqual(embeddedRelations('*,counterparties(id,name,counterparty_contacts(full_name,phone))'), ['counterparties', 'counterparty_contacts'])
    assert.deepEqual(embeddedRelations('id, tenders!inner(id, objects!left(name)), ...contacts(full_name)'), ['tenders', 'objects', 'contacts'])
    assert.deepEqual(embeddedRelations('id,materials_tender:tenders!parent_tender_id(id,status)'), ['tenders'])
  })

  it('то, что не разбирается однозначно, — отказ, а не пропуск', () => {
    for (const bad of ['id, "weird name"(x)', 'id, (x)', 'id, a.b(x)', 'id, a::int(x)', 'id, 1abc(x)', 'id, tenders !inner (x), (y)']) {
      assert.throws(() => embeddedRelations(bad), undefined, bad)
    }
  })

  it('решение по списку: таблица, действие, функция, связанные таблицы', () => {
    const d = (role, method, kind, name, opts) => decide(ALLOW, role, method, kind, name, opts)
    assert.equal(d('authenticated', 'GET', 'table', 'tenders', { select: '*, objects(name)' }), null)
    assert.equal(d('anon', 'GET', 'table', 'tenders', { select: 'id, objects(name)' }), null)
    assert.equal(d('authenticated', 'POST', 'table', 'tenders', { prefer: 'return=representation' }), null)
    assert.equal(d('authenticated', 'POST', 'rpc', 'is_admin'), null)
    // Нет в списке — для шлюза такого нет вовсе.
    assert.equal(d('authenticated', 'GET', 'table', 'kp_rates_registry_mv').status, 404)
    assert.equal(d('authenticated', 'GET', 'table', 'kp_rates_registry_mv').body.code, 'PGRST205')
    assert.equal(d('authenticated', 'POST', 'rpc', 'osp_is_employee').body.code, 'PGRST202')
    // Действие не выдано: вошедшему — 403, анониму — 401, код тот же, что у PostgREST.
    assert.deepEqual([d('authenticated', 'POST', 'table', 'psdc_rows').status, d('authenticated', 'POST', 'table', 'psdc_rows').body.code], [403, '42501'])
    assert.equal(d('authenticated', 'PATCH', 'table', 'employee_directory').status, 403)
    assert.equal(d('authenticated', 'DELETE', 'table', 'employee_directory').status, 403)
    assert.equal(d('anon', 'POST', 'table', 'tenders').status, 401)
    assert.equal(d('anon', 'GET', 'table', 'counterparties').status, 401)
    assert.equal(d('anon', 'POST', 'rpc', 'is_admin').status, 401)
    // Связанная таблица в select должна быть разрешена на чтение этому же виду пользователя.
    assert.equal(d('anon', 'GET', 'table', 'tenders', { select: 'id, counterparties(name)' }).status, 401)
    assert.equal(d('authenticated', 'GET', 'table', 'tenders', { select: 'id, write_only_log(id)' }).status, 403)
    assert.equal(d('authenticated', 'GET', 'table', 'tenders', { select: 'id, secret_table(id)' }).status, 403)
    assert.equal(d('authenticated', 'GET', 'table', 'tenders', { select: 'id, "x"(id)' }).status, 400)
    // Вставка «с заменой» требует права изменения, ответ со строками — права чтения.
    assert.equal(d('authenticated', 'POST', 'table', 'write_only_log'), null)
    assert.equal(d('authenticated', 'POST', 'table', 'write_only_log', { prefer: 'resolution=merge-duplicates' }).status, 403)
    assert.equal(d('authenticated', 'POST', 'table', 'write_only_log', { prefer: 'return=representation' }).status, 403)
    assert.equal(d('authenticated', 'POST', 'table', 'write_only_log', { select: 'id' }).status, 403)
  })
})

describe('osp-api: шлюз данных /api/db → PostgREST', { skip }, () => {
  let buildApp
  let upstream
  let seen
  let reply
  let app
  let logs
  let tmp
  let authAdminCalls
  let authAdminFails

  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  const validInternal = (token) => {
    const [head, body, signature] = token.split('.')
    return crypto.createHmac('sha256', GATEWAY_SECRET).update(`${head}.${body}`).digest('base64url') === signature
  }
  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0, supabaseUrl: SUPABASE_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: projectKey('service_role'),
    supabaseJwtSecret: SECRET, s3: {}, anthropicApiKey: '', ratesApiKeys: [], required: ['supabase'],
    dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: 'portal_owner', readOnlyFile: path.join(tmp, 'db-readonly') },
    ...over,
  })
  async function makeApp(over = {}) {
    await app?.close()
    logs = []
    const { defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    app = buildApp({ config: config(over), logger: { level: 'info', stream: { write: (l) => logs.push(l) } },
      deps: { ...defaultDeps, allow: ALLOW, createAuthAdmin: () => ({
        deleteUser: async (id) => { authAdminCalls.push(['deleteUser', id, seen.length]); if (authAdminFails) throw new Error('auth 500') },
        confirmEmail: async (id) => { authAdminCalls.push(['confirmEmail', id, seen.length]); if (authAdminFails) throw new Error('auth 500') },
        listUsers: async () => [],
      }) } })
    await app.ready()
  }
  const call = (method, url, { token, body, headers = {} } = {}) => app.inject({
    method, url, payload: body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  })
  const user = (id = USER, over) => userToken(SUPABASE_URL, id, over)
  const tableRequests = () => seen.filter((r) => !r.url.startsWith('/rpc/is_admin'))

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-gateway-'))
    seen = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
        seen.push(record)
        const r = reply(record)
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json; charset=utf-8', ...(r.headers || {}) })
        res.end(r.body ?? '[]')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    upstream = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
  })
  after(async () => {
    await app?.close()
    await upstream?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  beforeEach(async () => {
    seen.length = 0
    authAdminCalls = []
    authAdminFails = false
    reply = (r) => (r.url.startsWith('/rpc/is_admin') ? { body: 'false' } : {})
    fs.rmSync(path.join(tmp, 'db-readonly'), { force: true })
    await makeApp()
  })

  it('вошедший: запрос уходит в PostgREST со своим токеном шлюза; токен браузера дальше не идёт', async () => {
    const browserToken = user(USER, { email: 'user@example.ru', app_metadata: { role: 'admin' } })
    reply = () => ({ status: 206, headers: { 'content-range': '0-0/774' }, body: '[{"id":1}]' })
    const res = await call('GET', '/api/db/tenders?select=id,objects(name)&order=id.desc&limit=1', { token: browserToken, headers: { prefer: 'count=exact', range: '0-0' } })
    assert.equal(res.statusCode, 206)
    assert.equal(res.headers['content-range'], '0-0/774')
    assert.equal(res.body, '[{"id":1}]')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/tenders?select=id,objects(name)&order=id.desc&limit=1', 'адрес и параметры — как есть')
    assert.equal(seen[0].headers.prefer, 'count=exact')
    assert.equal(seen[0].headers.range, '0-0')
    const sent = seen[0].headers.authorization.replace(/^Bearer /, '')
    assert.notEqual(sent, browserToken)
    assert.ok(validInternal(sent), 'подписан внутренним секретом шлюза')
    const claims = decode(sent)
    // В базу — только минимум: кто, роль, почта. Ничего из содержимого токена браузера.
    assert.deepEqual(Object.keys(claims).sort(), ['email', 'exp', 'iat', 'osp_role', 'role', 'sub'])
    assert.deepEqual([claims.role, claims.osp_role, claims.sub, claims.email], ['portal_owner', 'authenticated', USER, 'user@example.ru'])
    assert.ok(claims.exp - claims.iat <= 60, 'живёт не дольше минуты')
    assert.ok(!seen[0].headers.apikey && !seen[0].headers['x-client-info'], 'лишние заголовки не передаются')
  })

  it('без токена — аноним: чтение по списку; негодный токен — отказ до PostgREST', async () => {
    const res = await call('GET', '/api/db/tenders?select=id')
    assert.equal(res.statusCode, 200)
    const claims = decode(seen[0].headers.authorization.replace(/^Bearer /, ''))
    assert.deepEqual([claims.role, claims.osp_role, claims.sub], ['portal_owner', 'anon', undefined])
    seen.length = 0
    for (const [token, why] of [
      ['not-a-token', 'мусор'],
      [projectKey('anon'), 'публичный ключ сайта вместо токена'],
      [projectKey('service_role'), 'служебный ключ'],
      [userToken(SUPABASE_URL, USER, { exp: Math.floor(Date.now() / 1000) - 60 }), 'просрочен'],
      [userToken('https://another.supabase.co', USER), 'другой проект'],
    ]) {
      const bad = await call('GET', '/api/db/tenders?select=id', { token })
      assert.equal(bad.statusCode, 401, why)
      assert.equal(bad.json().code, 'PGRST301', why)
    }
    assert.equal(seen.length, 0, 'до PostgREST такие запросы не доходят')
  })

  it('чего нет в списке — не доходит до PostgREST: таблицы, действия, функции, связанные таблицы', async () => {
    const t = user()
    const cases = [
      ['GET', '/api/db/kp_rates_registry_mv?select=id', t, 404],
      ['GET', '/api/db/pg_authid?select=*', t, 404],
      ['POST', '/api/db/psdc_rows', t, 403],
      ['PATCH', '/api/db/employee_directory?user_id=eq.1', t, 403],
      ['DELETE', '/api/db/employee_directory?user_id=eq.1', t, 403],
      ['GET', '/api/db/tenders?select=id,secret_table(id)', t, 403],
      ['POST', '/api/db/rpc/osp_is_employee', t, 404],
      ['POST', '/api/db/rpc/pg_sleep', t, 404],
      ['GET', '/api/db/counterparties?select=id', null, 401],
      ['POST', '/api/db/tenders', null, 401],
      ['PATCH', '/api/db/tenders?id=eq.1', null, 401],
      ['DELETE', '/api/db/tenders?id=eq.1', null, 401],
      ['POST', '/api/db/rpc/is_admin', null, 401],
      ['GET', '/api/db/tenders?select=id,counterparties(name)', null, 401],
      ['GET', '/api/db/tenders/extra', t, 404],
      ['GET', '/api/db/rpc/is_admin/extra', t, 404],
      ['GET', '/api/db/', t, 404],
      ['GET', '/api/db/..%2Ftenders', t, 404],
      ['PATCH', '/api/db/rpc/is_admin', t, 405],
    ]
    for (const [method, url, token, status] of cases) {
      const res = await call(method, url, { token, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' })
      assert.equal(res.statusCode, status, `${method} ${url}`)
      assert.ok(res.json().code && 'message' in res.json(), 'отказ в виде, который портал уже умеет показывать')
    }
    assert.equal(tableRequests().length, 0)
  })

  it('тело запроса и ответ PostgREST передаются как есть: байт в байт, с кодами и ошибками', async () => {
    // Число, которое JavaScript не хранит точно, и пробелы внутри — должны дойти без изменений.
    const body = '[{"amount": 12345678901234567890.123456789, "title":"Ёж  «тест»" }]'
    reply = () => ({ status: 201, headers: { 'content-range': '*/*', 'preference-applied': 'return=representation' }, body: '[{"id":"x","amount":12345678901234567890.123456789}]' })
    const created = await call('POST', '/api/db/tenders?select=id,amount', { token: user(), body, headers: { prefer: 'return=representation' } })
    assert.equal(created.statusCode, 201)
    assert.equal(created.body, '[{"id":"x","amount":12345678901234567890.123456789}]')
    assert.equal(created.headers['preference-applied'], 'return=representation')
    assert.equal(seen[0].body.toString('utf8'), body)
    assert.match(seen[0].headers['content-type'], /application\/json/)
    // Ошибка базы (нарушение уникальности) — код и тело те же, что вернул PostgREST.
    reply = () => ({ status: 409, body: '{"code":"23505","details":"Key (name)=(x) already exists.","hint":null,"message":"duplicate key value violates unique constraint"}' })
    const dup = await call('POST', '/api/db/counterparties', { token: user(), body: '{"name":"x"}' })
    assert.equal(dup.statusCode, 409)
    assert.equal(dup.json().code, '23505')
    // HEAD — без тела, с диапазоном (так портал считает строки).
    reply = () => ({ status: 200, headers: { 'content-range': '*/29298' }, body: '' })
    const head = await call('HEAD', '/api/db/tenders?select=id', { token: user(), headers: { prefer: 'count=exact' } })
    assert.deepEqual([head.statusCode, head.headers['content-range'], head.body], [200, '*/29298', ''])
    assert.equal(seen.at(-1).method, 'HEAD')
  })

  it('барьер записи: файл-переключатель оставляет только чтение', async () => {
    fs.writeFileSync(path.join(tmp, 'db-readonly'), '')
    await new Promise((r) => setTimeout(r, 1100)) // переключатель перечитывается раз в секунду
    const t = user()
    assert.equal((await call('GET', '/api/db/tenders?select=id', { token: t })).statusCode, 200)
    assert.equal((await call('GET', '/api/db/tenders?select=id')).statusCode, 200, 'витрина читается')
    for (const [method, url] of [['POST', '/api/db/tenders'], ['PATCH', '/api/db/tenders?id=eq.1'], ['DELETE', '/api/db/tenders?id=eq.1'], ['POST', '/api/db/rpc/psdc_validate']]) {
      const res = await call(method, url, { token: t, body: method === 'DELETE' ? undefined : '{}' })
      assert.equal(res.statusCode, 503, `${method} ${url}`)
      assert.equal(res.json().code, 'OSP_READONLY')
    }
    assert.deepEqual(seen.map((r) => r.method), ['GET', 'GET'], 'ни одна запись до базы не дошла')
    fs.rmSync(path.join(tmp, 'db-readonly'))
    await new Promise((r) => setTimeout(r, 1100))
    assert.equal((await call('POST', '/api/db/tenders', { token: t, body: '{}' })).statusCode, 200, 'барьер снят — запись идёт')
  })

  it('учётки входа: удаление и подтверждение почты — сначала вход Supabase, затем база; только администратору', async () => {
    const args = JSON.stringify({ target_user_id: TARGET })
    // Не администратор: во вход не ходим, функция базы откажет сама.
    await call('POST', '/api/db/rpc/admin_delete_user', { token: user(USER), body: args })
    assert.deepEqual(authAdminCalls, [])
    assert.deepEqual(seen.map((r) => r.url), ['/rpc/is_admin', '/rpc/admin_delete_user'])
    assert.equal(decode(seen[0].headers.authorization.replace(/^Bearer /, '')).sub, USER, 'вопрос «администратор ли» — от имени самого пользователя')
    // Администратор.
    seen.length = 0
    reply = (r) => (r.url.startsWith('/rpc/is_admin') ? { body: 'true' } : { status: 204, body: '' })
    assert.equal((await call('POST', '/api/db/rpc/admin_delete_user', { token: user(ADMIN), body: args })).statusCode, 204)
    assert.equal((await call('POST', '/api/db/rpc/admin_confirm_user_email', { token: user(ADMIN), body: args })).statusCode, 204)
    assert.deepEqual(authAdminCalls.map((c) => c.slice(0, 2)), [['deleteUser', TARGET], ['confirmEmail', TARGET]])
    assert.equal(authAdminCalls[0][2], 1, 'вход изменён после проверки прав и до функции базы')
    // Вход не ответил — база не тронута, понятный отказ.
    seen.length = 0
    authAdminFails = true
    const failed = await call('POST', '/api/db/rpc/admin_delete_user', { token: user(ADMIN), body: args })
    assert.equal(failed.statusCode, 502)
    assert.equal(failed.json().code, 'OSP_AUTH')
    assert.deepEqual(seen.map((r) => r.url), ['/rpc/is_admin'])
    // Без идентификатора в теле во вход не ходим.
    authAdminFails = false
    authAdminCalls = []
    await call('POST', '/api/db/rpc/admin_delete_user', { token: user(ADMIN), body: '{"target_user_id":"1 or 1=1"}' })
    assert.deepEqual(authAdminCalls, [])
  })

  it('PostgREST не отвечает — 503 «повторите»; шлюз не настроен — маршрут закрыт', async () => {
    await makeApp({ dbGateway: { upstream: 'http://127.0.0.1:9', secret: GATEWAY_SECRET, dbRole: 'portal_owner', readOnlyFile: '' } })
    const down = await call('GET', '/api/db/tenders?select=id', { token: user() })
    assert.equal(down.statusCode, 503)
    assert.equal(down.json().code, 'PGRST000')
    await makeApp({ dbGateway: { upstream: '', secret: '', dbRole: '', readOnlyFile: '' } })
    const off = await call('GET', '/api/db/tenders?select=id', { token: user() })
    assert.deepEqual([off.statusCode, off.json().code], [503, 'OSP_GATEWAY_OFF'])
  })

  it('маршруты файлов и готовность читают данные через тот же шлюз, а не из Supabase', async () => {
    reply = (r) => (r.url.startsWith('/user_roles') ? { body: '[]' } : r.url.startsWith('/app_settings') ? { body: '[{"key":"x"}]' } : {})
    const res = await app.inject({ method: 'POST', url: '/api/fn/s3-presign', payload: { action: 'download', s3_key: 'a/b' },
      headers: { authorization: `Bearer ${user(USER)}`, 'content-type': 'application/json' } })
    assert.equal(res.statusCode, 403, 'строки ролей нет — отказ')
    assert.match(seen[0].url, /^\/user_roles\?/)
    assert.equal(decode(seen[0].headers.authorization.replace(/^Bearer /, '')).sub, USER)
    seen.length = 0
    const ready = await app.inject({ method: 'GET', url: '/api/ready' })
    assert.equal(ready.json().checks.gateway, 'ok')
    assert.equal(decode(seen[0].headers.authorization.replace(/^Bearer /, '')).osp_role, 'service_role')
    reply = () => ({ status: 401, body: '{"code":"PGRST301","message":"JWSError JWSInvalidSignature"}' })
    assert.equal((await app.inject({ method: 'GET', url: '/api/ready' })).json().checks.gateway, 'fail', 'секрет шлюза не совпал с секретом PostgREST')
  })

  it('неверная настройка останавливает запуск; секретов в ответах и журнале нет', async () => {
    assert.throws(() => buildApp({ config: config({ dbGateway: { upstream: upstream.url, secret: 'short', dbRole: 'portal_owner' } }), logger: false }), /короче 32 символов/)
    assert.throws(() => buildApp({ config: config({ dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: '' } }), logger: false }), /OSP_PGRST_DB_ROLE/)
    const token = user()
    const res = await call('GET', '/api/db/tenders?select=id&title=eq.secret-filter-value', { token })
    await call('GET', '/api/db/tenders?select=id', { token: 'bad-token' })
    const text = [res.body, ...logs].join('\n')
    for (const secret of [GATEWAY_SECRET, SECRET, token, 'secret-filter-value', seen[0].headers.authorization]) assert.ok(!text.includes(secret), 'секрет или параметр запроса в журнале')
    assert.ok(logs.some((l) => l.includes('/api/db/*')), 'в журнале — шаблон маршрута')
  })
})
