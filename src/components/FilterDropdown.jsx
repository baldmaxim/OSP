import { useState, useEffect, useRef, useMemo } from 'react'
import './FilterDropdown.css'

// Лёгкий кастомный фильтр-дропдаун (combobox) в стиле проекта.
//   - триггер «Метка  Значение  ▾» со скруглением и состояниями hover/focus/active;
//   - popover: белая панель, тень, скролл; опционально встроенный поиск;
//   - подсветка выбранного пункта; click-outside + Escape закрывают.
// options: [{ value, label }]. Значение «Все» — это опция с value '' или 'all'.
export default function FilterDropdown({
  label,
  value,
  onChange,
  options,
  searchable = false,
  searchPlaceholder = 'Поиск…',
  disabled = false,
  allLabel = 'Все',
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
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

  // Активен = выбрано не «Все» (пустая строка либо 'all').
  const isActive = value !== '' && value !== 'all' && value != null

  // Click-outside + Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Автофокус на поиск + сброс запроса при открытии/закрытии.
  useEffect(() => { if (open && searchable && searchRef.current) searchRef.current.focus() }, [open, searchable])
  useEffect(() => { if (!open) setQuery('') }, [open])

  // Если стал disabled при открытом popover — закрываем.
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const pick = (v) => { onChange(v); setOpen(false) }

  return (
    <div className={`fdrop ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${isActive ? 'is-active' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="fdrop-trigger"
        onClick={() => { if (!disabled) setOpen(v => !v) }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${label}: ${selectedLabel}`}
      >
        <span className="fdrop-label">{label}</span>
        <span className="fdrop-value">{selectedLabel}</span>
        <span className="fdrop-arrow" aria-hidden>▾</span>
      </button>

      {open && !disabled && (
        <div className="fdrop-panel" role="listbox">
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
          <div className="fdrop-options">
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
        </div>
      )}
    </div>
  )
}
