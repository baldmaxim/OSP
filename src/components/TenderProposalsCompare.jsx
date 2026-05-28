import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../supabase'
import TenderProposalUploadModal from './TenderProposalUploadModal'
import './TenderProposalsCompare.css'

// task 346 + 349: вкладка «Сравнение КП» в тендере.
// Структура:
//   1) Tree-tabs: «Объединённый КП» + дочерние по ВОРам (как во вкладке ВОР).
//   2) Расширенные summary-карточки: Материалы / Работы / Итого по каждому КП.
//   3) Sub-tabs: «Исходный КП» / «Материалы» / «Работы».

const fmtMoney = (n) => {
  if (n == null || n === '' || isNaN(n)) return ''
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU')
}

// «Р»/«р-…» → работа, иначе материал.
const isWorkRow = (it) => {
  const c = String(it.code || '').trim().toLowerCase()
  return c === 'р' || c.startsWith('р-') || c.startsWith('р ') || c.startsWith('раб')
}

const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/[\s.]+/g, ' ').replace(/\s+/g, ' ').trim()

function TenderProposalsCompare({
  tenderId,
  estimateItems,
  docNames,
  tenderCounterparties,
  canEdit,
  onCountChange,
}) {
  const [proposals, setProposals] = useState([])
  const [loading, setLoading] = useState(false)
  // selectedDoc = 'all' для объединённого вида, либо конкретное имя ВОРа.
  const [selectedDoc, setSelectedDoc] = useState('all')
  const [subTab, setSubTab] = useState('source') // 'source' | 'materials' | 'works'
  const [showUploadModal, setShowUploadModal] = useState(false)

  // Если активный ВОР пропал — переключаемся на 'all'.
  useEffect(() => {
    if (selectedDoc === 'all') return
    if (!docNames.includes(selectedDoc)) setSelectedDoc('all')
  }, [docNames, selectedDoc])

  const loadProposals = useCallback(async () => {
    if (!tenderId) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('tender_counterparty_proposals')
        .select('*, counterparties(id, name)')
        .eq('tender_id', tenderId)
      if (error) throw error
      setProposals(data || [])
    } catch (err) {
      console.error('Ошибка загрузки КП:', err.message)
      setProposals([])
    } finally {
      setLoading(false)
    }
  }, [tenderId])

  useEffect(() => { loadProposals() }, [loadProposals])

  // Уникальные контрагенты с КП — общее число для счётчика на табе.
  const proposalsCount = useMemo(() => {
    const set = new Set(proposals.map(p => p.counterparty_id))
    return set.size
  }, [proposals])
  useEffect(() => { onCountChange?.(proposalsCount) }, [proposalsCount, onCountChange])

  // Позиции выбранного scope (без секций). 'all' = все ВОРы.
  const itemsOfScope = useMemo(() => estimateItems.filter(it => {
    if (it.is_section) return false
    if (selectedDoc === 'all') return true
    return (it.estimate_name || 'Основная смета') === selectedDoc
  }), [estimateItems, selectedDoc])

  const itemIds = useMemo(() => new Set(itemsOfScope.map(it => it.id)), [itemsOfScope])

  // Контрагенты в текущем scope.
  const counterpartiesInScope = useMemo(() => {
    const map = new Map() // cp_id → { id, name, latestDate }
    for (const p of proposals) {
      if (!itemIds.has(p.estimate_item_id)) continue
      const cur = map.get(p.counterparty_id)
      const date = p.proposal_date || null
      if (!cur) {
        map.set(p.counterparty_id, {
          id: p.counterparty_id,
          name: p.counterparties?.name || p.counterparty_id,
          latestDate: date,
        })
      } else if (date && (!cur.latestDate || date > cur.latestDate)) {
        cur.latestDate = date
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [proposals, itemIds])

  // Lookup: estimate_item_id × counterparty_id → proposal.
  const proposalLookup = useMemo(() => {
    const m = new Map()
    for (const p of proposals) {
      if (!itemIds.has(p.estimate_item_id)) continue
      m.set(`${p.estimate_item_id}__${p.counterparty_id}`, p)
    }
    return m
  }, [proposals, itemIds])

  // Итоги по контрагенту + разбивка по ВОРам (task 351).
  // В режиме selectedDoc === 'all' карточка показывает: «Материалы 59 ₽» с
  // вложенным списком «АК 49 ₽, АСУД 9.5 ₽, …». Так же для работ.
  const totalsByCp = useMemo(() => {
    const m = new Map() // cp_id → { totalMat, totalWork, totalCost, byDoc: Map<docName, {mat, work}> }
    for (const cp of counterpartiesInScope) {
      let mat = 0, wrk = 0, all = 0
      const byDoc = new Map()
      for (const it of itemsOfScope) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        if (!p) continue
        const m_ = Number(p.total_materials) || 0
        const w_ = Number(p.total_works) || 0
        const c_ = Number(p.total_cost) || 0
        mat += m_
        wrk += w_
        all += c_
        const docName = it.estimate_name || 'Основная смета'
        const cur = byDoc.get(docName) || { mat: 0, work: 0 }
        cur.mat += m_
        cur.work += w_
        byDoc.set(docName, cur)
      }
      m.set(cp.id, { totalMat: mat, totalWork: wrk, totalCost: all, byDoc })
    }
    return m
  }, [counterpartiesInScope, itemsOfScope, proposalLookup])

  // Минимум по сравниваемой метрике (для подсветки).
  const minTotalCost = useMemo(() => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const t = totalsByCp.get(cp.id)?.totalCost || 0
      if (t > 0 && t < min) min = t
    }
    return min === Infinity ? 0 : min
  }, [counterpartiesInScope, totalsByCp])

  // Минимум по строке (для подсветки в исходном виде).
  const minByItem = useMemo(() => {
    const m = new Map()
    for (const it of itemsOfScope) {
      let min = Infinity
      for (const cp of counterpartiesInScope) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        const v = p ? Number(p.total_cost) || 0 : 0
        if (v > 0 && v < min) min = v
      }
      if (min !== Infinity) m.set(it.id, min)
    }
    return m
  }, [itemsOfScope, counterpartiesInScope, proposalLookup])

  // Агрегация для «Материалы» / «Работы» — по name+unit внутри каждого ВОРа.
  // В режиме «Объединённый КП» группируем по estimate_name + считаем подытоги.
  // В режиме конкретного ВОРа — одна группа без явного заголовка.
  // task 350: на «Объединённом» хочется видеть Σ по каждому ВОРу + общий ИТОГО.
  const aggregatedGroups = useMemo(() => {
    if (subTab === 'source') return []
    const wantWork = subTab === 'works'
    // groupKey (estimate_name) → { name, rowsMap: Map<key, row>, subtotalByCp: Map<cpId, number> }
    const groups = new Map()
    for (const it of itemsOfScope) {
      const isWork = isWorkRow(it)
      if (wantWork && !isWork) continue
      if (!wantWork && isWork) continue
      const vol = isWork
        ? Number(it.work_volume) || 0
        : Number(it.material_consumption) || 0
      const hasAnyProposal = counterpartiesInScope.some(cp => proposalLookup.get(`${it.id}__${cp.id}`))
      if (vol <= 0 && !hasAnyProposal) continue

      const groupName = it.estimate_name || 'Основная смета'
      let group = groups.get(groupName)
      if (!group) {
        group = { name: groupName, rowsMap: new Map(), subtotalByCp: new Map() }
        groups.set(groupName, group)
      }

      const name = (it.cost_name || '').trim()
      const unit = (it.unit || '').trim()
      const rowKey = `${normalizeKey(name)}|${normalizeKey(unit)}`
      let row = group.rowsMap.get(rowKey)
      if (!row) {
        row = { name, unit, totalVol: 0, cpData: new Map() }
        group.rowsMap.set(rowKey, row)
      }
      row.totalVol += vol

      for (const cp of counterpartiesInScope) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        if (!p) continue
        const cur = row.cpData.get(cp.id) || { totalCost: 0, weightedPriceSum: 0, weightedVolSum: 0 }
        const cost = isWork ? (Number(p.total_works) || 0) : (Number(p.total_materials) || 0)
        const price = isWork ? (Number(p.unit_price_works) || 0) : (Number(p.unit_price_materials) || 0)
        cur.totalCost += cost
        cur.weightedPriceSum += price * vol
        cur.weightedVolSum += vol
        row.cpData.set(cp.id, cur)

        // Подытог по ВОРу
        const prev = group.subtotalByCp.get(cp.id) || 0
        group.subtotalByCp.set(cp.id, prev + cost)
      }
    }

    // Сортируем группы по имени ВОРа, строки внутри — по наименованию.
    const out = []
    const sortedGroupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))
    for (const gName of sortedGroupNames) {
      const g = groups.get(gName)
      const rows = [...g.rowsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      out.push({ name: g.name, rows, subtotalByCp: g.subtotalByCp })
    }
    return out
  }, [itemsOfScope, counterpartiesInScope, proposalLookup, subTab])

  // Удалить все КП контрагента в scope.
  const handleClearCpProposals = async (cpId, cpName) => {
    const where = selectedDoc === 'all' ? 'для всего тендера' : `для ВОРа «${selectedDoc}»`
    if (!window.confirm(`Удалить КП контрагента «${cpName}» ${where}?`)) return
    try {
      const ids = itemsOfScope.map(it => it.id)
      if (ids.length === 0) return
      const { error } = await supabase
        .from('tender_counterparty_proposals')
        .delete()
        .eq('counterparty_id', cpId)
        .in('estimate_item_id', ids)
      if (error) throw error

      const { data: remaining } = await supabase
        .from('tender_counterparty_proposals')
        .select('id')
        .eq('tender_id', tenderId)
        .eq('counterparty_id', cpId)
        .limit(1)
      if (!remaining || remaining.length === 0) {
        await supabase
          .from('tender_counterparties')
          .update({ status: 'request_sent' })
          .eq('tender_id', tenderId)
          .eq('counterparty_id', cpId)
      }
      await loadProposals()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  // Счётчики для tabs (контрагенты с КП в этом ВОРе).
  const cpCountByDoc = useMemo(() => {
    const out = new Map()
    for (const name of docNames) {
      const set = new Set()
      for (const p of proposals) {
        const item = estimateItems.find(i => i.id === p.estimate_item_id)
        if (!item) continue
        if ((item.estimate_name || 'Основная смета') !== name) continue
        set.add(p.counterparty_id)
      }
      out.set(name, set.size)
    }
    return out
  }, [docNames, estimateItems, proposals])

  if (docNames.length === 0) {
    return (
      <div className="proposals-empty">
        <p>В тендере нет ни одного ВОРа.</p>
        <p className="hint">Сначала загрузите ВОР во вкладке «ВОР», затем сравнивайте КП.</p>
      </div>
    )
  }

  return (
    <div className="proposals-section">
      {/* Toolbar */}
      <div className="proposals-toolbar">
        <h3 className="proposals-title">Сравнение КП</h3>
        {canEdit && (
          <button className="btn-primary" onClick={() => setShowUploadModal(true)}>
            + Загрузить КП
          </button>
        )}
      </div>

      {/* Tree-tabs: Объединённый + дочерние ВОРы (как во вкладке ВОР) */}
      <div className="proposals-doc-tree">
        <button
          type="button"
          className={`proposals-doc-tab proposals-doc-tab-parent ${selectedDoc === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedDoc('all')}
        >
          <span className="proposals-doc-tab-parent-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h18" /><path d="M3 12h18" /><path d="M3 17h18" />
            </svg>
          </span>
          <span className="proposals-doc-tab-label">Объединённый КП</span>
          <span className="proposals-doc-tab-count">{proposalsCount}</span>
          <span className="proposals-doc-tab-parent-hint">
            по {docNames.length}{' '}
            {docNames.length === 1 ? 'ВОРу' : docNames.length < 5 ? 'ВОРам' : 'ВОРам'}
          </span>
        </button>
        <div className="proposals-doc-tabs-children">
          {docNames.map((name, i) => {
            const isLast = i === docNames.length - 1
            return (
              <button
                key={name}
                type="button"
                className={`proposals-doc-tab proposals-doc-tab-child ${selectedDoc === name ? 'active' : ''} ${isLast ? 'is-last' : ''}`}
                onClick={() => setSelectedDoc(name)}
              >
                <span className="proposals-doc-tab-branch" aria-hidden />
                <span className="proposals-doc-tab-label">{name}</span>
                <span className="proposals-doc-tab-count">{cpCountByDoc.get(name) || 0}</span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="proposals-empty"><p>Загрузка…</p></div>
      ) : itemsOfScope.length === 0 ? (
        <div className="proposals-empty"><p>В выбранном ВОРе нет позиций.</p></div>
      ) : counterpartiesInScope.length === 0 ? (
        <div className="proposals-empty">
          <p>Для выбранного {selectedDoc === 'all' ? 'тендера' : 'ВОРа'} ещё не загружено ни одного КП.</p>
          {canEdit && (
            <p className="hint">Нажмите «+ Загрузить КП», чтобы добавить первое предложение.</p>
          )}
        </div>
      ) : (
        <>
          {/* Summary с разбивкой Материалы / Работы / Итого.
              task 351: в режиме «Объединённый» внутри каждой суммы
              показываем построчно разбивку по ВОРам. */}
          <div className="proposals-summary">
            {counterpartiesInScope.map(cp => {
              const t = totalsByCp.get(cp.id) || { totalMat: 0, totalWork: 0, totalCost: 0, byDoc: new Map() }
              const isMin = t.totalCost > 0 && t.totalCost === minTotalCost
              const showBreakdown = selectedDoc === 'all' && t.byDoc.size > 1
              // Сортируем ВОРы по убыванию материалов (показываем самые «дорогие» сверху).
              const sortedDocs = showBreakdown
                ? [...t.byDoc.entries()].sort((a, b) =>
                    (b[1].mat + b[1].work) - (a[1].mat + a[1].work)
                  )
                : []
              return (
                <div key={cp.id} className={`proposals-summary-card${isMin ? ' is-min' : ''}`}>
                  <div className="proposals-summary-head">
                    <div className="proposals-summary-name" title={cp.name}>{cp.name}</div>
                    {cp.latestDate && (
                      <div className="proposals-summary-date">КП от {fmtDate(cp.latestDate)}</div>
                    )}
                  </div>
                  <div className="proposals-summary-rows">
                    {/* Материалы */}
                    <div className="proposals-summary-row proposals-summary-row-section">
                      <span className="proposals-summary-row-label">Материалы</span>
                      <span className="proposals-summary-row-val">{fmtMoney(t.totalMat)} ₽</span>
                    </div>
                    {showBreakdown && sortedDocs.filter(([, v]) => v.mat > 0).map(([docName, v]) => (
                      <div key={`mat:${docName}`} className="proposals-summary-row proposals-summary-row-sub">
                        <span className="proposals-summary-row-label proposals-summary-row-sub-label">
                          <span className="proposals-summary-row-sub-bullet" aria-hidden>↳</span>
                          {docName}
                        </span>
                        <span className="proposals-summary-row-val proposals-summary-row-sub-val">{fmtMoney(v.mat)} ₽</span>
                      </div>
                    ))}

                    {/* Работы */}
                    <div className="proposals-summary-row proposals-summary-row-section">
                      <span className="proposals-summary-row-label">Работы</span>
                      <span className="proposals-summary-row-val">{fmtMoney(t.totalWork)} ₽</span>
                    </div>
                    {showBreakdown && sortedDocs.filter(([, v]) => v.work > 0).map(([docName, v]) => (
                      <div key={`work:${docName}`} className="proposals-summary-row proposals-summary-row-sub">
                        <span className="proposals-summary-row-label proposals-summary-row-sub-label">
                          <span className="proposals-summary-row-sub-bullet" aria-hidden>↳</span>
                          {docName}
                        </span>
                        <span className="proposals-summary-row-val proposals-summary-row-sub-val">{fmtMoney(v.work)} ₽</span>
                      </div>
                    ))}

                    {/* Итого */}
                    <div className="proposals-summary-row proposals-summary-row-total">
                      <span className="proposals-summary-row-label">Итого</span>
                      <span className="proposals-summary-row-val">{fmtMoney(t.totalCost)} ₽</span>
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      className="proposals-summary-remove"
                      onClick={() => handleClearCpProposals(cp.id, cp.name)}
                      title="Удалить КП этого контрагента в текущем scope"
                      aria-label="Удалить"
                    >×</button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Sub-tabs */}
          <div className="proposals-subtabs">
            <button
              className={`proposals-subtab ${subTab === 'source' ? 'active' : ''}`}
              onClick={() => setSubTab('source')}
            >Исходный КП</button>
            <button
              className={`proposals-subtab ${subTab === 'materials' ? 'active' : ''}`}
              onClick={() => setSubTab('materials')}
            >Материалы</button>
            <button
              className={`proposals-subtab ${subTab === 'works' ? 'active' : ''}`}
              onClick={() => setSubTab('works')}
            >Работы</button>
          </div>

          {subTab === 'source' && (
            <SourceTable
              itemsOfScope={itemsOfScope}
              counterpartiesInScope={counterpartiesInScope}
              proposalLookup={proposalLookup}
              minByItem={minByItem}
              totalsByCp={totalsByCp}
              minTotalCost={minTotalCost}
              showDocColumn={selectedDoc === 'all'}
            />
          )}
          {(subTab === 'materials' || subTab === 'works') && (
            <AggregateView
              kind={subTab}
              groups={aggregatedGroups}
              counterpartiesInScope={counterpartiesInScope}
              totalsByCp={totalsByCp}
              showGroupHeaders={selectedDoc === 'all'}
            />
          )}
        </>
      )}

      {showUploadModal && (
        <TenderProposalUploadModal
          tenderId={tenderId}
          tenderCounterparties={tenderCounterparties}
          estimateItems={estimateItems}
          docNames={docNames}
          onClose={() => setShowUploadModal(false)}
          onSaved={() => { setShowUploadModal(false); loadProposals() }}
        />
      )}
    </div>
  )
}

// ===== Подкомпонент: «Исходный КП» =====
function SourceTable({
  itemsOfScope, counterpartiesInScope, proposalLookup,
  minByItem, totalsByCp, minTotalCost, showDocColumn,
}) {
  return (
    <div className="proposals-table-wrap">
      <table className="proposals-table">
        <thead>
          <tr>
            <th rowSpan={2} className="th-num">№</th>
            {showDocColumn && <th rowSpan={2} className="th-doc">ВОР</th>}
            <th rowSpan={2} className="th-code">КОД</th>
            <th rowSpan={2} className="th-name">Наименование</th>
            <th rowSpan={2} className="th-unit">Ед.</th>
            <th rowSpan={2} className="th-vol">Объём раб.</th>
            <th rowSpan={2} className="th-vol">Объём мат.</th>
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={5} className="th-cp">
                <div className="th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
              </th>
            ))}
          </tr>
          <tr>
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="th-sub" title="Цена материала за ед.">Ц.мат, ₽/ед</th>
                <th className="th-sub" title="Стоимость материалов = Ц.мат × Объём мат.">Стоим.мат, ₽</th>
                <th className="th-sub" title="Цена работ за ед.">Ц.раб, ₽/ед</th>
                <th className="th-sub" title="Стоимость работ = Ц.раб × Объём раб.">Стоим.раб, ₽</th>
                <th className="th-sub th-sub-total" title="Итого по позиции">Итого, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {itemsOfScope.map((it, idx) => {
            const minPrice = minByItem.get(it.id)
            return (
              <tr key={it.id}>
                <td className="td-num">{idx + 1}</td>
                {showDocColumn && <td className="td-doc">{it.estimate_name || '—'}</td>}
                <td className="td-code">{it.code || '—'}</td>
                <td className="td-name" title={it.cost_name}>{it.cost_name}</td>
                <td className="td-unit">{it.unit || '—'}</td>
                <td className="td-vol">{fmtMoney(it.work_volume)}</td>
                <td className="td-vol">{fmtMoney(it.material_consumption)}</td>
                {counterpartiesInScope.map(cp => {
                  const p = proposalLookup.get(`${it.id}__${cp.id}`)
                  const total = p ? Number(p.total_cost) || 0 : 0
                  const isMin = total > 0 && minPrice != null && total === minPrice
                  return (
                    <React.Fragment key={cp.id}>
                      <td className="td-price td-cp-first">{p ? fmtMoney(p.unit_price_materials) : '—'}</td>
                      <td className="td-price td-sum">{p ? fmtMoney(p.total_materials) : '—'}</td>
                      <td className="td-price">{p ? fmtMoney(p.unit_price_works) : '—'}</td>
                      <td className="td-price td-sum">{p ? fmtMoney(p.total_works) : '—'}</td>
                      <td className={`td-price td-total${isMin ? ' is-min' : ''}`}>{p ? fmtMoney(total) : '—'}</td>
                    </React.Fragment>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="proposals-total-row">
            <td colSpan={showDocColumn ? 7 : 6} style={{ textAlign: 'right' }}>ИТОГО, ₽:</td>
            {counterpartiesInScope.map(cp => {
              const total = totalsByCp.get(cp.id)?.totalCost || 0
              const isMin = total > 0 && total === minTotalCost
              return (
                <td key={cp.id} colSpan={5} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
                  {fmtMoney(total)}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ===== Подкомпонент: «Материалы» / «Работы» (агрегированный) =====
// task 350: в режиме «Объединённый» рендерим по группам ВОРов с подытогами,
// потом общий ИТОГО. В режиме одного ВОРа — плоский список (одна группа,
// заголовок группы скрывается).
function AggregateView({ kind, groups, counterpartiesInScope, totalsByCp, showGroupHeaders }) {
  const isMaterials = kind === 'materials'
  const totalKey = isMaterials ? 'totalMat' : 'totalWork'

  // Минимум по строке (среди контрагентов с непустыми ценами) — для подсветки.
  const computeMinByRow = (row) => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const v = row.cpData.get(cp.id)?.totalCost || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? null : min
  }
  // Минимум по подытогу группы — подсветка лучшего контрагента ПО ЭТОМУ ВОРу.
  const computeMinSubtotal = (group) => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const v = group.subtotalByCp.get(cp.id) || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? null : min
  }

  if (groups.length === 0) {
    return (
      <div className="proposals-empty">
        <p>{isMaterials ? 'Материалов нет в выбранном scope.' : 'Работ нет в выбранном scope.'}</p>
      </div>
    )
  }

  // Минимальный итог по контрагенту (общий ИТОГО снизу).
  const allTotals = counterpartiesInScope.map(c => totalsByCp.get(c.id)?.[totalKey] || 0)
  const minTotal = allTotals.length > 0
    ? Math.min(...allTotals.filter(v => v > 0).concat(Infinity))
    : Infinity

  return (
    <div className="proposals-table-wrap">
      <table className="proposals-table proposals-table-aggregate">
        <thead>
          <tr>
            <th rowSpan={2} className="th-num">№</th>
            <th rowSpan={2} className="th-name">Наименование</th>
            <th rowSpan={2} className="th-unit">Ед.</th>
            <th rowSpan={2} className="th-vol">Σ Объём</th>
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={2} className="th-cp">
                <div className="th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
              </th>
            ))}
          </tr>
          <tr>
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="th-sub" title="Средняя цена за ед. (взвешенная по объёму)">Цена/ед, ₽</th>
                <th className="th-sub th-sub-total" title="Сумма стоимостей по всем позициям">Стоимость, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group, gi) => {
            const minSub = computeMinSubtotal(group)
            return (
              <React.Fragment key={`g:${group.name}|${gi}`}>
                {showGroupHeaders && (
                  <tr className="proposals-group-header">
                    <td colSpan={4 + counterpartiesInScope.length * 2}>
                      <span className="proposals-group-header-label">ВОР</span>
                      <span className="proposals-group-header-name">{group.name}</span>
                      <span className="proposals-group-header-count">
                        {group.rows.length} {isMaterials ? 'позиций материалов' : 'позиций работ'}
                      </span>
                    </td>
                  </tr>
                )}
                {group.rows.map((r, ri) => {
                  const minCost = computeMinByRow(r)
                  return (
                    <tr key={`${group.name}|${r.name}|${r.unit}|${ri}`}>
                      <td className="td-num">{ri + 1}</td>
                      <td className="td-name" title={r.name}>{r.name}</td>
                      <td className="td-unit">{r.unit || '—'}</td>
                      <td className="td-vol">{fmtMoney(r.totalVol)}</td>
                      {counterpartiesInScope.map(cp => {
                        const d = r.cpData.get(cp.id)
                        const avgPrice = d && d.weightedVolSum > 0 ? d.weightedPriceSum / d.weightedVolSum : 0
                        const total = d?.totalCost || 0
                        const isMin = total > 0 && minCost != null && total === minCost
                        return (
                          <React.Fragment key={cp.id}>
                            <td className="td-price td-cp-first">{d ? fmtMoney(avgPrice) : '—'}</td>
                            <td className={`td-price td-total${isMin ? ' is-min' : ''}`}>{d ? fmtMoney(total) : '—'}</td>
                          </React.Fragment>
                        )
                      })}
                    </tr>
                  )
                })}
                {showGroupHeaders && (
                  <tr className="proposals-group-subtotal">
                    <td colSpan={4} style={{ textAlign: 'right' }}>
                      Подытог по «{group.name}», ₽:
                    </td>
                    {counterpartiesInScope.map(cp => {
                      const v = group.subtotalByCp.get(cp.id) || 0
                      const isMin = v > 0 && minSub != null && v === minSub
                      return (
                        <td key={cp.id} colSpan={2} className={`td-group-subtotal${isMin ? ' is-min' : ''}`}>
                          {v > 0 ? fmtMoney(v) : '—'}
                        </td>
                      )
                    })}
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="proposals-total-row">
            <td colSpan={4} style={{ textAlign: 'right' }}>
              ОБЩИЙ ИТОГО по {isMaterials ? 'материалам' : 'работам'}, ₽:
            </td>
            {counterpartiesInScope.map(cp => {
              const total = totalsByCp.get(cp.id)?.[totalKey] || 0
              const isMin = total > 0 && total === minTotal
              return (
                <td key={cp.id} colSpan={2} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
                  {fmtMoney(total)}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
      <small className="proposals-aggregate-hint">
        {showGroupHeaders
          ? 'Строки сгруппированы по ВОРам. Внутри группы одинаковые наименования суммируются. Подытог — сумма по группе для каждого контрагента, ИТОГО снизу — по всем группам.'
          : 'В таблице суммированы одинаковые наименования из всех позиций ВОРа. Цена за единицу — средневзвешенная по объёму.'}
      </small>
    </div>
  )
}

export default TenderProposalsCompare
