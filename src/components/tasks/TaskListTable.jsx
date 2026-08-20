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

// Договор встречается у задач заметно реже объекта и тендера, поэтому отдельную
// колонку под него не заводим — чип идёт подписью под названием задачи, чтобы не
// растить и без того широкую таблицу.
function ContractLink({ task }) {
  if (!task.contract_id) return null
  return (
    <Link to={`/contracts/${task.contract_id}`} className="task-chip chip-contract"
      onClick={(e) => e.stopPropagation()}>
      Договор{task.contracts?.contract_number ? ` № ${task.contracts.contract_number}` : ''}
    </Link>
  )
}

// Объект и тендер вынесены в отдельные колонки — по ним чаще всего ищут глазами.
function ObjectLink({ task }) {
  if (!task.object_id || !task.objects?.name) return <span className="task-muted">—</span>
  return (
    <Link to={`/general/objects/${task.object_id}`} className="task-chip chip-object"
      title={task.objects.name} onClick={(e) => e.stopPropagation()}>{task.objects.name}</Link>
  )
}

function TenderLink({ task }) {
  if (!task.tender_id) return <span className="task-muted">—</span>
  const num = task.tenders?.public_tender_number
  return (
    <Link to={`/tenders/${task.tender_id}`} className="task-chip chip-tender"
      onClick={(e) => e.stopPropagation()}>{num != null ? `№ ${num}` : 'Тендер'}</Link>
  )
}

// «Иванов Иван Иванович» → «Иванов И.». В строке соисполнителей их бывает
// несколько, полные ФИО не помещаются.
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/)
  if (parts.length < 2) return full || ''
  return `${parts[0]} ${parts[1].charAt(0)}.`
}

// task 433: реестровый вид задач — для контроля сроков, когда карточек уже много.
// startIndex — смещение текущей страницы: нумерация сквозная, а не заново с
// единицы на каждой странице.
// coassigneesByTask — Map<task_id, user_id[]>: соисполнители показываются второй
// строкой под исполнителем, иначе непонятно, кто ещё занят задачей.
function TaskListTable({
  tasks, employeeMap, onOpen, onStatusChange, sort, onSort, isPhone, canEdit,
  startIndex = 0, coassigneesByTask,
}) {
  const nameOf = (userId) => (userId
    ? (employeeMap.get(userId)?.display_name || 'Пользователь удалён')
    : 'Не назначен')
  const coassigneesOf = (taskId) => (coassigneesByTask?.get(taskId) || [])

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
            <th className="col-num" title="Порядковый номер">№</th>
            <th className="col-object">Объект</th>
            <th className="col-tender">№ тендера</th>
            <SortTh field="title" className="col-title">Задача</SortTh>
            <th className="col-person">Постановщик</th>
            <th className="col-person">Исполнитель</th>
            <SortTh field="priority" className="col-priority">Приоритет</SortTh>
            <SortTh field="due_date" className="col-due">Срок</SortTh>
            <th className="col-status">Статус</th>
            <SortTh field="updated_at" className="col-updated">Обновлено</SortTh>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, index) => (
            <tr key={task.id} className={isOverdue(task) ? 'is-overdue' : ''} onClick={() => onOpen(task.id)}>
              <td className="col-num">{startIndex + index + 1}</td>
              <td className="col-object"><ObjectLink task={task} /></td>
              <td className="col-tender"><TenderLink task={task} /></td>
              <td className="col-title">
                <span className="task-title-cell">{task.title}</span>
                {task.checklistTotal > 0 && (
                  <span className="task-muted"> · чек-лист {task.checklistDone}/{task.checklistTotal}</span>
                )}
                {task.contract_id && (
                  <div className="task-title-sub"><ContractLink task={task} /></div>
                )}
              </td>
              <td className="col-person">
                <span className="task-person-name">{nameOf(task.created_by_user_id)}</span>
              </td>
              <td className="col-person">
                <span className="task-person">
                  <UserAvatar userId={task.assignee_user_id} name={nameOf(task.assignee_user_id)} />
                  <span className="task-person-name">{nameOf(task.assignee_user_id)}</span>
                </span>
                {/* Соисполнители — второй строкой: по одной колонке видно всех,
                    кто занят задачей, а не только основного исполнителя. */}
                {coassigneesOf(task.id).length > 0 && (
                  <div className="task-coassignees" title={coassigneesOf(task.id).map(nameOf).join(', ')}>
                    + {coassigneesOf(task.id).map(id => shortName(nameOf(id))).join(', ')}
                  </div>
                )}
              </td>
              <td className="col-priority">
                <span className={`task-priority-badge ${TASK_PRIORITY_CLASS[task.priority]}`}>
                  {TASK_PRIORITY_LABEL[task.priority]}
                </span>
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
                    colorOptions
                  />
                ) : (
                  <span className={`status-badge ${TASK_STATUS_CLASS[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
                )}
              </td>
              <td className="col-updated">{formatDateRu(task.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default TaskListTable
