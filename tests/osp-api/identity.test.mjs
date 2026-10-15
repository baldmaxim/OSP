// Кто вошёл — без обращения к Supabase на каждый запрос (server/osp-api: src/lib/token.js,
// src/lib/userStatus.js, сборка в src/app.js). Проверяем гарантии:
//   • токен проверяется на сервере, статус учётки читается из своей базы — к Supabase запросов нет;
//   • блокировка, отзыв одобрения и удаление учётки действуют при ещё живом токене — не позже срока кэша;
//   • сбой базы — 503 «повторите», а не «прав нет» и не падение службы;
//   • неверная настройка (секрет другого проекта, база не отвечает) видна в /api/ready до выкладки;
//   • секрет подписи, пароль базы и токены не попадают ни в ответы, ни в журнал.
// Статус — на настоящем PostgreSQL; Supabase — подделка, по ней считаем запросы.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { startFakeSupabase } from './lib/fakes.mjs'
import { SECRET, OTHER_SECRET, userToken, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const depsOk = fs.existsSync(path.join(SERVER, 'node_modules', 'jose')) && fs.existsSync(path.join(SERVER, 'node_modules', 'pg'))
const skipAll = depsOk ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const U = {
  emp: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  unapproved: '33333333-3333-4333-8333-333333333333',
  contractor: '44444444-4444-4444-8444-444444444444',
  blocked: '55555555-5555-4555-8555-555555555555',
  noRole: '66666666-6666-4666-8666-666666666666',
  later: '77777777-7777-4777-8777-777777777777', // блокируется и удаляется по ходу теста
}
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DB_PASSWORD = 'api-test-password-do-not-log'
const TTL_MS = 250

const ROWS_SQL = `
truncate public.user_roles;
insert into public.user_roles(user_id, role, counterparty_id, is_approved, is_blocked, full_name) values
  ('${U.emp}', 'engineer', null, true, false, 'Инженер Тестовый'),
  ('${U.admin}', 'admin', null, true, false, 'Админ'),
  ('${U.unapproved}', 'engineer', null, false, false, null),
  ('${U.contractor}', 'contractor', '${ORG}', true, false, 'Подрядчик'),
  ('${U.blocked}', 'engineer', null, true, true, 'Заблокированный'),
  ('${U.later}', 'engineer', null, true, false, 'Сотрудник');
`
const SETUP_SQL = `
create role api_login login password '${DB_PASSWORD}';
create table public.user_roles(
  user_id uuid primary key, role text not null, counterparty_id uuid,
  is_approved boolean, is_blocked boolean not null default false, full_name text);
alter table public.user_roles owner to api_login;
${ROWS_SQL}`

// ── Кэш статуса: правила без базы ──────────────────────────────────────────────────────────────
describe('osp-api: статус учётки — кэш не дольше минуты', { skip: skipAll }, () => {
  let createUserStatus
  // «База»: считает чтения, отдаёт строки по списку, умеет падать и задерживаться.
  const fakeDb = (rows) => {
    const db = {
      reads: 0, fail: null, gate: null,
      read: async (who, fn) => {
        assert.equal(who, null, 'статус читает служебная операция')
        db.reads++
        if (db.gate) await db.gate
        if (db.fail) throw db.fail
        return fn({ query: async (text, values) => {
          assert.match(text, /from public\.user_roles where user_id = \$1/)
          return { rows: rows[values[0]] ?? [] }
        } })
      },
    }
    return db
  }

  before(async () => {
    ;({ createUserStatus } = await import(path.join(SERVER, 'src', 'lib', 'userStatus.js')))
  })

  it('в пределах срока — из памяти; после срока — заново из базы', async () => {
    let clock = 1000
    const row = { role: 'engineer', is_approved: true, is_blocked: false }
    const rows = { a: [row] }
    const db = fakeDb(rows)
    const status = createUserStatus({ db, ttlMs: 30_000, now: () => clock })
    assert.deepEqual(await status.get('a'), row)
    clock += 29_999
    await status.get('a')
    assert.equal(db.reads, 1, 'второй запрос — из памяти')
    rows.a = [{ ...row, is_blocked: true }]
    clock += 1
    assert.equal((await status.get('a')).is_blocked, true, 'срок вышел — блокировка видна')
    assert.equal(db.reads, 2)
  })

  it('нет строки или строк несколько — статуса нет; отсутствие тоже помнится не дольше срока', async () => {
    let clock = 0
    const rows = { two: [{ role: 'admin' }, { role: 'engineer' }] }
    const db = fakeDb(rows)
    const status = createUserStatus({ db, ttlMs: 1000, now: () => clock })
    assert.equal(await status.get('nobody'), null)
    assert.equal(await status.get('two'), null, 'две строки — не угадываем, отказ')
    rows.nobody = [{ role: 'engineer', is_approved: true }]
    assert.equal(await status.get('nobody'), null, 'ещё из памяти')
    clock = 1000
    assert.equal((await status.get('nobody')).role, 'engineer', 'одобрили — увидели после срока')
  })

  it('одновременные запросы одного пользователя — одно чтение; сбой базы не запоминается', async () => {
    const db = fakeDb({ a: [{ role: 'engineer' }] })
    const status = createUserStatus({ db, ttlMs: 1000 })
    let open
    db.gate = new Promise((resolve) => { open = resolve })
    const waiting = [status.get('a'), status.get('a'), status.get('a')]
    open()
    assert.deepEqual((await Promise.all(waiting)).map((r) => r.role), ['engineer', 'engineer', 'engineer'])
    assert.equal(db.reads, 1)

    db.gate = null
    db.fail = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    await assert.rejects(status.get('b'), /ECONNREFUSED/)
    await assert.rejects(status.get('b'), /ECONNREFUSED/)
    assert.equal(db.reads, 3, 'каждый раз — новая попытка')
    db.fail = null
    assert.equal(await status.get('b'), null, 'база ответила — ответ настоящий')
    assert.equal((await status.get('a')).role, 'engineer', 'сбой не стёр статус других')
  })

  it('записей не больше предела: старые вытесняются; срок дольше минуты не принимается', async () => {
    const db = fakeDb({})
    const status = createUserStatus({ db, ttlMs: 1000, maxEntries: 3 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) await status.get(id)
    assert.equal(status.size(), 3)
    await status.get('e')
    assert.equal(db.reads, 5, 'свежая запись осталась')
    await status.get('a')
    assert.equal(db.reads, 6, 'вытесненная читается заново')
    assert.throws(() => createUserStatus({ db, ttlMs: 60_001 }), /не дольше 60 с/)
    assert.throws(() => createUserStatus({ db, ttlMs: -1 }), /не дольше 60 с/)
    assert.throws(() => createUserStatus({ ttlMs: 1000 }), /подключение не задано/)
    assert.doesNotThrow(() => createUserStatus({ db, ttlMs: 60_000 }))
  })
})

// ── Служба целиком: токен на сервере, статус из базы ────────────────────────────────────────────
const skipDb = skipAll || (pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)')

describe('osp-api: вход без обращения к Supabase на каждый запрос', { skip: skipDb, timeout: 300000 }, () => {
  let pgdb
  let supa
  let state
  let buildApp
  let access
  let app
  let logs
  let dbUrl

  const token = (userId, over) => userToken(supa.url, userId, over)
  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0,
    supabaseUrl: supa.url, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: projectKey('service_role'),
    supabaseJwtSecret: SECRET,
    s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' },
    anthropicApiKey: '', ratesApiKeys: [], required: ['supabase'],
    db: { url: dbUrl, caFile: '', poolMax: 2, secondLockRole: '' },
    userStatusTtlMs: TTL_MS,
    ...over,
  })

  async function makeApp(over = {}) {
    await app?.close()
    logs = []
    app = buildApp({ config: config(over), logger: { level: 'info', stream: { write: (line) => logs.push(line) } } })
    // Проверочные маршруты: что видит обработчик после проверки входа.
    for (const [url, require] of [['/api/test/approved', 'approved'], ['/api/test/employee', 'employee']]) {
      app.route({ method: 'POST', url, config: { access: access.user({ require, deny: 'Нет доступа' }) },
        handler: async (request) => ({ user: request.auth.user.id, who: request.auth.who, role: request.auth.roleRow.role, org: request.auth.roleRow.counterparty_id }) })
    }
    await app.ready()
    return app
  }
  const call = (url, bearer) => app.inject({
    method: 'POST', url, payload: '{}',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  })
  const approved = (bearer) => call('/api/test/approved', bearer)
  const employee = (bearer) => call('/api/test/employee', bearer)
  const supabaseCalls = () => supa.requests.map((r) => r.path)

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ access } = await import(path.join(SERVER, 'src', 'lib', 'access.js')))
    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL)
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`
    state = { users: {}, roles: {} }
    supa = await startFakeSupabase(state)
  })
  after(async () => {
    await app?.close()
    await supa?.close()
    pgdb?.stop()
  })
  beforeEach(async () => {
    pgdb.exec(ROWS_SQL)
    supa.reset()
    state.users = {}
    state.roles = {}
    await makeApp()
  })

  it('сотрудник входит: токен проверен на сервере, статус из базы — к Supabase ни одного запроса', async () => {
    const res = await approved(token(U.emp, { email: 'emp@example.ru' }))
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { user: U.emp, who: { userId: U.emp, email: 'emp@example.ru' }, role: 'engineer', org: null })
    assert.equal((await employee(token(U.admin))).json().role, 'admin')
    // Подрядчик: одобрен — да, сотрудник — нет; организация берётся из базы, а не из токена.
    const contractor = await approved(token(U.contractor, { app_metadata: { counterparty_id: 'подделка' } }))
    assert.equal(contractor.json().org, ORG)
    assert.equal((await employee(token(U.contractor))).statusCode, 403)
    assert.deepEqual(supabaseCalls(), [])
  })

  it('не токен пользователя — 401, в базу и в Supabase не ходим', async () => {
    // База намеренно недоступна: обращение к ней дало бы 503. Отказ 401 — значит, до базы не дошли.
    await makeApp({ db: { url: `postgres://api_login:${DB_PASSWORD}@127.0.0.1:9/psdc_test`, caFile: '', poolMax: 2, secondLockRole: '' } })
    assert.equal((await approved(token(U.emp))).statusCode, 503, 'настоящий токен до базы доходит')
    for (const [bearer, why] of [
      [null, 'без токена'],
      ['не-токен', 'не токен: знаки вне набора'],
      ['abc def', 'не токен: пробел'],
      ['a.b.c', 'мусор из трёх частей'],
      [projectKey('anon'), 'публичный ключ сайта'],
      [projectKey('service_role'), 'служебный ключ'],
      [userToken(supa.url, U.emp, {}, OTHER_SECRET), 'чужая подпись'],
      [token(U.emp, { exp: Math.floor(Date.now() / 1000) - 60 }), 'просрочен'],
      [userToken('https://another.supabase.co', U.emp), 'другой проект'],
    ]) {
      const res = await approved(bearer)
      assert.equal(res.statusCode, 401, why)
      assert.deepEqual(res.json(), { error: 'Unauthorized' }, why)
    }
    assert.deepEqual(supabaseCalls(), [])
  })

  it('живой токен не спасает: заблокированный, неодобренный и учётка без строки ролей — 403', async () => {
    for (const [id, why] of [[U.blocked, 'заблокирован'], [U.unapproved, 'не одобрен'], [U.noRole, 'нет строки ролей']]) {
      const res = await employee(token(id))
      assert.equal(res.statusCode, 403, why)
      assert.deepEqual(res.json(), { error: 'Нет доступа' }, why)
    }
    // «Одобрен» — мягче: без строки ролей и заблокированный всё равно не проходят.
    assert.equal((await approved(token(U.blocked))).statusCode, 403)
    assert.equal((await approved(token(U.noRole))).statusCode, 403)
    assert.deepEqual(supabaseCalls(), [])
  })

  it('блокировка и удаление учётки действуют при живом токене — не позже срока кэша', async () => {
    const bearer = token(U.later)
    assert.equal((await employee(bearer)).statusCode, 200)
    pgdb.exec(`update public.user_roles set is_blocked = true where user_id = '${U.later}';`)
    await sleep(TTL_MS + 100)
    assert.equal((await employee(bearer)).statusCode, 403, 'заблокирован — тот же токен больше не работает')
    // Разблокировали — после срока снова работает.
    pgdb.exec(`update public.user_roles set is_blocked = false where user_id = '${U.later}';`)
    await sleep(TTL_MS + 100)
    assert.equal((await employee(bearer)).statusCode, 200)
    // Отозвали одобрение.
    pgdb.exec(`update public.user_roles set is_approved = false where user_id = '${U.later}';`)
    await sleep(TTL_MS + 100)
    assert.equal((await employee(bearer)).statusCode, 403, 'одобрение отозвано')
    // Удалили учётку.
    pgdb.exec(`update public.user_roles set is_approved = true where user_id = '${U.later}';`)
    await sleep(TTL_MS + 100)
    assert.equal((await approved(bearer)).statusCode, 200)
    pgdb.exec(`delete from public.user_roles where user_id = '${U.later}';`)
    await sleep(TTL_MS + 100)
    assert.equal((await approved(bearer)).statusCode, 403, 'учётка удалена')
    assert.deepEqual(supabaseCalls(), [])
  })

  it('база не отвечает — 503 «повторите», а не «прав нет»; служба продолжает работать', async () => {
    await makeApp({ db: { url: `postgres://api_login:${DB_PASSWORD}@127.0.0.1:9/psdc_test`, caFile: '', poolMax: 2, secondLockRole: '' } })
    const res = await employee(token(U.emp))
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { error: 'Сервис временно недоступен, повторите запрос' })
    assert.equal((await approved(null)).statusCode, 401, 'служба отвечает и после сбоя')
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200)
    // База вернулась — тот же пользователь проходит без перезапуска службы.
    await makeApp()
    assert.equal((await employee(token(U.emp))).statusCode, 200)
  })

  it('/api/ready: база и секрет подписи проверяются; чужой секрет и недоступная база — 503 до выкладки', async () => {
    const ready = () => app.inject({ method: 'GET', url: '/api/ready' })
    const ok = await ready()
    assert.equal(ok.statusCode, 200, ok.body)
    assert.deepEqual(ok.json().checks, { supabase: 'ok', s3: 'not_configured', anthropic: 'not_configured', db: 'ok', token: 'ok', gateway: 'not_configured' })

    await makeApp({ supabaseJwtSecret: OTHER_SECRET })
    const wrongSecret = await ready()
    assert.equal(wrongSecret.statusCode, 503, 'секрет от другого проекта: любой вход получил бы 401')
    assert.equal(wrongSecret.json().checks.token, 'fail')
    assert.equal((await employee(token(U.emp))).statusCode, 401)

    await makeApp({ db: { url: `postgres://api_login:${DB_PASSWORD}@127.0.0.1:9/psdc_test`, caFile: '', poolMax: 2, secondLockRole: '' } })
    const dbDown = await ready()
    assert.equal(dbDown.statusCode, 503)
    assert.equal(dbDown.json().checks.db, 'fail')

    await makeApp({ db: { url: `postgres://no_such_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`, caFile: '', poolMax: 2, secondLockRole: '' } })
    assert.equal((await ready()).json().checks.db, 'fail', 'база не принимает учётку')

    // Публичный ключ нового вида — не токен: сверить секрет нечем, готовность это не роняет…
    await makeApp({ supabaseAnonKey: 'sb_publishable_abcdefghijklmnop' })
    const unchecked = await ready()
    assert.equal(unchecked.statusCode, 200)
    assert.equal(unchecked.json().checks.token, 'unchecked')
    // …но если проверку секрета потребовали явно — отказ.
    await makeApp({ supabaseAnonKey: 'sb_publishable_abcdefghijklmnop', required: ['supabase', 'token'] })
    assert.equal((await ready()).statusCode, 503)
    await makeApp({ required: ['supabase', 'db', 'token'] })
    assert.equal((await ready()).statusCode, 200)
  })

  it('переход по частям: только токен на сервере — статус ещё из Supabase; только база — токен ещё через Supabase', async () => {
    // Задан секрет, своей базы нет: запроса «кто это» к Supabase нет, строка ролей — оттуда, под токеном пользователя.
    const empToken = token(U.emp)
    state.users[empToken] = { id: U.emp }
    state.roles[U.emp] = { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Инженер' }
    await makeApp({ db: { url: '', caFile: '', poolMax: 2, secondLockRole: '' } })
    assert.equal((await employee(empToken)).statusCode, 200)
    assert.deepEqual(supabaseCalls(), ['/rest/v1/user_roles'])
    assert.equal(supa.requests[0].auth, `Bearer ${empToken}`, 'под токеном пользователя, не служебным ключом')

    // Задана база, секрета нет: «кто это» — запросом к Supabase, статус — из базы.
    supa.reset()
    state.users['tok-opaque'] = { id: U.admin }
    await makeApp({ supabaseJwtSecret: '' })
    const res = await employee('tok-opaque')
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().role, 'admin')
    assert.deepEqual(supabaseCalls(), ['/auth/v1/user'])
    assert.equal((await employee('tok-unknown')).statusCode, 401)
  })

  it('в ответах и журнале нет секрета подписи, пароля базы и токенов', async () => {
    const bearer = token(U.emp)
    await employee(bearer)
    await employee(token(U.blocked))
    await approved(projectKey('anon'))
    const health = await app.inject({ method: 'GET', url: '/api/health' })
    assert.deepEqual(health.json().configured, { supabase: true, supabaseService: true, s3: false, anthropic: false, rates: false, db: true, token: true, gateway: false, larix: false })
    const ready = await app.inject({ method: 'GET', url: '/api/ready' })
    await makeApp({ db: { url: `postgres://api_login:${DB_PASSWORD}@127.0.0.1:9/psdc_test`, caFile: '', poolMax: 2, secondLockRole: '' } })
    const failed = await employee(bearer)
    const readyDown = await app.inject({ method: 'GET', url: '/api/ready' })
    const seen = [health.body, ready.body, failed.body, readyDown.body, ...logs].join('\n')
    assert.ok(logs.some((line) => line.includes('user status')), 'сбой базы записан в журнал')
    for (const [secret, what] of [[SECRET, 'секрет подписи'], [DB_PASSWORD, 'пароль базы'], [bearer, 'токен'], [bearer.split('.')[2], 'подпись токена'], [projectKey('service_role'), 'служебный ключ']]) {
      assert.ok(!seen.includes(secret), what)
    }
  })

  it('неверная настройка останавливает запуск: короткий секрет, база без проверки сертификата', () => {
    assert.throws(() => buildApp({ config: config({ supabaseJwtSecret: 'short' }), logger: false }), /короче 32 символов/)
    assert.throws(() => buildApp({ config: config({ db: { url: 'postgres://u:p@db.example.internal:6432/osp', caFile: '', poolMax: 2 } }), logger: false }),
      /без проверки сертификата запрещено/)
    assert.throws(() => buildApp({ config: config({ db: { url: 'postgres://u:p@127.0.0.1:5432/osp?sslmode=disable', caFile: '', poolMax: 2 } }), logger: false }),
      /только verify-full/)
    assert.throws(() => buildApp({ config: config({ userStatusTtlMs: 120_000 }), logger: false }), /не дольше 60 с/)
  })
})
