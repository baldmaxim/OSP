import './TgPublishToggle.css'
import './EstimatToggle.css'
import {
  ESTIMAT_SKIP, ESTIMAT_UPLOADED, estimatState, estimatSupported, estimatTitle, nextEstimatState,
} from '../utils/contractEstimat'

// Плашка «Estimat» у договора и ДС: серая — не загружено, зелёная — загружено, красная — не загружать.
// Нажатие (с правом правки) — следующее состояние по кругу; onChange(doc, next). Цвета — общие с отметкой «ТГ».
// className — место плашки: в реестре рядом с номером, в карточке телефона своей строкой.

const STATE_CLASS = { none: 'is-unpub', uploaded: 'is-pub', skip: 'is-skip' }

const IconBox = ({ state }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    {state === ESTIMAT_UPLOADED && <path d="M8 12.5l2.6 2.6L16 9" />}
    {state === ESTIMAT_SKIP && <path d="M9 9l6 6M15 9l-6 6" />}
  </svg>
)

export default function EstimatToggle({ doc, canEdit = false, onChange, className = '' }) {
  if (!estimatSupported(doc)) return null
  const state = estimatState(doc)
  const cls = `tgpub estimat-chip ${STATE_CLASS[state]} ${className}`.trim()
  const title = estimatTitle(doc, canEdit)

  if (!canEdit) {
    return (
      <span className={`${cls} is-readonly`} title={title}>
        <IconBox state={state} /> <span>Estimat</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title}
      onClick={(e) => {
        // Плашка лежит в карточке-ссылке телефона: нажатие не должно открывать карточку договора.
        e.preventDefault()
        e.stopPropagation()
        onChange(doc, nextEstimatState(state))
      }}
    >
      <IconBox state={state} /> <span>Estimat</span>
    </button>
  )
}
