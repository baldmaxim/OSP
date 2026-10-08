// Временный локальный PostgreSQL для тестов ПСДЦ.
//
// Поднимает одноразовый кластер во временной папке, применяет заглушки Supabase
// и настоящие миграции проекта, выполняет SQL через psql. Боевая база не
// затрагивается. Путь к бинарникам — PG_BIN, иначе ищем в PATH.
//
// Если серверных бинарников (initdb, pg_ctl) нет, но есть Docker и клиент psql,
// сервер поднимается одноразовым контейнером (PG_DOCKER_IMAGE, по умолчанию
// postgres:17-alpine) с той же локалью; SQL по-прежнему идёт через локальный psql.
// Режим можно задать явно: PG_TEST_MODE=native | docker.
import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..', '..')

function findBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = []
  if (process.env.PG_BIN) candidates.push(path.join(process.env.PG_BIN, exe))
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe))
  }
  return candidates.find((p) => fs.existsSync(p)) || null
}

const DOCKER_IMAGE = process.env.PG_DOCKER_IMAGE || 'postgres:17-alpine'

function nativeAvailable() {
  return !!(findBin('initdb') && findBin('pg_ctl') && findBin('psql'))
}

let dockerChecked = null
function dockerAvailable() {
  if (dockerChecked === null) {
    const docker = findBin('docker')
    dockerChecked = !!(docker && findBin('psql') &&
      spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0)
  }
  return dockerChecked
}

function pgMode() {
  const forced = process.env.PG_TEST_MODE
  if (forced === 'native') return nativeAvailable() ? 'native' : null
  if (forced === 'docker') return dockerAvailable() ? 'docker' : null
  if (nativeAvailable()) return 'native'
  return dockerAvailable() ? 'docker' : null
}

export function pgAvailable() {
  return pgMode() !== null
}

// Синхронная пауза: start() синхронный, а ждать готовности контейнера нужно.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class TestDatabase {
  constructor() {
    this.mode = pgMode()
    this.port = 55000 + Math.floor(Math.random() * 5000)
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdc-pg-'))
    this.data = path.join(this.dir, 'data')
    this.container = null
    this.env = { ...process.env, PGCLIENTENCODING: 'UTF8', PGPASSWORD: '', LC_MESSAGES: 'C' }
  }

  run(bin, args, input) {
    const res = spawnSync(findBin(bin), args, { env: this.env, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    if (res.status !== 0) {
      throw new Error(`${bin} ${args.join(' ')} failed:\n${res.stderr || res.stdout}`)
    }
    return res.stdout
  }

  // pg_ctl оставляет запущенному серверу унаследованные дескрипторы: с
  // перехваченным выводом синхронный вызов ждал бы закрытия канала вечно.
  ctl(args) {
    const res = spawnSync(findBin('pg_ctl'), args, { env: this.env, stdio: 'ignore' })
    if (res.status !== 0) {
      const log = path.join(this.dir, 'server.log')
      throw new Error(`pg_ctl ${args.join(' ')} failed${fs.existsSync(log) ? `:\n${fs.readFileSync(log, 'utf8')}` : ''}`)
    }
  }

  start() {
    if (this.mode === 'docker') {
      this.startDocker()
    } else {
      this.run('initdb', ['-D', this.data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8',
        '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--no-instructions'])
      this.ctl(['-D', this.data, '-l', path.join(this.dir, 'server.log'), '-w',
        '-o', `-p ${this.port} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=40`, 'start'])
    }
    this.run('psql', this.args('postgres'), 'CREATE DATABASE psdc_test;')
  }

  // Одноразовый контейнер: порт только на 127.0.0.1, вход без пароля (trust) —
  // наружу контейнер не виден, и после stop() удаляется вместе с данными.
  startDocker() {
    this.container = `osp-test-pg-${process.pid}-${this.port}`
    this.run('docker', ['run', '-d', '--rm', '--name', this.container,
      '-p', `127.0.0.1:${this.port}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8',
      DOCKER_IMAGE, '-c', 'fsync=off', '-c', 'max_connections=40'])
    // Образ сначала поднимает временный сервер только на сокете, затем
    // перезапускается на TCP: готов, когда отвечает через проброшенный порт.
    const deadline = Date.now() + 120000
    for (;;) {
      const probe = spawnSync(findBin('psql'), ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'postgres',
        '-d', 'postgres', '-X', '-At', '-c', 'select 1'], { env: this.env, encoding: 'utf8' })
      if (probe.status === 0 && probe.stdout.trim() === '1') return
      if (Date.now() > deadline) {
        const logs = spawnSync(findBin('docker'), ['logs', this.container], { encoding: 'utf8' })
        throw new Error(`PostgreSQL в контейнере не поднялся:\n${logs.stdout}${logs.stderr}`)
      }
      sleepMs(300)
    }
  }

  stop() {
    if (this.mode === 'docker') {
      if (this.container) spawnSync(findBin('docker'), ['rm', '-f', this.container], { stdio: 'ignore' })
    } else {
      try { this.ctl(['-D', this.data, '-m', 'immediate', '-w', 'stop']) } catch { /* уже остановлен */ }
    }
    try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch { /* временная папка */ }
  }

  args(db = 'psdc_test') {
    return ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'postgres', '-d', db,
      '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-']
  }

  // Выполняет SQL суперпользователем, возвращает stdout.
  exec(sql) {
    return this.run('psql', this.args(), sql)
  }

  applyFile(file) {
    return this.exec(fs.readFileSync(file, 'utf8'))
  }

  // Выполняет SQL от имени пользователя приложения (роль authenticated + JWT sub).
  // Результат — последняя непустая строка вывода (обычно JSON).
  asUser(uid, sql) {
    const prefix = `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false) \\g /dev/null\n`
    return lastLine(this.exec(prefix.replace('/dev/null', nullDevice()) + sql))
  }

  // То же, но ошибка SQL возвращается как текст, а не исключение.
  tryAsUser(uid, sql) {
    try {
      return { ok: true, out: this.asUser(uid, sql) }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  // Асинхронный psql — для проверки конкурентных транзакций.
  spawnAsUser(uid, sql) {
    const prefix = `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false) \\g ${nullDevice()}\n`
    return new Promise((resolve) => {
      const child = spawn(findBin('psql'), this.args(), { env: this.env })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => resolve({ ok: code === 0, out: lastLine(out), error: err }))
      child.stdin.end(prefix + sql)
    })
  }
}

function nullDevice() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

function lastLine(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.length ? lines[lines.length - 1] : ''
}

// Строковый литерал SQL с долларовыми кавычками.
export function sqlJson(value) {
  const text = JSON.stringify(value)
  let tag = 'j'
  while (text.includes(`$${tag}$`)) tag += 'j'
  return `$${tag}$${text}$${tag}$::jsonb`
}

export function setupDatabase() {
  const db = new TestDatabase()
  try {
    db.start()
    db.applyFile(path.join(HERE, '..', 'fixtures', 'bootstrap.sql'))
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260906_contract_amendments.sql'))
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260908_psdc.sql'))
    // ПСДЦ у завершённых документов разрешена, колонки Larix и импорта.
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260929_contracts_fixes.sql'))
    // Повторный прогон миграций не должен падать (миграции идемпотентны).
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260908_psdc.sql'))
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260929_contracts_fixes.sql'))
  } catch (e) {
    db.stop()
    throw e
  }
  return db
}
