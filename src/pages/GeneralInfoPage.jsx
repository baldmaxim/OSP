import { useNavigate } from 'react-router-dom'
import './GeneralInfoPage.css'

// Lucide-style «users» — иконка для карточки «Сотрудники СУ-10» (task 303).
// Используем SVG вместо emoji-человечка — выглядит профессиональнее.
const UsersIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    width="40"
    height="40"
    aria-hidden="true"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)

function GeneralInfoPage() {
  const navigate = useNavigate()

  const sections = [
    { path: '/general/objects', label: 'Объекты', icon: '🏢', description: 'Строительные объекты' },
    { path: '/general/contacts', label: 'Сотрудники СУ-10', icon: <UsersIcon />, description: 'Сотрудники СУ-10 и подрядчиков' },
    { path: '/general/counterparties', label: 'Контрагенты', icon: '🏛️', description: 'Организации-подрядчики' },
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

