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

export const readExpected = () => expected(JSON.parse(fs.readFileSync(BASELINE, 'utf8')),
  fs.existsSync(FIXES) ? JSON.parse(fs.readFileSync(FIXES, 'utf8')) : [])
