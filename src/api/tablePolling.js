// Онлайн-обновления без Supabase Realtime: таблица периодически сверяется, и по разнице со снимком
// собираются те же события, что присылал Realtime — { eventType, new, old }. Компоненты и хук
// useRealtimeTable не меняются; отличие одно — событие приходит не сразу, а в пределах интервала.
// Временный механизм до серверной ленты изменений. Модуль чистый — tests/osp-api/client-db.test.mjs.
//
// Сколько это стоит серверу. Раньше каждая видимая вкладка раз в 20 с читала таблицу целиком (все строки и
// колонки: у «Тендеров» — семь запросов и 3 МБ JSON через шлюз, PostgREST и сжатие) — и всё ради одной-двух
// правок в минуту. Теперь снимок читается целиком один раз при открытии и раз в полчаса — страховка; за такт
// сверяются только id и отметка времени строк, изменившихся с прошлого раза (обычно пустой ответ), сами строки
// читаются лишь у изменившихся, удаления видны по числу строк.
//
// Почему это надёжно. Отметку времени ставит триггер базы (now() транзакции), а не браузер. Транзакция, начатая
// раньше уже увиденной отметки, может завершиться позже неё, поэтому первые overlapMs после новой отметки
// окно сверки шире на overlapMs (дольше транзакция жить не может: у запросов таймаут меньше минуты, у служебных —
// три минуты). Время — только сервера; часы браузера лишь считают, сколько прошло. Колонки отметки нет (база раньше
// миграции) или в ней пусто — читаем целиком, как раньше.

export const POLL_INTERVAL_MS = 20_000
export const OVERLAP_MS = 5 * 60_000
export const RESYNC_MS = 30 * 60_000
// Число строк (удаления) — раз в три такта: удаление редкое, минута задержки ему не мешает.
export const COUNT_EVERY = 3
// Пользователь не трогает страницу — опрашиваем в пять раз реже: монитор с открытым порталом весь день без человека.
export const IDLE_EVERY = 5
const PAGE = 1000
// id в одном запросе: адрес шлюза ≤ 8 КБ, а uuid с запятой — 37 знаков.
const ID_CHUNK = 100

// Какой колонкой отмечено изменение. Сообщения обсуждения не правятся, у них есть только created_at.
const STAMP_COLUMN = { contract_clause_comments: 'created_at' }
export const stampColumn = (table) => STAMP_COLUMN[table] || 'updated_at'

function snapshotEntry(row) {
  return { row, text: JSON.stringify(row) }
}

// Снимок: id → строка. Событие по каждой появившейся, изменившейся и пропавшей строке.
export function diffSnapshots(previous, rows) {
  const next = new Map()
  const events = []
  for (const row of rows) {
    if (row?.id == null) continue
    const key = String(row.id)
    const entry = snapshotEntry(row)
    next.set(key, entry)
    const old = previous?.get(key)
    if (!previous) continue
    if (!old) events.push({ eventType: 'INSERT', new: row, old: {} })
    else if (old.text !== entry.text) events.push({ eventType: 'UPDATE', new: row, old: old.row })
  }
  if (previous) {
    for (const [key, old] of previous) if (!next.has(key)) events.push({ eventType: 'DELETE', new: {}, old: old.row })
  }
  return { snapshot: next, events }
}

// Фильтр подписки в виде Realtime: «колонка=eq.значение». Иное — не поддерживается (таких подписок нет).
export function parseFilter(filter) {
  if (!filter) return null
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)$/.exec(filter)
  if (!m) throw new Error(`Фильтр подписки не поддерживается: ${filter}`)
  return { column: m[1], value: m[2] }
}

async function fetchPaged(makeQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

// Все строки таблицы (под правами пользователя), постранично.
export function fetchTableRows(client, { table, filter, columns = '*' }) {
  const eq = parseFilter(filter)
  return fetchPaged(() => {
    const query = client.from(table).select(columns).order('id', { ascending: true })
    return eq ? query.eq(eq.column, eq.value) : query
  })
}

// Чтение подписки. columns — какие колонки нужны странице (без отметки: её добавляем сами); не задано — все.
// getClient — функция: клиент зависит от флага, который переключается в открытой вкладке.
export function createTableReader(getClient, { table, filter = null, columns = null }) {
  const column = stampColumn(table)
  const eq = parseFilter(filter)
  let stampMissing = false
  const narrowed = (query) => (eq ? query.eq(eq.column, eq.value) : query)
  const fullColumns = () => (columns ? (stampMissing ? columns : `${columns},${column}`) : '*')

  const all = async () => {
    try {
      return await fetchTableRows(getClient(), { table, filter, columns: fullColumns() })
    } catch (err) {
      // Колонки отметки ещё нет (база раньше миграции): тот же список без неё.
      if (!columns || stampMissing || err?.code !== '42703') throw err
      stampMissing = true
      return fetchTableRows(getClient(), { table, filter, columns: fullColumns() })
    }
  }
  const delta = {
    column,
    stamps: (sinceIso) => fetchPaged(() => narrowed(getClient().from(table).select(`id,${column}`).gte(column, sinceIso))
      .order(column, { ascending: true }).order('id', { ascending: true })),
    byIds: async (ids) => {
      const parts = []
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await narrowed(getClient().from(table).select(fullColumns()).in('id', ids.slice(i, i + ID_CHUNK)))
        if (error) throw error
        parts.push(...(data || []))
      }
      return parts
    },
    count: async () => {
      const { count, error } = await narrowed(getClient().from(table).select('id', { count: 'exact', head: true }))
      if (error) throw error
      return count
    },
    ids: async () => (await fetchPaged(() => narrowed(getClient().from(table).select('id')).order('id', { ascending: true }))).map((r) => r.id),
  }
  return { all, delta }
}

