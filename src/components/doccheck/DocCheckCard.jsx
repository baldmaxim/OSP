import { memo } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconTag } from '../icons/ToolbarIcons'
import { IconCalendar, IconCheck, IconFlag, IconMore } from '../icons/ActionIcons'
import DocCheckAvatars from './DocCheckAvatars'
import DocCheckCardCounts from './DocCheckCardCounts'
import {
  CLOSED_DOC_CHECK_STATUSES,
  DOC_CHECK_PRIORITY_LABEL,
  cardTitle,
  createdShort,
  dueShort,
  dueState,
  fmtDocDate,
  requestIdLabel,
  shownAssigneeIds,
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
// номер заявки (ID, с 20270123), объект, дата добавления и метки, срок, приоритет, файлы, сообщения, письмо и кружки
// исполнителей; цвет карточки — заливкой. Остальное — в карточке заявки по щелчку.
function DocCheckCard({ request, employees, canEdit, onOpen, onToggleDone, onMenu }) {
  const done = CLOSED_DOC_CHECK_STATUSES.has(request.status)
  const due = dueState(request)
  const created = createdShort(request.created_at)
  const classes = [
    'dc-card',
    canEdit ? 'is-movable' : '',
    request.color ? `has-color dc-c-${request.color}` : '',
    done ? 'is-done' : '',
    due === 'overdue' ? 'is-overdue' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={classes}
      data-id={request.id}
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

      <div className="dc-card-foot">
        <div className="dc-card-chips">
          <span className="dc-card-where">
            {request.request_number != null && (
              <span className="dc-chip dc-chip--id" title="Номер заявки — не меняется; поиск: «ID 123»">{requestIdLabel(request)}</span>
            )}
            <span className="dc-chip dc-chip--object" title={request.objects?.name || 'Объект не указан'}>
              {request.objects?.name || 'Без объекта'}
            </span>
            {created && (
              <span className="dc-chip dc-chip--created" title={`Дата добавления: ${fmtDocDate(request.created_at)}`}>{created}</span>
            )}
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
          <DocCheckCardCounts request={request} />
        </div>
        <DocCheckAvatars ids={shownAssigneeIds(request, employees)} employees={employees} />
      </div>
    </article>
  )
}

// memo: на доске сотни карточек, перерисовывается только та, у которой изменились данные (см. mergeRequestCounts).
export default memo(DocCheckCard)
