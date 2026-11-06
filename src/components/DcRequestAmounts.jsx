import { useState } from 'react'
import { formatAmount, formatAmountLive } from '../utils/money'
import { amountSections, deltaText } from '../utils/dcRequestAmounts'
import './DcRequestAmounts.css'

// Суммы заявки на ДС: один блок из двух частей — «Было ПСДЦ → ДС подрядчика → Согласовано ДС ОСП» и под двойной чертой
// «Было ВОР подрядчик → Стало ВОР ОСП» (правила — utils/dcRequestAmounts.js). Ячейка «Сумма, руб. с НДС 22%» реестра и
// карточка на телефоне. canEdit — суммы правятся прямо в блоке (onSave(field, raw) при уходе из поля); columns=false —
// в базе нет колонок 20270104: только верхняя часть, «ДС подрядчика» не вводится.

export const AMOUNT_INPUT_HINT = 'Уменьшение стоимости — со знаком минус'
const liveAmount = (raw) => formatAmountLive(raw, { allowNegative: true })

// В фокусе — «сырое» число с разрядами, вне фокуса — «1 000 000,00». Сумма бывает отрицательной: минус первым символом.
function AmountInput({ value, label, className, onSave }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  const display = focused ? draft : (value != null ? formatAmount(value) : '')
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={display}
      placeholder="—"
      title={AMOUNT_INPUT_HINT}
      aria-label={label}
      onFocus={() => { setFocused(true); setDraft(value != null ? liveAmount(String(value)) : '') }}
      onChange={(e) => setDraft(liveAmount(e.target.value))}
      onBlur={() => { setFocused(false); onSave(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

function Delta({ row }) {
  const text = deltaText(row.delta)
  return (
    <div className={`dca-delta dca-delta--${row.kind === 'total' ? 'total' : row.tone} is-${text.dir}`}>
      <span className="dca-label">{row.label}</span>
      <span className="dca-delta-val">
        <span className="dca-delta-abs">{text.abs}</span>
        {text.pct && <span className="dca-delta-pct">{text.pct}</span>}
      </span>
    </div>
  )
}

export default function DcRequestAmounts({ req, canEdit = false, onSave, columns = true }) {
  const value = (row, head) => {
    const cls = head ? 'dca-head-value' : 'dca-value'
    if (canEdit && row.field) {
      return <AmountInput value={row.value} label={row.label} className={`dca-input ${cls}`} onSave={(raw) => onSave(row.field, raw)} />
    }
    return (
      <span className={`${cls}${row.value == null ? ' is-empty' : ''}`}>
        {row.value != null ? formatAmount(row.value) : '—'}
      </span>
    )
  }
  return (
    <div className="dca">
      {amountSections(req, { columns }).map(({ key, rows: [head, ...body] }) => (
        <div key={key} className={`dca-part dca-part--${key}`}>
          <div className="dca-head">
            <span className="dca-head-label">{head.label}</span>
            {value(head, true)}
          </div>
          {body.length > 0 && (
            <div className="dca-body">
              {body.map((row) => (row.kind === 'value' ? (
                <div key={row.label} className="dca-row">
                  <span className="dca-label">{row.label}</span>
                  {value(row, false)}
                </div>
              ) : <Delta key={`${row.kind}-${row.tone || ''}`} row={row} />))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
