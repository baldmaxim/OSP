// Временные базы для test:db: слепок схемы прода (без данных) и восстановленная копия прода.
// Обе — одноразовые контейнеры Docker; данные копии из контейнера не выходят, тесты читают
// только признаки и счётчики. К Supabase ничего не подключается.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const has = (bin) => spawnSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const dockerOk = () => has('docker') && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0

export function skipReason({ needCopy = false } = {}) {
  if (process.platform === 'win32') return 'test:db запускается на Linux с Docker'
  if (!dockerOk() || !has('psql') || !has('pg_restore')) return 'нужны Docker, psql, pg_restore'
  if (needCopy && !latestVerifiedCopy()) return 'нет проверенной копии прода в migration/dumps (backup.sh + verify.sh)'
  return false
}

// Последняя копия, прошедшая verify.sh (рядом лежит .verified).
export function latestVerifiedCopy() {
  const dir = path.join(ROOT, 'migration', 'dumps')
  if (!fs.existsSync(dir)) return null
  const dumps = fs.readdirSync(dir).filter((f) => /^prod-\d{8}-\d{6}\.dump$/.test(f)
    && fs.existsSync(path.join(dir, f.replace(/\.dump$/, '.verified')))).sort()
  return dumps.length ? path.join(dir, dumps[dumps.length - 1]) : null
}

// Миграции, применённые на проде после слепка (migration/schema/applied-after.txt).
export function appliedAfter() {
  return fs.readFileSync(path.join(ROOT, 'migration', 'schema', 'applied-after.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

export function psqlAt(port, sql, { file } = {}) {
  const args = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SET client_min_messages = warning']
  if (file) args.push('-f', file); else args.push('-c', sql)
  const res = spawnSync('psql', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: '', PGSSLMODE: 'disable' },
  })
  if (res.status !== 0) {
    // Только первая строка ошибки: в DETAIL бывают значения из данных.
    throw new Error((res.stderr || '').split('\n').find((l) => /ERROR/.test(l)) || `psql exit ${res.status}`)
  }
  return res.stdout.trim()
}

// Копия прода с правами как на проде (migration/backup/restore-copy.sh).
export function startCopy(dump) {
  const res = spawnSync('bash', [path.join(ROOT, 'migration', 'backup', 'restore-copy.sh'), dump],
    { encoding: 'utf8', cwd: ROOT, timeout: 15 * 60 * 1000 })
  const port = res.stdout.match(/^PORT=(\d+)$/m)?.[1]
  const container = res.stdout.match(/^CONTAINER=(\S+)$/m)?.[1]
  if (res.status !== 0 || !port) {
    if (container) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    throw new Error(`restore-copy.sh: ${(res.stdout + res.stderr).split('\n').slice(-5).join(' | ')}`)
  }
  return { port: Number(port), stop: () => spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' }) }
}

// Слепок схемы прода без данных: роли Supabase, pg_trgm в public, слепок. Миграции, применённые
// после слепка (appliedAfter), тест накатывает сам — чтобы сначала сверить слепок с файлом.
export function startSnapshot() {
  const port = 51000 + Math.floor(Math.random() * 3000)
  const container = `osp-test-db-${process.pid}-${port}`
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:5432`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'fsync=off'], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`docker run: ${run.stderr}`)
  const stop = () => spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 120000
    for (;;) {
      try { if (psqlAt(port, 'select 1') === '1') break } catch { /* ещё стартует */ }
      if (Date.now() > deadline) throw new Error('PostgreSQL в Docker не поднялся')
      spawnSync('sleep', ['0.5'])
    }
    psqlAt(port, `
      DO $r$ DECLARE r text; BEGIN
        FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','supabase_admin',
                                 'supabase_auth_admin','dashboard_user','supabase_storage_admin','pgbouncer'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
        END LOOP;
      END $r$;
      ALTER ROLE service_role BYPASSRLS;
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`)
    // Схема public в базе уже есть: её создание из слепка пропускаем.
    const snapshot = fs.readFileSync(path.join(ROOT, 'migration', 'schema', 'prod-schema.sql'), 'utf8')
      .split('\n').filter((l) => !/^(CREATE SCHEMA public;|ALTER SCHEMA public OWNER TO|COMMENT ON SCHEMA public IS)/.test(l))
      .join('\n')
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-snap-')), 'schema.sql')
    fs.writeFileSync(tmp, snapshot)
    psqlAt(port, null, { file: tmp })
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    return { port, stop }
  } catch (e) {
    stop()
    throw e
  }
}
