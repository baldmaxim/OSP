import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import { DP_MIGRATION_HINT, DP_REQUEST_PARAM, DP_STATUS_LABEL, isDpMigrationMissing } from '../../utils/dpRequests'
import { KP_GRANULARITY, formatDuration, periodStarts } from '../../utils/kpStats'
import {
  DP_NEW_STALE_DAYS, DP_WORK_STALE_DAYS, buildDpDynamics, computeDpStats, dpFilterOptions, filterDpRequests,
} from '../../utils/dpRequestStats'
import { BarChart, ProgressBar, StatusDonut } from './ReportCharts'
import { FilterChip, Limited, PeriodMatrix, QueueItem, fmtDateTime, fmtMoney, money, num } from './ReportParts'

// Отчёт «Заключение ДП» (12.11.2026): заявки на заключение ДП — сколько на каком этапе, суммы, сколько ждут и что не заполнено
// отделом, динамика, разрезы по объектам, ответственным и подавшим. Расчёт — utils/dpRequestStats.js. Данные грузит сам, при первом
// открытии подвкладки. Нет таблицы (база раньше миграции 20261227) — подсказка вместо отчёта.

const FIELDS = `id, request_number, object_id, contract_title, amount, responsible_name, responsible_role, status, status_changed_at,
  created_by_name, created_at, deleted_at, objects(id, name, status)`

const STATUS_SEGMENTS = [
  { key: 'new', color: '#2563eb' },
  { key: 'in_work', color: '#d97706' },
  { key: 'completed', color: '#16a34a' },
]
const DEPTS = [
  { id: 'main_construction', name: 'Основное строительство' },
  { id: 'warranty_service', name: 'Гарантийный отдел' },
]
const MATRIX_ROWS = [
  { key: 'created', label: 'Подано заявок', group: 'Поток заявок' },
  { key: 'completed', label: 'Завершено', hint: 'По времени перевода в «Завершена»' },
  { key: 'createdAmount', label: 'Сумма поданных, ₽', money: true, group: 'Суммы, руб.', hint: 'Сумма заявок, поданных за период (если её уже внесли)' },
  { key: 'completedAmount', label: 'Сумма завершённых, ₽', money: true, hint: 'Сумма заявок, завершённых за период' },
]
const MISSING_LABEL = { object: 'объект', contract: 'договор', amount: 'сумма', responsible: 'ответственный' }

