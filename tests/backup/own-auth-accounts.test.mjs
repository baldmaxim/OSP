// Перенос учёток и паролей для своего входа нового портала (migration/accounts, backup.sh --credentials) — от
// «прода» Supabase до входа в osp-api прежним паролем. Проверяем обещанное в плане:
//   • отпечатки паролей идут только запечатанными ключом corp: в файлах и выводе нет ни отпечатков, ни почт;
//   • --dry-run ничего не пишет; --yes — копия базы до записи, соседи не тронуты, канарейка ключа записана;
//   • в osp-api входят прежним паролем Supabase (формат строк prepare.mjs = формат сервера);
//   • повторный перенос (перед переключением): пароль, изменённый в Supabase после прошлой копии, обновляется (сессии
//     со старым отзываются), сменённый в
//     новом портале — не трогается; удалённая администратором учётка не воссоздаётся, --restore — возвращает;
//   • дубли почты — остановка до записи; чужой ключ переноса и несовпавшая опись — отказ;
//   • accounts-check: готовность своего входа; копия базы (export.sh) берёт пароли, проверка восстановлением
//     проходит; сброс репетиции (reset.sh) убирает схемы своего входа.
// Нужны Docker, psql, pg_dump, pg_restore, node.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SQL, PLATFORM_USERS } from './lib/supabase-platform.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKUP = path.join(ROOT, 'migration', 'backup')
const TARGET = path.join(ROOT, 'migration', 'target')
const ACCOUNTS = path.join(ROOT, 'migration', 'accounts')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const depsOk = ['bcryptjs', 'fastify', 'pg'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : depsOk ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const ADMIN_PASS = 'Admin-Pass-oa1-secret'
const OWNER_PASS = 'Owner-Pass-oa2-secret'
const [ADMIN, ANNA, BORIS] = PLATFORM_USERS
const PASS = { [ADMIN.id]: 'Admin-Supabase-Pass-1', [ANNA.id]: 'Anna-Supabase-Pass-22', [BORIS.id]: 'Boris-Supabase-Pass-333' }
const ORIGIN = 'https://tender.test'
const BORIS_PORTAL_PASS = 'пароль бориса в новом портале'

const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension pg_trgm with schema public;
${PLATFORM_SQL}
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.user_roles(id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, is_blocked boolean not null default false, email text, full_name text,
  work_phone text, requested_company text, counterparty_id uuid, object_ids uuid[] not null default '{}', last_login_at timestamptz);
create table public.tenders(id uuid primary key default gen_random_uuid(), title text not null);
create table public.s3_documents(id uuid primary key default gen_random_uuid(), uploaded_by uuid, file_name text not null);
alter table public.user_roles enable row level security;
alter table public.tenders enable row level security;
alter table public.s3_documents enable row level security;
create policy roles_self on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy tenders_all on public.tenders for select to authenticated using (true);
create policy docs_all on public.s3_documents for select to authenticated using (true);
insert into public.user_roles (user_id, role, is_approved, email, full_name) values
  ('${ADMIN.id}', 'admin', true, '${ADMIN.email}', 'Админ'), ('${ANNA.id}', 'engineer', true, '${ANNA.email}', 'Анна'),
  ('${BORIS.id}', 'engineer', true, '${BORIS.email}', 'Борис');
insert into public.s3_documents (uploaded_by, file_name) values ('${ANNA.id}', 'план.pdf'), ('${BORIS.id}', 'смета.xlsx');
insert into public.tenders (title) values ('Тендер 1');
`

describe('Перенос учёток и паролей для своего входа: от Supabase до входа в osp-api', { skip, timeout: 1200000 }, () => {
  let tmp
  let prodPort
  let targetPort
  let envFile
  let migDir
  let pubFile
  let keyFile
  let apiEnvFile
  let authKeys
  let bcrypt
  let firstCopy
  const prodContainer = `osp-oa-prod-${process.pid}`
  const targetContainer = `osp-oa-target-${process.pid}`

  const psql = (port, user, pass, db, sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pass, PGSSLMODE: 'disable', PGAPPNAME: 'osp-test' } })
  const prod = (sql) => { const r = psql(prodPort, 'postgres', '', 'postgres', sql); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  // Под учёткой-владельцем с отметкой — как служба.
  const owner = (mark, sql) => {
    const r = psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target', `begin; set local application_name = '${mark}'; ${sql}; commit;`)
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''
  }
  const run = (script, args, env = {}) => {
    const res = spawnSync('bash', [script, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'),
        PROBE_CONNECT_TIMEOUT: '5', OSP_MIGRATIONS_DIR: migDir, OSP_TOOL_COMMIT: 'test-commit', ...env } })
    return { ...res, all: res.stdout + res.stderr }
  }
  const backup = (args = []) => {
    const out = path.join(tmp, `dumps-${crypto.randomUUID()}`)
    const res = spawnSync('bash', [path.join(BACKUP, 'backup.sh'), ...args], { encoding: 'utf8', cwd: ROOT, timeout: 300000,
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(prodPort), PGUSER: 'postgres', PGDATABASE: 'postgres',
        PGSSLMODE: 'disable', PGPASSWORD: 'test-only', BACKUP_OUT_DIR: out } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const base = path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.auth-users.csv')).replace(/\.auth-users\.csv$/, ''))
    return { base, out: res.stdout + res.stderr }
  }
  const sync = (copy, mode, extra = []) => run(path.join(ACCOUNTS, 'accounts-sync.sh'), [envFile, '--users', `${copy.base}.auth-users.csv`,
    '--credentials', `${copy.base}.auth-credentials.sealed`, '--manifest', `${copy.base}.auth-credentials.manifest.json`,
    '--transfer-key', keyFile, '--auth-keys-file', apiEnvFile, ...extra, mode])
  const counter = (out, name) => Number(new RegExp(`^ {2}${name}=(\\d+)$`, 'm').exec(out)?.[1] ?? NaN)
  const waitFor = (probe, what) => {
    const deadline = Date.now() + 120000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`${what} не поднялся`)
      spawnSync('sleep', ['0.5'])
    }
  }
  const setProdPassword = async (user, password) => {
    const hash = (await bcrypt.hash(password, 10)).replace(/^\$2b\$/, '$2a$')
    prod(`update auth.users set encrypted_password = '${hash}' where id = '${user.id}'`)
  }

  // osp-api в режиме own поверх этой базы: вход — настоящий.
  async function withApi(fn) {
    const { buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
    const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]') }) })
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
    const app = buildApp({ deps: defaultDeps, logger: false, config: {
      host: '127.0.0.1', port: 0, supabaseUrl: '', supabaseAnonKey: '', supabaseServiceKey: '', supabaseJwtSecret: '',
      s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' }, anthropicApiKey: '', ratesApiKeys: [],
      required: ['db', 'gateway', 'auth'],
      db: { url: `postgres://target_owner:${OWNER_PASS}@127.0.0.1:${targetPort}/osp_target`, caFile: '', poolMax: 2, secondLockRole: '' },
      dbGateway: { upstream: `http://127.0.0.1:${upstream.address().port}`, secret: 'gw-secret-0123456789-0123456789-abcdef', dbRole: 'target_owner', readOnlyFile: '' },
      authMode: 'own', auth: { keys: authKeys, pilotIds: [], publicOrigin: ORIGIN, idleDays: 14, absoluteDays: 30, sessionCacheMs: 0 },
      userStatusTtlMs: 0, authCleanup: false,
    } })
    await app.ready()
    const login = (email, password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password },
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' } })
    try {
      return await fn({ app, login })
    } finally {
      await app.close()
      upstream.close()
    }
  }

  before(async () => {
    bcrypt = (await import(path.join(SERVER, 'node_modules', 'bcryptjs', 'index.js'))).default
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-accounts-'))
    migDir = path.join(tmp, 'yandex')
    fs.mkdirSync(migDir)
    for (const f of ['20261019_own_auth.sql', '20261019_own_auth.check.sql']) fs.copyFileSync(path.join(ROOT, 'migration', 'yandex', f), path.join(migDir, f))
    // Ключ переноса (как transfer-key-init на corp) и ключ сервера (как auth-key-init) — в файле окружения API.
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
    pubFile = path.join(tmp, 'transfer.pub.pem')
    keyFile = path.join(tmp, 'accounts-transfer.key')
    fs.writeFileSync(pubFile, pair.publicKey.export({ type: 'spki', format: 'pem' }))
    fs.writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    authKeys = `k1:${crypto.randomBytes(32).toString('base64')}`
    apiEnvFile = path.join(tmp, 'osp-api.env')
    fs.writeFileSync(apiEnvFile, `# настройки службы\nAUTH_MODE=supabase\nOSP_AUTH_KEYS=${authKeys}\n`, { mode: 0o600 })

    prodPort = 26000 + Math.floor(Math.random() * 1000)
    targetPort = 27000 + Math.floor(Math.random() * 1000)
    let started = spawnSync('docker', ['run', '-d', '--rm', '--name', prodContainer, '-p', `127.0.0.1:${prodPort}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    started = spawnSync('docker', ['run', '-d', '--rm', '--name', targetContainer, '-p', `127.0.0.1:${targetPort}:5432`,
      '-e', `POSTGRES_PASSWORD=${ADMIN_PASS}`, '-e', 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=icu --icu-locale=en-US',
      'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    waitFor(() => psql(prodPort, 'postgres', '', 'postgres', 'select 1').stdout.trim() === '1', '«прод»')
    waitFor(() => psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', 'select 1').stdout.trim() === '1', 'целевая база')
    prod(PROD_SQL)
    for (const u of PLATFORM_USERS) await setProdPassword(u, PASS[u.id])
    for (const sql of [
      `create role target_owner login password '${OWNER_PASS}' nosuperuser nocreaterole nocreatedb`,
      "create database osp_target owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
      'revoke connect on database osp_target from public',
      "create database neighbour_db owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
    ]) assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', sql).status, 0, sql)
    assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'osp_target', 'create extension pg_trgm; create extension pgcrypto').status, 0)
    envFile = path.join(tmp, 'target.env')
    fs.writeFileSync(envFile, ['PGHOST=127.0.0.1', `PGPORT=${targetPort}`, 'PGDATABASE=osp_target', 'PGUSER=target_owner',
      `PGPASSWORD=${OWNER_PASS}`, 'PGSSLMODE=disable'].join('\n') + '\n', { mode: 0o600 })

    firstCopy = backup(['--credentials', pubFile])
    const dump = `${firstCopy.base}.dump`
    let res = spawnSync('bash', [path.join(BACKUP, 'verify.sh'), dump], { encoding: 'utf8', cwd: ROOT, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    for (const [script, args] of [['pin.sh', [envFile, '--confirm']], ['load.sh', [envFile, dump, '--status', 'rehearsal', '--single-owner', '--auth']],
      ['rights.sh', [envFile, dump]], ['migrate.sh', [envFile, '--yes']]]) {
      res = run(path.join(TARGET, script), args)
      assert.equal(res.status, 0, `${script}: ${res.all}`)
    }
  })

  after(() => {
    spawnSync('docker', ['rm', '-fv', prodContainer, targetContainer], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('выгрузка паролей запечатана: в файлах и выводе нет ни отпечатков, ни почт; опись — только числа', () => {
    const sealed = fs.readFileSync(`${firstCopy.base}.auth-credentials.sealed`, 'utf8')
    const manifest = JSON.parse(fs.readFileSync(`${firstCopy.base}.auth-credentials.manifest.json`, 'utf8'))
    assert.equal(manifest.rows, 3)
    assert.match(manifest.fingerprint, /^[0-9a-f]{64}$/)
    for (const text of [sealed, JSON.stringify(manifest), firstCopy.out]) {
      assert.doesNotMatch(text, /\$2[aby]\$/, 'отпечаток')
      for (const u of PLATFORM_USERS) assert.ok(!text.includes(u.email), 'почта')
    }
    assert.equal((fs.statSync(`${firstCopy.base}.auth-credentials.sealed`).mode & 0o077), 0, 'права 600')
  })

  it('--dry-run ничего не пишет; чужой ключ переноса и несовпавшая опись — отказ до записи', () => {
    const dry = sync(firstCopy, '--dry-run')
    assert.equal(dry.status, 0, dry.all)
    assert.equal(counter(dry.stdout, 'passwords_new'), 3)
    assert.equal(owner('osp:auth', 'select count(*) from osp_auth.credentials'), '0')
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
    const otherKey = path.join(tmp, 'other.key')
    fs.writeFileSync(otherKey, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const wrong = run(path.join(ACCOUNTS, 'accounts-sync.sh'), [envFile, '--users', `${firstCopy.base}.auth-users.csv`,
      '--credentials', `${firstCopy.base}.auth-credentials.sealed`, '--transfer-key', otherKey, '--auth-keys-file', apiEnvFile, '--yes'])
    assert.equal(wrong.status, 3, wrong.all)
    assert.match(wrong.stdout, /другим ключом переноса/)
    const badManifest = path.join(tmp, 'bad-manifest.json')
    fs.writeFileSync(badManifest, JSON.stringify({ rows: 3, sha256: '0'.repeat(64) }))
    const mismatch = run(path.join(ACCOUNTS, 'accounts-sync.sh'), [envFile, '--users', `${firstCopy.base}.auth-users.csv`,
      '--credentials', `${firstCopy.base}.auth-credentials.sealed`, '--manifest', badManifest, '--transfer-key', keyFile, '--auth-keys-file', apiEnvFile, '--yes'])
    assert.equal(mismatch.status, 3)
    assert.equal(owner('osp:auth', 'select count(*) from osp_auth.credentials'), '0')
  })

  it('--yes: пароли перенесены, копия базы снята, соседи не тронуты; accounts-check — готово; вход в osp-api прежним паролем', async () => {
    const res = sync(firstCopy, '--yes')
    assert.equal(res.status, 0, res.all)
    assert.equal(counter(res.stdout, 'passwords_new'), 3)
    assert.match(res.stdout, /OK копия базы перед переносом учёток/)
    assert.match(res.stdout, /OK соседи по кластеру не изменились/)
    for (const u of PLATFORM_USERS) assert.ok(!res.all.includes(u.email) && !res.all.includes(PASS[u.id]))
    assert.equal(owner('osp:internal', 'select count(*) from osp_auth.credentials'), '0', 'пропуск служебных функций паролей не видит')
    assert.equal(owner('osp:auth', "select count(*) from osp_auth.meta where key = 'canary'"), '1')
    const check = run(path.join(ACCOUNTS, 'accounts-check.sh'), [envFile])
    assert.equal(check.status, 0, check.all)
    assert.match(check.stdout, /OK каждый пользователь портала и каждый владелец записей есть в auth\.users: 3 учёток/)
    assert.match(check.stdout, /ИТОГ: свой вход готов к включению/)

    await withApi(async ({ app, login }) => {
      const ok = await login(ANNA.email, PASS[ANNA.id])
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal((await login(ANNA.email, 'wrong-password-xx')).statusCode, 400)
      const ready = await app.inject({ method: 'GET', url: '/api/ready' })
      assert.equal(ready.json().checks.auth, 'ok', ready.body)
      // Вход пересчитывает отпечаток в scrypt, но пароль тот же — источник прежний (supabase).
      const boris = await login(BORIS.email, PASS[BORIS.id])
      assert.equal(boris.statusCode, 200)
      assert.equal(owner('osp:auth', `select algo || ':' || source from osp_auth.credentials where user_id = '${BORIS.id}'`), 'scrypt:supabase')
      // Борис меняет пароль в новом портале — теперь это пароль нового портала (own).
      const cookies = [].concat(boris.headers['set-cookie']).map((c) => c.split(';')[0])
      const csrf = cookies.find((c) => c.startsWith('__Host-osp_csrf=')).split('=')[1]
      const changed = await app.inject({ method: 'POST', url: '/api/auth/password',
        payload: { currentPassword: PASS[BORIS.id], newPassword: BORIS_PORTAL_PASS },
        headers: { cookie: cookies.join('; '), 'x-osp-csrf': csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } })
      assert.equal(changed.statusCode, 200, changed.body)
    })
    assert.equal(owner('osp:auth', `select source from osp_auth.credentials where user_id = '${BORIS.id}'`), 'own')
  })

  it('повтор перед переключением: пароль, изменённый в Supabase, обновляется, сессии со старым отозваны; сменённый в новом портале — не трогается', async () => {
    await setProdPassword(ANNA, 'Anna-New-Pass-on-root-sx')
    await setProdPassword(BORIS, 'Boris-New-Pass-on-root-sx')
    owner('osp:internal', `insert into osp_session.sessions (id_hash, user_id, csrf, idle_expires_at, absolute_expires_at)
      values ('${'b'.repeat(64)}', '${ANNA.id}', 'c', now() + interval '1 day', now() + interval '2 days')`)
    const copy = backup(['--credentials', pubFile, '--accounts-only'])
    assert.ok(!fs.readdirSync(path.dirname(copy.base)).some((f) => f.endsWith('.dump')), 'без копии данных')
    const res = sync(copy, '--yes')
    assert.equal(res.status, 0, res.all)
    assert.equal(counter(res.stdout, 'passwords_changed_in_supabase'), 1, res.stdout)
    assert.equal(counter(res.stdout, 'passwords_kept_changed_here'), 1, res.stdout)
    assert.ok(counter(res.stdout, 'sessions_revoked') >= 1, res.stdout)
    assert.equal(owner('osp:internal', `select count(*) from osp_session.sessions where user_id = '${ANNA.id}' and revoked_at is null`), '0',
      'все сессии Анны со старым паролем отозваны')
    assert.equal(owner('osp:internal', `select revoke_reason from osp_session.sessions where id_hash = '${'b'.repeat(64)}'`), 'password_synced')
    const again = sync(copy, '--yes')
    assert.equal(again.status, 0, again.all)
    assert.equal(counter(again.stdout, 'passwords_changed_in_supabase'), 0, 'повтор ничего не меняет')
    await withApi(async ({ login }) => {
      assert.equal((await login(ANNA.email, PASS[ANNA.id])).statusCode, 400, 'старый пароль Анны не действует')
      assert.equal((await login(ANNA.email, 'Anna-New-Pass-on-root-sx')).statusCode, 200)
      assert.equal((await login(BORIS.email, BORIS_PORTAL_PASS)).statusCode, 200, 'пароль Бориса из нового портала сохранён')
      assert.equal((await login(BORIS.email, 'Boris-New-Pass-on-root-sx')).statusCode, 400, 'пароль из Supabase его не заменил')
    })
  })

  it('удалённая администратором учётка не воссоздаётся; --restore возвращает; дубли почты — остановка до записи', async () => {
    owner('osp:auth', `insert into osp_auth.tombstones (user_id, email_norm) values ('${ANNA.id}', 'anna@example.ru')`)
    owner('osp:internal', `delete from public.user_roles where user_id = '${ANNA.id}'; delete from auth.users where id = '${ANNA.id}'`)
    const copy = backup(['--credentials', pubFile, '--accounts-only'])
    let res = sync(copy, '--yes')
    assert.equal(res.status, 0, res.all)
    assert.equal(counter(res.stdout, 'users_tombstoned_skipped'), 1)
    assert.equal(owner('osp:internal', `select count(*) from auth.users where id = '${ANNA.id}'`), '0')
    res = sync(copy, '--yes', ['--restore', ANNA.id])
    assert.equal(res.status, 0, res.all)
    assert.equal(owner('osp:internal', `select count(*) from auth.users where id = '${ANNA.id}'`), '1')
    assert.equal(owner('osp:auth', `select count(*) from osp_auth.credentials where user_id = '${ANNA.id}'`), '1')
    assert.equal(owner('osp:auth', `select count(*) from osp_auth.tombstones where user_id = '${ANNA.id}'`), '0')

    const dupId = 'a0000000-0000-4000-8000-0000000000dd'
    prod(`insert into auth.users (id, aud, role, email, created_at, updated_at) values ('${dupId}', 'authenticated', 'authenticated', ' ANNA@example.ru ', now(), now())`)
    const dupCopy = backup(['--credentials', pubFile, '--accounts-only'])
    const before = owner('osp:internal', 'select count(*) from auth.users')
    res = sync(dupCopy, '--yes')
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /одна почта у нескольких учёток/)
    assert.equal(owner('osp:internal', 'select count(*) from auth.users'), before, 'ничего не записано')
    prod(`delete from auth.users where id = '${dupId}'`)
  })

  it('копия базы (export.sh) берёт пароли, проверка восстановлением проходит; сброс репетиции убирает схемы своего входа', () => {
    const exported = run(path.join(TARGET, 'export.sh'), [envFile])
    assert.equal(exported.status, 0, exported.all)
    const dir = path.join(tmp, 'exports', fs.readdirSync(path.join(tmp, 'exports')).filter((d) => d.startsWith('yandex-')).sort().at(-1))
    const manifest = fs.readFileSync(path.join(dir, 'manifest.tsv'), 'utf8')
    assert.match(manifest, /^osp_auth\.credentials\t3\t/m)
    assert.doesNotMatch(manifest, /^osp_session\./m, 'сессии в копию не берутся')
    const verified = spawnSync('bash', [path.join(TARGET, 'export-verify.sh'), dir], { encoding: 'utf8', cwd: ROOT, timeout: 400000 })
    assert.equal(verified.status, 0, verified.stdout + verified.stderr)
    const reset = run(path.join(TARGET, 'reset.sh'), [envFile, '--yes-drop-rehearsal'])
    assert.equal(reset.status, 0, reset.all)
    assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'osp_target', "select to_regnamespace('osp_auth') is null and to_regnamespace('osp_session') is null").stdout.trim(), 't')
  })
})
