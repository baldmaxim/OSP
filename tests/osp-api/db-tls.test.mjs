// Подключение osp-api к базе — только с проверкой сертификата и имени сервера
// (server/osp-api/src/lib/db.js, dbConnection). Проверяем:
//   • правило: к базе не на этой машине без корневого сертификата служба не подключается; строка
//     подключения проверку не ослабляет (sslmode=require / disable и любые другие параметры — отказ);
//   • в текстах отказов нет адреса, учётки и пароля;
//   • на настоящем PostgreSQL с TLS: верный сертификат — подключение шифрованное; сертификат на другое
//     имя и сертификат чужого центра — отказ.
// Правило — без базы; TLS — нужны Docker и openssl.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const skipDeps = fs.existsSync(path.join(SERVER, 'node_modules', 'pg')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const dockerOk = process.platform !== 'win32' && has('docker') && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0
const skipTls = skipDeps || (dockerOk && has('openssl') ? false : 'нужны Docker и openssl')

const PASSWORD = 'S3cr3t-pass-do-not-print'
const REMOTE = `postgres://portal_user:${PASSWORD}@db.example.internal:6432/portal_db`

describe('osp-api: подключение к базе — правило проверки сертификата', { skip: skipDeps }, () => {
  let dbConnection
  let createDb
  const readCa = (file, enc) => { assert.equal(enc, 'utf8'); return `CA(${file})` }

  before(async () => {
    ;({ dbConnection, createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js')))
  })

  it('база на этой же машине — можно без сертификата; с сертификатом — проверка включена', () => {
    assert.deepEqual(dbConnection({ url: 'postgres://u:p%40ss%2Fw@127.0.0.1:5433/osp' }),
      { host: '127.0.0.1', port: 5433, user: 'u', password: 'p@ss/w', database: 'osp', ssl: false })
    assert.equal(dbConnection({ url: 'postgresql://u:p@localhost/osp' }).port, 5432)
    assert.deepEqual(dbConnection({ url: 'postgres://u:p@[::1]:5432/osp' }).host, '::1')
    assert.deepEqual(dbConnection({ url: 'postgres://u:p@127.0.0.1/osp', caFile: '/etc/ca.crt' }, readCa).ssl,
      { ca: 'CA(/etc/ca.crt)', rejectUnauthorized: true })
  })

  it('база не на этой машине: без корневого сертификата — отказ; с ним — проверка сертификата и имени', () => {
    assert.throws(() => dbConnection({ url: REMOTE }), /без проверки сертификата запрещено/)
    assert.throws(() => dbConnection({ url: REMOTE, caFile: '' }), /без проверки сертификата запрещено/)
    assert.throws(() => createDb({ url: REMOTE }), /без проверки сертификата запрещено/, 'обёртку не создать в обход правила')
    const c = dbConnection({ url: REMOTE, caFile: '/etc/osp-api/root.crt' }, readCa)
    assert.deepEqual(c, { host: 'db.example.internal', port: 6432, user: 'portal_user', password: PASSWORD, database: 'portal_db',
      ssl: { ca: 'CA(/etc/osp-api/root.crt)', rejectUnauthorized: true } })
    assert.deepEqual(dbConnection({ url: `${REMOTE}?sslmode=verify-full`, caFile: '/etc/osp-api/root.crt' }, readCa), c)
    // sslmode=verify-full без сертификата — отказ даже для базы на этой машине: просили проверку, проверить нечем.
    assert.throws(() => dbConnection({ url: 'postgres://u:p@127.0.0.1/osp?sslmode=verify-full' }), /без проверки сертификата запрещено/)
  })

  it('строка подключения проверку не ослабляет: любой другой sslmode и любые другие параметры — отказ', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify', '']) {
      assert.throws(() => dbConnection({ url: `${REMOTE}?sslmode=${mode}`, caFile: '/ca.crt' }, readCa), /только verify-full/, mode)
      assert.throws(() => dbConnection({ url: `postgres://u:p@127.0.0.1/osp?sslmode=${mode}` }), /только verify-full/, mode)
    }
    for (const param of ['ssl=true', 'ssl=0', 'sslrootcert=/tmp/x.crt', 'sslcert=/tmp/c', 'uselibpqcompat=true', 'options=-c%20role%3Dpostgres', 'application_name=x', 'host=other']) {
      assert.throws(() => dbConnection({ url: `${REMOTE}?${param}`, caFile: '/ca.crt' }, readCa), /допустим только параметр sslmode=verify-full/, param)
    }
  })

  it('неразборчивая строка — отказ; в текстах отказов нет адреса, учётки и пароля', () => {
    const bad = [
      '', 'не адрес', `https://portal_user:${PASSWORD}@db.example.internal/portal_db`, `postgres://portal_user:${PASSWORD}@db.example.internal:6432`,
      `postgres://db.example.internal:6432/portal_db`, `postgres://portal_user:${PASSWORD}@db.example.internal:6432/portal_db/extra`,
      `postgres://portal_user:${PASSWORD}@db.example.internal:6432/portal_db?sslmode=require`, REMOTE,
      // Неэкранированный «?» в пароле: остаток пароля и адрес разбираются как параметры.
      `postgres://portal_user:S3cr3t?pass-do-not-print@db.example.internal:6432/portal_db`,
      `postgres://portal_user:%E0%A4%A@db.example.internal:6432/portal_db`,
    ]
    for (const url of bad) {
      let message = null
      try { dbConnection({ url }) } catch (err) { message = err.message }
      assert.ok(message, `должен быть отказ: ${url.replace(/:[^:@/]*@/, ':***@')}`)
      for (const leak of ['portal_user', 'S3cr3t', 'do-not-print', 'db.example.internal', 'portal_db', '6432']) {
        assert.ok(!message.includes(leak), `в отказе видно «${leak}»: ${message}`)
      }
    }
  })
})

