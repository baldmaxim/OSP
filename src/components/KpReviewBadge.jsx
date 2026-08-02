import './KpReviewBadge.css'

// task 431: индикатор статуса проверки КП (галочка/замечания/на проверке).
// Показывается всем; если canReview — кликабелен и открывает проверку (onReview).
// showRemarks=true — под бейджем выводится текст замечаний (для has_remarks).

const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const IconWarn = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)
const IconClock = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
)

function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

const META = {
  pending: { cls: 'kpb-pending', icon: IconClock, label: 'На проверке' },
  approved: { cls: 'kpb-approved', icon: IconCheck, label: 'Проверено' },
  has_remarks: { cls: 'kpb-remarks', icon: IconWarn, label: 'Замечания' },
}

export default function KpReviewBadge({ file, canReview = false, onReview, showRemarks = false }) {
  const status = file.review_status || 'pending'
  const m = META[status] || META.pending
  const Icon = m.icon

  const tooltip = status === 'has_remarks'
    ? (file.review_note || 'Есть замечания')
    : status === 'approved'
      ? `Проверено${file.reviewed_by ? ` · ${file.reviewed_by}` : ''}${file.reviewed_at ? ` · ${fmt(file.reviewed_at)}` : ''}`
      : 'Ожидает проверки аналитиком'

  const pill = (
    <span className="kpb-pill-inner">
      <Icon />
      <span>{m.label}</span>
    </span>
  )

  return (
    <span className="kpb-wrap">
      {canReview ? (
        <button
          type="button"
          className={`kpb-pill ${m.cls} kpb-clickable`}
          title={`${tooltip}\nНажмите, чтобы изменить проверку`}
          onClick={() => onReview?.(file)}
        >{pill}</button>
      ) : (
        <span className={`kpb-pill ${m.cls}`} title={tooltip}>{pill}</span>
      )}
      {showRemarks && status === 'has_remarks' && file.review_note && (
        <span className="kpb-remarks-text">{file.review_note}</span>
      )}
    </span>
  )
}
