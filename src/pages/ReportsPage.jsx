import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './ReportsPage.css'

function ReportsPage() {
  const { scopedObjectId } = useRole()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [activeTab, setActiveTab] = useState('tenders')
  // null = обзор, 'construction' | 'warranty' = детализация по выбранному отделу
  const [tDeptView, setTDeptView] = useState(null)

  useEffect(() => {
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedObjectId])

  const fetchStats = async () => {
    try {
      setLoading(true)

      let tendersQ = supabase
        .from('tenders')
        .select(`
          id, object_id, status, end_date, responsible_contact_id, tender_type, deleted_at,
          cost_plan_status, cost_plan_responsible_id, cost_plan_end_date,
          vor_status, vor_responsible_id, vor_end_date,
          materials_proposal_deadline,
          winner_counterparty_id,
          objects(status),
          responsible_contact:contacts!responsible_contact_id(id, full_name),
          cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name),
          vor_responsible:contacts!vor_responsible_id(id, full_name),
          winner:counterparties!winner_counterparty_id(id, name)
        `)
      if (scopedObjectId) tendersQ = tendersQ.eq('object_id', scopedObjectId)
      const { data: tendersRaw } = await tendersQ

      let contractsQ = supabase
        .from('contracts')
        .select('id, object_id, status, contract_amount, counterparty_id, objects(status)')
      if (scopedObjectId) contractsQ = contractsQ.eq('object_id', scopedObjectId)
      const { data: contracts } = await contractsQ

      // Отчёт по тендерам считаем только по основным тендерам, не по дочерним на материалы.
      // Если миграция tender_type не применена, x.tender_type === undefined — учитываем как main.
      const allTenders = (tendersRaw || []).filter(x => !x.deleted_at)
      const t = allTenders.filter(x => !x.tender_type || x.tender_type === 'main')
      const materialsTenders = allTenders.filter(x => x.tender_type === 'materials')
      const c = contracts || []
      const today = new Date().toISOString().split('T')[0]

      const isOpen = (x) => x.status !== 'Завершен'
      const isClosed = (x) => x.status === 'Завершен'

      const tConst = t.filter(x => x.objects?.status === 'main_construction')
      const tWar = t.filter(x => x.objects?.status === 'warranty_service')
      const cConst = c.filter(x => x.objects?.status === 'main_construction')
      const cWar = c.filter(x => x.objects?.status === 'warranty_service')

      const groupByResponsible = (rows) => {
        const map = new Map()
        for (const x of rows) {
          const id = x.responsible_contact_id || '_unassigned'
          const name = x.responsible_contact?.full_name || 'Не назначен'
          if (!map.has(id)) {
            map.set(id, { id, name, inWork: 0, completed: 0 })
          }
          const row = map.get(id)
          if (isClosed(x)) row.completed += 1
          else row.inWork += 1
        }
        return Array.from(map.values())
          .map(r => ({ ...r, total: r.inWork + r.completed }))
          .sort((a, b) => b.total - a.total)
      }

      const overdueCount = (rows) =>
        rows.filter(x => isOpen(x) && x.end_date && x.end_date < today).length
      const unassignedCount = (rows) => rows.filter(x => !x.responsible_contact_id).length

      const sumAmount = (rows) => rows.reduce((acc, r) => acc + (Number(r.contract_amount) || 0), 0)

      // Общая группировка по ответственному с произвольным предикатом «завершено»
      // и произвольным getter ответственного — реюзается для materials/cost-plans/vor.
      const groupByResponsibleGeneric = (rows, getRespId, getRespName, isDoneFn) => {
        const map = new Map()
        for (const x of rows) {
          const id = getRespId(x) || '_unassigned'
          const name = getRespName(x) || 'Не назначен'
          if (!map.has(id)) map.set(id, { id, name, inWork: 0, completed: 0 })
          const row = map.get(id)
          if (isDoneFn(x)) row.completed += 1
          else row.inWork += 1
        }
        return Array.from(map.values())
          .map(r => ({ ...r, total: r.inWork + r.completed }))
          .sort((a, b) => b.total - a.total)
      }

      // === Тендеры на материалы ===
      const isMaterialsClosed = (x) => x.status === 'Завершён' || x.status === 'Завершен'
      const isMaterialsOpen = (x) => !isMaterialsClosed(x)
      const isMaterialsInWork = (x) => x.status === 'В работе'
      const isMaterialsNotStarted = (x) => x.status === 'Не начат' || (!isMaterialsClosed(x) && !isMaterialsInWork(x))
      const mat = {
        total: materialsTenders.length,
        open: materialsTenders.filter(isMaterialsOpen).length,
        closed: materialsTenders.filter(isMaterialsClosed).length,
        notStarted: materialsTenders.filter(isMaterialsNotStarted).length,
        inWork: materialsTenders.filter(isMaterialsInWork).length,
        overdue: materialsTenders.filter(x =>
          isMaterialsOpen(x) && x.materials_proposal_deadline && x.materials_proposal_deadline < today
        ).length,
        unassigned: materialsTenders.filter(x => !x.responsible_contact_id).length,
        byResp: groupByResponsibleGeneric(
          materialsTenders,
          (x) => x.responsible_contact_id,
          (x) => x.responsible_contact?.full_name,
          isMaterialsClosed
        ),
      }

      // === Планы затрат (только основные тендеры основного строительства) ===
      const cpRows = tConst
      const isCpDone = (x) => x.cost_plan_status === 'completed'
      const cp = {
        total: cpRows.length,
        notStarted: cpRows.filter(x => !x.cost_plan_status || x.cost_plan_status === 'not_started').length,
        inProgress: cpRows.filter(x => x.cost_plan_status === 'in_progress').length,
        completed: cpRows.filter(isCpDone).length,
        overdue: cpRows.filter(x => !isCpDone(x) && x.cost_plan_end_date && x.cost_plan_end_date < today).length,
        unassigned: cpRows.filter(x => !x.cost_plan_responsible_id).length,
        byResp: groupByResponsibleGeneric(
          cpRows,
          (x) => x.cost_plan_responsible_id,
          (x) => x.cost_plan_responsible?.full_name,
          isCpDone
        ),
      }

      // === Победители тендеров ===
      // Считаем только завершённые основные тендеры с указанным победителем.
      const winnerTenders = t.filter(x => isClosed(x) && x.winner_counterparty_id)
      const contractsByCounterparty = (c || []).reduce((acc, contract) => {
        const cpId = contract.counterparty_id
        if (!cpId) return acc
        if (!acc[cpId]) acc[cpId] = { signed: 0, signedAmount: 0, total: 0, totalAmount: 0 }
        const amount = Number(contract.contract_amount) || 0
        acc[cpId].total += 1
        acc[cpId].totalAmount += amount
        if (contract.status === 'signed') {
          acc[cpId].signed += 1
          acc[cpId].signedAmount += amount
        }
        return acc
      }, {})

      const winnerMap = new Map()
      for (const x of winnerTenders) {
        const id = x.winner_counterparty_id
        const name = x.winner?.name || 'Контрагент удалён'
        if (!winnerMap.has(id)) {
          winnerMap.set(id, {
            id,
            name,
            wins: 0,
            winsConst: 0,
            winsWar: 0,
            signedContracts: 0,
            signedAmount: 0,
          })
        }
        const row = winnerMap.get(id)
        row.wins += 1
        if (x.objects?.status === 'main_construction') row.winsConst += 1
        else if (x.objects?.status === 'warranty_service') row.winsWar += 1
        const cStats = contractsByCounterparty[id]
        if (cStats) {
          row.signedContracts = cStats.signed
          row.signedAmount = cStats.signedAmount
        }
      }
      const winners = {
        total: winnerTenders.length,
        unique: winnerMap.size,
        totalAmount: Array.from(winnerMap.values()).reduce((s, r) => s + r.signedAmount, 0),
        rows: Array.from(winnerMap.values()).sort((a, b) => b.wins - a.wins || b.signedAmount - a.signedAmount),
      }

      // === ВОРы и РД ===
      const vorRows = tConst
      const isVorDone = (x) => x.vor_status === 'completed'
      const vor = {
        total: vorRows.length,
        notStarted: vorRows.filter(x => !x.vor_status || x.vor_status === 'not_started').length,
        inProgress: vorRows.filter(x => x.vor_status === 'in_progress').length,
        completed: vorRows.filter(isVorDone).length,
        overdue: vorRows.filter(x => !isVorDone(x) && x.vor_end_date && x.vor_end_date < today).length,
        unassigned: vorRows.filter(x => !x.vor_responsible_id).length,
        byResp: groupByResponsibleGeneric(
          vorRows,
          (x) => x.vor_responsible_id,
          (x) => x.vor_responsible?.full_name,
          isVorDone
        ),
      }

      setStats({
        // Тендеры — общие
        tTotal: t.length,
        tOpen: t.filter(isOpen).length,
        tClosed: t.filter(isClosed).length,
        tOverdue: overdueCount(t),
        tUnassigned: unassignedCount(t),
        // По отделам тендеры
        tOpenConst: tConst.filter(isOpen).length,
        tClosedConst: tConst.filter(isClosed).length,
        tTotalConst: tConst.length,
        tOverdueConst: overdueCount(tConst),
        tUnassignedConst: unassignedCount(tConst),
        tOpenWar: tWar.filter(isOpen).length,
        tClosedWar: tWar.filter(isClosed).length,
        tTotalWar: tWar.length,
        tOverdueWar: overdueCount(tWar),
        tUnassignedWar: unassignedCount(tWar),
        // По ответственным
        byResponsible: groupByResponsible(t),
        byResponsibleConst: groupByResponsible(tConst),
        byResponsibleWar: groupByResponsible(tWar),
        // Договоры — общие
        cTotal: c.length,
        cPending: c.filter(x => x.status === 'pending').length,
        cSigned: c.filter(x => x.status === 'signed').length,
        cAmountTotal: sumAmount(c),
        cAmountSigned: sumAmount(c.filter(x => x.status === 'signed')),
        // По отделам договоры
        cPendingConst: cConst.filter(x => x.status === 'pending').length,
        cSignedConst: cConst.filter(x => x.status === 'signed').length,
        cTotalConst: cConst.length,
        cAmountConst: sumAmount(cConst),
        cPendingWar: cWar.filter(x => x.status === 'pending').length,
        cSignedWar: cWar.filter(x => x.status === 'signed').length,
        cTotalWar: cWar.length,
        cAmountWar: sumAmount(cWar),
        // Тендеры на материалы
        mat,
        // Планы затрат
        cp,
        // ВОРы и РД
        vor,
        // Победители тендеров
        winners,
      })
    } catch (err) {
      console.error('Ошибка загрузки отчётов:', err.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="reports-page">
        <div className="reports-header"><h2>Отчёты</h2></div>
        <div className="reports-loading">Загрузка...</div>
      </div>
    )
  }
  if (!stats) return null
  const s = stats

  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0
  const fmtMoney = (n) => {
    if (!n) return '0 ₽'
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₽'
  }

  // Данные текущего отдела (для детального вида)
  const deptData = tDeptView === 'construction'
    ? {
      title: 'Основное строительство',
      icon: '🏗️',
      accent: 'dept-card--construction',
      total: s.tTotalConst,
      open: s.tOpenConst,
      closed: s.tClosedConst,
      overdue: s.tOverdueConst,
      unassigned: s.tUnassignedConst,
      byResp: s.byResponsibleConst,
    }
    : tDeptView === 'warranty'
      ? {
        title: 'Гарантийный отдел',
        icon: '🛡️',
        accent: 'dept-card--warranty',
        total: s.tTotalWar,
        open: s.tOpenWar,
        closed: s.tClosedWar,
        overdue: s.tOverdueWar,
        unassigned: s.tUnassignedWar,
        byResp: s.byResponsibleWar,
      }
      : null

  const reportTabs = [
    { key: 'tenders', label: 'Тендеры', icon: '🏗️', accent: 'tab-blue', count: s.tTotal },
    { key: 'winners', label: 'Победители', icon: '🏆', accent: 'tab-amber', count: s.winners.unique },
    { key: 'materials', label: 'Материалы', icon: '📦', accent: 'tab-violet', count: s.mat.total },
    { key: 'cost_plans', label: 'Планы затрат', icon: '💰', accent: 'tab-emerald', count: s.cp.total },
    { key: 'vors', label: 'ВОРы и РД', icon: '📐', accent: 'tab-cyan', count: s.vor.total },
    { key: 'contracts', label: 'Договоры', icon: '📝', accent: 'tab-rose', count: s.cTotal },
  ]

  return (
    <div className="reports-page">
      <div className="reports-header">
        <div>
          <h2>Отчёты</h2>
          <div className="reports-subtitle">Состояние тендерной работы и договорной активности</div>
        </div>
      </div>

      <nav className="reports-nav" aria-label="Разделы отчётов">
        {reportTabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            className={`reports-nav-card ${tab.accent} ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(tab.key)
              if (tab.key !== 'tenders') setTDeptView(null)
            }}
            aria-pressed={activeTab === tab.key}
          >
            <span className="reports-nav-icon" aria-hidden>{tab.icon}</span>
            <span className="reports-nav-label">{tab.label}</span>
            <span className="reports-nav-count">{tab.count}</span>
          </button>
        ))}
      </nav>

      <div className="reports-content">
        {activeTab === 'tenders' && !deptData && (
          <>
            {/* KPI */}
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.tTotal}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value">{s.tOpen}</div>
                <div className="kpi-foot">{pct(s.tOpen, s.tTotal)}% от всех</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.tClosed}</div>
                <div className="kpi-foot">{pct(s.tClosed, s.tTotal)}% завершения</div>
              </div>
              <div className={`kpi-card ${s.tOverdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${s.tOverdue > 0 ? 'accent-danger' : ''}`}>{s.tOverdue}</div>
                <div className="kpi-foot">сроки прошли</div>
              </div>
              <div className={`kpi-card ${s.tUnassigned > 0 ? 'kpi-card--warn' : ''}`}>
                <div className="kpi-label">Без ответственного</div>
                <div className={`kpi-value ${s.tUnassigned > 0 ? 'accent-warn' : ''}`}>{s.tUnassigned}</div>
                <div className="kpi-foot">требуют назначения</div>
              </div>
            </div>

            {/* Большие кликабельные карточки по отделам */}
            <section className="report-section">
              <header className="section-head">
                <h3>По отделам</h3>
                <span className="section-meta">нажмите для деталей</span>
              </header>
              <div className="dept-grid">
                <button
                  type="button"
                  className="dept-card dept-card--construction"
                  onClick={() => setTDeptView('construction')}
                >
                  <div className="dept-card-head">
                    <span className="dept-icon" aria-hidden>🏗️</span>
                    <div>
                      <div className="dept-name">Основное строительство</div>
                      <div className="dept-total">{s.tTotalConst} <span className="dept-total-label">тендеров</span></div>
                    </div>
                    <span className="dept-arrow" aria-hidden>→</span>
                  </div>
                  <div className="dept-metrics">
                    <div className="dept-metric">
                      <span className="dept-metric-label">В работе</span>
                      <span className="dept-metric-value">{s.tOpenConst}</span>
                    </div>
                    <div className="dept-metric">
                      <span className="dept-metric-label">Завершено</span>
                      <span className="dept-metric-value accent-success">{s.tClosedConst}</span>
                    </div>
                    {s.tOverdueConst > 0 && (
                      <div className="dept-metric">
                        <span className="dept-metric-label">Просрочено</span>
                        <span className="dept-metric-value accent-danger">{s.tOverdueConst}</span>
                      </div>
                    )}
                  </div>
                  <div className="dept-progress">
                    <ProgressBar value={s.tClosedConst} total={s.tTotalConst} />
                  </div>
                </button>

                <button
                  type="button"
                  className="dept-card dept-card--warranty"
                  onClick={() => setTDeptView('warranty')}
                >
                  <div className="dept-card-head">
                    <span className="dept-icon" aria-hidden>🛡️</span>
                    <div>
                      <div className="dept-name">Гарантийный отдел</div>
                      <div className="dept-total">{s.tTotalWar} <span className="dept-total-label">тендеров</span></div>
                    </div>
                    <span className="dept-arrow" aria-hidden>→</span>
                  </div>
                  <div className="dept-metrics">
                    <div className="dept-metric">
                      <span className="dept-metric-label">В работе</span>
                      <span className="dept-metric-value">{s.tOpenWar}</span>
                    </div>
                    <div className="dept-metric">
                      <span className="dept-metric-label">Завершено</span>
                      <span className="dept-metric-value accent-success">{s.tClosedWar}</span>
                    </div>
                    {s.tOverdueWar > 0 && (
                      <div className="dept-metric">
                        <span className="dept-metric-label">Просрочено</span>
                        <span className="dept-metric-value accent-danger">{s.tOverdueWar}</span>
                      </div>
                    )}
                  </div>
                  <div className="dept-progress">
                    <ProgressBar value={s.tClosedWar} total={s.tTotalWar} />
                  </div>
                </button>
              </div>
            </section>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{s.byResponsible.length}</span>
              </header>
              {s.byResponsible.length === 0 ? (
                <div className="section-empty">Тендеров пока нет</div>
              ) : (
                <ResponsibleTable rows={s.byResponsible} />
              )}
            </section>
          </>
        )}

        {activeTab === 'tenders' && deptData && (
          <>
            <div className="reports-breadcrumb">
              <button className="reports-back" onClick={() => setTDeptView(null)}>
                ← Все отделы
              </button>
              <span className="reports-breadcrumb-sep">·</span>
              <span className="reports-breadcrumb-current">
                <span aria-hidden style={{ marginRight: '0.375rem' }}>{deptData.icon}</span>
                {deptData.title}
              </span>
            </div>

            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего</div>
                <div className="kpi-value">{deptData.total}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value">{deptData.open}</div>
                <div className="kpi-foot">{pct(deptData.open, deptData.total)}% от всех</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{deptData.closed}</div>
                <div className="kpi-foot">{pct(deptData.closed, deptData.total)}% завершения</div>
              </div>
              <div className={`kpi-card ${deptData.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${deptData.overdue > 0 ? 'accent-danger' : ''}`}>{deptData.overdue}</div>
                <div className="kpi-foot">сроки прошли</div>
              </div>
              <div className={`kpi-card ${deptData.unassigned > 0 ? 'kpi-card--warn' : ''}`}>
                <div className="kpi-label">Без ответственного</div>
                <div className={`kpi-value ${deptData.unassigned > 0 ? 'accent-warn' : ''}`}>{deptData.unassigned}</div>
                <div className="kpi-foot">требуют назначения</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{deptData.byResp.length}</span>
              </header>
              {deptData.byResp.length === 0 ? (
                <div className="section-empty">В этом отделе тендеров нет</div>
              ) : (
                <ResponsibleTable rows={deptData.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'winners' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Завершённых тендеров с победителем</div>
                <div className="kpi-value">{s.winners.total}</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Уникальных победителей</div>
                <div className="kpi-value accent-success">{s.winners.unique}</div>
                <div className="kpi-foot">подрядчиков-победителей</div>
              </div>
              <div className="kpi-card kpi-card-wide">
                <div className="kpi-label">Сумма заключённых договоров</div>
                <div className="kpi-value">{fmtMoney(s.winners.totalAmount)}</div>
                <div className="kpi-foot">по победителям тендеров</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>Рейтинг победителей</h3>
                <span className="section-meta">{s.winners.rows.length}</span>
              </header>
              {s.winners.rows.length === 0 ? (
                <div className="section-empty">Победителей пока нет. Назначьте победителя у завершённого тендера.</div>
              ) : (
                <WinnersTable rows={s.winners.rows} fmtMoney={fmtMoney} />
              )}
            </section>
          </>
        )}

        {activeTab === 'materials' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.mat.total}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.mat.notStarted}</div>
                <div className="kpi-foot">{pct(s.mat.notStarted, s.mat.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.mat.inWork}</div>
                <div className="kpi-foot">{pct(s.mat.inWork, s.mat.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.mat.closed}</div>
                <div className="kpi-foot">{pct(s.mat.closed, s.mat.total)}% завершения</div>
              </div>
              <div className={`kpi-card ${s.mat.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено (КП)</div>
                <div className={`kpi-value ${s.mat.overdue > 0 ? 'accent-danger' : ''}`}>{s.mat.overdue}</div>
                <div className="kpi-foot">срок предоставления КП прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{s.mat.byResp.length}</span>
              </header>
              {s.mat.byResp.length === 0 ? (
                <div className="section-empty">Тендеров на материалы пока нет</div>
              ) : (
                <ResponsibleTable rows={s.mat.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'cost_plans' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.cp.total}</div>
                <div className="kpi-foot">только основное строительство</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.cp.notStarted}</div>
                <div className="kpi-foot">{pct(s.cp.notStarted, s.cp.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.cp.inProgress}</div>
                <div className="kpi-foot">{pct(s.cp.inProgress, s.cp.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.cp.completed}</div>
                <div className="kpi-foot">{pct(s.cp.completed, s.cp.total)}% готовности</div>
              </div>
              <div className={`kpi-card ${s.cp.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${s.cp.overdue > 0 ? 'accent-danger' : ''}`}>{s.cp.overdue}</div>
                <div className="kpi-foot">срок плана прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным за план затрат</h3>
                <span className="section-meta">{s.cp.byResp.length}</span>
              </header>
              {s.cp.byResp.length === 0 ? (
                <div className="section-empty">Тендеров основного строительства пока нет</div>
              ) : (
                <ResponsibleTable rows={s.cp.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'vors' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.vor.total}</div>
                <div className="kpi-foot">только основное строительство</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.vor.notStarted}</div>
                <div className="kpi-foot">{pct(s.vor.notStarted, s.vor.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.vor.inProgress}</div>
                <div className="kpi-foot">{pct(s.vor.inProgress, s.vor.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.vor.completed}</div>
                <div className="kpi-foot">{pct(s.vor.completed, s.vor.total)}% готовности</div>
              </div>
              <div className={`kpi-card ${s.vor.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${s.vor.overdue > 0 ? 'accent-danger' : ''}`}>{s.vor.overdue}</div>
                <div className="kpi-foot">срок ВОР прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным за ВОР</h3>
                <span className="section-meta">{s.vor.byResp.length}</span>
              </header>
              {s.vor.byResp.length === 0 ? (
                <div className="section-empty">Тендеров основного строительства пока нет</div>
              ) : (
                <ResponsibleTable rows={s.vor.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'contracts' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего договоров</div>
                <div className="kpi-value">{s.cTotal}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">На стадии заключения</div>
                <div className="kpi-value">{s.cPending}</div>
                <div className="kpi-foot">{pct(s.cPending, s.cTotal)}% от всех</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Заключено</div>
                <div className="kpi-value accent-success">{s.cSigned}</div>
                <div className="kpi-foot">{pct(s.cSigned, s.cTotal)}% заключено</div>
              </div>
              <div className="kpi-card kpi-card-wide">
                <div className="kpi-label">Сумма заключённых</div>
                <div className="kpi-value">{fmtMoney(s.cAmountSigned)}</div>
                <div className="kpi-foot">всего по договорам: {fmtMoney(s.cAmountTotal)}</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По отделам</h3>
              </header>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>Отдел</th>
                    <th className="num">На стадии</th>
                    <th className="num">Заключено</th>
                    <th className="num">Всего</th>
                    <th className="num">Сумма</th>
                    <th className="bar-col">Готовность</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Основное строительство</td>
                    <td className="num">{s.cPendingConst}</td>
                    <td className="num">{s.cSignedConst}</td>
                    <td className="num strong">{s.cTotalConst}</td>
                    <td className="num">{fmtMoney(s.cAmountConst)}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.cSignedConst} total={s.cTotalConst} />
                    </td>
                  </tr>
                  <tr>
                    <td>Гарантийный отдел</td>
                    <td className="num">{s.cPendingWar}</td>
                    <td className="num">{s.cSignedWar}</td>
                    <td className="num strong">{s.cTotalWar}</td>
                    <td className="num">{fmtMoney(s.cAmountWar)}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.cSignedWar} total={s.cTotalWar} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function ResponsibleTable({ rows }) {
  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th>Сотрудник</th>
          <th className="num">В работе</th>
          <th className="num">Завершено</th>
          <th className="num">Всего</th>
          <th className="bar-col">Завершение</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const isUnassigned = r.id === '_unassigned'
          return (
            <tr key={r.id}>
              <td className={isUnassigned ? 'muted' : ''}>{r.name}</td>
              <td className="num">{r.inWork}</td>
              <td className="num">{r.completed}</td>
              <td className="num strong">{r.total}</td>
              <td className="bar-col">
                <ProgressBar value={r.completed} total={r.total} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function WinnersTable({ rows, fmtMoney }) {
  const maxWins = Math.max(...rows.map(r => r.wins), 1)
  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th style={{ width: '44px' }} className="num">#</th>
          <th>Контрагент</th>
          <th className="num">Побед</th>
          <th className="num">Стр-во</th>
          <th className="num">Гарантия</th>
          <th className="num">Договоров</th>
          <th className="num">Сумма</th>
          <th className="bar-col">Доля побед</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <tr key={r.id}>
            <td className="num" style={{ fontWeight: 600, color: idx < 3 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : idx + 1}
            </td>
            <td style={{ fontWeight: 500 }}>{r.name}</td>
            <td className="num strong">{r.wins}</td>
            <td className="num">{r.winsConst || '—'}</td>
            <td className="num">{r.winsWar || '—'}</td>
            <td className="num">{r.signedContracts || '—'}</td>
            <td className="num">{r.signedAmount > 0 ? fmtMoney(r.signedAmount) : '—'}</td>
            <td className="bar-col">
              <ProgressBar value={r.wins} total={maxWins} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProgressBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="bar-with-pct">
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-pct">{pct}%</span>
    </div>
  )
}

export default ReportsPage
