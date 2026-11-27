// Очередь сверки договоров с папками Signal: берёт договоры, у которых что-то менялось, сопоставляет их с опубликованным
// снимком папок и записывает результат. Тот же код считает ответ POST /api/signal/match (раздел 4.4 спецификации).
//
//   const jobs = createSignalJobs({ db, log, isReadOnly, isActive, config })
//   jobs.start()                                  // такт SIGNAL_JOBS_TICK_MS (по умолчанию 15 с)
//   await jobs.tick()                             // один такт: порции по 200 договоров, пока очередь не опустеет
//   await jobs.processContracts(ids)              // /match: без захвата, ревизия — из очереди на момент загрузки
//   await jobs.stop()
//
// Что обещано (tests/osp-api/signal-jobs.test.mjs, signal-match-route.test.mjs):
//   • к Signal очередь не обращается: вход — только снимок в нашей базе (signal_match_load / signal_match_nodes), расчёт —
//     чистые функции signalMatch.js, запись — signal_state_write; ссылку договора (contracts.signal_link) здесь никто не меняет;
//   • «служебные» функции базы вызываются без пользователя (db.read(null) / db.write(null)); каждая операция — отдельная
//     короткая транзакция, между ними в памяти — одна порция (≤ 200 договоров, узлы одной выборки);
//   • результат не зависит от того, как договоры разбиты на порции и группы запросов: сопоставитель получает только те узлы,
//     которые вернул бы запрос именно этого договора (signalMatch.js, scoped); /match и очередь дают один ответ;
//   • запись пропускается базой, если снимок сменился или договор правили после загрузки (revision / generation) либо решение
//     человека опередило расчёт (stateVersion / signalLink, С-15/С-24 — в том числе у /match без строки очереди): строка очереди
//     остаётся и обрабатывается в следующий такт; ошибка порции — по одному договору (С-19), сбойный возвращается через
//     signal_queue_release с нарастающей паузой, после 5 попыток — через час;
//   • расчёт уступает циклу событий (setImmediate) не реже, чем каждые 20 мс работы (С-37): очередь не задерживает запросы
//     пользователей; раз в 10 минут такт ставит в очередь договоры, правку которых пропустил триггер (С-16);
//   • барьер записи (isReadOnly) и выключенная возможность (isActive) пропускают такт целиком — ни захвата, ни записи.
import { performance } from 'node:perf_hooks'
import { matchContract, nodeQueryFor } from './signalMatch.js'
import { dbUnavailable } from './db.js'

export const SIGNAL_JOBS_FUNCTIONS = Object.freeze([
  'signal_queue_claim', 'signal_queue_release', 'signal_match_load', 'signal_match_nodes', 'signal_state_write', 'signal_enqueue_missed',
])
export const SIGNAL_JOBS_DEFAULTS = Object.freeze({
  jobsTickMs: 15_000,
  firstDelayMs: 5_000,
  batch: 200, // договоров в порции
  leaseSeconds: 180,
  maxPortions: 10, // порций за такт
  tickBudgetMs: 20_000,
  nodesLimit: 2000, // предел signal_match_nodes
  groupContracts: 50, // договоров в одной группе запросов узлов
  groupTerms: 190, // предел базы — 200 терминов, 1000 ключей, объектов и «под папкой»
  groupKeys: 900,
  failureBackoffSeconds: Object.freeze([30, 120, 600, 1800]),
  poisonAttempts: 5, // С-19: после стольких неудач подряд договор возвращается в очередь не раньше чем через poisonBackoffSeconds
  poisonBackoffSeconds: 3600,
  failureStreakStop: 5, // подряд сбоев договоров порции — причина общая (база, запись): остальные возвращаются, не перебираются
  staleBackoffSeconds: 5,
  stopWaitMs: 10_000,
  sliceMs: 20, // С-37: дольше этого срока непрерывной работы расчёт уступает циклу событий
  enqueueMissedMs: 600_000, // С-16: договоры, у которых правку пропустил триггер, ставятся в очередь раз в 10 минут
})

const silent = { info() {}, warn() {} }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const short = (err) => String(err?.message || err || 'сбой').replace(/\s+/g, ' ').slice(0, 200)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const uniq = (list) => [...new Set(list)]

class GenerationDrift extends Error {
  constructor() { super('generation_drift'); this.name = 'GenerationDrift' }
}

