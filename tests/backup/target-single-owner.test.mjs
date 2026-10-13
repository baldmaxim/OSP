// Перенос под одну учётку (migration/target: load.sh --single-owner, rights.sh, reset.sh, neighbors.sh).
// В целевой базе одна учётка — владелец; ролей Supabase нет. Проверяем обещанное:
//   • правила по строкам действуют и на владельца: каждый видит и меняет только своё, как в Supabase;
//   • служебная функция получает пропуск только на время своей работы — после неё правила снова действуют;
//   • аноним и запрос без токена видят только публичную витрину;
//   • материализованное представление уходит в закрытую схему, пересчёт и представление над ним работают;
//   • через представление записать нельзя; шаг прав не меняет ни одной строки и повторно не применяется;
//   • соседняя база той же учётки не тронута ни загрузкой, ни очисткой; пропажу соседней базы проверка видит;
//   • репетицию можно убрать, настоящий перенос — нельзя.
// Нужны Docker, psql, pg_dump, pg_restore.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKUP = path.join(ROOT, 'migration', 'backup')
const TARGET = path.join(ROOT, 'migration', 'target')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : false

const ADMIN_PASS = 'Admin-Pass-so1-secret'
const OWNER_PASS = 'Owner-Pass-so2-secret'
const ADMIN = '11111111-1111-4111-8111-111111111111'
const ANNA = '22222222-2222-4222-8222-222222222222'
const BORIS = '33333333-3333-4333-8333-333333333333'

// «Прод» как Supabase: роли, права по умолчанию «всем ролям», политики для вошедшего и анонима,
// функция-проверка с правами владельца, материализованное представление с представлением и пересчётом,
// обновляемое представление, закрытое на запись выдачей прав.
const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create extension pg_trgm with schema public;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create table public.user_roles(user_id uuid primary key, role text not null, is_approved boolean not null default true);
create table public.tenders(id int primary key, title text not null, kind text not null default 'main', created_by uuid);
create table public.notes(id int primary key, owner uuid not null, body text not null);
create table public.audit(id bigint generated always as identity primary key, what text not null);
alter table public.user_roles enable row level security;
alter table public.tenders enable row level security;
alter table public.notes enable row level security;
alter table public.audit enable row level security;

create function public.is_admin() returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin') $$;
create function public.is_employee() returns boolean language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.is_approved) $$;
-- Изменяющая служебная функция: пишет в таблицу, куда клиенту прямой записи нет.
create function public.log_action(p_what text) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; begin
  if auth.uid() is null then raise exception 'нет входа' using errcode = '42501'; end if;
  insert into public.audit(what) values (p_what) returning id into v; return v;
end $$;

create policy roles_self_or_admin on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy tenders_employees on public.tenders for all to authenticated using (public.is_employee()) with check (public.is_employee());
create policy tenders_showcase on public.tenders for select to anon using (kind = 'main');
create policy notes_own on public.notes for all to authenticated using (owner = auth.uid() or public.is_admin()) with check (owner = auth.uid());
create policy audit_admin_read on public.audit for select to authenticated using ((select public.is_admin()));

create materialized view public.tender_titles_mv as select id, lower(title) as title from public.tenders;
create unique index tender_titles_mv_id on public.tender_titles_mv (id);
create view public.tender_titles as select * from public.tender_titles_mv where (select public.is_employee());
create function public.refresh_titles() returns void language plpgsql security definer set search_path = public as $$
begin refresh materialized view concurrently tender_titles_mv; end $$;
create view public.role_names as select user_id, role from public.user_roles;
revoke insert, update, delete on public.role_names from anon, authenticated;
revoke all on public.tender_titles_mv from anon, authenticated;

