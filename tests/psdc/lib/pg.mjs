// Временный локальный PostgreSQL для тестов ПСДЦ.
//
// Поднимает одноразовый кластер во временной папке, применяет заглушки Supabase
// и настоящие миграции проекта, выполняет SQL через psql. Боевая база не
// затрагивается. Путь к бинарникам — PG_BIN, иначе ищем в PATH.
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

export function pgAvailable() {
  return !!(findBin('initdb') && findBin('pg_ctl') && findBin('psql'))
}

export class TestDatabase {
  constructor() {
    this.port = 55000 + Math.floor(Math.random() * 5000)
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdc-pg-'))
    this.data = path.join(this.dir, 'data')
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
    this.run('initdb', ['-D', this.data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8',
      '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--no-instructions'])
    this.ctl(['-D', this.data, '-l', path.join(this.dir, 'server.log'), '-w',
      '-o', `-p ${this.port} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=40`, 'start'])
    this.run('psql', this.args('postgres'), 'CREATE DATABASE psdc_test;')
  }

  stop() {
    try { this.ctl(['-D', this.data, '-m', 'immediate', '-w', 'stop']) } catch { /* уже остановлен */ }
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
    // Повторный прогон миграций не должен падать (миграции идемпотентны).
    db.applyFile(path.join(ROOT, 'supabase', 'migrations', '20260908_psdc.sql'))
  } catch (e) {
    db.stop()
    throw e
  }
  return db
}
