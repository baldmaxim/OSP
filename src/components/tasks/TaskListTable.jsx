import { Link } from 'react-router-dom'
import StatusDropdown from '../StatusDropdown'
import UserAvatar from './UserAvatar'
import {
  TASK_PRIORITY_CLASS,
  TASK_PRIORITY_LABEL,
  TASK_STATUSES,
  TASK_STATUS_CLASS,
  TASK_STATUS_LABEL,
  dueClass,
  dueLabel,
  formatDateRu,
  isOverdue,
} from '../../utils/taskHelpers'

// StatusDropdown работает с простыми строками-подписями, поэтому переводим
// value ↔ label на границе компонента.
const STATUS_LABELS = TASK_STATUSES.map(s => s.label)
const VALUE_BY_LABEL = Object.fromEntries(TASK_STATUSES.map(s => [s.label, s.value]))
const CLASS_BY_LABEL = Object.fromEntries(TASK_STATUSES.map(s => [s.label, s.className]))

// Ссылка на связанную сущность: объект / тендер / договор.
function TaskLinks({ task }) {
  const items = []
  if (task.object_id && task.objects?.name) {
    items.push(<Link key="o" to={`/general/objects/${task.object_id}`} className="task-chip chip-object"
      onClick={(e) => e.stopPropagation()}>{task.objects.name}</Link>)
  }
  if (task.tender_id) {
    items.push(<Link key="t" to={`/tenders/${task.tender_id}`} className="task-chip chip-tender"
      onClick={(e) => e.stopPropagation()}>
      Тендер{task.tenders?.public_tender_number != null ? ` №${task.tenders.public_tender_number}` : ''}
    </Link>)
  }
  if (task.contract_id) {
    items.push(<Link key="c" to={`/contracts/${task.contract_id}`} className="task-chip chip-contract"
      onClick={(e) => e.stopPropagation()}>
      Договор{task.contracts?.contract_number ? ` № ${task.contracts.contract_number}` : ''}
    </Link>)
  }
  if (!items.length) return <span className="task-muted">—</span>
  return <span className="task-links">{items}</span>
}

// task 433: реестровый вид задач — для контроля сроков, когда карточек уже много.
function TaskListTable({ tasks, employeeMap, onOpen, onStatusChange, sort, onSort, isPhone, canEdit }) {
  const nameOf = (userId) => (userId
    ? (employeeMap.get(userId)?.display_name || 'Пользователь удалён')
    : 'Не назначен')

  if (isPhone) {
    return (
      <div className="mobile-cards">
        {tasks.map(task => (
          <div key={task.id} className={`mcard${isOverdue(task) ? ' is-overdue' : ''}`} onClick={() => onOpen(task.id)}>
            <div className="mcard-head">
              <span className={`status-badge ${TASK_STATUS_CLASS[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
              {task.priority !== 'normal' && (
                <span className={`task-card-priority ${TASK_PRIORITY_CLASS[task.priority]}`}>
                  {TASK_PRIORITY_LABEL[task.priority]}
                </span>
              )}
            </div>
            <div className="mcard-title">{task.title}</div>
            <div className="mcard-rows">
              <div className="mcard-row"><span>Исполнитель</span><b>{nameOf(task.assignee_user_id)}</b></div>
              <div className="mcard-row">
                <span>Срок</span>
                <b className={`task-due ${dueClass(task.due_date, task.status)}`}>
                  {task.due_date ? `${formatDateRu(task.due_date)} · ${dueLabel(task.due_date)}` : '—'}
                </b>
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const SortTh = ({ field, children, className }) => (
    <th
      className={`${className || ''} is-sortable${sort.field === field ? ' is-sorted' : ''}`}
      onClick={() => onSort(field)}
      title="Сортировать"
    >
      {children}
      {sort.field === field && <span className="sort-caret" aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  )

  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <thead>
          <tr>
            <SortTh field="priority" className="col-priority">Приоритет</SortTh>
            <SortTh field="title" className="col-title">Задача</SortTh>
            <th className="col-person">Исполнитель</th>
            <th className="col-person">Постановщик</th>
            <SortTh field="due_date" className="col-due">Срок</SortTh>
            <th className="col-status">Статус</th>
            <th className="col-links">Связь</th>
            <SortTh field="updated_at" className="col-updated">Обновлено</SortTh>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.id} className={isOverdue(task) ? 'is-overdue' : ''} onClick={() => onOpen(task.id)}>
              <td className="col-priority">
                <span className={`task-priority-badge ${TASK_PRIORITY_CLASS[task.priority]}`}>
                  {TASK_PRIORITY_LABEL[task.priority]}
                </span>
              </td>
              <td className="col-title">
                <span className="task-title-cell">{task.title}</span>
                {task.checklistTotal > 0 && (
                  <span className="task-muted"> · чек-лист {task.checklistDone}/{task.checklistTotal}</span>
                )}
              </td>
              <td className="col-person">
                <span className="task-person">
                  <UserAvatar userId={task.assignee_user_id} name={nameOf(task.assignee_user_id)} />
                  <span className="task-person-name">{nameOf(task.assignee_user_id)}</span>
                </span>
              </td>
              <td className="col-person">
                <span className="task-person-name">{nameOf(task.created_by_user_id)}</span>
              </td>
              <td className="col-due">
                <span className={`task-due ${dueClass(task.due_date, task.status)}`}>
                  {task.due_date ? formatDateRu(task.due_date) : '—'}
                </span>
              </td>
              <td className="col-status" onClick={(e) => e.stopPropagation()}>
                {canEdit ? (
                  <StatusDropdown
                    value={TASK_STATUS_LABEL[task.status]}
                    options={STATUS_LABELS}
                    getBadgeClass={(label) => CLASS_BY_LABEL[label] || ''}
                    onChange={(label) => onStatusChange(task, VALUE_BY_LABEL[label])}
                    ariaLabel="Статус задачи"
                  />
                ) : (
                  <span className={`status-badge ${TASK_STATUS_CLASS[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
                )}
              </td>
              <td className="col-links"><TaskLinks task={task} /></td>
              <td className="col-updated">{formatDateRu(task.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default TaskListTable
