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

  // Итоги по контрагенту + разбивка по ВОРам + покрытие позиций (task 355).
  // matTotal/matCovered — сколько позиций МАТЕРИАЛОВ (с material_consumption > 0)
  //   и сколько из них реально расценено (unit_price_materials > 0).
  // Если matCovered < matTotal — есть «дыры», итог нерепрезентативный → подсветка.
  // Аналогично работы.
  const totalsByCp = useMemo(() => {
    const m = new Map()
    for (const cp of counterpartiesInScope) {
      let mat = 0, wrk = 0, all = 0
      let matCoveredAll = 0, matTotalAll = 0, workCoveredAll = 0, workTotalAll = 0
      const byDoc = new Map()
      for (const it of itemsOfScope) {
        const docName = it.estimate_name || 'Основная смета'
        let cur = byDoc.get(docName)
        if (!cur) {
          cur = { mat: 0, work: 0, matTotal: 0, matCovered: 0, workTotal: 0, workCovered: 0 }
          byDoc.set(docName, cur)
        }
        const hasMatVol = Number(it.material_consumption) > 0
        const hasWorkVol = Number(it.work_volume) > 0
        if (hasMatVol) { cur.matTotal++; matTotalAll++ }
        if (hasWorkVol) { cur.workTotal++; workTotalAll++ }

        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        if (!p) continue
        const m_ = Number(p.total_materials) || 0
        const w_ = Number(p.total_works) || 0
        const c_ = Number(p.total_cost) || 0
        mat += m_; wrk += w_; all += c_
        cur.mat += m_
        cur.work += w_
        const priceMat = Number(p.unit_price_materials) || 0
        const priceWork = Number(p.unit_price_works) || 0
        if (hasMatVol && priceMat > 0) { cur.matCovered++; matCoveredAll++ }
        if (hasWorkVol && priceWork > 0) { cur.workCovered++; workCoveredAll++ }
      }
      m.set(cp.id, {
        totalMat: mat, totalWork: wrk, totalCost: all, byDoc,
        matCoveredAll, matTotalAll, workCoveredAll, workTotalAll,
      })
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
        const cur = row.cpData.get(cp.id) || {
          totalCost: 0, weightedPriceSum: 0, weightedVolSum: 0,
          // task 355: счётчики покрытия для row в разрезе контрагента
          itemsTotal: 0, itemsCovered: 0,
        }
        // Учитываем только позиции с положительным объёмом — иначе они не
        // требуют расценки и не должны подсвечиваться как «дыра».
        if (vol > 0) cur.itemsTotal += 1

        const p = proposalLookup.get(`${it.id}__${cp.id}`)
        if (p) {
          const cost = isWork ? (Number(p.total_works) || 0) : (Number(p.total_materials) || 0)
          const price = isWork ? (Number(p.unit_price_works) || 0) : (Number(p.unit_price_materials) || 0)
          cur.totalCost += cost
          cur.weightedPriceSum += price * vol
          cur.weightedVolSum += vol
          if (vol > 0 && price > 0) cur.itemsCovered += 1

          // Подытог по ВОРу
          const prev = group.subtotalByCp.get(cp.id) || 0
          group.subtotalByCp.set(cp.id, prev + cost)
        }
        row.cpData.set(cp.id, cur)
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
          {/* task 354: сводная сопоставительная матрица «ВОР × контрагенты».
              Строки — ВОРы, колонки — каждый контрагент (Мат / Раб / Итого).
              Если контрагент не давал КП по ВОРу — клетка пустая (—). */}
          <SummaryMatrixTable
            docNames={docNames}
            selectedDoc={selectedDoc}
            counterpartiesInScope={counterpartiesInScope}
            totalsByCp={totalsByCp}
            canEdit={canEdit}
            onClearCp={handleClearCpProposals}
          />

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

// ===== Подкомпонент: сводная матрица «ВОР × контрагенты» (task 354) =====
// Строки — ВОРы текущего scope. Колонки — каждый контрагент с 3 sub-cells
// (Материалы / Работы / Итого). Если КП по ВОРу не подавалось — клетка «—».
// Минимальный «Итого» по строке ВОРа подсвечен зелёным. В footer — Σ по
// контрагенту с подсветкой минимального общего предложения.
function SummaryMatrixTable({
  docNames, selectedDoc, counterpartiesInScope, totalsByCp, canEdit, onClearCp,
}) {
  // ВОРы для строк: в режиме «Объединённый» — все, иначе только выбранный.
  const docsToShow = useMemo(
    () => (selectedDoc === 'all' ? docNames : [selectedDoc]),
    [selectedDoc, docNames]
  )

  // Минимальный totalCost по тендеру — для подсветки итоговой строки.
  const minTotalCost = useMemo(() => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const v = totalsByCp.get(cp.id)?.totalCost || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? 0 : min
  }, [counterpartiesInScope, totalsByCp])

  // Минимум по строке ВОРа — для подсветки лучшего контрагента в ВОР'е.
  const minByDoc = useMemo(() => {
    const m = new Map()
    for (const docName of docsToShow) {
      let min = Infinity
      for (const cp of counterpartiesInScope) {
        const v = totalsByCp.get(cp.id)?.byDoc.get(docName)
        const total = (v?.mat || 0) + (v?.work || 0)
        if (total > 0 && total < min) min = total
      }
      if (min !== Infinity) m.set(docName, min)
    }
    return m
  }, [docsToShow, counterpartiesInScope, totalsByCp])

  if (counterpartiesInScope.length === 0) return null

  return (
    <div className="proposals-summary-matrix-wrap">
      <table className="proposals-summary-matrix-table">
        <thead>
          <tr>
            <th rowSpan={2} className="psmt-th-doc">ВОР</th>
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={3} className="psmt-th-cp">
                <div className="psmt-th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="psmt-th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
                {canEdit && (
                  <button
                    type="button"
                    className="psmt-th-cp-remove"
                    onClick={() => onClearCp(cp.id, cp.name)}
                    title={`Удалить КП «${cp.name}» в текущем scope`}
                    aria-label="Удалить"
                  >×</button>
                )}
              </th>
            ))}
          </tr>
          <tr>
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="psmt-th-sub">Материалы, ₽</th>
                <th className="psmt-th-sub">Работы, ₽</th>
                <th className="psmt-th-sub psmt-th-sub-total">Итого, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {docsToShow.map(docName => {
            const minDoc = minByDoc.get(docName)
            return (
              <tr key={docName}>
                <td className="psmt-td-doc" title={docName}>{docName}</td>
                {counterpartiesInScope.map(cp => {
                  const v = totalsByCp.get(cp.id)?.byDoc.get(docName)
                  const mat = v?.mat || 0
                  const work = v?.work || 0
                  const total = mat + work
                  const isMin = total > 0 && minDoc != null && total === minDoc
                  // task 355: подсветка неполного покрытия по этому ВОРу.
                  const hasPart = (v?.mat || v?.work || 0) > 0
                  const matIncomplete = hasPart && v && v.matTotal > 0 && v.matCovered < v.matTotal
                  const workIncomplete = hasPart && v && v.workTotal > 0 && v.workCovered < v.workTotal
                  const matTip = matIncomplete ? `Расценено ${v.matCovered} из ${v.matTotal} позиций материалов` : null
                  const workTip = workIncomplete ? `Расценено ${v.workCovered} из ${v.workTotal} позиций работ` : null
                  return (
                    <React.Fragment key={cp.id}>
                      <td
                        className={`psmt-td-num psmt-td-mat${matIncomplete ? ' is-incomplete' : ''}`}
                        title={matTip || undefined}
                      >
                        {mat > 0 ? fmtMoney(mat) : '—'}
                      </td>
                      <td
                        className={`psmt-td-num${workIncomplete ? ' is-incomplete' : ''}`}
                        title={workTip || undefined}
                      >
                        {work > 0 ? fmtMoney(work) : '—'}
                      </td>
                      <td
                        className={`psmt-td-num psmt-td-total${isMin ? ' is-min' : ''}${(matIncomplete || workIncomplete) ? ' is-incomplete' : ''}`}
                        title={
                          (matIncomplete || workIncomplete)
                            ? `Итог нерепрезентативный: ${[matTip, workTip].filter(Boolean).join('; ')}`
                            : undefined
                        }
                      >
                        {total > 0 ? fmtMoney(total) : '—'}
                      </td>
                    </React.Fragment>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="psmt-tf-row">
            <td className="psmt-tf-label">ИТОГО, ₽</td>
            {counterpartiesInScope.map(cp => {
              const t = totalsByCp.get(cp.id) || {
                totalMat: 0, totalWork: 0, totalCost: 0,
                matCoveredAll: 0, matTotalAll: 0, workCoveredAll: 0, workTotalAll: 0,
              }
              const isMin = t.totalCost > 0 && t.totalCost === minTotalCost
              // task 355: общий итог подсвечен если хоть где-то материалы/работы недорасценены.
              const matIncomplete = t.matTotalAll > 0 && t.matCoveredAll < t.matTotalAll
              const workIncomplete = t.workTotalAll > 0 && t.workCoveredAll < t.workTotalAll
              const matTip = matIncomplete
                ? `Расценено ${t.matCoveredAll} из ${t.matTotalAll} позиций материалов по всем ВОРам`
                : null
              const workTip = workIncomplete
                ? `Расценено ${t.workCoveredAll} из ${t.workTotalAll} позиций работ по всем ВОРам`
                : null
              return (
                <React.Fragment key={cp.id}>
                  <td
                    className={`psmt-tf-num psmt-td-mat${matIncomplete ? ' is-incomplete' : ''}`}
                    title={matTip || undefined}
                  >
                    {fmtMoney(t.totalMat)}
                  </td>
                  <td
                    className={`psmt-tf-num${workIncomplete ? ' is-incomplete' : ''}`}
                    title={workTip || undefined}
                  >
                    {fmtMoney(t.totalWork)}
                  </td>
                  <td
                    className={`psmt-tf-num psmt-tf-total${isMin ? ' is-min' : ''}${(matIncomplete || workIncomplete) ? ' is-incomplete' : ''}`}
                    title={
                      (matIncomplete || workIncomplete)
                        ? `Итог нерепрезентативный: ${[matTip, workTip].filter(Boolean).join('; ')}`
                        : undefined
                    }
                  >
                    {fmtMoney(t.totalCost)}
                  </td>
                </React.Fragment>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ===== Подкомпонент: «Исходный КП» =====
// Контрагенты — колонками. Для каждого 5 sub-cells:
//   Ц.мат / Стоим.мат / Ц.раб / Стоим.раб / Итого.
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
                        // task 355: подсветка нерасценённой позиции у контрагента.
                        // Если itemsTotal > itemsCovered — есть «дыра» в покрытии
                        // (одно и то же название с разными подключёнными позициями).
                        const isIncomplete = d && d.itemsTotal > d.itemsCovered
                        const hasPrice = !!d && total > 0
                        const incompleteTip = isIncomplete
                          ? `Расценено ${d.itemsCovered} из ${d.itemsTotal} позиций — итог неполный`
                          : null
                        return (
                          <React.Fragment key={cp.id}>
                            <td
                              className={`td-price td-cp-first${isIncomplete ? ' is-incomplete' : ''}`}
                              title={incompleteTip || undefined}
                            >
                              {hasPrice ? fmtMoney(avgPrice) : '—'}
                            </td>
                            <td
                              className={`td-price td-total${isMin ? ' is-min' : ''}${isIncomplete ? ' is-incomplete' : ''}`}
                              title={incompleteTip || undefined}
                            >
                              {hasPrice ? fmtMoney(total) : '—'}
                            </td>
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
                      // task 355: подсветка если в группе есть нерасценённые позиции.
                      let incompleteCovered = 0, incompleteTotal = 0
                      for (const r of group.rows) {
                        const d = r.cpData.get(cp.id)
                        if (!d) continue
                        incompleteTotal += d.itemsTotal
                        incompleteCovered += d.itemsCovered
                      }
                      const isIncomplete = incompleteTotal > 0 && incompleteCovered < incompleteTotal
                      return (
                        <td
                          key={cp.id}
                          colSpan={2}
                          className={`td-group-subtotal${isMin ? ' is-min' : ''}${isIncomplete ? ' is-incomplete' : ''}`}
                          title={isIncomplete
                            ? `Расценено ${incompleteCovered} из ${incompleteTotal} позиций — подытог неполный`
                            : undefined}
                        >
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
