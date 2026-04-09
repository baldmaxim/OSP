import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import './ReportsPage.css'

function ReportsPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      setLoading(true)

      const { data: tenders } = await supabase
        .from('tenders')
        .select('id, status, objects(status)')

      const { data: contracts } = await supabase
        .from('contracts')
        .select('id, status, objects(status)')

      const t = tenders || []
      const c = contracts || []

      const tConstruction = t.filter(x => x.objects?.status === 'main_construction')
      const tWarranty = t.filter(x => x.objects?.status === 'warranty_service')

      const cConstruction = c.filter(x => x.objects?.status === 'main_construction')
      const cWarranty = c.filter(x => x.objects?.status === 'warranty_service')

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
      </div>

      <div className="reports-content">
        {/* Сводка */}
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
            <div className="summary-number">{s.totalContracts}</div>
            <div className="summary-label">Всего договоров</div>
          </div>
          <div className="summary-card">
            <div className="summary-number">{s.cSignedConst + s.cSignedWar}</div>
            <div className="summary-label">Заключено договоров</div>
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
      </div>
    </div>
  )
}

export default ReportsPage
