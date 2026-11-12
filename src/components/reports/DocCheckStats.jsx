import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import { fetchEmployees, employeesById } from '../../services/employees'
import {
  DOC_CHECK_SELECTS, DOC_CHECK_STATUSES, DOC_CHECK_STATUS_LABEL, DOC_TYPE_LABEL, isMissingBoardColumn,
} from '../../utils/docCheckHelpers'
import { KP_GRANULARITY, formatDuration, periodStarts } from '../../utils/kpStats'
import {
  DOC_CHECK_DUE_SOON_DAYS, DOC_CHECK_NEW_STALE_DAYS, DOC_CHECK_SCAN, DOC_CHECK_SCAN_STALE_DAYS,
  buildDocCheckDynamics, computeDocCheckStats, docCheckFilterOptions, docCheckStatusTimes, filterDocCheckRequests,
} from '../../utils/docCheckStats'
import { BarChart, ProgressBar, StatusDonut } from './ReportCharts'
import { FilterChip, Limited, PeriodMatrix, QueueItem, fmtDate, num } from './ReportParts'

// Отчёт «Проверка ДП/ДС» (12.11.2026): заявки на проверку ДП/ДС — сколько в каждой колонке доски, сроки, исполнители, сколько
// создано и завершено, как быстро берут в работу и завершают, разрезы по объектам, исполнителям и контрагентам. Расчёт —
// utils/docCheckStats.js. Данные грузит сам, при первом открытии подвкладки: заявки (тот же набор полей, что доска, с откатом на
// прежний, если колонок ещё нет), журнал смен статуса и справочник сотрудников (исполнители — юристы ОСП).

// Цвета колонок — как полосы колонок доски (DocCheckRequestsPage.css, .dcs-*).
const STATUS_COLOR = {
  new: '#64748b', in_progress: '#f59e0b', edo: '#0ea5e9', signal: '#8b5cf6', accounting: '#ec4899', done: '#16a34a', awaiting_scan: '#b45309',
}
// Короткие подписи колонок для таблиц; полные — в подсказке.
const STATUS_SHORT = {
  new: 'Новые', in_progress: 'В работе', edo: 'ЭДО', signal: 'Signal', accounting: '1С', done: 'Завершено', awaiting_scan: 'Скан',
}
// Подписи легенды кольца: полное «Ожидаем скан ДП/ДС, подписанного в бумажном виде» в узкой карточке шло в пять строк.
const STATUS_LEGEND = { ...STATUS_SHORT, new: 'Новые заявки', awaiting_scan: 'Ожидаем скан' }
const DEPTS = [
  { id: 'main_construction', name: 'Основное строительство' },
  { id: 'warranty_service', name: 'Гарантийный отдел' },
]
const DOC_TYPES = [{ id: 'dp', name: 'ДП' }, { id: 'ds', name: 'ДС' }]
const MATRIX_ROWS = [
  { key: 'created', label: 'Создано заявок', group: 'Поток заявок' },
  { key: 'createdDp', label: 'ДП', sub: true },
  { key: 'createdDs', label: 'ДС', sub: true },
  { key: 'taken', label: 'Взято в работу', hint: 'Первый перенос из «Новых заявок» — по истории заявки' },
  { key: 'completed', label: 'Завершено', hint: 'По дате переноса в «Завершено» в истории заявки' },
]

