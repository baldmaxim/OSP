import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import './CostPlansPage.css'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed']

function VorsPage() {
  const navigate = useNavigate()
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('in_work')
  const [responsibleFilter, setResponsibleFilter] = useState('')

  useEffect(() => {
    fetchTenders()
  }, [])

  const fetchTenders = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select(`
          id, status, vor_status, vor_link,
          start_date, end_date, work_description,
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position)
        `)
        .not('vor_responsible_id', 'is', null)
        .order('start_date', { ascending: false })

      if (error) throw error
      const filtered = (data || []).filter(t => t.objects?.status === 'main_construction')
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки ВОРов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleChangeStatus = async (tenderId, newStatus) => {
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ vor_status: newStatus })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, vor_status: newStatus } : t))
    } catch (err) {
      console.error('Ошибка изменения статуса ВОР:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const formatDate = (s) => s ? new Date(s).toLocaleDateString('ru-RU') : ''

  const formatDateRange = (start, end) => {
    if (!start && !end) return '—'
    if (!start) return formatDate(end)
    if (!end) return formatDate(start)
    return `${formatDate(start)} — ${formatDate(end)}`
  }

  if (loading) {
    return (
      <div className="cost-plans-page">
        <div className="page-header"><h2>ВОРы и РД</h2></div>
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  const responsibleMap = new Map()
  for (const t of tenders) {
    const r = t.vor_responsible
    if (r?.id && !responsibleMap.has(r.id)) responsibleMap.set(r.id, r)
  }
  const responsibles = Array.from(responsibleMap.values())
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'))

  const filtered = responsibleFilter
    ? tenders.filter(t => t.vor_responsible?.id === responsibleFilter)
    : tenders

  const inWork = filtered.filter(t => t.vor_status !== 'completed')
  const completed = filtered.filter(t => t.vor_status === 'completed')
  const visible = activeTab === 'completed' ? completed : inWork

  return (
    <div className="cost-plans-page">
      <div className="page-header">
        <h2>ВОРы и РД</h2>
        <div className="page-header-hint">
          Список тендеров основного строительства, по которым назначен ответственный за ВОРы и РД
        </div>
      </div>

      <div className="cost-plans-tabs">
        <button
          className={`tab ${activeTab === 'in_work' ? 'active' : ''}`}
          onClick={() => setActiveTab('in_work')}
        >
          В работе
          <span className="tab-count">{inWork.length}</span>
        </button>
        <button
          className={`tab ${activeTab === 'completed' ? 'active' : ''}`}
          onClick={() => setActiveTab('completed')}
        >
          Завершено
          <span className="tab-count completed">{completed.length}</span>
        </button>
      </div>

      <div className="cost-plans-toolbar">
        <label className="toolbar-label">
          Ответственный:
          <select
            value={responsibleFilter}
            onChange={(e) => setResponsibleFilter(e.target.value)}
          >
            <option value="">Все ({tenders.length})</option>
            {responsibles.map(r => {
              const cnt = tenders.filter(t => t.vor_responsible?.id === r.id).length
              return (
                <option key={r.id} value={r.id}>
                  {r.full_name} ({cnt})
                </option>
              )
            })}
          </select>
        </label>
        {responsibleFilter && (
          <button className="reset-btn" onClick={() => setResponsibleFilter('')}>Сбросить</button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Объект</th>
              <th>Описание работ</th>
              <th>Ответственный</th>
              <th>Сроки тендера</th>
              <th>ВОРы и РД</th>
              <th style={{ width: '180px' }}>Статус</th>
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="no-data">
                  {activeTab === 'completed'
                    ? 'Завершённых ВОРов нет'
                    : tenders.length === 0
                      ? 'Нет тендеров с назначенным ответственным за ВОР. Назначьте ответственного в форме тендера.'
                      : 'Все ВОРы для выбранного фильтра завершены — переключитесь на вкладку «Завершено».'}
                </td>
              </tr>
            ) : (
              visible.map((t) => (
                <tr key={t.id}>
                  <td>
                    <button
                      className="row-link primary"
                      onClick={() => navigate(`/tenders/${t.id}`)}
                      title="Открыть тендер"
                    >
                      {t.objects?.name || '—'}
                    </button>
                  </td>
                  <td className="muted-text">{t.work_description}</td>
                  <td>
                    <div>{t.vor_responsible?.full_name}</div>
                    {t.vor_responsible?.position && (
                      <div className="muted-tiny">{t.vor_responsible.position}</div>
                    )}
                  </td>
                  <td className="nowrap">{formatDateRange(t.start_date, t.end_date)}</td>
                  <td>
                    {t.vor_link ? (
                      <a
                        href={t.vor_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link"
                      >
                        Открыть
                      </a>
                    ) : (
                      <span className="muted-text">—</span>
                    )}
                  </td>
                  <td>
                    <select
                      className={`plan-status-select status-${t.vor_status}`}
                      value={t.vor_status || 'not_started'}
                      onChange={(e) => handleChangeStatus(t.id, e.target.value)}
                    >
                      {STATUS_OPTIONS.map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="actions-cell">
                    <button
                      className="btn-secondary btn-small"
                      onClick={() => navigate(`/tenders/${t.id}`)}
                      title="Открыть тендер"
                    >
                      Тендер
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default VorsPage
