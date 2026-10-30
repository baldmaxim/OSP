import FilterDropdown from './FilterDropdown'
import { IconTag } from './icons/ToolbarIcons'
import { VOR_DIVISIONS, VOR_DIVISION_LABEL } from '../utils/vorDivisions'
import { WORK_TYPE_DIVISIONS, WORK_TYPE_DIVISION_LABEL } from '../utils/workTypeDivisions'
import './VorDivisionChip.css'

// Подразделение ВОР под описанием работ в строке реестра тендеров — то же поле
// tenders.vor_division, что столбец «Подразделение» в «ВОРах и РД»
// (utils/vorDivisions.js). Выбор — тем же портальным списком FilterDropdown;
// onChange(код | null). Без права правки и без значения — ничего не рисует.
// subject='dc' — подразделение заявки на ДС (dc_requests.division, те же коды): свои подсказки, без «ВОРов и РД».
// subject='contract' — подразделение договора (contracts.division, utils/contractDivision.js); у ДС — договора.
// subject='wt' — подразделение вида работ (work_types.division, utils/workTypeDivisions.js), вкладка «Виды работ».
// subject='cp' — подразделение контрагента по его виду работ (только показ, в строке реестра контрагентов).
// У видов работ и контрагентов есть ещё «Прочее» (WORK_TYPE_DIVISIONS), у остальных — только подразделения ВОР.
const LISTS = {
  vor: { options: [{ value: '', label: 'Не указано' }, ...VOR_DIVISIONS], label: VOR_DIVISION_LABEL },
  work: { options: [{ value: '', label: 'Не указано' }, ...WORK_TYPE_DIVISIONS], label: WORK_TYPE_DIVISION_LABEL },
}
const listOf = (subject) => (subject === 'wt' || subject === 'cp' ? LISTS.work : LISTS.vor)

const TEXTS = {
  vor: {
    sr: 'Подразделение ВОР: ',
    read: (l) => `Подразделение ВОР: ${l} (как в «ВОРах и РД»)`,
    edit: (l) => `Подразделение ВОР: ${l} — меняется здесь и в «ВОРах и РД»`,
    empty: 'Указать подразделение ВОР — то же поле, что в «ВОРах и РД»',
  },
  dc: {
    sr: 'Подразделение: ',
    read: (l) => `Подразделение: ${l}`,
    edit: (l) => `Подразделение заявки: ${l} — нажмите, чтобы сменить`,
    empty: 'Указать подразделение заявки (как у тендеров)',
  },
  contract: {
    sr: 'Подразделение: ',
    read: (l) => `Подразделение договора: ${l}`,
    edit: (l) => `Подразделение договора: ${l} — нажмите, чтобы сменить (у его ДС — то же)`,
    empty: 'Указать подразделение договора (как у тендеров)',
  },
  wt: {
    sr: 'Подразделение: ',
    read: (l) => `Подразделение вида работ: ${l}`,
    edit: (l) => `Подразделение вида работ: ${l} — нажмите, чтобы сменить (у всех контрагентов с этим видом)`,
    empty: 'Указать подразделение вида работ — по нему фильтруются контрагенты',
  },
  cp: {
    sr: 'Подразделение: ',
    read: (l) => `Подразделение по виду работ: ${l}`,
  },
}

export default function VorDivisionChip({ value, canEdit = false, onChange, subject = 'vor' }) {
  const list = listOf(subject)
  const label = list.label[value] || null
  const t = TEXTS[subject] || TEXTS.vor

  if (!canEdit) {
    if (!label) return null
    return (
      <span className="vdiv is-set" title={t.read(label)}>
        <IconTag size={11} />
        <span className="ui-sr-only">{t.sr}</span>
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
      options={list.options}
      triggerTitle={label ? t.edit(label) : t.empty}
      formatTrigger={() => (label
        ? <><span className="ui-sr-only">{t.sr}</span>{label}</>
        : 'Подразделение')}
    />
  )
}
