import { useId, useState } from 'react'
import { IconClose } from '../icons/ToolbarIcons'
import { MAX_LABELS, normalizeLabels } from '../../utils/docCheckHelpers'

// Метки заявки: плашки с крестиком и поле ввода. Enter или запятая — добавить;
// подсказки — метки, которыми уже пользуются (частые первыми).
export default function DocCheckLabelsInput({ value, onChange, suggestions }) {
  const [draft, setDraft] = useState('')
  const listId = useId()
  const labels = value || []
  const full = labels.length >= MAX_LABELS

  const add = (text) => {
    const next = normalizeLabels([...labels, ...String(text).split(',')])
    if (next.length !== labels.length) onChange(next)
    setDraft('')
  }
  const remove = (label) => onChange(labels.filter(l => l !== label))
  const offered = (suggestions || []).filter(s => !labels.some(l => l.toLowerCase() === s.toLowerCase()))

  return (
    <div className="dc-labels-input">
      {labels.map(l => (
        <span key={l} className="dc-chip dc-chip--label">
          {l}
          <button type="button" className="dc-chip-x" aria-label={`Убрать метку «${l}»`} onClick={() => remove(l)}>
            <IconClose size={11} />
          </button>
        </span>
      ))}
      <input
        type="text"
        list={listId}
        value={draft}
        disabled={full}
        aria-label="Новая метка"
        placeholder={full ? `Не больше ${MAX_LABELS} меток` : 'Метка: Enter — добавить'}
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
