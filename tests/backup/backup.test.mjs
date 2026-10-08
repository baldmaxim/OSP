// Резервная копия, проверка восстановлением и прогон миграций на копии
// (migration/backup/*.sh) на синтетическом «проде» в Docker — как настоящий
// Supabase: роли, auth.uid(), расширение в схеме extensions, RLS, функции с
// обращением к auth.users, материализованное представление с триграммным
// индексом, публикация Realtime. Нужны Docker, psql, pg_dump, pg_restore.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = path.join(ROOT, 'migration', 'backup')
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const CHECKS = path.join(SCRIPTS, 'checks')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : false

const SECRET_EMAIL = 'ivanov.secret@example.ru'

const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema extensions;
create extension pg_trgm with schema extensions;
create table auth.users(id uuid primary key, email text, created_at timestamptz, last_sign_in_at timestamptz, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create publication supabase_realtime;

create table public.counterparties(id uuid primary key default gen_random_uuid(), name text not null);
create table public.user_roles(
  id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null default 'engineer',
  is_approved boolean not null default false, email text,
  counterparty_id uuid references public.counterparties(id) on delete set null);
create table public.tenders(id uuid primary key default gen_random_uuid(), title text, object_name text);
alter table public.tenders enable row level security;
create policy tenders_auth on public.tenders for all to authenticated using (auth.uid() is not null);
create function public.is_admin() returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin' and ur.is_approved)
  or exists(select 1 from auth.users u where u.id = auth.uid() and lower(u.email) = 'boss@example.ru') $$;
create materialized view public.tenders_mv as select id, title from public.tenders;
create index tenders_mv_title_trgm on public.tenders_mv using gin (title extensions.gin_trgm_ops);
alter publication supabase_realtime add table public.tenders;

insert into public.counterparties(id, name) select gen_random_uuid(), 'ООО Подрядчик ' || g from generate_series(1, 30) g;
insert into public.user_roles(user_id, role, is_approved, email, counterparty_id)
  select gen_random_uuid(), 'contractor', true, 'user' || g || '@example.ru', (select id from public.counterparties order by name limit 1 offset g)
  from generate_series(1, 10) g;
insert into public.user_roles(user_id, role, is_approved, email) values (gen_random_uuid(), 'admin', true, '${SECRET_EMAIL}');
insert into public.tenders(title, object_name) select 'Тендер ' || g, 'Объект ' || g from generate_series(1, 500) g;
refresh materialized view public.tenders_mv;
`

describe('Копия прода: снятие, проверка восстановлением, прогон миграций', { skip, timeout: 600000 }, () => {
  let tmp
  let port
  const container = `osp-fake-prod-${process.pid}`
  const prodEnv = () => ({ ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres',
    PGDATABASE: 'postgres', PGSSLMODE: 'disable', PGPASSWORD: 'test-only', BACKUP_OUT_DIR: path.join(tmp, 'dumps') })
  const prodSql = (sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: '' } })
  const run = (script, args, env = process.env) => spawnSync('bash', [path.join(SCRIPTS, script), ...args],
    { encoding: 'utf8', env, cwd: ROOT, timeout: 300000 })
  const writeTmp = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p }
  let dump

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-backup-'))
    port = 50000 + Math.floor(Math.random() * 4000)
    const started = spawnSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    const deadline = Date.now() + 120000
    while (prodSql('select 1').stdout.trim() !== '1') {
      if (Date.now() > deadline) throw new Error('fake prod did not start')
      spawnSync('sleep', ['0.5'])
    }
    const seeded = prodSql(PROD_SQL)
    assert.equal(seeded.status, 0, seeded.stderr)
  })
  after(() => {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('backup.sh: копия, подсчёт до и после, контрольная сумма, права 600', () => {
    const res = run('backup.sh', [], prodEnv())
    assert.equal(res.status, 0, res.stderr + res.stdout)
    const files = fs.readdirSync(path.join(tmp, 'dumps'))
    const name = files.find((f) => f.endsWith('.dump'))
    assert.ok(name, files.join(','))
    dump = path.join(tmp, 'dumps', name)
    for (const suffix of ['.counts-before.tsv', '.counts-after.tsv']) {
      assert.ok(files.includes(name.replace(/\.dump$/, suffix)), suffix)
    }
    assert.ok(files.includes(`${name}.sha256`))
    assert.equal(fs.statSync(dump).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(tmp, 'dumps')).mode & 0o777, 0o700)
    assert.match(res.stdout, /таблиц: 3/)
    assert.ok(!(res.stdout + res.stderr).includes(SECRET_EMAIL))
  })

  it('verify.sh: копия восстанавливается без ошибок, число строк совпадает', () => {
    const res = run('verify.sh', [dump])
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /КОПИЯ ГОДНА: таблиц 3, строк 541/)
    assert.ok(!(res.stdout + res.stderr).includes(SECRET_EMAIL), 'данные в вывод не попадают')
  })

  it('verify.sh: повреждённая копия отклоняется', () => {
    const broken = path.join(tmp, 'dumps', 'broken.dump')
    fs.copyFileSync(dump, broken)
    for (const s of ['.counts-before.tsv', '.counts-after.tsv']) fs.copyFileSync(dump.replace(/\.dump$/, s), broken.replace(/\.dump$/, s))
    fs.writeFileSync(`${broken}.sha256`, fs.readFileSync(`${dump}.sha256`, 'utf8').replace(path.basename(dump), 'broken.dump'))
    const fd = fs.openSync(broken, 'r+')
    fs.writeSync(fd, Buffer.from('XXXX'), 0, 4, 200)
    fs.closeSync(fd)
    const res = run('verify.sh', [broken])
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /КОПИЯ ПОВРЕЖДЕНА/)
  })

  it('rehearse.sh: 20261006 и 20261007 годны — два прогона, строки не изменились, проверки OK', () => {
    let res = run('rehearse.sh', [dump, path.join(MIGRATIONS, '20261006_user_roles_counterparty_restrict.sql'), path.join(CHECKS, '20261006.sql')])
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /^OK user_roles\.counterparty_id → counterparties ON DELETE RESTRICT \(user_roles_counterparty_id_fkey: RESTRICT\)$/m)
    assert.match(res.stdout, /МИГРАЦИЯ ГОДНА: два прогона без ошибок, число строк во всех 3 прежних таблицах не изменилось/)
    res = run('rehearse.sh', [dump, path.join(MIGRATIONS, '20261007_client_telemetry.sql'), path.join(CHECKS, '20261007.sql')])
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /client_versions .* новая таблица/)
    assert.equal((res.stdout.match(/^OK /gm) || []).length, 10, res.stdout)
    assert.doesNotMatch(res.stdout, /^FAIL/m)
    assert.match(res.stdout, /МИГРАЦИЯ ГОДНА/)
  })

  it('rehearse.sh: проверка не прошла — миграция не годна', () => {
    // 20261006 не применена: ограничение осталось SET NULL
    let res = run('rehearse.sh', [dump, writeTmp('noop.sql', 'select 1;'), path.join(CHECKS, '20261006.sql')])
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /^FAIL user_roles\.counterparty_id .*SET NULL/m)
    assert.match(res.stdout, /МИГРАЦИЯ НЕ ГОДНА/)
    // телеметрия без REVOKE: права по умолчанию, как в Supabase, открыли бы её anon
    const leaky = fs.readFileSync(path.join(MIGRATIONS, '20261007_client_telemetry.sql'), 'utf8')
      .split('\n').filter((l) => !/^REVOKE /.test(l)).join('\n')
    res = run('rehearse.sh', [dump, writeTmp('leaky.sql', leaky), path.join(CHECKS, '20261007.sql')])
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /^FAIL client_versions: anon и PUBLIC — без прав/m)
    assert.match(res.stdout, /^FAIL public\.report_client_version\(text\)/m)
    assert.match(res.stdout, /МИГРАЦИЯ НЕ ГОДНА/)
  })

  it('rehearse.sh: миграция, которая теряет строки, не годна', () => {
    const bad = path.join(tmp, 'bad.sql')
    fs.writeFileSync(bad, "delete from public.tenders where title like 'Тендер 1%';")
    const res = run('rehearse.sh', [dump, bad])
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /tenders .* ЧИСЛО СТРОК ИЗМЕНИЛОСЬ/)
    assert.match(res.stdout, /МИГРАЦИЯ НЕ ГОДНА/)
  })

  it('rehearse.sh без проверенной копии отказывается', () => {
    const unverified = path.join(tmp, 'dumps', 'broken.dump')
    const res = run('rehearse.sh', [unverified, path.join(MIGRATIONS, '20261006_user_roles_counterparty_restrict.sql')])
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /не проверена/)
  })

  it('counts.sh: после миграции на «проде» тревог нет; пропавшие строки — тревога', () => {
    const ref = dump.replace(/\.dump$/, '.counts-after.tsv')
    const migrated = prodSql(fs.readFileSync(path.join(MIGRATIONS, '20261006_user_roles_counterparty_restrict.sql'), 'utf8'))
    assert.equal(migrated.status, 0, migrated.stderr)
    let res = run('counts.sh', [ref], prodEnv())
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /Тревог: 0/)
    assert.equal(prodSql("delete from public.tenders where title = 'Тендер 7'").status, 0)
    res = run('counts.sh', [ref], prodEnv())
    assert.notEqual(res.status, 0)
    assert.match(res.stdout, /tenders .* СТАЛО МЕНЬШЕ/)
  })
})