// Наибольшая отметка времени снимка, мс; нет ни одной — null.
function newestStamp(rows, column) {
  let newest = null
  for (const row of rows) {
    const at = row?.[column] ? Date.parse(row[column]) : NaN
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at
  }
  return newest
}

// Опрос одной подписки. active() — включён ли новый путь прямо сейчас (флаг читается на каждом шаге:
// его включают и выключают без перезагрузки вкладки); visible() — видна ли вкладка; idle() — давно ли
// пользователь ничего не делал. delta (createTableReader) — сверка по отметке времени; нет — только целиком.
export function createTablePoller({
  fetchRows, delta = null, onChange, onStatus, active, visible = () => true, idle = () => false, now = Date.now,
  intervalMs = POLL_INTERVAL_MS, overlapMs = OVERLAP_MS, resyncMs = RESYNC_MS, countEvery = COUNT_EVERY, idleEvery = IDLE_EVERY,
}) {
  let snapshot = null
  let running = false
  let stopped = false
  let stamp = null // наибольшая отметка снимка: null — сверка по отметке невозможна, читаем целиком
  let stampSeenAt = 0
  let fullReadAt = 0
  let deltaTicks = 0
  let idleTicks = 0

  function noteStamp(at) {
    if (at !== null && (stamp === null || at > stamp)) {
      stamp = at
      stampSeenAt = now()
    }
  }

  async function readFull() {
    const rows = await fetchRows()
    if (stopped) return
    const first = snapshot === null
    const result = diffSnapshots(snapshot, rows)
    snapshot = result.snapshot
    fullReadAt = now()
    stamp = null
    if (delta) noteStamp(newestStamp(rows, delta.column))
    if (first) onStatus?.('SUBSCRIBED')
    for (const event of result.events) onChange(event)
  }

  async function readChanges() {
    const since = new Date(now() - stampSeenAt < overlapMs ? stamp - overlapMs : stamp).toISOString()
    const stamps = await delta.stamps(since)
    if (stopped) return
    deltaTicks += 1
    const changed = stamps.filter((r) => r?.id != null && snapshot.get(String(r.id))?.row[delta.column] !== r[delta.column])
    const fresh = changed.length ? await delta.byIds(changed.map((r) => r.id)) : []
    if (stopped) return

    const known = new Set(snapshot.keys())
    for (const row of fresh) known.add(String(row.id))
    let removed = []
    let extra = []
    if (deltaTicks % countEvery === 0 && (await delta.count()) !== known.size) {
      // Число разошлось — сверяем список: пропавшие строки и строки, появившиеся с отметкой старше окна.
      const ids = await delta.ids()
      const present = new Set(ids.map(String))
      removed = [...snapshot.keys()].filter((key) => !present.has(key))
      const missing = ids.filter((id) => !known.has(String(id)))
      extra = missing.length ? await delta.byIds(missing) : []
    }
    if (stopped) return

    // Снимок меняем только теперь: сбой любого чтения выше оставляет всё как было, следующий шаг сверит заново.
    const events = []
    for (const row of [...fresh, ...extra]) {
      if (row?.id == null) continue
      const key = String(row.id)
      const entry = snapshotEntry(row)
      const old = snapshot.get(key)
      if (old?.text === entry.text) continue
      snapshot.set(key, entry)
      events.push(old ? { eventType: 'UPDATE', new: row, old: old.row } : { eventType: 'INSERT', new: row, old: {} })
    }
    for (const key of removed) {
      const old = snapshot.get(key)
      if (!old) continue
      snapshot.delete(key)
      events.push({ eventType: 'DELETE', new: {}, old: old.row })
    }
    noteStamp(newestStamp(stamps, delta.column))
    for (const event of events) onChange(event)
  }

  async function tick() {
    if (stopped || running) return
    if (!active()) { snapshot = null; stamp = null; return } // прежний путь: события шлёт Realtime
    if (!visible()) return
    const isIdle = idle()
    if (isIdle && snapshot !== null) {
      idleTicks += 1
      if (idleTicks % idleEvery !== 0) return
    }
    running = true
    try {
      const needFull = snapshot === null || stamp === null || (!isIdle && now() - fullReadAt >= resyncMs)
      if (needFull) await readFull()
      else await readChanges()
    } catch {
      // Сбой чтения — не событие: снимок прежний, следующий шаг сверит заново.
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  tick()
  return { tick, stop() { stopped = true; clearInterval(timer) } }
}
