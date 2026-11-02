import { useId, useState } from 'react'
import { IconClose } from '../icons/ToolbarIcons'
import { MAX_LABELS, normalizeLabels } from '../../utils/docCheckHelpers'

// Список коротких текстов заявки: плашки с крестиком и поле ввода. Enter или запятая — добавить;
// подсказки — то, чем уже пользуются (частые первыми). По умолчанию — метки; те же плашки у
// исполнителей без учётной записи (свои предел, разбор и подписи).
export default function DocCheckLabelsInput({
  value, onChange, suggestions,
  normalize = normalizeLabels,
  max = MAX_LABELS,
  className = 'dc-labels-input',
  inputLabel = 'Новая метка',
  placeholder = 'Метка: Enter — добавить',
  fullText = `Не больше ${MAX_LABELS} меток`,
  removeLabel = (label) => `Убрать метку «${label}»`,
}) {
  const [draft, setDraft] = useState('')
  const listId = useId()
  const labels = value || []
  const full = labels.length >= max

  const add = (text) => {
    const next = normalize([...labels, ...String(text).split(',')])
    if (next.length !== labels.length) onChange(next)
    setDraft('')
  }
  const remove = (label) => onChange(labels.filter(l => l !== label))
  const offered = (suggestions || []).filter(s => !labels.some(l => l.toLowerCase() === s.toLowerCase()))

  return (
    <div className={className}>
      {labels.map(l => (
        <span key={l} className="dc-chip dc-chip--label">
          {l}
          <button type="button" className="dc-chip-x" aria-label={removeLabel(l)} onClick={() => remove(l)}>
            <IconClose size={11} />
          </button>
        </span>
      ))}
      <input
        type="text"
        list={listId}
        value={draft}
        disabled={full}
        aria-label={inputLabel}
        placeholder={full ? fullText : placeholder}
        onChange={(e) => {
          const v = e.target.value
          // Выбор подсказки из списка приходит целиком — добавляем сразу.
          if (offered.includes(v)) add(v)
          else setDraft(v)
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && draft.trim()) { e.preventDefault(); add(draft) }
          if (e.key === 'Enter' && !draft.trim()) e.preventDefault()
          if (e.key === 'Backspace' && !draft && labels.length) remove(labels[labels.length - 1])
        }}
        onBlur={() => { if (draft.trim()) add(draft) }}
      />
      <datalist id={listId}>
        {offered.slice(0, 30).map(s => <option key={s} value={s} />)}
      </datalist>
    </div>
  )
}
