// Таблица сметы КП / ПЗ: только видимые строки (VirtualTableBody), шапка и три левых столбца закреплены.
//   • строка — нажатие открывает подробности справа; флажок слева (Shift — диапазон) выделяет строки, у группы — со всем
//     её составом;
//   • «Выделять ячейки» — протянуть мышью прямоугольник ячеек для заливки;
//   • нажатие по «Актуальному объёму» или «Примечанию» (с правом правки) — правка прямо в ячейке, панель не открывается
//     (Enter — сохранить, Esc — отмена): иначе панель сдвигала таблицу между нажатиями.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import VirtualTableBody from '../VirtualTableBody'
import {
  STATUS_LABELS, fmtMoney, fmtMoneyShort, fmtQty, groupStatus, hasVolume, isPosition, linkedPzIds, parseQtyInput,
} from '../../utils/kpEstimate'

const STICKY_LEFT = { sel: 0 }

function statusChip(status, title) {
  return <span className={`kpe-status kpe-status--${status}`} title={title}>{STATUS_LABELS[status]}</span>
}

function qtyCell(v, { sign = false } = {}) {
  if (v === null || v === undefined) return ''
  const s = fmtQty(v)
  return sign && v > 0 ? `+${s}` : s
}

// Что показать в ячейке. ctx: { state, sum, mark, allocs, linkedCount }.
function cellContent(col, row, ctx) {
  const { state: s, sum, mark } = ctx
  const pos = isPosition(row)
  switch (col.key) {
    case 'code': return row.code || (row.pos_no ? <span className="kpe-muted">№ {row.pos_no}</span> : '')
    case 'actual': {
      if (!hasVolume(row)) return ''
      const set = mark?.actual_qty !== null && mark?.actual_qty !== undefined
      if (pos) return <span className={s?.changed ? 'kpe-changed' : (set ? '' : 'kpe-muted')}>{fmtQty(s?.actual)}</span>
      return set ? <span className="kpe-changed">{fmtQty(mark.actual_qty)}</span> : <span className="kpe-muted">{fmtQty(row.kp?.qty_gp)}</span>
    }
    case 'diff': {
      if (pos && s?.changed) return <span className={s.diff > 0 ? 'kpe-up' : 'kpe-down'} title={mark?.actual_reason || 'Причина не указана'}>{qtyCell(s.diff, { sign: true })}</span>
      if (row.kind === 'aggregate' && mark?.actual_qty !== null && mark?.actual_qty !== undefined) {
        const d = Number(mark.actual_qty) - (row.kp?.qty_gp || 0)
        return d ? <span className={d > 0 ? 'kpe-up' : 'kpe-down'}>{qtyCell(d, { sign: true })}</span> : ''
      }
      if (!pos && sum?.changed) return <span className="kpe-muted" title="Позиций с уточнённым объёмом">изм.: {sum.changed}</span>
      return ''
    }
    case 'distributed':
      if (pos) return s && s.status !== 'empty' ? fmtQty(s.distributed) : ''
      return sum?.distributedMoney ? <span className="kpe-muted" title={`${fmtMoney(sum.distributedMoney)} ₽`}>{fmtMoneyShort(sum.distributedMoney)}</span> : ''
    case 'free':
      if (pos) {
        if (!s || s.status === 'empty') return ''
        return <span className={s.status === 'over' ? 'kpe-over' : (s.status === 'full' ? 'kpe-ok' : '')}>{s.status === 'over' ? '⚠ ' : ''}{fmtQty(s.free)}</span>
      }
      if (sum?.overMoney) return <span className="kpe-over" title={`Превышение: ${fmtMoney(sum.overMoney)} ₽`}>⚠ {sum.counts.over} поз.</span>
      return sum?.freeMoney ? <span className="kpe-muted" title={`${fmtMoney(sum.freeMoney)} ₽`}>{fmtMoneyShort(sum.freeMoney)}</span> : ''
    case 'taken':
      if (pos) return s?.distributedMoney ? fmtMoney(s.distributedMoney) : ''
      return sum?.distributedMoney ? fmtMoney(sum.distributedMoney) : ''
    case 'rest':
      if (pos) return s && s.status !== 'empty' ? <span className={s.freeMoney < -0.005 ? 'kpe-over' : ''}>{fmtMoney(s.freeMoney)}</span> : ''
      return sum ? <span>{fmtMoney(sum.freeMoney - sum.overMoney)}</span> : ''
    case 'status':
      if (pos) return s ? statusChip(s.status) : ''
      if (!sum?.positions) return ''
      return statusChip(groupStatus(sum), `Распределено ${sum.counts.full}, частично ${sum.counts.partial}, не распределено ${sum.counts.none}, превышение ${sum.counts.over}`)
    case 'tenders':
      if (!pos || !s?.groups?.length) return ''
      return (
        <span className="kpe-chips">
          {s.groups.filter((g) => g.tender_id || g.tender_label).map((g) => (
            <span key={g.key} className={`kpe-chip${g.contractOver ? ' is-over' : ''}`}
              title={g.contractOver ? `По договорам этого тендера закреплено ${fmtQty(g.contractQty)} — больше, чем взято в расчёт ПЗ (${fmtQty(g.pzQty)})` : `Взято в расчёт ПЗ: ${fmtQty(g.pzQty)}`}>
              {g.tender_label || 'тендер'} · {fmtQty(g.pzQty)}
            </span>
          ))}
        </span>
      )
    case 'contractors': {
      const list = (ctx.allocs || []).filter((a) => a.counterparty_id || a.counterparty_name)
      if (!list.length) return ''
      return (
        <span className="kpe-chips">
          {list.map((a) => (
            <span key={a.id} className="kpe-chip kpe-chip--cp" title={[a.counterparty_name, a.contract_label, `закреплено ${fmtQty(a.contract_qty)}`].filter(Boolean).join(' · ')}>
              {a.counterparty_name || 'подрядчик'} · {fmtQty(a.contract_qty)}
            </span>
          ))}
        </span>
      )
    }
    case 'responsible': return mark?.responsible_name || ''
    case 'note': return mark?.note ? <span className="kpe-note-text">{mark.note}</span> : ''
    default: {
      if (!col.get) return ''
      const v = col.get(row, ctx)
      if (v === null || v === undefined || v === '') return ''
      return col.fmt ? col.fmt(v) : v
    }
  }
}

