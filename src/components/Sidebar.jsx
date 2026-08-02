import { useState, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { useNotifications } from '../contexts/NotificationsContext'
import { useMediaQuery } from '../hooks/useMediaQuery'
import ThemeToggle from './ThemeToggle'
import BrandLogo from './BrandLogo'
import {
  IconGeneral,
  IconTenders,
  IconAnalysis,
  IconContracts,
  IconDcRequest,
  IconRates,
  IconReports,
  IconAdmin,
  IconProfile,
  IconNotifications,
} from './icons/NavIcons'
import './Sidebar.css'

// Контейнер иконки: единый размер/скругление, цветовой тон задаётся классом tone-*.
function IconContainer({ tone, children }) {
  return <span className={`nav-ic tone-${tone}`}>{children}</span>
}

// Один пункт меню. Активность — из текущего маршрута (NavLink), либо принудительно
// через forceActive (раздел «Тендеры» подсвечивается на /cost-plans и /vors).
// badge — необязательный счётчик (например, непрочитанные уведомления).
function NavItem({ to, label, tone, Icon, forceActive, badge }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) => `nav-item ${(isActive || forceActive) ? 'active' : ''}`}
      aria-current={forceActive ? 'page' : undefined}
    >
      <IconContainer tone={tone}><Icon /></IconContainer>
      <span className="nav-label">{label}</span>
      {badge > 0 && (
        <span className="nav-badge" aria-label={`${badge} непрочитанных`}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  )
}

