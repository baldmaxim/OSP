import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { saveAs } from 'file-saver'
import '../components/ContractRegistry.css'

// Task 174: новые статусы
const STATUS_OPTIONS = [
  { value: 'new_request', label: 'Новая заявка', className: 'status-new-request' },
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'completed', label: 'Завершено', className: 'status-completed' },
]
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(s => [s.value, s.label]))

const EMPTY_FORM = {
  contract_number: '',
  contract_date: '',
  counterparty_id: '',
  object_id: '',
  contract_amount: '',
  warranty_retention_percent: '',
  warranty_retention_period: '',
  work_start_date: '',
  work_end_date: '',
  warranty_period: '',
  document_link: '',
  status: 'new_request',
  tender_id: '',
  work_name: '',
  responsible_contact_id: '',
}

function ContractRegistry() {
  const navigate = useNavigate()
  // Состояние для выбора отдела и статуса
  const [department, setDepartment] = useState(null) // null = не выбран, 'construction' | 'warranty'
  const [status, setStatus] = useState('new_request')

  const [contracts, setContracts] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingContract, setEditingContract] = useState(null)
  const [showTenderModal, setShowTenderModal] = useState(false)
  const [selectedTenderInfo, setSelectedTenderInfo] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  const [loadingTenderInfo, setLoadingTenderInfo] = useState(false)
  const templateInputRef = useRef(null)

  // Task 168: поиск контрагента
  const [counterpartySearch, setCounterpartySearch] = useState('')
  const [counterpartyDropdownOpen, setCounterpartyDropdownOpen] = useState(false)

  // Task 175: управление шаблонами и приложениями объектов
  const [showTemplatesModal, setShowTemplatesModal] = useState(false)
  const [templatesObjectId, setTemplatesObjectId] = useState('')
  const [objectAttachments, setObjectAttachments] = useState([]) // приложения текущего объекта (в модалке управления)
  const [newAttachmentName, setNewAttachmentName] = useState('')
  const [newAttachmentLink, setNewAttachmentLink] = useState('')
  // Для формы добавления договора — выбранные attachment_id (множество)
  const [formAttachments, setFormAttachments] = useState(new Set())
  const [availableAttachments, setAvailableAttachments] = useState([])
  // contract.id -> [{ id, name, link }] для отображения в таблице
  const [contractAttachmentsMap, setContractAttachmentsMap] = useState({})

  const [formData, setFormData] = useState(EMPTY_FORM)

  const objectStatus = department === 'construction' ? 'main_construction' : 'warranty_service'

  useEffect(() => {
    if (department) {
      fetchContracts()
      fetchObjects()
      fetchCounterparties()
      fetchContacts()
      fetchTenders()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, status])

  const fetchContracts = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('contracts')
        .select('*, objects(name, status, contract_template_link, contract_template_name), counterparties(name, inn, kpp, legal_address), tenders(work_description), responsible:contacts!responsible_contact_id(id, full_name, position)')
        .eq('status', status)
        .order('contract_date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })

      if (error) throw error

      const filtered = (data || []).filter(c => c.objects?.status === objectStatus)
      setContracts(filtered)

      // Подгружаем приложения для отображения в таблице
      const ids = filtered.map(c => c.id)
      if (ids.length > 0) {
        const { data: caRows, error: caErr } = await supabase
          .from('contract_attachments')
          .select('contract_id, object_contract_attachments(id, name, link, sort_order)')
          .in('contract_id', ids)
        if (caErr) throw caErr
        const map = {}
        for (const row of caRows || []) {
          const att = row.object_contract_attachments
          if (!att) continue
          if (!map[row.contract_id]) map[row.contract_id] = []
          map[row.contract_id].push(att)
        }
        // сортировка
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
        .select('id, name, status, contract_template_link, contract_template_name')
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

  const formatContractDate = (dateStr) => {
    if (!dateStr) return ''
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  }

  const formatAmount = (amount) => {
    if (!amount) return ''
    return Number(amount).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  // Task 175: загрузка .docx шаблона для выбранного объекта (сохраняется как ссылка + опционально base64 в localStorage для генерации)
  const handleTemplateUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!templatesObjectId) {
      alert('Сначала выберите объект для загрузки шаблона')
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const buffer = ev.target.result
      // Кэшируем шаблон в localStorage по object_id для последующей генерации .docx без повторной загрузки
      try {
        const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''))
        localStorage.setItem(`contractTemplate:${templatesObjectId}`, base64)
        localStorage.setItem(`contractTemplateName:${templatesObjectId}`, file.name)
      } catch (err) {
        console.warn('Не удалось закешировать шаблон в localStorage:', err)
      }
      // Сохраняем имя файла в объекте (как метку, что шаблон есть)
      try {
        await supabase
          .from('objects')
          .update({ contract_template_name: file.name })
          .eq('id', templatesObjectId)
        fetchObjects()
      } catch (err) {
        console.error('Ошибка сохранения имени шаблона:', err.message)
      }
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  // Сохранить ссылку на шаблон (Google Drive) для объекта
  const handleSaveTemplateLink = async (link) => {
    if (!templatesObjectId) return
    try {
      const { error } = await supabase
        .from('objects')
        .update({ contract_template_link: link || null })
        .eq('id', templatesObjectId)
      if (error) throw error
      fetchObjects()
    } catch (err) {
      console.error('Ошибка сохранения ссылки шаблона:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Task 175: приложения объекта — CRUD
  const fetchObjectAttachments = async (objectId) => {
    if (!objectId) {
      setObjectAttachments([])
      return
    }
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
    if (!templatesObjectId || !newAttachmentName.trim()) return
    try {
      const maxOrder = objectAttachments.reduce((m, a) => Math.max(m, a.sort_order || 0), 0)
      const { error } = await supabase
        .from('object_contract_attachments')
        .insert([{
          object_id: templatesObjectId,
          name: newAttachmentName.trim(),
          link: newAttachmentLink.trim() || null,
          sort_order: maxOrder + 1,
        }])
      if (error) throw error
      setNewAttachmentName('')
      setNewAttachmentLink('')
      fetchObjectAttachments(templatesObjectId)
    } catch (err) {
      console.error('Ошибка добавления приложения:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDeleteAttachment = async (id) => {
    if (!window.confirm('Удалить приложение из списка объекта?')) return
    try {
      const { error } = await supabase
        .from('object_contract_attachments')
        .delete()
        .eq('id', id)
      if (error) throw error
      fetchObjectAttachments(templatesObjectId)
    } catch (err) {
      console.error('Ошибка удаления приложения:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // При смене object_id в форме — подгружаем приложения и шаблон
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
        // Если редактируем — берём существующие связки, иначе по умолчанию выбраны все
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

  // При смене tender_id — автоподтягиваем work_name и counterparty (если победитель определён)
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

  // Доступные тендеры для выбранного объекта
  const availableTenders = useMemo(() => {
    if (!formData.object_id) return tenders
    return tenders.filter(t => t.object_id === formData.object_id)
  }, [tenders, formData.object_id])

  // Контакты для выбранного объекта (task 173)
  const availableContacts = useMemo(() => {
    if (!formData.object_id) return contacts
    return contacts.filter(c => c.object_id === formData.object_id)
  }, [contacts, formData.object_id])

  // Task 168: фильтрованный список контрагентов
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

  // Получить данные для подстановки в шаблон
  const getContractVariables = (contract) => {
    const cp = contract.counterparties || {}
    return {
      contract_number: contract.contract_number || '',
      contract_date: formatContractDate(contract.contract_date),
      contract_date_raw: contract.contract_date || '',
      counterparty_name: cp.name || '',
      counterparty_inn: cp.inn || '',
      counterparty_kpp: cp.kpp || '',
      counterparty_address: cp.legal_address || '',
      object_name: contract.objects?.name || '',
      work_description: contract.tenders?.work_description || '',
      work_name: contract.work_name || '',
      contract_amount: formatAmount(contract.contract_amount),
      contract_amount_raw: contract.contract_amount || '',
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: formatContractDate(contract.work_start_date),
      work_end_date: formatContractDate(contract.work_end_date),
      warranty_period: contract.warranty_period || '',
      responsible_name: contract.responsible?.full_name || '',
      responsible_position: contract.responsible?.position || '',
    }
  }

  // Сформировать .docx из шаблона объекта
  const handleGenerateDocument = (contract) => {
    const objectId = contract.object_id
    if (!objectId) {
      alert('У договора не указан объект')
      return
    }
    // Берём кэш .docx из localStorage по объекту
    const cached = localStorage.getItem(`contractTemplate:${objectId}`)
    if (!cached) {
      alert('Для этого объекта не загружен .docx-шаблон. Откройте «Шаблоны и приложения» и загрузите файл.')
      return
    }
    try {
      const binary = atob(cached)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const zip = new PizZip(bytes.buffer)
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: '{', end: '}' }
      })
      doc.render(getContractVariables(contract))
      const output = doc.getZip().generate({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      })
      const fileName = `Договор_${contract.contract_number || 'без_номера'}_${cp_short(contract)}.docx`
      saveAs(output, fileName)
    } catch (err) {
      console.error('Ошибка генерации документа:', err)
      alert('Ошибка при генерации документа: ' + (err.message || 'проверьте шаблон'))
    }
  }

  const cp_short = (contract) => {
    const name = contract.counterparties?.name || ''
    return name.substring(0, 20).replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '_')
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleSelectCounterparty = (id, name) => {
    setFormData(prev => ({ ...prev, counterparty_id: id }))
    setCounterpartySearch(name || '')
    setCounterpartyDropdownOpen(false)
  }

  // Сохранить контракт + синхронизировать contract_attachments
  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const payload = {
        ...formData,
        counterparty_id: formData.counterparty_id || null,
        object_id: formData.object_id || null,
        tender_id: formData.tender_id || null,
        responsible_contact_id: formData.responsible_contact_id || null,
        warranty_retention_percent: formData.warranty_retention_percent === '' ? null : formData.warranty_retention_percent,
      }

      let contractId = editingContract?.id
      if (editingContract) {
        const { error } = await supabase
          .from('contracts')
          .update(payload)
          .eq('id', editingContract.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('contracts')
          .insert([payload])
          .select('id')
          .single()
        if (error) throw error
        contractId = data?.id
      }

      // Sync contract_attachments
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
      setFormData({ ...EMPTY_FORM, status })
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
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: contract.work_start_date || '',
      work_end_date: contract.work_end_date || '',
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

  const handleDeleteContract = async (id, contractNumber) => {
    if (!window.confirm(`Вы уверены, что хотите удалить договор "${contractNumber}"?`)) return
    try {
      const { error } = await supabase.from('contracts').delete().eq('id', id)
      if (error) throw error
      fetchContracts()
    } catch (error) {
      console.error('Ошибка удаления договора:', error.message)
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
    setFormData({ ...EMPTY_FORM, contract_number: nextNumber, status })
    setCounterpartySearch('')
    setShowModal(true)
  }

  const handleStatusChange = async (contractId, newStatus) => {
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ status: newStatus })
        .eq('id', contractId)
      if (error) throw error
      fetchContracts()
    } catch (error) {
      console.error('Ошибка изменения статуса:', error.message)
      alert('Ошибка изменения статуса: ' + error.message)
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return ''
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const handleViewTender = async (tenderId) => {
    if (!tenderId) return
    setLoadingTenderInfo(true)
    setShowTenderModal(true)
    try {
      const { data: tenderData, error: tenderError } = await supabase
        .from('tenders')
        .select('*, objects(name), winner:counterparties!winner_counterparty_id(id, name)')
        .eq('id', tenderId)
        .single()
      if (tenderError) throw tenderError
      setSelectedTenderInfo(tenderData)

      const { data: participantsData, error: participantsError } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id, name, work_type, inn,
            counterparty_contacts(id, full_name, position, phone, email)
          )
        `)
        .eq('tender_id', tenderId)
      if (participantsError) throw participantsError
      setTenderCounterparties(participantsData || [])
    } catch (error) {
      console.error('Ошибка загрузки информации о тендере:', error.message)
      alert('Ошибка загрузки информации о тендере: ' + error.message)
      setShowTenderModal(false)
    } finally {
      setLoadingTenderInfo(false)
    }
  }

  const getCounterpartyStatusLabel = (s) => ({
    request_sent: 'Запрос отправлен',
    declined: 'Отказ',
    proposal_provided: 'КП предоставлено',
    accepted_for_work: 'Принято в работу',
  })[s] || s

  const getCounterpartyStatusColor = (s) => ({
    request_sent: '#6366f1',
    declined: '#b91c1c',
    proposal_provided: '#15803d',
    accepted_for_work: '#4338ca',
  })[s] || '#64748b'

  const handleSelectDepartment = (dept) => {
    setDepartment(dept)
    setStatus('new_request')
    setContracts([])
  }

  const handleBackToDepartments = () => {
    setDepartment(null)
    setContracts([])
    setObjects([])
  }

  // Открыть модалку управления шаблонами и приложениями объекта
  const handleOpenTemplatesModal = () => {
    setShowTemplatesModal(true)
    if (!templatesObjectId && objects.length > 0) {
      setTemplatesObjectId(objects[0].id)
      fetchObjectAttachments(objects[0].id)
    } else if (templatesObjectId) {
      fetchObjectAttachments(templatesObjectId)
    }
  }

  const handleTemplatesObjectChange = (e) => {
    const id = e.target.value
    setTemplatesObjectId(id)
    fetchObjectAttachments(id)
  }

  const currentTemplateObject = useMemo(
    () => objects.find(o => o.id === templatesObjectId),
    [objects, templatesObjectId]
  )

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

  return (
    <div className="contract-registry">
      <div className="registry-header">
        <div className="header-left">
          <button className="btn-back" onClick={handleBackToDepartments} title="Назад к выбору отдела">←</button>
          <h2>Договоры — {departmentLabel}</h2>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={handleOpenTemplatesModal}
            className="btn-secondary"
            style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
            title="Шаблон договора и стандартные приложения для каждого объекта"
          >
            📎 Шаблоны и приложения
          </button>
          <button className="btn-primary" onClick={handleAddNew}>
            + Добавить договор
          </button>
        </div>
      </div>

      {/* Task 174: 3 вкладки статусов */}
      <div className="status-tabs">
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            className={`status-tab ${status === opt.value ? 'active' : ''}`}
            onClick={() => setStatus(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
      <div className="table-container">
        <table className="contracts-table">
          <thead>
            <tr>
              <th style={{ width: '50px' }}>№ п/п</th>
              <th>№ договора</th>
              <th>Наименование контрагента</th>
              <th>Объект</th>
              <th>Наименование работ</th>
              <th>Ответственный</th>
              <th>Тендер</th>
              <th>Приложения</th>
              <th>Документ</th>
              <th>Статус</th>
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {contracts.length === 0 ? (
              <tr>
                <td colSpan="11" className="no-data">
                  Нет договоров со статусом «{STATUS_LABEL[status] || status}». Добавьте первый договор.
                </td>
              </tr>
            ) : (
              contracts.map((contract, index) => (
                <tr key={contract.id}>
                  <td style={{ textAlign: 'center', fontWeight: '600' }}>{index + 1}</td>
                  <td>
                    <button
                      onClick={() => navigate(`/contracts/${contract.id}`)}
                      style={{
                        background: 'none', border: 'none', color: 'var(--primary-color)',
                        cursor: 'pointer', padding: 0, fontSize: 'inherit', fontWeight: 600,
                        textDecoration: 'underline',
                      }}
                      title="Открыть договор"
                    >
                      №{index + 1}
                    </button>
                  </td>
                  <td>{contract.counterparties?.name || '-'}</td>
                  <td>{contract.objects?.name || '-'}</td>
                  <td>{contract.work_name || contract.tenders?.work_description || '-'}</td>
                  <td>
                    {contract.responsible ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>{contract.responsible.full_name}</div>
                        {contract.responsible.position && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{contract.responsible.position}</div>
                        )}
                      </div>
                    ) : '-'}
                  </td>
                  <td>
                    {contract.tender_id ? (
                      <button
                        type="button"
                        onClick={() => handleViewTender(contract.tender_id)}
                        style={{
                          background: 'none', border: 'none', color: 'var(--primary-color)',
                          textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 'inherit',
                        }}
                        title="Информация о тендере"
                      >
                        {contract.tenders?.work_description || 'Тендер'}
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>-</span>
                    )}
                  </td>
                  <td>
                    {(contractAttachmentsMap[contract.id] || []).length === 0 ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>-</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                        {(contractAttachmentsMap[contract.id] || []).map(a => (
                          a.link ? (
                            <a key={a.id} href={a.link} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--primary-color)', fontSize: '0.8125rem' }}>
                              {a.name}
                            </a>
                          ) : (
                            <span key={a.id} style={{ fontSize: '0.8125rem' }}>{a.name}</span>
                          )
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      {contract.document_link && (
                        <a href={contract.document_link} target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--primary-color)', textDecoration: 'underline', fontSize: '0.8125rem' }}>
                          Открыть
                        </a>
                      )}
                      <button
                        onClick={() => handleGenerateDocument(contract)}
                        style={{
                          padding: '0.2rem 0.5rem', fontSize: '0.75rem',
                          border: '1px solid var(--primary-color)', borderRadius: '3px',
                          background: 'transparent', color: 'var(--primary-color)', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                        title="Сформировать договор из шаблона объекта"
                      >
                        Скачать .docx
                      </button>
                    </div>
                  </td>
                  <td>
                    <select
                      className={`status-select ${STATUS_OPTIONS.find(o => o.value === contract.status)?.className || ''}`}
                      value={contract.status || 'new_request'}
                      onChange={(e) => handleStatusChange(contract.id, e.target.value)}
                    >
                      {STATUS_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="actions-cell">
                    <button className="btn-icon btn-edit" onClick={() => handleEditContract(contract)} title="Редактировать">✏️</button>
                    <button
                      className="btn-icon btn-delete"
                      onClick={() => handleDeleteContract(contract.id, contract.contract_number)}
                      title="Удалить"
                    >🗑️</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
                  <label>№ договора *</label>
                  <input type="text" name="contract_number" value={formData.contract_number} onChange={handleInputChange} required />
                </div>

                <div className="form-group">
                  <label>Дата договора *</label>
                  <input type="date" name="contract_date" value={formData.contract_date} onChange={handleInputChange} required />
                </div>

                {/* Task 168: поиск контрагента */}
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
                    {objects.map((obj) => (
                      <option key={obj.id} value={obj.id}>{obj.name}</option>
                    ))}
                  </select>
                </div>

                {/* Task 171: тендер */}
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

                {/* Task 172: наименование работ */}
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

                {/* Task 173: ответственный */}
                <div className="form-group full-width">
                  <label>Ответственный сотрудник</label>
                  <select name="responsible_contact_id" value={formData.responsible_contact_id} onChange={handleInputChange}>
                    <option value="">— Не назначен —</option>
                    {availableContacts.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.full_name}{c.position ? ` (${c.position})` : ''}
                      </option>
                    ))}
                  </select>
                  {!formData.object_id && (
                    <small style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                      Выберите объект, чтобы увидеть его сотрудников.
                    </small>
                  )}
                </div>

                <div className="form-group full-width">
                  <label>Сумма по договору *</label>
                  <input type="number" step="0.01" name="contract_amount" value={formData.contract_amount} onChange={handleInputChange} required />
                </div>

                {/* Task 169: Гарантийное удержание + Срок гарантийного удержания — на одной строке */}
                <div className="form-group">
                  <label>Гарантийное удержание (%)</label>
                  <input type="number" step="0.01" name="warranty_retention_percent" value={formData.warranty_retention_percent} onChange={handleInputChange} />
                </div>
                <div className="form-group">
                  <label>Срок гарантийных удержаний</label>
                  <input type="text" name="warranty_retention_period" value={formData.warranty_retention_period} onChange={handleInputChange} placeholder="Например: 12 месяцев" />
                </div>

                {/* Task 170: Начало работ + Окончание работ — на одной строке */}
                <div className="form-group">
                  <label>Начало работ</label>
                  <input type="date" name="work_start_date" value={formData.work_start_date} onChange={handleInputChange} />
                </div>
                <div className="form-group">
                  <label>Окончание работ</label>
                  <input type="date" name="work_end_date" value={formData.work_end_date} onChange={handleInputChange} />
                </div>

                <div className="form-group full-width">
                  <label>Срок гарантии на работы</label>
                  <input type="text" name="warranty_period" value={formData.warranty_period} onChange={handleInputChange} placeholder="Например: 24 месяца" />
                </div>

                <div className="form-group full-width">
                  <label>Ссылка на документ (Google Drive)</label>
                  <input type="url" name="document_link" value={formData.document_link} onChange={handleInputChange} placeholder="https://docs.google.com/document/d/..." />
                </div>

                {/* Task 175: выпадающий список приложений объекта */}
                {availableAttachments.length > 0 && (
                  <div className="form-group full-width">
                    <label>Приложения к договору</label>
                    <div className="attachments-checklist">
                      {availableAttachments.map(a => (
                        <label key={a.id} className="attachment-row">
                          <input
                            type="checkbox"
                            checked={formAttachments.has(a.id)}
                            onChange={() => {
                              const next = new Set(formAttachments)
                              if (next.has(a.id)) next.delete(a.id); else next.add(a.id)
                              setFormAttachments(next)
                            }}
                          />
                          <span>{a.name}</span>
                          {a.link && (
                            <a href={a.link} target="_blank" rel="noopener noreferrer" className="attachment-link"
                              onClick={(e) => e.stopPropagation()}>(ссылка)</a>
                          )}
                        </label>
                      ))}
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

      {/* Task 175: модалка управления шаблонами и приложениями */}
      {showTemplatesModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '720px' }}>
            <div className="modal-header">
              <h3>Шаблоны и приложения объектов</h3>
              <button className="modal-close" onClick={() => setShowTemplatesModal(false)}>×</button>
            </div>
            <div style={{ padding: '1.5rem 2rem' }}>
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label>Объект</label>
                <select value={templatesObjectId} onChange={handleTemplatesObjectChange}>
                  <option value="">Выберите объект</option>
                  {objects.map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>

              {templatesObjectId && (
                <>
                  <section style={{ marginBottom: '2rem' }}>
                    <h4 style={{ margin: '0 0 0.75rem' }}>Шаблон договора (.docx)</h4>
                    <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                      <label>Ссылка на шаблон (Google Drive)</label>
                      <input
                        type="url"
                        defaultValue={currentTemplateObject?.contract_template_link || ''}
                        placeholder="https://drive.google.com/file/d/..."
                        onBlur={(e) => handleSaveTemplateLink(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => templateInputRef.current?.click()}
                        style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
                      >
                        {currentTemplateObject?.contract_template_name
                          ? `Заменить .docx (${currentTemplateObject.contract_template_name})`
                          : 'Загрузить .docx для генерации'}
                      </button>
                      <small style={{ color: 'var(--text-tertiary)' }}>
                        Локальная копия в браузере используется для автозаполнения шаблона переменными.
                      </small>
                    </div>
                  </section>

                  <section>
                    <h4 style={{ margin: '0 0 0.75rem' }}>Стандартные приложения объекта</h4>
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
                              {a.link && (
                                <a href={a.link} target="_blank" rel="noopener noreferrer"
                                  style={{ color: 'var(--primary-color)', fontSize: '0.8125rem', wordBreak: 'break-all' }}>
                                  {a.link}
                                </a>
                              )}
                            </div>
                            <button type="button" className="btn-icon btn-delete"
                              onClick={() => handleDeleteAttachment(a.id)}
                              title="Удалить">🗑️</button>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="attachment-add-row">
                      <input
                        type="text"
                        placeholder="Название приложения"
                        value={newAttachmentName}
                        onChange={(e) => setNewAttachmentName(e.target.value)}
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
                  </section>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setShowTemplatesModal(false)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модальное окно информации о тендере */}
      {showTenderModal && department && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
            <div className="modal-header">
              <h3>Информация о тендере</h3>
              <button
                className="modal-close"
                onClick={() => { setShowTenderModal(false); setSelectedTenderInfo(null); setTenderCounterparties([]) }}
              >×</button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              {loadingTenderInfo ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Загрузка...</div>
              ) : selectedTenderInfo ? (
                <>
                  <div style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', padding: '1.5rem', marginBottom: '1.5rem' }}>
                    <div style={{ display: 'grid', gap: '1rem' }}>
                      <div>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Объект:</span>
                        <p style={{ margin: '0.25rem 0 0', fontWeight: '600', color: 'var(--text-primary)' }}>
                          {selectedTenderInfo.objects?.name || '-'}
                        </p>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Описание работ:</span>
                        <p style={{ margin: '0.25rem 0 0', color: 'var(--text-primary)' }}>
                          {selectedTenderInfo.work_description || '-'}
                        </p>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Статус:</span>
                          <p style={{ margin: '0.25rem 0 0', fontWeight: '600', color: 'var(--text-primary)' }}>
                            {selectedTenderInfo.status || '-'}
                          </p>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Дата начала:</span>
                          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-primary)' }}>
                            {selectedTenderInfo.start_date ? formatDate(selectedTenderInfo.start_date) : '-'}
                          </p>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Дата окончания:</span>
                          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-primary)' }}>
                            {selectedTenderInfo.end_date ? formatDate(selectedTenderInfo.end_date) : '-'}
                          </p>
                        </div>
                      </div>
                      {selectedTenderInfo.winner && (
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Победитель:</span>
                          <p style={{
                            margin: '0.25rem 0 0', display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                            padding: '0.375rem 0.75rem', backgroundColor: '#dcfce7', color: '#166534',
                            borderRadius: '6px', fontSize: '0.875rem', fontWeight: '600'
                          }}>
                            🏆 {selectedTenderInfo.winner.name}
                          </p>
                        </div>
                      )}
                      {selectedTenderInfo.tender_package_link && (
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Тендерный пакет:</span>
                          <p style={{ margin: '0.25rem 0 0' }}>
                            <a href={selectedTenderInfo.tender_package_link} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--primary-color)' }}>
                              Открыть документ
                            </a>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 style={{ margin: '0 0 1rem', color: 'var(--text-primary)' }}>
                      Участники тендера ({tenderCounterparties.length})
                    </h4>
                    {tenderCounterparties.length === 0 ? (
                      <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic', textAlign: 'center',
                        padding: '2rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                        Участники не были добавлены к этому тендеру
                      </p>
                    ) : (
                      <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden',
                        maxHeight: '350px', overflowY: 'auto' }}>
                        <table className="contracts-table" style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th style={{ width: '50px' }}>№</th>
                              <th>Наименование</th>
                              <th>Контактные данные</th>
                              <th>Статус</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tenderCounterparties.map((tc, index) => (
                              <tr key={tc.id} style={{
                                backgroundColor: selectedTenderInfo.winner?.id === tc.counterparty_id
                                  ? 'rgba(34, 197, 94, 0.1)' : 'transparent'
                              }}>
                                <td style={{ textAlign: 'center', fontWeight: '600' }}>
                                  {selectedTenderInfo.winner?.id === tc.counterparty_id ? '🏆' : index + 1}
                                </td>
                                <td>
                                  <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{tc.counterparties?.name}</div>
                                  {tc.counterparties?.work_type && (
                                    <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                      {tc.counterparties.work_type}
                                    </div>
                                  )}
                                  {tc.counterparties?.inn && (
                                    <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                      ИНН: {tc.counterparties.inn}
                                    </div>
                                  )}
                                </td>
                                <td>
                                  {tc.counterparties?.counterparty_contacts && tc.counterparties.counterparty_contacts.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                                      {tc.counterparties.counterparty_contacts.map((contact, idx) => (
                                        <div key={contact.id || idx} style={{ fontSize: '0.875rem' }}>
                                          {contact.full_name && (
                                            <div style={{ fontWeight: '500' }}>
                                              {contact.full_name}
                                              {contact.position && (
                                                <span style={{ color: 'var(--text-secondary)', fontWeight: '400', marginLeft: '0.5rem' }}>
                                                  ({contact.position})
                                                </span>
                                              )}
                                            </div>
                                          )}
                                          {contact.phone && (
                                            <a href={`tel:${contact.phone}`} style={{ color: 'var(--primary-color)', textDecoration: 'none', display: 'block' }}>
                                              {contact.phone}
                                            </a>
                                          )}
                                          {contact.email && (
                                            <a href={`mailto:${contact.email}`} style={{ color: 'var(--primary-color)', textDecoration: 'none', display: 'block' }}>
                                              {contact.email}
                                            </a>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '0.875rem' }}>
                                      Не указаны
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span style={{
                                    display: 'inline-block', padding: '0.375rem 0.75rem', borderRadius: '6px',
                                    fontSize: '0.75rem', fontWeight: '600',
                                    border: `2px solid ${getCounterpartyStatusColor(tc.status || 'request_sent')}`,
                                    color: getCounterpartyStatusColor(tc.status || 'request_sent')
                                  }}>
                                    {getCounterpartyStatusLabel(tc.status || 'request_sent')}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  Информация о тендере не найдена
                </div>
              )}

              <div style={{
                display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem',
                paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)'
              }}>
                <button className="btn-secondary"
                  onClick={() => { setShowTenderModal(false); setSelectedTenderInfo(null); setTenderCounterparties([]) }}>
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Скрытый input для загрузки .docx шаблона */}
      <input ref={templateInputRef} type="file" accept=".docx" onChange={handleTemplateUpload} style={{ display: 'none' }} />
    </div>
  )
}

export default ContractRegistry
