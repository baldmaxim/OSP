import { Fragment } from 'react'

// Номер документа («ДС-2026/0457-А») в узкой колонке: переносится только после
// разделителей / - _ . — не посреди цифр. Символы не теряются, многоточия нет.
export default function BreakableId({ value, className = '' }) {
  if (value == null || value === '') return null
  const parts = String(value).split(/(?<=[/\-_.])/)
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}{i < parts.length - 1 && <wbr />}</Fragment>
      ))}
    </span>
  )
}