// Служебные функции базы (вход сопоставления и запись результата). Единственная точка вызова этих функций — этот файл и
// маршрут confirm/reject/unlink через jobs.store.
export function createSignalStore(db) {
  const call = (mode, name, args, opts) => {
    if (!SIGNAL_JOBS_FUNCTIONS.includes(name)) throw new Error(`signal: функция ${name} не из набора очереди`)
    const marks = args.map((a, i) => `$${i + 1}::${a.type}`).join(', ')
    return db[mode](null, async (tx) => (await tx.query(`select osp_private.${name}(${marks}) as r`, args.map((a) => a.v))).rows[0]?.r ?? null, opts)
  }
  const a = (v, type) => ({ v, type })
  return Object.freeze({
    claim: (limit, leaseSeconds) => call('write', 'signal_queue_claim', [a(limit, 'int'), a(leaseSeconds, 'int')]),
    release: (lease, ids, backoffSeconds) => call('write', 'signal_queue_release', [a(lease, 'uuid'), a(ids, 'uuid[]'), a(backoffSeconds, 'int')]),
    // → { generation, objects, contracts }
    load: (ids) => call('read', 'signal_match_load', [a(ids, 'uuid[]')]),
    // sel = { nodeIds, numberKeys, objectIds, terms, under } → { generation, truncated, nodes }
    nodes: (sel, limit) => call('read', 'signal_match_nodes', [
      a(sel.nodeIds || [], 'uuid[]'), a(sel.numberKeys || [], 'text[]'), a(sel.objectIds || [], 'uuid[]'), a(sel.terms || [], 'text[]'),
      a(sel.under || [], 'uuid[]'), a(limit, 'int'),
    ]),
    // → { written, acked, stale }
    write: (lease, items) => call('write', 'signal_state_write', [a(lease ?? null, 'uuid'), a(JSON.stringify(items), 'jsonb')]),
    // С-16 → число поставленных в очередь договоров (правка новее состояния, строки очереди нет).
    enqueueMissed: () => call('write', 'signal_enqueue_missed', []),
  })
}

const hasSelectors = (q) => q.numberKeys.length > 0 || q.terms.length > 0 || q.under.length > 0

// Группы запросов узлов: у каждой — пределы базы (термины, ключи, «под папкой», объекты) и не больше groupContracts договоров.
function groupEntries(entries, o) {
  const groups = []
  let cur = null
  for (const e of entries) {
    const next = {
      terms: cur ? new Set([...cur.terms, ...e.q.terms]) : new Set(e.q.terms),
      keys: cur ? new Set([...cur.keys, ...e.q.numberKeys]) : new Set(e.q.numberKeys),
      under: cur ? new Set([...cur.under, ...e.q.under]) : new Set(e.q.under),
      objects: cur ? new Set([...cur.objects, ...e.q.objectIds]) : new Set(e.q.objectIds),
    }
    const fits = cur && cur.entries.length < o.groupContracts && next.terms.size <= o.groupTerms && next.keys.size <= o.groupKeys
      && next.under.size <= o.groupKeys && next.objects.size <= o.groupKeys
    if (!fits) {
      cur = { entries: [], terms: new Set(e.q.terms), keys: new Set(e.q.numberKeys), under: new Set(e.q.under), objects: new Set(e.q.objectIds) }
      groups.push(cur)
    } else {
      cur.terms = next.terms
      cur.keys = next.keys
      cur.under = next.under
      cur.objects = next.objects
    }
    cur.entries.push(e)
  }
  return groups
}

const selectorsOf = (g) => ({
  numberKeys: [...g.keys].sort(cmp), objectIds: [...g.objects].sort(cmp), terms: [...g.terms].sort(cmp), under: [...g.under].sort(cmp),
})

// С-37: уступка циклу событий. Часы — реальные (performance.now), а не подменяемые тестом now: срок работы измеряется на самом процессе.
const clock = () => performance.now()
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
function createYielder(sliceMs) {
  let since = clock()
  return async () => {
    if (clock() - since < sliceMs) return
    await nextTurn()
    since = clock()
  }
}

