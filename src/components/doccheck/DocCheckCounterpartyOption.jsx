import { counterpartyOptionMeta } from '../../utils/counterpartyPicker'

// Строка списка контрагентов (renderOption у FilterDropdown): название и под ним номер и ИНН — видно, по чему нашлось.
// Список рисуется в document.body, поэтому стили — без корня страницы (DocCheckRequestsPage.css, .dc-cp-option).
export default function renderCounterpartyOption(option) {
  const meta = counterpartyOptionMeta(option)
  return (
    <span className="fdrop-option-text dc-cp-option">
      <span className="dc-cp-option-name">{option.label}</span>
      {meta && <span className="dc-cp-option-meta">{meta}</span>}
    </span>
  )
}
