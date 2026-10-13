// Сравнение двух снимков кластера (sql/neighbors.sql): пострадало ли что-то рядом с базой портала.
// Модуль чистый — проверяется в tests/backup/target-neighbors.test.mjs. Имён в выводе нет: только счётчики.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// Уменьшение чужой базы считаем заметным, если ушло больше десятой части и больше 16 МБ:
// меньшие колебания — обычная работа (очистка, сжатие).
const SHRINK_SHARE = 0.10
const SHRINK_BYTES = 16 * 1024 * 1024

export function parseSnapshot(text) {
  const snap = { dbs: new Map(), roles: null, conn: null }
  for (const line of String(text).split('\n')) {
    const f = line.split('\t')
    if (f[0] === 'db') snap.dbs.set(f[2], { name: f[1], owner: f[3], size: f[4] === '' ? null : Number(f[4]), ours: f[5] === '1' })
    else if (f[0] === 'roles') snap.roles = { count: Number(f[1]), hash: f[2] }
    else if (f[0] === 'conn') snap.conn = { limit: Number(f[1]), total: Number(f[2]), ours: Number(f[3]) }
  }
  if (!snap.dbs.size || !snap.roles || !snap.conn) throw new Error('снимок кластера неполный')
  return snap
}

export function compareSnapshots(before, after) {
  const lines = []
  let missing = 0, owner = 0, renamed = 0, shrunk = 0, added = 0
  for (const [oid, b] of before.dbs) {
    const a = after.dbs.get(oid)
    if (!a) { if (!b.ours) missing += 1; else lines.push('FAIL база портала из снимка не найдена'); continue }
    if (a.owner !== b.owner) owner += 1
    if (a.name !== b.name) renamed += 1
    if (!b.ours && b.size != null && a.size != null && b.size - a.size > SHRINK_BYTES && (b.size - a.size) / b.size > SHRINK_SHARE) shrunk += 1
  }
  for (const oid of after.dbs.keys()) if (!before.dbs.has(oid)) added += 1
  const neighbours = [...before.dbs.values()].filter((d) => !d.ours).length
  lines.push(`${missing ? 'FAIL' : 'OK'} соседних баз в снимке: ${neighbours}; пропавших — ${missing}`)
  lines.push(`${owner || renamed ? 'FAIL' : 'OK'} сменивших владельца — ${owner}, переименованных — ${renamed}`)
  lines.push(`${shrunk ? 'ВНИМАНИЕ' : 'OK'} соседних баз, заметно уменьшившихся в размере, — ${shrunk}`)
  if (added) lines.push(`ИНФО новых баз в кластере — ${added}`)
  lines.push(before.roles.hash === after.roles.hash ? `OK учётки кластера без изменений: ${after.roles.count}`
    : `ВНИМАНИЕ состав учёток кластера изменился: было ${before.roles.count}, стало ${after.roles.count}`)
  const limit = after.conn.limit
  const budget = limit > 0 ? `${after.conn.total} из ${limit}` : `${after.conn.total} (лимит не задан)`
  const tight = limit > 0 && after.conn.total > limit * 0.7
  lines.push(`${tight ? 'ВНИМАНИЕ' : 'OK'} подключений общей учётки сейчас: ${budget}; из них к базе портала — ${after.conn.ours}`)
  return { lines, failed: lines.some((l) => l.startsWith('FAIL')), warned: lines.some((l) => l.startsWith('ВНИМАНИЕ')) }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [beforeFile, afterFile] = process.argv.slice(2)
  const result = compareSnapshots(parseSnapshot(fs.readFileSync(beforeFile, 'utf8')), parseSnapshot(fs.readFileSync(afterFile, 'utf8')))
  console.log(result.lines.join('\n'))
  process.exit(result.failed ? 3 : 0)
}
