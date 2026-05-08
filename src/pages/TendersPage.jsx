import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import '../components/Tenders.css'

function TendersPage({ department = 'construction' }) {
  const navigate = useNavigate()
  const { scopedObjectId, userProfile } = useRole()
  const [tenders, setTenders] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [responsibleContacts, setResponsibleContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [activeTab, setActiveTab] = useState('active') // 'active' or 'completed'
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
  const [counterpartyDepartmentFilter, setCounterpartyDepartmentFilter] = useState('')
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState([])
  const [showWinnerModal, setShowWinnerModal] = useState(false)
  const [tenderForWinnerSelection, setTenderForWinnerSelection] = useState(null)
  const [selectedWinnerId, setSelectedWinnerId] = useState(null)
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

  // Определяем статус объекта в зависимости от отдела
  const objectStatus = department === 'construction' ? 'main_construction' : 'warranty_service'
  const pageTitle = department === 'construction' ? 'Тендеры — Основное строительство' : 'Тендеры — Гарантийный отдел'

  const statusOptions = ['Заявка на тендер', 'Подготовка ВОР', 'Идет тендерная процедура', 'Завершен', 'Приостановка тендера']

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
  }, [department])

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
        .select('*, objects(name, status), winner:counterparties!winner_counterparty_id(id, name), responsible_contact:contacts!responsible_contact_id(id, full_name), cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name), vor_responsible:contacts!vor_responsible_id(id, full_name)')
        .order('start_date', { ascending: false })

      if (error) throw error
      // Фильтруем тендеры по статусу объекта + scope пользователя по объекту (если есть)
      let filteredTenders = (data || []).filter(
        tender => tender.objects?.status === objectStatus
      )
      if (scopedObjectId) {
        filteredTenders = filteredTenders.filter(t => t.object_id === scopedObjectId)
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
      const { data, error } = await supabase
        .from('objects')
        .select('*')
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

  const handleUpdateCounterpartyProposalLink = async (tenderId, tenderCounterpartyId, currentLink) => {
    const next = window.prompt('Ссылка на КП (Google/Yandex Drive):', currentLink || '')
    if (next === null) return // отменили
    const newValue = next.trim() || null
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ proposal_link: newValue })
        .eq('id', tenderCounterpartyId)
      if (error) throw error
      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: prev[tenderId].map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, proposal_link: newValue } : tc
        )
      }))
    } catch (error) {
      console.error('Ошибка сохранения ссылки на КП:', error.message)
      alert('Ошибка сохранения: ' + error.message)
    }
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

  const handleUpdateTenderResponsible = async (tenderId, newContactId) => {
    const value = newContactId || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ responsible_contact_id: value })
        .eq('id', tenderId)
      if (error) throw error
      const newContact = value ? responsibleContacts.find(c => c.id === value) : null
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, responsible_contact_id: value, responsible_contact: newContact ? { id: newContact.id, full_name: newContact.full_name } : null }
          : t
      ))
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
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
    try {
      await navigator.clipboard.writeText(unique.join('; '))
      setCopiedEmailsTenderId(tenderId)
      setTimeout(() => setCopiedEmailsTenderId(prev => prev === tenderId ? null : prev), 2000)
    } catch (err) {
      console.error('Ошибка копирования email:', err)
      alert('Не удалось скопировать в буфер обмена')
    }
  }

  const handleRemoveCounterpartyFromTender = async (tenderId, tenderCounterpartyId) => {
    if (!window.confirm('Удалить контрагента из тендера?')) return

    try {
      const { error} = await supabase
        .from('tender_counterparties')
        .delete()
        .eq('id', tenderCounterpartyId)

      if (error) throw error

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
      } else {
        // Insert new tender — только минимальный набор для заявки от руководителя строительства.
        // Это страхует от падений, если новые миграции (notes, cost_plan_*, vor_*) ещё не применены.
        const insertPayload = {
          object_id: formData.object_id || null,
          work_description: formData.work_description,
          status: formData.status || 'Заявка на тендер',
          start_date: formData.start_date,
          end_date: formData.end_date,
        }
        if (formData.notes) insertPayload.notes = formData.notes

        const { data: inserted, error } = await supabase
          .from('tenders')
          .insert([insertPayload])
          .select('id')
          .single()
        if (error) {
          // Если БД ругается на отсутствующую колонку notes (миграция не применена) —
          // повторим без неё, чтобы создать тендер.
          if (insertPayload.notes && /column .*notes.* does not exist/i.test(error.message)) {
            delete insertPayload.notes
            const retry = await supabase
              .from('tenders')
              .insert([insertPayload])
              .select('id')
              .single()
            if (retry.error) throw retry.error
            if (retry.data?.id) {
              await logTenderEvent(retry.data.id, 'created', {
                newValue: insertPayload,
                description: 'Тендер создан'
              })
            }
          } else {
            throw error
          }
        } else if (inserted?.id) {
          await logTenderEvent(inserted.id, 'created', {
            newValue: insertPayload,
            description: 'Тендер создан'
          })
        }
      }

      setShowModal(false)
      setEditingTender(null)
      setFormData({
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
    if (
      window.confirm(`Переместить тендер "${objectName}" в «Удалённые»? Его можно будет восстановить.`)
    ) {
      try {
        const { error } = await supabase
          .from('tenders')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', id)
        if (error) throw error
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
      fetchTenders()
    } catch (err) {
      console.error('Ошибка восстановления тендера:', err.message)
      alert('Ошибка восстановления: ' + err.message)
    }
  }

  const handleHardDeleteTender = async (id, objectName) => {
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
    setFormData({
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
    setShowModal(true)
  }

  const handleStatusChange = async (tenderId, newStatus) => {
    // Если статус меняется на "Завершен", показываем модальное окно выбора победителя
    if (newStatus === 'Завершен') {
      const tender = tenders.find(t => t.id === tenderId)
      setTenderForWinnerSelection(tender)

      // Загружаем контрагентов тендера если еще не загружены
      if (!tenderCounterparties[tenderId]) {
        await fetchTenderCounterparties(tenderId)
      }

      setSelectedWinnerId(tender?.winner_counterparty_id || null)
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

  const handleConfirmWinner = async () => {
    if (!tenderForWinnerSelection) return

    try {
      const prevStatus = tenderForWinnerSelection.status || null
      const prevWinnerId = tenderForWinnerSelection.winner_counterparty_id || null

      // Обновляем статус тендера
      const { error: tenderError } = await supabase
        .from('tenders')
        .update({
          status: 'Завершен',
          winner_counterparty_id: selectedWinnerId
        })
        .eq('id', tenderForWinnerSelection.id)

      if (tenderError) throw tenderError

      // Лог: смена статуса
      if (prevStatus !== 'Завершен') {
        await logTenderEvent(tenderForWinnerSelection.id, 'status_changed', {
          oldValue: prevStatus,
          newValue: 'Завершен',
          description: `Статус: ${prevStatus || '—'} → Завершен`
        })
      }

      // Лог: назначение победителя
      if (selectedWinnerId && selectedWinnerId !== prevWinnerId) {
        const tcList = tenderCounterparties[tenderForWinnerSelection.id] || []
        const winner = tcList.find(tc => tc.counterparties?.id === selectedWinnerId)?.counterparties
        const winnerName = winner?.name || null
        await logTenderEvent(tenderForWinnerSelection.id, 'winner_assigned', {
          oldValue: prevWinnerId,
          newValue: { id: selectedWinnerId, name: winnerName },
          description: winnerName ? `Назначен победитель: ${winnerName}` : 'Назначен победитель'
        })
      }

      // Если выбран победитель, создаем договор на согласовании
      if (selectedWinnerId) {
        const today = new Date().toISOString().split('T')[0]

        const { error: contractError } = await supabase
          .from('contracts')
          .insert([{
            tender_id: tenderForWinnerSelection.id,
            counterparty_id: selectedWinnerId,
            object_id: tenderForWinnerSelection.object_id,
            contract_number: `Проект-${Date.now()}`,
            contract_date: today,
            contract_amount: 0,
            status: 'pending'
          }])

        if (contractError) {
          console.error('Ошибка создания договора:', contractError.message)
          // Не прерываем выполнение, тендер уже завершен
        }
      }

      setShowWinnerModal(false)
      setTenderForWinnerSelection(null)
      setSelectedWinnerId(null)
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
    try {
      await navigator.clipboard.writeText(generatedLetter)
      setLetterCopied(true)
      setTimeout(() => setLetterCopied(false), 2000)
    } catch (error) {
      console.error('Ошибка копирования:', error)
      alert('Не удалось скопировать текст')
    }
  }

  const getStatusBadgeClass = (status) => {
    const statusClasses = {
      'Заявка на тендер': 'status-not-started',
      'Подготовка ВОР': 'status-waiting-vor',
      'Идет тендерная процедура': 'status-in-progress',
      'Завершен': 'status-completed',
      'Приостановка тендера': 'status-suspended',
      // legacy fallbacks (на случай несмигрированных данных)
      'Не начат': 'status-not-started',
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
    // Фильтр по вкладке (deleted_at-aware)
    if (activeTab === 'deleted') {
      if (!tender.deleted_at) return false
    } else if (activeTab === 'completed') {
      if (tender.deleted_at) return false
      if (tender.status !== 'Завершен') return false
    } else {
      if (tender.deleted_at) return false
      if (tender.status === 'Завершен') return false
    }
    // Фильтр по объекту
    if (objectFilter && tender.object_id !== objectFilter) return false
    // Фильтр по ответственному
    if (responsibleFilter && tender.responsible_contact_id !== responsibleFilter) return false
    // Фильтр по статусу
    if (statusFilter && tender.status !== statusFilter) return false
    return true
  })

  // Сортировка по выбранному полю
  const statusOrder = Object.fromEntries(statusOptions.map((s, i) => [s, i]))
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
      setSortOrder('desc')
    }
  }

  const sortIndicator = (field) => {
    if (sortField !== field) return ' ↕'
    return sortOrder === 'asc' ? ' ↑' : ' ↓'
  }

  // Подсчет количества тендеров для каждой вкладки (deleted_at-aware)
  const activeTendersCount = tenders.filter(t => !t.deleted_at && t.status !== 'Завершен').length
  const completedTendersCount = tenders.filter(t => !t.deleted_at && t.status === 'Завершен').length
  const deletedTendersCount = tenders.filter(t => t.deleted_at).length

  // Проверка просроченности
  const today = new Date().toISOString().split('T')[0]
  const isOverdue = (tender) => tender.end_date && tender.end_date < today && tender.status !== 'Завершен'

  // Уникальные объекты из тендеров для фильтра
  const tenderObjectIds = [...new Set(tenders.map(t => t.object_id).filter(Boolean))]
  const tenderObjects = objects.filter(o => tenderObjectIds.includes(o.id))

  return (
    <div className="tenders-page">
      <div className="page-header page-header-tenders">
        <h2><span className="page-icon" aria-hidden>📋</span> {pageTitle}</h2>
        <button className="btn-primary" onClick={handleAddNew}>
          + Добавить тендер
        </button>
      </div>

      {/* Вкладки */}
      <div className="tender-tabs">
        <button
          className={`tender-tab ${activeTab === 'active' ? 'active' : ''}`}
          onClick={() => setActiveTab('active')}
        >
          Актуальные тендеры
          {activeTendersCount > 0 && (
            <span className="tender-tab-count">{activeTendersCount}</span>
          )}
        </button>
        <button
          className={`tender-tab ${activeTab === 'completed' ? 'active' : ''}`}
          onClick={() => setActiveTab('completed')}
        >
          Завершенные
          {completedTendersCount > 0 && (
            <span className="tender-tab-count completed">{completedTendersCount}</span>
          )}
        </button>
        <button
          className={`tender-tab ${activeTab === 'deleted' ? 'active' : ''}`}
          onClick={() => setActiveTab('deleted')}
        >
          Удалённые
          {deletedTendersCount > 0 && (
            <span className="tender-tab-count">{deletedTendersCount}</span>
          )}
        </button>
        <button
          className={`tender-tab ${activeTab === 'template' ? 'active' : ''}`}
          onClick={() => setActiveTab('template')}
        >
          Шаблон письма
        </button>
      </div>

      {/* Фильтры и таблица (скрываем на вкладке шаблона) */}
      {activeTab !== 'template' && (<>
      <div style={{ padding: '0.5rem 0', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
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
            <option value="">Все объекты</option>
            {tenderObjects.map(obj => (
              <option key={obj.id} value={obj.id}>{obj.name}</option>
            ))}
          </select>
        </div>

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
            <option value="">Все статусы</option>
            {statusOptions.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

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
            <option value="">Все ответственные</option>
            {responsibleContacts
              .filter(c => tenders.some(t => t.responsible_contact_id === c.id))
              .map(c => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
          </select>
        </div>

        {(objectFilter || responsibleFilter || statusFilter) && (
          <button
            onClick={() => { setObjectFilter(''); setResponsibleFilter(''); setStatusFilter('') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
          >
            Сбросить все
          </button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '50px' }}></th>
              <th>Наименование объекта</th>
              <th>Описание работ</th>
              <th>Статус</th>
              {activeTab === 'completed' && <th>Победитель</th>}
              <th
                className="sortable-th"
                onClick={() => toggleSort('start_date')}
                title="Сортировать по датам"
              >
                Планируемые сроки выполнения работ{sortIndicator('start_date')}
              </th>
              <th>Ответственный по тендеру</th>
              {department === 'construction' && <th>ВОРы и РД</th>}
              <th>Тендерный пакет</th>
              {department === 'construction' && <th>План затрат</th>}
              <th>Сводная КП</th>
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {sortedTenders.length === 0 ? (
              <tr>
                <td colSpan={(department === 'construction' ? 11 : 9) + (activeTab === 'completed' ? 1 : 0)} className="no-data">
                  {activeTab === 'completed'
                    ? 'Нет завершенных тендеров'
                    : activeTab === 'deleted'
                      ? 'В корзине нет тендеров'
                      : 'Нет актуальных тендеров. Добавьте первый тендер.'}
                </td>
              </tr>
            ) : (
              sortedTenders.map((tender) => (
                <React.Fragment key={tender.id}>
                  <tr className={isOverdue(tender) ? 'overdue-row' : ''}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        <button
                          onClick={() => handleToggleTender(tender.id)}
                          className="expand-toggle"
                          title="Показать контрагентов"
                        >
                          {expandedTenderId === tender.id ? '▼' : '▶'}
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
                      <button
                        onClick={() => navigate(`/tenders/${tender.id}`)}
                        className="row-link primary"
                        title="Открыть тендер"
                      >
                        {tender.objects?.name || '-'}
                      </button>
                    </td>
                    <td>
                      <button
                        onClick={() => navigate(`/tenders/${tender.id}`)}
                        className="row-link muted"
                        title="Открыть тендер"
                      >
                        {tender.work_description}
                      </button>
                    </td>
                    <td>
                      <select
                        className={`status-select ${getStatusBadgeClass(tender.status)}`}
                        value={tender.status}
                        onChange={(e) => handleStatusChange(tender.id, e.target.value)}
                      >
                        {statusOptions.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </td>
                    {activeTab === 'completed' && (
                      <td>
                        {tender.winner ? (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.375rem 0.75rem',
                            backgroundColor: '#dcfce7',
                            color: '#166534',
                            borderRadius: '6px',
                            fontSize: '0.875rem',
                            fontWeight: '500',
                            border: '1px solid #86efac'
                          }}>
                            🏆 {tender.winner.name}
                          </span>
                        ) : (
                          <span style={{
                            color: 'var(--text-tertiary)',
                            fontStyle: 'italic',
                            fontSize: '0.875rem'
                          }}>
                            Не выбран
                          </span>
                        )}
                      </td>
                    )}
                    <td style={isOverdue(tender) ? { color: '#dc2626', fontWeight: 600, whiteSpace: 'nowrap' } : { whiteSpace: 'nowrap' }}>
                      {formatDateRange(tender.start_date, tender.end_date)}
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
                    {department === 'construction' && (
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
                        <a
                          href={tender.tender_package_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          Открыть
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    {/* План затрат */}
                    {department === 'construction' && (
                      <td>
                        <div className="phase-cell">
                          {(() => {
                            const s = tender.cost_plan_status || 'not_started'
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
                    {/* Сводная КП */}
                    <td>
                      {tender.summary_proposal_link ? (
                        <a
                          href={tender.summary_proposal_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          Открыть
                        </a>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>
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
                          <button
                            className="btn-icon btn-delete"
                            onClick={() => handleHardDeleteTender(tender.id, tender.objects?.name || 'тендер')}
                            title="Удалить безвозвратно"
                          >
                            🗑️
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-icon btn-edit"
                            onClick={() => handleEditTender(tender)}
                            title="Редактировать"
                          >
                            ✏️
                          </button>
                          <button
                            className="btn-icon btn-delete"
                            onClick={() =>
                              handleDeleteTender(tender.id, tender.objects?.name || 'тендер')
                            }
                            title="В корзину"
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedTenderId === tender.id && (
                    <tr>
                      <td colSpan={(department === 'construction' ? 11 : 9) + (activeTab === 'completed' ? 1 : 0)} className="expanded-cp-row">
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
                                  <th style={{ width: '48px' }}>№</th>
                                  <th>Наименование</th>
                                  <th>Контактные данные</th>
                                  <th>Email</th>
                                  <th style={{ width: '170px' }}>Статус</th>
                                  <th style={{ width: '140px' }}>КП</th>
                                  <th style={{ width: '64px' }}></th>
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
                                                  display: 'block'
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
                                    <td>
                                      {tc.proposal_link ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                          <a
                                            href={tc.proposal_link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="link"
                                          >
                                            Открыть
                                          </a>
                                          <button
                                            className="btn-icon btn-edit"
                                            onClick={() => handleUpdateCounterpartyProposalLink(tender.id, tc.id, tc.proposal_link)}
                                            title="Изменить ссылку"
                                            style={{ fontSize: '0.75rem' }}
                                          >
                                            ✏️
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          onClick={() => handleUpdateCounterpartyProposalLink(tender.id, tc.id, '')}
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
        </table>
      </div>
      </>)}

      {/* Вкладка шаблона письма */}
      {activeTab === 'template' && (
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
                onClick={() => navigator.clipboard.writeText(variable)}
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
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingTender ? 'Редактировать тендер' : 'Добавить новый тендер'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowModal(false)
                  setEditingTender(null)
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
                  >
                    <option value="">Выберите объект</option>
                    {objects.map((obj) => (
                      <option key={obj.id} value={obj.id}>
                        {obj.name}
                      </option>
                    ))}
                  </select>
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
                  <label>Дата начала работ *</label>
                  <input
                    type="date"
                    name="start_date"
                    value={formData.start_date}
                    onChange={handleInputChange}
                    min="2020-01-01"
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Дата окончания работ *</label>
                  <input
                    type="date"
                    name="end_date"
                    value={formData.end_date}
                    onChange={handleInputChange}
                    min={formData.start_date || '2020-01-01'}
                    required
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

          // Фильтр по категории работ
          if (counterpartyDepartmentFilter) {
            const depts = (cp.department || '').split(',').map(d => d.trim())
            if (!depts.includes(counterpartyDepartmentFilter)) return false
          }

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
          <div className="modal-overlay" onClick={() => {
            setShowAddCounterpartyModal(false)
            setCounterpartySearchQuery('')
            setCounterpartyWorkTypeFilter('')
            setCounterpartyDepartmentFilter('')
            setSelectedCounterpartyIds([])
          }}>
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
                    <select
                      value={counterpartyDepartmentFilter}
                      onChange={(e) => setCounterpartyDepartmentFilter(e.target.value)}
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
                      <option value="">Все категории</option>
                      <option value="Основное строительство">Основное строительство</option>
                      <option value="Гарантийный отдел">Гарантийный отдел</option>
                    </select>

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

                    {(counterpartyDepartmentFilter || counterpartyWorkTypeFilter) && (
                      <button
                        onClick={() => { setCounterpartyDepartmentFilter(''); setCounterpartyWorkTypeFilter('') }}
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
          <div className="modal-overlay" onClick={() => {
            setShowWinnerModal(false)
            setTenderForWinnerSelection(null)
            setSelectedWinnerId(null)
          }}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
              <div className="modal-header">
                <h3>Выбор победителя тендера</h3>
                <button
                  className="modal-close"
                  onClick={() => {
                    setShowWinnerModal(false)
                    setTenderForWinnerSelection(null)
                    setSelectedWinnerId(null)
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
                      Выберите победителя тендера:
                    </p>
                    <div style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px'
                    }}>
                      {tenderCps.map((tc) => (
                        <div
                          key={tc.id}
                          onClick={() => setSelectedWinnerId(tc.counterparty_id)}
                          style={{
                            padding: '1rem',
                            cursor: 'pointer',
                            borderBottom: '1px solid var(--border-color)',
                            backgroundColor: selectedWinnerId === tc.counterparty_id ? 'var(--primary-color)' : 'transparent',
                            color: selectedWinnerId === tc.counterparty_id ? 'white' : 'var(--text-primary)',
                            transition: 'all 0.2s',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '1rem'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedWinnerId !== tc.counterparty_id) {
                              e.currentTarget.style.backgroundColor = 'var(--hover-bg)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedWinnerId !== tc.counterparty_id) {
                              e.currentTarget.style.backgroundColor = 'transparent'
                            }
                          }}
                        >
                          <div style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '50%',
                            border: selectedWinnerId === tc.counterparty_id ? '2px solid white' : '2px solid var(--border-color)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0
                          }}>
                            {selectedWinnerId === tc.counterparty_id && (
                              <div style={{
                                width: '12px',
                                height: '12px',
                                borderRadius: '50%',
                                backgroundColor: 'white'
                              }} />
                            )}
                          </div>
                          <div>
                            <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                              {tc.counterparties?.name}
                            </div>
                            {tc.counterparties?.work_type && (
                              <div style={{
                                fontSize: '0.875rem',
                                opacity: selectedWinnerId === tc.counterparty_id ? 0.9 : 0.7
                              }}>
                                {tc.counterparties.work_type}
                              </div>
                            )}
                            <div style={{
                              fontSize: '0.75rem',
                              marginTop: '0.25rem',
                              padding: '0.25rem 0.5rem',
                              borderRadius: '4px',
                              display: 'inline-block',
                              backgroundColor: selectedWinnerId === tc.counterparty_id ? 'rgba(255,255,255,0.2)' : 'var(--bg-tertiary)',
                              color: selectedWinnerId === tc.counterparty_id ? 'white' : getCounterpartyStatusColor(tc.status)
                            }}>
                              {getCounterpartyStatusLabel(tc.status || 'request_sent')}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
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
                      setSelectedWinnerId(null)
                    }}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleConfirmWinner}
                  >
                    {selectedWinnerId ? 'Завершить с победителем' : 'Завершить без победителя'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Модальное окно с шаблонным письмом */}
      {showLetterModal && (
        <div className="modal-overlay" onClick={() => {
          setShowLetterModal(false)
          setLetterCopied(false)
        }}>
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
