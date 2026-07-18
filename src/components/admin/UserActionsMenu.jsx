import { useState, useRef, useEffect } from 'react'

// Меню действий по пользователю (кнопка «три точки»). Опасное действие «Удалить»
// визуально отделено разделителем. Закрывается кликом снаружи и по Escape.
export default function UserActionsMenu({ status, onEdit, onToggleBlock, onDelete }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn) => { setOpen(false); fn?.() }
  const blockLabel = status === 'active' ? 'Заблокировать' : 'Разблокировать'

  return (
    <div className="adm-menu" ref={rootRef}>
      <button
        type="button"
        className={`adm-iconbtn adm-menu-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Действия"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Ещё"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
      </button>
      {open && (
        <div className="adm-menu-pop" role="menu">
          <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onEdit)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Редактировать
          </button>
          <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onToggleBlock)}>
            {status === 'active' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            )}
            {blockLabel}
          </button>
          <div className="adm-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="adm-menu-item adm-menu-danger" onClick={() => run(onDelete)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Удалить
          </button>
        </div>
      )}
    </div>
  )
}
