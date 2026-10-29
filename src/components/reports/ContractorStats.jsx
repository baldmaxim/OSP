import { useCallback, useEffect, useMemo, useState } from 'react'
import { db } from '../../api'
import { fetchAllRowsParallel } from '../../utils/fetchPagesParallel'
import { NO_VOR_DIVISION, VOR_DIVISIONS } from '../../utils/vorDivisions'
import { WORK_TYPE_DIVISION_HINT, divisionByWorkType, hasDivisionColumn } from '../../utils/workTypeDivisions'
import { CP_LIMITED_LABEL, CP_STATUS_BLACKLIST, CP_STATUS_LIMITED } from '../../utils/counterpartyStatus'
import {
  AMOUNT_PRESETS, DEFAULT_SORT, SHOW_OPTIONS, buildContractorRows, divisionBreakdown, filterByDivision,
  filterContractorRows, isAmountFilterActive, sortContractorRows, summarizeContractors,
} from '../../utils/contractorStats'
import { RATE_NOTE, currencyEntries, fmtCur, fmtInt } from '../../utils/reportCurrency'
import { IconCoins, IconSearch } from '../icons/ToolbarIcons'
import VorDivisionChip from '../VorDivisionChip'
import { ProgressBar } from './ReportCharts'
// Только помощники (.ui-sr-only у поиска и плашек подразделений) и токены — правила раздела действуют под .ui-work.
import '../../styles/workUi.css'

// Отчёт «Подрядчики» (до 29.10.2026 — «Победители»): участие в тендерах, отправленные КП, отказы, победы и
// заключённые договоры по каждому подрядчику; фильтры — отдел, подразделение (по видам работ), сумма договоров,
// поиск, кого показывать. Расчёт — utils/contractorStats.js. Тендеры и договоры приходят со страницы (та же
// выборка, что у остальных отчётов), участников, файлы КП, победителей и справочники компонент грузит сам —
// при первом открытии вкладки.

const PAGE = 50
const DEFAULT_FILTERS = { dept: 'all', division: '', amount: { preset: 'any', from: '', to: '' }, show: 'all', search: '' }

const pctText = (share) => (share == null ? '—' : `${Math.round(share * 100)} %`)
const plural = (n, one, few, many) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
const rub = (n) => `${fmtInt(n)} ₽`
// Крупные суммы в карточке — в млн / млрд, полная — в подсказке.
const rubShort = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млрд ₽`
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`
  return rub(n)
}
const moneyTitle = (byCur, foreign) => (foreign
  ? `${RATE_NOTE}\n${currencyEntries(byCur).map((e) => fmtCur(e.amt, e.cur)).join(' · ')}`
  : undefined)

const isMissingTable = (err) => err?.code === 'PGRST205' || err?.code === '42P01'

