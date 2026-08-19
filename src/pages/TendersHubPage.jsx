import { useState, useEffect } from 'react'
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
import { IconJoint, IconOther } from '../components/icons/ToolbarIcons'
import { useRole } from '../contexts/RoleContext'
import { fetchTenderHubCounters } from '../services/tenderCounters'
import './TendersHubPage.css'

// Связанные разделы принадлежат только «Основному строительству».
const CONSTRUCTION_SUBSECTIONS = [
  { to: '/vors', Icon: IconDocument, title: 'ВОРы и РД', desc: 'Ведомости объёмов работ и рабочая документация' },
  { to: '/tenders/materials', Icon: IconPackage, title: 'Тендеры на материалы', desc: 'Закупка материалов по объектам' },
  { to: '/cost-plans', Icon: IconCalculator, title: 'Планы затрат', desc: 'Планирование стоимости по тендерам' },
  // task 431: очередь проверки КП аналитиком-экономистом.
  { to: '/kp-review', Icon: IconShieldCheck, title: 'Проверка КП', desc: 'Проверка коммерческих предложений аналитиком' },
]

// Направления, добавленные к основному строительству и гарантийному отделу.
// Собственных подразделов у них нет — ВОРы, планы затрат и тендеры на материалы
// остаются за основным строительством.
const EXTRA_DIRECTIONS = [
  {
    to: '/tenders/joint',
    tone: 'violet',
    Icon: IconJoint,
    title: 'Совместные тендеры',
    desc: 'Тендеры, охватывающие объекты обоих отделов',
    countKey: 'jointInProgress',
  },
  {
    to: '/tenders/other',
    tone: 'slate',
    Icon: IconOther,
    title: 'Тендеры (прочее)',
    desc: 'Закупки и работы без привязки к конкретному объекту',
    countKey: 'otherInProgress',
  },
]

// Индикаторы для подраздела: что показать справа от названия.
// tone задаёт цвет: warn — требует внимания, blue — в работе, muted — ещё не начато.
// Нули не прячем: одинаковый набор бейджей во всех строках держит колонки ровными,
// а «0 на проверке» — такая же полезная информация, как и «22».
function subsectionCounters(to, counts) {
  if (!counts) return []
  switch (to) {
    case '/vors':
      return [
        { label: 'не начат', value: counts.vorNotStarted, tone: 'muted' },
        { label: 'в работе', value: counts.vorInProgress, tone: 'blue' },
      ]
    case '/tenders/materials':
      return [
        { label: 'не начат', value: counts.materialsNotStarted, tone: 'muted' },
        { label: 'в работе', value: counts.materialsInProgress, tone: 'blue' },
      ]
    case '/cost-plans':
      return [
        { label: 'не начат', value: counts.costPlanNotStarted, tone: 'muted' },
        { label: 'в работе', value: counts.costPlanInProgress, tone: 'blue' },
      ]
    case '/kp-review':
      return [{ label: 'на проверке', value: counts.kpPending, tone: 'warn' }]
    default:
      return []
  }
}

// task 254: страница-хаб «Тендеры» — два направления работы
// (Основное строительство / Гарантийный отдел). У «Основного строительства» —
// раскрывающийся блок связанных разделов; у «Гарантийного отдела» его нет.
function TendersHubPage() {
  const { scopedObjectIds } = useRole()
  const [expanded, setExpanded] = useState(true)
  // Счётчики «сколько сейчас в работе». null = ещё не загружены: пока их нет,
  // бейджи не рисуем, чтобы карточки не «прыгали» от подстановки чисел.
  const [counts, setCounts] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchTenderHubCounters(scopedObjectIds)
      .then((data) => { if (!cancelled) setCounts(data) })
      // Индикаторы декоративные: молча остаёмся без них, страница работает как раньше.
      .catch((err) => console.error('Не удалось загрузить счётчики тендеров:', err?.message || err))
    return () => { cancelled = true }
  }, [scopedObjectIds])

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
              {counts?.constructionInProgress > 0 && (
                <span className="thub-count thub-count--solid" title="Тендеры в статусе «Идет тендерная процедура»">
                  <strong>{counts.constructionInProgress}</strong> в работе
                </span>
              )}
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
              {CONSTRUCTION_SUBSECTIONS.map(({ to, Icon, title, desc }) => {
                const counters = subsectionCounters(to, counts)
                return (
                  <Link key={to} to={to} className="thub-sub-item">
                    <span className="thub-sub-icon" aria-hidden><Icon size={20} /></span>
                    <span className="thub-sub-text">
                      <strong>{title}</strong>
                      <small>{desc}</small>
                    </span>
                    {/* Колонка фиксированной ширины — бейджи и стрелки выстраиваются
                        по одной вертикали во всех строках, даже если счётчиков нет. */}
                    <span className="thub-sub-counts">
                      {counters.map(c => (
                        <span
                          key={c.label}
                          className={`thub-count thub-count--${c.tone}${c.value ? '' : ' is-zero'}`}
                        >
                          <strong>{c.value}</strong> {c.label}
                        </span>
                      ))}
                    </span>
                    <span className="thub-sub-arrow" aria-hidden><IconArrowRight size={16} /></span>
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {/* Гарантийный отдел — отдельное самостоятельное направление, без подразделов */}
        <section className="thub-card thub-card--green">
          <span className="thub-accent" aria-hidden />
          <div className="thub-card-body thub-card-body--centered">
            <span className="thub-badge thub-badge--green" aria-hidden><IconShieldCheck size={24} /></span>
            <h3 className="thub-title">Гарантийный отдел</h3>
            {counts?.warrantyInProgress > 0 && (
              <span className="thub-count thub-count--solid-green" title="Тендеры в статусе «Идет тендерная процедура»">
                <strong>{counts.warrantyInProgress}</strong> в работе
              </span>
            )}
            <p className="thub-desc">Тендеры по гарантийному обслуживанию сданных объектов</p>
            <Link to="/tenders/warranty" className="thub-btn thub-btn--green">
              Перейти к тендерам <IconArrowRight size={16} />
            </Link>
          </div>
        </section>

        {/* Совместные и прочие — такие же самостоятельные реестры, как гарантийный
            отдел: подразделы (ВОРы, планы затрат, материалы) остаются у ОС. */}
        {EXTRA_DIRECTIONS.map(({ to, tone, Icon, title, desc, countKey }) => (
          <section key={to} className={`thub-card thub-card--${tone}`}>
            <span className="thub-accent" aria-hidden />
            <div className="thub-card-body thub-card-body--centered">
              <span className={`thub-badge thub-badge--${tone}`} aria-hidden><Icon size={24} /></span>
              <h3 className="thub-title">{title}</h3>
              {counts?.[countKey] > 0 && (
                <span className={`thub-count thub-count--solid-${tone}`} title="Тендеры в статусе «Идет тендерная процедура»">
                  <strong>{counts[countKey]}</strong> в работе
                </span>
              )}
              <p className="thub-desc">{desc}</p>
              <Link to={to} className={`thub-btn thub-btn--${tone}`}>
                Перейти к тендерам <IconArrowRight size={16} />
              </Link>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export default TendersHubPage
