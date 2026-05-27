import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, requestDownloadUrl, uploadFile } from '../services/s3'
import S3DocumentPreview from '../components/S3DocumentPreview'
import '../components/ContractRegistry.css'
import './DcRequestsPage.css'

// Task 306 + 307 + 309 + 310. Реестр «Заявок на ДС» — независимая сущность.
// Только для основного строительства (objects.status='main_construction').
// У каждой заявки несколько задач (dc_request_tasks) с парой «текст / ответ» и
// признаком выполнения (is_completed). Сама заявка имеет status: in_work | completed.
// Документы хранятся в s3_documents с owner_type='dc_request', notes = описание.

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

function formatBytes(bytes) {
  if (bytes == null) return ''
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
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
  // task 314: поиск контрагента в модалке.
  const [cpSearch, setCpSearch] = useState('')
  const [cpDropdownOpen, setCpDropdownOpen] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  // Фильтры в тулбаре (task 311).
  const [filterObjectId, setFilterObjectId] = useState('')
  const [filterResponsibleId, setFilterResponsibleId] = useState('')
  // Inline-добавление задачи: { [requestId]: 'строка задачи' }
  const [newTaskTexts, setNewTaskTexts] = useState({})
  // Раскрытые блоки задач: Set<requestId>
  const [expandedTasks, setExpandedTasks] = useState(() => new Set())

  // task 310 — статус в виде клик-попапа.
  const [statusPopoverFor, setStatusPopoverFor] = useState(null)

  // task 310 — документы заявки.
  // docsByReq: Map<requestId, s3_documents[]>
  const [docsByReq, setDocsByReq] = useState(() => new Map())
  const [expandedDocs, setExpandedDocs] = useState(() => new Set())
  // Модалка загрузки документа: { requestId, file, description } | null
  const [docUpload, setDocUpload] = useState(null)
  const [docUploadBusy, setDocUploadBusy] = useState(false)
  // Документ открытый в превью (S3DocumentPreview).
  const [previewDoc, setPreviewDoc] = useState(null)

  useEffect(() => {
    fetchRequests()
    fetchObjects()
    fetchCounterparties()
    fetchContacts()
    fetchAllDocs()
  }, [])

  // Закрытие попапа статуса по клику вне его.
  useEffect(() => {
    if (!statusPopoverFor) return
    const onMousedown = (e) => {
      if (!e.target.closest('.dcr-status-wrap')) setStatusPopoverFor(null)
    }
    // Откладываем на тик, чтобы открывающий клик не закрыл попап мгновенно.
    const t = setTimeout(() => document.addEventListener('mousedown', onMousedown), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onMousedown) }
  }, [statusPopoverFor])

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
      .select('id, name, inn')
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

  // Один запрос за всеми документами всех заявок — складываем в Map по owner_id.
  const fetchAllDocs = async () => {
    try {
      // Хронологический порядок: первый загруженный — наверху, новые — снизу.
      const { data, error } = await supabase
        .from('s3_documents')
        .select('*')
        .eq('owner_type', 'dc_request')
        .order('created_at', { ascending: true })
      if (error) throw error
      const map = new Map()
      for (const d of data || []) {
        const arr = map.get(d.owner_id) || []
        arr.push(d)
        map.set(d.owner_id, arr)
      }
      setDocsByReq(map)
    } catch (err) {
      console.error('Ошибка загрузки документов заявок:', err.message)
    }
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleAddNew = () => {
    setEditing(null)
    setFormData(EMPTY_FORM)
    setCpSearch('')
    setCpDropdownOpen(false)
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
    setCpSearch(req.counterparties?.name || '')
    setCpDropdownOpen(false)
    setShowModal(true)
  }

  const handleSelectCp = (cp) => {
    setFormData(prev => ({ ...prev, counterparty_id: cp.id }))
    setCpSearch(cp.name || '')
    setCpDropdownOpen(false)
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
    if (!window.confirm('Удалить заявку? Все её задачи и документы также будут удалены.')) return
    try {
      // Сначала S3-документы заявки удаляем явно (нет FK-каскада с s3_documents).
      const docs = docsByReq.get(id) || []
      for (const d of docs) {
        try { await deleteDocument(d) } catch { /* best effort */ }
      }
      const { error } = await supabase.from('dc_requests').delete().eq('id', id)
      if (error) throw error
      fetchRequests()
      fetchAllDocs()
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

  const toggleDocsExpanded = (requestId) => {
    setExpandedDocs(prev => {
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

  // Docs upload
  const handleDocPick = (requestId) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (file) {
        setDocUpload({ requestId, file, description: '' })
      }
    }
    document.body.appendChild(input)
    input.click()
    setTimeout(() => input.remove(), 1000)
  }

  const handleDocUploadConfirm = async () => {
    if (!docUpload) return
    setDocUploadBusy(true)
    try {
      const newDoc = await uploadFile({
        file: docUpload.file,
        ownerType: 'dc_request',
        ownerId: docUpload.requestId,
        notes: docUpload.description.trim() || null,
      })
      // Локально добавляем в docsByReq (в конец — сохраняем хронологический порядок).
      setDocsByReq(prev => {
        const next = new Map(prev)
        const arr = next.get(docUpload.requestId) || []
        next.set(docUpload.requestId, [...arr, newDoc])
        return next
      })
      setExpandedDocs(prev => new Set(prev).add(docUpload.requestId))
      setDocUpload(null)
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setDocUploadBusy(false)
    }
  }

  const handleDocDownload = async (doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key)
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const handleDocDelete = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    try {
      await deleteDocument(doc)
      setDocsByReq(prev => {
        const next = new Map(prev)
        const arr = (next.get(doc.owner_id) || []).filter(d => d.id !== doc.id)
        if (arr.length > 0) next.set(doc.owner_id, arr)
        else next.delete(doc.owner_id)
        return next
      })
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  // Фильтрация: таб → объект → ответственный → поиск.
  const filtered = requests
    .filter(r => activeTab === 'all' || (r.status || 'in_work') === activeTab)
    .filter(r => !filterObjectId || r.object_id === filterObjectId)
    .filter(r => !filterResponsibleId || r.responsible_contact_id === filterResponsibleId)
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

  const counts = {
    all: requests.length,
    in_work: requests.filter(r => (r.status || 'in_work') === 'in_work').length,
    completed: requests.filter(r => r.status === 'completed').length,
  }

  // В таблице contacts один сотрудник может встречаться несколько раз
  // (по записи на каждый объект). В UI показываем по одной строке на ФИО.
  const dedupedContacts = (() => {
    const seen = new Set()
    return contacts.filter(c => {
      const key = (c.full_name || '').trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  // Фильтр ответственных — только те сотрудники, что реально назначены хотя бы на одну заявку.
  const usedResponsibleIds = new Set(
    requests.map(r => r.responsible_contact_id).filter(Boolean)
  )
  const responsibleFilterOptions = dedupedContacts.filter(c => usedResponsibleIds.has(c.id))

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
        <select
          className={`dcr-filter${filterObjectId ? ' is-active' : ''}`}
          value={filterObjectId}
          onChange={(e) => setFilterObjectId(e.target.value)}
          title="Фильтр по объекту"
        >
          <option value="">🏢 Все объекты</option>
          {objects.map(o => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <select
          className={`dcr-filter${filterResponsibleId ? ' is-active' : ''}`}
          value={filterResponsibleId}
          onChange={(e) => setFilterResponsibleId(e.target.value)}
          title="Фильтр по ответственному"
          disabled={responsibleFilterOptions.length === 0}
        >
          <option value="">👤 Все ответственные</option>
          {responsibleFilterOptions.map(c => (
            <option key={c.id} value={c.id}>{c.full_name}</option>
          ))}
        </select>
        {(filterObjectId || filterResponsibleId) && (
          <button
            type="button"
            className="dcr-filter-clear"
            onClick={() => { setFilterObjectId(''); setFilterResponsibleId('') }}
            title="Сбросить фильтры"
          >×</button>
        )}
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
                <th style={{ width: '80px', textAlign: 'center' }}>№ ДС</th>
                <th style={{ minWidth: '200px' }}>Описание ДС</th>
                <th style={{ width: '110px' }}>Статус</th>
                <th style={{ width: '150px' }}>Ответственный</th>
                <th style={{ minWidth: '380px' }}>Задачи и ответы</th>
                <th style={{ minWidth: '200px' }}>Документы</th>
                <th style={{ width: '60px' }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="10" className="no-data" style={{ textAlign: 'center' }}>
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
                  const currentStatus = req.status || 'in_work'
                  const statusOpt = STATUS_OPTIONS.find(o => o.value === currentStatus)
                  const isStatusOpen = statusPopoverFor === req.id

                  const docs = docsByReq.get(req.id) || []
                  const docsOpen = expandedDocs.has(req.id)

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
                      <td style={{ textAlign: 'center' }}>{req.ds_number || <span className="muted-dash">—</span>}</td>
                      <td className="dcr-cell-works">{req.works_description || <span className="muted-dash">—</span>}</td>
                      <td>
                        <div className="dcr-status-wrap">
                          <button
                            type="button"
                            className={`dcr-status-chip ${statusOpt?.className || ''}${isStatusOpen ? ' is-open' : ''}`}
                            onClick={() => isEmployee && setStatusPopoverFor(isStatusOpen ? null : req.id)}
                            disabled={!isEmployee}
                            aria-haspopup="listbox"
                            aria-expanded={isStatusOpen}
                          >
                            <span>{STATUS_LABEL[currentStatus]}</span>
                            <span className="dcr-status-chev" aria-hidden>▾</span>
                          </button>
                          {isStatusOpen && (
                            <div className="dcr-status-popover" role="listbox">
                              {STATUS_OPTIONS.map(opt => {
                                const isCurrent = opt.value === currentStatus
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isCurrent}
                                    className={`dcr-status-popover-item ${opt.className}${isCurrent ? ' is-current' : ''}`}
                                    onClick={() => {
                                      if (!isCurrent) handleStatusChange(req.id, opt.value)
                                      setStatusPopoverFor(null)
                                    }}
                                  >
                                    <span className="dcr-status-popover-dot" />
                                    {opt.label}
                                    {isCurrent && <span className="dcr-status-popover-check" aria-hidden>✓</span>}
                                  </button>
                                )
                              })}
                            </div>
                          )}
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
                      <td className="dcr-cell-docs">
                        <div className="dcr-docs">
                          {docs.length > 0 && (
                            <button
                              type="button"
                              className="dcr-docs-toggle"
                              onClick={() => toggleDocsExpanded(req.id)}
                              aria-expanded={docsOpen}
                            >
                              <span className="dcr-docs-chev" aria-hidden>{docsOpen ? '▼' : '▶'}</span>
                              <svg
                                className="dcr-docs-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                              </svg>
                              <span className="dcr-docs-summary">
                                Файлы: <strong>{docs.length}</strong>
                              </span>
                            </button>
                          )}
                          {docsOpen && docs.length > 0 && (
                            <div className="dcr-doc-chips">
                              {docs.map(doc => {
                                const tooltip = [
                                  doc.file_name,
                                  doc.notes,
                                  [formatBytes(doc.size_bytes), doc.uploaded_by_name].filter(Boolean).join(' · '),
                                ].filter(Boolean).join('\n')
                                const mime = (doc.mime_type || '').toLowerCase()
                                const previewable = mime === 'application/pdf' || mime.startsWith('image/')
                                return (
                                  <div key={doc.id} className="dcr-doc-chip">
                                    <button
                                      type="button"
                                      className="dcr-doc-chip-main"
                                      onClick={() => previewable ? setPreviewDoc(doc) : handleDocDownload(doc)}
                                      title={tooltip}
                                    >
                                      <svg
                                        className="dcr-doc-chip-icon"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                      >
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                        <polyline points="14 2 14 8 20 8" />
                                      </svg>
                                      {doc.notes
                                        ? <span className="dcr-doc-chip-desc">{doc.notes}</span>
                                        : <span className="dcr-doc-chip-desc dcr-doc-chip-desc-empty" title={doc.file_name}>{doc.file_name}</span>}
                                    </button>
                                    {previewable && (
                                      <button
                                        type="button"
                                        className="dcr-doc-chip-action"
                                        onClick={() => setPreviewDoc(doc)}
                                        title="Просмотр"
                                        aria-label="Просмотр"
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                          <circle cx="12" cy="12" r="3" />
                                        </svg>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="dcr-doc-chip-action"
                                      onClick={() => handleDocDownload(doc)}
                                      title="Скачать"
                                      aria-label="Скачать"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="7 10 12 15 17 10" />
                                        <line x1="12" y1="15" x2="12" y2="3" />
                                      </svg>
                                    </button>
                                    {isEmployee && (
                                      <button
                                        type="button"
                                        className="dcr-doc-chip-del"
                                        onClick={() => handleDocDelete(doc)}
                                        title="Удалить"
                                        aria-label="Удалить"
                                      >×</button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          {isEmployee && (
                            <button
                              type="button"
                              className="dcr-doc-add"
                              onClick={() => handleDocPick(req.id)}
                              title="Добавить документ"
                            >+ Документ</button>
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

      {/* Модалка создания/редактирования заявки */}
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
                  <div className="cp-search-wrap">
                    <input
                      type="text"
                      className="cp-search-input"
                      placeholder="Начните вводить название или ИНН…"
                      value={cpSearch}
                      onChange={(e) => {
                        setCpSearch(e.target.value)
                        setCpDropdownOpen(true)
                        // Если пользователь чистит / правит — снимаем выбор, чтобы required снова сработал.
                        if (formData.counterparty_id) {
                          setFormData(prev => ({ ...prev, counterparty_id: '' }))
                        }
                      }}
                      onFocus={() => setCpDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setCpDropdownOpen(false), 150)}
                      required={!formData.counterparty_id}
                    />
                    {cpDropdownOpen && (() => {
                      const q = cpSearch.trim().toLowerCase()
                      const filtered = !q ? counterparties : counterparties.filter(cp =>
                        (cp.name || '').toLowerCase().includes(q) ||
                        (cp.inn || '').toLowerCase().includes(q)
                      )
                      return (
                        <div className="cp-search-dropdown">
                          {filtered.length === 0 ? (
                            <div className="cp-search-empty">Ничего не найдено</div>
                          ) : (
                            filtered.slice(0, 50).map(cp => (
                              <button
                                type="button"
                                key={cp.id}
                                className={`cp-search-item ${cp.id === formData.counterparty_id ? 'active' : ''}`}
                                onMouseDown={() => handleSelectCp(cp)}
                              >
                                <div className="cp-search-name">{cp.name}</div>
                                {cp.inn && <div className="cp-search-inn">ИНН: {cp.inn}</div>}
                              </button>
                            ))
                          )}
                        </div>
                      )
                    })()}
                  </div>
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
                    {dedupedContacts.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Описание ДС</label>
                  <textarea
                    name="works_description"
                    rows="3"
                    value={formData.works_description}
                    onChange={handleInputChange}
                    placeholder="Краткое описание ДС"
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

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {/* Модалка загрузки документа */}
      {docUpload && (
        <div
          className="modal-overlay"
          onClick={() => !docUploadBusy && setDocUpload(null)}
        >
          <div className="modal dcr-doc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Загрузка документа</h3>
              <button
                className="modal-close"
                onClick={() => !docUploadBusy && setDocUpload(null)}
                disabled={docUploadBusy}
              >×</button>
            </div>
            <div className="dcr-doc-modal-body">
              <div className="dcr-doc-modal-file">
                <span className="dcr-doc-modal-icon" aria-hidden>📄</span>
                <div className="dcr-doc-modal-fileinfo">
                  <span className="dcr-doc-modal-filename" title={docUpload.file.name}>
                    {docUpload.file.name}
                  </span>
                  <span className="dcr-doc-modal-filesize">{formatBytes(docUpload.file.size)}</span>
                </div>
              </div>
              <label className="dcr-doc-modal-field">
                <span>Описание документа (опционально)</span>
                <textarea
                  rows="3"
                  value={docUpload.description}
                  onChange={(e) => setDocUpload(s => s ? { ...s, description: e.target.value } : s)}
                  placeholder="Кратко — что внутри файла"
                  autoFocus
                />
              </label>
            </div>
            <div className="dcr-doc-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDocUpload(null)}
                disabled={docUploadBusy}
              >Отмена</button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDocUploadConfirm}
                disabled={docUploadBusy}
              >{docUploadBusy ? 'Загрузка…' : 'Загрузить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DcRequestsPage