function Svg({ children, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}
const IconUsers = () => (
  <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Svg>
)
const IconSend = () => <Svg><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></Svg>
const IconTrophy = () => (
  <Svg><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></Svg>
)
const IconAward = () => <Svg><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" /></Svg>
const IconPercent = () => <Svg><line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></Svg>

function Kpi({ icon, tone, label, value, foot, title }) {
  return (
    <div className="cs-kpi-card" title={title}>
      <span className={`cs-kpi-ico cs-tone-${tone}`}>{icon}</span>
      <div className="cs-kpi-body">
        <div className="kpi-label">{label}</div>
        <div className="cs-kpi-value">{value}</div>
        {foot && <div className="kpi-foot">{foot}</div>}
      </div>
    </div>
  )
}

// Воронка участия: от участий в тендерах к КП и победам; доля — от участий.
function Funnel({ s }) {
  const steps = [
    { key: 'part', label: 'Участие в тендерах', value: s.participations, tone: 'blue', hint: 'Тендеры, куда подрядчик приглашён, прислал КП или победил' },
    { key: 'kp', label: 'Отправлено КП', value: s.kp, tone: 'cyan', hint: 'Статус «КП предоставлено» или загружен файл КП' },
    { key: 'declined', label: 'Отказались', value: s.declined, tone: 'red', hint: 'Статус участника «Отказ», КП нет' },
    { key: 'wins', label: 'Побед', value: s.wins, tone: 'green', hint: 'Завершённые тендеры, где подрядчик среди победителей' },
  ]
  const base = s.participations || 1
  return (
    <ul className="cs-funnel">
      {steps.map((st) => (
        <li key={st.key} title={st.hint}>
          <div className="cs-funnel-head">
            <span className="cs-funnel-label">{st.label}</span>
            <span className="cs-funnel-val">{fmtInt(st.value)}</span>
            <span className="cs-funnel-pct">{st.key === 'part' ? '' : `${Math.round((st.value / base) * 100)} %`}</span>
          </div>
          <div className="cs-funnel-track">
            <div className={`cs-funnel-fill cs-tone-${st.tone}`} style={{ width: `${Math.min(100, (st.value / base) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function SortTh({ label, sortKey, sort, onSort, className = '', title }) {
  const active = sort.key === sortKey
  return (
    <th className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}>
      <button type="button" className={`cs-sort${active ? ' is-active' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="cs-sort-arrow" aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  )
}

function ContractorStats({ tenders = [], contracts = [], scopedObjectIds = [] }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [limit, setLimit] = useState(PAGE)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const scoped = scopedObjectIds.length > 0
      // Строки по тендерам — постранично (потолок шлюза — 1000 строк); при области объектов — только её тендеры.
      const byTender = (table, select, narrow = (q) => q) => fetchAllRowsParallel((from, to, withCount) => {
        let q = db.from(table).select(scoped ? `${select}, tenders!inner(object_id)` : select, withCount ? { count: 'exact' } : undefined)
        q = narrow(q)
        if (scoped) q = q.in('tenders.object_id', scopedObjectIds)
        return q.order('id', { ascending: true }).range(from, to)
      })
      const [participants, kpFiles, winners, counterparties, workTypes] = await Promise.all([
        byTender('tender_counterparties', 'id, tender_id, counterparty_id, status'),
        byTender('tender_proposal_files', 'id, tender_id, counterparty_id', (q) => q.eq('file_kind', 'commercial_proposal')),
        // Нет таблицы победителей — считаем по основному победителю тендера, как раньше.
        byTender('tender_winners', 'id, tender_id, counterparty_id').catch((err) => {
          if (!isMissingTable(err)) console.warn('Победители тендеров для отчёта:', err.message)
          return null
        }),
        fetchAllRowsParallel((from, to, withCount) => db.from('counterparties')
          .select('id, name, inn, work_type, status, deleted_at', withCount ? { count: 'exact' } : undefined)
          .order('id', { ascending: true }).range(from, to)),
        db.from('work_types').select('*').order('name', { ascending: true }).then(({ data: rows, error: err }) => {
          if (err) console.warn('Виды работ для отчёта:', err.message)
          return err ? [] : rows || []
        }),
      ])
      setData({ participants, kpFiles, winners, counterparties, workTypes })
      setLoadedAt(new Date())
    } catch (err) {
      console.error('Отчёт «Подрядчики»:', err.message)
      setError(err.message || 'Не удалось загрузить данные')
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  const hasDivisions = hasDivisionColumn(data?.workTypes)
  const divisionByName = useMemo(() => divisionByWorkType(data?.workTypes), [data])

  const deptTenders = useMemo(
    () => (filters.dept === 'all' ? tenders : tenders.filter((t) => t.objects?.status === filters.dept)),
    [tenders, filters.dept]
  )
  const allRows = useMemo(() => (data ? buildContractorRows({
    tenders: deptTenders, contracts, divisionByName,
    participants: data.participants, kpFiles: data.kpFiles, winners: data.winners, counterparties: data.counterparties,
  }) : []), [data, deptTenders, contracts, divisionByName])

  const showCounts = useMemo(() => ({
    all: allRows.length, kp: allRows.filter((r) => r.kp > 0).length, winners: allRows.filter((r) => r.wins > 0).length,
  }), [allRows])
  const filtered = useMemo(
    () => filterContractorRows(allRows, { show: filters.show, amount: filters.amount, search: filters.search }),
    [allRows, filters.show, filters.amount, filters.search]
  )
  const breakdown = useMemo(() => divisionBreakdown(filtered.rows), [filtered])
  const rows = useMemo(() => filterByDivision(filtered.rows, filters.division), [filtered, filters.division])
  const summary = useMemo(() => summarizeContractors(rows), [rows])
  const sorted = useMemo(() => sortContractorRows(rows, sort), [rows, sort])
  const maxWins = useMemo(() => Math.max(1, ...rows.map((r) => r.wins)), [rows])

  // Смена отбора и сортировки — список снова с начала.
  useEffect(() => { setLimit(PAGE) }, [filters, sort])

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }))
  const setAmount = (patch) => setFilters((f) => ({ ...f, amount: { ...f.amount, ...patch } }))
  const filtersActive = filters.dept !== 'all' || !!filters.division || isAmountFilterActive(filters.amount)
    || filters.show !== 'all' || !!filters.search.trim()
  const onSort = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' }))
  const isRating = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir
  const visible = sorted.slice(0, limit)

  return (
    <>
      <div className="reports-filters cs-toolbar">
        <label className={`rf-chip cs-search${filters.search.trim() ? ' is-active' : ''}`}>
          <IconSearch size={14} />
          <span className="ui-sr-only">Поиск подрядчика</span>
          <input
            type="search"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="Подрядчик, ИНН, вид работ"
          />
        </label>
        <label className={`rf-chip ${filters.dept !== 'all' ? 'is-active' : ''}`}>
          <span className="rf-chip-key">Отдел:</span>
          <select className="rf-chip-select" value={filters.dept} onChange={(e) => setFilter('dept', e.target.value)}>
            <option value="all">Все</option>
            <option value="main_construction">Основное строительство</option>
            <option value="warranty_service">Гарантийный отдел</option>
          </select>
        </label>
        <label
          className={`rf-chip ${filters.division ? 'is-active' : ''}${hasDivisions ? '' : ' is-disabled'}`}
          title={hasDivisions ? 'Подразделение по видам работ подрядчика (как в реестре контрагентов)' : WORK_TYPE_DIVISION_HINT}
        >
          <span className="rf-chip-key">Подразделение:</span>
          <select
            className="rf-chip-select"
            value={filters.division}
            onChange={(e) => setFilter('division', e.target.value)}
            disabled={!hasDivisions}
          >
            <option value="">Все</option>
            {VOR_DIVISIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            <option value={NO_VOR_DIVISION}>Не указано</option>
          </select>
        </label>
        <label className={`rf-chip ${isAmountFilterActive(filters.amount) ? 'is-active' : ''}`} title="Сумма заключённых договоров и ДС, ≈ ₽">
          <span className="rf-chip-key">Сумма договоров:</span>
          <select className="rf-chip-select" value={filters.amount.preset} onChange={(e) => setAmount({ preset: e.target.value })}>
            {AMOUNT_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {filters.amount.preset === 'custom' && (
          <span className="rf-chip cs-range is-active">
            <span className="rf-chip-key">от</span>
            <input inputMode="decimal" aria-label="Сумма от, млн ₽" value={filters.amount.from}
              onChange={(e) => setAmount({ from: e.target.value })} placeholder="0" />
            <span className="rf-chip-key">до</span>
            <input inputMode="decimal" aria-label="Сумма до, млн ₽" value={filters.amount.to}
              onChange={(e) => setAmount({ to: e.target.value })} placeholder="∞" />
            <span className="rf-chip-key">млн ₽</span>
          </span>
        )}
        {filtersActive && (
          <button type="button" className="rf-reset" onClick={() => setFilters(DEFAULT_FILTERS)}>Сбросить</button>
        )}
        <div className="kps-toolbar-end">
          {loadedAt && (
            <span className="reports-updated">
              Данные на {loadedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button type="button" className="activity-refresh" onClick={load} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="section-empty">Не удалось загрузить данные отчёта: {error}</div>
      ) : !data ? (
        <div className="section-empty">Загрузка…</div>
      ) : (
        <>
          <div className="cs-kpi">
            <Kpi
              icon={<IconUsers />} tone="blue" label="Подрядчиков"
              value={fmtInt(summary.contractors)}
              foot={`прислали КП: ${summary.withKp} · с победами: ${summary.winners}`}
            />
            <Kpi
              icon={<IconSend />} tone="cyan" label="Отправлено КП"
              value={fmtInt(summary.kp)}
              foot={`ответ на ${pctText(summary.responseRate)} приглашений · файлов: ${fmtInt(summary.kpFiles)}`}
              title="Тендеры, где у подрядчика статус «КП предоставлено» или загружен файл КП. Файлы — вместе с новыми версиями."
            />
            <Kpi
              icon={<IconTrophy />} tone="green" label="Тендеров с победителем"
              value={fmtInt(summary.closedWithWinner)}
              foot={summary.wins !== summary.closedWithWinner
                ? `завершённых · побед: ${summary.wins} — у части тендеров несколько победителей`
                : `завершённых · побед: ${summary.wins}`}
            />
            <Kpi
              icon={<IconAward />} tone="amber" label="Уникальных победителей"
              value={fmtInt(summary.winners)}
              foot={`${pctText(summary.contractors ? summary.winners / summary.contractors : null)} подрядчиков выборки`}
            />
            <Kpi
              icon={<IconPercent />} tone="violet" label="КП → победа"
              value={pctText(summary.winRate)}
              foot="побед от КП в завершённых тендерах"
            />
            <Kpi
              icon={<IconCoins size={18} />} tone="emerald" label="Сумма договоров"
              value={summary.anyForeign ? `≈ ${rubShort(summary.signedAmountRub)}` : rubShort(summary.signedAmountRub)}
              title={`${rub(summary.signedAmountRub)}${summary.anyForeign ? `\n${RATE_NOTE}` : ''}`}
              foot={`заключённых: ${summary.signedContracts} ${plural(summary.signedContracts, 'договор', 'договора', 'договоров')} и ДС у ${summary.withContracts} ${plural(summary.withContracts, 'подрядчика', 'подрядчиков', 'подрядчиков')}`}
            />
          </div>

          <div className="cs-dash">
            <section className="dash-card">
              <header className="dash-card-head">
                <h3>Воронка участия</h3>
                <span className="dash-card-meta">доля — от участий</span>
              </header>
              <Funnel s={summary} />
            </section>

            <section className="dash-card cs-divisions">
              <header className="dash-card-head">
                <h3>По подразделениям</h3>
                <span className="dash-card-meta">{hasDivisions ? 'по видам работ · нажмите строку' : ''}</span>
              </header>
              {!hasDivisions ? (
                <div className="section-empty">{WORK_TYPE_DIVISION_HINT}</div>
              ) : (
                <div className="cs-table-wrap">
                  <table className="dense-table cs-div-table">
                    <thead>
                      <tr>
                        <th>Подразделение</th>
                        <th className="num">Подрядчиков</th>
                        <th className="num">КП</th>
                        <th className="num">Побед</th>
                        <th className="num">Сумма договоров</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map((d) => {
                        const active = filters.division === d.value
                        const toggle = () => setFilter('division', active ? '' : d.value)
                        return (
                          <tr
                            key={d.value}
                            className={`cs-div-row${active ? ' is-active' : ''}${d.contractors ? '' : ' row-muted'}`}
                            onClick={toggle}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
                            tabIndex={0}
                            aria-pressed={active}
                          >
                            <td>{d.label}</td>
                            <td className="num strong">{d.contractors || '—'}</td>
                            <td className="num">{d.kp || '—'}</td>
                            <td className="num">{d.wins || '—'}</td>
                            <td className="num cs-nowrap">{d.signedAmountRub > 0 ? `${d.anyForeign ? '≈ ' : ''}${rubShort(d.signedAmountRub)}` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="report-section">
            <header className="section-head cs-list-head">
              <h3>Рейтинг подрядчиков</h3>
              <div className="cs-show" role="group" aria-label="Кого показывать">
                {SHOW_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`cs-show-btn${filters.show === o.value ? ' is-active' : ''}`}
                    aria-pressed={filters.show === o.value}
                    onClick={() => setFilter('show', o.value)}
                  >
                    {o.label}
                    <span className="cs-show-count">{showCounts[o.value]}</span>
                  </button>
                ))}
              </div>
            </header>
            {filtered.fix && (
              <div className="cs-search-fix">
                {filtered.fix.kind === 'layout'
                  ? <>Найдено по запросу «{filtered.fix.query}» — в другой раскладке</>
                  : <>Точных совпадений нет — показаны похожие названия</>}
              </div>
            )}
            {sorted.length === 0 ? (
              <div className="section-empty">
                {allRows.length === 0
                  ? 'Участников тендеров пока нет'
                  : 'Под выбранные фильтры подрядчиков нет'}
              </div>
            ) : (
              <>
                <div className="cs-table-wrap">
                  <table className="dense-table cs-table">
                    <thead>
                      <tr>
                        <th className="num cs-col-rank">#</th>
                        <SortTh label="Подрядчик" sortKey="name" sort={sort} onSort={onSort} className="cs-col-name" />
                        <SortTh label="Участие" sortKey="tenders" sort={sort} onSort={onSort} className="num"
                          title="Тендеры, куда приглашён, прислал КП или победил" />
                        <SortTh label="КП" sortKey="kp" sort={sort} onSort={onSort} className="num"
                          title="Отправлено КП: тендеры со статусом «КП предоставлено» или файлом КП" />
                        <SortTh label="Побед" sortKey="wins" sort={sort} onSort={onSort} className="num" />
                        <SortTh label="% побед" sortKey="winRate" sort={sort} onSort={onSort} className="num"
                          title="Победы от КП в завершённых тендерах" />
                        <SortTh label="Договоры и ДС" sortKey="contracts" sort={sort} onSort={onSort} className="num"
                          title="Заключено (статус «Завершено») из всех договоров и ДС основного строительства" />
                        <SortTh label="Сумма" sortKey="amount" sort={sort} onSort={onSort} className="num"
                          title="Сумма заключённых договоров и ДС" />
                        <th className="bar-col">Доля побед</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r, idx) => (
                        <tr key={r.id}>
                          <td className="num cs-col-rank">
                            <span className={`cs-rank${isRating && r.wins > 0 && idx < 3 ? ` cs-rank--${idx + 1}` : ''}`}>{idx + 1}</span>
                          </td>
                          <td className="cs-col-name">
                            <div className="cs-name">
                              <span className="cs-name-text">{r.name}</span>
                              {r.deleted && <span className="cs-badge cs-badge--muted">удалён</span>}
                              {r.cpStatus === CP_STATUS_BLACKLIST && <span className="cs-badge cs-badge--danger">чёрный список</span>}
                              {r.cpStatus === CP_STATUS_LIMITED && <span className="cs-badge cs-badge--warn">{CP_LIMITED_LABEL}</span>}
                            </div>
                            <div className={`cs-worktype${r.workType ? '' : ' is-empty'}`} title={r.workType || undefined}>
                              {r.workType || 'вид работ не указан'}
                            </div>
                            {r.divisions.length > 0 && (
                              <div className="cs-divs">
                                {r.divisions.map((d) => <VorDivisionChip key={d} subject="cp" value={d} />)}
                              </div>
                            )}
                          </td>
                          <td className="num">
                            <div>{r.tenders}</div>
                            {r.declined > 0 && <div className="cs-sub cs-sub--danger">отказ: {r.declined}</div>}
                          </td>
                          <td className="num" title={`Файлов КП: ${r.kpFiles} (с новыми версиями)`}>
                            <div className="strong">{r.kp || '—'}</div>
                            {r.kp > 0 && <div className="cs-sub">{pctText(r.responseRate)} ответов</div>}
                          </td>
                          <td className="num">
                            <div className={r.wins ? 'cs-wins' : 'muted'}>{r.wins || '—'}</div>
                            {(r.winsConst > 0 || r.winsWar > 0) && (
                              <div className="cs-sub" title="Основное строительство · гарантийный отдел">
                                стр. {r.winsConst} · гар. {r.winsWar}
                              </div>
                            )}
                          </td>
                          <td className="num" title={r.closedEngaged ? `${r.wins} из ${r.closedEngaged} завершённых тендеров с КП` : 'Завершённых тендеров с КП нет'}>
                            {pctText(r.winRate)}
                          </td>
                          <td className="num">
                            <div>{r.signedContracts || '—'}</div>
                            {r.contractsTotal > r.signedContracts && <div className="cs-sub">из {r.contractsTotal}</div>}
                          </td>
                          <td className="num cs-nowrap" title={moneyTitle(r.signedByCur, r.hasForeign)}>
                            {r.signedAmountRub > 0 ? `${r.hasForeign ? '≈ ' : ''}${rub(r.signedAmountRub)}` : '—'}
                          </td>
                          <td className="bar-col">
                            <ProgressBar value={r.wins} total={maxWins} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="cs-more">
                  <span className="cs-more-text">Показано {visible.length} из {sorted.length}</span>
                  {sorted.length > limit && (
                    <>
                      <button type="button" className="activity-refresh" onClick={() => setLimit((l) => l + PAGE)}>
                        Показать ещё {Math.min(PAGE, sorted.length - limit)}
                      </button>
                      <button type="button" className="activity-refresh" onClick={() => setLimit(sorted.length)}>
                        Показать всех
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </>
  )
}

export default ContractorStats