export function createSignalJobs({ db, log = silent, isReadOnly = () => false, isActive = () => true, config = {}, now = Date.now }) {
  if (!db) throw new Error('signalJobs: нужна db')
  const o = { ...SIGNAL_JOBS_DEFAULTS }
  for (const key of Object.keys(SIGNAL_JOBS_DEFAULTS)) if (config?.[key] !== undefined && config[key] !== null) o[key] = config[key]
  const formats = Array.isArray(config?.urlFormats) ? config.urlFormats : []
  const store = createSignalStore(db)

  let timer = null
  let first = null
  let running = null // выполняющийся такт
  let stopping = false

  // Один проход: загрузка → узлы → сопоставление. Без записи. → { generation, results, nodes } (results — по договорам загрузки)
  async function compute(ids) {
    const loaded = await store.load(ids)
    const contracts = Array.isArray(loaded?.contracts) ? loaded.contracts : []
    const objects = Array.isArray(loaded?.objects) ? loaded.objects : []
    const pause = createYielder(o.sliceMs)
    const entries = []
    for (const contract of contracts) {
      entries.push({ contract, q: nodeQueryFor(contract, { formats }) })
      await pause()
    }
    const known = new Map() // nodeId → узел (все полученные, для путей в ответе)
    const generations = []
    const remember = (res) => {
      generations.push(Number(res.generation))
      for (const n of res.nodes || []) known.set(n.nodeId, n)
    }

    // Узлы по id (ссылки договоров и узлы корневых ДП) — отдельным запросом: их мало, и усечение выборки поиска их не заденет.
    const idNodes = new Map()
    const wantIds = uniq(entries.flatMap((e) => e.q.nodeIds)).sort(cmp)
    const step = Math.max(1, Math.min(1000, o.nodesLimit))
    for (let i = 0; i < wantIds.length; i += step) {
      const res = await store.nodes({ nodeIds: wantIds.slice(i, i + step) }, o.nodesLimit)
      remember(res)
      for (const n of res.nodes || []) idNodes.set(n.nodeId, n)
    }

    // Поиск по номерам, названиям сторон, объектам и «под папкой»: группами; усечённая группа — по каждому договору отдельно.
    const searched = new Map() // contract.id → узлы поиска
    const withSel = entries.filter((e) => hasSelectors(e.q))
    for (const g of groupEntries(withSel, o)) {
      const res = await store.nodes(selectorsOf(g), o.nodesLimit)
      remember(res)
      if (!res.truncated) {
        for (const e of g.entries) searched.set(e.contract.id, res.nodes || [])
        continue
      }
      for (const e of g.entries) {
        const one = await store.nodes({ numberKeys: e.q.numberKeys, objectIds: e.q.objectIds, terms: e.q.terms, under: e.q.under }, o.nodesLimit)
        remember(one)
        if (one.truncated) log.warn({ contract: e.contract.id }, 'signal: выборка узлов договора усечена — список предложений неполный')
        searched.set(e.contract.id, one.nodes || [])
      }
    }

    // Снимок мог смениться между запросами: узлы из разных поколений не смешиваем.
    if (new Set(generations).size > 1) throw new GenerationDrift()
    const generation = generations.length ? generations[0] : Number(loaded?.generation ?? 0)

    const results = []
    for (const e of entries) {
      const seen = new Set()
      const nodes = []
      for (const id of e.q.nodeIds) {
        const n = idNodes.get(id)
        if (n && !seen.has(n.nodeId)) { seen.add(n.nodeId); nodes.push(n) }
      }
      for (const n of searched.get(e.contract.id) || []) if (!seen.has(n.nodeId)) { seen.add(n.nodeId); nodes.push(n) }
      // «verified:confirmed» (решение человека) сохраняет сам сопоставитель: ему нужен state.confirmedBy из входа.
      const r = matchContract({ ...e.contract, nodes, objects }, { formats, generation })
      // Пользователю — путь от границы объекта (К-1, С-21); полный путь узла в ответы не попадает.
      const pathOf = (id) => { const n = known.get(id); return n ? (n.objectPath ?? n.path ?? null) : null }
      results.push({
        id: e.contract.id, revision: e.contract.revision ?? null, state: r.state, reason: r.reason, nodeId: r.nodeId, path: r.nodeId ? pathOf(r.nodeId) : null,
        candidates: r.candidates.map((c) => ({ ...c, path: pathOf(c.nodeId) })), fingerprint: r.fingerprint, ctxKey: r.ctxKey,
        // Как их видел расчёт: база пропускает запись, если решение человека (Отвязать / Подтвердить) опередило её (С-15, С-24).
        stateVersion: Number(e.contract.stateVersion ?? 0), signalLink: e.contract.signalLink ?? null,
      })
      await pause()
    }
    return { generation, results }
  }

  // Договоры (≤ batch) → расчёт и запись. Ошибка — исключение: вызывающий решает, что делать со строками очереди.
  async function processChunk(ids, lease) {
    let done
    try {
      done = await compute(ids)
    } catch (err) {
      if (!(err instanceof GenerationDrift)) throw err
      done = await compute(ids) // публикация шла прямо сейчас — один повтор
    }
    const items = done.results.map((r) => ({
      contractId: r.id, revision: r.revision, generation: done.generation, state: r.state, reason: r.reason, nodeId: r.nodeId,
      fingerprint: r.fingerprint, ctxKey: r.ctxKey, stateVersion: r.stateVersion, signalLink: r.signalLink,
      candidates: r.candidates.map((c) => ({ nodeId: c.nodeId, score: c.score, reasons: c.reasons, flags: c.flags, nodeKey: c.nodeKey ?? null })),
    }))
    const written = items.length ? await store.write(lease, items) : { written: 0, acked: 0, stale: 0 }
    return { generation: done.generation, results: done.results, written }
  }

  // Уникальные идентификаторы договоров → результаты (по порядку загрузки базы) и итог записи. lease — захват очереди (без него
  // ответ /match: база подтвердит строку очереди той же ревизии, если она есть).
  async function processContracts(ids, { lease = null } = {}) {
    const list = uniq((ids || []).map((id) => String(id).toLowerCase()))
    if (list.some((id) => !UUID.test(id))) throw new TypeError('signalJobs: идентификатор договора — uuid')
    const out = { generation: null, results: [], written: 0, acked: 0, stale: 0 }
    for (let i = 0; i < list.length; i += o.batch) {
      const part = await processChunk(list.slice(i, i + o.batch), lease)
      out.generation = part.generation
      out.results.push(...part.results)
      out.written += part.written?.written ?? 0
      out.acked += part.written?.acked ?? 0
      out.stale += part.written?.stale ?? 0
    }
    return out
  }

  // Неудачи по договорам: в памяти процесса (после перезапуска счёт начинается заново — пауза снова короткая, договор не теряется).
  const failedBefore = new Map()
  const backoffFor = (n) => (n >= o.poisonAttempts ? o.poisonBackoffSeconds : o.failureBackoffSeconds[Math.min(Math.max(n, 1), o.failureBackoffSeconds.length) - 1])

  async function releaseQuiet(lease, ids, seconds) {
    try { await store.release(lease, ids, seconds) } catch (err) { log.warn({ msg: short(err) }, 'signal: договоры очереди не возвращены') }
  }

  // Сбойные договоры возвращаются в очередь, каждый со своей паузой (30 с, 2 мин, 10 мин, 30 мин, после пяти неудач — час).
  async function releaseFailed(lease, ids) {
    const bySeconds = new Map()
    for (const id of ids) {
      const n = (failedBefore.get(id) ?? 0) + 1
      failedBefore.delete(id)
      failedBefore.set(id, n)
      const seconds = backoffFor(n)
      if (!bySeconds.has(seconds)) bySeconds.set(seconds, [])
      bySeconds.get(seconds).push(id)
    }
    if (failedBefore.size > 20_000) for (const key of [...failedBefore.keys()].slice(0, failedBefore.size - 10_000)) failedBefore.delete(key)
    for (const [seconds, list] of bySeconds) await releaseQuiet(lease, list, seconds)
  }

  // Одна порция очереди. → { n, failed, error?, systemic? } (n — договоров взято; 0 — очередь пуста).
  // Ошибка порции (С-19) не бросает остальных договоров под один откат: порция разбирается по одному договору, сбойный
  // возвращается с паузой. Недоступная база или общая причина (подряд failureStreakStop сбоев) — остановка такта.
  async function portion() {
    const claimed = await store.claim(o.batch, o.leaseSeconds)
    const items = Array.isArray(claimed?.items) ? claimed.items : []
    if (!items.length) return { n: 0, failed: 0 }
    const lease = claimed.leaseToken
    const ids = items.map((i) => i.contractId)
    try {
      const res = await processContracts(ids, { lease })
      for (const id of ids) failedBefore.delete(id)
      // Договор правили во время расчёта: строка осталась в очереди под нашим захватом — вернуть, чтобы взяли в следующий такт.
      if (res.stale > 0) await releaseQuiet(lease, ids, o.staleBackoffSeconds)
      return { n: items.length, failed: 0 }
    } catch (err) {
      log.warn({ code: err?.code, msg: short(err), contracts: ids.length }, 'signal: порция очереди не обработана')
      if (dbUnavailable(err) || dbUnavailable(err?.cause)) {
        await releaseFailed(lease, ids)
        throw err
      }
      if (ids.length === 1) {
        await releaseFailed(lease, ids)
        return { n: 1, failed: 1, error: err?.code || err?.name || 'error' }
      }
      return pieceByPiece(lease, ids, err)
    }
  }

  async function pieceByPiece(lease, ids, firstErr) {
    const failed = []
    const retryLater = []
    let lastCode = firstErr?.code || firstErr?.name || 'error'
    let streak = 0
    let systemic = false
    for (let i = 0; i < ids.length; i++) {
      if (stopping || isReadOnly() || !isActive()) { retryLater.push(...ids.slice(i)); break }
      try {
        const res = await processContracts([ids[i]], { lease })
        streak = 0
        failedBefore.delete(ids[i])
        if (res.stale > 0) retryLater.push(ids[i])
      } catch (err) {
        if (dbUnavailable(err) || dbUnavailable(err?.cause)) {
          await releaseFailed(lease, ids.slice(i))
          throw err
        }
        lastCode = err?.code || err?.name || 'error'
        log.warn({ code: err?.code, msg: short(err) }, 'signal: договор очереди не обработан')
        failed.push(ids[i])
        streak += 1
        if (streak >= o.failureStreakStop) { failed.push(...ids.slice(i + 1)); systemic = true; break }
      }
    }
    if (failed.length) await releaseFailed(lease, failed)
    if (retryLater.length) await releaseQuiet(lease, retryLater, o.staleBackoffSeconds)
    return { n: ids.length, failed: failed.length, error: failed.length ? lastCode : undefined, systemic }
  }

  // С-16: правка договора новее состояния, а строки очереди нет (триггер не отработал) — договор ставится в очередь. Не бросает.
  let missedAt = null
  async function enqueueMissed() {
    const at = now()
    if (missedAt !== null && at - missedAt < o.enqueueMissedMs) return 0
    missedAt = at
    try {
      const n = Number(await store.enqueueMissed())
      return Number.isFinite(n) ? n : 0
    } catch (err) {
      log.warn({ code: err?.code, msg: short(err) }, 'signal: пропущенные правки договоров не поставлены в очередь')
      return 0
    }
  }

  // Такт: не бросает ошибок. → { skipped } | { portions, contracts, failed?, missed?, error? }
  function tick() {
    if (stopping) return Promise.resolve({ skipped: 'stopped' })
    if (running) return Promise.resolve({ skipped: 'busy' })
    if (!isActive()) return Promise.resolve({ skipped: 'inactive' })
    if (isReadOnly()) return Promise.resolve({ skipped: 'read_only' })
    const started = now()
    running = (async () => {
      let portions = 0
      let contracts = 0
      let failed = 0
      let error
      const report = (extra = {}) => ({ portions, contracts, ...(failed ? { failed } : {}), ...(error ? { error } : {}), ...extra })
      try {
        const missed = await enqueueMissed()
        while (portions < o.maxPortions && now() - started < o.tickBudgetMs && !stopping) {
          if (isReadOnly() || !isActive()) break
          const part = await portion()
          if (!part.n) break
          portions += 1
          contracts += part.n - part.failed
          failed += part.failed
          if (part.error) error = part.error
          if (part.systemic || part.n < o.batch) break
        }
        return report(missed ? { missed } : {})
      } catch (err) {
        if (dbUnavailable(err)) log.warn({ code: err?.code }, 'signal: база недоступна — очередь подождёт')
        return report({ error: err?.code || err?.name || 'error' })
      }
    })().finally(() => { running = null })
    return running
  }

  function start() {
    if (timer || stopping) return
    first = setTimeout(() => { void tick() }, Math.min(o.firstDelayMs, o.jobsTickMs))
    first.unref?.()
    timer = setInterval(() => { void tick() }, o.jobsTickMs)
    timer.unref?.()
  }

  async function stop() {
    stopping = true
    clearTimeout(first)
    clearInterval(timer)
    first = null
    timer = null
    if (!running) return
    let waiter
    const limit = new Promise((resolve) => { waiter = setTimeout(resolve, o.stopWaitMs); waiter.unref?.() })
    try { await Promise.race([running.catch(() => {}), limit]) } finally { clearTimeout(waiter) }
  }

  return { tick, processContracts, start, stop, store, config: Object.freeze({ ...o }) }
}

