import { Fragment, useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { CURRENCY_OPTIONS, formatMoney } from '../utils/estimateImport'
import ContractPreviewCard from '../components/ContractPreviewCard'
import '../components/ContractRegistry.css'

// Частые ставки НДС (задача 382): зависят от системы налогообложения контрагента.
const VAT_RATE_OPTIONS = ['', '0', '5', '7', '20', '22']

// Task 174 + 190: статусы договоров
const STATUS_OPTIONS = [
  { value: 'new_request', label: 'Новая заявка', className: 'status-new-request' },
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'paused', label: 'Приостановка', className: 'status-paused' },
  { value: 'completed', label: 'Завершено', className: 'status-completed' },
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(s => [s.value, s.label]))

// Вкладки (4 рабочих + удалённые). Удалённые — это soft-delete, deleted_at IS NOT NULL.
const TABS = [
  { key: 'new_request', label: 'Новая заявка' },
  { key: 'in_work', label: 'В работе' },
  { key: 'paused', label: 'Приостановка' },
  { key: 'completed', label: 'Завершено' },
  { key: 'deleted', label: 'Удаленные' },
]

const EMPTY_FORM = {
  contract_number: '',
  contract_date: '',
  counterparty_id: '',
  object_id: '',
  contract_amount: '',
  currency: 'RUB',
  vat_rate: '',
  amount_includes_vat: true,
  warranty_retention_percent: '',
  warranty_retention_period: '',
  work_start_date: '',
  work_end_date: '',
  accepted_date: '',
  signed_date: '',
  warranty_period: '',
  document_link: '',
  status: 'new_request',
  tender_id: '',
  work_name: '',
  responsible_contact_id: '',
}

// ДД.ММ.ГГГГ из ISO-даты (или null, если пусто/некорректно)
function formatDateRu(iso) {
  if (!iso) return null
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  if (!y || !m || !d) return null
  return `${d}.${m}.${y}`
}

