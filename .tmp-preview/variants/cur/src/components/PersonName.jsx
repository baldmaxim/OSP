import { shortPersonName } from '../utils/personName'

// ФИО в ячейке: видно «Фамилия И. О.», полное — в подсказке (мышь) и в тексте
// для экранного диктора (.ui-sr-only). Исходное значение, поиск и выгрузки —
// по полному ФИО. titlePrefix — пояснение в подсказке («Автор заявки: …»).
//
// Инициалы — одна неразрывная группа («В. А.» не расходятся по строкам);
// перенос возможен только между фамилией и инициалами.
export default function PersonName({ full, titlePrefix = '', className = '' }) {
  if (!full) return null
  const short = shortPersonName(full)
  if (short === full) return <span className={className} title={titlePrefix ? `${titlePrefix}: ${full}` : undefined}>{full}</span>
  const [surname, ...initials] = short.split(' ')
  return (
    <span className={className} title={titlePrefix ? `${titlePrefix}: ${full}` : full}>
      <span aria-hidden="true">{surname} <span className="ui-nowrap">{initials.join('\u00A0')}</span></span>
      <span className="ui-sr-only">{full}</span>
    </span>
  )
}
