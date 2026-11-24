// SIGNAL — ручные команды. На сервере corp — в образе выложенного выпуска с настройками портала
// (deploy/docker/deploy.sh, по образцу larix-cli.js):
//
//   node src/signal-cli.js probe
//   node src/signal-cli.js sync
//   node src/signal-cli.js accept-held --run <id> --expected-generation <n> --reason <текст>
//
//   probe        — только чтение: вход (токен получен, срок), число проектов, а для включённых корней — найден ли корень
//                  и сколько папок в его поддереве и во всём проекте. Названий, путей и идентификаторов SIGNAL не печатает.
//   sync         — внеочередной полный обход корней (без ожидания расписания) с публикацией по тем же правилам, что у службы.
//   accept-held  — принять отложенный защитой прогон: публикуется только последний held и только если поколение снимка
//                  совпало с --expected-generation; причина обязательна и записывается в журнал прогона.
//
// Настройки — те же переменные, что у службы (SIGNAL_*, OSP_DB_URL, OSP_DB_CA_FILE); SIGNAL_SYNC для команд не нужен.
// Барьер записи на время переноса (OSP_DB_READONLY_FILE при настроенном шлюзе OSP_PGRST_*) соблюдается так же, как службой:
// sync и accept-held при закрытом барьере ничего не пишут и выходят с кодом 4; probe (только чтение) работает всегда.
// Секрет и токен не печатаются. Выход: 0 — готово; 3 — прогон отложен защитой (held); 4 — сбой или отказ; 1 — ошибка запуска.
//
// Для тестов экспортируется runSignalCli(argv, { env, deps }) → код выхода (process.exitCode не трогает). deps — только из кода
// теста, из окружения не читается и проверку хостов в окружении не ослабляет:
//   deps.signalClient — параметры createSignalClient поверх настроек (baseUrl, allowLoopback, backoffMs, sleep …);
//   deps.db           — готовая обёртка базы (db.read / db.write); CLI её не закрывает;
//   deps.isReadOnly   — вместо барьера из настроек (проверка «закрыта ли запись» без файла-переключателя);
//   deps.stdout/stderr — приёмники строк вместо console.log / console.error.
// Запуск как скрипта (node src/signal-cli.js …) работает как раньше: настройки — из process.env, вывод — в консоль.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { createDb } from './lib/db.js'
import { createWriteBarrier } from './lib/writeBarrier.js'
import { createSignalClient, redact, SIGNAL_DEFAULT_URL } from './lib/signalClient.js'
import { createSignalApi } from './lib/signalApi.js'
import { createSignalSync } from './lib/signalSync.js'

const fmt = (n) => Number(n).toLocaleString('ru-RU')

// Вывод: по умолчанию консоль; в тестах — приёмники строк из deps.
function makeIo(deps) {
  const out = typeof deps.stdout === 'function' ? deps.stdout : (line) => console.log(line)
  const err = typeof deps.stderr === 'function' ? deps.stderr : (line) => console.error(line)
  return {
    out,
    err,
    log: {
      info: (obj, msg) => err(JSON.stringify({ level: 'info', msg, ...obj })),
      warn: (obj, msg) => err(JSON.stringify({ level: 'warn', msg, ...obj })),
    },
  }
}

// Барьер записи закрыт: команда, которая пишет в базу, ничего не меняет и сообщает об этом (код выхода 4).
function barrierRefused(io) {
  io.err('FAIL запись закрыта барьером переноса: команда ничего не изменила, повторите после окончания переноса данных')
  return 4
}

function usage(io) {
  io.err('Использование: node src/signal-cli.js probe | sync | accept-held --run <id> --expected-generation <n> --reason <текст>')
  return 1
}

