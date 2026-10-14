// Каждая миграция базы нового портала (migration/yandex) применяется на копии прода, загруженной так же,
// как база Яндекса (load.sh --single-owner + rights.sh), — до того, как её запустят на сервере:
//   • все новые миграции проходят migrate.sh --yes (правила под одну учётку, проверки миграций);
//   • повтор ничего не делает; проверка прав после — без замечаний.
// Нужны Docker, psql, pg_dump, pg_restore и проверенная копия прода (migration/dumps, вне git).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from './lib/stand.mjs'

const skip = skipReason({ needCopy: true })
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migration', 'yandex')).filter((f) => /^\d{8}_[a-z0-9_]+\.sql$/.test(f)).sort()

describe('Миграции базы нового портала на копии прода под одной учёткой', { skip, timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const migrate = (mode) => {
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, mode], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    return { ...res, all: res.stdout + res.stderr }
  }
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-yandex-mig-'))
    db = startSingleOwner(latestVerifiedCopy())
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it(`применяются все (${MIGRATIONS.length}), повтор ничего не делает, права после — в порядке`, () => {
    assert.ok(MIGRATIONS.length > 0, 'в migration/yandex есть миграции')
    const res = migrate('--yes')
    assert.equal(res.status, 0, res.all)
    for (const f of MIGRATIONS) assert.match(res.stdout, new RegExp(`OK ${f.replace(/\.sql$/, '')}: применена`), f)
    assert.ok(!/^FAIL|^ {2}FAIL/m.test(res.stdout), res.stdout)
    const again = migrate('--yes')
    assert.equal(again.status, 0, again.all)
    assert.match(again.stdout, /новых миграций нет/)
    const check = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'rights.sh'), db.envFile, '--check'], {
      encoding: 'utf8', cwd: ROOT, env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports') } })
    assert.equal(check.status, 0, check.stdout + check.stderr)
  })
})
