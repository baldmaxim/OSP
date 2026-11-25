// Синхронизация SIGNAL → наша база: обход корней, запись порциями в staging и публикация снимка.
//
//   const sync = createSignalSync({ db, api, isReadOnly, log, config, now })
//   sync.start()                      // такт SIGNAL_TICK_MS (по умолчанию 5 мин)
//   const run = await sync.runNow({ initiator: 'admin', startedBy })   // → { runId, done } | { busy } | …
//   await sync.stop()                 // прерывает обход без публикации, ждёт не больше 10 с
//
// Что обещано (tests/osp-api/signal-sync*.test.mjs, раздел 4 спецификации):
//   • в SIGNAL — только чтение через адаптер (signalApi.js); в нашей базе — только служебные функции osp_private.signal_*
//     через db.write(null, …) / db.read(null, …); других обращений к таблицам нет;
//   • расписание решает база (signal_sync_due, Europe/Moscow): такт лишь спрашивает; ночной обход — всегда полный,
//     дневной — SIGNAL_DAY_MODE (полный или только известные папки), ручной — полный;
//   • ни одной открытой транзакции во время обращения к SIGNAL и ожидания Retry-After: каждая запись — своя короткая
//     операция; в памяти — дерево одного проекта и список элементов одной папки (не больше maxNodes), запись порциями ≤ 500 строк;
//   • владелец прогона — токен, выданный signal_sync_begin; heartbeat каждые ≤ 30 с отдельной короткой записью,
//     в том числе пока идёт ожидание 429; потеря владения останавливает обход;
//   • барьер записи isReadOnly() проверяется перед каждой порцией и перед публикацией: прогон отменяется без записи
//     (отметка «отменён» в базе ставится позже, когда барьер снят, либо её поставит очистка зависших прогонов);
//   • любой сбой, held и отмена не меняют опубликованный снимок: публикует только signal_sync_finish, одной транзакцией;
//   • сбой одного корня (дерево проекта 403/404, корня нет в дереве, бюджет корня, предел, повтор страницы) не останавливает
//     остальные: корень уходит в stats.roots со статусом failed и причиной, обход продолжается, прогон кончается статусом
//     ok | partial | held | failed — его определяет база (signal_sync_finish, публикация по корням);
//   • папка, элементы которой не прочитаны (403, 404, ошибка разбора, нестабильные страницы), не валит обход: она уходит в staging
//     с items_listed = false и problem (forbidden | not_found | invalid | unstable), в stats.roots[].problems — её id и код;
//   • для файлов со ссылкой, которых обход не встретил, — адресный запрос удалённых элементов их папки (В-10): нашёлся
//     deleted = true — в staging уходит удалённый элемент (в базе — «Файл удалён в Signal»);
//   • в журнале и результатах — только идентификаторы корней, коды и счётчики, без имён и путей.
import { SignalError } from './signalClient.js'
import { dbUnavailable } from './db.js'
import { prepareNode as defaultPrepare } from './signalMatch.js'
import { readFolderItems, findDeletedItems, SIGNAL_PAGE_ENDS } from './signalApi.js'

