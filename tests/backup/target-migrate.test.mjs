// Миграции базы нового портала (migration/target/migrate.sh, migration/yandex/). Проверяем обещанное:
//   • без --yes ничего не пишется; --dry-run только показывает, что будет применено;
//   • миграция по образцу migration/yandex/README.md применяется: правила под одну учётку соблюдены,
//     сотрудник работает с новой таблицей, неодобренный и гость — нет; служебная функция проверяет сама;
//   • повтор ничего не делает; изменённый или удалённый файл применённой миграции — отказ до записи;
//   • таблица без правил, политика без проверки роли, служебная функция без отметки, проверка с FAIL,
//     ошибка SQL — транзакция отменяется, в базе и в журнале миграций ничего не остаётся;
//   • запрещённое в тексте (BEGIN/COMMIT, роли Supabase, команды psql, CONCURRENTLY) — отказ до записи;
//   • чужая база той же учётки (отпечаток не совпал) — отказ до первой команды, соседняя база не тронута;
//   • перед первой записью снимается копия базы.
// Нужны Docker, psql, pg_dump, pg_restore.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SQL } from './lib/supabase-platform.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKUP = path.join(ROOT, 'migration', 'backup')
const TARGET = path.join(ROOT, 'migration', 'target')
const YANDEX = path.join(ROOT, 'migration', 'yandex')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : false

const ADMIN_PASS = 'Admin-Pass-mg1-secret'
const OWNER_PASS = 'Owner-Pass-mg2-secret'
const ADMIN = '11111111-1111-4111-8111-111111111111'
const ANNA = '22222222-2222-4222-8222-222222222222'
const BORIS = '33333333-3333-4333-8333-333333333333'

// «Прод» как Supabase: роли, сотрудник по одобрению, тендеры с витриной для гостя, документы.
const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension pg_trgm with schema public;
${PLATFORM_SQL}
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.user_roles(user_id uuid primary key, role text not null, is_approved boolean not null default true);
create table public.tenders(id uuid primary key default gen_random_uuid(), title text not null, kind text not null default 'main');
create table public.s3_documents(id uuid primary key default gen_random_uuid(), owner_type text not null, file_name text not null);
alter table public.user_roles enable row level security;
alter table public.tenders enable row level security;
alter table public.s3_documents enable row level security;
create function public.is_portal_employee() returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.is_approved) $$;
create policy roles_self on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy tenders_employees on public.tenders for all to authenticated using (public.is_portal_employee()) with check (public.is_portal_employee());
create policy tenders_showcase on public.tenders for select to anon using (kind = 'main');
create policy docs_employees on public.s3_documents for all to authenticated using (public.is_portal_employee()) with check (public.is_portal_employee());

