// Суперадминистратор (запись в public.superadmins) на маршрутах сверки с Signal — решение владельца 24.11.2026.
// Маршруты сотрудника объявлены с требованием employeeOrSuperadmin (server/osp-api/src/lib/access.js): суперадминистратор проходит
// даже без строки в user_roles; заблокированный и подрядчик — нет. Дальше решает база: public.osp_can начинается с public.is_admin(),
// охват без строки — «все объекты». Проверяется механизмом:
//   • требование как функция: таблица «строка ролей × суперадминистратор»;
//   • настоящий buildApp в режиме both (isSuperadmin есть только у режимов со своим входом — в supabase его нет) и настоящая база:
//     status, метки, карточка, поиск папок, /match, confirm / unlink, маршрут администратора;
//   • отказы: заблокированный, подрядчик (в том числе суперадминистратор), учётка без строки и без записи в superadmins;
//   • обычный сотрудник и просмотр — как раньше (суперадминистратор права других не расширил).
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { signalConfig, SUPABASE_URL } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'

const key = () => crypto.randomUUID()
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const depsOk = fs.existsSync(path.join(SERVER, 'node_modules', 'fastify'))

describe('REQUIREMENTS.employeeOrSuperadmin: строка ролей × суперадминистратор', { skip: depsOk ? false : 'нет зависимостей: npm ci --prefix server/osp-api' }, () => {
  let requirement
  before(async () => {
    const { REQUIREMENTS } = await import(path.join(SERVER, 'src', 'lib', 'access.js'))
    requirement = REQUIREMENTS.employeeOrSuperadmin
  })
  const ENGINEER = { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: false }
  const run = async (row, superadmin, { withFn = true } = {}) => {
    const asked = []
    const isSuperadmin = withFn ? async (id) => { asked.push(id); return superadmin } : undefined
    const ok = await requirement(row, { auth: { user: { id: 'u-1' } }, isSuperadmin })
    return { ok, asked: asked.length }
  }

  it('сотрудник проходит без обращения к superadmins; подрядчик, заблокированный и неодобренный без записи — нет', async () => {
    assert.deepEqual(await run(ENGINEER, false), { ok: true, asked: 0 })
    assert.deepEqual(await run({ ...ENGINEER, role: 'admin' }, false), { ok: true, asked: 0 })
    assert.equal((await run({ ...ENGINEER, role: 'contractor', counterparty_id: 'cp-1' }, false)).ok, false)
    assert.equal((await run({ ...ENGINEER, is_blocked: true, is_approved: false }, false)).ok, false)
    assert.equal((await run({ ...ENGINEER, is_approved: false }, false)).ok, false)
    assert.equal((await run({ ...ENGINEER, counterparty_id: 'cp-1' }, false)).ok, false)
  })

  it('суперадминистратор без строки ролей проходит; не суперадминистратор без строки — нет; без функции isSuperadmin (режим supabase) — нет', async () => {
    assert.deepEqual(await run(null, true), { ok: true, asked: 1 })
    assert.deepEqual(await run(undefined, true), { ok: true, asked: 1 })
    assert.deepEqual(await run(null, false), { ok: false, asked: 1 })
    assert.deepEqual(await run(null, true, { withFn: false }), { ok: false, asked: 0 })
    assert.deepEqual(await run({ ...ENGINEER, is_approved: false }, true, { withFn: false }), { ok: false, asked: 0 })
  })

  it('суперадминистратор со строкой: заблокированный и подрядчик (организация или роль) — отказ без обращения к superadmins; неодобренная строка — не помеха', async () => {
    for (const row of [
      { ...ENGINEER, is_blocked: true, is_approved: false },
      { ...ENGINEER, role: 'contractor' },
      { ...ENGINEER, counterparty_id: 'cp-1' },
      { ...ENGINEER, role: 'contractor', counterparty_id: 'cp-1' },
    ]) assert.deepEqual(await run(row, true), { ok: false, asked: 0 }, JSON.stringify(row))
    // Как is_admin() в базе: суперадминистратору одобрение строки не нужно.
    assert.deepEqual(await run({ ...ENGINEER, is_approved: false }, true), { ok: true, asked: 1 })
    assert.deepEqual(await run({ ...ENGINEER, role: 'admin', is_approved: false }, true), { ok: true, asked: 1 })
  })

  it('ответ функции приводится к булеву, ошибка проверки не превращается в «можно»', async () => {
    assert.equal((await run(null, 1)).ok, true)
    assert.equal((await run(null, 0)).ok, false)
    assert.equal((await run(null, null)).ok, false)
    await assert.rejects(requirement(null, { auth: { user: { id: 'u-1' } }, isSuperadmin: async () => { throw new Error('база недоступна') } }), /база недоступна/)
  })
})

