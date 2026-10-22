import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../../api'
import { fetchAllRowsParallel } from '../../utils/fetchPagesParallel'
import { TENDER_DEPARTMENTS } from '../../utils/tenderDepartments'
import {
  KP_GRANULARITY, KP_STALE_DAYS, buildKpDynamics, computeKpStats, formatDuration, periodStarts,
} from '../../utils/kpStats'
import { BarChart, StatusDonut } from './ReportCharts'

// Отчёт «Коммерческие предложения»: сколько КП загружают (день, неделя, месяц),
// сколько проверяет аналитик и что ждёт следующего шага. Расчёт — utils/kpStats.js.
// Данные грузит сам, отдельно от остальных отчётов: КП тысячи, а нужны они только
// на этой вкладке.

const SELECT = `id, tender_id, counterparty_id, proposal_group_id, created_at,
  review_required, review_status, reviewed_at, reviewed_by,
  remarks_send_required, remarks_sent, remarks_sent_at,
  summary_added, summary_added_at,
  s3:s3_documents!s3_document_id(uploaded_by_name),
  tenders!inner(object_id, department)`

const pad = (n) => String(n).padStart(2, '0')
const ddmm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`

// Строки сводной таблицы. sub — подстрока предыдущей, group — начало блока.
const MATRIX_ROWS = [
  { key: 'uploaded', label: 'Загружено КП', group: 'Загрузка', hint: 'Файлы КП, загруженные на сайт, включая новые версии' },
  { key: 'versions', label: 'в т.ч. новые версии КП', sub: true, hint: 'Повторная загрузка КП того же подрядчика: со скидкой, исправленное и т.п.' },
  { key: 'tenders', label: 'Тендеров, по которым пришли КП' },
  { key: 'counterparties', label: 'Подрядчиков, приславших КП' },
  { key: 'reviewed', label: 'Проверено аналитиком', group: 'Проверка', hint: 'КП, по которым аналитик вынес решение (по дате решения)' },
  { key: 'approved', label: 'без замечаний', sub: true },
  { key: 'remarks', label: 'с замечаниями', sub: true },
  { key: 'reviewTime', label: 'Время от загрузки до проверки', duration: true, hint: 'Медиана: у половины КП быстрее, у половины дольше' },
  { key: 'summary', label: 'Внесено в сводную таблицу', group: 'После проверки' },
  { key: 'sent', label: 'Замечания отправлены подрядчику' },
]

// Этапы «Проверки КП», сведённые в четыре группы для кольца.
const STAGE_SEGMENTS = [
  { label: 'На проверке', keys: ['pending'], color: '#2563eb', title: 'Ждут решения аналитика' },
  { label: 'К занесению в сводную', keys: ['ok_summary', 'nosend_summary'], color: '#d97706', title: 'Решение есть, в сводную таблицу ещё не внесено' },
  { label: 'Сводная + отправка', keys: ['remarks_work'], color: '#dc2626', title: 'С замечаниями: занести в сводную и отправить подрядчику' },
  { label: 'Готово', keys: ['ok_done', 'remarks_sent', 'nosend_done'], color: '#16a34a', title: 'Работа по КП закончена' },
]

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
const num = (v) => (v ? v : '—')

function QueueItem({ tone, label, hint, value }) {
  return (
    <div className={`attn-item attn-item--${value > 0 ? tone : 'muted'}`}>
      <div className="attn-body">
        <div className="attn-label">{label}</div>
        <div className="attn-hint">{hint}</div>
      </div>
      <div className="attn-val">{value}</div>
    </div>
  )
}

function PeopleTable({ rows, nameTitle, withReview = false, empty }) {
  if (rows.length === 0) return <div className="section-empty">{empty}</div>
  return (
    <div className="kps-table-wrap">
      <table className="dense-table kps-people">
        <thead>
          <tr>
            <th className="num kps-col-idx">#</th>
            <th>{nameTitle}</th>
            <th className="num">Сегодня</th>
            <th className="num">Неделя</th>
            <th className="num">Месяц</th>
            <th className="num">Всего</th>
            {withReview && <th className="num" title="Доля КП с замечаниями среди всех проверенных">С замечаниями</th>}
            {withReview && <th className="num" title="Медиана времени от загрузки КП до решения аналитика">Время проверки</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name} className={r.name === 'Не указан' ? 'row-muted' : ''}>
              <td className="num muted">{i + 1}</td>
              <td>{r.name}</td>
              <td className="num">{num(r.today)}</td>
              <td className="num">{num(r.week)}</td>
              <td className="num strong">{num(r.month)}</td>
              <td className="num">{r.all}</td>
              {withReview && <td className="num">{r.all ? `${pct(r.remarks, r.all)}%` : '—'}</td>}
              {withReview && <td className="num">{formatDuration(r.medianMs)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KpStats({ scopedObjectIds = [], canOpenReview = false }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  const [dept, setDept] = useState('all')
  const [granularity, setGranularity] = useState('week')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAllRowsParallel((from, to, withCount) => {
        let q = db
          .from('tender_proposal_files')
          .select(SELECT, withCount ? { count: 'exact' } : undefined)
          .eq('file_kind', 'commercial_proposal')
        if (scopedObjectIds.length > 0) q = q.in('tenders.object_id', scopedObjectIds)
        return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      setRows(data)
      setLoadedAt(new Date())
    } catch (err) {
      console.error('Статистика КП:', err.message)
      setError(err.message || 'Не удалось загрузить КП')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  // Направления, по которым КП вообще есть, — в порядке раздела «Тендеры».
  const deptOptions = useMemo(() => {
    const present = new Set(rows.map(r => r.tenders?.department).filter(Boolean))
    return TENDER_DEPARTMENTS.filter(d => present.has(d.key))
  }, [rows])

  const filtered = useMemo(
    () => (dept === 'all' ? rows : rows.filter(r => r.tenders?.department === dept)),
    [rows, dept]
  )
  // «Сейчас» фиксируется вместе с загрузкой: числа не меняются сами, пока страница открыта.
  const now = useMemo(() => loadedAt || new Date(), [loadedAt])
  const stats = useMemo(() => computeKpStats(filtered, now), [filtered, now])
  const dynamics = useMemo(() => buildKpDynamics(filtered, granularity, now), [filtered, granularity, now])
  const starts = periodStarts(now)

  const m = stats.matrix
  const q = stats.queue
  const stageSegments = STAGE_SEGMENTS.map(s => ({
    label: s.label,
    title: s.title,
    color: s.color,
    value: s.keys.reduce((sum, k) => sum + (stats.stages[k] || 0), 0),
  }))

  return (
    <>
      <div className="reports-filters kps-toolbar">
        <label className={`rf-chip ${dept !== 'all' ? 'is-active' : ''}`}>
          <span className="rf-chip-key">Направление:</span>
          <select className="rf-chip-select" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="all">Все</option>
            {deptOptions.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
        <div className="kps-toolbar-end">
          {loadedAt && (
            <span className="reports-updated">
              Данные на {loadedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button type="button" className="activity-refresh" onClick={load} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
          {canOpenReview && <Link to="/kp-review" className="activity-refresh kps-link">Проверка КП</Link>}
        </div>
      </div>

      {error ? (
        <div className="section-empty">Не удалось загрузить КП: {error}</div>
      ) : loading && rows.length === 0 ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Загружено сегодня</div>
              <div className="kpi-value">{m.uploaded.today}</div>
              <div className="kpi-foot">неделя: {m.uploaded.week} · месяц: {m.uploaded.month}</div>
            </div>
            <div className="kpi-card kpi-card--success">
              <div className="kpi-label">Проверено сегодня</div>
              <div className="kpi-value accent-success">{m.reviewed.today}</div>
              <div className="kpi-foot">неделя: {m.reviewed.week} · месяц: {m.reviewed.month}</div>
            </div>
            <div className={`kpi-card ${q.stale > 0 ? 'kpi-card--warn' : ''}`}>
              <div className="kpi-label">На проверке сейчас</div>
              <div className={`kpi-value ${q.stale > 0 ? 'accent-warn' : ''}`}>{q.pending}</div>
              <div className="kpi-foot">
                {q.pending > 0 ? `дольше ${KP_STALE_DAYS} суток: ${q.stale}` : 'очередь пуста'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Время проверки</div>
              <div className="kpi-value">{formatDuration(m.reviewTime.month)}</div>
              <div className="kpi-foot">медиана за месяц, от загрузки до решения</div>
            </div>
            <div className={`kpi-card ${m.remarks.month > 0 ? 'kpi-card--warn' : ''}`}>
              <div className="kpi-label">С замечаниями</div>
              <div className="kpi-value">{pct(m.remarks.month, m.reviewed.month)}%</div>
              <div className="kpi-foot">{m.remarks.month} из {m.reviewed.month} проверенных за месяц</div>
            </div>
          </div>

          <div className="dash-grid">
            <section className="dash-card">
              <header className="dash-card-head">
                <h3>Этапы проверки сейчас</h3>
                <span className="dash-card-meta">как в «Проверке КП»</span>
              </header>
              <StatusDonut total={q.required} segments={stageSegments} label="Этапы проверки КП" caption="КП" />
            </section>

            <section className="dash-card kps-dyn">
              <header className="dash-card-head">
                <h3>Динамика</h3>
                <div className="activity-presets kps-gran" role="group" aria-label="Шаг графика">
                  {Object.entries(KP_GRANULARITY).map(([key, g]) => (
                    <button key={key} type="button" className={granularity === key ? 'is-active' : ''}
                      aria-pressed={granularity === key} onClick={() => setGranularity(key)}>
                      {g.label}
                    </button>
                  ))}
                </div>
              </header>
              <BarChart
                data={dynamics}
                label="Загрузка и проверка КП"
                series={[
                  { key: 'uploaded', label: 'Загружено', color: '#2563eb' },
                  { key: 'reviewed', label: 'Проверено', color: '#16a34a' },
                ]}
              />
            </section>

            <section className="dash-card dash-card--attention">
              <header className="dash-card-head"><h3>Ждут следующего шага</h3></header>
              <div className="attn-list">
                <QueueItem tone="warn" label={`На проверке дольше ${KP_STALE_DAYS} суток`} value={q.stale}
                  hint={q.oldestPendingMs != null ? `самое давнее ждёт ${formatDuration(q.oldestPendingMs)}` : 'нет КП на проверке'} />
                <QueueItem tone="warn" label="Не внесены в сводную" value={q.toSummary}
                  hint="проверены, в том числе с замечаниями" />
                <QueueItem tone="danger" label="Замечания не отправлены" value={q.toSend}
                  hint="замечания ещё не ушли подрядчику" />
              </div>
            </section>
          </div>

          <section className="report-section">
            <header className="section-head">
              <h3>Загрузка и проверка КП</h3>
              <span className="section-meta">проверка — с запуска «Проверки КП»</span>
            </header>
            <div className="kps-table-wrap">
              <table className="dense-table kps-matrix">
                <thead>
                  <tr>
                    <th>Показатель</th>
                    <th className="num">Сегодня<span className="kps-th-sub">{ddmm(starts.today)}</span></th>
                    <th className="num">Неделя<span className="kps-th-sub">с {ddmm(starts.week)}</span></th>
                    <th className="num">Месяц<span className="kps-th-sub">с {ddmm(starts.month)}</span></th>
                    <th className="num">Всего<span className="kps-th-sub">за всё время</span></th>
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_ROWS.flatMap(row => {
                    const out = []
                    if (row.group) {
                      out.push(
                        <tr key={`g-${row.group}`} className="kps-group-row">
                          <td colSpan={5}>{row.group}</td>
                        </tr>
                      )
                    }
                    out.push(
                      <tr key={row.key} className={row.sub ? 'kps-sub-row' : ''}>
                        <td title={row.hint}>{row.label}</td>
                        {['today', 'week', 'month', 'all'].map(p => (
                          <td key={p} className={`num${row.sub ? '' : ' strong'}`}>
                            {row.duration ? formatDuration(m[row.key][p]) : num(m[row.key][p])}
                          </td>
                        ))}
                      </tr>
                    )
                    return out
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="kps-two">
            <section className="report-section">
              <header className="section-head">
                <h3>Кто загружает</h3>
                <span className="section-meta">{stats.uploaders.length}</span>
              </header>
              <PeopleTable rows={stats.uploaders} nameTitle="Сотрудник" empty="КП ещё не загружали" />
            </section>
            <section className="report-section">
              <header className="section-head">
                <h3>Кто проверяет</h3>
                <span className="section-meta">{stats.reviewers.length}</span>
              </header>
              <PeopleTable rows={stats.reviewers} nameTitle="Аналитик" withReview empty="Проверенных КП пока нет" />
            </section>
          </div>
        </>
      )}
    </>
  )
}

export default KpStats