describe('osp-api: подключение к базе по TLS на настоящем PostgreSQL', { skip: skipTls, timeout: 300000 }, () => {
  let createDb
  let tmp
  let port
  const container = `osp-test-pg-tls-${process.pid}`
  const file = (name) => path.join(tmp, 'certs', name)
  const url = (host) => `postgres://postgres:${PASSWORD}@${host}:${port}/postgres`
  const tlsState = (db) => db.read(null, (tx) => tx.query('select ssl, version from pg_stat_ssl where pid = pg_backend_pid()')).then((r) => r.rows[0])

  before(async () => {
    ;({ createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js')))
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-api-tls-'))
    const certs = path.join(tmp, 'certs')
    fs.mkdirSync(certs)
    const ssl = (args) => assert.equal(spawnSync('openssl', args, { cwd: certs, stdio: 'ignore' }).status, 0, args.join(' '))
    // Свой центр сертификации; сертификат сервера — только на имя localhost (не на адрес 127.0.0.1);
    // «чужой» центр — для отказа.
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=osp-test-ca', '-keyout', 'ca.key', '-out', 'ca.crt'])
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=other-ca', '-keyout', 'other.key', '-out', 'other.crt'])
    ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr'])
    fs.writeFileSync(path.join(certs, 'ext.cnf'), 'subjectAltName=DNS:localhost\n')
    ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'server.crt'])
    spawnSync('chmod', ['-R', 'a+rX', tmp])
    // Ключ сервера должен принадлежать postgres: копируем внутрь контейнера до запуска.
    const boot = 'cp /certs/server.crt /certs/server.key /var/lib/postgresql/ && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key'
      + ' && chmod 600 /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c fsync=off -c ssl=on'
      + ' -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'
    // Порт занят — берём другой, до пяти попыток (диапазон ниже портов исходящих соединений).
    for (let attempt = 1; ; attempt++) {
      port = 23000 + Math.floor(Math.random() * 1000)
      const started = spawnSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:5432`,
        '-v', `${certs}:/certs:ro`, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '--entrypoint', 'sh', 'postgres:17-alpine', '-c', boot], { encoding: 'utf8' })
      if (started.status === 0) break
      spawnSync('docker', ['rm', '-fv', container], { stdio: 'ignore' })
      if (attempt >= 5 || !/address already in use|port is already allocated/i.test(started.stderr)) assert.fail(started.stderr)
    }
    // Готов, когда отвечает через проброшенный порт (образ сначала поднимает сервер только на сокете).
    const deadline = Date.now() + 120000
    for (;;) {
      const db = createDb({ url: url('localhost'), caFile: file('ca.crt'), max: 1, connectionTimeoutMs: 2000 })
      const ok = await tlsState(db).then(() => true, () => false)
      await db.close()
      if (ok) break
      if (Date.now() > deadline) assert.fail('временный PostgreSQL с TLS не поднялся')
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
  after(() => {
    spawnSync('docker', ['rm', '-fv', container], { stdio: 'ignore' })
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('верный корневой сертификат и имя сервера — подключение шифрованное', async () => {
    const db = createDb({ url: url('localhost'), caFile: file('ca.crt'), max: 1 })
    try {
      const state = await tlsState(db)
      assert.equal(state.ssl, true, 'сеанс идёт по TLS')
      assert.match(state.version, /^TLSv1\.[23]$/)
    } finally { await db.close() }
  })

  it('сертификат выдан на другое имя — отказ: проверяется не только центр, но и имя сервера', async () => {
    const db = createDb({ url: url('127.0.0.1'), caFile: file('ca.crt'), max: 1 })
    try {
      await assert.rejects(tlsState(db), (err) => err.code === 'ERR_TLS_CERT_ALTNAME_INVALID')
    } finally { await db.close() }
  })

  it('сертификат чужого центра — отказ, запрос до базы не доходит', async () => {
    const db = createDb({ url: url('localhost'), caFile: file('other.crt'), max: 1 })
    try {
      await assert.rejects(tlsState(db), (err) => /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(String(err.code)) || /certificate|self.signed/i.test(err.message))
    } finally { await db.close() }
  })

  it('файла сертификата нет — служба не запускается', () => {
    assert.throws(() => createDb({ url: url('localhost'), caFile: file('missing.crt') }), (err) => err.code === 'ENOENT')
  })
})