// Настройки SIGNAL: из config.signal (parseSignal в config.js), а пока его нет — прямо из окружения.
function signalSettings(config, env) {
  if (config.signal && typeof config.signal === 'object') return config.signal
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  const num = (v) => (Number(v) > 0 ? Number(v) : undefined)
  return {
    baseUrl: env.SIGNAL_BASE_URL || SIGNAL_DEFAULT_URL,
    hosts: list(env.SIGNAL_HOSTS),
    clientId: env.SIGNAL_CLIENT_ID || '',
    clientSecret: env.SIGNAL_CLIENT_SECRET || '',
    scopes: String(env.SIGNAL_SCOPES || '').split(/[\s,]+/).filter(Boolean),
    timeoutMs: num(env.SIGNAL_TIMEOUT_MS),
    maxBytes: num(env.SIGNAL_MAX_BYTES),
    dayMode: env.SIGNAL_DAY_MODE === 'known' ? 'known' : 'full',
    runBudgetMs: num(env.SIGNAL_RUN_BUDGET_MS),
  }
}

async function probe({ api, db, io }) {
  const started = Date.now()
  const token = await api.getToken()
  io.out(`SIGNAL: токен получен, срок ${fmt(token.expiresInSec)} с`)
  let projects = 0
  for (let skip = 0; skip < 100_000; skip += 100) {
    const page = await api.listProjects({ skip, take: 100 })
    projects += page.length
    if (page.length < 100) break
  }
  io.out(`Проектов доступно: ${fmt(projects)}`)
  if (!db) {
    io.out('Корни не проверены: нет OSP_DB_URL')
    return 0
  }
  const sources = await db.read(null, async (tx) => (await tx.query('select osp_private.signal_sources_for_sync() as r')).rows[0]?.r ?? [])
  const list = Array.isArray(sources) ? sources : (sources?.sources || [])
  if (!list.length) io.out('Включённых корней нет')
  const trees = new Map()
  for (const source of list) {
    const key = String(source.projectId).toLowerCase()
    if (!trees.has(key)) trees.set(key, await api.getFolderTree(key))
    const tree = trees.get(key)
    const root = tree.find((n) => n.nodeId === String(source.folderId).toLowerCase())
    const inRoot = root ? tree.filter((n) => n.nodeId === root.nodeId || n.pathIds[root.depth] === root.nodeId).length : 0
    io.out(`Корень #${source.id}: ${root ? `найден, папок в поддереве ${fmt(inRoot)}` : 'НЕ НАЙДЕН в дереве проекта'}; папок в проекте ${fmt(tree.length)}`)
  }
  io.out(`Готово за ${((Date.now() - started) / 1000).toFixed(1)} с`)
  return 0
}

async function syncNow({ api, db, settings, io, isReadOnly }) {
  if (isReadOnly()) return barrierRefused(io)
  const sync = createSignalSync({ db, api, isReadOnly, log: io.log, config: settings })
  const out = await sync.runNow({ initiator: 'cli' })
  if (!out.started) {
    if (out.readOnly) return barrierRefused(io)
    const why = out.notConfigured ? 'SIGNAL не настроен' : out.noSources ? 'нет включённых корней' : 'идёт другой прогон'
    io.out(`Обход не начат: ${why}`)
    return 4
  }
  const res = await out.done
  const roots = (res.stats?.roots || []).map((r) => `#${r.id}: папок ${fmt(r.folders)}, элементов ${fmt(r.items)}`).join('; ')
  io.out(`Прогон ${res.runId}: ${res.status}${res.reason ? ` (${res.reason})` : ''}${res.generation ? `, поколение ${res.generation}` : ''}${roots ? ` — ${roots}` : ''}`)
  if (res.status === 'ok') return 0
  if (res.reason === 'read_only') io.err('FAIL запись закрыта барьером переноса: прогон остановлен без публикации')
  if (res.status === 'held') {
    io.out('Прогон отложен защитой. Принять: accept-held --run <id> --expected-generation <n> --reason <текст>')
    return 3
  }
  return 4
}

