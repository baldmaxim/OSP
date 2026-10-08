// Проверка разделения транспорта (Р3, migration/PLAN.md): весь доступ к серверу — только
// через адаптеры src/api/. Ищет в src/ вне src/api/ прямой клиент Supabase и его методы.
// Запуск: npm run check:transport. Выход 0 — нарушений нет, 1 — список нарушений.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const API = path.join(SRC, 'api')

const RULES = [
  [/['"]@supabase\//, 'импорт @supabase/* — только в src/api/'],
  [/['"][^'"]*api\/supabaseClient(\.js)?['"]/, 'импорт клиента Supabase — только в src/api/'],
  [/\bcreateClient\s*\(/, 'создание клиента — только в src/api/supabaseClient.js'],
  [/\bsupabase\b/, 'прямое обращение к клиенту supabase — используйте адаптеры src/api'],
  [/\.channel\s*\(/, 'Realtime напрямую — используйте subscribeTable из src/api'],
  [/\.storage\s*\.\s*from\s*\(/, 'Storage напрямую — используйте objectPhotos из src/api'],
  [/\.functions\s*\.\s*invoke\s*\(/, 'функции напрямую — используйте invokeFunction из src/api'],
]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (p !== API) walk(p, out) }
    else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) out.push(p)
  }
  return out
}

// Комментарии не считаем: блочные вырезаются с сохранением переводов строк, строчные —
// только если // стоит в начале строки или после пробела (адреса вида https:// не задеты).
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

const problems = []
for (const file of walk(SRC)) {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    for (const [re, why] of RULES) {
      if (re.test(line)) problems.push(`${path.relative(ROOT, file)}:${i + 1} — ${why}`)
    }
  })
}

if (problems.length) {
  console.log(`Нарушений разделения транспорта: ${problems.length}`)
  for (const p of problems) console.log('  ' + p)
  process.exitCode = 1
} else {
  console.log('Разделение транспорта: нарушений нет (доступ к серверу только через src/api/).')
}
