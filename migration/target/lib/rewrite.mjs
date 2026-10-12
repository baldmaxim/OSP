// Подготовка копии прода (pg_dump -Fc схемы public из Supabase) к загрузке в базу без Supabase.
//
// Данные, таблицы, функции, индексы и ограничения загружаются как есть — их SQL не правится вовсе.
// Правятся только записи о правах, и только по строгим правилам:
//   • роль Supabase authenticated → роль приложения (osp_runtime) — в политиках и выдаче прав;
//   • anon, service_role и служебные роли Supabase — не переносятся (публичная витрина и функции
//     Supabase заменяются отдельно), каждая пропущенная запись попадает в отчёт;
//   • права по умолчанию Supabase («новая таблица открыта всем ролям») — не переносятся;
//   • незнакомый вид записи, незнакомая роль или строка, не похожая на известную форму, — отказ:
//     лучше не загрузить ничего, чем загрузить не то.
//
// Запуск (его делает migration/target/load.sh):
//   node rewrite.mjs split <оглавление pg_restore --list> <основное.list> <права.list> <отчёт.json>
//   node rewrite.mjs acl   <права.sql> <права.готово.sql> <отчёт.json> <роль приложения>
// Модуль чистый — проверяется в tests/backup/target-load.test.mjs.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// Виды записей оглавления (длинные — первыми: «TABLE DATA» раньше «TABLE»).
export const KNOWN_TYPES = [
  'MATERIALIZED VIEW DATA', 'MATERIALIZED VIEW', 'SEQUENCE OWNED BY', 'SEQUENCE SET', 'SEQUENCE',
  'TABLE DATA', 'TABLE', 'FK CONSTRAINT', 'CONSTRAINT', 'ROW SECURITY', 'DEFAULT ACL', 'DEFAULT',
  'FUNCTION', 'TRIGGER', 'COMMENT', 'POLICY', 'INDEX', 'SCHEMA', 'TYPE', 'VIEW', 'ACL',
]
const ACL_TYPES = new Set(['POLICY', 'ACL'])

// Роли Supabase в копии: во что превращаются.
export const ROLE_RULES = {
  authenticated: 'runtime', // → роль приложения
  anon: 'drop',
  service_role: 'drop',
  postgres: 'drop', // владелец в Supabase; в новой базе владелец и так владеет всем
  supabase_admin: 'drop',
  dashboard_user: 'drop',
  supabase_auth_admin: 'drop',
  supabase_storage_admin: 'drop',
}

class RewriteError extends Error {}
const fail = (message) => { throw new RewriteError(message) }

// Оглавление → два списка для pg_restore -L. Строка записи:
//   «2315; 1259 17290 TABLE public tenders postgres». Строки с «;» в начале — комментарии.
export function splitToc(toc) {
  const main = []
  const acl = []
  const report = { entries: 0, byType: {}, skipped: { schemaPublic: 0, defaultAcl: 0 } }
  for (const line of toc.split('\n')) {
    if (!line.trim() || line.startsWith(';')) continue
    const m = /^\d+; \d+ \d+ (.*)$/.exec(line)
    if (!m) fail(`оглавление: непонятная строка «${line.slice(0, 80)}»`)
    const type = KNOWN_TYPES.find((t) => m[1] === t || m[1].startsWith(`${t} `))
    if (!type) fail(`оглавление: незнакомый вид записи «${m[1].slice(0, 60)}»`)
    const rest = m[1].slice(type.length).trim()
    report.entries += 1
    report.byType[type] = (report.byType[type] || 0) + 1
    // Схема public в новой базе уже есть: ни её создание, ни комментарий к ней не переносим.
    if ((type === 'SCHEMA' && /^- public /.test(rest)) || (type === 'COMMENT' && /^- SCHEMA public /.test(rest))) {
      report.skipped.schemaPublic += 1
      continue
    }
    if (type === 'SCHEMA') fail(`оглавление: неожиданная схема «${rest.slice(0, 60)}»`)
    if (type === 'DEFAULT ACL') { report.skipped.defaultAcl += 1; continue }
    ;(ACL_TYPES.has(type) ? acl : main).push(line)
  }
  return { main: main.join('\n') + '\n', acl: acl.join('\n') + '\n', report }
}

// Идентификатор SQL с начала строки: "в кавычках" (с "" внутри) или простой. → [имя, остаток].
function readIdent(text) {
  if (text.startsWith('"')) {
    let i = 1
    let name = ''
    for (; i < text.length; i++) {
      if (text[i] === '"') {
        if (text[i + 1] === '"') { name += '"'; i += 1; continue }
        return [name, text.slice(i + 1)]
      }
      name += text[i]
    }
    fail('имя в кавычках не закрыто')
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text)
  if (!m) fail(`ожидалось имя: «${text.slice(0, 40)}»`)
  return [m[0], text.slice(m[0].length)]
}

