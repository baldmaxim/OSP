// Регистрация подрядчика на сайте на настоящем PostgreSQL: настоящие миграции 20261019_own_auth и 20261203_contractor_signup,
// база — как в Яндексе под одной учёткой. Письма и почтовый сервер — подделка, остальное настоящее. Проверяем обещанное:
//   • закрыта по умолчанию; меняющие запросы — только с портала, задача на вычисление, ловушка, лимиты;
//   • до подтверждения почты нет ни учётки, ни контрагента; пароль задаёт только хозяин почты; ссылка одноразовая, подтверждение не даёт входа;
//   • ответ не выдаёт, занят ли адрес; чёрный список не раскрывается;
//   • ЧС и связи с ЧС — на проверку; компания из реестра — только через почту компании; после ЧС доступ закрывается сам;
//   • учётка с регистрации: только подрядчик, только короткий список шлюза, файлов нет;
//   • восстановление пароля — только учётки с регистрации;
//   • в журнал не попадают ни пароль, ни ссылки, ни данные формы.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const depsOk = ['pg', 'fastify', 'nodemailer'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'signup-test-db-password'
const GATEWAY_SECRET = 'signup-gateway-secret-0123456789-abcdefghijkl'
const ORIGIN = 'https://tender.test'
const KEYS = `t1:${crypto.randomBytes(32).toString('base64')}`
const PASSWORD = 'длинная фраза для входа подрядчика'
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', email: 'admin@su10.ru', password: 'Admin-Pass-Для-Теста-1' }
const EMPLOYEE = { id: '33333333-3333-4333-8333-333333333333', email: 'engineer@su10.ru', password: 'Engineer-Pass-Для-Теста-2' }
const CP = {
  existing: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  nomail: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  black: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  friend: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
}
// Корректные по контрольной сумме ИНН.
const INN = {
  fresh: '7707083893', fresh2: '7736050003', existing: '7702070139', nomail: '7728168971', black: '7710140679', friend: '7704340310',
  sameMail: '7743013901', samePhone: '7728029110', sameDomain: '7842155505', sameName: '7705031674', ip: '500100732259',
}

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
create type public.counterparty_status as enum ('active', 'limited', 'blacklist');
create table public.counterparties (id uuid primary key default gen_random_uuid(), name text not null, inn text, kpp text,
  status public.counterparty_status default 'active', deleted_at timestamptz, updated_at timestamptz default now());
create table public.counterparty_contacts (id uuid primary key default gen_random_uuid(), counterparty_id uuid references public.counterparties(id),
  full_name text not null, phone text, email text);
create table public.counterparty_relations (id uuid primary key default gen_random_uuid(), counterparty_id uuid not null, related_counterparty_id uuid not null);
do $$ declare t text; begin
  foreach t in array array['counterparties', 'counterparty_contacts', 'counterparty_relations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy osp_internal on public.%I for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()))', t);
  end loop;
end $$;
create table public.roles (key text primary key, label text);
insert into public.roles values ('admin', 'Администратор'), ('engineer', 'Инженер'), ('contractor', 'Подрядчик');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, email text, full_name text, work_phone text, requested_company text,
  counterparty_id uuid references public.counterparties(id), object_ids uuid[] not null default '{}', last_login_at timestamptz,
  is_blocked boolean not null default false, blocked_at timestamptz, blocked_by_name text,
  constraint user_roles_blocked_not_approved check (not (is_blocked and is_approved)));
