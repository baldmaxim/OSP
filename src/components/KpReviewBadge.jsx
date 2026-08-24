import { requestDownloadUrl } from '../services/s3'
import './KpReviewBadge.css'

// task 431: индикатор статуса проверки КП (галочка/замечания/на проверке).
// Показывается всем; если canReview — кликабелен и открывает проверку (onReview).
// showRemarks=true — под бейджем выводится текст замечаний и ссылка на приложенный
// файл замечаний (для has_remarks). Виден и в тендерах (раскрытие контрагентов), и
// на вкладке «Проверка КП».

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
const IconPaperclip = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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
  const remarksDoc = file.review_note_s3 || null

  const openRemarksFile = async () => {
    if (!remarksDoc?.s3_key) return
    try {
      const { presigned_url } = await requestDownloadUrl(remarksDoc.s3_key)
      window.open(presigned_url, '_blank', 'noopener')
    } catch (e) {
      alert('Не удалось открыть файл замечаний: ' + (e.message || e))
    }
  }

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
      {status === 'has_remarks' && remarksDoc && (
        <button
          type="button"
          className="kpb-remarks-file"
          onClick={openRemarksFile}
          title={`Открыть файл замечаний: ${remarksDoc.file_name || ''}`}
        >
          <IconPaperclip />
          <span className="kpb-remarks-file-name">{remarksDoc.file_name || 'Файл замечаний'}</span>
        </button>
      )}
      {/* Занесение в сводную — общий шаг обеих веток (миграция 20260824), поэтому
          показываем и у «Проверено», и у «Замечаний». */}
      {showRemarks && (status === 'approved' || status === 'has_remarks') && (
        <span
          className={`kpb-sent ${file.summary_added ? 'is-sent' : 'is-todo'}`}
          title={file.summary_added
            ? `Занесено в сводную таблицу${file.summary_added_by ? ` · ${file.summary_added_by}` : ''}${file.summary_added_at ? ` · ${fmt(file.summary_added_at)}` : ''}`
            : 'КП ещё не занесено в сводную таблицу'}
        >{file.summary_added ? '✓ В сводной таблице' : 'К занесению в сводную'}</span>
      )}
      {/* Подветка «без отправки подрядчику» (миграция 20260826): маршрут
          заканчивается на сводной, очереди «к отправке» у такого КП нет. */}
      {showRemarks && status === 'has_remarks' && file.remarks_send_required === false && (
        <span className="kpb-sent is-muted" title="Замечания обрабатываются без отправки подрядчику">
          Без отправки подрядчику
        </span>
      )}
      {/* Отправка замечаний — следующий шаг после сводной. */}
      {showRemarks && status === 'has_remarks' && file.remarks_send_required !== false && file.summary_added && (
        <span
          className={`kpb-sent ${file.remarks_sent ? 'is-sent' : 'is-todo'}`}
          title={file.remarks_sent
            ? `Отправлено контрагенту${file.remarks_sent_by ? ` · ${file.remarks_sent_by}` : ''}${file.remarks_sent_at ? ` · ${fmt(file.remarks_sent_at)}` : ''}`
            : 'Замечания ещё не отправлены контрагенту'}
        >{file.remarks_sent ? '✓ Отправлено контрагенту' : 'К отправке контрагенту'}</span>
      )}
    </span>
  )
}
