import { useNavigate } from 'react-router-dom'
import './BSMSelectionPage.css'

function BSMSelectionPage() {
  const navigate = useNavigate()

  const mainSections = [
    { path: '/bsm/comparison', label: 'Сравнение расценок', icon: '⚖️', description: 'Сравнение цен из разных источников' },
    { path: '/bsm/supply-rates', label: 'Расценки от снабжения', icon: '📦', description: 'Цены от отдела снабжения' },
  ]

  const bsmSections = [
    { path: '/bsm/contract-rates', label: 'БСМ с заказчиком', icon: '📝', description: 'Утвержденные цены по договорам' },
    { path: '/bsm/contractor-rates', label: 'БСМ с подрядчиком', icon: '🤝', description: 'Расценки по подрядчикам' },
  ]

  return (
    <div className="bsm-selection-page">
      <div className="page-header">
        <h2>Материалы</h2>
      </div>

      <div className="section-selection">
        <p className="selection-label">Выберите раздел:</p>
        <div className="section-cards">
          {mainSections.map((section) => (
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

        <div className="bsm-divider">
          <span className="bsm-divider-text">БСМ</span>
        </div>

        <div className="section-cards bsm-cards">
          {bsmSections.map((section) => (
            <button
              key={section.path}
              className="section-card bsm-card"
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

export default BSMSelectionPage