export const SIGNAL_SYNC_FUNCTIONS = Object.freeze([
  'signal_sync_due', 'signal_sources_for_sync', 'signal_sync_begin', 'signal_sync_heartbeat', 'signal_stage_put',
  'signal_sync_fail', 'signal_sync_finish', 'signal_accept_held',
])
export const SIGNAL_SYNC_DEFAULTS = Object.freeze({
  dayMode: 'full',
  tickMs: 300_000,
  firstDelayMs: 60_000,
  runBudgetMs: 3_000_000,
  heartbeatMs: 30_000,
  pageSize: 200,
  stageChunk: 500,
  maxDepth: 30,
  maxNodes: 50_000,
  staleSeconds: 600,
  finishTimeoutMs: 120_000,
  stopWaitMs: 10_000,
  // С-58, TODO(G1): 'empty' — список кончается только пустой страницей (лишний запрос на папку); 'short' — страницей короче Take.
  pageEnd: 'empty',
  // Бюджет одного корня: превышение — сбой этого корня (reason budget), остальные корни обходятся.
  rootBudgetMs: 2_400_000,
  // В-10, TODO(G1): сколько запросов удалённых элементов (deleted=true) на прогон; 0 — адресный запрос выключен.
  deletedLookupLimit: 200,
  // Сколько проблемных подпапок уходит в статистику прогона (база хранит её не больше 20 000 знаков).
  problemsMax: 100,
})
// Причины, которыми прогон завершается со стороны службы (причины публикации — held — выдаёт база).
export const SIGNAL_RUN_REASONS = Object.freeze([
  'auth', 'scope', 'http', 'timeout', 'too_large', 'invalid', 'rate_limited', 'not_configured', // коды клиента
  'root_missing', 'root_unavailable', 'limit', 'budget', 'db', 'internal', // обход
  'read_only', 'stopped', 'lost_owner', // отмены
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const silent = { info() {}, warn() {} }

// Остановка по причине: budget | stopped | read_only | lost_owner.
class RunAbort extends Error {
  constructor(code) { super(code); this.name = 'RunAbort'; this.code = code }
}
// Ошибка обхода с кодом причины (не SIGNAL и не база).
class SyncFail extends Error {
  constructor(code) { super(code); this.name = 'SyncFail'; this.code = code }
}

// Что делать с ошибкой чтения: причина сбоя корня (код для last_error), либо null — остановить весь прогон
// (отмена, остановка, потеря владения, авторизация, квота, база, ошибка в самой службе).
function rootFailReason(err, { tree = false } = {}) {
  if (err instanceof SyncFail) return err.code
  if (err instanceof SignalError) {
    if (['aborted', 'auth', 'rate_limited', 'not_configured'].includes(err.code)) return null
    if (tree && err.code === 'http' && err.status === 404) return 'root_unavailable'
    return SIGNAL_RUN_REASONS.includes(err.code) ? err.code : 'http'
  }
  if (err?.code === 'SG422') return 'invalid' // база не приняла строку (данные, а не связь)
  return null
}
// Код проблемы папки, элементы которой не прочитаны; null — это не проблема папки (сбой корня или прогона).
function folderProblemOf(err) {
  if (!(err instanceof SignalError) || err.repeat) return null
  if (err.code === 'scope') return 'forbidden'
  if (err.code === 'http' && err.status === 404) return 'not_found'
  if (err.code === 'invalid' || err.code === 'too_large') return 'invalid'
  return null
}
const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n).toWellFormed() : v)

const short = (err) => String(err?.message || err || 'сбой').replace(/\s+/g, ' ').slice(0, 200)
const idOf = (v) => String(v || '').toLowerCase()

