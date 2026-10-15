import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import FilterDropdown from '../components/FilterDropdown'
import { larixContractUrl, LARIX_NAME } from '../utils/contractLarix'
import {
  fmtMoney, fmtDate, fmtRefreshed, describeRegistryError, PAGE_SIZES, useDebounced,
  applyInFilter, fetchAllRows, downloadXlsx, todayStamp,
} from '../utils/ratesRegistry'

// Вкладка «Договорные расценки (Larix)» реестра расценок. Источник — Larix.CPM, метод «ВОР по договорам»:
// osp-api загружает его раз в день в таблицу larix_contract_rates (server/osp-api/src/lib/larixSync.js,
// миграция 20261018). Вид — как у вкладки КП: подвкладки «Материалы / Работы», в строке одна цена; позиция
// ВОР с обеими ценами есть в обеих подвкладках. Всё серверное: фильтры, сортировка, страницы.
// Свежесть и итог последней загрузки — журнал larix_sync_runs; списки фильтров — там же (filters).

const LARIX_COLS = 'id,item_type,item_name,unit,price,vat_rate,materials_used,comment,project_id,project_name,'
  + 'contractor_id,contractor_name,contract_id,contract_number,contract_date,contract_state,object_type,osp_contract_id'
const EXPORT_COLS = `${LARIX_COLS},price_material,price_work`
const SORT_COLUMN = {
  name: 'item_name', price: 'price', date: 'contract_date', contract: 'contract_number', contractor: 'contractor_name',
}
// Если Larix отдаёт ставку НДС, то под одним из этих имён (тот же список — server/osp-api/src/lib/larixSync.js).
const VAT_KEYS = ['vat_rate', 'vat', 'nds', 'nds_rate', 'vat_percent', 'nds_percent']
const MISSING = 'Договорные расценки ещё не настроены в базе данных. Обратитесь к администратору — требуется миграция 20261018_larix_contract_rates.sql и загрузка из Larix.'

// Причина неудачной или отложенной загрузки — по коду журнала, без технических подробностей.
const RUN_REASON = {
  login: 'Larix отклонил вход — нужно проверить логин и пароль технической учётки в настройках сервера.',
  http: 'Larix был недоступен.',
  timeout: 'Larix не ответил вовремя.',
  too_large: 'ответ Larix оказался больше допустимого размера.',
  invalid: 'Larix вернул данные в неожиданном формате.',
  db: 'не удалось записать данные в базу.',
  stale: 'загрузка прервалась.',
  empty: 'Larix вернул пустой список.',
  shrink: 'позиций стало намного меньше, чем в прошлый раз, — нужна проверка.',
}

const fmtCount = (n) => Number(n || 0).toLocaleString('ru-RU')
const fmtVat = (v) => (v == null || v === '' || isNaN(v) ? '—' : `${fmtMoney(v)} %`)

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

// Строка о свежести данных и предупреждение, если последняя загрузка не удалась или отложена.
function LarixStatus({ lastRun, lastOk, loaded }) {
  if (!loaded) return null
  const problem = lastRun && (lastRun.status === 'failed' || lastRun.status === 'held')
    && (!lastOk || Number(lastRun.id) > Number(lastOk.id)) ? lastRun : null
  return (
    <>
      <div className="rr-larix-status">
        {lastOk ? (
          <>
            Данные {LARIX_NAME} на <strong>{fmtRefreshed(lastOk.finished_at)}</strong>
            {' · '}позиций ВОР: {fmtCount(lastOk.positions_count)}
            {' · '}договоров: {fmtCount(lastOk.larix_contracts)}, из них в портале: {fmtCount(lastOk.matched_contracts)}
            <span className="rr-larix-status-note"> · обновляются автоматически раз в день</span>
          </>
        ) : lastRun?.status === 'running' ? (
          <>Идёт первая загрузка из {LARIX_NAME}…</>
        ) : (
          <>Загрузки из {LARIX_NAME} ещё не было. Данные появятся после первой автоматической загрузки (раз в день, утром).</>
        )}
        {lastOk && lastRun?.status === 'running' && Number(lastRun.id) > Number(lastOk.id) && (
          <span className="rr-larix-status-note"> · идёт обновление…</span>
        )}
      </div>
      {problem && (
        <div className="rr-larix-warn" role="status">
          {problem.status === 'held'
            ? <>Загрузка {fmtRefreshed(problem.started_at)} отложена: {RUN_REASON[problem.error_code] || 'нужна проверка.'}</>
            : <>Загрузка {fmtRefreshed(problem.started_at)} не удалась: {RUN_REASON[problem.error_code] || 'причина в журнале сервера.'}</>}
          {' '}{lastOk ? 'Показаны данные прошлой загрузки.' : ''}
          {problem.status === 'failed' ? ' Повторная попытка — автоматически.' : ' Принять такой ответ может администратор ручной загрузкой.'}
        </div>
      )}
    </>
  )
}

