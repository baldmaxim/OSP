// Синхронизация SIGNAL → наша база: обход корней, запись порциями в staging и публикация снимка.
//
//   const sync = createSignalSync({ db, api, isReadOnly, log, config, now })
//   sync.start()                      // такт SIGNAL_TICK_MS (по умолчанию 5 мин)
//   const run = await sync.runNow({ initiator: 'admin', startedBy })   // → { runId, done } | { busy } | …
//   await sync.stop()                 // прерывает обход без публикации, ждёт не больше 10 с
//
// Что обещано (tests/osp-api/signal-sync.test.mjs, раздел 4 спецификации):
//   • в SIGNAL — только чтение через адаптер (signalApi.js); в нашей базе — только служебные функции osp_private.signal_*
//     через db.write(null, …) / db.read(null, …); других обращений к таблицам нет;
//   • расписание решает база (signal_sync_due, Europe/Moscow): такт лишь спрашивает; ночной обход — всегда полный,
//     дневной — SIGNAL_DAY_MODE (полный или только известные папки), ручной — полный;
//   • ни одной открытой транзакции во время обращения к SIGNAL и ожидания Retry-After: каждая запись — своя короткая
//     операция; в памяти — дерево одного проекта и одна страница элементов, запись порциями не больше 500 строк;
//   • владелец прогона — токен, выданный signal_sync_begin; heartbeat каждые ≤ 30 с отдельной короткой записью,
//     в том числе пока идёт ожидание 429; потеря владения останавливает обход;
//   • барьер записи isReadOnly() проверяется перед каждой порцией и перед публикацией: прогон отменяется без записи
//     (отметка «отменён» в базе ставится позже, когда барьер снят, либо её поставит очистка зависших прогонов);
//   • любой сбой, held и отмена не меняют опубликованный снимок: публикует только signal_sync_finish, одной транзакцией;
//   • в журнале и результатах — только идентификаторы корней, коды и счётчики, без имён и путей.
import { SignalError } from './signalClient.js'
import { dbUnavailable } from './db.js'
import { prepareNode as defaultPrepare } from './signalMatch.js'

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
    sources: async (mode) => {
      const r = await call('read', 'signal_sources_for_sync', [a(mode === 'known' ? 'known' : 'full', 'text')])
      return Array.isArray(r?.sources) ? r.sources : []
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
  // parentId = null и pathIds = [], у потомков pathIds начинается с корня.
  function rowOf(n, { source, listed }) {
    const prepared = prepareNode({ name: n.name, path: n.path, kind: n.kind }) || {}
    return {
      nodeId: n.nodeId, projectId: source.projectId, sourceId: source.id, kind: n.kind, parentId: n.parentId,
      name: n.name, path: n.path, pathIds: n.pathIds, depth: n.depth, modifiedAt: n.modifiedAt, itemType: n.itemType,
      versionNumber: n.versionNumber, deleted: n.deleted,
      numberKeys: prepared.numberKeys ?? [], nameNorm: prepared.nameNorm ?? '', features: prepared.features ?? {},
      itemsListed: listed,
    }
  }

  async function stageRows(ctx, rows) {
    for (let i = 0; i < rows.length; i += o.stageChunk) {
      ensureActive(ctx)
      guardWrite()
      await store.stagePut(ctx.runId, ctx.owner, rows.slice(i, i + o.stageChunk))
    }
  }

  // Папки, элементы которых перечисляются: полный обход — все; known — со связью/кандидатом и новые (нет в снимке).
  function listedFolders(source, mode, folders) {
    if (mode !== 'known') return null
    const known = new Set((source.knownFolderIds || []).map(idOf))
    const published = new Set((source.folderIds || []).map(idOf))
    return new Set(folders.filter((f) => known.has(f.nodeId) || !published.has(f.nodeId)).map((f) => f.nodeId))
  }

  async function listFolderItems(ctx, source, folder, counters) {
    let skip = 0
    let previous = new Set()
    for (;;) {
      ensureActive(ctx)
      // G2: запрос идёт с deleted=false (выжимка API), поэтому удалённые элементы не приходят и missing:deleted в MVP
      // не возникает; исчезновение узла ловит правило Ф2 (две ночи подряд).
      const page = await api.listItems(folder.nodeId, { skip, take: o.pageSize }, { signal: ctx.controller.signal })
      if (!page.length) return
      // Повтор страницы (курсор не сдвинулся) — ответ не тот, что ждём.
      if (page.some((item) => previous.has(item.nodeId))) throw new SyncFail('invalid')
      counters.total += page.length
      if (counters.total > o.maxNodes) throw new SyncFail('limit')
      previous = new Set(page.map((item) => item.nodeId))
      const rows = page.map((item) => rowOf({
        ...item, path: `${folder.path} / ${item.name}`, pathIds: [...folder.pathIds, folder.nodeId], depth: folder.depth + 1,
      }, { source, listed: false }))
      await stageRows(ctx, rows)
      counters.items += page.length
      if (page.length < o.pageSize) return
      skip += page.length
    }
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
    const listed = listedFolders(source, ctx.mode, subtree)
    const entry = { id: source.id, status: 'ok', folders: subtree.length, items: 0, listed: 0 }
    await stageRows(ctx, subtree.map((n) => rowOf(n, { source, listed: listed === null || listed.has(n.nodeId) })))
    const counters = { total: subtree.length, items: 0 }
    for (const folder of subtree) {
      if (listed !== null && !listed.has(folder.nodeId)) continue
      await listFolderItems(ctx, source, folder, counters)
      entry.listed += 1
      entry.items = counters.items
    }
    stats.roots.push(entry)
    ctx.active = []
  }

  // Дерево проекта — один запрос на проект, даже если в проекте несколько корней. ctx.active — корни, над которыми
  // идёт работа (при сбое именно их отметит signal_sync_fail в last_error).
  async function walk(ctx, stats) {
    const byProject = new Map()
    for (const source of ctx.sources) {
      const key = idOf(source.projectId)
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push({ ...source, projectId: key, folderId: idOf(source.folderId) })
    }
    for (const [projectId, group] of byProject) {
      ensureActive(ctx)
      ctx.active = group.map((s) => s.id)
      let tree
      try {
        tree = await api.getFolderTree(projectId, { signal: ctx.controller.signal })
      } catch (err) {
        if (err instanceof SignalError && err.code === 'http' && err.status === 404) throw new SyncFail('root_unavailable')
        throw err
      }
      const byId = new Map(tree.map((n) => [n.nodeId, n]))
      for (const source of group) {
        ctx.active = [source.id]
        const root = byId.get(source.folderId)
        if (!root) throw new SyncFail('root_missing')
        await syncRoot(ctx, source, root, tree, stats)
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
    return { roots }
  }

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
      const fin = await store.finish(ctx.runId, ctx.owner, stats, false)
      const result = { status: fin?.status === 'held' ? 'held' : 'ok', reason: fin?.reason ?? null, generation: fin?.generation ?? null, runId: ctx.runId, stats }
      log.info({ runId: ctx.runId, status: result.status, reason: result.reason, generation: result.generation, roots: stats.roots }, 'signal sync')
      return result
    } catch (err) {
      const outcome = outcomeOf(err, ctx)
      const failed = failedStats(stats, ctx, err, outcome)
      log.warn({ runId: ctx.runId, status: outcome.status, reason: outcome.reason, roots: failed.roots }, 'signal sync stopped')
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
      const sources = await store.sources(mode)
      if (!sources.length) return { noSources: true }
      const begun = await store.begin(kind, mode, initiator, slot, UUID.test(String(startedBy || '')) ? startedBy : null)
      if (!begun?.runId || !begun?.ownerToken) return { busy: true }
      if (stopping) {
        // Остановка пришла, пока шёл begin: прогон не начинаем и сразу закрываем отметкой.
        await markEnd({ runId: begun.runId, owner: begun.ownerToken }, { status: 'cancelled', reason: 'stopped' }, { roots: [] })
        return { stopped: true }
      }
      const ctx = {
        runId: begun.runId, owner: begun.ownerToken, kind, mode, sources, controller: new AbortController(),
        deadline: now() + o.runBudgetMs,
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
