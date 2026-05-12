import { useEffect, useRef, useState } from 'react'
import './StatusDropdown.css'

function StatusDropdown({ value, options, onChange, getBadgeClass, getDisplay, ariaLabel = 'Статус' }) {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    const onDocMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  const currentClass = getBadgeClass(value)
  const display = getDisplay ? getDisplay(value) : value

  return (
    <div ref={rootRef} className={`status-dropdown ${isOpen ? 'open' : ''}`}>
      <button
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
      {isOpen && (
        <ul className="status-dropdown-menu" role="listbox">
          {options.map((opt) => {
            const isActive = opt === value
            return (
              <li
                key={opt}
                role="option"
                aria-selected={isActive}
                className={`status-dropdown-option ${isActive ? 'active' : ''}`}
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
        </ul>
      )}
    </div>
  )
}

export default StatusDropdown
