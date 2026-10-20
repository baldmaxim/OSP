import FilterDropdown from './FilterDropdown'
import { IconFilter, IconClose, IconTag } from './icons/ToolbarIcons'
import { VOR_DIVISIONS, VOR_DIVISION_LABEL, NO_VOR_DIVISION } from '../utils/vorDivisions'
import './VorDivisionFilter.css'

// Фильтр реестра «Тендеры — Основное строительство» по подразделению ВОР — в
// заголовке колонки «Описание работ», где под описанием стоит плашка
// подразделения (VorDivisionChip). На телефоне шапки таблицы нет — тот же
// фильтр в панели фильтров (inHeader=false, обычный вид панели).
//
// value — массив кодов, NO_VOR_DIVISION — «Не указано». Пустой массив — фильтр
// не применён: показаны все тендеры, в том числе без подразделения.
// Выбранный фильтр видно сразу: заливка акцентом, в подписи — что выбрано,
// рядом кнопка сброса; у заголовка — акцентная черта (класс на <th>).
// counts — Map(код → число тендеров) по реестру без этого фильтра.
const ITEMS = [...VOR_DIVISIONS, { value: NO_VOR_DIVISION, label: 'Не указано' }]
const ITEM_LABEL = { ...VOR_DIVISION_LABEL, [NO_VOR_DIVISION]: 'Не указано' }

export default function VorDivisionFilter({ value, onChange, counts = null, inHeader = false }) {
  const active = value.length > 0
  const names = value.map(v => ITEM_LABEL[v]).filter(Boolean)
  const shown = names.length === 1 ? names[0] : `Подразделений: ${names.length}`
  const options = ITEMS.map(d => ({
    value: d.value,
    label: counts ? `${d.label} (${counts.get(d.value) || 0})` : d.label,
  }))
  const title = active
    ? `Фильтр по подразделению ВОР: ${names.join(', ')}`
    : 'Фильтр по подразделению ВОР: показаны все тендеры, в том числе без подразделения'

  const dropdown = (
    <FilterDropdown
      className={inHeader ? 'vdivf-fdrop' : ''}
      label=""
      multiple
      allLabel="Все подразделения"
      icon={inHeader ? <IconFilter size={11} /> : <IconTag size={15} />}
      value={value}
      onChange={onChange}
      options={options}
      triggerTitle={title}
      formatTrigger={(label) => (active
        ? <><span className="ui-sr-only">Подразделение ВОР: </span>{shown}</>
        : label)}
    />
  )
  if (!inHeader) return dropdown

  return (
    <span className={`vdivf${active ? ' is-active' : ''}`}>
      {dropdown}
      {active && (
        <button
          type="button"
          className="vdivf-clear"
          onClick={() => onChange([])}
          aria-label="Сбросить фильтр по подразделению"
          title="Сбросить фильтр: все подразделения, в том числе без подразделения"
        >
          <IconClose size={10} />
        </button>
      )}
    </span>
  )
}
