import { useState, useEffect, useMemo, useCallback, useDeferredValue } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import './RatesRegistryPage.css'

// task 356: Реестр расценок — общий список расценок из разных источников.
//   1) От подрядчиков (КП) — выгрузка из tender_counterparty_proposals.
//   2) От подрядчиков (ДП и ДС) — в разработке.
//   3) От снабжения СУ-10 — в разработке.
//
// task 354: добавлены фильтры по объекту/контрагенту, колонка «Описание работ»
//   с гиперссылкой на тендер, переработан стиль таблицы.

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

function RatesRegistryPage() {
  const [topTab, setTopTab] = useState('kp')          // 'kp' | 'dp_ds' | 'supply'
  const [kindTab, setKindTab] = useState('materials') // 'materials' | 'works'
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [selectedObject, setSelectedObject] = useState('')         // task 354
  const [selectedCounterparty, setSelectedCounterparty] = useState('') // task 354
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)

  const loadKpRates = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('tender_counterparty_proposals')
        .select(`
          id,
          unit_price_materials,
          unit_price_works,
          proposal_date,
          counterparties(name),
          tender_estimate_items(cost_name, unit, code, material_consumption, work_volume),
          tenders(id, work_description, objects(name))
        `)
      if (error) throw error
      setRows(data || [])
    } catch (err) {
      console.error('Ошибка загрузки расценок:', err.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (topTab === 'kp') loadKpRates()
  }, [topTab, loadKpRates])

  // Разбиваем proposals на материалы и работы.
  const { materialEntries, workEntries } = useMemo(() => {
    const materials = []
    const works = []
    for (const p of rows) {
      const item = p.tender_estimate_items
      if (!item) continue
      const objectName = p.tenders?.objects?.name || '—'
      const counterparty = p.counterparties?.name || '—'
      const tenderId = p.tenders?.id || null
      const tenderDesc = p.tenders?.work_description || ''
      const matVol = Number(item.material_consumption) || 0
      const matPrice = Number(p.unit_price_materials) || 0
      const workVol = Number(item.work_volume) || 0
      const workPrice = Number(p.unit_price_works) || 0

      const base = {
        object: objectName,
        counterparty,
        name: item.cost_name || '',
        unit: item.unit || '',
        proposalDate: p.proposal_date,
        tenderId,
        tenderDesc,
      }
      if (matVol > 0 && matPrice > 0) {
        materials.push({ ...base, id: `${p.id}:mat`, price: matPrice })
      }
      if (workVol > 0 && workPrice > 0) {
        works.push({ ...base, id: `${p.id}:work`, price: workPrice })
      }
    }
    const sortFn = (a, b) => {
      const n = (a.name || '').localeCompare(b.name || '', 'ru')
      if (n !== 0) return n
      return (b.proposalDate || '').localeCompare(a.proposalDate || '')
    }
    materials.sort(sortFn)
    works.sort(sortFn)
    return { materialEntries: materials, workEntries: works }
  }, [rows])

  // task 354: уникальные списки для фильтров по текущему виду (мат./раб.).
  const { objectOptions, counterpartyOptions } = useMemo(() => {
    const all = kindTab === 'materials' ? materialEntries : workEntries
    const objs = new Set()
    const cps = new Set()
    for (const r of all) {
      if (r.object && r.object !== '—') objs.add(r.object)
      if (r.counterparty && r.counterparty !== '—') cps.add(r.counterparty)
    }
    const ru = (a, b) => a.localeCompare(b, 'ru')
    return {
      objectOptions: Array.from(objs).sort(ru),
      counterpartyOptions: Array.from(cps).sort(ru),
    }
  }, [materialEntries, workEntries, kindTab])

  // task 354: применяем все фильтры — поиск + объект + контрагент.
  const filtered = useMemo(() => {
    const all = kindTab === 'materials' ? materialEntries : workEntries
    const q = deferredSearch.trim().toLowerCase()
    return all.filter(r => {
      if (selectedObject && r.object !== selectedObject) return false
      if (selectedCounterparty && r.counterparty !== selectedCounterparty) return false
      if (!q) return true
      return (
        (r.name || '').toLowerCase().includes(q) ||
        (r.counterparty || '').toLowerCase().includes(q) ||
        (r.object || '').toLowerCase().includes(q) ||
        (r.unit || '').toLowerCase().includes(q) ||
        (r.tenderDesc || '').toLowerCase().includes(q)
      )
    })
  }, [materialEntries, workEntries, kindTab, deferredSearch, selectedObject, selectedCounterparty])

  const resetFilters = () => {
    setSearch('')
    setSelectedObject('')
    setSelectedCounterparty('')
  }
  const hasActiveFilters = Boolean(search || selectedObject || selectedCounterparty)

  return (
    <div className="rates-registry">
      <div className="rr-header">
        <h2 className="rr-title">Реестр расценок</h2>
        <div className="rr-counter" title="Уникальных строк в выбранной вкладке">
          {filtered.length}
        </div>
      </div>

      {/* Верхние табы — источники расценок */}
      <div className="rr-top-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={topTab === 'kp'}
          className={`rr-top-tab ${topTab === 'kp' ? 'active' : ''}`}
          onClick={() => setTopTab('kp')}
        >
          Расценки от подрядчиков (КП)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={topTab === 'dp_ds'}
          className={`rr-top-tab ${topTab === 'dp_ds' ? 'active' : ''}`}
          onClick={() => setTopTab('dp_ds')}
        >
          Расценки от подрядчиков (ДП и ДС)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={topTab === 'supply'}
          className={`rr-top-tab ${topTab === 'supply' ? 'active' : ''}`}
          onClick={() => setTopTab('supply')}
        >
          Расценки от снабжения СУ-10
        </button>
      </div>

      {topTab !== 'kp' ? (
        <div className="rr-stub">
          <div className="rr-stub-icon" aria-hidden>🚧</div>
          <div className="rr-stub-title">В разработке</div>
          <div className="rr-stub-hint">
            {topTab === 'dp_ds'
              ? 'Раздел «Расценки от подрядчиков (ДП и ДС)» — в разработке. Скоро здесь будут расценки, выгруженные из подписанных договоров подряда и допсоглашений.'
              : 'Раздел «Расценки от снабжения СУ-10» — в разработке. Скоро здесь будут расценки от отдела снабжения.'}
          </div>
        </div>
      ) : (
        <>
          {/* task 354: панель фильтров — объект + контрагент + поиск + сброс */}
          <div className="rr-filters">
            <div className="rr-filter-group">
              <label className="rr-filter-label">Объект</label>
              <select
                className="rr-filter-select"
                value={selectedObject}
                onChange={(e) => setSelectedObject(e.target.value)}
              >
                <option value="">Все объекты ({objectOptions.length})</option>
                {objectOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="rr-filter-group">
              <label className="rr-filter-label">Контрагент</label>
              <select
                className="rr-filter-select"
                value={selectedCounterparty}
                onChange={(e) => setSelectedCounterparty(e.target.value)}
              >
                <option value="">Все контрагенты ({counterpartyOptions.length})</option>
                {counterpartyOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="rr-filter-group rr-filter-group-search">
              <label className="rr-filter-label">Поиск</label>
              <input
                type="search"
                className="rr-filter-search"
                placeholder="🔍 По наименованию, описанию работ, ед. изм.…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                className="rr-filter-reset"
                onClick={resetFilters}
                title="Сбросить все фильтры"
              >
                ✕ Сбросить
              </button>
            )}
          </div>

          {/* Sub-tabs — материалы / работы */}
          <div className="rr-sub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={kindTab === 'materials'}
              className={`rr-sub-tab ${kindTab === 'materials' ? 'active' : ''}`}
              onClick={() => setKindTab('materials')}
            >
              Материалы
              <span className="rr-sub-count">{materialEntries.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kindTab === 'works'}
              className={`rr-sub-tab ${kindTab === 'works' ? 'active' : ''}`}
              onClick={() => setKindTab('works')}
            >
              Работы
              <span className="rr-sub-count">{workEntries.length}</span>
            </button>
          </div>

          {loading ? (
            <div className="rr-empty">Загрузка…</div>
          ) : filtered.length === 0 ? (
            <div className="rr-empty">
              {rows.length === 0
                ? 'Расценок ещё нет. Загрузите КП в тендерах — данные подтянутся сюда автоматически.'
                : 'По заданным фильтрам ничего не найдено.'}
            </div>
          ) : (
            <div className="rr-table-wrap">
              <table className="rr-table">
                <thead>
                  <tr>
                    <th className="rr-th-num">№ п/п</th>
                    <th className="rr-th-object">Объект</th>
                    <th className="rr-th-counterparty">Контрагент</th>
                    <th className="rr-th-name">
                      {kindTab === 'materials' ? 'Наименование материалов' : 'Наименование работ'}
                    </th>
                    <th className="rr-th-tender">Описание работ (тендер)</th>
                    <th className="rr-th-unit">Ед.</th>
                    <th className="rr-th-price">
                      {kindTab === 'materials' ? 'Цена за материал, ₽' : 'Цена за работу, ₽'}
                    </th>
                    <th className="rr-th-date">Дата расценки</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr key={r.id}>
                      <td className="rr-td-num">{idx + 1}</td>
                      <td className="rr-td-object">
                        <span className="rr-chip rr-chip-object" title={r.object}>{r.object}</span>
                      </td>
                      <td className="rr-td-counterparty">
                        <span className="rr-chip rr-chip-cp" title={r.counterparty}>{r.counterparty}</span>
                      </td>
                      <td className="rr-td-name" title={r.name}>{r.name}</td>
                      <td className="rr-td-tender" title={r.tenderDesc}>
                        {r.tenderId && r.tenderDesc
                          ? (
                            <Link to={`/tenders/${r.tenderId}`} className="rr-tender-link">
                              <span className="rr-tender-icon" aria-hidden>🔗</span>
                              <span className="rr-tender-text">{r.tenderDesc}</span>
                            </Link>
                          )
                          : <span className="rr-tender-empty">—</span>}
                      </td>
                      <td className="rr-td-unit">{r.unit || '—'}</td>
                      <td className="rr-td-price">{fmtMoney(r.price)}</td>
                      <td className="rr-td-date">{fmtDate(r.proposalDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default RatesRegistryPage
