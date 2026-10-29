import { avatarTone, initials } from '../../utils/docCheckHelpers'
import { employeeName } from '../../services/employees'

// Исполнители заявки — кружки с инициалами, как на прежней доске. Полное ФИО —
// в подсказке и для экранного диктора. Больше max — «+N».
export default function DocCheckAvatars({ ids, employees, max = 3, size = 'sm' }) {
  const list = ids || []
  if (!list.length) return null
  const names = list.map(id => employeeName(employees, id, 'Не назначен'))
  const shown = list.slice(0, max)
  const rest = list.length - shown.length
  return (
    <span className={`dc-avatars dc-avatars--${size}`} title={names.join(', ')}>
      {shown.map((id, i) => (
        <span key={id} className={`dc-avatar dc-avatar--t${avatarTone(id)}`} aria-hidden="true">{initials(names[i])}</span>
      ))}
      {rest > 0 && <span className="dc-avatar dc-avatar--more" aria-hidden="true">+{rest}</span>}
      <span className="ui-sr-only">Исполнители: {names.join(', ')}</span>
    </span>
  )
}