function GroupTable({ rows, nameTitle, empty, limit = null }) {
  if (rows.length === 0) return <div className="section-empty">{empty}</div>
  const hasOther = rows.some(g => g.other > 0)
  return (
    <Limited rows={rows} limit={limit} render={(visible) => (
      <div className="kps-table-wrap">
        <table className="dense-table dck-groups">
          <thead>
            <tr>
              <th>{nameTitle}</th>
              {DOC_CHECK_STATUSES.map(st => (
                <th key={st.value} className="num" title={st.label}>{STATUS_SHORT[st.value] || st.label}</th>
              ))}
              {hasOther && <th className="num" title="Статус вне списка колонок доски">Другой</th>}
              <th className="num">Всего</th>
              <th className="num" title="Договоры подряда / дополнительные соглашения">ДП / ДС</th>
              <th className="num" title="Срок прошёл, заявка не в «Завершено»">Просрочено</th>
              <th className="bar-col">Завершено, доля</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(g => (
              <tr key={g.id} className={g.id === '_none' ? 'row-muted' : ''}>
                <td>{g.name}</td>
                {DOC_CHECK_STATUSES.map(st => <td key={st.value} className="num">{num(g[st.value])}</td>)}
                {hasOther && <td className="num">{num(g.other)}</td>}
                <td className="num strong">{g.total}</td>
                <td className="num dcs-nowrap">{g.dp} / {g.ds}</td>
                <td className={`num${g.overdue ? ' strong accent-warn' : ''}`}>{num(g.overdue)}</td>
                <td className="bar-col"><ProgressBar value={g.done} total={g.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )} />
  )
}

function DocCheckStats({ scopedObjectIds = [], canOpenBoard = false }) {
  const [rows, setRows] = useState([])
  const [events, setEvents] = useState([])
  const [employees, setEmployees] = useState(() => new Map())
  const [hasBoard, setHasBoard] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  const [dept, setDept] = useState('all')
  const [objectId, setObjectId] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [docType, setDocType] = useState('all')
  const [granularity, setGranularity] = useState('month')
  // Какая выборка подошла базе (колонки доски, карточки, номер): при «Обновить» заведомо неподходящие не повторяем.
  const selectAt = useRef(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Постранично: без .range() шлюз отдаёт первые 1000 строк — числа отчёта врали бы.
      const read = (select) => fetchAllRows((from, to) => {
        let q = db.from('doc_check_requests').select(select)
        if (scopedObjectIds.length > 0) q = q.in('object_id', scopedObjectIds)
        return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      const loadRequests = async () => {
        for (;;) {
          try {
            return await read(DOC_CHECK_SELECTS[selectAt.current].select)
          } catch (err) {
            if (!isMissingBoardColumn(err) || selectAt.current === DOC_CHECK_SELECTS.length - 1) throw err
            selectAt.current += 1
          }
        }
      }
      const [requests, statusEvents, staff] = await Promise.all([
        loadRequests(),
        // Только смены статуса: по ним — когда взяли в работу и когда завершили. Журнал читает тот, кто видит заявки.
        fetchAllRows((from, to) => db
          .from('doc_check_request_audit_log')
          .select('id, request_id, new_value, changed_at')
          .eq('event_type', 'status_changed')
          .order('changed_at', { ascending: true }).order('id', { ascending: true })
          .range(from, to))
          .catch((err) => {
            console.error('Журнал заявок на проверку ДП/ДС для отчёта:', err.message)
            return []
          }),
        // Исполнители — по справочнику, как на доске; не загрузился — все заявки «без исполнителя» не покажем: разрез пропадёт.
        fetchEmployees().catch((err) => {
          console.error('Сотрудники для отчёта по проверке ДП/ДС:', err.message)
          return null
        }),
      ])
      setRows(requests)
      setEvents(statusEvents)
      setEmployees(staff ? employeesById(staff) : null)
      setHasBoard(DOC_CHECK_SELECTS[selectAt.current].board)
      setLoadedAt(new Date())
    } catch (err) {
      console.error('Статистика заявок на проверку ДП/ДС:', err.message)
      setError(err.message || 'Не удалось загрузить заявки')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  // Справочник не загрузился — исполнителей не знаем: фильтра и разреза по ним нет, «без исполнителя» не считаем.
  const knowsAssignees = hasBoard && employees != null
  const staff = useMemo(() => employees || new Map(), [employees])
  const times = useMemo(() => docCheckStatusTimes(events), [events])
  const options = useMemo(() => ({
    ...docCheckFilterOptions(rows, staff),
    depts: DEPTS.filter(d => rows.some(r => !r.deleted_at && r.objects?.status === d.id)),
  }), [rows, staff])
  const filtered = useMemo(
    () => filterDocCheckRequests(rows, { dept, objectId, assignee: knowsAssignees ? assignee : 'all', docType }, staff),
    [rows, dept, objectId, assignee, docType, staff, knowsAssignees])
  // «Сейчас» фиксируется вместе с загрузкой: числа не меняются сами, пока страница открыта.
  const now = useMemo(() => loadedAt || new Date(), [loadedAt])
  const s = useMemo(() => computeDocCheckStats(filtered, times, staff, now), [filtered, times, staff, now])
  const dynamics = useMemo(() => buildDocCheckDynamics(filtered, times, granularity, now), [filtered, times, granularity, now])
  const starts = periodStarts(now)

  const fActive = dept !== 'all' || objectId !== 'all' || assignee !== 'all' || docType !== 'all'
  const reset = () => { setDept('all'); setObjectId('all'); setAssignee('all'); setDocType('all') }
  const statusSegments = [
    ...DOC_CHECK_STATUSES.map(st => ({
      label: STATUS_LEGEND[st.value] || st.label, title: st.label, color: STATUS_COLOR[st.value], value: s.byStatus[st.value] || 0,
    })),
    ...(s.byStatus.other ? [{ label: 'Другой статус', color: '#94a3b8', value: s.byStatus.other }] : []),
  ]
  const d = s.deadlines
  const at = s.attention
  const openLink = (id) => `/doc-check-requests?request=${encodeURIComponent(id)}`

  return (
    <>
      <div className="reports-filters kps-toolbar">
        {options.depts.length > 1 && <FilterChip label="Отдел" value={dept} onChange={setDept} options={options.depts} />}
        <FilterChip label="Объект" value={objectId} onChange={setObjectId} options={options.objects} />
        {knowsAssignees && <FilterChip label="Исполнитель" value={assignee} onChange={setAssignee} options={options.people} />}
        <FilterChip label="Документ" value={docType} onChange={setDocType} options={DOC_TYPES} allLabel="ДП и ДС" />
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
          {canOpenBoard && <Link to="/doc-check-requests" className="activity-refresh kps-link">Заявки на проверку</Link>}
        </div>
      </div>

      {error ? (
        <div className="section-empty">Не удалось загрузить заявки на проверку ДП/ДС: {error}</div>
      ) : loading && rows.length === 0 ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="kpi-grid dck-kpi">
            <div className="kpi-card">
              <div className="kpi-label">Всего заявок</div>
              <div className="kpi-value">{s.total}</div>
              <div className="kpi-foot">
                ДП: {s.byType.dp} · ДС: {s.byType.ds}
                {s.archived > 0 ? ` · в архиве: ${s.archived}` : ''}
                {s.deleted > 0 ? ` · в «Удалённых»: ${s.deleted}` : ''}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">В работе у отдела</div>
              <div className="kpi-value">{s.inWork}</div>
              <div className="kpi-foot">
                новых: {s.byStatus.new} · завершено: {s.byStatus.done} · ждём скан: {s.byStatus[DOC_CHECK_SCAN]}
              </div>
            </div>
            {hasBoard && (
              <div className={`kpi-card ${d.overdue > 0 ? 'kpi-card--warn' : ''}`}>
                <div className="kpi-label">Просрочен срок</div>
                <div className={`kpi-value ${d.overdue > 0 ? 'accent-warn' : ''}`}>{d.overdue}</div>
                <div className="kpi-foot">в ближайшие {DOC_CHECK_DUE_SOON_DAYS} дн.: {d.dueSoon} · без срока: {d.noDeadline}</div>
              </div>
            )}
            <div className="kpi-card">
              <div className="kpi-label">До взятия в работу</div>
              <div className="kpi-value">{formatDuration(s.durations.takeMedianMs)}</div>
              <div className="kpi-foot">
                {s.durations.takeCount ? `медиана от создания, по ${s.durations.takeCount} заявк.` : 'в истории заявок переносов нет'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">От создания до «Завершено»</div>
              <div className="kpi-value">{formatDuration(s.durations.doneMedianMs)}</div>
              <div className="kpi-foot">
                {s.durations.doneCount ? `медиана по ${s.durations.doneCount} заявк. с переносом в истории` : 'в истории заявок завершений нет'}
              </div>
            </div>
          </div>

          <div className="dash-grid">
            <section className="dash-card">
              <header className="dash-card-head">
                <h3>Колонки доски сейчас</h3>
                <span className="dash-card-meta">как на доске</span>
              </header>
              <StatusDonut total={s.total} segments={statusSegments} label="Заявки на проверку ДП/ДС по колонкам" caption="заявок" />
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
                label="Создание и завершение заявок на проверку ДП/ДС"
                series={[
                  { key: 'created', label: 'Создано', color: '#2563eb' },
                  { key: 'completed', label: 'Завершено', color: '#16a34a' },
                ]}
              />
            </section>

            <section className="dash-card dash-card--attention">
              <header className="dash-card-head"><h3>Требуют внимания</h3></header>
              <div className="attn-list">
                {hasBoard && (
                  <QueueItem tone="danger" label="Просрочен срок" value={d.overdue} hint="срок прошёл, заявка не в «Завершено»" />
                )}
                {hasBoard && (
                  <QueueItem tone="warn" label={`Срок в ближайшие ${DOC_CHECK_DUE_SOON_DAYS} дней`} value={d.dueSoon} hint="включая сегодня" />
                )}
                {knowsAssignees && (
                  <QueueItem tone="warn" label="Без исполнителя" value={at.unassigned} hint="не в «Завершено», юрист ОСП не назначен" />
                )}
                <QueueItem tone="warn" label={`В «Новых» дольше ${DOC_CHECK_NEW_STALE_DAYS} дней`} value={at.staleNew}
                  hint={at.oldestNewDays != null ? `самая давняя — ${at.oldestNewDays} дн.` : 'новых заявок нет'} />
                <QueueItem tone="warn" label={`Скан не вернулся за ${DOC_CHECK_SCAN_STALE_DAYS} дней`} value={at.staleScan}
                  hint="«Ожидаем скан», бумажный оригинал" />
                {hasBoard && (
                  <QueueItem tone="warn" label="Высокий приоритет" value={at.highPriority} hint="не в «Завершено»" />
                )}
              </div>
            </section>
          </div>

          <section className="report-section">
            <header className="section-head">
              <h3>Заявки за период</h3>
              <span className="section-meta">сегодня, неделя, месяц, всё время</span>
            </header>
            <PeriodMatrix rows={MATRIX_ROWS} matrix={s.matrix} starts={starts} />
          </section>

          {hasBoard && (
            <section className="report-section">
              <header className="section-head">
                <h3>Просроченные заявки</h3>
                <span className="section-meta">{d.overdue}</span>
              </header>
              {d.overdueList.length === 0 ? (
                <div className="section-empty">Просроченных заявок нет</div>
              ) : (
                <Limited rows={d.overdueList} limit={15} render={(visible) => (
                  <div className="kps-table-wrap">
                    <table className="dense-table dck-overdue">
                      <thead>
                        <tr>
                          <th className="num">ID</th>
                          <th>Объект</th>
                          <th>Контрагент</th>
                          <th>Документ</th>
                          <th>Исполнители</th>
                          <th>Колонка</th>
                          <th className="num">Срок</th>
                          <th className="num">Просрочка, дн.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(r => (
                          <tr key={r.id}>
                            <td className="num">
                              {canOpenBoard
                                ? <Link to={openLink(r.id)} className="dps-open">{r.number ?? 'открыть'}</Link>
                                : (r.number ?? '—')}
                            </td>
                            <td>{r.object || '—'}</td>
                            <td>{r.counterparty || '—'}</td>
                            <td className="dcs-nowrap">
                              {DOC_TYPE_LABEL[r.docType] || r.docType}{r.docNumber ? ` № ${r.docNumber}` : ''}
                            </td>
                            <td>{r.assignees.length ? r.assignees.join(', ') : (knowsAssignees ? 'Без исполнителя' : '—')}</td>
                            <td>{DOC_CHECK_STATUS_LABEL[r.status] || r.status}</td>
                            <td className="num">{fmtDate(r.due)}</td>
                            <td className="num strong accent-warn">{r.days}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )} />
              )}
            </section>
          )}

          {knowsAssignees && (
            <section className="report-section">
              <header className="section-head">
                <h3>По исполнителям</h3>
                <span className="section-meta">юристы ОСП; заявка с несколькими исполнителями — у каждого</span>
              </header>
              <GroupTable rows={s.byAssignee} nameTitle="Исполнитель" empty="Заявок нет" />
            </section>
          )}

          <section className="report-section">
            <header className="section-head">
              <h3>По объектам</h3>
              <span className="section-meta">{s.byObject.length}</span>
            </header>
            <GroupTable rows={s.byObject} nameTitle="Объект" empty="Заявок нет" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По контрагентам</h3>
              <span className="section-meta">{s.byCounterparty.length}</span>
            </header>
            <GroupTable rows={s.byCounterparty} nameTitle="Контрагент" empty="Заявок нет" limit={15} />
          </section>
        </>
      )}
    </>
  )
}

export default DocCheckStats
