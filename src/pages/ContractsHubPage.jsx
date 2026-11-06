import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { IconArrowRight, IconChevronDown } from '../components/icons/TenderHubIcons'
import { IconContracts, IconDcRequest, IconDocCheck, IconDpRequest } from '../components/icons/NavIcons'
import AccessDenied from '../components/AccessDenied'
import { useRole } from '../contexts/RoleContext'
import { fetchContractsHubCounters } from '../services/contractsHubCounters'
import { CONTRACTS_REGISTRY_PATH, visibleContractSections } from '../utils/contractsHub'
import { plural } from '../utils/taskHelpers'
import './TendersHubPage.css'

const ICONS = {
  contracts: IconContracts,
  dc_requests: IconDcRequest,
  dp_requests: IconDpRequest,
  doc_check_requests: IconDocCheck,
}

// Страница-хаб «Договоры и ДС» — как «Тендеры»: шапка и карточки направлений, стили общие. Показаны только блоки, открытые
// роли; сами страницы проверяют то же право на своём маршруте (App.jsx), так что прямая ссылка закрыта и без хаба.
function ContractsHubPage() {
  const { canView, scopedObjectIds } = useRole()
  const location = useLocation()
  const sections = useMemo(() => visibleContractSections(canView), [canView])
  const sectionKeys = sections.map((s) => s.section).join(',')
  const showHub = sections.length > 1 && !location.search && !location.hash
  // null — ещё не загружены: бейджи не рисуем, чтобы карточки не прыгали от подстановки чисел.
  const [counts, setCounts] = useState(null)

  useEffect(() => {
    if (!showHub) return undefined
    let cancelled = false
    fetchContractsHubCounters(sectionKeys.split(','), scopedObjectIds)
      .then((data) => { if (!cancelled) setCounts(data) })
      // Индикаторы декоративные: без них страница работает так же.
      .catch((err) => console.error('Не удалось загрузить счётчики договоров:', err?.message || err))
    return () => { cancelled = true }
  }, [showHub, sectionKeys, scopedObjectIds])

  // Адрес с параметрами — прежняя ссылка на реестр (/contracts?ds=…): право проверит маршрут реестра.
  if (location.search || location.hash) {
    return <Navigate to={`${CONTRACTS_REGISTRY_PATH}${location.search}${location.hash}`} replace />
  }
  if (sections.length === 0) return <AccessDenied />
  if (sections.length === 1) return <Navigate to={sections[0].to} replace />

  return (
    <div className="tenders-hub contracts-hub">
      <header className="thub-header">
        <div className="thub-header-title">
          <span className="thub-header-icon" aria-hidden><IconContracts /></span>
          <h2>Договоры и ДС</h2>
        </div>
        <div className="thub-header-select">
          <span>Выберите раздел работы</span>
          <IconChevronDown size={16} />
        </div>
      </header>

      <div className="thub-grid thub-grid--even">
        {sections.map(({ section, to, title, desc, action, tone, counters }) => {
          const Icon = ICONS[section]
          const shown = counters.filter((c) => counts?.[c.key] > 0)
          return (
            <section key={section} className={`thub-card thub-card--${tone}`}>
              <span className="thub-accent" aria-hidden />
              <div className="thub-card-body thub-card-body--centered">
                <span className={`thub-badge thub-badge--${tone}`} aria-hidden><Icon /></span>
                <h3 className="thub-title">{title}</h3>
                {shown.length > 0 && (
                  <div className="thub-card-counts">
                    {shown.map((c) => (
                      <span key={c.key} className={`thub-count thub-count--solid${tone === 'blue' ? '' : `-${tone}`}`}>
                        <strong>{counts[c.key]}</strong> {plural(counts[c.key], ...c.forms)}
                      </span>
                    ))}
                  </div>
                )}
                <p className="thub-desc">{desc}</p>
                <Link to={to} className={`thub-btn thub-btn--${tone}`}>
                  {action} <IconArrowRight size={16} />
                </Link>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

export default ContractsHubPage
