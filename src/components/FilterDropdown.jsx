import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import './FilterDropdown.css'

// Лёгкий кастомный фильтр-дропдаун (combobox) в стиле проекта.
//   - триггер «Метка Значение ▾» со скруглением и состояниями hover/focus/active;
//   - popover рендерится через PORTAL в document.body и позиционируется fixed по
//     координатам триггера → не зависит от высоты рабочей карточки, не обрезается
//     overflow родителей и не «уходит» за контейнер при пустой таблице;
//   - auto-placement: если снизу мало места — раскрывается вверх; по горизонтали —
//     прижимается вправо у правого края; список со своим max-height и скроллом;
//   - опционально встроенный поиск; click-outside / Escape / scroll закрывают.
// options: [{ value, label }]. «Все» — опция со значением '' или 'all'.
export default function FilterDropdown({
  label,
  value,
  onChange,
  options,
  searchable = false,
  searchPlaceholder = 'Поиск…',
  disabled = false,
  allLabel = 'Все',
  // Необязательно: как показать ВЫБРАННОЕ значение в триггере (напр. краткое ФИО).
  // Список опций и title всегда показывают полный label.
  formatTrigger = null,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [coords, setCoords] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)

  const selectedLabel = useMemo(() => {
    const found = options.find(o => String(o.value) === String(value))
    return found ? found.label : allLabel
  }, [options, value, allLabel])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => String(o.label).toLowerCase().includes(q))
  }, [options, query])

  const isActive = value !== '' && value !== 'all' && value != null

  // Считаем позицию panel'а относительно вьюпорта (для position: fixed).
  const computeCoords = () => {
    const el = rootRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const PANEL_W = Math.min(340, vw - 24)
    const spaceBelow = vh - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < 320 && spaceAbove > spaceBelow
    const alignRight = r.left + PANEL_W > vw - 12
    const avail = (openUp ? spaceAbove : spaceBelow) - 16
    const maxHeight = Math.max(160, Math.min(320, avail))
    const c = { width: Math.max(r.width, 240), maxHeight }
    if (alignRight) c.right = vw - r.right
    else c.left = r.left
    if (openUp) c.bottom = vh - r.top + 6
    else c.top = r.bottom + 6
    return c
  }

  const toggle = () => {
    if (disabled) return
    if (open) { setOpen(false); return }
    setCoords(computeCoords())
    setOpen(true)
  }

  // Click-outside (с учётом portal-панели) + Escape + репозиция при scroll/resize.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onReflow = () => setCoords(computeCoords())
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [open])

  useEffect(() => { if (open && searchable && searchRef.current) searchRef.current.focus() }, [open, searchable])
  useEffect(() => { if (!open) setQuery('') }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const pick = (v) => { onChange(v); setOpen(false) }

  const panelStyle = coords ? {
    position: 'fixed',
    left: coords.left != null ? `${coords.left}px` : undefined,
    right: coords.right != null ? `${coords.right}px` : undefined,
    top: coords.top != null ? `${coords.top}px` : undefined,
    bottom: coords.bottom != null ? `${coords.bottom}px` : undefined,
    width: `${coords.width}px`,
  } : {}

  return (
    <div className={`fdrop ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${isActive ? 'is-active' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="fdrop-trigger"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label ? `${label}: ${selectedLabel}` : selectedLabel}
      >
        {label && <span className="fdrop-label">{label}</span>}
        <span className="fdrop-value">{formatTrigger ? formatTrigger(selectedLabel) : selectedLabel}</span>
        <span className="fdrop-arrow" aria-hidden>▾</span>
      </button>

      {open && !disabled && coords && createPortal(
        <div ref={panelRef} className="fdrop-panel" role="listbox" style={panelStyle}>
          {searchable && (
            <div className="fdrop-search-wrap">
              <input
                ref={searchRef}
                type="search"
                className="fdrop-search"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div className="fdrop-options" style={{ maxHeight: `${coords.maxHeight}px` }}>
            {filtered.length === 0 ? (
              <div className="fdrop-empty">Ничего не найдено</div>
            ) : (
              filtered.map(o => (
                <button
                  type="button"
                  key={String(o.value)}
                  className={`fdrop-option ${String(o.value) === String(value) ? 'is-current' : ''}`}
                  onClick={() => pick(o.value)}
                  title={o.label}
                >
                  <span className="fdrop-option-text">{o.label}</span>
                  {String(o.value) === String(value) && <span className="fdrop-check" aria-hidden>✓</span>}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
