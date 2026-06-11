import { useState, useRef, useEffect } from 'react'
import './RowActionsMenu.css'

// Компактное меню действий строки («⋮» → Редактировать / Удалить).
//   Меню позиционируется fixed по координатам кнопки, поэтому НЕ обрезается
//   overflow:hidden ячейки таблицы и не двигает layout. Закрывается по
//   click-outside / Escape / скроллу.
export default function RowActionsMenu({ onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const toggle = (e) => {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    const r = triggerRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
    setOpen(true)
  }

  const run = (e, fn) => { e.stopPropagation(); setOpen(false); fn() }

  return (
    <div className="ram" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className="ram-trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Действия"
      >⋮</button>
      {open && pos && (
        <div className="ram-menu" role="menu" style={{ position: 'fixed', top: pos.top, right: pos.right }}>
          <button type="button" className="ram-item" role="menuitem" onClick={(e) => run(e, onEdit)}>
            <span aria-hidden>✏️</span> Редактировать
          </button>
          <button type="button" className="ram-item ram-item-danger" role="menuitem" onClick={(e) => run(e, onDelete)}>
            <span aria-hidden>🗑️</span> Удалить
          </button>
        </div>
      )}
    </div>
  )
}
