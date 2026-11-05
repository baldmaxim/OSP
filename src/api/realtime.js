// Онлайн-обновления таблиц.
//   • данные в Supabase — Supabase Realtime (postgres_changes под RLS текущего пользователя);
//   • данные в базе Яндекса (флаг ospDb) — опрос через свой шлюз: таблица сверяется под правами
//     пользователя, и по разнице собираются те же события (tablePolling.js). Событие приходит не сразу,
//     а в пределах интервала опроса.
// Флаг читается на каждом шаге опроса: путь переключается в открытой вкладке, без перезагрузки.
import { supabase } from './supabaseClient'
import { ownDb, ownDbEnabled } from './db'
import { isOwnAuth } from './authMode'
import { createTablePoller, createTableReader } from './tablePolling'

// Сколько без действий пользователя вкладка считается оставленной (монитор с открытым порталом): опрос реже.
const IDLE_AFTER_MS = 5 * 60_000
let lastActivityAt = Date.now()
let activityWatched = false
function watchActivity() {
  if (activityWatched) return
  activityWatched = true
  const note = () => { lastActivityAt = Date.now() }
  // capture: страницы гасят всплытие; passive: обработчик не должен влиять на прокрутку.
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, note, { capture: true, passive: true })
  }
}
const userIdle = () => Date.now() - lastActivityAt >= IDLE_AFTER_MS

// Подписка на изменения одной таблицы. onChange(payload) — событие как у supabase-js
// (eventType, new, old); onStatus(status) — 'SUBSCRIBED' и т. п. Возвращает отписку.
// columns — какие колонки нужны подписчику в опросе (через запятую, с id); не задано — все.
export function subscribeTable({ channelName, schema = 'public', table, filter = null, columns = null }, onChange, onStatus) {
  // Свой вход: к Supabase не обращаемся вовсе — только опрос своего сервера.
  const channel = isOwnAuth() ? null : supabase
    .channel(channelName)
    // После переключения на базу Яндекса события Supabase уже не про наши данные — пропускаем.
    .on('postgres_changes', { event: '*', schema, table, ...(filter ? { filter } : {}) }, (payload) => { if (!ownDbEnabled()) onChange(payload) })
    .subscribe((status) => { if (!ownDbEnabled()) onStatus?.(status) })
  watchActivity()
  const reader = createTableReader(ownDb, { table, filter, columns })
  const poller = createTablePoller({
    fetchRows: reader.all,
    delta: reader.delta,
    onChange,
    onStatus,
    active: ownDbEnabled,
    visible: () => document.visibilityState === 'visible',
    idle: userIdle,
  })
  // Вернулись на вкладку — сверяемся сразу, не дожидаясь очередного шага.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    lastActivityAt = Date.now()
    poller.tick()
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    poller.stop()
    if (channel) supabase.removeChannel(channel)
  }
}