const quoteIdent = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`)

function mapRole(role, runtimeRole, where) {
  if (!Object.hasOwn(ROLE_RULES, role)) fail(`${where}: незнакомая роль «${role}»`)
  return ROLE_RULES[role] === 'runtime' ? runtimeRole : null
}

// Первая строка CREATE POLICY: имя, таблица, [AS …], [FOR …], TO роли, остаток.
function rewritePolicyHead(line, runtimeRole) {
  let rest = line.slice('CREATE POLICY '.length)
  let name
  ;[name, rest] = readIdent(rest)
  if (!rest.startsWith(' ON ')) fail(`политика «${name}»: нет ON`)
  rest = rest.slice(4)
  let schema
  let table
  ;[schema, rest] = readIdent(rest)
  if (!rest.startsWith('.')) fail(`политика «${name}»: таблица без схемы`)
  ;[table, rest] = readIdent(rest.slice(1))
  let head = `CREATE POLICY ${quoteIdent(name)} ON ${quoteIdent(schema)}.${quoteIdent(table)}`
  const opt = /^( AS (?:PERMISSIVE|RESTRICTIVE))?( FOR (?:ALL|SELECT|INSERT|UPDATE|DELETE))? TO /.exec(rest)
  if (!opt) fail(`политика «${name}»: нет роли (TO) в первой строке`)
  head += (opt[1] || '') + (opt[2] || '')
  rest = rest.slice(opt[0].length)
  const roles = []
  for (;;) {
    let role
    ;[role, rest] = readIdent(rest)
    roles.push(role)
    if (rest.startsWith(', ')) { rest = rest.slice(2); continue }
    break
  }
  if (rest !== '' && rest !== ';' && !rest.startsWith(' USING ') && !rest.startsWith(' WITH CHECK ')) {
    fail(`политика «${name}»: непонятное продолжение после ролей`)
  }
  const mapped = [...new Set(roles.map((r) => mapRole(r, runtimeRole, `политика «${name}»`)).filter(Boolean))]
  return { name, table: `${schema}.${table}`, roles, mapped, line: mapped.length ? `${head} TO ${mapped.map(quoteIdent).join(', ')}${rest}` : null }
}

const HEADER_RE = /^-- (?:Data for )?Name: (.*); Type: ([A-Z ]+); Schema: (.*); Owner: (.*)$/
const PASS_RE = /^(?:--.*|\s*|\\(?:un)?restrict \S+|SET [a-z_]+ = [^;]+;|SELECT pg_catalog\.set_config\('search_path', '', false\);)$/
const GRANT_RE = /^(GRANT|REVOKE) (.+) (TO|FROM) ("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)( WITH GRANT OPTION)?;$/

// SQL только из записей POLICY и ACL (pg_restore -L права.list -f …) → готовый SQL и отчёт.
export function rewriteAcl(sql, runtimeRole) {
  if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) fail(`роль приложения: недопустимое имя «${runtimeRole}»`)
  const out = []
  const report = {
    policies: { kept: 0, dropped: [] },
    grants: { toRuntime: 0, publicKept: 0, droppedByRole: {} },
  }
  let type = null // вид текущей записи
  let inPolicy = false // внутри многострочного CREATE POLICY
  let dropPolicy = false
  const lines = sql.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const where = `строка ${i + 1}`
    const header = HEADER_RE.exec(line)
    if (header && !inPolicy) {
      type = header[2]
      if (!ACL_TYPES.has(type)) fail(`${where}: запись вида «${type}» в файле прав`)
      out.push(line)
      continue
    }
    if (inPolicy) {
      // Продолжение условия политики — как есть; запись кончается перед следующим заголовком.
      if (line === '--' && HEADER_RE.test(lines[i + 1] || '')) { inPolicy = false; dropPolicy = false; out.push(line); continue }
      if (!dropPolicy) out.push(line)
      continue
    }
    if (line.startsWith('CREATE POLICY ')) {
      if (type !== 'POLICY') fail(`${where}: CREATE POLICY вне записи POLICY`)
      const p = rewritePolicyHead(line, runtimeRole)
      inPolicy = true
      dropPolicy = !p.line
      if (p.line) { out.push(p.line); report.policies.kept += 1 } else report.policies.dropped.push({ table: p.table, name: p.name, roles: p.roles })
      continue
    }
    const grant = GRANT_RE.exec(line)
    if (grant) {
      if (type !== 'ACL') fail(`${where}: выдача прав вне записи ACL`)
      const role = grant[4].startsWith('"') ? readIdent(grant[4])[0] : grant[4]
      if (role === 'PUBLIC') { out.push(line); report.grants.publicKept += 1; continue }
      const mapped = mapRole(role, runtimeRole, where)
      if (!mapped) { report.grants.droppedByRole[role] = (report.grants.droppedByRole[role] || 0) + 1; continue }
      out.push(`${grant[1]} ${grant[2]} ${grant[3]} ${quoteIdent(mapped)}${grant[5] || ''};`)
      report.grants.toRuntime += 1
      continue
    }
    if (PASS_RE.test(line)) { out.push(line); continue }
    fail(`${where}: строка не похожа ни на одну известную форму: «${line.slice(0, 80)}»`)
  }
  return { sql: out.join('\n'), report }
}

function main(argv) {
  const [mode, ...args] = argv
  if (mode === 'split' && args.length === 4) {
    const { main: mainList, acl, report } = splitToc(fs.readFileSync(args[0], 'utf8'))
    fs.writeFileSync(args[1], mainList)
    fs.writeFileSync(args[2], acl)
    fs.writeFileSync(args[3], JSON.stringify(report))
    return
  }
  if (mode === 'acl' && args.length === 4) {
    const { sql, report } = rewriteAcl(fs.readFileSync(args[0], 'utf8'), args[3])
    fs.writeFileSync(args[1], sql)
    fs.writeFileSync(args[2], JSON.stringify(report))
    return
  }
  fail('запуск: rewrite.mjs split <оглавление> <основное.list> <права.list> <отчёт.json> | acl <права.sql> <готово.sql> <отчёт.json> <роль>')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    if (!(e instanceof RewriteError)) throw e
    console.error(`Преобразование копии остановлено: ${e.message}`)
    process.exit(1)
  }
}
