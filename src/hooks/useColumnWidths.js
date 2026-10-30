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
//   subscribe / isCustomized / resetAll — для ColumnWidthsReset: есть ли свои ширины и сброс всех;
//   handle(key) — для ColumnResizeHandle: ширина, начало перетаскивания, шаг клавишами, сброс столбца.
//
// Скорость (30.10: «автомасштабирование столбцов очень сильно лагает»). Ширина любого столбца меняет перенос текста
// во всех строках, и браузер заново раскладывает таблицу целиком: в «Заявках на ДС» на 400 заявок — 0,13 с раскладки
// на каждое движение мыши, с отрисовкой — 0,3 с (стенд). Поэтому:
//   • пока тянут границу, строки вне экрана скрыты (createRowFreezer): раскладка — 4 мс на шаг вместо 133;
//     отпустили — остальные строки показываются порциями, без заминки. Сворачивание меню так не ускорить:
//     анимация — несколько кадров, а скрыть и показать строки стоит дороже, чем они;
//   • ширина при перетаскивании меняется не чаще раза в кадр;
//   • свои ширины — не состояние React: новая ширина пишется прямо в <col> и min-width таблицы, перерисовываются
//     только границы столбцов и кнопка сброса (ColumnResizeHandle, ColumnWidthsReset), а не весь реестр (0,3 с на
//     400 заявок); страница при своей перерисовке берёт те же значения отсюда.

const rootFontPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
const round = (rem) => Math.round(rem * 1000) / 1000
// Место под таблицу в rem: ширина родителя без полос прокрутки и без его внутренних полей.
function placeRem(box) {
  const cs = getComputedStyle(box)
  const px = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  return px / rootFontPx()
}

// Строки таблицы вне экрана скрыты (ColumnResizeHandle.css, [data-col-frozen]): раскладывается и рисуется только
// видимое. Видимые — строки подряд [from, to], которые пересекают и окно, и место под таблицу, с запасом; место
// скрытых держат соседние с видимыми строки-распорки: пустые, высотой во все скрытые выше / ниже (на момент
// заморозки). Прокрутили или видимые строки стали ниже — видимых больше (sync); строки только добавляются к видимым.
// Верхняя строка на экране стоит на месте, когда меняются ширины (update) и когда показываются строки выше видимых —
// они уже другой высоты (show): поправка прокруткой в том же кадре. Пока тянут границу (hold) — так; отпустили
// (release) — остальные строки показываются порциями в свободное время браузера: все сразу — это заново посчитать
// стили всей таблицы (0,4 с на 400 заявок), заминка дольше прежней. Каждая смена трогает только свои строки: высоты —
// inline у распорок, не переменной на tbody (наследуется — пересчитывались бы все видимые строки).
// Таблица сменила строки (React: данные, вкладка, сортировка) — показывается всё сразу (flush).
const FROZEN_MARGIN_PX = 200
const FROZEN_ATTR = 'data-col-frozen' // у строки: hidden | spacer; у tbody — пока есть скрытые
const THAW_CHUNK = 15 // строк выше и ниже видимых за одну порцию

function scrollParentOf(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement || document.documentElement
}

