import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './SummaryPage.css'

const STAGE_LABELS = {
  vor: 'Подготовка ВОР',
  tender: 'Тендерная процедура',
  pre_work: 'Ожидание начала работ',
  work: 'Идут работы',
  post_work: 'Работы завершены',
  unknown: 'Не определено',
}

const STAGE_ORDER_KEYS = ['vor', 'tender', 'work']

function getCurrentStage(t, today) {
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
  if (t.start_date && t.end_date) {
    if (today < t.start_date) {
      return { key: 'pre_work', responsible: t.winner?.name || 'Подрядчик не выбран', responsibleNote: null, start: t.start_date, end: t.end_date, overdue: false }
    } else if (today > t.end_date) {
      return { key: 'post_work', responsible: t.winner?.name || '—', responsibleNote: null, start: t.start_date, end: t.end_date, overdue: false }
    }
    return { key: 'work', responsible: t.winner?.name || '—', responsibleNote: null, start: t.start_date, end: t.end_date, overdue: false }
  }
  return { key: 'unknown', responsible: '—', responsibleNote: null, start: null, end: null, overdue: false }
}

const STAGE_RANK = { vor: 1, tender: 2, pre_work: 3, work: 4, post_work: 5, unknown: 6 }

const daysBetween = (fromIso, toIso) => {
  if (!fromIso || !toIso) return null
  const from = new Date(fromIso)
  const to = new Date(toIso)
  return Math.round((to - from) / (1000 * 60 * 60 * 24))
}

