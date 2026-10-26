import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import { DS_TYPE_LABEL, STATUS_LABEL } from '../../utils/dcRequestOptions'
import { KP_GRANULARITY, formatDuration, periodStarts } from '../../utils/kpStats'
import {
  DC_DUE_SOON_DAYS, buildDcDynamics, completionTimes, computeDcStats, filterDcRequests,
} from '../../utils/dcRequestStats'
import { BarChart, ProgressBar, StatusDonut } from './ReportCharts'

// Отчёт «Заявки на ДС»: сколько заявок на каком этапе, суммы «Было подано» / «Утверждено», сроки
// утверждения, итог проверки по договору, задачи, разрезы по объектам, ответственным, типам ДС,
// материалам и контрагентам. Расчёт — utils/dcRequestStats.js. Данные грузит сам, при первом открытии
// вкладки: заявки и журнал смен статуса нужны только здесь.

const SELECT = `id, object_id, counterparty_id, responsible_contact_id, ds_number, status, check_status, checked_at,
  ds_type, material_type, amount_before, amount_after, expected_approval_date, created_at, deleted_at,
  objects(id, name, status),
  counterparties(id, name),
  responsible:contacts!responsible_contact_id(id, full_name),
  dc_request_tasks(id, is_completed)`

const STATUS_SEGMENTS = [
  { key: 'contract_check', color: '#2563eb' },
  { key: 'check_result', color: '#7c3aed' },
  { key: 'in_work', color: '#d97706' },
  { key: 'completed', color: '#16a34a' },
]
const VERDICT_SEGMENTS = [
  { key: 'matches', label: 'Соответствует', color: '#16a34a' },
  { key: 'matches_with_remarks', label: 'С замечаниями', color: '#d97706' },
  { key: 'not_matches', label: 'Не соответствует', color: '#dc2626' },
  { key: 'not_checked', label: 'Ещё не проверено', color: '#94a3b8' },
]
const DEPTS = [
  { value: 'main_construction', label: 'Основное строительство' },
  { value: 'warranty_service', label: 'Гарантийный отдел' },
]

const MATRIX_ROWS = [
  { key: 'created', label: 'Создано заявок', group: 'Поток заявок' },
  { key: 'checked', label: 'Проверено по договору', hint: 'По дате итога проверки (окно «Результат проверки»)' },
  { key: 'checkedOk', label: 'соответствует', sub: true },
  { key: 'checkedRemarks', label: 'соответствует с замечаниями', sub: true },
  { key: 'checkedBad', label: 'не соответствует', sub: true },
  { key: 'completed', label: 'Завершено', hint: 'По дате перевода в «Завершено» в истории заявки' },
  { key: 'submitted', label: 'Было подано, ₽', money: true, group: 'Суммы, руб. с НДС', hint: 'Сумма «Было подано» заявок, созданных за период' },
  { key: 'approved', label: 'Утверждено, ₽', money: true, hint: 'Сумма «Утверждено» заявок, завершённых за период' },
]

const pad = (n) => String(n).padStart(2, '0')
const ddmm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
const num = (v) => (v ? v : '—')
const fmtMoney = (n) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n || 0))} ₽`
const money = (v) => (v ? fmtMoney(v) : '—')
const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`
const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'
}

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

