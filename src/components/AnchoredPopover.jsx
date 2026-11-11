import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './AnchoredPopover.css'

// Небольшое окно у кнопки в ячейке таблицы (11.11.2026, реестр договоров: пути документа и понятийное соглашение
// свернуты в значки, их правка и список файлов — здесь). Рисуется в <body> (position: fixed), чтобы не обрезалось
// прокруткой таблицы: под кнопкой, а не помещается — над ней; при прокрутке едет вместе с кнопкой.
// Закрывается Escape (фокус — обратно на кнопку) и нажатием мимо окна и кнопки, если canClose() не против —
// например, в поле уже что-то набрано: тогда закрывают «Отмена» или Escape, набранное случайно не пропадает.
// Нажатия внутри окна не доходят до строки таблицы (React проводит события порталов через родителей).
const GAP = 4
const EDGE = 8

export default function AnchoredPopover({ anchor, onClose, canClose, label, className = '', children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const closeRef = useRef({ onClose, canClose })
  closeRef.current = { onClose, canClose }

  useLayoutEffect(() => {
    if (!anchor) return undefined
    let raf = 0
    const place = () => {
      raf = 0
      const el = ref.current
      if (!el) return
      const r = anchor.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.round(Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE)))
      const below = r.bottom + GAP
      const fitsBelow = below + h <= window.innerHeight - EDGE
      const top = Math.round(fitsBelow || r.top - GAP - h < EDGE ? below : r.top - GAP - h)
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }))
    }
    place()
    const onMove = () => { if (!raf) raf = requestAnimationFrame(place) }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    // Высота окна меняется (сообщение об ошибке, «Загрузка…») — положение пересчитывается.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onMove) : null
    if (ro && ref.current) ro.observe(ref.current)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      ro?.disconnect()
    }
  }, [anchor])

  useEffect(() => {
    if (!anchor) return undefined
    const onPointer = (e) => {
      if (ref.current?.contains(e.target) || anchor.contains(e.target)) return
      const { onClose: close, canClose: allowed } = closeRef.current
      if (!allowed || allowed()) close()
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current.onClose()
      if (anchor.isConnected) anchor.focus()
    }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor])

  if (!anchor) return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`apop ${className}`.trim()}
      // До первого замера — прозрачное, а не visibility: hidden: скрытое так поле не берёт autoFocus (React ставит фокус
      // раньше, чем это окно успевает встать на место). Замер — до отрисовки, мигания нет.
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
