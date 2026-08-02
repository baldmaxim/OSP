import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, requestDownloadUrl, uploadFile } from '../services/s3'
import S3DocumentPreview from '../components/S3DocumentPreview'
import AutoGrowTextarea from '../components/AutoGrowTextarea'
import FilterDropdown from '../components/FilterDropdown'
import { useIsPhone } from '../hooks/useMediaQuery'
import '../components/ContractRegistry.css'
import '../components/MobileCards.css'
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
  amount_before: '', // task 370
  amount_after: '', // task 370
  material_type: '', // task 370
}

const STATUS_OPTIONS = [
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'completed', label: 'Завершено', className: 'status-completed' },
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(o => [o.value, o.label]))

// task 370: тип материала по ДС.
const MATERIAL_OPTIONS = [
  { value: 'tolling', label: 'Давальческие (М-15)', className: 'material-tolling' },
  { value: 'realization', label: 'Реализация', className: 'material-realization' },
]
// Сколько контрагентов показывать в выпадающем поиске за раз (список большой — 1000+).
const CP_SEARCH_LIMIT = 50

const MATERIAL_LABEL = Object.fromEntries(MATERIAL_OPTIONS.map(o => [o.value, o.label]))
const MATERIAL_CLASS = Object.fromEntries(MATERIAL_OPTIONS.map(o => [o.value, o.className]))

const TABS = [
  { key: 'all', label: 'Все заявки' },
  { key: 'in_work', label: 'В работе' },
  { key: 'completed', label: 'Завершено' },
  { key: 'deleted', label: 'Удаленные' },
]

// ── История изменений заявки (dc_request_audit_log) ─────────────────────────
const EVENT_LABEL = {
  created: 'Создание',
  status_changed: 'Смена статуса',
  field_updated: 'Изменение поля',
  soft_deleted: 'В «Удаленные»',
  restored: 'Восстановление',
}

