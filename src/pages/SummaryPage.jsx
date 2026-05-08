import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import './SummaryPage.css'

const STAGE_LABELS = {
  vor: 'Подготовка ВОР',
  tender: 'Тендерная процедура',
  pre_work: 'Ожидание начала работ',
  work: 'Идут работы',
  post_work: 'Работы завершены',
  unknown: 'Не определено',
}

function getCurrentStage(t, today) {
  // Если ВОР ещё не завершён — этап подготовки ВОР
  if (t.vor_status !== 'completed') {
    return {
      key: 'vor',
      responsible: t.vor_responsible?.full_name || 'Сметный отдел',
      responsibleNote: t.vor_responsible ? null : 'не назначен',
      start: t.vor_start_date,
      end: t.vor_end_date,
      overdue: !!(t.vor_end_date && t.vor_end_date < today),
    }
  }
  // Если статус тендера не «Завершен» — этап тендерной процедуры (ОСП)
  if (t.status !== 'Завершен') {
    return {
      key: 'tender',
      responsible: t.responsible_contact?.full_name || 'ОСП',
      responsibleNote: t.responsible_contact ? null : 'не назначен',
      start: t.tender_start_date,
      end: t.tender_end_date,
      overdue: !!(t.tender_end_date && t.tender_end_date < today),
    }
  }
  // Тендер завершён → смотрим на даты работ
  if (t.start_date && t.end_date) {
    if (today < t.start_date) {
      return {
        key: 'pre_work',
        responsible: t.winner?.name || 'Подрядчик не выбран',
        responsibleNote: null,
        start: t.start_date,
        end: t.end_date,
        overdue: false,
      }
    } else if (today > t.end_date) {
      return {
        key: 'post_work',
        responsible: t.winner?.name || '—',
        responsibleNote: null,
        start: t.start_date,
        end: t.end_date,
        overdue: false,
      }
    } else {
      return {
        key: 'work',
        responsible: t.winner?.name || '—',
        responsibleNote: null,
        start: t.start_date,
        end: t.end_date,
        overdue: false,
      }
    }
  }
  return {
    key: 'unknown',
    responsible: '—',
    responsibleNote: null,
    start: null,
    end: null,
    overdue: false,
  }
}

const STAGE_ORDER = { vor: 1, tender: 2, pre_work: 3, work: 4, post_work: 5, unknown: 6 }

function SummaryPage() {
  const navigate = useNavigate()
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [stageFilter, setStageFilter] = useState('all') // 'all' | 'vor' | 'tender' | 'work' | 'overdue'

  useEffect(() => {
    fetchTenders()
  }, [])

  const fetchTenders = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select(`
          id, status, start_date, end_date,
          vor_status, vor_start_date, vor_end_date,
          tender_start_date, tender_end_date,
          work_description,
          objects(name, status),
          responsible_contact:contacts!responsible_contact_id(id, full_name),
          vor_responsible:contacts!vor_responsible_id(id, full_name),
          winner:counterparties!winner_counterparty_id(id, name)
        `)
        .order('start_date', { ascending: false })
      if (error) throw error
      const filtered = (data || []).filter(t => t.objects?.status === 'main_construction')
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки сводки:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('ru-RU') : '—'

  if (loading) {
    return (
      <div className="summary-page">
        <div className="summary-header"><h2>Сводка по тендерам</h2></div>
        <div className="summary-loading">Загрузка...</div>
      </div>
    )
  }

  const today = new Date().toISOString().split('T')[0]

  const enriched = tenders.map(t => ({
    ...t,
    stage: getCurrentStage(t, today),
  }))

  // Применяем фильтр
  const filtered = enriched.filter(t => {
    if (stageFilter === 'all') return true
    if (stageFilter === 'overdue') return t.stage.overdue
    if (stageFilter === 'vor') return t.stage.key === 'vor'
    if (stageFilter === 'tender') return t.stage.key === 'tender'
    if (stageFilter === 'work') return ['pre_work', 'work', 'post_work'].includes(t.stage.key)
    return true
  })

  // Сортировка: просроченные первыми, потом по порядку этапов, потом по end_date этапа
  filtered.sort((a, b) => {
    if (a.stage.overdue !== b.stage.overdue) return a.stage.overdue ? -1 : 1
    if (STAGE_ORDER[a.stage.key] !== STAGE_ORDER[b.stage.key]) {
      return STAGE_ORDER[a.stage.key] - STAGE_ORDER[b.stage.key]
    }
    const aEnd = a.stage.end || ''
    const bEnd = b.stage.end || ''
    return aEnd.localeCompare(bEnd)
  })

  // Подсчёт для бейджей фильтров
  const counts = {
    all: enriched.length,
    vor: enriched.filter(t => t.stage.key === 'vor').length,
    tender: enriched.filter(t => t.stage.key === 'tender').length,
    work: enriched.filter(t => ['pre_work', 'work', 'post_work'].includes(t.stage.key)).length,
    overdue: enriched.filter(t => t.stage.overdue).length,
  }

  return (
    <div className="summary-page">
      <div className="summary-header">
        <div>
          <h2>Сводка по тендерам</h2>
          <div className="summary-subtitle">Текущий этап, ответственный и сроки по каждому тендеру основного строительства</div>
        </div>
      </div>

      <div className="summary-filters">
        {[
          { key: 'all', label: 'Все' },
          { key: 'vor', label: 'Подготовка ВОР' },
          { key: 'tender', label: 'Тендерная процедура' },
          { key: 'work', label: 'Работы' },
          { key: 'overdue', label: 'Просрочено', danger: true },
        ].map(f => (
          <button
            key={f.key}
            className={`summary-filter ${stageFilter === f.key ? 'active' : ''} ${f.danger ? 'danger' : ''}`}
            onClick={() => setStageFilter(f.key)}
          >
            {f.label}
            <span className="filter-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <div className="summary-table-wrap">
        <table className="summary-table">
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Объект</th>
              <th>Описание работ</th>
              <th style={{ width: '180px' }}>Этап</th>
              <th style={{ width: '180px' }}>На ком</th>
              <th style={{ width: '140px' }}>Срок этапа</th>
              <th style={{ width: '110px' }}>Срок работ</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="summary-empty">
                  {tenders.length === 0
                    ? 'Тендеров основного строительства пока нет'
                    : 'По выбранному фильтру тендеров нет'}
                </td>
              </tr>
            ) : (
              filtered.map(t => (
                <tr
                  key={t.id}
                  className={t.stage.overdue ? 'overdue' : ''}
                  onClick={() => navigate(`/tenders/${t.id}`)}
                >
                  <td className="object-cell">{t.objects?.name || '—'}</td>
                  <td className="muted">{t.work_description}</td>
                  <td>
                    <span className={`stage-badge stage-${t.stage.key}`}>
                      {STAGE_LABELS[t.stage.key]}
                    </span>
                  </td>
                  <td>
                    <div>{t.stage.responsible}</div>
                    {t.stage.responsibleNote && (
                      <div className="muted-tiny">{t.stage.responsibleNote}</div>
                    )}
                  </td>
                  <td>
                    {t.stage.start || t.stage.end ? (
                      <div className={t.stage.overdue ? 'date-overdue' : ''}>
                        {fmtDate(t.stage.start)} — {fmtDate(t.stage.end)}
                        {t.stage.overdue && <span className="overdue-mark"> просрочен</span>}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {fmtDate(t.start_date)} — {fmtDate(t.end_date)}
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

export default SummaryPage
