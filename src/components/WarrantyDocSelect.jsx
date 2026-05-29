import { useState, useEffect, useRef, useMemo } from 'react'
import './WarrantyDocSelect.css'

// task 362: кастомный селект «Форма документа о начале гарантии».
//   Нативный <select> с десятками документов давал гигантский неуправляемый
//   dropdown на полстраницы. Этот компонент решает три проблемы:
//     • поиск по подстроке (имя + номер) — фильтруется на лету;
//     • группировка по типу (договор / ДС / приложение) — структура видна;
//     • dropdown в пределах модалки, со скроллом внутри панели.

const TYPE_ORDER = ['general_contract', 'additional_agreement', 'attachment']
const TYPE_LABEL = {
  general_contract: 'Договоры генподряда',
  additional_agreement: 'Дополнительные соглашения',
  attachment: 'Приложения',
}

function docLabel(d) {
  const num = d?.document_number ? ` (№ ${d.document_number})` : ''
  return `${d?.name || ''}${num}`
}

export default function WarrantyDocSelect({ value, onChange, documents }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)
  const searchRef = useRef(null)

  const selected = useMemo(
    () => (value ? documents.find(d => d.id === value) || null : null),
    [value, documents]
  )

  // Группировка по типу + сортировка внутри каждой группы.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (d) => {
      if (!q) return true
      const hay = `${d.name || ''} ${d.document_number || ''}`.toLowerCase()
      return hay.includes(q)
    }
    const byType = new Map()
    for (const d of documents) {
      if (!matches(d)) continue
      const t = d.document_type || 'attachment'
      if (!byType.has(t)) byType.set(t, [])
      byType.get(t).push(d)
    }
    const sortFn = (a, b) =>
      (a.order_number ?? 0) - (b.order_number ?? 0) ||
      (a.name || '').localeCompare(b.name || '', 'ru')
    const result = []
    for (const type of TYPE_ORDER) {
      const arr = byType.get(type)
      if (arr && arr.length) result.push({ type, label: TYPE_LABEL[type], items: arr.sort(sortFn) })
    }
    // Прочие типы (если появятся новые ENUM-значения)
    for (const [type, arr] of byType.entries()) {
      if (TYPE_ORDER.includes(type)) continue
      result.push({ type, label: type, items: arr.sort(sortFn) })
    }
    return result
  }, [documents, query])

  // Click outside + Escape — закрываем dropdown.
  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // При открытии — автофокус на поиск.
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus()
    }
  }, [open])

  const handlePick = (id) => {
    onChange(id || '')
    setOpen(false)
    setQuery('')
  }

  return (
    <div className={`wds-root ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="wds-trigger"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`wds-trigger-text ${!selected ? 'is-placeholder' : ''}`}>
          {selected ? docLabel(selected) : '— не выбран —'}
        </span>
        <span className="wds-trigger-arrow" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="wds-panel" role="listbox">
          <div className="wds-search-wrap">
            <input
              ref={searchRef}
              type="search"
              className="wds-search"
              placeholder="🔍 Поиск по названию или номеру…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="wds-options">
            <button
              type="button"
              className={`wds-option wds-option-clear ${!value ? 'is-current' : ''}`}
              onClick={() => handlePick('')}
            >
              — не выбран —
            </button>
            {groups.length === 0 ? (
              <div className="wds-empty">Ничего не найдено</div>
            ) : (
              groups.map(g => (
                <div key={g.type} className="wds-group">
                  <div className="wds-group-label">{g.label}</div>
                  {g.items.map(d => (
                    <button
                      type="button"
                      key={d.id}
                      className={`wds-option ${value === d.id ? 'is-current' : ''}`}
                      onClick={() => handlePick(d.id)}
                      title={docLabel(d)}
                    >
                      <span className="wds-option-name">{d.name}</span>
                      {d.document_number && (
                        <span className="wds-option-num">№ {d.document_number}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