function createRowFreezer(table) {
  const body = table.tBodies[0]
  const rows = Array.from(body?.rows || [])
  if (rows.length === 0) return null
  // Положение строк от начала tbody — на момент заморозки (сначала только чтения: раскладка — один раз).
  const bodyTop = body.getBoundingClientRect().top
  const tops = []
  const bottoms = []
  for (const tr of rows) {
    const r = tr.getBoundingClientRect()
    tops.push(r.top - bodyTop)
    bottoms.push(r.bottom - bodyTop)
  }
  const scroller = scrollParentOf(table)
  const last = rows.length - 1
  const view = () => {
    const box = table.parentElement.getBoundingClientRect()
    return {
      top: Math.max(box.top, 0) - FROZEN_MARGIN_PX,
      bottom: Math.min(box.bottom, window.innerHeight) + FROZEN_MARGIN_PX,
    }
  }

  // Видимые сейчас.
  const v = view()
  let from = bottoms.findIndex(y => y + bodyTop >= v.top)
  if (from < 0) from = last
  let to = from
  while (to < last && tops[to + 1] + bodyTop <= v.bottom) to++

  const roles = new Array(rows.length).fill('shown')
  const heights = rows.map(tr => tr.style.height) // свои inline-высоты строк — вернуть после распорки
  const place = (i) => {
    const role = i >= from && i <= to ? 'shown' : i === from - 1 || i === to + 1 ? 'spacer' : 'hidden'
    if (roles[i] === role) return
    const tr = rows[i]
    if (role === 'shown') tr.removeAttribute(FROZEN_ATTR)
    else tr.setAttribute(FROZEN_ATTR, role)
    tr.style.height = role === 'spacer'
      ? `${i < from ? tops[from] : bottoms[last] - tops[i]}px`
      : heights[i]
    roles[i] = role
  }
  rows.forEach((_, i) => place(i))
  body.setAttribute(FROZEN_ATTR, '')

  let held = false
  let done = false
  let frame = 0
  let idle = 0
  // anchor после fn() должна стоять там же, где до.
  const keep = (anchor, fn) => {
    const before = anchor.getBoundingClientRect().top
    fn()
    const shift = anchor.getBoundingClientRect().top - before
    if (Math.abs(shift) >= 0.5) scroller.scrollTop += shift
  }
  const show = (a, b) => {
    a = Math.min(a, from)
    b = Math.max(b, to)
    if (a === from && b === to) return
    const [oldFrom, oldTo] = [from, to]
    const reveal = () => {
      from = a
      to = b
      for (let i = Math.max(0, a - 1); i < oldFrom; i++) place(i)
      for (let i = oldTo + 1; i <= Math.min(last, b + 1); i++) place(i)
    }
    // Видимые строки сдвигаются вместе — держим первую.
    if (a < oldFrom) keep(rows[oldFrom], reveal)
    else reveal()
  }
  // Видимых не хватает до краёв окна (прокрутили, строки стали ниже) — добавить по прежним высотам скрытых.
  const sync = () => {
    frame = 0
    if (done) return
    const { top, bottom } = view()
    let a = from
    let y = rows[from].getBoundingClientRect().top
    while (a > 0 && y > top) { a--; y -= bottoms[a] - tops[a] }
    let b = to
    y = rows[to].getBoundingClientRect().bottom
    while (b < last && y < bottom) { b++; y += bottoms[b] - tops[b] }
    show(a, b)
  }
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync) }
  // Меняются ширины (fn): верхняя строка на экране — на месте, видимых — до краёв окна.
  const update = (fn) => {
    if (done) { fn(); return }
    const top = Math.max(table.parentElement.getBoundingClientRect().top, 0)
    let anchor = to
    for (let i = from; i < to; i++) {
      if (rows[i].getBoundingClientRect().bottom > top) { anchor = i; break }
    }
    keep(rows[anchor], fn)
    sync()
  }
  const dispose = () => {
    done = true
    cancelAnimationFrame(frame)
    if (idle) (window.cancelIdleCallback || clearTimeout)(idle)
    idle = 0
    document.removeEventListener('scroll', onScroll, { capture: true })
    mutations.disconnect()
  }
  const finish = () => {
    dispose()
    body.removeAttribute(FROZEN_ATTR)
  }
  const thawStep = () => {
    idle = 0
    if (done || held) return
    show(Math.max(0, from - THAW_CHUNK), Math.min(last, to + THAW_CHUNK))
    if (from === 0 && to === last) finish()
    else schedule()
  }
  const schedule = () => {
    if (idle || done) return
    idle = window.requestIdleCallback ? window.requestIdleCallback(thawStep, { timeout: 300 }) : setTimeout(thawStep, 30)
  }
  const flush = () => {
    if (done) return
    show(0, last)
    finish()
  }
  // Строки таблицы сменились — прежние высоты и порядок уже не те.
  const mutations = new MutationObserver(flush)
  mutations.observe(body, { childList: true })
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })

  return {
    table,
    get done() { return done },
    update,
    hold() { held = true },
    release() { held = false; schedule() },
    flush,
    dispose,
  }
}

