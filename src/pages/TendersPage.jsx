import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import StatusDropdown from '../components/StatusDropdown'
import TenderCounterpartyFiles from '../components/TenderCounterpartyFiles'
import { copyToClipboard } from '../utils/clipboard'
import '../components/Tenders.css'

function TendersPage({ department = 'construction', tenderType = 'main' }) {
  const isMaterialsView = tenderType === 'materials'
  const { scopedObjectId, userProfile, isAdmin } = useRole()
  const [tenders, setTenders] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [responsibleContacts, setResponsibleContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  // task 212: 'all' | <status> | 'template' | 'deleted'
  const [activeTab, setActiveTab] = useState('all')
  // task 232/233: статус-вкладки скрыты под кнопкой «Статусы тендеров»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [editingTender, setEditingTender] = useState(null)
  const [expandedTenderId, setExpandedTenderId] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState({})
  // Сводка по каждому тендеру: { tenderId: { total, proposalProvided } }
  const [tenderProposalCounts, setTenderProposalCounts] = useState({})
  const [copiedEmailsTenderId, setCopiedEmailsTenderId] = useState(null)
  const [editingResponsibleTenderId, setEditingResponsibleTenderId] = useState(null)
  const [showAddCounterpartyModal, setShowAddCounterpartyModal] = useState(false)
  const [selectedTenderForCounterparty, setSelectedTenderForCounterparty] = useState(null)
  const [counterpartySearchQuery, setCounterpartySearchQuery] = useState('')
  const [counterpartyWorkTypeFilter, setCounterpartyWorkTypeFilter] = useState('')
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState([])
  const [showWinnerModal, setShowWinnerModal] = useState(false)
  const [tenderForWinnerSelection, setTenderForWinnerSelection] = useState(null)
  // task 215: несколько победителей — массив { counterparty_id, scope_note }
  const [selectedWinners, setSelectedWinners] = useState([])
  const [showLetterModal, setShowLetterModal] = useState(false)
  const [generatedLetter, setGeneratedLetter] = useState('')
  const [letterCopied, setLetterCopied] = useState(false)

  const DEFAULT_LETTER_TEMPLATE = `Уважаемые руководители!

ООО «СУ-10» уведомляет о проведении тендера на выбор подрядчика на {work_description} для объекта: «{object_name}».

В связи с этим, мы приглашаем вашу компанию принять участие в тендере и предоставить свои предложения для рассмотрения.
Срок подачи заявок на участие в тендере: {start_date}-{end_date} гг.

Для получения дополнительных разъяснений и уточнений вы можете связаться с нами по телефону {employee_phone} или отправить запрос на электронную почту {employee_email}, в теле письма указать по какому тендеру и объекту обращаетесь.

Мы рассчитываем на плодотворное сотрудничество и надеемся на участие вашей компании в тендере.

Приложение: ссылка на тендерную документацию:
{tender_package_link}

С уважением,
{employee_position} ООО "СУ-10"
{employee_name}
Телефон для связи: {employee_phone}
Почта: {employee_email}`

  const [letterTemplate, setLetterTemplate] = useState(() => {
    return localStorage.getItem('letterTemplate') || DEFAULT_LETTER_TEMPLATE
  })
  const [templateSaved, setTemplateSaved] = useState(false)
  const [objectFilter, setObjectFilter] = useState('')
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // Компактный вид: скрывает столбцы «ВОРы и РД», «План затрат», «Тендер на материалы», «Сводная КП»
  // и сохраняется в localStorage отдельно для каждого представления (construction/warranty/materials).
  const compactStorageKey = `tenders-compact-view:${tenderType}:${department}`
  const [compactView, setCompactView] = useState(() => {
    try { return localStorage.getItem(compactStorageKey) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(compactStorageKey, compactView ? '1' : '0') } catch { /* noop */ }
  }, [compactView, compactStorageKey])
  // Родительский тендер при создании дочернего тендера на материалы (preselect)
  const [materialsParentTender, setMaterialsParentTender] = useState(null)
  const [sortField, setSortField] = useState('start_date') // 'start_date' | 'end_date'
  const [sortOrder, setSortOrder] = useState('desc') // 'asc' | 'desc'
  const [formData, setFormData] = useState({
    object_id: '',
    work_description: '',
    status: 'Заявка на тендер',
    start_date: '',
    end_date: '',
    tender_package_link: '',
    responsible_contact_id: '',
    cost_plan_link: '',
    cost_plan_responsible_id: '',
    vor_link: '',
    vor_responsible_id: '',
    vor_start_date: '',
    vor_end_date: '',
    tender_start_date: '',
    tender_end_date: '',
    summary_proposal_link: '',
    notes: '',
  })

  // Определяем статус объекта в зависимости от отдела (только для основных тендеров)
  const objectStatus = department === 'construction' ? 'main_construction' : 'warranty_service'
  const pageTitle = isMaterialsView
    ? 'Тендеры на материалы'
    : department === 'construction'
      ? 'Тендеры — Основное строительство'
      : 'Тендеры — Гарантийный отдел'

  const statusOptions = ['Заявка на тендер', 'Подготовка ВОР', 'Идет тендерная процедура', 'Подведение итогов', 'Завершен', 'Приостановка тендера']
  // Отдельный набор статусов для тендеров на материалы — не пересекается со статусами основного тендера.
  // «Не требуется» — финальный статус (материалы закупать не требуется), считается как завершённый.
  const materialsStatusOptions = ['Не начат', 'В работе', 'Завершён', 'Не требуется']
  const currentStatusOptions = isMaterialsView ? materialsStatusOptions : statusOptions
  // Для тендеров на материалы «завершённые» — это «Завершён» и «Не требуется»
  // (а также старое значение «Не нужно» — для обратной совместимости).
  // Для основных тендеров — только «Завершен».
  const isCompletedStatus = (status) => isMaterialsView
    ? (status === 'Завершён' || status === 'Не требуется' || status === 'Не нужно')
    : (status === 'Завершен')
  const initialStatusValue = isMaterialsView ? 'Не начат' : 'Заявка на тендер'

  const counterpartyStatusOptions = [
    { value: 'request_sent', label: 'Запрос отправлен' },
    { value: 'accepted_for_work', label: 'Принято в работу' },
    { value: 'proposal_provided', label: 'КП предоставлено' },
    { value: 'declined', label: 'Отказ' }
  ]

  const getCounterpartyStatusLabel = (status) => {
    const option = counterpartyStatusOptions.find(opt => opt.value === status)
    return option ? option.label : status
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6b7a99',
      'declined': '#9c6b6b',
      'proposal_provided': '#5a8a72',
      'accepted_for_work': '#4338ca'
    }
    return colors[status] || '#64748b'
  }

  useEffect(() => {
    // Загружаем всё параллельно
    Promise.all([
      fetchTenders(),
      fetchObjects(),
      fetchCounterparties(),
      fetchResponsibleContacts(),
      fetchTenderProposalCounts()
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, tenderType])

  // Сводный запрос: считаем для каждого тендера сколько контрагентов и сколько предоставили КП.
  const fetchTenderProposalCounts = async () => {
    try {
      const { data, error } = await supabase
        .from('tender_counterparties')
        .select('tender_id, status')
      if (error) throw error
      const map = {}
      ;(data || []).forEach(row => {
        const t = row.tender_id
        if (!map[t]) map[t] = { total: 0, proposalProvided: 0 }
        map[t].total += 1
        if (row.status === 'proposal_provided') map[t].proposalProvided += 1
      })
      setTenderProposalCounts(map)
    } catch (err) {
      console.error('Ошибка загрузки счётчиков КП:', err.message)
    }
  }

  const fetchTenders = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select('*, objects(name, status, address, map_link), winner:counterparties!winner_counterparty_id(id, name), tender_winners(counterparty_id, scope_note, counterparties(id, name)), responsible_contact:contacts!responsible_contact_id(id, full_name), cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name), vor_responsible:contacts!vor_responsible_id(id, full_name), materials_tender:tenders!parent_tender_id(id, status, summary_proposal_link, cost_plan_status, cost_plan_link, materials_proposal_deadline, materials_proposal_link)')
        .eq('tender_type', tenderType)
        .order('start_date', { ascending: false })

      if (error) throw error
      // Reverse FK tenders!parent_tender_id возвращается массивом (UNIQUE на parent_tender_id нет).
      // Сводим к одному объекту или null, чтобы дальше обращаться как tender.materials_tender.status.
      const normalized = (data || []).map(t => ({
        ...t,
        materials_tender: Array.isArray(t.materials_tender)
          ? (t.materials_tender[0] || null)
          : (t.materials_tender || null)
      }))
      // Для основных тендеров фильтруем по статусу объекта (construction/warranty).
      // Для тендеров на материалы показываем все объекты без фильтрации по отделу.
      let filteredTenders = isMaterialsView
        ? normalized
        : normalized.filter(tender => tender.objects?.status === objectStatus)
      if (scopedObjectId) {
        filteredTenders = filteredTenders.filter(t => t.object_id === scopedObjectId)
      }

      // task 223b: для тендеров на материалы подгружаем родительский тендер
      // основного строительства (отдельным запросом — self-FK неоднозначен в embed).
      if (isMaterialsView) {
        const parentIds = [...new Set(filteredTenders.map(t => t.parent_tender_id).filter(Boolean))]
        if (parentIds.length > 0) {
          const { data: parents, error: parentsError } = await supabase
            .from('tenders')
            .select('id, public_tender_number, work_description, objects(name)')
            .in('id', parentIds)
          if (parentsError) {
            console.error('Не удалось загрузить родительские тендеры:', parentsError.message)
          } else {
            const parentMap = new Map((parents || []).map(p => [p.id, p]))
            // task 231: описание работ тендера на материалы всегда взято из
            // основного тендера (взаимосвязь). Если разошлось — тихо приводим
            // к родительскому и в отображении, и в БД (самовосстановление,
            // чинит и старые расхождения без миграции).
            const toSync = []
            filteredTenders = filteredTenders.map(t => {
              const parent = t.parent_tender_id ? (parentMap.get(t.parent_tender_id) || null) : null
              if (parent && (parent.work_description || '') !== (t.work_description || '')) {
                toSync.push({ id: t.id, work_description: parent.work_description })
                return { ...t, parent_tender: parent, work_description: parent.work_description }
              }
              return { ...t, parent_tender: parent }
            })
            if (toSync.length > 0) {
              await Promise.all(toSync.map(async (s) => {
                const { error: upErr } = await supabase
                  .from('tenders')
                  .update({ work_description: s.work_description })
                  .eq('id', s.id)
                if (upErr) {
                  console.error('Синхронизация описания тендера на материалы не удалась:', s.id, upErr.message)
                }
              }))
            }
          }
        }
      }

      setTenders(filteredTenders)
    } catch (error) {
      console.error('Ошибка загрузки тендеров:', error.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchObjects = async () => {
    try {
      let query = supabase
        .from('objects')
        .select('*')
        .order('name', { ascending: true })
      // Для тендеров на материалы доступны объекты любого отдела
      if (!isMaterialsView) {
        query = query.eq('status', objectStatus)
      }
      const { data, error } = await query

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
        .eq('status', 'active')
        .order('name', { ascending: true })

      if (error) throw error
      setCounterparties(data || [])
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
    }
  }

  const ROLE_LABELS_MAP = {
    admin: 'Администратор',
    engineer: 'Инженер ОСП',
    economist: 'Экономист ОСП',
    lawyer: 'Юрист ОСП'
  }

  const fetchResponsibleContacts = async () => {
    try {
      // Параллельная загрузка
      const [contactsRes, profilesRes] = await Promise.all([
        supabase.from('contacts').select('*').order('full_name', { ascending: true }),
        supabase.from('user_roles').select('full_name, role, work_phone, work_email, email, is_approved').eq('is_approved', true)
      ])

      if (contactsRes.error) throw contactsRes.error

      const contacts = contactsRes.data || []
      const profiles = profilesRes.data || []

      // Синхронизируем: добавляем профили, которых нет в contacts
      const contactNames = new Set(contacts.map(c => c.full_name?.toLowerCase()))
      const missing = profiles.filter(
        p => p.full_name && !contactNames.has(p.full_name.toLowerCase())
      )

      if (missing.length > 0) {
        const toInsert = missing.map(p => ({
          full_name: p.full_name,
          position: ROLE_LABELS_MAP[p.role] || p.role,
          phone: p.work_phone || '',
          email: p.work_email || p.email || ''
        }))

        const { data: inserted } = await supabase.from('contacts').insert(toInsert).select()

        if (inserted) {
          setResponsibleContacts([...contacts, ...inserted].sort((a, b) =>
            (a.full_name || '').localeCompare(b.full_name || '', 'ru')
          ))
          return
        }
      }

      setResponsibleContacts(contacts)
    } catch (error) {
      console.error('Ошибка загрузки сотрудников:', error.message)
    }
  }

  // Найти имя ответственного по tender
  const getResponsibleName = (tender) => {
    if (tender.responsible_contact?.full_name) return tender.responsible_contact.full_name
    return null
  }

  const fetchTenderCounterparties = async (tenderId) => {
    try {
      const { data, error } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id,
            name,
            work_type,
            inn,
            counterparty_contacts(
              id,
              full_name,
              position,
              phone,
              email
            )
          )
        `)
        .eq('tender_id', tenderId)

      if (error) throw error
      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: data || []
      }))
    } catch (error) {
      console.error('Ошибка загрузки контрагентов тендера:', error.message)
    }
  }

  const handleToggleTender = async (tenderId) => {
    if (expandedTenderId === tenderId) {
      setExpandedTenderId(null)
    } else {
      setExpandedTenderId(tenderId)
      if (!tenderCounterparties[tenderId]) {
        await fetchTenderCounterparties(tenderId)
      }
    }
  }

  const handleAddCounterpartiesToTender = async () => {
    if (!selectedTenderForCounterparty || selectedCounterpartyIds.length === 0) {
      alert('Выберите хотя бы одного контрагента')
      return
    }

    try {
      const inserts = selectedCounterpartyIds.map(counterpartyId => ({
        tender_id: selectedTenderForCounterparty,
        counterparty_id: counterpartyId
      }))

      const { error } = await supabase
        .from('tender_counterparties')
        .insert(inserts)

      if (error) throw error

      for (const counterpartyId of selectedCounterpartyIds) {
        const cp = counterparties.find(c => c.id === counterpartyId)
        const name = cp?.name || null
        await logTenderEvent(selectedTenderForCounterparty, 'participant_added', {
          fieldName: 'participants',
          newValue: { id: counterpartyId, name },
          description: `Добавлен участник: ${name || '—'}`
        })
      }

      await fetchTenderCounterparties(selectedTenderForCounterparty)
      fetchTenderProposalCounts()
      setShowAddCounterpartyModal(false)
      setSelectedCounterpartyIds([])
      setCounterpartySearchQuery('')
      setCounterpartyWorkTypeFilter('')
    } catch (error) {
      console.error('Ошибка добавления контрагентов:', error.message)
      alert('Ошибка добавления: ' + error.message)
    }
  }

  const handleToggleCounterpartySelection = (counterpartyId) => {
    setSelectedCounterpartyIds(prev => {
      if (prev.includes(counterpartyId)) {
        return prev.filter(id => id !== counterpartyId)
      } else {
        return [...prev, counterpartyId]
      }
    })
  }

  const handleUpdateCounterpartyStatus = async (tenderId, tenderCounterpartyId, newStatus) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      // Обновляем локальное состояние
      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: prev[tenderId].map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, status: newStatus } : tc
        )
      }))
      // Перепосчитываем счётчик «КП предоставлено» для этого тендера
      fetchTenderProposalCounts()
    } catch (error) {
      console.error('Ошибка обновления статуса:', error.message)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const handleUpdateMaterialsDeadline = async (tenderId, value) => {
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ materials_proposal_deadline: value || null })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId ? { ...t, materials_proposal_deadline: value || null } : t
      ))
    } catch (err) {
      console.error('Ошибка сохранения срока КП на материалы:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleUpdateMaterialsLink = async (tenderId, currentValue) => {
    const next = window.prompt('Ссылка на КП на материалы (Google/Yandex Drive):', currentValue || '')
    if (next === null) return
    const trimmed = next.trim()
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ materials_proposal_link: trimmed || null })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId ? { ...t, materials_proposal_link: trimmed || null } : t
      ))
    } catch (err) {
      console.error('Ошибка сохранения ссылки на КП:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleUpdateCounterpartyNotes = async (tenderId, tenderCounterpartyId, notes) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ notes: notes || null })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: prev[tenderId].map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, notes } : tc
        )
      }))
    } catch (error) {
      console.error('Ошибка сохранения примечания:', error.message)
    }
  }

  const handleUpdateTenderResponsible = async (tenderId, newContactId) => {
    const value = newContactId || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldName = tender?.responsible_contact?.full_name || null
    const newContact = value ? responsibleContacts.find(c => c.id === value) : null
    const newName = newContact?.full_name || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ responsible_contact_id: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, responsible_contact_id: value, responsible_contact: newContact ? { id: newContact.id, full_name: newContact.full_name } : null }
          : t
      ))
      if (oldName !== newName) {
        logTenderEvent(tenderId, 'field_updated', {
          fieldName: 'responsible_contact_id',
          oldValue: oldName,
          newValue: newName,
          description: newName
            ? (oldName ? `Сменён ответственный по тендеру: ${oldName} → ${newName}` : `Назначен ответственный по тендеру: ${newName}`)
            : `Снят ответственный по тендеру (был: ${oldName})`,
        })
      }
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Инлайн-редактирование ссылок (тендерный пакет / сводная КП) прямо из таблицы.
  const TENDER_LINK_FIELDS = {
    tender_package_link: 'Ссылка на тендерный пакет',
    summary_proposal_link: 'Ссылка на сводную КП',
  }
  const handleUpdateTenderLink = async (tenderId, field, currentValue) => {
    const label = TENDER_LINK_FIELDS[field] || 'Ссылка'
    const next = window.prompt(`${label} (Google/Yandex Drive):`, currentValue || '')
    if (next === null) return
    const value = next.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ [field]: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, [field]: value } : t))
      // Пишем событие в журнал, чтобы изменение было видно в истории тендера.
      logTenderEvent(tenderId, 'field_updated', {
        fieldName: field,
        oldValue: currentValue || null,
        newValue: value,
        description: `Изменено: ${label}`,
      })
    } catch (err) {
      console.error('Ошибка сохранения ссылки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Открыть модалку с шаблоном письма прямо из строки таблицы (без перехода в редактирование).
  const handleShowLetterForTender = (tender) => {
    if (!tender.responsible_contact_id) {
      alert('Сначала назначьте ответственного по тендеру — без него нельзя сформировать письмо.')
      return
    }
    const objectName = tender.objects?.name || '[Объект не указан]'
    const employee = responsibleContacts.find(c => c.id === tender.responsible_contact_id)
    const letter = generateRequestLetter(tender, objectName, employee)
    setGeneratedLetter(letter)
    setShowLetterModal(true)
  }

  const handleCopyEmailsForTender = async (tenderId) => {
    const rows = tenderCounterparties[tenderId] || []
    const emails = []
    rows.forEach(tc => {
      const contacts = tc.counterparties?.counterparty_contacts || []
      contacts.forEach(c => {
        if (c.email && c.email.trim()) emails.push(c.email.trim())
      })
    })
    const unique = Array.from(new Set(emails))
    if (unique.length === 0) {
      alert('У контрагентов нет email-адресов')
      return
    }
    const ok = await copyToClipboard(unique.join('; '))
    if (ok) {
      setCopiedEmailsTenderId(tenderId)
      setTimeout(() => setCopiedEmailsTenderId(prev => prev === tenderId ? null : prev), 2000)
    } else {
      alert('Не удалось скопировать в буфер обмена')
    }
  }

  const handleRemoveCounterpartyFromTender = async (tenderId, tenderCounterpartyId) => {
    if (!window.confirm('Удалить контрагента из тендера?')) return

    try {
      const removed = (tenderCounterparties[tenderId] || []).find(tc => tc.id === tenderCounterpartyId)
      const removedInfo = removed
        ? { id: removed.counterparty_id, name: removed.counterparties?.name || null }
        : null

      const { error} = await supabase
        .from('tender_counterparties')
        .delete()
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      if (removedInfo) {
        await logTenderEvent(tenderId, 'participant_removed', {
          fieldName: 'participants',
          oldValue: removedInfo,
          description: `Удалён участник: ${removedInfo.name || '—'}`
        })
      }

      await fetchTenderCounterparties(tenderId)
      fetchTenderProposalCounts()
    } catch (error) {
      console.error('Ошибка удаления контрагента:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  // Поля, которые могут содержать UUID — пустую строку конвертируем в null,
  // иначе Postgres падает на невалидном UUID.
  const UUID_FIELDS = new Set([
    'object_id', 'responsible_contact_id', 'cost_plan_responsible_id', 'vor_responsible_id'
  ])
  const normalizeField = (key, value) => {
    if (value === '' || value === undefined) return null
    return value
  }
  const normalizePayload = (data) => {
    const out = {}
    for (const [k, v] of Object.entries(data)) {
      const nv = normalizeField(k, v)
      // UUID — null если пусто
      if (UUID_FIELDS.has(k) && (nv === '' || nv == null)) {
        out[k] = null
      } else {
        out[k] = nv
      }
    }
    return out
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      if (editingTender) {
        // Update existing tender — отправляем все поля
        const updatePayload = normalizePayload(formData)
        const { error } = await supabase
          .from('tenders')
          .update(updatePayload)
          .eq('id', editingTender.id)

        if (error) throw error

        // Логируем изменения каждого поля
        const trackFields = [
          'work_description', 'start_date', 'end_date',
          'vor_start_date', 'vor_end_date', 'tender_start_date', 'tender_end_date',
          'tender_package_link', 'responsible_contact_id', 'object_id',
          'cost_plan_link', 'cost_plan_responsible_id',
          'vor_link', 'vor_responsible_id',
          'summary_proposal_link', 'notes'
        ]
        for (const f of trackFields) {
          const oldV = editingTender[f] ?? null
          const newV = updatePayload[f] ?? null
          if ((oldV || null) !== (newV || null)) {
            await logTenderEvent(editingTender.id, 'field_updated', {
              fieldName: f,
              oldValue: oldV,
              newValue: newV,
              description: `Изменено: ${FIELD_LABELS[f] || f}`
            })
          }
        }
        // Если статус изменился через форму — отдельно
        if ((editingTender.status || null) !== (formData.status || null)) {
          await logTenderEvent(editingTender.id, 'status_changed', {
            oldValue: editingTender.status || null,
            newValue: formData.status,
            description: `Статус: ${editingTender.status || '—'} → ${formData.status}`
          })
        }

        // task 223a / 226 / 229: описание работ основного тендера взаимосвязано
        // с дочерним тендером на материалы — синхронизируем при любом изменении.
        const descChanged = (editingTender.work_description || '') !== (updatePayload.work_description || '')
        if (editingTender.tender_type !== 'materials' && descChanged) {
          const newDesc = updatePayload.work_description
          let syncedCount = 0

          // 1) Основной путь: дочерние тендеры на материалы по parent_tender_id.
          const { data: byParent, error: byParentErr } = await supabase
            .from('tenders')
            .update({ work_description: newDesc })
            .eq('parent_tender_id', editingTender.id)
            .select('id')
          if (byParentErr) {
            console.error('Синхронизация описания (по parent_tender_id) не удалась:', byParentErr.message)
          } else {
            syncedCount += byParent?.length || 0
          }

          // 2) Самовосстановление связи: если по parent_tender_id ничего не нашлось,
          //    подхватываем «осиротевшие» тендеры на материалы того же объекта
          //    (parent_tender_id IS NULL) — обновляем описание и проставляем связь,
          //    чтобы дальше работал быстрый путь.
          if (syncedCount === 0 && editingTender.object_id) {
            const { data: adopted, error: adoptErr } = await supabase
              .from('tenders')
              .update({ work_description: newDesc, parent_tender_id: editingTender.id })
              .eq('object_id', editingTender.object_id)
              .eq('tender_type', 'materials')
              .is('parent_tender_id', null)
              .select('id')
            if (adoptErr) {
              console.error('Синхронизация описания (привязка по объекту) не удалась:', adoptErr.message)
            } else {
              syncedCount += adopted?.length || 0
            }
          }

          if (syncedCount === 0) {
            console.warn('Описание работ изменено, но связанный тендер на материалы не найден ' +
              '(нет тендера на материалы с parent_tender_id этого тендера и нет несвязанного ' +
              'тендера на материалы для объекта).')
          }
        }
      } else {
        // Insert new tender — только минимальный набор для заявки от руководителя строительства.
        // Это страхует от падений, если новые миграции (notes, cost_plan_*, vor_*) ещё не применены.
        // Тип тендера определяется текущим режимом страницы или явным запуском дочернего тендера на материалы.
        const newTenderType = materialsParentTender ? 'materials' : tenderType
        const insertPayload = {
          object_id: formData.object_id || null,
          work_description: formData.work_description,
          status: formData.status || initialStatusValue,
          // task 270: даты работ необязательны — пустое значение сохраняем как NULL
          start_date: formData.start_date || null,
          end_date: formData.end_date || null,
          tender_type: newTenderType,
        }
        if (materialsParentTender) {
          insertPayload.parent_tender_id = materialsParentTender.id
        }
        if (formData.notes) insertPayload.notes = formData.notes
        // task 271: даты тендерной процедуры теперь сохраняются и при создании
        // (поля есть в форме создания, но раньше не попадали в insert).
        if (formData.tender_start_date) insertPayload.tender_start_date = formData.tender_start_date
        if (formData.tender_end_date) insertPayload.tender_end_date = formData.tender_end_date

        // Вставка с автоматическим retry: если БД ругается на отсутствующие новые колонки
        // (миграция ещё не применена), отбрасываем эти поля и пробуем снова.
        const insertTenderWithRetry = async (payload) => {
          const attempt = async (p) => await supabase
            .from('tenders')
            .insert([p])
            .select('id')
            .single()
          let p = { ...payload }
          let res = await attempt(p)
          // Retry для каждой проблемной колонки (notes, tender_type, parent_tender_id)
          for (let i = 0; i < 4 && res.error; i++) {
            const m = res.error.message || ''
            const match = m.match(/column "?([a-z_]+)"? .* does not exist/i)
              || m.match(/Could not find the '([a-z_]+)' column/i)
            if (match && p[match[1]] !== undefined) {
              const col = match[1]
              const next = { ...p }
              delete next[col]
              p = next
              res = await attempt(p)
              continue
            }
            break
          }
          return { res, finalPayload: p }
        }

        const { res: mainRes, finalPayload: mainFinalPayload } = await insertTenderWithRetry(insertPayload)
        let createdMainId = null
        if (mainRes.error) throw mainRes.error
        if (mainRes.data?.id) {
          createdMainId = mainRes.data.id
          await logTenderEvent(mainRes.data.id, 'created', {
            newValue: mainFinalPayload,
            description: 'Тендер создан'
          })
        }

        // Автоматически создаём связанный тендер на материалы только для тендеров основного строительства.
        // В гарантийном отделе тендеры на материалы не нужны.
        if (createdMainId && newTenderType === 'main' && department === 'construction') {
          // Если retry основной вставки удалил tender_type / parent_tender_id — миграция не применена,
          // создание дочернего тендера невозможно. Сообщаем пользователю явно.
          if (mainFinalPayload.tender_type === undefined) {
            alert('Тендер создан, но автосоздание тендера на материалы пропущено: миграция 20260515_add_tender_type_and_parent не применена в БД. Примените миграцию и пересоздайте основной тендер.')
          } else {
            try {
              const materialsPayload = {
                object_id: insertPayload.object_id,
                work_description: insertPayload.work_description,
                status: 'Не начат',
                start_date: insertPayload.start_date,
                end_date: insertPayload.end_date,
                tender_type: 'materials',
                parent_tender_id: createdMainId,
              }
              const { res: matRes, finalPayload: matFinalPayload } = await insertTenderWithRetry(materialsPayload)
              if (matRes.error) {
                console.error('Не удалось автоматически создать тендер на материалы:', matRes.error.message)
                alert('Тендер создан, но автосоздание тендера на материалы не удалось: ' + matRes.error.message)
              } else if (matRes.data?.id) {
                await logTenderEvent(matRes.data.id, 'created', {
                  newValue: matFinalPayload,
                  description: 'Тендер на материалы создан автоматически'
                })
              }
            } catch (matErr) {
              console.error('Ошибка автосоздания тендера на материалы:', matErr.message)
              alert('Ошибка автосоздания тендера на материалы: ' + matErr.message)
            }
          }
        }
      }

      setShowModal(false)
      setEditingTender(null)
      setMaterialsParentTender(null)
      setFormData({
        object_id: '',
        work_description: '',
        status: initialStatusValue,
        start_date: '',
        end_date: '',
        tender_package_link: '',
        responsible_contact_id: '',
        cost_plan_link: '',
        cost_plan_responsible_id: '',
        vor_link: '',
        vor_responsible_id: '',
        vor_start_date: '',
        vor_end_date: '',
        tender_start_date: '',
        tender_end_date: '',
        summary_proposal_link: '',
        notes: '',
      })
      fetchTenders()
    } catch (error) {
      console.error('Ошибка сохранения тендера:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditTender = (tender) => {
    setEditingTender(tender)
    setFormData({
      object_id: tender.object_id || '',
      work_description: tender.work_description,
      status: tender.status,
      start_date: tender.start_date || '',
      end_date: tender.end_date || '',
      tender_package_link: tender.tender_package_link || '',
      responsible_contact_id: tender.responsible_contact_id || '',
      cost_plan_link: tender.cost_plan_link || '',
      cost_plan_responsible_id: tender.cost_plan_responsible_id || '',
      vor_link: tender.vor_link || '',
      vor_responsible_id: tender.vor_responsible_id || '',
      vor_start_date: tender.vor_start_date || '',
      vor_end_date: tender.vor_end_date || '',
      tender_start_date: tender.tender_start_date || '',
      tender_end_date: tender.tender_end_date || '',
      summary_proposal_link: tender.summary_proposal_link || '',
      notes: tender.notes || '',
    })
    setShowModal(true)
  }

  // Мягкое удаление: тендер уходит во вкладку «Удалённые» и может быть восстановлен.
  const handleDeleteTender = async (id, objectName) => {
    if (!isAdmin) {
      alert('Удалять тендеры может только администратор.')
      return
    }
    if (
      window.confirm(`Переместить тендер "${objectName}" в «Удалённые»? Его можно будет восстановить.`)
    ) {
      try {
        const delAt = new Date().toISOString()
        const { error } = await supabase
          .from('tenders')
          .update({ deleted_at: delAt })
          .eq('id', id)
        if (error) throw error
        // task 267: дочерние тендеры на материалы тоже уходят в «Удалённые»
        const { error: childErr } = await supabase
          .from('tenders')
          .update({ deleted_at: delAt })
          .eq('parent_tender_id', id)
        if (childErr) console.error('Не удалось удалить связанный тендер на материалы:', childErr.message)
        fetchTenders()
      } catch (error) {
        console.error('Ошибка удаления тендера:', error.message)
        alert('Ошибка удаления: ' + error.message)
      }
    }
  }

  const handleRestoreTender = async (id, objectName) => {
    if (!window.confirm(`Восстановить тендер "${objectName}"?`)) return
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      // task 267: восстанавливаем и связанный тендер на материалы
      const { error: childErr } = await supabase
        .from('tenders')
        .update({ deleted_at: null })
        .eq('parent_tender_id', id)
      if (childErr) console.error('Не удалось восстановить связанный тендер на материалы:', childErr.message)
      fetchTenders()
    } catch (err) {
      console.error('Ошибка восстановления тендера:', err.message)
      alert('Ошибка восстановления: ' + err.message)
    }
  }

  const handleHardDeleteTender = async (id, objectName) => {
    if (!isAdmin) {
      alert('Удалять тендеры может только администратор.')
      return
    }
    if (!window.confirm(`Удалить тендер "${objectName}" БЕЗВОЗВРАТНО? Это действие нельзя отменить.`)) return
    try {
      const { error } = await supabase.from('tenders').delete().eq('id', id)
      if (error) throw error
      fetchTenders()
    } catch (err) {
      console.error('Ошибка безвозвратного удаления:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleAddNew = () => {
    setEditingTender(null)
    setMaterialsParentTender(null)
    setFormData({
      object_id: '',
      work_description: '',
      status: initialStatusValue,
      start_date: '',
      end_date: '',
      tender_package_link: '',
      responsible_contact_id: '',
      cost_plan_link: '',
      cost_plan_responsible_id: '',
      vor_link: '',
      vor_responsible_id: '',
      vor_start_date: '',
      vor_end_date: '',
      tender_start_date: '',
      tender_end_date: '',
      summary_proposal_link: '',
      notes: '',
    })
    setShowModal(true)
  }

  // Открыть форму создания дочернего тендера на материалы для конкретного родительского тендера

  const handleStatusChange = async (tenderId, newStatus) => {
    // Для тендеров на материалы выбор победителя не требуется — статус ставится напрямую.
    // Для основных тендеров при переходе в «Завершен» открываем модал выбора победителя.
    if (!isMaterialsView && newStatus === 'Завершен') {
      const tender = tenders.find(t => t.id === tenderId)
      setTenderForWinnerSelection(tender)

      // Загружаем контрагентов тендера если еще не загружены
      if (!tenderCounterparties[tenderId]) {
        await fetchTenderCounterparties(tenderId)
      }

      const existingWinners = (tender?.tender_winners || []).map(w => ({
        counterparty_id: w.counterparty_id,
        scope_note: w.scope_note || ''
      }))
      // подстраховка, если миграция tender_winners ещё не применена
      if (existingWinners.length === 0 && tender?.winner_counterparty_id) {
        existingWinners.push({ counterparty_id: tender.winner_counterparty_id, scope_note: '' })
      }
      setSelectedWinners(existingWinners)
      setShowWinnerModal(true)
      return
    }

    try {
      const prev = tenders.find(t => t.id === tenderId)
      const oldStatus = prev?.status || null

      const { error } = await supabase
        .from('tenders')
        .update({ status: newStatus })
        .eq('id', tenderId)

      if (error) throw error

      if (oldStatus !== newStatus) {
        await logTenderEvent(tenderId, 'status_changed', {
          oldValue: oldStatus,
          newValue: newStatus,
          description: `Статус: ${oldStatus || '—'} → ${newStatus}`
        })
      }

      fetchTenders()
    } catch (error) {
      console.error('Ошибка изменения статуса:', error.message)
      alert('Ошибка изменения статуса: ' + error.message)
    }
  }

  // task 215: помощники для выбора нескольких победителей
  const isWinnerSelected = (cpId) => selectedWinners.some(w => w.counterparty_id === cpId)
  const toggleWinner = (cpId) => setSelectedWinners(prev =>
    prev.some(w => w.counterparty_id === cpId)
      ? prev.filter(w => w.counterparty_id !== cpId)
      : [...prev, { counterparty_id: cpId, scope_note: '' }]
  )
  const setWinnerScope = (cpId, note) => setSelectedWinners(prev =>
    prev.map(w => w.counterparty_id === cpId ? { ...w, scope_note: note } : w)
  )
  const getWinnerScope = (cpId) => selectedWinners.find(w => w.counterparty_id === cpId)?.scope_note || ''

  // task 215: список победителей тендера для отображения (с откатом на одиночного winner)
  const getTenderWinners = (tender) => {
    const tw = tender?.tender_winners || []
    if (tw.length > 0) {
      return tw.map(w => ({
        id: w.counterparty_id,
        name: w.counterparties?.name || '—',
        scope: w.scope_note || ''
      }))
    }
    if (tender?.winner) {
      return [{ id: tender.winner.id, name: tender.winner.name, scope: '' }]
    }
    return []
  }

  const handleConfirmWinner = async () => {
    if (!tenderForWinnerSelection) return

    try {
      const prevStatus = tenderForWinnerSelection.status || null
      // основной победитель (первый выбранный) — для обратной совместимости
      const primaryWinnerId = selectedWinners[0]?.counterparty_id || null

      // Обновляем статус тендера и основного победителя
      const { error: tenderError } = await supabase
        .from('tenders')
        .update({
          status: 'Завершен',
          winner_counterparty_id: primaryWinnerId
        })
        .eq('id', tenderForWinnerSelection.id)

      if (tenderError) throw tenderError

      // Пересобираем список победителей в junction-таблице
      const { error: delError } = await supabase
        .from('tender_winners')
        .delete()
        .eq('tender_id', tenderForWinnerSelection.id)
      if (delError) throw delError

      if (selectedWinners.length > 0) {
        const { error: insError } = await supabase
          .from('tender_winners')
          .insert(selectedWinners.map(w => ({
            tender_id: tenderForWinnerSelection.id,
            counterparty_id: w.counterparty_id,
            scope_note: w.scope_note?.trim() || null
          })))
        if (insError) throw insError
      }

      // Лог: смена статуса
      if (prevStatus !== 'Завершен') {
        await logTenderEvent(tenderForWinnerSelection.id, 'status_changed', {
          oldValue: prevStatus,
          newValue: 'Завершен',
          description: `Статус: ${prevStatus || '—'} → Завершен`
        })
      }

      // Лог: назначение победителей
      if (selectedWinners.length > 0) {
        const tcList = tenderCounterparties[tenderForWinnerSelection.id] || []
        const nameOf = (cpId) => tcList.find(tc => tc.counterparties?.id === cpId)?.counterparties?.name || null
        const winnerNames = selectedWinners
          .map(w => {
            const nm = nameOf(w.counterparty_id) || '—'
            return w.scope_note?.trim() ? `${nm} (${w.scope_note.trim()})` : nm
          })
          .join(', ')
        await logTenderEvent(tenderForWinnerSelection.id, 'winner_assigned', {
          oldValue: tenderForWinnerSelection.winner_counterparty_id || null,
          newValue: { winners: selectedWinners },
          description: `Назначены победители: ${winnerNames}`
        })
      }

      // Создаём проект договора на каждого победителя
      if (selectedWinners.length > 0) {
        const today = new Date().toISOString().split('T')[0]
        const contractRows = selectedWinners.map((w, i) => ({
          tender_id: tenderForWinnerSelection.id,
          counterparty_id: w.counterparty_id,
          object_id: tenderForWinnerSelection.object_id,
          contract_number: `Проект-${Date.now()}-${i + 1}`,
          contract_date: today,
          contract_amount: 0,
          status: 'pending'
        }))

        const { error: contractError } = await supabase
          .from('contracts')
          .insert(contractRows)

        if (contractError) {
          console.error('Ошибка создания договоров:', contractError.message)
          // Не прерываем выполнение, тендер уже завершен
        }
      }

      setShowWinnerModal(false)
      setTenderForWinnerSelection(null)
      setSelectedWinners([])
      fetchTenders()
    } catch (error) {
      console.error('Ошибка завершения тендера:', error.message)
      alert('Ошибка завершения тендера: ' + error.message)
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return ''
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const formatDateRange = (startDate, endDate) => {
    if (!startDate && !endDate) return '—'
    if (!startDate) return formatDate(endDate)
    if (!endDate) return formatDate(startDate)
    const start = new Date(startDate)
    const end = new Date(endDate)
    const sameYear = start.getFullYear() === end.getFullYear()
    const dd = (d) => String(d.getDate()).padStart(2, '0')
    const mm = (d) => String(d.getMonth() + 1).padStart(2, '0')
    if (sameYear) {
      return `${dd(start)}.${mm(start)} — ${dd(end)}.${mm(end)}.${end.getFullYear()}`
    }
    return `${formatDate(startDate)} — ${formatDate(endDate)}`
  }

  const FIELD_LABELS = {
    work_description: 'Описание работ',
    start_date: 'Дата начала работ',
    end_date: 'Дата окончания работ',
    vor_start_date: 'Начало подготовки ВОР',
    vor_end_date: 'Окончание подготовки ВОР',
    tender_start_date: 'Начало тендерной процедуры',
    tender_end_date: 'Окончание тендерной процедуры',
    tender_package_link: 'Ссылка на тендерный пакет',
    responsible_contact_id: 'Ответственный',
    object_id: 'Объект',
    cost_plan_link: 'План затрат',
    cost_plan_responsible_id: 'Ответственный за план затрат',
    vor_link: 'ВОРы и РД',
    vor_responsible_id: 'Ответственный за ВОРы и РД',
    summary_proposal_link: 'Сводная КП',
    notes: 'Примечание'
  }

  const logTenderEvent = async (tenderId, eventType, payload = {}) => {
    if (!tenderId || !eventType) return
    try {
      const role = localStorage.getItem('userRole') || null
      await supabase.from('tender_audit_log').insert([{
        tender_id: tenderId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])
    } catch (err) {
      console.error('Ошибка записи истории тендера:', err.message)
    }
  }

  const formatDateForLetter = (dateString) => {
    if (!dateString) return ''
    const date = new Date(dateString)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}.${month}.${year}`
  }

  const generateRequestLetter = (tenderData, objectName, employee) => {
    const replacements = {
      '{work_description}': tenderData.work_description || '[Описание работ]',
      '{object_name}': objectName || '[Объект не указан]',
      '{start_date}': formatDateForLetter(tenderData.start_date),
      '{end_date}': formatDateForLetter(tenderData.end_date),
      '{employee_name}': employee?.full_name || '[ФИО не указано]',
      '{employee_position}': employee?.position || 'Сотрудник отдела сопровождения подрядчиков',
      '{employee_phone}': employee?.phone || '[Телефон не указан]',
      '{employee_email}': employee?.email || '[Email не указан]',
      '{tender_package_link}': tenderData.tender_package_link || '[Ссылка не указана]'
    }

    let result = letterTemplate
    for (const [key, value] of Object.entries(replacements)) {
      result = result.replaceAll(key, value)
    }
    return result
  }

  const handleSaveTemplate = () => {
    localStorage.setItem('letterTemplate', letterTemplate)
    setTemplateSaved(true)
    setTimeout(() => setTemplateSaved(false), 2000)
  }

  const handleResetTemplate = () => {
    if (window.confirm('Вернуть шаблон по умолчанию?')) {
      setLetterTemplate(DEFAULT_LETTER_TEMPLATE)
      localStorage.setItem('letterTemplate', DEFAULT_LETTER_TEMPLATE)
    }
  }

  const handleCopyLetter = async () => {
    const ok = await copyToClipboard(generatedLetter)
    if (ok) {
      setLetterCopied(true)
      setTimeout(() => setLetterCopied(false), 2000)
    } else {
      alert('Не удалось скопировать текст')
    }
  }

  const getStatusBadgeClass = (status) => {
    const statusClasses = {
      'Заявка на тендер': 'status-not-started',
      'Подготовка ВОР': 'status-waiting-vor',
      'Идет тендерная процедура': 'status-in-progress',
      'Подведение итогов': 'status-summarizing',
      'Завершен': 'status-completed',
      'Приостановка тендера': 'status-suspended',
      // Статусы тендеров на материалы
      'Не начат': 'status-not-started',
      'В работе': 'status-in-progress',
      'Завершён': 'status-completed',
      'Не требуется': 'status-suspended',
      'Не нужно': 'status-suspended', // legacy
      // legacy fallbacks (на случай несмигрированных данных)
      'Ожидание ВОР': 'status-waiting-vor',
      'Принято в работу': 'status-completed',
    }
    return statusClasses[status] || 'status-not-started'
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  // Фильтрация тендеров по вкладке и объекту
  const filteredByTab = tenders.filter(tender => {
    // task 212: Фильтр по вкладке — 'all' | <конкретный статус> | 'deleted'
    if (activeTab === 'deleted') {
      if (!tender.deleted_at) return false
    } else if (activeTab === 'all') {
      if (tender.deleted_at) return false
    } else {
      // вкладка конкретного статуса
      if (tender.deleted_at) return false
      if (tender.status !== activeTab) return false
    }
    // Фильтр по объекту
    if (objectFilter && tender.object_id !== objectFilter) return false
    // Фильтр по ответственному
    if (responsibleFilter === '__unassigned__') {
      if (tender.responsible_contact_id) return false
    } else if (responsibleFilter && tender.responsible_contact_id !== responsibleFilter) {
      return false
    }
    // Фильтр по статусу
    if (statusFilter && tender.status !== statusFilter) return false
    // Текстовый поиск по наименованию объекта, адресу и описанию работ
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      const haystack = [
        tender.objects?.name,
        tender.objects?.address,
        tender.work_description,
      ].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  // Сортировка по выбранному полю
  const statusOrder = Object.fromEntries(currentStatusOptions.map((s, i) => [s, i]))
  const sortedTenders = [...filteredByTab].sort((a, b) => {
    let av, bv
    if (sortField === 'status') {
      av = statusOrder[a.status] ?? 999
      bv = statusOrder[b.status] ?? 999
    } else {
      av = a[sortField] || ''
      bv = b[sortField] || ''
    }
    if (av === bv) return 0
    if (av === '' || av === null || av === undefined) return 1
    if (bv === '' || bv === null || bv === undefined) return -1
    return sortOrder === 'asc' ? (av > bv ? 1 : -1) : (av > bv ? -1 : 1)
  })

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      // По номеру тендера логичнее восходящая (1, 2, 3...), по датам — нисходящая (свежие сверху).
      setSortOrder(field === 'public_tender_number' ? 'asc' : 'desc')
    }
  }

  const sortIndicator = (field) => {
    if (sortField !== field) return ' ↕'
    return sortOrder === 'asc' ? ' ↑' : ' ↓'
  }

  // task 212: счётчики — «Все» + по каждому статусу + «Удалённые»
  const allTendersCount = tenders.filter(t => !t.deleted_at).length
  const statusCounts = Object.fromEntries(
    currentStatusOptions.map(s => [s, tenders.filter(t => !t.deleted_at && t.status === s).length])
  )
  const deletedTendersCount = tenders.filter(t => t.deleted_at).length

  // task 212: «завершённая» вкладка — когда активен таб статуса, считающегося завершённым
  const isCompletedTab = activeTab !== 'all'
    && activeTab !== 'deleted'
    && activeTab !== 'template'
    && isCompletedStatus(activeTab)

  // Проверка просроченности
  const today = new Date().toISOString().split('T')[0]
  const isOverdue = (tender) => tender.tender_end_date && tender.tender_end_date < today && !isCompletedStatus(tender.status)

  // Уникальные объекты из тендеров для фильтра
  const tenderObjectIds = [...new Set(tenders.map(t => t.object_id).filter(Boolean))]
  const tenderObjects = objects.filter(o => tenderObjectIds.includes(o.id))

  return (
    <div className="tenders-page">
      <div className="page-header page-header-tenders">
        <h2><span className="page-icon" aria-hidden>📋</span> {pageTitle}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {!isMaterialsView && (
            <button
              type="button"
              className={`btn-view-toggle ${activeTab === 'template' ? 'active' : ''}`}
              onClick={() => setActiveTab(activeTab === 'template' ? 'all' : 'template')}
              title="Шаблон письма для запроса КП"
            >
              <span aria-hidden style={{ fontSize: '0.875rem' }}>✉️</span>
              <span>Шаблон письма</span>
            </button>
          )}
          {!isMaterialsView && (
            <button
              type="button"
              className={`btn-view-toggle ${compactView ? 'active' : ''}`}
              onClick={() => setCompactView(v => !v)}
              title={compactView
                ? 'Показать все столбцы'
                : 'Скрыть столбцы: ВОРы и РД, План затрат, Тендер на материалы, Сводная КП'}
            >
              <span aria-hidden style={{ fontSize: '0.875rem' }}>{compactView ? '⊞' : '⊟'}</span>
              <span>{compactView ? 'Все столбцы' : 'Компактный вид'}</span>
            </button>
          )}
          <button className="btn-primary" onClick={handleAddNew}>
            + Добавить тендер
          </button>
        </div>
      </div>

      {/* task 212: Вкладки — «Все тендеры» + по каждому статусу + Шаблон + Удалённые */}
      <div className={`tender-tabs${isMaterialsView ? ' tender-tabs--simple' : ''}`}>
        <button
          className={`tender-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все тендеры
          {allTendersCount > 0 && (
            <span className="tender-tab-count">{allTendersCount}</span>
          )}
        </button>
        {(() => {
          const statusActive = currentStatusOptions.includes(activeTab)
          return (
            <>
              <button
                type="button"
                className={`tender-tab tender-tab-status-toggle ${statusActive ? 'active' : ''} ${statusMenuOpen ? 'open' : ''}`}
                onClick={() => setStatusMenuOpen(o => !o)}
                aria-expanded={statusMenuOpen}
                title="Развернуть/свернуть статусы тендеров"
              >
                Статусы тендеров
                <span className="tender-tab-chevron" aria-hidden>▸</span>
              </button>
              {statusMenuOpen && currentStatusOptions.map(s => (
                <button
                  key={s}
                  className={`tender-tab tender-tab-status ${activeTab === s ? 'active' : ''}`}
                  onClick={() => setActiveTab(s)}
                >
                  {s}
                  {statusCounts[s] > 0 && (
                    <span className={`tender-tab-count ${isCompletedStatus(s) ? 'completed' : ''}`}>
                      {statusCounts[s]}
                    </span>
                  )}
                </button>
              ))}
            </>
          )
        })()}
        {/* task 242: «Шаблон письма» перенесён в шапку (справа сверху) */}
        {/* task 194: «Удалённые» — в самой правой части */}
        <button
          className={`tender-tab tender-tab-deleted ${activeTab === 'deleted' ? 'active' : ''}`}
          onClick={() => setActiveTab('deleted')}
        >
          Удалённые
          {deletedTendersCount > 0 && (
            <span className="tender-tab-count">{deletedTendersCount}</span>
          )}
        </button>
      </div>

      {/* Фильтры и таблица (скрываем на вкладке шаблона) */}
      {activeTab !== 'template' && (<>
      <div style={{ padding: '0.5rem 0', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '1 1 240px', minWidth: '200px', maxWidth: '360px' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по объекту, адресу, описанию работ…"
            style={{
              width: '100%',
              padding: '0.375rem 0.625rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>Объект:</span>
          <select
            value={objectFilter}
            onChange={(e) => setObjectFilter(e.target.value)}
            style={{
              padding: '0.375rem 1.5rem 0.375rem 0.5rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 0.375rem center'
            }}
          >
            <option value="">🏢 Все объекты</option>
            {tenderObjects.map(obj => (
              <option key={obj.id} value={obj.id}>{obj.name}</option>
            ))}
          </select>
        </div>

        {/* task 212: фильтр по статусу нужен только на вкладке «Все тендеры» —
            на вкладке конкретного статуса список уже отфильтрован */}
        {activeTab === 'all' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>Статус:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '0.375rem 1.5rem 0.375rem 0.5rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 0.375rem center'
            }}
          >
            <option value="">🏷 Все статусы</option>
            {currentStatusOptions.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>Ответственный:</span>
          <select
            value={responsibleFilter}
            onChange={(e) => setResponsibleFilter(e.target.value)}
            style={{
              padding: '0.375rem 1.5rem 0.375rem 0.5rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 0.375rem center'
            }}
          >
            <option value="">👤 Все ответственные</option>
            <option value="__unassigned__">— Не назначен —</option>
            {responsibleContacts
              .filter(c => tenders.some(t => t.responsible_contact_id === c.id))
              .map(c => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
          </select>
        </div>

        {(objectFilter || responsibleFilter || statusFilter || searchQuery) && (
          <button
            onClick={() => { setObjectFilter(''); setResponsibleFilter(''); setStatusFilter(''); setSearchQuery('') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
          >
            Сбросить все
          </button>
        )}
      </div>

      <div className="table-container">
        <table className={`data-table ${compactView ? 'data-table--compact' : ''}`}>
          {isMaterialsView ? (
            <>
              <thead>
                <tr>
                  <th
                    className="sortable-th"
                    style={{ width: '52px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => toggleSort('public_tender_number')}
                    title="Номер тендера. Кликните для сортировки"
                  >
                    №{sortIndicator('public_tender_number')}
                  </th>
                  <th style={{ width: '130px', textAlign: 'center' }}>Объект</th>
                  <th style={{ width: '170px', textAlign: 'center' }}>Описание работ</th>
                  <th style={{ width: '160px' }}>Ответственный</th>
                  <th
                    className="sortable-th"
                    onClick={() => toggleSort('materials_proposal_deadline')}
                    title="Сортировать по сроку"
                    style={{ width: '110px', textAlign: 'center' }}
                  >
                    Срок предоставления<br />КП на материалы{sortIndicator('materials_proposal_deadline')}
                  </th>
                  <th style={{ width: '140px' }}>Ссылка на КП</th>
                  <th style={{ width: '140px' }}>Статус</th>
                  <th className="actions-column" style={{ width: '90px' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {sortedTenders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="no-data">
                      {activeTab === 'deleted'
                        ? 'В корзине нет тендеров на материалы'
                        : activeTab === 'all'
                          ? 'Нет тендеров на материалы. Они создаются автоматически вместе с основным тендером, либо через «+ Добавить тендер».'
                          : `Нет тендеров на материалы со статусом «${activeTab}»`}
                    </td>
                  </tr>
                ) : (
                  sortedTenders.map((tender) => (
                    <tr key={tender.id} className={isOverdue(tender) ? 'overdue-row' : ''}>
                      <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {tender.public_tender_number ?? '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {tender.objects?.name || '-'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {tender.parent_tender_id ? (
                          <Link
                            to={`/tenders/${tender.parent_tender_id}`}
                            className="row-link primary"
                            title="Открыть тендер основного строительства (Ctrl+клик или средняя кнопка — в новой вкладке)"
                            style={{ fontSize: '0.75rem', textAlign: 'center', display: 'inline-block', color: 'var(--primary-color)', textDecoration: 'underline' }}
                          >
                            {tender.work_description}
                          </Link>
                        ) : (
                          <span style={{ fontSize: '0.75rem' }}>{tender.work_description}</span>
                        )}
                      </td>
                      <td>
                        {editingResponsibleTenderId === tender.id ? (
                          <select
                            autoFocus
                            className="inline-responsible-select"
                            value={tender.responsible_contact_id || ''}
                            onChange={(e) => { handleUpdateTenderResponsible(tender.id, e.target.value); setEditingResponsibleTenderId(null) }}
                            onBlur={() => setEditingResponsibleTenderId(null)}
                          >
                            <option value="">— не назначен —</option>
                            {responsibleContacts.map(c => (
                              <option key={c.id} value={c.id}>{c.full_name}</option>
                            ))}
                          </select>
                        ) : (
                          <button
                            className="responsible-display"
                            onClick={() => setEditingResponsibleTenderId(tender.id)}
                            title="Назначить ответственного"
                          >
                            {tender.responsible_contact?.full_name || (
                              <span className="responsible-empty">— не назначен —</span>
                            )}
                          </button>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="date"
                          value={tender.materials_proposal_deadline || ''}
                          onChange={(e) => handleUpdateMaterialsDeadline(tender.id, e.target.value)}
                          style={{
                            width: '100%',
                            padding: '0.25rem 0.375rem',
                            fontSize: '0.75rem',
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td>
                        {tender.materials_proposal_link ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                            <a
                              href={tender.materials_proposal_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            <button
                              className="btn-icon btn-edit"
                              onClick={() => handleUpdateMaterialsLink(tender.id, tender.materials_proposal_link)}
                              title="Изменить ссылку"
                              style={{ fontSize: '0.75rem' }}
                            >
                              ✏️
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleUpdateMaterialsLink(tender.id, '')}
                            style={{
                              background: 'none',
                              border: '1px dashed var(--border-color)',
                              borderRadius: '4px',
                              padding: '0.1875rem 0.5rem',
                              color: 'var(--text-tertiary)',
                              cursor: 'pointer',
                              fontSize: '0.75rem'
                            }}
                            title="Добавить ссылку на КП"
                          >
                            + ссылка
                          </button>
                        )}
                      </td>
                      <td>
                        {isCompletedTab ? (
                          <span className={`status-badge ${getStatusBadgeClass(tender.status)}`} style={{ display: 'inline-block', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                            {tender.status}
                          </span>
                        ) : (
                          <StatusDropdown
                            value={tender.status}
                            options={materialsStatusOptions}
                            onChange={(next) => handleStatusChange(tender.id, next)}
                            getBadgeClass={getStatusBadgeClass}
                            ariaLabel="Статус тендера"
                          />
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'center' }}>
                          {/* task 246 (исправление): в тендер на материалы нельзя «заходить внутрь» —
                              кнопка открытия его собственной карточки убрана */}
                          {activeTab === 'deleted' ? (
                            <>
                              <button
                                className="btn-icon"
                                onClick={() => handleRestoreTender(tender.id, tender.objects?.name)}
                                title="Восстановить"
                              >
                                ♻️
                              </button>
                              {isAdmin && (
                                <button
                                  className="btn-icon btn-delete"
                                  onClick={() => handleHardDeleteTender(tender.id, tender.objects?.name)}
                                  title="Удалить безвозвратно (только для администратора)"
                                >
                                  🗑️
                                </button>
                              )}
                            </>
                          ) : (
                            isAdmin && (
                              <button
                                className="btn-icon btn-delete"
                                onClick={() => handleDeleteTender(tender.id, tender.objects?.name)}
                                title="Переместить в Корзину (только для администратора)"
                              >
                                🗑️
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </>
          ) : (
          <>
          <thead>
            <tr>
              <th
                className="sortable-th"
                style={{ width: '44px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => toggleSort('public_tender_number')}
                title="Номер тендера. Кликните для сортировки"
              >
                №{sortIndicator('public_tender_number')}
              </th>
              <th style={{ width: '36px' }}></th>
              <th style={{ minWidth: '160px' }}>Наименование<br />объекта</th>
              <th style={{ minWidth: '140px', maxWidth: '220px' }}>Описание работ</th>
              {activeTab !== 'completed' && <th style={{ width: '100px' }}>Статус</th>}
              {isCompletedTab && <th style={{ width: '130px' }}>Победитель</th>}
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_start_date')}
                title="Сортировать по срокам тендерных процедур"
                style={{ width: '150px' }}
              >
                Срок проведения<br />тендерных процедур{sortIndicator('tender_start_date')}
              </th>
              <th style={{ width: '130px' }}>Ответственный<br />по тендеру</th>
              {!compactView && department === 'construction' && (
                <th style={{ width: '90px' }}>ВОРы<br />и&nbsp;РД</th>
              )}
              <th style={{ width: '105px' }}>Тендерный<br />пакет</th>
              {!compactView && department === 'construction' && activeTab !== 'completed' && (
                <th style={{ width: '95px' }}>План<br />затрат</th>
              )}
              {!compactView && !isMaterialsView && department === 'construction' && (
                <th style={{ width: '105px' }}>Тендер<br />на&nbsp;материалы</th>
              )}
              {!compactView && <th style={{ width: '105px' }}>Сводная<br />КП</th>}
              <th className="actions-column" style={{ width: '72px' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {sortedTenders.length === 0 ? (
              <tr>
                <td colSpan={compactView ? 9 : (isCompletedTab ? (!isMaterialsView && department === 'construction' ? 12 : 10) : (isMaterialsView ? 10 : (department === 'construction' ? 13 : 10)))} className="no-data">
                  {activeTab === 'deleted'
                    ? 'В корзине нет тендеров'
                    : activeTab === 'all'
                      ? 'Нет тендеров. Добавьте первый тендер.'
                      : `Нет тендеров со статусом «${activeTab}»`}
                </td>
              </tr>
            ) : (
              sortedTenders.map((tender) => (
                <React.Fragment key={tender.id}>
                  <tr className={isOverdue(tender) ? 'overdue-row' : ''}>
                    <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {tender.public_tender_number ?? '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem' }}>
                        <button
                          onClick={() => handleToggleTender(tender.id)}
                          className={`expand-toggle${expandedTenderId === tender.id ? ' is-expanded' : ''}`}
                          title="Показать контрагентов"
                          aria-expanded={expandedTenderId === tender.id}
                        >
                          <span className="expand-toggle-chevron" aria-hidden>›</span>
                        </button>
                        {(() => {
                          const c = tenderProposalCounts[tender.id]
                          if (!c || c.total === 0) return null
                          const all = c.proposalProvided === c.total
                          return (
                            <span
                              className={`kp-counter ${all ? 'kp-counter-full' : ''}`}
                              title={`КП предоставлено: ${c.proposalProvided} из ${c.total} контрагентов`}
                            >
                              {c.proposalProvided}/{c.total} КП
                            </span>
                          )
                        })()}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                        {tender.object_id ? (
                          <Link
                            to={`/general/objects/${tender.object_id}`}
                            className="row-link primary"
                            title="Открыть карточку объекта (Ctrl+клик или средняя кнопка — в новой вкладке)"
                          >
                            {tender.objects?.name || '-'}
                          </Link>
                        ) : (
                          <span className="row-link primary" style={{ cursor: 'default' }}>{tender.objects?.name || '-'}</span>
                        )}
                        {tender.objects?.address && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>
                            {tender.objects.address}
                          </div>
                        )}
                        {tender.objects?.map_link && (
                          <a
                            href={tender.objects.map_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Открыть в Яндекс.Картах"
                            className="yandex-map-link"
                          >
                            <span aria-hidden>🗺️</span>
                            <span>Месторасположение</span>
                          </a>
                        )}
                      </div>
                    </td>
                    <td>
                      <Link
                        to={`/tenders/${tender.id}`}
                        className="row-link primary"
                        title="Открыть тендер (Ctrl+клик или средняя кнопка — в новой вкладке)"
                        style={{ color: 'var(--primary-color)', textDecoration: 'underline' }}
                      >
                        {tender.work_description}
                      </Link>
                    </td>
                    {activeTab !== 'completed' && (
                      <td>
                        <StatusDropdown
                          value={tender.status}
                          options={statusOptions}
                          onChange={(next) => handleStatusChange(tender.id, next)}
                          getBadgeClass={getStatusBadgeClass}
                          getDisplay={(s) =>
                            s === 'Идет тендерная процедура'
                              ? <>Идет тендерная<br />процедура</>
                              : s
                          }
                          ariaLabel="Статус тендера"
                        />
                      </td>
                    )}
                    {isCompletedTab && (
                      <td>
                        {(() => {
                          const winners = getTenderWinners(tender)
                          if (winners.length === 0) {
                            return (
                              <span style={{
                                color: 'var(--text-tertiary)',
                                fontStyle: 'italic',
                                fontSize: '0.8125rem'
                              }}>
                                Не выбран
                              </span>
                            )
                          }
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              {winners.map(w => (
                                <span key={w.id} className="winner-cell" title="Победитель">
                                  <span className="winner-icon" aria-hidden>🏆</span>
                                  <span className="winner-name">
                                    {w.name}
                                    {w.scope && (
                                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                                        {' '}— {w.scope}
                                      </span>
                                    )}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )
                        })()}
                      </td>
                    )}
                    <td style={isOverdue(tender) ? { color: '#dc2626', fontWeight: 600, whiteSpace: 'nowrap' } : { whiteSpace: 'nowrap' }}>
                      {formatDateRange(tender.tender_start_date, tender.tender_end_date)}
                      {isOverdue(tender) && <span style={{ marginLeft: '0.375rem', fontSize: '0.75rem' }} title="Срок истёк">!</span>}
                    </td>
                    <td>
                      {editingResponsibleTenderId === tender.id ? (
                        <select
                          autoFocus
                          className="inline-responsible-select"
                          value={tender.responsible_contact_id || ''}
                          onChange={(e) => {
                            handleUpdateTenderResponsible(tender.id, e.target.value)
                            setEditingResponsibleTenderId(null)
                          }}
                          onBlur={() => setEditingResponsibleTenderId(null)}
                        >
                          <option value="">— не назначен —</option>
                          {responsibleContacts.map((contact) => (
                            <option key={contact.id} value={contact.id}>
                              {contact.full_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          className="responsible-display"
                          onClick={() => setEditingResponsibleTenderId(tender.id)}
                          title="Назначить ответственного"
                        >
                          {getResponsibleName(tender) || (
                            <span className="responsible-empty">— не назначен —</span>
                          )}
                        </button>
                      )}
                    </td>
                    {/* ВОРы и РД */}
                    {!compactView && department === 'construction' && (
                      <td>
                        <div className="phase-cell">
                          {(() => {
                            const s = tender.vor_status || 'not_started'
                            if (s === 'completed') {
                              return tender.vor_link
                                ? <span className="phase-done" title="ВОР готов">✓ Готово</span>
                                : <span className="phase-warn" title="Статус «Завершён», но ссылка не указана">⚠ Нет ссылки</span>
                            }
                            if (s === 'in_progress') {
                              return <span className="phase-progress" title="В работе">В работе</span>
                            }
                            return <span className="phase-pending" title="Не начат">Не начат</span>
                          })()}
                          {tender.vor_link && (
                            <a
                              href={tender.vor_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                          )}
                        </div>
                        {tender.vor_responsible?.full_name && (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                            {tender.vor_responsible.full_name}
                          </div>
                        )}
                      </td>
                    )}
                    {/* Тендерный пакет */}
                    <td>
                        {tender.tender_package_link ? (
                          <div className="link-with-edit">
                            <a
                              href={tender.tender_package_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            <button
                              className="btn-icon btn-edit"
                              onClick={() => handleUpdateTenderLink(tender.id, 'tender_package_link', tender.tender_package_link)}
                              title="Изменить ссылку"
                              style={{ fontSize: '0.75rem' }}
                            >✏️</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleUpdateTenderLink(tender.id, 'tender_package_link', '')}
                            style={{
                              background: 'none',
                              border: '1px dashed var(--border-color)',
                              borderRadius: '4px',
                              padding: '0.1875rem 0.5rem',
                              color: 'var(--text-tertiary)',
                              cursor: 'pointer',
                              fontSize: '0.75rem'
                            }}
                            title="Добавить ссылку на тендерный пакет"
                          >+ ссылка</button>
                        )}
                      </td>
                    {/* План затрат */}
                    {!compactView && department === 'construction' && activeTab !== 'completed' && (
                      <td>
                        <div className="phase-cell">
                          {(() => {
                            const s = tender.cost_plan_status || 'not_started'
                            if (s === 'not_required') {
                              return <span className="phase-done" title="План затрат не требуется">— Не требуется</span>
                            }
                            if (s === 'completed') {
                              return tender.cost_plan_link
                                ? <span className="phase-done" title="План затрат готов">✓ Готово</span>
                                : <span className="phase-warn" title="Статус «Завершён», но ссылка не указана">⚠ Нет ссылки</span>
                            }
                            if (s === 'in_progress') {
                              return <span className="phase-progress" title="В работе">В работе</span>
                            }
                            return <span className="phase-pending" title="Не начат">Не начат</span>
                          })()}
                          {tender.cost_plan_link && (
                            <a
                              href={tender.cost_plan_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                          )}
                        </div>
                        {tender.cost_plan_responsible?.full_name && (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                            {tender.cost_plan_responsible.full_name}
                          </div>
                        )}
                      </td>
                    )}
                    {/* Тендер на материалы (дочерний) — только в основном строительстве */}
                    {!compactView && !isMaterialsView && department === 'construction' && (
                      <td>
                        {tender.materials_tender ? (
                          <div className="phase-cell">
                            {(() => {
                              const s = tender.materials_tender.status
                              if (s === 'Завершён' || s === 'Завершен') {
                                return <span className="phase-done" title="Тендер на материалы завершён">✓ Завершён</span>
                              }
                              if (s === 'В работе') {
                                return <span className="phase-progress" title="В работе">В работе</span>
                              }
                              if (s === 'Не требуется' || s === 'Не нужно') {
                                return <span className="phase-done" title="Тендер на материалы не требуется">— Не требуется</span>
                              }
                              return <span className="phase-pending" title={s || 'Не начат'}>{s || 'Не начат'}</span>
                            })()}
                            {tender.materials_tender.materials_proposal_link && (
                              <a
                                href={tender.materials_tender.materials_proposal_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link"
                                title="Открыть КП на материалы"
                              >
                                Открыть
                              </a>
                            )}
                          </div>
                        ) : (
                          // Task 289: ручное создание тендера на материалы запрещено —
                          // материал создаётся автоматически при создании основного тендера.
                          // Если у тендера нет материала (исторические данные или ошибка) —
                          // показываем прочерк, а не предлагаем создать вручную.
                          <span className="muted" style={{ fontSize: '0.75rem' }} title="Тендер на материалы не создан">—</span>
                        )}
                      </td>
                    )}
                    {/* Сводная КП */}
                    {!compactView && (
                      <td>
                        {tender.summary_proposal_link ? (
                          <div className="link-with-edit">
                            <a
                              href={tender.summary_proposal_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            <button
                              className="btn-icon btn-edit"
                              onClick={() => handleUpdateTenderLink(tender.id, 'summary_proposal_link', tender.summary_proposal_link)}
                              title="Изменить ссылку"
                              style={{ fontSize: '0.75rem' }}
                            >✏️</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleUpdateTenderLink(tender.id, 'summary_proposal_link', '')}
                            style={{
                              background: 'none',
                              border: '1px dashed var(--border-color)',
                              borderRadius: '4px',
                              padding: '0.1875rem 0.5rem',
                              color: 'var(--text-tertiary)',
                              cursor: 'pointer',
                              fontSize: '0.75rem'
                            }}
                            title="Добавить ссылку на сводную КП"
                          >+ ссылка</button>
                        )}
                      </td>
                    )}
                    <td className="actions-cell">
                      {activeTab === 'deleted' ? (
                        <>
                          <button
                            className="btn-icon"
                            onClick={() => handleRestoreTender(tender.id, tender.objects?.name || 'тендер')}
                            title="Восстановить"
                            style={{ fontSize: '0.875rem' }}
                          >
                            ↩️
                          </button>
                          {isAdmin && (
                            <button
                              className="btn-icon btn-delete"
                              onClick={() => handleHardDeleteTender(tender.id, tender.objects?.name || 'тендер')}
                              title="Удалить безвозвратно (только для администратора)"
                            >
                              🗑️
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-icon"
                            onClick={() => handleShowLetterForTender(tender)}
                            title="Шаблон письма подрядчикам"
                            style={{ fontSize: '0.875rem' }}
                          >
                            ✉️
                          </button>
                          <button
                            className="btn-icon btn-edit"
                            onClick={() => handleEditTender(tender)}
                            title="Редактировать"
                          >
                            ✏️
                          </button>
                          {isAdmin && (
                            <button
                              className="btn-icon btn-delete"
                              onClick={() =>
                                handleDeleteTender(tender.id, tender.objects?.name || 'тендер')
                              }
                              title="В корзину (только для администратора)"
                            >
                              🗑️
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedTenderId === tender.id && (
                    <tr>
                      <td colSpan={compactView ? 8 : (isCompletedTab ? (!isMaterialsView && department === 'construction' ? 11 : 9) : (isMaterialsView ? 9 : (department === 'construction' ? 12 : 9)))} className="expanded-cp-row">
                        <div className="expanded-cp-toolbar">
                          <button
                            className="btn-primary"
                            onClick={() => {
                              setSelectedTenderForCounterparty(tender.id)
                              setShowAddCounterpartyModal(true)
                            }}
                          >
                            + Добавить контрагента
                          </button>
                          {tenderCounterparties[tender.id] && tenderCounterparties[tender.id].length > 0 && (
                            <button
                              className="btn-secondary"
                              onClick={() => handleCopyEmailsForTender(tender.id)}
                              title="Скопировать все email-адреса контрагентов в буфер обмена"
                            >
                              {copiedEmailsTenderId === tender.id ? '✓ Скопировано' : '📋 Копировать email'}
                            </button>
                          )}
                        </div>
                        {tenderCounterparties[tender.id] && tenderCounterparties[tender.id].length > 0 ? (
                          <div className="expanded-cp-table-wrap">
                            <table className="data-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '40px' }}>№</th>
                                  <th style={{ width: '20%' }}>Наименование</th>
                                  <th style={{ width: '13%' }}>Контактные данные</th>
                                  <th style={{ width: '140px' }}>Email</th>
                                  <th style={{ width: '190px' }}>Статус</th>
                                  <th style={{ width: '280px' }}>КП / Документы</th>
                                  <th>Примечание</th>
                                  <th style={{ width: '56px' }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {tenderCounterparties[tender.id].map((tc, index) => (
                                  <tr key={tc.id}>
                                    <td style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
                                      {index + 1}
                                    </td>
                                    <td>
                                      <div style={{ fontWeight: 600 }}>
                                        {tc.counterparties?.name}
                                      </div>
                                      {tc.counterparties?.work_type && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                                          {tc.counterparties.work_type}
                                        </div>
                                      )}
                                      {tc.counterparties?.inn && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                                          ИНН: {tc.counterparties.inn}
                                        </div>
                                      )}
                                    </td>
                                    <td>
                                      {tc.counterparties?.counterparty_contacts && tc.counterparties.counterparty_contacts.length > 0 ? (
                                        <div style={{ display: 'grid', gap: '0.25rem' }}>
                                          {tc.counterparties.counterparty_contacts.map((contact, idx) => (
                                            <div key={contact.id || idx}>
                                              {contact.full_name && (
                                                <div style={{ fontWeight: 500 }}>
                                                  {contact.full_name}
                                                  {contact.position && (
                                                    <span style={{
                                                      color: 'var(--text-tertiary)',
                                                      fontWeight: 400,
                                                      marginLeft: '0.375rem',
                                                      fontSize: '0.75rem'
                                                    }}>
                                                      {contact.position}
                                                    </span>
                                                  )}
                                                </div>
                                              )}
                                              {contact.phone && (
                                                <a
                                                  href={`tel:${contact.phone}`}
                                                  style={{
                                                    color: 'var(--primary-color)',
                                                    textDecoration: 'none',
                                                    display: 'block',
                                                    fontSize: '0.75rem'
                                                  }}
                                                >
                                                  {contact.phone}
                                                </a>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                                      )}
                                    </td>
                                    <td>
                                      {tc.counterparties?.counterparty_contacts && tc.counterparties.counterparty_contacts.length > 0 ? (
                                        <div style={{ display: 'grid', gap: '0.25rem' }}>
                                          {tc.counterparties.counterparty_contacts
                                            .filter(contact => contact.email)
                                            .map((contact, idx) => (
                                              <a
                                                key={contact.id || idx}
                                                href={`mailto:${contact.email}`}
                                                style={{
                                                  color: 'var(--primary-color)',
                                                  textDecoration: 'none',
                                                  display: 'block',
                                                  fontSize: '0.75rem',
                                                  wordBreak: 'break-all',
                                                }}
                                              >
                                                {contact.email}
                                              </a>
                                            ))}
                                          {tc.counterparties.counterparty_contacts.every(c => !c.email) && (
                                            <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                                          )}
                                        </div>
                                      ) : (
                                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                                      )}
                                    </td>
                                    <td>
                                      <select
                                        value={tc.status || 'request_sent'}
                                        onChange={(e) => handleUpdateCounterpartyStatus(tender.id, tc.id, e.target.value)}
                                        style={{
                                          padding: '0.25rem 0.5rem',
                                          fontSize: '0.75rem',
                                          fontWeight: 600,
                                          border: '1px solid',
                                          borderColor: getCounterpartyStatusColor(tc.status || 'request_sent'),
                                          borderRadius: '4px',
                                          backgroundColor: 'var(--bg-secondary)',
                                          color: getCounterpartyStatusColor(tc.status || 'request_sent'),
                                          cursor: 'pointer',
                                          width: '100%'
                                        }}
                                      >
                                        {counterpartyStatusOptions.map((option) => (
                                          <option
                                            key={option.value}
                                            value={option.value}
                                            style={{ backgroundColor: '#ffffff', color: '#000000' }}
                                          >
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td style={{ verticalAlign: 'top' }}>
                                      <TenderCounterpartyFiles
                                        tenderId={tender.id}
                                        counterpartyId={tc.counterparty_id}
                                      />
                                    </td>
                                    <td>
                                      <textarea
                                        ref={(el) => {
                                          if (el) {
                                            el.style.height = 'auto'
                                            el.style.height = Math.max(el.scrollHeight, 30) + 'px'
                                          }
                                        }}
                                        defaultValue={tc.notes || ''}
                                        onInput={(e) => {
                                          e.target.style.height = 'auto'
                                          e.target.style.height = Math.max(e.target.scrollHeight, 30) + 'px'
                                        }}
                                        onBlur={(e) => {
                                          const newNotes = e.target.value
                                          if ((tc.notes || '') !== newNotes) {
                                            handleUpdateCounterpartyNotes(tender.id, tc.id, newNotes)
                                          }
                                        }}
                                        placeholder="Примечание…"
                                        rows={1}
                                        style={{
                                          width: '100%',
                                          minHeight: '30px',
                                          padding: '0.25rem 0.4rem',
                                          fontSize: '0.75rem',
                                          lineHeight: 1.35,
                                          border: '1px solid var(--border-color)',
                                          borderRadius: '4px',
                                          background: 'var(--bg-secondary)',
                                          color: 'var(--text-primary)',
                                          resize: 'none',
                                          overflow: 'hidden',
                                          fontFamily: 'inherit',
                                          boxSizing: 'border-box',
                                        }}
                                      />
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <button
                                        className="btn-icon btn-delete"
                                        onClick={() => handleRemoveCounterpartyFromTender(tender.id, tc.id)}
                                        title="Удалить из тендера"
                                      >
                                        🗑️
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="expanded-cp-empty">
                            Контрагенты еще не добавлены к этому тендеру
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
          </>
          )}
        </table>
      </div>
      </>)}

      {/* Вкладка шаблона письма */}
      {activeTab === 'template' && !isMaterialsView && (
        <div style={{ padding: '1.5rem' }}>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)', marginBottom: '1rem' }}>
            Редактируйте шаблон письма для запроса КП. Используйте переменные в фигурных скобках — они будут заменены реальными данными при создании тендера:
          </p>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1rem'
          }}>
            {[
              ['{work_description}', 'Описание работ'],
              ['{object_name}', 'Название объекта'],
              ['{start_date}', 'Дата начала'],
              ['{end_date}', 'Дата окончания'],
              ['{employee_name}', 'ФИО сотрудника'],
              ['{employee_position}', 'Должность'],
              ['{employee_phone}', 'Телефон сотрудника'],
              ['{employee_email}', 'Email сотрудника'],
              ['{tender_package_link}', 'Ссылка на тендерный пакет'],
            ].map(([variable, label]) => (
              <span
                key={variable}
                title={label}
                onClick={() => copyToClipboard(variable)}
                style={{
                  padding: '0.2rem 0.5rem',
                  fontSize: '0.75rem',
                  fontFamily: 'Consolas, Monaco, monospace',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  color: 'var(--primary-color)',
                  cursor: 'pointer',
                }}
              >
                {variable}
              </span>
            ))}
          </div>
          <textarea
            value={letterTemplate}
            onChange={(e) => setLetterTemplate(e.target.value)}
            style={{
              width: '100%',
              minHeight: '400px',
              padding: '1rem',
              fontSize: '0.875rem',
              lineHeight: '1.6',
              fontFamily: 'inherit',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', alignItems: 'center' }}>
            <button className="btn-primary" onClick={handleSaveTemplate}>
              {templateSaved ? 'Сохранено!' : 'Сохранить шаблон'}
            </button>
            <button className="btn-secondary" onClick={handleResetTemplate}>
              По умолчанию
            </button>
            {templateSaved && (
              <span style={{ fontSize: '0.8125rem', color: '#16a34a' }}>Шаблон сохранён</span>
            )}
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingTender
                  ? 'Редактировать тендер'
                  : materialsParentTender
                    ? `Тендер на материалы для: ${materialsParentTender.objects?.name || ''}`
                    : isMaterialsView
                      ? 'Новый тендер на материалы'
                      : 'Добавить новый тендер'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowModal(false)
                  setEditingTender(null)
                  setMaterialsParentTender(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Наименование объекта *</label>
                  <select
                    name="object_id"
                    value={formData.object_id}
                    onChange={handleInputChange}
                    required
                    disabled={!!materialsParentTender}
                  >
                    <option value="">Выберите объект</option>
                    {(materialsParentTender && !objects.some(o => o.id === materialsParentTender.object_id)
                      ? [{ id: materialsParentTender.object_id, name: materialsParentTender.objects?.name || '—' }, ...objects]
                      : objects
                    ).map((obj) => (
                      <option key={obj.id} value={obj.id}>
                        {obj.name}
                      </option>
                    ))}
                  </select>
                  {materialsParentTender && (
                    <small style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                      Объект унаследован от родительского тендера на работы
                    </small>
                  )}
                </div>

                <div className="form-group full-width">
                  <label>Описание работ *</label>
                  <textarea
                    name="work_description"
                    value={formData.work_description}
                    onChange={handleInputChange}
                    required
                    rows="4"
                    placeholder="Опишите виды работ, которые будут проводиться..."
                  />
                </div>

                {editingTender && (
                  <div className="form-group full-width">
                    <label>Статус *</label>
                    <select
                      name="status"
                      value={formData.status}
                      onChange={handleInputChange}
                      required
                    >
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label>Дата начала работ</label>
                  <input
                    type="date"
                    name="start_date"
                    value={formData.start_date}
                    onChange={handleInputChange}
                    min="2020-01-01"
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Дата окончания работ</label>
                  <input
                    type="date"
                    name="end_date"
                    value={formData.end_date}
                    onChange={handleInputChange}
                    min={formData.start_date || '2020-01-01'}
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Тендерная процедура: начало</label>
                  <input
                    type="date"
                    name="tender_start_date"
                    value={formData.tender_start_date}
                    onChange={handleInputChange}
                    min="2020-01-01"
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Тендерная процедура: окончание</label>
                  <input
                    type="date"
                    name="tender_end_date"
                    value={formData.tender_end_date}
                    onChange={handleInputChange}
                    min={formData.tender_start_date || '2020-01-01'}
                    max="9999-12-31"
                  />
                </div>

                {editingTender && (
                  <>
                    <div className="form-group">
                      <label>Подготовка ВОР: начало</label>
                      <input
                        type="date"
                        name="vor_start_date"
                        value={formData.vor_start_date}
                        onChange={handleInputChange}
                        min="2020-01-01"
                        max="9999-12-31"
                      />
                    </div>

                    <div className="form-group">
                      <label>Подготовка ВОР: окончание</label>
                      <input
                        type="date"
                        name="vor_end_date"
                        value={formData.vor_end_date}
                        onChange={handleInputChange}
                        min={formData.vor_start_date || '2020-01-01'}
                        max="9999-12-31"
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный сотрудник</label>
                      <select
                        name="responsible_contact_id"
                        value={formData.responsible_contact_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {responsibleContacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>Ссылка на тендерный пакет</label>
                      <input
                        type="url"
                        name="tender_package_link"
                        value={formData.tender_package_link}
                        onChange={handleInputChange}
                        placeholder="https://example.com/tender-package.pdf"
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>План затрат — ссылка</label>
                      <input
                        type="url"
                        name="cost_plan_link"
                        value={formData.cost_plan_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный за план затрат</label>
                      <select
                        name="cost_plan_responsible_id"
                        value={formData.cost_plan_responsible_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {responsibleContacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>ВОРы и РД — ссылка на диск</label>
                      <input
                        type="url"
                        name="vor_link"
                        value={formData.vor_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный за ВОРы и РД</label>
                      <select
                        name="vor_responsible_id"
                        value={formData.vor_responsible_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {responsibleContacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>Сводная КП — ссылка</label>
                      <input
                        type="url"
                        name="summary_proposal_link"
                        value={formData.summary_proposal_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>
                  </>
                )}

                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea
                    name="notes"
                    value={formData.notes}
                    onChange={handleInputChange}
                    rows={3}
                    placeholder="Свободные заметки по тендеру: ход переговоров, особые условия, риски и т.п."
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowModal(false)
                    setEditingTender(null)
                  }}
                >
                  Отмена
                </button>
                {editingTender && formData.responsible_contact_id && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      const selectedObject = objects.find(obj => obj.id === formData.object_id)
                      const objectName = selectedObject?.name || '[Объект не указан]'
                      const selectedContact = responsibleContacts.find(c => c.id === formData.responsible_contact_id)
                      const letter = generateRequestLetter(formData, objectName, selectedContact)
                      setGeneratedLetter(letter)
                      setShowLetterModal(true)
                    }}
                    title="Сгенерировать письмо для подрядчиков"
                  >
                    Письмо подрядчикам
                  </button>
                )}
                <button type="submit" className="btn-primary">
                  {editingTender ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddCounterpartyModal && (() => {
        const currentTenderCounterparties = tenderCounterparties[selectedTenderForCounterparty] || []
        const uniqueWorkTypes = [...new Set(
          counterparties
            .flatMap(c => (c.work_type || '').split(',').map(wt => wt.trim()))
            .filter(wt => wt !== '')
        )].sort((a, b) => a.localeCompare(b, 'ru'))

        const availableCounterparties = counterparties.filter(cp => {
          if (currentTenderCounterparties.some(tc => tc.counterparty_id === cp.id)) return false

          // Фильтр по виду работ
          if (counterpartyWorkTypeFilter) {
            const types = (cp.work_type || '').split(',').map(wt => wt.trim())
            if (!types.includes(counterpartyWorkTypeFilter)) return false
          }

          // Поиск
          if (counterpartySearchQuery.trim()) {
            const query = counterpartySearchQuery.toLowerCase()
            return (
              (cp.name && cp.name.toLowerCase().includes(query)) ||
              (cp.work_type && cp.work_type.toLowerCase().includes(query)) ||
              (cp.inn && cp.inn.toLowerCase().includes(query)) ||
              (cp.department && cp.department.toLowerCase().includes(query))
            )
          }

          return true
        })

        return (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
              <div className="modal-header">
                <h3>Выбрать контрагентов для добавления к тендеру</h3>
                <button
                  className="modal-close"
                  onClick={() => {
                    setShowAddCounterpartyModal(false)
                    setCounterpartySearchQuery('')
                    setCounterpartyWorkTypeFilter('')
                    setSelectedCounterpartyIds([])
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '1.5rem' }}>
                {/* Поиск и фильтры */}
                <div style={{ marginBottom: '1rem' }}>
                  <input
                    type="text"
                    placeholder="🔍 Поиск по названию, виду работ, ИНН..."
                    value={counterpartySearchQuery}
                    onChange={(e) => setCounterpartySearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      fontSize: '1rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      backgroundColor: 'var(--bg-color)',
                      color: 'var(--text-color)',
                      marginBottom: '0.75rem'
                    }}
                  />

                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {uniqueWorkTypes.length > 0 && (
                      <select
                        value={counterpartyWorkTypeFilter}
                        onChange={(e) => setCounterpartyWorkTypeFilter(e.target.value)}
                        style={{
                          padding: '0.375rem 0.75rem',
                          fontSize: '0.8125rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: '4px',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="">Все виды работ</option>
                        {uniqueWorkTypes.map(workType => (
                          <option key={workType} value={workType}>{workType}</option>
                        ))}
                      </select>
                    )}

                    {counterpartyWorkTypeFilter && (
                      <button
                        onClick={() => setCounterpartyWorkTypeFilter('')}
                        style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
                      >Сбросить</button>
                    )}
                  </div>
                </div>

                {/* Таблица контрагентов */}
                {counterparties.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                    Нет активных контрагентов
                  </p>
                ) : availableCounterparties.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                    {currentTenderCounterparties.length === counterparties.length
                      ? 'Все активные контрагенты уже добавлены к тендеру'
                      : 'Контрагенты не найдены по заданным критериям'
                    }
                  </p>
                ) : (
                  <>
                    <div style={{
                      maxHeight: '400px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      marginBottom: '1rem'
                    }}>
                      <table className="data-table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th style={{
                              width: '50px',
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              backdropFilter: 'blur(10px)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                              padding: '0.75rem'
                            }}>
                              <input
                                type="checkbox"
                                checked={availableCounterparties.length > 0 && selectedCounterpartyIds.length === availableCounterparties.length}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedCounterpartyIds(availableCounterparties.map(cp => cp.id))
                                  } else {
                                    setSelectedCounterpartyIds([])
                                  }
                                }}
                                style={{ cursor: 'pointer' }}
                              />
                            </th>
                            <th style={{
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              backdropFilter: 'blur(10px)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                              padding: '0.75rem'
                            }}>Наименование</th>
                            <th style={{
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              padding: '0.75rem',
                              width: '80px',
                              textAlign: 'center'
                            }}>Категория</th>
                            <th style={{
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              padding: '0.75rem'
                            }}>Вид работ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {availableCounterparties.map((counterparty) => (
                            <tr
                              key={counterparty.id}
                              style={{
                                cursor: 'pointer',
                                backgroundColor: selectedCounterpartyIds.includes(counterparty.id) ? 'var(--hover-bg, #f0f9ff)' : ''
                              }}
                              onClick={() => handleToggleCounterpartySelection(counterparty.id)}
                              onMouseEnter={(e) => {
                                if (!selectedCounterpartyIds.includes(counterparty.id)) {
                                  e.currentTarget.style.backgroundColor = 'var(--hover-bg, #f9fafb)'
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!selectedCounterpartyIds.includes(counterparty.id)) {
                                  e.currentTarget.style.backgroundColor = ''
                                }
                              }}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selectedCounterpartyIds.includes(counterparty.id)}
                                  onChange={() => handleToggleCounterpartySelection(counterparty.id)}
                                  style={{ cursor: 'pointer' }}
                                />
                              </td>
                              <td style={{ fontWeight: 500 }}>{counterparty.name}</td>
                              <td style={{ textAlign: 'center' }}>
                                {counterparty.department ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', alignItems: 'center' }}>
                                    {counterparty.department.split(',').map((d, i) => {
                                      const dept = d.trim()
                                      const isCon = dept === 'Основное строительство'
                                      return (
                                        <span key={i} style={{
                                          padding: '0.1rem 0.35rem',
                                          fontSize: '0.6875rem',
                                          fontWeight: 700,
                                          borderRadius: '3px',
                                          background: isCon ? 'rgba(37,99,235,0.12)' : 'rgba(234,88,12,0.12)',
                                          color: isCon ? '#2563eb' : '#ea580c',
                                          border: `1px solid ${isCon ? 'rgba(37,99,235,0.25)' : 'rgba(234,88,12,0.25)'}`,
                                        }}>{isCon ? 'ОС' : 'ГО'}</span>
                                      )
                                    })}
                                  </div>
                                ) : '-'}
                              </td>
                              <td>
                                {counterparty.work_type ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                                    {counterparty.work_type.split(',').map((wt, i) => (
                                      <span key={i} style={{
                                        display: 'block',
                                        padding: '0.1rem 0.35rem',
                                        fontSize: '0.75rem',
                                        background: 'var(--bg-tertiary)',
                                        borderRadius: '3px',
                                        borderLeft: '2px solid var(--primary-color)',
                                        color: 'var(--text-secondary)',
                                      }}>{wt.trim()}</span>
                                    ))}
                                  </div>
                                ) : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                        {selectedCounterpartyIds.length > 0 && (
                          <span>Выбрано: <strong>{selectedCounterpartyIds.length}</strong></span>
                        )}
                      </div>
                      <button
                        onClick={handleAddCounterpartiesToTender}
                        disabled={selectedCounterpartyIds.length === 0}
                        style={{
                          backgroundColor: selectedCounterpartyIds.length > 0 ? 'var(--primary-color)' : '#9ca3af',
                          color: 'white',
                          border: 'none',
                          borderRadius: '8px',
                          padding: '0.75rem 2rem',
                          cursor: selectedCounterpartyIds.length > 0 ? 'pointer' : 'not-allowed',
                          fontSize: '1rem',
                          fontWeight: '600',
                          transition: 'all 0.2s',
                          boxShadow: selectedCounterpartyIds.length > 0 ? '0 4px 6px rgba(0, 0, 0, 0.1)' : 'none'
                        }}
                        onMouseEnter={(e) => {
                          if (selectedCounterpartyIds.length > 0) {
                            e.target.style.transform = 'scale(1.05)'
                            e.target.style.boxShadow = '0 6px 8px rgba(0, 0, 0, 0.15)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.target.style.transform = 'scale(1)'
                          if (selectedCounterpartyIds.length > 0) {
                            e.target.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)'
                          }
                        }}
                      >
                        ✓ Добавить выбранных ({selectedCounterpartyIds.length})
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Модальное окно выбора победителя */}
      {showWinnerModal && tenderForWinnerSelection && (() => {
        const tenderCps = tenderCounterparties[tenderForWinnerSelection.id] || []

        return (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
              <div className="modal-header">
                <h3>Выбор победителей тендера</h3>
                <button
                  className="modal-close"
                  onClick={() => {
                    setShowWinnerModal(false)
                    setTenderForWinnerSelection(null)
                    setSelectedWinners([])
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '1.5rem' }}>
                <div style={{ marginBottom: '1.5rem' }}>
                  <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                    <strong>Объект:</strong> {tenderForWinnerSelection.objects?.name || '-'}
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    <strong>Описание работ:</strong> {tenderForWinnerSelection.work_description}
                  </p>
                </div>

                {tenderCps.length === 0 ? (
                  <div style={{
                    textAlign: 'center',
                    padding: '2rem',
                    color: 'var(--text-secondary)',
                    backgroundColor: 'var(--bg-tertiary)',
                    borderRadius: '8px'
                  }}>
                    <p style={{ marginBottom: '1rem' }}>К этому тендеру не добавлены контрагенты.</p>
                    <p>Вы можете завершить тендер без победителя или сначала добавить контрагентов.</p>
                  </div>
                ) : (
                  <>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontWeight: '500' }}>
                      Выберите победителей тендера (можно несколько — при разделении по корпусам/системам):
                    </p>
                    <div style={{
                      maxHeight: '320px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px'
                    }}>
                      {tenderCps.map((tc) => {
                        const selected = isWinnerSelected(tc.counterparty_id)
                        return (
                          <div
                            key={tc.id}
                            onClick={() => toggleWinner(tc.counterparty_id)}
                            style={{
                              padding: '1rem',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border-color)',
                              backgroundColor: selected ? 'color-mix(in srgb, var(--primary-color) 12%, transparent)' : 'transparent',
                              color: 'var(--text-primary)',
                              transition: 'background 0.15s',
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '1rem'
                            }}
                            onMouseEnter={(e) => {
                              if (!selected) e.currentTarget.style.backgroundColor = 'var(--hover-bg)'
                            }}
                            onMouseLeave={(e) => {
                              if (!selected) e.currentTarget.style.backgroundColor = 'transparent'
                            }}
                          >
                            <div style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '4px',
                              border: selected ? '2px solid var(--primary-color)' : '2px solid var(--border-color)',
                              background: selected ? 'var(--primary-color)' : 'transparent',
                              color: 'white',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              marginTop: '0.125rem',
                              fontSize: '0.75rem',
                              lineHeight: 1
                            }}>
                              {selected && '✓'}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                                {tc.counterparties?.name}
                              </div>
                              {tc.counterparties?.work_type && (
                                <div style={{ fontSize: '0.875rem', opacity: 0.7 }}>
                                  {tc.counterparties.work_type}
                                </div>
                              )}
                              <div style={{
                                fontSize: '0.75rem',
                                marginTop: '0.25rem',
                                padding: '0.25rem 0.5rem',
                                borderRadius: '4px',
                                display: 'inline-block',
                                backgroundColor: 'var(--bg-tertiary)',
                                color: getCounterpartyStatusColor(tc.status)
                              }}>
                                {getCounterpartyStatusLabel(tc.status || 'request_sent')}
                              </div>
                              {selected && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ marginTop: '0.625rem' }}
                                >
                                  <input
                                    type="text"
                                    value={getWinnerScope(tc.counterparty_id)}
                                    onChange={(e) => setWinnerScope(tc.counterparty_id, e.target.value)}
                                    placeholder="Корпус / система (необязательно)"
                                    style={{
                                      width: '100%',
                                      padding: '0.375rem 0.5rem',
                                      fontSize: '0.8125rem',
                                      border: '1px solid var(--border-color)',
                                      borderRadius: '4px',
                                      background: 'var(--bg-secondary)',
                                      color: 'var(--text-primary)',
                                      fontFamily: 'inherit',
                                      boxSizing: 'border-box'
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {selectedWinners.length > 0 && (
                      <p style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        Выбрано победителей: <strong>{selectedWinners.length}</strong>. На каждого будет создан проект договора.
                      </p>
                    )}
                  </>
                )}

                <div style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '1rem',
                  marginTop: '1.5rem',
                  paddingTop: '1.5rem',
                  borderTop: '1px solid var(--border-color)'
                }}>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setShowWinnerModal(false)
                      setTenderForWinnerSelection(null)
                      setSelectedWinners([])
                    }}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleConfirmWinner}
                  >
                    {selectedWinners.length > 0 ? 'Завершить с победителями' : 'Завершить без победителя'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Модальное окно с шаблонным письмом */}
      {showLetterModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '90vh' }}>
            <div className="modal-header">
              <h3>📧 Шаблон письма для запроса КП</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowLetterModal(false)
                  setLetterCopied(false)
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              <p style={{
                color: 'var(--text-secondary)',
                marginBottom: '1rem',
                fontSize: '0.9rem'
              }}>
                Тендер успешно создан! Ниже готовое письмо для отправки контрагентам:
              </p>

              <div style={{
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '1.5rem',
                maxHeight: '400px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                lineHeight: '1.6',
                color: 'var(--text-primary)'
              }}>
                {generatedLetter}
              </div>

              <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '1rem',
                marginTop: '1.5rem',
                paddingTop: '1rem',
                borderTop: '1px solid var(--border-color)'
              }}>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setShowLetterModal(false)
                    setLetterCopied(false)
                  }}
                >
                  Закрыть
                </button>
                <button
                  className="btn-primary"
                  onClick={handleCopyLetter}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    backgroundColor: letterCopied ? '#16a34a' : undefined
                  }}
                >
                  {letterCopied ? '✓ Скопировано!' : '📋 Копировать письмо'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TendersPage