function ContractRegistry() {
  const navigate = useNavigate()
  const { isAdmin, userProfile, canEdit } = useRole()
  // task 333: гейт add/edit/delete для раздела «contracts»
  const canEditContracts = canEdit('contracts')

  const [department, setDepartment] = useState(null) // null | 'construction' | 'warranty'
  const [activeTab, setActiveTab] = useState('new_request')

  const [contracts, setContracts] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingContract, setEditingContract] = useState(null)

  // Task 168: поиск контрагента
  const [counterpartySearch, setCounterpartySearch] = useState('')
  const [counterpartyDropdownOpen, setCounterpartyDropdownOpen] = useState(false)

  // Приложения объектов
  const [showAttachmentsModal, setShowAttachmentsModal] = useState(false)
  const [attachmentsObjectId, setAttachmentsObjectId] = useState('')
  const [objectAttachments, setObjectAttachments] = useState([])
  const [newAttachmentName, setNewAttachmentName] = useState('')
  const [newAttachmentDescription, setNewAttachmentDescription] = useState('')
  const [newAttachmentLink, setNewAttachmentLink] = useState('')
  const [formAttachments, setFormAttachments] = useState(new Set())
  const [availableAttachments, setAvailableAttachments] = useState([])
  const [contractAttachmentsMap, setContractAttachmentsMap] = useState({})

  // Task 188: dropdown состояние для приложений в форме
  const [attachmentsDropdownOpenForm, setAttachmentsDropdownOpenForm] = useState(false)
  // Task 193: раскрытая строка договора (показывает приложения с комментариями)
  const [expandedContractId, setExpandedContractId] = useState(null)

  const [formData, setFormData] = useState(EMPTY_FORM)

  // Панель фильтров реестра (over-table, in-memory)
  const [filterObjectId, setFilterObjectId] = useState('')
  const [filterLawyerId, setFilterLawyerId] = useState('')
  const [searchText, setSearchText] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [onlyNoDate, setOnlyNoDate] = useState(false)

  // Сортировка по клику на заголовок (default — по имени объекта, как раньше)
  const [sortKey, setSortKey] = useState('object')
  const [sortDir, setSortDir] = useState('asc')

  // Мини-карточка договора (popover)
  const [previewContractId, setPreviewContractId] = useState(null)
  const [previewAnchorEl, setPreviewAnchorEl] = useState(null)

  const objectStatus = department === 'construction' ? 'main_construction' : 'warranty_service'

  // Универсальная запись в аудит-лог (task 187)
  const logContractEvent = async (contractId, eventType, payload = {}) => {
    if (!contractId || !eventType) return
    try {
      const role = localStorage.getItem('userRole') || null
      await supabase.from('contract_audit_log').insert([{
        contract_id: contractId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null,
      }])
    } catch (err) {
      console.error('Ошибка записи истории договора:', err.message)
    }
  }

  useEffect(() => {
    if (department) {
      fetchContracts()
      fetchObjects()
      fetchCounterparties()
      fetchContacts()
      fetchTenders()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, activeTab])

  const fetchContracts = async () => {
    try {
      setLoading(true)
      let query = supabase
        .from('contracts')
        .select('*, objects(name, status), counterparties(name, inn), tenders(work_description), responsible:contacts!responsible_contact_id(id, full_name, position)')

      if (activeTab === 'deleted') {
        query = query.not('deleted_at', 'is', null)
      } else {
        query = query.is('deleted_at', null).eq('status', activeTab)
      }
      query = query.order('contract_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })

      const { data, error } = await query
      if (error) throw error

      // Задача 391: сортировка по объекту (затем по дате договора). Сортируем в JS,
      // т.к. серверный .order() по join-колонке objects.name недоступен.
      const filtered = (data || [])
        .filter(c => c.objects?.status === objectStatus)
        .sort((a, b) => {
          const cmp = (a.objects?.name || '').localeCompare(b.objects?.name || '', 'ru')
          if (cmp !== 0) return cmp
          return (a.contract_date || '').localeCompare(b.contract_date || '')
        })
      setContracts(filtered)

      // Подгружаем приложения договоров (с комментариями) для inline-раскрытия (task 193)
      const ids = filtered.map(c => c.id)
      if (ids.length > 0) {
        const { data: caRows, error: caErr } = await supabase
          .from('contract_attachments')
          .select('id, contract_id, comment, object_contract_attachments(id, name, description, link, sort_order)')
          .in('contract_id', ids)
        if (caErr) throw caErr
        const map = {}
        for (const row of caRows || []) {
          const att = row.object_contract_attachments
          if (!att) continue
          if (!map[row.contract_id]) map[row.contract_id] = []
          map[row.contract_id].push({
            ca_id: row.id,
            comment: row.comment || '',
            id: att.id,
            name: att.name,
            description: att.description || '',
            link: att.link,
            sort_order: att.sort_order,
          })
        }
        Object.values(map).forEach(arr => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)))
        setContractAttachmentsMap(map)
      } else {
        setContractAttachmentsMap({})
      }
    } catch (error) {
      console.error('Ошибка загрузки договоров:', error.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchObjects = async () => {
    try {
      const { data, error } = await supabase
        .from('objects')
        .select('id, name, status')
        .eq('status', objectStatus)
        .order('name', { ascending: true })
      if (error) throw error
      setObjects(data || [])
    } catch (error) {
      console.error('Ошибка загрузки объектов:', error.message)
    }
  }

  const fetchCounterparties = async () => {
    try {
      const { data, error } = await supabase
        .from('counterparties')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      setCounterparties(data || [])
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
    }
  }

  const fetchContacts = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, full_name, position, object_id')
        .order('full_name', { ascending: true })
      if (error) throw error
      setContacts(data || [])
    } catch (error) {
      console.error('Ошибка загрузки контактов:', error.message)
    }
  }

  const fetchTenders = async () => {
    try {
      const { data, error } = await supabase
        .from('tenders')
        .select('id, object_id, work_description, winner_counterparty_id, status')
        .order('created_at', { ascending: false })
      if (error) throw error
      setTenders(data || [])
    } catch (error) {
      console.error('Ошибка загрузки тендеров:', error.message)
    }
  }

  // Управление приложениями объектов
  const fetchObjectAttachments = async (objectId) => {
    if (!objectId) { setObjectAttachments([]); return }
    try {
      const { data, error } = await supabase
        .from('object_contract_attachments')
        .select('*')
        .eq('object_id', objectId)
        .order('sort_order', { ascending: true })
      if (error) throw error
      setObjectAttachments(data || [])
    } catch (err) {
      console.error('Ошибка загрузки приложений:', err.message)
    }
  }

  const handleAddAttachment = async () => {
    if (!attachmentsObjectId || !newAttachmentName.trim()) return
    try {
      const maxOrder = objectAttachments.reduce((m, a) => Math.max(m, a.sort_order || 0), 0)
      const { error } = await supabase
        .from('object_contract_attachments')
        .insert([{
          object_id: attachmentsObjectId,
          name: newAttachmentName.trim(),
          description: newAttachmentDescription.trim() || null,
          link: newAttachmentLink.trim() || null,
          sort_order: maxOrder + 1,
        }])
      if (error) throw error
      setNewAttachmentName('')
      setNewAttachmentDescription('')
      setNewAttachmentLink('')
      fetchObjectAttachments(attachmentsObjectId)
    } catch (err) {
      console.error('Ошибка добавления приложения:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Task 193: сохранение комментария к приложению договора (по blur)
  const handleSaveAttachmentComment = async (caId, newComment) => {
    try {
      const { error } = await supabase
        .from('contract_attachments')
        .update({ comment: newComment.trim() || null })
        .eq('id', caId)
      if (error) throw error
      setContractAttachmentsMap(prev => {
        const next = {}
        for (const [contractId, list] of Object.entries(prev)) {
          next[contractId] = list.map(a => a.ca_id === caId ? { ...a, comment: newComment } : a)
        }
        return next
      })
    } catch (err) {
      console.error('Ошибка сохранения комментария:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDeleteAttachment = async (id) => {
    if (!window.confirm('Удалить приложение из списка объекта?')) return
    try {
      const { error } = await supabase.from('object_contract_attachments').delete().eq('id', id)
      if (error) throw error
      fetchObjectAttachments(attachmentsObjectId)
    } catch (err) {
      console.error('Ошибка удаления приложения:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // При смене object_id в форме — подгружаем приложения объекта
  useEffect(() => {
    const loadFormAttachments = async () => {
      if (!formData.object_id) {
        setAvailableAttachments([])
        setFormAttachments(new Set())
        return
      }
      try {
        const { data, error } = await supabase
          .from('object_contract_attachments')
          .select('*')
          .eq('object_id', formData.object_id)
          .order('sort_order', { ascending: true })
        if (error) throw error
        const list = data || []
        setAvailableAttachments(list)
        if (editingContract) {
          const { data: cas } = await supabase
            .from('contract_attachments')
            .select('attachment_id')
            .eq('contract_id', editingContract.id)
          setFormAttachments(new Set((cas || []).map(r => r.attachment_id)))
        } else {
          setFormAttachments(new Set(list.map(a => a.id)))
        }
      } catch (err) {
        console.error('Ошибка загрузки приложений объекта:', err.message)
      }
    }
    loadFormAttachments()
  }, [formData.object_id, editingContract])

  // Автоподтягивание данных из тендера
  const handleTenderChange = (e) => {
    const tenderId = e.target.value
    setFormData(prev => {
      const next = { ...prev, tender_id: tenderId }
      if (tenderId) {
        const t = tenders.find(x => x.id === tenderId)
        if (t) {
          if (t.work_description && !prev.work_name) next.work_name = t.work_description
          if (t.winner_counterparty_id && !prev.counterparty_id) next.counterparty_id = t.winner_counterparty_id
          if (t.object_id && !prev.object_id) next.object_id = t.object_id
        }
      }
      return next
    })
  }

  const availableTenders = useMemo(() => {
    if (!formData.object_id) return tenders
    return tenders.filter(t => t.object_id === formData.object_id)
  }, [tenders, formData.object_id])

  // Задача 391: «Ответственный юрист» — список всех сотрудников (без фильтра по объекту).
  const availableContacts = contacts

  const filteredCounterparties = useMemo(() => {
    const q = counterpartySearch.trim().toLowerCase()
    if (!q) return counterparties
    return counterparties.filter(cp =>
      (cp.name || '').toLowerCase().includes(q) ||
      (cp.inn || '').toLowerCase().includes(q)
    )
  }, [counterparties, counterpartySearch])

  const selectedCounterparty = useMemo(() => {
    return counterparties.find(cp => cp.id === formData.counterparty_id) || null
  }, [counterparties, formData.counterparty_id])

  // ── Реестр: фильтры, сортировка, просрочка ─────────────────────────────
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // Просрочено = есть план-дата подписания (signed_date), она в прошлом и договор не завершён
  const isOverdue = useCallback((c) => {
    if (!c?.signed_date || c.status === 'completed') return false
    return String(c.signed_date).slice(0, 10) < todayStr
  }, [todayStr])

  const contactNameById = useMemo(() => {
    const m = {}
    contacts.forEach(c => { m[c.id] = c.full_name })
    return m
  }, [contacts])

  // Опции фильтра «Объект» — из объектов текущего отдела
  const objectFilterOptions = useMemo(() =>
    [...objects].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru')),
  [objects])

  // Опции фильтра «Ответственный юрист» — реально назначенные в загруженных договорах
  const lawyerFilterOptions = useMemo(() => {
    const seen = new Map()
    contracts.forEach(c => {
      const id = c.responsible_contact_id
      if (id && !seen.has(id)) seen.set(id, contactNameById[id] || c.responsible?.full_name || '—')
    })
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
  }, [contracts, contactNameById])

  const currentUserName = (userProfile?.full_name || '').trim().toLowerCase()

  const filteredSortedContracts = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    const list = contracts.filter(c => {
      if (filterObjectId && c.object_id !== filterObjectId) return false
      if (filterLawyerId && c.responsible_contact_id !== filterLawyerId) return false
      if (onlyMine) {
        const respName = (contactNameById[c.responsible_contact_id] || c.responsible?.full_name || '').trim().toLowerCase()
        if (!currentUserName || respName !== currentUserName) return false
      }
      if (onlyOverdue && !isOverdue(c)) return false
      if (onlyNoDate && c.signed_date) return false
      if (q) {
        const hay = [
          c.counterparties?.name,
          c.work_name,
          c.tenders?.work_description,
          c.contract_number,
          c.notes,
          c.objects?.name,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    const dir = sortDir === 'asc' ? 1 : -1
    const getVal = (c) => {
      switch (sortKey) {
        case 'counterparty': return (c.counterparties?.name || '').toLowerCase()
        case 'amount': return Number(c.contract_amount) || 0
        case 'status': return c.status || ''
        case 'accepted': return c.accepted_date || ''
        case 'planned': return c.signed_date || ''
        case 'object':
        default: return (c.objects?.name || '').toLowerCase()
      }
    }
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b)
      let cmp
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
      else cmp = String(va).localeCompare(String(vb), 'ru')
      if (cmp !== 0) return cmp * dir
      // вторичная сортировка — по объекту, затем дате договора (как в fetchContracts)
      const so = (a.objects?.name || '').localeCompare(b.objects?.name || '', 'ru')
      if (so !== 0) return so
      return (a.contract_date || '').localeCompare(b.contract_date || '')
    })
  }, [contracts, filterObjectId, filterLawyerId, onlyMine, onlyOverdue, onlyNoDate, searchText, sortKey, sortDir, contactNameById, currentUserName, isOverdue])

  const hasActiveFilters = !!(filterObjectId || filterLawyerId || searchText || onlyMine || onlyOverdue || onlyNoDate)

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const resetFilters = () => {
    setFilterObjectId(''); setFilterLawyerId(''); setSearchText('')
    setOnlyMine(false); setOnlyOverdue(false); setOnlyNoDate(false)
  }

  const openPreview = (e, contractId) => {
    e.stopPropagation()
    if (previewContractId === contractId) {
      setPreviewContractId(null); setPreviewAnchorEl(null)
    } else {
      setPreviewAnchorEl(e.currentTarget); setPreviewContractId(contractId)
    }
  }

  const closePreview = useCallback(() => {
    setPreviewContractId(null); setPreviewAnchorEl(null)
  }, [])

  // Закрываем мини-карточку при смене вкладки/фильтров/сортировки
  useEffect(() => {
    setPreviewContractId(null); setPreviewAnchorEl(null)
  }, [activeTab, filterObjectId, filterLawyerId, searchText, onlyMine, onlyOverdue, onlyNoDate, sortKey, sortDir])

  const previewContract = previewContractId
    ? filteredSortedContracts.find(c => c.id === previewContractId)
    : null

  // Заголовок с сортировкой по клику (не вложенный компонент — обычная функция-рендер)
  const sortableTh = (col, label, style) => (
    <th
      style={style}
      className={`th-sortable ${sortKey === col ? 'th-sorted' : ''}`}
      onClick={() => toggleSort(col)}
      title="Сортировать"
    >
      <span className="th-label">{label}</span>
      <span className="sort-ind" aria-hidden>{sortKey === col ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
    </th>
  )

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleSelectCounterparty = (id, name) => {
    setFormData(prev => ({ ...prev, counterparty_id: id }))
    setCounterpartySearch(name || '')
    setCounterpartyDropdownOpen(false)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const payload = {
        ...formData,
        counterparty_id: formData.counterparty_id || null,
        object_id: formData.object_id || null,
        tender_id: formData.tender_id || null,
        responsible_contact_id: formData.responsible_contact_id || null,
        accepted_date: formData.accepted_date || null,
        signed_date: formData.signed_date || null,
        warranty_retention_percent: formData.warranty_retention_percent === '' ? null : formData.warranty_retention_percent,
        // Сумма необязательна — считается из ПСДЦ; пустое поле = NULL.
        contract_amount: formData.contract_amount === '' ? null : formData.contract_amount,
        vat_rate: formData.vat_rate === '' ? null : formData.vat_rate,
        currency: formData.currency || 'RUB',
        amount_includes_vat: formData.amount_includes_vat !== false,
      }

      let contractId = editingContract?.id
      if (editingContract) {
        const { error } = await supabase.from('contracts').update(payload).eq('id', editingContract.id)
        if (error) throw error
        await logContractEvent(contractId, 'field_updated', { description: 'Обновлены данные договора' })
      } else {
        const { data, error } = await supabase.from('contracts').insert([payload]).select('id').single()
        if (error) throw error
        contractId = data?.id
        await logContractEvent(contractId, 'created', { description: `Создан договор № ${payload.contract_number}` })
      }

      if (contractId) {
        await supabase.from('contract_attachments').delete().eq('contract_id', contractId)
        const rows = Array.from(formAttachments).map(attachment_id => ({ contract_id: contractId, attachment_id }))
        if (rows.length > 0) {
          const { error: caErr } = await supabase.from('contract_attachments').insert(rows)
          if (caErr) throw caErr
        }
      }

      setShowModal(false)
      setEditingContract(null)
      setFormData({ ...EMPTY_FORM, status: activeTab === 'deleted' ? 'new_request' : activeTab })
      setCounterpartySearch('')
      setFormAttachments(new Set())
      fetchContracts()
    } catch (error) {
      console.error('Ошибка сохранения договора:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditContract = (contract) => {
    setEditingContract(contract)
    setFormData({
      contract_number: contract.contract_number || '',
      contract_date: contract.contract_date || '',
      counterparty_id: contract.counterparty_id || '',
      object_id: contract.object_id || '',
      contract_amount: contract.contract_amount || '',
      currency: contract.currency || 'RUB',
      vat_rate: contract.vat_rate ?? '',
      amount_includes_vat: contract.amount_includes_vat !== false,
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: contract.work_start_date || '',
      work_end_date: contract.work_end_date || '',
      accepted_date: contract.accepted_date || '',
      signed_date: contract.signed_date || '',
      warranty_period: contract.warranty_period || '',
      document_link: contract.document_link || '',
      status: contract.status || 'new_request',
      tender_id: contract.tender_id || '',
      work_name: contract.work_name || '',
      responsible_contact_id: contract.responsible_contact_id || '',
    })
    setCounterpartySearch(contract.counterparties?.name || '')
    setShowModal(true)
  }

  // Task 183: soft delete (любой пользователь) — переносит в «Удалённые»
  const handleSoftDeleteContract = async (id, contractNumber) => {
    if (!window.confirm(`Перенести договор «${contractNumber}» в «Удалённые»?`)) return
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      await logContractEvent(id, 'soft_deleted', { description: `Договор № ${contractNumber} перенесён в «Удалённые»` })
      fetchContracts()
    } catch (error) {
      console.error('Ошибка удаления договора:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // Task 183: восстановить из «Удалённых»
  const handleRestoreContract = async (id, contractNumber) => {
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      await logContractEvent(id, 'restored', { description: `Договор № ${contractNumber} восстановлен из «Удалённых»` })
      fetchContracts()
    } catch (error) {
      console.error('Ошибка восстановления договора:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  // Task 183: безвозвратное удаление — только для администратора, из вкладки «Удалённые»
  const handleHardDeleteContract = async (id, contractNumber) => {
    if (!isAdmin) {
      alert('Безвозвратное удаление доступно только администратору.')
      return
    }
    if (!window.confirm(`Безвозвратно удалить договор «${contractNumber}»? Это действие нельзя отменить.`)) return
    try {
      const { error } = await supabase.from('contracts').delete().eq('id', id)
      if (error) throw error
      fetchContracts()
    } catch (error) {
      console.error('Ошибка безвозвратного удаления:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  const computeNextContractNumber = async () => {
    try {
      const { data, error } = await supabase.from('contracts').select('contract_number')
      if (error) throw error
      const max = (data || []).reduce((acc, row) => {
        const n = parseInt(String(row.contract_number || '').trim(), 10)
        return Number.isInteger(n) && n > acc ? n : acc
      }, 0)
      return String(max + 1)
    } catch (err) {
      console.error('Не удалось подобрать следующий номер договора:', err.message)
      return ''
    }
  }

  const handleAddNew = async () => {
    setEditingContract(null)
    const nextNumber = await computeNextContractNumber()
    const status = activeTab === 'deleted' ? 'new_request' : activeTab
    setFormData({ ...EMPTY_FORM, contract_number: nextNumber, status })
    setCounterpartySearch('')
    setShowModal(true)
  }

  const handleStatusChange = async (contractId, newStatus) => {
    const contract = contracts.find(c => c.id === contractId)
    const oldStatus = contract?.status
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ status: newStatus })
        .eq('id', contractId)
      if (error) throw error
      await logContractEvent(contractId, 'status_changed', {
        fieldName: 'status',
        oldValue: oldStatus,
        newValue: newStatus,
        description: `Статус изменён: ${STATUS_LABEL[oldStatus] || oldStatus} → ${STATUS_LABEL[newStatus] || newStatus}`,
      })
      fetchContracts()
    } catch (error) {
      console.error('Ошибка изменения статуса:', error.message)
      alert('Ошибка изменения статуса: ' + error.message)
    }
  }

  // Задача 391: инлайн-правка поля договора прямо в таблице (юрист, даты, примечание).
  const INLINE_FIELD_LABEL = {
    responsible_contact_id: 'Ответственный юрист',
    accepted_date: 'Дата принятия в работу ДП',
    signed_date: 'Дата подписания',
    notes: 'Примечание',
  }
  const handleInlineField = async (contractId, field, rawValue) => {
    const value = rawValue === '' ? null : rawValue
    const contract = contracts.find(c => c.id === contractId)
    if (!contract || (contract[field] ?? null) === value) return
    try {
      const { error } = await supabase.from('contracts').update({ [field]: value }).eq('id', contractId)
      if (error) throw error
      setContracts(prev => prev.map(c => c.id === contractId ? { ...c, [field]: value } : c))
      await logContractEvent(contractId, 'field_updated', {
        fieldName: field,
        oldValue: contract[field] ?? null,
        newValue: value,
        description: `Изменено: ${INLINE_FIELD_LABEL[field] || field}`,
      })
    } catch (error) {
      console.error('Ошибка сохранения:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleSelectDepartment = (dept) => {
    setDepartment(dept)
    setActiveTab('new_request')
    setContracts([])
  }

  const handleBackToDepartments = () => {
    setDepartment(null)
    setContracts([])
    setObjects([])
  }

  // Управление приложениями
  const handleOpenAttachmentsModal = () => {
    setShowAttachmentsModal(true)
    if (!attachmentsObjectId && objects.length > 0) {
      setAttachmentsObjectId(objects[0].id)
      fetchObjectAttachments(objects[0].id)
    } else if (attachmentsObjectId) {
      fetchObjectAttachments(attachmentsObjectId)
    }
  }

  const handleAttachmentsObjectChange = (e) => {
    const id = e.target.value
    setAttachmentsObjectId(id)
    fetchObjectAttachments(id)
  }

  // Экран выбора отдела
  if (!department) {
    return (
      <div className="contract-registry">
        <div className="registry-header">
          <h2>Договоры</h2>
        </div>
        <div className="department-selection">
          <p className="selection-label">Выберите отдел:</p>
          <div className="department-cards">
            <button className="department-card" onClick={() => handleSelectDepartment('construction')}>
              <span className="department-icon">🏗️</span>
              <span className="department-name">Основное строительство</span>
            </button>
            <button className="department-card" onClick={() => handleSelectDepartment('warranty')}>
              <span className="department-icon">🛡️</span>
              <span className="department-name">Гарантийный отдел</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  const departmentLabel = department === 'construction' ? 'Основное строительство' : 'Гарантийный отдел'
  const isDeletedTab = activeTab === 'deleted'

  return (
    <div className="contract-registry contracts-page-v2">
      <div className="registry-header">
        <div className="header-left">
          <button className="btn-back" onClick={handleBackToDepartments} title="Назад к выбору отдела">←</button>
          <h2>Договоры — {departmentLabel}</h2>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={handleOpenAttachmentsModal}
            className="btn-secondary"
            style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
            title="Стандартные приложения для каждого объекта"
          >
            📎 Приложения объектов
          </button>
          {!isDeletedTab && canEditContracts && (
            <button className="btn-primary" onClick={handleAddNew}>
              + Добавить договор
            </button>
          )}
        </div>
      </div>

      {/* Вкладки (task 183 + 190) */}
      <div className="status-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`status-tab ${activeTab === tab.key ? 'active' : ''} ${tab.key === 'deleted' ? 'tab-deleted' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Панель фильтров реестра */}
      <div className="registry-filters">
        <div className="rf-field">
          <label className="rf-label">Объект</label>
          <select
            className="rf-select"
            value={filterObjectId}
            onChange={(e) => setFilterObjectId(e.target.value)}
          >
            <option value="">Все объекты</option>
            {objectFilterOptions.map(o => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>
        <div className="rf-field">
          <label className="rf-label">Ответственный юрист</label>
          <select
            className="rf-select"
            value={filterLawyerId}
            onChange={(e) => setFilterLawyerId(e.target.value)}
          >
            <option value="">Все юристы</option>
            {lawyerFilterOptions.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div className="rf-field rf-field-search">
          <label className="rf-label">Поиск</label>
          <input
            type="text"
            className="rf-search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Поиск по контрагенту, работам, № договора, примечанию"
          />
        </div>
        <div className="rf-quick">
          <button
            className={`qfilter ${onlyMine ? 'active' : ''}`}
            onClick={() => setOnlyMine(v => !v)}
            title="Договоры, где ответственный — вы"
          >Мои</button>
          <button
            className={`qfilter ${onlyOverdue ? 'active' : ''}`}
            onClick={() => setOnlyOverdue(v => !v)}
            title="Просроченная плановая дата подписания"
          >Просрочено</button>
          <button
            className={`qfilter ${onlyNoDate ? 'active' : ''}`}
            onClick={() => setOnlyNoDate(v => !v)}
            title="Без плановой даты подписания"
          >Без даты</button>
          <button
            className="qfilter qfilter-reset"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            title="Сбросить фильтры"
          >Сбросить</button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
      <div className="table-container">
        <table className="contracts-table contracts-table-compact">
          <thead>
            <tr>
              <th style={{ width: '32px' }} aria-label="Раскрыть"></th>
              <th style={{ width: '40px' }}>№</th>
              {sortableTh('object', 'Объект', { minWidth: '150px' })}
              <th style={{ minWidth: '140px' }}>Договор / № ДС</th>
              {sortableTh('counterparty', 'Контрагент', { minWidth: '160px' })}
              <th>Выполняемые работы</th>
              {sortableTh('amount', 'Сумма', { width: '120px' })}
              {sortableTh('status', 'Текущий статус', { width: '150px' })}
              <th style={{ width: '150px' }}>Ответственный юрист</th>
              {sortableTh('accepted', 'Дата принятия в работу', { width: '120px' })}
              {sortableTh('planned', 'План. дата подписания', { width: '120px' })}
              <th style={{ minWidth: '140px' }}>Примечание</th>
              <th className="actions-column" style={{ width: '90px' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedContracts.length === 0 ? (
              <tr>
                <td colSpan="13" className="no-data">
                  {hasActiveFilters
                    ? 'Нет договоров под выбранные фильтры.'
                    : isDeletedTab
                      ? 'Нет удалённых договоров.'
                      : `Нет договоров со статусом «${STATUS_LABEL[activeTab] || activeTab}».`}
                </td>
              </tr>
            ) : (
              filteredSortedContracts.map((contract, index) => {
                const items = contractAttachmentsMap[contract.id] || []
                const isExpanded = expandedContractId === contract.id
                const toggleExpand = () => setExpandedContractId(isExpanded ? null : contract.id)
                const overdue = !isDeletedTab && isOverdue(contract)
                const dsNum = contract.contract_number
                const dsDate = formatDateRu(contract.contract_date)
                return (
                <Fragment key={contract.id}>
                <tr
                  className={`contract-row ${isDeletedTab ? 'row-deleted' : ''} ${isExpanded ? 'is-expanded' : ''} ${previewContractId === contract.id ? 'row-preview-active' : ''}`}
                  onClick={toggleExpand}
                >
                  <td className="cell-expand" onClick={(e) => { e.stopPropagation(); toggleExpand() }}>
                    <span className={`expand-chev ${isExpanded ? 'open' : ''}`} aria-hidden>▸</span>
                    {items.length > 0 && <span className="expand-badge">{items.length}</span>}
                  </td>
                  <td className="cell-num">{index + 1}</td>
                  <td className="cell-object">{contract.objects?.name || '—'}</td>
                  <td className="cell-contract-num" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`contract-ds-link ${previewContractId === contract.id ? 'is-active' : ''}`}
                      onClick={(e) => openPreview(e, contract.id)}
                      title="Показать мини-карточку договора"
                    >
                      {(dsNum || dsDate) ? (
                        <>
                          <span className="cds-main">{dsNum ? `№ ${dsNum}` : 'Договор'}</span>
                          {dsDate && <span className="cds-sub">от {dsDate}</span>}
                        </>
                      ) : (
                        <span className="cds-main">Открыть договор</span>
                      )}
                    </button>
                  </td>
                  <td className="cell-counterparty">{contract.counterparties?.name || '—'}</td>
                  <td className="cell-work">{contract.work_name || contract.tenders?.work_description || '—'}</td>
                  <td className="cell-amount">{formatMoney(contract.contract_amount, contract.currency) || '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {isDeletedTab ? (
                      <span className="status-badge status-deleted">Удалён</span>
                    ) : (
                      <select
                        className={`status-select ${STATUS_OPTIONS.find(o => o.value === contract.status)?.className || ''}`}
                        value={contract.status || 'new_request'}
                        onChange={(e) => handleStatusChange(contract.id, e.target.value)}
                        disabled={!canEditContracts}
                      >
                        {STATUS_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="inline-cell-select"
                      value={contract.responsible_contact_id || ''}
                      onChange={(e) => handleInlineField(contract.id, 'responsible_contact_id', e.target.value)}
                      disabled={!canEditContracts || isDeletedTab}
                    >
                      <option value="">—</option>
                      {contacts.map(c => (
                        <option key={c.id} value={c.id}>{c.full_name}</option>
                      ))}
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="date"
                      className="inline-cell-date"
                      value={contract.accepted_date || ''}
                      onChange={(e) => handleInlineField(contract.id, 'accepted_date', e.target.value)}
                      disabled={!canEditContracts || isDeletedTab}
                    />
                  </td>
                  <td className={`date-cell ${overdue ? 'date-overdue' : ''}`} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="date"
                      className="inline-cell-date"
                      value={contract.signed_date || ''}
                      onChange={(e) => handleInlineField(contract.id, 'signed_date', e.target.value)}
                      disabled={!canEditContracts || isDeletedTab}
                    />
                    {overdue && <span className="overdue-warn" title="Просрочено">⚠</span>}
                  </td>
                  <td className="cell-note" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      className="inline-cell-notes"
                      defaultValue={contract.notes || ''}
                      placeholder="Примечание…"
                      rows={1}
                      onBlur={(e) => handleInlineField(contract.id, 'notes', e.target.value.trim())}
                      disabled={!canEditContracts || isDeletedTab}
                    />
                  </td>
                  <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                    {isDeletedTab ? (
                      <>
                        {canEditContracts && (
                          <button
                            className="btn-icon btn-restore"
                            onClick={() => handleRestoreContract(contract.id, contract.contract_number)}
                            title="Восстановить"
                          >↩</button>
                        )}
                        {isAdmin && (
                          <button
                            className="btn-icon btn-delete"
                            onClick={() => handleHardDeleteContract(contract.id, contract.contract_number)}
                            title="Удалить безвозвратно (админ)"
                          >🗑️</button>
                        )}
                      </>
                    ) : canEditContracts ? (
                      <>
                        <button
                          className="btn-icon btn-edit"
                          onClick={() => handleEditContract(contract)}
                          title="Редактировать"
                        >✏️</button>
                        <button
                          className="btn-icon btn-delete"
                          onClick={() => handleSoftDeleteContract(contract.id, contract.contract_number)}
                          title="В корзину"
                        >🗑️</button>
                      </>
                    ) : null}
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="contract-attachments-row" onClick={(e) => e.stopPropagation()}>
                    <td colSpan="13">
                      <div className="contract-attachments-panel">
                        <div className="cap-header">
                          <span className="cap-title">📎 Приложения к договору № {contract.contract_number}</span>
                          <span className="cap-count">{items.length === 0 ? 'нет приложений' : `${items.length} шт.`}</span>
                        </div>
                        {items.length === 0 ? (
                          <div className="cap-empty">
                            Для договора не выбрано ни одного приложения. Откройте редактирование и отметьте нужные.
                          </div>
                        ) : (
                          <ul className="cap-list">
                            {items.map(a => (
                              <li key={a.ca_id} className="cap-item">
                                <div className="cap-item-head">
                                  <span className="cap-item-name">
                                    {a.link
                                      ? <a href={a.link} target="_blank" rel="noopener noreferrer">{a.name}</a>
                                      : a.name}
                                  </span>
                                  {a.description && <span className="cap-item-desc">{a.description}</span>}
                                </div>
                                <textarea
                                  className="cap-item-comment"
                                  defaultValue={a.comment || ''}
                                  placeholder="Комментарий к этому приложению (необязательно)…"
                                  rows={1}
                                  onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                                  onBlur={(e) => {
                                    const v = e.target.value
                                    if ((a.comment || '') !== v) handleSaveAttachmentComment(a.ca_id, v)
                                  }}
                                  ref={(el) => { if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      )}

      {/* Мини-карточка договора (popover над таблицей) */}
      {previewContract && previewAnchorEl && (
        <ContractPreviewCard
          contract={previewContract}
          anchorEl={previewAnchorEl}
          counterpartyName={previewContract.counterparties?.name}
          objectName={previewContract.objects?.name}
          lawyerName={contactNameById[previewContract.responsible_contact_id] || previewContract.responsible?.full_name}
          statusLabel={STATUS_LABEL[previewContract.status] || previewContract.status}
          statusClassName={`status-${previewContract.status}`}
          isOverdue={!isDeletedTab && isOverdue(previewContract)}
          onClose={closePreview}
          onOpenCard={() => navigate(`/contracts/${previewContract.id}`)}
          onEdit={() => { handleEditContract(previewContract); closePreview() }}
        />
      )}

      {/* Модалка добавления/редактирования договора */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingContract ? 'Редактировать договор' : 'Добавить новый договор'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowModal(false); setEditingContract(null) }}
              >×</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group">
                  <label>№ договора *</label>
                  <input type="text" name="contract_number" value={formData.contract_number} onChange={handleInputChange} required />
                </div>

                <div className="form-group">
                  <label>Дата договора *</label>
                  <input type="date" name="contract_date" value={formData.contract_date} onChange={handleInputChange} required />
                </div>

                <div className="form-group full-width">
                  <label>Наименование контрагента *</label>
                  <div className="cp-search-wrap">
                    <input
                      type="text"
                      className="cp-search-input"
                      placeholder="Начните вводить название или ИНН..."
                      value={counterpartyDropdownOpen ? counterpartySearch : (selectedCounterparty?.name || counterpartySearch)}
                      onChange={(e) => { setCounterpartySearch(e.target.value); setCounterpartyDropdownOpen(true) }}
                      onFocus={() => setCounterpartyDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setCounterpartyDropdownOpen(false), 150)}
                      required={!formData.counterparty_id}
                    />
                    {counterpartyDropdownOpen && (
                      <div className="cp-search-dropdown">
                        {filteredCounterparties.length === 0 ? (
                          <div className="cp-search-empty">Ничего не найдено</div>
                        ) : (
                          filteredCounterparties.slice(0, 50).map(cp => (
                            <button
                              type="button"
                              key={cp.id}
                              className={`cp-search-item ${cp.id === formData.counterparty_id ? 'active' : ''}`}
                              onMouseDown={() => handleSelectCounterparty(cp.id, cp.name)}
                            >
                              <div className="cp-search-name">{cp.name}</div>
                              {cp.inn && <div className="cp-search-inn">ИНН: {cp.inn}</div>}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="form-group full-width">
                  <label>Объект работ *</label>
                  <select name="object_id" value={formData.object_id} onChange={handleInputChange} required>
                    <option value="">Выберите объект</option>
                    {objects.map(obj => (
                      <option key={obj.id} value={obj.id}>{obj.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Тендер (необязательно)</label>
                  <select
                    name="tender_id"
                    value={formData.tender_id}
                    onChange={handleTenderChange}
                    disabled={!formData.object_id && availableTenders.length === 0}
                  >
                    <option value="">— Без привязки —</option>
                    {availableTenders.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.work_description || `Тендер ${t.id.slice(0, 8)}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Наименование работ</label>
                  <textarea
                    name="work_name"
                    rows="2"
                    value={formData.work_name}
                    onChange={handleInputChange}
                    placeholder={formData.tender_id ? 'Подтянуто из тендера, можно отредактировать' : 'Введите наименование работ'}
                  />
                </div>

                <div className="form-group full-width">
                  <label>Ответственный юрист</label>
                  <select name="responsible_contact_id" value={formData.responsible_contact_id} onChange={handleInputChange}>
                    <option value="">— Не назначен —</option>
                    {availableContacts.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.full_name}{c.position ? ` (${c.position})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Сумма по договору</label>
                  <input type="number" step="0.01" name="contract_amount" value={formData.contract_amount} onChange={handleInputChange} placeholder="Подтянется из ПСДЦ" />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                    После импорта ПСДЦ пересчитывается из строк; можно поправить вручную.
                  </small>
                </div>
                <div className="form-group">
                  <label>Валюта</label>
                  <select name="currency" value={formData.currency} onChange={handleInputChange}>
                    {CURRENCY_OPTIONS.map(c => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Ставка НДС (%)</label>
                  <select name="vat_rate" value={formData.vat_rate} onChange={handleInputChange}>
                    {VAT_RATE_OPTIONS.map(v => (
                      <option key={v || 'none'} value={v}>{v === '' ? '— не указана —' : `${v}%`}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Хранение суммы</label>
                  <select
                    name="amount_includes_vat"
                    value={formData.amount_includes_vat ? 'with' : 'without'}
                    onChange={(e) => setFormData(prev => ({ ...prev, amount_includes_vat: e.target.value === 'with' }))}
                  >
                    <option value="with">С НДС</option>
                    <option value="without">Без НДС</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Гарантийное удержание (%)</label>
                  <input type="number" step="0.01" name="warranty_retention_percent" value={formData.warranty_retention_percent} onChange={handleInputChange} />
                </div>
                <div className="form-group">
                  <label>Срок гарантийных удержаний</label>
                  <input type="text" name="warranty_retention_period" value={formData.warranty_retention_period} onChange={handleInputChange} placeholder="Например: 12 месяцев" />
                </div>

                <div className="form-group">
                  <label>Начало работ</label>
                  <input type="date" name="work_start_date" value={formData.work_start_date} onChange={handleInputChange} />
                </div>
                <div className="form-group">
                  <label>Окончание работ</label>
                  <input type="date" name="work_end_date" value={formData.work_end_date} onChange={handleInputChange} />
                </div>

                <div className="form-group">
                  <label>Дата принятия в работу ДП</label>
                  <input type="date" name="accepted_date" value={formData.accepted_date} onChange={handleInputChange} />
                </div>
                <div className="form-group">
                  <label>Дата подписания</label>
                  <input type="date" name="signed_date" value={formData.signed_date} onChange={handleInputChange} />
                </div>

                <div className="form-group full-width">
                  <label>Срок гарантии на работы</label>
                  <input type="text" name="warranty_period" value={formData.warranty_period} onChange={handleInputChange} placeholder="Например: 24 месяца" />
                </div>

                <div className="form-group full-width">
                  <label>Ссылка на документ (Google Drive)</label>
                  <input type="url" name="document_link" value={formData.document_link} onChange={handleInputChange} placeholder="https://docs.google.com/document/d/..." />
                </div>

                {/* Task 188: приложения в виде выпадающего списка с чекбоксами */}
                {availableAttachments.length > 0 && (
                  <div className="form-group full-width">
                    <label>Приложения к договору</label>
                    <div className="attachments-multiselect">
                      <button
                        type="button"
                        className="attachments-multiselect-trigger"
                        onClick={() => setAttachmentsDropdownOpenForm(o => !o)}
                      >
                        <span>
                          {formAttachments.size === 0
                            ? 'Не выбрано'
                            : `Выбрано: ${formAttachments.size} из ${availableAttachments.length}`}
                        </span>
                        <span className="caret">{attachmentsDropdownOpenForm ? '▴' : '▾'}</span>
                      </button>
                      {attachmentsDropdownOpenForm && (
                        <div className="attachments-multiselect-menu">
                          <div className="multiselect-actions">
                            <button type="button" onClick={() => setFormAttachments(new Set(availableAttachments.map(a => a.id)))}>Все</button>
                            <button type="button" onClick={() => setFormAttachments(new Set())}>Очистить</button>
                          </div>
                          {availableAttachments.map(a => (
                            <label key={a.id} className="multiselect-row">
                              <input
                                type="checkbox"
                                checked={formAttachments.has(a.id)}
                                onChange={() => {
                                  const next = new Set(formAttachments)
                                  if (next.has(a.id)) next.delete(a.id); else next.add(a.id)
                                  setFormAttachments(next)
                                }}
                              />
                              <span className="ms-name">
                                {a.name}
                                {a.description && <span className="ms-desc"> — {a.description}</span>}
                              </span>
                              {a.link && (
                                <a href={a.link} target="_blank" rel="noopener noreferrer" className="attachment-link"
                                  onClick={(e) => e.stopPropagation()}>(ссылка)</a>
                              )}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => { setShowModal(false); setEditingContract(null) }}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingContract ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модалка управления приложениями объектов (task 184 — без шаблонов) */}
      {showAttachmentsModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '720px' }}>
            <div className="modal-header">
              <h3>Стандартные приложения объекта</h3>
              <button className="modal-close" onClick={() => setShowAttachmentsModal(false)}>×</button>
            </div>
            <div style={{ padding: '1.5rem 2rem' }}>
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>Объект</label>
                <select value={attachmentsObjectId} onChange={handleAttachmentsObjectChange}>
                  <option value="">Выберите объект</option>
                  {objects.map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>

              {attachmentsObjectId && (
                <section>
                  <div className="attachments-list">
                    {objectAttachments.length === 0 ? (
                      <div style={{ color: 'var(--text-tertiary)', fontStyle: 'italic', padding: '0.5rem 0' }}>
                        Приложений пока нет. Добавьте первое ниже.
                      </div>
                    ) : (
                      objectAttachments.map(a => (
                        <div key={a.id} className="attachment-list-row">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500 }}>{a.name}</div>
                            {a.description && (
                              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.1875rem' }}>
                                {a.description}
                              </div>
                            )}
                            {a.link && (
                              <a href={a.link} target="_blank" rel="noopener noreferrer"
                                style={{ color: 'var(--primary-color)', fontSize: '0.8125rem', wordBreak: 'break-all', display: 'block', marginTop: '0.1875rem' }}>
                                {a.link}
                              </a>
                            )}
                          </div>
                          {canEditContracts && (
                            <button type="button" className="btn-icon btn-delete"
                              onClick={() => handleDeleteAttachment(a.id)}
                              title="Удалить">🗑️</button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {canEditContracts && (
                  <div className="attachment-add-row">
                    <input
                      type="text"
                      placeholder="Название приложения"
                      value={newAttachmentName}
                      onChange={(e) => setNewAttachmentName(e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="Описание (краткая сводка)"
                      value={newAttachmentDescription}
                      onChange={(e) => setNewAttachmentDescription(e.target.value)}
                    />
                    <input
                      type="url"
                      placeholder="Ссылка (необязательно)"
                      value={newAttachmentLink}
                      onChange={(e) => setNewAttachmentLink(e.target.value)}
                    />
                    <button type="button" className="btn-primary" onClick={handleAddAttachment}
                      disabled={!newAttachmentName.trim()}>
                      Добавить
                    </button>
                  </div>
                  )}
                </section>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setShowAttachmentsModal(false)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ContractRegistry
