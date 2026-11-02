import { avatarTone, initials } from '../../utils/docCheckHelpers'
import { employeeName } from '../../services/employees'

// Исполнители заявки — кружки с инициалами, как на прежней доске. Полное ФИО —
// в подсказке и для экранного диктора. Больше max — «+N». Вписанные руками
// (manual — нет учётной записи) стоят рядом, кружком с пунктирной рамкой.
export default function DocCheckAvatars({ ids, manual, employees, max = 3, size = 'sm' }) {
  const people = [
    ...(ids || []).map(id => ({ key: id, name: employeeName(employees, id, 'Не назначен'), tone: avatarTone(id) })),
    ...(manual || []).map(name => ({ key: `manual:${name}`, name, isManual: true })),
  ]
  if (!people.length) return null
  const names = people.map(p => p.name).join(', ')
  const shown = people.slice(0, max)
  const rest = people.length - shown.length
  return (
    <span className={`dc-avatars dc-avatars--${size}`} title={names}>
      {shown.map(p => (
        <span
          key={p.key}
          className={`dc-avatar ${p.isManual ? 'dc-avatar--manual' : `dc-avatar--t${p.tone}`}`}
          aria-hidden="true"
        >{initials(p.name)}</span>
      ))}
      {rest > 0 && <span className="dc-avatar dc-avatar--more" aria-hidden="true">+{rest}</span>}
      <span className="ui-sr-only">Исполнители: {names}</span>
    </span>
  )
}
