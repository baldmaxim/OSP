import { useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import { TASK_PRIORITIES } from '../../utils/taskHelpers'

// task 433: постановка задачи. Обязательны только «что сделать» и «кому» —
// остальное (срок, связи, наблюдатели) заполняется по необходимости, чтобы
// поставить задачу можно было за пару секунд.
function TaskFormModal({ employees, objects, tenders, contracts, onClose, onSubmit, saving }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    assignee_user_id: '',
    due_date: '',
    priority: 'normal',
    object_id: '',
    tender_id: '',
    contract_id: '',
  })
  const [coassignees, setCoassignees] = useState([])
  const [watchers, setWatchers] = useState([])

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const peopleOptions = employees.map(e => ({ value: e.user_id, label: e.display_name || e.email }))

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.title.trim()) { alert('Укажите, что нужно сделать'); return }
    if (!form.assignee_user_id) { alert('Выберите исполнителя'); return }
    onSubmit(form, { coassignees, watchers })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Новая задача</h3>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-group full-width">
              <label>Что нужно сделать *</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="Например: подготовить ВОР по фасаду"
                autoFocus
              />
            </div>

            <div className="form-group full-width">
              <label>Описание</label>
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Детали, ссылки, что считать результатом"
                rows={3}
              />
            </div>

            <div className="form-group">
              <label>Исполнитель *</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={form.assignee_user_id}
                onChange={(v) => set('assignee_user_id', v)}
                options={peopleOptions}
                searchable
                searchPlaceholder="Поиск сотрудника…"
                allLabel="Выберите сотрудника"
              />
            </div>

            <div className="form-group">
              <label>Срок</label>
              <input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} />
            </div>

            <div className="form-group">
              <label>Приоритет</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={form.priority}
                onChange={(v) => set('priority', v || 'normal')}
                options={TASK_PRIORITIES.map(p => ({ value: p.value, label: p.label }))}
                allLabel="Обычный"
              />
            </div>

            <div className="form-group">
              <label>Соисполнители</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={coassignees}
                onChange={setCoassignees}
                options={peopleOptions}
                multiple
                searchable
                searchPlaceholder="Поиск сотрудника…"
                allLabel="Нет"
              />
            </div>

            <div className="form-group">
              <label>Наблюдатели</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={watchers}
                onChange={setWatchers}
                options={peopleOptions}
                multiple
                searchable
                searchPlaceholder="Поиск сотрудника…"
                allLabel="Нет"
              />
            </div>

            {/* Связи с разделами системы — то, чего нет во внешних таск-трекерах. */}
            <div className="form-group">
              <label>Объект</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={form.object_id}
                onChange={(v) => set('object_id', v)}
                options={objects.map(o => ({ value: o.id, label: o.name }))}
                searchable
                searchPlaceholder="Поиск объекта…"
                allLabel="Без привязки"
              />
            </div>

            <div className="form-group">
              <label>Тендер</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={form.tender_id}
                onChange={(v) => set('tender_id', v)}
                options={tenders}
                searchable
                searchPlaceholder="Поиск тендера…"
                allLabel="Без привязки"
              />
            </div>

            <div className="form-group">
              <label>Договор</label>
              <FilterDropdown
                className="task-field-picker"
                label=""
                value={form.contract_id}
                onChange={(v) => set('contract_id', v)}
                options={contracts}
                searchable
                searchPlaceholder="Поиск договора…"
                allLabel="Без привязки"
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Поставить задачу'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default TaskFormModal
