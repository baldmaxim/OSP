// Список разрешённого для шлюза данных osp-api (/api/db) — server/osp-api/src/data/allow.json.
//
// В базе Яндекса одна учётка: «кому какие таблицы, действия и функции можно вообще» там выдачей прав
// не выразить. Этот список переносит выдачу прав прода как есть: что на проде выдано анониму и
// вошедшему (GRANT), то и пропускает шлюз; остального для него не существует. Строки по-прежнему
// делит база (правила по строкам, migration/target/sql/load-single-owner.sql).
//
// Берётся с последней проверенной копии прода, поднятой с правами как на проде
// (migration/backup/restore-copy.sh). Запуск: node scripts/build-db-allow.mjs [--check]
//   --check — ничего не писать, выйти с кодом 1, если файл в репозитории отличается (для теста).
// В файле только имена таблиц, представлений и функций.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, latestVerifiedCopy, startCopy, psqlAt } from '../tests/db/lib/stand.mjs'

const OUT = path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')
const ROLES = ['anon', 'authenticated']

export function readGrants(port) {
  const actions = (role) => `(select coalesce(json_agg(p order by p), '[]'::json)
    from unnest(array['delete', 'insert', 'select', 'update']) p where has_table_privilege('${role}', c.oid, p))`
  // Таблицы и представления public. Материализованные представления не включаются: правил по строкам у
  // них нет, в базе Яндекса они лежат в закрытой схеме.
  const tables = JSON.parse(psqlAt(port, `
    select coalesce(json_object_agg(c.relname, json_build_object(
      'kind', case c.relkind when 'v' then 'view' else 'table' end,
      ${ROLES.map((r) => `'${r}', ${actions(r)}`).join(', ')}) order by c.relname), '{}'::json)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') and not c.relispartition`))
  // Функции, которые можно вызвать напрямую: не триггерные, не из расширений. Имя — одно на все
  // перегрузки: если у перегрузок права разные, список собрать нельзя.
  const functions = JSON.parse(psqlAt(port, `
    select coalesce(json_agg(json_build_object('name', p.proname,
      ${ROLES.map((r) => `'${r}', has_function_privilege('${r}', p.oid, 'EXECUTE')`).join(', ')}) order by p.proname, p.oid), '[]'::json)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`))
  return { tables, functions }
}

export function buildAllow({ tables, functions }) {
  const allow = { tables: {}, rpc: {} }
  for (const [name, t] of Object.entries(tables)) {
    const entry = {}
    // Аноним — только чтение: записи без входа портал не делает, и правил записи для анонима в базе нет.
    const anon = t.anon.filter((a) => a === 'select')
    if (anon.length) entry.anon = anon
    if (t.authenticated.length) entry.authenticated = t.authenticated
    if (Object.keys(entry).length) allow.tables[name] = entry
  }
  const byName = new Map()
  for (const f of functions) {
    const seen = byName.get(f.name)
    if (seen && (seen.anon !== f.anon || seen.authenticated !== f.authenticated)) {
      throw new Error(`у перегрузок функции ${f.name} разные права — по имени их не различить`)
    }
    byName.set(f.name, f)
  }
  for (const f of byName.values()) {
    const roles = ROLES.filter((r) => f[r])
    if (roles.length) allow.rpc[f.name] = roles
  }
  return allow
}

async function main() {
  const check = process.argv.includes('--check')
  const dump = latestVerifiedCopy()
  const db = startCopy(dump)
  let allow
  try {
    allow = buildAllow(readGrants(db.port))
  } finally {
    db.stop()
  }
  const text = JSON.stringify(allow, null, 2) + '\n'
  const count = (role) => Object.values(allow.tables).filter((t) => t[role]).length
  console.log(`Копия: ${path.basename(dump, '.dump')}. Таблиц и представлений: ${Object.keys(allow.tables).length}`
    + ` (анониму на чтение — ${count('anon')}, вошедшему — ${count('authenticated')}); функций: ${Object.keys(allow.rpc).length}`
    + ` (анониму — ${Object.values(allow.rpc).filter((r) => r.includes('anon')).length})`)
  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (current !== text) { console.error('allow.json отличается от прав на копии прода: node scripts/build-db-allow.mjs'); process.exit(1) }
    console.log('allow.json совпадает с правами на копии прода')
    return
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, text)
  console.log(`Записано: ${path.relative(ROOT, OUT)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main()
}
