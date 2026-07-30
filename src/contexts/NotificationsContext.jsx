import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../supabase'
import { useRole } from './RoleContext'

// Уведомления о приближающемся завершении тендеров и договоров.
// Считаются на лету из дат (без таблицы в БД и без крон-задач): при загрузке
// приложения тянем не завершённые тендеры/договоры, у которых дата окончания
// в пределах ближайших 5 дней или уже прошла, и формируем список. Отметка
// «прочитано» хранится в localStorage.
//
// Даты «окончания»:
//   тендер   → tender_end_date (окончание тендерной процедуры)
//   договор  → signed_date     (планируемая дата подписания)
//
// Пороговые «бакеты» 5/3/0 зашиты в ключ уведомления: когда объект переходит из
// «≤5 дней» в «≤3 дня» и затем в «просрочено», ключ меняется и уведомление снова
// становится непрочитанным — так реализуется повторное напоминание за 5, 3 и 0 дней.

const NotificationsContext = createContext(null)

const READ_KEY = 'notifications_read_v1'
const HORIZON_DAYS = 5

// Завершённые статусы, по которым не уведомляем.
const TENDER_DONE = new Set(['Завершен', 'Завершён', 'Принято в работу'])
const CONTRACT_DONE = new Set(['completed'])

function todayMidnight() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Дней до даты: >0 впереди, 0 сегодня, <0 просрочено.
function daysUntil(dateStr) {
  const d = new Date(dateStr)
  d.setHours(0, 0, 0, 0)
  return Math.round((d - todayMidnight()) / 86400000)
}

// Бакет напоминания — на нём завязано повторное «непрочитано».
function bucketOf(days) {
  if (days <= 0) return 'overdue'
  if (days <= 3) return 'd3'
  return 'd5'
}

function toDateOnlyString(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadReadSet() {
  try {
    const raw = localStorage.getItem(READ_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

export function NotificationsProvider({ children }) {
  const { isLoggedIn, isEmployee, canView, scopedObjectId } = useRole()
  // canView — нестабильная функция (пересоздаётся каждый рендер). Забираем нужные
  // права как примитивы, чтобы refresh/useEffect не уходили в цикл перезапросов.
  const canTenders = canView('tenders')
  const canContracts = canView('contracts')
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(false)
  const [readSet, setReadSet] = useState(loadReadSet)

  const persistRead = useCallback((set) => {
    setReadSet(new Set(set))
    try { localStorage.setItem(READ_KEY, JSON.stringify([...set])) } catch { /* noop */ }
  }, [])

  const refresh = useCallback(async () => {
    if (!isLoggedIn || !isEmployee) {
      setNotifications([])
      return
    }
    setLoading(true)
    try {
      const horizon = todayMidnight()
      horizon.setDate(horizon.getDate() + HORIZON_DAYS)
      const horizonStr = toDateOnlyString(horizon)
      const out = []

      // Тендеры — по tender_end_date. Руководителя строительства ограничиваем его объектом.
      if (canTenders) {
        let q = supabase
          .from('tenders')
          .select('id, public_tender_number, work_description, tender_end_date, status, object_id, objects(name)')
          .is('deleted_at', null)
          .not('tender_end_date', 'is', null)
          .lte('tender_end_date', horizonStr)
          .order('tender_end_date', { ascending: true })
          .limit(1000)
        if (scopedObjectId) q = q.eq('object_id', scopedObjectId)
        const { data, error } = await q
        if (error) throw error
        for (const t of data || []) {
          if (TENDER_DONE.has(t.status)) continue
          const days = daysUntil(t.tender_end_date)
          out.push({
            kind: 'tender',
            id: t.id,
            key: `tender:${t.id}:${bucketOf(days)}`,
            objectName: t.objects?.name || 'Тендер',
            subtitle: t.work_description || '',
            badge: t.public_tender_number != null ? `№${t.public_tender_number}` : null,
            date: t.tender_end_date,
            days,
            to: `/tenders/${t.id}`,
          })
        }
      }

      // Договоры — по signed_date (планируемая дата подписания).
      if (canContracts) {
        const { data, error } = await supabase
          .from('contracts')
          .select('id, contract_number, signed_date, status, objects(name)')
          .is('deleted_at', null)
          .not('signed_date', 'is', null)
          .lte('signed_date', horizonStr)
          .order('signed_date', { ascending: true })
          .limit(1000)
        if (error) throw error
        for (const c of data || []) {
          if (CONTRACT_DONE.has(c.status)) continue
          const days = daysUntil(c.signed_date)
          out.push({
            kind: 'contract',
            id: c.id,
            key: `contract:${c.id}:${bucketOf(days)}`,
            objectName: c.objects?.name || 'Договор',
            subtitle: c.contract_number ? `№ ${c.contract_number}` : '№ не присвоен',
            badge: null,
            date: c.signed_date,
            days,
            to: `/contracts/${c.id}`,
          })
        }
      }

      // Самые срочные (просроченные и «сегодня») — вверху.
      out.sort((a, b) => a.days - b.days)
      setNotifications(out)
    } catch (err) {
      console.error('Ошибка загрузки уведомлений:', err.message)
      setNotifications([])
    } finally {
      setLoading(false)
    }
  }, [isLoggedIn, isEmployee, canTenders, canContracts, scopedObjectId])

  useEffect(() => { refresh() }, [refresh])

  const unreadCount = useMemo(
    () => notifications.filter(n => !readSet.has(n.key)).length,
    [notifications, readSet]
  )

  const markRead = useCallback((key) => {
    if (readSet.has(key)) return
    const s = new Set(readSet)
    s.add(key)
    persistRead(s)
  }, [readSet, persistRead])

  const markAllRead = useCallback(() => {
    const s = new Set(readSet)
    notifications.forEach(n => s.add(n.key))
    persistRead(s)
  }, [notifications, readSet, persistRead])

  const isRead = useCallback((key) => readSet.has(key), [readSet])

  const value = useMemo(
    () => ({ notifications, unreadCount, loading, refresh, markRead, markAllRead, isRead }),
    [notifications, unreadCount, loading, refresh, markRead, markAllRead, isRead]
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

// Безопасный дефолт вне провайдера (например, на страницах авторизации).
export function useNotifications() {
  const ctx = useContext(NotificationsContext)
  if (!ctx) {
    return {
      notifications: [], unreadCount: 0, loading: false,
      refresh: () => {}, markRead: () => {}, markAllRead: () => {}, isRead: () => false,
    }
  }
  return ctx
}
