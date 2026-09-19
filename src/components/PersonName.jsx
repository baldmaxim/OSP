import { shortPersonName } from '../utils/personName'

// ФИО в ячейке: видно «Фамилия И. О.», полное — в подсказке (мышь) и в тексте
// для экранного диктора (.ui-sr-only). Исходное значение, поиск и выгрузки —
// по полному ФИО. titlePrefix — пояснение в подсказке («Автор заявки: …»).
export default function PersonName({ full, titlePrefix = '', className = '' }) {
  if (!full) return null
  const short = shortPersonName(full)
  if (short === full) return <span className={className} title={titlePrefix ? `${titlePrefix}: ${full}` : undefined}>{full}</span>
  return (
    <span className={className} title={titlePrefix ? `${titlePrefix}: ${full}` : full}>
      <span aria-hidden="true">{short}</span>
      <span className="ui-sr-only">{full}</span>
    </span>
  )
}
