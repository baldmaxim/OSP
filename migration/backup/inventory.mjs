// Опись Supabase против списка «переносится / не переносится» (inventory-rules.txt) и выгрузки копии.
// Копия годна, только если:
//   • у каждой непустой таблицы описи есть решение в списке (неизвестная — стоп, а не «наверное, не нужна»);
//   • в выгрузках учёток, способов входа и обложек ровно столько записей, сколько строк в описи — оба
//     числа сняты в одной транзакции (extras.sql), расхождение значит недописанный или чужой файл.
// В вывод — только имена таблиц и числа.
//
//   node migration/backup/inventory.mjs check migration/dumps/prod-<время>
// Выход: 0 — годно; 1 — ошибка запуска; 4 — есть FAIL.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RULES_FILE = path.join(HERE, 'inventory-rules.txt')

// Выгрузки копии: суффикс файла и строка описи, с которой сверяется число записей.
export const EXPORTS = [
  { suffix: '.auth-users.csv', table: 'auth.users', title: 'учётные записи' },
  { suffix: '.auth-identities.csv', table: 'auth.identities', title: 'способы входа' },
  { suffix: '.covers.csv', table: 'storage.objects[object-photos]', title: 'обложки объектов' },
]

const NAME_RE = /^[a-z_][a-z0-9_]*\.(?:\*|[a-z_][a-z0-9_$]*(?:\[[^\]\s]*\])?)$/

export function parseRules(text) {
  const rules = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(transfer|skip)\s+(\S.*)$/)
    if (!m || !NAME_RE.test(m[1])) throw new Error(`inventory-rules.txt, строка ${i + 1}: не похожа на «<имя> transfer|skip <причина>»`)
    if (rules.some((r) => r.name === m[1])) throw new Error(`inventory-rules.txt: ${m[1]} указана дважды`)
    rules.push({ name: m[1], decision: m[2], reason: m[3] })
  }
  return rules
}

// Точное имя важнее «схема.*».
export function ruleFor(name, rules) {
  const exact = rules.find((r) => r.name === name)
  if (exact) return exact
  const schema = name.split('.')[0]
  return rules.find((r) => r.name === `${schema}.*`) || null
}

export function parseInventory(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const [name, n, extra] = line.split('\t')
    if (extra !== undefined || !name || !/^-?\d+$/.test(n ?? '')) throw new Error('опись повреждена: строка не «имя<TAB>число»')
    rows.push({ name, n: Number(n) })
  }
  return rows
}

// Число записей CSV без заголовка; переводы строк внутри кавычек записи не делят.
export function countCsvRecords(text) {
  let records = 0
  let inQuotes = false
  let lineHasData = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { inQuotes = !inQuotes; lineHasData = true; continue }
    if (ch === '\n' && !inQuotes) {
      if (lineHasData) records++
      lineHasData = false
      continue
    }
    lineHasData = true
  }
  if (inQuotes) throw new Error('CSV оборван: незакрытые кавычки')
  if (lineHasData) records++
  return Math.max(0, records - 1)
}

export function checkCopy({ inventoryText, rulesText, exportTexts }) {
  const rules = parseRules(rulesText)
  const rows = parseInventory(inventoryText)
  const lines = []
  let failed = 0
  const counts = new Map(rows.map((r) => [r.name, r.n]))
  for (const row of rows) {
    const rule = ruleFor(row.name, rules)
    if (!rule) {
      if (row.n === 0) continue
      failed++
      lines.push(`FAIL ${row.name}: ${row.n < 0 ? 'нет права чтения' : `строк ${row.n}`} — нет в описи: решить, переносится ли, и дописать migration/backup/inventory-rules.txt`)
      continue
    }
    if (row.n === 0 || row.name.startsWith('public.')) continue
    if (row.n < 0 && rule.decision === 'transfer') {
      failed++
      lines.push(`FAIL ${row.name}: нет права чтения, а таблица переносится`)
      continue
    }
    lines.push(`${rule.decision === 'transfer' ? 'OK переносится' : 'OK не переносится'} ${row.name}: ${row.n < 0 ? 'нет права чтения' : `строк ${row.n}`} — ${rule.reason}`)
  }
  const publicRows = rows.filter((r) => r.name.startsWith('public.'))
  lines.push(`OK переносится public: таблиц ${publicRows.length}, строк ${publicRows.reduce((s, r) => s + Math.max(r.n, 0), 0)} — копия pg_dump, сверка по таблицам выше`)
  for (const exp of EXPORTS) {
    const text = exportTexts[exp.suffix]
    if (text === undefined) {
      failed++
      lines.push(`FAIL ${exp.title}: нет файла выгрузки ${exp.suffix}`)
      continue
    }
    const records = countCsvRecords(text)
    const expected = counts.get(exp.table) ?? 0
    if (records === expected) lines.push(`OK ${exp.title}: в выгрузке ${records}, в описи ${expected}`)
    else { failed++; lines.push(`FAIL ${exp.title}: в выгрузке ${records}, в описи ${expected} — файл недописан или от другой копии`) }
  }
  return { ok: failed === 0, failed, lines }
}

function main(argv) {
  const [cmd, base] = argv
  if (cmd !== 'check' || !base) {
    console.error('Использование: node migration/backup/inventory.mjs check migration/dumps/prod-<время>')
    return 1
  }
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined)
  const inventoryText = read(`${base}.inventory.tsv`)
  if (inventoryText === undefined) {
    console.log('FAIL нет описи Supabase (.inventory.tsv) — копия снята не нынешним backup.sh')
    return 4
  }
  const exportTexts = Object.fromEntries(EXPORTS.map((e) => [e.suffix, read(`${base}${e.suffix}`)]))
  let res
  try {
    res = checkCopy({ inventoryText, rulesText: fs.readFileSync(RULES_FILE, 'utf8'), exportTexts })
  } catch (err) {
    console.log(`FAIL ${err.message}`)
    return 4
  }
  for (const line of res.lines) console.log(line)
  return res.ok ? 0 : 4
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
