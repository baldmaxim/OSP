// Проверки миграций (migration/backup/checks/<дата>.sql) по ним restore-copy.sh решает, применена ли миграция в
// копии прода: «есть FAIL» — накатить. Поэтому до своей миграции проверка обязана отвечать FAIL, а не падать с
// ошибкой (иначе restore-copy.sh, test:db и сборка списка шлюза встают — так было 16.10 с Р2g после 20261016).
// На слепке схемы прода с миграциями после него: каждая проверка миграции-кандидата до применения — строки
// OK/FAIL и хотя бы один FAIL, после применения — только OK.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from './lib/stand.mjs'
import { candidateMigrations } from './lib/rights.mjs'

const CHECKS = path.join(ROOT, 'migration', 'backup', 'checks')
const checkOf = (m) => path.join(CHECKS, `${m.split('_')[0]}.sql`)
const skip = skipReason()

describe('Проверки миграций-кандидатов: до миграции FAIL, а не ошибка', { skip, timeout: 600000 }, () => {
  let db
  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
  })
  after(() => db?.stop())

  it('у каждого кандидата: до применения — FAIL без ошибки, после — только OK', () => {
    const candidates = candidateMigrations().filter((m) => !m.includes('/') && fs.existsSync(checkOf(m)))
    assert.ok(candidates.length > 0)
    for (const m of candidates) {
      let before
      assert.doesNotThrow(() => { before = psqlAt(db.port, null, { file: checkOf(m) }) }, `${m}: проверка до миграции падает с ошибкой`)
      const lines = before.split('\n').filter(Boolean)
      assert.ok(lines.every((l) => /^(OK|FAIL) /.test(l)), `${m}: не OK/FAIL — ${lines.join(' | ')}`)
      assert.match(before, /^FAIL /m, `${m}: до миграции проверка не видит, что её нет`)
    }
    for (const m of candidates) {
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
      const out = psqlAt(db.port, null, { file: checkOf(m) })
      assert.doesNotMatch(out, /^FAIL/m, `${m}: после миграции — ${out}`)
    }
  })
})
