// Загрузка копии прода в базу без Supabase (migration/target: load.sh, verify.sh, reset.sh, lib/rewrite.mjs).
// Синтетический «прод» как Supabase → backup.sh и verify.sh дают проверенную копию → загрузка в базу,
// настроенную как выданная: владелец без прав суперпользователя и без права создавать роли, роль
// приложения, расширения в public, часовой пояс сервера — Москва.
// Проверяем обещанное: загрузка — всё или ничего; сверка ловит любую подмену; права те же, но у роли
// приложения; очистка убирает только репетицию и никогда — настоящий перенос; данных в выводе нет.
// Нужны Docker, psql, pg_dump, pg_restore.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteAcl, splitToc } from '../../migration/target/lib/rewrite.mjs'
import { PLATFORM_SQL, coversJournal } from './lib/supabase-platform.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKUP = path.join(ROOT, 'migration', 'backup')
const TARGET = path.join(ROOT, 'migration', 'target')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : false

describe('Преобразование копии: роли Supabase → роль приложения (lib/rewrite.mjs)', () => {
  const HEAD = (name, type) => `--\n-- Name: ${name}; Type: ${type}; Schema: public; Owner: -\n--\n\n`

  it('оглавление: основное и права — отдельно; схема public и права по умолчанию не переносятся', () => {
    const toc = [
      '; Archive created at 2026-10-09', ';',
      '7; 2615 2200 SCHEMA - public pg_database_owner',
      '4100; 0 0 COMMENT - SCHEMA public pg_database_owner',
      '300; 1259 17290 TABLE public tenders postgres',
      '4200; 0 17290 TABLE DATA public tenders postgres',
      '4300; 3256 20001 POLICY public tenders tenders_auth postgres',
      '4400; 0 0 ACL public TABLE tenders postgres',
      '4500; 826 30001 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres',
      '4600; 0 17290 MATERIALIZED VIEW DATA public tenders_mv postgres',
    ].join('\n')
    const { main, acl, report } = splitToc(toc)
    assert.deepEqual(main.trim().split('\n').map((l) => l.split(';')[0]), ['300', '4200', '4600'])
    assert.deepEqual(acl.trim().split('\n').map((l) => l.split(';')[0]), ['4300', '4400'])
    assert.deepEqual(report.skipped, { schemaPublic: 2, defaultAcl: 1 })
    assert.equal(report.byType['TABLE DATA'], 1)
    assert.equal(report.byType['MATERIALIZED VIEW DATA'], 1)
  })

  it('оглавление: незнакомый вид записи или чужая схема — отказ', () => {
    assert.throws(() => splitToc('10; 1 2 EVENT TRIGGER - evt postgres'), /незнакомый вид записи/)
    assert.throws(() => splitToc('10; 2615 99 SCHEMA - other postgres'), /неожиданная схема/)
    assert.throws(() => splitToc('что-то не то'), /непонятная строка/)
  })

  it('политики: authenticated → роль приложения; только anon — не переносится целиком', () => {
    const sql = HEAD('tenders Allow all', 'POLICY')
      + 'CREATE POLICY "Allow all for authenticated users" ON public.tenders TO authenticated USING ((auth.uid() IS NOT NULL)) WITH CHECK (true);\n\n\n'
      + HEAD('showcase anon', 'POLICY')
      + 'CREATE POLICY showcase_anon ON public.showcase FOR SELECT TO anon USING ((\n  title IS NOT NULL\n));\n\n\n'
      + HEAD('user_roles mixed', 'POLICY')
      + 'CREATE POLICY "roles TO self ON purpose" ON public.user_roles AS RESTRICTIVE FOR SELECT TO authenticated, anon USING ((user_id = auth.uid()));\n'
    const { sql: out, report } = rewriteAcl(sql, 'osp_runtime')
    assert.match(out, /CREATE POLICY "Allow all for authenticated users" ON public\.tenders TO osp_runtime USING \(\(auth\.uid\(\) IS NOT NULL\)\) WITH CHECK \(true\);/)
    assert.match(out, /CREATE POLICY "roles TO self ON purpose" ON public\.user_roles AS RESTRICTIVE FOR SELECT TO osp_runtime USING/)
    assert.ok(!out.includes('showcase_anon'), 'политика только для anon убрана')
    assert.ok(!out.includes('title IS NOT NULL'), '…вместе с продолжением условия')
    const statements = out.split('\n').filter((l) => !l.startsWith('--')).join('\n').replace(/"[^"]*"/g, '')
    assert.ok(!/\b(authenticated|anon)\b/.test(statements), 'ролей Supabase в командах не осталось')
    assert.equal(report.policies.kept, 2)
    assert.deepEqual(report.policies.dropped, [{ table: 'public.showcase', name: 'showcase_anon', roles: ['anon'] }])
  })

  it('выдача прав: приложению — переносится, anon и service_role — нет, PUBLIC — как есть', () => {
    const sql = HEAD('TABLE tenders', 'ACL')
      + 'GRANT ALL ON TABLE public.tenders TO anon;\nGRANT ALL ON TABLE public.tenders TO authenticated;\nGRANT ALL ON TABLE public.tenders TO service_role;\n\n\n'
      + HEAD('FUNCTION is_admin()', 'ACL')
      + 'REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;\nGRANT ALL ON FUNCTION public.is_admin() TO authenticated WITH GRANT OPTION;\n'
      + 'GRANT SELECT(id,title) ON TABLE public.tenders TO authenticated;\nGRANT USAGE ON SCHEMA public TO postgres;\n'
    const { sql: out, report } = rewriteAcl(sql, 'osp_runtime')
    assert.deepEqual(out.split('\n').filter((l) => /^(GRANT|REVOKE)/.test(l)), [
      'GRANT ALL ON TABLE public.tenders TO osp_runtime;',
      'REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;',
      'GRANT ALL ON FUNCTION public.is_admin() TO osp_runtime WITH GRANT OPTION;',
      'GRANT SELECT(id,title) ON TABLE public.tenders TO osp_runtime;',
    ])
    assert.deepEqual(report.grants, { toRuntime: 3, publicKept: 1, droppedByRole: { anon: 1, service_role: 1, postgres: 1 } })
  })

  it('незнакомая роль, незнакомая строка, чужой вид записи, плохое имя роли — отказ', () => {
    assert.throws(() => rewriteAcl(HEAD('t', 'ACL') + 'GRANT ALL ON TABLE public.t TO weird_role;\n', 'osp_runtime'), /незнакомая роль «weird_role»/)
    assert.throws(() => rewriteAcl(HEAD('p', 'POLICY') + 'CREATE POLICY p ON public.t TO weird_role USING (true);\n', 'osp_runtime'), /незнакомая роль/)
    assert.throws(() => rewriteAcl(HEAD('t', 'ACL') + 'DROP TABLE public.t;\n', 'osp_runtime'), /не похожа ни на одну известную форму/)
    assert.throws(() => rewriteAcl(HEAD('t', 'TABLE') + 'CREATE TABLE public.t (id int);\n', 'osp_runtime'), /запись вида «TABLE» в файле прав/)
    assert.throws(() => rewriteAcl(HEAD('p', 'POLICY') + 'CREATE POLICY p ON public.t USING (true);\n', 'osp_runtime'), /нет роли \(TO\)/)
    assert.throws(() => rewriteAcl('', 'osp_runtime; DROP'), /недопустимое имя/)
  })
})

