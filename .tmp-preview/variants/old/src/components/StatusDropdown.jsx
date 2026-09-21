import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './StatusDropdown.css'

// colorOptions — раскрашивать не только точку, но и саму строку списка (класс
// статуса уезжает на <li>). По умолчанию выключено: на страницах договоров и
// заявок классы статусов заданы «голыми» правилами с собственными паддингами и
// рамками, и такая строка поехала бы вёрсткой.
function StatusDropdown({ value, options, onChange, getBadgeClass, getDisplay, ariaLabel = 'Статус', colorOptions = false }) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 })
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  // Позиционируем меню относительно триггера (фиксированные координаты — не обрезаются overflow родителей).
  // Если внизу мало места — раскрываем меню вверх, чтобы оно не уходило за экран.
  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - r.bottom
    const spaceAbove = r.top
    // Оцениваем высоту меню по числу опций (примерно 32px на строку + паддинги).
    const estimatedMenuH = Math.min(320, options.length * 32 + 16)
    const openUp = spaceBelow < estimatedMenuH + 12 && spaceAbove > spaceBelow
    // Если у меню уже есть реальная высота (после первого рендера) — используем её.
    const actualH = menuRef.current?.offsetHeight || estimatedMenuH
    const top = openUp
      ? Math.max(8, r.top - actualH - 4)
      : r.bottom + 4
    setMenuPos({ top, left: r.left, width: r.width })
  }, [options.length])

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition()
      // Второй проход после рендера меню — теперь у нас есть фактическая высота.
      requestAnimationFrame(updatePosition)
    }
  }, [isOpen, updatePosition])

  useEffect(() => {
    if (!isOpen) return
    const onDocMouseDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setIsOpen(false)
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    const onScrollOrResize = () => updatePosition()
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [isOpen, updatePosition])

  const currentClass = getBadgeClass(value)
  const display = getDisplay ? getDisplay(value) : value

  return (
    <div className={`status-dropdown ${isOpen ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`status-dropdown-trigger ${currentClass}`}
        onClick={() => setIsOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
      >
        <span className="status-dropdown-label">{display}</span>
        <span className="status-dropdown-chevron" aria-hidden>▾</span>
      </button>
      {isOpen && createPortal(
        <ul
          ref={menuRef}
          className="status-dropdown-menu status-dropdown-menu-portal"
          role="listbox"
          style={{ top: menuPos.top, left: menuPos.left, minWidth: Math.max(menuPos.width, 220) }}
        >
          {options.map((opt) => {
            const isActive = opt === value
            return (
              <li
                key={opt}
                role="option"
                aria-selected={isActive}
                className={`status-dropdown-option${isActive ? ' active' : ''}${colorOptions ? ` is-colored ${getBadgeClass(opt)}` : ''}`}
                onClick={() => {
                  if (opt !== value) onChange(opt)
                  setIsOpen(false)
                }}
              >
                <span className={`status-dropdown-dot ${getBadgeClass(opt)}`} aria-hidden />
                <span className="status-dropdown-option-label">{opt}</span>
                {isActive && <span className="status-dropdown-check" aria-hidden>✓</span>}
              </li>
            )
          })}
        </ul>,
        document.body
      )}
    </div>
  )
}

export default StatusDropdown
