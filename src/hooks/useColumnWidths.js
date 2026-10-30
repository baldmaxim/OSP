import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  COLUMN_WIDTH_MIN, clampWidth, readColumnWidths, resizedWidth, shownWidth, writeColumnWidths,
} from '../utils/columnWidths'

// Ширины столбцов таблицы, которые человек меняет сам (utils/columnWidths.js — расчёт и хранение).
// columns — видимые столбцы по порядку: [{ key, rem, min? }], rem — ширина по умолчанию.
// Возвращает:
//   tableRef — ref для <table> (место под таблицу — её родитель);
//   tableStyle / colStyle(key) — min-width таблицы и ширины <col data-col={key}>;
//   fits — таблица помещается в своё место (горизонтальная прокрутка не нужна);
//   customized / resetAll — есть ли свои ширины и сброс всех;
//   handle(key) — для ColumnResizeHandle: ширина, начало перетаскивания, шаг клавишами, сброс столбца.
// Пока человек тянет границу, таблица не перерисовывается React'ом: ширины меняются прямо в <col>, а в состояние
// (и в хранилище) попадают, когда кнопку мыши отпустили, — иначе каждое движение перерисовывало бы весь реестр.

const rootFontPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
const sumOf = (cols, widthOf) => cols.reduce((s, c) => s + widthOf(c.key), 0)
// Место под таблицу в rem: ширина родителя без полос прокрутки и без его внутренних полей.
function placeRem(box) {
  const cs = getComputedStyle(box)
  const px = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  return px / rootFontPx()
}

export default function useColumnWidths(storageKey, columns) {
  const [custom, setCustom] = useState(() => readColumnWidths(storageKey))
  const defaults = useMemo(() => new Map(columns.map(c => [c.key, c])), [columns])
  const widthOf = useCallback((key) => custom[key] ?? defaults.get(key)?.rem ?? COLUMN_WIDTH_MIN, [custom, defaults])
  const minOf = useCallback((key) => {
    const c = defaults.get(key)
    return c?.min ?? Math.min(c?.rem ?? COLUMN_WIDTH_MIN, COLUMN_WIDTH_MIN)
  }, [defaults])
  const total = Math.round(sumOf(columns, widthOf) * 1000) / 1000

  // Свежие значения для обработчиков, заведённых при нажатии.
  const live = useRef({})
  live.current = { columns, widthOf, minOf, total }

  const setWidth = useCallback((key, rem) => {
    setCustom(prev => {
      const next = { ...prev }
      const def = defaults.get(key)?.rem
      if (rem == null || (def != null && Math.abs(rem - def) < 0.01)) delete next[key]
      else next[key] = rem
      writeColumnWidths(storageKey, next)
      return next
    })
  }, [defaults, storageKey])

  const resetAll = useCallback(() => {
    setCustom({})
    writeColumnWidths(storageKey, {})
  }, [storageKey])

  // Помещается ли таблица: место под неё меряем при каждом изменении размера (окно, свёрнутое меню), сумму —
  // при каждой смене ширин.
  const tableEl = useRef(null)
  const observer = useRef(null)
  const [fits, setFits] = useState(false)
  const measure = useCallback(() => {
    const box = tableEl.current?.parentElement
    if (box) setFits(placeRem(box) >= live.current.total - 0.01)
  }, [])
  const tableRef = useCallback((node) => {
    observer.current?.disconnect()
    observer.current = null
    tableEl.current = node
    const box = node?.parentElement
    if (!box) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure)
      observer.current.observe(box)
    }
  }, [measure])
  useEffect(() => { measure() }, [total, measure])
  useEffect(() => () => observer.current?.disconnect(), [])

  const startResize = useCallback((key, e) => {
    if (e.button !== 0) return
    const table = tableEl.current
    const col = table?.querySelector(`col[data-col="${key}"]`)
    if (!table || !col) return
    e.preventDefault()
    e.stopPropagation()
    const handleEl = e.currentTarget
    const { widthOf: widthNow, minOf: minNow, total: sum } = live.current
    const rootPx = rootFontPx()
    const container = placeRem(table.parentElement)
    const base = widthNow(key)
    const min = minNow(key)
    const startShown = shownWidth({ base, sum, container })
    const startX = e.clientX
    let next = base
    let done = false
    const apply = (rem) => {
      col.style.width = `${rem}rem`
      table.style.minWidth = `${Math.round((sum - base + rem) * 1000) / 1000}rem`
    }
    const onMove = (ev) => {
      const target = startShown + (ev.clientX - startX) / rootPx
      next = clampWidth(resizedWidth({ base, sum, container, target }), min)
      apply(next)
    }
    const finish = (commit) => {
      if (done) return
      done = true
      handleEl.removeEventListener('pointermove', onMove)
      handleEl.removeEventListener('pointerup', onUp)
      handleEl.removeEventListener('pointercancel', onCancel)
      document.body.classList.remove('is-col-resizing')
      if (commit && next !== base) setWidth(key, next)
      else apply(base)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    try { handleEl.setPointerCapture(e.pointerId) } catch { /* указатель уже отпущен */ }
    document.body.classList.add('is-col-resizing')
    handleEl.addEventListener('pointermove', onMove)
    handleEl.addEventListener('pointerup', onUp)
    handleEl.addEventListener('pointercancel', onCancel)
  }, [setWidth])

  const handle = useCallback((key) => ({
    width: widthOf(key),
    onStart: (e) => startResize(key, e),
    onStep: (deltaRem) => setWidth(key, clampWidth(widthOf(key) + deltaRem, minOf(key))),
    onReset: () => setWidth(key, null),
  }), [widthOf, minOf, startResize, setWidth])

  return {
    tableRef,
    tableStyle: { minWidth: `${total}rem` },
    colStyle: (key) => ({ width: `${widthOf(key)}rem` }),
    fits,
    customized: Object.keys(custom).some(k => defaults.has(k)),
    resetAll,
    handle,
  }
}
