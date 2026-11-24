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
//   • запись пропускается базой, если снимок сменился или договор правили после загрузки (revision / generation): строка
//     очереди остаётся и обрабатывается в следующий такт; ошибка — signal_queue_release с нарастающей паузой;
//   • барьер записи (isReadOnly) и выключенная возможность (isActive) пропускают такт целиком — ни захвата, ни записи.
import { matchContract, nodeQueryFor } from './signalMatch.js'
import { dbUnavailable } from './db.js'

export const SIGNAL_JOBS_FUNCTIONS = Object.freeze([
  'signal_queue_claim', 'signal_queue_release', 'signal_match_load', 'signal_match_nodes', 'signal_state_write',
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
  staleBackoffSeconds: 5,
  stopWaitMs: 10_000,
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
  let failures = 0

  // Один проход: загрузка → узлы → сопоставление. Без записи. → { generation, results, nodes } (results — по договорам загрузки)
  async function compute(ids) {
    const loaded = await store.load(ids)
    const contracts = Array.isArray(loaded?.contracts) ? loaded.contracts : []
    const objects = Array.isArray(loaded?.objects) ? loaded.objects : []
    const entries = contracts.map((contract) => ({ contract, q: nodeQueryFor(contract, { formats }) }))
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
      const r = matchContract({ ...e.contract, nodes, objects }, { formats, generation })
      // Подтверждение человека сохраняется, пока узел тот же и сопоставитель его не оспаривает.
      const prev = e.contract.state
      const reason = r.state === 'verified' && r.reason === 'existing_url' && prev?.state === 'verified' && prev.reason === 'confirmed'
        && prev.confirmedBy && prev.nodeId && prev.nodeId === r.nodeId ? 'confirmed' : r.reason
      const pathOf = (id) => known.get(id)?.path ?? null
      results.push({
        id: e.contract.id, revision: e.contract.revision ?? null, state: r.state, reason, nodeId: r.nodeId, path: r.nodeId ? pathOf(r.nodeId) : null,
        candidates: r.candidates.map((c) => ({ ...c, path: pathOf(c.nodeId) })), fingerprint: r.fingerprint, ctxKey: r.ctxKey,
      })
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
      fingerprint: r.fingerprint, ctxKey: r.ctxKey,
      candidates: r.candidates.map((c) => ({ nodeId: c.nodeId, score: c.score, reasons: c.reasons, flags: c.flags })),
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

  const backoffFor = (n) => o.failureBackoffSeconds[Math.min(Math.max(n, 1), o.failureBackoffSeconds.length) - 1]

  async function releaseQuiet(lease, ids, seconds) {
    try { await store.release(lease, ids, seconds) } catch (err) { log.warn({ msg: short(err) }, 'signal: договоры очереди не возвращены') }
  }

  // Одна порция очереди. → число договоров (0 — очередь пуста).
  async function portion() {
    const claimed = await store.claim(o.batch, o.leaseSeconds)
    const items = Array.isArray(claimed?.items) ? claimed.items : []
    if (!items.length) return 0
    const lease = claimed.leaseToken
    const ids = items.map((i) => i.contractId)
    try {
      const res = await processContracts(ids, { lease })
      failures = 0
      // Договор правили во время расчёта: строка осталась в очереди под нашим захватом — вернуть, чтобы взяли в следующий такт.
      if (res.stale > 0) await releaseQuiet(lease, ids, o.staleBackoffSeconds)
    } catch (err) {
      failures += 1
      log.warn({ code: err?.code, msg: short(err), contracts: ids.length }, 'signal: порция очереди не обработана')
      await releaseQuiet(lease, ids, backoffFor(failures))
      throw err
    }
    return items.length
  }

  // Такт: не бросает ошибок. → { skipped } | { portions, contracts, error? }
  function tick() {
    if (stopping) return Promise.resolve({ skipped: 'stopped' })
    if (running) return Promise.resolve({ skipped: 'busy' })
    if (!isActive()) return Promise.resolve({ skipped: 'inactive' })
    if (isReadOnly()) return Promise.resolve({ skipped: 'read_only' })
    const started = now()
    running = (async () => {
      let portions = 0
      let contracts = 0
      try {
        while (portions < o.maxPortions && now() - started < o.tickBudgetMs && !stopping) {
          if (isReadOnly() || !isActive()) break
          const n = await portion()
          if (!n) break
          portions += 1
          contracts += n
          if (n < o.batch) break
        }
        return { portions, contracts }
      } catch (err) {
        if (dbUnavailable(err)) log.warn({ code: err?.code }, 'signal: база недоступна — очередь подождёт')
        return { portions, contracts, error: err?.code || err?.name || 'error' }
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
// (osp_private.signal_meta.schema_version = 1). Проверка — при запуске и раз в intervalMs; ошибка проверки схемы запуск не
// роняет: нет ответа базы — остаётся прежнее состояние (до первой удачной проверки возможность выключена), повтор через retryMs.
export const SIGNAL_SCHEMA_VERSION = 1
export const SIGNAL_CAPABILITY_DEFAULTS = Object.freeze({ intervalMs: 300_000, retryMs: 30_000 })

export function createSignalCapability({ db, log = silent, onChange = () => {}, options = {} }) {
  if (!db) throw new Error('signalCapability: нужна db')
  const o = { ...SIGNAL_CAPABILITY_DEFAULTS, ...options }
  let active = false
  let checked = false
  let timer = null
  let checking = null
  let stopped = false
  let retry = false // последняя проверка не получила ответа базы

  const readMeta = () => db.read(null, async (tx) => (await tx.query(
    'select schema_version, generation::text as generation, published_at from osp_private.signal_meta where id = 1')).rows[0] ?? null)

  function set(next) {
    const changed = next !== active
    active = next
    checked = true
    if (changed) {
      try { onChange(active) } catch (err) { log.warn({ msg: short(err) }, 'signal: обработчик смены состояния') }
    }
  }

  // → true | false | null (нет ответа базы). Не бросает.
  function refresh() {
    checking ??= (async () => {
      try {
        const row = await readMeta()
        retry = false
        set(Boolean(row) && Number(row.schema_version) === SIGNAL_SCHEMA_VERSION)
        return active
      } catch (err) {
        if (dbUnavailable(err) || dbUnavailable(err?.cause)) {
          log.warn({ code: err?.code }, 'signal: схему проверить не удалось — база не отвечает')
          retry = true
          return null
        }
        // Нет таблицы или схемы — миграция не применена; другой отказ базы — тоже «нет схемы», не отказ запуска.
        retry = false
        if (!checked || active) log.warn({ code: err?.code }, 'signal: схемы сверки в базе нет — возможность выключена')
        set(false)
        return false
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
    refresh,
    // Поколение снимка и время публикации — для «данные на …» (служебное чтение одной строки).
    async meta() {
      const row = await readMeta()
      return { generation: row ? Number(row.generation) : 0, publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null }
    },
    start() { if (!timer && !stopped) schedule(retry ? o.retryMs : o.intervalMs) },
    stop() { stopped = true; clearTimeout(timer); timer = null },
  }
}
