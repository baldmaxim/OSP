// Учётка базы у osp-api одна — владелец: менять структуру она может. Поэтому в коде сервера
// (docs/API_RULES.md, «Принятое исключение из правила 4»):
//   • нет команд изменения структуры и прав — миграции выполняются отдельной командой, не из API;
//   • драйвер базы подключён в одном месте — обёртке транзакции (src/lib/db.js): другого пути к базе нет;
//   • роль и «кто вошёл» выставляет только обёртка.
// Проверка — по исходникам: набор не требует ни базы, ни зависимостей.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'server', 'osp-api', 'src')
const DB_WRAPPER = path.join('lib', 'db.js')

function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? sources(full) : /\.(js|mjs|ts)$/.test(e.name) ? [full] : []
  })
}
// Код без комментариев: в комментариях команды упоминать можно.
const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
const rel = (file) => path.relative(SRC, file)

const DDL = [
  /\b(create|alter|drop)\s+(or\s+replace\s+)?(table|index|unique\s+index|view|materialized|schema|function|procedure|policy|role|user|extension|type|sequence|trigger|database|domain|rule)\b/i,
  /\btruncate\s+(table\s+)?[a-z_"]/i,
  /\b(grant|revoke)\s+[a-z_, ]+\s+on\s/i,
  /\balter\s+default\s+privileges\b/i,
  /\b(reindex|vacuum|cluster)\s+(table|index|full|\()/i,
  /\bcomment\s+on\s+(table|column|function|view|schema)\b/i,
  /\bsecurity\s+definer\b/i,
]
const SESSION = [/\bset\s+(local\s+|session\s+)?role\b/i, /\breset\s+role\b/i, /\bset\s+session\s+authorization\b/i, /set_config\(\s*'role'/i, /request\.jwt\.claim/i]

describe('osp-api: в коде сервера нет команд изменения структуры, путь к базе один', () => {
  const files = sources()

  it('исходники найдены', () => {
    assert.ok(files.length >= 8, `файлов: ${files.length}`)
    assert.ok(files.some((f) => rel(f) === DB_WRAPPER), 'обёртка транзакции на месте')
  })

  it('нет команд изменения структуры и прав', () => {
    const found = []
    for (const file of files) {
      const text = code(file)
      for (const re of DDL) {
        const m = text.match(re)
        if (m) found.push(`${rel(file)}: «${m[0].replace(/\s+/g, ' ')}»`)
      }
    }
    assert.deepEqual(found, [], 'миграции выполняются отдельной командой, не из API')
  })

  it('драйвер базы подключён только в обёртке транзакции', () => {
    const importers = files.filter((f) => /from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)|import\(\s*['"]pg['"]\s*\)/.test(code(f))).map(rel)
    assert.deepEqual(importers, [DB_WRAPPER])
  })

  it('роль и «кто вошёл» выставляет только обёртка транзакции', () => {
    const found = []
    for (const file of files) {
      if (rel(file) === DB_WRAPPER) continue
      const text = code(file)
      for (const re of SESSION) {
        const m = text.match(re)
        if (m) found.push(`${rel(file)}: «${m[0]}»`)
      }
    }
    assert.deepEqual(found, [])
  })

  it('проверка ловит то, что должна: примеры запрещённого', () => {
    const bad = ['drop table public.contracts', 'ALTER TABLE x ADD COLUMN y int', 'create or replace function f()', 'truncate public.tenders',
      'grant select on public.t to anon', 'alter default privileges revoke execute', 'CREATE POLICY p ON t', 'vacuum full', 'security definer']
    for (const sql of bad) assert.ok(DDL.some((re) => re.test(sql)), `не поймано: ${sql}`)
    const fine = ['select id from public.contracts where created_at > $1', 'insert into public.tasks (title) values ($1)',
      'update public.tenders set status = $1 where id = $2', 'delete from public.task_comments where id = $1', 'select public.osp_can($1, $2)']
    for (const sql of fine) assert.ok(!DDL.some((re) => re.test(sql)), `ложное срабатывание: ${sql}`)
  })
})
