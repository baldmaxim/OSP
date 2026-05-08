import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import ThemeToggle from './ThemeToggle'
import './Sidebar.css'

function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { logout, canView, isAdmin, role, roleLabels } = useRole()

  const isInTendersSection =
    location.pathname.startsWith('/tenders')
    || location.pathname.startsWith('/cost-plans')
    || location.pathname.startsWith('/vors')
    || location.pathname.startsWith('/summary')

  const [tendersExpanded, setTendersExpanded] = useState(isInTendersSection)
  const isTendersActive = isInTendersSection

  const tendersSubItems = [
    { path: '/tenders/construction', label: 'Основное строительство', icon: '🏗️' },
    { path: '/tenders/warranty', label: 'Гарантийный отдел', icon: '🛡️' },
    { path: '/summary', label: 'Сводка', icon: '🧭' },
    { path: '/cost-plans', label: 'Планы затрат', icon: '💰' },
    { path: '/vors', label: 'ВОРы и РД', icon: '📐' },
  ]

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

        {/* Тендеры */}
        {canView('tenders') && (
          <div className="sidebar-item-wrapper">
            <button
              className={`sidebar-item sidebar-item-parent ${isTendersActive ? 'active' : ''}`}
              onClick={() => setTendersExpanded(!tendersExpanded)}
            >
              <span className="sidebar-icon">📢</span>
              <span className="sidebar-label">Тендеры</span>
              <span className={`sidebar-chevron ${tendersExpanded ? 'expanded' : ''}`}>
                ›
              </span>
            </button>

            {tendersExpanded && (
              <div className="sidebar-submenu">
                {tendersSubItems.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) =>
                      `sidebar-subitem ${isActive ? 'active' : ''}`
                    }
                  >
                    <span className="sidebar-icon">{item.icon}</span>
                    <span className="sidebar-label">{item.label}</span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
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

        {/* Администрирование */}
        {isAdmin && (
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