// Поля заявки, изменения которых пишем в историю (порядок = порядок в модалке).
const AUDIT_FIELD_LABEL = {
  object_id: 'Объект',
  counterparty_id: 'Контрагент',
  ds_number: '№ ДС',
  works_description: 'Описание ДС',
  responsible_contact_id: 'Ответственный',
  status: 'Статус',
  expected_approval_date: 'Срок согласования',
  amount_before: 'Было подано',
  amount_after: 'Утверждено',
  material_type: 'Материал',
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

// task 370: парсинг введённой суммы → число | null. Терпим пробелы, ₽ и запятую.
function parseAmount(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  // \s в JS-регулярках уже покрывает все юникод-пробелы (вкл. U+00A0/U+2007/U+202F).
  const str = String(raw)
    .replace(/[₽\s]/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '')
  const num = parseFloat(str)
  return Number.isFinite(num) ? num : null
}

// task 371: всегда 2 знака после запятой + разрядность пробелами (ru-RU):
//   1000000 → «1 000 000,00».
const AMOUNT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
function formatAmount(num) {
  if (num == null || !Number.isFinite(num)) return ''
  return AMOUNT_FORMATTER.format(num)
}

// Процент изменения суммы: «5,6» (1 знак после запятой; для мелких изменений — 2).
const PERCENT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const PERCENT_FORMATTER_SMALL = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
function formatPercent(num) {
  if (num == null || !Number.isFinite(num)) return ''
  return num < 0.1 ? PERCENT_FORMATTER_SMALL.format(num) : PERCENT_FORMATTER.format(num)
}

// task 371: «живое» форматирование во время ввода — группировка разрядов пробелами
//   («1000000» → «1 000 000», «1000,5» → «1 000,5»). Десятичная часть до 2 знаков.
function formatAmountLive(raw) {
  if (raw == null) return ''
  let s = String(raw).replace(/\s/g, '').replace('.', ',').replace(/[^\d,]/g, '')
  const i = s.indexOf(',')
  let intPart = i === -1 ? s : s.slice(0, i)
  const decPart = i === -1 ? null : s.slice(i + 1).replace(/,/g, '').slice(0, 2)
  intPart = intPart.replace(/^0+(?=\d)/, '')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  if (decPart === null) return grouped
  return `${grouped || '0'},${decPart}`
}

// task 365 + 366: маленький popover для быстрого редактирования ориентировочного
//   срока согласования. Рендерится через React Portal в <body>, position:fixed —
//   не вызывает прокрутку родительской таблицы и не обрезается её overflow:auto.
//   Координаты считаются от anchorRect (BCR кнопки-триггера) с авто-флипом
//   вверх, если внизу не помещается.
const POPOVER_WIDTH = 248
const POPOVER_HEIGHT = 132

function DeadlinePopover({ initial, anchorRect, onClose, onSave }) {
  const [value, setValue] = useState(initial || '')
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const rootRef = useRef(null)

  useLayoutEffect(() => {
    if (!anchorRect) return
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = anchorRect.bottom + 6
    if (top + POPOVER_HEIGHT > vh - margin) {
      // не помещается снизу — переворачиваем над триггером
      top = Math.max(margin, anchorRect.top - POPOVER_HEIGHT - 6)
    }
    let left = anchorRect.left
    if (left + POPOVER_WIDTH > vw - margin) left = vw - POPOVER_WIDTH - margin
    if (left < margin) left = margin
    setPos({ top, left })
  }, [anchorRect])

  useEffect(() => {
    const handleClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose()
    }
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    const handleScrollOrResize = () => onClose()
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    // При прокрутке таблицы / окна позиция popover устареет — проще закрыть.
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [onClose])

  return createPortal(
    <div
      className="dcr-deadline-popover"
      ref={rootRef}
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
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
    </div>,
    document.body
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

// task 371: инлайн-ввод суммы с красивым форматированием.
//   В фокусе — «сырое» число для редактирования, вне фокуса — «1 000 000,00».
function AmountCellInput({ value, disabled, onSave }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  // Вне фокуса — с фикс. 2 знаками; в фокусе — «живой» формат (разряды пробелами).
  const display = focused ? draft : (value != null ? formatAmount(value) : '')
  return (
    <input
      type="text"
      inputMode="decimal"
      className="dcr-amount-input"
      value={display}
      disabled={disabled}
      placeholder="—"
      onFocus={() => { setFocused(true); setDraft(value != null ? formatAmountLive(String(value)) : '') }}
      onChange={(e) => setDraft(formatAmountLive(e.target.value))}
      onBlur={() => { setFocused(false); onSave(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

function DcRequestsPage() {
  const { userProfile, canEdit, isAdmin, scopedObjectIds } = useRole()
  // Телефон: список заявок рендерим карточками вместо широкой таблицы
  const isPhone = useIsPhone()
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
  // Активный пункт списка для навигации клавишами ↑/↓/Enter.
  const [cpHighlight, setCpHighlight] = useState(0)
  // task 365 + 366: какая заявка сейчас в inline-popover для редактирования срока,
  //   и куда привязан popover (rect триггерной кнопки). Popover рендерится через
  //   portal, поэтому anchor нужен для расчёта fixed-координат.
  const [deadlinePopover, setDeadlinePopover] = useState(null) // { id, rect } | null

  const [searchQuery, setSearchQuery] = useState('')
  // Фильтры в тулбаре: множественный выбор (пустой массив = фильтр не применён).
  const [filterObjectIds, setFilterObjectIds] = useState([])
  const [filterCounterpartyIds, setFilterCounterpartyIds] = useState([])
  const [filterResponsibleIds, setFilterResponsibleIds] = useState([])
  // История изменений: заявка, чья история открыта (или null) + её записи.
  const [historyFor, setHistoryFor] = useState(null)
  const [historyRows, setHistoryRows] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      let query = supabase
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
      // Скоуп по объектам: сотрудник видит только заявки своих объектов.
      if (scopedObjectIds.length > 0) query = query.in('object_id', scopedObjectIds)
      const { data, error } = await query
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
    // Постранично: PostgREST отдаёт максимум 1000 строк, а контрагентов уже больше —
    // без пагинации обрезался хвост сортировки по названию (буква «Ф» и далее,
    // из-за чего не находился «Фортекс»). Тай-брейк по id: имена неуникальны.
    const PAGE = 1000
    const rows = []
    try {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('counterparties')
          .select('id, name, inn')
          .is('deleted_at', null)   // удалённых не предлагаем к выбору
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      setCounterparties(rows)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
    }
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
      amount_before: req.amount_before != null ? String(req.amount_before) : '', // task 370
      amount_after: req.amount_after != null ? String(req.amount_after) : '', // task 370
      material_type: req.material_type || '', // task 370
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

  // Поиск контрагента: сначала совпадения С НАЧАЛА названия/ИНН, потом любые вхождения —
  // при 1000+ контрагентах это выводит нужного наверх (набрал «форт» → «Фортекс» первым).
  const cpMatches = useMemo(() => {
    const q = cpSearch.trim().toLowerCase()
    if (!q) return counterparties
    const starts = []
    const contains = []
    for (const cp of counterparties) {
      const name = (cp.name || '').toLowerCase()
      const inn = (cp.inn || '').toLowerCase()
      if (name.startsWith(q) || inn.startsWith(q)) starts.push(cp)
      else if (name.includes(q) || inn.includes(q)) contains.push(cp)
    }
    return [...starts, ...contains]
  }, [counterparties, cpSearch])

  const cpVisible = cpMatches.slice(0, CP_SEARCH_LIMIT)

  // При изменении запроса подсветку возвращаем на первый пункт.
  useEffect(() => { setCpHighlight(0) }, [cpSearch])

  // ── История изменений ──────────────────────────────────────────────────────
  // Универсальная запись в аудит-лог (по образцу logContractEvent). Ошибки глотаем:
  // сбой логирования не должен ломать саму правку заявки.
  const logDcEvent = async (dcRequestId, eventType, payload = {}) => {
    if (!dcRequestId || !eventType) return
    try {
      await supabase.from('dc_request_audit_log').insert([{
        dc_request_id: dcRequestId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: localStorage.getItem('userRole') || null,
        changed_by_name: userProfile?.full_name || null,
      }])
    } catch (err) {
      console.error('Ошибка записи истории заявки:', err.message)
    }
  }

  // Человекочитаемое значение поля: id → имя, суммы/даты/словари → как в интерфейсе.
  const auditValueText = useCallback((field, value) => {
    if (value === null || value === undefined || value === '') return '—'
    switch (field) {
      case 'object_id':
        return objects.find(o => o.id === value)?.name || String(value)
      case 'counterparty_id':
        return counterparties.find(c => c.id === value)?.name || String(value)
      case 'responsible_contact_id':
        return contacts.find(c => c.id === value)?.full_name || String(value)
      case 'status':
        return STATUS_LABEL[value] || String(value)
      case 'material_type':
        return MATERIAL_LABEL[value] || String(value)
      case 'expected_approval_date':
        return formatShortDate(value) || String(value)
      case 'amount_before':
      case 'amount_after':
        return `${formatAmount(Number(value))} ₽`
      default:
        return String(value)
    }
  }, [objects, counterparties, contacts])

  // Открыть историю заявки (модалка, только чтение).
  const openHistory = async (req) => {
    setHistoryFor(req)
    setHistoryLoading(true)
    setHistoryRows([])
    try {
      const { data, error } = await supabase
        .from('dc_request_audit_log')
        .select('*')
        .eq('dc_request_id', req.id)
        .order('changed_at', { ascending: false })
      if (error) throw error
      setHistoryRows(data || [])
    } catch (err) {
      console.error('Ошибка загрузки истории заявки:', err.message)
    } finally {
      setHistoryLoading(false)
    }
  }

  // Одна запись «Поле: было → стало».
  const logFieldChange = (id, field, oldValue, newValue) => logDcEvent(id, 'field_updated', {
    fieldName: field,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    description: `${AUDIT_FIELD_LABEL[field] || field}: ${auditValueText(field, oldValue)} → ${auditValueText(field, newValue)}`,
  })

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
        amount_before: parseAmount(formData.amount_before), // task 370
        amount_after: parseAmount(formData.amount_after), // task 370
        material_type: formData.material_type || null, // task 370
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        const { error } = await supabase.from('dc_requests').update(payload).eq('id', editing.id)
        if (error) throw error
        // История: по одной записи на каждое реально изменившееся поле («было → стало»).
        for (const field of Object.keys(AUDIT_FIELD_LABEL)) {
          const before = editing[field] ?? null
          const after = payload[field] ?? null
          if (before === after) continue
          if (field === 'status') {
            await logDcEvent(editing.id, 'status_changed', {
              fieldName: 'status',
              oldValue: before,
              newValue: after,
              description: `Статус: ${auditValueText('status', before)} → ${auditValueText('status', after)}`,
            })
          } else {
            await logFieldChange(editing.id, field, before, after)
          }
        }
      } else {
        // .select('id') нужен, чтобы записать в историю событие создания.
        const { data, error } = await supabase.from('dc_requests').insert([{
          ...payload,
          created_by_name: userProfile?.full_name || null,
        }]).select('id').single()
        if (error) throw error
        await logDcEvent(data?.id, 'created', {
          description: `Заявка создана${payload.ds_number ? ` (№ ДС ${payload.ds_number})` : ''}`,
        })
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
    const next = newDate || null
    const prev = requests.find(r => r.id === id)?.expected_approval_date ?? null
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ expected_approval_date: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      if (prev !== next) await logFieldChange(id, 'expected_approval_date', prev, next)
      setDeadlinePopover(null)
      fetchRequests()
    } catch (err) {
      alert('Ошибка сохранения срока: ' + (err.message || err))
    }
  }

  // task 366: открыть popover, привязав его к BCR-кнопки-триггера.
  const openDeadlinePopover = (id, e) => {
    setDeadlinePopover({ id, rect: e.currentTarget.getBoundingClientRect() })
  }

  const handleStatusChange = async (id, newStatus) => {
    const oldStatus = requests.find(r => r.id === id)?.status ?? null
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r))
      if (oldStatus !== newStatus) {
        await logDcEvent(id, 'status_changed', {
          fieldName: 'status',
          oldValue: oldStatus,
          newValue: newStatus,
          description: `Статус: ${auditValueText('status', oldStatus)} → ${auditValueText('status', newStatus)}`,
        })
      }
    } catch (err) {
      alert('Ошибка смены статуса: ' + (err.message || err))
    }
  }

  // task 370: инлайн-сохранение суммы (Было/Стало) прямо из ячейки таблицы.
  // field ∈ 'amount_before' | 'amount_after'. Пустая строка → null.
  const handleSaveAmount = async (id, field, rawValue) => {
    const num = parseAmount(rawValue)
    const current = requests.find(r => r.id === id)
    if (current && (current[field] ?? null) === num) return // без изменений
    const prevValue = current?.[field] ?? null
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ [field]: num, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, [field]: num } : r))
      await logFieldChange(id, field, prevValue, num)
    } catch (err) {
      alert('Ошибка сохранения суммы: ' + (err.message || err))
    }
  }

  // task 371: инлайн-смена типа материала прямо из таблицы.
  const handleSaveMaterial = async (id, value) => {
    const next = value || null
    const prevValue = requests.find(r => r.id === id)?.material_type ?? null
    if (prevValue === next) return
    try {
      const { error } = await supabase
        .from('dc_requests')
        .update({ material_type: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, material_type: next } : r))
      await logFieldChange(id, 'material_type', prevValue, next)
    } catch (err) {
      alert('Ошибка сохранения материала: ' + (err.message || err))
    }
  }

  // Soft-delete: заявка уходит во вкладку «Удаленные» (документы/задачи сохраняются).
  const handleDelete = async (id) => {
    if (!window.confirm('Переместить заявку в «Удаленные»?')) return
    try {
      const { error } = await supabase.from('dc_requests')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      await logDcEvent(id, 'soft_deleted', { description: 'Заявка перемещена в «Удаленные»' })
      fetchRequests()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  // Восстановление из «Удаленных» (доступно редактору).
  const handleRestore = async (id) => {
    try {
      const { error } = await supabase.from('dc_requests')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      await logDcEvent(id, 'restored', { description: 'Заявка восстановлена из «Удаленных»' })
      fetchRequests()
    } catch (err) {
      alert('Ошибка восстановления: ' + (err.message || err))
    }
  }

  // Безвозвратное удаление — только администратор. Чистим S3-документы (нет FK-каскада).
  const handleHardDelete = async (id) => {
    if (!window.confirm('Удалить заявку безвозвратно? Все её задачи и документы также будут удалены.')) return
    try {
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

  // Docs upload. task 370: category ∈ 'general' | 'final' — рабочий или итоговый документ.
  const handleDocPick = (requestId, category = 'general') => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (file) {
        setDocUpload({ requestId, file, description: '', category })
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
        category: docUpload.category || 'general', // task 370
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

  const isDeletedTab = activeTab === 'deleted'

  // Фильтрация: таб (soft-delete) → объект → контрагент → ответственный → поиск.
  const filtered = requests
    .filter(r => isDeletedTab
      ? r.deleted_at != null
      : (r.deleted_at == null && (activeTab === 'all' || (r.status || 'in_work') === activeTab)))
    .filter(r => filterObjectIds.length === 0 || filterObjectIds.includes(r.object_id))
    .filter(r => filterCounterpartyIds.length === 0 || filterCounterpartyIds.includes(r.counterparty_id))
    .filter(r => filterResponsibleIds.length === 0 || filterResponsibleIds.includes(r.responsible_contact_id))
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
    all: requests.filter(r => r.deleted_at == null).length,
    in_work: requests.filter(r => r.deleted_at == null && (r.status || 'in_work') === 'in_work').length,
    completed: requests.filter(r => r.deleted_at == null && r.status === 'completed').length,
    deleted: requests.filter(r => r.deleted_at != null).length,
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

  // Любой id контакта → «представитель» (первый id с тем же ФИО), который и есть в
  // dedupedContacts. Иначе сохранённый ответственный из non-first дубля не совпадёт
  // ни с одной опцией селекта и покажется «Не назначен» (хотя в таблице виден).
  const contactRepById = (() => {
    const nameToRep = new Map(dedupedContacts.map(c => [(c.full_name || '').trim().toLowerCase(), c.id]))
    const m = {}
    for (const c of contacts) {
      m[c.id] = nameToRep.get((c.full_name || '').trim().toLowerCase()) || c.id
    }
    return m
  })()

  // Фильтр ответственных — только те сотрудники, что реально назначены хотя бы на одну заявку.
  const usedResponsibleIds = new Set(
    requests.map(r => r.responsible_contact_id).filter(Boolean)
  )
  const responsibleFilterOptions = dedupedContacts.filter(c => usedResponsibleIds.has(c.id))

  // task 371: фильтр по контрагентам — только те, что реально фигурируют в заявках.
  const counterpartyFilterOptions = (() => {
    const byId = new Map()
    for (const r of requests) {
      if (r.counterparties?.id && !byId.has(r.counterparties.id)) {
        byId.set(r.counterparties.id, r.counterparties)
      }
    }
    return [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
  })()

  // task 370: выгрузка текущей выборки (с учётом вкладки/фильтров/поиска) в Excel.
  const handleExportExcel = () => {
    if (filtered.length === 0) {
      alert('Нечего выгружать — список пуст.')
      return
    }
    const rows = filtered.map((req, idx) => {
      const allDocs = docsByReq.get(req.id) || []
      const generalCount = allDocs.filter(d => d.doc_category !== 'final').length
      const finalCount = allDocs.filter(d => d.doc_category === 'final').length
      const tasks = req.dc_request_tasks || []
      const done = tasks.filter(t => t.is_completed).length
      const before = req.amount_before
      const after = req.amount_after
      const diff = (before != null && after != null) ? before - after : null
      return {
        '№': idx + 1,
        'Объект': req.objects?.name || '',
        'Контрагент': req.counterparties?.name || '',
        'Материал': MATERIAL_LABEL[req.material_type] || '',
        '№ ДС': req.ds_number || '',
        'Описание ДС': req.works_description || '',
        'Было подано, ₽ (с НДС 22%)': before != null ? before : '',
        'Утверждено, ₽ (с НДС 22%)': after != null ? after : '',
        'Разница, ₽': diff != null ? diff : '',
        'Изменение, %': (diff != null && Number.isFinite(Number(before)) && Number(before) !== 0)
          ? Number((-(diff / Number(before)) * 100).toFixed(2))
          : '',
        'Статус': STATUS_LABEL[req.status || 'in_work'] || '',
        'Ответственный': req.responsible?.full_name || '',
        'Срок согласования': formatShortDate(req.expected_approval_date),
        'Задачи': tasks.length ? `${done}/${tasks.length}` : '',
        'Документы': generalCount || '',
        'Итоговые документы': finalCount || '',
        'Создал': req.created_by_name || '',
        'Создано': formatShortDate(req.created_at),
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [
      { wch: 5 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 16 },
      { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
      { wch: 22 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 16 },
      { wch: 22 }, { wch: 12 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Заявки на ДС')
    const today = formatShortDate(new Date().toISOString()).replace(/\./g, '-')
    XLSX.writeFile(wb, `Заявки_на_ДС_${today}.xlsx`)
  }

  // task 370: единый рендер чипа документа — используется и в «рабочих»,
  // и в «итоговых» документах.
  const renderDocChip = (doc) => {
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
  }

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
          {/* task 370: выгрузка текущей выборки в Excel */}
          <button
            type="button"
            className="btn-secondary dcr-export-btn"
            onClick={handleExportExcel}
            title="Выгрузить текущую выборку в Excel"
          >
            <span aria-hidden>📊</span>
            <span>Excel</span>
          </button>
          {canEditDc && (
            <button className="btn-primary" onClick={handleAddNew}>+ Добавить заявку</button>
          )}
        </div>
      </div>

      <div className="status-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`status-tab ${activeTab === tab.key ? 'active' : ''} ${tab.key === 'deleted' ? 'tab-deleted' : ''}`}
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
        <div className={`dcr-filter-drop${filterObjectIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск объекта…"
            allLabel="🏢 Все объекты"
            value={filterObjectIds}
            onChange={setFilterObjectIds}
            options={objects.map(o => ({ value: o.id, label: o.name }))}
          />
        </div>
        <div className={`dcr-filter-drop${filterCounterpartyIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск контрагента…"
            allLabel="🏗️ Все контрагенты"
            value={filterCounterpartyIds}
            onChange={setFilterCounterpartyIds}
            options={counterpartyFilterOptions.map(cp => ({ value: cp.id, label: cp.name }))}
            disabled={counterpartyFilterOptions.length === 0}
          />
        </div>
        <div className={`dcr-filter-drop${filterResponsibleIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск сотрудника…"
            allLabel="👤 Все ответственные"
            value={filterResponsibleIds}
            onChange={setFilterResponsibleIds}
            options={responsibleFilterOptions.map(c => ({ value: c.id, label: c.full_name }))}
            disabled={responsibleFilterOptions.length === 0}
          />
        </div>
        {(filterObjectIds.length > 0 || filterCounterpartyIds.length > 0 || filterResponsibleIds.length > 0) && (
          <button
            type="button"
            className="dcr-filter-clear"
            onClick={() => { setFilterObjectIds([]); setFilterCounterpartyIds([]); setFilterResponsibleIds([]) }}
            title="Сбросить фильтры"
          >×</button>
        )}
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : isPhone ? (
        filtered.length === 0 ? (
          <div className="no-data" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            {searchQuery ? 'Ничего не найдено.' : isDeletedTab ? 'Нет удалённых заявок.' : 'Заявок пока нет.'}
          </div>
        ) : (
          <div className="mcard-list">
            {filtered.map((req) => {
              const currentStatus = req.status || 'in_work'
              const statusOpt = STATUS_OPTIONS.find(o => o.value === currentStatus)
              const tasks = req.dc_request_tasks || []
              const totalTasks = tasks.length
              const completedTasks = tasks.filter(t => t.is_completed).length
              const docsCount = (docsByReq.get(req.id) || []).length
              return (
                <div key={req.id} className={`mcard${req.deleted_at ? ' row-deleted' : ''}`}>
                  <div className="mcard-head">
                    <span className="mcard-num">{req.ds_number ? `№ ДС ${req.ds_number}` : '№ ДС не присвоен'}</span>
                    <span className={`status-badge ${statusOpt?.className || ''}`}>{STATUS_LABEL[currentStatus]}</span>
                  </div>
                  <div className="mcard-title">{req.objects?.name || '—'}</div>
                  {req.works_description && <div className="mcard-desc">{req.works_description}</div>}
                  <div className="mcard-rows">
                    <div className="mcard-row">
                      <span className="mcard-label">Контрагент</span>
                      <span className="mcard-value">{req.counterparties?.name || '—'}</span>
                    </div>
                    {req.material_type && (
                      <div className="mcard-row">
                        <span className="mcard-label">Материал</span>
                        <span className="mcard-value">{MATERIAL_LABEL[req.material_type] || '—'}</span>
                      </div>
                    )}
                    <div className="mcard-row">
                      <span className="mcard-label">Сумма, руб.</span>
                      <span className="mcard-value">
                        {req.amount_before != null ? formatAmount(req.amount_before) : '—'}
                        {' → '}
                        {req.amount_after != null ? formatAmount(req.amount_after) : '—'}
                      </span>
                    </div>
                    <div className="mcard-row">
                      <span className="mcard-label">Ответственный</span>
                      <span className="mcard-value">{req.responsible?.full_name || '—'}</span>
                    </div>
                    <div className="mcard-row">
                      <span className="mcard-label">Ориент. срок</span>
                      <span className="mcard-value">{req.expected_approval_date ? formatShortDate(req.expected_approval_date) : '—'}</span>
                    </div>
                  </div>
                  <div className="mcard-foot">
                    {docsCount > 0 && <span className="mcard-chip">📎 {docsCount}</span>}
                    <div className="mcard-actions">
                      <button
                        className="btn-icon btn-history"
                        onClick={() => openHistory(req)}
                        title="История изменений"
                        aria-label="История изменений"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 3v5h5" />
                          <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                          <path d="M12 7v5l3 2" />
                        </svg>
                      </button>
                      <button
                        className="btn-icon"
                        onClick={() => setTasksModalFor(req.id)}
                        title="Задачи и ответы"
                        aria-label="Задачи и ответы"
                      >
                        ✔ {totalTasks > 0 ? `${completedTasks}/${totalTasks}` : '0'}
                      </button>
                      {isDeletedTab ? (
                        <>
                          {canEditDc && (
                            <button className="btn-icon btn-restore" onClick={() => handleRestore(req.id)} title="Восстановить" aria-label="Восстановить">↩</button>
                          )}
                          {isAdmin && (
                            <button className="btn-icon btn-delete" onClick={() => handleHardDelete(req.id)} title="Удалить безвозвратно" aria-label="Удалить безвозвратно">🗑️</button>
                          )}
                        </>
                      ) : canEditDc ? (
                        <button className="btn-icon btn-edit" onClick={() => handleEdit(req)} title="Редактировать" aria-label="Редактировать">✏️</button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        <div className="table-container">
          <table className="dcr-table">
            <thead>
              <tr>
                <th style={{ width: '3%' }}>№</th>
                <th style={{ width: '11%' }}>Объект</th>
                <th style={{ width: '13%' }}>Контрагент</th>
                <th style={{ width: '6%', textAlign: 'center' }}>№ ДС</th>
                <th style={{ width: '10%' }}>Описание ДС</th>
                {/* task 370: сумма ДС («Было подано» / «Утверждено») с НДС 22% перед статусом */}
                <th style={{ width: '14%', whiteSpace: 'normal', textAlign: 'center' }}>Сумма, руб. с НДС 22%</th>
                <th style={{ width: '8%' }}>Статус</th>
                <th style={{ width: '9%' }}>Ответственный</th>
                {/* task 334: было «Задачи и ответы» (inline) — теперь только счётчик-кнопка,
                    подробности в модалке. Колонка сильно компактнее, освобождённое место —
                    в «Описание ДС» и «Документы». */}
                <th style={{ width: '8%', textAlign: 'center' }}>Задачи</th>
                <th style={{ width: '13%' }}>Документы</th>
                <th style={{ width: '5%', textAlign: 'right' }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="11" className="no-data" style={{ textAlign: 'center' }}>
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
                  // task 370: рабочие vs итоговые документы.
                  const generalDocs = docs.filter(d => d.doc_category !== 'final')
                  const finalDocs = docs.filter(d => d.doc_category === 'final')
                  const docsOpen = expandedDocs.has(req.id)

                  // task 370: разница сумм («Было подано» − «Утверждено»). >0 → удешевление.
                  const amountBefore = req.amount_before
                  const amountAfter = req.amount_after
                  const amountDiff = (amountBefore != null && amountAfter != null)
                    ? amountBefore - amountAfter
                    : null
                  // Процент изменения — от поданной суммы. Если «Было подано» пусто или 0 — не считаем.
                  const amountPct = (amountDiff != null && Number.isFinite(Number(amountBefore)) && Number(amountBefore) !== 0)
                    ? (amountDiff / Number(amountBefore)) * 100
                    : null

                  return (
                    <tr key={req.id} className={req.deleted_at ? 'row-deleted' : ''}>
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
                              onClick={canEditDc ? (e) => openDeadlinePopover(req.id, e) : undefined}
                              disabled={!canEditDc}
                              title={canEditDc ? 'Изменить срок' : undefined}
                            >
                              {formatShortDate(req.expected_approval_date)}г.
                            </button>
                          ) : canEditDc ? (
                            <button
                              type="button"
                              className="dcr-meta-deadline-link"
                              onClick={(e) => openDeadlinePopover(req.id, e)}
                            >
                              Указать срок
                            </button>
                          ) : (
                            <span className="dcr-meta-deadline-empty">—</span>
                          )}
                          {deadlinePopover?.id === req.id && (
                            <DeadlinePopover
                              initial={req.expected_approval_date || ''}
                              anchorRect={deadlinePopover.rect}
                              onClose={() => setDeadlinePopover(null)}
                              onSave={(newDate) => handleQuickSaveDeadline(req.id, newDate)}
                            />
                          )}
                        </div>
                      </td>
                      <td>
                        {req.counterparties?.name || <span className="muted-dash">—</span>}
                        {/* task 370 + 371: материал. Сотрудник меняет инлайн-селектором
                            прямо в таблице, остальные видят бейдж «Материал: …». */}
                        {canEditDc ? (
                          <div className="dcr-material-edit">
                            <span className="dcr-material-edit-label">Материал:</span>
                            <select
                              className={`dcr-material-select ${MATERIAL_CLASS[req.material_type] || 'is-empty'}`}
                              value={req.material_type || ''}
                              onChange={(e) => handleSaveMaterial(req.id, e.target.value)}
                              title="Тип материала"
                            >
                              <option value="">— не указан —</option>
                              {MATERIAL_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                        ) : req.material_type && (
                          <div className={`dcr-material-badge ${MATERIAL_CLASS[req.material_type] || ''}`}>
                            Материал: {MATERIAL_LABEL[req.material_type]}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>{req.ds_number || <span className="muted-dash">—</span>}</td>
                      <td className="dcr-cell-works">{req.works_description || <span className="muted-dash">—</span>}</td>
                      {/* task 370: сумма ДС («Было подано» / «Утверждено») с инлайн-редактированием + разница */}
                      <td className="dcr-cell-amount">
                        <div className="dcr-amount">
                          <div className="dcr-amount-row">
                            <span className="dcr-amount-label">Было подано</span>
                            {canEditDc ? (
                              <AmountCellInput
                                value={amountBefore}
                                disabled={!canEditDc}
                                onSave={(v) => handleSaveAmount(req.id, 'amount_before', v)}
                              />
                            ) : (
                              <span className="dcr-amount-value">{amountBefore != null ? formatAmount(amountBefore) : '—'}</span>
                            )}
                          </div>
                          <div className="dcr-amount-row">
                            <span className="dcr-amount-label">Утверждено</span>
                            {canEditDc ? (
                              <AmountCellInput
                                value={amountAfter}
                                disabled={!canEditDc}
                                onSave={(v) => handleSaveAmount(req.id, 'amount_after', v)}
                              />
                            ) : (
                              <span className="dcr-amount-value">{amountAfter != null ? formatAmount(amountAfter) : '—'}</span>
                            )}
                          </div>
                          {amountDiff != null && amountDiff !== 0 ? (
                            <div
                              className={`dcr-amount-diff ${amountDiff > 0 ? 'is-cheaper' : 'is-pricier'}`}
                              title={amountDiff > 0 ? 'Удешевление относительно поданной суммы' : 'Удорожание относительно поданной суммы'}
                            >
                              <span className="dcr-diff-abs">{amountDiff > 0 ? '↓' : '↑'} {formatAmount(Math.abs(amountDiff))} ₽</span>
                              {amountPct != null && (
                                <span className="dcr-diff-pct">
                                  {amountPct > 0 ? '−' : '+'}{formatPercent(Math.abs(amountPct))}%
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="dcr-amount-diff is-zero">
                              {amountDiff === 0 ? 'без изменений' : ''}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="dcr-status-wrap">
                          <button
                            type="button"
                            className={`dcr-status-chip ${statusOpt?.className || ''}${isStatusOpen ? ' is-open' : ''}`}
                            onClick={() => canEditDc && !isDeletedTab && setStatusPopoverFor(isStatusOpen ? null : req.id)}
                            disabled={!canEditDc || isDeletedTab}
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
                        {/* Рабочие документы */}
                        <div className="dcr-docs">
                          {generalDocs.length > 0 && (
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
                                Файлы: <strong>{generalDocs.length}</strong>
                              </span>
                            </button>
                          )}
                          {docsOpen && generalDocs.length > 0 && (
                            <div className="dcr-doc-chips">
                              {generalDocs.map(renderDocChip)}
                            </div>
                          )}
                          {canEditDc && (
                            <button
                              type="button"
                              className="dcr-doc-add"
                              onClick={() => handleDocPick(req.id, 'general')}
                              title="Добавить документ"
                            >+ Документ</button>
                          )}
                        </div>

                        {/* task 370: итоговые документы — отдельная секция,
                            подсвечивается при наличии файлов. */}
                        {(finalDocs.length > 0 || canEditDc) && (
                          <div className={`dcr-final-docs${finalDocs.length > 0 ? ' has-final' : ''}`}>
                            <div className="dcr-final-docs-title">
                              <span className="dcr-final-docs-icon" aria-hidden>✔</span>
                              Итоговые документы
                              {finalDocs.length > 0 && (
                                <span className="dcr-final-docs-count">{finalDocs.length}</span>
                              )}
                            </div>
                            {finalDocs.length > 0 && (
                              <div className="dcr-doc-chips">
                                {finalDocs.map(renderDocChip)}
                              </div>
                            )}
                            {canEditDc && (
                              <button
                                type="button"
                                className="dcr-doc-add dcr-doc-add-final"
                                onClick={() => handleDocPick(req.id, 'final')}
                                title="Добавить итоговый документ"
                              >+ Итоговый документ</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="actions-cell">
                        {/* История доступна всем, кто видит заявку, — она только для чтения */}
                        <button
                          className="btn-icon btn-history"
                          onClick={() => openHistory(req)}
                          title="История изменений"
                          aria-label="История изменений"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 3v5h5" />
                            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                            <path d="M12 7v5l3 2" />
                          </svg>
                        </button>
                        {isDeletedTab ? (
                          <>
                            {canEditDc && (
                              <button className="btn-icon btn-restore" onClick={() => handleRestore(req.id)} title="Восстановить">↩</button>
                            )}
                            {isAdmin && (
                              <button className="btn-icon btn-delete" onClick={() => handleHardDelete(req.id)} title="Удалить безвозвратно (админ)">🗑️</button>
                            )}
                          </>
                        ) : canEditDc ? (
                          <>
                            <button className="btn-icon btn-edit" onClick={() => handleEdit(req)} title="Редактировать">✏️</button>
                            <button className="btn-icon btn-delete" onClick={() => handleDelete(req.id)} title="Удалить">🗑️</button>
                          </>
                        ) : null}
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
                      // Навигация клавишами: ↑/↓ — по списку, Enter — выбрать, Esc — закрыть.
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setCpDropdownOpen(false); return }
                        if (!cpDropdownOpen) {
                          if (e.key === 'ArrowDown') { setCpDropdownOpen(true); e.preventDefault() }
                          return
                        }
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setCpHighlight(i => Math.min(i + 1, cpVisible.length - 1))
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setCpHighlight(i => Math.max(i - 1, 0))
                        } else if (e.key === 'Enter' && cpVisible[cpHighlight]) {
                          e.preventDefault()
                          handleSelectCp(cpVisible[cpHighlight])
                        }
                      }}
                      required={!formData.counterparty_id}
                    />
                    {cpSearch && (
                      <button
                        type="button"
                        className="cp-search-clear"
                        title="Очистить"
                        aria-label="Очистить"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setCpSearch('')
                          setFormData(prev => ({ ...prev, counterparty_id: '' }))
                          setCpDropdownOpen(true)
                        }}
                      >×</button>
                    )}
                    {cpDropdownOpen && (
                      <div className="cp-search-dropdown">
                        {cpVisible.length === 0 ? (
                          <div className="cp-search-empty">Ничего не найдено</div>
                        ) : (
                          <>
                            {cpVisible.map((cp, i) => (
                              <button
                                type="button"
                                key={cp.id}
                                className={`cp-search-item ${cp.id === formData.counterparty_id ? 'active' : ''} ${i === cpHighlight ? 'is-highlighted' : ''}`}
                                onMouseEnter={() => setCpHighlight(i)}
                                onMouseDown={() => handleSelectCp(cp)}
                              >
                                <div className="cp-search-name">{cp.name}</div>
                                {cp.inn && <div className="cp-search-inn">ИНН: {cp.inn}</div>}
                              </button>
                            ))}
                            <div className="cp-search-hint">
                              {cpMatches.length > CP_SEARCH_LIMIT
                                ? `Показаны первые ${CP_SEARCH_LIMIT} из ${cpMatches.length} — уточните запрос`
                                : `Найдено: ${cpMatches.length}`}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* task 370: тип материала по ДС */}
                <div className="form-group full-width">
                  <label>Материал</label>
                  <select name="material_type" value={formData.material_type} onChange={handleInputChange}>
                    <option value="">— Не указан —</option>
                    {MATERIAL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
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

                {/* task 370: суммы ДС (с НДС 22%) — «Было подано» / «Утверждено» */}
                <div className="form-group">
                  <label>Было подано, ₽ (с НДС 22%)</label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    name="amount_before"
                    value={formData.amount_before}
                    onChange={handleInputChange}
                    placeholder="0"
                  />
                </div>

                <div className="form-group">
                  <label>Утверждено, ₽ (с НДС 22%)</label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    name="amount_after"
                    value={formData.amount_after}
                    onChange={handleInputChange}
                    placeholder="0"
                  />
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
                    value={contactRepById[formData.responsible_contact_id] || formData.responsible_contact_id || ''}
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

      {/* История изменений заявки. Только чтение; закрывается крестиком/«Закрыть». */}
      {historyFor && (
        <div className="modal-overlay">
          <div className="modal dcr-history-modal">
            <div className="modal-header">
              <div>
                <h3>История изменений</h3>
                <p className="dcr-history-sub">
                  {historyFor.ds_number ? `№ ДС ${historyFor.ds_number}` : 'Заявка без № ДС'}
                  {historyFor.objects?.name ? ` · ${historyFor.objects.name}` : ''}
                </p>
              </div>
              <button className="modal-close" onClick={() => setHistoryFor(null)} aria-label="Закрыть">×</button>
            </div>
            <div className="dcr-history-body">
              {historyLoading ? (
                <div className="loading">Загрузка...</div>
              ) : historyRows.length === 0 ? (
                <div className="dcr-history-empty">
                  <p>Записей нет.</p>
                  <p className="dcr-history-hint">
                    История ведётся с момента подключения этой функции — более ранние изменения
                    не фиксировались.
                  </p>
                </div>
              ) : (
                <ul className="audit-list">
                  {historyRows.map(ev => (
                    <li key={ev.id} className="audit-item">
                      <div className="audit-meta">
                        <span className="audit-type">{EVENT_LABEL[ev.event_type] || ev.event_type}</span>
                        <span className="audit-date">{formatDateTime(ev.changed_at)}</span>
                      </div>
                      <div className="audit-desc">{ev.description || '—'}</div>
                      <div className="audit-who">
                        {ev.changed_by_name || 'без имени'}
                        {ev.changed_by_role ? ` (${ev.changed_by_role})` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setHistoryFor(null)}>Закрыть</button>
            </div>
          </div>
        </div>
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
              <h3>{docUpload.category === 'final' ? 'Загрузка итогового документа' : 'Загрузка документа'}</h3>
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
