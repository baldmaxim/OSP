// Организация учётки СУ-10 → контрагент ОСП (server/osp-api/src/lib/auth/orgs.js, orgAdmin.js; миграция
// migration/yandex/20270201_su10_org_links.sql) на настоящем PostgreSQL, Keycloak — в памяти (tests/osp-api/lib/fake-keycloak.mjs).
// Проверяем гарантии плана (ред. 2) — каждая механизмом:
//   • реестр: страницы по 100, без id — пропуск, повтор id и негодные атрибуты — ошибка, неполное чтение и сбой — кэш прежний,
//     предохранитель (пустой реестр, массовое выбывание) и --force, троттлинг;
//   • сотрудник входит только со своей организацией; иначе отказ и закрытие всех сессий; исключение суперадминистратора — для
//     той же организации; две организации исключением не покрываются;
//   • подрядчик: связь → свой контрагент; другая организация → новый контрагент, прежние сессии закрыты; без связи, своя, пустой
//     claim → отказ, контрагент прежний и не NULL;
//   • перепроверка: смена → 401 OSP_ORG_CHANGED, отказ → 403 и все сессии закрыты;
//   • сразу: отвязка, чёрный список, удаление, смена контрагента и роли, выбывание из реестра; правка мимо сервера — 42501;
//   • гонка «вход ↔ отвязка»: живой сессии без связи не остаётся;
//   • «Создать пользователя»: контрагент только из связи; админка и права маршрутов; режим own; готовность keycloak.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { SECRET, projectKey } from './lib/tokens.mjs'
import { createFakeKeycloak, orgGroup, userGroupsOf } from './lib/fake-keycloak.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const MIGRATIONS = ['20261019_own_auth.sql', '20270112_keycloak_identity.sql', '20270201_su10_org_links.sql']
  .map((f) => path.join(ROOT, 'migration', 'yandex', f))
