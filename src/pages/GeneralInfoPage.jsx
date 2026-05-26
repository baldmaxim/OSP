import { useNavigate } from 'react-router-dom'
import './GeneralInfoPage.css'

// Lucide-style SVG-иконки для карточек «Общей информации» (task 303 + 308).
// Все иконки единого стиля — currentColor + stroke 1.75, размер 40×40.
const sectionIconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  width: 40,
  height: 40,
  'aria-hidden': true,
}

const BuildingIcon = () => (
  <svg {...sectionIconProps}>
    <rect width="16" height="20" x="4" y="2" rx="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" />
    <path d="M16 6h.01" />
    <path d="M12 6h.01" />
    <path d="M12 10h.01" />
    <path d="M12 14h.01" />
    <path d="M16 10h.01" />
    <path d="M16 14h.01" />
    <path d="M8 10h.01" />
    <path d="M8 14h.01" />
  </svg>
)

const UsersIcon = () => (
  <svg {...sectionIconProps}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

const BriefcaseIcon = () => (
  <svg {...sectionIconProps}>
    <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    <path d="M2 13h20" />
  </svg>
)

function GeneralInfoPage() {
  const navigate = useNavigate()

  const sections = [
    { path: '/general/objects', label: 'Объекты', icon: <BuildingIcon />, description: 'Строительные объекты' },
    { path: '/general/contacts', label: 'Сотрудники СУ-10', icon: <UsersIcon />, description: 'Контактные данные сотрудников' },
    { path: '/general/counterparties', label: 'Контрагенты', icon: <BriefcaseIcon />, description: 'Организации-подрядчики' },
  ]

  return (
    <div className="general-info-page">
      <div className="page-header">
        <h2>Общая информация</h2>
      </div>

      <div className="section-selection">
        <p className="selection-label">Выберите раздел:</p>
        <div className="section-cards">
          {sections.map((section) => (
            <button
              key={section.path}
              className="section-card"
              onClick={() => navigate(section.path)}
            >
              <span className="section-icon">{section.icon}</span>
              <span className="section-name">{section.label}</span>
              <span className="section-description">{section.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default GeneralInfoPage

