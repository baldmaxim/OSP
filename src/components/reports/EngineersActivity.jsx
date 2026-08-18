import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../../supabase'
import { fetchAllRows } from '../../utils/fetchAllRows'

// Отчёт «Работа инженеров в тендерах».
//
// Источник — tender_audit_log: инженер обзвонил подрядчика и записал результат в
// примечание участника → в журнале появилась запись field_name='participant_notes'.
// Поэтому отчёт считает именно записи журнала за выбранный день, а не состояние
// тендеров: состояние показывает результат, а нам нужна ежедневная работа.
//
// Автор берётся из денормализованного changed_by_name (в журнале хранится снимок
// ФИО на момент действия) — join'ить не с чем и не нужно.

// Категории действий. Порядок = порядок колонок в сводной таблице.
const CATEGORIES = [
  {
    key: 'calls',
    label: 'Примечания (звонки)',
    short: 'Звонки',
    hint: 'Записи в примечаниях участников — результат обзвона подрядчиков',
    match: (r) => r.field_name === 'participant_notes',
  },
  {
    key: 'cp_status',
    label: 'Статусы участников',
    short: 'Статусы',
    hint: 'Отметки «КП предоставлено», «Отказ», «Запрос отправлен»',
    match: (r) => r.event_type === 'participant_status',
  },
  {
    key: 'invited',
    label: 'Приглашено участников',
    short: 'Приглашения',
    hint: 'Добавление подрядчиков в тендер',
    match: (r) => r.event_type === 'participant_added',
  },
  {
    key: 'tenders',
    label: 'Тендеры (создание, статусы)',
    short: 'Тендеры',
    hint: 'Создание тендеров, смена статуса, назначение победителя',
    match: (r) => ['created', 'status_changed', 'winner_assigned'].includes(r.event_type),
  },
  {
    key: 'other',
    label: 'Прочие правки',
    short: 'Прочее',
    hint: 'Сроки, ссылки, ответственные, примечания тендера и другие поля',
    match: () => true,   // всё, что не попало в категории выше
  },
]

const categoryOf = (row) => (CATEGORIES.find(c => c.match(row)) || CATEGORIES[CATEGORIES.length - 1]).key