// Возможность «сверка с Signal»: включена настройкой (SIGNAL_SYNC=1, проверяет config.js), и в базе есть схема нужной версии
// (osp_private.signal_meta.schema_version = 1). Проверка — при запуске и раз в intervalMs. Выключает сверку только «нет схемы»
// (С-25: 42P01 — нет таблицы, 42883 — нет функции, 3F000 — нет схемы, либо строки/версии схемы нет); любая другая ошибка проверки
// (lock_timeout 55P03, 57014, 53300, обрыв связи…) — повтор через retryMs, состояние прежнее: идущий обход не отменяется, маршруты
// не мигают. До первой удачной проверки возможность выключена (причина db_error). Причина выключения — reason(): no_schema | db_error.
export const SIGNAL_SCHEMA_VERSION = 1
export const SIGNAL_CAPABILITY_DEFAULTS = Object.freeze({ intervalMs: 300_000, retryMs: 30_000 })
export const SIGNAL_NO_SCHEMA_CODES = Object.freeze(['42P01', '42883', '3F000'])
const NO_SCHEMA = new Set(SIGNAL_NO_SCHEMA_CODES)

export function createSignalCapability({ db, log = silent, onChange = () => {}, options = {} }) {
  if (!db) throw new Error('signalCapability: нужна db')
  const o = { ...SIGNAL_CAPABILITY_DEFAULTS, ...options }
  let active = false
  let checked = false
  let timer = null
  let checking = null
  let stopped = false
  let retry = false // последняя проверка не получила ответа базы
  let why = 'db_error' // причина выключенного состояния: no_schema — схемы нет; db_error — проверить не удалось

  // data_at — дата данных (наименьший last_ok_at включённых готовых корней); схема без таблицы корней сюда не доходит.
  const readMeta = () => db.read(null, async (tx) => (await tx.query(
    `select schema_version, generation::text as generation, published_at,
            (select min(s.last_ok_at) from osp_private.signal_sources s where s.enabled and s.ready) as data_at
       from osp_private.signal_meta where id = 1`)).rows[0] ?? null)

  function set(next, reason = null) {
    const changed = next !== active
    active = next
    checked = true
    why = next ? null : reason
    if (changed) {
      try { onChange(active) } catch (err) { log.warn({ msg: short(err) }, 'signal: обработчик смены состояния') }
    }
  }

  const noSchema = (err) => NO_SCHEMA.has(String(err?.code || '')) || NO_SCHEMA.has(String(err?.cause?.code || ''))

  // → true | false | null (нет ответа базы или ошибка проверки — состояние прежнее). Не бросает.
  function refresh() {
    checking ??= (async () => {
      try {
        const row = await readMeta()
        retry = false
        set(Boolean(row) && Number(row.schema_version) === SIGNAL_SCHEMA_VERSION, 'no_schema')
        return active
      } catch (err) {
        if (noSchema(err)) {
          retry = false
          if (!checked || active) log.warn({ code: err?.code }, 'signal: схемы сверки в базе нет — возможность выключена')
          set(false, 'no_schema')
          return false
        }
        // Связь, блокировка, таймаут, лимит соединений: схема не опровергнута — прежнее состояние, повтор скоро.
        retry = true
        if (!checked) why = 'db_error'
        log.warn({ code: err?.code || err?.cause?.code }, 'signal: схему проверить не удалось — состояние прежнее, повтор скоро')
        return null
      }
    })().finally(() => { checking = null })
    return checking
  }

  function schedule(ms) {
    if (stopped) return
    timer = setTimeout(async () => {
      await refresh()
      schedule(retry ? o.retryMs : o.intervalMs)
    }, ms)
    timer.unref?.()
  }

  return {
    active: () => active,
    checked: () => checked,
    reason: () => (active ? null : why),
    refresh,
    // Поколение снимка, время публикации и дата данных — для «данные на …» (служебное чтение одной строки).
    async meta() {
      const row = await readMeta()
      const at = (v) => (v ? new Date(v).toISOString() : null)
      return { generation: row ? Number(row.generation) : 0, publishedAt: at(row?.published_at), dataAt: at(row?.data_at) }
    },
    start() { if (!timer && !stopped) schedule(retry ? o.retryMs : o.intervalMs) },
    stop() { stopped = true; clearTimeout(timer); timer = null },
  }
}

// Выключенная возможность без проверки базы (config_invalid, В-8): маршруты отвечают «выключено», таймеры не стартуют.
export function createDisabledCapability(reason) {
  return {
    active: () => false,
    checked: () => true,
    reason: () => reason,
    refresh: async () => false,
    async meta() { return { generation: 0, publishedAt: null, dataAt: null } },
    start() {},
    stop() {},
  }
}