const depsOk = ['openid-client', 'jose', 'pg', 'fastify'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'org-test-db-password'
const GATEWAY_SECRET = 'org-test-gateway-secret-0123456789-abcdefghij'
const ORIGIN = 'https://tender.test'
const ISSUER = 'https://auth.test/realms/su10'
const CLIENT_SECRET = 'org-client-secret-NEVER-IN-LOGS'
const ADMIN_SECRET = 'org-admin-secret-NEVER-IN-LOGS'
const KEYS = `t1:${crypto.randomBytes(32).toString('base64')}`
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Организации реестра СУ-10.
const OWN = 'f0000000-0000-4000-8000-000000000001'
const ORG_A = 'f0000000-0000-4000-8000-00000000000a'
const ORG_B = 'f0000000-0000-4000-8000-00000000000b'
const ORG_C = 'f0000000-0000-4000-8000-00000000000c'
const ORG_SM = 'f0000000-0000-4000-8000-0000000000aa' // своя, появится в реестре позже
const DUP = 'f0000000-0000-4000-8000-0000000000dd'
const BADK = 'f0000000-0000-4000-8000-0000000000bb'
const INN_A = '7707083893'
const INN_C = '9909202642'
const G = {
  own: orgGroup({ id: OWN, kind: 'own', name: 'СУ-10' }),
  a: orgGroup({ id: ORG_A, name: 'Альфа ООО', inn: INN_A }),
  b: orgGroup({ id: ORG_B, name: 'Бета ООО' }),
  c: orgGroup({ id: ORG_C, name: 'Гамма ООО', inn: INN_C, nested: 2 }),
  sm: orgGroup({ id: ORG_SM, kind: 'own', name: 'СМ' }),
}
const BASE_GROUPS = [G.own, G.a, G.b, G.c]

// Контрагенты ОСП.
const CP = {
  a: { id: 'c0000000-0000-4000-8000-00000000000a', name: 'ООО «Альфа»', inn: INN_A },
  b: { id: 'c0000000-0000-4000-8000-00000000000b', name: 'ООО «Бета»', inn: null },
  c: { id: 'c0000000-0000-4000-8000-00000000000c', name: 'ООО «Гамма»', inn: INN_C },
  bl: { id: 'c0000000-0000-4000-8000-0000000000b1', name: 'ООО «Чёрный»', inn: null, status: 'blacklist' },
}

// Учётки портала и учётки СУ-10.
const U = {
  emp: { id: '11111111-1111-4111-8111-111111111111', email: 'emp@su10.ru', role: 'engineer' },
  admin: { id: '22222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', role: 'admin' },
  boss: { id: '33333333-3333-4333-8333-333333333333', email: 'boss@su10.ru', role: 'engineer' },
  con: { id: '44444444-4444-4444-8444-444444444444', email: 'con@alfa.ru', role: 'contractor', cp: CP.a.id },
}
const KC = {
  emp: { sub: 'a1111111-1111-4111-8111-111111111111', email: 'emp@su10.ru', given: 'Иван', family: 'Иванов', org: [OWN] },
  admin: { sub: 'a2222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', given: 'Анна', family: 'Админова', org: [OWN] },
  boss: { sub: 'a3333333-3333-4333-8333-333333333333', email: 'boss@su10.ru', given: 'Борис', family: 'Главный', org: [OWN] },
  con: { sub: 'a4444444-4444-4444-8444-444444444444', email: 'con@alfa.ru', given: 'Пётр', family: 'Подрядов', org: [ORG_A] },
}

const policy = (table) => `alter table ${table} enable row level security; alter table ${table} force row level security;
create policy osp_internal on ${table} for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));`

const SETUP_SQL = (dbPassword) => `
create role api_login login password '${dbPassword}';
grant create, connect on database psdc_test to api_login;
grant create on schema public to api_login;
set role api_login;
${fs.readFileSync(path.join(ROOT, 'migration', 'target', 'compat', 'auth.sql'), 'utf8')}
create schema osp_private;
create function osp_private.bypass() returns boolean language sql stable
  as $$ select coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' or coalesce(auth.role(), '') = 'service_role' $$;
create table auth.users (id uuid primary key, aud text, role text, email text, email_confirmed_at timestamptz,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz, raw_user_meta_data jsonb);
${policy('auth.users')}
create table public.counterparties (id uuid primary key default gen_random_uuid(), counterparty_number int generated always as identity,
  name text not null, inn text, status text not null default 'active', deleted_at timestamptz);
${policy('public.counterparties')}
create table public.counterparty_contacts (id uuid primary key default gen_random_uuid(), counterparty_id uuid references public.counterparties(id), email text);
${policy('public.counterparty_contacts')}
create table public.contracts (id uuid primary key default gen_random_uuid(), counterparty_id uuid);
${policy('public.contracts')}
create table public.contract_counterparties (contract_id uuid, counterparty_id uuid);
${policy('public.contract_counterparties')}
create table public.tender_counterparties (tender_id uuid, counterparty_id uuid);
${policy('public.tender_counterparties')}
create table public.counterparty_relations (counterparty_id uuid, related_counterparty_id uuid);
${policy('public.counterparty_relations')}
create table public.counterparty_audit_log (id uuid primary key default gen_random_uuid(), counterparty_id uuid, event_type text,
  description text, changed_by_role text, changed_by_name text, changed_at timestamptz default now());
${policy('public.counterparty_audit_log')}
create table public.roles (key text primary key, label text);
insert into public.roles values ('admin', 'Администратор'), ('engineer', 'Инженер'), ('contractor', 'Подрядчик');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, email text, full_name text, work_phone text, requested_company text,
  counterparty_id uuid references public.counterparties(id) on delete set null, object_ids uuid[] not null default '{}', last_login_at timestamptz,
  is_blocked boolean not null default false, self_registered boolean not null default false,
  constraint user_roles_blocked_not_approved check (not (is_blocked and is_approved)));
${policy('public.user_roles')}
-- «Шлюз данных»: запись без пропуска служебных функций (как запрос администратора через PostgREST).
create policy test_gateway on public.user_roles for all to public
  using (current_setting('application_name', true) = 'gateway-test') with check (current_setting('application_name', true) = 'gateway-test');
create table public.superadmins (user_id uuid primary key);
${policy('public.superadmins')}
${MIGRATIONS.map((f) => fs.readFileSync(f, 'utf8')).join('\n')}
`

describe('организации СУ-10 → контрагент: вход, перепроверка, админка (настоящая база)', { skip, timeout: 600000 }, () => {
  let pgdb
  let dbUrl
  let buildApp
  let defaultDeps
  let blocklist
  let jose
  let kc
  let upstream
  let app
  let logs
  let createKcAdmin

  const sql = (text) => pgdb.exec(`set role api_login;\n${text}`)
  const one = (text) => sql(text).trim().split('\n').filter(Boolean).at(-1) ?? ''
  const asMark = (mark, text) => one(`set application_name = '${mark}';\n${text}`)
  const internal = (text) => asMark('osp:internal', text)
  const authSql = (text) => asMark('osp:auth', text)

  const config = (over = {}) => {
    const base = {
      host: '127.0.0.1', port: 0,
      supabaseUrl: 'https://testproject.supabase.co', supabaseAnonKey: projectKey('anon'), supabaseServiceKey: '', supabaseJwtSecret: SECRET,
      s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' },
      anthropicApiKey: '', ratesApiKeys: [], required: ['db', 'gateway', 'auth'],
      db: { url: dbUrl, caFile: '', poolMax: 8, secondLockRole: '' },
      dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: 'api_login', readOnlyFile: '' },
      authMode: 'keycloak',
      auth: { keys: KEYS, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
      oidc: {
        issuer: ISSUER, clientId: 'osp', clientSecret: CLIENT_SECRET, redirectUri: `${ORIGIN}/api/auth/oidc/callback`,
        postLogoutRedirectUri: `${ORIGIN}/login`, scopes: 'openid email profile', linkByEmail: false,
        recheckSec: 300, activityWindowSec: 1800, maxOfflineSec: 3600,
        admin: { clientId: 'osp-access-sync', clientSecret: ADMIN_SECRET, group: 'osp-access', syncIntervalSec: 300 },
      },
      userStatusTtlMs: 0, authCleanup: false, accessSyncTimer: false,
    }
    return { ...base, ...over, oidc: over.oidc === null ? {} : { ...base.oidc, ...(over.oidc || {}) } }
  }

  async function makeApp(over = {}) {
    await app?.close()
    logs = []
    app = buildApp({
      config: config(over),
      deps: { ...defaultDeps, blocklist, oidcFetch: kc.fetch, recheckOptions: { waitMs: 3000, pollMs: 50 },
        orgsOptions: { throttleMs: 200, unknownWaitMs: 3000 } },
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } },
    })
    await app.ready()
    return app
  }

  const cookiesOf = (res) => {
    const raw = [].concat(res.headers['set-cookie'] || [])
    const get = (name) => raw.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') ?? null
    return { session: get('__Host-osp_session'), csrf: get('__Host-osp_csrf') }
  }
  const sessionHeaders = (c, { unsafe = false, activity = false } = {}) => ({
    cookie: `__Host-osp_session=${c.session}; __Host-osp_csrf=${c.csrf}`,
    ...(unsafe ? { 'x-osp-csrf': c.csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
    ...(activity ? { 'x-osp-activity': c.csrf } : {}),
  })
  async function loginAs(user) {
    const res0 = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnUrl=%2Ftenders', headers: NAV })
    assert.equal(res0.statusCode, 302, res0.body)
    const loc = new URL(res0.headers.location)
    const cookie = [].concat(res0.headers['set-cookie']).find((c) => c.startsWith('__Host-osp_oidc_') && !/Max-Age=0/.test(c)).split(';')[0]
    const code = crypto.randomBytes(16).toString('hex')
    kc.codes.set(code, { user, nonce: loc.searchParams.get('nonce'), challenge: loc.searchParams.get('code_challenge'), redirectUri: loc.searchParams.get('redirect_uri') })
    const query = `code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}&session_state=ss&iss=${encodeURIComponent(ISSUER)}`
    const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?${query}`, headers: { ...NAV, cookie } })
    return { res, location: res.headers.location, c: cookiesOf(res) }
  }
  const me = (c, opts) => app.inject({ method: 'GET', url: '/api/auth/me', headers: sessionHeaders(c, opts) })
  const ageCheck = (c) => internal(`update osp_session.sessions set kc_checked_at = date_trunc('milliseconds', now() - interval '10 minutes')
    where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
  const liveSessions = (user) => Number(internal(`select count(*) from osp_session.sessions where user_id = '${user.id}' and revoked_at is null`))
  const cpOf = (user) => internal(`select coalesce(counterparty_id::text, 'NULL') || '|' || coalesce(counterparty_source, '-') from public.user_roles where user_id = '${user.id}'`)
  const events = (kind) => Number(authSql(`select count(*) from osp_auth.events where kind = '${kind}'`))
  const linkSql = (org, cp) => authSql(`insert into osp_auth.org_links (issuer, su10_org_id, counterparty_id, source, match, linked_by)
    values ('${ISSUER}', '${org}', '${cp}', 'admin', 'admin', '${U.admin.id}') on conflict do nothing`)
  const adminCall = async (who, method, url, payload) => {
    const c = who.c || who
    return app.inject({ method, url, headers: sessionHeaders(c, { unsafe: method !== 'GET' }), ...(method !== 'GET' ? { payload: payload ?? {} } : {}) })
  }
  const setOrg = (kcUser, claim) => { if (claim === undefined) kc.orgOf.set(kcUser.sub, undefined); else kc.orgOf.set(kcUser.sub, claim) }
  const resetOrg = (kcUser) => kc.orgOf.delete(kcUser.sub)
  const resetCon = () => internal(`update public.user_roles set counterparty_id = '${CP.a.id}', counterparty_source = 'su10', role = 'contractor' where user_id = '${U.con.id}'`)

  before(async () => {
    ({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ createKcAdmin } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'kcAdmin.js')))
    const { loadBlocklist } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'policy.js'))
    const { createSecretBox } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'secretBox.js'))
    jose = await import(path.join(SERVER, 'node_modules', 'jose', 'dist', 'webapi', 'index.js'))
    blocklist = loadBlocklist()
    kc = await createFakeKeycloak(jose, { issuer: ISSUER, clientSecret: CLIENT_SECRET, adminSecret: ADMIN_SECRET })
    kc.orgGroups = [...BASE_GROUPS]

    upstream = { server: http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') }) }) }
    await new Promise((r) => upstream.server.listen(0, '127.0.0.1', r))
    upstream.url = `http://127.0.0.1:${upstream.server.address().port}`

    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL(DB_PASSWORD))
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`
    const cps = Object.values(CP).map((c) => `('${c.id}', '${c.name.replace(/'/g, "''")}', ${c.inn ? `'${c.inn}'` : 'null'}, '${c.status || 'active'}')`).join(',')
    const users = Object.values(U).map((u) => `('${u.id}', 'authenticated', 'authenticated', '${u.email}', now(), now(), now(), '{}')`).join(',')
    const roles = Object.values(U).map((u) => `('${u.id}', '${u.role}', true, '${u.email}', ${u.cp ? `'${u.cp}'` : 'null'})`).join(',')
    internal(`insert into public.counterparties (id, name, inn, status) values ${cps};
      insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data) values ${users};
      insert into public.user_roles (user_id, role, is_approved, email, counterparty_id) values ${roles};
      insert into public.superadmins values ('${U.boss.id}');
      select 1`)
    const box = createSecretBox(KEYS)
    authSql(`insert into osp_auth.meta (key, value) values ('canary', '${box.encrypt('osp-auth-canary', 'osp-auth-canary')}')`)
    for (const k of ['emp', 'admin', 'boss', 'con']) {
      authSql(`insert into osp_auth.identity_links (issuer, subject, user_id, source) values ('${ISSUER}', '${KC[k].sub}', '${U[k].id}', 'link_file')`)
    }
    await makeApp()
    await app.orgs.refreshRegistry({ force: true })
    linkSql(ORG_A, CP.a.id)
    linkSql(ORG_B, CP.b.id)
  })

  after(async () => {
    await app?.close()
    upstream?.server.close()
    pgdb?.stop()
  })

  it('миграция: прежние строки user_roles без отметки; запрет правки мимо сервера и проверка — на месте', () => {
    assert.equal(internal(`select count(*) from public.user_roles where counterparty_source is not null`), '0')
    assert.equal(authSql(`select count(*) from pg_policies where schemaname = 'osp_auth' and tablename in ('su10_orgs','org_links','subject_orgs','org_exceptions')`), '4')
    const out = sql(`set application_name = 'osp:internal';\n${fs.readFileSync(path.join(ROOT, 'migration', 'yandex', '20270201_su10_org_links.check.sql'), 'utf8')}`)
    assert.ok(!/^FAIL/m.test(out), out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 10, out)
  })

  it('реестр: страницы по 100; без id — пропуск; повтор id и негодные атрибуты — ошибка; троттлинг; сбой и неполное чтение — кэш прежний; предохранитель', async () => {
    const filler = Array.from({ length: 150 }, (_, i) => orgGroup({ id: crypto.randomUUID(), name: `Наполнитель ${i}` }))
    const dupA = orgGroup({ id: DUP, name: 'Двойник 1' })
    const dupB = orgGroup({ id: DUP, name: 'Двойник 2' })
    const badKind = orgGroup({ id: BADK, name: 'Странный', attrs: { su10_org_id: [BADK], su10_org_kind: ['partner'], org_name: ['Странный'] } })
    const noId = orgGroup({ id: 'x', name: '(организация не определена)', attrs: {} })
    kc.orgGroups = [...BASE_GROUPS, ...filler, dupA, dupB, badKind, noId]
    kc.calls.children = 0
    const r = await app.orgs.refreshRegistry({ force: true })
    assert.equal(kc.calls.children, 2, 'две страницы по 100')
    assert.equal(r.orgs, 4 + 150 + 2)
    assert.equal(r.skipped.noId, 1)
    assert.equal(r.skipped.nested, 2)
    assert.equal(authSql(`select state || '|' || invalid_reason from osp_auth.su10_orgs where su10_org_id = '${DUP}'`), 'invalid|duplicate_id')
    assert.equal(authSql(`select state || '|' || invalid_reason from osp_auth.su10_orgs where su10_org_id = '${BADK}'`), 'invalid|attributes')
    // Троттлинг: частый вызов — прошлый итог без похода в Keycloak.
    const cached = await app.orgs.refreshRegistry({ throttle: true })
    assert.equal(cached.cached, true)
    assert.equal(kc.calls.children, 2)
    // Сбой второй страницы — кэш прежний, ошибка запомнена.
    await sleep(250)
    const before = authSql(`select string_agg(su10_org_id || state, ',' order by su10_org_id) from osp_auth.su10_orgs`)
    kc.failChildrenPage = 1
    await assert.rejects(() => app.orgs.refreshRegistry({ force: true }))
    kc.failChildrenPage = null
    assert.equal(authSql(`select string_agg(su10_org_id || state, ',' order by su10_org_id) from osp_auth.su10_orgs`), before)
    assert.match(authSql(`select value from osp_auth.meta where key = 'su10_org_registry'`), /"error":"http"/)
    // 403 на реестр — тоже без изменений.
    kc.forbid.add('children')
    await assert.rejects(() => app.orgs.refreshRegistry({ force: true }))
    kc.forbid.delete('children')
    // Массовое выбывание (150 из 156) — предохранитель, ничего не меняется; --force — принять.
    kc.orgGroups = [...BASE_GROUPS]
    const held = await app.orgs.refreshRegistry()
    assert.equal(held.held, true)
    assert.ok(held.reasons.includes('drop'))
    assert.equal(authSql(`select count(*) from osp_auth.su10_orgs where state = 'active'`), String(4 + 150))
    const forced = await app.orgs.refreshRegistry({ force: true })
    assert.equal(forced.held, false)
    assert.equal(authSql(`select count(*) from osp_auth.su10_orgs where state = 'active'`), '4')
    assert.equal(authSql(`select count(*) from osp_auth.su10_orgs where state = 'missing'`), '152')
    // Пустой реестр после непустого — предохранитель.
    kc.orgGroups = []
    const empty = await app.orgs.refreshRegistry({ force: false })
    assert.equal(empty.held, true)
    assert.ok(empty.reasons.includes('empty'))
    kc.orgGroups = [...BASE_GROUPS]
    await app.orgs.refreshRegistry({ force: true })
  })

  it('сотрудник: своя организация — вход; пустой claim, подрядчик, две, неизвестная — отказ и закрытие сессий; исключение суперадминистратора', async () => {
    const first = await loginAs(KC.emp)
    assert.equal(first.location, `${ORIGIN}/tenders`)
    assert.equal((await me(first.c)).statusCode, 200)
    const denied = events('org.denied')
    for (const claim of [[], [ORG_A], [OWN, ORG_A]]) {
      setOrg(KC.emp, claim)
      const r = await loginAs(KC.emp)
      assert.equal(r.location, '/login?sso_error=org_denied', JSON.stringify(claim))
      assert.equal(r.c.session, null, 'сессии нет')
    }
    assert.equal(liveSessions(U.emp), 0, 'прежняя сессия закрыта при первом отказе')
    assert.equal(events('org.denied'), denied + 3)
    // Исключение — только суперадминистратор; для той же организации.
    setOrg(KC.emp, [ORG_A])
    await loginAs(KC.emp)
    const admin = (await loginAs(KC.admin)).c
    const boss = (await loginAs(KC.boss)).c
    const no = await adminCall(admin, 'POST', '/api/admin/su10-org-exceptions', { subject: KC.emp.sub, reason: 'Совместитель' })
    assert.equal(no.statusCode, 403)
    const yes = await adminCall(boss, 'POST', '/api/admin/su10-org-exceptions', { subject: KC.emp.sub, reason: 'Совместитель' })
    assert.equal(yes.statusCode, 200, yes.body)
    assert.equal(yes.json().orgId, ORG_A)
    const ok = await loginAs(KC.emp)
    assert.equal(ok.location, `${ORIGIN}/tenders`, 'с исключением — вход')
    setOrg(KC.emp, [ORG_C])
    assert.equal((await loginAs(KC.emp)).location, '/login?sso_error=org_denied', 'другая организация — исключение не действует')
    setOrg(KC.emp, [ORG_A, OWN])
    assert.equal((await loginAs(KC.emp)).location, '/login?sso_error=org_denied', 'две организации — исключение не покрывает')
    // Неизвестная организация: перечитывание реестра; появилась своя — вход.
    setOrg(KC.emp, [ORG_SM])
    await sleep(250)
    kc.orgGroups = [...BASE_GROUPS, G.sm]
    kc.calls.children = 0
    assert.equal((await loginAs(KC.emp)).location, `${ORIGIN}/tenders`)
    assert.ok(kc.calls.children >= 1, 'реестр перечитан')
    // Снятие исключения — событие.
    const del = await adminCall(boss, 'DELETE', `/api/admin/su10-org-exceptions/${KC.emp.sub}`)
    assert.equal(del.statusCode, 200, del.body)
    assert.equal(events('org.exception.remove'), 1)
    resetOrg(KC.emp)
  })

  it('подрядчик: связь — свой контрагент; другая организация — новый контрагент и закрытие прежних сессий; без связи, своя, без claim — отказ, контрагент прежний', async () => {
    resetCon()
    internal(`update public.user_roles set counterparty_source = null where user_id = '${U.con.id}'`)
    const c1 = (await loginAs(KC.con)).c
    assert.equal(cpOf(U.con), `${CP.a.id}|su10`, 'отметка «поставил сервер» появилась, контрагент тот же')
    const c2 = (await loginAs(KC.con)).c
    assert.equal(liveSessions(U.con), 2)
    setOrg(KC.con, [ORG_B])
    const changes = events('org.change')
    const moved = await loginAs(KC.con)
    assert.equal(moved.location, `${ORIGIN}/tenders`)
    assert.equal(cpOf(U.con), `${CP.b.id}|su10`)
    assert.equal(events('org.change'), changes + 1)
    assert.equal((await me(c1)).statusCode, 401)
    assert.equal((await me(c2)).statusCode, 401)
    assert.equal((await me(moved.c)).statusCode, 200, 'новая сессия — уже с новым контрагентом')
    for (const claim of [[ORG_C], [OWN], undefined, [ORG_A, ORG_B]]) {
      setOrg(KC.con, claim)
      const r = await loginAs(KC.con)
      assert.equal(r.location, '/login?sso_error=org_unmapped', JSON.stringify(claim))
      assert.equal(cpOf(U.con), `${CP.b.id}|su10`, 'контрагент прежний и не NULL')
    }
    assert.equal(liveSessions(U.con), 0, 'отказ закрыл и действующую сессию')
    resetOrg(KC.con)
    resetCon()
  })

  it('перепроверка: смена организации — 401 OSP_ORG_CHANGED; без связи — 403, закрыты все сессии; сотрудник не в своей — 403', async () => {
    resetCon()
    const c = (await loginAs(KC.con)).c
    setOrg(KC.con, [ORG_B])
    ageCheck(c)
    const r1 = await me(c, { activity: true })
    assert.equal(r1.statusCode, 401)
    assert.equal(r1.json().code, 'OSP_ORG_CHANGED')
    assert.equal(cpOf(U.con), `${CP.b.id}|su10`)
    const d1 = (await loginAs(KC.con)).c
    const d2 = (await loginAs(KC.con)).c
    setOrg(KC.con, [ORG_C])
    ageCheck(d1)
    const r2 = await me(d1, { activity: true })
    assert.equal(r2.statusCode, 403)
    assert.equal(r2.json().code, 'OSP_ORG_UNMAPPED')
    assert.equal((await me(d2)).statusCode, 401, 'закрыты все сессии пользователя')
    resetOrg(KC.con)
    resetCon()
    const e = (await loginAs(KC.emp)).c
    setOrg(KC.emp, [ORG_A])
    ageCheck(e)
    const r3 = await me(e, { activity: true })
    assert.equal(r3.statusCode, 403)
    assert.equal(r3.json().code, 'OSP_ORG_DENIED')
    resetOrg(KC.emp)
  })

  it('сразу: отвязка, чёрный список, удаление, смена контрагента и роли, выбывание из реестра; правка мимо сервера — 42501', async () => {
    resetCon()
    const admin = (await loginAs(KC.admin)).c
    let c = (await loginAs(KC.con)).c
    // Отвязка администратором.
    const un = await adminCall(admin, 'DELETE', `/api/admin/su10-orgs/${ORG_A}/link`)
    assert.equal(un.statusCode, 200, un.body)
    assert.ok(un.json().revoked >= 1)
    assert.equal((await me(c)).statusCode, 401, 'сессия закрыта сразу')
    assert.equal((await loginAs(KC.con)).location, '/login?sso_error=org_unmapped')
    const re = await adminCall(admin, 'POST', `/api/admin/su10-orgs/${ORG_A}/link`, { counterpartyId: CP.a.id })
    assert.equal(re.statusCode, 200, re.body)
    // Чёрный список и удаление контрагента — триггер базы.
    for (const [bad, good] of [[`status = 'blacklist'`, `status = 'active'`], ['deleted_at = now()', 'deleted_at = null']]) {
      c = (await loginAs(KC.con)).c
      assert.equal((await me(c)).statusCode, 200)
      internal(`update public.counterparties set ${bad} where id = '${CP.a.id}'`)
      assert.equal(liveSessions(U.con), 0, bad)
      assert.equal((await loginAs(KC.con)).location, '/login?sso_error=org_unmapped', bad)
      internal(`update public.counterparties set ${good} where id = '${CP.a.id}'`)
    }
    // Мимо сервера (шлюз): поставить отметку или сменить контрагента учётки СУ-10 — отказ базы.
    c = (await loginAs(KC.con)).c
    assert.throws(() => asMark('gateway-test', `update public.user_roles set counterparty_id = '${CP.b.id}' where user_id = '${U.con.id}'`), /42501|задаёт организация/)
    assert.throws(() => asMark('gateway-test', `update public.user_roles set counterparty_source = null where user_id = '${U.con.id}'`), /42501|задаёт организация/)
    assert.throws(() => asMark('gateway-test', `update public.user_roles set counterparty_source = 'su10' where user_id = '${U.emp.id}'`), /42501|задаёт организация/)
    assert.equal((await me(c)).statusCode, 200, 'отказ ничего не изменил')
    // Смена контрагента любым путём — сессии закрыты (триггер).
    internal(`update public.user_roles set counterparty_id = '${CP.b.id}' where user_id = '${U.con.id}'`)
    assert.equal(liveSessions(U.con), 0)
    resetCon()
    c = (await loginAs(KC.con)).c
    internal(`update public.user_roles set role = 'engineer' where user_id = '${U.con.id}'`)
    assert.equal(liveSessions(U.con), 0, 'смена роли «подрядчик» — сессии закрыты')
    resetCon()
    // Связанного контрагента удалить нельзя.
    assert.throws(() => internal(`delete from public.counterparties where id = '${CP.a.id}'`))
    // Выбывание организации из реестра — сессии её подрядчиков закрыты в той же транзакции.
    c = (await loginAs(KC.con)).c
    kc.orgGroups = [G.own, G.b, G.c]
    await sleep(250)
    const r = await app.orgs.refreshRegistry({ force: true })
    assert.equal(r.losing, 1)
    assert.equal(liveSessions(U.con), 0)
    assert.equal((await loginAs(KC.con)).location, '/login?sso_error=org_unmapped')
    kc.orgGroups = [...BASE_GROUPS]
    await sleep(250)
    await app.orgs.refreshRegistry({ force: true })
    assert.equal((await loginAs(KC.con)).location, `${ORIGIN}/tenders`)
  })

  it('гонка: отвязка параллельно со входом — живой сессии без связи не остаётся', async () => {
    resetCon()
    const admin = (await loginAs(KC.admin)).c
    for (let i = 0; i < 6; i++) {
      linkSql(ORG_A, CP.a.id)
      await Promise.all([loginAs(KC.con), adminCall(admin, 'DELETE', `/api/admin/su10-orgs/${ORG_A}/link`)])
      assert.equal(authSql(`select count(*) from osp_auth.org_links where su10_org_id = '${ORG_A}'`), '0')
      assert.equal(liveSessions(U.con), 0, `попытка ${i + 1}`)
    }
    linkSql(ORG_A, CP.a.id)
  })

  it('«Создать пользователя»: подрядчику — контрагент из связи; без связи — 409; сотрудник не в своей — 409; СУ-10 не ответил — 503', async () => {
    const boss = (await loginAs(KC.boss)).c
    const make = (groups) => {
      const s = crypto.randomUUID()
      if (groups) kc.userGroups.set(s, groups)
      const id = authSql(`insert into osp_auth.identity_requests (issuer, subject, email, full_name, origin)
        values ('${ISSUER}', '${s}', 'n${s.slice(0, 8)}@x.ru', 'Новый', 'kc_sync') returning id`)
      return id
    }
    const create = (id, body) => adminCall(boss, 'POST', `/api/admin/identity-requests/${id}/create-user`, body)
    const r1 = await create(make(userGroupsOf(G.a)), { role: 'contractor', counterpartyId: CP.b.id })
    assert.equal(r1.statusCode, 200, r1.body)
    assert.equal(cpOf({ id: r1.json().user.id }), `${CP.a.id}|su10`, 'контрагент — из связи, присланный не берётся')
    const r2 = await create(make(userGroupsOf(G.c)), { role: 'contractor', counterpartyId: CP.c.id })
    assert.equal(r2.statusCode, 409)
    assert.equal(r2.json().code, 'org_unmapped')
    assert.equal(r2.json().orgId, ORG_C)
    const r3 = await create(make(userGroupsOf(G.a)), { role: 'engineer' })
    assert.equal(r3.statusCode, 409)
    assert.equal(r3.json().code, 'org_not_own')
    const r4 = await create(make(userGroupsOf(G.own)), { role: 'engineer', counterpartyId: CP.a.id })
    assert.equal(r4.statusCode, 200, r4.body)
    assert.equal(cpOf({ id: r4.json().user.id }), 'NULL|-', 'сотруднику контрагент не ставится')
    kc.forbid.add('user_groups')
    const r5 = await create(make(null), { role: 'contractor' })
    kc.forbid.delete('user_groups')
    assert.equal(r5.statusCode, 503)
    assert.equal(r5.json().code, 'org_lookup_failed')
    // В списке заявок — организация человека и её связь.
    const list = await adminCall(boss, 'GET', '/api/admin/identity-requests?status=pending')
    assert.equal(list.json().orgsEnabled, true)
    const withOrg = list.json().requests.find((q) => q.org?.org?.id === ORG_C)
    assert.equal(withOrg.org.result, 'unmapped')
  })

  it('админка: список, подсказки, связать (ошибки), создать контрагента, отвязать, карточка; не-администратор — 403', async () => {
    const admin = (await loginAs(KC.admin)).c
    const emp = (await loginAs(KC.emp)).c
    assert.equal((await adminCall(emp, 'GET', '/api/admin/su10-orgs')).statusCode, 403)
    const list = await adminCall(admin, 'GET', '/api/admin/su10-orgs')
    assert.equal(list.statusCode, 200, list.body)
    const a = list.json().orgs.find((o) => o.id === ORG_A)
    assert.equal(a.counterparty.id, CP.a.id)
    assert.equal(a.usable, true)
    assert.ok(list.json().registry.generation > 0)
    // Подсказка по ИНН реестра — уверенная (ИНН с верной суммой, один живой контрагент).
    const cand = await adminCall(admin, 'GET', `/api/admin/su10-orgs/${ORG_C}/candidates`)
    assert.equal(cand.statusCode, 200, cand.body)
    assert.equal(cand.json().candidates[0].counterparty.id, CP.c.id)
    assert.equal(cand.json().candidates[0].confident, true)
    const search = await adminCall(admin, 'GET', `/api/admin/su10-orgs/${ORG_C}/candidates?q=${encodeURIComponent('гамма')}`)
    assert.deepEqual(search.json().candidates.map((x) => x.counterparty.id), [CP.c.id])
    // Ошибки связи.
    const tries = [
      [ORG_C, CP.bl.id, 'counterparty_blacklisted'], [ORG_C, CP.a.id, 'counterparty_linked'], [OWN, CP.c.id, 'org_own'],
      [DUP, CP.c.id, 'org_inactive'], [ORG_A, CP.c.id, 'org_linked'],
    ]
    for (const [org, cp, code] of tries) {
      const r = await adminCall(admin, 'POST', `/api/admin/su10-orgs/${org}/link`, { counterpartyId: cp })
      assert.equal(r.json().code, code, `${org} → ${cp}`)
    }
    // Создать контрагента: ИНН уже есть — отказ; новый — контрагент, журнал контрагента, связь, событие.
    const taken = await adminCall(admin, 'POST', `/api/admin/su10-orgs/${ORG_C}/create-counterparty`, { inn: INN_C })
    assert.equal(taken.json().code, 'inn_taken')
    assert.equal(taken.json().counterpartyId, CP.c.id)
    const created = await adminCall(admin, 'POST', `/api/admin/su10-orgs/${ORG_C}/create-counterparty`, { name: 'ООО «Гамма-2»', inn: '' })
    assert.equal(created.statusCode, 200, created.body)
    const newId = created.json().counterparty.id
    assert.equal(internal(`select count(*) from public.counterparty_audit_log where counterparty_id = '${newId}' and event_type = 'created'`), '1')
    assert.equal(authSql(`select counterparty_id from osp_auth.org_links where su10_org_id = '${ORG_C}'`), newId)
    const card = await adminCall(admin, 'GET', `/api/admin/counterparties/${newId}/su10-org`)
    assert.equal(card.json().link.orgId, ORG_C)
    const un = await adminCall(admin, 'DELETE', `/api/admin/su10-orgs/${ORG_C}/link`)
    assert.equal(un.statusCode, 200)
    assert.equal((await adminCall(admin, 'DELETE', `/api/admin/su10-orgs/${ORG_C}/link`)).json().code, 'org_not_linked')
    const free = await adminCall(admin, 'GET', `/api/admin/counterparties/${CP.c.id}/su10-org`)
    assert.equal(free.json().link, null)
    assert.equal(free.json().orgs[0].id, ORG_C, 'похожая по ИНН организация — первой')
    for (const kind of ['org.link', 'org.unlink']) assert.ok(events(kind) >= 1, kind)
  })

  it('режим own: вкладка работает при KC_ADMIN_*, вход по паролю связи не трогают; без KC_ADMIN_* — 404', async () => {
    const token = crypto.randomBytes(32).toString('base64url')
    internal(`insert into osp_session.sessions (id_hash, user_id, csrf, created_at, last_used_at, idle_expires_at, absolute_expires_at)
      values (encode(sha256('${token}'::bytea), 'hex'), '${U.admin.id}', 'csrf-own', now(), now(), now() + interval '1 day', now() + interval '2 days')`)
    const c = { session: token, csrf: 'csrf-own' }
    await makeApp({ authMode: 'own' })
    const ok = await adminCall(c, 'GET', '/api/admin/su10-orgs')
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().mode, 'own')
    await makeApp({ authMode: 'own', oidc: { admin: null } })
    assert.equal((await adminCall(c, 'GET', '/api/admin/su10-orgs')).statusCode, 404)
    await makeApp()
  })

  it('готовность keycloak: без сверки реестра или своей организации — auth fail', async () => {
    const ready = async () => (await app.inject({ method: 'GET', url: '/api/ready' })).json().checks.auth
    assert.equal(await ready(), 'ok')
    const meta = authSql(`select value from osp_auth.meta where key = 'su10_org_registry'`)
    authSql(`delete from osp_auth.meta where key = 'su10_org_registry'`)
    assert.equal(await ready(), 'fail')
    authSql(`insert into osp_auth.meta (key, value) values ('su10_org_registry', '${meta}')`)
    authSql(`update osp_auth.su10_orgs set state = 'missing', missing_since = now() where kind = 'own'`)
    assert.equal(await ready(), 'fail')
    authSql(`update osp_auth.su10_orgs set state = 'active', missing_since = null where kind = 'own'`)
    assert.equal(await ready(), 'ok')
  })

  it('права служебного клиента (identity orgs-sync --check); в журнале нет секретов и названий организаций', async () => {
    const admin = createKcAdmin({ issuer: ISSUER, admin: { clientId: 'osp-access-sync', clientSecret: ADMIN_SECRET, group: 'osp-access' }, fetch: kc.fetch })
    kc.members = [{ id: KC.con.sub, username: 'con', email: KC.con.email, firstName: 'П', lastName: 'П', enabled: true }]
    const good = await admin.probe()
    assert.equal(good.ok, true, JSON.stringify(good.steps))
    kc.forbid.add('children')
    const bad = await admin.probe()
    kc.forbid.delete('children')
    assert.equal(bad.ok, false)
    assert.equal(bad.steps.find((s) => s.step === 'org_children').ok, false)
    await app.accessSync.run({ force: true }).catch(() => {})
    const text = logs.join('\n')
    for (const secret of [CLIENT_SECRET, ADMIN_SECRET, 'Альфа', 'Гамма', KC.con.email, 'eyJ']) {
      assert.ok(!text.includes(secret), `в журнале: ${secret.slice(0, 12)}`)
    }
  })
})
