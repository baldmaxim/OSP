import { Link } from 'react-router-dom'
import './TendersHubPage.css'

// task 254: страница-хаб «Тендеры» — две карточки направлений
// (Основное строительство / Гарантийный отдел) + связанные разделы.
function TendersHubPage() {
  return (
    <div className="tenders-hub">
      <div className="page-header">
        <h2><span className="page-icon" aria-hidden>📢</span> Тендеры</h2>
        <div className="tenders-hub-hint">Выберите направление работы</div>
      </div>

      <div className="tenders-hub-grid">
        {/* Основное строительство */}
        <section className="tenders-hub-card tenders-hub-card--construction">
          <Link to="/tenders/construction" className="tenders-hub-main">
            <span className="tenders-hub-badge" aria-hidden>🏗️</span>
            <span className="tenders-hub-title">Основное строительство</span>
            <span className="tenders-hub-desc">
              Тендеры по основным строительно-монтажным работам
            </span>
            <span className="tenders-hub-cta">Перейти к тендерам →</span>
          </Link>

          <div className="tenders-hub-sub">
            <span className="tenders-hub-sub-label">Связанные разделы</span>
            <div className="tenders-hub-chips">
              <Link to="/vors" className="tenders-hub-chip">
                <span className="tenders-hub-chip-icon" aria-hidden>📐</span>
                <span className="tenders-hub-chip-text">
                  <strong>ВОРы и РД</strong>
                  <small>Ведомости объёмов работ и рабочая документация</small>
                </span>
                <span className="tenders-hub-chip-arrow" aria-hidden>→</span>
              </Link>
              <Link to="/tenders/materials" className="tenders-hub-chip">
                <span className="tenders-hub-chip-icon" aria-hidden>📦</span>
                <span className="tenders-hub-chip-text">
                  <strong>Тендеры на материалы</strong>
                  <small>Закупка материалов по объектам</small>
                </span>
                <span className="tenders-hub-chip-arrow" aria-hidden>→</span>
              </Link>
              <Link to="/cost-plans" className="tenders-hub-chip">
                <span className="tenders-hub-chip-icon" aria-hidden>💰</span>
                <span className="tenders-hub-chip-text">
                  <strong>Планы затрат</strong>
                  <small>Планирование стоимости по тендерам</small>
                </span>
                <span className="tenders-hub-chip-arrow" aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>

        {/* Гарантийный отдел */}
        <section className="tenders-hub-card tenders-hub-card--warranty">
          <Link to="/tenders/warranty" className="tenders-hub-main tenders-hub-main--centered">
            <span className="tenders-hub-badge" aria-hidden>🛡️</span>
            <span className="tenders-hub-title">Гарантийный отдел</span>
            <span className="tenders-hub-desc">
              Тендеры по гарантийному обслуживанию сданных объектов
            </span>
            <span className="tenders-hub-cta">Перейти к тендерам →</span>
          </Link>
        </section>
      </div>
    </div>
  )
}

export default TendersHubPage
