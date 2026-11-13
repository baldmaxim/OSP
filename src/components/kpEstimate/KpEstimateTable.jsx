// Таблица сметы КП / ПЗ: только видимые строки (VirtualTableBody), шапка, флажок и код закреплены слева.
//   • наименование — одной строкой и целиком (13.11.2026, просьба пользователя): ширина столбца — по самому длинному
//     видимому наименованию; столбцы после него закреплены справа, поэтому длинное наименование уходит под них, а не
//     уводит числа за край. Не уместилось — при наведении наименование показывается целиком одной строкой поверх чисел
//     (подсказка не ловит мышь, ничему не мешает); ещё — прокрутка таблицы вбок (Shift + колесо). Узкое окно — без закрепления;
//   • нажатие по строке открывает окно строки; флажок слева (Shift — диапазон) выделяет строки, у группы — со всем её
//     составом; «Ячейки» — протянуть мышью прямоугольник ячеек для заливки;
//   • нажатие по «Актуальному» или «Примечанию» (с правом правки) — правка прямо в ячейке (Enter — сохранить, Esc — отмена).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import VirtualTableBody from '../VirtualTableBody'
import { allocQty, allocationText, fmtMoney, fmtQty, hasVolume, isPosition, originalQty, parseQtyInput } from '../../utils/kpEstimate'

const SEL_W = 2.25
const MIN_NAME_REM = 16
const MIN_FREE_NAME_REM = 18

// Ширина текста в пикселях (canvas): наименование меряется один раз на шрифт.
let canvas = null
function measure(text, font) {
  canvas = canvas || document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  ctx.font = font
  return ctx.measureText(text).width
}
const WEIGHT = { section: 600, group: 500 }

function qtyCell(v, { sign = false } = {}) {
  if (v === null || v === undefined) return ''
  const s = fmtQty(v)
  return sign && v > 0 ? `+${s}` : s
}

