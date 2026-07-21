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
//
// multiple=true — режим множественного выбора: `value` это МАССИВ значений, опции
// показываются чекбоксами, панель не закрывается после клика, появляются «Все» /
// «Очистить». Пустой массив = фильтр не применён (показывается allLabel).
// По умолчанию (multiple=false) поведение прежнее — одиночный выбор.
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
  // Необязательно: кастомный рендер опции в списке (напр. цветной бейдж статуса).
  // Получает объект опции целиком. Работает в одиночном режиме.
  renderOption = null,
  // Необязательный доп. класс на корень (напр. компактный вид status-fdrop).
  className = '',
  // Необязательный inline-стиль на корень (напр. проброс CSS-переменной цвета статуса).
  style = null,
  multiple = false,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [coords, setCoords] = useState(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const searchRef = useRef(null)

  // В multiple-режиме работаем с массивом; наружу всегда отдаём массив.
  const selectedValues = useMemo(
    () => (multiple ? (Array.isArray(value) ? value.map(String) : []) : []),
    [multiple, value])

  // Опции, доступные для выбора (без служебной «Все …» со значением '').
  const pickable = useMemo(
    () => options.filter(o => o.value !== '' && o.value !== 'all'),
    [options])

  const selectedLabel = useMemo(() => {
    if (multiple) {
      if (selectedValues.length === 0) return allLabel
      if (selectedValues.length === 1) {
        const found = options.find(o => String(o.value) === selectedValues[0])
        return found ? found.label : allLabel
      }
      return `Выбрано: ${selectedValues.length}`
    }
    const found = options.find(o => String(o.value) === String(value))
    return found ? found.label : allLabel
  }, [options, value, allLabel, multiple, selectedValues])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => String(o.label).toLowerCase().includes(q))
  }, [options, query])

  const isActive = multiple
    ? selectedValues.length > 0
    : (value !== '' && value !== 'all' && value != null)

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
    const c = { width: Math.min(340, Math.max(r.width, 300)), maxHeight }
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

  // Одиночный режим — выбрали и закрыли. Множественный — переключаем галочку,
  // панель остаётся открытой (можно отметить сразу несколько).
  const pick = (v) => {
    if (!multiple) { onChange(v); setOpen(false); return }
    const key = String(v)
    const next = selectedValues.includes(key)
      ? selectedValues.filter(x => x !== key)
      : [...selectedValues, key]
    onChange(next)
  }

  const panelStyle = coords ? {
    position: 'fixed',
    left: coords.left != null ? `${coords.left}px` : undefined,
    right: coords.right != null ? `${coords.right}px` : undefined,
    top: coords.top != null ? `${coords.top}px` : undefined,
    bottom: coords.bottom != null ? `${coords.bottom}px` : undefined,
    width: `${coords.width}px`,
  } : {}

  return (
    <div className={`fdrop ${className} ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${isActive ? 'is-active' : ''}`} style={style || undefined} ref={rootRef}>
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
          {multiple && (
            <div className="fdrop-multi-actions">
              <button type="button" onClick={() => onChange(pickable.map(o => String(o.value)))}>
                Выбрать все
              </button>
              <button type="button" onClick={() => onChange([])} disabled={selectedValues.length === 0}>
                Очистить
              </button>
            </div>
          )}
          <div className="fdrop-options" style={{ maxHeight: `${coords.maxHeight}px` }}>
            {filtered.length === 0 ? (
              <div className="fdrop-empty">Ничего не найдено</div>
            ) : multiple ? (
              // Служебную опцию «Все …» в списке не показываем — её роль играет «Очистить».
              filtered.filter(o => o.value !== '' && o.value !== 'all').map(o => {
                const checked = selectedValues.includes(String(o.value))
                return (
                  <label key={String(o.value)} className={`fdrop-option fdrop-option-multi ${checked ? 'is-current' : ''}`} title={o.label}>
                    <input
                      type="checkbox"
                      className="fdrop-option-box"
                      checked={checked}
                      onChange={() => pick(o.value)}
                    />
                    <span className="fdrop-option-text">{o.label}</span>
                  </label>
                )
              })
            ) : (
              filtered.map(o => (
                <button
                  type="button"
                  key={String(o.value)}
                  className={`fdrop-option ${String(o.value) === String(value) ? 'is-current' : ''}`}
                  onClick={() => pick(o.value)}
                  title={o.label}
                >
                  {renderOption ? renderOption(o) : <span className="fdrop-option-text">{o.label}</span>}
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
