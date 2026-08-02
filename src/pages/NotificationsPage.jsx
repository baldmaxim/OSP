import { useMemo, useState } from 'react'
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
  const isReview = n.kind === 'kp_review'
  const dateLabel = isReview ? 'Проверено'
    : n.kind === 'tender' ? 'Окончание процедуры' : 'Планируемое подписание'
  return (
    <li
      className={`notif-item ${isReview ? 'is-review' : urgencyClass(n.days)}${read ? ' is-read' : ''}`}
      onClick={() => onOpen(n)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n) }}
    >
      <span className="notif-dot" aria-hidden />
      <div className="notif-body">
        <div className="notif-top">
          {n.badge && <span className="notif-num">{n.badge}</span>}
          {isReview ? (
            <span className={`notif-review-chip ${n.reviewStatus === 'has_remarks' ? 'is-remarks' : 'is-ok'}`}>
              {n.reviewStatus === 'has_remarks' ? 'Есть замечания' : 'Проверено'}
            </span>
          ) : (
            <span className={`notif-days ${urgencyClass(n.days)}`}>{daysLabel(n.days)}</span>
          )}
          {!read && <span className="notif-unread" title="Не прочитано" aria-label="Не прочитано" />}
        </div>
        <div className="notif-object">{n.objectName}</div>
        {n.subtitle && <div className="notif-subtitle">{n.subtitle}</div>}
        {isReview && n.responsible && (
          <div className="notif-subtitle notif-responsible">
            Ответственный: {n.responsible} — направить контрагенту
          </div>
        )}
        {isReview && n.note && <div className="notif-review-note">{n.note}</div>}
        <div className="notif-date">{dateLabel}: {formatDateRu(n.date)}</div>
      </div>
      <span className="notif-open" aria-hidden>›</span>
    </li>
  )
}

function NotificationsPage() {
  const navigate = useNavigate()
  const { notifications, unreadCount, loading, markAllRead, markRead, isRead } = useNotifications()
  const [tab, setTab] = useState('tender') // 'tender' | 'contract' | 'kp_review'

  const openItem = (n) => {
    markRead(n.key)
    navigate(n.to)
  }

  // Разбиваем по виду; порядок внутри сохраняется (уже отсортированы по срочности).
  const tenderItems = useMemo(() => notifications.filter(n => n.kind === 'tender'), [notifications])
  const contractItems = useMemo(() => notifications.filter(n => n.kind === 'contract'), [notifications])
  const kpReviewItems = useMemo(() => notifications.filter(n => n.kind === 'kp_review'), [notifications])
  const tenderUnread = useMemo(() => tenderItems.filter(n => !isRead(n.key)).length, [tenderItems, isRead])
  const contractUnread = useMemo(() => contractItems.filter(n => !isRead(n.key)).length, [contractItems, isRead])
  const kpUnread = useMemo(() => kpReviewItems.filter(n => !isRead(n.key)).length, [kpReviewItems, isRead])

  const activeItems = tab === 'tender' ? tenderItems : tab === 'contract' ? contractItems : kpReviewItems

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

      {/* Переключатель между тендерами и договорами со счётчиками (task 424) */}
      <div className="notif-toggle" role="tablist" aria-label="Тип уведомлений">
        <button
          role="tab"
          aria-selected={tab === 'tender'}
          className={`notif-toggle-btn notif-toggle-tender${tab === 'tender' ? ' is-active' : ''}`}
          onClick={() => setTab('tender')}
        >
          <span>Тендеры</span>
          <span className="notif-toggle-count">{tenderItems.length}</span>
          {tenderUnread > 0 && <span className="notif-toggle-dot" title={`${tenderUnread} непрочитанных`} />}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'contract'}
          className={`notif-toggle-btn notif-toggle-contract${tab === 'contract' ? ' is-active' : ''}`}
          onClick={() => setTab('contract')}
        >
          <span>Договоры</span>
          <span className="notif-toggle-count">{contractItems.length}</span>
          {contractUnread > 0 && <span className="notif-toggle-dot" title={`${contractUnread} непрочитанных`} />}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'kp_review'}
          className={`notif-toggle-btn notif-toggle-review${tab === 'kp_review' ? ' is-active' : ''}`}
          onClick={() => setTab('kp_review')}
        >
          <span>Проверка КП</span>
          <span className="notif-toggle-count">{kpReviewItems.length}</span>
          {kpUnread > 0 && <span className="notif-toggle-dot" title={`${kpUnread} непрочитанных`} />}
        </button>
      </div>

      {loading ? (
        <div className="notif-empty">Загрузка…</div>
      ) : activeItems.length === 0 ? (
        <div className="notif-empty">
          <p>{tab === 'tender'
            ? 'Нет тендеров с приближающимся сроком.'
            : tab === 'contract'
              ? 'Нет договоров с приближающимся сроком.'
              : 'Нет недавно проверенных КП.'}</p>
          <p className="notif-empty-hint">
            {tab === 'kp_review'
              ? 'Здесь появятся результаты проверки КП аналитиком — их нужно направить контрагенту.'
              : 'Здесь появятся записи, которые скоро завершаются.'}
          </p>
        </div>
      ) : (
        <ul className="notif-list">
          {activeItems.map((n) => (
            <NotifItem key={n.key} n={n} read={isRead(n.key)} onOpen={openItem} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default NotificationsPage
