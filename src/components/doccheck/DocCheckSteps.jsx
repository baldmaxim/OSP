import { useRef, useState } from 'react'
import DocCheckGrowingField from './DocCheckGrowingField'
import { IconClose } from '../icons/ToolbarIcons'
import { IconPencil } from '../icons/ActionIcons'
import useChecklistSort from '../../hooks/useChecklistSort'
import { addSteps, deleteStep, saveStepOrder, updateStep } from '../../services/docCheckCard'
import { MAX_STEP_TITLE, compareSteps, stepTitles } from '../../utils/docCheckHelpers'
import { nextChecklistOrder, plural, reorderChecklist } from '../../utils/taskHelpers'

// Шаги заявки — по образцу чек-листа задачи ([TaskDetailModal](src/components/tasks/TaskDetailModal.jsx)): ручка слева
// для порядка, правка текста, несколько шагов строками (Shift+Enter). Добавляет, правит, удаляет и переставляет тот, у
// кого право правки раздела (canArrange); отметить шаг может ещё и исполнитель заявки (canTick). Список держит окно
// заявки: от него зависят счётчик вкладки и карточка на доске.
export default function DocCheckSteps({ requestId, steps, onStepsChange, onReload, canArrange, canTick }) {
  const [draft, setDraft] = useState('')
  // Шаг в правке: { id, title }. Ref не даёт сохранить дважды (Enter, затем уход из поля).
  const [editing, setEditing] = useState(null)
  const editingRef = useRef(null)
  // Не даёт добавить шаги дважды (Enter, нажатый снова до ответа базы).
  const addingRef = useRef(false)
  const lines = stepTitles(draft)
  const done = steps.filter(s => s.is_done).length

  const add = async () => {
    if (!lines.length || addingRef.current) return
    addingRef.current = true
    try {
      const rows = await addSteps(requestId, lines, nextChecklistOrder(steps))
      onStepsChange(prev => [...prev, ...rows].sort(compareSteps))
      setDraft('')
    } catch (err) {
      alert('Не удалось добавить шаг: ' + (err.message || err))
    } finally {
      addingRef.current = false
    }
  }

  // Отметка и удаление — сразу на экране; отказ — вернуть как в базе.
  const toggle = async (step) => {
    onStepsChange(prev => prev.map(s => (s.id === step.id ? { ...s, is_done: !step.is_done } : s)))
    try {
      await updateStep(step.id, { is_done: !step.is_done })
    } catch (err) {
      alert('Не удалось изменить шаг: ' + (err.message || err))
      onReload()
    }
  }
  const remove = async (step) => {
    onStepsChange(prev => prev.filter(s => s.id !== step.id))
    try {
      await deleteStep(step.id)
    } catch (err) {
      alert('Не удалось удалить шаг: ' + (err.message || err))
      onReload()
    }
  }

  const startEdit = (step) => {
    editingRef.current = { id: step.id, title: step.title }
    setEditing(editingRef.current)
  }
  const changeEdit = (title) => {
    editingRef.current = { ...editingRef.current, title }
    setEditing(editingRef.current)
  }
  const cancelEdit = () => {
    editingRef.current = null
    setEditing(null)
  }
  // Пустой текст шаг не удаляет — для этого есть крестик; правка просто отменяется.
  const commitEdit = async () => {
    const edit = editingRef.current
    if (!edit) return
    cancelEdit()
    const step = steps.find(s => s.id === edit.id)
    const title = edit.title.trim()
    if (!step || !title || title === step.title) return
    onStepsChange(prev => prev.map(s => (s.id === step.id ? { ...s, title } : s)))
    try {
      await updateStep(step.id, { title })
    } catch (err) {
      alert('Не удалось изменить шаг: ' + (err.message || err))
      onReload()
    }
  }

  // Порядок: сразу на экране, затем в базе — только у шагов, чей номер изменился.
  const reorder = async (draggedId, targetId, position) => {
    const result = reorderChecklist(steps, draggedId, targetId, position)
    if (!result) return
    onStepsChange(() => result.ordered)
    try {
      await saveStepOrder(result.updates)
    } catch (err) {
      alert('Не удалось изменить порядок шагов: ' + (err.message || err))
      onReload()
    }
  }
  const { drag, listRef, handleProps } = useChecklistSort({
    items: steps, onReorder: reorder, handleSelector: '.dc-step-handle',
  })

  return (
    <div className="dc-steps-block">
      {steps.length > 0 ? (
        <div className="dc-steps-summary">
          <span className="ui-num">Сделано {done} из {steps.length}</span>
          <div className="dc-steps-progress" aria-hidden="true">
            <span style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <p className="dc-muted">Шагов пока нет.</p>
      )}

      <ul className={`dc-steps${drag ? ' is-sorting' : ''}`} ref={listRef}>
        {steps.map(step => {
          const isEditing = editing?.id === step.id
          const rowClass = [
            step.is_done ? 'is-done' : '',
            drag?.id === step.id ? 'is-dragging' : '',
            drag?.overId === step.id ? `drop-${drag.position}` : '',
          ].filter(Boolean).join(' ')
          return (
            <li key={step.id} data-item-id={step.id} className={rowClass}>
              {canArrange && steps.length > 1 && (
                <button
                  type="button"
                  className="dc-step-handle"
                  aria-label={`Переместить шаг «${step.title}»`}
                  title="Перетащите, чтобы изменить порядок (или стрелки ↑ ↓)"
                  {...handleProps(step)}
                >⋮⋮</button>
              )}
              {isEditing ? (
                <input
                  type="text"
                  className="dc-step-edit"
                  aria-label="Текст шага"
                  autoFocus
                  maxLength={MAX_STEP_TITLE}
                  value={editing.title}
                  onChange={(e) => changeEdit(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                  }}
                />
              ) : (
                <label className="dc-step-label">
                  <input
                    type="checkbox"
                    checked={step.is_done}
                    disabled={!canTick}
                    onChange={() => toggle(step)}
                  />
                  <span>{step.title}</span>
                </label>
              )}
              {canArrange && !isEditing && (
                <button
                  type="button"
                  className="dc-step-btn"
                  aria-label={`Изменить шаг «${step.title}»`}
                  title="Изменить шаг"
                  onClick={() => startEdit(step)}
                ><IconPencil size={14} /></button>
              )}
              {canArrange && (
                <button
                  type="button"
                  className="dc-step-btn dc-step-del"
                  aria-label={`Удалить шаг «${step.title}»`}
                  title="Удалить шаг"
                  onClick={() => remove(step)}
                ><IconClose size={14} /></button>
              )}
            </li>
          )
        })}
      </ul>

      {canArrange && (
        <div className="dc-inline-add">
          <DocCheckGrowingField
            value={draft}
            onChange={setDraft}
            onSubmit={add}
            placeholder="Добавить шаг"
            aria-label="Новый шаг"
            title="Enter — добавить. Shift+Enter — новая строка: каждая строка станет отдельным шагом"
          />
          <button type="button" className="btn-secondary" onClick={add}>
            {lines.length > 1 ? `Добавить ${lines.length} ${plural(lines.length, 'шаг', 'шага', 'шагов')}` : 'Добавить'}
          </button>
        </div>
      )}
    </div>
  )
}