alter table public.user_roles enable row level security; alter table public.user_roles force row level security;
create policy osp_internal on public.user_roles for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
create table public.superadmins (user_id uuid primary key);
alter table public.superadmins enable row level security; alter table public.superadmins force row level security;
create policy osp_internal on public.superadmins for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
${fs.readFileSync(path.join(ROOT, 'migration', 'yandex', '20261019_own_auth.sql'), 'utf8')}
${fs.readFileSync(path.join(ROOT, 'migration', 'yandex', '20261203_contractor_signup.sql'), 'utf8')}
`

const jsonHeaders = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }

describe('регистрация подрядчика на настоящей базе', { skip, timeout: 600000 }, () => {
  let pgdb
  let dbUrl
  let buildApp
  let defaultDeps
  let createProofOfWork
  let createPasswordVerifier
  let loadBlocklist
  let createSecretBox
  let DEFAULT_LIMITS
  let upstream
  let app
  let logs
  let sent
  let box
  let domainOk

  const sql = (text) => pgdb.exec(`set role api_login;\n${text}`)
  const one = (text) => sql(text).trim().split('\n').filter(Boolean).at(-1) ?? ''
  const asMark = (mark, text) => one(`set application_name = '${mark}';\n${text}`)

  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0,
    supabaseUrl: '', supabaseAnonKey: '', supabaseServiceKey: '', supabaseJwtSecret: '',
    s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' },
    anthropicApiKey: '', ratesApiKeys: [], required: ['db', 'gateway', 'auth'],
    db: { url: dbUrl, caFile: '', poolMax: 4, secondLockRole: '' },
    dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: 'api_login', readOnlyFile: '' },
    authMode: 'own',
    auth: { keys: KEYS, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
    userStatusTtlMs: 0, authCleanup: false,
    signup: { enabled: true, mailFrom: 'portal@su10.test', replyTo: 'reply@su10.test', notifyEmail: 'dept@su10.test', smtpUrl: '' },
    ...over,
  })

  const blocklistOnce = () => { blocklistOnce.value ??= loadBlocklist(); return blocklistOnce.value }

  async function makeApp(over = {}, limits, signupOptions) {
    await app?.close()
    logs = []
    sent = []
    const deps = {
      ...defaultDeps, blocklist: blocklistOnce(),
      createPasswordVerifier: () => createPasswordVerifier(),
      createMailTransport: () => ({ sendMail: async (m) => { sent.push(m) } }),
      domainAcceptsMail: async (domain) => domainOk(domain),
      proofOfWork: createProofOfWork({ bits: 2 }),
      outboxOptions: { tickMs: 3_600_000 },
      noBidPositions: true,
      signupOptions,
    }
    app = null
    // Лимиты по адресу проверяет отдельный тест: здесь все запросы — с одного адреса.
    const roomy = { max: 100_000, windowMs: 60_000 }
    app = buildApp({ config: config(over), deps,
      limits: { ...DEFAULT_LIMITS, signupPerIp: roomy, signupTotal: roomy, signupChallengePerIp: roomy, signupTokenPerIp: roomy, ...limits },
      logger: { level: 'info', stream: { write: (line) => logs.push(line) } } })
    await app.ready()
    return app
  }

  function solve(challenge, bits) {
    for (let n = 0; ; n++) {
      const hash = crypto.createHash('sha256').update(`${challenge}:${n}`).digest()
      let zero = 0
      for (const b of hash) { if (b === 0) { zero += 8; continue } zero += Math.clz32(b) - 24; break }
      if (zero >= bits) return String(n)
    }
  }
  async function proof() {
    const res = await app.inject({ method: 'GET', url: '/api/auth/register/challenge' })
    assert.equal(res.statusCode, 200, res.body)
    const { challenge, bits } = res.json()
    return { challenge, answer: solve(challenge, bits) }
  }
  const form = (over = {}) => ({
    email: 'ivanov@stroy-fresh.ru', companyName: 'ООО «Новая стройка»', inn: INN.fresh, kpp: '770101001',
    contactName: 'Иванов Иван Иванович', phone: '+7 916 123-45-67', consent: true, ...over,
  })
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers: { ...jsonHeaders, ...headers } })
  const register = async (over = {}) => post('/api/auth/register', { ...form(over), ...(await proof()) })
  const login = (email, password = PASSWORD) => post('/api/auth/login', { email, password })

  async function mails() {
    await app.mailOutbox.drain()
    return sent
  }
  const linkIn = (text, kind) => new RegExp(`${ORIGIN}/partner/${kind}#t=([A-Za-z0-9_-]{43})`).exec(text)?.[1] ?? null
  // Заявка + токен из письма.
  async function registerAndGetToken(over = {}) {
    const email = over.email || form().email
    const res = await register(over)
    assert.equal(res.statusCode, 202, res.body)
    await app.mailOutbox.drain()
    const mail = [...sent].reverse().find((m) => m.to === email && linkIn(m.text, 'confirm'))
    assert.ok(mail, `нет письма для ${email}`)
    return linkIn(mail.text, 'confirm')
  }
  const confirm = (token, password = PASSWORD) => post('/api/auth/register/confirm', { token, password })
  const count = (table, where = 'true', mark = 'osp:internal') => Number(asMark(mark, `select count(*) from ${table} where ${where}`))

  function cookiesOf(res) {
    const raw = [].concat(res.headers['set-cookie'] || [])
    const get = (name) => raw.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=')[1] ?? null
    return { session: get('__Host-osp_session'), csrf: get('__Host-osp_csrf') }
  }
  const as = (c, { unsafe = false } = {}) => ({
    cookie: `__Host-osp_session=${c.session}; __Host-osp_csrf=${c.csrf}`,
    ...(unsafe ? { 'x-osp-csrf': c.csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
  })
  const signedIn = async (email, password = PASSWORD) => {
    const res = await login(email, password)
    assert.equal(res.statusCode, 200, res.body)
    return cookiesOf(res)
  }

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ createProofOfWork } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'proofOfWork.js')))
    ;({ createPasswordVerifier } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'passwords.js')))
    ;({ loadBlocklist } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'policy.js')))
    ;({ createSecretBox } = await import(path.join(SERVER, 'src', 'lib', 'auth', 'secretBox.js')))
    ;({ DEFAULT_LIMITS } = await import(path.join(SERVER, 'src', 'lib', 'limits.js')))
    box = createSecretBox(KEYS)
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
    pgdb.exec(SETUP_SQL)
    dbUrl = `postgres://api_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`

    const verifier = createPasswordVerifier()
    asMark('osp:internal', `insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data) values
        ('${ADMIN.id}', 'authenticated', 'authenticated', '${ADMIN.email}', now(), now(), now(), '{}'),
        ('${EMPLOYEE.id}', 'authenticated', 'authenticated', '${EMPLOYEE.email}', now(), now(), now(), '{}');
      insert into public.user_roles (user_id, role, is_approved, email, full_name) values
        ('${ADMIN.id}', 'admin', true, '${ADMIN.email}', 'Админ'), ('${EMPLOYEE.id}', 'engineer', true, '${EMPLOYEE.email}', 'Инженер');
      insert into public.counterparties (id, name, inn, status) values
        ('${CP.existing}', 'ООО Старый подрядчик', '${INN.existing}', 'active'),
        ('${CP.nomail}', 'ООО Без почты', ' ${INN.nomail} ', 'active'),
        ('${CP.black}', 'ООО Плохая компания', '${INN.black}', 'blacklist'),
        ('${CP.friend}', 'ООО Друзья плохой', '${INN.friend}', 'active');
      insert into public.counterparty_contacts (counterparty_id, full_name, phone, email) values
        ('${CP.existing}', 'Петров', '+7 495 000-00-01', 'petrov@old-contractor.ru, office@old-contractor.ru'),
        ('${CP.black}', 'Плохой', '8 (916) 555-44-33 доб. 12', 'boss@bad-company.ru');
      insert into public.counterparty_relations (counterparty_id, related_counterparty_id) values ('${CP.friend}', '${CP.black}');
      select 1`)
    for (const u of [ADMIN, EMPLOYEE]) {
      const secret = box.encrypt(await verifier.hash(u.password), u.id)
      asMark('osp:auth', `insert into osp_auth.credentials (user_id, secret, algo, source) values ('${u.id}', '${secret}', 'scrypt', 'own')`)
    }
    asMark('osp:auth', `insert into osp_auth.meta (key, value) values ('canary', '${box.encrypt('osp-auth-canary', 'osp-auth-canary')}')`)
  })

  after(async () => {
    await app?.close()
    upstream?.server.close()
    pgdb?.stop()
  })

  beforeEach(async () => {
    domainOk = () => true
    // Каждая проверка — на чистых заявках и учётках с регистрации: лимиты и ИНН не мешают друг другу.
    asMark('osp:internal', `delete from public.user_roles where self_registered;
      delete from auth.users where id not in ('${ADMIN.id}', '${EMPLOYEE.id}');
      delete from public.counterparty_contacts where counterparty_id in (select id from public.counterparties where registered_via = 'self');
      delete from public.counterparties where registered_via = 'self';
      update public.counterparties set status = 'active', deleted_at = null where id in ('${CP.existing}', '${CP.nomail}', '${CP.friend}');
      select 1`)
    asMark('osp:auth', `delete from osp_auth.registrations; delete from osp_auth.mail_outbox; delete from osp_auth.password_resets;
      delete from osp_auth.login_failures; delete from osp_auth.tombstones; select 1`)
    await makeApp()
  })

  it('закрыта по умолчанию: без флага, без почты, не в режиме own — 404, и страница её не предлагает', async () => {
    for (const over of [
      { signup: { enabled: false, mailFrom: 'p@su10.test' } },
      { signup: { enabled: true, mailFrom: '' } },
      { authMode: 'both', auth: { keys: KEYS, pilotIds: [ADMIN.id], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 } },
    ]) {
      await makeApp(over)
      const cfg = (await app.inject({ method: 'GET', url: '/api/auth/config' })).json()
      assert.ok(!('signup' in cfg), JSON.stringify(cfg))
      for (const [method, url, payload] of [
        ['GET', '/api/auth/register/challenge'],
        ['POST', '/api/auth/register', { ...form(), challenge: 'x', answer: '1' }],
        ['POST', '/api/auth/register/preview', { token: 'a'.repeat(43), kind: 'confirm' }],
        ['POST', '/api/auth/register/confirm', { token: 'a'.repeat(43), password: PASSWORD }],
        ['POST', '/api/auth/register/claim', { token: 'a'.repeat(43), decision: 'approve' }],
        ['POST', '/api/auth/password/forgot', { email: 'a@b.ru', challenge: 'x', answer: '1' }],
        ['POST', '/api/auth/password/reset', { token: 'a'.repeat(43), newPassword: PASSWORD }],
      ]) {
        const res = await app.inject({ method, url, payload, headers: payload ? jsonHeaders : {} })
        assert.equal(res.statusCode, 404, `${url}: ${res.statusCode}`)
      }
    }
    await makeApp()
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/config' })).json().signup, true)
  })

  it('заявка: только с портала и только JSON; задача на вычисление одноразовая; ловушка молчит', async () => {
    const good = { ...form(), ...(await proof()) }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: good, headers: { 'content-type': 'application/json' } })).statusCode, 403, 'без Origin')
    assert.equal((await post('/api/auth/register', good, { origin: 'https://evil.test' })).statusCode, 403, 'чужой Origin')
    assert.equal((await post('/api/auth/register', good, { 'sec-fetch-site': 'same-site' })).statusCode, 403, 'соседний портал')
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: new URLSearchParams(good).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } })).statusCode, 415, 'форма с другого сайта')

    assert.equal((await post('/api/auth/register', { ...form(), challenge: 'подделка', answer: '1' })).json().code, 'OSP_POW')
    const { challenge } = (await app.inject({ method: 'GET', url: '/api/auth/register/challenge' })).json()
    const tampered = challenge.replace(/\.\d+\./, '.1.')
    assert.equal((await post('/api/auth/register', { ...form(), challenge: tampered, answer: solve(tampered, 1) })).json().code, 'OSP_POW', 'сложность подписана')
    const p = await proof()
    assert.equal((await post('/api/auth/register', { ...form(), ...p })).statusCode, 202)
    assert.equal((await post('/api/auth/register', { ...form({ email: 'second@stroy-fresh.ru' }), ...p })).json().code, 'OSP_POW', 'задача действует один раз')

    const before = count('osp_auth.registrations', 'true', 'osp:auth')
    const trap = await post('/api/auth/register', { ...form({ email: 'bot@stroy-fresh.ru' }), website: 'http://spam.test', ...(await proof()) })
    assert.equal(trap.statusCode, 202, 'бот не узнаёт, что попался')
    assert.equal(count('osp_auth.registrations', 'true', 'osp:auth'), before)
  })

  it('поля: ИНН, почта, телефон, название, пароль, согласие и длины проверяет сервер', async () => {
    const bad = async (over, field) => {
      const res = await register(over)
      assert.equal(res.statusCode, 400, `${JSON.stringify(over)}: ${res.body}`)
      assert.equal(res.json().field, field, JSON.stringify(over))
    }
    await bad({ inn: '7707083894' }, 'inn')
    await bad({ inn: '0000000000' }, 'inn')
    await bad({ inn: '' }, 'inn')
    await bad({ inn: INN.ip, kpp: '770101001' }, 'kpp')
    await bad({ kpp: '12' }, 'kpp')
    await bad({ email: 'x@yopmail.com' }, 'email')
    await bad({ email: 'x"y@stroy.ru' }, 'email')
    await bad({ phone: '12345' }, 'phone')
    await bad({ companyName: '=HYPERLINK("http://evil","x")' }, 'companyName')
    await bad({ companyName: 'ООО https://evil.ru' }, 'companyName')
    await bad({ companyName: '<img src=x>' }, 'companyName')
    await bad({ contactName: 'Иван<script>' }, 'contactName')
    await bad({ consent: false }, 'consent')
    domainOk = () => false
    await bad({}, 'email')
    domainOk = () => true
    // Схема тела: слишком длинное не разбирается, лишние поля (роль, организация) отбрасываются.
    assert.equal((await post('/api/auth/register', { ...form({ companyName: 'Я'.repeat(9000) }), challenge: 'x', answer: '1' })).statusCode, 413)
    const extra = await post('/api/auth/register', { ...form(), role: 'admin', counterparty_id: CP.existing, is_approved: true, self_registered: false, ...(await proof()) })
    assert.equal(extra.statusCode, 202)
    const token = linkIn((await mails()).at(-1).text, 'confirm')
    // Пароль проверяется при подтверждении; слабый ссылку не тратит.
    for (const weak of ['коротко', form().email]) {
      const res = await confirm(token, weak)
      assert.equal(res.statusCode, 400, weak)
      assert.equal(res.json().field, 'password', weak)
    }
    assert.equal((await confirm(token)).json().status, 'active')
    assert.equal(asMark('osp:internal', `select role || ':' || self_registered || ':' || (counterparty_id = '${CP.existing}')::text from public.user_roles where email = '${form().email}'`), 'contractor:true:false')
  })

  it('новая компания: до подтверждения нет ни учётки, ни контрагента; подтверждение не даёт входа; дальше — подрядчик своей компании', async () => {
    const res = await register()
    assert.equal(res.statusCode, 202)
    assert.deepEqual(res.json(), { ok: true })
    assert.equal(count('auth.users', `email = '${form().email}'`), 0, 'учётки нет')
    assert.equal(count('public.counterparties', `inn = '${INN.fresh}'`), 0, 'контрагента нет')
    assert.equal((await login(form().email)).statusCode, 400, 'войти нельзя')

    const mail = (await mails()).at(-1)
    assert.equal(mail.from, 'portal@su10.test')
    assert.equal(mail.to, form().email)
    assert.ok(!mail.html, 'письмо — только текст')
    assert.doesNotMatch(mail.text, /Новая стройка|Иванов/, 'в письме нет введённого текста')
    const token = linkIn(mail.text, 'confirm')
    // В базе — только sha256 ссылки, письмо из очереди удалено.
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.registrations where token_hash = '${crypto.createHash('sha256').update(token).digest('hex')}'`), '1')
    assert.equal(asMark('osp:auth', `select count(*) from osp_auth.registrations where token_hash = '${token}'`), '0')
    assert.equal(count('osp_auth.mail_outbox', 'true', 'osp:auth'), 0)

    const done = await confirm(token)
    assert.equal(done.statusCode, 200, done.body)
    assert.deepEqual(done.json(), { status: 'active' })
    assert.ok(![].concat(done.headers['set-cookie'] || []).length, 'подтверждение не открывает сессию')
    assert.ok((await mails()).some((m) => m.to === form().email && /завершена/.test(m.text)), 'письмо о созданной учётке')
    assert.equal(asMark('osp:internal', `select role || ':' || is_approved || ':' || self_registered from public.user_roles where email = '${form().email}'`), 'contractor:true:true')
    const company = asMark('osp:internal', `select name || '|' || inn || '|' || kpp || '|' || status || '|' || registered_via from public.counterparties where inn = '${INN.fresh}'`)
    assert.equal(company, `ООО «Новая стройка»|${INN.fresh}|770101001|active|self`)
    assert.equal(asMark('osp:internal', `select phone || '|' || email from public.counterparty_contacts cc join public.counterparties c on c.id = cc.counterparty_id where c.inn = '${INN.fresh}'`), `+79161234567|${form().email}`)
    assert.equal(asMark('osp:auth', `select coalesce(secret, 'стёрт') from osp_auth.registrations where email_norm = '${form().email}'`), 'стёрт', 'отпечатка в заявке больше нет')

    assert.equal((await confirm(token)).json().code, 'OSP_SIGNUP_TOKEN', 'ссылка одноразовая')
    const ok = await login(form().email)
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().mustChange, false)
  })

  it('ссылка: устаревшая и чужая не работают; повторная заявка отменяет прежнюю; открытие страницы ничего не меняет', async () => {
    const first = await registerAndGetToken()
    const second = await registerAndGetToken({ phone: '+7 916 123-45-68' })
    assert.notEqual(first, second)
    assert.equal((await confirm(first)).json().code, 'OSP_SIGNUP_TOKEN', 'прежняя отменена')
    asMark('osp:auth', `update osp_auth.registrations set expires_at = now() - interval '1 minute' where status = 'pending'; select 1`)
    assert.equal((await confirm(second)).json().code, 'OSP_SIGNUP_TOKEN', 'устарела')
    assert.equal((await confirm('b'.repeat(43))).json().code, 'OSP_SIGNUP_TOKEN')
    assert.equal((await post('/api/auth/register/confirm', { token: "' or 1=1 --" })).statusCode, 400)
    assert.equal(count('auth.users', `email = '${form().email}'`), 0)
    // Браузер получает ссылку без запроса к серверу: токен — после #. GET по этому адресу API не существует.
    assert.equal((await app.inject({ method: 'GET', url: `/api/auth/register/confirm?token=${second}` })).statusCode, 404)
  })

  it('занятый адрес: ответ такой же; хозяин узнаёт письмом, письмо — без ссылки подтверждения и не чаще предела', async () => {
    const free = await register()
    const taken = await register({ email: EMPLOYEE.email, inn: INN.fresh2 })
    assert.equal(taken.statusCode, free.statusCode)
    assert.deepEqual(taken.json(), free.json())
    const toOwner = (await mails()).filter((m) => m.to === EMPLOYEE.email)
    assert.equal(toOwner.length, 1)
    assert.equal(linkIn(toOwner[0].text, 'confirm'), null)
    assert.match(toOwner[0].text, /уже есть/)
    await register({ email: EMPLOYEE.email })
    await register({ email: EMPLOYEE.email })
    assert.equal((await mails()).filter((m) => m.to === EMPLOYEE.email).length, 2, 'не больше двух писем в сутки')
    assert.equal(count('osp_auth.registrations', `email_norm = '${EMPLOYEE.email}'`, 'osp:auth'), 0, 'заявки на занятый адрес нет')
  })

  it('чёрный список и связи с ним: на проверку, учётки нет, заявитель не узнаёт причину', async () => {
    const cases = [
      { over: { email: 'a1@clean-one.ru', inn: INN.black }, reason: 'inn_blacklisted' },
      { over: { email: 'a2@clean-two.ru', inn: INN.friend }, reason: 'affiliate_blacklisted' },
      { over: { email: 'boss@bad-company.ru', inn: INN.sameMail }, reason: 'contact_blacklisted' },
      { over: { email: 'a3@clean-three.ru', inn: INN.samePhone, phone: '8 916 555 44 33' }, reason: 'contact_blacklisted' },
      { over: { email: 'other@bad-company.ru', inn: INN.sameDomain }, reason: 'domain_blacklisted' },
      { over: { email: 'a4@clean-four.ru', inn: INN.sameName, companyName: 'Плохая компания, АО' }, reason: 'name_blacklisted' },
    ]
    for (const { over, reason } of cases) {
      const token = await registerAndGetToken({ phone: '+7 926 000-11-22', ...over })
      const res = await confirm(token)
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual(res.json(), { status: 'review' }, reason)
      assert.equal(count('auth.users', `email = '${over.email}'`), 0, `${reason}: учётки нет`)
      assert.equal((await login(over.email)).statusCode, 400, `${reason}: входа нет`)
      assert.match(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = '${over.email}'`), new RegExp(reason))
    }
    assert.equal(count('public.counterparties', `registered_via = 'self'`), 0, 'контрагенты не созданы')
    // Общая почтовая служба сама по себе не связывает: домен gmail.com у контакта из ЧС никого не задевает.
    asMark('osp:internal', `update public.counterparty_contacts set email = 'bad@gmail.com' where counterparty_id = '${CP.black}'; select 1`)
    const token = await registerAndGetToken({ email: 'someone@gmail.com', inn: INN.fresh2, phone: '+7 926 000-11-23' })
    assert.equal((await confirm(token)).json().status, 'active')
    asMark('osp:internal', `update public.counterparty_contacts set email = 'boss@bad-company.ru' where counterparty_id = '${CP.black}'; select 1`)
    // Ответ заявки не выдаёт ЧС ни на шаге заявки, ни в письме.
    assert.ok(![...sent].some((m) => /чёрн|ЧС/i.test(m.text) && m.to !== 'dept@su10.test'))
  })

  it('компания из реестра: почта совпала с контактом — сразу; иначе подтверждение с почты компании, до него учётки нет', async () => {
    // Почта известна отделу.
    const direct = await registerAndGetToken({ email: 'PETROV@old-contractor.ru', inn: INN.existing, phone: '+7 926 000-11-24' })
    assert.equal((await confirm(direct)).json().status, 'active')
    assert.equal(asMark('osp:internal', `select counterparty_id::text from public.user_roles where lower(email) = 'petrov@old-contractor.ru'`), CP.existing)
    assert.equal(count('public.counterparties', `inn = '${INN.existing}'`), 1, 'новый контрагент не заведён')

    // Чужая почта: письмо на адреса из карточки, ни одного введённого заявителем слова, кроме адреса.
    const stranger = 'stranger@somewhere.ru'
    const res = await confirm(await registerAndGetToken({ email: stranger, inn: INN.existing, companyName: 'Зайдите на сайт злоумышленника', contactName: 'Срочно Оплатите Счёт', phone: '+7 926 000-11-25' }))
    assert.deepEqual(res.json(), { status: 'review' }, 'для заявителя неотличимо от проверки по ЧС')
    assert.equal(count('auth.users', `email = '${stranger}'`), 0)
    const claimMails = (await mails()).filter((m) => linkIn(m.text, 'claim'))
    assert.deepEqual(claimMails.map((m) => m.to).sort(), ['office@old-contractor.ru', 'petrov@old-contractor.ru'])
    for (const m of claimMails) {
      assert.match(m.text, /stranger@somewhere\.ru/)
      assert.match(m.text, new RegExp(`ООО Старый подрядчик.*${INN.existing}`), 'название и ИНН — из реестра')
      assert.doesNotMatch(m.text, /злоумышленника|Оплатите/)
    }
    const claim = linkIn(claimMails[0].text, 'claim')
    const shown = await post('/api/auth/register/preview', { token: claim, kind: 'claim' })
    assert.deepEqual(shown.json(), { companyName: 'ООО Старый подрядчик', inn: INN.existing, email: stranger }, 'на странице — тоже из реестра')
    assert.equal((await post('/api/auth/register/preview', { token: claim, kind: 'confirm' })).json().code, 'OSP_SIGNUP_TOKEN', 'ссылка компании — не ссылка заявителя')
    sent.length = 0
    assert.equal((await post('/api/auth/register/claim', { token: claim, decision: 'когда-нибудь' })).statusCode, 400)
    assert.equal((await post('/api/auth/register/claim', { token: claim, decision: 'approve' })).json().status, 'approved')
    assert.equal(asMark('osp:internal', `select counterparty_id::text || ':' || self_registered from public.user_roles where email = '${stranger}'`), `${CP.existing}:true`)
    assert.equal((await post('/api/auth/register/claim', { token: claim, decision: 'approve' })).json().code, 'OSP_SIGNUP_TOKEN', 'одноразовая')
    assert.equal((await login(stranger)).statusCode, 200)
    const told = (await mails()).filter((m) => /Открыт доступ/.test(m.subject)).map((m) => m.to).sort()
    assert.deepEqual(told, ['dept@su10.test', 'office@old-contractor.ru', 'petrov@old-contractor.ru'], 'об открытом доступе узнают все адреса и отдел')

    // Отказ: учётки нет, заявка — администратору.
    const denied = 'denied@somewhere.ru'
    await confirm(await registerAndGetToken({ email: denied, inn: INN.existing, phone: '+7 926 000-11-26' }))
    const deniedClaim = linkIn((await mails()).filter((m) => linkIn(m.text, 'claim')).at(-1).text, 'claim')
    assert.equal((await post('/api/auth/register/claim', { token: deniedClaim, decision: 'deny' })).json().status, 'denied')
    assert.equal(count('auth.users', `email = '${denied}'`), 0)
    assert.equal(asMark('osp:auth', `select status || ':' || array_to_string(reasons, ',') from osp_auth.registrations where email_norm = '${denied}'`), 'review:claim_denied')

    // В карточке нет почты — решает администратор. ИНН в реестре записан с пробелами — всё равно та же компания.
    const nomail = 'someone@nomail-company.ru'
    assert.deepEqual((await confirm(await registerAndGetToken({ email: nomail, inn: INN.nomail, phone: '+7 926 000-11-27' }))).json(), { status: 'review' })
    assert.equal(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = '${nomail}'`), 'no_company_mail')
    assert.equal(count('public.counterparties', `regexp_replace(inn, '[^0-9]', '', 'g') = '${INN.nomail}'`), 1)
  })

  it('чужой ящик не завалить: писем по ИНН компании не больше предела, дальше — администратору', async () => {
    await makeApp({}, undefined, { dailyClaimsPerCompany: 2 })
    for (let i = 0; i < 3; i++) {
      await confirm(await registerAndGetToken({ email: `n${i}@somewhere.ru`, inn: INN.existing, phone: `+7 926 000-12-0${i}` }))
    }
    assert.equal((await mails()).filter((m) => m.to === 'petrov@old-contractor.ru').length, 2)
    assert.equal(asMark('osp:auth', `select status || ':' || array_to_string(reasons, ',') from osp_auth.registrations where email_norm = 'n2@somewhere.ru'`), 'review:claim_limit')
  })

  it('лимиты: адрес, почта, общий предел в сутки; при пределе вход работает', async () => {
    await makeApp({}, { signupPerIp: { max: 2, windowMs: 60_000 } })
    assert.equal((await register()).statusCode, 202)
    assert.equal((await register({ email: 'b@stroy-fresh.ru' })).statusCode, 202)
    const third = await register({ email: 'c@stroy-fresh.ru' })
    assert.equal(third.statusCode, 429)
    assert.equal(third.json().code, 'too_many_attempts')

    await makeApp({}, undefined, { dailyPerEmailIp: 1 })
    asMark('osp:auth', 'delete from osp_auth.registrations; delete from osp_auth.mail_outbox; select 1')
    const first = await register()
    const again = await register()
    assert.equal(again.statusCode, first.statusCode, 'ответ тот же')
    assert.equal((await mails()).filter((m) => m.to === form().email).length, 1, 'с одного адреса писем на почту не больше предела')
    // Чужой адрес отправителя предел не занимает: хозяин почты сам получит письмо, сколько бы заявок ни подал другой.
    const fromOwner = await post('/api/auth/register', { ...form(), ...(await proof()) }, { 'x-forwarded-for': '203.0.113.9' })
    assert.equal(fromOwner.statusCode, 202)

    await makeApp({}, undefined, { dailyPerDomain: 2 })
    asMark('osp:auth', 'delete from osp_auth.registrations; delete from osp_auth.mail_outbox; select 1')
    for (const n of [1, 2, 3]) assert.equal((await register({ email: `n${n}@one-domain.ru` })).statusCode, 202)
    assert.equal(count('osp_auth.registrations', `email_norm like '%@one-domain.ru'`, 'osp:auth'), 2, 'с одного домена не больше предела')
    for (const n of [1, 2, 3]) await register({ email: `n${n}@gmail.com` })
    assert.equal(count('osp_auth.registrations', `email_norm like '%@gmail.com'`, 'osp:auth'), 3, 'общие почтовые службы — не один домен')

    await makeApp({}, undefined, { dailyTotal: 1 })
    const closed = await register({ email: 'd@stroy-fresh.ru' })
    assert.equal(closed.statusCode, 503)
    assert.equal(closed.json().code, 'OSP_SIGNUP_CLOSED')
    assert.equal((await login(EMPLOYEE.email, EMPLOYEE.password)).statusCode, 200, 'вход сотрудников не задет')
  })

  it('чужой пароль заранее не задать: заявка с почтой директора не даёт войти отправителю', async () => {
    const director = 'petrov@old-contractor.ru'
    const attacker = 'пароль злоумышленника длинный'
    // Пароль в заявке не принимается вообще.
    await post('/api/auth/register', { ...form({ email: director, inn: INN.existing, phone: '+7 926 000-20-01' }), password: attacker, ...(await proof()) })
    const token = linkIn((await mails()).at(-1).text, 'confirm')
    assert.equal(asMark('osp:auth', `select coalesce(secret, 'нет') from osp_auth.registrations where email_norm = '${director}'`), 'нет', 'до подтверждения пароля нет')
    // Хозяин почты видит, что подтверждает.
    const shown = (await post('/api/auth/register/preview', { token, kind: 'confirm' })).json()
    assert.equal(shown.inn, INN.existing)
    assert.equal(shown.email, director)
    assert.equal((await confirm(token, 'пароль директора длинный и свой')).json().status, 'active')
    assert.equal((await login(director, attacker)).statusCode, 400, 'пароль отправителя заявки не подходит')
    assert.equal((await login(director, 'пароль директора длинный и свой')).statusCode, 200)
  })

  it('первый занявший ИНН не решает за настоящую компанию: следующая заявка — администратору, письма ему нет', async () => {
    assert.equal((await confirm(await registerAndGetToken({ email: 'squatter@squat.ru', inn: INN.fresh2, phone: '+7 926 000-21-01' }))).json().status, 'active')
    await mails() // письмо о созданной учётке ему — своё
    sent.length = 0
    const real = 'real@real-company.ru'
    assert.deepEqual((await confirm(await registerAndGetToken({ email: real, inn: INN.fresh2, phone: '+7 926 000-21-02' }))).json(), { status: 'review' })
    assert.equal(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = '${real}'`), 'company_unverified')
    const list = await mails()
    assert.equal(list.filter((m) => m.to === 'squatter@squat.ru').length, 0, 'занявшему не пишем и адрес настоящей компании не показываем')
    assert.ok(!list.some((m) => m.to !== real && m.text.includes(real)))
  })

  it('блокировку и отказ не обойти новой почтой; ИНН в реестре в любом виде', async () => {
    // Заблокированная учётка: новая заявка с тем же ИНН — администратору, письма на адрес заблокированного нет.
    await confirm(await registerAndGetToken({ email: 'old@blocked-firm.ru', inn: INN.existing, phone: '+7 926 000-22-01' }))
    await post('/api/auth/register/claim', { token: linkIn((await mails()).filter((m) => linkIn(m.text, 'claim')).at(-1).text, 'claim'), decision: 'approve' })
    asMark('osp:internal', `update public.user_roles set is_blocked = true, is_approved = false where email = 'old@blocked-firm.ru'; select 1`)
    sent.length = 0
    assert.deepEqual((await confirm(await registerAndGetToken({ email: 'again@blocked-firm.ru', inn: INN.existing, phone: '+7 926 000-22-02' }))).json(), { status: 'review' })
    assert.equal(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = 'again@blocked-firm.ru'`), 'company_account_blocked')
    assert.equal((await mails()).filter((m) => linkIn(m.text, 'claim')).length, 0)

    // Отказ: та же почта или тот же ИНН — снова администратору.
    const admin = await signedIn(ADMIN.email, ADMIN.password)
    await confirm(await registerAndGetToken({ email: 'no@refused-firm.ru', inn: INN.nomail, phone: '+7 926 000-22-03' }))
    const id = asMark('osp:auth', `select id from osp_auth.registrations where email_norm = 'no@refused-firm.ru'`)
    await app.inject({ method: 'POST', url: `/api/admin/contractor-signups/${id}/decision`, payload: { decision: 'refuse' }, headers: as(admin, { unsafe: true }) })
    assert.deepEqual((await confirm(await registerAndGetToken({ email: 'no2@other-firm.ru', inn: INN.nomail, phone: '+7 926 000-22-04' }))).json(), { status: 'review' })
    assert.match(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = 'no2@other-firm.ru'`), /previously_refused/)

    // Компанию удалили: новая не заводится сама.
    const deleted = '7743013901'
    asMark('osp:internal', `insert into public.counterparties (name, inn, status, deleted_at) values ('ООО Удалённая', '${deleted}', 'active', now()); select 1`)
    assert.deepEqual((await confirm(await registerAndGetToken({ email: 'x@deleted-firm.ru', inn: deleted, phone: '+7 926 000-22-05' }))).json(), { status: 'review' })
    assert.equal(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = 'x@deleted-firm.ru'`), 'company_deleted')
    asMark('osp:internal', `delete from public.counterparties where inn = '${deleted}'; select 1`)

    // ЧС с ИНН, записанным как попало: с КПП через «/», двумя ИНН, без ведущего нуля. Обхода нет.
    const zero = '0274062111'
    for (const [written, inn, email] of [[`${INN.fresh2}/770101001`, INN.fresh2, 'a@kpp-case.ru'], [`${INN.fresh}, 7702070139`, INN.fresh, 'a@two-case.ru'], [zero.replace(/^0/, ''), zero, 'a@zero-case.ru']]) {
      asMark('osp:internal', `insert into public.counterparties (name, inn, status) values ('ООО Формат ${email}', '${written}', 'blacklist'); select 1`)
      assert.deepEqual((await confirm(await registerAndGetToken({ email, inn, phone: `+7 926 000-23-0${email.length}` }))).json(), { status: 'review' }, written)
      assert.match(asMark('osp:auth', `select array_to_string(reasons, ',') from osp_auth.registrations where email_norm = '${email}'`), /inn_blacklisted/, written)
      asMark('osp:internal', `delete from public.counterparties where inn = '${written}'; select 1`)
    }
  })

  it('предел новых компаний за сутки: дальше — администратору; напоминание о заявке на проверке — раз в сутки', async () => {
    await makeApp({}, undefined, { dailyNewCompanies: 1 })
    assert.equal((await confirm(await registerAndGetToken({ email: 'a@firm-1.ru', inn: INN.fresh, phone: '+7 926 000-24-01' }))).json().status, 'active')
    assert.equal((await confirm(await registerAndGetToken({ email: 'a@firm-2.ru', inn: INN.fresh2, phone: '+7 926 000-24-02' }))).json().status, 'review')
    assert.equal(count('public.counterparties', `registered_via = 'self'`), 1)
    sent.length = 0
    for (let i = 0; i < 3; i++) await register({ email: 'a@firm-2.ru', inn: INN.fresh2, phone: '+7 926 000-24-02' })
    assert.equal((await mails()).filter((m) => m.to === 'a@firm-2.ru').length, 1, 'письмо «проверяется» не чаще раза в сутки')
  })

  it('смена пароля: лимит на пользователя, расчёт отпечатка не занять', async () => {
    await makeApp({}, { authPasswordPerUser: { max: 2, windowMs: 60_000 } })
    await confirm(await registerAndGetToken())
    const c = await signedIn(form().email)
    const change = () => app.inject({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: 'неверный', newPassword: 'новая длинная фраза для входа' }, headers: as(c, { unsafe: true }) })
    assert.equal((await change()).statusCode, 400)
    assert.equal((await change()).statusCode, 400)
    assert.equal((await change()).statusCode, 429)
  })

  it('одновременно: один адрес — одна заявка; один новый ИНН — одна компания', async () => {
    const results = await Promise.all([1, 2, 3].map(async () => register()))
    for (const r of results) assert.equal(r.statusCode, 202)
    assert.equal(count('osp_auth.registrations', `email_norm = '${form().email}' and status = 'pending'`, 'osp:auth'), 1)

    const a = await registerAndGetToken({ email: 'one@firm-a.ru', inn: INN.fresh2, phone: '+7 926 000-13-01' })
    const b = await registerAndGetToken({ email: 'two@firm-b.ru', inn: INN.fresh2, phone: '+7 926 000-13-02' })
    const done = await Promise.all([confirm(a), confirm(b)])
    assert.deepEqual(done.map((r) => r.json().status).sort(), ['active', 'review'], 'второй — на проверку')
    assert.equal(count('public.counterparties', `inn = '${INN.fresh2}'`), 1)
  })

  it('учётка с регистрации: шлюз пропускает только короткий список, файлы и маршруты сотрудников закрыты', async () => {
    await confirm(await registerAndGetToken())
    const c = await signedIn(form().email)
    const { default: allow } = await import(path.join(SERVER, 'src', 'data', 'allow.json'), { with: { type: 'json' } })
    const { default: own } = await import(path.join(SERVER, 'src', 'data', 'allow-self-contractor.json'), { with: { type: 'json' } })
    const passed = (status) => status === 200
    upstream.seen.length = 0

    // Каждая таблица и функция портала, кроме короткого списка, — отказ и запрос до базы не доходит.
    for (const table of Object.keys(allow.tables)) {
      const res = await app.inject({ method: 'GET', url: `/api/db/${table}?select=*`, headers: as(c) })
      if (own.tables[table]) assert.ok(passed(res.statusCode), `${table}: ${res.statusCode}`)
      else assert.equal(res.statusCode, 404, `${table}: ${res.statusCode}`)
    }
    for (const fn of Object.keys(allow.rpc)) {
      const res = await app.inject({ method: 'POST', url: `/api/db/rpc/${fn}`, payload: {}, headers: as(c, { unsafe: true }) })
      if (own.rpc[fn]) assert.ok(passed(res.statusCode), `${fn}: ${res.statusCode}`)
      else assert.equal(res.statusCode, 404, `${fn}: ${res.statusCode}`)
    }
    const reached = new Set(upstream.seen.map((r) => r.url.split('?')[0].replace(/^\//, '').replace(/^rpc\//, '')))
    assert.deepEqual([...reached].sort(), [...Object.keys(own.tables), ...Object.keys(own.rpc)].sort(), 'до базы дошло только разрешённое')

    // Запись, связанные таблицы и обходы.
    const denied = [
      ['POST', '/api/db/user_roles', { user_id: 'x', role: 'admin' }],
      ['PATCH', '/api/db/user_roles?user_id=eq.x', { role: 'admin', self_registered: false }],
      ['DELETE', '/api/db/tender_bid_rates?id=eq.x'],
      ['PATCH', '/api/db/tender_bid_rates?id=eq.x', { price: 1 }],
      ['GET', '/api/db/tender_bid_rates?select=*,tenders(*)'],
      ['GET', '/api/db/tender_bid_rates?select=*,counterparties!inner(*)'],
      ['GET', '/api/db/user_roles?select=*,x:counterparties(notes)'],
      ['GET', '/api/db/bid_form_fields?select=...tenders(*)'],
    ]
    upstream.seen.length = 0
    for (const [method, url, payload] of denied) {
      const res = await app.inject({ method, url, payload, headers: method === 'GET' ? as(c) : as(c, { unsafe: true }) })
      assert.ok(res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 400, `${method} ${url}: ${res.statusCode}`)
    }
    assert.equal(upstream.seen.length, 0, 'до базы не дошло')
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/tender_bid_rates?select=id;foo', headers: as(c) })).statusCode, 400)

    // Форма запроса: только простые условия, остальное до базы не доходит — и без входа.
    upstream.seen.length = 0
    const regex = 'x'
    for (const q of [`label=match.${regex}`, `label=imatch.${regex}`, 'label=like.*a*', 'label=ilike.*a*', 'or=(label.match.x,id.eq.1)', 'and=(label.like.x)', 'not.or=(a.eq.1)',
      'label=not.match.x', 'label=fts.x', 'label=cs.{a}', 'tenders.id=eq.1', 'columns=id', 'on_conflict=id', 'select=label::text', 'select=id,x:label', `order=label.asc,${encodeURIComponent('a(b)')}`, 'limit=1;drop']) {
      const res = await app.inject({ method: 'GET', url: `/api/db/bid_form_fields?${q}`, headers: as(c) })
      assert.equal(res.statusCode, 400, `${q}: ${res.statusCode}`)
    }
    const anonymous = await app.inject({ method: 'GET', url: `/api/db/public_open_tenders?select=id&work_description=match.${regex}` })
    assert.equal(anonymous.statusCode, 400, 'без входа — то же')
    assert.equal(upstream.seen.length, 0, 'до базы не дошло')
    // То, чем пользуется кабинет и публичная страница, — проходит.
    for (const q of ['select=id,label&is_active=eq.true&order=sort_order.asc,id.asc', 'select=*&limit=10&offset=20', 'id=in.(1,2)', 'price=not.is.null', 'tender_id=neq.x']) {
      const res = await app.inject({ method: 'GET', url: `/api/db/bid_form_fields?${q}`, headers: as(c) })
      assert.equal(res.statusCode, 200, `${q}: ${res.statusCode}`)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/public_open_tenders?select=id,work_description&order=tender_end_date.asc.nullslast' })).statusCode, 200)

    // Большое тело — до чтения; потоковое — тоже.
    const big = await app.inject({ method: 'POST', url: '/api/db/rpc/bid_rates_save', headers: { ...as(c, { unsafe: true }), 'content-length': String(3 * 1024 * 1024) }, payload: '{}' })
    assert.ok(big.statusCode === 413 || big.statusCode === 400, `большое тело: ${big.statusCode}`)
    assert.equal((await app.inject({ method: 'POST', url: '/api/db/rpc/bid_rates_save', headers: { ...as(c, { unsafe: true }), 'transfer-encoding': 'chunked' }, payload: '{}' })).statusCode, 413)

    // Файлы, ИИ, обложки, администрирование.
    for (const payload of [{ action: 'download', s3_key: 'tenders/x/y.xlsx' }, { action: 'upload' }, { action: 'delete' }, { action: 'rename' }, { action: 'describe' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/fn/s3-presign', payload, headers: as(c, { unsafe: true }) })).statusCode, 403, payload.action)
    }
    for (const [method, url, payload] of [
      ['POST', '/api/fn/ai-assist', { action: 'clause_suggest' }],
      ['POST', '/api/fn/cover-upload', {}],
      ['POST', '/api/auth/admin/users', { email: 'x@y.ru', fullName: 'x', role: 'admin' }],
      ['POST', '/api/auth/admin/reset-password', { userId: ADMIN.id }],
      ['GET', '/api/admin/api-keys'],
      ['GET', '/api/admin/contractor-signups'],
    ]) {
      const res = await app.inject({ method, url, payload, headers: method === 'GET' ? as(c) : as(c, { unsafe: true }) })
      assert.equal(res.statusCode, 403, `${url}: ${res.statusCode}`)
    }

    // Сотрудник ходит по шлюзу как раньше.
    const emp = await signedIn(EMPLOYEE.email, EMPLOYEE.password)
    assert.equal((await app.inject({ method: 'GET', url: '/api/db/tenders?select=id,objects(name)&name=ilike.*a*', headers: as(emp) })).statusCode, 200, 'сотруднику фильтры не ограничены')
  })

  it('одновременные запросы: у учётки с регистрации и без входа есть предел, сотрудника он не задевает; места освобождаются', async () => {
    await makeApp({}, { dbRestrictedConcurrentPerKey: 2 })
    await confirm(await registerAndGetToken())
    const c = await signedIn(form().email)
    const emp = await signedIn(EMPLOYEE.email, EMPLOYEE.password)
    // «PostgREST» держит ответ, пока тест не отпустит.
    const held = []
    const realUrl = upstream.server.listeners('request')[0]
    upstream.server.removeAllListeners('request')
    upstream.server.on('request', (req, res) => { req.resume(); held.push(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') }) })
    try {
      const get = (headers) => app.inject({ method: 'GET', url: '/api/db/bid_form_fields?select=id', headers })
      const two = [get(as(c)), get(as(c))]
      while (held.length < 2) await new Promise((r) => setTimeout(r, 10))
      const third = await get(as(c))
      assert.equal(third.statusCode, 429)
      const staff = app.inject({ method: 'GET', url: '/api/db/tenders?select=id', headers: as(emp) })
      while (held.length < 3) await new Promise((r) => setTimeout(r, 10))
      for (const release of held.splice(0)) release()
      assert.equal((await staff).statusCode, 200, 'сотрудника предел не задевает')
      for (const r of await Promise.all(two)) assert.equal(r.statusCode, 200)
      const again = get(as(c))
      while (held.length < 1) await new Promise((r) => setTimeout(r, 10))
      for (const release of held.splice(0)) release()
      assert.equal((await again).statusCode, 200, 'места освободились')
    } finally {
      upstream.server.removeAllListeners('request')
      upstream.server.on('request', realUrl)
    }
  })

  it('учётку с регистрации нельзя сделать сотрудником: ограничение базы', async () => {
    await confirm(await registerAndGetToken())
    assert.throws(() => asMark('osp:internal', `update public.user_roles set role = 'engineer' where email = '${form().email}'`), /user_roles_self_registered_contractor/)
    assert.throws(() => asMark('osp:internal', `update public.user_roles set role = 'admin' where email = '${form().email}'`), /user_roles_self_registered_contractor/)
    assert.equal(asMark('osp:internal', `select role from public.user_roles where email = '${form().email}'`), 'contractor')
  })

  it('чёрный список после регистрации: учётка заблокирована сразу, сессия отозвана; снятие статуса не снимает блокировку', async () => {
    await confirm(await registerAndGetToken())
    const c = await signedIn(form().email)
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })).statusCode, 200)
    asMark('osp:internal', `update public.counterparties set status = 'blacklist' where inn = '${INN.fresh}'; select 1`)
    assert.equal(asMark('osp:internal', `select is_blocked || ':' || is_approved || ':' || blocked_by_name from public.user_roles where email = '${form().email}'`), 'true:false:Контрагент в чёрном списке')
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(c) })).statusCode, 401, 'сессия отозвана')
    assert.equal((await login(form().email)).statusCode, 403, 'войти нельзя')
    asMark('osp:internal', `update public.counterparties set status = 'active' where inn = '${INN.fresh}'; select 1`)
    assert.equal((await login(form().email)).statusCode, 403, 'разблокирует только администратор')

    // Удаление компании закрывает учётку с регистрации, но не трогает учётку от администратора.
    await confirm(await registerAndGetToken({ email: 'x@firm-x.ru', inn: INN.fresh2, phone: '+7 926 000-14-01' }))
    asMark('osp:internal', `insert into auth.users (id, aud, role, email, created_at, updated_at, raw_user_meta_data) values ('99999999-9999-4999-8999-999999999999', 'authenticated', 'authenticated', 'managed@firm-x.ru', now(), now(), '{}');
      insert into public.user_roles (user_id, role, is_approved, email, counterparty_id) select '99999999-9999-4999-8999-999999999999', 'contractor', true, 'managed@firm-x.ru', id from public.counterparties where inn = '${INN.fresh2}';
      update public.counterparties set deleted_at = now() where inn = '${INN.fresh2}'; select 1`)
    assert.equal(asMark('osp:internal', `select is_blocked from public.user_roles where email = 'x@firm-x.ru'`), 't')
    assert.equal(asMark('osp:internal', `select is_blocked from public.user_roles where email = 'managed@firm-x.ru'`), 'f')
    asMark('osp:internal', `delete from public.user_roles where email = 'managed@firm-x.ru'; select 1`)
  })

  it('администратор: видит заявки без отпечатков и ссылок, решает; компанию из ЧС одобрить нельзя', async () => {
    await confirm(await registerAndGetToken({ email: 'black@clean.ru', inn: INN.black, phone: '+7 926 000-15-01' }))
    await confirm(await registerAndGetToken({ email: 'nomail@clean.ru', inn: INN.nomail, phone: '+7 926 000-15-02' }))
    await confirm(await registerAndGetToken({ email: 'refused@clean.ru', inn: INN.friend, phone: '+7 926 000-15-03' }))
    const admin = await signedIn(ADMIN.email, ADMIN.password)
    const emp = await signedIn(EMPLOYEE.email, EMPLOYEE.password)
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/contractor-signups', headers: as(emp) })).statusCode, 403)

    const list = await app.inject({ method: 'GET', url: '/api/admin/contractor-signups?status=review', headers: as(admin) })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().items.length, 3)
    assert.doesNotMatch(list.body, /"secret"|token_hash|v1:t1:/)
    const item = (email) => list.json().items.find((r) => r.email === email)
    assert.deepEqual(item('black@clean.ru').reasons, ['inn_blacklisted'])
    assert.equal(item('nomail@clean.ru').counterparty_name, 'ООО Без почты')
    const decide = (id, decision, who = admin) => app.inject({ method: 'POST', url: `/api/admin/contractor-signups/${id}/decision`, payload: { decision }, headers: as(who, { unsafe: true }) })

    const blocked = await decide(item('black@clean.ru').id, 'approve')
    assert.equal(blocked.statusCode, 409)
    assert.equal(blocked.json().code, 'OSP_SIGNUP_BLACKLISTED')
    assert.equal(count('auth.users', `email = 'black@clean.ru'`), 0)
    assert.equal((await decide(item('nomail@clean.ru').id, 'approve', emp)).statusCode, 403)

    assert.equal((await decide(item('nomail@clean.ru').id, 'approve')).json().status, 'active')
    assert.equal(asMark('osp:internal', `select counterparty_id::text from public.user_roles where email = 'nomail@clean.ru'`), CP.nomail)
    assert.equal((await login('nomail@clean.ru')).statusCode, 200)
    assert.equal((await decide(item('nomail@clean.ru').id, 'approve')).statusCode, 409, 'повторно — нельзя')

    assert.equal((await decide(item('refused@clean.ru').id, 'refuse')).json().status, 'refused')
    assert.equal(asMark('osp:auth', `select coalesce(secret, 'стёрт') from osp_auth.registrations where email_norm = 'refused@clean.ru'`), 'стёрт')
    assert.equal((await login('refused@clean.ru')).statusCode, 400)
    assert.ok((await mails()).some((m) => m.to === 'refused@clean.ru' && /не удалось/.test(m.text)))
    assert.ok(sent.some((m) => m.to === 'dept@su10.test' && !/clean\.ru|ООО/.test(m.text)), 'отдел узнаёт о заявке без персональных данных')
  })

  it('учётка, удалённая администратором, сама не возвращается', async () => {
    asMark('osp:auth', `insert into osp_auth.tombstones (user_id, email_norm) values ('77777777-7777-4777-8777-777777777777', 'deleted@firm.ru'); select 1`)
    assert.deepEqual((await confirm(await registerAndGetToken({ email: 'deleted@firm.ru', inn: INN.fresh2, phone: '+7 926 000-16-01' }))).json(), { status: 'review' })
    assert.equal(count('auth.users', `email = 'deleted@firm.ru'`), 0)
  })

  it('восстановление пароля: ответ один, только учётки с регистрации, ссылка одноразовая, остальные входы завершаются', async () => {
    await confirm(await registerAndGetToken())
    const old = await signedIn(form().email)
    const forgot = async (email) => post('/api/auth/password/forgot', { email, ...(await proof()) })

    const ownerRes = await forgot(form().email)
    const strangerRes = await forgot('nobody@nowhere.ru')
    const employeeRes = await forgot(EMPLOYEE.email)
    for (const r of [ownerRes, strangerRes, employeeRes]) {
      assert.equal(r.statusCode, 202)
      assert.deepEqual(r.json(), { ok: true })
    }
    const list = await mails()
    assert.equal(list.filter((m) => m.to === 'nobody@nowhere.ru').length, 0)
    assert.equal(list.filter((m) => m.to === EMPLOYEE.email).length, 0, 'сотруднику пароль выдаёт администратор')
    const token = linkIn(list.filter((m) => m.to === form().email).at(-1).text, 'reset')
    assert.ok(token)

    const reset = (t, newPassword) => post('/api/auth/password/reset', { token: t, newPassword })
    const weak = await reset(token, 'короткий')
    assert.equal(weak.statusCode, 400)
    assert.equal(weak.json().field, 'password')
    const next = 'совсем другая длинная фраза для входа'
    assert.equal((await reset(token, next)).statusCode, 200, 'слабый пароль ссылку не сжёг')
    assert.equal((await reset(token, `${next} снова`)).json().code, 'OSP_SIGNUP_TOKEN', 'одноразовая')
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(old) })).statusCode, 401, 'прежний вход завершён')
    assert.equal((await login(form().email)).statusCode, 400, 'прежний пароль не подходит')
    assert.equal((await login(form().email, next)).statusCode, 200)
    assert.ok((await mails()).some((m) => m.to === form().email && /изменён/.test(m.text)), 'письмо о смене пароля')

    // Устаревшая и заблокированная.
    await forgot(form().email)
    const stale = linkIn((await mails()).filter((m) => m.to === form().email && linkIn(m.text, 'reset')).at(-1).text, 'reset')
    asMark('osp:auth', `update osp_auth.password_resets set expires_at = now() - interval '1 minute' where used_at is null; select 1`)
    assert.equal((await reset(stale, next)).json().code, 'OSP_SIGNUP_TOKEN')
  })

  it('письма: сбой почтового сервера не теряет письмо и не меняет ответ; в очереди ссылка зашифрована', async () => {
    let failing = true
    await app.close()
    logs = []
    const delivered = []
    app = buildApp({ config: config(), logger: { level: 'info', stream: { write: (l) => logs.push(l) } }, limits: DEFAULT_LIMITS, deps: {
      ...defaultDeps, blocklist: blocklistOnce(), createPasswordVerifier: () => createPasswordVerifier(),
      createMailTransport: () => ({ sendMail: async (m) => {
        if (failing) throw Object.assign(new Error('connect refused to smtp.secret-host'), { code: 'ECONNREFUSED' })
        delivered.push(m)
      } }),
      domainAcceptsMail: async () => true, proofOfWork: createProofOfWork({ bits: 2 }), outboxOptions: { tickMs: 3_600_000 }, noBidPositions: true,
    } })
    await app.ready()
    assert.equal((await register()).statusCode, 202)
    const payload = asMark('osp:auth', 'select payload from osp_auth.mail_outbox limit 1')
    assert.match(payload, /^v1:t1:/)
    assert.ok(!payload.includes(form().email) && !payload.includes('partner/confirm'), 'в строке базы ни адреса, ни ссылки')
    await app.mailOutbox.drain()
    assert.equal(count('osp_auth.mail_outbox', 'attempts = 1 and not_before > now()', 'osp:auth'), 1, 'повтор позже')
    failing = false
    await app.mailOutbox.drain()
    assert.equal(delivered.length, 0, 'до срока повтора не отправляется')
    asMark('osp:auth', 'update osp_auth.mail_outbox set not_before = now(); select 1')
    await app.mailOutbox.drain()
    assert.equal(delivered.length, 1)
    assert.equal(count('osp_auth.mail_outbox', 'true', 'osp:auth'), 0)
    assert.ok(!logs.join('').includes('secret-host') && !logs.join('').includes(form().email), 'в журнале ни адреса, ни текста ошибки сервера')
  })

  it('очистка: подтверждение не пришло — администратору; незавершённые заявки и старые ссылки уходят', async () => {
    const svc = (await import(path.join(SERVER, 'src', 'lib', 'auth', 'signup.js')))
    await confirm(await registerAndGetToken({ email: 'late@firm.ru', inn: INN.existing, phone: '+7 926 000-17-01' }))
    await register({ email: 'unconfirmed@firm.ru', inn: INN.fresh2, phone: '+7 926 000-17-02' })
    asMark('osp:auth', `update osp_auth.registrations set claim_expires_at = now() - interval '1 minute' where email_norm = 'late@firm.ru';
      update osp_auth.registrations set created_at = now() - interval '8 days' where email_norm = 'unconfirmed@firm.ru'; select 1`)
    const cleanup = svc.createSignup({
      db: { write: async () => { throw new Error('не тот путь') } }, box, verifier: createPasswordVerifier(), blocklist: new Set(), mail: { enqueue: async () => {} },
      sessions: {}, publicOrigin: ORIGIN, domainAcceptsMail: async () => true,
    })
    assert.equal(typeof cleanup.cleanup, 'function')
    const direct = await (async () => {
      const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
      const db = createDb({ url: dbUrl, caFile: '', max: 1, secondLockRole: '' })
      try {
        return await svc.createSignup({ db, box, verifier: createPasswordVerifier(), blocklist: new Set(), mail: { enqueue: async () => {} }, sessions: {}, publicOrigin: ORIGIN, domainAcceptsMail: async () => true }).cleanup()
      } finally { await db.close() }
    })()
    assert.deepEqual(direct, { expired: 1, registrations: 1, resets: 0 })
    assert.equal(asMark('osp:auth', `select status || ':' || array_to_string(reasons, ',') from osp_auth.registrations where email_norm = 'late@firm.ru'`), 'review:claim_expired')
    assert.equal(count('osp_auth.registrations', `email_norm = 'unconfirmed@firm.ru'`, 'osp:auth'), 0)
  })

  it('отметки и журнал: заявки не видны пропуску служебных функций; в журнале нет пароля, ссылки и данных формы', async () => {
    const token = await registerAndGetToken()
    assert.equal(count('osp_auth.registrations', 'true', 'osp:internal'), 0, 'пропуск служебных функций заявок не видит')
    assert.equal(count('osp_auth.mail_outbox', 'true', 'osp:internal'), 0)
    assert.equal(count('osp_auth.registrations', 'true', 'osp-api'), 0, 'обычная операция — тоже')
    assert.ok(count('osp_auth.registrations', 'true', 'osp:auth') >= 1)
    await confirm(token)
    await login(form().email)
    const text = logs.join('\n')
    for (const secret of [PASSWORD, token, form().email, INN.fresh, 'Новая стройка', 'Иванов', '+7916', crypto.createHash('sha256').update(token).digest('hex')]) {
      assert.ok(!text.includes(secret), `в журнале: ${secret}`)
    }
  })
})
