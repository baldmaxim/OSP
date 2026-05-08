import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { saveAs } from 'file-saver'
import '../components/ContractRegistry.css'

function ContractRegistry() {
  const navigate = useNavigate()
  // Состояние для выбора отдела и статуса
  const [department, setDepartment] = useState(null) // null = не выбран, 'construction' | 'warranty'
  const [status, setStatus] = useState('pending') // 'pending' | 'signed'

  const [contracts, setContracts] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingContract, setEditingContract] = useState(null)
  const [showTenderModal, setShowTenderModal] = useState(false)
  const [selectedTenderInfo, setSelectedTenderInfo] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  const [loadingTenderInfo, setLoadingTenderInfo] = useState(false)
  const [showRequisitesModal, setShowRequisitesModal] = useState(false)
  const [requisitesContract, setRequisitesContract] = useState(null)
  const [requisitesCopied, setRequisitesCopied] = useState(false)
  const [templateFile, setTemplateFile] = useState(null) // ArrayBuffer шаблона
  const [templateName, setTemplateName] = useState(localStorage.getItem('contractTemplateName') || '')
  const templateInputRef = useRef(null)
  const [formData, setFormData] = useState({
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
    status: 'pending',
  })

  // Определяем статус объекта в зависимости от отдела
  const objectStatus = department === 'construction' ? 'main_construction' : 'warranty_service'

  useEffect(() => {
    if (department) {
      fetchContracts()
      fetchObjects()
      fetchCounterparties()
    }
  }, [department, status])

  const fetchContracts = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('contracts')
        .select('*, objects(name, status), counterparties(name, inn, kpp, legal_address), tenders(work_description)')
        .eq('status', status)
        .order('contract_date', { ascending: false })

      if (error) throw error

      // Фильтруем договоры по статусу объекта (отделу)
      const filteredContracts = (data || []).filter(
        contract => contract.objects?.status === objectStatus
      )
      setContracts(filteredContracts)
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
        .order('name', { ascending: true })

      if (error) throw error
      setCounterparties(data || [])
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
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

  // Загрузка шаблона .docx
  const handleTemplateUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      setTemplateFile(ev.target.result)
      setTemplateName(file.name)
      localStorage.setItem('contractTemplateName', file.name)
      // Сохраняем в localStorage как base64
      const base64 = btoa(
        new Uint8Array(ev.target.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )
      localStorage.setItem('contractTemplate', base64)
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  // Загрузить шаблон из localStorage при старте
  useEffect(() => {
    const saved = localStorage.getItem('contractTemplate')
    if (saved) {
      const binary = atob(saved)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      setTemplateFile(bytes.buffer)
    }
  }, [])

  // Получить данные для подстановки
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
      contract_amount: formatAmount(contract.contract_amount),
      contract_amount_raw: contract.contract_amount || '',
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: formatContractDate(contract.work_start_date),
      work_end_date: formatContractDate(contract.work_end_date),
      warranty_period: contract.warranty_period || '',
    }
  }

  // Сформировать .docx из шаблона
  const handleGenerateDocument = (contract) => {
    if (!templateFile) {
      alert('Сначала загрузите шаблон договора (.docx)')
      return
    }

    try {
      const zip = new PizZip(templateFile)
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

  const handleShowRequisites = (contract) => {
    setRequisitesContract(contract)
    setShowRequisitesModal(true)
    setRequisitesCopied(false)
  }

  // Список доступных переменных
  const TEMPLATE_VARIABLES = [
    ['{contract_number}', '№ договора'],
    ['{contract_date}', 'Дата договора (текстом)'],
    ['{counterparty_name}', 'Наименование контрагента'],
    ['{counterparty_inn}', 'ИНН контрагента'],
    ['{counterparty_kpp}', 'КПП контрагента'],
    ['{counterparty_address}', 'Юридический адрес контрагента'],
    ['{object_name}', 'Наименование объекта'],
    ['{work_description}', 'Описание работ (из тендера)'],
    ['{contract_amount}', 'Сумма договора'],
    ['{warranty_retention_percent}', 'Гарантийное удержание (%)'],
    ['{warranty_retention_period}', 'Срок гарантийного удержания'],
    ['{work_start_date}', 'Начало работ'],
    ['{work_end_date}', 'Окончание работ'],
    ['{warranty_period}', 'Срок гарантии'],
  ]

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      if (editingContract) {
        // Update existing contract
        const { error } = await supabase
          .from('contracts')
          .update(formData)
          .eq('id', editingContract.id)

        if (error) throw error
      } else {
        // Insert new contract
        const { error } = await supabase.from('contracts').insert([formData])
        if (error) throw error
      }

      setShowModal(false)
      setEditingContract(null)
      setFormData({
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
        status: status,
      })
      fetchContracts()
    } catch (error) {
      console.error('Ошибка сохранения договора:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditContract = (contract) => {
    setEditingContract(contract)
    setFormData({
      contract_number: contract.contract_number,
      contract_date: contract.contract_date,
      counterparty_id: contract.counterparty_id || '',
      object_id: contract.object_id || '',
      contract_amount: contract.contract_amount,
      warranty_retention_percent: contract.warranty_retention_percent || '',
      warranty_retention_period: contract.warranty_retention_period || '',
      work_start_date: contract.work_start_date || '',
      work_end_date: contract.work_end_date || '',
      warranty_period: contract.warranty_period || '',
      document_link: contract.document_link || '',
      status: contract.status || 'pending',
    })
    setShowModal(true)
  }

  const handleDeleteContract = async (id, contractNumber) => {
    if (
      window.confirm(`Вы уверены, что хотите удалить договор "${contractNumber}"?`)
    ) {
      try {
        const { error } = await supabase.from('contracts').delete().eq('id', id)

        if (error) throw error
        fetchContracts()
      } catch (error) {
        console.error('Ошибка удаления договора:', error.message)
        alert('Ошибка удаления: ' + error.message)
      }
    }
  }

  // Подбираем следующий порядковый номер договора: max(числовой contract_number) + 1.
  // Существующие нечисловые номера (например, «12-А-2024») игнорируем.
  const computeNextContractNumber = async () => {
    try {
      const { data, error } = await supabase
        .from('contracts')
        .select('contract_number')
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
    setFormData({
      contract_number: nextNumber,
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
      status: status,
    })
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
      // Загружаем информацию о тендере
      const { data: tenderData, error: tenderError } = await supabase
        .from('tenders')
        .select('*, objects(name), winner:counterparties!winner_counterparty_id(id, name)')
        .eq('id', tenderId)
        .single()

      if (tenderError) throw tenderError
      setSelectedTenderInfo(tenderData)

      // Загружаем участников тендера
      const { data: participantsData, error: participantsError } = await supabase
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

  const getCounterpartyStatusLabel = (status) => {
    const options = {
      'request_sent': 'Запрос отправлен',
      'declined': 'Отказ',
      'proposal_provided': 'КП предоставлено',
      'accepted_for_work': 'Принято в работу'
    }
    return options[status] || status
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6366f1',
      'declined': '#b91c1c',
      'proposal_provided': '#15803d',
      'accepted_for_work': '#4338ca'
    }
    return colors[status] || '#64748b'
  }

  // Выбор отдела
  const handleSelectDepartment = (dept) => {
    setDepartment(dept)
    setStatus('pending') // Сбрасываем статус на "На согласовании" при смене отдела
    setContracts([])
  }

  // Возврат к выбору отдела
  const handleBackToDepartments = () => {
    setDepartment(null)
    setContracts([])
    setObjects([])
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
            <button
              className="department-card"
              onClick={() => handleSelectDepartment('construction')}
            >
              <span className="department-icon">🏗️</span>
              <span className="department-name">Основное строительство</span>
            </button>
            <button
              className="department-card"
              onClick={() => handleSelectDepartment('warranty')}
            >
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
          <button className="btn-back" onClick={handleBackToDepartments} title="Назад к выбору отдела">
            ←
          </button>
          <h2>Договоры — {departmentLabel}</h2>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={() => templateInputRef.current?.click()}
            style={{
              padding: '0.375rem 0.75rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title="Загрузите .docx шаблон с переменными {contract_number}, {counterparty_name} и т.д."
          >
            {templateName ? `Шаблон: ${templateName}` : 'Загрузить шаблон .docx'}
          </button>
          <button className="btn-primary" onClick={handleAddNew}>
            + Добавить договор
          </button>
        </div>
      </div>

      {/* Табы статуса */}
      <div className="status-tabs">
        <button
          className={`status-tab ${status === 'pending' ? 'active' : ''}`}
          onClick={() => setStatus('pending')}
        >
          На согласовании
        </button>
        <button
          className={`status-tab ${status === 'signed' ? 'active' : ''}`}
          onClick={() => setStatus('signed')}
        >
          Заключенные ДП
        </button>
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
              <th>Тендер</th>
              <th>Документ</th>
              <th>Статус</th>
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {contracts.length === 0 ? (
              <tr>
                <td colSpan="8" className="no-data">
                  {status === 'pending'
                    ? 'Нет договоров на согласовании. Добавьте первый договор.'
                    : 'Нет заключенных договоров.'}
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
                        background: 'none',
                        border: 'none',
                        color: 'var(--primary-color)',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: 'inherit',
                        fontWeight: 600,
                        textDecoration: 'underline',
                      }}
                      title="Открыть договор"
                    >
                      {contract.contract_number || '—'}
                    </button>
                  </td>
                  <td>{contract.counterparties?.name || '-'}</td>
                  <td>{contract.objects?.name || '-'}</td>
                  <td>
                    {contract.tender_id ? (
                      <a
                        href={`/tenders/${contract.tender_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: 'var(--primary-color)',
                          textDecoration: 'underline',
                          fontSize: 'inherit',
                        }}
                        title="Открыть тендер в новой вкладке"
                      >
                        {contract.tenders?.work_description || 'Тендер'}
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>-</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                      {contract.document_link && (
                        <a
                          href={contract.document_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--primary-color)', textDecoration: 'underline', fontSize: '0.8125rem' }}
                        >
                          Открыть
                        </a>
                      )}
                      <button
                        onClick={() => handleGenerateDocument(contract)}
                        style={{
                          padding: '0.2rem 0.5rem',
                          fontSize: '0.75rem',
                          border: '1px solid var(--primary-color)',
                          borderRadius: '3px',
                          background: 'transparent',
                          color: 'var(--primary-color)',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                        title="Сформировать договор из шаблона"
                      >
                        Скачать .docx
                      </button>
                    </div>
                  </td>
                  <td>
                    <select
                      className={`status-select ${contract.status === 'signed' ? 'status-signed' : 'status-pending'}`}
                      value={contract.status || 'pending'}
                      onChange={(e) => handleStatusChange(contract.id, e.target.value)}
                    >
                      <option value="pending">На согласовании</option>
                      <option value="signed">Заключен</option>
                    </select>
                  </td>
                  <td className="actions-cell">
                    <button
                      className="btn-icon btn-edit"
                      onClick={() => handleEditContract(contract)}
                      title="Редактировать"
                    >
                      ✏️
                    </button>
                    <button
                      className="btn-icon btn-delete"
                      onClick={() =>
                        handleDeleteContract(
                          contract.id,
                          contract.contract_number
                        )
                      }
                      title="Удалить"
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingContract
                  ? 'Редактировать договор'
                  : 'Добавить новый договор'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowModal(false)
                  setEditingContract(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group">
                  <label>№ договора *</label>
                  <input
                    type="text"
                    name="contract_number"
                    value={formData.contract_number}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Дата договора *</label>
                  <input
                    type="date"
                    name="contract_date"
                    value={formData.contract_date}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label>Наименование контрагента *</label>
                  <select
                    name="counterparty_id"
                    value={formData.counterparty_id}
                    onChange={handleInputChange}
                    required
                  >
                    <option value="">Выберите контрагента</option>
                    {counterparties.map((counterparty) => (
                      <option key={counterparty.id} value={counterparty.id}>
                        {counterparty.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Объект работ *</label>
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

                <div className="form-group">
                  <label>Сумма по договору *</label>
                  <input
                    type="number"
                    step="0.01"
                    name="contract_amount"
                    value={formData.contract_amount}
                    onChange={handleInputChange}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Гарантийное удержание (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    name="warranty_retention_percent"
                    value={formData.warranty_retention_percent}
                    onChange={handleInputChange}
                  />
                </div>

                <div className="form-group">
                  <label>Срок гарантийных удержаний</label>
                  <input
                    type="text"
                    name="warranty_retention_period"
                    value={formData.warranty_retention_period}
                    onChange={handleInputChange}
                    placeholder="Например: 12 месяцев"
                  />
                </div>

                <div className="form-group">
                  <label>Начало работ</label>
                  <input
                    type="date"
                    name="work_start_date"
                    value={formData.work_start_date}
                    onChange={handleInputChange}
                  />
                </div>

                <div className="form-group">
                  <label>Окончание работ</label>
                  <input
                    type="date"
                    name="work_end_date"
                    value={formData.work_end_date}
                    onChange={handleInputChange}
                  />
                </div>

                <div className="form-group">
                  <label>Срок гарантии на работы</label>
                  <input
                    type="text"
                    name="warranty_period"
                    value={formData.warranty_period}
                    onChange={handleInputChange}
                    placeholder="Например: 24 месяца"
                  />
                </div>

                <div className="form-group full-width">
                  <label>Ссылка на документ (Google Drive)</label>
                  <input
                    type="url"
                    name="document_link"
                    value={formData.document_link}
                    onChange={handleInputChange}
                    placeholder="https://docs.google.com/document/d/..."
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowModal(false)
                    setEditingContract(null)
                  }}
                >
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

      {/* Модальное окно информации о тендере */}
      {showTenderModal && department && (
        <div className="modal-overlay" onClick={() => {
          setShowTenderModal(false)
          setSelectedTenderInfo(null)
          setTenderCounterparties([])
        }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
            <div className="modal-header">
              <h3>Информация о тендере</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowTenderModal(false)
                  setSelectedTenderInfo(null)
                  setTenderCounterparties([])
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              {loadingTenderInfo ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  Загрузка...
                </div>
              ) : selectedTenderInfo ? (
                <>
                  {/* Основная информация о тендере */}
                  <div style={{
                    backgroundColor: 'var(--bg-tertiary)',
                    borderRadius: '8px',
                    padding: '1.5rem',
                    marginBottom: '1.5rem'
                  }}>
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
                            margin: '0.25rem 0 0',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.375rem 0.75rem',
                            backgroundColor: '#dcfce7',
                            color: '#166534',
                            borderRadius: '6px',
                            fontSize: '0.875rem',
                            fontWeight: '600'
                          }}>
                            🏆 {selectedTenderInfo.winner.name}
                          </p>
                        </div>
                      )}
                      {selectedTenderInfo.tender_package_link && (
                        <div>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Тендерный пакет:</span>
                          <p style={{ margin: '0.25rem 0 0' }}>
                            <a
                              href={selectedTenderInfo.tender_package_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: 'var(--primary-color)' }}
                            >
                              Открыть документ
                            </a>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Участники тендера */}
                  <div>
                    <h4 style={{ margin: '0 0 1rem', color: 'var(--text-primary)' }}>
                      Участники тендера ({tenderCounterparties.length})
                    </h4>

                    {tenderCounterparties.length === 0 ? (
                      <p style={{
                        color: 'var(--text-secondary)',
                        fontStyle: 'italic',
                        textAlign: 'center',
                        padding: '2rem',
                        backgroundColor: 'var(--bg-tertiary)',
                        borderRadius: '8px'
                      }}>
                        Участники не были добавлены к этому тендеру
                      </p>
                    ) : (
                      <div style={{
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        overflow: 'hidden',
                        maxHeight: '350px',
                        overflowY: 'auto'
                      }}>
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
                              <tr
                                key={tc.id}
                                style={{
                                  backgroundColor: selectedTenderInfo.winner?.id === tc.counterparty_id
                                    ? 'rgba(34, 197, 94, 0.1)'
                                    : 'transparent'
                                }}
                              >
                                <td style={{ textAlign: 'center', fontWeight: '600' }}>
                                  {selectedTenderInfo.winner?.id === tc.counterparty_id ? '🏆' : index + 1}
                                </td>
                                <td>
                                  <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                                    {tc.counterparties?.name}
                                  </div>
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
                                    display: 'inline-block',
                                    padding: '0.375rem 0.75rem',
                                    borderRadius: '6px',
                                    fontSize: '0.75rem',
                                    fontWeight: '600',
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
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: '1.5rem',
                paddingTop: '1.5rem',
                borderTop: '1px solid var(--border-color)'
              }}>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setShowTenderModal(false)
                    setSelectedTenderInfo(null)
                    setTenderCounterparties([])
                  }}
                >
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Скрытый input для загрузки шаблона */}
      <input
        ref={templateInputRef}
        type="file"
        accept=".docx"
        onChange={handleTemplateUpload}
        style={{ display: 'none' }}
      />
    </div>
  )
}

export default ContractRegistry
