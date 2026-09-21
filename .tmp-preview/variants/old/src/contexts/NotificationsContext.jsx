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
//   задача   → due_date        (крайний срок; просроченные тоже показываем)
//
// Ключ уведомления СТАБИЛЕН для конкретной сущности (tender:<id>, contract:<id>,
// kp_review:<id>:<status>) и НЕ зависит от количества дней до срока. Поэтому один
// раз прочитанное уведомление остаётся прочитанным — при пересчёте списка, смене дня,
// перезагрузке или ремаунте оно не «всплывает» снова непрочитанным. (Раньше ключ
// включал «бакет» дней 5/3/0 — из-за этого прочитанные уведомления периодически
// снова становились непрочитанными; это и была причина цикличных повторов.)

const NotificationsContext = createContext(null)

// v2: начинаем отсчёт заново с сегодняшнего дня (прежние/просроченные уведомления
// и их отметки «прочитано» сбрасываются — bump ключа обнуляет старое состояние).
const READ_KEY = 'notifications_read_v2'
const HORIZON_DAYS = 5
// task 431: недавно проверенные КП попадают в уведомления в течение N дней после проверки.
const REVIEW_LOOKBACK_DAYS = 14

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

function toDateOnlyString(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadReadSet() {
  try {
    const raw = localStorage.getItem(READ_KEY)
    const arr = raw ? JSON.parse(raw) : []
    // Миграция: старые ключи с бакетом дней (`tender:<id>:d5`) приводим к стабильному
    // виду (`tender:<id>`), чтобы ранее прочитанные уведомления не всплыли снова после
    // перехода на стабильные ключи.
    const norm = (Array.isArray(arr) ? arr : []).map(k =>
      typeof k === 'string' ? k.replace(/:(d0|d3|d5)$/, '') : k
    )
    return new Set(norm)
  } catch {
    return new Set()
  }
}

export function NotificationsProvider({ children }) {
  const { isLoggedIn, isEmployee, canView, scopedObjectIds, user } = useRole()
  // canView — нестабильная функция (пересоздаётся каждый рендер). Забираем нужные
  // права как примитивы, чтобы refresh/useEffect не уходили в цикл перезапросов.
  const canTenders = canView('tenders')
  const canContracts = canView('contracts')
  // task 433: задачи уведомляют конкретного человека, поэтому нужен его user_id.
  const canTasks = canView('tasks')
  const userId = user?.id || null
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
      const todayStr = toDateOnlyString(todayMidnight())
      const horizon = todayMidnight()
      horizon.setDate(horizon.getDate() + HORIZON_DAYS)
      const horizonStr = toDateOnlyString(horizon)
      const out = []

      // Тендеры и договоры независимы — грузим параллельно (быстрее старт приложения).
      let tendersQ = null
      if (canTenders) {
        tendersQ = supabase
          .from('tenders')
          .select('id, public_tender_number, work_description, tender_end_date, status, object_id, objects(name)')
          .is('deleted_at', null)
          .not('tender_end_date', 'is', null)
          .gte('tender_end_date', todayStr)
          .lte('tender_end_date', horizonStr)
          .order('tender_end_date', { ascending: true })
          .limit(1000)
        if (scopedObjectIds.length > 0) tendersQ = tendersQ.in('object_id', scopedObjectIds)
      }
      const contractsQ = canContracts
        ? supabase
          .from('contracts')
          .select('id, contract_number, work_name, signed_date, status, objects(name)')
          .is('deleted_at', null)
          .not('signed_date', 'is', null)
          .gte('signed_date', todayStr)
          .lte('signed_date', horizonStr)
          .order('signed_date', { ascending: true })
          .limit(1000)
        : null

      // task 431: недавно завершённые проверки КП (approved/has_remarks) — уведомляем
      // ответственного по тендеру, чтобы он направил результат контрагенту.
      let kpReviewQ = null
      if (canTenders) {
        const reviewSince = todayMidnight()
        reviewSince.setDate(reviewSince.getDate() - REVIEW_LOOKBACK_DAYS)
        kpReviewQ = supabase
          .from('tender_proposal_files')
          .select('id, tender_id, review_status, review_note, reviewed_at, remarks_sent, remarks_send_required, summary_added, counterparties(name), tenders!inner(work_description, object_id, objects(name), responsible_contact:contacts!responsible_contact_id(full_name))')
          .eq('file_kind', 'commercial_proposal')
          .eq('review_required', true)
          .in('review_status', ['approved', 'has_remarks'])
          .gte('reviewed_at', reviewSince.toISOString())
          .order('reviewed_at', { ascending: false })
          .limit(1000)
        if (scopedObjectIds.length > 0) kpReviewQ = kpReviewQ.in('tenders.object_id', scopedObjectIds)
      }

      // task 433: мои задачи с приближающимся/прошедшим сроком и задачи, которые
      // ждут МОЕЙ приёмки (я — постановщик, исполнитель сдал работу). Два простых
      // запроса вместо одного с or(and(...)) — читаемее и надёжнее.
      const myTasksQ = canTasks && userId
        ? supabase
          .from('tasks')
          .select('id, title, status, due_date, objects(name)')
          .is('deleted_at', null)
          .eq('assignee_user_id', userId)
          .neq('status', 'done')
          .not('due_date', 'is', null)
          .lte('due_date', horizonStr)
          .order('due_date', { ascending: true })
          .limit(1000)
        : null
      const reviewTasksQ = canTasks && userId
        ? supabase
          .from('tasks')
          .select('id, title, status, due_date, updated_at, assignee_user_id, objects(name)')
          .is('deleted_at', null)
          .eq('created_by_user_id', userId)
          .eq('status', 'review')
          .order('updated_at', { ascending: false })
          .limit(1000)
        : null

      const [tendersRes, contractsRes, kpReviewRes, myTasksRes, reviewTasksRes] = await Promise.all([
        tendersQ ? tendersQ : Promise.resolve({ data: [], error: null }),
        contractsQ ? contractsQ : Promise.resolve({ data: [], error: null }),
        kpReviewQ ? kpReviewQ : Promise.resolve({ data: [], error: null }),
        myTasksQ ? myTasksQ : Promise.resolve({ data: [], error: null }),
        reviewTasksQ ? reviewTasksQ : Promise.resolve({ data: [], error: null }),
      ])
      if (tendersRes.error) throw tendersRes.error
      if (contractsRes.error) throw contractsRes.error

      // Тендеры — по tender_end_date. Окно [сегодня, сегодня+5].
      for (const t of tendersRes.data || []) {
        if (TENDER_DONE.has(t.status)) continue
        const days = daysUntil(t.tender_end_date)
        if (days < 0 || days > HORIZON_DAYS) continue
        out.push({
          kind: 'tender',
          id: t.id,
          key: `tender:${t.id}`,
          objectName: t.objects?.name || 'Тендер',
          subtitle: t.work_description || '',
          badge: t.public_tender_number != null ? `№${t.public_tender_number}` : null,
          date: t.tender_end_date,
          days,
          to: `/tenders/${t.id}`,
        })
      }

      // Договоры — по signed_date (планируемая дата подписания). Окно [сегодня, +5].
      for (const c of contractsRes.data || []) {
        if (CONTRACT_DONE.has(c.status)) continue
        const days = daysUntil(c.signed_date)
        if (days < 0 || days > HORIZON_DAYS) continue
        out.push({
          kind: 'contract',
          id: c.id,
          key: `contract:${c.id}`,
          objectName: c.objects?.name || 'Договор',
          // Показываем выполняемые работы (как у тендеров), номер договора — бейджем.
          subtitle: c.work_name || (c.contract_number ? `№ ${c.contract_number}` : '№ не присвоен'),
          badge: c.contract_number ? `№ ${c.contract_number}` : null,
          date: c.signed_date,
          days,
          to: `/contracts/${c.id}`,
        })
      }

      // task 431: проверки КП. Query best-effort — если миграция 20260802 ещё не
      // применена (нет review-полей), просто пропускаем, не ломая остальные уведомления.
      if (kpReviewRes.error) {
        console.warn('Проверки КП не загружены (миграция 20260802?):', kpReviewRes.error.message)
      } else {
        for (const f of kpReviewRes.data || []) {
          // Задача по замечаниям закрыта, когда сделано всё, что требует ветка:
          // при отправке подрядчику это две параллельные задачи (сводная +
          // отправка), без отправки — только сводная. Тогда напоминание снимаем.
          const sendBranch = f.remarks_send_required !== false
          const remarksDone = sendBranch ? (f.remarks_sent && f.summary_added) : f.summary_added
          if (f.review_status === 'has_remarks' && remarksDone) continue
          const t = f.tenders
          // Подветка «без отправки подрядчику» (миграция 20260826) — звать
          // «направьте контрагенту» там нечего, замечания остаются внутри.
          const statusLabel = f.review_status === 'has_remarks'
            ? (f.remarks_send_required === false
              ? 'есть замечания — без отправки подрядчику'
              : 'есть замечания — направить подрядчику')
            : 'проверено, замечаний нет'
          out.push({
            kind: 'kp_review',
            id: f.id,
            key: `kp_review:${f.id}:${f.review_status}`,
            objectName: t?.objects?.name || 'Тендер',
            subtitle: `${f.counterparties?.name || 'Контрагент'} — ${statusLabel}`,
            responsible: t?.responsible_contact?.full_name || '',
            note: f.review_status === 'has_remarks' ? (f.review_note || '') : '',
            reviewStatus: f.review_status,
            badge: null,
            date: f.reviewed_at,
            days: 0,
            to: `/tenders/${f.tender_id}`,
          })
        }
      }

      // task 433: задачи. Запросы best-effort — если миграция 20260818 ещё не
      // применена, просто пропускаем, не ломая остальные уведомления.
      if (myTasksRes.error || reviewTasksRes.error) {
        console.warn('Задачи не загружены (миграция 20260818?):',
          (myTasksRes.error || reviewTasksRes.error).message)
      } else {
        for (const t of myTasksRes.data || []) {
          // Просроченные НЕ отбрасываем (в отличие от тендеров/договоров):
          // для задачи просрочка — главный повод напомнить.
          const days = daysUntil(t.due_date)
          if (days > HORIZON_DAYS) continue
          out.push({
            kind: 'task',
            id: t.id,
            key: `task:${t.id}:due`,
            objectName: t.title,
            subtitle: t.objects?.name || '',
            badge: null,
            date: t.due_date,
            days,
            to: `/tasks?task=${t.id}`,
          })
        }
        for (const t of reviewTasksRes.data || []) {
          out.push({
            kind: 'task',
            id: t.id,
            key: `task:${t.id}:review`,
            objectName: t.title,
            subtitle: 'Исполнитель сдал работу — нужна ваша приёмка',
            taskReview: true,
            badge: null,
            date: t.updated_at,
            days: 0,
            to: `/tasks?task=${t.id}`,
          })
        }
      }

      // Самые срочные (просроченные и «сегодня») — вверху. Проверки КП (days=0)
      // остаются в порядке добавления (по дате проверки, свежие сверху).
      out.sort((a, b) => a.days - b.days)
      setNotifications(out)
    } catch (err) {
      console.error('Ошибка загрузки уведомлений:', err.message)
      setNotifications([])
    } finally {
      setLoading(false)
    }
  }, [isLoggedIn, isEmployee, canTenders, canContracts, canTasks, userId, scopedObjectIds])

  useEffect(() => { refresh() }, [refresh])

  // Синхронизация «прочитано» между вкладками: если в другой вкладке отметили
  // уведомления прочитанными, подхватываем актуальный набор — иначе в этой вкладке
  // они продолжали бы показываться непрочитанными (и «возвращались» бы при действиях).
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === READ_KEY) setReadSet(loadReadSet())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
