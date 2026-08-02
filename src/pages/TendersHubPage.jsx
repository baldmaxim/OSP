import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconBuilding,
  IconHardHat,
  IconShieldCheck,
  IconDocument,
  IconPackage,
  IconCalculator,
  IconChevronDown,
  IconArrowRight,
} from '../components/icons/TenderHubIcons'
import './TendersHubPage.css'

// Связанные разделы принадлежат только «Основному строительству».
const CONSTRUCTION_SUBSECTIONS = [
  { to: '/vors', Icon: IconDocument, title: 'ВОРы и РД', desc: 'Ведомости объёмов работ и рабочая документация' },
  { to: '/tenders/materials', Icon: IconPackage, title: 'Тендеры на материалы', desc: 'Закупка материалов по объектам' },
  { to: '/cost-plans', Icon: IconCalculator, title: 'Планы затрат', desc: 'Планирование стоимости по тендерам' },
  // task 431: очередь проверки КП аналитиком-экономистом.
  { to: '/kp-review', Icon: IconShieldCheck, title: 'Проверка КП', desc: 'Проверка коммерческих предложений аналитиком' },
]

// task 254: страница-хаб «Тендеры» — два направления работы
// (Основное строительство / Гарантийный отдел). У «Основного строительства» —
// раскрывающийся блок связанных разделов; у «Гарантийного отдела» его нет.
function TendersHubPage() {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="tenders-hub">
      <header className="thub-header">
        <div className="thub-header-title">
          <span className="thub-header-icon" aria-hidden><IconBuilding size={22} /></span>
          <h2>Тендеры</h2>
        </div>
        <div className="thub-header-select">
          <span>Выберите направление работы</span>
          <IconChevronDown size={16} />
        </div>
      </header>

      <div className="thub-grid">
        {/* Основное строительство */}
        <section className="thub-card thub-card--blue">
          <span className="thub-accent" aria-hidden />
          <div className="thub-card-body">
            <span className="thub-badge thub-badge--blue" aria-hidden><IconHardHat size={24} /></span>
            <div className="thub-title-row">
              <h3 className="thub-title">Основное строительство</h3>
              <button
                type="button"
                className={`thub-toggle ${expanded ? 'is-open' : ''}`}
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-controls="thub-construction-sub"
                title={expanded ? 'Свернуть связанные разделы' : 'Развернуть связанные разделы'}
              >
                <IconChevronDown size={20} />
              </button>
            </div>
            <p className="thub-desc">Тендеры по основным строительно-монтажным работам</p>
            <Link to="/tenders/construction" className="thub-btn thub-btn--blue">
              Перейти к тендерам <IconArrowRight size={16} />
            </Link>
          </div>

          {expanded && (
            <div className="thub-sub" id="thub-construction-sub">
              {CONSTRUCTION_SUBSECTIONS.map(({ to, Icon, title, desc }) => (
                <Link key={to} to={to} className="thub-sub-item">
                  <span className="thub-sub-icon" aria-hidden><Icon size={20} /></span>
                  <span className="thub-sub-text">
                    <strong>{title}</strong>
                    <small>{desc}</small>
                  </span>
                  <span className="thub-sub-arrow" aria-hidden><IconArrowRight size={16} /></span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Гарантийный отдел — отдельное самостоятельное направление, без подразделов */}
        <section className="thub-card thub-card--green">
          <span className="thub-accent" aria-hidden />
          <div className="thub-card-body thub-card-body--centered">
            <span className="thub-badge thub-badge--green" aria-hidden><IconShieldCheck size={24} /></span>
            <h3 className="thub-title">Гарантийный отдел</h3>
            <p className="thub-desc">Тендеры по гарантийному обслуживанию сданных объектов</p>
            <Link to="/tenders/warranty" className="thub-btn thub-btn--green">
              Перейти к тендерам <IconArrowRight size={16} />
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}

export default TendersHubPage