export default function LarixRegistrySection() {
  const { canView } = useRole()
  const canOpenContracts = canView('contracts')
  const [kindTab, setKindTab] = useState('materials') // 'materials' | 'works'

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search, 400)
  const [projectIds, setProjectIds] = useState([])
  const [contractorIds, setContractorIds] = useState([])
  const [contractIds, setContractIds] = useState([])
  const [states, setStates] = useState([])
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)

  const [rows, setRows] = useState([])
  const [counts, setCounts] = useState({ materials: 0, works: 0 })
  const [countsFailed, setCountsFailed] = useState(false)
  const [lastPageSize, setLastPageSize] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [exporting, setExporting] = useState(false)

  // Журнал загрузок: последняя (любая) и последняя удачная — с ней приходят списки фильтров.
  const [lastRun, setLastRun] = useState(null)
  const [lastOk, setLastOk] = useState(null)
  const [statusLoaded, setStatusLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      db.from('larix_sync_runs').select('id,status,started_at,finished_at,error_code')
        .order('id', { ascending: false }).limit(1),
      db.from('larix_sync_runs').select('id,finished_at,positions_count,larix_contracts,matched_contracts,response_keys,filters')
        .eq('status', 'ok').order('id', { ascending: false }).limit(1),
    ]).then(([runRes, okRes]) => {
      if (cancelled) return
      setLastRun(runRes.data?.[0] || null)
      setLastOk(okRes.data?.[0] || null)
      setStatusLoaded(true)
    }).catch(() => { if (!cancelled) setStatusLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const options = useMemo(() => {
    const f = lastOk?.filters || {}
    const byLabel = (a, b) => a.label.localeCompare(b.label, 'ru')
    return {
      projects: (f.projects || []).filter(p => p.id != null).map(p => ({ value: String(p.id), label: p.name || `Проект ${p.id}` })).sort(byLabel),
      contractors: (f.contractors || []).filter(c => c.id != null).map(c => ({ value: String(c.id), label: c.name || `Подрядчик ${c.id}` })).sort(byLabel),
      contracts: (f.contracts || []).filter(c => c.id != null)
        .map(c => ({ value: String(c.id), label: `${c.number || `№ ${c.id}`}${c.date ? ` от ${fmtDate(c.date)}` : ''}` })).sort(byLabel),
      states: (f.states || []).filter(Boolean).map(s => ({ value: s, label: s })).sort(byLabel),
    }
  }, [lastOk])
  const hasVat = useMemo(() => (lastOk?.response_keys || []).some(k => VAT_KEYS.includes(k)), [lastOk])

  // Размеры списков — в ref, как у вкладки КП: иначе их появление пересоздаёт applyFilters и данные
  // грузятся второй раз.
  const optionCounts = useRef({ projects: 0, contractors: 0, contracts: 0, states: 0 })
  useEffect(() => {
    optionCounts.current = {
      projects: options.projects.length, contractors: options.contractors.length,
      contracts: options.contracts.length, states: options.states.length,
    }
  }, [options])

  const applyFilters = useCallback((q) => {
    const s = debouncedSearch.trim()
    if (s) q = q.ilike('item_name', `%${s}%`)
    q = applyInFilter(q, 'project_id', projectIds, optionCounts.current.projects)
    q = applyInFilter(q, 'contractor_id', contractorIds, optionCounts.current.contractors)
    q = applyInFilter(q, 'contract_id', contractIds, optionCounts.current.contracts)
    q = applyInFilter(q, 'contract_state', states, optionCounts.current.states)
    if (priceMin !== '' && !isNaN(Number(priceMin))) q = q.gte('price', Number(priceMin))
    if (priceMax !== '' && !isNaN(Number(priceMax))) q = q.lte('price', Number(priceMax))
    if (dateFrom) q = q.gte('contract_date', dateFrom)
    if (dateTo) q = q.lte('contract_date', dateTo)
    return q
  }, [debouncedSearch, projectIds, contractorIds, contractIds, states, priceMin, priceMax, dateFrom, dateTo])

  useEffect(() => {
    setPage(0)
  }, [debouncedSearch, projectIds, contractorIds, contractIds, states, priceMin, priceMax, dateFrom, dateTo, sortBy, sortDir, kindTab, pageSize])

  const ordered = useCallback((q) => q
    .order(SORT_COLUMN[sortBy] || 'item_name', { ascending: sortDir === 'asc', nullsFirst: false })
    .order('id', { ascending: true }), [sortBy, sortDir])

  // Текущая страница активной подвкладки.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const from = page * pageSize
        const itemType = kindTab === 'materials' ? 'material' : 'work'
        const q = ordered(applyFilters(db.from('larix_contract_rates').select(LARIX_COLS).eq('item_type', itemType)))
          .range(from, from + pageSize - 1)
        const { data, error: qErr } = await q
        if (qErr) throw qErr
        if (cancelled) return
        setRows(data || [])
        setLastPageSize(data?.length || 0)
      } catch (err) {
        if (cancelled) return
        console.error('Ошибка загрузки договорных расценок:', err.message)
        setError(describeRegistryError(err, MISSING))
        setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [kindTab, page, pageSize, ordered, applyFilters])

  // Счётчики подвкладок — только при смене фильтров, не при листании.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const mk = (type) => applyFilters(db.from('larix_contract_rates').select('id', { count: 'exact', head: true }).eq('item_type', type))
        const [m, w] = await Promise.all([mk('material'), mk('work')])
        if (cancelled) return
        if (m.error || w.error) throw (m.error || w.error)
        setCounts({ materials: m.count || 0, works: w.count || 0 })
        setCountsFailed(false)
      } catch {
        if (!cancelled) setCountsFailed(true)
      }
    }
    run()
    return () => { cancelled = true }
  }, [applyFilters])

  const totalCount = countsFailed
    ? page * pageSize + lastPageSize + (lastPageSize === pageSize ? pageSize : 0)
    : (kindTab === 'materials' ? counts.materials : counts.works)

  const resetFilters = () => {
    setSearch(''); setProjectIds([]); setContractorIds([]); setContractIds([]); setStates([])
    setPriceMin(''); setPriceMax(''); setDateFrom(''); setDateTo('')
    setSortBy('name'); setSortDir('asc')
  }
  const hasActiveFilters = Boolean(search || projectIds.length || contractorIds.length || contractIds.length
    || states.length || priceMin || priceMax || dateFrom || dateTo)

  // Выгрузка: материалы и работы вместе (колонка «Тип») под текущие фильтры, обе цены позиции.
  const handleExport = async () => {
    setExporting(true)
    try {
      const all = await fetchAllRows((from, to) => ordered(applyFilters(db.from('larix_contract_rates').select(EXPORT_COLS))).range(from, to))
      if (all.length === 0) { alert('Нет строк для выгрузки под текущие фильтры.'); return }
      const headers = ['№ п/п', 'Объект', 'Подрядчик', 'Тип', 'Наименование', 'Ед. изм.', 'Цена, ₽', 'Цена материалов, ₽', 'Цена работ, ₽',
        ...(hasVat ? ['Ставка НДС, %'] : []), 'Договор', 'Дата договора', 'Статус договора', 'Вид документа', 'Примечание', 'Материалы']
      const num = (v) => (v != null && v !== '' ? Number(v) : '')
      const dataRows = all.map((r, i) => [
        i + 1, r.project_name || '', r.contractor_name || '', r.item_type === 'work' ? 'Работа' : 'Материал', r.item_name || '',
        r.unit || '', num(r.price), num(r.price_material), num(r.price_work), ...(hasVat ? [num(r.vat_rate)] : []),
        r.contract_number || '', r.contract_date ? fmtDate(r.contract_date) : '', r.contract_state || '', r.object_type || '',
        r.comment || '', r.materials_used || '',
      ])
      downloadXlsx(headers, dataRows, 'Договорные расценки', `Реестр расценок (Larix) ${todayStamp()}.xlsx`,
        [6, 24, 24, 10, 46, 10, 14, 14, 14, ...(hasVat ? [10] : []), 24, 12, 14, 14, 30, 30])
    } catch (err) {
      alert('Ошибка выгрузки: ' + (err.message || err))
    } finally {
      setExporting(false)
    }
  }

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(col); setSortDir('asc') }
  }
  const sortIndicator = (col) => (sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const fromRow = totalCount === 0 ? 0 : page * pageSize + 1
  const toRow = Math.min(totalCount, (page + 1) * pageSize)
  const isMaterials = kindTab === 'materials'

  const contractCell = (r) => {
    const label = r.contract_number || (r.contract_id ? `№ ${r.contract_id}` : '—')
    const larixUrl = larixContractUrl(r.contract_id)
    const internal = r.osp_contract_id && canOpenContracts
    const meta = [r.contract_state, r.object_type && r.object_type !== 'Договор' ? r.object_type : null].filter(Boolean).join(' · ')
    return (
      <>
        <div className="rr-contract-line">
          {internal ? (
            <Link to={`/contracts/${r.osp_contract_id}`} className="rr-tender-link" title="Карточка договора в портале">
              <span className="rr-tender-text">{label}</span>
            </Link>
          ) : larixUrl ? (
            <a href={larixUrl} target="_blank" rel="noopener noreferrer" className="rr-tender-link" title={`Открыть в ${LARIX_NAME}`}>
              <span className="rr-tender-text">{label}</span>
              <ExternalIcon />
            </a>
          ) : <span>{label}</span>}
          {internal && larixUrl && (
            <a href={larixUrl} target="_blank" rel="noopener noreferrer" className="rr-larix-ext" aria-label={`Открыть договор в ${LARIX_NAME}`}
              title={`Открыть в ${LARIX_NAME}`}>
              <ExternalIcon />
            </a>
          )}
        </div>
        {meta && <div className="rr-cell-note">{meta}</div>}
      </>
    )
  }

  return (
    <>
      <LarixStatus lastRun={lastRun} lastOk={lastOk} loaded={statusLoaded} />

      <div className="rr-filters">
        <div className={`rr-filter-group rr-filter-group-search ${search ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Поиск по наименованию</label>
          <input type="search" className={`rr-filter-search ${search ? 'is-active' : ''}`}
            placeholder="Например: газобетон" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className={`rr-filter-group ${projectIds.length ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Объект</label>
          <FilterDropdown label="" multiple searchable searchPlaceholder="Поиск объекта…"
            allLabel={`Все объекты (${options.projects.length})`} value={projectIds} onChange={setProjectIds} options={options.projects} />
        </div>
        <div className={`rr-filter-group ${contractorIds.length ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Подрядчик</label>
          <FilterDropdown label="" multiple searchable searchPlaceholder="Поиск подрядчика…"
            allLabel={`Все подрядчики (${options.contractors.length})`} value={contractorIds} onChange={setContractorIds} options={options.contractors} />
        </div>
        <div className={`rr-filter-group ${contractIds.length ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Договор</label>
          <FilterDropdown label="" multiple searchable searchPlaceholder="Номер договора…"
            allLabel={`Все договоры (${options.contracts.length})`} value={contractIds} onChange={setContractIds} options={options.contracts} />
        </div>
        <div className={`rr-filter-group ${states.length ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Статус договора</label>
          <FilterDropdown label="" multiple allLabel={`Все статусы (${options.states.length})`}
            value={states} onChange={setStates} options={options.states} />
        </div>
        <div className={`rr-filter-group ${priceMin || priceMax ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Цена, ₽</label>
          <div className="rr-filter-range">
            <input type="number" className="rr-filter-num" placeholder="от" min="0"
              value={priceMin} onChange={(e) => setPriceMin(e.target.value)} />
            <span className="rr-filter-range-dash">—</span>
            <input type="number" className="rr-filter-num" placeholder="до" min="0"
              value={priceMax} onChange={(e) => setPriceMax(e.target.value)} />
          </div>
        </div>
        <div className={`rr-filter-group ${dateFrom || dateTo ? 'is-active' : ''}`}>
          <label className="rr-filter-label">Дата договора</label>
          <div className="rr-filter-range">
            <input type="date" className="rr-filter-date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span className="rr-filter-range-dash">—</span>
            <input type="date" className="rr-filter-date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>
        {hasActiveFilters && (
          <button type="button" className="rr-filter-reset" onClick={resetFilters} title="Сбросить все фильтры">✕ Сбросить</button>
        )}
        <button type="button" className="rr-filter-export" onClick={handleExport}
          disabled={exporting || (counts.materials + counts.works) === 0}
          title="Выгрузить в Excel (материалы + работы, учитывает фильтры; без фильтров — весь реестр)">
          <DownloadIcon />
          {exporting ? 'Выгрузка…' : 'Excel'}
        </button>
      </div>

      <div className="rr-sub-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={isMaterials}
          className={`rr-sub-tab ${isMaterials ? 'active' : ''}`} onClick={() => setKindTab('materials')}>
          Материалы<span className="rr-sub-count">{counts.materials}</span>
        </button>
        <button type="button" role="tab" aria-selected={!isMaterials}
          className={`rr-sub-tab ${!isMaterials ? 'active' : ''}`} onClick={() => setKindTab('works')}>
          Работы<span className="rr-sub-count">{counts.works}</span>
        </button>
      </div>

      {error ? (
        <div className="rr-empty rr-error">Ошибка загрузки: {error}</div>
      ) : loading && rows.length === 0 ? (
        <div className="rr-empty">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="rr-empty">
          {hasActiveFilters
            ? 'По заданным фильтрам ничего не найдено.'
            : lastOk
              ? `В последней загрузке из ${LARIX_NAME} нет позиций с ценой ${isMaterials ? 'материалов' : 'работ'}.`
              : `Расценки из ${LARIX_NAME} ещё не загружены. Загрузка идёт автоматически раз в день.`}
        </div>
      ) : (
        <>
          <div className={`rr-table-wrap${loading ? ' is-loading' : ''}`}>
            <table className="rr-table">
              <thead>
                <tr>
                  <th className="rr-th-num">№ п/п</th>
                  <th className="rr-th-object">Объект</th>
                  <th className="rr-th-counterparty rr-th-sortable" onClick={() => toggleSort('contractor')}>
                    Подрядчик{sortIndicator('contractor')}
                  </th>
                  <th className="rr-th-name rr-th-sortable" onClick={() => toggleSort('name')}>
                    {isMaterials ? 'Наименование материалов' : 'Наименование работ'}{sortIndicator('name')}
                  </th>
                  <th className="rr-th-contract rr-th-sortable" onClick={() => toggleSort('contract')}>
                    Договор{sortIndicator('contract')}
                  </th>
                  <th className="rr-th-unit">Ед. изм.</th>
                  <th className="rr-th-price rr-th-sortable" onClick={() => toggleSort('price')}>
                    {isMaterials ? 'Цена за материал, ₽' : 'Цена за работу, ₽'}{sortIndicator('price')}
                  </th>
                  {hasVat && <th className="rr-th-vat">НДС</th>}
                  <th className="rr-th-date rr-th-sortable" onClick={() => toggleSort('date')}>
                    Дата договора{sortIndicator('date')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={r.id}>
                    <td className="rr-td-num">{page * pageSize + idx + 1}</td>
                    <td className="rr-td-object">
                      <span className="rr-chip rr-chip-object" title={r.project_name || '—'}>{r.project_name || '—'}</span>
                    </td>
                    <td className="rr-td-counterparty">
                      <span className="rr-chip rr-chip-cp" title={r.contractor_name || '—'}>{r.contractor_name || '—'}</span>
                    </td>
                    <td className="rr-td-name" title={r.item_name}>
                      {r.item_name}
                      {r.materials_used && <div className="rr-cell-note">Материалы: {r.materials_used}</div>}
                      {r.comment && <div className="rr-cell-note">{r.comment}</div>}
                    </td>
                    <td className="rr-td-contract">{contractCell(r)}</td>
                    <td className="rr-td-unit">{r.unit || '—'}</td>
                    <td className="rr-td-price">{fmtMoney(r.price)}</td>
                    {hasVat && <td className="rr-td-vat">{fmtVat(r.vat_rate)}</td>}
                    <td className="rr-td-date">{fmtDate(r.contract_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rr-pagination">
            <div className="rr-pagination-info">{fromRow}–{toRow} из {totalCount}</div>
            <div className="rr-pagination-controls">
              <label className="rr-page-size">
                На странице:
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <button className="rr-page-btn" disabled={page <= 0 || loading} onClick={() => setPage(0)} title="Первая">«</button>
              <button className="rr-page-btn" disabled={page <= 0 || loading} onClick={() => setPage(p => Math.max(0, p - 1))} title="Назад">‹</button>
              <span className="rr-page-cur">Стр. {page + 1} из {totalPages}</span>
              <button className="rr-page-btn" disabled={page >= totalPages - 1 || loading} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} title="Вперёд">›</button>
              <button className="rr-page-btn" disabled={page >= totalPages - 1 || loading} onClick={() => setPage(totalPages - 1)} title="Последняя">»</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
