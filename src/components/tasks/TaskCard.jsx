import UserAvatar from './UserAvatar'
import {
  TASK_PRIORITY_CLASS,
  TASK_PRIORITY_LABEL,
  dueClass,
  dueLabel,
} from '../../utils/taskHelpers'

// Иконки-счётчики карточки: чек-лист, обсуждение, файлы.
const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)
const IconComment = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

// task 433: карточка задачи на канбан-доске.
// Состав повторяет то, что доказали YouGile/Kaiten: цветовая метка приоритета,
// заголовок, связи, срок «светофором», исполнитель и счётчики вложенного.
function TaskCard({ task, assigneeName, onOpen, onDragStart, onDragEnd, isDragging }) {
  const due = task.due_date ? dueLabel(task.due_date) : ''
  return (
    <article
      className={`task-card ${TASK_PRIORITY_CLASS[task.priority] || 'tp-normal'}${isDragging ? ' is-dragging' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(task.id) }}
      role="button"
      tabIndex={0}
      title={task.title}
    >
      {task.priority !== 'normal' && (
        <span className="task-card-priority">{TASK_PRIORITY_LABEL[task.priority]}</span>
      )}
      <h4 className="task-card-title">{task.title}</h4>

      {(task.objects?.name || task.tenders?.public_tender_number != null || task.contracts?.contract_number) && (
        <div className="task-card-links">
          {task.objects?.name && <span className="task-chip chip-object" title={task.objects.name}>{task.objects.name}</span>}
          {task.tenders?.public_tender_number != null && (
            <span className="task-chip chip-tender">Тендер №{task.tenders.public_tender_number}</span>
          )}
          {task.contracts?.contract_number && (
            <span className="task-chip chip-contract">Договор № {task.contracts.contract_number}</span>
          )}
        </div>
      )}

      <div className="task-card-foot">
        <UserAvatar userId={task.assignee_user_id} name={assigneeName} title={assigneeName} />
        <div className="task-card-meta">
          {task.checklistTotal > 0 && (
            <span className={`task-count ${task.checklistDone === task.checklistTotal ? 'is-full' : ''}`}
              title="Чек-лист">
              <IconCheck />{task.checklistDone}/{task.checklistTotal}
            </span>
          )}
          {task.commentsCount > 0 && (
            <span className="task-count" title="Комментарии"><IconComment />{task.commentsCount}</span>
          )}
        </div>
        {due && <span className={`task-due ${dueClass(task.due_date, task.status)}`}>{due}</span>}
      </div>
    </article>
  )
}

export default TaskCard