// Переход КП ↔ ПЗ: из КП — к позициям ПЗ строки (у группы и укрупнённой — их число), из ПЗ — к строке КП.
function linkLabel(row, ctx, view) {
  if (view === 'pz') return row.pz ? 'КП' : ''
  if (row.pz) return 'ПЗ'
  return ctx.linkedCount ? `ПЗ · ${ctx.linkedCount}` : ''
}

function InlineEditor({ kind, initial, onCommit, onCancel }) {
  const [value, setValue] = useState(initial)
  const ref = useRef(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select?.() }, [])
  const commit = () => { if (done.current) return; done.current = true; if (value !== initial) onCommit(value); else onCancel() }
  const cancel = () => { done.current = true; onCancel() }
  if (kind === 'note') {
    return (
      <textarea ref={ref} className="kpe-inline kpe-inline--note" value={value} maxLength={4000} aria-label="Примечание"
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
        }} />
    )
  }
  return (
    <input ref={ref} className="kpe-inline" value={value} inputMode="decimal" aria-label="Актуальный объём"
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel() }
        if (e.key === 'Enter') { e.preventDefault(); commit() }
      }} />
  )
}

const Row = memo(function Row({
  row, index, columns, view, ctx, level, collapsed, hasChildren, selected, active, highlighted, remote, cellSel, brush,
  canEdit, editing, lefts, onToggle, onSelect, onOpen, onCellDown, onCellEnter, onStartEdit, onCommitEdit, onCancelEdit, onLink,
}) {
  const mark = ctx.mark
  const rowFill = mark?.fill || null
  const cellFills = mark?.cell_fills || {}
  const isGroup = hasChildren
  const cls = ['kpe-row', `kpe-row--${row.kind}`, `kpe-lv${Math.min(level, 6)}`]
  if (selected) cls.push('is-selected')
  if (active) cls.push('is-active')
  if (highlighted) cls.push('is-highlight')
  if (remote) cls.push('is-remote')
  if (rowFill) cls.push('has-fill')
  if (ctx.state?.status === 'over') cls.push('is-over')
  return (
    <tr className={cls.join(' ')} data-id={row.id} data-index={index} style={rowFill ? { '--kpe-fill': rowFill } : undefined}
      onClick={(e) => { if (!brush && !e.target.closest('button, input, textarea, a, .kpe-inline')) onOpen(row.id) }}>
      <td className="kpe-c-sel kpe-sticky" style={{ left: lefts.sel }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} aria-label={`Выделить: ${row.code || ''} ${row.name}`.trim()}
          onChange={() => {}} onClick={(e) => onSelect(row.id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })} />
      </td>
      {columns.map((col, ci) => {
        const fill = cellFills[col.key]
        const inSel = cellSel && index >= cellSel.r1 && index <= cellSel.r2 && ci >= cellSel.c1 && ci <= cellSel.c2
        const tdCls = [`kpe-c-${col.key}`]
        if (col.num) tdCls.push('kpe-num')
        if (col.sticky) tdCls.push('kpe-sticky')
        if (col.strong) tdCls.push('kpe-strong')
        if (fill) tdCls.push('has-cell-fill')
        if (inSel) tdCls.push('is-cell-sel')
        const editable = canEdit && col.editable && (col.editable === 'note' || hasVolume(row))
        if (editable) tdCls.push('is-editable')
        const style = {}
        if (col.sticky) style.left = lefts[col.key]
        if (fill) style['--kpe-cell-fill'] = fill
        const isEditing = editing && editing.id === row.id && editing.key === col.key
        if (isEditing) tdCls.push('is-editing')
        let content
        if (isEditing) {
          const initial = col.editable === 'note' ? (mark?.note || '') : (mark?.actual_qty ?? '')
          content = <InlineEditor kind={col.editable} initial={initial === null ? '' : String(initial).replace('.', ',')}
            onCommit={(v) => onCommitEdit(row.id, col.editable, v)} onCancel={onCancelEdit} />
        } else if (col.key === 'name') {
          content = (
            <span className="kpe-name" style={{ paddingLeft: `${(level - 1) * 0.85}rem` }}>
              {isGroup
                ? <button type="button" className={`kpe-toggle${collapsed ? '' : ' is-open'}`} aria-label={collapsed ? 'Развернуть' : 'Свернуть'}
                    aria-expanded={!collapsed} onClick={(e) => { e.stopPropagation(); onToggle(row.id) }}>
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                : <span className="kpe-toggle-space" />}
              {row.kind === 'aggregate' && <span className="kpe-tag" title="Укрупнённая позиция КП: состав — подробные позиции ниже">укрупн.</span>}
              <span className="kpe-name-text" title={row.name}>{row.name}</span>
              {mark?.note && <span className="kpe-dot" title={`Примечание: ${mark.note}`} />}
              {linkLabel(row, ctx, view) && (
                <button type="button" className="kpe-link-btn" title={view === 'pz' ? 'Показать строку в КП' : 'Показать подробные позиции ПЗ'}
                  onClick={(e) => { e.stopPropagation(); onLink(row.id) }}>{linkLabel(row, ctx, view)}</button>
              )}
            </span>
          )
        } else {
          content = cellContent(col, row, ctx)
        }
        return (
          <td key={col.key} className={tdCls.join(' ')} style={style}
            onMouseDown={brush ? (e) => { if (e.button === 0) { e.preventDefault(); onCellDown(index, ci, e.shiftKey) } } : undefined}
            onMouseEnter={brush ? () => onCellEnter(index, ci) : undefined}
            onClick={editable && !brush && !isEditing ? (e) => { e.stopPropagation(); onStartEdit(row.id, col.key) } : undefined}
            title={editable && !isEditing ? 'Нажмите, чтобы изменить' : undefined}>
            {content}
          </td>
        )
      })}
    </tr>
  )
})