// Иконка-бургер для мобильного топбара.
function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout, canView, isAdmin, isSuperAdmin, isEmployee, role, roleLabels, scopedObjectIds } = useRole()
  const { unreadCount } = useNotifications()

  // Мобильное меню: скрытый off-canvas drawer вместо горизонтальной ленты.
  const isMobileNav = useMediaQuery('(max-width: 768px)')
  const [open, setOpen] = useState(false)

  // Закрываем drawer при переходе (клик по пункту → навигация) и по Escape.
  useEffect(() => { setOpen(false) }, [location.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Блокируем прокрутку фона, пока меню открыто.
  useEffect(() => {
    if (!(isMobileNav && open)) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isMobileNav, open])

  // Свайп: от левого края вправо — открыть; влево по открытому — закрыть.
  useEffect(() => {
    if (!isMobileNav) return
    let sx = 0, sy = 0, track = false
    const onStart = (e) => {
      const t = e.touches[0]
      sx = t.clientX; sy = t.clientY
      track = open || sx <= 24 // тянем либо при открытом (для закрытия), либо от левого края
    }
    const onEnd = (e) => {
      if (!track) return
      const t = e.changedTouches[0]
      const dx = t.clientX - sx
      const dy = t.clientY - sy
      if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy)) return // не горизонтальный жест
      if (!open && sx <= 24 && dx > 0) setOpen(true)
      else if (open && dx < 0) setOpen(false)
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [isMobileNav, open])

  // task 254: «Тендеры» — единый пункт-ссылка на страницу-хаб /tenders.
  // Подсвечиваем его активным на любой странице раздела тендеров.
  const isInTendersSection =
    location.pathname.startsWith('/tenders')
    || location.pathname.startsWith('/cost-plans')
    || location.pathname.startsWith('/vors')
    || location.pathname.startsWith('/kp-review')

  // Конфиг пунктов навигации. Порядок, маршруты и права доступа — как были;
  // visible повторяет прежние гейты один-в-один.
  const navItems = [
    {
      key: 'general',
      to: '/general',
      label: 'Общая информация',
      tone: 'amber',
      Icon: IconGeneral,
      visible: canView('objects') || canView('contacts') || canView('counterparties') || canView('general_documents'),
    },
    {
      key: 'tenders',
      // Руководитель строительства (привязан к объекту) попадает сразу в «Основное
      // строительство», минуя хаб-страницу /tenders.
      to: scopedObjectIds.length > 0 ? '/tenders/construction' : '/tenders',
      label: 'Тендеры',
      tone: 'rose',
      Icon: IconTenders,
      visible: canView('tenders'),
      forceActive: isInTendersSection,
    },
    {
      key: 'analysis',
      to: '/analysis-kp',
      label: 'Анализ ВОР/КП',
      tone: 'sky',
      Icon: IconAnalysis,
      visible: canView('analysis_kp'),
    },
    {
      key: 'contracts',
      to: '/contracts',
      label: 'Договоры и ДС',
      tone: 'sand',
      Icon: IconContracts,
      visible: canView('contracts'),
    },
    {
      key: 'dc-requests',
      to: '/dc-requests',
      label: 'Заявка на ДС',
      tone: 'coral',
      Icon: IconDcRequest,
      // task 333: гейтим через canView('dc_requests'), чтобы права из админки управляли пунктом.
      visible: isEmployee && canView('dc_requests'),
    },
    {
      key: 'rates',
      to: '/rates-registry',
      label: 'Реестр расценок',
      tone: 'green',
      Icon: IconRates,
      // task 356: Реестр расценок — общий список расценок из всех источников.
      visible: canView('rates_registry'),
    },
    {
      key: 'reports',
      to: '/reports',
      label: 'Отчёты',
      tone: 'violet',
      Icon: IconReports,
      visible: canView('reports'),
    },
    {
      key: 'admin',
      to: '/admin',
      label: 'Администрирование',
      tone: 'slate',
      Icon: IconAdmin,
      // Всегда видно суперадминам, даже если они переключились на другую роль.
      visible: isAdmin || isSuperAdmin,
    },
  ]

  return (
    <>
      {isMobileNav && (
        <header className="mobile-topbar">
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={() => setOpen(true)}
            aria-label="Открыть меню"
            aria-expanded={open}
          >
            <MenuIcon />
          </button>
          <div className="mobile-topbar-brand">
            <BrandLogo />
            <span className="mobile-topbar-sub">Тендеры</span>
          </div>
          {isEmployee && (
            <NavLink to="/notifications" className="mobile-topbar-bell" title="Уведомления" aria-label="Уведомления">
              <IconNotifications />
              {unreadCount > 0 && (
                <span className="mobile-topbar-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
              )}
            </NavLink>
          )}
        </header>
      )}
      {isMobileNav && (
        <div
          className={`mobile-nav-backdrop ${open ? 'is-open' : ''}`}
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar-header">
        <h1 className="sidebar-title"><BrandLogo /></h1>
        <p className="sidebar-subtitle">Тендеры</p>
        {role && role !== 'contractor' && (
          <span className="sidebar-role">{roleLabels?.[role] || role}</span>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Основная навигация">
        {navItems.filter((item) => item.visible).map((item) => (
          <NavItem
            key={item.key}
            to={item.to}
            label={item.label}
            tone={item.tone}
            Icon={item.Icon}
            forceActive={item.forceActive}
            badge={item.badge}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        {isEmployee && (
          <NavLink
            to="/notifications"
            className={({ isActive }) => `nav-item nav-item--footer ${isActive ? 'active' : ''}`}
            title="Уведомления"
          >
            <IconContainer tone="rose"><IconNotifications /></IconContainer>
            <span className="nav-label">Уведомления</span>
            {unreadCount > 0 && (
              <span className="nav-badge" aria-label={`${unreadCount} непрочитанных`}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </NavLink>
        )}
        <NavLink to="/profile" className={({ isActive }) => `nav-item nav-item--footer ${isActive ? 'active' : ''}`} title="Профиль">
          <IconContainer tone="slate"><IconProfile /></IconContainer>
          <span className="nav-label">Профиль</span>
        </NavLink>
        <ThemeToggle />
        <button
          className="logout-btn"
          onClick={async () => {
            await logout()
            navigate('/login')
          }}
        >
          Выйти
        </button>
      </div>
    </aside>
    </>
  )
}

export default Sidebar
