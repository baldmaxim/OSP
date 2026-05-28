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
  // Берём latest proposal_date по контрагенту для отображения в шапке.
  const counterpartiesInDoc = useMemo(() => {
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

  const fmtDate = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString('ru-RU')
  }

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

  // Минимальный total_cost (стоимость позиции с учётом объёма) по каждой
  // строке — для подсветки самого выгодного предложения.
  const minByItem = useMemo(() => {
    const m = new Map()
    for (const it of itemsOfDoc) {
      let min = Infinity
      for (const cp of counterpartiesInDoc) {
        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        const v = p ? Number(p.total_cost) || 0 : 0
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

          {/* Таблица сравнения — 5 sub-cells на контрагента:
              Ц.мат / Стоим.мат / Ц.раб / Стоим.раб / Итого. */}
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
                    <th key={cp.id} colSpan={5} className="th-cp">
                      <div className="th-cp-name" title={cp.name}>{cp.name}</div>
                      {cp.latestDate && (
                        <div className="th-cp-date">КП от {fmtDate(cp.latestDate)}</div>
                      )}
                    </th>
                  ))}
                </tr>
                <tr>
                  {counterpartiesInDoc.map(cp => (
                    <React.Fragment key={cp.id}>
                      <th className="th-sub" title="Цена материала за ед.">Ц.мат, ₽/ед</th>
                      <th className="th-sub" title="Стоимость материалов = Ц.мат × Объём мат.">Стоим.мат, ₽</th>
                      <th className="th-sub" title="Цена работ за ед.">Ц.раб, ₽/ед</th>
                      <th className="th-sub" title="Стоимость работ = Ц.раб × Объём раб.">Стоим.раб, ₽</th>
                      <th className="th-sub th-sub-total" title="Итого по позиции (стоим.мат + стоим.раб)">Итого, ₽</th>
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
                        const total = p ? Number(p.total_cost) || 0 : 0
                        const isMin = total > 0 && minPrice != null && total === minPrice
                        return (
                          <React.Fragment key={cp.id}>
                            <td className="td-price td-cp-first">{p ? fmtMoney(p.unit_price_materials) : '—'}</td>
                            <td className="td-price td-sum">{p ? fmtMoney(p.total_materials) : '—'}</td>
                            <td className="td-price">{p ? fmtMoney(p.unit_price_works) : '—'}</td>
                            <td className="td-price td-sum">{p ? fmtMoney(p.total_works) : '—'}</td>
                            <td className={`td-price td-total${isMin ? ' is-min' : ''}`}>
                              {p ? fmtMoney(total) : '—'}
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
                      <td key={cp.id} colSpan={5} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
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
