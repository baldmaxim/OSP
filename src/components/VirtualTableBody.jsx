import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'

// task 410: лёгкая виртуализация <tbody> больших таблиц БЕЗ внешних зависимостей.
//
// `rows` — массив уже готовых элементов <tr> (по одному на ВИДИМУЮ строку; свёрнутые
// разделы в массив не попадают — это делает вызывающая таблица). Рендерим только окно
// строк вокруг вьюпорта + спейсеры-«пустышки» сверху/снизу, чтобы в DOM было ~десятки
// строк, а не тысячи.
//
// ВЫСОТЫ СТРОК ИЗМЕРЯЮТСЯ. Раньше высота считалась фиксированной (`rowHeight`), и на
// таблицах с разной высотой строк (ВОР: длинные наименования переносятся, есть строки
// разделов и заголовки документов) это давало «штробление» — строки прыгали сами по себе:
//   распорка padTop = start * rowHeight не совпадала с реальной высотой контента →
//   при сдвиге окна менялась высота над вьюпортом → браузерное scroll anchoring
//   переписывало scrollTop → это порождало событие scroll → пересчёт окна → другие
//   строки → другая высота → цикл на каждом кадре.
// Теперь `rowHeight` — лишь стартовая ОЦЕНКА для ещё не измеренных строк, а распорки
// считаются по префиксным суммам реальных высот. Дополнительно у скролл-контейнера
// отключено scroll anchoring (`overflow-anchor: none` в CSS) — это разрывает цикл.
//
// Скролл-контейнер передаётся через `scrollRef` (тот <div>, что оборачивает <table>
// и имеет overflow-y:auto). Подписка на scroll живёт здесь, поэтому при прокрутке
// перерисовывается только этот компонент, а не вся (тяжёлая) родительская таблица.
//
// Вместо готового массива `rows` можно передать `rowCount` + `renderRow(index)`: тогда
// элементы создаются только для окна. Для таблиц «позиции × контрагенты» это разница
// между сотнями тысяч JSX-ячеек на каждую перерисовку и несколькими сотнями.
//
// `viewport` — таблица без своей прокрутки (реестр в прокручиваемой .main-content или окне):
// окно строк считается по положению <tbody> относительно экрана, прокрутку ловит любой
// предок (scroll с захватом на document). Строки такого <tbody> не служат якорем прокрутки
// (overflow-anchor: none) — по той же причине, что выше.
export default function VirtualTableBody({ rows, rowCount, renderRow, colSpan, scrollRef, viewport = false, rowHeight = 40, overscan = 14 }) {
  const count = rows ? rows.length : (rowCount || 0)
  const tbodyRef = useRef(null)
  const heightsRef = useRef([])      // высота каждой строки: измеренная или оценочная
  const offsetsRef = useRef([0])     // префиксные суммы: offsets[i] — верх строки i
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, 80) }))
  const [version, setVersion] = useState(0)

  const rebuildOffsets = useCallback(() => {
    const h = heightsRef.current
    const off = new Array(count + 1)
    off[0] = 0
    for (let i = 0; i < count; i++) off[i + 1] = off[i] + (h[i] || rowHeight)
    offsetsRef.current = off
  }, [count, rowHeight])

  // Подгоняем массив высот под текущий набор строк, сохраняя уже измеренные значения.
  useLayoutEffect(() => {
    const prev = heightsRef.current
    const next = new Array(count)
    for (let i = 0; i < count; i++) next[i] = prev[i] || rowHeight
    heightsRef.current = next
    rebuildOffsets()
    setVersion(v => v + 1)
  }, [count, rowHeight, rebuildOffsets])

  const compute = useCallback(() => {
    const off = offsetsRef.current
    if (off.length !== count + 1) return
    let top
    let vh
    if (viewport) {
      const tb = tbodyRef.current
      if (!tb) return
      top = Math.max(0, -tb.getBoundingClientRect().top)
      vh = window.innerHeight || 800
    } else {
      const el = scrollRef?.current
      if (!el) return
      top = el.scrollTop
      vh = el.clientHeight || 800
    }
    // Бинарный поиск первой строки, попадающей во вьюпорт (высоты разные — деление не годится).
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (off[mid + 1] <= top) lo = mid + 1
      else hi = mid
    }
    let end = lo
    while (end < count && off[end] < top + vh) end++
    const nextStart = Math.max(0, lo - overscan)
    const nextEnd = Math.min(count, end + overscan)
    setRange(prev => (prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd }))
  }, [scrollRef, viewport, count, overscan])

  useEffect(() => {
    if (viewport) {
      let raf = 0
      const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute) }
      compute()
      document.addEventListener('scroll', onScroll, { capture: true, passive: true })
      window.addEventListener('resize', onScroll)
      return () => {
        cancelAnimationFrame(raf)
        document.removeEventListener('scroll', onScroll, { capture: true })
        window.removeEventListener('resize', onScroll)
      }
    }
    const el = scrollRef?.current
    if (!el) { setRange({ start: 0, end: count }); return }
    let raf = 0
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute) }
    compute()
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [scrollRef, viewport, count, compute, version])

  // Измеряем реальные высоты отрисованных строк — только при смене окна или набора
  // строк (setVersion в deps нет, поэтому цепочка обновлений не зацикливается:
  // коррекция высот перерисовывает распорки, но повторного замера не вызывает).
  useLayoutEffect(() => {
    const tb = tbodyRef.current
    if (!tb) return
    const h = heightsRef.current
    let i = Math.min(range.start, count)
    let changed = false
    for (const child of tb.children) {
      if (child.classList.contains('vt-spacer')) continue
      if (i >= count) break
      const real = child.offsetHeight
      if (real > 0 && Math.abs((h[i] || 0) - real) >= 1) {
        h[i] = real
        changed = true
      }
      i++
    }
    if (changed) {
      rebuildOffsets()
      setVersion(v => v + 1)
    }
  }, [range.start, range.end, count, rebuildOffsets])

  const start = Math.min(range.start, count)
  const end = Math.min(range.end, count)
  const off = offsetsRef.current
  const ready = off.length === count + 1
  const padTop = ready ? off[start] : start * rowHeight
  const padBottom = ready ? Math.max(0, off[count] - off[end]) : Math.max(0, (count - end) * rowHeight)

  return (
    <tbody ref={tbodyRef} style={viewport ? { overflowAnchor: 'none' } : undefined}>
      {padTop > 0 && (
        <tr aria-hidden className="vt-spacer">
          <td colSpan={colSpan} style={{ height: padTop, padding: 0, border: 0 }} />
        </tr>
      )}
      {rows
        ? rows.slice(start, end)
        : Array.from({ length: Math.max(0, end - start) }, (_, k) => renderRow(start + k))}
      {padBottom > 0 && (
        <tr aria-hidden className="vt-spacer">
          <td colSpan={colSpan} style={{ height: padBottom, padding: 0, border: 0 }} />
        </tr>
      )}
    </tbody>
  )
}
