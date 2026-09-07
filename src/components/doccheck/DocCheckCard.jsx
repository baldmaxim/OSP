import { DOC_TYPE_LABEL, DOC_TYPE_TITLE, docTitle } from '../../utils/docCheckHelpers'

const IconPaperclip = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

// Карточка заявки на проверку ДП/ДС на канбан-доске.
// Состав ровно тот, что нужен для опознания документа в колонке: тип с номером и
// датой, контрагент, объект. Остальное — в карточке заявки по клику.
function DocCheckCard({ request, onOpen, onDragStart, onDragEnd, isDragging }) {
  return (
    <article
      className={`dc-card dc-card--${request.doc_type}${isDragging ? ' is-dragging' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, request)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(request.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(request.id) }}
      role="button"
      tabIndex={0}
      title={docTitle(request)}
    >
      <div className="dc-card-head">
        <span className={`dc-type dc-type--${request.doc_type}`} title={DOC_TYPE_TITLE[request.doc_type]}>
          {DOC_TYPE_LABEL[request.doc_type] || '—'}
        </span>
        <h4 className="dc-card-title">{docTitle(request)}</h4>
      </div>

      <div className="dc-card-cp">{request.counterparties?.name || 'Контрагент не указан'}</div>

      <div className="dc-card-foot">
        <span className="dc-chip dc-chip--object" title={request.objects?.name || 'Объект не указан'}>
          {request.objects?.name || 'Без объекта'}
        </span>
        {request.docsCount > 0 && (
          <span className="dc-count" title="Вложенные файлы"><IconPaperclip />{request.docsCount}</span>
        )}
      </div>
    </article>
  )
}

export default DocCheckCard
