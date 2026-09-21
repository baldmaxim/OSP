import { useRef, useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import AutoGrowTextarea from '../AutoGrowTextarea'
import IconTile from '../IconTile'
import { IconTasks } from '../icons/NavIcons'
import { TASK_PRIORITIES } from '../../utils/taskHelpers'

// task 433: постановка задачи. Обязательны только «что сделать» и «кому» —
// остальное (срок, связи, наблюдатели) заполняется по необходимости, чтобы
// поставить задачу можно было за пару секунд.
//
// Поля сгруппированы по смыслу: сначала суть задачи, затем кому и когда, затем
// связи с разделами системы. Сплошная сетка из девяти полей читалась хуже —
// глазу не за что зацепиться.
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
  const [error, setError] = useState('')
  // Защита от двойной отправки: два быстрых клика попадают в один рендер, и оба
  // обработчика увидели бы saving === false из своего замыкания.
  const submittingRef = useRef(false)

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const peopleOptions = employees.map(e => ({ value: e.user_id, label: e.display_name || e.email }))

  const handleSubmit = (e) => {
    e.preventDefault()
    if (submittingRef.current || saving) return
    if (!form.title.trim()) { setError('Укажите, что нужно сделать'); return }
    if (!form.assignee_user_id) { setError('Выберите исполнителя'); return }
    setError('')
    submittingRef.current = true
    // Сбрасываем в микрозадаче: при ошибке сохранения модалка остаётся открытой,
    // и форма не должна залипнуть заблокированной.
    Promise.resolve(onSubmit(form, { coassignees, watchers }))
      .finally(() => { submittingRef.current = false })
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal task-form-modal" role="dialog" aria-modal="true">
        <header className="tfm-head">
          <IconTile tone="teal"><IconTasks /></IconTile>
          <div className="tfm-head-text">
            <h3>Новая задача</h3>
            <p>Обязательны только суть задачи и исполнитель</p>
          </div>
          <button type="button" className="tfm-close" onClick={onClose} aria-label="Закрыть">×</button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="tfm-body">
            <section className="tfm-section">
              <div className="tfm-field">
                <label htmlFor="tfm-title">Что нужно сделать <span className="tfm-req">*</span></label>
                <input
                  id="tfm-title"
                  type="text"
                  className="tfm-input tfm-input--title"
                  value={form.title}
                  onChange={(e) => { set('title', e.target.value); if (error) setError('') }}
                  placeholder="Например: подготовить ВОР по фасаду"
                  autoFocus
                />
              </div>

              <div className="tfm-field">
                <label htmlFor="tfm-desc">Описание</label>
                <AutoGrowTextarea
                  id="tfm-desc"
                  className="tfm-input tfm-textarea"
                  minHeight={76}
                  defaultValue={form.description}
                  onInput={(e) => set('description', e.target.value)}
                  placeholder="Детали, ссылки, что считать результатом"
                />
              </div>
            </section>

            <section className="tfm-section">
              <h4 className="tfm-section-title">Кому и когда</h4>
              <div className="tfm-grid">
                <div className="tfm-field">
                  <label>Исполнитель <span className="tfm-req">*</span></label>
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={form.assignee_user_id}
                    onChange={(v) => { set('assignee_user_id', v); if (error) setError('') }}
                    options={peopleOptions}
                    searchable
                    searchPlaceholder="Поиск сотрудника…"
                    allLabel="Выберите сотрудника"
                  />
                </div>

                <div className="tfm-field">
                  <label htmlFor="tfm-due">Срок</label>
                  <input
                    id="tfm-due"
                    type="date"
                    className="tfm-input"
                    value={form.due_date}
                    onChange={(e) => set('due_date', e.target.value)}
                  />
                </div>

                <div className="tfm-field">
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

                <div className="tfm-field">
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

                <div className="tfm-field tfm-field--wide">
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
              </div>
            </section>

            {/* Связи с разделами системы — то, чего нет во внешних таск-трекерах. */}
            <section className="tfm-section">
              <h4 className="tfm-section-title">Связано с</h4>
              <div className="tfm-grid tfm-grid--three">
                <div className="tfm-field">
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

                <div className="tfm-field">
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

                <div className="tfm-field">
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
            </section>
          </div>

          <footer className="tfm-foot">
            {error
              ? <span className="tfm-error">{error}</span>
              : <span className="tfm-hint">Задачу увидят исполнитель, соисполнители и наблюдатели</span>}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Поставить задачу'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

export default TaskFormModal
