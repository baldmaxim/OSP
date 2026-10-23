import { useState } from 'react'
import { VAT_EXEMPT, VAT_NONE, VAT_RATES, formatPercent, vatSelectValue } from '../../utils/counterpartyVat'

// Выпадающий список НДС контрагента — один на реестр (колонка «НДС») и вкладку «Общая информация».
// Пишет страница (onSave → handleVatChange): строка в её списке контрагентов одна, поэтому правка в реестре
// сразу видна в открытой карточке и наоборот.
export default function CounterpartyVatSelect({ counterparty, onSave, className }) {
  const [saving, setSaving] = useState(false)
  const value = vatSelectValue(counterparty)
  // Ставка не из списка (прежние 20 и 10 % или заведена в базе вручную) — показываем её отдельной строкой списка;
  // «Без НДС» из выбора убран — строка есть, только если он уже записан.
  const rates = VAT_RATES.map(String)
  if (value !== VAT_NONE && value !== VAT_EXEMPT && !rates.includes(value)) rates.push(value)

  const handleChange = async (e) => {
    setSaving(true)
    try {
      await onSave(e.target.value)
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      className={`${className}${value === VAT_NONE ? ' is-empty' : ''}`}
      value={value}
      onChange={handleChange}
      disabled={saving}
      aria-label={`НДС контрагента${counterparty.name ? ` ${counterparty.name}` : ''}`}
    >
      <option value={VAT_NONE}>не указан</option>
      {value === VAT_EXEMPT && <option value={VAT_EXEMPT}>Без НДС</option>}
      {rates.map(r => <option key={r} value={r}>{formatPercent(r)} %</option>)}
    </select>
  )
}
