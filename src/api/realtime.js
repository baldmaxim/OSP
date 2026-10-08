// Онлайн-обновления таблиц: сейчас Supabase Realtime (postgres_changes под RLS текущего
// пользователя), на этапе 3 — сигналы «перечитать» по SSE от osp-api.
import { supabase } from './supabaseClient'

// Подписка на изменения одной таблицы. onChange(payload) — событие как у supabase-js
// (eventType, new, old); onStatus(status) — 'SUBSCRIBED' и т. п. Возвращает отписку.
export function subscribeTable({ channelName, schema = 'public', table, filter = null }, onChange, onStatus) {
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema, table, ...(filter ? { filter } : {}) }, onChange)
    .subscribe(onStatus)
  return () => supabase.removeChannel(channel)
}