insert into public.user_roles values ('${ADMIN}', 'admin', true), ('${ANNA}', 'engineer', true), ('${BORIS}', 'engineer', false);
insert into public.tenders select g, 'Тендер ' || g, case when g % 4 = 0 then 'main' else 'internal' end, '${ANNA}' from generate_series(1, 40) g;
insert into public.notes select g, case when g % 2 = 0 then '${ANNA}' else '${BORIS}' end::uuid, 'заметка ' || g from generate_series(1, 10) g;
refresh materialized view public.tender_titles_mv;
`

describe('Перенос под одну учётку: правила действуют на владельца, соседи не тронуты', { skip, timeout: 900000 }, () => {
  let tmp
  let prodPort
  let targetPort
  let dump
  let envFile
  const prodContainer = `osp-so-prod-${process.pid}`
  const targetContainer = `osp-so-target-${process.pid}`

  const psql = (port, user, pass, db, sql, extraEnv = {}) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pass, PGSSLMODE: 'disable', PGAPPNAME: 'osp-test', ...extraEnv } })
  const admin = (sql, db = 'osp_target') => {
    const res = psql(targetPort, 'postgres', ADMIN_PASS, db, sql)
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  // Запрос под учёткой-владельцем от имени пользователя портала: claims — как ставит PostgREST за шлюзом.
  const as = (who, sql) => {
    const claims = who === 'none' ? '' : JSON.stringify(who === 'anon' ? { osp_role: 'anon' } : { osp_role: 'authenticated', sub: who })
    const res = psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target', `begin; select set_config('request.jwt.claims', '${claims}', true); ${sql}; rollback;`)
    const lines = res.stdout.trim().split('\n').filter((l) => l !== claims)
    return res.status === 0 ? (lines.at(-1) ?? '') : `err:${/ERROR:\s*(.*)/.exec(res.stderr)?.[1] || res.stderr.trim()}`
  }
  const run = (script, args, env = {}) => {
    const res = spawnSync('bash', [path.join(TARGET, script), ...args], { encoding: 'utf8', cwd: ROOT, timeout: 400000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), PROBE_CONNECT_TIMEOUT: '5', ...env } })
    return { ...res, all: res.stdout + res.stderr }
  }
  const neighbourObjects = () => admin("select count(*) || ':' || (select count(*) from keep_me) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'", 'neighbour_db')
  const waitFor = (probe, what) => {
    const deadline = Date.now() + 120000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`${what} не поднялся`)
      spawnSync('sleep', ['0.5'])
    }
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-single-'))
    prodPort = 26000 + Math.floor(Math.random() * 1000) // свои диапазоны, ниже портов исходящих соединений
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
    const seeded = psql(prodPort, 'postgres', '', 'postgres', PROD_SQL)
    assert.equal(seeded.status, 0, seeded.stderr)
    for (const sql of [
      `create role target_owner login password '${OWNER_PASS}' nosuperuser nocreaterole nocreatedb`,
      "create database osp_target owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
      'revoke connect on database osp_target from public',
      // Соседняя база той же учётки с чужими данными: её не должно задеть ничто.
      "create database neighbour_db owner target_owner template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US'",
    ]) assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', sql).status, 0, sql)
    admin('create extension pg_trgm; create extension pgcrypto')
    admin("create table keep_me(id int primary key, v text); insert into keep_me select g, 'чужое ' || g from generate_series(1, 500) g", 'neighbour_db')
    envFile = path.join(tmp, 'target.env')
    fs.writeFileSync(envFile, ['PGHOST=127.0.0.1', `PGPORT=${targetPort}`, 'PGDATABASE=osp_target', 'PGUSER=target_owner',
      `PGPASSWORD=${OWNER_PASS}`, 'PGSSLMODE=disable'].join('\n') + '\n', { mode: 0o600 })

    const prodEnv = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(prodPort), PGUSER: 'postgres', PGDATABASE: 'postgres',
      PGSSLMODE: 'disable', PGPASSWORD: 'test-only', BACKUP_OUT_DIR: path.join(tmp, 'dumps') }
    let res = spawnSync('bash', [path.join(BACKUP, 'backup.sh')], { encoding: 'utf8', cwd: ROOT, env: prodEnv, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    dump = path.join(tmp, 'dumps', fs.readdirSync(path.join(tmp, 'dumps')).find((f) => f.endsWith('.dump')))
    res = spawnSync('bash', [path.join(BACKUP, 'verify.sh'), dump], { encoding: 'utf8', cwd: ROOT, timeout: 300000 })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.equal(run('pin.sh', [envFile, '--confirm']).status, 0)
  })
  after(() => {
    spawnSync('docker', ['rm', '-f', prodContainer, targetContainer], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('загрузка, сверка и права: каждый шаг проходит, строки не меняются, повторно права не применяются', () => {
    const snapshot = run('neighbors.sh', [envFile, '--save'])
    assert.equal(snapshot.status, 0, snapshot.all)
    const before = neighbourObjects()
    assert.equal(before, '1:500')

    const loaded = run('load.sh', [envFile, dump, '--status', 'rehearsal', '--single-owner'])
    assert.equal(loaded.status, 0, loaded.all)
    assert.match(loaded.stdout, /Затем — права под одну учётку: bash migration\/target\/rights\.sh/)
    const verified = run('verify.sh', [envFile, dump])
    assert.equal(verified.status, 0, verified.all)

    const rights = run('rights.sh', [envFile, dump])
    assert.equal(rights.status, 0, rights.all)
    assert.match(rights.stdout, /OK права применены одной транзакцией за \d+ с; число строк в таблицах не изменилось/)
    assert.match(rights.stdout, /политик в копии: 5 \(authenticated — 4, anon — 1\)/)
    assert.equal((rights.stdout.match(/^OK /gm) || []).length, 12, rights.stdout)
    assert.ok(!/^FAIL/m.test(rights.stdout), rights.stdout)
    assert.match(rights.stdout, /ИТОГ: права под одну учётку применены и проверены\./)

    assert.equal(run('rights.sh', [envFile, '--check']).status, 0)
    const again = run('rights.sh', [envFile, dump])
    assert.equal(again.status, 3, again.all)
    assert.match(again.stdout, /шаг не к месту/)
    const lateVerify = run('verify.sh', [envFile, dump])
    assert.equal(lateVerify.status, 4, lateVerify.all)
    assert.match(lateVerify.stdout, /права под одну учётку уже применены/)

    assert.equal(neighbourObjects(), before, 'соседняя база не изменилась')
    const compared = run('neighbors.sh', [envFile, '--compare'])
    assert.equal(compared.status, 0, compared.all)
    assert.match(compared.stdout, /OK соседних баз в снимке: \d+; пропавших — 0/)
    for (const s of [OWNER_PASS, ADMIN_PASS, 'neighbour_db', 'keep_me']) assert.ok(!(loaded.all + rights.all + compared.all).includes(s), `в выводе: ${s}`)
  })

  it('правила действуют на владельца: каждый видит своё, аноним — витрину, без токена — как аноним', () => {
    assert.equal(as(ADMIN, 'select count(*) from public.tenders'), '40')
    assert.equal(as(ANNA, 'select count(*) from public.tenders'), '40', 'одобренный сотрудник')
    assert.equal(as(BORIS, 'select count(*) from public.tenders'), '0', 'неодобренный')
    assert.equal(as('anon', 'select count(*) from public.tenders'), '10', 'только публичная витрина')
    assert.equal(as('none', 'select count(*) from public.tenders'), '10', 'без токена — как аноним, не как владелец')
    assert.equal(as(ANNA, 'select count(*) from public.notes'), '5', 'только свои заметки')
    assert.equal(as(BORIS, 'select count(*) from public.notes'), '5')
    assert.equal(as(ADMIN, 'select count(*) from public.notes'), '10')
    assert.equal(as('anon', 'select count(*) from public.notes'), '0')
    assert.equal(as(ANNA, 'select count(*) from public.user_roles'), '1', 'своя строка ролей')
    assert.equal(as(ADMIN, 'select count(*) from public.user_roles'), '3')
    assert.equal(as('anon', 'select count(*) from public.user_roles'), '0')
    // Запись — те же правила: своё можно, чужое нельзя, приписать себе чужое авторство нельзя.
    assert.equal(as(ANNA, "with u as (update public.notes set body = 'x' returning 1) select count(*) from u"), '5')
    assert.match(as(ANNA, `insert into public.notes values (100, '${BORIS}', 'от чужого имени')`), /err:.*row-level security/)
    assert.equal(as(ANNA, `with i as (insert into public.notes values (101, '${ANNA}', 'своя') returning 1) select count(*) from i`), '1')
    assert.match(as(BORIS, "insert into public.tenders values (900, 'x', 'main', null)"), /err:.*row-level security/)
    assert.match(as('anon', "insert into public.tenders values (901, 'x', 'main', null)"), /err:.*row-level security/)
    assert.equal(as('anon', "with d as (delete from public.tenders returning 1) select count(*) from d"), '0')
  })

  it('пропуск служебной функции действует только пока она работает', () => {
    // Политика заметок вызывает is_admin() на каждой строке: функция читает user_roles с пропуском,
    // но после её возврата правила снова действуют — иначе Анна увидела бы все десять заметок.
    assert.equal(as(ANNA, 'select count(*) from public.notes where public.is_admin() is not null'), '5')
    assert.equal(as(ANNA, 'select public.is_admin()::text || (select count(*) from public.user_roles)'), 'false1')
    assert.equal(as(ADMIN, 'select public.is_admin()'), 't')
    // Изменяющая служебная функция пишет туда, куда клиенту прямой записи нет; сама проверяет вход.
    assert.match(as(ANNA, "insert into public.audit(what) values ('напрямую')"), /err:.*row-level security/)
    assert.match(as(ANNA, "select public.log_action('через функцию') > 0"), /^t$/)
    assert.match(as('anon', "select public.log_action('аноним')"), /err:.*нет входа/)
    assert.equal(as(ANNA, "select public.log_action('a') is not null and (select count(*) from public.audit) = 0"), 't', 'после функции журнал Анне по-прежнему не виден')
    // Именем подключения, заданным командой, пропуск получает только доверенный код сервера; у запроса
    // пользователя шлюз и PostgREST ставят своё имя в начале транзакции.
    assert.equal(as(ANNA, "set local application_name = 'osp-postgrest'; select count(*) from public.notes"), '5')
    assert.equal(admin("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and not coalesce(proconfig::text, '') ~ 'application_name=osp:internal'"), '0')
  })

  it('материализованное представление — в закрытой схеме; чтение через представление и пересчёт работают', () => {
    assert.equal(admin("select count(*) from pg_matviews where schemaname = 'public'"), '0')
    assert.equal(admin("select count(*) from pg_matviews where schemaname = 'osp_private'"), '1')
    assert.equal(as(ANNA, 'select count(*) from public.tender_titles'), '40')
    assert.equal(as(BORIS, 'select count(*) from public.tender_titles'), '0', 'условие внутри представления по-прежнему решает')
    assert.equal(as('anon', 'select count(*) from public.tender_titles'), '0')
    assert.equal(as(ANNA, "select 'пересчитано' from (select public.refresh_titles()) x"), 'пересчитано', 'функция нашла представление в закрытой схеме')
    // Через обновляемое представление записать нельзя (на «проде» это снимала выдача прав).
    assert.equal(as(ADMIN, "update public.role_names set role = 'admin'; select count(*) from public.user_roles where role = 'admin'"), '1',
      'изменение через представление не меняет ни строки')
    assert.equal(as(ADMIN, "delete from public.role_names; select count(*) from public.user_roles"), '3')
    assert.match(as(ADMIN, "update public.role_names set role = 'admin' returning user_id"), /^err:/, 'с возвратом строк — отказ')
    assert.equal(as(ADMIN, 'select count(*) from public.role_names'), '3', 'чтение работает')
  })

  it('репетицию можно убрать целиком; соседняя база не тронута; её пропажу проверка видит', () => {
    const reset = run('reset.sh', [envFile, '--yes-drop-rehearsal'])
    assert.equal(reset.status, 0, reset.all)
    assert.equal(admin("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','v','m','S') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'"), '0')
    assert.equal(admin("select count(*) from pg_namespace where nspname in ('osp_private', 'osp_meta', 'auth')"), '0')
    assert.equal(neighbourObjects(), '1:500')
    assert.equal(run('neighbors.sh', [envFile, '--compare']).status, 0)
    // Кто-то (не мы) удалил соседнюю базу — сравнение обязано это показать.
    assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', 'drop database neighbour_db').status, 0)
    const lost = run('neighbors.sh', [envFile, '--compare'])
    assert.equal(lost.status, 3, lost.all)
    assert.match(lost.stdout, /FAIL соседних баз в снимке: \d+; пропавших — 1/)
  })

  it('настоящий перенос под одну учётку разрешён, а его очистка — нет', () => {
    const loaded = run('load.sh', [envFile, dump, '--status', 'final', '--single-owner'])
    assert.equal(loaded.status, 0, loaded.all)
    assert.equal(run('verify.sh', [envFile, dump]).status, 0)
    assert.equal(run('rights.sh', [envFile, dump]).status, 0)
    const reset = run('reset.sh', [envFile, '--yes-drop-rehearsal'])
    assert.notEqual(reset.status, 0)
    assert.equal(as(ADMIN, 'select count(*) from public.tenders'), '40', 'данные настоящего переноса на месте')
    // Без --single-owner настоящий перенос без прав по-прежнему запрещён.
    const refused = run('load.sh', [envFile, dump, '--status', 'final', '--without-rights'])
    assert.equal(refused.status, 1, refused.all)
  })
})
