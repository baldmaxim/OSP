// Разведка выданной базы (migration/target/probe.sh) на временном PostgreSQL в Docker с парольным входом.
// Проверяем обещанное пользователю: разведка ничего не меняет; пароль, адрес и чужие имена не попадают
// ни на экран, ни в отчёт; база «как в заявке», чужая база и база Supabase распознаются; при отказе —
// понятная строка и выход без зависания. Сервер — с TLS (свой центр сертификации): проверка сертификата
// проходит с верным корневым сертификатом и не проходит без него или с чужим. Нужны Docker, psql, openssl.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROBE = path.join(ROOT, 'migration', 'target', 'probe.sh')
const PROBE_SQL = path.join(ROOT, 'migration', 'target', 'probe.sql')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0
const skip = process.platform === 'win32' || !dockerOk || !has('psql') || !has('openssl') ? 'нужны Docker, psql и openssl' : false

const ADMIN_PASS = 'Admin-Pass-zz1-secret'
const STAGE_PASS = 'Stage-Pass-zz7-secret'
const OTHER_PASS = 'Other-Pass-zz8-secret'
const SECRETS = [ADMIN_PASS, STAGE_PASS, OTHER_PASS]
const FOREIGN_NAMES = ['zz_private_db', 'zz_private_role', 'zz_secret_table', 'zz_osp_test_db', 'zz_osp_role']

const SETUP_SQL = `
create role osp_migration login password '${STAGE_PASS}';
create database osp_stage_db owner osp_migration encoding 'UTF8' template template0;
create role zz_private_role login password '${OTHER_PASS}';
create database zz_private_db owner zz_private_role;
create role zz_osp_role login password '${OTHER_PASS}';
create database zz_osp_test_db owner zz_osp_role;
-- «как Supabase» — в базе postgres
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users(id uuid primary key);
create table public.tenders(id int);
create table public.user_roles(id int);
\\c osp_stage_db
create extension pg_trgm; create extension pgcrypto; create extension "uuid-ossp";
\\c zz_private_db
create table public.zz_secret_table(id int);
`

