import { useState, useEffect } from 'react'

// task 410: лёгкая виртуализация <tbody> больших таблиц БЕЗ внешних зависимостей.
//
// `rows` — массив уже готовых элементов <tr> (по одному на ВИДИМУЮ строку; свёрнутые
// разделы в массив не попадают — это делает вызывающая таблица). Рендерим только окно
// строк вокруг вьюпорта + спейсеры-«пустышки» сверху/снизу, чтобы в DOM было ~десятки
// строк, а не тысячи. Высота строки фиксированная (`rowHeight`) — для почти однородных
// строк этого достаточно; небольшие расхождения сглаживает `overscan`.
//
// Скролл-контейнер передаётся через `scrollRef` (тот <div>, что оборачивает <table>
// и имеет overflow-y:auto). Подписка на scroll живёт здесь, поэтому при прокрутке
// перерисовывается только этот компонент, а не вся (тяжёлая) родительская таблица.
export default function VirtualTableBody({ rows, colSpan, scrollRef, rowHeight = 40, overscan = 14 }) {
  const count = rows.length
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, 80) }))

  useEffect(() => {
    const el = scrollRef?.current
    if (!el) { setRange({ start: 0, end: count }); return }
    let raf = 0
    const compute = () => {
      const top = el.scrollTop
      const vh = el.clientHeight || 800
      const start = Math.max(0, Math.floor(top / rowHeight) - overscan)
      const end = Math.min(count, Math.ceil((top + vh) / rowHeight) + overscan)
      setRange(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute) }
    compute()
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [scrollRef, count, rowHeight, overscan])

  const start = Math.min(range.start, count)
  const end = Math.min(range.end, count)
  const padTop = start * rowHeight
  const padBottom = Math.max(0, (count - end) * rowHeight)

  return (
    <tbody>
      {padTop > 0 && (
        <tr aria-hidden className="vt-spacer">
          <td colSpan={colSpan} style={{ height: padTop, padding: 0, border: 0 }} />
        </tr>
      )}
      {rows.slice(start, end)}
      {padBottom > 0 && (
        <tr aria-hidden className="vt-spacer">
          <td colSpan={colSpan} style={{ height: padBottom, padding: 0, border: 0 }} />
        </tr>
      )}
    </tbody>
  )
}
