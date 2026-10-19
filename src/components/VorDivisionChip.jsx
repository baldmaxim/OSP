import FilterDropdown from './FilterDropdown'
import { IconTag } from './icons/ToolbarIcons'
import { VOR_DIVISIONS, VOR_DIVISION_LABEL } from '../utils/vorDivisions'
import './VorDivisionChip.css'

// Подразделение ВОР под описанием работ в строке реестра тендеров — то же поле
// tenders.vor_division, что столбец «Подразделение» в «ВОРах и РД»
// (utils/vorDivisions.js). Выбор — тем же портальным списком FilterDropdown;
// onChange(код | null). Без права правки и без значения — ничего не рисует.
const OPTIONS = [{ value: '', label: 'Не указано' }, ...VOR_DIVISIONS]

export default function VorDivisionChip({ value, canEdit = false, onChange }) {
  const label = VOR_DIVISION_LABEL[value] || null

  if (!canEdit) {
    if (!label) return null
    return (
      <span className="vdiv is-set" title={`Подразделение ВОР: ${label} (как в «ВОРах и РД»)`}>
        <IconTag size={11} />
        <span className="ui-sr-only">Подразделение ВОР: </span>
        {label}
      </span>
    )
  }

  return (
    <FilterDropdown
      className={`vdiv-fdrop${label ? ' is-set' : ''}`}
      label=""
      allLabel="Не указано"
      icon={<IconTag size={11} />}
      value={value || ''}
      onChange={(v) => onChange(v || null)}
      options={OPTIONS}
      triggerTitle={label
        ? `Подразделение ВОР: ${label} — меняется здесь и в «ВОРах и РД»`
        : 'Указать подразделение ВОР — то же поле, что в «ВОРах и РД»'}
      formatTrigger={() => (label
        ? <><span className="ui-sr-only">Подразделение ВОР: </span>{label}</>
        : 'Подразделение')}
    />
  )
}
