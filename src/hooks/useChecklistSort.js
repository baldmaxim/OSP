import { useEffect, useRef, useState } from 'react'

// Перестановка строк чек-листа ручкой: указателем (мышь, палец, перо — HTML5-перетаскивание на телефоне не работает) и
// стрелками ↑ ↓ с клавиатуры. Общая для чек-листа задачи и шагов заявки на проверку ДП/ДС.
//
// Строки списка — li[data-item-id]. onReorder(перетащенный, цель, 'before' | 'after') сохраняет порядок и возвращает
// промис; handleSelector — селектор ручки внутри строки: после перестановки с клавиатуры фокус возвращается на неё.
// Отдаёт drag ({ id, overId, position } — для подсветки), listRef (на <ul>) и handleProps(строка) (на кнопку-ручку).

// Ближайший прокручиваемый предок: область, которую надо двигать, когда палец у её края.
function scrollParentOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

// Автопрокрутка при перетаскивании пункта: зона у края области прокрутки и
// наибольший шаг за кадр (у самого края — быстрее).
const AUTOSCROLL_ZONE = 56
const AUTOSCROLL_MAX_STEP = 16

export default function useChecklistSort({ items, onReorder, handleSelector }) {
  // Ref — для отпускания: обработчик видит последнее место, а не прошлую отрисовку.
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const listRef = useRef(null)
  // Палец у края области прокрутки: { y, frame } — последняя высота указателя и кадр.
  const autoScrollRef = useRef({ y: 0, frame: 0 })

  // Место вставки — по строке под указателем: верхняя половина — перед ней, нижняя — после.
  const dropPlace = (clientY) => {
    const rows = [...(listRef.current?.querySelectorAll('li[data-item-id]') || [])]
    if (!rows.length) return null
    const first = rows[0].getBoundingClientRect()
    if (clientY < first.top) return { overId: rows[0].dataset.itemId, position: 'before' }
    for (const li of rows) {
      const rect = li.getBoundingClientRect()
      if (clientY <= rect.bottom) {
        return { overId: li.dataset.itemId, position: clientY - rect.top < rect.height / 2 ? 'before' : 'after' }
      }
    }
    return { overId: rows[rows.length - 1].dataset.itemId, position: 'after' }
  }
  const setDragState = (next) => {
    dragRef.current = next
    setDrag(next)
  }
  const updateDropPlace = (clientY) => {
    const cur = dragRef.current
    if (!cur) return
    const place = dropPlace(clientY)
    if (!place) return
    // Над самим перетаскиваемым пунктом — не вставка, а «на месте».
    const next = place.overId === cur.id ? { ...cur, overId: null, position: null } : { ...cur, ...place }
    if (next.overId !== cur.overId || next.position !== cur.position) setDragState(next)
  }
  // Палец держат у верхнего или нижнего края области прокрутки — карточка едет
  // сама, место вставки пересчитывается: на телефоне чек-лист длиннее экрана,
  // и без этого пункт не дотащить за видимый край. Цикл кадров идёт, пока
  // указатель в зоне и есть куда прокручивать; только рефы — замыкание не стареет.
  const autoScrollStep = () => {
    const state = autoScrollRef.current
    state.frame = 0
    const box = dragRef.current && scrollParentOf(listRef.current)
    if (!box) return
    const rect = box.getBoundingClientRect()
    const zone = Math.min(AUTOSCROLL_ZONE, rect.height / 4)
    const depth = state.y < rect.top + zone ? state.y - (rect.top + zone)
      : state.y > rect.bottom - zone ? state.y - (rect.bottom - zone) : 0
    if (!depth) return
    const step = Math.sign(depth) * Math.min(AUTOSCROLL_MAX_STEP, Math.ceil((Math.abs(depth) / zone) * AUTOSCROLL_MAX_STEP))
    const before = box.scrollTop
    box.scrollTop = before + step
    if (box.scrollTop === before) return
    updateDropPlace(state.y)
    state.frame = requestAnimationFrame(autoScrollStep)
  }
  const stopAutoScroll = () => {
    cancelAnimationFrame(autoScrollRef.current.frame)
    autoScrollRef.current.frame = 0
  }
  // Карточку закрыли посреди перетаскивания — кадр не должен пережить окно.
  useEffect(() => {
    const state = autoScrollRef.current
    return () => cancelAnimationFrame(state.frame)
  }, [])

  const handleProps = (item) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      setDragState({ id: item.id, overId: null, position: null })
    },
    onPointerMove: (e) => {
      if (!dragRef.current) return
      updateDropPlace(e.clientY)
      autoScrollRef.current.y = e.clientY
      if (!autoScrollRef.current.frame) autoScrollRef.current.frame = requestAnimationFrame(autoScrollStep)
    },
    onPointerUp: () => {
      const cur = dragRef.current
      stopAutoScroll()
      setDragState(null)
      if (cur?.overId) onReorder(cur.id, cur.overId, cur.position)
    },
    onPointerCancel: () => { stopAutoScroll(); setDragState(null) },
    // С клавиатуры: стрелки вверх / вниз на ручке переставляют пункт на одно место.
    onKeyDown: (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const idx = items.findIndex(i => i.id === item.id)
      const up = e.key === 'ArrowUp'
      const target = items[up ? idx - 1 : idx + 1]
      if (!target) return
      onReorder(item.id, target.id, up ? 'before' : 'after').then(() => {
        listRef.current?.querySelector(`li[data-item-id="${item.id}"] ${handleSelector}`)?.focus()
      })
    },
  })

  return { drag, listRef, handleProps }
}