// Что показать в ячейке. ctx: { state, sum, mark, allocs }.
function cellContent(col, row, ctx) {
  const { state: s, sum, mark } = ctx
  const pos = isPosition(row)
  const group = !!sum
  switch (col.key) {
    case 'code': return row.code || (row.pos_no ? <span className="kpe-muted">№ {row.pos_no}</span> : '')
    case 'qty_gp': {
      if (!row.unit) return ''
      return <>{fmtQty(originalQty(row))} <span className="kpe-unit">{row.unit}</span></>
    }
    case 'actual': {
      if (!hasVolume(row)) return ''
      const set = mark?.actual_qty !== null && mark?.actual_qty !== undefined
      if (!set) return ''
      const diff = Number(mark.actual_qty) - originalQty(row)
      const title = `Было ${fmtQty(originalQty(row))}, разница ${qtyCell(diff, { sign: true })}${mark.actual_reason ? `. Причина: ${mark.actual_reason}` : ''}`
      return <span className={diff > 0 ? 'kpe-up' : diff < 0 ? 'kpe-down' : ''} title={title}>{fmtQty(mark.actual_qty)}</span>
    }
    case 'total': {
      const v = group ? sum.total : row.kp?.total
      return v || v === 0 ? (v === 0 && !row.unit ? '' : fmtMoney(v)) : ''
    }
    case 'direct': {
      const v = group ? sum.direct : row.pz?.direct
      return v ? fmtMoney(v) : ''
    }
    case 'free':
      if (pos) {
        if (!s || s.status === 'empty' || s.status === 'none') return ''
        const title = `Распределено ${fmtQty(s.distributed)} из ${fmtQty(s.actual)}`
        if (s.status === 'over') return <span className="kpe-over" title={title}>{qtyCell(s.free)}</span>
        return <span className={s.status === 'full' ? 'kpe-ok' : ''} title={title}>{fmtQty(s.free)}</span>
      }
      if (sum?.counts?.over) return <span className="kpe-over" title="Позиций с превышением внутри">⚠ {sum.counts.over} поз.</span>
      return ''
    case 'alloc': {
      const list = ctx.allocs || []
      if (!pos || !list.length) return ''
      return (
        <span className="kpe-chips">
          {list.map((a) => (
            <span key={a.id} className="kpe-chip" title={`${allocationText(a)}: ${fmtQty(allocQty(a))} ${row.unit || ''}`.trim()}>
              {allocationText(a)} · {fmtQty(allocQty(a))}
            </span>
          ))}
        </span>
      )
    }
    case 'note': return mark?.note ? <span className="kpe-note-text">{mark.note}</span> : ''
    default: return ''
  }
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
  row, index, columns, place, ctx, level, collapsed, hasChildren, selected, active, highlighted, remote, cellSel, brush,
  canEdit, editing, onToggle, onSelect, onOpen, onCellDown, onCellEnter, onStartEdit, onCommitEdit, onCancelEdit, onNameHover,
}) {
  const mark = ctx.mark
  const rowFill = mark?.fill || null
  const cellFills = mark?.cell_fills || {}
  const cls = ['kpe-row', `kpe-row--${row.kind}`]
  if (selected) cls.push('is-selected')
  if (active) cls.push('is-active')
  if (highlighted) cls.push('is-highlight')
  if (remote) cls.push('is-remote')
  if (rowFill) cls.push('has-fill')
  if (ctx.state?.status === 'over') cls.push('is-over')
  return (
    <tr className={cls.join(' ')} data-id={row.id} data-index={index} style={rowFill ? { '--kpe-fill': rowFill } : undefined}
      onClick={(e) => { if (!brush && !e.target.closest('button, input, textarea, a, .kpe-inline')) onOpen(row.id) }}>
      <td className="kpe-c-sel kpe-pin-l" style={{ left: 0 }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} aria-label={`Выделить: ${row.code || ''} ${row.name}`.trim()}
          onChange={() => {}} onClick={(e) => onSelect(row.id, { shift: e.shiftKey })} />
      </td>
      {columns.map((col, ci) => {
        const fill = cellFills[col.key]
        const inSel = cellSel && index >= cellSel.r1 && index <= cellSel.r2 && ci >= cellSel.c1 && ci <= cellSel.c2
        const p = place[col.key]
        const tdCls = [`kpe-c-${col.key}`]
        if (col.num) tdCls.push('kpe-num')
        if (p?.cls) tdCls.push(p.cls)
        if (col.strong) tdCls.push('kpe-strong')
        if (fill) tdCls.push('has-cell-fill')
        if (inSel) tdCls.push('is-cell-sel')
        const editable = canEdit && col.editable && (col.editable === 'note' || hasVolume(row))
        if (editable) tdCls.push('is-editable')
        const style = p?.style ? { ...p.style } : {}
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
              {hasChildren
                ? <button type="button" className={`kpe-toggle${collapsed ? '' : ' is-open'}`} aria-label={collapsed ? 'Развернуть' : 'Свернуть'}
                    aria-expanded={!collapsed} onClick={(e) => { e.stopPropagation(); onToggle(row.id) }}>
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                : <span className="kpe-toggle-space" />}
              <span className="kpe-name-text" onMouseEnter={(e) => onNameHover(e.currentTarget, row)} onMouseLeave={() => onNameHover(null)}>{row.name}</span>
              {mark?.note && <span className="kpe-dot" title={`Примечание: ${mark.note}`} />}
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
  tree, ids, columns, marks, allocsByRow, states, sums, collapsed, selection, activeId, highlight, remoteIds,
  cellSel, setCellSel, brush, canEdit, scrollTo, onToggle, onSelect, onOpen, onEdit,
}) {
  const scrollRef = useRef(null)
  const [editing, setEditing] = useState(null)
  const dragRef = useRef(null)
  const [box, setBox] = useState({ width: 0, rem: 16, font: '' })
  const [peek, setPeek] = useState(null)

  // Ширина окна таблицы и шрифт — для ширины наименования и закрепления справа.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const read = () => {
      const cs = getComputedStyle(el)
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setBox({ width: el.clientWidth, rem, font: `${cs.fontSize} ${cs.fontFamily}` })
    }
    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  // Самое длинное видимое наименование (с отступом уровня, стрелкой и отметкой примечания).
  const widthCache = useRef({ font: '', map: new Map() })
  const nameNeed = useMemo(() => {
    if (!box.font) return MIN_NAME_REM * box.rem
    if (widthCache.current.font !== box.font) widthCache.current = { font: box.font, map: new Map() }
    const cache = widthCache.current.map
    let max = 0
    for (const id of ids) {
      let w = cache.get(id)
      if (w === undefined) {
        const r = tree.byId.get(id)
        w = measure(r.name || '', `${r.kind === 'title' ? 'italic ' : ''}${WEIGHT[r.kind] || 400} ${box.font}`) + ((r.level || 1) - 1) * 0.85 * box.rem
        cache.set(id, w)
      }
      if (w > max) max = w
    }
    // Стрелка, отступы ячейки, отметка примечания, запас на округление шрифта.
    return Math.ceil(max + 2.75 * box.rem + 8)
  }, [ids, tree, box.font, box.rem])

  const leftRem = SEL_W + columns.filter((c) => c.left).reduce((s, c) => s + c.width, 0)
  const right = columns.filter((c) => !c.left && c.key !== 'name')
  const rightRem = right.reduce((s, c) => s + c.width, 0)
  const room = box.width - (leftRem + rightRem) * box.rem
  const pinRight = room >= MIN_FREE_NAME_REM * box.rem
  const nameWidth = Math.max(nameNeed, MIN_NAME_REM * box.rem, pinRight ? Math.floor(room) - 1 : 0)
  const tableWidth = (leftRem + rightRem) * box.rem + nameWidth

  // Где стоит столбец: закреплён слева / справа (отступ — сумма ширин соседей).
  const place = useMemo(() => {
    const out = {}
    let acc = SEL_W
    for (const c of columns) if (c.left) { out[c.key] = { cls: 'kpe-pin-l', style: { left: `${acc}rem` } }; acc += c.width }
    if (pinRight) {
      let r = rightRem
      right.forEach((c, i) => {
        r -= c.width
        out[c.key] = { cls: `kpe-pin-r${i === 0 ? ' kpe-pin-edge' : ''}`, style: { right: `${r}rem` } }
      })
    }
    return out
  }, [columns, pinRight, rightRem]) // eslint-disable-line react-hooks/exhaustive-deps

  // Наименование не уместилось (ушло под закреплённые столбцы или за край) — показать целиком поверх таблицы.
  const onNameHover = useCallback((el, row) => {
    const wrap = scrollRef.current
    if (!el || !wrap || brush) { setPeek(null); return }
    const r = el.getBoundingClientRect()
    const host = wrap.getBoundingClientRect()
    const leftEdge = host.left + leftRem * box.rem
    const rightEdge = host.left + wrap.clientWidth - (pinRight ? rightRem * box.rem : 0)
    if (r.left >= leftEdge - 1 && r.right <= rightEdge + 1) { setPeek(null); return }
    setPeek({ text: row.name, kind: row.kind, left: Math.max(r.left, leftEdge), top: r.top + r.height / 2 })
  }, [brush, box.rem, leftRem, rightRem, pinRight])

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
        const r = tr.getBoundingClientRect()
        const host = el.getBoundingClientRect()
        if (r.top < host.top + 44 || r.bottom > host.bottom) el.scrollTop += r.top - host.top - el.clientHeight / 3
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
    }
    const rowSel = cellSel && index >= cellSel.r1 && index <= cellSel.r2 ? cellSel : null
    return (
      <Row key={id} row={row} index={index} columns={columns} place={place} ctx={ctx} level={row.level}
        collapsed={collapsed.has(id)} hasChildren={hasChildren} selected={selection.has(id)} active={activeId === id}
        highlighted={highlight.has(id)} remote={remoteIds.has(id)} cellSel={rowSel} brush={brush} canEdit={canEdit}
        editing={editing && editing.id === id ? editing : null}
        onToggle={onToggle} onSelect={onSelect} onOpen={onOpen} onCellDown={onCellDown} onCellEnter={onCellEnter}
        onStartEdit={onStartEdit} onCommitEdit={onCommitEdit} onCancelEdit={onCancelEdit} onNameHover={onNameHover} />
    )
  }

  return (
    <div className={`kpe-table-wrap${brush ? ' is-brush' : ''}`} ref={scrollRef} onScroll={peek ? () => setPeek(null) : undefined}>
      {peek && createPortal(
        <div className={`kpe-peek kpe-peek--${peek.kind}`} role="tooltip" style={{ left: `${peek.left}px`, top: `${peek.top}px` }}>{peek.text}</div>,
        document.body,
      )}
      <table className="kpe-table" style={{ width: `${tableWidth}px` }}>
        <colgroup>
          <col style={{ width: `${SEL_W}rem` }} />
          {columns.map((c) => <col key={c.key} style={{ width: c.key === 'name' ? `${nameWidth}px` : `${c.width}rem` }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="kpe-c-sel kpe-pin-l" style={{ left: 0 }} aria-label="Выделение" />
            {columns.map((c) => (
              <th key={c.key} className={`kpe-c-${c.key}${c.num ? ' kpe-num' : ''}${place[c.key]?.cls ? ` ${place[c.key].cls}` : ''}`}
                style={place[c.key]?.style} title={c.hint || undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        {ids.length ? (
          <VirtualTableBody rowCount={ids.length} renderRow={renderRow} colSpan={columns.length + 1} scrollRef={scrollRef} rowHeight={34} />
        ) : (
          <tbody><tr><td colSpan={columns.length + 1} className="kpe-empty-row">Ничего не найдено — измените поиск или «Показать»</td></tr></tbody>
        )}
      </table>
    </div>
  )
}