export default function useColumnWidths(storageKey, columns) {
  const custom = useRef(null)
  if (custom.current === null) custom.current = readColumnWidths(storageKey)
  const defaults = useMemo(() => new Map(columns.map(c => [c.key, c])), [columns])
  // Свежие столбцы для обработчиков, заведённых раньше.
  const live = useRef(null)
  live.current = { columns, defaults }

  const widthOf = useCallback((key) => (
    custom.current[key] ?? live.current.defaults.get(key)?.rem ?? COLUMN_WIDTH_MIN
  ), [])
  const minOf = useCallback((key) => {
    const c = live.current.defaults.get(key)
    return c?.min ?? Math.min(c?.rem ?? COLUMN_WIDTH_MIN, COLUMN_WIDTH_MIN)
  }, [])
  const totalOf = useCallback(() => round(live.current.columns.reduce((s, c) => s + widthOf(c.key), 0)), [widthOf])
  const isCustomized = useCallback(() => Object.keys(custom.current).some(k => live.current.defaults.has(k)), [])
  const total = totalOf()

  // Подписчики на смену ширин: границы столбцов и кнопка сброса.
  const listeners = useRef(new Set())
  const subscribe = useCallback((fn) => {
    listeners.current.add(fn)
    return () => listeners.current.delete(fn)
  }, [])

  // Помещается ли таблица: место под неё меряем при каждом изменении размера (окно, свёрнутое меню), сумму —
  // при каждой смене ширин.
  const tableEl = useRef(null)
  const observer = useRef(null)
  const place = useRef(null)
  const [fits, setFits] = useState(false)
  const checkFits = useCallback(() => {
    if (place.current != null) setFits(place.current >= totalOf() - 0.01)
  }, [totalOf])

  const measure = useCallback(() => {
    const box = tableEl.current?.parentElement
    if (!box) return
    place.current = placeRem(box)
    checkFits()
  }, [checkFits])
  // Строки вне экрана, скрытые на время перетаскивания (createRowFreezer); после — показываются фоном.
  // Таблица ушла со страницы — React вызывает tableRef(null): наблюдатели снимаются здесь, отдельного эффекта нет
  // (в StrictMode его пробная очистка отключала бы наблюдатель насовсем).
  const freezer = useRef(null)
  const tableRef = useCallback((node) => {
    observer.current?.disconnect()
    observer.current = null
    if (freezer.current && freezer.current.table !== node) {
      freezer.current.dispose()
      freezer.current = null
    }
    tableEl.current = node
    place.current = null
    const box = node?.parentElement
    if (!box) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure)
      observer.current.observe(box)
    }
  }, [measure])
  useEffect(() => { checkFits() }, [total, checkFits])

  // Новые ширины — сразу в таблицу, без перерисовки страницы.
  const commit = useCallback((next) => {
    custom.current = next
    writeColumnWidths(storageKey, next)
    const table = tableEl.current
    const paint = () => {
      for (const c of live.current.columns) {
        const col = table.querySelector(`col[data-col="${c.key}"]`)
        if (col) col.style.width = `${widthOf(c.key)}rem`
      }
      table.style.minWidth = `${totalOf()}rem`
    }
    if (table && freezer.current?.table === table) freezer.current.update(paint)
    else if (table) paint()
    checkFits()
    for (const fn of listeners.current) fn()
  }, [storageKey, widthOf, totalOf, checkFits])

  const setWidth = useCallback((key, rem) => {
    const next = { ...custom.current }
    const def = live.current.defaults.get(key)?.rem
    if (rem == null || (def != null && Math.abs(rem - def) < 0.01)) delete next[key]
    else next[key] = rem
    commit(next)
  }, [commit])

  const resetAll = useCallback(() => commit({}), [commit])

  const startResize = useCallback((key, e) => {
    if (e.button !== 0) return
    const table = tableEl.current
    const col = table?.querySelector(`col[data-col="${key}"]`)
    if (!table || !col) return
    e.preventDefault()
    e.stopPropagation()
    const handleEl = e.currentTarget
    const sum = totalOf()
    const rootPx = rootFontPx()
    const container = placeRem(table.parentElement)
    const base = widthOf(key)
    const min = minOf(key)
    const startShown = shownWidth({ base, sum, container })
    const startX = e.clientX
    let x = startX
    let next = base
    let frame = 0
    let done = false
    // С первым движением строки вне экрана скрываются, а месту под таблицу разрешается прокрутка (класс на body:
    // сменить прокрутку — разложить таблицу заново, поэтому — после скрытия строк). Щелчок и двойной щелчок — без этого.
    let moved = false
    let rows = null
    const apply = (rem) => {
      col.style.width = `${rem}rem`
      table.style.minWidth = `${round(sum - base + rem)}rem`
    }
    const step = () => {
      frame = 0
      if (!moved) {
        moved = true
        if (!freezer.current || freezer.current.done || freezer.current.table !== table) {
          freezer.current = createRowFreezer(table)
        }
        rows = freezer.current
        rows?.hold()
        document.body.classList.add('is-col-resizing')
      }
      const target = startShown + (x - startX) / rootPx
      next = clampWidth(resizedWidth({ base, sum, container, target }), min)
      if (rows) rows.update(() => apply(next))
      else apply(next)
    }
    const onMove = (ev) => {
      if (ev.clientX === x) return
      x = ev.clientX
      if (!frame) frame = requestAnimationFrame(step)
    }
    const finish = (commitIt) => {
      if (done) return
      done = true
      if (frame) {
        cancelAnimationFrame(frame)
        if (commitIt) step()
      }
      handleEl.removeEventListener('pointermove', onMove)
      handleEl.removeEventListener('pointerup', onUp)
      handleEl.removeEventListener('pointercancel', onCancel)
      handleEl.removeEventListener('lostpointercapture', onCancel)
      document.body.classList.remove('is-col-resizing')
      handleEl.removeAttribute('data-dragging')
      veil.remove()
      rows?.release()
      if (commitIt && next !== base) {
        setWidth(key, next)
      } else if (rows) {
        rows.update(() => apply(base))
      } else {
        apply(base)
      }
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    try { handleEl.setPointerCapture(e.pointerId) } catch { return /* указатель уже отпущен — тянуть нечего */ }
    handleEl.setAttribute('data-dragging', '')
    const veil = document.createElement('div')
    veil.className = 'col-resize-veil'
    document.body.append(veil)
    handleEl.addEventListener('pointermove', onMove)
    handleEl.addEventListener('pointerup', onUp)
    handleEl.addEventListener('pointercancel', onCancel)
    handleEl.addEventListener('lostpointercapture', onCancel)
  }, [totalOf, widthOf, minOf, setWidth])

  const handle = (key) => ({
    subscribe,
    getWidth: () => widthOf(key),
    onStart: (e) => startResize(key, e),
    onStep: (deltaRem) => setWidth(key, clampWidth(widthOf(key) + deltaRem, minOf(key))),
    onReset: () => setWidth(key, null),
  })

  return {
    tableRef,
    tableStyle: { minWidth: `${total}rem` },
    colStyle: (key) => ({ width: `${widthOf(key)}rem` }),
    fits,
    subscribe,
    isCustomized,
    resetAll,
    handle,
  }
}
