// Сверка с Signal в режиме входа по СЕССИИ (cookie + защита запроса, AUTH_MODE own), В-13 / проверка 9.8: маршруты /api/signal/* работают
// не только с токеном Supabase (Bearer — остальные файлы signal-routes*.test.mjs), но и с cookie своего входа:
//   • сотрудник с cookie получает status (enabled:true), marks, карточку; решения человека и /match без отметки защиты (заголовок
//     X-OSP-CSRF) и без источника «с портала» — отказ OSP_CSRF до любой работы с базой, с отметкой — проходят;
//   • подрядчик с сессией, учётка без права «Договоры», заблокированный и запрос без cookie — отказ, ничего не раскрыто;
//   • в режиме сессии токен Supabase отклоняется (одна схема входа за раз).
// Сессии создаёт тот же модуль, что и вход (src/lib/auth/sessions.js); данные — синтетика. Нужны PostgreSQL и зависимости сервера.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { startSignalDb, signalDbSkip, SERVER, ROOT } from './lib/signal-db.mjs'
import { signalConfig, SUPABASE_URL } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'

const key = () => crypto.randomUUID()
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
const ORIGIN = 'https://tender.test'
const SESSION_COOKIE = '__Host-osp_session'
const CSRF_COOKIE = '__Host-osp_csrf'