function parseAcceptArgs(rest) {
  const out = {}
  const names = { '--run': 'run', '--expected-generation': 'generation', '--reason': 'reason' }
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]
    if (!key || rest[i + 1] === undefined || key in out) return null
    out[key] = rest[i + 1]
  }
  if (!('run' in out) || !('generation' in out) || !('reason' in out)) return null
  const run = Number(out.run)
  const generation = Number(out.generation)
  const reason = String(out.reason).trim()
  if (!Number.isSafeInteger(run) || run < 1 || !/^\d+$/.test(out.run)) return null
  if (!Number.isSafeInteger(generation) || generation < 0 || !/^\d+$/.test(out.generation)) return null
  if (reason.length < 3 || reason.length > 300) return null
  return { runId: run, expectedGeneration: generation, reason }
}

async function acceptHeld({ api, db, settings, io, isReadOnly }, args) {
  if (isReadOnly()) return barrierRefused(io)
  const sync = createSignalSync({ db, api, isReadOnly, log: io.log, config: settings })
  let res
  try {
    res = await sync.acceptHeld({ ...args, actor: 'cli' })
  } catch (err) {
    if (isReadOnly() && err?.message === 'read_only') return barrierRefused(io) // барьер закрылся между проверкой и записью
    throw err
  }
  io.out(`Прогон ${args.runId}: принят${res?.generation ? `, поколение ${res.generation}` : ''}`)
  return 0
}

export async function runSignalCli(argv, { env = process.env, deps = {} } = {}) {
  const io = makeIo(deps)
  const [cmd, ...rest] = argv
  if (!['probe', 'sync', 'accept-held'].includes(cmd)) return usage(io)
  if ((cmd === 'probe' || cmd === 'sync') && rest.length) return usage(io)
  const accept = cmd === 'accept-held' ? parseAcceptArgs(rest) : null
  if (cmd === 'accept-held' && !accept) return usage(io)

  // accept-held работает только с базой: настройки SIGNAL ему не нужны (и их отсутствие не должно мешать).
  const wantsSignal = cmd !== 'accept-held'
  let db = null
  let ownDb = false
  let secrets = [env.SIGNAL_CLIENT_SECRET, env.SIGNAL_CLIENT_ID]
  try {
    const config = loadConfig({ ...env, SIGNAL_SYNC: wantsSignal ? '1' : '' })
    const settings = signalSettings(config, env)
    secrets = [settings.clientSecret, settings.clientId]
    if (deps.db) db = deps.db
    else if (config.db.url) { db = createDb({ url: config.db.url, caFile: config.db.caFile, max: 2, logger: io.log }); ownDb = true }
    if (cmd !== 'probe' && !db) throw new Error('нужен OSP_DB_URL')
    if (wantsSignal && !settings.clientId) throw new Error('SIGNAL не настроен: нужны SIGNAL_CLIENT_ID и SIGNAL_CLIENT_SECRET')
    const api = createSignalApi({ client: createSignalClient({ ...settings, log: io.log, ...deps.signalClient }) })
    // Барьер — как у службы (app.js): шлюз данных настроен и есть файл-переключатель. probe ничего не пишет и от барьера не зависит.
    const gatewayOn = Boolean(config.dbGateway?.upstream)
    const isReadOnly = cmd === 'probe' ? () => false
      : typeof deps.isReadOnly === 'function' ? deps.isReadOnly
        : createWriteBarrier({ file: config.dbGateway?.readOnlyFile, enabled: gatewayOn })
    const ctx = { api, db, settings, io, isReadOnly }
    if (cmd === 'probe') return await probe(ctx)
    if (cmd === 'sync') return await syncNow(ctx)
    return await acceptHeld(ctx, accept)
  } catch (err) {
    io.err(`FAIL ${redact(err?.message || err, secrets).slice(0, 300)}`)
    return 4
  } finally {
    if (ownDb) await db?.close()
  }
}

// Запуск как скрипта (а не импорт из теста).
function isEntryPoint() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntryPoint()) {
  runSignalCli(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.error(`FAIL ${String(err?.message || err).slice(0, 300)}`)
    process.exitCode = 1
  })
}
