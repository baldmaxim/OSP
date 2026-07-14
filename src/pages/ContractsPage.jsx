import { Fragment, useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { CURRENCY_OPTIONS, formatMoney } from '../utils/estimateImport'
import FilterDropdown from '../components/FilterDropdown'
import AutoGrowTextarea from '../components/AutoGrowTextarea'
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

// Вкладки: «Общий реестр» = все не удалённые (любой статус, включая «Новая заявка»);
// далее фильтры по статусу; «Удалённые» — soft-delete (deleted_at IS NOT NULL).
const TABS = [
  { key: 'all', label: 'Общий реестр' },
  { key: 'in_work', label: 'В работе' },
  { key: 'paused', label: 'Приостановка' },
  { key: 'completed', label: 'Завершено' },
  { key: 'deleted', label: 'Удаленные' },
]

const EMPTY_FORM = {
  contract_number: '',
  contract_date: '',
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
  notes: '',
}

// ДД.ММ.ГГГГ из ISO-даты (или null, если пусто/некорректно)
function formatDateRu(iso) {
  if (!iso) return null
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  if (!y || !m || !d) return null
  return `${d}.${m}.${y}`
}

// Читаемое обозначение договора для сообщений и истории (номера может не быть).
function contractLabel(contractNumber) {
  return contractNumber ? `№ ${contractNumber}` : 'без номера'
}

// Все стороны договора (может быть несколько — трёхсторонний договор), по порядку.
// Старые договоры без строк в contract_counterparties → fallback на основного контрагента.
function contractParties(contract) {
  const rows = contract?.contract_counterparties || []
  if (rows.length > 0) {
    return [...rows]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map(r => r.counterparties)
      .filter(Boolean)
  }
  return contract?.counterparties ? [contract.counterparties] : []
}

// Нормализация ФИО для дедупликации: trim + сжать пробелы (сравнение — без регистра).
function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ')
}

// Краткое ФИО для таблицы: «Фамилия И.О.» (одна строка). Полное ФИО — в title/dropdown.
// Только визуальное отображение; в payload/БД уходит исходный id, а не эта строка.
function formatPersonShortName(fullName) {
  const normalized = String(fullName || '').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized === '—') return '—'
  const parts = normalized.split(' ')
  // Уже сокращённый формат («Иванов И.И.», «Егорова О.Ю.», «Россолов И.») — как есть.
  if (parts.length <= 2 && /[А-ЯЁA-Za-z]\./.test(normalized)) return normalized
  const [lastName, firstName, middleName] = parts
  const initial = (p) => (p ? p.charAt(0).toUpperCase() + '.' : '')
  if (parts.length >= 3) return `${lastName} ${initial(firstName)}${initial(middleName)}`
  if (parts.length === 2) return `${lastName} ${initial(firstName)}`
  return normalized
}

// Склонение «договор/договора/договоров» для счётчика пагинации.
function pluralContracts(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'договор'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'договора'
  return 'договоров'
}