describe('Маршруты /api/signal/* в режиме сессии (cookie + CSRF), AUTH_MODE own', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let sdb
  let s
  let app
  let C
  let F
  let W // сессии: { token, csrf, id }

  const sessionFor = async (userId) => {
    const out = await sdb.write(null, (tx) => W.sessions.createInTx(tx, { userId }))
    return { ...out, id: userId }
  }
  // Запрос от браузера: cookie, отметка защиты и источник — по отдельности отключаются.
  const call = (who, method, url, { payload, csrf = true, origin = ORIGIN, bearer = null } = {}) => app.inject({
    method, url,
    headers: {
      ...(who ? { cookie: `${SESSION_COOKIE}=${who.token}; ${CSRF_COOKIE}=${who.csrf}` } : {}),
      ...(who && csrf ? { 'x-osp-csrf': who.csrf } : {}),
      ...(origin ? { origin, 'sec-fetch-site': 'same-origin' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(payload !== undefined ? { payload } : method === 'GET' ? {} : { payload: {} }),
  })
  const get = (who, url) => call(who, 'GET', url)
  const linkOf = (id) => one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`)
  const stateOf = (id) => one(db, `select state || ':' || coalesce(reason, '') || ':' || state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb()
    s = await seedScenario(db)
    C = s.contracts
    F = s.folders
    // Учётки входа (auth.users) и схемы своего входа — как в базе Яндекса после миграции 20261019_own_auth.
    db.sql('create table auth.users (id uuid primary key, email text)')
    const users = { editor: s.users.editor, viewer: s.users.viewer, noRight: s.users.noRight, contractor: s.users.contractor, admin: s.users.admin,
      blocked: db.seed.user({ contracts: 'edit', blocked: true }) }
    for (const [name, id] of Object.entries(users)) db.sql(`insert into auth.users (id, email) values (${lit(id)}, ${lit(`${name}@example.invalid`)})`)
    db.applyFile(path.join(ROOT, 'migration', 'yandex', '20261019_own_auth.sql'))
    db.sql(`create policy signal_test_user on public.contracts for all to public
      using (current_setting('application_name', true) = 'osp-api') with check (current_setting('application_name', true) = 'osp-api')`)

    const { createSessions } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'sessions.js'))
    W = { sessions: createSessions({ db: sdb }) }
    const { buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const { DEFAULT_LIMITS } = await import(path.join(SERVER, 'src', 'lib', 'limits.js'))
    app = buildApp({
      config: {
        host: '127.0.0.1', port: 0,
        supabaseUrl: SUPABASE_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: 'service-test-key', supabaseJwtSecret: SECRET,
        s3: {}, anthropicApiKey: '', ratesApiKeys: [],
        db: { url: db.url, caFile: '', poolMax: 4, secondLockRole: '' }, userStatusTtlMs: 0,
        dbGateway: { upstream: 'http://127.0.0.1:9', secret: 'g'.repeat(40), dbRole: 'portal_owner', readOnlyFile: '' },
        authMode: 'own', authCleanup: false,
        auth: { keys: `t1:${crypto.randomBytes(32).toString('base64')}`, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
        signal: signalConfig({}),
      },
      deps: { ...defaultDeps, signalClient: { allowLoopback: true } },
      logger: false,
      limits: { ...DEFAULT_LIMITS, signalWritePerUser: { max: 1000, windowMs: 60_000 }, signalMatchPerUser: { max: 1000, windowMs: 60_000 } },
    })
    await app.ready()
    for (let i = 0; i < 50; i++) if (!(await app.signal.jobs.tick()).contracts) break
    W.editor = await sessionFor(users.editor)
    W.viewer = await sessionFor(users.viewer)
    W.noRight = await sessionFor(users.noRight)
    W.contractor = await sessionFor(users.contractor)
    W.admin = await sessionFor(users.admin)
    W.blocked = await sessionFor(users.blocked)
  })
  after(async () => {
    await app?.close()
    await db?.stop()
  })

  it('сотрудник с cookie: status — включено, права и охват по базе; marks — значки с подсказками; карточка договора; без отметки защиты читать можно', async () => {
    const res = await get(W.editor, '/api/signal/status')
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.deepEqual([body.enabled, body.canView, body.canEdit, body.isAdmin], [true, true, true, false])
    assert.equal(body.confirmAvailable, true)
    assert.ok(!('sources' in body), 'корни — только администратору')
    assert.equal(res.headers['cache-control'], 'private, no-store')
    const marks = await get(W.editor, '/api/signal/marks')
    assert.equal(marks.statusCode, 200, marks.body)
    const byId = Object.fromEntries(marks.json().items.map((m) => [m.id, m]))
    assert.equal(byId[C.c2].state, 'verified')
    assert.match(byId[C.c2].tip, /^Signal: сверено · данные на \d{2}\.\d{2}\.\d{4} · Документы Альфа/)
    assert.equal(byId[C.c1].hasCandidate, true)
    const card = await get(W.editor, `/api/signal/contracts/${C.c1}`)
    assert.equal(card.statusCode, 200, card.body)
    assert.equal(card.json().candidates[0].nodeId, F.f1)
    // Чтение — безопасный метод: отметка защиты не нужна (но cookie обязательна).
    assert.equal((await call(W.editor, 'GET', '/api/signal/status', { csrf: false, origin: null })).statusCode, 200)
    // Просмотр без правки — те же маршруты, но без предложений.
    assert.deepEqual([(await get(W.viewer, '/api/signal/status')).json().canEdit, (await get(W.viewer, `/api/signal/contracts/${C.c1}`)).json().canEdit], [false, false])
  })

  it('POST /match: без отметки защиты — 403 OSP_CSRF, с чужим источником — 403, с отметкой и источником — 200; ничего не записано при отказе', async () => {
    const ids = { contractIds: [C.c1, C.c2] }
    const before = one(db, 'select max(updated_at) from osp_private.signal_contracts')
    const noMark = await call(W.editor, 'POST', '/api/signal/match', { payload: ids, csrf: false })
    assert.deepEqual([noMark.statusCode, noMark.json().code], [403, 'OSP_CSRF'])
    // Отметка есть, но от другой сессии.
    const stolen = await app.inject({ method: 'POST', url: '/api/signal/match', payload: ids, headers: {
      cookie: `${SESSION_COOKIE}=${W.editor.token}; ${CSRF_COOKIE}=${W.editor.csrf}`, 'x-osp-csrf': W.viewer.csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin' } })
    assert.deepEqual([stolen.statusCode, stolen.json().code], [403, 'OSP_CSRF'])
    // Отметка верна, запрос — с чужого сайта.
    for (const origin of ['https://evil.example.invalid', null]) {
      const res = await call(W.editor, 'POST', '/api/signal/match', { payload: ids, origin })
      assert.equal(res.statusCode, 403, String(origin))
    }
    const crossSite = await app.inject({ method: 'POST', url: '/api/signal/match', payload: ids, headers: {
      cookie: `${SESSION_COOKIE}=${W.editor.token}; ${CSRF_COOKIE}=${W.editor.csrf}`, 'x-osp-csrf': W.editor.csrf, origin: ORIGIN, 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.statusCode, 403)
    assert.equal(one(db, 'select max(updated_at) from osp_private.signal_contracts'), before, 'при отказе расчёт не начинался')
    const ok = await call(W.editor, 'POST', '/api/signal/match', { payload: ids })
    assert.equal(ok.statusCode, 200, ok.body)
    const items = Object.fromEntries(ok.json().items.map((i) => [i.id, i]))
    assert.deepEqual([items[C.c1].state, items[C.c1].nodeId, items[C.c2].state], ['suggested', F.f1, 'verified'])
    assert.equal(linkOf(C.c1), '', '/match ссылку не меняет')
  })

  it('решения человека по сессии: confirm без отметки — 403 и ничего не записано; с отметкой — 200, ссылка и «История» от имени вошедшего', async () => {
    const c = (await get(W.editor, `/api/signal/contracts/${C.c1}`)).json()
    const body = { nodeId: F.f1, replace: false, expectedSignalLink: c.signalLink, expectedStateVersion: c.stateVersion, expectedRevision: c.revision ?? 0, idempotencyKey: key() }
    const denied = await call(W.editor, 'POST', `/api/signal/contracts/${C.c1}/confirm`, { payload: body, csrf: false })
    assert.deepEqual([denied.statusCode, denied.json().code], [403, 'OSP_CSRF'])
    assert.equal(linkOf(C.c1), '')
    const res = await call(W.editor, 'POST', `/api/signal/contracts/${C.c1}/confirm`, { payload: body })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual([res.json().state, res.json().reason, res.json().signalLink, res.json().warning], ['verified', 'confirmed', s.urlOf(F.f1), null])
    assert.equal(linkOf(C.c1), s.urlOf(F.f1))
    assert.equal(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`), '1')
    assert.match(stateOf(C.c1), /^verified:confirmed:/)
    // Повтор того же ключа — тот же ответ; просмотр без правки решений не принимает даже с отметкой.
    assert.deepEqual((await call(W.editor, 'POST', `/api/signal/contracts/${C.c1}/confirm`, { payload: body })).json(), res.json())
    assert.equal((await call(W.viewer, 'POST', '/api/signal/match', { payload: { contractIds: [C.c2] } })).statusCode, 403)
  })

  it('администратор по сессии: корни и прогоны — да; мутации администратора без отметки — 403', async () => {
    const st = (await get(W.admin, '/api/signal/status')).json()
    assert.deepEqual([st.enabled, st.isAdmin, st.sources.length], [true, true, 2])
    assert.equal((await get(W.admin, '/api/signal/runs')).statusCode, 200)
    assert.equal((await get(W.admin, `/api/signal/tree?sourceId=${s.srcA.id}`)).statusCode, 200)
    const body = { sourceId: s.srcA.id, nodeId: F.k1, objectId: null }
    assert.equal((await call(W.admin, 'POST', '/api/signal/bindings', { payload: body, csrf: false })).statusCode, 403)
    assert.equal((await call(W.admin, 'POST', '/api/signal/bindings', { payload: body })).statusCode, 200)
    // Сотрудник — маршруты администратора закрыты и с отметкой.
    for (const [method, url, payload] of [['GET', '/api/signal/runs'], ['GET', `/api/signal/tree?sourceId=${s.srcA.id}`], ['POST', '/api/signal/bindings', body], ['POST', '/api/signal/sync', {}]]) {
      assert.equal((await call(W.editor, method, url, { payload })).statusCode, 403, `${method} ${url}`)
    }
  })

  it('подрядчик с сессией, учётка без права «Договоры», заблокированный и запрос без cookie — отказ, чужих имён в ответах нет', async () => {
    const calls = [['GET', '/api/signal/status'], ['GET', '/api/signal/marks'], ['GET', `/api/signal/contracts/${C.c1}`], ['GET', `/api/signal/folders?contractId=${C.c1}`],
      ['POST', '/api/signal/match', { contractIds: [C.c1] }], ['GET', '/api/signal/aliases'],
      ['POST', `/api/signal/contracts/${C.c1}/reject`, { nodeId: F.f1, expectedStateVersion: 1, idempotencyKey: key() }]]
    for (const [method, url, payload] of calls) {
      const res = await call(W.contractor, method, url, { payload })
      assert.equal(res.statusCode, 403, `подрядчик ${method} ${url}: ${res.body}`)
      assert.ok(!/Альфа|Корпус|Ромашка/.test(res.body))
    }
    // Без права на «Договоры»: сервер пускает сотрудника, база отвечает «выключено» / 403.
    assert.deepEqual((await get(W.noRight, '/api/signal/status')).json(), { enabled: false })
    for (const [method, url, payload] of calls.slice(1, 5)) assert.equal((await call(W.noRight, method, url, { payload })).statusCode, 403, `без права ${method} ${url}`)
    // Заблокированный: сессия не действует.
    for (const [method, url, payload] of calls.slice(0, 5)) assert.ok([401, 403].includes((await call(W.blocked, method, url, { payload })).statusCode), `заблокированный ${method} ${url}`)
    // Без cookie — 401; с чужим значением cookie — 401.
    for (const [method, url, payload] of calls) assert.equal((await call(null, method, url, { payload })).statusCode, 401, `без cookie ${method} ${url}`)
    const fake = { token: crypto.randomBytes(32).toString('base64url'), csrf: W.editor.csrf }
    assert.equal((await get(fake, '/api/signal/status')).statusCode, 401)
  })

  it('режим сессии отклоняет токен Supabase (одна схема входа за раз): Bearer — 401 OSP_AUTH_MODE, данных нет', async () => {
    const res = await call(null, 'GET', '/api/signal/status', { bearer: userToken(SUPABASE_URL, s.users.editor) })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().code, 'OSP_AUTH_MODE')
    assert.ok(!/Альфа/.test(res.body))
    const post = await call(null, 'POST', '/api/signal/match', { payload: { contractIds: [C.c1] }, bearer: userToken(SUPABASE_URL, s.users.editor) })
    assert.equal(post.statusCode, 401)
  })
})