// Служебные функции базы: каждый вызов — отдельная короткая транзакция.
function createStore(db, o) {
  const call = (mode, name, args, opts) => {
    if (!SIGNAL_SYNC_FUNCTIONS.includes(name)) throw new Error(`signal: функция ${name} не из набора синхронизации`)
    const marks = args.map((a, i) => `$${i + 1}${a.cast ? `::${a.cast}` : ''}`).join(', ')
    const params = args.map((a) => a.v)
    return db[mode](null, async (tx) => (await tx.query(`select osp_private.${name}(${marks}) as r`, params)).rows[0]?.r ?? null, opts)
  }
  const a = (v, cast) => ({ v, cast })
  return {
    due: (at) => call('read', 'signal_sync_due', [a(at.toISOString(), 'timestamptz')]),
    // Режим known приносит ещё knownFolderIds (папки со связью или кандидатом) и folderIds (папки опубликованного снимка).
    // У корня может быть linkedItems: [{nodeId, folderId}] — файлы, на которые ссылаются договоры (их папки читаются всегда, а не
    // встреченные в прогоне ищутся среди удалённых). codes — объектные коды для сопоставителя (на уровне ответа или корня).
    sources: async (mode) => {
      const r = await call('read', 'signal_sources_for_sync', [a(mode === 'known' ? 'known' : 'full', 'text')])
      return {
        sources: Array.isArray(r?.sources) ? r.sources : [],
        codes: Array.isArray(r?.codes) ? r.codes.map(String).filter(Boolean) : [],
      }
    },
    begin: (kind, mode, initiator, slot, startedBy) => call('write', 'signal_sync_begin', [
      a(kind, 'text'), a(mode, 'text'), a(initiator, 'text'), a(slot ?? null, 'timestamptz'), a(startedBy ?? null, 'uuid'), a(o.staleSeconds, 'int'),
    ]),
    heartbeat: (run, owner) => call('write', 'signal_sync_heartbeat', [a(run, 'bigint'), a(owner, 'uuid')]),
    stagePut: (run, owner, rows) => call('write', 'signal_stage_put', [a(run, 'bigint'), a(owner, 'uuid'), a(JSON.stringify(rows), 'jsonb')]),
    fail: (run, owner, status, reason, stats) => call('write', 'signal_sync_fail', [
      a(run, 'bigint'), a(owner, 'uuid'), a(status, 'text'), a(reason, 'text'), a(JSON.stringify(stats ?? {}), 'jsonb'),
    ]),
    finish: (run, owner, stats, force) => call('write', 'signal_sync_finish', [
      a(run, 'bigint'), a(owner, 'uuid'), a(JSON.stringify(stats ?? {}), 'jsonb'), a(Boolean(force), 'boolean'),
    ], { statementTimeoutMs: o.finishTimeoutMs }),
    acceptHeld: (run, expected, actor, reason) => call('write', 'signal_accept_held', [
      a(run, 'bigint'), a(expected, 'bigint'), a(actor, 'text'), a(reason, 'text'),
    ], { statementTimeoutMs: o.finishTimeoutMs }),
  }
}

