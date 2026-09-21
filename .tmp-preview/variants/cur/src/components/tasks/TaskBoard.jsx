import { useState } from 'react'
import TaskCard from './TaskCard'
import UserAvatar from './UserAvatar'
import { TASK_STATUSES, TASK_STATUS_CLASS, compareForBoard } from '../../utils/taskHelpers'

// task 433: канбан-доска.
//
// Две раскладки колонок:
//   groupBy='status'   — колонки = статусы (классический канбан, ведение работы);
//   groupBy='assignee' — колонки = сотрудники, перетаскивание = переназначение.
// Вторая раскладка и есть главный сценарий раздела — «распределяю задачи по людям».
//
// DnD — нативный HTML5 draggable (как в TendersPage/ObjectDetailPage), без библиотек.
// Бросок на карточку вставляет ПЕРЕД ней, бросок на пустое место колонки — в конец.

const UNASSIGNED = '__none__'

function TaskBoard({ tasks, groupBy, employees, employeeMap, onOpen, onMove, canEdit }) {
  const [dragged, setDragged] = useState(null)      // перетаскиваемая задача
  const [overColumn, setOverColumn] = useState(null) // подсветка колонки-приёмника

  // Колонки: статусы либо сотрудники (+ «Не назначены», если такие задачи есть).
  // В раскладке по людям сотрудники с задачами идут первыми, «пустые» — следом:
  // так загруженные видны сразу, но перетащить задачу можно на любого.
  const withTasks = new Set(tasks.map(t => t.assignee_user_id).filter(Boolean))
  const columns = groupBy === 'status'
    ? TASK_STATUSES.map(s => ({ key: s.value, label: s.label, className: s.className }))
    : [
      ...(employees || [])
        .map(e => ({ key: e.user_id, label: e.display_name || e.email, userId: e.user_id }))
        .sort((a, b) => (withTasks.has(b.key) ? 1 : 0) - (withTasks.has(a.key) ? 1 : 0)),
      ...(tasks.some(t => !t.assignee_user_id) ? [{ key: UNASSIGNED, label: 'Не назначены' }] : []),
    ]

  const columnKeyOf = (task) => (groupBy === 'status'
    ? task.status
    : (task.assignee_user_id || UNASSIGNED))

  const byColumn = new Map(columns.map(c => [c.key, []]))
  for (const t of tasks) {
    const key = columnKeyOf(t)
    if (!byColumn.has(key)) byColumn.set(key, [])   // статус/сотрудник вне справочника
    byColumn.get(key).push(t)
  }
  for (const list of byColumn.values()) list.sort(compareForBoard)

  const handleDragStart = (e, task) => {
    if (!canEdit) { e.preventDefault(); return }
    setDragged(task)
    e.dataTransfer.effectAllowed = 'move'
    // Без setData Firefox не начинает перетаскивание.
    try { e.dataTransfer.setData('text/plain', task.id) } catch { /* noop */ }
  }

  const handleDrop = (columnKey, beforeTaskId) => {
    setOverColumn(null)
    const task = dragged
    setDragged(null)
    if (!task) return
    const list = (byColumn.get(columnKey) || []).filter(t => t.id !== task.id)
    const idx = beforeTaskId ? list.findIndex(t => t.id === beforeTaskId) : -1
    const orderedIds = [...list.map(t => t.id)]
    orderedIds.splice(idx >= 0 ? idx : orderedIds.length, 0, task.id)
    onMove(task, columnKey === UNASSIGNED ? null : columnKey, orderedIds)
  }

  return (
    <div className="task-board">
      {columns.map(col => {
        const list = byColumn.get(col.key) || []
        return (
          <section
            key={col.key}
            className={`task-column${overColumn === col.key ? ' is-over' : ''}`}
            onDragOver={(e) => { if (dragged) { e.preventDefault(); setOverColumn(col.key) } }}
            onDragLeave={(e) => {
              // Игнорируем переходы между дочерними элементами внутри колонки.
              if (!e.currentTarget.contains(e.relatedTarget)) setOverColumn(null)
            }}
            onDrop={(e) => { e.preventDefault(); handleDrop(col.key) }}
          >
            <header className={`task-column-head ${groupBy === 'status' ? (TASK_STATUS_CLASS[col.key] || '') : ''}`}>
              {groupBy === 'assignee' && (
                <UserAvatar userId={col.userId} name={col.label} title={col.label} />
              )}
              <span className="task-column-title" title={col.label}>{col.label}</span>
              <span className="task-column-count">{list.length}</span>
            </header>

            <div className="task-column-body">
              {list.map(task => (
                <div
                  key={task.id}
                  onDragOver={(e) => { if (dragged) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col.key, task.id) }}
                >
                  <TaskCard
                    task={task}
                    assigneeName={task.assignee_user_id
                      ? (employeeMap.get(task.assignee_user_id)?.display_name || 'Пользователь удалён')
                      : ''}
                    onOpen={onOpen}
                    onDragStart={handleDragStart}
                    onDragEnd={() => { setDragged(null); setOverColumn(null) }}
                    isDragging={dragged?.id === task.id}
                  />
                </div>
              ))}
              {list.length === 0 && <p className="task-column-empty">Пусто</p>}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export default TaskBoard
