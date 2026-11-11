// Вход через Keycloak su10 (AUTH_MODE=keycloak) на настоящем PostgreSQL: схема — как в базе Яндекса под одной учёткой, поверх —
// настоящие миграции 20261019_own_auth и 20270112_keycloak_identity. Keycloak — в памяти (подставной fetch): discovery, JWKS
// RS256, token endpoint (код + PKCE, refresh, client_credentials), выход, Admin API группы. Адреса — https, как на проде: в коде
// службы нет послаблений для тестов.
// Проверяем обещанное в плане (temp-quiet-puppy, ред. 3):
//   • вход: две вкладки — каждая со своим state; возврат без своей cookie при живой сессии — на главную; ошибка Keycloak —
//     /login?sso_error; returnUrl — только свой путь; начало входа — только переходом страницы;
//   • токены: aud без клиента, чужой azp, подмена iss ответа, чужая подпись, просроченный, не-UUID sub; нет роли доступа —
//     /no-access, сессии нет; токены Keycloak в базе — только шифром, отзыв их затирает;
//   • связь учёток: по sub, по почте (только окно, не администраторы), конфликт, заявка, отклонённая, решения администратора;
//     роль «Администратор» и связи администраторов — только суперадминистратор, в том числе прямой записью в базу;
//   • перепроверка: успех, invalid_grant, нет роли, чужой sub, Keycloak недоступен (час, затем 503), простой — OSP_IDLE,
//     параллельные запросы — один refresh;
//   • режимы: сессия СУ-10 в own и парольная в keycloak — OSP_AUTH_MODE; парольные маршруты в keycloak — 410;
//   • сверка группы: заявки kc_sync, чистка, быстрый отзыв, постраничное чтение, предохранитель, эндпоинт;
//   • выход — адрес выхода СУ-10 с id_token; в журнале нет кода, state, токенов, секретов и почты из Admin API.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const OWN_AUTH = path.join(ROOT, 'migration', 'yandex', '20261019_own_auth.sql')
const IDENTITY = path.join(ROOT, 'migration', 'yandex', '20270112_keycloak_identity.sql')
// Организации СУ-10 (20270201): сотрудник входит только со своей организацией — у тестовых учёток claim своей по умолчанию,
// реестр засеян (подробно — tests/osp-api/su10-orgs.test.mjs).
const ORGS = path.join(ROOT, 'migration', 'yandex', '20270201_su10_org_links.sql')
const OWN_ORG = 'f0000000-0000-4000-8000-000000000001'
const depsOk = ['openid-client', 'jose', 'pg', 'fastify'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'kc-test-db-password'
const GATEWAY_SECRET = 'kc-test-gateway-secret-0123456789-abcdefghij'
const ORIGIN = 'https://tender.test'
const ISSUER = 'https://auth.test/realms/su10'
const ADMIN_BASE = 'https://auth.test/admin/realms/su10'
const CLIENT_SECRET = 'kc-client-secret-NEVER-IN-LOGS'
const ADMIN_SECRET = 'kc-admin-secret-NEVER-IN-LOGS'
const KEYS = `t1:${crypto.randomBytes(32).toString('base64')}`
const GROUP_ID = '99999999-9999-4999-8999-999999999999'
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

// Учётки портала (auth.users + user_roles) и учётки СУ-10 (sub).
const U = {
  emp: { id: '11111111-1111-4111-8111-111111111111', email: 'emp@su10.ru', role: 'engineer', approved: true },
  admin: { id: '22222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', role: 'admin', approved: true },
  boss: { id: '33333333-3333-4333-8333-333333333333', email: 'boss@su10.ru', role: 'engineer', approved: false },
  blocked: { id: '44444444-4444-4444-8444-444444444444', email: 'blocked@su10.ru', role: 'engineer', approved: false, blocked: true },
  mail: { id: '55555555-5555-4555-8555-555555555555', email: 'Same.Mail@su10.ru', role: 'engineer', approved: true },
  other: { id: '66666666-6666-4666-8666-666666666666', email: 'other.name@su10.ru', role: 'engineer', approved: true, fullName: 'Петров Пётр' },
  admin2: { id: '77777777-7777-4777-8777-777777777777', email: 'admin2@su10.ru', role: 'admin', approved: true },
  pwd: { id: '88888888-8888-4888-8888-888888888888', email: 'pwd@su10.ru', role: 'engineer', approved: true },
}
const sub = () => crypto.randomUUID()
const KC = {
  emp: { sub: 'a1111111-1111-4111-8111-111111111111', email: 'emp@su10.ru', given: 'Иван', family: 'Иванов' },
  admin: { sub: 'a2222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', given: 'Анна', family: 'Админова' },
  boss: { sub: 'a3333333-3333-4333-8333-333333333333', email: 'boss@su10.ru', given: 'Борис', family: 'Главный' },
  blocked: { sub: 'a4444444-4444-4444-8444-444444444444', email: 'blocked@su10.ru', given: 'Бл', family: 'Блок' },
}

// --- Keycloak в памяти ---------------------------------------------------------------------------------------------
async function createFakeKeycloak(jose) {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true })
  const foreign = await jose.generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const kc = {
    codes: new Map(), refresh: new Map(), members: [], down: false, refreshMode: 'ok', variant: null,
    calls: { refresh: 0, code: 0, admin: 0, adminToken: 0, members: 0 }, groupMissing: false, adminForbidden: false,
  }
  const now = () => Math.floor(Date.now() / 1000)
  const sign = (claims, key = privateKey, kid = 'k1') => new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key)

  async function accessToken(user, { roles = ['access'], v = {} } = {}) {
    const claims = {
      iss: ISSUER, sub: user.sub, aud: ['osp', 'account'], azp: 'osp', typ: 'Bearer', exp: now() + 300, iat: now(),
      email: user.email, preferred_username: user.email, sid: user.sid || 'sid-1',
      resource_access: { osp: { roles }, account: { roles: ['view-profile'] } },
      su10_org_id: user.org ?? [OWN_ORG],
      ...v.claims,
    }
    if (v.aud !== undefined) claims.aud = v.aud
    if (v.azp !== undefined) claims.azp = v.azp
    if (v.expired) { claims.exp = now() - 600; claims.iat = now() - 900 }
    return sign(claims, v.foreign ? foreign.privateKey : privateKey)
  }
  const idToken = (user, nonce) => sign({
    iss: ISSUER, sub: user.sub, aud: 'osp', azp: 'osp', exp: now() + 300, iat: now(), ...(nonce ? { nonce } : {}),
    email: user.email, given_name: user.given, family_name: user.family, name: `${user.given} ${user.family}`, sid: user.sid || 'sid-1',
  })
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const basicOk = (headers, id, secret) => {
    const h = new Headers(headers).get('authorization') || ''
    const [u, p] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent)
    return u === id && p === secret
  }

  kc.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.host !== 'auth.test') throw new TypeError('fetch failed: unknown host')
    if (kc.down) throw new TypeError('fetch failed')
    const method = (init.method || 'GET').toUpperCase()
    if (url.pathname === '/realms/su10/.well-known/openid-configuration') {
      return json(200, {
        issuer: kc.discoveryIssuer || ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'], authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      })
    }
    if (url.pathname === '/realms/su10/protocol/openid-connect/certs') return json(200, { keys: [jwk] })
    if (url.pathname === '/realms/su10/protocol/openid-connect/token' && method === 'POST') {
      const body = new URLSearchParams(String(init.body))
      const grant = body.get('grant_type')
      if (grant === 'client_credentials') {
        if (!basicOk(init.headers, 'osp-access-sync', ADMIN_SECRET)) return json(401, { error: 'invalid_client' })
        kc.calls.adminToken++
        return json(200, { access_token: `admin-${crypto.randomUUID()}`, token_type: 'Bearer', expires_in: 300 })
      }
      if (!basicOk(init.headers, 'osp', CLIENT_SECRET)) return json(401, { error: 'invalid_client' })
      if (grant === 'authorization_code') {
        kc.calls.code++
        const c = kc.codes.get(body.get('code'))
        kc.codes.delete(body.get('code'))
        if (!c) return json(400, { error: 'invalid_grant' })
        const challenge = crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url')
        if (challenge !== c.challenge || body.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' })
        const rt = `rt-${crypto.randomUUID()}`
        kc.refresh.set(rt, { user: c.user })
        return json(200, {
          access_token: await accessToken(c.user, { roles: c.roles, v: c.variant || {} }), id_token: await idToken(c.user, c.nonce),
          refresh_token: rt, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile',
        })
      }
      if (grant === 'refresh_token') {
        kc.calls.refresh++
        if (kc.refreshDelayMs) await new Promise((r) => setTimeout(r, kc.refreshDelayMs))
        const r = kc.refresh.get(body.get('refresh_token'))
        if (!r || kc.refreshMode === 'invalid_grant') return json(400, { error: 'invalid_grant', error_description: 'Session not active' })
        if (kc.refreshMode === '500') return json(503, { error: 'temporarily_unavailable' })
        const user = kc.refreshMode === 'other_sub' ? { ...r.user, sub: sub() } : r.user
        const rt = `rt-${crypto.randomUUID()}`
        kc.refresh.set(rt, { user: r.user })
        return json(200, {
          access_token: await accessToken(user, { roles: kc.refreshMode === 'no_access' ? [] : ['access'] }), id_token: await idToken(user),
          refresh_token: rt, token_type: 'Bearer', expires_in: 300,
        })
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname.startsWith('/admin/realms/su10/')) {
      kc.calls.admin++
      if (!/^Bearer admin-/.test(new Headers(init.headers).get('authorization') || '')) return json(401, { error: 'unauthorized' })
      if (kc.adminForbidden) return json(403, { error: 'forbidden' })
      if (url.pathname === '/admin/realms/su10/groups') {
        if (url.searchParams.get('exact') !== 'true') return json(400, {})
        return json(200, kc.groupMissing ? [] : [{ id: GROUP_ID, name: 'osp-access', path: '/osp-access', subGroups: [] }])
      }
      if (url.pathname === `/admin/realms/su10/groups/${GROUP_ID}/members`) {
        kc.calls.members++
        const first = Number(url.searchParams.get('first') || 0)
        const max = Number(url.searchParams.get('max') || 100)
        return json(200, kc.members.slice(first, first + max))
      }
      return json(404, {})
    }
    return json(404, { error: 'not_found' })
  }
  kc.accessToken = accessToken
  return kc
}

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
alter table auth.users enable row level security; alter table auth.users force row level security;
create policy osp_internal on auth.users for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
create table public.counterparties (id uuid primary key, name text, status text not null default 'active', deleted_at timestamptz);
create table public.roles (key text primary key, label text);
insert into public.roles values ('admin', 'Администратор'), ('engineer', 'Инженер'), ('contractor', 'Подрядчик');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, email text, full_name text, work_phone text, requested_company text,
  counterparty_id uuid references public.counterparties(id), object_ids uuid[] not null default '{}', last_login_at timestamptz,
  is_blocked boolean not null default false, self_registered boolean not null default false,
  constraint user_roles_blocked_not_approved check (not (is_blocked and is_approved)));
alter table public.user_roles enable row level security; alter table public.user_roles force row level security;
create policy osp_internal on public.user_roles for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
create table public.superadmins (user_id uuid primary key);
alter table public.superadmins enable row level security; alter table public.superadmins force row level security;
create policy osp_internal on public.superadmins for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
${fs.readFileSync(OWN_AUTH, 'utf8')}
${fs.readFileSync(IDENTITY, 'utf8')}
${fs.readFileSync(ORGS, 'utf8')}
`

describe('вход через Keycloak su10 на настоящей базе', { skip, timeout: 600000 }, () => {
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
  let createSecretBox
  let box

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
      db: { url: dbUrl, caFile: '', poolMax: 6, secondLockRole: '' },
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
    return { ...base, ...over, oidc: { ...base.oidc, ...(over.oidc || {}) } }
  }

  async function makeApp(over = {}, deps = {}) {
    await app?.close()
    logs = []
    app = buildApp({
      config: config(over),
      deps: { ...defaultDeps, blocklist, oidcFetch: kc.fetch, recheckOptions: { waitMs: 3000, pollMs: 50 }, accessSyncOptions: { throttleMs: 15_000 }, ...deps },
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } },
    })
    await app.ready()
    return app
  }

  const cookiesOf = (res) => {
    const raw = [].concat(res.headers['set-cookie'] || [])
    const get = (name) => raw.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') ?? null
    return { raw, session: get('__Host-osp_session'), csrf: get('__Host-osp_csrf') }
  }
  const sessionHeaders = (c, { unsafe = false, activity = false } = {}) => ({
    cookie: `__Host-osp_session=${c.session}; __Host-osp_csrf=${c.csrf}`,
    ...(unsafe ? { 'x-osp-csrf': c.csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
    ...(activity ? { 'x-osp-activity': c.csrf } : {}),
  })

  async function startLogin(returnUrl = '/tenders', headers = NAV) {
    const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/login?returnUrl=${encodeURIComponent(returnUrl)}`, headers })
    assert.equal(res.statusCode, 302, res.body)
    const loc = new URL(res.headers.location)
    const raw = [].concat(res.headers['set-cookie'] || [])
    const stateCookie = raw.find((c) => c.startsWith('__Host-osp_oidc_') && !/Max-Age=0/.test(c))
    return {
      location: loc, raw, cookie: stateCookie.split(';')[0], state: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce'),
      challenge: loc.searchParams.get('code_challenge'), redirectUri: loc.searchParams.get('redirect_uri'),
    }
  }
  function authorize(login, user, { iss = ISSUER, roles = ['access'], variant = null } = {}) {
    const code = crypto.randomBytes(16).toString('hex')
    kc.codes.set(code, { user, nonce: login.nonce, challenge: login.challenge, redirectUri: login.redirectUri, roles, variant })
    return `code=${code}&state=${encodeURIComponent(login.state)}&session_state=ss-${code}&iss=${encodeURIComponent(iss)}`
  }
  const callback = (query, cookie) => app.inject({ method: 'GET', url: `/api/auth/oidc/callback?${query}`, headers: { ...NAV, cookie } })
  async function loginAs(user, opts = {}) {
    const login = await startLogin(opts.returnUrl || '/tenders')
    const res = await callback(authorize(login, user, opts), login.cookie)
    return { res, login, c: cookiesOf(res) }
  }
  const link = (kcUser, portalUser) => authSql(`insert into osp_auth.identity_links (issuer, subject, user_id, source)
    values ('${ISSUER}', '${kcUser.sub}', '${portalUser.id}', 'link_file') on conflict do nothing`)
  const sessionRow = (c, cols) => internal(`select ${cols} from osp_session.sessions where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
  const ageCheck = (c, sqlInterval) => internal(`update osp_session.sessions set kc_checked_at = date_trunc('milliseconds', now() - interval '${sqlInterval}')
    where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
  const me = (c, opts) => app.inject({ method: 'GET', url: '/api/auth/me', headers: sessionHeaders(c, opts) })

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ createSecretBox } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'secretBox.js')))
    const { loadBlocklist } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'policy.js'))
    jose = await import(path.join(SERVER, 'node_modules', 'jose', 'dist', 'webapi', 'index.js'))
    blocklist = loadBlocklist()
    box = createSecretBox(KEYS)
    kc = await createFakeKeycloak(jose)

    upstream = { seen: [] }
    upstream.server = http.createServer((req, res) => {
      upstream.seen.push({ method: req.method, url: req.url })
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') })
    })
    await new Promise((r) => upstream.server.listen(0, '127.0.0.1', r))
    upstream.url = `http://127.0.0.1:${upstream.server.address().port}`

    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL(DB_PASSWORD))
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`
    const users = Object.values(U).map((u) => `('${u.id}', 'authenticated', 'authenticated', '${u.email}', now(), now(), now(), '{}')`).join(',\n')
    const roles = Object.values(U).map((u) => `('${u.id}', '${u.role}', ${u.approved}, ${Boolean(u.blocked)}, '${u.email}', ${u.fullName ? `'${u.fullName}'` : 'null'})`).join(',\n')
    internal(`insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data) values ${users};
      insert into public.user_roles (user_id, role, is_approved, is_blocked, email, full_name) values ${roles};
      insert into public.superadmins values ('${U.boss.id}');
      select 1`)
    authSql(`insert into osp_auth.meta (key, value) values ('canary', '${box.encrypt('osp-auth-canary', 'osp-auth-canary')}')`)
    authSql(`insert into osp_auth.su10_orgs (issuer, su10_org_id, kind, name, state, generation) values ('${ISSUER}', '${OWN_ORG}', 'own', 'СУ-10', 'active', 1);
      insert into osp_auth.meta (key, value) values ('su10_org_registry', '{"generation":1}')`)
    for (const [k, p] of [['emp', 'emp'], ['admin', 'admin'], ['boss', 'boss'], ['blocked', 'blocked']]) link(KC[k], U[p])
    await makeApp()
  })

  after(async () => {
    await app?.close()
    upstream?.server.close()
    pgdb?.stop()
  })

  it('режим: /api/auth/config — keycloak, ссылки СУ-10; парольные маршруты и регистрация — 410', async () => {
    const cfg = await app.inject({ method: 'GET', url: '/api/auth/config' })
    assert.deepEqual(cfg.json(), { mode: 'keycloak', ownLogin: false, sso: { accountUrl: `${ISSUER}/account`, manageUrl: 'https://auth.test/manage' } })
    const json = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: { email: 'emp@su10.ru', password: 'x' } })
    assert.equal(login.statusCode, 410)
    assert.equal(login.json().code, 'OSP_SSO_ONLY')
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', headers: json, payload: {} })
    assert.ok([400, 410].includes(reg.statusCode), String(reg.statusCode))
    const challenge = await app.inject({ method: 'GET', url: '/api/auth/register/challenge' })
    assert.equal(challenge.statusCode, 410)
    const { c } = await loginAs(KC.admin)
    for (const [url, payload] of [['/api/auth/admin/users', { email: 'n@su10.ru', fullName: 'Н', role: 'engineer' }],
      ['/api/auth/admin/reset-password', { userId: U.emp.id }], ['/api/auth/password', { currentPassword: 'a', newPassword: 'b' }]]) {
      const r = await app.inject({ method: 'POST', url, headers: sessionHeaders(c, { unsafe: true }), payload })
      assert.equal(r.statusCode, 410, url)
    }
  })

  it('вход: cookie сессии, переход на returnUrl; токены Keycloak в базе — только шифром; /me и шлюз работают', async () => {
    const { res, c } = await loginAs(KC.emp, { returnUrl: '/tenders/construction?tab=2' })
    assert.equal(res.statusCode, 302, res.body)
    assert.equal(res.headers.location, `${ORIGIN}/tenders/construction?tab=2`)
    assert.match(c.raw.find((x) => x.startsWith('__Host-osp_session=')), /; Path=\/; Max-Age=2592000; Secure; SameSite=Lax; HttpOnly$/)
    assert.ok(c.raw.some((x) => /^__Host-osp_oidc_[0-9a-f]{16}=; .*Max-Age=0/.test(x)), 'cookie состояния погашена')
    const row = sessionRow(c, `auth_source || '|' || kc_subject || '|' || (kc_refresh_enc like 'v1:t1:%') || '|' || (kc_refresh_enc not like '%rt-%')
      || '|' || (idle_expires_at < now() + interval '49 hours')`)
    assert.equal(row, `keycloak|${KC.emp.sub}|true|true|true`)
    const m = await me(c)
    assert.equal(m.statusCode, 200, m.body)
    assert.deepEqual(m.json(), { user: { id: U.emp.id, email: U.emp.email }, isSuperadmin: false, mustChange: false, authSource: 'keycloak' })
    upstream.seen.length = 0
    const g = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: sessionHeaders(c) })
    assert.equal(g.statusCode, 200, g.body)
    assert.equal(upstream.seen.length, 1)
    // Меняющий запрос — только с CSRF и с самого портала, как у парольной сессии.
    const bad = await app.inject({ method: 'POST', url: '/api/db/rpc/x', headers: { ...sessionHeaders(c), 'content-type': 'application/json' }, payload: {} })
    assert.equal(bad.statusCode, 403)
  })

  it('две вкладки со входом — у каждой свой state; возврат без своей cookie: есть сессия — на главную, нет — /login?sso_error=state', async () => {
    const a = await startLogin('/a')
    const b = await startLogin('/b')
    assert.notEqual(a.state, b.state)
    const both = `${a.cookie}; ${b.cookie}`
    const rb = await callback(authorize(b, KC.emp), both)
    assert.equal(rb.headers.location, `${ORIGIN}/b`)
    const ra = await callback(authorize(a, KC.emp), both)
    assert.equal(ra.headers.location, `${ORIGIN}/a`)
    const c = cookiesOf(ra)
    const again = await callback(authorize(a, KC.emp), `__Host-osp_session=${c.session}; __Host-osp_csrf=${c.csrf}`)
    assert.equal(again.headers.location, `${ORIGIN}/`)
    const none = await callback(authorize(a, KC.emp), '')
    assert.equal(none.headers.location, '/login?sso_error=state')
    // Не больше трёх cookie состояния: четвёртая вкладка гасит самую старую.
    const s1 = await startLogin('/1')
    const s2 = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnUrl=/2', headers: { ...NAV, cookie: `${s1.cookie}; ${a.cookie}; ${b.cookie}` } })
    const cleared = [].concat(s2.headers['set-cookie']).filter((x) => /Max-Age=0/.test(x))
    assert.ok(cleared.length >= 1, 'старые cookie состояния погашены')
  })

  it('начало входа — только переходом страницы; returnUrl — только свой путь', async () => {
    const img = await app.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } })
    assert.equal(img.statusCode, 400)
    assert.equal(img.headers['set-cookie'], undefined)
    // Браузер без Sec-Fetch-* (Safari до 16.4) — вход работает.
    const old = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnUrl=/x', headers: {} })
    assert.equal(old.statusCode, 302)
    // Не-ASCII в адресе возврата — в %-кодировке, сессия и переход без сбоя.
    const ru = await startLogin('/tenders?q=Мост#раздел')
    const ruRes = await callback(authorize(ru, KC.emp), ru.cookie)
    assert.equal(ruRes.statusCode, 302, ruRes.body)
    assert.equal(ruRes.headers.location, `${ORIGIN}/tenders?q=%D0%9C%D0%BE%D1%81%D1%82#%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB`)
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/\\evil.test', '/api/db/users', '/\u0007x', `/${'x'.repeat(600)}`]) {
      const login = await startLogin(bad)
      const res = await callback(authorize(login, KC.emp), login.cookie)
      assert.equal(res.headers.location, `${ORIGIN}/`, bad)
    }
    const auth = (await startLogin('/x')).location
    assert.equal(auth.origin + auth.pathname, `${ISSUER}/protocol/openid-connect/auth`)
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/oidc/callback`)
    assert.equal(auth.searchParams.get('client_id'), 'osp')
  })

  it('ответ Keycloak: ошибка — /login?sso_error=<код>; подмена iss, чужой aud и azp, просроченный, чужая подпись, не-UUID sub — без сессии', async () => {
    const login = await startLogin('/x')
    const denied = await callback(`error=access_denied&state=${encodeURIComponent(login.state)}`, login.cookie)
    assert.equal(denied.headers.location, '/login?sso_error=access_denied')
    const cases = [
      [{ iss: 'https://evil.test/realms/su10' }, 'exchange'],
      [{ variant: { aud: ['account'] } }, 'token'],
      [{ variant: { aud: 'account' } }, 'token'],
      [{ variant: { azp: 'other-client' } }, 'token'],
      [{ variant: { expired: true } }, 'token'],
      [{ variant: { foreign: true } }, 'token'],
    ]
    for (const [opts, code] of cases) {
      const l = await startLogin('/x')
      const res = await callback(authorize(l, KC.emp, opts), l.cookie)
      assert.equal(res.headers.location, `/login?sso_error=${code}`, JSON.stringify(opts))
      assert.ok(!cookiesOf(res).session, 'сессии нет')
    }
    const l = await startLogin('/x')
    const badSub = await callback(authorize(l, { ...KC.emp, sub: 'not-a-uuid' }), l.cookie)
    assert.match(badSub.headers.location, /^\/login\?sso_error=(claims|token)$/)
    // aud строкой с клиентом — годится (у Keycloak бывает и так).
    const ok = await startLogin('/ok')
    const okRes = await callback(authorize(ok, KC.emp, { variant: { aud: 'osp' } }), ok.cookie)
    assert.equal(okRes.headers.location, `${ORIGIN}/ok`)
  })

  it('нет роли доступа к порталу — /no-access, сессии нет; заблокированный в портале — /login?sso_error=disabled', async () => {
    const { res } = await loginAs(KC.emp, { roles: [] })
    assert.equal(res.headers.location, '/no-access')
    assert.ok(!cookiesOf(res).session)
    const blocked = await loginAs(KC.blocked)
    assert.equal(blocked.res.headers.location, '/login?sso_error=disabled')
    // Суперадминистратор входит и без одобренной строки ролей — как при парольном входе.
    const boss = await loginAs(KC.boss)
    assert.equal(boss.res.headers.location, `${ORIGIN}/tenders`)
  })

  it('без связи — заявка (/access-requested), повторный вход освежает её; отклонённая — /no-access', async () => {
    const stranger = { sub: sub(), email: 'New.Person@su10.ru', given: 'Нина', family: 'Новикова' }
    const first = await loginAs(stranger)
    assert.equal(first.res.headers.location, '/access-requested')
    assert.equal(authSql(`select status || '|' || origin || '|' || email || '|' || full_name || '|' || (first_seen_at is not null)
      from osp_auth.identity_requests where subject = '${stranger.sub}'`), 'pending|login|new.person@su10.ru|Новикова Нина|true')
    await loginAs(stranger)
    assert.equal(authSql(`select count(*) from osp_auth.identity_requests where subject = '${stranger.sub}'`), '1')
    authSql(`update osp_auth.identity_requests set status = 'rejected' where subject = '${stranger.sub}'`)
    const rejected = await loginAs(stranger)
    assert.equal(rejected.res.headers.location, '/no-access')
  })

  it('по почте — только в окно переключения, ровно одна одобренная учётка без связи и не администратор; конфликт — заявка', async () => {
    const byMail = { sub: sub(), email: 'same.mail@SU10.ru', given: 'Почта', family: 'Совпала' }
    const off = await loginAs(byMail)
    assert.equal(off.res.headers.location, '/access-requested', 'флаг выключен — только заявка')
    await makeApp({ oidc: { linkByEmail: true } })
    authSql(`delete from osp_auth.identity_requests where subject = '${byMail.sub}'`)
    const on = await loginAs(byMail)
    assert.equal(on.res.headers.location, `${ORIGIN}/tenders`)
    assert.equal(authSql(`select user_id || '|' || source from osp_auth.identity_links where subject = '${byMail.sub}'`), `${U.mail.id}|email`)
    // Учётка уже связана с другим sub — не привязываем, событие конфликта, заявка.
    const twin = { sub: sub(), email: 'same.mail@su10.ru', given: 'Двойник', family: 'Почты' }
    const conflict = await loginAs(twin)
    assert.equal(conflict.res.headers.location, '/access-requested')
    assert.equal(authSql("select count(*) from osp_auth.events where kind = 'sso.link_conflict'"), '1')
    // Администратор по почте не привязывается никогда.
    const adm = { sub: sub(), email: 'admin2@su10.ru', given: 'Второй', family: 'Админ' }
    const r = await loginAs(adm)
    assert.equal(r.res.headers.location, '/access-requested')
    await makeApp()
  })

  it('решения администратора: похожие, создать, привязать, отклонить, открыть заново, отвязать; не администратору — 403', async () => {
    const admin = (await loginAs(KC.admin)).c
    const emp = (await loginAs(KC.emp)).c
    const p = { sub: sub(), email: 'other.name@ext.ru', given: 'Пётр', family: 'Петров' }
    await loginAs(p)
    const list = await app.inject({ method: 'GET', url: '/api/admin/identity-requests', headers: sessionHeaders(admin) })
    assert.equal(list.statusCode, 200, list.body)
    const req = list.json().requests.find((q) => q.email === 'other.name@ext.ru')
    assert.ok(req)
    const sim = req.similar.find((s) => s.userId === U.other.id)
    assert.ok(sim, 'похожий по ФИО и части почты')
    assert.deepEqual(sim.match.sort(), ['email_local', 'name'])
    const denied = await app.inject({ method: 'GET', url: '/api/admin/identity-requests', headers: sessionHeaders(emp) })
    assert.equal(denied.statusCode, 403)
    // Привязать к существующему.
    const linked = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${req.id}/link`, headers: sessionHeaders(admin, { unsafe: true }), payload: { userId: U.other.id } })
    assert.equal(linked.statusCode, 200, linked.body)
    const again = await loginAs(p)
    assert.equal(again.res.headers.location, `${ORIGIN}/tenders`)
    const ids = await app.inject({ method: 'GET', url: '/api/admin/identities', headers: sessionHeaders(admin) })
    assert.ok(ids.json().links.some((l) => l.userId === U.other.id && l.source === 'request'))
    // Отвязать — сессии СУ-10 сразу закрыты, следующий вход — снова заявка.
    const un = await app.inject({ method: 'DELETE', url: `/api/admin/users/${U.other.id}/identity`, headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(un.statusCode, 200, un.body)
    assert.equal((await me(again.c)).statusCode, 401)
    assert.equal((await loginAs(p)).res.headers.location, '/access-requested')
    // Создать пользователя: учётка без пароля, роль одобрена, связь, заявка разобрана.
    const fresh = { sub: sub(), email: 'fresh@ext.ru', given: 'Свежий', family: 'Человек' }
    await loginAs(fresh)
    const freshId = authSql(`select id from osp_auth.identity_requests where subject = '${fresh.sub}'`)
    const created = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${freshId}/create-user`, headers: sessionHeaders(admin, { unsafe: true }), payload: { role: 'engineer' } })
    assert.equal(created.statusCode, 200, created.body)
    const newId = created.json().user.id
    assert.equal(internal(`select role || '|' || is_approved || '|' || full_name from public.user_roles where user_id = '${newId}'`), 'engineer|true|Человек Свежий')
    assert.equal(authSql(`select count(*) from osp_auth.credentials where user_id = '${newId}'`), '0', 'пароля ОСП нет')
    assert.equal((await loginAs(fresh)).res.headers.location, `${ORIGIN}/tenders`)
    // Почта занята — 409 с подсказкой «привязать».
    const dup = { sub: sub(), email: 'pwd@su10.ru', given: 'Дубль', family: 'Почты' }
    await loginAs(dup)
    const dupId = authSql(`select id from osp_auth.identity_requests where subject = '${dup.sub}'`)
    const taken = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${dupId}/create-user`, headers: sessionHeaders(admin, { unsafe: true }), payload: { role: 'engineer' } })
    assert.equal(taken.statusCode, 409)
    assert.equal(taken.json().userId, U.pwd.id)
    // Отклонить и открыть заново.
    const rej = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${dupId}/reject`, headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(rej.statusCode, 200)
    assert.equal((await loginAs(dup)).res.headers.location, '/no-access')
    const reo = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${dupId}/reopen`, headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(reo.statusCode, 200)
    assert.equal((await loginAs(dup)).res.headers.location, '/access-requested')
  })

  it('роль «Администратор» и связи администраторов — только суперадминистратор: маршруты и прямая запись в базу', async () => {
    const admin = (await loginAs(KC.admin)).c
    const boss = (await loginAs(KC.boss)).c
    const cand = { sub: sub(), email: 'cand@ext.ru', given: 'Кандидат', family: 'Админов' }
    await loginAs(cand)
    const id = authSql(`select id from osp_auth.identity_requests where subject = '${cand.sub}'`)
    const byAdmin = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${id}/create-user`, headers: sessionHeaders(admin, { unsafe: true }), payload: { role: 'admin' } })
    assert.equal(byAdmin.statusCode, 403)
    assert.equal(byAdmin.json().code, 'superadmin_only')
    const byBoss = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${id}/create-user`, headers: sessionHeaders(boss, { unsafe: true }), payload: { role: 'admin' } })
    assert.equal(byBoss.statusCode, 200, byBoss.body)
    // Привязка заявки к учётке администратора — только суперадминистратор.
    const a2 = { sub: sub(), email: 'a2@ext.ru', given: 'А', family: 'Два' }
    await loginAs(a2)
    const a2id = authSql(`select id from osp_auth.identity_requests where subject = '${a2.sub}'`)
    const l1 = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${a2id}/link`, headers: sessionHeaders(admin, { unsafe: true }), payload: { userId: U.admin2.id } })
    assert.equal(l1.statusCode, 403)
    const l2 = await app.inject({ method: 'POST', url: `/api/admin/identity-requests/${a2id}/link`, headers: sessionHeaders(boss, { unsafe: true }), payload: { userId: U.admin2.id } })
    assert.equal(l2.statusCode, 200, l2.body)
    const un = await app.inject({ method: 'DELETE', url: `/api/admin/users/${U.admin2.id}/identity`, headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(un.statusCode, 403)
    // Прямая запись в базу (как шлюз от имени вошедшего): обычный администратор не повышает до admin, суперадминистратор — да,
    // служебная операция (без вошедшего) — без проверки.
    const claims = (u) => `select set_config('request.jwt.claims', '{"sub":"${u.id}","role":"authenticated"}', true);`
    assert.throws(() => internal(`begin; ${claims(U.admin)} update public.user_roles set role = 'admin' where user_id = '${U.pwd.id}'; commit;`), /только суперадминистратор/)
    internal(`begin; ${claims(U.boss)} update public.user_roles set role = 'admin' where user_id = '${U.pwd.id}'; commit;`)
    assert.equal(internal(`select role from public.user_roles where user_id = '${U.pwd.id}'`), 'admin')
    internal(`update public.user_roles set role = 'engineer' where user_id = '${U.pwd.id}'`)
    // «Добавить пользователя» в своём входе (own) — та же граница.
    await makeApp({ authMode: 'own' })
    await makeApp()
  })

  it('перепроверка: успех продлевает, параллельные — один refresh; invalid_grant, нет роли, чужой sub — отзыв', async () => {
    kc.refreshMode = 'ok'
    const { c } = await loginAs(KC.emp)
    ageCheck(c, '10 minutes')
    kc.calls.refresh = 0
    kc.refreshDelayMs = 300
    const parallel = await Promise.all(Array.from({ length: 5 }, () => me(c, { activity: true })))
    kc.refreshDelayMs = 0
    assert.deepEqual(parallel.map((r) => r.statusCode), [200, 200, 200, 200, 200])
    assert.equal(kc.calls.refresh, 1, 'один refresh grant на сессию')
    assert.equal(sessionRow(c, "kc_checked_at > now() - interval '1 minute'"), 't')

    for (const [mode, status, code] of [['invalid_grant', 401, 'OSP_SSO_REQUIRED'], ['no_access', 403, 'OSP_NO_PORTAL_ACCESS'], ['other_sub', 401, 'OSP_SSO_REQUIRED']]) {
      const s = (await loginAs(KC.emp)).c
      ageCheck(s, '10 minutes')
      kc.refreshMode = mode
      const r = await me(s, { activity: true })
      assert.equal(r.statusCode, status, mode)
      assert.equal(r.json().code, code, mode)
      assert.equal(sessionRow(s, "(revoked_at is not null) || '|' || coalesce(kc_refresh_enc, 'null')"), 'true|null', `${mode}: отозвана, токены затёрты`)
      assert.ok(!cookiesOf(r).raw.length, 'cookie на отказе не стираются')
    }
    kc.refreshMode = 'ok'
  })

  it('перепроверка: Keycloak недоступен — работа до часа без проверки, повтор не чаще раза в минуту, потом 503 без отзыва', async () => {
    const { c } = await loginAs(KC.emp)
    ageCheck(c, '10 minutes')
    kc.down = true
    const r1 = await me(c, { activity: true })
    assert.equal(r1.statusCode, 200, 'в пределах часа — работаем')
    kc.calls.refresh = 0
    const r2 = await me(c, { activity: true })
    assert.equal(r2.statusCode, 200)
    assert.equal(sessionRow(c, "kc_retry_after > now()"), 't', 'следующая попытка — не раньше чем через минуту')
    ageCheck(c, '2 hours')
    internal(`update osp_session.sessions set kc_retry_after = null where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
    const r3 = await me(c, { activity: true })
    assert.equal(r3.statusCode, 503)
    assert.equal(r3.json().code, 'OSP_SSO_UNAVAILABLE')
    assert.equal(sessionRow(c, 'revoked_at is null'), 't', 'сессия не отозвана')
    kc.down = false
    // Неудачная попытка отложила следующую на минуту — до неё ответ прежний.
    assert.equal((await me(c, { activity: true })).statusCode, 503)
    internal(`update osp_session.sessions set kc_retry_after = null where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
    const r4 = await me(c, { activity: true })
    assert.equal(r4.statusCode, 200, 'Keycloak вернулся — проверка прошла')
  })

  it('простой: фоновый запрос после 30 минут без действий — OSP_IDLE без отзыва; действие — проверка и работа дальше', async () => {
    const { c } = await loginAs(KC.emp)
    ageCheck(c, '10 minutes')
    internal(`update osp_session.sessions set last_activity_at = now() - interval '40 minutes' where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
    const bg = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: sessionHeaders(c) })
    assert.equal(bg.statusCode, 401)
    assert.equal(bg.json().code, 'OSP_IDLE')
    assert.equal(sessionRow(c, 'revoked_at is null'), 't')
    const act = await me(c, { activity: true })
    assert.equal(act.statusCode, 200)
    // Продление пишется в фоне (запрос не ждёт записи) — ждём её, а не читаем сразу.
    for (let i = 0; i < 50 && sessionRow(c, "last_activity_at > now() - interval '1 minute'") !== 't'; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(sessionRow(c, "last_activity_at > now() - interval '1 minute'"), 't', 'действие продлило')
    // Чужое значение заголовка действия — не действие.
    internal(`update osp_session.sessions set last_activity_at = now() - interval '40 minutes' where id_hash = encode(sha256('${c.session}'::bytea), 'hex')`)
    ageCheck(c, '10 minutes')
    const forged = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...sessionHeaders(c), 'x-osp-activity': '1' } })
    assert.equal(forged.json().code, 'OSP_IDLE')
  })

  it('матрица режимов: сессия СУ-10 в own, парольная в keycloak, токен Supabase в keycloak — OSP_AUTH_MODE', async () => {
    const kcSession = (await loginAs(KC.emp)).c
    // Парольная сессия — как выдал бы вход в own.
    const token = crypto.randomBytes(32).toString('base64url')
    internal(`insert into osp_session.sessions (id_hash, user_id, csrf, idle_expires_at, absolute_expires_at)
      values (encode(sha256('${token}'::bytea), 'hex'), '${U.pwd.id}', 'csrf-pwd-0123456789', now() + interval '1 day', now() + interval '2 days')`)
    const pwd = { session: token, csrf: 'csrf-pwd-0123456789' }
    const inKc = await me(pwd)
    assert.equal(inKc.json().code, 'OSP_AUTH_MODE')
    const bearer = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${userToken({ sub: U.emp.id })}` } })
    assert.equal(bearer.json().code, 'OSP_AUTH_MODE')
    await makeApp({ authMode: 'own' })
    const inOwn = await me(kcSession)
    assert.equal(inOwn.json().code, 'OSP_AUTH_MODE')
    assert.equal((await me(pwd)).statusCode, 200)
    const oidcInOwn = await app.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: NAV })
    assert.equal(oidcInOwn.statusCode, 404)
    await makeApp()
  })

  it('выход: адрес выхода СУ-10 с id_token; сессия отозвана, токены затёрты; «выйти везде» — все сессии', async () => {
    const { c } = await loginAs(KC.emp)
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: sessionHeaders(c, { unsafe: true }), payload: {} })
    assert.equal(res.statusCode, 200, res.body)
    const url = new URL(res.json().endSessionUrl)
    assert.equal(url.origin + url.pathname, `${ISSUER}/protocol/openid-connect/logout`)
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), `${ORIGIN}/login`)
    assert.equal(url.searchParams.get('client_id'), 'osp')
    assert.ok(url.searchParams.get('id_token_hint')?.split('.').length === 3)
    assert.equal(sessionRow(c, "(revoked_at is not null) || '|' || coalesce(kc_id_token_enc, 'null')"), 'true|null')
    const a = (await loginAs(KC.emp)).c
    const b = (await loginAs(KC.emp)).c
    const all = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: sessionHeaders(a, { unsafe: true }), payload: { all: true } })
    assert.equal(all.statusCode, 200)
    assert.equal((await me(b)).statusCode, 401)
    const noCsrf = (await loginAs(KC.emp)).c
    const refused = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: sessionHeaders(noCsrf), payload: {} })
    assert.equal(refused.statusCode, 403)
  })

  it('сверка группы: заявки kc_sync, обновление, отключённые, чистка, быстрый отзыв, страницы по 100, предохранитель', async () => {
    authSql(`delete from osp_auth.meta where key like 'kc_sync%'`)
    const admin = (await loginAs(KC.admin)).c
    const linkedEmp = (await loginAs(KC.emp)).c
    const member = (u, enabled = true) => ({ id: u.sub, username: u.email, email: u.email, firstName: u.given, lastName: u.family, enabled })
    const newbie = { sub: sub(), email: 'Newbie@su10.ru', given: 'Нов', family: 'Новичков' }
    const disabled = { sub: sub(), email: 'off@su10.ru', given: 'Выкл', family: 'Отключён' }
    const filler = Array.from({ length: 120 }, (_, i) => ({ sub: sub(), email: `f${i}@su10.ru`, given: 'Ф', family: `Номер${i}` }))
    kc.members = [member(KC.emp), member(KC.admin), member(KC.boss), member(newbie), member(disabled, false), ...filler.map((f) => member(f))]
    kc.calls.members = 0
    const r1 = await app.inject({ method: 'POST', url: '/api/admin/identity-requests/sync', headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(r1.statusCode, 200, r1.body)
    assert.equal(r1.json().created, 121)
    assert.equal(kc.calls.members, 2, 'две страницы по 100')
    assert.equal(authSql(`select origin || '|' || email || '|' || (first_seen_at is null) from osp_auth.identity_requests where subject = '${newbie.sub}'`),
      'kc_sync|newbie@su10.ru|true')
    assert.equal(authSql(`select count(*) from osp_auth.identity_requests where subject = '${disabled.sub}'`), '0', 'отключённый пропущен')
    // Частый вызов — прошлый итог, без похода в Keycloak.
    const calls = kc.calls.admin
    const r2 = await app.inject({ method: 'POST', url: '/api/admin/identity-requests/sync', headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(r2.json().cached, true)
    assert.equal(kc.calls.admin, calls)
    // Выдали и отозвали: заявка без входов уходит, с входом — остаётся; связанный не из группы теряет сессию.
    const visited = filler[0]
    authSql(`update osp_auth.identity_requests set first_seen_at = now() where subject = '${visited.sub}'`)
    kc.members = [member(KC.admin), member(KC.boss), member(newbie), member(disabled, false), ...filler.slice(0, 1).map((f) => member(f))]
    const run = (force = false) => app.accessSync.run({ force })
    const held = await run()
    assert.equal(held.held, true, 'участников стало меньше на 30 % — предохранитель')
    assert.ok(held.reasons.includes('drop'))
    assert.equal((await me(linkedEmp)).statusCode, 200, 'ни отзыва, ни чистки')
    const forced = await run(true)
    assert.equal(forced.held, false)
    assert.equal(forced.revoked, 1)
    assert.equal((await me(linkedEmp)).statusCode, 401)
    assert.equal(authSql(`select count(*) from osp_auth.identity_requests where subject = '${filler[1].sub}'`), '0', 'без входов — удалена')
    assert.equal(authSql(`select count(*) from osp_auth.identity_requests where subject = '${visited.sub}'`), '1', 'с входом — осталась')
    // Группа не найдена — ошибка, чистки нет.
    kc.groupMissing = true
    await assert.rejects(() => run(true))
    kc.groupMissing = false
    // Пустая группа после непустой — предохранитель.
    kc.members = []
    const empty = await run()
    assert.equal(empty.held, true)
    assert.ok(empty.reasons.includes('empty'))
  })

  it('без KC_ADMIN_* сверка выключена: эндпоинт — 409; Keycloak недоступен при запуске — служба работает; issuer не тот — не стартует', async () => {
    await makeApp({ oidc: { admin: null } })
    const admin = (await loginAs(KC.admin)).c
    const r = await app.inject({ method: 'POST', url: '/api/admin/identity-requests/sync', headers: sessionHeaders(admin, { unsafe: true }), payload: {} })
    assert.equal(r.statusCode, 409)
    assert.equal(r.json().code, 'kc_sync_unavailable')
    kc.down = true
    await makeApp()
    const h = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(h.statusCode, 200)
    const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: NAV })
    assert.equal(login.headers.location, '/login?sso_error=unavailable')
    kc.down = false
    kc.discoveryIssuer = 'https://evil.test/realms/su10'
    await assert.rejects(() => makeApp())
    app = null
    kc.discoveryIssuer = null
    await makeApp()
  })

  it('в журнале нет кода, state, токенов, секретов клиентов и почты участников группы', async () => {
    const login = await startLogin('/x')
    const query = authorize(login, KC.emp)
    await callback(query, login.cookie)
    const code = new URLSearchParams(query).get('code')
    await app.accessSync.run({ force: true }).catch(() => {})
    const text = logs.join('\n')
    for (const secret of [code, login.state, CLIENT_SECRET, ADMIN_SECRET, 'rt-', 'newbie@su10.ru', 'eyJ']) {
      assert.ok(!text.includes(secret), `в журнале: ${secret.slice(0, 12)}`)
    }
  })
})
