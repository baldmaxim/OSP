import './CounterpartyDocBadges.css'

// Минималистичные иконки-индикаторы документов контрагента:
//   • Согласование СБ (doc_category='sb_approval') — щит с галочкой + дата загрузки
//   • Должная осмотрительность (doc_category='other') — документ с лупой + число
// summary — элемент из fetchCounterpartyDocSummary(): { sb: {date}|null, other: {date,count}|null }.
// onOpen (необязательно) — клик по иконке открывает детали (в реестре договоров не
// передаётся — иконки чисто информационные). showDate — показывать дату СБ рядом.

// Lucide-style inline SVG (currentColor, strokeWidth 2) — как в CounterpartyCardChip.
const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const ShieldCheckIcon = () => (
  <Svg>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)
const DueDiligenceIcon = () => (
  <Svg>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9" />
    <polyline points="14 2 14 8 20 8" />
    <circle cx="16.5" cy="16.5" r="2.5" />
    <line x1="21" y1="21" x2="18.3" y2="18.3" />
  </Svg>
)

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

export default function CounterpartyDocBadges({ summary, onOpen, showDate = false }) {
  const sb = summary?.sb || null
  const other = summary?.other || null

  const handle = (e) => {
    if (!onOpen) return
    e.stopPropagation()
    onOpen()
  }

  const Tag = onOpen ? 'button' : 'span'
  const sbTitle = sb ? `Согласование СБ: загружено ${formatDate(sb.date)}` : 'Согласование СБ: нет документа'
  const otherTitle = other
    ? `Должная осмотрительность: ${other.count} док. (посл. ${formatDate(other.date)})`
    : 'Должная осмотрительность: нет документов'

  return (
    <span className="cp-doc-badges">
      <Tag
        type={onOpen ? 'button' : undefined}
        className={`cp-doc-badge${sb ? ' is-on' : ' is-off'}${onOpen ? ' is-clickable' : ''}`}
        title={sbTitle}
        aria-label={sbTitle}
        onClick={onOpen ? handle : undefined}
      >
        <ShieldCheckIcon />
        {showDate && sb && <span className="cp-doc-badge-text">{formatDate(sb.date)}</span>}
      </Tag>
      <Tag
        type={onOpen ? 'button' : undefined}
        className={`cp-doc-badge${other ? ' is-on' : ' is-off'}${onOpen ? ' is-clickable' : ''}`}
        title={otherTitle}
        aria-label={otherTitle}
        onClick={onOpen ? handle : undefined}
      >
        <DueDiligenceIcon />
        {showDate && other && <span className="cp-doc-badge-text">{formatDate(other.date)}</span>}
        {other && other.count > 1 && <span className="cp-doc-badge-count">{other.count}</span>}
      </Tag>
    </span>
  )
}
