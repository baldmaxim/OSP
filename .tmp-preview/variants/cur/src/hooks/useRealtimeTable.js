import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'

// Подписка на изменения таблицы через Supabase Realtime.
//
// Зачем отдельный хук: над реестром тендеров одновременно работают несколько
// инженеров, и правку коллеги было видно только после перезагрузки страницы.
//
// Две разные ситуации обрабатываются по-разному:
//   • UPDATE — прилетает изменённая строка целиком, но БЕЗ связанных данных
//     (objects(name), ответственные и т.п.). Полностью заменять строку нельзя —
//     пропадут подтянутые связи, поэтому наверх отдаём только изменившиеся
//     скалярные поля, а страница подмешивает их в свою строку.
//   • INSERT/DELETE — появилась или исчезла строка: тут нужен перезапрос, и он
//     откладывается (debounce), чтобы пакет правок не вызвал десяток загрузок.
//
// Права не обходятся: события фильтруются теми же RLS-политиками под токеном
// текущего пользователя (таблицы включены в публикацию миграцией 20260915).
//
// Возвращает { connected } — можно показать индикатор «онлайн».
export function useRealtimeTable({
  table,
  schema = 'public',
  filter = null,          // например `tender_id=eq.${id}`
  enabled = true,
  onUpdate,               // (newRow, oldRow) => void
  onStructuralChange,     // () => void — вызывается с задержкой
  debounceMs = 800,
}) {
  const [connected, setConnected] = useState(false)
  // Колбэки держим в ref: иначе новая функция на каждый рендер пересоздавала бы
  // подписку, а это переподключение вебсокета на каждое нажатие клавиши.
  const onUpdateRef = useRef(onUpdate)
  const onStructuralRef = useRef(onStructuralChange)
  onUpdateRef.current = onUpdate
  onStructuralRef.current = onStructuralChange

  useEffect(() => {
    if (!enabled || !table) return undefined

    const timer = { id: null }
    const scheduleStructural = () => {
      if (!onStructuralRef.current) return
      if (timer.id) clearTimeout(timer.id)
      timer.id = setTimeout(() => { timer.id = null; onStructuralRef.current?.() }, debounceMs)
    }

    const channelName = `rt:${schema}.${table}${filter ? `:${filter}` : ''}:${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes',
        { event: '*', schema, table, ...(filter ? { filter } : {}) },
        (payload) => {
          if (payload.eventType === 'UPDATE') {
            if (onUpdateRef.current) onUpdateRef.current(payload.new, payload.old)
            else scheduleStructural()
          } else {
            scheduleStructural()
          }
        })
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))

    return () => {
      if (timer.id) clearTimeout(timer.id)
      supabase.removeChannel(channel)
      setConnected(false)
    }
  }, [table, schema, filter, enabled, debounceMs])

  return { connected }
}

// Какие поля реально изменились. Нужен, чтобы подмешать в строку только их и не
// затереть связанные данные (objects, responsible и т.п.), которых в событии нет.
export function changedScalarFields(newRow, oldRow) {
  const patch = {}
  if (!newRow) return patch
  for (const key of Object.keys(newRow)) {
    const next = newRow[key]
    if (typeof next === 'object' && next !== null) continue   // связи не трогаем
    if (!oldRow || oldRow[key] !== next) patch[key] = next
  }
  return patch
}