const SECRET_EMAIL = 'ivanov.secret@example.ru'
const ADMIN_PASS = 'Admin-Pass-zz1-secret'
const OWNER_PASS = 'Owner-Pass-zz2-secret'
const RUNTIME_PASS = 'Runtime-Pass-zz3-secret'
const USER_ID = '11111111-1111-4111-8111-111111111111'

// «Прод» как Supabase: роли, auth.uid(), права по умолчанию «всем ролям», политики для authenticated и
// для anon, значение по умолчанию auth.uid(), счётчик, тип, функция, материализованное представление.
const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension pg_trgm with schema public;
${PLATFORM_SQL}
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create type public.tender_kind as enum ('main', 'materials');
create sequence public.tender_number_seq;
create table public.tenders(
  id uuid primary key default gen_random_uuid(), number bigint not null default nextval('public.tender_number_seq'),
  title text not null, kind public.tender_kind not null default 'main', created_at timestamptz not null default now(),
  plain_ts timestamp, created_by uuid default auth.uid());
alter sequence public.tender_number_seq owned by public.tenders.number;
create table public.showcase(id int primary key, title text);
create table public.user_roles(id uuid primary key default gen_random_uuid(), user_id uuid not null unique, role text not null, email text);
alter table public.tenders enable row level security;
alter table public.showcase enable row level security;
alter table public.user_roles enable row level security;
create policy "Allow all for authenticated users" on public.tenders for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy tenders_anon_read on public.tenders for select to anon using (kind = 'main');
create policy showcase_anon on public.showcase for select to anon using (true);
create policy "roles TO self ON purpose" on public.user_roles for select to authenticated, anon using (user_id = auth.uid());
create function public.is_admin() returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin') $$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;
create view public.tender_titles as select id, title from public.tenders;
create materialized view public.tenders_mv as select distinct on (lower(title)) id, title from public.tenders order by lower(title), id;
create index tenders_title_trgm on public.tenders using gin (title public.gin_trgm_ops);
create index tenders_mv_title on public.tenders_mv (title);

