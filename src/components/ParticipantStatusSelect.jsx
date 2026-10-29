import FilterDropdown from './FilterDropdown'
import { PARTICIPANT_STATUS_OPTIONS, participantStatusKey } from '../utils/participantStatus'
import './ParticipantStatusSelect.css'

// Статус участника тендера — цветная плашка-список: в раскрытой строке реестра
// тендеров и во вкладке «Участники» карточки (раньше там был обычный select с
// другими цветами). Цвет — не единственный признак: точка и подпись. Без права
// правки — та же плашка без стрелки.
const dotLabel = (label) => (
  <span className="tc-status-opt">
    <span className="tc-status-dot" aria-hidden />
    {label}
  </span>
)

export default function ParticipantStatusSelect({ value, onChange, disabled = false }) {
  const status = participantStatusKey(value)
  return (
    <FilterDropdown
      className={`tc-status-fdrop tc-st-${status}`}
      label=""
      value={status}
      onChange={onChange}
      options={PARTICIPANT_STATUS_OPTIONS}
      disabled={disabled}
      triggerTitle={disabled ? 'Статус участника' : 'Статус участника — нажмите, чтобы изменить'}
      formatTrigger={dotLabel}
      renderOption={(o) => (
        <span className={`tc-status-opt tc-st-${o.value}`}>
          <span className="tc-status-dot" aria-hidden />
          {o.label}
        </span>
      )}
    />
  )
}
