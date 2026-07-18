import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
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
} from './icons/NavIcons'
import './Sidebar.css'

// Контейнер иконки: единый размер/скругление, цветовой тон задаётся классом tone-*.
function IconContainer({ tone, children }) {
  return <span className={`nav-ic tone-${tone}`}>{children}</span>
}

// Один пункт меню. Активность — из текущего маршрута (NavLink), либо принудительно
// через forceActive (раздел «Тендеры» подсвечивается на /cost-plans и /vors).
function NavItem({ to, label, tone, Icon, forceActive }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) => `nav-item ${(isActive || forceActive) ? 'active' : ''}`}
      aria-current={forceActive ? 'page' : undefined}
    >
      <IconContainer tone={tone}><Icon /></IconContainer>
      <span className="nav-label">{label}</span>
    </NavLink>
  )
}

function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout, canView, isAdmin, isSuperAdmin, isEmployee, role, roleLabels } = useRole()

  // task 254: «Тендеры» — единый пункт-ссылка на страницу-хаб /tenders.
  // Подсвечиваем его активным на любой странице раздела тендеров.
  const isInTendersSection =
    location.pathname.startsWith('/tenders')
    || location.pathname.startsWith('/cost-plans')
    || location.pathname.startsWith('/vors')

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
      to: '/tenders',
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
    <aside className="sidebar">
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
          />
        ))}
      </nav>

      <div className="sidebar-footer">
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
  )
}

export default Sidebar