// Разрез: объект, ответственный, тип ДС… — этапы, просрочка, суммы, доля завершённых.
function GroupTable({ rows, nameTitle, empty, limit = null, unassignedId }) {
  const [showAll, setShowAll] = useState(false)
  if (rows.length === 0) return <div className="section-empty">{empty}</div>
  const visible = limit && !showAll ? rows.slice(0, limit) : rows
  return (
    <>
      <div className="kps-table-wrap">
        <table className="dense-table dcs-groups">
          <thead>
            <tr>
              <th>{nameTitle}</th>
              <th className="num">Проверка по договору</th>
              <th className="num">Итог проверки</th>
              <th className="num">В работе</th>
              <th className="num">Завершено</th>
              <th className="num">Всего</th>
              <th className="num" title="Срок утверждения прошёл, заявка не завершена">Просрочено</th>
              <th className="money-col">Было подано</th>
              <th className="money-col">Утверждено</th>
              <th className="bar-col">Завершено, доля</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(g => (
              <tr key={g.id} className={g.id === unassignedId ? 'row-muted' : ''}>
                <td>{g.name}</td>
                <td className="num">{num(g.contract_check)}</td>
                <td className="num">{num(g.check_result)}</td>
                <td className="num">{num(g.in_work)}</td>
                <td className="num">{num(g.completed)}</td>
                <td className="num strong">{g.total}</td>
                <td className={`num${g.overdue ? ' strong accent-warn' : ''}`}>{num(g.overdue)}</td>
                <td className="money-col">{money(g.submitted)}</td>
                <td className="money-col">{money(g.approved)}</td>
                <td className="bar-col"><ProgressBar value={g.completed} total={g.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && rows.length > limit && (
        <button type="button" className="activity-refresh dcs-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Свернуть' : `Показать все (${rows.length})`}
        </button>
      )}
    </>
  )
}

function DcRequestStats({ scopedObjectIds = [], canOpenRegistry = false }) {
  const [rows, setRows] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  const [dept, setDept] = useState('all')
  const [objectId, setObjectId] = useState('all')
  const [respId, setRespId] = useState('all')
  const [dsType, setDsType] = useState('all')
  const [granularity, setGranularity] = useState('month')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Постранично: без .range() PostgREST отдаёт первые 1000 строк — числа отчёта врали бы.
      const [requests, statusEvents] = await Promise.all([
        fetchAllRows((from, to) => {
          let q = db.from('dc_requests').select(SELECT)
          if (scopedObjectIds.length > 0) q = q.in('object_id', scopedObjectIds)
          return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
        }),
        // Только смены статуса: по ним — дата завершения заявки. Журнал читает тот, кто видит заявки.
        fetchAllRows((from, to) => db
          .from('dc_request_audit_log')
          .select('dc_request_id, new_value, changed_at')
          .eq('event_type', 'status_changed')
          .order('changed_at', { ascending: true }).order('id', { ascending: true })
          .range(from, to))
          .catch((err) => {
            console.error('Журнал заявок на ДС для отчёта:', err.message)
            return []
          }),
      ])
      setRows(requests)
      setEvents(statusEvents)
      setLoadedAt(new Date())
    } catch (err) {
      console.error('Статистика заявок на ДС:', err.message)
      setError(err.message || 'Не удалось загрузить заявки')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  // Списки фильтров — из самих заявок (только то, что встречается).
  const options = useMemo(() => {
    const objects = new Map()
    const people = new Map()
    const types = new Set()
    let unassigned = false
    let noType = false
    for (const r of rows) {
      if (r.deleted_at) continue
      if (r.object_id) objects.set(r.object_id, r.objects?.name || 'Объект')
      if (r.responsible_contact_id) people.set(r.responsible_contact_id, r.responsible?.full_name || 'Сотрудник')
      else unassigned = true
      if (r.ds_type) types.add(r.ds_type)
      else noType = true
    }
    const sort = (m) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    return {
      objects: sort(objects),
      people: [...sort(people), ...(unassigned ? [{ id: '_unassigned', name: 'Не назначен' }] : [])],
      types: [...[...types].map(t => ({ id: t, name: DS_TYPE_LABEL[t] || t })), ...(noType ? [{ id: '_none', name: 'Не указан' }] : [])],
      depts: DEPTS.filter(d => rows.some(r => r.objects?.status === d.value)),
    }
  }, [rows])

  const filtered = useMemo(
    () => filterDcRequests(rows, { dept, objectId, respId, dsType }),
    [rows, dept, objectId, respId, dsType])
  const completed = useMemo(() => completionTimes(events), [events])
  // «Сейчас» фиксируется вместе с загрузкой: числа не меняются сами, пока страница открыта.
  const now = useMemo(() => loadedAt || new Date(), [loadedAt])
  const s = useMemo(() => computeDcStats(filtered, completed, now), [filtered, completed, now])
  const dynamics = useMemo(() => buildDcDynamics(filtered, completed, granularity, now), [filtered, completed, granularity, now])
  const starts = periodStarts(now)

  const fActive = dept !== 'all' || objectId !== 'all' || respId !== 'all' || dsType !== 'all'
  const reset = () => { setDept('all'); setObjectId('all'); setRespId('all'); setDsType('all') }
  const chip = (label, value, setter, list, allLabel = 'Все') => (
    <label className={`rf-chip ${value !== 'all' ? 'is-active' : ''}`}>
      <span className="rf-chip-key">{label}:</span>
      <select className="rf-chip-select" value={value} onChange={(e) => setter(e.target.value)}>
        <option value="all">{allLabel}</option>
        {list.map(o => <option key={o.id ?? o.value} value={o.id ?? o.value}>{o.name ?? o.label}</option>)}
      </select>
    </label>
  )

  const a = s.amounts
  const d = s.deadlines
  const statusSegments = STATUS_SEGMENTS.map(seg => ({ label: STATUS_LABEL[seg.key], color: seg.color, value: s.byStatus[seg.key] || 0 }))
  const verdictSegments = VERDICT_SEGMENTS.map(seg => ({ label: seg.label, color: seg.color, value: s.verdicts[seg.key] || 0 }))

  return (
    <>
      <div className="reports-filters kps-toolbar">
        {options.depts.length > 1 && chip('Отдел', dept, setDept, options.depts)}
        {chip('Объект', objectId, setObjectId, options.objects)}
        {chip('Ответственный', respId, setRespId, options.people)}
        {chip('Тип ДС', dsType, setDsType, options.types, 'Любой')}
        {fActive && <button type="button" className="rf-reset" onClick={reset}>Сбросить</button>}
        <div className="kps-toolbar-end">
          {loadedAt && (
            <span className="reports-updated">
              Данные на {loadedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button type="button" className="activity-refresh" onClick={load} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
          {canOpenRegistry && <Link to="/dc-requests" className="activity-refresh kps-link">Заявки на ДС</Link>}
        </div>
      </div>

      {error ? (
        <div className="section-empty">Не удалось загрузить заявки на ДС: {error}</div>
      ) : loading && rows.length === 0 ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="kpi-grid dcs-kpi">
            <div className="kpi-card">
              <div className="kpi-label">Всего заявок</div>
              <div className="kpi-value">{s.total}</div>
              <div className="kpi-foot">
                не завершено: {s.active} · завершено: {s.byStatus.completed}
                {s.deleted > 0 ? ` · в «Удалённых»: ${s.deleted}` : ''}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Было подано</div>
              <div className="kpi-value dcs-money">{fmtMoney(a.submitted)}</div>
              <div className="kpi-foot">утверждено: {fmtMoney(a.approved)}</div>
            </div>
            <div className={`kpi-card ${a.diff < 0 ? 'kpi-card--success' : ''}`}>
              <div className="kpi-label">Утверждено к поданному</div>
              <div className={`kpi-value dcs-money ${a.diff < 0 ? 'accent-success' : ''}`}>
                {a.diffPct == null ? '—' : fmtPct(a.diffPct)}
              </div>
              <div className="kpi-foot">
                {a.withBoth
                  ? `${a.diff > 0 ? '+' : a.diff < 0 ? '−' : ''}${fmtMoney(Math.abs(a.diff))} по ${a.withBoth} заявк. с обеими суммами`
                  : 'нет заявок с обеими суммами'}
              </div>
            </div>
            <div className={`kpi-card ${d.overdue > 0 ? 'kpi-card--warn' : ''}`}>
              <div className="kpi-label">Просрочен срок утверждения</div>
              <div className={`kpi-value ${d.overdue > 0 ? 'accent-warn' : ''}`}>{d.overdue}</div>
              <div className="kpi-foot">в ближайшие {DC_DUE_SOON_DAYS} дн.: {d.dueSoon} · без срока: {d.noDeadline}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Проверка по договору</div>
              <div className="kpi-value">{formatDuration(s.durations.checkMedianMs)}</div>
              <div className="kpi-foot">
                медиана от создания до итога; до завершения — {formatDuration(s.durations.completeMedianMs)}
              </div>
            </div>
          </div>

          <div className="dash-grid">
            <section className="dash-card">
              <header className="dash-card-head">
                <h3>Этапы сейчас</h3>
                <span className="dash-card-meta">как в реестре</span>
              </header>
              <StatusDonut total={s.total} segments={statusSegments} label="Этапы заявок на ДС" caption="заявок" />
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
                label="Создание и завершение заявок на ДС"
                series={[
                  { key: 'created', label: 'Создано', color: '#2563eb' },
                  { key: 'completed', label: 'Завершено', color: '#16a34a' },
                ]}
              />
            </section>

            <section className="dash-card dash-card--attention">
              <header className="dash-card-head"><h3>Требуют внимания</h3></header>
              <div className="attn-list">
                <QueueItem tone="danger" label="Просрочен срок утверждения" value={d.overdue}
                  hint="срок прошёл, заявка не завершена" />
                <QueueItem tone="warn" label={`Срок в ближайшие ${DC_DUE_SOON_DAYS} дней`} value={d.dueSoon}
                  hint="включая сегодня" />
                <QueueItem tone="warn" label="Без срока утверждения" value={d.noDeadline}
                  hint="срок в заявке не указан" />
                <QueueItem tone="warn" label="Есть невыполненные задачи" value={s.tasks.requestsWithOpen}
                  hint={`задач всего: ${s.tasks.total}, выполнено: ${s.tasks.done} (${pct(s.tasks.done, s.tasks.total)}%)`} />
              </div>
            </section>
          </div>

          <div className="kps-two">
            <section className="report-section">
              <header className="section-head">
                <h3>Заявки за период</h3>
                <span className="section-meta">сегодня, неделя, месяц, всё время</span>
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
                          <tr key={`g-${row.group}`} className="kps-group-row"><td colSpan={5}>{row.group}</td></tr>
                        )
                      }
                      out.push(
                        <tr key={row.key} className={row.sub ? 'kps-sub-row' : ''}>
                          <td title={row.hint}>{row.label}</td>
                          {['today', 'week', 'month', 'all'].map(p => (
                            <td key={p} className={`num${row.sub ? '' : ' strong'}${row.money ? ' dcs-money-cell' : ''}`}>
                              {row.money ? money(s.matrix[row.key][p]) : num(s.matrix[row.key][p])}
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

            <section className="report-section">
              <header className="section-head">
                <h3>Итог проверки по договору</h3>
                <span className="section-meta">все заявки</span>
              </header>
              <StatusDonut total={s.total} segments={verdictSegments} label="Итог проверки заявок на ДС" caption="заявок" />
            </section>
          </div>

          <section className="report-section">
            <header className="section-head">
              <h3>Просроченные заявки</h3>
              <span className="section-meta">{d.overdue}</span>
            </header>
            {d.overdueList.length === 0 ? (
              <div className="section-empty">Просроченных заявок нет</div>
            ) : (
              <div className="kps-table-wrap">
                <table className="dense-table dcs-overdue">
                  <thead>
                    <tr>
                      <th>Объект</th>
                      <th>Контрагент</th>
                      <th>№ ДС</th>
                      <th>Ответственный</th>
                      <th>Этап</th>
                      <th className="num">Срок</th>
                      <th className="num">Просрочка, дн.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.overdueList.map(r => (
                      <tr key={r.id}>
                        <td>{r.object}</td>
                        <td>{r.counterparty}</td>
                        <td className="dcs-nowrap">{r.dsNumber || '—'}</td>
                        <td>{r.responsible}</td>
                        <td>{STATUS_LABEL[r.status]}</td>
                        <td className="num">{fmtDate(r.due)}</td>
                        <td className="num strong accent-warn">{r.days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По объектам</h3>
              <span className="section-meta">{s.byObject.length}</span>
            </header>
            <GroupTable rows={s.byObject} nameTitle="Объект" empty="Заявок нет" unassignedId="_none" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По ответственным</h3>
              <span className="section-meta">{s.byResponsible.length}</span>
            </header>
            <GroupTable rows={s.byResponsible} nameTitle="Ответственный" empty="Заявок нет" unassignedId="_unassigned" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По типу ДС</h3>
            </header>
            <GroupTable rows={s.byDsType} nameTitle="Тип ДС" empty="Заявок нет" unassignedId="_none" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По типу материала</h3>
            </header>
            <GroupTable rows={s.byMaterial} nameTitle="Материал" empty="Заявок нет" unassignedId="_none" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По контрагентам</h3>
              <span className="section-meta">{s.byCounterparty.length}</span>
            </header>
            <GroupTable rows={s.byCounterparty} nameTitle="Контрагент" empty="Заявок нет" limit={15} unassignedId="_none" />
          </section>
        </>
      )}
    </>
  )
}

export default DcRequestStats