// Нейтральные SVG-иконки действий (currentColor, единый размер 16×16).
const actionIconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 16, height: 16, 'aria-hidden': true,
}
const EditIcon = () => (
  <svg {...actionIconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const TrashIcon = () => (
  <svg {...actionIconProps}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
)
const RestoreIcon = () => (
  <svg {...actionIconProps}>
    <path d="M3 7v6h6" />
    <path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" />
  </svg>
)

function ContractRegistry() {
  const navigate = useNavigate()
  const { isAdmin, userProfile, canEdit } = useRole()
  // task 333: гейт add/edit/delete для раздела «contracts»
  const canEditContracts = canEdit('contracts')

  const [department, setDepartment] = useState(null) // null | 'construction' | 'warranty'
  const [activeTab, setActiveTab] = useState('all')

  const [contracts, setContracts] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingContract, setEditingContract] = useState(null)

  // Task 168: поиск контрагента. Договор может быть многосторонним (трёхсторонний):
  // formCounterpartyIds — упорядоченный список сторон, первый = основной (contracts.counterparty_id).
  const [counterpartySearch, setCounterpartySearch] = useState('')
  const [counterpartyDropdownOpen, setCounterpartyDropdownOpen] = useState(false)
  const [formCounterpartyIds, setFormCounterpartyIds] = useState([])

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
  // Задача 419: сопутствующие приложения договора (ручные): id → массив строк
  const [contractAppendicesMap, setContractAppendicesMap] = useState({})

  // Task 188: dropdown состояние для приложений в форме
  const [attachmentsDropdownOpenForm, setAttachmentsDropdownOpenForm] = useState(false)
  // Task 193/417: раскрытая строка договора (примечание юриста + сопутствующие приложения)
  const [expandedContractId, setExpandedContractId] = useState(null)
  const [noteSavingId, setNoteSavingId] = useState(null)

  const [formData, setFormData] = useState(EMPTY_FORM)

  // Панель фильтров реестра (over-table, in-memory)
  const [filterObjectId, setFilterObjectId] = useState('')
  const [filterLawyerId, setFilterLawyerId] = useState('')
  const [searchText, setSearchText] = useState('')
  const [onlyOverdue, setOnlyOverdue] = useState(false)

  // Сортировка по клику на заголовок (default — по имени объекта, как раньше)
  const [sortKey, setSortKey] = useState('object')
  const [sortDir, setSortDir] = useState('asc')

  // Пагинация реестра
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

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
        .select('*, objects(name, status), counterparties(id, name, inn), contract_counterparties(counterparty_id, sort_order, counterparties(id, name, inn)), tenders(work_description), responsible:contacts!responsible_contact_id(id, full_name, position)')

      if (activeTab === 'deleted') {
        query = query.not('deleted_at', 'is', null)
      } else if (activeTab === 'all') {
        // Общий реестр — все не удалённые, любой статус.
        query = query.is('deleted_at', null)
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

        // Задача 419: сопутствующие приложения договора (ручные строки)
        const { data: apRows, error: apErr } = await supabase
          .from('contract_appendices')
          .select('*')
          .in('contract_id', ids)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true })
        if (apErr) throw apErr
        const apMap = {}
        for (const r of apRows || []) {
          if (!apMap[r.contract_id]) apMap[r.contract_id] = []
          apMap[r.contract_id].push(r)
        }
        setContractAppendicesMap(apMap)
      } else {
        setContractAttachmentsMap({})
        setContractAppendicesMap({})
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

  // ── Задача 419: сопутствующие приложения договора (ручные строки) ──────────
  const nextAppendixNumber = (list) => {
    const nums = (list || [])
      .map(a => parseInt(a.appendix_number, 10))
      .filter(n => Number.isFinite(n))
    return String(nums.length ? Math.max(...nums) + 1 : 1)
  }

  const handleAddAppendix = async (contractId) => {
    const list = contractAppendicesMap[contractId] || []
    const number = nextAppendixNumber(list)
    try {
      const { data, error } = await supabase
        .from('contract_appendices')
        .insert([{ contract_id: contractId, appendix_number: number, name: '', responsible: '', status: '', sort_order: list.length }])
        .select('*')
        .single()
      if (error) throw error
      setContractAppendicesMap(prev => ({ ...prev, [contractId]: [...(prev[contractId] || []), data] }))
    } catch (err) {
      console.error('Ошибка добавления приложения:', err.message)
      alert('Не удалось добавить приложение: ' + err.message)
    }
  }

  const handleUpdateAppendix = async (contractId, appendixId, field, rawValue) => {
    const value = (rawValue ?? '').toString()
    const ap = (contractAppendicesMap[contractId] || []).find(a => a.id === appendixId)
    if (!ap || (ap[field] || '') === value) return
    // Оптимистично обновляем локально
    setContractAppendicesMap(prev => ({
      ...prev,
      [contractId]: (prev[contractId] || []).map(a => a.id === appendixId ? { ...a, [field]: value } : a),
    }))
    try {
      const { error } = await supabase
        .from('contract_appendices')
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('id', appendixId)
      if (error) throw error
    } catch (err) {
      console.error('Ошибка сохранения приложения:', err.message)
      alert('Ошибка сохранения приложения: ' + err.message)
    }
  }

  const handleDeleteAppendix = async (contractId, appendixId) => {
    if (!window.confirm('Удалить это приложение?')) return
    try {
      const { error } = await supabase.from('contract_appendices').delete().eq('id', appendixId)
      if (error) throw error
      setContractAppendicesMap(prev => ({
        ...prev,
        [contractId]: (prev[contractId] || []).filter(a => a.id !== appendixId),
      }))
    } catch (err) {
      console.error('Ошибка удаления приложения:', err.message)
      alert('Не удалось удалить приложение: ' + err.message)
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
    const t = tenderId ? tenders.find(x => x.id === tenderId) : null
    setFormData(prev => {
      const next = { ...prev, tender_id: tenderId }
      if (t) {
        if (t.work_description && !prev.work_name) next.work_name = t.work_description
        if (t.object_id && !prev.object_id) next.object_id = t.object_id
      }
      return next
    })
    // Победитель тендера подставляется основной стороной — только если стороны ещё не выбраны.
    if (t?.winner_counterparty_id) {
      setFormCounterpartyIds(prev => prev.length === 0 ? [t.winner_counterparty_id] : prev)
    }
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

  // Выбранные стороны договора в порядке добавления (первая — основная).
  const selectedParties = useMemo(() => {
    return formCounterpartyIds
      .map(id => counterparties.find(cp => cp.id === id))
      .filter(Boolean)
  }, [counterparties, formCounterpartyIds])

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

  // Нормализованное (lowercase) ФИО по id сотрудника — для дедупа и фильтрации по имени.
  const normNameById = useMemo(() => {
    const m = {}
    contacts.forEach(c => { m[c.id] = normalizeName(c.full_name).toLowerCase() })
    return m
  }, [contacts])

  // Дедуплицированный список сотрудников (одно ФИО = одна запись, представитель — первый id).
  const dedupContacts = useMemo(() => {
    const byName = new Map()
    contacts.forEach(c => {
      const name = normalizeName(c.full_name)
      if (!name) return
      const key = name.toLowerCase()
      if (!byName.has(key)) byName.set(key, { id: c.id, name })
    })
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [contacts])

  // Любой id сотрудника → id представителя того же ФИО (чтобы выбранное значение
  // совпадало с опцией даже при дублях с разными id).
  const lawyerRepByContactId = useMemo(() => {
    const nameToRep = new Map(dedupContacts.map(c => [c.name.toLowerCase(), c.id]))
    const m = {}
    contacts.forEach(c => {
      const key = normalizeName(c.full_name).toLowerCase()
      m[c.id] = nameToRep.get(key) || c.id
    })
    return m
  }, [contacts, dedupContacts])

  // Опции фильтра «Объект» — из объектов текущего отдела
  const objectFilterOptions = useMemo(() =>
    [...objects].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru')),
  [objects])

  // Опции фильтра «Ответственный юрист» — реально назначенные в договорах, без дублей ФИО.
  const lawyerFilterOptions = useMemo(() => {
    const seen = new Map()
    contracts.forEach(c => {
      const id = c.responsible_contact_id
      if (!id) return
      const name = normalizeName(contactNameById[id] || c.responsible?.full_name || '')
      if (!name) return
      const key = name.toLowerCase()
      if (!seen.has(key)) seen.set(key, { id, name })
    })
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [contracts, contactNameById])

  // Опции для кастомных FilterDropdown (первая — «Все …»).
  const objectDropdownOptions = useMemo(
    () => [{ value: '', label: 'Все объекты' }, ...objectFilterOptions.map(o => ({ value: o.id, label: o.name }))],
    [objectFilterOptions])
  const lawyerDropdownOptions = useMemo(
    () => [{ value: '', label: 'Все юристы' }, ...lawyerFilterOptions.map(l => ({ value: l.id, label: l.name }))],
    [lawyerFilterOptions])

  // Опции для inline-выбора ответственного в строке таблицы (все сотрудники, без дублей ФИО).
  const contactDropdownOptions = useMemo(
    () => [{ value: '', label: '—' }, ...dedupContacts.map(c => ({ value: c.id, label: c.name }))],
    [dedupContacts])

  const filteredSortedContracts = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    const list = contracts.filter(c => {
      if (filterObjectId && c.object_id !== filterObjectId) return false
      if (filterLawyerId) {
        // Сопоставляем по нормализованному ФИО — чтобы фильтр по одному «представителю»
        // ловил все договоры с этим же юристом, даже если у него дублирующиеся id.
        const selName = normNameById[filterLawyerId]
        if (!selName || normNameById[c.responsible_contact_id] !== selName) return false
      }
      if (onlyOverdue && !isOverdue(c)) return false
      if (q) {
        const hay = [
          ...contractParties(c).map(p => p.name),
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
        case 'counterparty': return (contractParties(c)[0]?.name || '').toLowerCase()
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
  }, [contracts, filterObjectId, filterLawyerId, onlyOverdue, searchText, sortKey, sortDir, isOverdue, normNameById])

  const hasActiveFilters = !!(filterObjectId || filterLawyerId || searchText || onlyOverdue)

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const resetFilters = () => {
    setFilterObjectId(''); setFilterLawyerId(''); setSearchText('')
    setOnlyOverdue(false)
  }

  // Сохранение примечания юриста из раскрытого блока (по blur), с индикатором «Сохранение…».
  const handleSaveNote = async (contractId, rawValue) => {
    const contract = contracts.find(c => c.id === contractId)
    const next = (rawValue || '').trim()
    if (!contract || (contract.notes || '') === next) return
    setNoteSavingId(contractId)
    try {
      await handleInlineField(contractId, 'notes', next)
    } finally {
      setNoteSavingId(null)
    }
  }

  // Пагинация: считаем страницу от отфильтрованного/отсортированного списка.
  const totalCount = filteredSortedContracts.length
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * pageSize
  const pagedContracts = filteredSortedContracts.slice(pageStart, pageStart + pageSize)
  const rangeFrom = totalCount === 0 ? 0 : pageStart + 1
  const rangeTo = Math.min(pageStart + pageSize, totalCount)

  // При смене вкладки/фильтров/сортировки — на первую страницу и закрыть раскрытие.
  useEffect(() => {
    setPage(1)
    setExpandedContractId(null)
  }, [activeTab, filterObjectId, filterLawyerId, searchText, onlyOverdue, sortKey, sortDir, pageSize])

  // Закрываем раскрытие при перелистывании страниц.
  useEffect(() => {
    setExpandedContractId(null)
  }, [page])

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

  // Добавляет контрагента в список сторон (повторный клик — убирает). Поле поиска очищается,
  // список остаётся открытым, чтобы можно было сразу добавить следующую сторону.
  const handleSelectCounterparty = (id) => {
    setFormCounterpartyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
    setCounterpartySearch('')
  }

  const handleRemoveCounterparty = (id) => {
    setFormCounterpartyIds(prev => prev.filter(x => x !== id))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const payload = {
        ...formData,
        // Основной контрагент = первая сторона; остальные — в contract_counterparties.
        counterparty_id: formCounterpartyIds[0] || null,
        object_id: formData.object_id || null,
        tender_id: formData.tender_id || null,
        responsible_contact_id: formData.responsible_contact_id || null,
        // Пустые даты → NULL (иначе Postgres: invalid input syntax for type date: "").
        contract_date: formData.contract_date || null,
        work_start_date: formData.work_start_date || null,
        work_end_date: formData.work_end_date || null,
        accepted_date: formData.accepted_date || null,
        signed_date: formData.signed_date || null,
        warranty_retention_percent: formData.warranty_retention_percent === '' ? null : formData.warranty_retention_percent,
        // Сумма необязательна — считается из ПСДЦ; пустое поле = NULL.
        contract_amount: formData.contract_amount === '' ? null : formData.contract_amount,
        vat_rate: formData.vat_rate === '' ? null : formData.vat_rate,
        currency: formData.currency || 'RUB',
        amount_includes_vat: formData.amount_includes_vat !== false,
        // Номер необязателен. Пустая строка → NULL: в UNIQUE-индексе NULL не конфликтует
        // с NULL, а вот двух договоров с номером '' быть не может.
        contract_number: formData.contract_number.trim() || null,
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
        await logContractEvent(contractId, 'created', {
          description: payload.contract_number
            ? `Создан договор № ${payload.contract_number}`
            : 'Создан договор (без номера)',
        })
      }

      if (contractId) {
        await supabase.from('contract_attachments').delete().eq('contract_id', contractId)
        const rows = Array.from(formAttachments).map(attachment_id => ({ contract_id: contractId, attachment_id }))
        if (rows.length > 0) {
          const { error: caErr } = await supabase.from('contract_attachments').insert(rows)
          if (caErr) throw caErr
        }

        // Стороны договора: полностью перезаписываем (порядок = sort_order).
        await supabase.from('contract_counterparties').delete().eq('contract_id', contractId)
        const cpRows = formCounterpartyIds.map((counterparty_id, i) => ({
          contract_id: contractId,
          counterparty_id,
          sort_order: i,
        }))
        if (cpRows.length > 0) {
          const { error: ccErr } = await supabase.from('contract_counterparties').insert(cpRows)
          if (ccErr) throw ccErr
        }
      }

      setShowModal(false)
      setEditingContract(null)
      setFormData({ ...EMPTY_FORM, status: (activeTab === 'deleted' || activeTab === 'all') ? 'new_request' : activeTab })
      setFormCounterpartyIds([])
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
      notes: contract.notes || '',
    })
    setFormCounterpartyIds(contractParties(contract).map(p => p.id))
    setCounterpartySearch('')
    setShowModal(true)
  }

  // Task 183: soft delete (любой пользователь) — переносит в «Удалённые»
  const handleSoftDeleteContract = async (id, contractNumber) => {
    if (!window.confirm(`Перенести договор ${contractLabel(contractNumber)} в «Удалённые»?`)) return
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      await logContractEvent(id, 'soft_deleted', { description: `Договор ${contractLabel(contractNumber)} перенесён в «Удалённые»` })
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
      await logContractEvent(id, 'restored', { description: `Договор ${contractLabel(contractNumber)} восстановлен из «Удалённых»` })
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
    if (!window.confirm(`Безвозвратно удалить договор ${contractLabel(contractNumber)}? Это действие нельзя отменить.`)) return
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
    const status = (activeTab === 'deleted' || activeTab === 'all') ? 'new_request' : activeTab
    setFormData({ ...EMPTY_FORM, contract_number: nextNumber, status })
    setFormCounterpartyIds([])
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
    setActiveTab('all')
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
        <div className="rf-field rf-field-object">
          <label className="rf-label">Объект</label>
          <FilterDropdown
            label=""
            value={filterObjectId}
            onChange={setFilterObjectId}
            options={objectDropdownOptions}
            searchable
            searchPlaceholder="Поиск объекта…"
            allLabel="Все объекты"
          />
        </div>
        <div className="rf-field rf-field-lawyer">
          <label className="rf-label">Ответственный юрист</label>
          <FilterDropdown
            label=""
            value={filterLawyerId}
            onChange={setFilterLawyerId}
            options={lawyerDropdownOptions}
            searchable
            searchPlaceholder="Поиск юриста…"
            allLabel="Все юристы"
          />
        </div>
        <div className="rf-field rf-field-search">
          <label className="rf-label">Поиск</label>
          <input
            type="text"
            className="rf-search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Поиск по контрагенту, работам, № договора"
          />
        </div>
        <div className="rf-quick">
          <button
            className={`qfilter ${onlyOverdue ? 'active' : ''}`}
            onClick={() => setOnlyOverdue(v => !v)}
            title="Просроченная плановая дата подписания"
          >Просрочено</button>
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
          <colgroup>
            <col className="cg-num" />
            <col className="cg-object" />
            <col className="cg-ds" />
            <col className="cg-counterparty" />
            <col className="cg-work" />
            <col className="cg-amount" />
            <col className="cg-status" />
            <col className="cg-lawyer" />
            <col className="cg-accepted" />
            <col className="cg-planned" />
            <col className="cg-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>№</th>
              {sortableTh('object', 'Объект')}
              <th>Договор / № ДС</th>
              {sortableTh('counterparty', 'Контрагент')}
              <th>Выполняемые работы</th>
              {sortableTh('amount', 'Сумма')}
              {sortableTh('status', 'Текущий статус')}
              <th>Ответственный юрист</th>
              {sortableTh('accepted', <>Дата принятия<br />в работу</>)}
              {sortableTh('planned', <>План. дата<br />подписания</>)}
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedContracts.length === 0 ? (
              <tr>
                <td colSpan="11" className="no-data">
                  {hasActiveFilters
                    ? 'Нет договоров под выбранные фильтры.'
                    : isDeletedTab
                      ? 'Нет удалённых договоров.'
                      : activeTab === 'all'
                        ? 'Договоров пока нет.'
                        : `Нет договоров со статусом «${STATUS_LABEL[activeTab] || activeTab}».`}
                </td>
              </tr>
            ) : (
              pagedContracts.map((contract, index) => {
                const items = contractAttachmentsMap[contract.id] || []
                const appendices = contractAppendicesMap[contract.id] || []
                const isExpanded = expandedContractId === contract.id
                const toggleExpand = () => setExpandedContractId(isExpanded ? null : contract.id)
                const overdue = !isDeletedTab && isOverdue(contract)
                const dsNum = contract.contract_number
                const dsDate = formatDateRu(contract.contract_date)
                // Договор можно завести без номера/даты — подсвечиваем такие в реестре.
                const missingLabel = [!dsNum && 'номер', !dsDate && 'дата договора'].filter(Boolean).join(', ')
                const parties = contractParties(contract)
                return (
                <Fragment key={contract.id}>
                <tr
                  className={`contract-row ${isDeletedTab ? 'row-deleted' : ''} ${isExpanded ? 'is-expanded' : ''}`}
                  onClick={toggleExpand}
                  title="Нажмите, чтобы раскрыть договор"
                >
                  <td className="cell-num">
                    <span className={`expand-chev ${isExpanded ? 'open' : ''}`} aria-hidden>▸</span>
                    <span className="cell-num-value">{pageStart + index + 1}</span>
                    {items.length > 0 && <span className="expand-badge" title={`Приложений: ${items.length}`}>{items.length}</span>}
                  </td>
                  <td className="cell-object">{contract.objects?.name || '—'}</td>
                  <td
                    className={`cell-contract-num ${(!dsNum || !dsDate) && !isDeletedTab ? 'is-incomplete' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                    title={missingLabel ? `Не заполнено: ${missingLabel}` : undefined}
                  >
                    <button
                      className={`contract-ds-link ${isExpanded ? 'is-active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleExpand() }}
                      title={isExpanded ? 'Свернуть договор' : 'Раскрыть договор'}
                    >
                      {dsNum
                        ? <span className="cds-main">№ {dsNum}</span>
                        : <span className="cds-main cds-missing">№ не присвоен</span>}
                      {dsDate
                        ? <span className="cds-sub">от {dsDate}</span>
                        : <span className="cds-sub cds-missing">дата не указана</span>}
                    </button>
                  </td>
                  <td className="cell-counterparty">
                    {parties.length === 0 ? '—' : (
                      <ul className="cp-list">
                        {parties.map(p => <li key={p.id}>{p.name}</li>)}
                      </ul>
                    )}
                  </td>
                  <td className="cell-work" title={contract.work_name || contract.tenders?.work_description || ''}>{contract.work_name || contract.tenders?.work_description || '—'}</td>
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
                  <td className="cell-lawyer" onClick={(e) => e.stopPropagation()}>
                    <FilterDropdown
                      label=""
                      value={lawyerRepByContactId[contract.responsible_contact_id] || contract.responsible_contact_id || ''}
                      onChange={(v) => handleInlineField(contract.id, 'responsible_contact_id', v)}
                      options={contactDropdownOptions}
                      searchable
                      searchPlaceholder="Поиск сотрудника…"
                      allLabel="—"
                      formatTrigger={formatPersonShortName}
                      disabled={!canEditContracts || isDeletedTab}
                    />
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
                    {overdue && <span className="overdue-note">Просрочено</span>}
                  </td>
                  <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                    <div className="actions-inner">
                      {isDeletedTab ? (
                        <>
                          {canEditContracts && (
                            <button
                              className="btn-icon btn-restore"
                              onClick={() => handleRestoreContract(contract.id, contract.contract_number)}
                              title="Восстановить"
                              aria-label="Восстановить"
                            ><RestoreIcon /></button>
                          )}
                          {isAdmin && (
                            <button
                              className="btn-icon btn-delete"
                              onClick={() => handleHardDeleteContract(contract.id, contract.contract_number)}
                              title="Удалить безвозвратно (админ)"
                              aria-label="Удалить безвозвратно"
                            ><TrashIcon /></button>
                          )}
                        </>
                      ) : canEditContracts ? (
                        <>
                          <button
                            className="btn-icon btn-edit"
                            onClick={() => handleEditContract(contract)}
                            title="Редактировать"
                            aria-label="Редактировать"
                          ><EditIcon /></button>
                          <button
                            className="btn-icon btn-delete"
                            onClick={() => handleSoftDeleteContract(contract.id, contract.contract_number)}
                            title="Удалить"
                            aria-label="Удалить"
                          ><TrashIcon /></button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="contract-expanded-row" onClick={(e) => e.stopPropagation()}>
                    <td colSpan="11">
                      <div className="contract-expanded-content">
                        {/* Стороны договора (может быть несколько — трёхсторонний договор) */}
                        {parties.length > 1 && (
                          <section className="ce-block">
                            <div className="ce-block-title">Стороны договора</div>
                            <ul className="ce-parties">
                              {parties.map((p, i) => (
                                <li key={p.id}>
                                  <span className="ce-party-name">{p.name}</span>
                                  {p.inn && <span className="ce-party-inn">ИНН: {p.inn}</span>}
                                  {i === 0 && <span className="ce-party-main">основной</span>}
                                </li>
                              ))}
                            </ul>
                          </section>
                        )}

                        {/* Блок 1: Примечание юриста */}
                        <section className="ce-block">
                          <div className="ce-block-title">
                            Примечание юриста
                            {noteSavingId === contract.id && <span className="ce-saving">Сохранение…</span>}
                          </div>
                          {canEditContracts && !isDeletedTab ? (
                            <AutoGrowTextarea
                              className="ce-note"
                              minHeight={68}
                              defaultValue={contract.notes || ''}
                              placeholder="Добавьте примечание по договору"
                              onBlur={(e) => handleSaveNote(contract.id, e.target.value)}
                            />
                          ) : contract.notes ? (
                            <div className="ce-note-ro">{contract.notes}</div>
                          ) : (
                            <div className="ce-empty">Примечание пока не заполнено</div>
                          )}
                        </section>

                        {/* Блок 2: Приложения к Договору (ручной ввод, task 419) */}
                        <section className="ce-block">
                          <div className="ce-block-title">
                            Приложения к Договору
                            {appendices.length > 0 && <span className="ce-count">{appendices.length} шт.</span>}
                            {canEditContracts && !isDeletedTab && (
                              <button type="button" className="ce-add-appendix" onClick={() => handleAddAppendix(contract.id)}>
                                + Добавить приложение
                              </button>
                            )}
                          </div>
                          {appendices.length === 0 ? (
                            <div className="ce-empty">
                              Приложения не добавлены.{canEditContracts && !isDeletedTab ? ' Нажмите «+ Добавить приложение».' : ''}
                            </div>
                          ) : (
                            <div className="ce-appendix-wrap">
                              <table className="ce-appendix-table">
                                <thead>
                                  <tr>
                                    <th className="ce-ap-num">№</th>
                                    <th>Наименование приложения</th>
                                    <th>Ответственный</th>
                                    <th className="ce-ap-status">Статус</th>
                                    <th className="ce-ap-notes">Примечание</th>
                                    {canEditContracts && !isDeletedTab && <th className="ce-ap-actions" aria-label="Действия"></th>}
                                  </tr>
                                </thead>
                                <tbody>
                                  {appendices.map(ap => {
                                    const ro = !canEditContracts || isDeletedTab
                                    return (
                                      <tr key={ap.id}>
                                        <td className="ce-ap-num">
                                          <input
                                            className="ce-ap-input ce-ap-input-num"
                                            defaultValue={ap.appendix_number || ''}
                                            readOnly={ro}
                                            title="№ приложения (можно изменить)"
                                            onBlur={(e) => handleUpdateAppendix(contract.id, ap.id, 'appendix_number', e.target.value)}
                                          />
                                        </td>
                                        <td>
                                          <input
                                            className="ce-ap-input"
                                            defaultValue={ap.name || ''}
                                            placeholder="Наименование приложения"
                                            readOnly={ro}
                                            onBlur={(e) => handleUpdateAppendix(contract.id, ap.id, 'name', e.target.value)}
                                          />
                                        </td>
                                        <td>
                                          <input
                                            className="ce-ap-input"
                                            defaultValue={ap.responsible || ''}
                                            placeholder="Ответственный"
                                            readOnly={ro}
                                            onBlur={(e) => handleUpdateAppendix(contract.id, ap.id, 'responsible', e.target.value)}
                                          />
                                        </td>
                                        <td className="ce-ap-status">
                                          <input
                                            className="ce-ap-input"
                                            defaultValue={ap.status || ''}
                                            placeholder="Статус"
                                            readOnly={ro}
                                            onBlur={(e) => handleUpdateAppendix(contract.id, ap.id, 'status', e.target.value)}
                                          />
                                        </td>
                                        <td className="ce-ap-notes">
                                          {ro ? (
                                            <div className="ce-ap-notes-ro">{ap.notes || '—'}</div>
                                          ) : (
                                            <AutoGrowTextarea
                                              className="ce-ap-input ce-ap-textarea"
                                              minHeight={32}
                                              defaultValue={ap.notes || ''}
                                              placeholder="Примечание по статусу приложения"
                                              onBlur={(e) => handleUpdateAppendix(contract.id, ap.id, 'notes', e.target.value)}
                                            />
                                          )}
                                        </td>
                                        {canEditContracts && !isDeletedTab && (
                                          <td className="ce-ap-actions">
                                            <button
                                              type="button"
                                              className="ce-ap-del"
                                              title="Удалить приложение"
                                              aria-label="Удалить приложение"
                                              onClick={() => handleDeleteAppendix(contract.id, ap.id)}
                                            >×</button>
                                          </td>
                                        )}
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </section>

                        {/* Блок 3: Приложения из объекта (привязанные в модалке) — если есть */}
                        {items.length > 0 && (
                          <section className="ce-block">
                            <div className="ce-block-title">
                              Приложения из объекта
                              <span className="ce-count">{items.length} шт.</span>
                            </div>
                            <ul className="cap-list">
                              {items.map(a => (
                                <li key={a.ca_id} className="cap-item">
                                  <div className="cap-item-head">
                                    <span className="cap-item-name">
                                      <span className="cap-item-icon" aria-hidden>📎</span>
                                      {a.link
                                        ? <a href={a.link} target="_blank" rel="noopener noreferrer">{a.name}</a>
                                        : a.name}
                                    </span>
                                    {a.description && <span className="cap-item-desc">{a.description}</span>}
                                  </div>
                                  {canEditContracts && !isDeletedTab && (
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
                                  )}
                                  {(!canEditContracts || isDeletedTab) && a.comment && (
                                    <div className="cap-item-comment-ro">{a.comment}</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </section>
                        )}

                        {/* Действия раскрытого блока */}
                        <div className="ce-actions">
                          <button type="button" className="ce-open-card" onClick={() => navigate(`/contracts/${contract.id}`)}>
                            Открыть карточку договора
                          </button>
                          {canEditContracts && !isDeletedTab && (
                            <button type="button" className="ce-edit-link" onClick={() => handleEditContract(contract)}>
                              Редактировать договор
                            </button>
                          )}
                        </div>
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

      {!loading && totalCount > 0 && (
        <div className="registry-pagination">
          <span className="rp-info">
            Показано {rangeFrom}–{rangeTo} из {totalCount} {pluralContracts(totalCount)}
          </span>
          <div className="rp-controls">
            <label className="rp-size">
              Строк на странице:
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="rp-pager">
              <button className="rp-btn" onClick={() => setPage(1)} disabled={currentPage <= 1} title="Первая">«</button>
              <button className="rp-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1} title="Назад">‹</button>
              <span className="rp-page">Стр. {currentPage} из {pageCount}</span>
              <button className="rp-btn" onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={currentPage >= pageCount} title="Вперёд">›</button>
              <button className="rp-btn" onClick={() => setPage(pageCount)} disabled={currentPage >= pageCount} title="Последняя">»</button>
            </div>
          </div>
        </div>
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
                  <label>№ договора</label>
                  <input type="text" name="contract_number" value={formData.contract_number} onChange={handleInputChange} placeholder="Можно оставить пустым" />
                  <small className="form-hint">Если номера ещё нет — оставьте поле пустым, договор подсветится в реестре.</small>
                </div>

                <div className="form-group">
                  <label>Дата договора</label>
                  <input type="date" name="contract_date" value={formData.contract_date} onChange={handleInputChange} />
                </div>

                <div className="form-group full-width">
                  <label>Контрагенты (стороны договора) *</label>
                  {selectedParties.length > 0 && (
                    <div className="cp-chips">
                      {selectedParties.map((cp, i) => (
                        <span key={cp.id} className="cp-chip">
                          {i === 0 && <span className="cp-chip-badge">Основной</span>}
                          <span className="cp-chip-name">{cp.name}</span>
                          <button
                            type="button"
                            className="cp-chip-remove"
                            title="Убрать контрагента"
                            onClick={() => handleRemoveCounterparty(cp.id)}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="cp-search-wrap">
                    <input
                      type="text"
                      className="cp-search-input"
                      placeholder={formCounterpartyIds.length === 0
                        ? 'Начните вводить название или ИНН...'
                        : 'Добавить ещё контрагента (для трёхстороннего договора)...'}
                      value={counterpartySearch}
                      onChange={(e) => { setCounterpartySearch(e.target.value); setCounterpartyDropdownOpen(true) }}
                      onFocus={() => setCounterpartyDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setCounterpartyDropdownOpen(false), 150)}
                      required={formCounterpartyIds.length === 0}
                    />
                    {counterpartyDropdownOpen && (
                      <div className="cp-search-dropdown">
                        {filteredCounterparties.length === 0 ? (
                          <div className="cp-search-empty">Ничего не найдено</div>
                        ) : (
                          filteredCounterparties.slice(0, 50).map(cp => {
                            const picked = formCounterpartyIds.includes(cp.id)
                            return (
                              <button
                                type="button"
                                key={cp.id}
                                className={`cp-search-item ${picked ? 'active' : ''}`}
                                onMouseDown={() => handleSelectCounterparty(cp.id)}
                              >
                                <div className="cp-search-name">{cp.name}{picked && <span className="cp-search-picked"> ✓ выбран</span>}</div>
                                {cp.inn && <div className="cp-search-inn">ИНН: {cp.inn}</div>}
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                  <small className="form-hint">Первый в списке — основной контрагент. Для трёхстороннего договора добавьте остальные стороны.</small>
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

                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea name="notes" value={formData.notes} onChange={handleInputChange} rows={2} placeholder="Примечание (необязательно)" />
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
          <div className="modal oa-modal" role="dialog" aria-modal="true">
            <div className="oa-modal-header">
              <div className="oa-modal-heading">
                <h3>Стандартные приложения объекта</h3>
                <p className="oa-modal-subtitle">
                  Список приложений, которые предлагаются при заведении договора по этому объекту
                </p>
              </div>
              <button className="modal-close" onClick={() => setShowAttachmentsModal(false)} aria-label="Закрыть">×</button>
            </div>

            <div className="oa-modal-body">
              <div className="oa-field">
                <label htmlFor="oa-object">Объект</label>
                <select id="oa-object" value={attachmentsObjectId} onChange={handleAttachmentsObjectChange}>
                  <option value="">Выберите объект</option>
                  {objects.map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>

              {!attachmentsObjectId ? (
                <div className="oa-placeholder">Выберите объект, чтобы увидеть его приложения</div>
              ) : (
                <>
                  <div className="oa-section-title">
                    Приложения
                    {objectAttachments.length > 0 && <span className="oa-count">{objectAttachments.length}</span>}
                  </div>

                  {objectAttachments.length === 0 ? (
                    <div className="oa-empty">Приложений пока нет — добавьте первое в форме ниже.</div>
                  ) : (
                    <ul className="oa-list">
                      {objectAttachments.map(a => (
                        <li key={a.id} className="oa-item">
                          <div className="oa-item-main">
                            <div className="oa-item-name">{a.name}</div>
                            {a.description && <div className="oa-item-desc">{a.description}</div>}
                            {a.link && (
                              <a className="oa-item-link" href={a.link} target="_blank" rel="noopener noreferrer">
                                {a.link}
                              </a>
                            )}
                          </div>
                          {canEditContracts && (
                            <button
                              type="button"
                              className="btn-icon btn-delete oa-item-del"
                              onClick={() => handleDeleteAttachment(a.id)}
                              title="Удалить приложение"
                              aria-label="Удалить приложение"
                            ><TrashIcon /></button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canEditContracts && (
                    <div className="oa-add-card">
                      <div className="oa-add-title">Новое приложение</div>
                      <div className="oa-add-grid">
                        <div className="oa-field">
                          <label htmlFor="oa-name">Название *</label>
                          <input
                            id="oa-name"
                            type="text"
                            placeholder="Например: ПСДЦ"
                            value={newAttachmentName}
                            onChange={(e) => setNewAttachmentName(e.target.value)}
                          />
                        </div>
                        <div className="oa-field">
                          <label htmlFor="oa-desc">Описание</label>
                          <input
                            id="oa-desc"
                            type="text"
                            placeholder="Краткая сводка (необязательно)"
                            value={newAttachmentDescription}
                            onChange={(e) => setNewAttachmentDescription(e.target.value)}
                          />
                        </div>
                        <div className="oa-field oa-field-wide">
                          <label htmlFor="oa-link">Ссылка</label>
                          <input
                            id="oa-link"
                            type="url"
                            placeholder="https://… (необязательно)"
                            value={newAttachmentLink}
                            onChange={(e) => setNewAttachmentLink(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="oa-add-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={handleAddAttachment}
                          disabled={!newAttachmentName.trim()}
                        >+ Добавить приложение</button>
                      </div>
                    </div>
                  )}
                </>
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
