import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../supabase'
import TenderProposalUploadModal from './TenderProposalUploadModal'
import './TenderProposalsCompare.css'

// task 346: вкладка «Сравнение КП» в тендере.
// Таблица «позиции выбранного ВОРа × контрагенты с их ценами».

const fmtMoney = (n) => {
  if (n == null || n === '' || isNaN(n)) return ''
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)
}

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
  const [selectedDoc, setSelectedDoc] = useState(docNames[0] || '')
  const [showUploadModal, setShowUploadModal] = useState(false)

  // Если активный ВОР пропал — переключаемся на первый.
  useEffect(() => {
    if (docNames.length === 0) return
    if (!docNames.includes(selectedDoc)) setSelectedDoc(docNames[0])
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

  useEffect(() => {
    onCountChange?.(proposalsCount)
  }, [proposalsCount, onCountChange])

  // Позиции выбранного ВОРа (без секций).
  const itemsOfDoc = useMemo(() => estimateItems.filter(
    it => (it.estimate_name || 'Основная смета') === selectedDoc && !it.is_section
  ), [estimateItems, selectedDoc])

  const itemIds = useMemo(() => new Set(itemsOfDoc.map(it => it.id)), [itemsOfDoc])

  // Контрагенты, у которых есть хоть один proposal в этом ВОРе.
  const counterpartiesInDoc = useMemo(() => {
    const map = new Map() // cp_id → { id, name }
    for (const p of proposals) {
      if (!itemIds.has(p.estimate_item_id)) continue
      if (!map.has(p.counterparty_id)) {
        map.set(p.counterparty_id, {
          id: p.counterparty_id,
          name: p.counterparties?.name || p.counterparty_id,
        })
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [proposals, itemIds])

  // Lookup: estimate_item_id × counterparty_id → proposal row.
  const proposalLookup = useMemo(() => {
    const m = new Map()
    for (const p of proposals) {
      if (!itemIds.has(p.estimate_item_id)) continue
      m.set(`${p.estimate_item_id}__${p.counterparty_id}`, p)
    }
    return m
  }, [proposals, itemIds])

  // Итог по каждому контрагенту = Σ total_cost его proposals в этом ВОРе.
  const totalsByCp = useMemo(() => {
    const m = new Map()
    for (const cp of counterpartiesInDoc) {
      let sum = 0
      for (const it of itemsOfDoc) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        if (p) sum += Number(p.total_cost) || 0
      }
      m.set(cp.id, sum)
    }
    return m
  }, [counterpartiesInDoc, itemsOfDoc, proposalLookup])

  // Минимальный total_unit_price по каждой позиции — для подсветки.
  const minByItem = useMemo(() => {
    const m = new Map()
    for (const it of itemsOfDoc) {
      let min = Infinity
      for (const cp of counterpartiesInDoc) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        const v = p ? Number(p.total_unit_price) || 0 : 0
        if (v > 0 && v < min) min = v
      }
      if (min !== Infinity) m.set(it.id, min)
    }
    return m
  }, [itemsOfDoc, counterpartiesInDoc, proposalLookup])

  // Удалить все КП контрагента в выбранном ВОР.
  const handleClearCpProposals = async (cpId, cpName) => {
    if (!window.confirm(`Удалить КП контрагента «${cpName}» для ВОРа «${selectedDoc}»?`)) return
    try {
      const ids = itemsOfDoc.map(it => it.id)
      if (ids.length === 0) return
      const { error } = await supabase
        .from('tender_counterparty_proposals')
        .delete()
        .eq('counterparty_id', cpId)
        .in('estimate_item_id', ids)
      if (error) throw error

      // Если у контрагента не осталось proposals по всему тендеру — откатить статус.
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

      {/* Под-табы по ВОРам */}
      <div className="proposals-doc-tabs" role="tablist">
        {docNames.map(name => {
          const cpCount = new Set(
            proposals
              .filter(p => {
                const item = estimateItems.find(i => i.id === p.estimate_item_id)
                return item && (item.estimate_name || 'Основная смета') === name
              })
              .map(p => p.counterparty_id)
          ).size
          return (
            <button
              key={name}
              role="tab"
              aria-selected={selectedDoc === name}
              className={`proposals-doc-tab ${selectedDoc === name ? 'active' : ''}`}
              onClick={() => setSelectedDoc(name)}
            >
              <span className="proposals-doc-tab-label">{name}</span>
              <span className="proposals-doc-tab-count">{cpCount}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="proposals-empty"><p>Загрузка…</p></div>
      ) : itemsOfDoc.length === 0 ? (
        <div className="proposals-empty">
          <p>В ВОРе «{selectedDoc}» нет позиций.</p>
        </div>
      ) : counterpartiesInDoc.length === 0 ? (
        <div className="proposals-empty">
          <p>Для этого ВОРа ещё не загружено ни одного КП.</p>
          {canEdit && (
            <p className="hint">Нажмите «+ Загрузить КП», чтобы добавить первое предложение.</p>
          )}
        </div>
      ) : (
        <>
          {/* Summary бар по контрагентам */}
          <div className="proposals-summary">
            {counterpartiesInDoc.map(cp => {
              const total = totalsByCp.get(cp.id) || 0
              const min = Math.min(...counterpartiesInDoc.map(c => totalsByCp.get(c.id) || Infinity))
              const isMin = total > 0 && total === min
              return (
                <div key={cp.id} className={`proposals-summary-card${isMin ? ' is-min' : ''}`}>
                  <div className="proposals-summary-name" title={cp.name}>{cp.name}</div>
                  <div className="proposals-summary-total">{fmtMoney(total)} ₽</div>
                  {canEdit && (
                    <button
                      className="proposals-summary-remove"
                      onClick={() => handleClearCpProposals(cp.id, cp.name)}
                      title="Удалить КП этого контрагента в текущем ВОРе"
                      aria-label="Удалить"
                    >×</button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Таблица сравнения */}
          <div className="proposals-table-wrap">
            <table className="proposals-table">
              <thead>
                <tr>
                  <th rowSpan={2} className="th-num">№</th>
                  <th rowSpan={2} className="th-code">КОД</th>
                  <th rowSpan={2} className="th-name">Наименование</th>
                  <th rowSpan={2} className="th-unit">Ед.</th>
                  <th rowSpan={2} className="th-vol">Объём раб.</th>
                  <th rowSpan={2} className="th-vol">Объём мат.</th>
                  {counterpartiesInDoc.map(cp => (
                    <th key={cp.id} colSpan={3} className="th-cp">
                      <span className="th-cp-name" title={cp.name}>{cp.name}</span>
                    </th>
                  ))}
                </tr>
                <tr>
                  {counterpartiesInDoc.map(cp => (
                    <React.Fragment key={cp.id}>
                      <th className="th-sub" title="Цена за ед. материалов">Ц.мат</th>
                      <th className="th-sub" title="Цена за ед. работ">Ц.раб</th>
                      <th className="th-sub" title="Итого за ед. (мат+раб)">Итого/ед</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {itemsOfDoc.map((it, idx) => {
                  const minPrice = minByItem.get(it.id)
                  return (
                    <tr key={it.id}>
                      <td className="td-num">{idx + 1}</td>
                      <td className="td-code">{it.code || '—'}</td>
                      <td className="td-name" title={it.cost_name}>{it.cost_name}</td>
                      <td className="td-unit">{it.unit || '—'}</td>
                      <td className="td-vol">{fmtMoney(it.work_volume)}</td>
                      <td className="td-vol">{fmtMoney(it.material_consumption)}</td>
                      {counterpartiesInDoc.map(cp => {
                        const p = proposalLookup.get(`${it.id}__${cp.id}`)
                        const totalUnit = p ? Number(p.total_unit_price) || 0 : 0
                        const isMin = totalUnit > 0 && minPrice != null && totalUnit === minPrice
                        return (
                          <React.Fragment key={cp.id}>
                            <td className="td-price">{p ? fmtMoney(p.unit_price_materials) : '—'}</td>
                            <td className="td-price">{p ? fmtMoney(p.unit_price_works) : '—'}</td>
                            <td className={`td-price td-total${isMin ? ' is-min' : ''}`}>
                              {p ? fmtMoney(totalUnit) : '—'}
                            </td>
                          </React.Fragment>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="proposals-total-row">
                  <td colSpan={6} style={{ textAlign: 'right' }}>ИТОГО, ₽:</td>
                  {counterpartiesInDoc.map(cp => {
                    const total = totalsByCp.get(cp.id) || 0
                    const min = Math.min(...counterpartiesInDoc.map(c => totalsByCp.get(c.id) || Infinity))
                    const isMin = total > 0 && total === min
                    return (
                      <td key={cp.id} colSpan={3} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
                        {fmtMoney(total)}
                      </td>
                    )
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
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

export default TenderProposalsCompare
