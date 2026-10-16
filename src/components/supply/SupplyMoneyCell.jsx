import { useRef, useState } from 'react'
import { formatAmount, formatAmountLive } from '../../utils/money'

// Поле цены или суммы в таблице расценки снабжения (по образцу AmountCellInput «Заявки на ДС»):
// в фокусе — «сырое» число с разрядами, вне фокуса — «1 000,00». Enter — сохранить и перейти на строку ниже
// в ту же колонку, Esc — отменить ввод. derived — значение посчитано из соседнего поля (светлее).
// cellId — «колонка-строка» (unit-3): по нему Enter находит поле ниже.
export default function SupplyMoneyCell({ value, derived = false, disabled = false, onCommit, cellId, label, title, invalid = false }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  const cancelRef = useRef(false)
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
      placeholder="—"
      aria-label={label}
      title={title}
      data-sp-cell={cellId}
      onFocus={(e) => {
        cancelRef.current = false
        setFocused(true)
        setDraft(value != null && Number.isFinite(value) ? formatAmountLive(String(Math.round(value * 100) / 100)) : '')
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setDraft(formatAmountLive(e.target.value))}
      onBlur={() => {
        setFocused(false)
        if (!cancelRef.current) onCommit(draft)
        cancelRef.current = false
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const input = e.currentTarget
          input.blur()
          focusNext(input)
        } else if (e.key === 'Escape') {
          cancelRef.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}