insert into public.user_roles values ('${ADMIN}', 'admin', true), ('${ANNA}', 'engineer', true), ('${BORIS}', 'engineer', false);
insert into public.tenders(title, kind) select 'Тендер ' || g, case when g % 2 = 0 then 'main' else 'internal' end from generate_series(1, 6) g;
insert into public.s3_documents(owner_type, file_name) select 'tender', 'файл ' || g from generate_series(1, 5) g;
`

// Образцы из migration/yandex/README.md — именно они, чтобы описание и проверка не разошлись.
function readmeSamples() {
  const text = fs.readFileSync(path.join(YANDEX, 'README.md'), 'utf8')
  const blocks = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
  const table = blocks.find((b) => b.includes('CREATE TABLE public.tender_tags'))
  const fn = blocks.find((b) => b.includes('FUNCTION public.tender_tag_count'))
  assert.ok(table && fn, 'в README есть образцы таблицы и служебной функции')
  return table + fn
}

describe('Миграции базы нового портала: правила под одну учётку, откат при нарушении, соседи не тронуты', { skip, timeout: 900000 }, () => {
  let tmp
  let prodPort
  let targetPort
  let envFile
  let migDir
  const prodContainer = `osp-mg-prod-${process.pid}`
  const targetContainer = `osp-mg-target-${process.pid}`

  const psql = (port, user, pass, db, sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pass, PGSSLMODE: 'disable', PGAPPNAME: 'osp-test' } })
  const admin = (sql, db = 'osp_target') => {
    const res = psql(targetPort, 'postgres', ADMIN_PASS, db, sql)
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  // Под учёткой-владельцем от имени пользователя портала — claims как ставит PostgREST за шлюзом.
  const as = (who, sql) => {
    const claims = who === 'anon' ? { osp_role: 'anon' } : { osp_role: 'authenticated', sub: who }
    const res = psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target', `begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true); ${sql}; rollback;`)
    const lines = res.stdout.trim().split('\n').filter((l) => l !== JSON.stringify(claims))
    return res.status === 0 ? (lines.at(-1) ?? '') : `err:${/ERROR:\s*(.*)/.exec(res.stderr)?.[1] || res.stderr.trim()}`
  }
  const run = (script, args, env = {}) => {
    const res = spawnSync('bash', [path.join(TARGET, script), ...args], { encoding: 'utf8', cwd: ROOT, timeout: 400000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'),
        PROBE_CONNECT_TIMEOUT: '5', OSP_MIGRATIONS_DIR: migDir, OSP_TOOL_COMMIT: 'test-commit', ...env } })
    return { ...res, all: res.stdout + res.stderr }
  }
  const migrate = (mode, env) => run('migrate.sh', [envFile, mode], env)
  const journal = () => admin("select coalesce(string_agg(name, ',' order by name), '') from osp_meta.schema_migrations")
  const put = (name, sql) => fs.writeFileSync(path.join(migDir, name), sql)
  const drop = (name) => fs.rmSync(path.join(migDir, name))
  const waitFor = (probe, what) => {
    const deadline = Date.now() + 120000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`${what} не поднялся`)
      spawnSync('sleep', ['0.5'])
    }
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-migrate-'))
    migDir = path.join(tmp, 'yandex')
    fs.mkdirSync(migDir)
    prodPort = 24000 + Math.floor(Math.random() * 1000) // свои диапазоны, ниже портов исходящих соединений
    targetPort = 25000 + Math.floor(Math.random() * 1000)
    let started = spawnSync('docker', ['run', '-d', '--rm', '--name', prodContainer, '-p', `127.0.0.1:${prodPort}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    started = spawnSync('docker', ['run', '-d', '--rm', '--name', targetContainer, '-p', `127.0.0.1:${targetPort}:5432`,
      '-e', `POSTGRES_PASSWORD=${ADMIN_PASS}`, '-e', 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=icu --icu-locale=en-US',
      'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    waitFor(() => psql(prodPort, 'postgres', '', 'postgres', 'select 1').stdout.trim() === '1', '«прод»')
    waitFor(() => psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', 'select 1').stdout.trim() === '1', 'целевая база')
    const seeded = psql(prodPort, 'postgres', '', 'postgres', PROD_SQL)
    assert.equal(seeded.status, 0, seeded.stderr)
    for (const sql of [
      `create role target_owner login password '${OWNER_PASS}' nosuperuser nocreaterole nocreatedb`,
      "create database osp_target owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
      'revoke connect on database osp_target from public',
      "create database neighbour_db owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
    ]) assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', sql).status, 0, sql)
    admin('create extension pg_trgm; create extension pgcrypto')
    admin("create table keep_me(id int primary key, v text); insert into keep_me select g, 'чужое ' || g from generate_series(1, 50) g", 'neighbour_db')
    const conn = (db) => ['PGHOST=127.0.0.1', `PGPORT=${targetPort}`, `PGDATABASE=${db}`, 'PGUSER=target_owner',
      `PGPASSWORD=${OWNER_PASS}`, 'PGSSLMODE=disable'].join('\n') + '\n'
    envFile = path.join(tmp, 'target.env')
    fs.writeFileSync(envFile, conn('osp_target'), { mode: 0o600 })

    const prodEnv = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(prodPort), PGUSER: 'postgres', PGDATABASE: 'postgres',
      PGSSLMODE: 'disable', PGPASSWORD: 'test-only', BACKUP_OUT_DIR: path.join(tmp, 'dumps') }
    let res = spawnSync('bash', [path.join(BACKUP, 'backup.sh')], { encoding: 'utf8', cwd: ROOT, env: prodEnv, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const dump = path.join(tmp, 'dumps', fs.readdirSync(path.join(tmp, 'dumps')).find((f) => f.endsWith('.dump')))
    res = spawnSync('bash', [path.join(BACKUP, 'verify.sh'), dump], { encoding: 'utf8', cwd: ROOT, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    for (const [script, args] of [['pin.sh', [envFile, '--confirm']], ['load.sh', [envFile, dump, '--status', 'rehearsal', '--single-owner']], ['rights.sh', [envFile, dump]]]) {
      const step = run(script, args)
      assert.equal(step.status, 0, `${script}: ${step.all}`)
    }
  })
  after(() => {
    spawnSync('docker', ['rm', '-fv', prodContainer, targetContainer], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('--dry-run показывает новые и ничего не пишет; без ключа режима — отказ', () => {
    fs.copyFileSync(path.join(YANDEX, '20261014_s3_documents_sha256.sql'), path.join(migDir, '20261014_s3_documents_sha256.sql'))
    fs.copyFileSync(path.join(YANDEX, '20261014_s3_documents_sha256.check.sql'), path.join(migDir, '20261014_s3_documents_sha256.check.sql'))
    const dry = migrate('--dry-run')
    assert.equal(dry.status, 0, dry.all)
    assert.match(dry.stdout, /ИНФО к применению: 20261014_s3_documents_sha256 \(с проверкой\)/)
    assert.equal(admin("select to_regclass('osp_meta.schema_migrations') is null"), 't', 'журнал не создан')
    assert.equal(admin("select count(*) from information_schema.columns where table_name = 's3_documents' and column_name = 'sha256'"), '0')
    assert.equal(run('migrate.sh', [envFile]).status, 1)
  })

  it('--yes: копия базы, миграция в транзакции с проверками, журнал; повтор ничего не делает', () => {
    const before = admin("select count(*) || ':' || (select count(*) from keep_me) from pg_class where relkind = 'r'", 'neighbour_db')
    const res = migrate('--yes')
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /OK копия базы перед миграцией: .*yandex-\d{8}-\d{6}/)
    assert.match(res.stdout, /OK 20261014_s3_documents_sha256: применена за \d+ с; проверок OK — 17/)
    assert.match(res.stdout, /OK соседи по кластеру не изменились/)
    assert.equal(journal(), '20261014_s3_documents_sha256')
    assert.equal(admin("select tool_commit from osp_meta.schema_migrations"), 'test-commit')
    assert.equal(admin("select count(*) from information_schema.columns where table_name = 's3_documents' and column_name = 'sha256'"), '1')
    assert.equal(admin("set application_name = 'osp:internal'; select count(*) from public.s3_documents"), '5', 'строки документов на месте')
    assert.equal(fs.readdirSync(path.join(tmp, 'exports')).filter((d) => d.startsWith('yandex-')).length, 1)

    const again = migrate('--yes')
    assert.equal(again.status, 0, again.all)
    assert.match(again.stdout, /ИТОГ: новых миграций нет — база не менялась\./)
    assert.equal(fs.readdirSync(path.join(tmp, 'exports')).filter((d) => d.startsWith('yandex-')).length, 1, 'без новых миграций копия не снимается')
    assert.equal(admin("select count(*) || ':' || (select count(*) from keep_me) from pg_class where relkind = 'r'", 'neighbour_db'), before)
    for (const s of [OWNER_PASS, ADMIN_PASS, 'neighbour_db', 'keep_me']) assert.ok(!(res.all + again.all).includes(s), `в выводе: ${s}`)
  })

  it('образец таблицы и служебной функции из README: применяется, сотрудник работает, остальные — нет', () => {
    put('20261015_tender_tags.sql', readmeSamples())
    const res = migrate('--yes')
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /OK 20261015_tender_tags: применена/)
    assert.equal(run('rights.sh', [envFile, '--check']).status, 0, 'проверка прав после миграции — без замечаний')
    const tender = admin("set application_name = 'osp:internal'; select id from public.tenders order by title limit 1")
    assert.equal(as(ANNA, `with i as (insert into public.tender_tags(tender_id, tag) values ('${tender}', 'срочно') returning 1) select count(*) from i`), '1')
    assert.match(as(BORIS, `insert into public.tender_tags(tender_id, tag) values ('${tender}', 'x')`), /err:.*row-level security/)
    assert.match(as('anon', `insert into public.tender_tags(tender_id, tag) values ('${tender}', 'x')`), /err:.*row-level security/)
    admin(`set application_name = 'osp:internal'; insert into public.tender_tags(tender_id, tag) values ('${tender}', 'есть')`)
    assert.equal(as(ANNA, 'select count(*) from public.tender_tags'), '1')
    assert.equal(as(BORIS, 'select count(*) from public.tender_tags'), '0')
    assert.equal(as('anon', 'select count(*) from public.tender_tags'), '0')
    assert.equal(as(ANNA, `select public.tender_tag_count('${tender}')`), '1', 'служебная функция видит строки с пропуском')
    assert.match(as(BORIS, `select public.tender_tag_count('${tender}')`), /err:.*нет доступа/)
    assert.equal(as(ANNA, 'select count(*) from public.user_roles'), '1', 'после функции пропуск снят — правила снова действуют')
  })

  it('нарушение правил, проверка с FAIL, ошибка SQL — откат; в базе и журнале ничего не остаётся', () => {
    const cases = [
      ['20261016_open_table.sql', 'CREATE TABLE public.open_table (id int PRIMARY KEY); INSERT INTO public.open_table VALUES (1);',
        /FAIL правила по строкам включены и действуют на владельца/, "select to_regclass('public.open_table') is null"],
      ['20261016_bare_policy.sql', 'CREATE POLICY tags_all ON public.tender_tags FOR SELECT TO PUBLIC USING (true);\n'
        + "INSERT INTO osp_meta.policy_roles VALUES ('public', 'tender_tags', 'tags_all', ARRAY['authenticated']);",
        /FAIL каждая политика проверяет роль из токена/, "select count(*) = 0 from pg_policies where policyname = 'tags_all'"],
      ['20261016_unmarked_definer.sql', 'CREATE FUNCTION public.unmarked() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;',
        /FAIL отметка пропуска — у всех служебных функций/, "select to_regprocedure('public.unmarked()') is null"],
      ['20261016_bad_data.sql', "ALTER TABLE public.tender_tags ADD COLUMN level int; UPDATE public.tender_tags SET level = 1;",
        /FAIL уровень/, "select count(*) = 0 from information_schema.columns where table_name = 'tender_tags' and column_name = 'level'",
        "select case when count(*) = 0 then 'OK уровень' else 'FAIL уровень не у всех' end from public.tender_tags where level is distinct from 2;"],
      ['20261016_syntax.sql', 'ALTER TABLE public.tender_tags ADD COLUMN note text; SELEC 1;',
        /ошибка — транзакция отменена/, "select count(*) = 0 from information_schema.columns where table_name = 'tender_tags' and column_name = 'note'"],
    ]
    for (const [name, sql, why, gone, check] of cases) {
      put(name, sql)
      if (check) put(name.replace(/\.sql$/, '.check.sql'), check)
      const res = migrate('--yes')
      assert.equal(res.status, 4, `${name}: ${res.all}`)
      assert.match(res.stdout, why, name)
      assert.match(res.stdout, /ИТОГ: применено в этом запуске: 0/)
      assert.equal(admin(gone), 't', `${name}: изменения отменены`)
      assert.equal(journal(), '20261014_s3_documents_sha256,20261015_tender_tags', `${name}: в журнале нет`)
      drop(name)
      if (check) drop(name.replace(/\.sql$/, '.check.sql'))
    }
    assert.equal(run('rights.sh', [envFile, '--check']).status, 0, 'права в порядке')
  })

  it('запрещённое в тексте и изменённая история — отказ до записи', () => {
    for (const [name, sql, why] of [
      ['20261017_tx.sql', 'BEGIN;\nALTER TABLE public.tenders ADD COLUMN x int;\nCOMMIT;', /BEGIN\/COMMIT\/ROLLBACK в файле нельзя/],
      ['20261017_roles.sql', 'GRANT SELECT ON public.tenders TO authenticated;', /ролей Supabase .* в этой базе нет/],
      ['20261017_psql.sql', '\\set x 1\nSELECT 1;', /команды psql/],
      ['20261017_conc.sql', 'CREATE INDEX CONCURRENTLY t_idx ON public.tenders (title);', /CONCURRENTLY/],
      ['Tags.sql', 'SELECT 1;', /имя миграции не по образцу/],
    ]) {
      put(name, sql)
      const res = migrate('--yes')
      assert.equal(res.status, 3, `${name}: ${res.all}`)
      assert.match(res.stdout, why, name)
      drop(name)
    }
    // Комментарий с BEGIN и тело функции с END — не нарушение.
    put('20261017_comment.sql', '-- BEGIN; COMMIT; TO authenticated — в комментарии можно\nALTER TABLE public.tender_tags ADD COLUMN IF NOT EXISTS weight int;')
    assert.equal(migrate('--yes').status, 0)

    fs.appendFileSync(path.join(migDir, '20261015_tender_tags.sql'), '\n-- правка задним числом\n')
    let res = migrate('--dry-run')
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /файл применённой миграции изменён: 20261015_tender_tags\.sql/)
    put('20261015_tender_tags.sql', readmeSamples())
    drop('20261017_comment.sql')
    res = migrate('--dry-run')
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /файла применённой миграции нет: 20261017_comment\.sql/)
  })

  it('чужая база той же учётки — отказ до первой команды, соседняя база не тронута', () => {
    const other = path.join(tmp, 'other.env')
    fs.writeFileSync(other, fs.readFileSync(envFile, 'utf8').replace('PGDATABASE=osp_target', 'PGDATABASE=neighbour_db'), { mode: 0o600 })
    fs.copyFileSync(`${envFile}.pin`, `${other}.pin`)
    const res = run('migrate.sh', [other, '--yes'])
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /база не закреплена или это другая база — ничего не изменено/)
    assert.equal(admin("select to_regnamespace('osp_meta') is null and (select count(*) from keep_me) = 50", 'neighbour_db'), 't')
  })
})