function SummaryPage() {
  const navigate = useNavigate()
  const { scopedObjectIds } = useRole()
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [stageFilter, setStageFilter] = useState('all')

  useEffect(() => {
    fetchTenders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedObjectIds])

  const fetchTenders = async () => {
    try {
      setLoading(true)
      let query = supabase
        .from('tenders')
        .select(`
          id, object_id, status, start_date, end_date,
          vor_status, vor_start_date, vor_end_date,
          tender_start_date, tender_end_date,
          work_description,
          objects(name, status),
          responsible_contact:contacts!responsible_contact_id(id, full_name),
          vor_responsible:contacts!vor_responsible_id(id, full_name),
          winner:counterparties!winner_counterparty_id(id, name)
        `)
        .order('start_date', { ascending: false })
      if (scopedObjectIds.length > 0) query = query.in('object_id', scopedObjectIds)
      const { data, error } = await query
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

  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—'

  if (loading) {
    return (
      <div className="summary-page">
        <div className="summary-header"><h2>Сводка по тендерам</h2></div>
        <div className="summary-loading">Загрузка...</div>
      </div>
    )
  }

  const today = new Date().toISOString().split('T')[0]

  const enriched = tenders.map(t => {
    const stage = getCurrentStage(t, today)
    let daysLeft = null
    if (stage.end) daysLeft = daysBetween(today, stage.end)
    return { ...t, stage, daysLeft }
  })

  const filtered = enriched.filter(t => {
    if (stageFilter === 'all') return true
    if (stageFilter === 'overdue') return t.stage.overdue
    if (stageFilter === 'vor') return t.stage.key === 'vor'
    if (stageFilter === 'tender') return t.stage.key === 'tender'
    if (stageFilter === 'work') return ['pre_work', 'work', 'post_work'].includes(t.stage.key)
    return true
  })

  filtered.sort((a, b) => {
    if (a.stage.overdue !== b.stage.overdue) return a.stage.overdue ? -1 : 1
    if (STAGE_RANK[a.stage.key] !== STAGE_RANK[b.stage.key]) {
      return STAGE_RANK[a.stage.key] - STAGE_RANK[b.stage.key]
    }
    const aEnd = a.stage.end || ''
    const bEnd = b.stage.end || ''
    return aEnd.localeCompare(bEnd)
  })

  const counts = {
    all: enriched.length,
    vor: enriched.filter(t => t.stage.key === 'vor').length,
    tender: enriched.filter(t => t.stage.key === 'tender').length,
    work: enriched.filter(t => ['pre_work', 'work', 'post_work'].includes(t.stage.key)).length,
    overdue: enriched.filter(t => t.stage.overdue).length,
  }

  // Группировка по этапам для секционного отображения
  const stageGroups = [
    { key: 'vor', label: 'Подготовка ВОР', icon: '📐', accent: '#9333ea' },
    { key: 'tender', label: 'Тендерная процедура', icon: '📢', accent: '#2563eb' },
    { key: 'pre_work', label: 'Ожидание начала работ', icon: '🕐', accent: '#0891b2' },
    { key: 'work', label: 'Идут работы', icon: '🛠', accent: '#16a34a' },
    { key: 'post_work', label: 'Работы завершены', icon: '🏁', accent: '#64748b' },
    { key: 'unknown', label: 'Не определено', icon: '❓', accent: '#94a3b8' },
  ]
  const filteredByStageGroup = stageGroups
    .map(g => ({ ...g, items: filtered.filter(t => t.stage.key === g.key) }))
    .filter(g => g.items.length > 0)

  // Список «требуют внимания»: просрочены или без ответственного на текущем этапе
  const attentionItems = enriched.filter(t =>
    t.stage.overdue || (t.stage.responsibleNote === 'не назначен' && t.stage.key !== 'unknown')
  )

  return (
    <div className="summary-page">
      <div className="summary-header summary-header-board">
        <div>
          <h2><span className="page-icon" aria-hidden>🧭</span> Сводка по тендерам</h2>
          <div className="summary-subtitle">
            Этап, ответственный и сроки по каждому тендеру основного строительства
          </div>
        </div>
        <div className="summary-updated" title="Данные актуальны на момент загрузки страницы">
          Обновлено: {new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* KPI: 5 карточек с иконками */}
      <div className="summary-kpis">
        <div className="kpi">
          <div className="kpi-icon" aria-hidden>📊</div>
          <div className="kpi-body">
            <div className="kpi-label">Всего тендеров</div>
            <div className="kpi-value">{counts.all}</div>
          </div>
        </div>
        <div className="kpi accent-vor">
          <div className="kpi-icon" aria-hidden>📐</div>
          <div className="kpi-body">
            <div className="kpi-label">Подготовка ВОР</div>
            <div className="kpi-value">{counts.vor}</div>
          </div>
        </div>
        <div className="kpi accent-tender">
          <div className="kpi-icon" aria-hidden>📢</div>
          <div className="kpi-body">
            <div className="kpi-label">Тендерная процедура</div>
            <div className="kpi-value">{counts.tender}</div>
          </div>
        </div>
        <div className="kpi accent-work">
          <div className="kpi-icon" aria-hidden>🛠</div>
          <div className="kpi-body">
            <div className="kpi-label">Работы</div>
            <div className="kpi-value">{counts.work}</div>
          </div>
        </div>
        <div className={`kpi ${counts.overdue > 0 ? 'accent-danger' : ''}`}>
          <div className="kpi-icon" aria-hidden>{counts.overdue > 0 ? '⚠️' : '✓'}</div>
          <div className="kpi-body">
            <div className="kpi-label">Просрочено</div>
            <div className="kpi-value">{counts.overdue}</div>
          </div>
        </div>
      </div>

      {/* Требуют внимания — топ-проблемы для руководителя */}
      {attentionItems.length > 0 && (
        <div className="attention-panel">
          <div className="attention-panel-header">
            <span className="attention-icon" aria-hidden>⚠️</span>
            <span className="attention-title">Требуют внимания</span>
            <span className="attention-count">{attentionItems.length}</span>
          </div>
          <div className="attention-list">
            {attentionItems.slice(0, 6).map(t => (
              <button
                key={t.id}
                className={`attention-chip ${t.stage.overdue ? 'overdue' : 'no-responsible'}`}
                onClick={() => navigate(`/tenders/${t.id}`)}
                title={t.work_description}
              >
                <span className="chip-stage">{STAGE_LABELS[t.stage.key]}</span>
                <span className="chip-object">{t.objects?.name || '—'}</span>
                <span className="chip-reason">
                  {t.stage.overdue ? `просрочен на ${Math.abs(t.daysLeft || 0)} дн.` : 'нет ответственного'}
                </span>
              </button>
            ))}
            {attentionItems.length > 6 && (
              <span className="attention-more">+{attentionItems.length - 6}</span>
            )}
          </div>
        </div>
      )}

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
              <th style={{ width: '210px' }}>Этапы</th>
              <th style={{ width: '180px' }}>На ком</th>
              <th style={{ width: '170px' }}>Срок этапа</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="summary-empty">
                  {tenders.length === 0
                    ? 'Тендеров основного строительства пока нет'
                    : 'По выбранному фильтру тендеров нет'}
                </td>
              </tr>
            ) : (
              filteredByStageGroup.map(group => (
                <React.Fragment key={group.key}>
                  <tr className="stage-group-row" style={{ '--stage-accent': group.accent }}>
                    <td colSpan={5}>
                      <div className="stage-group-header">
                        <span className="stage-group-icon" aria-hidden>{group.icon}</span>
                        <span className="stage-group-label">{group.label}</span>
                        <span className="stage-group-count">{group.items.length}</span>
                      </div>
                    </td>
                  </tr>
                  {group.items.map(t => (
                    <tr
                      key={t.id}
                      className={t.stage.overdue ? 'overdue' : ''}
                      onClick={() => navigate(`/tenders/${t.id}`)}
                    >
                      <td className="object-cell">{t.objects?.name || '—'}</td>
                      <td className="muted">{t.work_description}</td>
                      <td>
                        <Timeline currentStage={t.stage.key} />
                      </td>
                      <td>
                        <div className="responsible-name">{t.stage.responsible}</div>
                        <div className="muted-tiny">
                          {STAGE_LABELS[t.stage.key]}
                          {t.stage.responsibleNote && <span> · {t.stage.responsibleNote}</span>}
                        </div>
                      </td>
                      <td>
                        <DeadlineCell start={t.stage.start} end={t.stage.end} daysLeft={t.daysLeft} overdue={t.stage.overdue} fmt={fmtDate} />
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}


function Timeline({ currentStage }) {
  // 3 этапа, текущий подсвечен; прошедшие — заполнены, будущие — приглушены
  const currentIdx = STAGE_ORDER_KEYS.indexOf(currentStage === 'pre_work' || currentStage === 'work' || currentStage === 'post_work' ? 'work' : currentStage)
  const stages = [
    { key: 'vor', label: 'ВОР' },
    { key: 'tender', label: 'Тендер' },
    { key: 'work', label: 'Работы' },
  ]
  return (
    <div className="timeline">
      {stages.map((s, i) => {
        let state = 'future'
        if (currentIdx === -1) state = 'future'
        else if (i < currentIdx) state = 'done'
        else if (i === currentIdx) state = 'current'
        return (
          <div key={s.key} className={`timeline-step ${state} step-${s.key}`}>
            <span className="dot" />
            <span className="label">{s.label}</span>
            {i < stages.length - 1 && <span className={`connector ${state}`} />}
          </div>
        )
      })}
    </div>
  )
}

function DeadlineCell({ start, end, daysLeft, overdue, fmt }) {
  if (!start && !end) {
    return <span className="muted">не указан</span>
  }
  const range = `${fmt(start)} — ${fmt(end)}`
  let suffix = null
  if (daysLeft !== null) {
    if (overdue) {
      const overdueDays = Math.abs(daysLeft)
      suffix = <span className="days-pill danger">просрочен на {overdueDays} {pluralDays(overdueDays)}</span>
    } else if (daysLeft === 0) {
      suffix = <span className="days-pill warn">сегодня</span>
    } else if (daysLeft <= 3) {
      suffix = <span className="days-pill warn">{daysLeft} {pluralDays(daysLeft)}</span>
    } else {
      suffix = <span className="days-pill">{daysLeft} {pluralDays(daysLeft)}</span>
    }
  }
  return (
    <div className="deadline-cell">
      <div className="deadline-range">{range}</div>
      {suffix}
    </div>
  )
}

function pluralDays(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня'
  return 'дней'
}

export default SummaryPage
