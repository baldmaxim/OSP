// Свой вход tender.su10.ru (AUTH_MODE both | own) на настоящем PostgreSQL: схема — как в базе Яндекса под одной
// учёткой (правила по строкам на владельце, пропуск служебных функций), поверх — настоящая миграция
// migration/yandex/20261019_own_auth.sql. Проверяем обещанное в плане:
//   • вход прежним паролем Supabase (bcrypt) и пересчёт в scrypt; один ответ на любую неудачу;
//   • перебор: блокировка по почте (и несуществующей), сброс при успехе; лимит по адресу клиента — только от
//     своего прокси (подложенный X-Forwarded-For без доверия не учитывается);
//   • вход по уже заменённому паролю сессии не получает (гонка входа и сброса);
//   • сессия: cookie __Host-, CSRF и источник на меняющих запросах, единая проверка для шлюза, функций и /me;
//     блокировка прямым изменением user_roles (как из «Администрирования») отзывает сессию триггером;
//   • временный пароль от администратора: до смены — ничего, кроме смены пароля, /me и выхода;
//   • удаление учётки — надгробие и функция базы одной транзакцией (отказ функции — надгробия нет);
//   • режимы: both — только пилот; own — Bearer Supabase отклоняется; готовность проверяет ключ;
//   • отметки: пароли (osp_auth) не видны пропуску служебных функций, отметка osp:auth не видит портал;
//   • пароли, отпечатки и id сессии не попадают ни в ответы, ни в журнал.
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
const MIGRATION = path.join(ROOT, 'migration', 'yandex', '20261019_own_auth.sql')
const depsOk = ['bcryptjs', 'pg', 'fastify'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'own-auth-test-db-password'
const GATEWAY_SECRET = 'own-auth-gateway-secret-0123456789-abcdefghij'
const SUPA_URL = 'https://testproject.supabase.co'
const ORIGIN = 'https://tender.test'
const AUTH_KEY = crypto.randomBytes(32).toString('base64')
const KEYS = `t1:${AUTH_KEY}`

const U = {
  legacy: { id: '11111111-1111-4111-8111-111111111111', email: 'Legacy.User@su10.ru', password: 'Old-Supabase-Pass-1' },
  admin: { id: '22222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', password: 'Admin-Supabase-Pass-2' },
  unapproved: { id: '33333333-3333-4333-8333-333333333333', email: 'wait@su10.ru', password: 'Waiting-Pass-3' },
  blocked: { id: '44444444-4444-4444-8444-444444444444', email: 'blocked@su10.ru', password: 'Blocked-Pass-4' },
  norole: { id: '55555555-5555-4555-8555-555555555555', email: 'contractor@example.ru', password: 'No-Role-Pass-5' },
  superadmin: { id: '66666666-6666-4666-8666-666666666666', email: 'boss@su10.ru', password: 'Boss-Pass-6-long' },
  victim: { id: '77777777-7777-4777-8777-777777777777', email: 'victim@su10.ru', password: 'Victim-Pass-7' },
  racer: { id: '88888888-8888-4888-8888-888888888888', email: 'racer@su10.ru', password: 'Racer-Pass-8-long' },
}
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// База — как в Яндексе под одной учёткой: всё принадлежит api_login, правила по строкам действуют и на неё.
const SETUP_SQL = `
create role api_login login password '${DB_PASSWORD}';
grant create, connect on database psdc_test to api_login;
grant create on schema public to api_login;
set role api_login;
${fs.readFileSync(path.join(ROOT, 'migration', 'target', 'compat', 'auth.sql'), 'utf8')}
create schema osp_private;
create function osp_private.bypass() returns boolean language sql stable
  as $$ select coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' or coalesce(auth.role(), '') = 'service_role' $$;
create function osp_private.role_in(variadic p_roles text[]) returns boolean language sql stable
  as $$ select coalesce(nullif(auth.role(), ''), 'anon') = any (p_roles) $$;
create table auth.users (id uuid primary key, aud text, role text, email text, email_confirmed_at timestamptz,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz, raw_user_meta_data jsonb);
alter table auth.users enable row level security; alter table auth.users force row level security;
create policy osp_internal on auth.users for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
create table public.counterparties (id uuid primary key, name text);
create table public.roles (key text primary key, label text);
insert into public.roles values ('admin', 'Администратор'), ('engineer', 'Инженер'), ('contractor', 'Подрядчик');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, email text, full_name text, work_phone text, requested_company text,
  counterparty_id uuid references public.counterparties(id), object_ids uuid[] not null default '{}', last_login_at timestamptz,
  is_blocked boolean not null default false, constraint user_roles_blocked_not_approved check (not (is_blocked and is_approved)));
alter table public.user_roles enable row level security; alter table public.user_roles force row level security;
create policy osp_internal on public.user_roles for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
create policy roles_self on public.user_roles for select to public
  using (case when (select osp_private.bypass()) then true else ((select osp_private.role_in('authenticated')) and user_id = auth.uid()) end);
create table public.superadmins (user_id uuid primary key);
alter table public.superadmins enable row level security; alter table public.superadmins force row level security;
create policy osp_internal on public.superadmins for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
-- Функция удаления — как на проде (prod-schema.sql), с отметкой пропуска, как ставит загрузка под одну учётку.
create function public.admin_delete_user(target_user_id uuid) returns void language plpgsql security definer
  set search_path = public, auth set application_name = 'osp:internal' as $$
declare v_caller_role text;
begin
  select role into v_caller_role from public.user_roles where user_id = auth.uid() and is_approved = true limit 1;
  if v_caller_role is distinct from 'admin' then raise exception 'Insufficient privileges: only admin can delete users'; end if;
  if target_user_id = auth.uid() then raise exception 'Cannot delete yourself'; end if;
  delete from public.user_roles where user_id = target_user_id;
  delete from auth.users where id = target_user_id;
end $$;
${fs.readFileSync(MIGRATION, 'utf8')}
`

describe('свой вход на настоящей базе', { skip, timeout: 600000 }, () => {
  let pgdb
  let dbUrl
  let pg
  let buildApp
  let defaultDeps
  let createSecretBox
  let bcrypt
  let blocklist
  let upstream
  let app
  let logs
  let box
  let verifierHook = null

  const sql = (text) => pgdb.exec(`set role api_login;\n${text}`)
  const one = (text) => sql(text).trim().split('\n').filter(Boolean).at(-1) ?? ''
  const asMark = (mark, text) => one(`set application_name = '${mark}';\n${text}`)

  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0,
    supabaseUrl: SUPA_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: '', supabaseJwtSecret: SECRET,
    s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' },
    anthropicApiKey: '', ratesApiKeys: [], required: ['db', 'gateway', 'auth'],
    db: { url: dbUrl, caFile: '', poolMax: 4, secondLockRole: '' },
    dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: 'api_login', readOnlyFile: '' },
    authMode: 'own',
    auth: { keys: KEYS, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
    userStatusTtlMs: 0, authCleanup: false,
    ...over,
    ...(over.auth ? { auth: { keys: KEYS, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0, ...over.auth } } : {}),
  })

  async function makeApp(over = {}, limits) {
    await app?.close()
    logs = []
    const deps = {
      ...defaultDeps, blocklist,
      // Проверка пароля с крючком: тест может «задержать» вход между проверкой и записью.
      createPasswordVerifier: () => {
        const real = defaultDeps.createPasswordVerifier ? defaultDeps.createPasswordVerifier() : null
        return {
          verify: async (pw, stored) => {
            const result = await (real || realVerifier).verify(pw, stored)
            if (verifierHook) await verifierHook()
            return result
          },
          hash: (pw) => (real || realVerifier).hash(pw),
        }
      },
    }
    app = null
    app = buildApp({ config: config(over), deps, limits: limits ? { ...DEFAULT_LIMITS, ...limits } : undefined,
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } } })
    await app.ready()
    return app
  }
  let realVerifier
  let DEFAULT_LIMITS

  const jsonHeaders = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
  const login = (email, password, headers = {}) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { ...jsonHeaders, ...headers } })
  function cookiesOf(res) {
    const raw = [].concat(res.headers['set-cookie'] || [])
    const get = (name) => raw.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=')[1] ?? null
    return { raw, session: get('__Host-osp_session'), csrf: get('__Host-osp_csrf') }
  }
  // Заголовки вошедшего: cookie; для меняющего запроса — CSRF и источник.
  const as = (c, { unsafe = false, extra = {} } = {}) => ({
    cookie: `__Host-osp_session=${c.session}; __Host-osp_csrf=${c.csrf}`,
    ...(unsafe ? { 'x-osp-csrf': c.csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
    ...extra,
  })
  const loginOk = async (u, password = u.password) => {
    const res = await login(u.email, password)
    assert.equal(res.statusCode, 200, res.body)
    return cookiesOf(res)
  }
  const internalTokens = () => upstream.seen.map((r) => JSON.parse(Buffer.from(r.auth.replace('Bearer ', '').split('.')[1], 'base64url').toString('utf8')))

  async function putCredential(user, hash, { mustChange = false, source = 'supabase' } = {}) {
    const secret = box.encrypt(hash, user.id)
    asMark('osp:auth', `insert into osp_auth.credentials (user_id, secret, algo, source, must_change)
      values ('${user.id}', '${secret}', '${hash.startsWith('$scrypt') ? 'scrypt' : 'bcrypt'}', '${source}', ${mustChange})
      on conflict (user_id) do update set secret = excluded.secret, algo = excluded.algo, version = osp_auth.credentials.version + 1`)
  }

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ createSecretBox } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'secretBox.js')))
    ;({ DEFAULT_LIMITS } = await import(path.join(SERVER, 'src', 'lib', 'limits.js')))
    const { loadBlocklist } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'policy.js'))
    const { createPasswordVerifier } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'passwords.js'))
    realVerifier = createPasswordVerifier()
    bcrypt = (await import(path.join(SERVER, 'node_modules', 'bcryptjs', 'index.js'))).default
    pg = (await import(path.join(SERVER, 'node_modules', 'pg', 'lib', 'index.js'))).default
    blocklist = loadBlocklist()
    box = createSecretBox(KEYS)

    // «PostgREST»: запоминает, что дошло, и отвечает пусто.
    upstream = { seen: [] }
    upstream.server = http.createServer((req, res) => {
      upstream.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' })
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') })
    })
    await new Promise((r) => upstream.server.listen(0, '127.0.0.1', r))
    upstream.url = `http://127.0.0.1:${upstream.server.address().port}`

    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL)
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`

    const users = Object.values(U).map((u) => `('${u.id}', 'authenticated', 'authenticated', '${u.email}', now(), now(), now(), '{}')`).join(',\n')
    asMark('osp:internal', `insert into public.counterparties values ('${ORG}', 'ООО Подряд');
      insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data) values ${users};
      update auth.users set raw_user_meta_data = '{"kind":"contractor","company":"ООО Новый","full_name":"Подрядчиков П.","phone":"+7 900"}' where id = '${U.norole.id}';
      insert into public.user_roles (user_id, role, is_approved, is_blocked, email, full_name) values
        ('${U.legacy.id}', 'engineer', true, false, '${U.legacy.email}', 'Легаси Пользователь'),
        ('${U.admin.id}', 'admin', true, false, '${U.admin.email}', 'Админ'),
        ('${U.unapproved.id}', 'engineer', false, false, '${U.unapproved.email}', null),
        ('${U.blocked.id}', 'engineer', false, true, '${U.blocked.email}', null),
        ('${U.superadmin.id}', 'engineer', false, false, '${U.superadmin.email}', 'Главный'),
        ('${U.victim.id}', 'engineer', true, false, '${U.victim.email}', 'Жертва'),
        ('${U.racer.id}', 'engineer', true, false, '${U.racer.email}', 'Гонщик');
      insert into public.superadmins values ('${U.superadmin.id}');
      select 1`)
    // Пароли — как перенесёт accounts-sync: bcrypt из Supabase ($2a$10$), зашифрованные ключом сервера.
    for (const u of Object.values(U)) putCredential(u, (await bcrypt.hash(u.password, 10)).replace(/^\$2b\$/, '$2a$'))
    asMark('osp:auth', `insert into osp_auth.meta (key, value) values ('canary', '${box.encrypt('osp-auth-canary', 'osp-auth-canary')}')`)
    await makeApp()
  })

  after(async () => {
    await app?.close()
    upstream?.server.close()
    pgdb?.stop()
  })

  it('вход прежним паролем Supabase: cookie __Host-, отпечаток пересчитан в scrypt, сессия в базе — только хэшем', async () => {
    const res = await login(U.legacy.email.toLowerCase(), U.legacy.password)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { user: { id: U.legacy.id, email: U.legacy.email }, mustChange: false })
    const c = cookiesOf(res)
    assert.match(c.raw.find((x) => x.startsWith('__Host-osp_session=')), /; Path=\/; Max-Age=2592000; Secure; SameSite=Lax; HttpOnly$/)
    assert.match(c.raw.find((x) => x.startsWith('__Host-osp_csrf=')), /; Path=\/; Max-Age=2592000; Secure; SameSite=Lax$/)
    // Пересчитан тот же пароль: источник прежний (supabase) — повторный перенос учёток ещё может его обновить.
    assert.equal(asMark('osp:auth', `select algo || ':' || source || ':' || version from osp_auth.credentials where user_id = '${U.legacy.id}'`), 'scrypt:supabase:2')
    const hash = crypto.createHash('sha256').update(c.session).digest('hex')
    assert.equal(asMark('osp:internal', `select count(*) from osp_session.sessions where id_hash = '${hash}' and user_id = '${U.legacy.id}'`), '1')
    assert.equal(asMark('osp:internal', `select count(*) from osp_session.sessions where id_hash = '${c.session}'`), '0', 'сам id в базе не хранится')
    assert.equal(asMark('osp:internal', `select last_login_at is not null from public.user_roles where user_id = '${U.legacy.id}'`), 't')
    // Второй вход — уже по scrypt.
    const again = await loginOk(U.legacy)
    assert.notEqual(again.session, c.session, 'новый вход — новый id')
  })

  it('неудача — один ответ для неверного пароля, несуществующей и заблокированной учётки; статус — только после верного пароля', async () => {
    const wrong = await login(U.legacy.email, 'Wrong-Password-x')
    const nobody = await login('nobody@su10.ru', 'Wrong-Password-x')
    const blockedWrong = await login(U.blocked.email, 'Wrong-Password-x')
    for (const r of [wrong, nobody, blockedWrong]) {
      assert.equal(r.statusCode, 400)
      assert.deepEqual(r.json(), { error: 'Invalid login credentials', code: 'invalid_credentials' })
      assert.equal(cookiesOf(r).session, null)
    }
    assert.deepEqual((await login(U.blocked.email, U.blocked.password)).json().code, 'ACCOUNT_BLOCKED')
    assert.deepEqual((await login(U.unapproved.email, U.unapproved.password)).json().code, 'PENDING_APPROVAL')
    asMark('osp:auth', `delete from osp_auth.login_failures`)
  })

  it('учётка без заявки: заявка создаётся по данным регистрации (подрядчик — с компанией), входа нет', async () => {
    const res = await login(U.norole.email, U.norole.password)
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().code, 'PENDING_APPROVAL')
    assert.equal(asMark('osp:internal', `select role || '|' || is_approved || '|' || requested_company || '|' || full_name from public.user_roles where user_id = '${U.norole.id}'`),
      'contractor|false|ООО Новый|Подрядчиков П.')
  })

  it('суперадминистратор входит и без одобренной заявки', async () => {
    const c = await loginOk(U.superadmin)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })
    assert.equal(me.statusCode, 200)
    assert.deepEqual(me.json(), { user: { id: U.superadmin.id, email: U.superadmin.email }, isSuperadmin: true, mustChange: false })
  })

  it('перебор: после 5 неудач пауза растёт, верный пароль её не обходит; несуществующая почта считается так же; успех сбрасывает', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await login(U.victim.email, `bad-${i}-password`)).statusCode, 400)
    const fifth = await login(U.victim.email, 'bad-5-password')
    assert.equal(fifth.statusCode, 429)
    assert.ok(Number(fifth.headers['retry-after']) >= 1)
    assert.equal((await login(U.victim.email, U.victim.password)).statusCode, 429, 'во время паузы и верный пароль не проходит')
    for (let i = 0; i < 5; i++) await login('ghost@su10.ru', `bad-${i}-password`)
    assert.equal((await login('ghost@su10.ru', 'bad-x-password')).statusCode, 429, 'несуществующая почта — та же пауза: не узнать, есть ли учётка')
    // Пауза истекла (сдвигаем время в базе) — верный пароль проходит, счётчик сброшен.
    asMark('osp:auth', `update osp_auth.login_failures set locked_until = now() - interval '1 second' where email_norm = 'victim@su10.ru'`)
    await loginOk(U.victim)
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.login_failures where email_norm = 'victim@su10.ru'`), '0')
    asMark('osp:auth', 'delete from osp_auth.login_failures')
  })

  it('лимит по адресу клиента: адрес берётся только от своего прокси (OSP_TRUST_PROXY=peer), подложенный заголовок без доверия не учитывается', async () => {
    const limits = { loginPerIp: { max: 2, windowMs: 60_000 } }
    // Каждая попытка — новая почта: счётчик по почте здесь ни при чём, проверяем только лимит по адресу.
    let n = 0
    const from = (ip) => login(`nobody${++n}@su10.ru`, 'Wrong-Password-x', { 'x-forwarded-for': ip })
    try {
      await makeApp({ trustProxy: 'peer' }, limits)
      assert.equal((await from('198.51.100.1')).statusCode, 400)
      assert.equal((await from('198.51.100.1')).statusCode, 400)
      assert.equal((await from('198.51.100.1')).statusCode, 429, 'третья попытка с того же адреса')
      assert.equal((await from('198.51.100.2')).statusCode, 400, 'другой клиент — свой лимит')
      // Без доверия к прокси X-Forwarded-For не читается: все — один адрес соединения.
      await makeApp({}, limits)
      assert.equal((await from('203.0.113.1')).statusCode, 400)
      assert.equal((await from('203.0.113.2')).statusCode, 400)
      assert.equal((await from('203.0.113.3')).statusCode, 429, 'подложенные адреса не дают обойти лимит')
    } finally {
      asMark('osp:auth', 'delete from osp_auth.login_failures')
      await makeApp()
    }
  })

  it('вход только с самого портала: чужой Origin, Sec-Fetch-Site: same-site, не-JSON — отказ', async () => {
    assert.equal((await login(U.legacy.email, U.legacy.password, { origin: 'https://evil.su10.ru' })).statusCode, 403)
    assert.equal((await login(U.legacy.email, U.legacy.password, { 'sec-fetch-site': 'same-site' })).statusCode, 403)
    const form = await app.inject({ method: 'POST', url: '/api/auth/login', payload: `email=${U.legacy.email}&password=x`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } })
    assert.ok([400, 415].includes(form.statusCode), String(form.statusCode))
  })

  it('сессия: шлюз и /me по cookie; меняющий запрос — только с CSRF и с самого портала; повторённая cookie — отказ', async () => {
    const c = await loginOk(U.legacy)
    upstream.seen.length = 0
    const read = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: as(c) })
    assert.equal(read.statusCode, 200)
    const token = internalTokens().at(-1)
    assert.equal(token.sub, U.legacy.id)
    assert.equal(token.osp_role, 'authenticated')
    const write = (headers) => app.inject({ method: 'PATCH', url: '/api/db/tenders?id=eq.x', payload: '{"title":"x"}', headers })
    assert.equal((await write(as(c))).statusCode, 403, 'без CSRF')
    assert.equal((await write({ ...as(c, { unsafe: true }), 'x-osp-csrf': 'not-the-token-xxxxxxxx' })).statusCode, 403, 'чужой CSRF')
    assert.equal((await write({ ...as(c, { unsafe: true }), 'sec-fetch-site': 'same-site' })).statusCode, 403, 'соседний сайт')
    assert.equal((await write({ ...as(c, { unsafe: true }), origin: 'https://evil.test' })).statusCode, 403, 'чужой источник')
    upstream.seen.length = 0
    assert.equal((await write(as(c, { unsafe: true }))).statusCode, 200)
    assert.equal(upstream.seen.length, 1, 'дошёл до PostgREST только правильный запрос')
    const dup = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `__Host-osp_session=${c.session}; __Host-osp_session=${'z'.repeat(43)}` } })
    assert.equal(dup.statusCode, 400)
    assert.equal(dup.json().code, 'OSP_COOKIE_DUPLICATE')
    const anon = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id' })
    assert.equal(anon.statusCode, 200, 'без cookie — аноним, как раньше')
    assert.equal(internalTokens().at(-1).osp_role, 'anon')
  })

  it('блокировка прямым изменением user_roles (как из «Администрирования») отзывает сессию триггером', async () => {
    const c = await loginOk(U.racer)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })).statusCode, 200)
    asMark('osp:internal', `update public.user_roles set is_blocked = true, is_approved = false where user_id = '${U.racer.id}'`)
    assert.equal(asMark('osp:internal', `select count(*) from osp_session.sessions where user_id = '${U.racer.id}' and revoked_at is null`), '0')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })
    assert.equal(me.statusCode, 401)
    assert.equal(me.json().code, 'OSP_SESSION_REVOKED')
    assert.match([].concat(me.headers['set-cookie']).join('|'), /__Host-osp_session=; Path=\/; Max-Age=0/)
    const db = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: as(c) })
    assert.equal(db.statusCode, 401)
    asMark('osp:internal', `update public.user_roles set is_blocked = false, is_approved = true where user_id = '${U.racer.id}'`)
  })

  it('гонка: пароль сменили, пока шла проверка, — вход по старому паролю сессии не получает', async () => {
    let release
    const held = new Promise((r) => { release = r })
    let reached
    const atHook = new Promise((r) => { reached = r })
    verifierHook = async () => { verifierHook = null; reached(); await held }
    const pending = login(U.racer.email, U.racer.password)
    let timer
    await Promise.race([atHook, pending.then((r) => { throw new Error(`вход не дошёл до проверки пароля: ${r.statusCode} ${r.body}`) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('вход не дошёл до проверки пароля за 20 с')), 20000) })])
      .finally(() => { clearTimeout(timer); verifierHook = null })
    // Пока вход «думает», администратор сбрасывает пароль.
    const admin = await loginOk(U.admin)
    const reset = await app.inject({ method: 'POST', url: '/api/auth/admin/reset-password', payload: { userId: U.racer.id }, headers: as(admin, { unsafe: true }) })
    assert.equal(reset.statusCode, 200, reset.body)
    release()
    const res = await pending
    // Вход перепроверил по новой версии: старый пароль больше не подходит.
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(cookiesOf(res).session, null)
    assert.equal(asMark('osp:internal', `select count(*) from osp_session.sessions where user_id = '${U.racer.id}' and revoked_at is null`), '0')
    asMark('osp:auth', 'delete from osp_auth.login_failures')
  })

  it('учётка от администратора: временный пароль один раз; до смены — только смена пароля, /me и выход; правила нового пароля', async () => {
    const admin = await loginOk(U.admin)
    const created = await app.inject({ method: 'POST', url: '/api/auth/admin/users', headers: as(admin, { unsafe: true }),
      payload: { email: '  New.Person@su10.ru ', fullName: 'Новиков Николай', role: 'engineer' } })
    assert.equal(created.statusCode, 200, created.body)
    const { user, temporaryPassword } = created.json()
    assert.equal(user.email, 'New.Person@su10.ru')
    assert.equal(temporaryPassword.length, 20)
    assert.equal(asMark('osp:internal', `select is_approved || ':' || role from public.user_roles where user_id = '${user.id}'`), 'true:engineer')
    const dupe = await app.inject({ method: 'POST', url: '/api/auth/admin/users', headers: as(admin, { unsafe: true }),
      payload: { email: 'new.person@SU10.ru', fullName: 'Дубль', role: 'engineer' } })
    assert.equal(dupe.statusCode, 409, 'почта (после нормализации) уже занята')
    const noOrg = await app.inject({ method: 'POST', url: '/api/auth/admin/users', headers: as(admin, { unsafe: true }),
      payload: { email: 'podr@example.ru', fullName: 'Подрядчик', role: 'contractor' } })
    assert.equal(noOrg.statusCode, 400)

    const res = await login('new.person@su10.ru', temporaryPassword)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().mustChange, true)
    const c = cookiesOf(res)
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: as(c) })).json().code, 'OSP_PASSWORD_CHANGE_REQUIRED')
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })).json().mustChange, true)
    const change = (newPassword, currentPassword = temporaryPassword) => app.inject({ method: 'POST', url: '/api/auth/password',
      payload: { currentPassword, newPassword }, headers: as(c, { unsafe: true }) })
    assert.equal((await change('коротко')).json().code, 'password_too_short')
    assert.equal((await change([...blocklist][0])).json().code, 'password_common')
    assert.equal((await change('Новиков Николай 2025')).json().code, 'password_personal')
    assert.equal((await change('new.person@su10.ru')).json().code, 'password_personal')
    assert.equal((await change('новая длинная фраза-пароль', 'not-the-temporary')).json().code, 'current_password_invalid')
    const ok = await change('новая длинная фраза-пароль')
    assert.equal(ok.statusCode, 200, ok.body)
    const fresh = cookiesOf(ok)
    assert.notEqual(fresh.session, c.session)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })).statusCode, 401, 'прежняя сессия отозвана')
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: as(fresh) })).statusCode, 200)
    assert.equal((await login('new.person@su10.ru', temporaryPassword)).statusCode, 400, 'временный пароль больше не действует')
    await loginOk({ email: 'new.person@su10.ru' }, 'новая длинная фраза-пароль')
    asMark('osp:auth', 'delete from osp_auth.login_failures')
  })

  it('не администратор не заводит учёток и не сбрасывает пароли', async () => {
    const c = await loginOk(U.legacy, (await (async () => {
      // У legacy после первого теста свой пароль тот же — отпечаток пересчитан, пароль прежний.
      return U.legacy.password
    })()))
    const create = await app.inject({ method: 'POST', url: '/api/auth/admin/users', headers: as(c, { unsafe: true }),
      payload: { email: 'x@su10.ru', fullName: 'Икс', role: 'engineer' } })
    assert.equal(create.statusCode, 403)
    const reset = await app.inject({ method: 'POST', url: '/api/auth/admin/reset-password', headers: as(c, { unsafe: true }), payload: { userId: U.admin.id } })
    assert.equal(reset.statusCode, 403)
  })

  it('удаление учётки: надгробие и функция базы — одной транзакцией; отказ функции — надгробия нет; в PostgREST запрос не идёт', async () => {
    const admin = await loginOk(U.admin)
    upstream.seen.length = 0
    const rpc = (headers, target) => app.inject({ method: 'POST', url: '/api/db/rpc/admin_delete_user', payload: JSON.stringify({ target_user_id: target }),
      headers: { ...headers, 'content-type': 'application/json' } })
    const self = await rpc(as(admin, { unsafe: true }), U.admin.id)
    assert.equal(self.statusCode, 400)
    assert.match(self.json().message, /Cannot delete yourself/)
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.tombstones where user_id = '${U.admin.id}'`), '0', 'отказ функции — надгробие откатилось')
    const legacy = await loginOk(U.legacy)
    const notAdmin = await rpc(as(legacy, { unsafe: true }), U.victim.id)
    assert.equal(notAdmin.statusCode, 400)
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.tombstones`), '0')

    const victim = await loginOk(U.victim)
    const del = await rpc(as(admin, { unsafe: true }), U.victim.id)
    assert.equal(del.statusCode, 204, del.body)
    assert.equal(upstream.seen.length, 0)
    assert.equal(asMark('osp:auth', `select email_norm || ':' || deleted_by from osp_auth.tombstones where user_id = '${U.victim.id}'`), `victim@su10.ru:${U.admin.id}`)
    assert.equal(asMark('osp:internal', `select count(*) from auth.users where id = '${U.victim.id}'`), '0')
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.credentials where user_id = '${U.victim.id}'`), '0', 'пароль — каскадом')
    assert.equal(asMark('osp:internal', `select count(*) from osp_session.sessions where user_id = '${U.victim.id}'`), '0', 'сессии — каскадом')
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(victim) })).statusCode, 401)
  })

  it('выход: отзывает сессию; «выйти везде» — все; без CSRF не отзывает', async () => {
    const a = await loginOk(U.legacy)
    const b = await loginOk(U.legacy)
    const noCsrf = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { ...as(a), 'content-type': 'application/json' } })
    assert.equal(noCsrf.statusCode, 403)
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: as(a, { unsafe: true }) })
    assert.equal(out.statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(a) })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(b) })).statusCode, 200, 'другая сессия жива')
    const c = await loginOk(U.legacy)
    const all = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { all: true }, headers: as(c, { unsafe: true }) })
    assert.equal(all.statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(b) })).statusCode, 401, 'все сессии отозваны')
  })

  it('режим own: токен Supabase отклоняется (OSP_AUTH_MODE); режим both: свой вход — только пилоту, токен Supabase принимается', async () => {
    const bearer = { authorization: `Bearer ${userToken(SUPA_URL, U.legacy.id)}` }
    const own = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: bearer })
    assert.equal(own.statusCode, 401)
    assert.equal(own.json().code, 'OSP_AUTH_MODE')
    await makeApp({ authMode: 'both', auth: { pilotIds: [U.admin.id] }, required: ['supabase', 'db', 'gateway', 'auth'] })
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: bearer })).statusCode, 200)
    const blockedBearer = await app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: { authorization: `Bearer ${userToken(SUPA_URL, U.blocked.id)}` } })
    assert.equal(blockedBearer.statusCode, 403, 'заблокированный не проходит и с живым токеном Supabase')
    const notPilot = await login(U.legacy.email, U.legacy.password)
    assert.equal(notPilot.statusCode, 403)
    assert.equal(notPilot.json().code, 'OSP_AUTH_PILOT')
    await loginOk(U.admin)
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/config' })).json(), { mode: 'both', ownLogin: false })
    await makeApp()
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/auth/config' })).json(), { mode: 'own', ownLogin: true })
  })

  it('готовность: канарейка и ключи; неверный ключ или неизвестный ключ строки — 503; без Supabase в own — 200', async () => {
    const ready = async () => (await app.inject({ method: 'GET', url: '/api/ready' }))
    let r = await ready()
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().checks.auth, 'ok')
    await makeApp({ supabaseUrl: '', supabaseAnonKey: '', supabaseJwtSecret: '' })
    r = await ready()
    assert.equal(r.statusCode, 200, `own работает без Supabase: ${r.body}`)
    await makeApp({ auth: { keys: `t1:${crypto.randomBytes(32).toString('base64')}` } })
    r = await ready()
    assert.equal(r.statusCode, 503)
    assert.equal(r.json().checks.auth, 'fail')
    await makeApp({ auth: { keys: `t2:${crypto.randomBytes(32).toString('base64')},${KEYS}` } })
    assert.equal((await ready()).statusCode, 200, 'новый текущий ключ + прежний для расшифровки — годно')
    await makeApp({ auth: { keys: `t2:${crypto.randomBytes(32).toString('base64')}` } })
    assert.equal((await ready()).statusCode, 503, 'строки под ключом t1, а его нет — не годно')
    await makeApp()
    assert.throws(() => buildApp({ config: config({ auth: { keys: '' } }) }), /OSP_AUTH_KEYS/)
    assert.throws(() => buildApp({ config: config({ authMode: 'both' }) }), /OSP_AUTH_PILOT_IDS/)
    assert.throws(() => buildApp({ config: config({ dbGateway: { upstream: '' } }) }), /шлюз данных/)
  })

  it('отметки: пароли не видны пропуску служебных функций; отметка osp:auth не видит портал; ставит её только модуль входа', async () => {
    assert.equal(asMark('osp:internal', 'select count(*) from osp_auth.credentials'), '0')
    assert.ok(Number(asMark('osp:auth', 'select count(*) from osp_auth.credentials')) > 0)
    assert.equal(asMark('osp:auth', 'select count(*) from public.user_roles'), '0')
    assert.equal(asMark('osp:auth', 'select count(*) from auth.users'), '0')
    assert.equal(asMark('osp-postgrest', 'select count(*) from osp_session.sessions'), '0', 'без пропуска сессий не видно')
    // В коде сервера отметка 'auth' — только в модуле входа.
    const offenders = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.js') && /mark\(\s*['"]auth['"]\s*\)|['"]osp:auth['"]/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(SERVER, p))
      }
    }
    walk(path.join(SERVER, 'src'))
    assert.deepEqual(offenders.filter((f) => !f.startsWith(path.join('src', 'lib', 'auth')) && f !== path.join('src', 'lib', 'db.js')), [])
  })

  it('очистка: просроченные сессии, давние неудачи без блокировки и старый журнал удаляются; надгробия — нет', async () => {
    const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
    const { createSessions } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'sessions.js'))
    const { createAuthService } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'service.js'))
    const db = createDb({ url: dbUrl, caFile: '' })
    try {
      const service = createAuthService({ db, box, verifier: realVerifier, sessions: createSessions({ db }), blocklist })
      asMark('osp:internal', `insert into osp_session.sessions (id_hash, user_id, csrf, idle_expires_at, absolute_expires_at, created_at)
        values ('${'a'.repeat(64)}', '${U.legacy.id}', 'c', now() - interval '20 days', now() - interval '10 days', now() - interval '40 days')`)
      asMark('osp:auth', `insert into osp_auth.login_failures (email_norm, failures, last_at, locked_until) values
          ('old@x', 1, now() - interval '2 days', null), ('locked@x', 9, now() - interval '2 days', now() + interval '1 hour');
        insert into osp_auth.events (at, kind) values (now() - interval '200 days', 'login');
        insert into osp_auth.tombstones (user_id, deleted_at) values (gen_random_uuid(), now() - interval '400 days')`)
      const n = await service.cleanup()
      assert.ok(n.sessions >= 1 && n.failures === 1 && n.events === 1, JSON.stringify(n))
      assert.equal(asMark('osp:auth', "select count(*) from osp_auth.login_failures where email_norm = 'locked@x'"), '1', 'действующая блокировка осталась')
      assert.ok(Number(asMark('osp:auth', 'select count(*) from osp_auth.tombstones')) >= 1)
    } finally {
      await db.close()
    }
  })

  it('в ответах и журнале нет паролей, отпечатков и id сессии', async () => {
    const c = await loginOk(U.legacy)
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })
    await login(U.legacy.email, 'Wrong-Password-for-log')
    const text = logs.join('\n')
    for (const secret of [U.legacy.password, 'Wrong-Password-for-log', c.session, c.csrf, AUTH_KEY, DB_PASSWORD]) {
      assert.ok(!text.includes(secret), 'в журнале секрет')
    }
    assert.ok(!text.includes('$2a$') && !text.includes('$scrypt$'), 'в журнале отпечаток')
  })
})
