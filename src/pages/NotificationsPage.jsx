import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '../contexts/NotificationsContext'
import './NotificationsPage.css'

// Человекочитаемая пометка по количеству дней до окончания.
function daysLabel(days) {
  if (days < 0) return `просрочено на ${Math.abs(days)} ${plural(Math.abs(days), 'день', 'дня', 'дней')}`
  if (days === 0) return 'сегодня'
  return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`
}
function plural(n, one, few, many) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}
function urgencyClass(days) {
  if (days < 0) return 'is-overdue'
  if (days === 0) return 'is-today'
  if (days <= 3) return 'is-soon'
  return 'is-upcoming'
}
function formatDateRu(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

// Иконка «двойная галочка» для кнопки «Прочитать все».
const CheckAllIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2 12 5 5L18 6" />
    <path d="m13 17 1 1 8-8" />
  </svg>
)

// Один пункт списка уведомлений. Внутри раздела вид (Тендер/Договор) очевиден из
// заголовка секции, поэтому бейдж вида не показываем.
function NotifItem({ n, read, onOpen }) {
  return (
    <li
      className={`notif-item ${urgencyClass(n.days)}${read ? ' is-read' : ''}`}
      onClick={() => onOpen(n)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n) }}
    >
      <span className="notif-dot" aria-hidden />
      <div className="notif-body">
        <div className="notif-top">
          {n.badge && <span className="notif-num">{n.badge}</span>}
          <span className={`notif-days ${urgencyClass(n.days)}`}>{daysLabel(n.days)}</span>
          {!read && <span className="notif-unread" title="Не прочитано" aria-label="Не прочитано" />}
        </div>
        <div className="notif-object">{n.objectName}</div>
        {n.subtitle && <div className="notif-subtitle">{n.subtitle}</div>}
        <div className="notif-date">
          {n.kind === 'tender' ? 'Окончание процедуры' : 'Планируемое подписание'}: {formatDateRu(n.date)}
        </div>
      </div>
      <span className="notif-open" aria-hidden>›</span>
    </li>
  )
}

function NotificationsPage() {
  const navigate = useNavigate()
  const { notifications, unreadCount, loading, markAllRead, markRead, isRead } = useNotifications()

  const openItem = (n) => {
    markRead(n.key)
    navigate(n.to)
  }

  // Разбиваем на разделы по виду; порядок внутри сохраняется (уже отсортированы по срочности).
  const tenderItems = useMemo(() => notifications.filter(n => n.kind === 'tender'), [notifications])
  const contractItems = useMemo(() => notifications.filter(n => n.kind === 'contract'), [notifications])

  const renderSection = (kind, title, items) => {
    if (items.length === 0) return null
    return (
      <section className={`notif-section notif-section-${kind}`}>
        <div className="notif-section-head">
          <span className="notif-section-title">{title}</span>
          <span className="notif-section-count">{items.length}</span>
        </div>
        <ul className="notif-list">
          {items.map((n) => (
            <NotifItem key={n.key} n={n} read={isRead(n.key)} onOpen={openItem} />
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="notifications-page">
      <div className="notif-header">
        <h2><span className="notif-title-icon" aria-hidden>🔔</span> Уведомления</h2>
        {unreadCount > 0 && (
          <button className="notif-mark-all" onClick={markAllRead} title="Отметить все уведомления прочитанными">
            <CheckAllIcon />
            <span>Прочитать все</span>
            <span className="notif-mark-all-count">{unreadCount}</span>
          </button>
        )}
      </div>

      <p className="notif-hint">
        Тендеры и договоры, у которых окончание в ближайшие 5 дней.
        Напоминания повторяются за 5, 3 дня и в день окончания.
      </p>

      {loading ? (
        <div className="notif-empty">Загрузка…</div>
      ) : notifications.length === 0 ? (
        <div className="notif-empty">
          <p>Нет приближающихся сроков.</p>
          <p className="notif-empty-hint">Здесь появятся тендеры и договоры, которые скоро завершаются.</p>
        </div>
      ) : (
        <div className="notif-sections">
          {renderSection('tender', 'Тендеры', tenderItems)}
          {renderSection('contract', 'Договоры', contractItems)}
        </div>
      )}
    </div>
  )
}

export default NotificationsPage
