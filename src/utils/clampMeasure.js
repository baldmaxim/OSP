// Замер «текст не помещается в N строк» — пачкой на всю таблицу.
//
// Чтение scrollHeight заставляет браузер пересчитать раскладку. Пока каждая
// строка мерила себя сама (эффект + свой ResizeObserver), в реестре на 300
// строк получалось 300 таких пересчётов подряд: переключение направления в
// «ВОРах и РД» занимало больше секунды, и 39 % времени профиль показывал
// ровно на `get scrollHeight`.
//
// Здесь все зарегистрированные элементы меряются одним проходом в одном кадре:
// сначала ТОЛЬКО чтения (раскладка считается один раз), потом ТОЛЬКО ответы
// подписчикам. Один ResizeObserver на всех — при смене ширины колонки замер
// просто планируется заново.
import { useLayoutEffect, useRef, useState } from 'react'

const watched = new Map()   // элемент → notify(boolean)
let frame = 0
let observer = null

function measureAll() {
  frame = 0
  const results = []
  // Проход 1 — только чтения.
  for (const [el, notify] of watched) {
    if (!el.isConnected) continue
    if (el.classList.contains('is-expanded')) continue   // раскрытый текст не меряем
    results.push([notify, el.scrollHeight > el.clientHeight + 1])
  }
  // Проход 2 — только записи (React сам сложит их в один перерисовку).
  for (const [notify, value] of results) notify(value)
}

function schedule() {
  if (frame) return
  frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(measureAll)
    : setTimeout(measureAll, 0)
}

// Следить за элементом; возвращает функцию отписки.
export function watchClamp(el, notify) {
  watched.set(el, notify)
  if (typeof ResizeObserver !== 'undefined') {
    if (!observer) observer = new ResizeObserver(schedule)
    observer.observe(el)
  }
  schedule()
  return () => {
    watched.delete(el)
    if (observer) observer.unobserve(el)
  }
}

// Хук для ячейки: [ref на текст, «не помещается»]. deps — то, от чего текст
// зависит (сам текст, число строк): при изменении замер повторяется.
export function useClampOverflow(deps = []) {
  const ref = useRef(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    return watchClamp(el, setOverflows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [ref, overflows]
}