const pad = (n) => String(n).padStart(2, '0')
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const shiftDays = (d, days) => {
  const x = new Date(d)
  x.setDate(x.getDate() + days)
  return x
}
const formatTime = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
const formatDateTime = (iso) => {
  const d = new Date(iso)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${formatTime(iso)}`
}
const formatDateRu = (ymd) => {
  const [y, m, d] = String(ymd).split('-')
  return `${d}.${m}.${y}`
}

// Текст примечания из JSONB {tc_id, cp_name, text}; для полей-строк — само значение.
const valueText = (v) => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return v.text != null ? String(v.text) : ''
  return String(v)
}
const counterpartyOf = (row) => {
  const v = row.new_value
  if (v && typeof v === 'object') return v.cp_name || v.name || ''
  return ''
}

function EngineersActivity({ scopedObjectIds = [] }) {
  const today = useMemo(() => new Date(), [])
  const [dateFrom, setDateFrom] = useState(() => toDateInput(new Date()))
  const [dateTo, setDateTo] = useState(() => toDateInput(new Date()))
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)      // ФИО инженера с раскрытой детализацией
  const [detailFilter, setDetailFilter] = useState('') // категория в детализации

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Границы периода — по местному времени: сотрудник мыслит своим днём,
      // а changed_at хранится в UTC.
      const fromIso = new Date(`${dateFrom}T00:00:00`).toISOString()
      const toIso = shiftDays(new Date(`${dateTo}T00:00:00`), 1).toISOString()

      const data = await fetchAllRows((from, to) => supabase
        .from('tender_audit_log')
        .select(`
          id, tender_id, event_type, field_name, old_value, new_value, description,
          changed_at, changed_by_name, changed_by_role,
          tenders(public_tender_number, work_description, object_id, objects(name))
        `)
        .gte('changed_at', fromIso)
        .lt('changed_at', toIso)
        .order('changed_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))

      // Скоуп по объектам: руководитель видит работу только по своим объектам.
      const scoped = scopedObjectIds.length > 0
        ? data.filter(r => r.tenders?.object_id && scopedObjectIds.includes(r.tenders.object_id))
        : data
      setRows(scoped)
    } catch (err) {
      console.error('Ошибка загрузки журнала тендеров:', err.message)
      setError(err.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, scopedObjectIds])

  useEffect(() => { load() }, [load])

  // Сводка по инженерам.
  const summary = useMemo(() => {
    const byName = new Map()
    for (const r of rows) {
      const name = r.changed_by_name?.trim() || 'Без имени'
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          role: r.changed_by_role || '',
          total: 0,
          counts: Object.fromEntries(CATEGORIES.map(c => [c.key, 0])),
          tenders: new Set(),
          counterparties: new Set(),
          lastAt: r.changed_at,
          rows: [],
        })
      }
      const e = byName.get(name)
      e.total += 1
      e.counts[categoryOf(r)] += 1
      if (r.tender_id) e.tenders.add(r.tender_id)
      const cp = counterpartyOf(r)
      if (cp) e.counterparties.add(cp)
      if (r.changed_at > e.lastAt) e.lastAt = r.changed_at
      e.rows.push(r)
    }
    // Сортировка: сначала те, кто больше звонил, затем по общему числу действий.
    return [...byName.values()].sort((a, b) =>
      (b.counts.calls - a.counts.calls) || (b.total - a.total) || a.name.localeCompare(b.name, 'ru'))
  }, [rows])

  const totals = useMemo(() => {
    const t = { total: rows.length, tenders: new Set(), counts: Object.fromEntries(CATEGORIES.map(c => [c.key, 0])) }
    for (const r of rows) {
      t.counts[categoryOf(r)] += 1
      if (r.tender_id) t.tenders.add(r.tender_id)
    }
    return t
  }, [rows])

  const setPreset = (preset) => {
    const base = new Date()
    if (preset === 'today') { setDateFrom(toDateInput(base)); setDateTo(toDateInput(base)) }
    if (preset === 'yesterday') {
      const y = shiftDays(base, -1)
      setDateFrom(toDateInput(y)); setDateTo(toDateInput(y))
    }
    if (preset === 'week') { setDateFrom(toDateInput(shiftDays(base, -6))); setDateTo(toDateInput(base)) }
    if (preset === 'month') { setDateFrom(toDateInput(shiftDays(base, -29))); setDateTo(toDateInput(base)) }
  }
  const isToday = dateFrom === toDateInput(today) && dateTo === toDateInput(today)

  const handleExport = () => {
    const head = ['Инженер', ...CATEGORIES.map(c => c.label), 'Всего действий', 'Тендеров затронуто', 'Последняя активность']
    const body = summary.map(e => [
      e.name,
      ...CATEGORIES.map(c => e.counts[c.key]),
      e.total,
      e.tenders.size,
      formatDateTime(e.lastAt),
    ])
    const details = [
      ['Дата и время', 'Инженер', 'Тендер №', 'Объект', 'Действие', 'Контрагент', 'Текст примечания'],
      ...rows.map(r => [
        formatDateTime(r.changed_at),
        r.changed_by_name || 'Без имени',
        r.tenders?.public_tender_number ?? '',
        r.tenders?.objects?.name || '',
        r.description || r.event_type,
        counterpartyOf(r),
        valueText(r.new_value),
      ]),
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...body]), 'Сводка')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(details), 'Детализация')
    const period = dateFrom === dateTo ? formatDateRu(dateFrom) : `${formatDateRu(dateFrom)}-${formatDateRu(dateTo)}`
    XLSX.writeFile(wb, `Работа инженеров ${period}.xlsx`)
  }

  const expandedEngineer = summary.find(e => e.name === expanded) || null
  const detailRows = expandedEngineer
    ? expandedEngineer.rows.filter(r => !detailFilter || categoryOf(r) === detailFilter)
    : []

  return (
    <>
      <div className="activity-toolbar">
        <div className="activity-presets">
          <button type="button" className={isToday ? 'is-active' : ''} onClick={() => setPreset('today')}>Сегодня</button>
          <button type="button" onClick={() => setPreset('yesterday')}>Вчера</button>
          <button type="button" onClick={() => setPreset('week')}>7 дней</button>
          <button type="button" onClick={() => setPreset('month')}>30 дней</button>
        </div>
        <label className="activity-date">
          с <input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="activity-date">
          по <input type="date" value={dateTo} min={dateFrom} max={toDateInput(today)} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <button type="button" className="activity-refresh" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
        <button type="button" className="activity-refresh" onClick={handleExport} disabled={loading || rows.length === 0}>
          Excel
        </button>
      </div>

      {error ? (
        <div className="section-empty">
          Не удалось загрузить журнал: {error}
        </div>
      ) : loading ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card kpi-card--success">
              <div className="kpi-label">Примечаний по подрядчикам</div>
              <div className="kpi-value accent-success">{totals.counts.calls}</div>
              <div className="kpi-foot">результаты обзвона за период</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Всего действий в тендерах</div>
              <div className="kpi-value">{totals.total}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Инженеров работало</div>
              <div className="kpi-value">{summary.length}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Тендеров затронуто</div>
              <div className="kpi-value">{totals.tenders.size}</div>
            </div>
          </div>

          <section className="report-section">
            <header className="section-head">
              <h3>Работа инженеров {dateFrom === dateTo ? `за ${formatDateRu(dateFrom)}` : `с ${formatDateRu(dateFrom)} по ${formatDateRu(dateTo)}`}</h3>
              <span className="section-meta">{summary.length}</span>
            </header>

            {summary.length === 0 ? (
              <div className="section-empty">
                За выбранный период записей нет — в тендерах в эти дни никто ничего не менял.
              </div>
            ) : (
              <table className="dense-table activity-table">
                <thead>
                  <tr>
                    <th>Инженер</th>
                    {CATEGORIES.map(c => (
                      <th key={c.key} className="num" title={c.hint}>{c.short}</th>
                    ))}
                    <th className="num">Всего</th>
                    <th className="num">Тендеров</th>
                    <th className="num">Последняя активность</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map(e => (
                    <tr
                      key={e.name}
                      className={expanded === e.name ? 'is-expanded' : ''}
                      onClick={() => { setExpanded(expanded === e.name ? null : e.name); setDetailFilter('') }}
                      title="Показать, что именно сделано"
                    >
                      <td className="activity-name">
                        <span className="activity-caret" aria-hidden>{expanded === e.name ? '▾' : '▸'}</span>
                        {e.name}
                      </td>
                      {CATEGORIES.map(c => (
                        <td key={c.key} className={`num${c.key === 'calls' && e.counts[c.key] > 0 ? ' activity-calls' : ''}`}>
                          {e.counts[c.key] || '—'}
                        </td>
                      ))}
                      <td className="num"><b>{e.total}</b></td>
                      <td className="num">{e.tenders.size}</td>
                      <td className="num">{formatTime(e.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {expandedEngineer && (
            <section className="report-section">
              <header className="section-head">
                <h3>{expandedEngineer.name} — что сделано</h3>
                <span className="section-meta">{detailRows.length}</span>
              </header>

              <div className="activity-chips">
                <button type="button" className={detailFilter === '' ? 'is-active' : ''} onClick={() => setDetailFilter('')}>
                  Все ({expandedEngineer.total})
                </button>
                {CATEGORIES.filter(c => expandedEngineer.counts[c.key] > 0).map(c => (
                  <button
                    key={c.key}
                    type="button"
                    className={detailFilter === c.key ? 'is-active' : ''}
                    onClick={() => setDetailFilter(c.key)}
                  >
                    {c.label} ({expandedEngineer.counts[c.key]})
                  </button>
                ))}
              </div>

              <table className="dense-table activity-detail-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Тендер</th>
                    <th>Подрядчик</th>
                    <th>Что сделано</th>
                    <th>Запись</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(r => (
                    <tr key={r.id}>
                      <td className="activity-time">
                        {dateFrom === dateTo ? formatTime(r.changed_at) : formatDateTime(r.changed_at)}
                      </td>
                      <td>
                        <Link to={`/tenders/${r.tender_id}`} className="activity-link">
                          {r.tenders?.public_tender_number != null ? `№${r.tenders.public_tender_number}` : 'Тендер'}
                        </Link>
                        {r.tenders?.objects?.name && <div className="activity-sub">{r.tenders.objects.name}</div>}
                      </td>
                      <td>{counterpartyOf(r) || '—'}</td>
                      <td>{r.description || r.event_type}</td>
                      <td className="activity-note">{valueText(r.new_value) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  )
}

export default EngineersActivity
