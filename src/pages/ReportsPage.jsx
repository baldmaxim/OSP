import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './ReportsPage.css'

function ReportsPage() {
  const { scopedObjectId } = useRole()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [activeTab, setActiveTab] = useState('tenders')

  useEffect(() => {
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedObjectId])

  const fetchStats = async () => {
    try {
      setLoading(true)

      let tendersQ = supabase
        .from('tenders')
        .select('id, object_id, status, end_date, responsible_contact_id, objects(status), responsible_contact:contacts!responsible_contact_id(id, full_name)')
      if (scopedObjectId) tendersQ = tendersQ.eq('object_id', scopedObjectId)
      const { data: tenders } = await tendersQ

      let contractsQ = supabase
        .from('contracts')
        .select('id, object_id, status, contract_amount, objects(status)')
      if (scopedObjectId) contractsQ = contractsQ.eq('object_id', scopedObjectId)
      const { data: contracts } = await contractsQ

      const t = tenders || []
      const c = contracts || []
      const today = new Date().toISOString().split('T')[0]

      const isOpen = (x) => x.status !== 'Завершен'
      const isClosed = (x) => x.status === 'Завершен'

      const tConst = t.filter(x => x.objects?.status === 'main_construction')
      const tWar = t.filter(x => x.objects?.status === 'warranty_service')
      const cConst = c.filter(x => x.objects?.status === 'main_construction')
      const cWar = c.filter(x => x.objects?.status === 'warranty_service')

      // Группировка по ответственному (тендеры)
      const byResponsibleMap = new Map()
      for (const x of t) {
        const id = x.responsible_contact_id || '_unassigned'
        const name = x.responsible_contact?.full_name || 'Не назначен'
        if (!byResponsibleMap.has(id)) {
          byResponsibleMap.set(id, { id, name, inWork: 0, completed: 0 })
        }
        const row = byResponsibleMap.get(id)
        if (isClosed(x)) row.completed += 1
        else row.inWork += 1
      }
      const byResponsible = Array.from(byResponsibleMap.values())
        .map(r => ({ ...r, total: r.inWork + r.completed }))
        .sort((a, b) => b.total - a.total)

      const sumAmount = (rows) => rows.reduce((acc, r) => acc + (Number(r.contract_amount) || 0), 0)

      setStats({
        // Тендеры — общие
        tTotal: t.length,
        tOpen: t.filter(isOpen).length,
        tClosed: t.filter(isClosed).length,
        tOverdue: t.filter(x => isOpen(x) && x.end_date && x.end_date < today).length,
        tUnassigned: t.filter(x => !x.responsible_contact_id).length,
        // По отделам тендеры
        tOpenConst: tConst.filter(isOpen).length,
        tClosedConst: tConst.filter(isClosed).length,
        tTotalConst: tConst.length,
        tOpenWar: tWar.filter(isOpen).length,
        tClosedWar: tWar.filter(isClosed).length,
        tTotalWar: tWar.length,
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
        // Распределение
        byResponsible,
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

  return (
    <div className="reports-page">
      <div className="reports-header">
        <div>
          <h2>Отчёты</h2>
          <div className="reports-subtitle">Состояние тендерной работы и договорной активности</div>
        </div>
        <div className="reports-tabs">
          <button
            className={`reports-tab ${activeTab === 'tenders' ? 'active' : ''}`}
            onClick={() => setActiveTab('tenders')}
          >
            Тендеры
          </button>
          <button
            className={`reports-tab ${activeTab === 'contracts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contracts')}
          >
            Договоры
          </button>
        </div>
      </div>

      <div className="reports-content">
        {activeTab === 'tenders' && (
          <>
            {/* KPI: 5 карточек, плотная сетка */}
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

            <section className="report-section">
              <header className="section-head">
                <h3>По отделам</h3>
              </header>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>Отдел</th>
                    <th className="num">В работе</th>
                    <th className="num">Завершено</th>
                    <th className="num">Всего</th>
                    <th className="bar-col">Завершение</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Основное строительство</td>
                    <td className="num">{s.tOpenConst}</td>
                    <td className="num">{s.tClosedConst}</td>
                    <td className="num strong">{s.tTotalConst}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.tClosedConst} total={s.tTotalConst} />
                    </td>
                  </tr>
                  <tr>
                    <td>Гарантийный отдел</td>
                    <td className="num">{s.tOpenWar}</td>
                    <td className="num">{s.tClosedWar}</td>
                    <td className="num strong">{s.tTotalWar}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.tClosedWar} total={s.tTotalWar} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{s.byResponsible.length}</span>
              </header>
              {s.byResponsible.length === 0 ? (
                <div className="section-empty">Тендеров пока нет</div>
              ) : (
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
                    {s.byResponsible.map(r => {
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
