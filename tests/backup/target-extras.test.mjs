// Учётные записи (без паролей) и обложки объектов при переносе: migration/backup/extras.sql →
// migration/target/load.sh --auth --covers → verify.sh --covers → rights.sh → vault.sh → reset.sh.
// Проверяем обещанное:
//   • учётки лежат в закрытой схеме osp_vault ровно как в выгрузке копии (побайтно) и без паролей; копия
//     auth.users наполняется из них; osp_vault не читается ни без отметки, ни с пропуском служебных
//     функций, ни служебным ключом;
//   • адрес обложки меняется только у сверенных файлов и только при точном совпадении прежнего адреса;
//     дата изменения объектов и состояние триггеров — прежние; адрес другого вида — отмена всей загрузки;
//   • окончательный перенос без учёток и обложек, с журналом от другого списка или с несверенной обложкой
//     не начинается;
//   • сверка видит подменённую учётку; репетиция убирается вместе с osp_vault.
// Нужны Docker, psql, pg_dump, pg_restore.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SQL, PLATFORM_USERS, COVERS, HASH_MARK } from './lib/supabase-platform.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGET = path.join(ROOT, 'migration', 'target')
const BACKUP = path.join(ROOT, 'migration', 'backup')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('pg_dump') || !has('pg_restore') || !has('psql')
  ? 'нужны Docker, psql, pg_dump, pg_restore' : false

const ADMIN_PASS = 'Admin-Pass-ex1-secret'
const OWNER_PASS = 'Owner-Pass-ex2-secret'
const SRC = 'https://test-ref.supabase.co/storage/v1/object/public/object-photos/'

const PROD_SQL = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
${PLATFORM_SQL}
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.user_roles(user_id uuid primary key, role text not null);
create table public.objects(id int primary key, name text not null, cover_image_url text, updated_at timestamptz not null);
create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger objects_touch before update on public.objects for each row execute function public.touch_updated_at();
create function public.never_fires() returns trigger language plpgsql as $$ begin raise exception 'выключенный триггер сработал'; end $$;
create trigger objects_off before update on public.objects for each row execute function public.never_fires();
alter table public.objects disable trigger objects_off;
alter table public.objects enable row level security;
alter table public.user_roles enable row level security;
create policy objects_auth on public.objects for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
create policy roles_self on public.user_roles for select to authenticated using (user_id = auth.uid());

insert into public.user_roles values ('${PLATFORM_USERS[0].id}', 'admin');
insert into public.objects values
  (1, 'Объект 1', '${SRC}${COVERS[0].name}', '2026-01-01 10:00:00+00'),
  (2, 'Объект 2', '${SRC}${COVERS[1].name}', '2026-01-02 10:00:00+00'),
  (3, 'Объект 3', null, '2026-01-03 10:00:00+00'),
  (4, 'Объект 4', 'https://example.org/photo.jpg', '2026-01-04 10:00:00+00');