function GroupTable({ rows, nameTitle, empty, limit = null, withRole = false }) {
  if (rows.length === 0) return <div className="section-empty">{empty}</div>
  return (
    <Limited rows={rows} limit={limit} render={(visible) => (
      <div className="kps-table-wrap">
        <table className="dense-table dps-groups">
          <thead>
            <tr>
              <th>{nameTitle}</th>
              <th className="num">Новые</th>
              <th className="num">В работе</th>
              <th className="num">Завершено</th>
              <th className="num">Всего</th>
              <th className="num" title={`Новые дольше ${DP_NEW_STALE_DAYS} дн., в работе дольше ${DP_WORK_STALE_DAYS} дн.`}>Ждут долго</th>
              <th className="money-col">Сумма</th>
              <th className="bar-col">Завершено, доля</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(g => (
              <tr key={g.id} className={g.id === '_none' ? 'row-muted' : ''}>
                <td>
                  {g.name}
                  {withRole && g.role && <span className="dps-role">{g.role}</span>}
                </td>
                <td className="num">{num(g.new)}</td>
                <td className="num">{num(g.in_work)}</td>
                <td className="num">{num(g.completed)}</td>
                <td className="num strong">{g.total}</td>
                <td className={`num${g.stale ? ' strong accent-warn' : ''}`}>{num(g.stale)}</td>
                <td className="money-col">{money(g.amount)}</td>
                <td className="bar-col"><ProgressBar value={g.completed} total={g.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )} />
  )
}

function DpRequestStats({ scopedObjectIds = [], canOpenRegistry = false }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [missing, setMissing] = useState(false)
  const [loadedAt, setLoadedAt] = useState(null)
  const [dept, setDept] = useState('all')
  const [objectId, setObjectId] = useState('all')
  const [respKey, setRespKey] = useState('all')
  const [granularity, setGranularity] = useState('month')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Постранично: без .range() шлюз отдаёт первые 1000 строк. Черновики — не заявки: их видит только автор, секунды.
      const list = await fetchAllRows((from, to) => {
        let q = db.from('dp_requests').select(FIELDS).neq('status', 'draft')
        if (scopedObjectIds.length > 0) q = q.in('object_id', scopedObjectIds)
        return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      setRows(list)
      setMissing(false)
      setLoadedAt(new Date())
    } catch (err) {
      if (isDpMigrationMissing(err)) {
        setMissing(true)
      } else {
        console.error('Статистика заявок на ДП:', err.message)
        setError(err.message || 'Не удалось загрузить заявки')
      }
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  const options = useMemo(() => ({
    ...dpFilterOptions(rows),
    depts: DEPTS.filter(d => rows.some(r => !r.deleted_at && r.objects?.status === d.id)),
  }), [rows])
  const filtered = useMemo(() => filterDpRequests(rows, { dept, objectId, respKey }), [rows, dept, objectId, respKey])
  // «Сейчас» фиксируется вместе с загрузкой: числа не меняются сами, пока страница открыта.
  const now = useMemo(() => loadedAt || new Date(), [loadedAt])
  const s = useMemo(() => computeDpStats(filtered, now), [filtered, now])
  const dynamics = useMemo(() => buildDpDynamics(filtered, granularity, now), [filtered, granularity, now])
  const starts = periodStarts(now)

  const fActive = dept !== 'all' || objectId !== 'all' || respKey !== 'all'
  const reset = () => { setDept('all'); setObjectId('all'); setRespKey('all') }
  const statusSegments = STATUS_SEGMENTS.map(seg => ({ label: DP_STATUS_LABEL[seg.key], color: seg.color, value: s.byStatus[seg.key] || 0 }))
  const m = s.missing
  const missingParts = Object.keys(MISSING_LABEL).filter(k => m[k] > 0).map(k => `${MISSING_LABEL[k]} — ${m[k]}`)
  const openLink = (id) => `/dp-requests?${DP_REQUEST_PARAM}=${encodeURIComponent(id)}`

  return (
    <>
      <div className="reports-filters kps-toolbar">
        {options.depts.length > 1 && <FilterChip label="Отдел" value={dept} onChange={setDept} options={options.depts} />}
        <FilterChip label="Объект" value={objectId} onChange={setObjectId} options={options.objects} />
        <FilterChip label="Ответственный" value={respKey} onChange={setRespKey} options={options.people} />
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
          {canOpenRegistry && <Link to="/dp-requests" className="activity-refresh kps-link">Заявки на ДП</Link>}
        </div>
      </div>

      {missing ? (
        <div className="section-empty">{DP_MIGRATION_HINT}</div>
      ) : error ? (
        <div className="section-empty">Не удалось загрузить заявки на ДП: {error}</div>
      ) : loading && rows.length === 0 ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="kpi-grid dps-kpi">
            <div className="kpi-card">
              <div className="kpi-label">Всего заявок</div>
              <div className="kpi-value">{s.total}</div>
              <div className="kpi-foot">
                новых: {s.byStatus.new} · в работе: {s.byStatus.in_work} · завершено: {s.byStatus.completed}
                {s.deleted > 0 ? ` · в «Удалённых»: ${s.deleted}` : ''}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Сумма заявок</div>
              <div className="kpi-value dcs-money">{fmtMoney(s.amounts.total)}</div>
              <div className="kpi-foot">
                завершено на {fmtMoney(s.amounts.completed)}
                {s.amounts.withoutAmount > 0 ? ` · сумма не внесена: ${s.amounts.withoutAmount}` : ''}
              </div>
            </div>
            <div className={`kpi-card ${s.stale.newCount > 0 ? 'kpi-card--warn' : ''}`}>
              <div className="kpi-label">Ждут в «Новых»</div>
              <div className={`kpi-value ${s.stale.newCount > 0 ? 'accent-warn' : ''}`}>{s.byStatus.new}</div>
              <div className="kpi-foot">
                дольше {DP_NEW_STALE_DAYS} дн.: {s.stale.newCount}
                {s.stale.oldestNewDays != null ? ` · самая давняя — ${s.stale.oldestNewDays} дн.` : ''}
              </div>
            </div>
            <div className={`kpi-card ${m.requests > 0 ? 'kpi-card--warn' : ''}`}>
              <div className="kpi-label">Не заполнено отделом</div>
              <div className={`kpi-value ${m.requests > 0 ? 'accent-warn' : ''}`}>{m.requests}</div>
              <div className="kpi-foot">{missingParts.length ? `незавершённые: ${missingParts.join(', ')}` : 'у незавершённых всё внесено'}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">От подачи до завершения</div>
              <div className="kpi-value">{formatDuration(s.durations.completeMedianMs)}</div>
              <div className="kpi-foot">
                {s.durations.completeCount ? `медиана по ${s.durations.completeCount} завершённым` : 'завершённых заявок нет'}
              </div>
            </div>
          </div>

          <div className="dash-grid">
            <section className="dash-card">
              <header className="dash-card-head">
                <h3>Статусы сейчас</h3>
                <span className="dash-card-meta">как в реестре</span>
              </header>
              <StatusDonut total={s.total} segments={statusSegments} label="Статусы заявок на ДП" caption="заявок" />
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
                label="Подача и завершение заявок на ДП"
                series={[
                  { key: 'created', label: 'Подано', color: '#2563eb' },
                  { key: 'completed', label: 'Завершено', color: '#16a34a' },
                ]}
              />
            </section>

            <section className="dash-card dash-card--attention">
              <header className="dash-card-head"><h3>Требуют внимания</h3></header>
              <div className="attn-list">
                <QueueItem tone="danger" label={`Новые дольше ${DP_NEW_STALE_DAYS} дней`} value={s.stale.newCount}
                  hint="подана, в работу не взята" />
                <QueueItem tone="warn" label={`В работе дольше ${DP_WORK_STALE_DAYS} дней`} value={s.stale.workCount}
                  hint="с момента взятия в работу" />
                <QueueItem tone="warn" label="Не заполнены поля отдела" value={m.requests}
                  hint="объект, договор, сумма или ответственный" />
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

          <section className="report-section">
            <header className="section-head">
              <h3>Незавершённые заявки</h3>
              <span className="section-meta">{s.waiting.length} · дольше всех ждут — сверху</span>
            </header>
            {s.waiting.length === 0 ? (
              <div className="section-empty">Незавершённых заявок нет</div>
            ) : (
              <Limited rows={s.waiting} limit={15} render={(visible) => (
                <div className="kps-table-wrap">
                  <table className="dense-table dps-waiting">
                    <thead>
                      <tr>
                        <th className="num">№</th>
                        <th>Объект</th>
                        <th>Договор</th>
                        <th className="money-col">Сумма</th>
                        <th>Ответственный</th>
                        <th>Подал(а)</th>
                        <th>Статус</th>
                        <th className="num" title="Дата подачи или взятия в работу">С какого числа</th>
                        <th className="num">Ждёт, дн.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(r => (
                        <tr key={r.id}>
                          <td className="num">
                            {canOpenRegistry
                              ? <Link to={openLink(r.id)} className="dps-open">{r.number ?? '—'}</Link>
                              : (r.number ?? '—')}
                          </td>
                          <td className={r.object ? '' : 'dps-gap'}>{r.object || 'не заполнено'}</td>
                          <td className={r.contract ? '' : 'dps-gap'}>{r.contract || 'не заполнено'}</td>
                          <td className={`money-col${r.amount == null ? ' dps-gap' : ''}`}>{r.amount == null ? 'не заполнено' : fmtMoney(r.amount)}</td>
                          <td className={r.responsible ? '' : 'dps-gap'}>
                            {r.responsible || 'не заполнено'}
                            {r.responsibleRole && <span className="dps-role">{r.responsibleRole}</span>}
                          </td>
                          <td>{r.author || '—'}</td>
                          <td className="dcs-nowrap">{DP_STATUS_LABEL[r.status] || r.status}</td>
                          <td className="num">{fmtDateTime(r.since)}</td>
                          <td className={`num${r.stale ? ' strong accent-warn' : ''}`}>{r.days ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )} />
            )}
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По объектам</h3>
              <span className="section-meta">{s.byObject.length}</span>
            </header>
            <GroupTable rows={s.byObject} nameTitle="Объект" empty="Заявок нет" />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>По ответственным</h3>
              <span className="section-meta">экономист объекта или руководитель строительства</span>
            </header>
            <GroupTable rows={s.byResponsible} nameTitle="Ответственный" empty="Заявок нет" withRole />
          </section>

          <section className="report-section">
            <header className="section-head">
              <h3>Кто подаёт заявки</h3>
              <span className="section-meta">{s.byAuthor.length}</span>
            </header>
            <GroupTable rows={s.byAuthor} nameTitle="Подал(а)" empty="Заявок нет" limit={15} />
          </section>
        </>
      )}
    </>
  )
}

export default DpRequestStats