export default function KpEstimateTable({
  tree, ids, columns, view, marks, allocsByRow, states, sums, collapsed, selection, activeId, highlight, remoteIds,
  cellSel, setCellSel, brush, canEdit, scrollTo, onToggle, onSelect, onOpen, onEdit, onLink,
}) {
  const scrollRef = useRef(null)
  const [editing, setEditing] = useState(null)
  const dragRef = useRef(null)

  // Отступы закреплённых столбцов: флажок, код, наименование.
  const lefts = { sel: '0rem' }
  let acc = 2.25
  for (const c of columns) {
    if (!c.sticky) continue
    lefts[c.key] = `${acc}rem`
    acc += c.width
  }
  const minWidth = 2.25 + columns.reduce((s, c) => s + c.width, 0)

  useEffect(() => {
    const up = () => { dragRef.current = null }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const onCellDown = useCallback((r, c, shift) => {
    if (shift && cellSel) {
      const a = cellSel.anchor || { r: cellSel.r1, c: cellSel.c1 }
      setCellSel({ anchor: a, r1: Math.min(a.r, r), r2: Math.max(a.r, r), c1: Math.min(a.c, c), c2: Math.max(a.c, c) })
      return
    }
    dragRef.current = { r, c }
    setCellSel({ anchor: { r, c }, r1: r, r2: r, c1: c, c2: c })
  }, [cellSel, setCellSel])
  const onCellEnter = useCallback((r, c) => {
    const a = dragRef.current
    if (!a) return
    setCellSel({ anchor: a, r1: Math.min(a.r, r), r2: Math.max(a.r, r), c1: Math.min(a.c, c), c2: Math.max(a.c, c) })
  }, [setCellSel])

  const onStartEdit = useCallback((id, key) => setEditing({ id, key }), [])
  const onCancelEdit = useCallback(() => setEditing(null), [])
  const onCommitEdit = useCallback((id, kind, value) => {
    setEditing(null)
    if (kind === 'note') onEdit(id, { note: value })
    else {
      const n = parseQtyInput(value)
      if (Number.isNaN(n) || (n !== null && n < 0)) return onEdit(id, { invalid: 'Объём — неотрицательное число' })
      onEdit(id, { actual_qty: n })
    }
  }, [onEdit])

  // Переход к строке: сначала примерно (виртуальный список), затем точно — по самой строке.
  useLayoutEffect(() => {
    if (!scrollTo?.id) return
    const el = scrollRef.current
    if (!el) return
    const index = ids.indexOf(scrollTo.id)
    if (index < 0) return
    el.scrollTop = Math.max(0, index * 34 - el.clientHeight / 3)
    let tries = 0
    const exact = () => {
      const tr = el.querySelector(`tr[data-id="${scrollTo.id}"]`)
      if (tr) {
        const box = tr.getBoundingClientRect()
        const host = el.getBoundingClientRect()
        el.scrollTop += box.top - host.top - el.clientHeight / 3
      } else if (tries++ < 10) requestAnimationFrame(exact)
    }
    requestAnimationFrame(exact)
  }, [scrollTo, ids])

  const renderRow = (index) => {
    const id = ids[index]
    const row = tree.byId.get(id)
    const hasChildren = tree.children.has(id)
    const ctx = {
      state: states.get(id),
      sum: hasChildren ? sums.get(id) : null,
      mark: marks.get(id),
      allocs: allocsByRow.get(id),
      linkedCount: view === 'kp' && hasChildren ? linkedPzIds(tree, id).length : 0,
    }
    const rowSel = cellSel && index >= cellSel.r1 && index <= cellSel.r2 ? cellSel : null
    return (
      <Row key={id} row={row} index={index} columns={columns} view={view} ctx={ctx} level={row.level}
        collapsed={collapsed.has(id)} hasChildren={hasChildren} selected={selection.has(id)} active={activeId === id}
        highlighted={highlight.has(id)} remote={remoteIds.has(id)} cellSel={rowSel} brush={brush} canEdit={canEdit}
        editing={editing && editing.id === id ? editing : null} lefts={lefts}
        onToggle={onToggle} onSelect={onSelect} onOpen={onOpen} onCellDown={onCellDown} onCellEnter={onCellEnter}
        onStartEdit={onStartEdit} onCommitEdit={onCommitEdit} onCancelEdit={onCancelEdit} onLink={onLink} />
    )
  }

  return (
    <div className={`kpe-table-wrap${brush ? ' is-brush' : ''}`} ref={scrollRef}>
      <table className="kpe-table" style={{ minWidth: `${minWidth}rem` }}>
        <colgroup>
          <col style={{ width: '2.25rem' }} />
          {columns.map((c) => <col key={c.key} style={{ width: `${c.width}rem` }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="kpe-c-sel kpe-sticky" style={{ left: STICKY_LEFT.sel }} aria-label="Выделение" />
            {columns.map((c) => (
              <th key={c.key} className={`kpe-c-${c.key}${c.num ? ' kpe-num' : ''}${c.sticky ? ' kpe-sticky' : ''}`}
                style={c.sticky ? { left: lefts[c.key] } : undefined} title={c.hint || undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        {ids.length ? (
          <VirtualTableBody rowCount={ids.length} renderRow={renderRow} colSpan={columns.length + 1} scrollRef={scrollRef} rowHeight={34} />
        ) : (
          <tbody><tr><td colSpan={columns.length + 1} className="kpe-empty-row">Ничего не найдено — измените поиск или фильтры</td></tr></tbody>
        )}
      </table>
    </div>
  )
}
