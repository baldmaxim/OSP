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

// Вкладки. У руководителя строительства и экономиста объекта (siteStaff) — статус тендеров своих объектов и свои заявки
// (utils/siteNotifications.js); договоров и проверки КП у них нет. onlyIfAny — вкладка видна, только когда в ней что-то есть.
const OFFICE_TABS = [
  { key: 'tender', label: 'Тендеры', cls: 'notif-toggle-tender', empty: 'Нет тендеров с приближающимся сроком.', hint: 'Здесь появятся записи, которые скоро завершаются.' },
  { key: 'contract', label: 'Договоры', cls: 'notif-toggle-contract', empty: 'Нет договоров с приближающимся сроком.', hint: 'Здесь появятся записи, которые скоро завершаются.' },
  { key: 'task', label: 'Задачи', cls: 'notif-toggle-task', empty: 'Нет задач с горящим сроком.', hint: 'Здесь появятся ваши задачи со сроком в ближайшие дни и задачи, ждущие вашей приёмки.' },
  { key: 'kp_review', label: 'Проверка КП', cls: 'notif-toggle-review', empty: 'Нет недавно проверенных КП.', hint: 'Здесь появятся результаты проверки КП аналитиком — их нужно направить контрагенту.' },
  { key: 'supply_vor', label: 'Изменения ВОР', cls: 'notif-toggle-review', onlyIfAny: true },
]
const SITE_TABS = [
  { key: 'tender', label: 'Тендеры', cls: 'notif-toggle-tender', empty: 'По вашим объектам нет идущих тендеров.', hint: 'Здесь виден статус тендеров ваших объектов. Объекты назначает администратор в «Ролях».' },
  { key: 'doc_check', label: 'Проверка ДП/ДС', cls: 'notif-toggle-doccheck', empty: 'По вашим объектам нет заявок на проверку ДП/ДС.', hint: 'Здесь видно, на каком этапе заявки ваших объектов, кто бы их ни подал. Подать заявку — «Договоры и ДС» → «Заявки на проверку ДП/ДС».' },
  { key: 'dp_request', label: 'Заявки на ДП', cls: 'notif-toggle-dp', empty: 'По вашим объектам нет заявок на заключение ДП.', hint: 'Здесь виден статус заявок ваших объектов. Заявку подают в «Реестре по договорам» кнопкой «+ Заявка на заключение ДП».' },
  { key: 'task', label: 'Задачи', cls: 'notif-toggle-task', onlyIfAny: true },
  { key: 'supply_vor', label: 'Изменения ВОР', cls: 'notif-toggle-review', onlyIfAny: true },
]

