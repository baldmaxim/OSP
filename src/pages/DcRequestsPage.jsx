import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, requestDownloadUrl, uploadFile } from '../services/s3'
import S3DocumentPreview from '../components/S3DocumentPreview'
import AutoGrowTextarea from '../components/AutoGrowTextarea'
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
  expected_approval_date: '', // task 365
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

// task 365: маленький popover для быстрого редактирования ориентировочного
//   срока согласования прямо из ячейки таблицы. Click-outside / Escape закрывают.
function DeadlinePopover({ initial, onClose, onSave }) {
  const [value, setValue] = useState(initial || '')
  const rootRef = useRef(null)

  useEffect(() => {
    const handleClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose()
    }
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return (
    <div className="dcr-deadline-popover" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <input
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="dcr-deadline-popover-actions">
        {initial && (
          <button type="button" className="dcr-deadline-btn dcr-deadline-btn-clear" onClick={() => onSave('')}>
            Очистить
          </button>
        )}
        <button type="button" className="dcr-deadline-btn dcr-deadline-btn-cancel" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="dcr-deadline-btn dcr-deadline-btn-save"
          onClick={() => onSave(value)}
          disabled={!value && !initial}
        >
          Сохранить
        </button>
      </div>
    </div>
  )
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
  const { userProfile, canEdit } = useRole()
  // task 333: гейт add/edit/delete и inline-editing на этой странице.
  // Сам факт показа страницы контролируется EmployeeLayout (по App.jsx).
  const canEditDc = canEdit('dc_requests')

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
  // task 365: какая заявка сейчас в inline-popover для редактирования срока согласования.
  const [deadlinePopoverId, setDeadlinePopoverId] = useState(null)

  const [searchQuery, setSearchQuery] = useState('')
  // Фильтры в тулбаре (task 311).
  const [filterObjectId, setFilterObjectId] = useState('')
  const [filterResponsibleId, setFilterResponsibleId] = useState('')
  // Inline-добавление задачи: { [requestId]: 'строка задачи' }
  const [newTaskTexts, setNewTaskTexts] = useState({})
  // task 334: задачи открываются в отдельной модалке. Храним id заявки,
  // чьи задачи сейчас открыты (или null).
  const [tasksModalFor, setTasksModalFor] = useState(null)

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

  // task 324: ссылка на общую таблицу с отделами. Хранится в app_settings
  // под ключом 'dc_requests_external_link'. Редактируется через модалку.
  const [externalLink, setExternalLink] = useState('')
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [linkInput, setLinkInput] = useState('')

  useEffect(() => {
    fetchRequests()
    fetchObjects()
    fetchCounterparties()
    fetchContacts()
    fetchAllDocs()
    fetchExternalLink()
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
          dc_request_tasks(id, task_text, response_text, is_completed, order_number, created_at, created_by_name, responded_by_name, responded_at)
        `)
        // task 325: хронология добавления — старые сверху (№1), новые внизу.
        .order('created_at', { ascending: true })
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

  // task 324: ссылка на общую таблицу с отделами.
  const fetchExternalLink = async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'dc_requests_external_link')
        .maybeSingle()
      if (error) throw error
      setExternalLink(data?.value || '')
    } catch (err) {
      console.warn('Не удалось загрузить ссылку на общую таблицу (app_settings?):', err.message)
      setExternalLink('')
    }
  }

  const openLinkEditor = () => {
    setLinkInput(externalLink || '')
    setShowLinkModal(true)
  }

  const saveExternalLink = async (e) => {
    e.preventDefault()
    const value = linkInput.trim() || null
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'dc_requests_external_link', value, updated_at: new Date().toISOString() })
      if (error) throw error
      setExternalLink(value || '')
      setShowLinkModal(false)
    } catch (err) {
      alert('Не удалось сохранить ссылку: ' + (err.message || err))
    }
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
      expected_approval_date: req.expected_approval_date || '', // task 365
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
        expected_approval_date: formData.expected_approval_date || null, // task 365
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

  // task 365: быстрое сохранение ориентировочного срока согласования из inline-popover.
  const handleQuickSaveDeadline = async (id, newDate) => {
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ expected_approval_date: newDate || null, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setDeadlinePopoverId(null)
      fetchRequests()
    } catch (err) {
      alert('Ошибка сохранения срока: ' + (err.message || err))
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
        // task 337: snapshot ФИО автора задачи
        created_by_name: userProfile?.full_name || null,
      }])
      if (error) throw error
      setNewTaskTexts(prev => ({ ...prev, [requestId]: '' }))
      fetchRequests()
    } catch (err) {
      alert('Ошибка добавления задачи: ' + (err.message || err))
    }
  }

  const handleSaveTaskField = async (taskId, field, value) => {
    try {
      // task 337: при сохранении ответа фиксируем автора и время.
      const patch = { [field]: value, updated_at: new Date().toISOString() }
      if (field === 'response_text') {
        const trimmed = (value || '').trim()
        if (trimmed) {
          patch.responded_by_name = userProfile?.full_name || null
          patch.responded_at = new Date().toISOString()
        } else {
          // Очистка ответа — снимаем подпись.
          patch.responded_by_name = null
          patch.responded_at = null
        }
      }
      const { error } = await supabase
        .from('dc_request_tasks')
        .update(patch)
        .eq('id', taskId)
      if (error) throw error
      setRequests(prev => prev.map(r => ({
        ...r,
        dc_request_tasks: (r.dc_request_tasks || []).map(t =>
          t.id === taskId ? { ...t, ...patch } : t
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
        <div className="dcr-header-actions">
          {/* task 324: ссылка на общую таблицу с отделами (хранится в app_settings) */}
          {externalLink ? (
            <a
              href={externalLink}
              target="_blank"
              rel="noopener noreferrer"
              className="dcr-link-btn"
              title={externalLink}
            >
              <span aria-hidden>🔗</span>
              <span>Общая таблица отделов</span>
            </a>
          ) : canEditDc && (
            <button
              type="button"
              className="dcr-link-btn dcr-link-btn-empty"
              onClick={openLinkEditor}
              title="Задать ссылку на общую таблицу"
            >
              <span aria-hidden>🔗</span>
              <span>Указать ссылку</span>
            </button>
          )}
          {canEditDc && externalLink && (
            <button
              type="button"
              className="dcr-link-edit"
              onClick={openLinkEditor}
              title="Изменить ссылку"
              aria-label="Изменить ссылку"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
          {canEditDc && (
            <button className="btn-primary" onClick={handleAddNew}>+ Добавить заявку</button>
          )}
        </div>
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
                <th style={{ width: '3%' }}>№</th>
                <th style={{ width: '11%' }}>Объект</th>
                <th style={{ width: '11%' }}>Контрагент</th>
                <th style={{ width: '6%', textAlign: 'center' }}>№ ДС</th>
                <th style={{ width: '19%' }}>Описание ДС</th>
                <th style={{ width: '8%' }}>Статус</th>
                <th style={{ width: '10%' }}>Ответственный</th>
                {/* task 334: было «Задачи и ответы» (inline) — теперь только счётчик-кнопка,
                    подробности в модалке. Колонка сильно компактнее, освобождённое место —
                    в «Описание ДС» и «Документы». */}
                <th style={{ width: '9%', textAlign: 'center' }}>Задачи</th>
                <th style={{ width: '18%' }}>Документы</th>
                <th style={{ width: '5%', textAlign: 'right' }}>Действия</th>
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
                        {/* task 365: ориентировочный срок согласования + inline-edit */}
                        <div className="dcr-meta-deadline">
                          <span className="dcr-meta-icon" aria-hidden>📅</span>
                          <span className="dcr-meta-deadline-label">Ориентировочный срок:</span>
                          {req.expected_approval_date ? (
                            <button
                              type="button"
                              className="dcr-meta-deadline-value"
                              onClick={canEditDc ? () => setDeadlinePopoverId(req.id) : undefined}
                              disabled={!canEditDc}
                              title={canEditDc ? 'Изменить срок' : undefined}
                            >
                              {formatShortDate(req.expected_approval_date)}г.
                            </button>
                          ) : canEditDc ? (
                            <button
                              type="button"
                              className="dcr-meta-deadline-link"
                              onClick={() => setDeadlinePopoverId(req.id)}
                            >
                              Указать срок
                            </button>
                          ) : (
                            <span className="dcr-meta-deadline-empty">—</span>
                          )}
                          {deadlinePopoverId === req.id && (
                            <DeadlinePopover
                              initial={req.expected_approval_date || ''}
                              onClose={() => setDeadlinePopoverId(null)}
                              onSave={(newDate) => handleQuickSaveDeadline(req.id, newDate)}
                            />
                          )}
                        </div>
                      </td>
                      <td>{req.counterparties?.name || <span className="muted-dash">—</span>}</td>
                      <td style={{ textAlign: 'center' }}>{req.ds_number || <span className="muted-dash">—</span>}</td>
                      <td className="dcr-cell-works">{req.works_description || <span className="muted-dash">—</span>}</td>
                      <td>
                        <div className="dcr-status-wrap">
                          <button
                            type="button"
                            className={`dcr-status-chip ${statusOpt?.className || ''}${isStatusOpen ? ' is-open' : ''}`}
                            onClick={() => canEditDc && setStatusPopoverFor(isStatusOpen ? null : req.id)}
                            disabled={!canEditDc}
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
                        {/* task 334: кнопка-счётчик. Клик открывает модалку
                            со списком задач (общий контейнер на странице). */}
                        <button
                          type="button"
                          className={[
                            'dcr-tasks-pill',
                            totalTasks === 0 ? 'dcr-tasks-pill-empty' : '',
                            totalTasks > 0 && completedTasks === totalTasks ? 'dcr-tasks-pill-done' : '',
                          ].filter(Boolean).join(' ')}
                          onClick={() => setTasksModalFor(req.id)}
                          title={totalTasks === 0 ? 'Добавить задачи' : 'Открыть задачи'}
                        >
                          <span className="dcr-tasks-pill-icon" aria-hidden>📋</span>
                          {totalTasks > 0 ? (
                            <span className="dcr-tasks-pill-counter">
                              {completedTasks}<span className="dcr-tasks-pill-sep">/</span>{totalTasks}
                            </span>
                          ) : (
                            <span className="dcr-tasks-pill-empty-label">
                              {canEditDc ? '+ Добавить' : 'Нет задач'}
                            </span>
                          )}
                        </button>
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
                                    {canEditDc && (
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
                          {canEditDc && (
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
                        {canEditDc && (
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

                {/* task 365: ориентировочный срок согласования */}
                <div className="form-group full-width">
                  <label>Ориентировочный срок согласования</label>
                  <input
                    type="date"
                    name="expected_approval_date"
                    value={formData.expected_approval_date}
                    onChange={handleInputChange}
                  />
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

      {/* task 334: модалка задач и ответов для выбранной заявки */}
      {tasksModalFor && (() => {
        const req = requests.find(r => r.id === tasksModalFor)
        if (!req) return null
        const tasks = req.dc_request_tasks || []
        const totalTasks = tasks.length
        const completedTasks = tasks.filter(t => t.is_completed).length
        const cpName = req.counterparties?.name || ''
        const objName = req.objects?.name || ''
        const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
        return (
          <div className="modal-overlay" onClick={() => setTasksModalFor(null)}>
            <div
              className="modal dcr-tasks-modal"
              onClick={(e) => e.stopPropagation()}
            >
              {/* task 338: профессиональная шапка — без эмодзи, без gradient,
                  как в Jira/Linear: заголовок + breadcrumb-метаданные + KPI справа. */}
              <div className="dcr-tasks-modal-header">
                <div className="dcr-tasks-modal-head-row">
                  <div className="dcr-tasks-modal-title">
                    <div className="dcr-tasks-modal-eyebrow">Чек-лист</div>
                    <h3>Задачи и ответы</h3>
                    <div className="dcr-tasks-modal-meta">
                      {req.ds_number && (
                        <span className="dcr-tasks-modal-meta-item">
                          <span className="dcr-tasks-modal-meta-key">ДС</span>
                          <span className="dcr-tasks-modal-meta-val">№{req.ds_number}</span>
                        </span>
                      )}
                      {objName && (
                        <span className="dcr-tasks-modal-meta-item">
                          <span className="dcr-tasks-modal-meta-key">Объект</span>
                          <span className="dcr-tasks-modal-meta-val">{objName}</span>
                        </span>
                      )}
                      {cpName && (
                        <span className="dcr-tasks-modal-meta-item">
                          <span className="dcr-tasks-modal-meta-key">Контрагент</span>
                          <span className="dcr-tasks-modal-meta-val">{cpName}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="dcr-tasks-modal-kpi">
                    <div className="dcr-tasks-modal-kpi-label">Выполнено</div>
                    <div
                      className={`dcr-tasks-modal-counter${
                        totalTasks > 0 && completedTasks === totalTasks ? ' is-complete' : ''
                      }`}
                    >
                      <span className="dcr-tasks-modal-counter-done">{completedTasks}</span>
                      <span className="dcr-tasks-modal-counter-sep">/</span>
                      <span className="dcr-tasks-modal-counter-total">{totalTasks}</span>
                    </div>
                  </div>
                  <button className="modal-close" onClick={() => setTasksModalFor(null)} aria-label="Закрыть">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {/* Тонкая прогресс-полоса — без подписей и без gradient */}
                <div className="dcr-tasks-modal-progress" aria-hidden>
                  <div className="dcr-tasks-modal-progress-bar">
                    <div
                      className={`dcr-tasks-modal-progress-fill${
                        totalTasks > 0 && completedTasks === totalTasks ? ' is-complete' : ''
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <span className="dcr-tasks-modal-progress-label">
                    {totalTasks === 0 ? 'Нет задач' : `${progressPct}%`}
                  </span>
                </div>
              </div>

              <div className="dcr-tasks-modal-body">
                {totalTasks === 0 && (
                  <div className="dcr-tasks-modal-empty">
                    <div className="dcr-tasks-modal-empty-icon" aria-hidden>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path d="M9 11l3 3 7-7" />
                      </svg>
                    </div>
                    <div className="dcr-tasks-modal-empty-title">
                      {canEditDc ? 'Задачи не поставлены' : 'Задач пока нет'}
                    </div>
                    <div className="dcr-tasks-modal-empty-hint">
                      {canEditDc
                        ? 'Создайте первую задачу в поле ниже, чтобы зафиксировать её и отслеживать статус выполнения.'
                        : 'Сотрудник пока не добавил задачи к этой заявке.'}
                    </div>
                  </div>
                )}

                {tasks.length > 0 && (
                  <ul className="dcr-tasks-list">
                    {tasks.map((task, taskIdx) => (
                      <li
                        key={task.id}
                        className={`dcr-task-card${task.is_completed ? ' is-done' : ''}`}
                      >
                        <div className="dcr-task-card-head">
                          <label
                            className={`dcr-task-checkbox${task.is_completed ? ' is-checked' : ''}${!canEditDc ? ' is-disabled' : ''}`}
                            title={task.is_completed ? 'Снять отметку' : 'Отметить выполненной'}
                          >
                            <input
                              type="checkbox"
                              checked={!!task.is_completed}
                              onChange={(e) => handleSaveTaskField(task.id, 'is_completed', e.target.checked)}
                              disabled={!canEditDc}
                            />
                            <span className="dcr-task-checkbox-box" aria-hidden>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="5 13 10 18 19 7" />
                              </svg>
                            </span>
                          </label>
                          <span className="dcr-task-card-num">№{taskIdx + 1}</span>
                          <span className="dcr-task-card-spacer" />
                          {canEditDc && (
                            <button
                              type="button"
                              className="dcr-task-card-delete"
                              onClick={() => handleDeleteTask(task.id)}
                              title="Удалить задачу"
                              aria-label="Удалить задачу"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18" />
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              </svg>
                            </button>
                          )}
                        </div>

                        <div className="dcr-task-card-body">
                          <div className="dcr-task-card-section dcr-task-card-section-task">
                            <div className="dcr-task-card-label">Описание задачи</div>
                            <AutoGrowTextarea
                              className="dcr-task-text"
                              defaultValue={task.task_text}
                              placeholder="Опишите что нужно сделать…"
                              disabled={!canEditDc}
                              minHeight={68}
                              onBlur={(e) => {
                                if (e.target.value !== task.task_text) {
                                  handleSaveTaskField(task.id, 'task_text', e.target.value)
                                }
                              }}
                            />
                            {/* task 337 + 338: автор и дата постановки */}
                            {(task.created_by_name || task.created_at) && (
                              <div className="dcr-task-card-meta">
                                <span className="dcr-task-card-meta-label">Поставил:</span>
                                <span className="dcr-task-card-meta-val">
                                  {task.created_by_name || <em className="dcr-task-card-meta-muted">не указан</em>}
                                </span>
                                {task.created_at && (
                                  <>
                                    <span className="dcr-task-card-meta-sep">·</span>
                                    <span className="dcr-task-card-meta-date">
                                      {formatShortDate(task.created_at)}
                                    </span>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="dcr-task-card-section dcr-task-card-section-response">
                            <div className="dcr-task-card-label">
                              <span>Ответ исполнителя</span>
                              {task.response_text && task.response_text.trim() && (
                                <span className="dcr-task-card-label-tag">заполнено</span>
                              )}
                            </div>
                            <AutoGrowTextarea
                              className="dcr-task-response"
                              defaultValue={task.response_text || ''}
                              placeholder="Введите ответ или комментарий…"
                              disabled={!canEditDc}
                              minHeight={68}
                              onBlur={(e) => {
                                if (e.target.value !== (task.response_text || '')) {
                                  handleSaveTaskField(task.id, 'response_text', e.target.value)
                                }
                              }}
                            />
                            {/* task 337 + 338: автор и дата ответа */}
                            {task.responded_by_name && (
                              <div className="dcr-task-card-meta">
                                <span className="dcr-task-card-meta-label">Ответил:</span>
                                <span className="dcr-task-card-meta-val">{task.responded_by_name}</span>
                                {task.responded_at && (
                                  <>
                                    <span className="dcr-task-card-meta-sep">·</span>
                                    <span className="dcr-task-card-meta-date">
                                      {formatShortDate(task.responded_at)}
                                    </span>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {canEditDc && (
                  <div className="dcr-task-add-card">
                    <span className="dcr-task-add-card-icon" aria-hidden>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      className="dcr-task-add-card-input"
                      placeholder={totalTasks === 0 ? 'Поставить первую задачу…' : 'Поставить новую задачу…'}
                      value={newTaskTexts[req.id] || ''}
                      onChange={(e) => setNewTaskTexts(prev => ({ ...prev, [req.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleAddTask(req.id) }
                      }}
                    />
                    <button
                      type="button"
                      className="dcr-task-add-card-btn"
                      onClick={() => handleAddTask(req.id)}
                      disabled={!(newTaskTexts[req.id] || '').trim()}
                      title="Добавить задачу (Enter)"
                    >Добавить</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* task 324: модалка редактирования ссылки на общую таблицу с отделами */}
      {showLinkModal && (
        <div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <h3>{externalLink ? 'Изменить ссылку на общую таблицу' : 'Указать ссылку на общую таблицу'}</h3>
              <button className="modal-close" onClick={() => setShowLinkModal(false)}>×</button>
            </div>
            <form onSubmit={saveExternalLink}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>URL общей таблицы отделов</label>
                  <input
                    type="url"
                    value={linkInput}
                    onChange={(e) => setLinkInput(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/…"
                    autoFocus
                  />
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.375rem' }}>
                    Оставьте поле пустым, чтобы удалить ссылку.
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowLinkModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
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
