import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import ThemeToggle from './ThemeToggle'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout, canView, isAdmin, isSuperAdmin, role, roleLabels } = useRole()

  // task 254: «Тендеры» — единый пункт-ссылка на страницу-хаб /tenders.
  // Подсвечиваем его активным на любой странице раздела тендеров.
  const isInTendersSection =
    location.pathname.startsWith('/tenders')
    || location.pathname.startsWith('/cost-plans')
    || location.pathname.startsWith('/vors')

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">ОСП</h1>
        <p className="sidebar-subtitle">отдел сопровождения подрядчиков</p>
        {role && role !== 'contractor' && (
          <span className="sidebar-role">{roleLabels?.[role] || role}</span>
        )}
      </div>

      <nav className="sidebar-nav">
        {/* Общая информация (objects, contacts, counterparties) */}
        {(canView('objects') || canView('contacts') || canView('counterparties')) && (
          <NavLink
            to="/general"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">📁</span>
            <span className="sidebar-label">Общая информация</span>
          </NavLink>
        )}

        {/* Тендеры — переход на страницу-хаб */}
        {canView('tenders') && (
          <NavLink
            to="/tenders"
            className={`sidebar-item ${isInTendersSection ? 'active' : ''}`}
          >
            <span className="sidebar-icon">📢</span>
            <span className="sidebar-label">Тендеры</span>
          </NavLink>
        )}

        {/* Анализ КП */}
        {canView('analysis_kp') && (
          <NavLink
            to="/analysis-kp"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">📊</span>
            <span className="sidebar-label">Анализ КП</span>
          </NavLink>
        )}

        {/* Договоры */}
        {canView('contracts') && (
          <NavLink
            to="/contracts"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">📋</span>
            <span className="sidebar-label">Договоры</span>
          </NavLink>
        )}

        {/* Проверка ДП/ДС */}
        <NavLink
          to="/document-check"
          className={({ isActive }) =>
            `sidebar-item ${isActive ? 'active' : ''}`
          }
        >
          <span className="sidebar-icon">📑</span>
          <span className="sidebar-label">Проверка ДП/ДС</span>
        </NavLink>

        {/* Материалы (БСМ) */}
        {canView('bsm') && (
          <NavLink
            to="/bsm"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">📦</span>
            <span className="sidebar-label">Материалы</span>
          </NavLink>
        )}

        {/* Приёмка */}
        {canView('acceptance') && (
          <NavLink
            to="/acceptance"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">✓</span>
            <span className="sidebar-label">Приёмка работ</span>
          </NavLink>
        )}

        {/* Отчёты */}
        {canView('reports') && (
          <NavLink
            to="/reports"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">📊</span>
            <span className="sidebar-label">Отчёты</span>
          </NavLink>
        )}

        {/* Администрирование — всегда видно суперадминам, даже если они переключились на другую роль */}
        {(isAdmin || isSuperAdmin) && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="sidebar-icon">⚙</span>
            <span className="sidebar-label">Администрирование</span>
          </NavLink>
        )}
      </nav>

      <div className="sidebar-footer">
        <NavLink to="/profile" className={({ isActive }) => `sidebar-profile-link ${isActive ? 'active' : ''}`}>
          <span className="sidebar-icon">👤</span>
          <span className="sidebar-label">Профиль</span>
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