// Один пункт списка уведомлений. Внутри раздела вид (Тендер/Договор) очевиден из
// заголовка секции, поэтому бейдж вида не показываем.
function NotifItem({ n, read, onOpen }) {
  const isReview = n.kind === 'kp_review'
  const isVor = n.kind === 'supply_vor'
  // Статус тендера или заявки (рукстрой и экономист объекта): срока нет, важен этап.
  const isStatus = Boolean(n.statusLabel)
  const dateLabel = n.dateLabel || (isReview ? 'Проверено'
    : isVor ? 'Изменён'
      : n.kind === 'task' ? (n.taskReview ? 'Сдано на приёмку' : 'Срок')
        : n.kind === 'tender' ? 'Окончание процедуры' : 'Планируемое подписание')
  const tone = isStatus ? `is-status is-${n.statusTone || 'active'}` : isReview ? 'is-review' : urgencyClass(n.days)
  return (
    <li
      className={`notif-item ${tone}${read ? ' is-read' : ''}`}
      onClick={() => onOpen(n)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(n) }}
    >
      <span className="notif-dot" aria-hidden />
      <div className="notif-body">
        <div className="notif-top">
          {n.badge && <span className="notif-num">{n.badge}</span>}
          {isStatus ? (
            <span className={`notif-status-chip is-${n.statusTone || 'active'}`}>{n.statusLabel}</span>
          ) : isReview ? (
            <span className={`notif-review-chip ${n.reviewStatus === 'has_remarks' ? 'is-remarks' : 'is-ok'}`}>
              {n.reviewStatus === 'has_remarks' ? 'Есть замечания' : 'Проверено'}
            </span>
          ) : isVor ? (
            // ВОР изменён: срока нет, важно посмотреть изменения в расценке.
            <span className="notif-review-chip is-remarks">ВОР изменён</span>
          ) : n.taskReview ? (
            // Задача сдана исполнителем: срок тут ни при чём, важно само действие.
            <span className="notif-review-chip is-remarks">Ждёт приёмки</span>
          ) : (
            <span className={`notif-days ${urgencyClass(n.days)}`}>{daysLabel(n.days)}</span>
          )}
          {!read && <span className="notif-unread" title="Не прочитано" aria-label="Не прочитано" />}
        </div>
        <div className="notif-object">{n.objectName}</div>
        {n.subtitle && <div className="notif-subtitle">{n.subtitle}</div>}
        {n.author && <div className="notif-subtitle notif-author">Подал(а): {n.author}</div>}
        {isReview && n.responsible && (
          <div className="notif-subtitle notif-responsible">
            Ответственный: {n.responsible} — направить контрагенту
          </div>
        )}
        {isReview && n.note && <div className="notif-review-note">{n.note}</div>}
        {n.date && <div className="notif-date">{dateLabel}: {formatDateRu(n.date)}</div>}
      </div>
      <span className="notif-open" aria-hidden>›</span>
    </li>
  )
}

function NotificationsPage() {
  const navigate = useNavigate()
  const { notifications, unreadCount, loading, markAllRead, markRead, isRead, siteStaff } = useNotifications()
  const [tab, setTab] = useState('tender')

  const openItem = (n) => {
    markRead(n.key)
    navigate(n.to)
  }

  // Разбиваем по виду; порядок внутри сохраняется (уже отсортированы по срочности).
  const byKind = useMemo(() => {
    const map = new Map()
    for (const n of notifications) {
      if (!map.has(n.kind)) map.set(n.kind, [])
      map.get(n.kind).push(n)
    }
    return map
  }, [notifications])
  const tabs = (siteStaff ? SITE_TABS : OFFICE_TABS)
    .map((t) => {
      const items = byKind.get(t.key) || []
      return { ...t, items, unread: items.filter((n) => !isRead(n.key)).length }
    })
    .filter((t) => !t.onlyIfAny || t.items.length > 0)
  const active = tabs.find((t) => t.key === tab) || tabs[0]

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
        {siteStaff
          ? 'Статус тендеров ваших объектов и заявок по ним — на проверку ДП/ДС и на заключение ДП. Сменился статус — уведомление снова непрочитанное.'
          : 'Тендеры и договоры, у которых окончание в ближайшие 5 дней, и ваши задачи с горящим сроком. Напоминания повторяются за 5, 3 дня и в день окончания.'}
      </p>

      {/* Переключатель вкладок со счётчиками (task 424) */}
      <div className="notif-toggle" role="tablist" aria-label="Тип уведомлений">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active.key}
            className={`notif-toggle-btn ${t.cls}${t.key === active.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span>{t.label}</span>
            <span className="notif-toggle-count">{t.items.length}</span>
            {t.unread > 0 && <span className="notif-toggle-dot" title={`${t.unread} непрочитанных`} />}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="notif-empty">Загрузка…</div>
      ) : active.items.length === 0 ? (
        <div className="notif-empty">
          <p>{active.empty || 'Уведомлений нет.'}</p>
          {active.hint && <p className="notif-empty-hint">{active.hint}</p>}
        </div>
      ) : (
        <ul className="notif-list">
          {active.items.map((n) => (
            <NotifItem key={n.key} n={n} read={isRead(n.key)} onOpen={openItem} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default NotificationsPage