insert into public.tenders(title, kind, plain_ts)
  select (array['ёж','Ель','еж','Яма','Бетон','бетон','ООО «Ромашка»'])[1 + g % 7] || ' ' || g,
         case when g % 5 = 0 then 'materials' else 'main' end::public.tender_kind, timestamp '2026-10-01 12:00:00' + g * interval '1 minute'
  from generate_series(1, 300) g;
insert into public.user_roles(user_id, role, email) select gen_random_uuid(), 'viewer-' || g, 'user' || g || '@example.ru' from generate_series(1, 5) g;
insert into public.user_roles(user_id, role, email) values ('${USER_ID}', 'admin', '${SECRET_EMAIL}');
insert into public.showcase values (1, 'Витрина 1'), (2, 'Витрина 2'), (3, 'Витрина 3');
refresh materialized view public.tenders_mv;
`

describe('Загрузка копии в базу без Supabase: всё или ничего, сверка, очистка', { skip, timeout: 900000 }, () => {
  let tmp
  let prodPort
  let targetPort
  let dump
  let envFile
  const prodContainer = `osp-load-prod-${process.pid}`
  const targetContainer = `osp-load-target-${process.pid}`

  const psql = (port, user, pass, db, sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pass, PGSSLMODE: 'disable' } })
  const prodSql = (sql) => psql(prodPort, 'postgres', '', 'postgres', sql)
  const admin = (sql) => {
    const res = psql(targetPort, 'postgres', ADMIN_PASS, 'osp_target', sql)
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  const asRuntime = (sql) => psql(targetPort, 'osp_runtime', RUNTIME_PASS, 'osp_target', sql)
  const asOwner = (sql) => psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target', sql)
  const prodEnv = () => ({ ...process.env, PGHOST: '127.0.0.1', PGPORT: String(prodPort), PGUSER: 'postgres',
    PGDATABASE: 'postgres', PGSSLMODE: 'disable', PGPASSWORD: 'test-only', BACKUP_OUT_DIR: path.join(tmp, 'dumps') })
  const run = (script, args, env = {}) => {
    const res = spawnSync('bash', [script, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 400000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), PROBE_CONNECT_TIMEOUT: '5', ...env } })
    return { ...res, all: res.stdout + res.stderr }
  }
  const load = (args, env) => run(path.join(TARGET, 'load.sh'), [envFile, dump, ...args], env)
  const verify = (...args) => run(path.join(TARGET, 'verify.sh'), [envFile, dump, ...args])
  const reset = () => run(path.join(TARGET, 'reset.sh'), [envFile, '--yes-drop-rehearsal'])
  const noSecrets = (r) => {
    for (const s of [SECRET_EMAIL, ADMIN_PASS, OWNER_PASS, RUNTIME_PASS]) assert.ok(!r.all.includes(s), `в выводе: ${s}`)
  }
  // «Пусто» — как у выданной базы: ни таблиц, ни схем кроме public, ни своих функций, ни настройки пояса.
  const stateOfTarget = () => admin(`
    select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r','p','v','m','S') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_')
        || ':' || (select count(*) from pg_namespace where nspname not in ('pg_catalog','information_schema','public') and nspname !~ '^pg_')
        || ':' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
                   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))
        || ':' || (select count(*) from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = current_database())
        || ':' || (select string_agg(extname, ',' order by extname) from pg_extension where extname <> 'plpgsql')
        || ':' || (select count(*) from pg_default_acl)`)
  const EMPTY = '0:0:0:0:pg_trgm,pgcrypto:0'
  const waitFor = (probe, what) => {
    const deadline = Date.now() + 120000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`${what} не поднялся`)
      spawnSync('sleep', ['0.5'])
    }
  }
  const counts = (suffix) => path.join(tmp, 'dumps', path.basename(dump).replace(/\.dump$/, `.counts-${suffix}.tsv`))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-load-'))
    prodPort = 23000 + Math.floor(Math.random() * 1000) // свои диапазоны (наборы идут параллельно), ниже портов исходящих соединений
    targetPort = 24000 + Math.floor(Math.random() * 1000)
    let started = spawnSync('docker', ['run', '-d', '--rm', '--name', prodContainer, '-p', `127.0.0.1:${prodPort}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    started = spawnSync('docker', ['run', '-d', '--rm', '--name', targetContainer, '-p', `127.0.0.1:${targetPort}:5432`,
      '-e', `POSTGRES_PASSWORD=${ADMIN_PASS}`, '-e', 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=icu --icu-locale=en-US',
      'postgres:17-alpine', '-c', 'fsync=off', '-c', 'timezone=Europe/Moscow'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    waitFor(() => prodSql('select 1').stdout.trim() === '1', '«прод»')
    waitFor(() => psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', 'select 1').stdout.trim() === '1', 'целевая база')
    const seeded = prodSql(PROD_SQL)
    assert.equal(seeded.status, 0, seeded.stderr)
    // Как в Яндексе: роли и расширения создаёт не владелец базы.
    for (const sql of [
      `create role target_owner login password '${OWNER_PASS}' nosuperuser nocreaterole nocreatedb`,
      `create role osp_runtime login password '${RUNTIME_PASS}'`,
      "create database osp_target owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
      // Как в Яндексе: подключение к базе у «всех» снято, соседней учётке выдано явно.
      'revoke connect on database osp_target from public',
      'grant connect on database osp_target to osp_runtime',
      // Вторая база той же учётки: загрузка и очистка не должны в неё попасть.
      "create database neighbour_db owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
      'revoke connect on database neighbour_db from public',
    ]) assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', sql).status, 0, sql)
    admin('create extension pg_trgm')
    admin('create extension pgcrypto')
    envFile = path.join(tmp, 'target.env')
    fs.writeFileSync(envFile, ['PGHOST=127.0.0.1', `PGPORT=${targetPort}`, 'PGDATABASE=osp_target', 'PGUSER=target_owner',
      `PGPASSWORD=${OWNER_PASS}`, 'PGSSLMODE=disable'].join('\n') + '\n', { mode: 0o600 })

    // Проверенная копия — обычным путём: backup.sh и verify.sh.
    let res = spawnSync('bash', [path.join(BACKUP, 'backup.sh')], { encoding: 'utf8', cwd: ROOT, env: prodEnv(), timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    dump = path.join(tmp, 'dumps', fs.readdirSync(path.join(tmp, 'dumps')).find((f) => f.endsWith('.dump')))
    res = spawnSync('bash', [path.join(BACKUP, 'verify.sh'), dump], { encoding: 'utf8', cwd: ROOT, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.ok(fs.existsSync(dump.replace(/\.dump$/, '.verified')), 'отметка проверенной копии')
    assert.equal(stateOfTarget(), EMPTY)
  })
  const pin = (file, args = ['--confirm']) => run(path.join(TARGET, 'pin.sh'), [file, ...args])
  const objectsIn = (db) => psql(targetPort, 'postgres', ADMIN_PASS, db,
    "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','v','m','S') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'").stdout.trim()

  it('отпечаток базы: без него и в другую базу той же учётки — отказ до первой записи', () => {
    const unpinned = load(['--status', 'rehearsal'])
    assert.equal(unpinned.status, 3, unpinned.all)
    assert.match(unpinned.stdout, /^FAIL база не закреплена: сначала bash migration\/target\/pin\.sh/m)

    const shown = pin(envFile, [])
    assert.equal(shown.status, 0, shown.all)
    assert.match(shown.stdout, /ИНФО в имени базы есть «osp»: да; роль — владелец базы: да/)
    assert.match(shown.stdout, /Не закреплено\. Если это база портала — повторите с --confirm/)
    assert.ok(!fs.existsSync(`${envFile}.pin`), 'без --confirm файл не пишется')

    const pinned = pin(envFile)
    assert.equal(pinned.status, 0, pinned.all)
    assert.match(pinned.stdout, /^OK база закреплена: target\.env\.pin/m)
    assert.equal(fs.statSync(`${envFile}.pin`).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(`${envFile}.pin`, 'utf8'), /^[0-9a-f]{64}\n$/)
    assert.match(pin(envFile).stdout, /^OK эта база уже закреплена$/m)

    // Опечатка в файле подключения: та же учётка, другая база — отпечаток прежний, значит отказ.
    const wrong = path.join(tmp, 'wrong.env')
    fs.writeFileSync(wrong, fs.readFileSync(envFile, 'utf8').replace('PGDATABASE=osp_target', 'PGDATABASE=neighbour_db'), { mode: 0o600 })
    fs.copyFileSync(`${envFile}.pin`, `${wrong}.pin`)
    const other = run(path.join(TARGET, 'load.sh'), [wrong, dump, '--status', 'rehearsal'])
    assert.equal(other.status, 3, other.all)
    assert.match(other.stdout, /^FAIL это другая база: отпечаток не совпадает с закреплённым/m)
    const otherReset = run(path.join(TARGET, 'reset.sh'), [wrong, '--yes-drop-rehearsal'])
    assert.equal(otherReset.status, 3, otherReset.all)
    assert.match(otherReset.stdout, /это другая база — отпечаток не совпадает/)
    const repin = pin(wrong)
    assert.equal(repin.status, 3, repin.all)
    assert.match(repin.stdout, /^FAIL закреплена другая база/m)
    assert.equal(objectsIn('neighbour_db'), '0', 'в соседней базе ничего не создано')
    assert.equal(stateOfTarget(), EMPTY)
    for (const r of [unpinned, shown, pinned, other, otherReset, repin]) noSecrets(r)
  })
  after(() => {
    spawnSync('docker', ['rm', '-fv', prodContainer, targetContainer], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('отказы до начала: непроверенная копия, нет роли приложения, не владелец — база не тронута', () => {
    const unverified = path.join(tmp, 'dumps', 'unverified.dump')
    fs.copyFileSync(dump, unverified)
    const noMark = run(path.join(TARGET, 'load.sh'), [envFile, unverified, '--status', 'rehearsal'])
    assert.equal(noMark.status, 1)
    assert.match(noMark.stderr, /Копия не проверена восстановлением/)

    const noRole = load(['--status', 'rehearsal', '--runtime-role', 'nope_role'])
    assert.equal(noRole.status, 3, noRole.all)
    assert.match(noRole.stdout, /^FAIL роль приложения nope_role существует/m)
    assert.match(noRole.stdout, /Загрузка не начата: в базе ничего не изменилось/)

    const notOwner = path.join(tmp, 'runtime.env')
    fs.writeFileSync(notOwner, fs.readFileSync(envFile, 'utf8').replace('PGUSER=target_owner', 'PGUSER=osp_runtime').replace(OWNER_PASS, RUNTIME_PASS))
    fs.copyFileSync(`${envFile}.pin`, `${notOwner}.pin`) // база та же — отпечаток тот же
    const asApp = run(path.join(TARGET, 'load.sh'), [notOwner, dump, '--status', 'rehearsal'])
    assert.equal(asApp.status, 3, asApp.all)
    assert.match(asApp.stdout, /^FAIL роль подключения — владелец базы/m)
    assert.match(asApp.stdout, /^FAIL роль приложения — не владелец/m)

    assert.equal(load([]).status, 1, 'без --status')
    assert.equal(load(['--status', 'prod']).status, 1, 'незнакомый статус')
    assert.equal(stateOfTarget(), EMPTY)
    for (const r of [noMark, noRole, asApp]) noSecrets(r)
  })

  it('всё или ничего: ошибка в самом конце загрузки — в базе не осталось ничего', () => {
    const res = load(['--status', 'rehearsal'], { OSP_LOAD_TEST_INJECT_FAILURE: '1' })
    assert.equal(res.status, 4, res.all)
    assert.match(res.stdout, /^FAIL загрузка прервана, транзакция отменена — в базе ничего не изменилось/m)
    assert.match(res.stdout, /причина: ERROR: division by zero/)
    assert.equal(stateOfTarget(), EMPTY)
    noSecrets(res)
  })

  it('загрузка: одной транзакцией; политики и права — у роли приложения; anon и service_role не перенесены', () => {
    const res = load(['--status', 'rehearsal'])
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /^OK база — та, что закреплена отпечатком$/m)
    assert.match(res.stdout, /^OK право подключения к базе у «всех» \(PUBLIC\) снято$/m)
    assert.match(res.stdout, /^OK сеансов других обычных учёток в базе нет$/m)
    assert.match(res.stdout, /^OK база пустая$/m)
    assert.match(res.stdout, /политик перенесено: 2, не перенесено: 2 \(/)
    for (const t of ['public.tenders для anon', 'public.showcase для anon']) assert.ok(res.stdout.includes(t), t)
    assert.match(res.stdout, /не перенесено выдач: .*anon — \d+.*service_role — \d+.*прав по умолчанию Supabase: \d/)
    assert.match(res.stdout, /^OK загружено одной транзакцией за \d+ с$/m)
    assert.match(res.stdout, /статус rehearsal, права — загружены, часовой пояс базы — UTC/)
    noSecrets(res)

    assert.equal(admin("select count(*) from pg_policies where schemaname = 'public'"), '2')
    assert.equal(admin("select string_agg(distinct r::text, ',') from pg_policies p, unnest(p.roles) r where p.schemaname = 'public'"), 'osp_runtime')
    assert.equal(admin("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')"), '0', 'ролей Supabase в кластере нет и не появилось')
    assert.equal(admin("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','auth','osp_meta') and pg_get_userbyid(c.relowner) = 'osp_runtime'"), '0', 'роль приложения ничем не владеет')
    assert.equal(admin("select count(*) from pg_default_acl"), '0', 'прав по умолчанию «всем ролям» нет')
    assert.equal(admin('select count(*) from public.tenders'), '300')
    // Новый сеанс: пояс базы — UTC, хотя у сервера — Москва.
    assert.equal(psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target', 'show timezone').stdout.trim(), 'UTC')
    assert.equal(psql(targetPort, 'target_owner', OWNER_PASS, 'postgres', 'show timezone').stdout.trim(), 'Europe/Moscow', 'другие базы не затронуты')
  })

  it('права действуют на роль приложения: строки — только вошедшему; «кто вошёл» подставляется сам', () => {
    const claims = `select set_config('request.jwt.claims', '{"sub":"${USER_ID}","role":"osp_runtime"}', true)`
    const seen = asRuntime(`begin; ${claims}; select 'tenders=' || count(*) from public.tenders; select 'roles=' || count(*) from public.user_roles; select 'admin=' || public.is_admin(); select 'showcase=' || count(*) from public.showcase; commit;`)
    assert.equal(seen.status, 0, seen.stderr)
    for (const line of ['tenders=300', 'roles=1', 'admin=true', 'showcase=0']) assert.ok(seen.stdout.includes(line), `${line}\n${seen.stdout}`)
    const anonymous = asRuntime("select 'tenders=' || count(*) from public.tenders; select 'roles=' || count(*) from public.user_roles")
    assert.ok(anonymous.stdout.includes('tenders=0') && anonymous.stdout.includes('roles=0'), `без входа строк не видно\n${anonymous.stdout}`)
    // Номер задаём явно: счётчик не откатывается вместе с транзакцией, а сверка ниже ждёт его нетронутым.
    const inserted = asRuntime(`begin; ${claims}; insert into public.tenders(number, title) values (999999, 'проверка') returning 'by=' || created_by; rollback;`)
    assert.ok(inserted.stdout.includes(`by=${USER_ID}`), inserted.stdout + inserted.stderr)
    assert.notEqual(asRuntime('drop table public.showcase').status, 0, 'роль приложения не может менять структуру')
    assert.notEqual(asRuntime('select * from osp_meta.load_log').status, 0, 'служебная схема приложению закрыта')
  })

  it('сверка: расхождений нет; во время копии «работали» — число строк в допустимых пределах', () => {
    // Как на проде: между подсчётом «до» и «после» добавилась строка.
    const original = fs.readFileSync(counts('before'), 'utf8')
    fs.writeFileSync(counts('before'), original.replace(/^tenders\t300$/m, 'tenders\t299'))
    try {
      const res = verify()
      assert.equal(res.status, 0, res.all)
      for (const line of [
        'OK число строк по таблицам: 4 — совпадают',
        'OK контрольные суммы данных: 4 — совпадают',
        'OK счётчики номеров: 1 — совпадают',
        'OK политики: 2 — совпадают',
        'OK функции: 1 — совпадают',
        'OK число строк — в пределах подсчёта на проде до и после копии (3 таблиц; во время копии менялись 1)',
        'OK часовой пояс базы — UTC, как в Supabase',
        'OK порядок сортировки кириллицы — как в Supabase (ICU en-US)',
        'РАСХОЖДЕНИЙ НЕТ: в базе ровно то, что в копии.',
      ]) assert.ok(res.stdout.includes(line), `нет строки: ${line}\n${res.stdout}`)
      assert.doesNotMatch(res.stdout, /^FAIL/m)
      noSecrets(res)
    } finally {
      fs.writeFileSync(counts('before'), original)
    }
  })

  it('повторная загрузка в непустую базу — отказ; чужая таблица — очистка отказывает и ничего не удаляет', () => {
    const again = load(['--status', 'rehearsal'])
    assert.equal(again.status, 3, again.all)
    assert.match(again.stdout, /^FAIL база не пустая/m)

    admin('create table public.someone_else(id int)')
    const blocked = reset()
    assert.equal(blocked.status, 3, blocked.all)
    assert.match(blocked.stdout, /в базе есть объекты сверх загруженных \(1\) — чужое не удаляем/)
    assert.equal(admin('select count(*) from public.tenders'), '300', 'данные на месте')
    admin('drop table public.someone_else')

    assert.equal(run(path.join(TARGET, 'reset.sh'), [envFile]).status, 1, 'без подтверждающего флага')
    const ok = reset()
    assert.equal(ok.status, 0, ok.all)
    assert.equal(stateOfTarget(), EMPTY, 'база пустая, расширения на месте, пояс сброшен')
    const noMark = reset()
    assert.equal(noMark.status, 3)
    assert.match(noMark.stdout, /нет отметки загрузчика/)
  })

  it('без прав: роль приложения не нужна, соседней учётке кластера всё закрыто, сверка и очистка работают', () => {
    const finalNoRights = load(['--status', 'final', '--without-rights'])
    assert.equal(finalNoRights.status, 1, finalNoRights.all)
    assert.match(finalNoRights.stderr, /Настоящий перенос \(final\) без прав не выполняется/)
    assert.equal(load(['--status', 'rehearsal', '--without-rights', '--runtime-role', 'osp_runtime']).status, 1, 'оба флага вместе')
    assert.equal(stateOfTarget(), EMPTY)

    const res = load(['--status', 'rehearsal', '--without-rights'])
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /без прав: роли приложения нет/)
    assert.match(res.stdout, /политики и выдача прав не загружаются: записей о них в копии — \d+/)
    assert.doesNotMatch(res.stdout, /роль приложения osp_runtime/)
    assert.match(res.stdout, /статус rehearsal, права — не загружались, часовой пояс базы — UTC/)
    noSecrets(res)

    assert.equal(admin("select count(*) from pg_policies where schemaname = 'public'"), '0')
    assert.equal(admin("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity"), '3', 'защита строк — часть структуры, загружена')
    assert.equal(admin("select rights || ':' || coalesce(runtime_role, 'нет') from osp_meta.load_log"), 'skipped:нет')
    assert.equal(asOwner('select count(*) from public.tenders').stdout.trim(), '300', 'владелец читает')

    // Соседняя учётка кластера: подключиться может, а до данных и функций портала не дотянется.
    assert.equal(asRuntime('select 1').stdout.trim(), '1', 'подключение ей открыто — как двум учёткам в Яндексе')
    for (const sql of [
      'select count(*) from public.tenders', 'select * from public.tender_titles', 'select * from public.tenders_mv',
      "select nextval('public.tender_number_seq')", 'select public.is_admin()', 'select auth.uid()',
      'select * from osp_meta.load_log', 'create table public.intruder(i int)', "insert into public.showcase values (9, 'x')",
    ]) {
      const denied = asRuntime(sql)
      assert.notEqual(denied.status, 0, `соседней учётке должно быть закрыто: ${sql}`)
      assert.match(denied.stderr, /permission denied/, sql)
    }
    // Функция, созданная позже (миграцией): «всем» по умолчанию не открыта.
    assert.equal(asOwner('create function public.later_fn() returns int language sql as $$ select 1 $$').status, 0)
    assert.match(asRuntime('select public.later_fn()').stderr, /permission denied for function/)
    assert.equal(asOwner('drop function public.later_fn()').status, 0)

    const ok = verify()
    assert.equal(ok.status, 0, ok.all)
    for (const line of [
      'без прав',
      'OK контрольные суммы данных: 4 — совпадают',
      'OK защита строк на таблицах: 3 — совпадают',
      'ВНИМАНИЕ политики и выданные права не сверялись: загрузка была без прав',
      'OK база закрыта для обычных учёток кластера: политик 0, выдач не владельцу 0, функций и типов, открытых «всем», 0',
      'ИНФО подключиться к базе могут ещё обычных учёток: 1 ',
      'РАСХОЖДЕНИЙ НЕТ: данные и структура — ровно как в копии; права не загружались, база закрыта.',
    ]) assert.ok(ok.stdout.includes(line), `нет строки: ${line}\n${ok.stdout}`)
    assert.doesNotMatch(ok.stdout, /^(OK|FAIL) (политики|выданные права)/m)
    assert.doesNotMatch(ok.stdout, /^FAIL/m)
    noSecrets(ok)

    // Сверка ловит и подмену данных, и приоткрытую базу.
    admin("update public.tenders set title = title || '!' where number = 7")
    admin('grant select on public.showcase to osp_runtime')
    admin('grant execute on function public.is_admin() to public')
    const bad = verify()
    assert.equal(bad.status, 4, bad.all)
    assert.match(bad.stdout, /^FAIL контрольные суммы данных: .*tenders/m)
    assert.match(bad.stdout, /^FAIL база не закрыта: политик — 0; выдач на таблицы и счётчики не владельцу — 1, на колонки — 0; функций, открытых не только владельцу, — 1;/m)

    const cleared = reset()
    assert.equal(cleared.status, 0, cleared.all)
    assert.equal(stateOfTarget(), EMPTY, 'база пустая, права по умолчанию возвращены')
  })

  it('сверка ловит подмену: строку, пропажу, счётчик, политику, право, колонку', () => {
    assert.equal(load(['--status', 'rehearsal']).status, 0)
    admin("update public.tenders set title = title || '!' where number = 7")
    admin("delete from public.user_roles where role = 'viewer-3'")
    admin("select setval('public.tender_number_seq', 9999)")
    admin('drop policy "Allow all for authenticated users" on public.tenders')
    admin('revoke insert on public.showcase from osp_runtime')
    admin('alter table public.showcase add column extra int')
    const res = verify()
    assert.equal(res.status, 4, res.all)
    const fail = (title) => (res.stdout.split('\n').find((l) => l.startsWith(`FAIL ${title}`)) || '')
    assert.match(fail('число строк по таблицам'), /user_roles/)
    assert.match(fail('контрольные суммы данных'), /showcase.*tenders.*user_roles/)
    assert.match(fail('счётчики номеров'), /tender_number_seq/)
    assert.match(fail('политики'), /tenders\.Allow all for authenticated users/)
    assert.match(fail('выданные права'), /rel:showcase/)
    assert.match(fail('колонки'), /showcase\.extra/)
    assert.match(res.stdout, /ЕСТЬ РАСХОЖДЕНИЯ: \d+\. Базу в работу не пускать\./)
    assert.match(res.stdout, /^OK индексы: \d+ — совпадают$/m)
    noSecrets(res)
    assert.equal(reset().status, 0)
  })

  it('настоящий перенос (final): сверка требует остановленной записи; очистка — отказ навсегда', () => {
    // Окончательный перенос — только с учётками и обложками (их путь проверяет target-extras.test.mjs).
    const journal = coversJournal(dump, path.join(tmp, 'covers-journal.json'))
    const res = load(['--status', 'final', '--auth', '--covers', journal])
    assert.equal(res.status, 0, res.all)
    const ok = verify('--covers', journal)
    assert.equal(ok.status, 0, ok.all)
    assert.ok(ok.stdout.includes('OK число строк равно подсчёту на проде до и после копии (3 таблиц)'))

    const original = fs.readFileSync(counts('before'), 'utf8')
    fs.writeFileSync(counts('before'), original.replace(/^tenders\t300$/m, 'tenders\t299'))
    try {
      const moving = verify('--covers', journal)
      assert.equal(moving.status, 4, moving.all)
      assert.match(moving.stdout, /^FAIL настоящий перенос: число строк должно быть равно проду и до, и после копии — запись не была остановлена или строки потеряны: tenders/m)
    } finally {
      fs.writeFileSync(counts('before'), original)
    }

    const blocked = reset()
    assert.equal(blocked.status, 3, blocked.all)
    assert.match(blocked.stdout, /настоящий перенос \(final\) — боевые данные этим скриптом не удаляются/)
    assert.equal(admin('select count(*) from public.tenders'), '300')
    assert.equal(admin('select status from osp_meta.load_log'), 'final')
  })
})