describe('Разведка выданной базы: только чтение, без секретов в выводе', { skip, timeout: 300000 }, () => {
  let tmp
  let port
  let certs
  const container = `osp-probe-test-${process.pid}`

  const admin = (db, sql) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: ADMIN_PASS, PGSSLMODE: 'disable' } })

  let n = 0
  function envFile(lines) {
    const file = path.join(tmp, `target-${++n}.env`)
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
    return file
  }
  const conn = (over = {}) => {
    const v = { PGHOST: '127.0.0.1', PGPORT: String(port), PGDATABASE: 'osp_stage_db', PGUSER: 'osp_migration', PGPASSWORD: STAGE_PASS, PGSSLMODE: 'require', ...over }
    return Object.entries(v).filter(([, value]) => value !== null).map(([k, value]) => `${k}=${value}`)
  }
  function probe(file, { input, env = {} } = {}) {
    const reports = path.join(tmp, `reports-${n}`)
    const res = spawnSync('bash', [PROBE, file], {
      encoding: 'utf8', cwd: ROOT, timeout: 60000, input,
      // HOME — пустой каталог: корневого сертификата нет; чужое PG* из окружения не должно влиять.
      env: { ...process.env, HOME: tmp, PROBE_REPORT_DIR: reports, PROBE_CONNECT_TIMEOUT: '5', PGHOST: 'ambient.invalid', PGDATABASE: 'ambient_db', ...env },
    })
    const files = fs.existsSync(reports) ? fs.readdirSync(reports) : []
    const report = files.length ? fs.readFileSync(path.join(reports, files[0]), 'utf8') : ''
    const mode = files.length ? fs.statSync(path.join(reports, files[0])).mode & 0o777 : null
    return { ...res, all: res.stdout + res.stderr, report, mode }
  }
  const noSecrets = (r, extra = []) => {
    for (const s of [...SECRETS, ...extra]) {
      assert.ok(!r.all.includes(s), `в выводе: ${s}`)
      assert.ok(!r.report.includes(s), `в отчёте: ${s}`)
    }
  }
  // «Отпечаток» всего кластера: объекты, роли, базы, строки пользовательских таблиц.
  const fingerprint = () => ['postgres', 'osp_stage_db', 'zz_private_db'].map((db) => admin(db, `
    select md5(coalesce((select string_agg(c.oid::text || ':' || c.relname || ':' || c.relfilenode, ',' order by c.oid) from pg_class c), ''))
        || md5(coalesce((select string_agg(r.oid::text || ':' || r.rolname || ':' || coalesce(r.rolpassword, ''), ',' order by r.oid) from pg_authid r), ''))
        || md5(coalesce((select string_agg(d.oid::text || ':' || d.datname, ',' order by d.oid) from pg_database d), ''))
        || (select count(*) from pg_prepared_xacts) || ':' || (select count(*) from pg_locks where locktype = 'advisory')`).stdout.trim()).join('|')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-probe-'))
    port = 22000 + Math.floor(Math.random() * 1000) // свой диапазон (наборы идут параллельно), ниже портов исходящих соединений
    // Свой центр сертификации, сертификат сервера на 127.0.0.1 и «чужой» центр — для отказа.
    certs = path.join(tmp, 'certs')
    fs.mkdirSync(certs)
    const ssl = (args) => assert.equal(spawnSync('openssl', args, { cwd: certs, stdio: 'ignore' }).status, 0, args.join(' '))
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=osp-test-ca', '-keyout', 'ca.key', '-out', 'ca.crt'])
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=other-ca', '-keyout', 'other.key', '-out', 'other.crt'])
    ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr'])
    fs.writeFileSync(path.join(certs, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
    ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'server.crt'])
    spawnSync('chmod', ['-R', 'a+rX', tmp])
    // Ключ сервера должен принадлежать postgres: копируем внутрь контейнера до запуска.
    const boot = 'cp /certs/server.crt /certs/server.key /var/lib/postgresql/ && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key'
      + ' && chmod 600 /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c fsync=off -c ssl=on'
      + ' -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'
    const started = spawnSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:5432`,
      '-v', `${certs}:/certs:ro`, '-e', `POSTGRES_PASSWORD=${ADMIN_PASS}`, '--entrypoint', 'sh', 'postgres:17-alpine', '-c', boot], { encoding: 'utf8' })
    assert.equal(started.status, 0, started.stderr)
    let ready = false
    for (let i = 0; i < 240 && !ready; i++) {
      ready = admin('postgres', 'select 1').stdout.trim() === '1'
      if (!ready) spawnSync('sleep', ['0.5'])
    }
    assert.ok(ready, 'временный PostgreSQL не поднялся')
    const setup = path.join(tmp, 'setup.sql')
    fs.writeFileSync(setup, SETUP_SQL)
    const res = spawnSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', setup],
      { encoding: 'utf8', env: { ...process.env, PGPASSWORD: ADMIN_PASS, PGSSLMODE: 'disable' } })
    assert.equal(res.status, 0, res.stderr)
  })
  after(() => {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('база «как в заявке»: стенд, роль-владелец, расширения, пустая — и ни одного секрета', () => {
    const r = probe(envFile(conn()))
    assert.equal(r.status, 0, r.all)
    for (const line of [
      'ИНФО адрес: эта же машина; порт нестандартный (не показываю)',
      'ВНИМАНИЕ TLS в файле: require — шифрование есть, сертификат сервера не проверяется',
      'ИНФО verify-full не пробовали: корневого сертификата нет ни рядом с файлом подключения, ни в ~/.postgresql',
      'ИНФО это не Supabase',
      'OK версия сервера: PostgreSQL 17',
      'ИНФО база: osp_stage_db — СТЕНД данных портала',
      'ИНФО роль: osp_migration',
      'суперпользователь — нет',
      'OK роль — владелец этой базы',
      'OK роль может создавать схемы в базе',
      'OK роль может создавать таблицы в схеме public',
      'OK кодировка: UTF8',
      'OK расширение pg_trgm: включено (схема public)',
      'OK расширение pgcrypto: включено',
      'OK расширение uuid-ossp: включено',
      'ИНФО расширение pg_stat_statements: не включено (необязательное)',
      'OK база пустая: таблиц и представлений нет',
      'ИНФО других баз в кластере видно: 3 (имена не показываю)',
      'ИНФО пулер: признаков режима транзакций нет',
    ]) assert.ok(r.stdout.includes(line), `нет строки: ${line}\n${r.stdout}`)
    assert.match(r.stdout, /^OK часовой пояс: (UTC|Etc\/UTC)/m)
    // В тестовом кластере подключение открыто всем — разведка обязана это заметить.
    assert.match(r.stdout, /^ВНИМАНИЕ подключение к этой базе открыто всем учёткам кластера \(PUBLIC\)$/m)
    assert.match(r.stdout, /^ИНФО к этой базе могут подключиться другие учётки: обычных — \d+, суперпользователей — 1 \(имена не показываю\)$/m)
    assert.match(r.stdout, /^ИНФО подключений учётки сейчас: \d+ из лимита без лимита; из них в других базах — 0$/m)
    assert.match(r.stdout, /^OK подключение установлено; шифрование TLSv1\.[23]$/m)
    assert.doesNotMatch(r.stdout, /^FAIL/m)
    noSecrets(r, [...FOREIGN_NAMES, '127.0.0.1', String(port)])
    assert.equal(r.mode, 0o600, 'отчёт доступен только владельцу')
    assert.equal(r.report.trim(), r.stdout.split('\n').filter((l) => !l.startsWith('Отчёт сохранён')).join('\n').trim(), 'отчёт = то, что на экране')
  })

  it('чужая база и роль: имена не показываются, чужие таблицы — только счётчиком', () => {
    const r = probe(envFile(conn({ PGDATABASE: 'zz_private_db', PGUSER: 'zz_private_role', PGPASSWORD: OTHER_PASS })))
    assert.equal(r.status, 0, r.all)
    assert.ok(r.stdout.includes('ИНФО база: имя не из нашей заявки (не показываю); «osp» в имени нет; стенд или боевая — по имени не видно'))
    assert.ok(r.stdout.includes('ИНФО роль: имя не из нашей заявки (не показываю); «osp» в имени нет'))
    assert.ok(r.stdout.includes('ВНИМАНИЕ в базе есть таблицы, и это не таблицы портала: 1 (имена не показываю)'))
    assert.ok(r.stdout.includes('ВНИМАНИЕ расширение pg_trgm: доступно, но не включено'))
    noSecrets(r, FOREIGN_NAMES)
  })

  it('имя не из заявки: само не показывается, но видно, что оно про портал и похоже на стенд', () => {
    const r = probe(envFile(conn({ PGDATABASE: 'zz_osp_test_db', PGUSER: 'zz_osp_role', PGPASSWORD: OTHER_PASS })))
    assert.equal(r.status, 0, r.all)
    assert.ok(r.stdout.includes('ИНФО база: имя не из нашей заявки (не показываю); в имени есть «osp»; по имени похожа на стенд'))
    assert.ok(r.stdout.includes('ИНФО роль: имя не из нашей заявки (не показываю); в имени есть «osp»'))
    assert.ok(r.stdout.includes('OK роль — владелец этой базы'))
    noSecrets(r, FOREIGN_NAMES)
  })

  it('база Supabase распознаётся; таблицы портала считаются', () => {
    const r = probe(envFile(conn({ PGDATABASE: 'postgres', PGUSER: 'postgres', PGPASSWORD: ADMIN_PASS })))
    assert.equal(r.status, 0, r.all)
    assert.ok(r.stdout.includes('ИНФО это база Supabase: есть схема auth и роли anon / authenticated / service_role'))
    assert.ok(r.stdout.includes('ИНФО база: postgres (имя по умолчанию)'))
    assert.ok(r.stdout.includes('суперпользователь — да'))
    assert.match(r.stdout, /ИНФО в базе уже есть таблицы портала: 2 из 7 опорных; всего таблиц и представлений — 3/)
    noSecrets(r, FOREIGN_NAMES)
  })

  it('TLS: с верным корневым сертификатом проверка проходит; без него и с чужим — отказ', () => {
    const ca = path.join(certs, 'ca.crt')
    const full = probe(envFile([...conn({ PGSSLMODE: 'verify-full' }), `PGSSLROOTCERT=${ca}`]))
    assert.equal(full.status, 0, full.all)
    assert.ok(full.stdout.includes('OK TLS в файле: verify-full — сертификат и имя сервера проверяются'))
    assert.match(full.stdout, /^OK подключение установлено; шифрование TLSv1\.[23]$/m)
    assert.ok(!full.stdout.includes('verify-full не пробовали'))

    // Файл с require, а сертификат на машине уже есть — подсказка, что режим можно ужесточить.
    const home = path.join(tmp, 'home-with-ca')
    fs.mkdirSync(path.join(home, '.postgresql'), { recursive: true })
    fs.copyFileSync(ca, path.join(home, '.postgresql', 'root.crt'))
    const hint = probe(envFile(conn()), { env: { HOME: home } })
    assert.equal(hint.status, 0, hint.all)
    assert.ok(hint.stdout.includes('OK с проверкой сертификата (verify-full) подключение тоже проходит'))

    const noCa = probe(envFile(conn({ PGSSLMODE: 'verify-full' })))
    assert.equal(noCa.status, 2, noCa.all)
    assert.ok(noCa.stdout.includes('FAIL нет корневого сертификата для проверки TLS на этой машине'))
    assert.ok(noCa.stdout.includes('storage.yandexcloud.net/cloud-certs/CA.pem'), 'подсказка, где взять сертификат Яндекса')
    assert.ok(noCa.stdout.includes(`-o ${tmp}/root.crt`), 'сертификат — рядом с файлом подключения')
    assert.ok(noCa.stdout.includes('в ~/.postgresql/root.crt его не класть'))

    // Сертификат рядом с файлом подключения подхватывается сам; в ~/.postgresql ничего не появляется.
    const dir = path.join(tmp, 'secrets-dir')
    fs.mkdirSync(dir)
    fs.copyFileSync(ca, path.join(dir, 'root.crt'))
    const beside = path.join(dir, 'target.env')
    fs.writeFileSync(beside, conn({ PGSSLMODE: 'verify-full' }).join('\n') + '\n', { mode: 0o600 })
    n += 1
    const adjacent = probe(beside)
    assert.equal(adjacent.status, 0, adjacent.all)
    assert.match(adjacent.stdout, /^OK подключение установлено; шифрование TLSv1\.[23]$/m)
    assert.ok(!fs.existsSync(path.join(tmp, '.postgresql')), 'в ~/.postgresql ничего не пишется')
    noSecrets(adjacent)

    const wrongCa = probe(envFile([...conn({ PGSSLMODE: 'verify-full' }), `PGSSLROOTCERT=${path.join(certs, 'other.crt')}`]))
    assert.equal(wrongCa.status, 2, wrongCa.all)
    assert.ok(wrongCa.stdout.includes('FAIL проверка TLS-сертификата сервера не прошла'))

    const plain = probe(envFile(conn({ PGSSLMODE: 'disable' })))
    assert.equal(plain.status, 0, plain.all)
    assert.ok(plain.stdout.includes('ВНИМАНИЕ TLS в файле: disable — шифрование не обязательно'))
    assert.ok(plain.stdout.includes('ВНИМАНИЕ подключение установлено без шифрования'))
    for (const r of [full, hint, noCa, wrongCa, plain]) noSecrets(r)
  })

  it('разведка ничего не меняет — даже под суперпользователем', () => {
    const before = fingerprint()
    assert.match(before, /^[0-9a-f:|]+$/)
    for (const over of [{}, { PGDATABASE: 'zz_private_db', PGUSER: 'zz_private_role', PGPASSWORD: OTHER_PASS }, { PGDATABASE: 'postgres', PGUSER: 'postgres', PGPASSWORD: ADMIN_PASS }]) {
      assert.equal(probe(envFile(conn(over))).status, 0)
    }
    assert.equal(fingerprint(), before)
  })

  it('в запросах разведки нет записи: только чтение каталогов в транзакции READ ONLY', () => {
    // Без комментариев и строковых литералов: в литералах есть слова вроде 'CREATE' (имя права).
    const sql = fs.readFileSync(PROBE_SQL, 'utf8').replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''")
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^\\set ON_ERROR_STOP on\s*/, ''))
    assert.equal(statements[0], 'BEGIN TRANSACTION READ ONLY')
    assert.equal(statements.at(-1), 'ROLLBACK')
    for (const s of statements.slice(1, -1)) assert.match(s, /^(select|with|SET LOCAL (statement_timeout|lock_timeout) = '')/i, s.slice(0, 80))
    assert.doesNotMatch(sql, /\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|call|do|refresh|vacuum|reindex|cluster|comment|commit|lock|listen|notify|nextval|setval|pg_terminate_backend|pg_cancel_backend|set_config|lo_\w+|dblink\w*)\b/i)
    // В самом скрипте — только эти запросы.
    const inScript = [...fs.readFileSync(PROBE, 'utf8').matchAll(/-c '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual([...new Set(inScript)].sort(), ['DEALLOCATE osp_probe_stmt', 'EXECUTE osp_probe_stmt', 'PREPARE osp_probe_stmt AS SELECT 1', '\\conninfo', 'select 1'].sort())
  })

  it('файл разбирается, а не исполняется; кавычки, export и CRLF понимаются; лишние ключи игнорируются', () => {
    const marker = path.join(tmp, 'pwned')
    const file = path.join(tmp, 'tricky.env')
    fs.writeFileSync(file, [
      `$(touch ${marker})`,
      `touch ${marker}`,
      'PGOPTIONS=-c default_transaction_read_only=off',
      'PGHOST=127.0.0.1',
      `PGPORT=${port}  `,
      "export PGDATABASE='osp_stage_db'",
      'PGUSER="osp_migration"',
      `PGPASSWORD=${STAGE_PASS}`,
      'PGSSLMODE=disable',
    ].join('\r\n') + '\r\n')
    n += 1
    const r = probe(file)
    assert.equal(r.status, 0, r.all)
    assert.ok(r.stdout.includes('ИНФО база: osp_stage_db — СТЕНД данных портала'))
    assert.ok(!fs.existsSync(marker), 'строки файла не исполняются')
  })

  it('пароля в файле нет — спрашивается скрыто; без обязательного ключа — отказ, окружение не подставляется', () => {
    const asked = probe(envFile(conn({ PGPASSWORD: null })), { input: `${STAGE_PASS}\n` })
    assert.equal(asked.status, 0, asked.all)
    assert.ok(asked.stdout.includes('ИНФО роль: osp_migration'))
    noSecrets(asked)
    const missing = probe(envFile(conn({ PGDATABASE: null })))
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /В файле нет PGDATABASE/)
    assert.equal(probe(path.join(tmp, 'нет-такого.env')).status, 1)
  })

  it('отказы: понятная строка, код 2, без адреса и пароля, без зависания', () => {
    const cases = [
      [{ PGPASSWORD: 'Wrong-Pass-zz9-secret' }, 'FAIL вход не выполнен: пароль или имя роли не подошли', ['Wrong-Pass-zz9-secret']],
      [{ PGHOST: 'secret-host-zz9.invalid' }, 'FAIL адрес сервера не находится (DNS) с этой машины', ['secret-host-zz9']],
      [{ PGPORT: '1' }, 'FAIL соединение отклонено: порт закрыт или сервер не слушает', []],
      [{ PGDATABASE: 'zz_no_such_db' }, 'FAIL базы или роли с таким именем на сервере нет', ['zz_no_such_db']],
    ]
    for (const [over, line, hidden] of cases) {
      const started = Date.now()
      const r = probe(envFile(conn(over)))
      assert.equal(r.status, 2, `${line}\n${r.all}`)
      assert.ok(r.stdout.includes(line), `нет строки: ${line}\n${r.all}`)
      assert.ok(r.report.includes(line), 'отказ записан в отчёт')
      noSecrets(r, hidden)
      assert.ok(Date.now() - started < 30000, 'без зависания')
    }
  })
})