export function createSignalSync({ db, api, isReadOnly = () => false, log = silent, config = {}, now = Date.now, prepareNode = defaultPrepare }) {
  if (!db || !api) throw new Error('signalSync: нужны db и api')
  const o = { ...SIGNAL_SYNC_DEFAULTS }
  for (const key of Object.keys(SIGNAL_SYNC_DEFAULTS)) if (config?.[key] !== undefined && config[key] !== null) o[key] = config[key]
  if (o.dayMode !== 'known') o.dayMode = 'full'
  if (!SIGNAL_PAGE_ENDS.includes(o.pageEnd)) o.pageEnd = 'empty'
  for (const key of ['deletedLookupLimit', 'problemsMax']) if (!Number.isInteger(o[key]) || o[key] < 0) o[key] = SIGNAL_SYNC_DEFAULTS[key]
  if (!(Number(o.rootBudgetMs) > 0)) o.rootBudgetMs = SIGNAL_SYNC_DEFAULTS.rootBudgetMs
  const store = createStore(db, o)

  let current = null // { controller, promise, runId } — прогон этого процесса
  let launching = false
  let pending = null // отметка «отменён», отложенная из-за барьера записи
  let timer = null
  let first = null
  let stopping = false

  const guardWrite = () => { if (isReadOnly()) throw new RunAbort('read_only') }

  // Причина остановки по сигналу прогона.
  function abortCodeOf(err, controller) {
    if (err instanceof RunAbort) return err.code
    if (err instanceof SignalError && err.code === 'aborted') return controller.signal.reason instanceof RunAbort ? controller.signal.reason.code : 'stopped'
    return null
  }

  function ensureActive(ctx) {
    const { signal } = ctx.controller
    if (signal.aborted) throw signal.reason instanceof RunAbort ? signal.reason : new RunAbort('stopped')
    if (now() >= ctx.deadline) throw new RunAbort('budget')
    if (ctx.rootDeadline && now() >= ctx.rootDeadline) throw new SyncFail('budget') // бюджет корня: сбой корня, не прогона
  }

  // Результат прогона по ошибке: статус, причина, нужна ли отметка в базе.
  function outcomeOf(err, ctx) {
    const abort = abortCodeOf(err, ctx.controller)
    if (abort === 'lost_owner') return { status: 'cancelled', reason: 'lost_owner', mark: false }
    if (abort === 'read_only' || abort === 'stopped') return { status: 'cancelled', reason: abort, mark: true }
    if (abort === 'budget') return { status: 'failed', reason: 'budget', mark: true }
    if (err instanceof SyncFail) return { status: 'failed', reason: err.code, mark: true }
    if (err instanceof SignalError) return { status: 'failed', reason: SIGNAL_RUN_REASONS.includes(err.code) ? err.code : 'http', mark: true }
    // Чужой владелец или прогон уже не выполняется: база отвечает SG409 «busy» — отмечать нечем и незачем.
    if (err?.code === 'SG409' || err?.code === 'SG403') return { status: 'cancelled', reason: 'lost_owner', mark: false }
    if (dbUnavailable(err) || (err?.code && /^[0-9A-Z]{5}$/.test(String(err.code)))) return { status: 'failed', reason: 'db', mark: true }
    return { status: 'failed', reason: 'internal', mark: true }
  }

  async function markEnd(ctx, outcome, stats) {
    if (isReadOnly()) {
      pending = { runId: ctx.runId, owner: ctx.owner, status: outcome.status, reason: outcome.reason, stats }
      return
    }
    try {
      await store.fail(ctx.runId, ctx.owner, outcome.status, outcome.reason, stats)
    } catch (err) {
      log.warn({ runId: ctx.runId, msg: short(err) }, 'signal: отметка о завершении не записана')
    }
  }

  async function flushPending() {
    if (!pending || isReadOnly()) return
    const p = pending
    pending = null
    try {
      await store.fail(p.runId, p.owner, p.status, p.reason, p.stats)
    } catch (err) {
      log.warn({ runId: p.runId, msg: short(err) }, 'signal: отложенная отметка не записана')
    }
  }

  function startHeartbeat(ctx) {
    let busy = false
    const t = setInterval(async () => {
      if (busy || ctx.controller.signal.aborted || isReadOnly()) return
      busy = true
      try {
        const alive = await store.heartbeat(ctx.runId, ctx.owner)
        if (alive === false) ctx.controller.abort(new RunAbort('lost_owner'))
      } catch (err) {
        if (err?.code === 'SG409' || err?.code === 'SG403') ctx.controller.abort(new RunAbort('lost_owner'))
        else log.warn({ runId: ctx.runId, msg: short(err) }, 'signal: heartbeat не записан')
      } finally { busy = false }
    }, o.heartbeatMs)
    t.unref?.()
    return t
  }

  // Строка staging (camelCase, как ждёт signal_stage_put). Путь, предки и глубина — от корня обхода: у самого корня
  // parentId = null и pathIds = [], у потомков pathIds начинается с корня. Пределы колонок базы (путь ≤ 8000, тип ≤ 100) соблюдаются
  // усечением: одна длинная строка не должна останавливать публикацию. problem — у папки, элементы которой не прочитаны.
  function rowOf(n, { source, codes, listed, problem = null }) {
    const prepared = prepareNode({ name: n.name, path: n.path, kind: n.kind, codes }) || {}
    return {
      nodeId: n.nodeId, projectId: source.projectId, sourceId: source.id, kind: n.kind, parentId: n.parentId,
      name: n.name, path: clip(n.path, 8000), pathIds: n.pathIds, depth: n.depth, modifiedAt: n.modifiedAt, itemType: clip(n.itemType, 100),
      versionNumber: n.versionNumber, deleted: n.deleted,
      numberKeys: prepared.numberKeys ?? [], nameNorm: prepared.nameNorm ?? '', features: prepared.features ?? {},
      itemsListed: listed && !problem, ...(problem ? { problem } : {}),
    }
  }

  async function stageRows(ctx, rows) {
    for (let i = 0; i < rows.length; i += o.stageChunk) {
      ensureActive(ctx)
      guardWrite()
      await store.stagePut(ctx.runId, ctx.owner, rows.slice(i, i + o.stageChunk))
    }
  }

  // Папки, элементы которых перечисляются: полный обход — все; known — со связью/кандидатом, с файлами по ссылке и новые (нет в снимке).
  function listedFolders(source, mode, folders, linked) {
    if (mode !== 'known') return null
    const known = new Set((source.knownFolderIds || []).map(idOf))
    for (const folderId of linked.values()) known.add(folderId)
    const published = new Set((source.folderIds || []).map(idOf))
    return new Set(folders.filter((f) => known.has(f.nodeId) || !published.has(f.nodeId)).map((f) => f.nodeId))
  }

  // Файлы со ссылкой: nodeId → folderId (папка, где файл видели в прошлый раз). Чужие и неверные записи отбрасываются.
  function linkedItemsOf(source) {
    const out = new Map()
    for (const l of Array.isArray(source.linkedItems) ? source.linkedItems : []) {
      const nodeId = idOf(l?.nodeId)
      const folderId = idOf(l?.folderId)
      if (UUID.test(nodeId) && UUID.test(folderId)) out.set(nodeId, folderId)
    }
    return out
  }

  // Элементы одной папки: читаются целиком (readFolderItems: конец списка, повторы, согласованность страниц) и только затем
  // уходят в staging — нестабильный или нечитаемый список в снимок не попадает. → { problem } либо { count }.
  async function listFolderItems(ctx, source, folder, counters, met) {
    let read
    try {
      read = await readFolderItems(api, folder.nodeId, {
        pageSize: o.pageSize, pageEnd: o.pageEnd, maxItems: Math.max(0, o.maxNodes - counters.total), signal: ctx.controller.signal,
        onPage: () => ensureActive(ctx),
      })
    } catch (err) {
      const problem = folderProblemOf(err)
      if (!problem) throw err
      return { problem }
    }
    if (read.unstable) return { problem: 'unstable' }
    counters.total += read.items.length
    if (counters.total > o.maxNodes) throw new SyncFail('limit')
    const rows = read.items.map((item) => {
      met.add(item.nodeId)
      return rowOf({
        ...item, path: `${folder.path} / ${item.name}`, pathIds: [...folder.pathIds, folder.nodeId], depth: folder.depth + 1,
      }, { source, codes: ctx.codes, listed: false })
    })
    await stageRows(ctx, rows)
    return { count: read.items.length }
  }

  // В-10: файлы со ссылкой, которых обход не встретил, — адресный запрос удалённых элементов их папки (только папки, прочитанные
  // в этом прогоне целиком). Найденное удалённое → staging deleted = true (в базе — missing:deleted). Не найденное — как и прежде:
  // пропавший файл ловит правило двух ночей (file_not_visible). Предел запросов на прогон — deletedLookupLimit.
  async function lookupDeleted(ctx, source, byNode, linked, met, readFolders, entry) {
    const pending = new Map() // folderId → Set(nodeId)
    for (const [nodeId, folderId] of linked) {
      if (met.has(nodeId) || !readFolders.has(folderId)) continue
      if (!pending.has(folderId)) pending.set(folderId, new Set())
      pending.get(folderId).add(nodeId)
    }
    let skipped = 0
    for (const [folderId, wanted] of pending) {
      ensureActive(ctx)
      const left = o.deletedLookupLimit - ctx.deletedRequests
      if (left <= 0) { skipped += wanted.size; continue }
      let res
      try {
        res = await findDeletedItems(api, folderId, wanted, { pageSize: o.pageSize, pageEnd: o.pageEnd, maxRequests: left, signal: ctx.controller.signal })
      } catch (err) {
        if (folderProblemOf(err)) { skipped += wanted.size; continue }
        throw err
      }
      ctx.deletedRequests += res.requests
      const folder = byNode.get(folderId)
      const rows = res.found.map((item) => rowOf({
        ...item, deleted: true, path: `${folder.path} / ${item.name}`, pathIds: [...folder.pathIds, folder.nodeId], depth: folder.depth + 1,
      }, { source, codes: ctx.codes, listed: false }))
      await stageRows(ctx, rows)
      if (rows.length) entry.deletedFound = (entry.deletedFound || 0) + rows.length
      if (!res.complete) skipped += wanted.size - rows.length
    }
    if (skipped) entry.deletedSkipped = skipped
  }

  async function syncRoot(ctx, source, root, tree, stats) {
    // Поддерево корня; путь, предки и глубина пересчитываются от корня (корень — без родителя).
    const prefix = root.path.slice(0, root.path.length - root.name.length)
    const subtree = []
    let deepest = 0
    for (const n of tree) {
      if (n.nodeId !== root.nodeId && n.pathIds[root.depth] !== root.nodeId) continue
      const depth = n.depth - root.depth
      if (depth > deepest) deepest = depth
      subtree.push({
        ...n, path: n.path.slice(prefix.length), pathIds: n.pathIds.slice(root.depth), depth,
        parentId: n.nodeId === root.nodeId ? null : n.parentId,
      })
    }
    if (deepest > o.maxDepth || subtree.length > o.maxNodes) throw new SyncFail('limit')
    const linked = linkedItemsOf(source)
    const listed = listedFolders(source, ctx.mode, subtree, linked)
    const entry = { id: source.id, status: 'ok', folders: subtree.length, items: 0, listed: 0 }
    const problems = []
    ctx.rootDeadline = now() + o.rootBudgetMs
    await stageRows(ctx, subtree.map((n) => rowOf(n, { source, codes: ctx.codes, listed: listed === null || listed.has(n.nodeId) })))
    const counters = { total: subtree.length, items: 0 }
    const byNode = new Map(subtree.map((n) => [n.nodeId, n]))
    const met = new Set() // файлы со ссылкой, встреченные в прогоне
    const readFolders = new Set()
    for (const folder of subtree) {
      if (listed !== null && !listed.has(folder.nodeId)) continue
      const res = await listFolderItems(ctx, source, folder, counters, met)
      if (res.problem) {
        // Элементы папки не прочитаны: строка папки заменяется (items_listed = false, problem), её файлы база перенесёт из прежнего снимка.
        problems.push({ nodeId: folder.nodeId, code: res.problem })
        await stageRows(ctx, [rowOf(folder, { source, codes: ctx.codes, listed: false, problem: res.problem })])
        continue
      }
      readFolders.add(folder.nodeId)
      entry.listed += 1
      counters.items += res.count
      entry.items = counters.items
    }
    if (linked.size && o.deletedLookupLimit > 0) await lookupDeleted(ctx, source, byNode, linked, met, readFolders, entry)
    if (problems.length) entry.problems = problems
    stats.roots.push(entry)
  }

  // Дерево проекта — один запрос на проект, даже если в проекте несколько корней. ctx.active — корни, над которыми
  // идёт работа (при сбое всего прогона именно их отметит signal_sync_fail в last_error). Сбой корня (rootFailReason) — запись
  // failed в stats.roots и переход к следующему: остальные корни и проекты обходятся и публикуются.
  async function walk(ctx, stats) {
    const byProject = new Map()
    for (const source of ctx.sources) {
      const key = idOf(source.projectId)
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push({ ...source, projectId: key, folderId: idOf(source.folderId) })
    }
    const fail = (source, reason) => {
      log.warn({ runId: ctx.runId, rootId: source.id, reason }, 'signal root failed')
      stats.roots.push({ id: source.id, status: 'failed', reason })
    }
    for (const [projectId, group] of byProject) {
      ensureActive(ctx)
      ctx.active = group.map((s) => s.id)
      let tree
      try {
        tree = await api.getFolderTree(projectId, { signal: ctx.controller.signal })
      } catch (err) {
        const reason = rootFailReason(err, { tree: true })
        if (!reason) throw err
        for (const source of group) fail(source, reason)
        ctx.active = []
        continue
      }
      const byId = new Map(tree.map((n) => [n.nodeId, n]))
      for (const source of group) {
        ensureActive(ctx)
        ctx.active = [source.id]
        const root = byId.get(source.folderId)
        if (!root) {
          fail(source, 'root_missing')
          continue
        }
        try {
          await syncRoot(ctx, source, root, tree, stats)
        } catch (err) {
          const reason = rootFailReason(err)
          if (!reason) throw err
          fail(source, reason)
        } finally { ctx.rootDeadline = null }
        ctx.active = []
      }
      tree = null
    }
  }

  // Статистика сбойного прогона: завершённые корни — ok, корни в работе — failed с причиной (она попадёт в last_error).
  // Остановка, барьер, бюджет и потеря владения корень не винят.
  function failedStats(stats, ctx, err, outcome) {
    const blame = err instanceof SyncFail || (err instanceof SignalError && err.code !== 'aborted')
    const roots = [...stats.roots]
    if (blame) for (const id of ctx.active || []) roots.push({ id, status: 'failed', reason: outcome.reason })
    return capStats({ roots })
  }

  // База хранит статистику прогона не больше 20 000 знаков и при превышении отбрасывает её целиком (вместе со сбоями корней):
  // список проблемных подпапок ограничивается problemsMax на весь прогон, полное число — в problemsTotal.
  function capStats(stats) {
    let left = o.problemsMax
    return {
      ...stats,
      roots: stats.roots.map((r) => {
        if (!r.problems?.length) return r
        const { problems, ...rest } = r
        const keep = problems.slice(0, left)
        left -= keep.length
        return { ...rest, problemsTotal: problems.length, ...(keep.length ? { problems: keep } : {}) }
      }),
    }
  }

  // Счётчики в журнал: проблемные папки — числом (идентификаторы узлов SIGNAL в журнал не идут).
  const logRoots = (roots) => roots.map(({ problems, ...r }) => ({ ...r, ...(problems ? { problems: problems.length } : {}) }))

  async function execute(ctx) {
    const stats = { roots: [] }
    const budget = setTimeout(() => ctx.controller.abort(new RunAbort('budget')), o.runBudgetMs)
    budget.unref?.()
    const heartbeat = startHeartbeat(ctx)
    try {
      await walk(ctx, stats)
      ensureActive(ctx)
      clearInterval(heartbeat)
      guardWrite()
      const capped = capStats(stats)
      const fin = await store.finish(ctx.runId, ctx.owner, capped, false)
      // Статус прогона решает база по корням: ok — опубликованы все, partial — часть, held — отложены, failed — ни один не обойдён.
      const status = ['ok', 'partial', 'held', 'failed'].includes(fin?.status) ? fin.status : 'ok'
      const result = { status, reason: fin?.reason ?? null, generation: fin?.generation ?? null, runId: ctx.runId, stats: capped }
      const level = status === 'ok' ? 'info' : 'warn'
      log[level]({ runId: ctx.runId, status, reason: result.reason, generation: result.generation, roots: logRoots(capped.roots) }, 'signal sync')
      return result
    } catch (err) {
      const outcome = outcomeOf(err, ctx)
      const failed = failedStats(stats, ctx, err, outcome)
      log.warn({ runId: ctx.runId, status: outcome.status, reason: outcome.reason, roots: logRoots(failed.roots) }, 'signal sync stopped')
      if (outcome.mark) await markEnd(ctx, outcome, failed)
      return { status: outcome.status, reason: outcome.reason, generation: null, runId: ctx.runId, stats: failed }
    } finally {
      clearTimeout(budget)
      clearInterval(heartbeat)
    }
  }

  // Начало прогона: корни → begin → обход в фоне. Возвращает { started, runId, done } или причину отказа.
  async function launch({ kind, initiator, startedBy = null, slot = null }) {
    if (stopping) return { stopped: true }
    if (current || launching) return { busy: true }
    launching = true
    try {
      await flushPending()
      if (!api.configured) return { notConfigured: true }
      const mode = kind === 'day' && o.dayMode === 'known' ? 'known' : 'full'
      const { sources, codes } = await store.sources(mode)
      if (!sources.length) return { noSources: true }
      const begun = await store.begin(kind, mode, initiator, slot, UUID.test(String(startedBy || '')) ? startedBy : null)
      if (!begun?.runId || !begun?.ownerToken) return { busy: true }
      if (stopping) {
        // Остановка пришла, пока шёл begin: прогон не начинаем и сразу закрываем отметкой.
        await markEnd({ runId: begun.runId, owner: begun.ownerToken }, { status: 'cancelled', reason: 'stopped' }, { roots: [] })
        return { stopped: true }
      }
      const ctx = {
        runId: begun.runId, owner: begun.ownerToken, kind, mode, sources, codes, controller: new AbortController(),
        deadline: now() + o.runBudgetMs, rootDeadline: null, deletedRequests: 0,
      }
      const promise = execute(ctx).finally(() => { current = null })
      current = { controller: ctx.controller, promise, runId: ctx.runId }
      return { started: true, runId: ctx.runId, done: promise }
    } finally { launching = false }
  }

  // Такт: спросить базу, пора ли; если пора — обойти. Не бросает ошибок. Возвращает результат прогона или причину пропуска.
  async function tick() {
    if (stopping) return { skipped: 'stopped' }
    if (current || launching) return { skipped: 'busy' }
    if (isReadOnly()) return { skipped: 'read_only' }
    try {
      await flushPending()
      if (!api.configured) return { skipped: 'not_configured' }
      const due = await store.due(new Date(now()))
      if (!due?.due) return { skipped: 'not_due' }
      const started = await launch({ kind: due.kind === 'night' ? 'night' : 'day', initiator: 'schedule', slot: due.slot ?? null })
      if (started.done) return await started.done
      return { skipped: started.noSources ? 'no_sources' : started.busy ? 'busy' : 'not_started' }
    } catch (err) {
      log.warn({ msg: short(err) }, 'signal tick')
      return { skipped: 'error' }
    }
  }

  // Ручной запуск (админ или команда): полный обход. Ответ — сразу после begin; завершение — в done.
  async function runNow({ initiator = 'admin', startedBy = null } = {}) {
    if (isReadOnly()) return { readOnly: true }
    return launch({ kind: 'manual', initiator, startedBy })
  }

  async function acceptHeld({ runId, expectedGeneration, actor, reason }) {
    if (isReadOnly()) throw new Error('read_only')
    return store.acceptHeld(runId, expectedGeneration, actor, reason)
  }

  function start() {
    if (timer || stopping) return
    first = setTimeout(() => { void tick() }, o.firstDelayMs)
    first.unref?.()
    timer = setInterval(() => { void tick() }, o.tickMs)
    timer.unref?.()
  }

  // Прерывает обход без публикации и ждёт его завершения не дольше stopWaitMs.
  async function stop() {
    stopping = true
    clearTimeout(first)
    clearInterval(timer)
    first = null
    timer = null
    if (!current) return
    current.controller.abort(new RunAbort('stopped'))
    let waiter
    const limit = new Promise((resolve) => { waiter = setTimeout(resolve, o.stopWaitMs); waiter.unref?.() })
    try { await Promise.race([current?.promise?.catch(() => {}), limit]) } finally { clearTimeout(waiter) }
  }

  return { tick, runNow, acceptHeld, start, stop, config: Object.freeze({ ...o }) }
}
