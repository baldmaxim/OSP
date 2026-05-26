import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import '../components/ContractRegistry.css'
import './DcRequestsPage.css'

// Task 306 + 307. Реестр «Заявок на ДС» — независимая сущность.
// Только для основного строительства (objects.status='main_construction').
// У каждой заявки несколько задач (dc_request_tasks) с парой «текст / ответ» и
// признаком выполнения (is_completed). Сама заявка имеет status: in_work | completed.

const EMPTY_FORM = {
  object_id: '',
  counterparty_id: '',
  ds_number: '',
  works_description: '',
  responsible_contact_id: '',
  status: 'in_work',
}

const STATUS_OPTIONS = [
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'completed', label: 'Завершено', className: 'status-completed' },
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(o => [o.value, o.label]))

const TABS = [
  { key: 'all', label: 'Все заявки' },
  { key: 'in_work', label: 'В работе' },
  { key: 'completed', label: 'Завершено' },
]

function formatShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

function DcRequestsPage() {
  const { isEmployee, userProfile } = useRole()

  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)

  const [activeTab, setActiveTab] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [formData, setFormData] = useState(EMPTY_FORM)

  const [searchQuery, setSearchQuery] = useState('')
  // Inline-добавление задачи: { [requestId]: 'строка задачи' }
  const [newTaskTexts, setNewTaskTexts] = useState({})
  // Раскрытые блоки задач: Set<requestId>
  const [expandedTasks, setExpandedTasks] = useState(() => new Set())

  useEffect(() => {
    fetchRequests()
    fetchObjects()
    fetchCounterparties()
    fetchContacts()
  }, [])

  const fetchRequests = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('dc_requests')
        .select(`
          *,
          objects(id, name),
          counterparties(id, name),
          responsible:contacts!responsible_contact_id(id, full_name),
          dc_request_tasks(id, task_text, response_text, is_completed, order_number)
        `)
        .order('created_at', { ascending: false })
      if (error) throw error
      const sorted = (data || []).map(r => ({
        ...r,
        dc_request_tasks: (r.dc_request_tasks || []).sort(
          (a, b) => (a.order_number || 0) - (b.order_number || 0)
        ),
      }))
      setRequests(sorted)
    } catch (err) {
      console.error('Ошибка загрузки заявок на ДС:', err.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchObjects = async () => {
    const { data, error } = await supabase
      .from('objects')
      .select('id, name')
      .eq('status', 'main_construction')
      .order('name', { ascending: true })
    if (!error) setObjects(data || [])
  }

  const fetchCounterparties = async () => {
    const { data, error } = await supabase
      .from('counterparties')
      .select('id, name')
      .order('name', { ascending: true })
    if (!error) setCounterparties(data || [])
  }

  const fetchContacts = async () => {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, full_name')
      .order('full_name', { ascending: true })
    if (!error) setContacts(data || [])
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleAddNew = () => {
    setEditing(null)
    setFormData(EMPTY_FORM)
    setShowModal(true)
  }

  const handleEdit = (req) => {
    setEditing(req)
    setFormData({
      object_id: req.object_id || '',
      counterparty_id: req.counterparty_id || '',
      ds_number: req.ds_number || '',
      works_description: req.works_description || '',
      responsible_contact_id: req.responsible_contact_id || '',
      status: req.status || 'in_work',
    })
    setShowModal(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const payload = {
        object_id: formData.object_id || null,
        counterparty_id: formData.counterparty_id || null,
        ds_number: formData.ds_number.trim() || null,
        works_description: formData.works_description.trim() || null,
        responsible_contact_id: formData.responsible_contact_id || null,
        status: formData.status || 'in_work',
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        const { error } = await supabase.from('dc_requests').update(payload).eq('id', editing.id)
        if (error) throw error
      } else {
        // Снимок имени автора — нужен для «📅 25.05.2026 · ФИО» под Объектом (task 309).
        const { error } = await supabase.from('dc_requests').insert([{
          ...payload,
          created_by_name: userProfile?.full_name || null,
        }])
        if (error) throw error
      }
      setShowModal(false)
      setEditing(null)
      setFormData(EMPTY_FORM)
      fetchRequests()
    } catch (err) {
      alert('Ошибка сохранения: ' + (err.message || err))
    }
  }

  const handleStatusChange = async (id, newStatus) => {
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r))
    } catch (err) {
      alert('Ошибка смены статуса: ' + (err.message || err))
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Удалить заявку? Все её задачи также будут удалены.')) return
    try {
      const { error } = await supabase.from('dc_requests').delete().eq('id', id)
      if (error) throw error
      fetchRequests()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const toggleTasksExpanded = (requestId) => {
    setExpandedTasks(prev => {
      const next = new Set(prev)
      if (next.has(requestId)) next.delete(requestId); else next.add(requestId)
      return next
    })
  }

  // Tasks CRUD
  const handleAddTask = async (requestId) => {
    const text = (newTaskTexts[requestId] || '').trim()
    if (!text) return
    try {
      const req = requests.find(r => r.id === requestId)
      const maxOrder = (req?.dc_request_tasks || []).reduce(
        (m, t) => Math.max(m, t.order_number || 0), 0
      )
      const { error } = await supabase.from('dc_request_tasks').insert([{
        request_id: requestId,
        task_text: text,
        order_number: maxOrder + 1,
      }])
      if (error) throw error
      setNewTaskTexts(prev => ({ ...prev, [requestId]: '' }))
      // Авто-раскрываем блок задач, чтобы видна была свежая.
      setExpandedTasks(prev => new Set(prev).add(requestId))
      fetchRequests()
    } catch (err) {
      alert('Ошибка добавления задачи: ' + (err.message || err))
    }
  }

  const handleSaveTaskField = async (taskId, field, value) => {
    try {
      const { error } = await supabase
        .from('dc_request_tasks')
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('id', taskId)
      if (error) throw error
      setRequests(prev => prev.map(r => ({
        ...r,
        dc_request_tasks: (r.dc_request_tasks || []).map(t =>
          t.id === taskId ? { ...t, [field]: value } : t
        ),
      })))
    } catch (err) {
      alert('Ошибка сохранения: ' + (err.message || err))
    }
  }

  const handleDeleteTask = async (taskId) => {
    if (!window.confirm('Удалить задачу?')) return
    try {
      const { error } = await supabase.from('dc_request_tasks').delete().eq('id', taskId)
      if (error) throw error
      fetchRequests()
    } catch (err) {
      alert('Ошибка удаления задачи: ' + (err.message || err))
    }
  }

  // Фильтрация: сначала по табу, потом по поиску.
  const filtered = requests
    .filter(r => activeTab === 'all' || (r.status || 'in_work') === activeTab)
    .filter(r => {
      const q = searchQuery.trim().toLowerCase()
      if (!q) return true
      return (
        (r.objects?.name || '').toLowerCase().includes(q) ||
        (r.counterparties?.name || '').toLowerCase().includes(q) ||
        (r.ds_number || '').toLowerCase().includes(q) ||
        (r.works_description || '').toLowerCase().includes(q)
      )
    })

  // Счётчики для табов — по всему массиву (без фильтра поиска).
  const counts = {
    all: requests.length,
    in_work: requests.filter(r => (r.status || 'in_work') === 'in_work').length,
    completed: requests.filter(r => r.status === 'completed').length,
  }

  return (
    <div className="dc-requests-page contract-registry">
      <div className="registry-header">
        <h2>Заявка на ДС</h2>
        {isEmployee && (
          <button className="btn-primary" onClick={handleAddNew}>+ Добавить заявку</button>
        )}
      </div>

      <div className="status-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`status-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            <span className="tab-count">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      <div className="dcr-toolbar">
        <input
          type="search"
          className="dcr-search"
          placeholder="🔍 Поиск по объекту, контрагенту, № ДС или работам..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="table-container">
          <table className="dcr-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>№</th>
                <th style={{ minWidth: '160px' }}>Объект</th>
                <th style={{ minWidth: '160px' }}>Контрагент</th>
                <th style={{ width: '110px' }}>№ ДС</th>
                <th style={{ minWidth: '220px' }}>Выполняемые работы</th>
                <th style={{ width: '140px' }}>Статус</th>
                <th style={{ width: '160px' }}>Ответственный</th>
                <th style={{ minWidth: '360px' }}>Задачи и ответы</th>
                <th style={{ width: '72px' }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="9" className="no-data" style={{ textAlign: 'center' }}>
                    {searchQuery
                      ? 'Ничего не найдено.'
                      : (activeTab === 'all'
                        ? 'Заявок пока нет. Нажмите «+ Добавить заявку».'
                        : `Нет заявок со статусом «${STATUS_LABEL[activeTab]}».`)}
                  </td>
                </tr>
              ) : (
                filtered.map((req, idx) => {
                  const tasks = req.dc_request_tasks || []
                  const totalTasks = tasks.length
                  const completedTasks = tasks.filter(t => t.is_completed).length
                  const isExpanded = expandedTasks.has(req.id)
                  return (
                    <tr key={req.id}>
                      <td style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                      <td>
                        <div className="dcr-object-name">
                          {req.objects?.name || <span className="muted-dash">—</span>}
                        </div>
                        {(req.created_at || req.created_by_name) && (
                          <div className="dcr-meta-line" title={req.created_by_name ? `Создал: ${req.created_by_name}` : undefined}>
                            <span className="dcr-meta-icon" aria-hidden>🕒</span>
                            {req.created_at && formatShortDate(req.created_at)}
                            {req.created_by_name && (
                              <>
                                <span className="dcr-meta-sep">·</span>
                                <span className="dcr-meta-author">{req.created_by_name}</span>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{req.counterparties?.name || <span className="muted-dash">—</span>}</td>
                      <td>{req.ds_number || <span className="muted-dash">—</span>}</td>
                      <td className="dcr-cell-works">{req.works_description || <span className="muted-dash">—</span>}</td>
                      <td>
                        <div className="dcr-status-seg" role="group" aria-label="Статус заявки">
                          {STATUS_OPTIONS.map(opt => {
                            const isActive = (req.status || 'in_work') === opt.value
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                className={`dcr-status-seg-btn${isActive ? ` active ${opt.className}` : ''}`}
                                onClick={() => isEmployee && !isActive && handleStatusChange(req.id, opt.value)}
                                disabled={!isEmployee}
                                title={opt.label}
                              >{opt.label}</button>
                            )
                          })}
                        </div>
                      </td>
                      <td>{req.responsible?.full_name || <span className="muted-dash">—</span>}</td>
                      <td className="dcr-cell-tasks">
                        <div className="dcr-tasks">
                          {totalTasks > 0 && (
                            <button
                              type="button"
                              className={`dcr-tasks-toggle${completedTasks === totalTasks && totalTasks > 0 ? ' dcr-tasks-toggle-done' : ''}`}
                              onClick={() => toggleTasksExpanded(req.id)}
                              aria-expanded={isExpanded}
                            >
                              <span className="dcr-tasks-chev" aria-hidden>{isExpanded ? '▼' : '▶'}</span>
                              <span className="dcr-tasks-summary">
                                Задачи: <strong>{completedTasks}/{totalTasks}</strong>
                              </span>
                            </button>
                          )}
                          {isExpanded && tasks.map(task => (
                            <div
                              key={task.id}
                              className={`dcr-task-row${task.is_completed ? ' dcr-task-row-done' : ''}`}
                            >
                              <input
                                type="checkbox"
                                className="dcr-task-check"
                                checked={!!task.is_completed}
                                onChange={(e) => handleSaveTaskField(task.id, 'is_completed', e.target.checked)}
                                disabled={!isEmployee}
                                title={task.is_completed ? 'Снять отметку' : 'Отметить выполненной'}
                              />
                              <textarea
                                className="dcr-task-text"
                                defaultValue={task.task_text}
                                placeholder="Задача…"
                                rows={1}
                                disabled={!isEmployee}
                                onBlur={(e) => {
                                  if (e.target.value !== task.task_text) {
                                    handleSaveTaskField(task.id, 'task_text', e.target.value)
                                  }
                                }}
                                onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                              />
                              <textarea
                                className="dcr-task-response"
                                defaultValue={task.response_text || ''}
                                placeholder="Ответ…"
                                rows={1}
                                disabled={!isEmployee}
                                onBlur={(e) => {
                                  if (e.target.value !== (task.response_text || '')) {
                                    handleSaveTaskField(task.id, 'response_text', e.target.value)
                                  }
                                }}
                                onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                              />
                              {isEmployee && (
                                <button
                                  type="button"
                                  className="dcr-task-delete"
                                  onClick={() => handleDeleteTask(task.id)}
                                  title="Удалить задачу"
                                  aria-label="Удалить задачу"
                                >×</button>
                              )}
                            </div>
                          ))}
                          {isEmployee && (
                            <div className="dcr-task-add">
                              <input
                                type="text"
                                placeholder={totalTasks === 0 ? '+ Добавить первую задачу…' : '+ Добавить задачу…'}
                                value={newTaskTexts[req.id] || ''}
                                onChange={(e) => setNewTaskTexts(prev => ({ ...prev, [req.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); handleAddTask(req.id) }
                                }}
                              />
                              <button
                                type="button"
                                className="dcr-task-add-btn"
                                onClick={() => handleAddTask(req.id)}
                                disabled={!(newTaskTexts[req.id] || '').trim()}
                                title="Добавить задачу"
                              >+</button>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="actions-cell">
                        {isEmployee && (
                          <>
                            <button className="btn-icon btn-edit" onClick={() => handleEdit(req)} title="Редактировать">✏️</button>
                            <button className="btn-icon btn-delete" onClick={() => handleDelete(req.id)} title="Удалить">🗑️</button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Редактировать заявку' : 'Добавить заявку на ДС'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowModal(false); setEditing(null) }}
              >×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Объект *</label>
                  <select name="object_id" value={formData.object_id} onChange={handleInputChange} required>
                    <option value="">Выберите объект</option>
                    {objects.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                    Только объекты основного строительства
                  </small>
                </div>

                <div className="form-group full-width">
                  <label>Контрагент *</label>
                  <select name="counterparty_id" value={formData.counterparty_id} onChange={handleInputChange} required>
                    <option value="">Выберите контрагента</option>
                    {counterparties.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>№ ДС</label>
                  <input
                    type="text"
                    name="ds_number"
                    value={formData.ds_number}
                    onChange={handleInputChange}
                    placeholder="например: ДС №12 / 2026-001"
                  />
                </div>

                <div className="form-group">
                  <label>Статус</label>
                  <select name="status" value={formData.status} onChange={handleInputChange}>
                    {STATUS_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Ответственный сотрудник</label>
                  <select
                    name="responsible_contact_id"
                    value={formData.responsible_contact_id}
                    onChange={handleInputChange}
                  >
                    <option value="">— Не назначен —</option>
                    {contacts.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Выполняемые работы</label>
                  <textarea
                    name="works_description"
                    rows="3"
                    value={formData.works_description}
                    onChange={handleInputChange}
                    placeholder="Описание работ по заявке на ДС"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowModal(false); setEditing(null) }}
                >Отмена</button>
                <button type="submit" className="btn-primary">
                  {editing ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default DcRequestsPage
