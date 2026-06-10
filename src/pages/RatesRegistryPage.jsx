import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import './RatesRegistryPage.css'

// task 356/354/411: «Реестр расценок» — общий список расценок из разных источников.
//   1) От подрядчиков (КП) — представление kp_rates_registry (дедуп на стороне БД).
//   2) ДП и ДС — в разработке. 3) Снабжение СУ-10 — в разработке.
//
// task 411: всё серверное — пагинация (.range + count), фильтры (.eq/.gte/.lte),
// поиск (.ilike по триграммному индексу), сортировка (.order). В браузер грузится
// только текущая страница, а не весь реестр.

const fmtMoney = (n) => {
  if (n == null || n === '' || isNaN(n)) return ''
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)
}
const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ru-RU')
}

const PAGE_SIZES = [50, 100, 250]
// Сопоставление UI-сортировки → колонке представления.
const SORT_COLUMN = {
  name: 'item_name',
  price: 'price',
  date: 'proposal_date',
  tender: 'tender_desc',
  counterparty: 'counterparty_name',
}

// Локальный debounce-хук (для поиска).
function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

const SELECT_COLS =
  'id,item_type,item_name,unit,price,tender_id,counterparty_id,object_id,tender_desc,object_name,counterparty_name,proposal_date'

function RatesRegistryPage() {
  const [topTab, setTopTab] = useState('kp')          // 'kp' | 'dp_ds' | 'supply'
  const [kindTab, setKindTab] = useState('materials') // 'materials' | 'works'

  // Фильтры
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search, 400)
  const [tenderId, setTenderId] = useState('')
  const [objectId, setObjectId] = useState('')
  const [counterpartyId, setCounterpartyId] = useState('')
  const [unit, setUnit] = useState('')
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Сортировка + страница
  const [sortBy, setSortBy] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)

  // Данные текущей страницы
  const [rows, setRows] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [counts, setCounts] = useState({ materials: 0, works: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Справочники для фильтров (грузятся отдельно, легко)
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [tenders, setTenders] = useState([])
  const [units, setUnits] = useState([])

  // Применяет фильтры к произвольному query-builder (для страницы и для счётчиков).
  const applyFilters = useCallback((q) => {
    const s = debouncedSearch.trim()
    if (s) q = q.ilike('item_name', `%${s}%`)
    if (tenderId) q = q.eq('tender_id', tenderId)
    if (objectId) q = q.eq('object_id', objectId)
    if (counterpartyId) q = q.eq('counterparty_id', counterpartyId)
    if (unit) q = q.eq('unit', unit)
    if (priceMin !== '' && !isNaN(Number(priceMin))) q = q.gte('price', Number(priceMin))
    if (priceMax !== '' && !isNaN(Number(priceMax))) q = q.lte('price', Number(priceMax))
    if (dateFrom) q = q.gte('proposal_date', dateFrom)
    if (dateTo) q = q.lte('proposal_date', dateTo)
    return q
  }, [debouncedSearch, tenderId, objectId, counterpartyId, unit, priceMin, priceMax, dateFrom, dateTo])

  // Справочники — один раз.
  useEffect(() => {
    let cancelled = false
    const loadRefs = async () => {
      try {
        const [objRes, cpRes, tndRes, unitRes] = await Promise.all([
          supabase.from('objects').select('id, name').order('name'),
          supabase.from('counterparties').select('id, name').order('name'),
          supabase.from('tenders').select('id, work_description, object_id').order('work_description'),
          supabase.from('kp_rates_registry_units').select('unit'),
        ])
        if (cancelled) return
        setObjects(objRes.data || [])
        setCounterparties(cpRes.data || [])
        setTenders(tndRes.data || [])
        setUnits((unitRes.data || []).map(u => u.unit).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')))
      } catch (err) {
        console.error('Ошибка загрузки справочников реестра:', err.message)
      }
    }
    loadRefs()
    return () => { cancelled = true }
  }, [])

  // Любое изменение фильтров/сортировки/вкладки/размера страницы → на первую страницу.
  useEffect(() => {
    setPage(0)
  }, [debouncedSearch, tenderId, objectId, counterpartyId, unit, priceMin, priceMax, dateFrom, dateTo, sortBy, sortDir, kindTab, pageSize])

  // Загрузка текущей страницы (серверная пагинация + фильтры + сортировка).
  useEffect(() => {
    if (topTab !== 'kp') return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const from = page * pageSize
        const to = from + pageSize - 1
        let q = supabase
          .from('kp_rates_registry')
          .select(SELECT_COLS, { count: 'exact' })
          .eq('item_type', kindTab === 'materials' ? 'material' : 'work')
        q = applyFilters(q)
        q = q
          .order(SORT_COLUMN[sortBy] || 'item_name', { ascending: sortDir === 'asc', nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to)
        const { data, count, error: qErr } = await q
        if (qErr) throw qErr
        if (cancelled) return
        setRows(data || [])
        setTotalCount(count || 0)
      } catch (err) {
        if (cancelled) return
        console.error('Ошибка загрузки реестра:', err.message)
        setError(err.message || 'Не удалось загрузить реестр')
        setRows([])
        setTotalCount(0)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [topTab, kindTab, page, pageSize, sortBy, sortDir, applyFilters])

  // Счётчики обеих подвкладок с учётом фильтров (две лёгкие head-выборки count).
  useEffect(() => {
    if (topTab !== 'kp') return
    let cancelled = false
    const run = async () => {
      try {
        const mk = (type) => applyFilters(
          supabase.from('kp_rates_registry').select('id', { count: 'exact', head: true }).eq('item_type', type)
        )
        const [m, w] = await Promise.all([mk('material'), mk('work')])
        if (cancelled) return
        setCounts({ materials: m.count || 0, works: w.count || 0 })
      } catch {
        /* счётчики не критичны — игнорируем */
      }
    }
    run()
    return () => { cancelled = true }
  }, [topTab, applyFilters])

  const resetFilters = () => {
    setSearch('')
    setTenderId('')
    setObjectId('')
    setCounterpartyId('')
    setUnit('')
    setPriceMin('')
    setPriceMax('')
    setDateFrom('')
    setDateTo('')
    setSortBy('name')
    setSortDir('asc')
  }
  const hasActiveFilters = Boolean(
    search || tenderId || objectId || counterpartyId || unit ||
    priceMin || priceMax || dateFrom || dateTo
  )

  // Тендеры в выпадающем списке — с учётом выбранного объекта.
  const tendersForSelect = objectId
    ? tenders.filter(t => String(t.object_id) === String(objectId))
    : tenders

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(col); setSortDir('asc') }
  }
  const sortIndicator = (col) => (sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const fromRow = totalCount === 0 ? 0 : page * pageSize + 1
  const toRow = Math.min(totalCount, (page + 1) * pageSize)

  return (
    <div className="rates-registry">
      <div className="rr-header">
        <h2 className="rr-title">Реестр расценок</h2>
        <div className="rr-counter" title="Найдено строк в выбранной вкладке (с учётом фильтров)">
          {totalCount}
        </div>
      </div>

      {/* Верхние табы — источники расценок */}
      <div className="rr-top-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={topTab === 'kp'}
          className={`rr-top-tab ${topTab === 'kp' ? 'active' : ''}`}
          onClick={() => setTopTab('kp')}>
          Расценки от подрядчиков (КП)
        </button>
        <button type="button" role="tab" aria-selected={topTab === 'dp_ds'}
          className={`rr-top-tab ${topTab === 'dp_ds' ? 'active' : ''}`}
          onClick={() => setTopTab('dp_ds')}>
          Расценки от подрядчиков (ДП и ДС)
        </button>
        <button type="button" role="tab" aria-selected={topTab === 'supply'}
          className={`rr-top-tab ${topTab === 'supply' ? 'active' : ''}`}
          onClick={() => setTopTab('supply')}>
          Расценки от снабжения СУ-10
        </button>
      </div>

      {topTab !== 'kp' ? (
        <div className="rr-stub">
          <div className="rr-stub-icon" aria-hidden>🚧</div>
          <div className="rr-stub-title">В разработке</div>
          <div className="rr-stub-hint">
            {topTab === 'dp_ds'
              ? 'Раздел «Расценки от подрядчиков (ДП и ДС)» — в разработке.'
              : 'Раздел «Расценки от снабжения СУ-10» — в разработке.'}
          </div>
        </div>
      ) : (
        <>
          {/* Фильтры — все применяются на стороне БД */}
          <div className="rr-filters">
            <div className={`rr-filter-group rr-filter-group-search ${search ? 'is-active' : ''}`}>
              <label className="rr-filter-label">Поиск по наименованию</label>
              <input
                type="search"
                className={`rr-filter-search ${search ? 'is-active' : ''}`}
                placeholder="🔍 Например: грунтовка"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={`rr-filter-group ${objectId ? 'is-active' : ''}`}>
              <label className="rr-filter-label">Объект</label>
              <select className={`rr-filter-select ${objectId ? 'is-active' : ''}`}
                value={objectId} onChange={(e) => { setObjectId(e.target.value); setTenderId('') }}>
                <option value="">Все объекты ({objects.length})</option>
                {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div className={`rr-filter-group ${tenderId ? 'is-active' : ''}`}>
              <label className="rr-filter-label">Тендер</label>
              <select className={`rr-filter-select ${tenderId ? 'is-active' : ''}`}
                value={tenderId} onChange={(e) => setTenderId(e.target.value)}>
                <option value="">Все тендеры ({tendersForSelect.length})</option>
                {tendersForSelect.map(t => (
                  <option key={t.id} value={t.id}>{t.work_description || t.id}</option>
                ))}
              </select>
            </div>
            <div className={`rr-filter-group ${counterpartyId ? 'is-active' : ''}`}>
              <label className="rr-filter-label">Подрядчик</label>
              <select className={`rr-filter-select ${counterpartyId ? 'is-active' : ''}`}
                value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)}>
                <option value="">Все подрядчики ({counterparties.length})</option>
                {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className={`rr-filter-group ${unit ? 'is-active' : ''}`}>
              <label className="rr-filter-label">Ед. изм.</label>
              <select className={`rr-filter-select ${unit ? 'is-active' : ''}`}
                value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="">Все ({units.length})</option>
                {units.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
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
              <label className="rr-filter-label">Дата расценки</label>
              <div className="rr-filter-range">
                <input type="date" className="rr-filter-date"
                  value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                <span className="rr-filter-range-dash">—</span>
                <input type="date" className="rr-filter-date"
                  value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
            </div>
            {hasActiveFilters && (
              <button type="button" className="rr-filter-reset" onClick={resetFilters}
                title="Сбросить все фильтры">✕ Сбросить</button>
            )}
          </div>

          {/* Sub-tabs — материалы / работы (грузится только активная) */}
          <div className="rr-sub-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={kindTab === 'materials'}
              className={`rr-sub-tab ${kindTab === 'materials' ? 'active' : ''}`}
              onClick={() => setKindTab('materials')}>
              Материалы<span className="rr-sub-count">{counts.materials}</span>
            </button>
            <button type="button" role="tab" aria-selected={kindTab === 'works'}
              className={`rr-sub-tab ${kindTab === 'works' ? 'active' : ''}`}
              onClick={() => setKindTab('works')}>
              Работы<span className="rr-sub-count">{counts.works}</span>
            </button>
          </div>

          {error ? (
            <div className="rr-empty rr-error">
              Ошибка загрузки: {error}
              <div className="rr-error-hint">
                Если реестр ещё не оптимизирован — примените миграцию
                <code> 20260610_optimize_rates_registry.sql</code> (создаёт представление kp_rates_registry).
              </div>
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="rr-empty">Загрузка…</div>
          ) : totalCount === 0 ? (
            <div className="rr-empty">
              {hasActiveFilters
                ? 'По заданным фильтрам ничего не найдено.'
                : 'Расценок ещё нет. Загрузите КП в тендерах — данные подтянутся сюда автоматически.'}
            </div>
          ) : (
            <>
              <div className={`rr-table-wrap${loading ? ' is-loading' : ''}`}>
                <table className="rr-table">
                  <thead>
                    <tr>
                      <th className="rr-th-num">№ п/п</th>
                      <th className="rr-th-object">Объект</th>
                      <th className="rr-th-counterparty rr-th-sortable" onClick={() => toggleSort('counterparty')}>
                        Контрагент{sortIndicator('counterparty')}
                      </th>
                      <th className="rr-th-name rr-th-sortable" onClick={() => toggleSort('name')}>
                        {kindTab === 'materials' ? 'Наименование материалов' : 'Наименование работ'}{sortIndicator('name')}
                      </th>
                      <th className="rr-th-tender rr-th-sortable" onClick={() => toggleSort('tender')}>
                        Описание работ (тендер){sortIndicator('tender')}
                      </th>
                      <th className="rr-th-unit">Ед. изм.</th>
                      <th className="rr-th-price rr-th-sortable" onClick={() => toggleSort('price')}>
                        {kindTab === 'materials' ? 'Цена за материал, ₽' : 'Цена за работу, ₽'}{sortIndicator('price')}
                      </th>
                      <th className="rr-th-date rr-th-sortable" onClick={() => toggleSort('date')}>
                        Дата расценки{sortIndicator('date')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, idx) => (
                      <tr key={r.id}>
                        <td className="rr-td-num">{page * pageSize + idx + 1}</td>
                        <td className="rr-td-object">
                          <span className="rr-chip rr-chip-object" title={r.object_name || '—'}>{r.object_name || '—'}</span>
                        </td>
                        <td className="rr-td-counterparty">
                          <span className="rr-chip rr-chip-cp" title={r.counterparty_name || '—'}>{r.counterparty_name || '—'}</span>
                        </td>
                        <td className="rr-td-name" title={r.item_name}>{r.item_name}</td>
                        <td className="rr-td-tender" title={r.tender_desc}>
                          {r.tender_id && r.tender_desc
                            ? (
                              <Link to={`/tenders/${r.tender_id}`} className="rr-tender-link">
                                <span className="rr-tender-icon" aria-hidden>🔗</span>
                                <span className="rr-tender-text">{r.tender_desc}</span>
                              </Link>
                            )
                            : <span className="rr-tender-empty">—</span>}
                        </td>
                        <td className="rr-td-unit">{r.unit || '—'}</td>
                        <td className="rr-td-price">{fmtMoney(r.price)}</td>
                        <td className="rr-td-date">{fmtDate(r.proposal_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Пагинация */}
              <div className="rr-pagination">
                <div className="rr-pagination-info">
                  {fromRow}–{toRow} из {totalCount}
                </div>
                <div className="rr-pagination-controls">
                  <label className="rr-page-size">
                    На странице:
                    <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                      {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <button className="rr-page-btn" disabled={page <= 0 || loading}
                    onClick={() => setPage(0)} title="Первая">«</button>
                  <button className="rr-page-btn" disabled={page <= 0 || loading}
                    onClick={() => setPage(p => Math.max(0, p - 1))} title="Назад">‹</button>
                  <span className="rr-page-cur">Стр. {page + 1} из {totalPages}</span>
                  <button className="rr-page-btn" disabled={page >= totalPages - 1 || loading}
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} title="Вперёд">›</button>
                  <button className="rr-page-btn" disabled={page >= totalPages - 1 || loading}
                    onClick={() => setPage(totalPages - 1)} title="Последняя">»</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

export default RatesRegistryPage
