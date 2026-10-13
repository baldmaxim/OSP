// Онлайн-обновления без Supabase Realtime: таблица периодически перечитывается, и по разнице со
// снимком собираются те же события, что присылал Realtime — { eventType, new, old }. Компоненты и хук
// useRealtimeTable не меняются; отличие одно — событие приходит не сразу, а в пределах интервала.
// Временный механизм до серверной ленты изменений. Модуль чистый — tests/osp-api/client-db.test.mjs.

export const POLL_INTERVAL_MS = 20_000
const PAGE = 1000

// Снимок: id → строка. Событие по каждой появившейся, изменившейся и пропавшей строке.
export function diffSnapshots(previous, rows) {
  const next = new Map()
  const events = []
  for (const row of rows) {
    if (row?.id == null) continue
    const key = String(row.id)
    const text = JSON.stringify(row)
    next.set(key, { row, text })
    const old = previous?.get(key)
    if (!previous) continue
    if (!old) events.push({ eventType: 'INSERT', new: row, old: {} })
    else if (old.text !== text) events.push({ eventType: 'UPDATE', new: row, old: old.row })
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

// Все строки таблицы (под правами пользователя), постранично.
export async function fetchTableRows(client, { table, filter }) {
  const eq = parseFilter(filter)
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let query = client.from(table).select('*').order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (eq) query = query.eq(eq.column, eq.value)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

// Опрос одной подписки. active() — включён ли новый путь прямо сейчас (флаг читается на каждом шаге:
// его включают и выключают без перезагрузки вкладки); visible() — видна ли вкладка.
export function createTablePoller({ fetchRows, onChange, onStatus, active, visible = () => true, intervalMs = POLL_INTERVAL_MS }) {
  let snapshot = null
  let running = false
  let stopped = false

  async function tick() {
    if (stopped || running) return
    if (!active()) { snapshot = null; return } // прежний путь: события шлёт Realtime
    if (!visible()) return
    running = true
    try {
      const rows = await fetchRows()
      if (stopped) return
      const first = snapshot === null
      const result = diffSnapshots(snapshot, rows)
      snapshot = result.snapshot
      if (first) onStatus?.('SUBSCRIBED')
      for (const event of result.events) onChange(event)
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
