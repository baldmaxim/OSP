// Общее для замеров прав (tests/db): классы пользователей и ожидание «эталон + утверждённые исправления».
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './stand.mjs'

export const BASELINE_DIR = path.join(ROOT, 'tests', 'db', 'baseline')
export const BASELINE = path.join(BASELINE_DIR, 'rights.json')
export const FIXES = path.join(BASELINE_DIR, 'approved-fixes.json')
export const CLASSES = ['admin', 'employee_full', 'employee_none', 'vors_only', 'contractor_own', 'contractor_noorg',
  'unapproved', 'blocked', 'no_user_roles', 'anon', 'service_role']

// Ожидание = эталон + утверждённые исправления Р2.
export function expected(baseline, fixes) {
  const exp = structuredClone(baseline)
  for (const f of fixes) {
    // to: null — функция анониму больше не выдана и из замера исчезает.
    if (f.table === '*functions*') {
      if (f.to === null) delete exp.anon_functions[f.action]; else exp.anon_functions[f.action] = f.to
      continue
    }
    if (f.table === '*self_promote*') { exp.self_promote[f.class] = f.to; continue }
    ;(exp.classes[f.class][f.table] ??= {})[f.action] = f.to  // новая таблица — добавить запись
  }
  return exp
}

// Миграции-кандидаты: ещё не применены на проде (baseline/candidate-migrations.txt).
export const candidateMigrations = () => fs.readFileSync(path.join(BASELINE_DIR, 'candidate-migrations.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

// withCandidates: false — ожидание для копии прода БЕЗ миграций-кандидатов. Исправление, которое вносит
// кандидат, помечено полем candidate (имя файла миграции) и пропускается, пока файл в списке кандидатов:
// в копии прода его действия ещё нет. Так сравнивает замер под одной учёткой — кандидаты туда не
// накатываются. Миграцию применили на проде и убрали из списка — исправление снова учитывается.
export const readExpected = ({ withCandidates = true } = {}) => {
  let fixes = fs.existsSync(FIXES) ? JSON.parse(fs.readFileSync(FIXES, 'utf8')) : []
  if (!withCandidates) {
    const pending = new Set(candidateMigrations())
    fixes = fixes.filter((f) => !pending.has(f.candidate))
  }
  return expected(JSON.parse(fs.readFileSync(BASELINE, 'utf8')), fixes)
}
