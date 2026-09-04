import './TgPublishToggle.css'
import './CompletionLetterToggle.css'

// Галочка «Письмо о завершении отправлено всем участникам тендера».
//
// Между «Подведением итогов» и «Завершен» есть шаг, у которого нет своего статуса:
// проигравшим подрядчикам рассылают письмо о закрытии тендера. Отдельной стадией
// его не делаем — это признак выполненного действия, как публикация в ТГ, поэтому
// компонент повторяет TgPublishToggle и переиспользует его стили.
//
// Показывается только там, где шаг актуален: на подведении итогов и после него.
// На «Заявке на тендер» галочка была бы шумом.

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const IconMail = ({ checked }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="3" />
    {checked ? <path d="m6 10 5 4 7-7" /> : <path d="m2.5 6.5 9.5 7 9.5-7" />}
  </svg>
)

// Стадии, на которых шаг имеет смысл. «Приостановка тендера» сюда не входит:
// пока процедура заморожена, рассылать письмо о завершении нечего.
const RELEVANT_STATUSES = ['Подведение итогов', 'Завершен']

export function isCompletionLetterRelevant(status) {
  return RELEVANT_STATUSES.includes(status)
}

export default function CompletionLetterToggle({ tender, canEdit = false, onToggle }) {
  if (!isCompletionLetterRelevant(tender?.status)) return null

  const sent = !!tender.completion_letter_sent
  const label = sent ? 'Письмо о завершении отправлено' : 'Письмо о завершении'
  const cls = `tgpub cletter ${sent ? 'is-pub' : 'is-unpub'}`

  const title = sent
    ? `Письмо о завершении разослано участникам${tender.completion_letter_sent_by ? ` · ${tender.completion_letter_sent_by}` : ''}${tender.completion_letter_sent_at ? ` · ${fmtDate(tender.completion_letter_sent_at)}` : ''}`
    : 'Отметить, что письмо о завершении тендера разослано всем участникам'

  if (!canEdit) {
    return (
      <span className={`${cls} is-readonly`} title={sent ? title : 'Письмо о завершении не отправлено'}>
        <IconMail checked={sent} /> <span>{label}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(tender.id, !sent) }}
    >
      <IconMail checked={sent} /> <span>{label}</span>
    </button>
  )
}
