import { useEffect, useRef, useState } from 'react'
import { formatAmount, formatAmountLive } from '../../utils/money'

// Поле цены или суммы в таблице расценки снабжения (по образцу AmountCellInput «Заявки на ДС»):
// в фокусе — «сырое» число с разрядами, вне фокуса — «1 000,00». derived — значение посчитано из соседнего
// поля (светлее). cellId — «колонка-строка» (unit-3): по нему Enter находит поле ниже.
//
// Сохранение — само: через AUTOSAVE_MS после последнего нажатия, при уходе из поля (мышью, Tab, Enter) и при
// закрытии вкладки карточки. Записывается только то, что набрали: проход через поле по Tab ничего не пишет
// (раньше это давало вторую запись той же строки и ложное «цену уже изменили»). Esc — вернуть значение,
// которое было до правки (если набранное уже успело сохраниться — записывается прежнее).
export const AUTOSAVE_MS = 1000
const toRaw = (value) => (value != null && Number.isFinite(value) ? formatAmountLive(String(Math.round(value * 100) / 100)) : '')

export default function SupplyMoneyCell({ value, derived = false, disabled = false, onCommit, cellId, label, title, invalid = false, placeholder = '—' }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const dirty = useRef(false) // набрано и ещё не отдано на запись
  const committed = useRef(false) // за этот заход в поле что-то уже записали
  const initial = useRef('')
  const timer = useRef(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const flush = () => {
    clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current) return
    dirty.current = false
    committed.current = true
    onCommitRef.current(draftRef.current)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  // Вкладку карточки закрыли с набранным значением — сохранить.
  useEffect(() => () => flushRef.current(), [])

  const display = focused ? draft : (value != null && Number.isFinite(value) ? formatAmount(value) : '')

  const focusNext = (input) => {
    const [col, row] = String(cellId).split('-')
    const next = input.closest('table')?.querySelector(`[data-sp-cell="${col}-${Number(row) + 1}"]`)
    if (next && !next.disabled) requestAnimationFrame(() => next.focus())
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      className={`sp-money-input${derived ? ' is-derived' : ''}${invalid ? ' is-invalid' : ''}`}
      value={display}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      title={title}
      data-sp-cell={cellId}
      onFocus={(e) => {
        const raw = toRaw(value)
        initial.current = raw
        draftRef.current = raw
        dirty.current = false
        committed.current = false
        setDraft(raw)
        setFocused(true)
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => {
        const v = formatAmountLive(e.target.value)
        draftRef.current = v
        setDraft(v)
        dirty.current = true
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, AUTOSAVE_MS)
      }}
      onBlur={() => {
        setFocused(false)
        flush()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const input = e.currentTarget
          input.blur()
          focusNext(input)
        } else if (e.key === 'Escape') {
          clearTimeout(timer.current)
          timer.current = null
          dirty.current = false
          if (committed.current) {
            committed.current = false
            onCommitRef.current(initial.current)
          }
          e.currentTarget.blur()
        }
      }}
    />
  )
}
