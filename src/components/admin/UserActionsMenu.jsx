import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Меню действий по пользователю (кнопка «три точки»). Опасное действие «Удалить»
// визуально отделено разделителем. Закрывается кликом снаружи и по Escape.
// onSetStatus(next) — 'active' | 'blocked'. Приглашённого можно и подтвердить, и
// заблокировать сразу — раньше был только один пункт, и заблокировать того, кто
// ни разу не входил, было нельзя.
// onConfirmEmail — только у тех, кто не подтвердил почту (иначе null).
// onResetPassword — свой вход (tender.su10.ru): временный пароль от администратора (иначе null).
// onUnlinkSso — вход через СУ-10: снять связь с учёткой СУ-10 (иначе null).
//
// Меню рисуется в <body> (position: fixed), а не внутри ячейки (12.11.2026): таблица пользователей лежит в блоке
// с горизонтальной прокруткой, и он обрезал меню — при одной-двух строках (поиск) от меню оставалась полоска
// «Редактировать» и лишняя полоса прокрутки. Встаёт под кнопкой правым краем к её правому краю, не помещается
// снизу — над ней; при прокрутке едет вместе с кнопкой.
const GAP = 4
const EDGE = 8

export default function UserActionsMenu({ status, onEdit, onSetStatus, onDelete, onConfirmEmail = null, onResetPassword = null, onUnlinkSso = null }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const rootRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)

  useLayoutEffect(() => {
    if (!open) return undefined
    let raf = 0
    const place = () => {
      raf = 0
      const btn = btnRef.current
      const pop = popRef.current
      if (!btn || !pop) return
      const r = btn.getBoundingClientRect()
      // Кнопку унесло прокруткой за край окна — меню закрывается, а не висит отдельно от строки.
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return }
      const w = pop.offsetWidth
      const h = pop.offsetHeight
      const left = Math.round(Math.max(EDGE, Math.min(r.right - w, window.innerWidth - w - EDGE)))
      const below = r.bottom + GAP
      const above = r.top - GAP - h
      const top = Math.round(below + h <= window.innerHeight - EDGE || above < EDGE ? below : above)
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }))
    }
    place()
    const onMove = () => { if (!raf) raf = requestAnimationFrame(place) }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn) => { setOpen(false); fn?.() }
  const IconBlock = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>
  )
  const IconCheck = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
  )

  return (
    <div className="adm-menu" ref={rootRef}>
      <button
        ref={btnRef}
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
      {open && createPortal(
        <div
          ref={popRef}
          className="adm-menu-pop"
          role="menu"
          // До замера — прозрачное, замер — до отрисовки, мигания нет.
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
        >
          <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onEdit)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Редактировать
          </button>
          {onConfirmEmail && (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onConfirmEmail)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
              Подтвердить e-mail
            </button>
          )}
          {onResetPassword && (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onResetPassword)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
              Сбросить пароль
            </button>
          )}
          {onUnlinkSso && (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(onUnlinkSso)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 4 8" /><path d="M2 2l20 20" /></svg>
              Отвязать от СУ-10
            </button>
          )}
          {status === 'pending' && (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(() => onSetStatus('active'))}>
              <IconCheck /> Подтвердить доступ
            </button>
          )}
          {status === 'blocked' ? (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(() => onSetStatus('active'))}>
              <IconCheck /> Разблокировать
            </button>
          ) : (
            <button type="button" role="menuitem" className="adm-menu-item" onClick={() => run(() => onSetStatus('blocked'))}>
              <IconBlock /> Заблокировать
            </button>
          )}
          <div className="adm-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="adm-menu-item adm-menu-danger" onClick={() => run(onDelete)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Удалить
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