describe('Маршруты /api/signal/* для суперадминистратора на настоящей базе', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let app
  let U
  let C
  let F
  let sup // суперадминистратор без строки в user_roles
  let supBlocked // суперадминистратор с заблокированной строкой
  let supContractor // суперадминистратор со строкой подрядчика (организация)
  let supUnapproved // суперадминистратор с неодобренной строкой сотрудника
  let nobody // ни строки ролей, ни записи в superadmins
  let blockedEmployee

  const call = (uid, method, url, payload) => app.inject({
    method, url, headers: { authorization: `Bearer ${userToken(SUPABASE_URL, uid)}` },
    ...(payload !== undefined ? { payload } : method === 'GET' ? {} : { payload: {} }),
  })
  const get = (uid, url) => call(uid, 'GET', url)
  const post = (uid, url, payload = {}) => call(uid, 'POST', url, payload)
  const card = async (uid, id) => {
    const res = await get(uid, `/api/signal/contracts/${id}`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const linkOf = (id) => one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`)
  const auditCount = (id) => Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(id)} and event_type = 'signal_link'`))
  const stateOf = (id) => one(db, `select state || ':' || coalesce(reason, '') || ':' || state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)
  const makeSuperadmin = (id) => db.sql(`INSERT INTO public.superadmins (user_id) VALUES (${lit(id)})`)
  const roleRow = (id, { role = 'engineer', approved = true, blocked = false, counterparty = null } = {}) => {
    db.sql(`INSERT INTO public.roles (key, label) VALUES (${lit(role)}, ${lit(role)}) ON CONFLICT DO NOTHING`)
    db.sql(`INSERT INTO public.user_roles (user_id, role, is_approved, is_blocked, email, counterparty_id)
      VALUES (${lit(id)}, ${lit(role)}, ${approved && !blocked}, ${blocked}, ${lit(`${id}@example.invalid`)}, ${lit(counterparty)})`)
  }

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    C = s.contracts
    F = s.folders
    // Суперадминистраторы создаются до первого запроса: сервер помнит ответ «суперадминистратор?» около 30 секунд.
    sup = db.id('sup')
    makeSuperadmin(sup)
    supBlocked = db.id('sup')
    roleRow(supBlocked, { blocked: true })
    makeSuperadmin(supBlocked)
    supContractor = db.id('sup')
    roleRow(supContractor, { role: 'contractor', counterparty: s.cpR })
    makeSuperadmin(supContractor)
    supUnapproved = db.id('sup')
    roleRow(supUnapproved, { approved: false })
    makeSuperadmin(supUnapproved)
    nobody = db.id('usr')
    blockedEmployee = db.seed.user({ contracts: 'edit', blocked: true })
    // «Шлюз» тестовой базы: правка договора от имени пользователя (в заготовке схемы у contracts только служебная политика).
    db.sql(`create policy signal_test_user on public.contracts for all to public
      using (current_setting('application_name', true) = 'osp-api') with check (current_setting('application_name', true) = 'osp-api')`)

    // Режим both: у AUTH_MODE=supabase нет проверки superadmins (isSuperadmin = null), а портал на базе Яндекса работает в both | own | keycloak.
    // Вход — по токену Supabase Auth (как в tests/osp-api/lib/signal-app.mjs): режим both пускает такой токен без сессии.
    const { buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const { DEFAULT_LIMITS } = await import(path.join(SERVER, 'src', 'lib', 'limits.js'))
    app = buildApp({
      config: {
        host: '127.0.0.1', port: 0,
        supabaseUrl: SUPABASE_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: 'service-test-key', supabaseJwtSecret: SECRET,
        s3: {}, anthropicApiKey: '', ratesApiKeys: [],
        db: { url: db.url, caFile: '', poolMax: 4, secondLockRole: '' }, userStatusTtlMs: 0,
        dbGateway: { upstream: 'http://127.0.0.1:9', secret: 'g'.repeat(40), dbRole: 'portal_owner', readOnlyFile: '' },
        authMode: 'both', authCleanup: false,
        auth: { keys: `t1:${crypto.randomBytes(32).toString('base64')}`, pilotIds: [nobody], publicOrigin: 'https://tender.test', idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
        signal: signalConfig({}),
      },
      deps: { ...defaultDeps, signalClient: { allowLoopback: true } },
      logger: false,
      limits: { ...DEFAULT_LIMITS, signalWritePerUser: { max: 1000, windowMs: 60_000 } },
    })
    await app.ready()
    // Начальный проход очереди — по готовому снимку (в Signal не ходим: подключения нет).
    for (let i = 0; i < 50; i++) if (!(await app.signal.jobs.tick()).contracts) break
  })
  after(async () => {
    await app?.close()
    await db?.stop()
  })

  const EMPLOYEE_CALLS = (id, node) => [
    ['GET', '/api/signal/status'], ['GET', '/api/signal/marks'], ['GET', `/api/signal/contracts/${id}`], ['GET', `/api/signal/folders?contractId=${id}`],
    ['POST', '/api/signal/match', { contractIds: [id] }],
    ['POST', `/api/signal/contracts/${id}/confirm`, { nodeId: node, replace: false, expectedSignalLink: null, expectedStateVersion: 1, idempotencyKey: key() }],
    ['POST', `/api/signal/contracts/${id}/reject`, { nodeId: node, expectedStateVersion: 1, idempotencyKey: key() }],
    ['POST', `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: 'https://signal.example.test/x', expectedStateVersion: 1, idempotencyKey: key() }],
    ['POST', '/api/signal/aliases', { objectId: s.A, text: 'Альфа Парк' }], ['DELETE', '/api/signal/aliases/1', {}],
  ]

  it('база и сервер согласны: суперадминистратор без строки ролей — isAdmin и право правки; обычная учётка без строки — нет', () => {
    const flags = db.asJson(sup, 'select osp_private.signal_user_flags()')
    assert.deepEqual(flags, { canView: true, canEdit: true, isAdmin: true })
    assert.deepEqual(db.asJson(nobody, 'select osp_private.signal_user_flags()'), { canView: false, canEdit: false, isAdmin: false })
    assert.equal(one(db, `select count(*) from public.user_roles where user_id = ${lit(sup)}`), '0', 'строки ролей у суперадминистратора нет')
  })

  it('status: включено, canView / canEdit / isAdmin — истина, как у администратора (корни и прогоны)', async () => {
    const res = await get(sup, '/api/signal/status')
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.deepEqual([body.enabled, body.canView, body.canEdit, body.isAdmin], [true, true, true, true])
    assert.deepEqual(body.sources.map((x) => x.projectName), ['Тест: проект Альфа', 'Тест: проект Бета'])
    assert.equal(body.confirmAvailable, true)
    assert.equal(res.headers['cache-control'], 'private, no-store')
  })

  it('marks: охват — все объекты (как без ограничения по объектам), подсказки с путями', async () => {
    const res = await get(sup, '/api/signal/marks')
    assert.equal(res.statusCode, 200, res.body)
    const ids = res.json().items.map((m) => m.id).sort()
    const editor = (await get(U.editor, '/api/signal/marks')).json().items.map((m) => m.id).sort()
    assert.deepEqual(ids, editor, 'столько же договоров, сколько у сотрудника с правом правки на все объекты')
    assert.ok(ids.includes(C.c1) && ids.includes(C.cb), 'и объект A, и объект B')
    const byId = Object.fromEntries(res.json().items.map((m) => [m.id, m]))
    assert.match(byId[C.c1].tip, /^Signal: предложена папка Документы Альфа \/ Корпус 1 \/ ДП АЛФ-ДП-26-001/, 'предложенная папка — путь виден при праве правки')
    assert.match(byId[C.c2].tip, /^Signal: сверено/)
    assert.equal(byId[C.c1].hasCandidate, true)
  })

  it('карточка договора и поиск папок: предложения, canEdit; договор объекта B тоже виден', async () => {
    const c1 = await card(sup, C.c1)
    assert.equal(c1.canEdit, true)
    assert.equal(c1.candidates[0].nodeId, F.f1)
    const cb = await card(sup, C.cb)
    assert.equal(cb.candidates[0].nodeId, F.fb1)
    const missing = await get(sup, `/api/signal/contracts/${key()}`)
    assert.equal(missing.statusCode, 404, 'несуществующий договор — 404 без деталей')
    const folders = await get(sup, `/api/signal/folders?contractId=${C.c1}&q=${encodeURIComponent('корпус 2')}`)
    assert.equal(folders.statusCode, 200, folders.body)
    assert.ok(folders.json().items.length >= 1)
  })

  it('/match: сверка по снимку для 1–200 договоров; ссылка не меняется, в Signal запросов нет', async () => {
    const res = await post(sup, '/api/signal/match', { contractIds: [C.c1, C.c2, C.cb] })
    assert.equal(res.statusCode, 200, res.body)
    const items = Object.fromEntries(res.json().items.map((i) => [i.id, i]))
    assert.deepEqual([items[C.c1].state, items[C.c1].nodeId], ['suggested', F.f1])
    assert.equal(items[C.c2].state, 'verified')
    assert.equal(items[C.cb].nodeId, F.fb1)
    assert.equal(linkOf(C.c1), '')
    assert.equal(linkOf(C.cb), '')
  })

  it('confirm, unlink, reject: решения человека суперадминистратора — одной транзакцией, событие «Истории» с именем автора', async () => {
    const before = await card(sup, C.c1)
    const body = { nodeId: F.f1, replace: false, expectedSignalLink: before.signalLink, expectedStateVersion: before.stateVersion, idempotencyKey: key() }
    const res = await post(sup, `/api/signal/contracts/${C.c1}/confirm`, body)
    assert.equal(res.statusCode, 200, res.body)
    const out = res.json()
    assert.deepEqual([out.state, out.reason, out.stateVersion, out.signalLink], ['verified', 'confirmed', before.stateVersion + 1, s.urlOf(F.f1)])
    assert.equal(linkOf(C.c1), s.urlOf(F.f1))
    assert.equal(auditCount(C.c1), 1)
    assert.ok(one(db, `select coalesce(changed_by_name, '') from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`).length > 0,
      'в «Истории» автор указан, хотя строки user_roles нет')
    assert.deepEqual((await post(sup, `/api/signal/contracts/${C.c1}/confirm`, body)).json(), out, 'повтор ключа — тот же ответ')
    assert.equal(auditCount(C.c1), 1)

    const unlink = await post(sup, `/api/signal/contracts/${C.c1}/unlink`, { expectedSignalLink: out.signalLink, expectedStateVersion: out.stateVersion, idempotencyKey: key() })
    assert.equal(unlink.statusCode, 200, unlink.body)
    assert.equal(linkOf(C.c1), '')
    assert.equal(auditCount(C.c1), 2)

    // Отказ — по договору объекта B (за пределами «своего» объекта обычного сотрудника): пара отклонена.
    const cb = await card(sup, C.cb)
    const reject = await post(sup, `/api/signal/contracts/${C.cb}/reject`, { nodeId: F.fb1, note: 'не та папка', expectedStateVersion: cb.stateVersion, idempotencyKey: key() })
    assert.equal(reject.statusCode, 200, reject.body)
    assert.deepEqual([reject.json().state, reject.json().reason], ['none', 'none'])
    assert.equal(stateOf(C.cb).split(':')[0], 'none')
  })

  it('синоним объекта и маршруты администратора: суперадминистратор — как администратор', async () => {
    const created = await post(sup, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Парк' })
    assert.equal(created.statusCode, 200, created.body)
    assert.equal((await get(sup, '/api/signal/aliases')).statusCode, 200)
    assert.equal((await get(sup, '/api/signal/runs')).statusCode, 200)
    assert.equal((await get(sup, '/api/signal/unassigned?sourceId=1')).statusCode !== 403, true)
  })

  it('заблокированный (в том числе суперадминистратор), подрядчик (в том числе суперадминистратор) и учётка без строки и без superadmins — 403 везде', async () => {
    for (const [name, uid] of [['суперадмин с заблокированной строкой', supBlocked], ['заблокированный сотрудник', blockedEmployee],
      ['суперадмин-подрядчик', supContractor], ['подрядчик', U.contractor], ['без строки и без superadmins', nobody]]) {
      for (const [method, url, body] of EMPLOYEE_CALLS(C.c1, F.f1)) {
        const res = await call(uid, method, url, body)
        assert.equal(res.statusCode, 403, `${name}: ${method} ${url}: ${res.body}`)
        for (const needle of ['Альфа', 'Корпус', 'Ромашка', F.f1]) assert.ok(!res.body.includes(needle), `${name}: в ответе есть «${needle}»`)
      }
    }
    assert.equal(linkOf(C.c1), '')
  })

  it('суперадминистратор с неодобренной строкой сотрудника: как is_admin() в базе — проходит; строка не ограничивает охват', async () => {
    const res = await get(supUnapproved, '/api/signal/status')
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual([res.json().canEdit, res.json().isAdmin], [true, true])
  })

  it('обычный сотрудник и просмотр — как раньше; администраторские маршруты им закрыты', async () => {
    const editor = (await get(U.editor, '/api/signal/status')).json()
    assert.deepEqual([editor.enabled, editor.canView, editor.canEdit, editor.isAdmin], [true, true, true, false])
    assert.ok(!('sources' in editor), 'сотруднику корни не показываются')
    const viewer = (await get(U.viewer, '/api/signal/status')).json()
    assert.deepEqual([viewer.canView, viewer.canEdit, viewer.isAdmin], [true, false, false])
    assert.equal((await get(U.viewer, `/api/signal/folders?contractId=${C.c1}`)).statusCode, 403)
    assert.equal((await post(U.viewer, '/api/signal/match', { contractIds: [C.c1] })).statusCode, 403)
    assert.equal((await get(U.editor, '/api/signal/runs')).statusCode, 403)
    assert.equal((await get(U.editorB, `/api/signal/contracts/${C.c1}`)).statusCode, 404, 'охват по объектам у обычного сотрудника действует')
    // Сотрудник без права на «Договоры»: сервер пускает, база — «выключено».
    assert.deepEqual((await get(U.noRight, '/api/signal/status')).json(), { enabled: false })
    // Без токена — 401.
    assert.equal((await app.inject({ method: 'GET', url: '/api/signal/status' })).statusCode, 401)
  })
})
