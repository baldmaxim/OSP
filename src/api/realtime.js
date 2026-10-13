// Онлайн-обновления таблиц.
//   • данные в Supabase — Supabase Realtime (postgres_changes под RLS текущего пользователя);
//   • данные в базе Яндекса (флаг ospDb) — опрос через свой шлюз: таблица перечитывается под правами
//     пользователя, и по разнице собираются те же события (tablePolling.js). Событие приходит не сразу,
//     а в пределах интервала опроса.
// Флаг читается на каждом шаге опроса: путь переключается в открытой вкладке, без перезагрузки.
import { supabase } from './supabaseClient'
import { ownDb, ownDbEnabled } from './db'
import { createTablePoller, fetchTableRows } from './tablePolling'

// Подписка на изменения одной таблицы. onChange(payload) — событие как у supabase-js
// (eventType, new, old); onStatus(status) — 'SUBSCRIBED' и т. п. Возвращает отписку.
export function subscribeTable({ channelName, schema = 'public', table, filter = null }, onChange, onStatus) {
  const channel = supabase
    .channel(channelName)
    // После переключения на базу Яндекса события Supabase уже не про наши данные — пропускаем.
    .on('postgres_changes', { event: '*', schema, table, ...(filter ? { filter } : {}) }, (payload) => { if (!ownDbEnabled()) onChange(payload) })
    .subscribe((status) => { if (!ownDbEnabled()) onStatus?.(status) })
  const poller = createTablePoller({
    fetchRows: () => fetchTableRows(ownDb(), { table, filter }),
    onChange,
    onStatus,
    active: ownDbEnabled,
    visible: () => document.visibilityState === 'visible',
  })
  // Вернулись на вкладку — сверяемся сразу, не дожидаясь очередного шага.
  const onVisible = () => { if (document.visibilityState === 'visible') poller.tick() }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    poller.stop()
    supabase.removeChannel(channel)
  }
}
