import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import './ReportsPage.css'

function ReportsPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [activeTab, setActiveTab] = useState('tenders') // 'tenders' | 'contracts'

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      setLoading(true)

      const { data: tenders } = await supabase
        .from('tenders')
        .select('id, status, responsible_contact_id, objects(status), responsible_contact:contacts!responsible_contact_id(id, full_name)')

      const { data: contracts } = await supabase
        .from('contracts')
        .select('id, status, objects(status)')

      const t = tenders || []
      const c = contracts || []

      const tConstruction = t.filter(x => x.objects?.status === 'main_construction')
      const tWarranty = t.filter(x => x.objects?.status === 'warranty_service')

      const cConstruction = c.filter(x => x.objects?.status === 'main_construction')
      const cWarranty = c.filter(x => x.objects?.status === 'warranty_service')

      // Распределение тендеров по ответственным
      const byResponsibleMap = new Map()
      for (const x of t) {
        const id = x.responsible_contact_id || '_unassigned'
        const name = x.responsible_contact?.full_name || 'Не назначен'
        if (!byResponsibleMap.has(id)) {
          byResponsibleMap.set(id, { id, name, inWork: 0, completed: 0 })
        }
        const row = byResponsibleMap.get(id)
        if (x.status === 'Завершен') row.completed += 1
        else row.inWork += 1
      }
      const byResponsible = Array.from(byResponsibleMap.values())
        .map(r => ({ ...r, total: r.inWork + r.completed }))
        .sort((a, b) => b.total - a.total)

      setStats({
        tOpenConst: tConstruction.filter(x => x.status !== 'Завершен').length,
        tClosedConst: tConstruction.filter(x => x.status === 'Завершен').length,
        tOpenWar: tWarranty.filter(x => x.status !== 'Завершен').length,
        tClosedWar: tWarranty.filter(x => x.status === 'Завершен').length,
        cPendingConst: cConstruction.filter(x => x.status === 'pending').length,
        cSignedConst: cConstruction.filter(x => x.status === 'signed').length,
        cPendingWar: cWarranty.filter(x => x.status === 'pending').length,
        cSignedWar: cWarranty.filter(x => x.status === 'signed').length,
        totalTenders: t.length,
        totalContracts: c.length,
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

  const tTotalConst = s.tOpenConst + s.tClosedConst
  const tTotalWar = s.tOpenWar + s.tClosedWar
  const cTotalConst = s.cPendingConst + s.cSignedConst
  const cTotalWar = s.cPendingWar + s.cSignedWar

  const Bar = ({ value, max, color }) => {
    const pct = max > 0 ? (value / max) * 100 : 0
    return (
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    )
  }

  return (
    <div className="reports-page">
      <div className="reports-header">
        <h2>Отчёты</h2>
        <div className="reports-tabs">
          <button
            className={`reports-tab ${activeTab === 'tenders' ? 'active' : ''}`}
            onClick={() => setActiveTab('tenders')}
          >
            Тендеры
            <span className="reports-tab-count">{s.totalTenders}</span>
          </button>
          <button
            className={`reports-tab ${activeTab === 'contracts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contracts')}
          >
            Договоры
            <span className="reports-tab-count">{s.totalContracts}</span>
          </button>
        </div>
      </div>

      <div className="reports-content">
        {activeTab === 'tenders' && (
          <>
            <div className="summary-cards">
              <div className="summary-card">
                <div className="summary-number">{s.totalTenders}</div>
                <div className="summary-label">Всего тендеров</div>
              </div>
              <div className="summary-card">
                <div className="summary-number">{s.tOpenConst + s.tOpenWar}</div>
                <div className="summary-label">Открытых тендеров</div>
              </div>
              <div className="summary-card">
                <div className="summary-number">{s.tClosedConst + s.tClosedWar}</div>
                <div className="summary-label">Завершённых тендеров</div>
              </div>
            </div>

        {/* Тендеры */}
        <div className="report-block">
          <div className="block-header">
            <h3>Тендеры</h3>
            <span className="block-total">{s.totalTenders}</span>
          </div>

          <div className="report-grid">
            {/* Основное строительство */}
            <div className="report-card">
              <div className="card-dept-label construction">Основное строительство</div>
              <div className="card-metric-row">
                <div className="metric">
                  <span className="metric-value">{s.tOpenConst}</span>
                  <span className="metric-label">Открытые</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{s.tClosedConst}</span>
                  <span className="metric-label">Завершённые</span>
                </div>
                <div className="metric total">
                  <span className="metric-value">{tTotalConst}</span>
                  <span className="metric-label">Всего</span>
                </div>
              </div>
              <div className="card-bar-section">
                <div className="bar-label">
                  <span>Завершено</span>
                  <span>{tTotalConst > 0 ? Math.round((s.tClosedConst / tTotalConst) * 100) : 0}%</span>
                </div>
                <Bar value={s.tClosedConst} max={tTotalConst} color="#2563eb" />
              </div>
            </div>

            {/* Гарантийный отдел */}
            <div className="report-card">
              <div className="card-dept-label warranty">Гарантийный отдел</div>
              <div className="card-metric-row">
                <div className="metric">
                  <span className="metric-value">{s.tOpenWar}</span>
                  <span className="metric-label">Открытые</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{s.tClosedWar}</span>
                  <span className="metric-label">Завершённые</span>
                </div>
                <div className="metric total">
                  <span className="metric-value">{tTotalWar}</span>
                  <span className="metric-label">Всего</span>
                </div>
              </div>
              <div className="card-bar-section">
                <div className="bar-label">
                  <span>Завершено</span>
                  <span>{tTotalWar > 0 ? Math.round((s.tClosedWar / tTotalWar) * 100) : 0}%</span>
                </div>
                <Bar value={s.tClosedWar} max={tTotalWar} color="#ea580c" />
              </div>
            </div>
          </div>
        </div>

        {/* Распределение тендеров по ответственным */}
        <div className="report-block">
          <div className="block-header">
            <h3>Тендеры по ответственным</h3>
            <span className="block-total">{s.byResponsible.length}</span>
          </div>

          {s.byResponsible.length === 0 ? (
            <div className="responsible-empty">Тендеров пока нет</div>
          ) : (
            <div className="responsible-table-wrap">
              <table className="responsible-table">
                <thead>
                  <tr>
                    <th>Ответственный</th>
                    <th className="num">В работе</th>
                    <th className="num">Завершено</th>
                    <th className="num">Всего</th>
                    <th className="bar-col">Доля завершённых</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byResponsible.map(r => {
                    const pct = r.total > 0 ? Math.round((r.completed / r.total) * 100) : 0
                    const isUnassigned = r.id === '_unassigned'
                    return (
                      <tr key={r.id}>
                        <td className={isUnassigned ? 'name muted' : 'name'}>{r.name}</td>
                        <td className="num">{r.inWork}</td>
                        <td className="num">{r.completed}</td>
                        <td className="num total">{r.total}</td>
                        <td className="bar-col">
                          <div className="bar-with-label">
                            <Bar value={r.completed} max={r.total} color="#2563eb" />
                            <span className="bar-pct">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

          </>
        )}

        {activeTab === 'contracts' && (
          <>
            <div className="summary-cards">
              <div className="summary-card">
                <div className="summary-number">{s.totalContracts}</div>
                <div className="summary-label">Всего договоров</div>
              </div>
              <div className="summary-card">
                <div className="summary-number">{s.cPendingConst + s.cPendingWar}</div>
                <div className="summary-label">На стадии заключения</div>
              </div>
              <div className="summary-card">
                <div className="summary-number">{s.cSignedConst + s.cSignedWar}</div>
                <div className="summary-label">Заключено договоров</div>
              </div>
            </div>

        {/* Договоры */}
        <div className="report-block">
          <div className="block-header">
            <h3>Договоры</h3>
            <span className="block-total">{s.totalContracts}</span>
          </div>

          <div className="report-grid">
            {/* Основное строительство */}
            <div className="report-card">
              <div className="card-dept-label construction">Основное строительство</div>
              <div className="card-metric-row">
                <div className="metric">
                  <span className="metric-value">{s.cPendingConst}</span>
                  <span className="metric-label">На стадии заключения</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{s.cSignedConst}</span>
                  <span className="metric-label">Заключены</span>
                </div>
                <div className="metric total">
                  <span className="metric-value">{cTotalConst}</span>
                  <span className="metric-label">Всего</span>
                </div>
              </div>
              <div className="card-bar-section">
                <div className="bar-label">
                  <span>Заключено</span>
                  <span>{cTotalConst > 0 ? Math.round((s.cSignedConst / cTotalConst) * 100) : 0}%</span>
                </div>
                <Bar value={s.cSignedConst} max={cTotalConst} color="#2563eb" />
              </div>
            </div>

            {/* Гарантийный отдел */}
            <div className="report-card">
              <div className="card-dept-label warranty">Гарантийный отдел</div>
              <div className="card-metric-row">
                <div className="metric">
                  <span className="metric-value">{s.cPendingWar}</span>
                  <span className="metric-label">На стадии заключения</span>
                </div>
                <div className="metric">
                  <span className="metric-value">{s.cSignedWar}</span>
                  <span className="metric-label">Заключены</span>
                </div>
                <div className="metric total">
                  <span className="metric-value">{cTotalWar}</span>
                  <span className="metric-label">Всего</span>
                </div>
              </div>
              <div className="card-bar-section">
                <div className="bar-label">
                  <span>Заключено</span>
                  <span>{cTotalWar > 0 ? Math.round((s.cSignedWar / cTotalWar) * 100) : 0}%</span>
                </div>
                <Bar value={s.cSignedWar} max={cTotalWar} color="#ea580c" />
              </div>
            </div>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  )
}

export default ReportsPage
