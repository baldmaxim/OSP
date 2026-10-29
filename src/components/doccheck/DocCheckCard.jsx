import PaperclipIcon from '../icons/PaperclipIcon'
import { IconTag } from '../icons/ToolbarIcons'
import { IconCalendar, IconCheck, IconFlag, IconMore } from '../icons/ActionIcons'
import DocCheckAvatars from './DocCheckAvatars'
import {
  CLOSED_DOC_CHECK_STATUSES,
  DOC_CHECK_PRIORITY_LABEL,
  DOC_CHECK_STATUS_LABEL,
  cardTitle,
  dueShort,
  dueState,
  fmtDocDate,
} from '../../utils/docCheckHelpers'

const DUE_TITLE = {
  overdue: 'Срок прошёл',
  today: 'Срок — сегодня',
  soon: 'Срок скоро',
  upcoming: 'Срок',
  closed: 'Срок (заявка завершена)',
}

// Карточка заявки на проверку ДП/ДС на доске — по образцу прежней доски отдела:
// кружок «завершить», заголовок «Контрагент / ДС № 1» с примечанием, внизу
// объект и метки, срок, приоритет, файлы и кружки исполнителей; цвет карточки —
// заливкой. Остальное — в карточке заявки по щелчку.
function DocCheckCard({
  request, employees, canEdit, showStatus, onOpen, onToggleDone, onMenu,
  onDragStart, onDragEnd, isDragging,
}) {
  const done = CLOSED_DOC_CHECK_STATUSES.has(request.status)
  const due = dueState(request)
  const classes = [
    'dc-card',
    request.color ? `has-color dc-c-${request.color}` : '',
    done ? 'is-done' : '',
    due === 'overdue' ? 'is-overdue' : '',
    isDragging ? 'is-dragging' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={classes}
      data-id={request.id}
      draggable={canEdit}
      onDragStart={(e) => onDragStart(e, request)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(request.id)}
    >
      <div className="dc-card-main">
        {canEdit ? (
          <button
            type="button"
            className="dc-card-check"
            aria-label={done ? 'Вернуть в работу' : 'Завершить'}
            title={done ? 'Вернуть в работу' : 'Завершить'}
            onClick={(e) => { e.stopPropagation(); onToggleDone(request) }}
          >{done && <IconCheck size={11} />}</button>
        ) : (
          <span className="dc-card-check is-static" aria-hidden="true">{done && <IconCheck size={11} />}</span>
        )}
        <button type="button" className="dc-card-title">
          <span className="dc-card-name">{cardTitle(request)}</span>
          {request.notes && <span className="dc-card-notes"> {request.notes}</span>}
        </button>
        {canEdit && (
          <button
            type="button"
            className="dc-card-more"
            aria-label="Действия с заявкой"
            title="Действия"
            onClick={(e) => { e.stopPropagation(); onMenu(request, e.currentTarget.getBoundingClientRect()) }}
          ><IconMore size={16} /></button>
        )}
      </div>

      {showStatus && (
        <div className="dc-card-status">{DOC_CHECK_STATUS_LABEL[request.status] || request.status}</div>
      )}

      <div className="dc-card-foot">
        <div className="dc-card-chips">
          <span className="dc-chip dc-chip--object" title={request.objects?.name || 'Объект не указан'}>
            {request.objects?.name || 'Без объекта'}
          </span>
          {(request.labels || []).map(l => (
            <span key={l} className="dc-chip dc-chip--label" title={`Метка: ${l}`}>
              <IconTag size={11} />{l}
            </span>
          ))}
          {request.due_date && (
            <span className={`dc-chip dc-due is-${due}`} title={`${DUE_TITLE[due] || 'Срок'}: ${fmtDocDate(request.due_date)}`}>
              <IconCalendar size={11} />{dueShort(request.due_date)}
            </span>
          )}
          {request.priority && (
            <span className={`dc-prio is-${request.priority}`} title={`Приоритет: ${DOC_CHECK_PRIORITY_LABEL[request.priority]}`}>
              <IconFlag size={12} />
              <span className="ui-sr-only">Приоритет: {DOC_CHECK_PRIORITY_LABEL[request.priority]}</span>
            </span>
          )}
          {request.docsCount > 0 && (
            <span className="dc-count" title="Файлы заявки"><PaperclipIcon size={12} />{request.docsCount}</span>
          )}
        </div>
        <DocCheckAvatars ids={request.assignee_ids} employees={employees} />
      </div>
    </article>
  )
}

export default DocCheckCard
