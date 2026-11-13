// Общие поля окон сметы КП / ПЗ: окно, поле с сохранением при уходе, выбор с поиском, «тендер + подрядчик-победитель».
import { useEffect, useMemo, useRef, useState } from 'react'
import { tenderLabel, tenderOptionLabel, tenderWinners } from '../../utils/kpEstimate'

export function Modal({ title, ariaLabel, onClose, children, footer, wide = false, extra = null, className = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="kpe-modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`kpe-modal${wide ? ' kpe-modal--wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true"
        aria-label={ariaLabel || (typeof title === 'string' ? title : undefined)}>
        <header className="kpe-modal-head">
          <h3>{title}</h3>
          <span className="kpe-modal-tools">
            {extra}
            <button type="button" className="kpe-icon-btn" aria-label="Закрыть" onClick={onClose}>✕</button>
          </span>
        </header>
        <div className="kpe-modal-body">{children}</div>
        {footer && <footer className="kpe-modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export const qtyText = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','))

// Поле, которое сохраняется при уходе из него (и по Enter у однострочного); Esc — вернуть как было (окно не закрывает).
export function SaveOnBlur({ value, onSave, multiline = false, placeholder, disabled, label, inputMode, maxLength, invalid, className = '' }) {
  const [text, setText] = useState(value ?? '')
  const cancelRef = useRef(false)
  useEffect(() => { setText(value ?? '') }, [value])
  const commit = () => {
    if (cancelRef.current) { cancelRef.current = false; setText(value ?? ''); return }
    if ((text ?? '') !== (value ?? '')) onSave(text)
  }
  const props = {
    value: text, disabled, placeholder, 'aria-label': label, maxLength,
    className: `kpe-field${invalid ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`,
    onChange: (e) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancelRef.current = true; e.currentTarget.blur() }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
    },
  }
  return multiline ? <textarea rows={3} {...props} /> : <input inputMode={inputMode} {...props} />
}

// Выбор с поиском: список подходящих; своё значение (не из списка) — тоже можно.
export function SearchSelect({ value, options, onPick, placeholder, label, disabled }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  useEffect(() => { setQuery(value || '') }, [value])
  const tokens = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)
  const exact = options.some((o) => (o.value ?? o.label) === query)
  const list = useMemo(() => {
    if (!open) return []
    const out = []
    for (const o of options) {
      const hay = `${o.label} ${o.hint || ''}`.toLowerCase().replace(/ё/g, 'е')
      if (exact || tokens.every((t) => hay.includes(t))) out.push(o)
      if (out.length >= 50) break
    }
    return out
  }, [open, options, exact, tokens.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="kpe-search-select">
      <input className="kpe-field" value={query} placeholder={placeholder} aria-label={label} disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}
        onBlur={() => setTimeout(() => {
          setOpen(false)
          if ((query || '') !== (value || '')) onPick({ id: null, label: query.trim() })
        }, 150)} />
      {open && list.length > 0 && (
        <ul className="kpe-options" role="listbox" aria-label={label}>
          {list.map((o) => (
            <li key={o.id || o.label} role="option" aria-selected={false}
              onMouseDown={(e) => { e.preventDefault(); setQuery(o.value ?? o.label); setOpen(false); onPick(o) }}>
              <span>{o.label}</span>{o.hint && <span className="kpe-muted"> · {o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Тендер + подрядчик-победитель. pickers: { tenders, counterparties, winners }. Выбрали тендер — победитель (если он
// один) встаёт подрядчиком сам; победители — первыми в списке подрядчиков.
export function TenderContractorFields({ draft, setDraft, pickers, disabled }) {
  const winners = tenderWinners(pickers, draft.tender_id)
  const winnerIds = new Set(winners.map((c) => c.id))
  const tenderOptions = useMemo(() => (pickers?.tenders || []).map((t) => ({ id: t.id, label: tenderOptionLabel(t), value: tenderLabel(t), tender: t })), [pickers])
  const cpOptions = useMemo(() => {
    const list = (pickers?.counterparties || []).map((c) => ({
      id: c.id, label: c.name, hint: [winnerIds.has(c.id) && 'победитель тендера', c.inn && `ИНН ${c.inn}`].filter(Boolean).join(' · '),
    }))
    return list.sort((a, b) => (winnerIds.has(b.id) ? 1 : 0) - (winnerIds.has(a.id) ? 1 : 0))
  }, [pickers, draft.tender_id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <label className="kpe-f"><span>Тендер <span className="kpe-f-opt">(если есть)</span></span>
        <SearchSelect value={draft.tender_label || ''} options={tenderOptions} label="Тендер" placeholder="№ тендера или работы" disabled={disabled}
          onPick={(o) => {
            if (o.tender) {
              const w = tenderWinners(pickers, o.tender.id)
              const auto = !draft.counterparty_name || draft.autoCp
              setDraft((d) => ({
                ...d, tender_id: o.tender.id, tender_label: tenderLabel(o.tender),
                ...(auto && w.length === 1 ? { counterparty_id: w[0].id, counterparty_name: w[0].name, autoCp: true } : {}),
                ...(auto && w.length !== 1 && d.autoCp ? { counterparty_id: null, counterparty_name: null, autoCp: false } : {}),
              }))
            } else {
              setDraft((d) => ({ ...d, tender_id: null, tender_label: o.label || null }))
            }
          }} />
      </label>
      <label className="kpe-f"><span>Подрядчик{winners.length > 1 ? <span className="kpe-f-opt"> — победителей {winners.length}, выберите</span> : winners.length === 1 && draft.counterparty_id === winners[0].id ? <span className="kpe-f-opt"> — победитель тендера</span> : null}</span>
        <SearchSelect value={draft.counterparty_name || ''} options={cpOptions} label="Подрядчик" placeholder="Название или ИНН" disabled={disabled}
          onPick={(o) => setDraft((d) => ({ ...d, counterparty_id: o.id || null, counterparty_name: o.label || null, autoCp: false }))} />
      </label>
    </>
  )
}
