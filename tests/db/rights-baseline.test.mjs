// «Отпечаток» прав (основа Р2): кто что может сейчас на копии прода. Для каждого класса
// пользователей (администратор, сотрудник с разделами и без, подрядчик, неодобренный,
// заблокированный, аноним …) и каждой таблицы — видит ли он все / часть / ни одной строки и
// может ли вставить, изменить, удалить строку. Действия — в откатываемых транзакциях во
// временной базе (tests/db/fingerprint.sql), в файл и вывод — только эти признаки.
//
// Эталон — tests/db/baseline/rights.json (текущее поведение, ВКЛЮЧАЯ дыры).
//   UPDATE_BASELINE=1 npm run test:db   — снять эталон заново (после новой копии прода);
//   npm run test:db                     — сравнить с эталоном.
// Р2 меняет ожидания только через tests/db/baseline/approved-fixes.json: каждая строка —
// класс, таблица, действие, новое значение и причина. Любое другое расхождение — ошибка:
// закрываем дыры, не задевая законных пользователей.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, latestVerifiedCopy, startCopy, psqlAt } from './lib/stand.mjs'
import { SECTIONS } from '../../src/contexts/roleConstants.js'

const BASELINE_DIR = path.join(ROOT, 'tests', 'db', 'baseline')
const BASELINE = path.join(BASELINE_DIR, 'rights.json')
const FIXES = path.join(BASELINE_DIR, 'approved-fixes.json')
const CANDIDATES = fs.readFileSync(path.join(BASELINE_DIR, 'candidate-migrations.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
const UPDATE = process.env.UPDATE_BASELINE === '1'
const CLASSES = ['admin', 'employee_full', 'employee_none', 'vors_only', 'contractor_own', 'contractor_noorg',
  'unapproved', 'blocked', 'no_user_roles', 'anon', 'service_role']

const skip = skipReason({ needCopy: true })

// Ожидание = эталон + утверждённые исправления Р2.
function expected(baseline, fixes) {
  const exp = structuredClone(baseline)
  for (const f of fixes) {
    if (f.table === '*functions*') { exp.anon_functions[f.action] = f.to; continue }
    if (f.table === '*self_promote*') { exp.self_promote[f.class] = f.to; continue }
    ;(exp.classes[f.class][f.table] ??= {})[f.action] = f.to  // новая таблица — добавить запись
  }
  return exp
}

function diff(exp, act) {
  const out = []
  for (const c of CLASSES) {
    const tables = new Set([...Object.keys(exp.classes[c] || {}), ...Object.keys(act.classes[c] || {})])
    for (const t of [...tables].sort()) {
      const e = exp.classes[c]?.[t] || {}
      const a = act.classes[c]?.[t] || {}
      for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
        if (e[k] !== a[k]) out.push(`${c} / ${t} / ${k}: ожидалось ${e[k] ?? '—'}, стало ${a[k] ?? '—'}`)
      }
    }
  }
  for (const c of new Set([...Object.keys(exp.self_promote || {}), ...Object.keys(act.self_promote || {})])) {
    if (exp.self_promote?.[c] !== act.self_promote?.[c]) {
      out.push(`${c} / самоповышение до администратора: ожидалось ${exp.self_promote?.[c] ?? '—'}, стало ${act.self_promote?.[c] ?? '—'}`)
    }
  }
  for (const fn of new Set([...Object.keys(exp.anon_functions), ...Object.keys(act.anon_functions)])) {
    if (exp.anon_functions[fn] !== act.anon_functions[fn]) {
      out.push(`anon / функция ${fn}: ожидалось ${exp.anon_functions[fn] ?? '—'}, стало ${act.anon_functions[fn] ?? '—'}`)
    }
  }
  return out
}

describe('Права на копии прода: отпечаток против эталона', { skip, timeout: 30 * 60 * 1000 }, () => {
  let db
  let actual
  before(() => {
    // Эталон снимается только с прода как есть — без миграций-кандидатов.
    if (UPDATE && CANDIDATES.length) throw new Error('UPDATE_BASELINE=1 при непустом candidate-migrations.txt')
    const dump = latestVerifiedCopy()
    db = startCopy(dump)
    // Кандидат — имя миграции из supabase/migrations или путь от корня (например, SQL отката).
    for (const m of CANDIDATES) psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    psqlAt(db.port, null, { file: path.join(ROOT, 'tests', 'db', 'fingerprint.sql') })
    const sections = Object.keys(SECTIONS).map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
    psqlAt(db.port, `select osp_test.setup(array[${sections}]::text[])`)
    actual = { copy: path.basename(dump, '.dump'), candidates: CANDIDATES, classes: {}, anon_functions: {} }
    for (const c of CLASSES) actual.classes[c] = JSON.parse(psqlAt(db.port, `select osp_test.fingerprint('${c}')::text`))
    actual.anon_functions = JSON.parse(psqlAt(db.port, 'select osp_test.anon_functions()::text'))
    actual.self_promote = {}
    for (const c of CLASSES) {
      const r = psqlAt(db.port, `select osp_test.self_promote('${c}')`)
      if (r !== 'n/a') actual.self_promote[c] = r
    }
  })
  after(() => db?.stop())

  it('совпадает с эталоном с учётом утверждённых исправлений', () => {
    // ACTUAL_OUT=<файл> — сохранить фактический отпечаток (для разбора и составления approved-fixes).
    if (process.env.ACTUAL_OUT) fs.writeFileSync(process.env.ACTUAL_OUT, JSON.stringify(actual, null, 2) + '\n')
    if (UPDATE || !fs.existsSync(BASELINE)) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true })
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n')
      if (!fs.existsSync(FIXES)) fs.writeFileSync(FIXES, '[]\n')
      return
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    const fixes = fs.existsSync(FIXES) ? JSON.parse(fs.readFileSync(FIXES, 'utf8')) : []
    const problems = diff(expected(baseline, fixes), actual)
    assert.deepEqual(problems, [], `Права изменились вне утверждённого списка:\n${problems.join('\n')}`)
  })

  it('инварианты, которые должны держаться всегда — и до Р2, и после', () => {
    const c = actual.classes
    // Аноним: ничего из договоров и реестра расценок, витрина — только часть тендеров.
    assert.notEqual(c.anon.tenders.select, 'all')
    assert.equal(c.anon.contracts.select, 'none')
    assert.equal(c.anon.kp_rates_registry_mv.select, 'err:42501')
    // Администратор видит всё рабочее.
    assert.equal(c.admin.tenders.select, 'all')
    assert.equal(c.admin.contracts.select, 'all')
    // Удалить пользователя аноним не может.
    assert.equal(actual.anon_functions.admin_delete_user, 'err:P0001')
  })
})