`

describe('Перенос учётных записей и обложек', { skip, timeout: 900000 }, () => {
  let tmp
  let prodPort
  let targetPort
  let dump
  let envFile
  const prodContainer = `osp-extras-prod-${process.pid}`
  const targetContainer = `osp-extras-target-${process.pid}`

  const psql = (port, user, pass, db, sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pass, PGSSLMODE: 'disable' } })
  const admin = (sql) => {
    const res = psql(targetPort, 'postgres', ADMIN_PASS, 'osp_target', sql)
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }
  // Владелец базы — та самая общая учётка; отметка — внутри транзакции, как у инструментов переноса.
  const asOwner = (sql, mark) => {
    const res = psql(targetPort, 'target_owner', OWNER_PASS, 'osp_target',
      mark ? `begin; set local application_name = '${mark}'; ${sql}; commit;` : sql)
    return { ...res, out: res.stdout.trim() }
  }
  const run = (script, args) => {
    const res = spawnSync('bash', [path.join(TARGET, script), ...args], { encoding: 'utf8', cwd: ROOT, timeout: 400000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), PROBE_CONNECT_TIMEOUT: '5' } })
    return { ...res, all: res.stdout + res.stderr }
  }
  const load = (...args) => run('load.sh', [envFile, dump, ...args])
  const noSecrets = (r) => {
    for (const s of [HASH_MARK, ADMIN_PASS, OWNER_PASS, ...PLATFORM_USERS.map((u) => u.email)]) assert.ok(!r.all.includes(s), `в выводе: ${s}`)
  }
  const emptyTarget = () => admin(`select (select count(*) from pg_namespace where nspname not in ('pg_catalog','information_schema','public') and nspname !~ '^pg_')
    || ':' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','S'))`)
  const list = () => `${dump.replace(/\.dump$/, '')}.covers.csv`
  const journal = (name, patch = (j) => j) => {
    const text = fs.readFileSync(list(), 'utf8')
    const names = text.split('\n').filter(Boolean).slice(1).map((l) => l.split(',')[0])
    const j = patch({
      tool: 'covers-copy', version: 1, list_sha256: crypto.createHash('sha256').update(text).digest('hex'),
      source_base: SRC, target_prefix: 'covers/', finished_at: new Date().toISOString(),
      files: names.map((n, i) => ({ name: n, size: 1000 + i, sha256: String(i).repeat(64), status: 'verified' })),
    })
    const file = path.join(tmp, name)
    fs.writeFileSync(file, JSON.stringify(j))
    return file
  }
  const waitFor = (probe, what) => {
    const deadline = Date.now() + 120000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`${what} не поднялся`)
      spawnSync('sleep', ['0.5'])
    }
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-extras-'))
    prodPort = 22000 + Math.floor(Math.random() * 500) // свои диапазоны (наборы идут параллельно), ниже портов исходящих соединений
    targetPort = 22500 + Math.floor(Math.random() * 500)
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
    ]) assert.equal(psql(targetPort, 'postgres', ADMIN_PASS, 'postgres', sql).status, 0, sql)
    admin('create extension pg_trgm; create extension pgcrypto')
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

  it('окончательный перенос без учёток или обложек не начинается', () => {
    for (const args of [['--auth'], ['--covers', journal('good.json')], []]) {
      const res = load('--status', 'final', '--single-owner', ...args)
      assert.equal(res.status, 1, res.all)
      assert.match(res.stderr, /только вместе с учётками и обложками: --auth --covers/)
    }
    assert.equal(emptyTarget(), '0:0')
  })

  it('журнал от другого списка, несверенная обложка в final — отказ до записи', () => {
    let res = load('--status', 'rehearsal', '--single-owner', '--auth', '--covers', journal('other.json', (j) => ({ ...j, list_sha256: 'f'.repeat(64) })))
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /^FAIL журнал обложек не принят: error: журнал обложек снят по другому списку/m)
    res = load('--status', 'final', '--single-owner', '--auth', '--covers', journal('failed.json', (j) => {
      j.files[2] = { name: j.files[2].name, status: 'failed', reason: 'нет ответа' }
      return j
    }))
    assert.equal(res.status, 3, res.all)
    assert.match(res.stdout, /^FAIL обложек не сверено: 1 из 3 — окончательный перенос только со всеми/m)
    assert.equal(emptyTarget(), '0:0')
  })

  it('адрес обложки другого вида — отмена всей загрузки', () => {
    const res = load('--status', 'rehearsal', '--single-owner', '--auth', '--covers',
      journal('host.json', (j) => ({ ...j, source_base: 'https://other-ref.supabase.co/storage/v1/object/public/object-photos/' })))
    assert.equal(res.status, 4, res.all)
    assert.match(res.stdout, /OSP_COVERS_MISMATCH: заменено адресов 0, ожидалось 2/)
    assert.equal(emptyTarget(), '0:0')
  })

  it('репетиция: учётки — в osp_vault, адреса сверенных обложек — /api/covers, даты объектов и триггеры прежние', () => {
    const good = journal('good.json')
    const res = load('--status', 'rehearsal', '--single-owner', '--auth', '--covers', good)
    assert.equal(res.status, 0, res.all)
    noSecrets(res)
    assert.match(res.stdout, /^ИНФО учётные записи без паролей — в закрытую схему osp_vault: учёток 3, способов входа 3$/m)
    assert.equal(admin("select count(*) from information_schema.columns where table_schema = 'osp_vault' and column_name like '%password%'"), '0')
    assert.match(res.stdout, /^ИНФО обложки: в списке копии 3, скопировано в cloud\.ru и сверено 3, не сверено 0$/m)
    assert.match(res.stdout, /^ИНФО обложки: адресов объектов заменено на \/api\/covers\/… — 2 \(сверенных файлов 3\)$/m)
    assert.match(res.stdout, /verify\.sh <файл подключения> .* --covers /)
    assert.equal(admin('select string_agg(id || \'=\' || coalesce(cover_image_url, \'-\') || \'@\' || to_char(updated_at at time zone \'UTC\', \'MM-DD HH24\'), \' \' order by id) from public.objects'),
      `1=/api/covers/${COVERS[0].name}@01-01 10 2=/api/covers/${COVERS[1].name}@01-02 10 3=-@01-03 10 4=https://example.org/photo.jpg@01-04 10`)
    assert.equal(admin("select string_agg(tgname || ':' || tgenabled::text, ' ' order by tgname) from pg_trigger where tgrelid = 'public.objects'::regclass and not tgisinternal"),
      'objects_off:D objects_touch:O')
    // Владелец без отметки не видит ни строки, с отметкой — все.
    assert.equal(asOwner('select count(*) from osp_vault.users').out, '0')
    assert.equal(asOwner('select count(*) || \'/\' || (select count(*) from osp_vault.identities) from osp_vault.users', 'osp:vault').out, '3/3')
    assert.equal(asOwner('select count(*) from osp_vault.users', 'osp:internal').out, '0')
  })

  it('сверка: без журнала обложек — отказ; с ним — учётки побайтно, адреса по журналу; подменённая учётка видна', () => {
    let res = run('verify.sh', [envFile, dump])
    assert.equal(res.status, 1, res.all)
    assert.match(res.stdout, /^FAIL загрузка меняла адреса обложек: сверка — с тем же журналом/m)
    res = run('verify.sh', [envFile, dump, '--covers', path.join(tmp, 'good.json')])
    assert.equal(res.status, 0, res.all)
    noSecrets(res)
    assert.match(res.stdout, /^OK адреса обложек: замены в базе — ровно по журналу \(3 файлов, адресов 2\)$/m)
    assert.match(res.stdout, /^OK учётные записи: в базе ровно выгрузка копии — 3 строк, побайтно$/m)
    assert.match(res.stdout, /^OK способы входа: в базе ровно выгрузка копии — 3 строк, побайтно$/m)
    assert.match(res.stdout, /^OK контрольные суммы данных: .* — совпадают$/m)

    const id = PLATFORM_USERS[1].id
    assert.equal(asOwner(`update osp_vault.users set email = email || 'x' where id = '${id}'`, 'osp:vault').status, 0)
    res = run('verify.sh', [envFile, dump, '--covers', path.join(tmp, 'good.json')])
    assert.equal(res.status, 4, res.all)
    assert.match(res.stdout, /^FAIL учётные записи: в базе не то, что в выгрузке копии$/m)
    assert.equal(asOwner(`update osp_vault.users set email = left(email, -1) where id = '${id}'`, 'osp:vault').status, 0)
  })

  it('права под одну учётку: копия auth.users — из osp_vault; osp_vault закрыта и от пропуска, и от служебного ключа', () => {
    const res = run('rights.sh', [envFile, dump])
    assert.equal(res.status, 0, res.all)
    noSecrets(res)
    assert.match(res.stdout, /^OK учётные записи Supabase Auth закрыты: только отметка переноса, функциям и представлениям портала недоступны$/m)
    assert.match(res.stdout, /^OK с пропуском служебных функций и служебным ключом учётные записи osp_vault не читаются$/m)
    assert.equal(asOwner('select count(*) from auth.users', 'osp:internal').out, '3')
    assert.equal(admin("select count(*) from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name like '%password%'"), '0')
  })

  it('vault.sh status: учётные записи актуальны; новая и изменённая учётка в Supabase Auth видны', () => {
    let res = run('vault.sh', [envFile, 'status'])
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /^Учётные записи \(osp_vault\): 3, сняты с копии prod-.*\.dump/m)
    assert.match(res.stdout, /^Новые учётки — в osp_vault их нет: 0$/m)
    assert.match(res.stdout, /^ИТОГ: учётные записи актуальны\.$/m)
    // Так копию обновляет osp-api из Supabase Auth.
    assert.equal(asOwner(`update auth.users set updated_at = now() where id = '${PLATFORM_USERS[2].id}';
      insert into auth.users (id, email, created_at, updated_at) values (gen_random_uuid(), 'new@example.ru', now(), now())`, 'osp:internal').status, 0)
    res = run('vault.sh', [envFile, 'status'])
    assert.equal(res.status, 0, res.all)
    assert.match(res.stdout, /^Новые учётки — в osp_vault их нет: 1$/m)
    assert.match(res.stdout, /^Изменены в Supabase позже копии: 1$/m)
    assert.match(res.stdout, /^ИТОГ: перед сопоставлением со входом через Keycloak снять учётные записи заново\.$/m)
  })

  it('ночная копия базы (export.sh) включает учётные записи osp_vault — тем же снимком, и восстанавливается', () => {
    const out = path.join(tmp, 'exports')
    const res = spawnSync('bash', [path.join(TARGET, 'export.sh'), envFile], { encoding: 'utf8', cwd: ROOT, timeout: 400000,
      env: { ...process.env, BACKUP_OUT_DIR: out, PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    const dir = path.join(out, fs.readdirSync(out).find((d) => d.startsWith('yandex-')))
    const manifest = Object.fromEntries(fs.readFileSync(path.join(dir, 'manifest.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t').slice(0, 2)))
    assert.deepEqual([manifest['osp_vault.users'], manifest['osp_vault.identities'], manifest['osp_vault.copy_log'], manifest['auth.users']], ['3', '3', '1', '4'])
    const verified = spawnSync('bash', [path.join(TARGET, 'export-verify.sh'), dir], { encoding: 'utf8', cwd: ROOT, timeout: 400000 })
    assert.equal(verified.status, 0, verified.stdout + verified.stderr)
    assert.match(verified.stdout, /КОПИЯ ГОДНА/)
    assert.ok(!(res.stdout + verified.stdout).includes(HASH_MARK))
  })

  it('очистка репетиции убирает и osp_vault, и перечень обложек', () => {
    const res = run('reset.sh', [envFile, '--yes-drop-rehearsal'])
    assert.equal(res.status, 0, res.all)
    assert.equal(emptyTarget(), '0:0')
  })
})
