// Связи учёток с СУ-10 — ручные команды на сервере corp, в образе выложенного выпуска с настройками портала
// (deploy/docker/deploy.sh identity …; удобнее — scripts/deploy-server.sh identity …: файлы — только на сервере, права 600).
//
//   export-users                     — CSV одобренных незаблокированных пользователей и суперадминистраторов на stdout:
//                                      osp_user_id,email,full_name. Для команды auth (файл передаётся вручную, не через git
//                                      и не в открытых каналах). В журнал — только число.
//   links-apply [--apply] [--partial <id,id…>] < файл связей
//                                    — файл от auth: osp_user_id,kc_user_id,match (email | fio | partial). По умолчанию —
//                                      пробный прогон: сколько строк, какие совпадения, несуществующие учётки, повторы,
//                                      конфликты с уже записанными связями. --apply — одной транзакцией: та же связь уже
//                                      есть — пропуск; любой другой конфликт — отказ целиком с перечнем. partial — только
//                                      учётки из --partial (проверены вручную).
//   links-report                     — сколько одобренных пользователей связано с СУ-10; администраторы без связи (id);
//                                      заявки; у кого нет пароля ОСП (им нужен временный для входа «через Яндекс»).
//   sync [--force]                   — сверка группы СУ-10 сейчас; --force — принять состояние, которое предохранитель отложил.
//   revoke-sessions --kind keycloak|password
//                                    — закрыть действующие сессии этого вида (после переключения режима входа).
//
// Почта и ФИО — только в CSV export-users (stdout); остальные команды печатают числа и идентификаторы. Секреты не печатаются.
// Выход: 0 — готово; 3 — конфликты / предохранитель; 4 — сбой; 1 — ошибка запуска.
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { defaultDeps } from './app.js'
import { createSecretBox } from './lib/auth/secretBox.js'
import { createSessions } from './lib/auth/sessions.js'
import { createIdentity } from './lib/auth/identity.js'
import { createKcAdmin } from './lib/auth/kcAdmin.js'
import { createAccessSync } from './lib/auth/accessSync.js'
import * as ops from './lib/auth/identityOps.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MATCHES = new Set(['email', 'fio', 'partial'])
const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)
const log = {
  info: (obj, msg) => err(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => err(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => err(JSON.stringify({ level: 'error', msg, ...obj })),
}

function usage() {
  err('Использование: node src/identity-cli.js export-users | links-apply [--apply] [--partial id,id] | links-report | sync [--force] | revoke-sessions --kind keycloak|password')
  return 1
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

// CSV без кавычек в значениях почты и id; ФИО — в кавычках, если в нём запятая.
const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function parseLinksCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const header = (lines.shift() || '').toLowerCase().replace(/\s+/g, '')
  if (header !== 'osp_user_id,kc_user_id,match') throw new Error('первая строка — osp_user_id,kc_user_id,match')
  const rows = []
  const bad = []
  lines.forEach((line, i) => {
    const [osp, kc, match, ...rest] = line.split(',').map((s) => s.trim())
    if (rest.length || !UUID.test(osp || '') || !UUID.test(kc || '') || !MATCHES.has(String(match || '').toLowerCase())) bad.push(i + 2)
    else rows.push({ line: i + 2, osp: osp.toLowerCase(), kc: kc.toLowerCase(), match: match.toLowerCase() })
  })
  return { rows, bad }
}

// Проверка файла связей против базы → { plan, problems } (problems — строки «что не так», только id и номера строк).
export function planLinks({ rows, bad }, { users, links, partialAllowed }) {
  const problems = bad.map((n) => `строка ${n}: не по формату`)
  const seenOsp = new Map()
  const seenKc = new Map()
  const plan = { insert: [], same: 0, byMatch: { email: 0, fio: 0, partial: 0 } }
  for (const r of rows) {
    plan.byMatch[r.match]++
    const dupOsp = seenOsp.get(r.osp)
    const dupKc = seenKc.get(r.kc)
    if (dupOsp) problems.push(`строка ${r.line}: osp_user_id ${r.osp} повторяется (строка ${dupOsp})`)
    if (dupKc) problems.push(`строка ${r.line}: kc_user_id ${r.kc} повторяется (строка ${dupKc})`)
    if (!dupOsp) seenOsp.set(r.osp, r.line)
    if (!dupKc) seenKc.set(r.kc, r.line)
    if (dupOsp || dupKc) continue
    if (!users.has(r.osp)) { problems.push(`строка ${r.line}: учётки ${r.osp} в портале нет`); continue }
    if (r.match === 'partial' && !partialAllowed.has(r.osp)) { problems.push(`строка ${r.line}: partial для ${r.osp} не подтверждён (--partial)`); continue }
    const bySub = links.bySubject.get(r.kc)
    const byUser = links.byUser.get(r.osp)
    if (bySub === r.osp && byUser === r.kc) { plan.same++; continue }
    if (bySub && bySub !== r.osp) { problems.push(`строка ${r.line}: kc_user_id ${r.kc} уже связан с другой учёткой ${bySub}`); continue }
    if (byUser && byUser !== r.kc) { problems.push(`строка ${r.line}: учётка ${r.osp} уже связана с другой учёткой СУ-10`); continue }
    plan.insert.push(r)
  }
  return { plan, problems }
}

async function exportUsers(db) {
  const rows = await ops.exportUsers(db)
  out('osp_user_id,email,full_name')
  for (const r of rows) out([r.id, r.email || '', r.full_name || ''].map(csvCell).join(','))
  err(`Выгружено пользователей: ${rows.length}`)
  return 0
}

async function linksApply(db, issuer, args) {
  const apply = args.includes('--apply')
  const pIdx = args.indexOf('--partial')
  const partialAllowed = new Set(pIdx >= 0 ? String(args[pIdx + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)) : [])
  const parsed = parseLinksCsv(await readStdin())
  const users = new Set(await ops.userIds(db))
  const { plan, problems } = planLinks(parsed, { users, links: await ops.readLinks(db, issuer), partialAllowed })
  err(`Строк: ${parsed.rows.length + parsed.bad.length}; email — ${plan.byMatch.email}, fio — ${plan.byMatch.fio}, partial — ${plan.byMatch.partial}`)
  err(`Новых связей: ${plan.insert.length}; уже записаны так же: ${plan.same}; замечаний: ${problems.length}`)
  for (const p of problems) err(`  ${p}`)
  if (!apply) {
    err('Пробный прогон — база не менялась. Записать: --apply')
    return problems.length ? 3 : 0
  }
  if (problems.length) {
    err('Не записано: сначала исправьте файл (или подтвердите partial через --partial)')
    return 3
  }
  await ops.insertLinks(db, issuer, plan.insert)
  err(`Записано связей: ${plan.insert.length}`)
  return 0
}

async function linksReport(db, issuer) {
  const r = await ops.linksReport(db, issuer)
  const unlinked = r.approved.filter((u) => !r.linked.has(u.id))
  const adminsUnlinked = unlinked.filter((u) => u.admin)
  const noPassword = r.approved.filter((u) => !r.withPassword.has(u.id))
  out(`Одобренных пользователей и суперадминистраторов: ${r.approved.length}`)
  out(`Связаны с СУ-10: ${r.approved.length - unlinked.length}; без связи: ${unlinked.length}`)
  out(`Администраторы без связи: ${adminsUnlinked.length}${adminsUnlinked.length ? ` — ${adminsUnlinked.map((u) => u.id).join(', ')}` : ''}`)
  out(`Заявки: ${r.requests.map((x) => `${x.status} — ${x.n}`).join(', ') || 'нет'}`)
  out(`Без пароля ОСП (для входа «через Яндекс» нужен временный): ${noPassword.length}`)
  return adminsUnlinked.length ? 3 : 0
}

async function revokeSessions(db, args) {
  const kind = args[args.indexOf('--kind') + 1]
  if (!['keycloak', 'password'].includes(kind)) return usage()
  const n = await ops.revokeSessionsOfKind(db, kind)
  err(`Закрыто сессий (${kind}): ${n}`)
  return 0
}

async function main(argv) {
  const [cmd, ...args] = argv
  if (!['export-users', 'links-apply', 'links-report', 'sync', 'revoke-sessions'].includes(cmd)) return usage()
  const config = loadConfig()
  if (!config.db.url) { err('нет OSP_DB_URL'); return 1 }
  const issuer = config.oidc.issuer
  if (['links-apply', 'links-report', 'sync'].includes(cmd) && !issuer) { err('нет OIDC_ISSUER — связи привязаны к нему'); return 1 }
  const db = defaultDeps.createDb({ url: config.db.url, caFile: config.db.caFile, max: 1, logger: log })
  try {
    if (cmd === 'export-users') return await exportUsers(db)
    if (cmd === 'links-apply') return await linksApply(db, issuer, args)
    if (cmd === 'links-report') return await linksReport(db, issuer)
    if (cmd === 'revoke-sessions') return await revokeSessions(db, args)
    // sync
    if (!config.oidc.admin) { err('сверка не настроена: нет KC_ADMIN_CLIENT_ID / KC_ADMIN_CLIENT_SECRET'); return 1 }
    if (!config.auth.keys) { err('нет OSP_AUTH_KEYS'); return 1 }
    const box = createSecretBox(config.auth.keys)
    const sessions = createSessions({ db, box, logger: log })
    const identity = createIdentity({ db, issuer, linkByEmail: config.oidc.linkByEmail, sessions, createUserTx: null, isSuperadmin: async () => false, log })
    const sync = createAccessSync({
      db, identity, sessions, issuer, linkByEmail: config.oidc.linkByEmail, log,
      kcAdmin: createKcAdmin({ issuer, admin: config.oidc.admin }),
    })
    const result = await sync.run({ force: args.includes('--force') })
    if (result.busy) { err('сверка уже идёт в службе — повторите через минуту'); return 3 }
    out(JSON.stringify(result))
    return result.held ? 3 : 0
  } catch (e) {
    err(`сбой: ${e?.code || e?.name || 'error'}${e?.status ? ` (${e.status})` : ''}`)
    return 4
  } finally {
    await db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    err(`ошибка запуска: ${e?.message || e}`)
    process.exitCode = 1
  })
}
