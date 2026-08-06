import './TgPublishToggle.css'

// Галочка «Публикация тендера в Telegram-канале». После запуска тендера сотрудник
// публикует его в ТГ-канале и отмечает это здесь. Показывается в строке тендера под
// описанием работ. Клик (для редакторов) переключает состояние; onToggle(tenderId, next).

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const IconBox = ({ checked }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    {checked && <path d="M8 12.5l2.6 2.6L16 9" />}
  </svg>
)

export default function TgPublishToggle({ tender, canEdit = false, onToggle }) {
  const published = !!tender.tg_published
  const label = published ? 'Опубликовано в ТГ' : 'Публикация в ТГ'
  const cls = `tgpub ${published ? 'is-pub' : 'is-unpub'}`

  const title = published
    ? `Опубликовано в Telegram-канале${tender.tg_published_by ? ` · ${tender.tg_published_by}` : ''}${tender.tg_published_at ? ` · ${fmtDate(tender.tg_published_at)}` : ''}`
    : 'Отметить публикацию тендера в Telegram-канале'

  if (!canEdit) {
    return (
      <span className={`${cls} is-readonly`} title={published ? title : 'Не опубликовано в ТГ'}>
        <IconBox checked={published} /> <span>{label}</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      title={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(tender.id, !published) }}
    >
      <IconBox checked={published} /> <span>{label}</span>
    </button>
  )
}
