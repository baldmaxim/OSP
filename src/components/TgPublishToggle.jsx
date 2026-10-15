import './TgPublishToggle.css'
import { TG_PUBLISHED, TG_SKIP, nextTgState, tgSkipSupported, tgState } from '../utils/tgPublish'

// Отметка «Публикация тендера в Telegram-канале» в строке тендера под описанием работ.
// Три состояния (utils/tgPublish.js): серое «не опубликовано», зелёное «опубликовано»,
// красное «не публиковать». Клик (для редакторов) — следующее по кругу; onToggle(tender, next).

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const whoWhen = (by, at) => `${by ? ` · ${by}` : ''}${at ? ` · ${fmtDate(at)}` : ''}`

const IconBox = ({ state }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    {state === TG_PUBLISHED && <path d="M8 12.5l2.6 2.6L16 9" />}
    {state === TG_SKIP && <path d="M9 9l6 6M15 9l-6 6" />}
  </svg>
)

const LABEL = { none: 'Публикация в ТГ', published: 'Опубликовано в ТГ', skip: 'Не публиковать в ТГ' }
const STATE_CLASS = { none: 'is-unpub', published: 'is-pub', skip: 'is-skip' }

// short — короткая подпись для плотного реестра; полный смысл остаётся в подсказке.
export default function TgPublishToggle({ tender, canEdit = false, onToggle, short = false }) {
  const state = tgState(tender)
  const label = short ? 'ТГ' : LABEL[state]
  const cls = `tgpub ${STATE_CLASS[state]}`

  let title
  if (state === TG_PUBLISHED) title = `Опубликовано в Telegram-канале${whoWhen(tender.tg_published_by, tender.tg_published_at)}`
  else if (state === TG_SKIP) title = `Не публиковать${whoWhen(tender.tg_skip_by, tender.tg_skip_at)}`
  else title = canEdit ? 'Отметить публикацию тендера в Telegram-канале' : 'Не опубликовано в ТГ'

  if (!canEdit) {
    return (
      <span className={`${cls} is-readonly`} title={title}>
        <IconBox state={state} /> <span>{label}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={short ? title : undefined}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onToggle(tender, nextTgState(state, tgSkipSupported(tender)))
      }}
    >
      <IconBox state={state} /> <span>{label}</span>
    </button>
  )
}
