import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import '../components/TenderDetail.css'

function TenderDetailPage() {
  const { tenderId } = useParams()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [tender, setTender] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  const [estimateItems, setEstimateItems] = useState([])
  const [proposals, setProposals] = useState({})
  const [proposalFiles, setProposalFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('estimate') // 'estimate', 'comparison', 'participants'
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [selectedCounterpartyForUpload, setSelectedCounterpartyForUpload] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [showAddEstimateModal, setShowAddEstimateModal] = useState(false)
  const [showImportEstimateModal, setShowImportEstimateModal] = useState(false)
  const [editingEstimateItem, setEditingEstimateItem] = useState(null)
  const [selectedEstimateItems, setSelectedEstimateItems] = useState(new Set())

  // Состояния для множественных смет
  const [expandedEstimates, setExpandedEstimates] = useState(new Set(['Основная смета']))

  // Состояния для документов тендера (исходные данные) - ссылки на Google Drive
  const [tenderDocuments, setTenderDocuments] = useState([])
  const [estimateTemplate, setEstimateTemplate] = useState(null)
  const [showAddDocumentModal, setShowAddDocumentModal] = useState(false)
  const [addingDocumentType, setAddingDocumentType] = useState('attachment') // 'attachment' или 'estimate_template'
  const [documentFormData, setDocumentFormData] = useState({ name: '', url: '' })
  const [savingDocument, setSavingDocument] = useState(false)

  // Состояния для добавления участников
  const [showAddParticipantModal, setShowAddParticipantModal] = useState(false)
  const [availableCounterparties, setAvailableCounterparties] = useState([])
  const [selectedParticipants, setSelectedParticipants] = useState(new Set())
  const [loadingCounterparties, setLoadingCounterparties] = useState(false)
  const [participantSearchQuery, setParticipantSearchQuery] = useState('')

  // Полноэкранный режим для таблицы сравнения КП
  const [isComparisonFullscreen, setIsComparisonFullscreen] = useState(false)
  const [comparisonSubTab, setComparisonSubTab] = useState('all') // 'all' | 'materials'

  // Полноэкранный режим для просмотра сметы
  const [isEstimateFullscreen, setIsEstimateFullscreen] = useState(false)

  const [estimateFormData, setEstimateFormData] = useState({
    row_number: '',
    code: '',
    cost_name: '',
    calculation_note: '',
    unit: '',
    work_volume: '',
    material_consumption: ''
  })

  useEffect(() => {
    if (tenderId) {
      fetchTenderData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenderId])

  // Закрытие полноэкранного режима по Escape
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        if (isComparisonFullscreen) setIsComparisonFullscreen(false)
        if (isEstimateFullscreen) setIsEstimateFullscreen(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isComparisonFullscreen, isEstimateFullscreen])

  const fetchTenderData = async () => {
    setLoading(true)
    try {
      // Загружаем данные тендера
      const { data: tenderData, error: tenderError } = await supabase
        .from('tenders')
        .select('*, objects(name, status), winner:counterparties!winner_counterparty_id(id, name)')
        .eq('id', tenderId)
        .single()

      if (tenderError) throw tenderError
      setTender(tenderData)

      // Загружаем контрагентов тендера
      const { data: counterpartiesData, error: cpError } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id,
            name,
            work_type,
            inn,
            counterparty_contacts(id, full_name, position, phone, email)
          )
        `)
        .eq('tender_id', tenderId)

      if (cpError) throw cpError
      setTenderCounterparties(counterpartiesData || [])

      // Загружаем позиции сметы
      const { data: estimateData, error: estimateError } = await supabase
        .from('tender_estimate_items')
        .select('*')
        .eq('tender_id', tenderId)
        .order('row_number', { ascending: true })

      if (!estimateError) {
        setEstimateItems(estimateData || [])
      }

      // Загружаем предложения контрагентов
      const { data: proposalsData, error: proposalsError } = await supabase
        .from('tender_counterparty_proposals')
        .select('*')
        .eq('tender_id', tenderId)

      if (!proposalsError && proposalsData) {
        // Группируем предложения по контрагентам
        const grouped = {}
        proposalsData.forEach(p => {
          if (!grouped[p.counterparty_id]) {
            grouped[p.counterparty_id] = {}
          }
          grouped[p.counterparty_id][p.estimate_item_id] = p
        })
        setProposals(grouped)
      }

      // Загружаем файлы предложений
      const { data: filesData, error: filesError } = await supabase
        .from('tender_proposal_files')
        .select('*, counterparties(name)')
        .eq('tender_id', tenderId)
        .order('uploaded_at', { ascending: false })

      if (!filesError) {
        setProposalFiles(filesData || [])
      }

      // Загружаем документы тендера (исходные данные)
      const { data: docsData, error: docsError } = await supabase
        .from('tender_documents')
        .select('*')
        .eq('tender_id', tenderId)
        .order('created_at', { ascending: false })

      if (!docsError) {
        setTenderDocuments(docsData || [])
        // Находим шаблон сметы
        const template = docsData?.find(d => d.document_type === 'estimate_template')
        setEstimateTemplate(template || null)
      }

    } catch (error) {
      console.error('Ошибка загрузки данных тендера:', error.message)
      alert('Ошибка загрузки данных: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleAddEstimateItem = () => {
    const nextRowNumber = estimateItems.length > 0
      ? Math.max(...estimateItems.map(i => i.row_number)) + 1
      : 1
    setEstimateFormData({
      row_number: nextRowNumber,
      code: '',
      cost_name: '',
      calculation_note: '',
      unit: '',
      work_volume: '',
      material_consumption: ''
    })
    setEditingEstimateItem(null)
    setShowAddEstimateModal(true)
  }

  const handleEditEstimateItem = (item) => {
    setEstimateFormData({
      row_number: item.row_number,
      code: item.code || '',
      cost_name: item.cost_name || '',
      calculation_note: item.calculation_note || '',
      unit: item.unit || '',
      work_volume: item.work_volume || '',
      material_consumption: item.material_consumption || ''
    })
    setEditingEstimateItem(item)
    setShowAddEstimateModal(true)
  }

  const handleSaveEstimateItem = async (e) => {
    e.preventDefault()
    try {
      // Автоопределение типа затрат по коду
      let costType = null
      const code = estimateFormData.code?.trim()
      if (code) {
        if (code.toLowerCase().startsWith('мат')) costType = 'Материалы'
        else if (code.toUpperCase().startsWith('Р')) costType = 'Работы'
      }

      const itemData = {
        tender_id: tenderId,
        row_number: parseInt(estimateFormData.row_number),
        code: code || null,
        cost_type: costType,
        cost_name: estimateFormData.cost_name,
        calculation_note: estimateFormData.calculation_note || null,
        unit: estimateFormData.unit || null,
        work_volume: estimateFormData.work_volume ? parseFloat(estimateFormData.work_volume) : null,
        material_consumption: estimateFormData.material_consumption ? parseFloat(estimateFormData.material_consumption) : null
      }

      if (editingEstimateItem) {
        const { error } = await supabase
          .from('tender_estimate_items')
          .update(itemData)
          .eq('id', editingEstimateItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('tender_estimate_items')
          .insert([itemData])
        if (error) throw error
      }

      setShowAddEstimateModal(false)
      fetchTenderData()
    } catch (error) {
      console.error('Ошибка сохранения позиции:', error.message)
      alert('Ошибка сохранения: ' + error.message)
    }
  }

  const handleDeleteEstimateItem = async (itemId) => {
    if (!window.confirm('Удалить эту позицию сметы?')) return
    try {
      const { error } = await supabase
        .from('tender_estimate_items')
        .delete()
        .eq('id', itemId)
      if (error) throw error
      setSelectedEstimateItems(prev => {
        const newSet = new Set(prev)
        newSet.delete(itemId)
        return newSet
      })
      fetchTenderData()
    } catch (error) {
      console.error('Ошибка удаления:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // Функции для множественного выбора и удаления позиций сметы
  const handleToggleSelectItem = (itemId) => {
    setSelectedEstimateItems(prev => {
      const newSet = new Set(prev)
      if (newSet.has(itemId)) {
        newSet.delete(itemId)
      } else {
        newSet.add(itemId)
      }
      return newSet
    })
  }

  const handleDeleteSelectedItems = async () => {
    if (selectedEstimateItems.size === 0) return
    if (!window.confirm(`Удалить ${selectedEstimateItems.size} выбранных позиций?`)) return

    try {
      const idsToDelete = Array.from(selectedEstimateItems)
      const { error } = await supabase
        .from('tender_estimate_items')
        .delete()
        .in('id', idsToDelete)
      if (error) throw error
      setSelectedEstimateItems(new Set())
      fetchTenderData()
      alert(`Удалено ${idsToDelete.length} позиций`)
    } catch (error) {
      console.error('Ошибка удаления:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // ========== Функции для работы с документами тендера (ссылки Google Drive) ==========
  const handleOpenAddDocument = (docType) => {
    setAddingDocumentType(docType)
    setDocumentFormData({ name: '', url: '' })
    setShowAddDocumentModal(true)
  }

  const handleSaveDocument = async (e) => {
    e.preventDefault()
    if (!documentFormData.name.trim() || !documentFormData.url.trim()) {
      alert('Заполните название и ссылку')
      return
    }

    setSavingDocument(true)
    try {
      const { error } = await supabase
        .from('tender_documents')
        .insert({
          tender_id: tenderId,
          name: documentFormData.name.trim(),
          url: documentFormData.url.trim(),
          document_type: addingDocumentType
        })

      if (error) throw error

      setShowAddDocumentModal(false)
      fetchTenderData()
    } catch (error) {
      console.error('Ошибка сохранения документа:', error.message)
      alert('Ошибка сохранения: ' + error.message)
    } finally {
      setSavingDocument(false)
    }
  }

  const handleDeleteDocument = async (doc) => {
    if (!window.confirm(`Удалить ссылку "${doc.name}"?`)) return

    try {
      const { error } = await supabase
        .from('tender_documents')
        .delete()
        .eq('id', doc.id)

      if (error) throw error
      fetchTenderData()
    } catch (error) {
      console.error('Ошибка удаления:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // Функции для добавления участников
  const handleOpenAddParticipantModal = async () => {
    setShowAddParticipantModal(true)
    setSelectedParticipants(new Set())
    setLoadingCounterparties(true)

    try {
      // Загружаем всех активных контрагентов
      const { data, error } = await supabase
        .from('counterparties')
        .select('id, name, work_type, inn')
        .eq('status', 'active')
        .order('name')

      if (error) throw error

      // Исключаем уже добавленных участников
      const existingIds = tenderCounterparties.map(tc => tc.counterparty_id)
      const available = (data || []).filter(c => !existingIds.includes(c.id))

      setAvailableCounterparties(available)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error)
      alert('Ошибка загрузки списка контрагентов')
    } finally {
      setLoadingCounterparties(false)
    }
  }

  const handleToggleParticipant = (counterpartyId) => {
    setSelectedParticipants(prev => {
      const newSet = new Set(prev)
      if (newSet.has(counterpartyId)) {
        newSet.delete(counterpartyId)
      } else {
        newSet.add(counterpartyId)
      }
      return newSet
    })
  }

  const handleAddParticipants = async () => {
    if (selectedParticipants.size === 0) {
      alert('Выберите хотя бы одного контрагента')
      return
    }

    try {
      const participantsToAdd = Array.from(selectedParticipants).map(counterpartyId => ({
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        status: 'request_sent'
      }))

      const { error } = await supabase
        .from('tender_counterparties')
        .insert(participantsToAdd)

      if (error) throw error

      setShowAddParticipantModal(false)
      setSelectedParticipants(new Set())
      setParticipantSearchQuery('')
      fetchTenderData()
      alert(`Добавлено ${participantsToAdd.length} участников`)
    } catch (error) {
      console.error('Ошибка добавления участников:', error)
      alert('Ошибка добавления: ' + error.message)
    }
  }

  const handleUpdateParticipantStatus = async (tenderCounterpartyId, newStatus) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      // Обновляем локальное состояние без перезагрузки всех данных
      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId
            ? { ...tc, status: newStatus }
            : tc
        )
      )
    } catch (error) {
      console.error('Ошибка обновления статуса:', error)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const getDocumentIcon = (url) => {
    if (url.includes('drive.google.com')) return '📁'
    if (url.includes('docs.google.com/spreadsheets')) return '📊'
    if (url.includes('docs.google.com/document')) return '📝'
    if (url.includes('docs.google.com/presentation')) return '📽️'
    return '🔗'
  }

  // ========== Функции для работы с множественными сметами ==========

  // Получить уникальные названия смет
  const getEstimateNames = () => {
    const names = new Set()
    estimateItems.forEach(item => {
      names.add(item.estimate_name || 'Основная смета')
    })
    return Array.from(names).sort()
  }

  // Получить позиции по названию сметы
  const getItemsByEstimate = (estimateName) => {
    return estimateItems.filter(item =>
      (item.estimate_name || 'Основная смета') === estimateName
    ).sort((a, b) => a.row_number - b.row_number)
  }

  // Переключить раскрытие/скрытие сметы
  const toggleEstimateExpanded = (estimateName) => {
    setExpandedEstimates(prev => {
      const newSet = new Set(prev)
      if (newSet.has(estimateName)) {
        newSet.delete(estimateName)
      } else {
        newSet.add(estimateName)
      }
      return newSet
    })
  }

  // Удалить всю смету
  const handleDeleteEstimate = async (estimateName) => {
    if (!window.confirm(`Удалить смету "${estimateName}" со всеми позициями?`)) return

    try {
      const itemsToDelete = estimateItems
        .filter(item => (item.estimate_name || 'Основная смета') === estimateName)
        .map(item => item.id)

      if (itemsToDelete.length === 0) return

      const { error } = await supabase
        .from('tender_estimate_items')
        .delete()
        .in('id', itemsToDelete)

      if (error) throw error
      fetchTenderData()
      alert(`Смета "${estimateName}" удалена`)
    } catch (error) {
      console.error('Ошибка удаления сметы:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // ========== Функции для группировки позиций и генерации шаблона КП ==========

  // Группировка позиций сметы по ключу (наименование) - для шаблона расценок
  const getGroupedEstimateItems = () => {
    const grouped = {}

    estimateItems.forEach(item => {
      // Ключ группировки: наименование затрат (объединяем одинаковые позиции)
      const costName = item.cost_name?.trim() || ''
      if (!costName) return // Пропускаем позиции без наименования

      // Определяем тип позиции по коду: мат. = материалы, Р- = работы
      const code = item.code?.trim() || ''
      const isMaterial = code.toLowerCase().startsWith('мат')
      const isWork = code.toUpperCase().startsWith('Р')
      const itemType = isMaterial ? 'material' : (isWork ? 'work' : 'unknown')

      // Ключ = наименование + тип (чтобы не смешивать материалы и работы с одинаковым названием)
      const groupKey = `${costName}__${itemType}`

      if (!grouped[groupKey]) {
        grouped[groupKey] = {
          key: groupKey,
          code: item.code,
          cost_type: item.cost_type,
          cost_name: costName,
          unit: item.unit,
          itemType: itemType, // 'material' или 'work'
          total_volume: 0, // Объём (работ или расход материала)
          items: [],
          rowNumbers: []
        }
      }

      // Суммируем объём в зависимости от типа
      if (itemType === 'material') {
        grouped[groupKey].total_volume += parseFloat(item.material_consumption) || 0
      } else {
        grouped[groupKey].total_volume += parseFloat(item.work_volume) || 0
      }

      grouped[groupKey].items.push(item)
      grouped[groupKey].rowNumbers.push(item.row_number)
    })

    return Object.values(grouped).sort((a, b) => {
      // Сортируем по первому номеру строки в группе
      return Math.min(...a.rowNumbers) - Math.min(...b.rowNumbers)
    })
  }

  // Генерация упрощённого шаблона для заполнения расценок
  const handleDownloadPriceTemplate = () => {
    // Фильтруем только материалы (код начинается с "мат." или тип затрат = Материалы)
    const materialItems = estimateItems.filter(item => {
      if (item.is_section) return false  // Пропускаем разделы
      const code = (item.code || '').toLowerCase().trim()
      const costType = (item.cost_type || '').toLowerCase()
      return code.startsWith('мат') || code === 'мат.' || code === 'мат' || costType === 'материалы'
    })

    if (materialItems.length === 0) {
      alert('Сначала загрузите смету с материалами (код "мат.")')
      return
    }

    // Группируем по наименованию, суммируем объёмы, собираем позиции
    const groupedItems = {}
    materialItems.forEach(item => {
      const name = (item.cost_name || '').trim()
      if (!name) return

      if (!groupedItems[name]) {
        groupedItems[name] = {
          cost_name: name,
          unit: item.unit || '',
          total_volume: 0,
          positions: []
        }
      }

      // Суммируем объём (берём material_consumption или work_volume)
      const volume = parseFloat(item.material_consumption) || parseFloat(item.work_volume) || 0
      groupedItems[name].total_volume += volume

      // Добавляем позицию в список
      const posNum = String(item.original_row_number || item.row_number || '')
      if (posNum && !groupedItems[name].positions.includes(posNum)) {
        groupedItems[name].positions.push(posNum)
      }
    })

    // Преобразуем в массив и сортируем по наименованию
    const sortedItems = Object.values(groupedItems).sort((a, b) =>
      a.cost_name.localeCompare(b.cost_name, 'ru')
    )

    if (sortedItems.length === 0) {
      alert('Не удалось сгруппировать позиции')
      return
    }

    // Заголовки шаблона
    const headers = [
      '№ п/п',
      'Наименование затрат',
      'Ед. изм.',
      'Объем',
      'Ед. расценка за материал с учетом НДС 22%',
      'Ед. расценка за работы с учетом НДС 22%',
      'Позиции в смете'
    ]

    // Данные
    const dataRows = sortedItems.map((item, idx) => [
      idx + 1,
      item.cost_name,
      item.unit,
      item.total_volume || '',
      '',  // Ед. расценка за материал - ЗАПОЛНЯЕТ ПОДРЯДЧИК
      '',  // Ед. расценка за работы - ЗАПОЛНЯЕТ ПОДРЯДЧИК
      item.positions.join(', ')
    ])

    // Создаём Excel
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])

    // Ширина колонок
    ws['!cols'] = [
      { wch: 8 },   // № п/п
      { wch: 55 },  // Наименование затрат
      { wch: 10 },  // Ед. изм.
      { wch: 12 },  // Объем
      { wch: 40 },  // Ед. расценка за материал
      { wch: 40 },  // Ед. расценка за работы
      { wch: 20 }   // Позиции в смете
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Расценки')

    const objectName = tender?.objects?.name || 'Тендер'
    const fileName = `Расценки_${objectName.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}.xlsx`
    XLSX.writeFile(wb, fileName)
  }

  // Импорт заполненных расценок и распределение на все позиции
  const handleImportPricesFromTemplate = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    try {
      const reader = new FileReader()
      reader.onload = async (event) => {
        try {
          const data = new Uint8Array(event.target.result)
          const workbook = XLSX.read(data, { type: 'array' })
          const worksheet = workbook.Sheets[workbook.SheetNames[0]]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          // Парсим расценки из шаблона
          // Структура: 0-№ п/п, 1-Наименование затрат, 2-Ед.изм., 3-Объем, 4-Расценка материал, 5-Расценка работы, 6-Позиции в смете
          const priceMap = {} // key (наименование) -> { priceMaterial, priceWork }

          for (let i = 1; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row || row.length < 5) continue

            const costName = row[1]?.toString().trim()
            const priceMaterial = parseFloat(row[4]) || 0
            const priceWork = parseFloat(row[5]) || 0

            if (!costName || (priceMaterial <= 0 && priceWork <= 0)) continue

            priceMap[costName] = { priceMaterial, priceWork }
          }

          if (Object.keys(priceMap).length === 0) {
            alert('Не найдены расценки в файле. Заполните колонки «Ед. расценка за материал» или «Ед. расценка за работы»')
            return
          }

          // Формируем предложения для каждой позиции сметы
          const proposalsToInsert = []

          estimateItems.forEach(item => {
            if (item.is_section) return // Пропускаем разделы

            const costName = item.cost_name?.trim() || ''
            const priceData = priceMap[costName]

            if (priceData) {
              const workVolume = parseFloat(item.work_volume) || 0
              const materialConsumption = parseFloat(item.material_consumption) || 0

              const unitPriceMaterials = priceData.priceMaterial
              const unitPriceWorks = priceData.priceWork
              const totalMaterials = unitPriceMaterials * materialConsumption
              const totalWorks = unitPriceWorks * workVolume
              const totalCost = totalMaterials + totalWorks

              proposalsToInsert.push({
                tender_id: tenderId,
                counterparty_id: selectedCounterpartyForUpload,
                estimate_item_id: item.id,
                unit_price_materials: unitPriceMaterials,
                unit_price_works: unitPriceWorks,
                total_unit_price: unitPriceMaterials + unitPriceWorks,
                total_materials: totalMaterials,
                total_works: totalWorks,
                total_cost: totalCost
              })
            }
          })

          if (proposalsToInsert.length === 0) {
            alert('Не удалось сопоставить расценки с позициями сметы. Проверьте наименования.')
            return
          }

          // Дедупликация по estimate_item_id (оставляем последнюю запись)
          const uniqueProposals = Object.values(
            proposalsToInsert.reduce((acc, proposal) => {
              acc[proposal.estimate_item_id] = proposal
              return acc
            }, {})
          )

          // Удаляем старые предложения этого контрагента для этого тендера
          const { error: deleteError } = await supabase
            .from('tender_counterparty_proposals')
            .delete()
            .eq('tender_id', tenderId)
            .eq('counterparty_id', selectedCounterpartyForUpload)

          if (deleteError) {
            console.error('Ошибка удаления старых предложений:', deleteError)
            throw deleteError
          }

          // Вставляем новые предложения
          const { error } = await supabase
            .from('tender_counterparty_proposals')
            .insert(uniqueProposals)

          if (error) throw error

          setShowUploadModal(false)
          fetchTenderData()
          alert(`Импортировано расценок для ${uniqueProposals.length} из ${estimateItems.length} позиций`)

        } catch (parseError) {
          console.error('Ошибка парсинга:', parseError)
          alert('Ошибка чтения файла: ' + parseError.message)
        }
      }
      reader.readAsArrayBuffer(file)
    } catch (error) {
      console.error('Ошибка импорта:', error)
      alert('Ошибка импорта: ' + error.message)
    }
  }

  const handleUploadClick = (counterpartyId) => {
    setSelectedCounterpartyForUpload(counterpartyId)
    setShowUploadModal(true)
  }

  const handleFileSelect = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert('Пожалуйста, выберите файл Excel (.xlsx или .xls)')
      return
    }

    setUploading(true)
    try {
      const reader = new FileReader()
      reader.onload = async (event) => {
        try {
          const data = new Uint8Array(event.target.result)
          const workbook = XLSX.read(data, { type: 'array' })
          const sheetName = workbook.SheetNames[0]
          const worksheet = workbook.Sheets[sheetName]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          // Парсим данные из Excel и сохраняем предложения
          await parseAndSaveProposals(jsonData, selectedCounterpartyForUpload, file.name)

          setShowUploadModal(false)
          setSelectedCounterpartyForUpload(null)
          fetchTenderData()
        } catch (parseError) {
          console.error('Ошибка парсинга Excel:', parseError)
          alert('Ошибка чтения файла Excel: ' + parseError.message)
        }
      }
      reader.readAsArrayBuffer(file)
    } catch (error) {
      console.error('Ошибка загрузки файла:', error)
      alert('Ошибка загрузки: ' + error.message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const parseAndSaveProposals = async (excelData, counterpartyId, fileName) => {
    // Предполагаем, что данные начинаются со 2-й строки (первая - заголовки)
    // Структура: № п/п, КОД, ..., Цена материалы, Цена работы, ..., Примечание
    // Нужно будет адаптировать под реальную структуру Excel файла

    const proposalsToInsert = []

    // Пропускаем заголовок, начинаем с индекса 1
    for (let i = 1; i < excelData.length; i++) {
      const row = excelData[i]
      if (!row || row.length === 0) continue

      const rowNumber = parseInt(row[0])
      if (isNaN(rowNumber)) continue

      // Находим позицию сметы по номеру строки
      const estimateItem = estimateItems.find(item => item.row_number === rowNumber)
      if (!estimateItem) continue

      // Индексы колонок - нужно адаптировать под реальную структуру
      // Предполагаем: колонка 8 - цена материалы, колонка 9 - цена работы, последняя - примечание
      const unitPriceMaterials = parseFloat(row[8]) || 0
      const unitPriceWorks = parseFloat(row[9]) || 0
      const participantNote = row[row.length - 1] || ''

      const workVolume = estimateItem.work_volume || 0
      const totalUnitPrice = unitPriceMaterials + unitPriceWorks
      const totalMaterials = unitPriceMaterials * workVolume
      const totalWorks = unitPriceWorks * workVolume
      const totalCost = totalMaterials + totalWorks

      proposalsToInsert.push({
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        estimate_item_id: estimateItem.id,
        unit_price_materials: unitPriceMaterials,
        unit_price_works: unitPriceWorks,
        total_unit_price: totalUnitPrice,
        total_materials: totalMaterials,
        total_works: totalWorks,
        total_cost: totalCost,
        participant_note: participantNote
      })
    }

    if (proposalsToInsert.length > 0) {
      // Дедупликация по estimate_item_id (оставляем последнюю запись)
      const uniqueProposals = Object.values(
        proposalsToInsert.reduce((acc, proposal) => {
          acc[proposal.estimate_item_id] = proposal
          return acc
        }, {})
      )

      // Удаляем старые предложения этого контрагента
      const { error: deleteError } = await supabase
        .from('tender_counterparty_proposals')
        .delete()
        .eq('tender_id', tenderId)
        .eq('counterparty_id', counterpartyId)

      if (deleteError) {
        console.error('Ошибка удаления старых предложений:', deleteError)
        throw deleteError
      }

      // Вставляем новые
      const { error } = await supabase
        .from('tender_counterparty_proposals')
        .insert(uniqueProposals)

      if (error) throw error

      // Сохраняем информацию о файле
      await supabase
        .from('tender_proposal_files')
        .insert([{
          tender_id: tenderId,
          counterparty_id: counterpartyId,
          file_name: fileName,
          file_url: '',  // Можно добавить загрузку в Storage
          file_size: 0
        }])
    }
  }

  // Удаление загруженного КП
  const handleDeleteProposalFile = async (file) => {
    const counterpartyName = file.counterparties?.name || 'подрядчика'
    if (!window.confirm(`Удалить КП от "${counterpartyName}"?\n\nВсе расценки от этого подрядчика будут удалены.`)) {
      return
    }

    try {
      // Удаляем предложения (расценки) этого подрядчика
      await supabase
        .from('tender_counterparty_proposals')
        .delete()
        .eq('tender_id', tenderId)
        .eq('counterparty_id', file.counterparty_id)

      // Удаляем запись о файле
      const { error } = await supabase
        .from('tender_proposal_files')
        .delete()
        .eq('id', file.id)

      if (error) throw error

      // Обновляем данные
      fetchTenderData()
    } catch (error) {
      console.error('Ошибка удаления КП:', error)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  // Импорт сметы из Excel - название берётся из имени файла
  // Структура: A=№ п/п, B=КОД, C=Наименование затрат, D=Ед.изм., E=Объем, F=Расход
  // Разделы (заголовки секций) сохраняются как отдельные строки с is_section=true
  const handleImportEstimateFromExcel = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    // Название сметы = имя файла без расширения
    const estimateName = file.name.replace(/\.(xlsx|xls)$/i, '').trim() || 'Новая смета'
    const existingEstimate = getEstimateNames().includes(estimateName)

    // Если смета с таким именем существует - спрашиваем
    if (existingEstimate) {
      if (!window.confirm(`Смета "${estimateName}" уже существует. Заменить её?`)) {
        e.target.value = ''
        return
      }
    }

    try {
      const reader = new FileReader()
      reader.onload = async (event) => {
        try {
          const data = new Uint8Array(event.target.result)
          const workbook = XLSX.read(data, { type: 'array' })
          const sheetName = workbook.SheetNames[0]
          const worksheet = workbook.Sheets[sheetName]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          // Парсим смету из Excel
          // Структура колонок:
          // A (0) = № п/п
          // B (1) = КОД
          // C (2) = Наименование затрат
          // D (3) = Ед. изм.
          // E (4) = Объем по виду работ
          // F (5) = Общий расход по материалу

          // Ищем строку заголовка таблицы (начало таблицы)
          // Таблица начинается там, где в колонке A есть "№ п/п" или в колонке B есть "КОД"
          let headerRowIndex = -1
          for (let i = 0; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row || row.length === 0) continue

            const colA = row[0]?.toString().trim().toLowerCase() || ''
            const colB = row[1]?.toString().trim().toLowerCase() || ''
            const colC = row[2]?.toString().trim().toLowerCase() || ''

            // Проверяем, является ли это строкой заголовка таблицы
            const isHeader = (colA.includes('№') && colA.includes('п/п')) ||
                             colA === '№ п/п' ||
                             colA === 'n п/п' ||
                             colB === 'код' ||
                             colB === 'code' ||
                             (colC.includes('наименование') && colC.includes('затрат'))

            if (isHeader) {
              headerRowIndex = i
              break
            }
          }

          // Если заголовок не найден, начинаем с первой строки (предполагаем, что данные идут сразу)
          const startRowIndex = headerRowIndex >= 0 ? headerRowIndex + 1 : 0

          const itemsToInsert = []

          // Находим максимальный row_number среди ВСЕХ существующих позиций тендера
          // (кроме позиций сметы, которую заменяем)
          const existingItems = existingEstimate
            ? estimateItems.filter(item => (item.estimate_name || 'Основная смета') !== estimateName)
            : estimateItems

          const maxExistingRowNumber = existingItems.length > 0
            ? Math.max(...existingItems.map(item => item.row_number))
            : 0

          // Нумерация новых позиций начинается после максимального существующего номера
          let nextRowNumber = maxExistingRowNumber + 1

          for (let i = startRowIndex; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row || row.length === 0) continue

            // Читаем данные по колонкам A-F
            const colA = row[0]?.toString().trim() || ''              // A: № п/п (оригинальный)
            const colB = row[1]?.toString().trim() || ''              // B: КОД
            const colC = row[2]?.toString().trim() || ''              // C: Наименование затрат
            const unit = row[3]?.toString().trim() || ''              // D: Ед. изм.
            const workVolume = row[4]                                  // E: Объем
            const materialConsumption = row[5]                         // F: Расход

            // Определяем, является ли это объединённой ячейкой (часть/раздел)
            // Объединённые ячейки: текст в колонке A или B, остальные колонки пустые
            const hasNumericInRow = (parseFloat(workVolume) > 0) || (parseFloat(materialConsumption) > 0)
            const isColANumber = /^\d+$/.test(colA) || colA === ''
            const isStandardCode = colB.toUpperCase().startsWith('Р') ||
                                   colB.toUpperCase().startsWith('P') ||
                                   colB.toLowerCase().startsWith('мат')

            // Если в колонке A есть текст (не число), B и C пустые, и нет числовых данных - это раздел
            const isMergedSection = !isColANumber && colA !== '' && !colB && !colC && !hasNumericInRow
            // Если в колонке B есть текст (не код), C пустая, и нет числовых данных - тоже раздел
            const isMergedSectionB = !isStandardCode && colB !== '' && !colC && !hasNumericInRow && isColANumber

            let originalRowNum, code, costName

            if (isMergedSection) {
              // Объединённая ячейка - название раздела в колонке A
              originalRowNum = ''
              code = ''
              costName = colA
            } else if (isMergedSectionB) {
              // Объединённая ячейка - название раздела в колонке B
              originalRowNum = colA.substring(0, 20)  // VARCHAR(20)
              code = ''
              costName = colB
            } else {
              // Обычная строка
              originalRowNum = colA.substring(0, 20)   // VARCHAR(20)
              code = colB.substring(0, 50)             // VARCHAR(50)
              costName = colC
            }

            // Ограничиваем длину unit
            const unitTrimmed = unit.substring(0, 50)  // VARCHAR(50)

            // Пропускаем полностью пустые строки
            if (!costName && !code) continue

            // Проверяем, не достигли ли строки ИТОГО - после неё прекращаем импорт
            const lowerCostName = costName.toLowerCase()
            const lowerOriginalRow = originalRowNum.toLowerCase()
            const lowerCode = code.toLowerCase()
            const combinedText = (lowerCostName + ' ' + lowerOriginalRow + ' ' + lowerCode).toLowerCase()

            // Если встретили ИТОГО - прекращаем импорт (все последующие строки игнорируются)
            if (combinedText.includes('итого') || lowerCostName.startsWith('итого') || lowerOriginalRow.startsWith('итого')) {
              break
            }

            // Пропускаем служебные строки (примечания, условия и т.д.)
            const isFooterRow = combinedText.includes('авансирован') ||
                                combinedText.includes('плательщик') ||
                                combinedText.includes('ндс') ||
                                combinedText.includes('гарантийн') ||
                                combinedText.includes('приступить к работ') ||
                                combinedText.includes('готовность') ||
                                combinedText.includes('срок выполнения') ||
                                combinedText.includes('срок поставки') ||
                                combinedText.includes('срок исполнения') ||
                                combinedText.includes('условия оплаты') ||
                                combinedText.includes('примечание') ||
                                combinedText.includes('всего:') ||
                                combinedText.includes('подпись') ||
                                combinedText.includes('печать') ||
                                combinedText.includes('директор') ||
                                combinedText.includes('генеральный') ||
                                combinedText.includes('посещени') ||
                                combinedText.includes('наличие сро') ||
                                combinedText.includes('сро') && combinedText.includes('наличие') ||
                                combinedText.includes('численность') ||
                                combinedText.includes('дата регистрации') ||
                                combinedText.includes('оборот за') ||
                                combinedText.includes('сайт компании') ||
                                combinedText.includes('контактное лицо') ||
                                combinedText.includes('ткп претендента') ||
                                combinedText.includes('предмета тендера')
            if (isFooterRow) continue

            // Определяем, является ли строка разделом (заголовком секции)
            // Раздел - это строка, у которой:
            // - есть наименование (costName)
            // - НЕТ кода типа "Р-XXX" или "мат."
            // - обычно нет единицы измерения, объёма и расхода
            const isWorkCode = code.toUpperCase().startsWith('Р') || code.toUpperCase().startsWith('P')
            const isMaterialCode = code.toLowerCase().startsWith('мат')
            const hasStandardCode = isWorkCode || isMaterialCode

            // Строка является разделом если:
            // 1. Есть наименование
            // 2. Нет стандартного кода (Р или мат.) ИЛИ код пустой
            // 3. Нет числовых данных (объём и расход)
            const hasNumericData = (parseFloat(workVolume) > 0) || (parseFloat(materialConsumption) > 0)
            const isSection = Boolean(costName && !hasStandardCode && !hasNumericData)

            // Определяем тип затрат
            let costType = null
            if (isSection) {
              costType = 'Раздел'
            } else if (isMaterialCode) {
              costType = 'Материалы'
            } else if (isWorkCode) {
              costType = 'Работы'
            }

            const rowNumber = nextRowNumber++

            itemsToInsert.push({
              tender_id: tenderId,
              estimate_name: estimateName,
              row_number: rowNumber,
              original_row_number: originalRowNum || null,
              code: code || null,
              cost_type: costType,
              cost_name: costName || '',
              unit: unitTrimmed || null,
              work_volume: parseFloat(workVolume) || null,
              material_consumption: parseFloat(materialConsumption) || null,
              is_section: isSection
            })
          }

          if (itemsToInsert.length > 0) {
            // Удаляем старую смету с таким же названием (если есть)
            if (existingEstimate) {
              const oldItems = estimateItems
                .filter(item => (item.estimate_name || 'Основная смета') === estimateName)
                .map(item => item.id)
              if (oldItems.length > 0) {
                await supabase
                  .from('tender_estimate_items')
                  .delete()
                  .in('id', oldItems)
              }
            }

            // Вставляем новые позиции
            const { error } = await supabase
              .from('tender_estimate_items')
              .insert(itemsToInsert)

            if (error) throw error

            // Раскрываем добавленную смету
            setExpandedEstimates(prev => new Set([...prev, estimateName]))

            // Подсчитываем статистику
            const sectionsCount = itemsToInsert.filter(i => i.is_section).length
            const itemsCount = itemsToInsert.length - sectionsCount

            fetchTenderData()
            alert(`Импортировано в смету "${estimateName}":\n• ${sectionsCount} разделов\n• ${itemsCount} позиций`)
          } else {
            alert('Не найдено позиций для импорта. Проверьте структуру файла.')
          }
        } catch (parseError) {
          console.error('Ошибка парсинга:', parseError)
          alert('Ошибка чтения файла: ' + parseError.message)
        }
      }
      reader.readAsArrayBuffer(file)
    } catch (error) {
      console.error('Ошибка импорта:', error)
      alert('Ошибка импорта: ' + error.message)
    }

    // Сбрасываем input для возможности повторного выбора того же файла
    e.target.value = ''
  }

  const handleDownloadEstimateTemplate = () => {
    // Создаем шаблон сметы - структура A-F
    // Включает пример раздела (секции) и позиций
    const templateData = [
      ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу'],
      // Пример раздела (секции) - строка без кода и без числовых данных
      ['', '', '1. Электромонтажные работы', '', '', ''],
      // Позиции раздела
      ['', 'мат.', 'Кабель ВВГнг 3x2.5', 'м', '', 105],
      [1, 'Р-001', 'Монтаж кабеля', 'м', 100, ''],
      ['', 'мат.', 'Кабель-канал 40x25', 'м', '', 50],
      [2, 'Р-002', 'Монтаж кабель-канала', 'м', 50, ''],
      // Пример второго раздела
      ['', '', '2. Отделочные работы', '', '', ''],
      ['', 'мат.', 'Краска водоэмульсионная', 'кг', '', 25],
      [3, 'Р-003', 'Покраска стен', 'м²', 120, ''],
    ]

    const ws = XLSX.utils.aoa_to_sheet(templateData)

    // Устанавливаем ширину колонок (A-F)
    ws['!cols'] = [
      { wch: 8 },   // A: № п/п
      { wch: 12 },  // B: КОД
      { wch: 45 },  // C: Наименование затрат
      { wch: 10 },  // D: Ед. изм.
      { wch: 20 },  // E: Объем по виду работ
      { wch: 25 },  // F: Общий расход по материалу
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Смета')
    XLSX.writeFile(wb, 'Шаблон_сметы.xlsx')
  }

  const handleDownloadProposalTemplate = () => {
    // Создаем шаблон расценок на основе существующей сметы
    // Только позиции с кодом "материал" (мат.)
    // Одинаковые позиции группируются, объёмы суммируются

    console.log('All estimate items:', estimateItems.length, estimateItems)

    // Фильтруем только материалы (код начинается с "мат." или тип затрат = Материалы)
    const materialItems = estimateItems.filter(item => {
      if (item.is_section) return false  // Пропускаем разделы
      const code = (item.code || '').toLowerCase().trim()
      const costType = (item.cost_type || '').toLowerCase()
      return code.startsWith('мат') || code === 'мат.' || code === 'мат' || costType === 'материалы'
    })

    console.log('Filtered material items:', materialItems.length, materialItems)

    if (materialItems.length === 0) {
      alert('В смете нет позиций с кодом "материал" (мат.)\n\nВсего позиций в смете: ' + estimateItems.length)
      return
    }

    // Группируем по наименованию, суммируем объёмы, собираем позиции
    const groupedItems = {}
    materialItems.forEach(item => {
      const name = (item.cost_name || '').trim()
      if (!name) return

      if (!groupedItems[name]) {
        groupedItems[name] = {
          cost_name: name,
          unit: item.unit || '',
          total_volume: 0,
          positions: []
        }
      }

      // Суммируем объём (берём material_consumption или work_volume)
      const volume = parseFloat(item.material_consumption) || parseFloat(item.work_volume) || 0
      groupedItems[name].total_volume += volume

      // Добавляем позицию в список (конвертируем в строку для корректного сравнения)
      const posNum = String(item.original_row_number || item.row_number || '')
      if (posNum && !groupedItems[name].positions.includes(posNum)) {
        groupedItems[name].positions.push(posNum)
      }
    })

    console.log('Material items found:', materialItems.length)
    console.log('Grouped items:', Object.keys(groupedItems).length)

    // Преобразуем в массив и сортируем по наименованию
    const sortedItems = Object.values(groupedItems).sort((a, b) =>
      a.cost_name.localeCompare(b.cost_name, 'ru')
    )

    if (sortedItems.length === 0) {
      alert('Не удалось сгруппировать позиции. Проверьте данные сметы.')
      return
    }

    console.log('Sorted items for export:', sortedItems)

    const headerRow = [
      '№ п/п',
      'Наименование затрат',
      'Ед. изм.',
      'Объем',
      'Ед. расценка за материал с учетом НДС 22%',
      'Ед. расценка за работы с учетом НДС 22%',
      'Позиции в смете'
    ]

    const dataRows = sortedItems.map((item, idx) => {
      return [
        idx + 1,                                    // A: № п/п
        item.cost_name,                             // B: Наименование затрат
        item.unit,                                  // C: Ед. изм.
        item.total_volume || '',                    // D: Объем (суммарный)
        '',                                         // E: Ед. расценка за материал - заполняет подрядчик
        '',                                         // F: Ед. расценка за работы - заполняет подрядчик
        item.positions.join(', ')                   // G: Позиции в смете
      ]
    })

    const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])

    // Устанавливаем ширину колонок
    ws['!cols'] = [
      { wch: 8 },   // A: № п/п
      { wch: 55 },  // B: Наименование затрат
      { wch: 10 },  // C: Ед. изм.
      { wch: 12 },  // D: Объем
      { wch: 38 },  // E: Ед. расценка за материал
      { wch: 38 },  // F: Ед. расценка за работы
      { wch: 20 }   // G: Позиции в смете
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'КП')

    const fileName = tender?.objects?.name
      ? `КП_${tender.objects.name.replace(/[/\\?%*:|"<>]/g, '_')}.xlsx`
      : 'Шаблон_КП.xlsx'
    XLSX.writeFile(wb, fileName)
  }

  const formatDate = (dateString) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const formatCurrency = (amount) => {
    if (!amount && amount !== 0) return '-'
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      minimumFractionDigits: 2
    }).format(amount)
  }

  const getStatusBadgeClass = (status) => {
    const classes = {
      'Не начат': 'status-not-started',
      'Идет тендерная процедура': 'status-in-progress',
      'Завершен': 'status-completed'
    }
    return classes[status] || ''
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6366f1',
      'declined': '#b91c1c',
      'proposal_provided': '#15803d'
    }
    return colors[status] || '#64748b'
  }

  // Расчет итогов для сравнительной таблицы
  const calculateTotals = (counterpartyId, forAllItems = false) => {
    const cpProposals = proposals[counterpartyId] || {}
    let totalMaterials = 0
    let totalWorks = 0
    let totalCost = 0

    // Фильтруем позиции в соответствии с текущей вкладкой (или берём все для сводки)
    // Для materials/works вкладок показываем все позиции, т.к. расценки могут быть у любой
    const filteredItems = forAllItems ? estimateItems : estimateItems.filter(item => {
      if (comparisonSubTab === 'all' || comparisonSubTab === 'summary') return true
      if (item.is_section) return false
      // Для materials и works показываем все позиции
      return true
    })

    filteredItems.forEach(item => {
      const proposal = cpProposals[item.id]
      if (proposal) {
        // Определяем объём как в таблице
        const code = (item.code || '').toLowerCase().trim()
        const isMaterial = code.startsWith('мат') || code === 'мат.' || code === 'мат'
        const volume = isMaterial
          ? (parseFloat(item.material_consumption) || parseFloat(item.work_volume) || 0)
          : (parseFloat(item.work_volume) || 0)

        const matTotal = (proposal.unit_price_materials || 0) * volume
        const workTotal = (proposal.unit_price_works || 0) * volume

        totalMaterials += matTotal
        totalWorks += workTotal
        totalCost += matTotal + workTotal
      }
    })

    return { totalMaterials, totalWorks, totalCost }
  }

  // Получить все итоги по подрядчикам для сводной таблицы
  const getAllCounterpartyTotals = () => {
    return tenderCounterparties.map(tc => {
      const totals = calculateTotals(tc.counterparty_id, true)
      return {
        id: tc.counterparty_id,
        name: tc.counterparties?.name || 'Неизвестный',
        ...totals
      }
    }).sort((a, b) => a.totalCost - b.totalCost) // Сортируем по общей сумме
  }

  // Функция для определения класса цены (лучшая/худшая) на основе сравнения с другими подрядчиками
  const getPriceComparisonClass = (itemId, priceType, currentPrice) => {
    if (!currentPrice || currentPrice <= 0) return ''

    // Собираем все цены для этой позиции от всех подрядчиков
    const allPrices = tenderCounterparties
      .map(tc => {
        const proposal = proposals[tc.counterparty_id]?.[itemId]
        if (!proposal) return null
        return priceType === 'materials'
          ? proposal.unit_price_materials
          : proposal.unit_price_works
      })
      .filter(p => p && p > 0)

    if (allPrices.length < 2) return '' // Нужно минимум 2 цены для сравнения

    const minPrice = Math.min(...allPrices)
    const maxPrice = Math.max(...allPrices)

    if (minPrice === maxPrice) return '' // Все цены одинаковые

    // Проверяем, является ли текущая цена лучшей (минимальной)
    if (currentPrice === minPrice) {
      return 'price-best'
    }

    // Проверяем, отличается ли от минимальной более чем на 5%
    const diffPercent = ((currentPrice - minPrice) / minPrice) * 100
    if (diffPercent >= 5) {
      return 'price-worse'
    }

    return ''
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  if (!tender) {
    return (
      <div className="tender-detail-page">
        <div className="error-message">Тендер не найден</div>
        <button className="btn-secondary" onClick={() => navigate(-1)}>
          Назад
        </button>
      </div>
    )
  }

  return (
    <div className="tender-detail-page">
      {/* Шапка */}
      <div className="tender-detail-header">
        <button className="btn-back" onClick={() => navigate(-1)} title="Назад к списку">
          ←
        </button>
        <div className="tender-detail-title">
          <h2>{tender.objects?.name || 'Тендер'}</h2>
          <p className="tender-work-description">{tender.work_description}</p>
        </div>
        <span className={`status-badge ${getStatusBadgeClass(tender.status)}`}>
          {tender.status}
        </span>
      </div>

      {/* Информация о тендере */}
      <div className="tender-info-card">
        <div className="tender-info-grid">
          <div className="info-item">
            <span className="info-label">Дата начала</span>
            <span className="info-value">{formatDate(tender.start_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Дата окончания</span>
            <span className="info-value">{formatDate(tender.end_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Участников</span>
            <span className="info-value">{tenderCounterparties.length}</span>
          </div>
          {tender.winner && (
            <div className="info-item winner">
              <span className="info-label">Победитель</span>
              <span className="info-value winner-name">🏆 {tender.winner.name}</span>
            </div>
          )}
          {tender.tender_package_link && (
            <div className="info-item">
              <span className="info-label">Тендерный пакет</span>
              <a href={tender.tender_package_link} target="_blank" rel="noopener noreferrer" className="info-link">
                Открыть документ
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Вкладки */}
      <div className="tender-tabs">
        <button
          className={`tender-tab ${activeTab === 'source_data' ? 'active' : ''}`}
          onClick={() => setActiveTab('source_data')}
        >
          Исходные данные
          {tenderDocuments.length > 0 && <span className="tab-count">{tenderDocuments.length}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'estimate' ? 'active' : ''}`}
          onClick={() => setActiveTab('estimate')}
        >
          Смета
          {estimateItems.length > 0 && <span className="tab-count">{estimateItems.length}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'comparison' ? 'active' : ''}`}
          onClick={() => setActiveTab('comparison')}
        >
          Сравнение КП
        </button>
        <button
          className={`tender-tab ${activeTab === 'participants' ? 'active' : ''}`}
          onClick={() => setActiveTab('participants')}
        >
          Участники
          {tenderCounterparties.length > 0 && <span className="tab-count">{tenderCounterparties.length}</span>}
        </button>
      </div>

      {/* Контент вкладок */}
      <div className="tender-tab-content">
        {/* Вкладка Исходные данные */}
        {activeTab === 'source_data' && (
          <div className="source-data-section">
            {/* Шаблон расценок для подрядчика */}
            <div className="source-data-card">
              <div className="source-data-card-header">
                <h3>📋 Шаблон расценок для подрядчика</h3>
                <p className="source-data-description">
                  Система анализирует смету, объединяет одинаковые позиции и генерирует упрощённый шаблон.
                  Подрядчику нужно заполнить цены только для уникальных позиций.
                </p>
              </div>
              <div className="source-data-card-content">
                {estimateItems.length === 0 ? (
                  <div className="no-template">
                    <p>Сначала загрузите смету во вкладке «Смета»</p>
                    <button
                      className="btn-secondary"
                      onClick={() => setActiveTab('estimate')}
                    >
                      Перейти к смете
                    </button>
                  </div>
                ) : (
                  <div className="price-template-section">
                    <div className="analysis-stats">
                      <div className="stat-item">
                        <span className="stat-value">{estimateItems.length}</span>
                        <span className="stat-label">позиций в смете</span>
                      </div>
                      <div className="stat-item">
                        <span className="stat-value">{getGroupedEstimateItems().length}</span>
                        <span className="stat-label">уникальных позиций</span>
                      </div>
                      <div className="stat-item highlight">
                        <span className="stat-value">
                          {estimateItems.length - getGroupedEstimateItems().length}
                        </span>
                        <span className="stat-label">объединённых (экономия)</span>
                      </div>
                    </div>
                    <div className="template-actions">
                      <button
                        className="btn-primary"
                        onClick={handleDownloadPriceTemplate}
                      >
                        📥 Скачать шаблон расценок
                      </button>
                      <p className="action-hint">
                        Отправьте этот файл подрядчикам. Они заполнят колонки «Цена материала» и «Цена работы»
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Документы для подрядчика */}
            <div className="source-data-card">
              <div className="source-data-card-header">
                <h3>📎 Документы для подрядчика</h3>
                <p className="source-data-description">
                  Ссылки на чертежи, спецификации, ТЗ и другие материалы в Google Drive
                </p>
              </div>
              <div className="source-data-card-content">
                <div className="documents-upload-area">
                  <button
                    className="btn-primary"
                    onClick={() => handleOpenAddDocument('attachment')}
                  >
                    + Добавить ссылку на документ
                  </button>
                </div>

                {tenderDocuments.filter(d => d.document_type === 'attachment').length === 0 ? (
                  <div className="empty-documents">
                    <p>Ссылки на документы не добавлены</p>
                    <p className="hint">Добавьте ссылки на Google Drive с чертежами и спецификациями</p>
                  </div>
                ) : (
                  <div className="documents-list">
                    {tenderDocuments
                      .filter(d => d.document_type === 'attachment')
                      .map(doc => (
                        <div key={doc.id} className="document-item">
                          <span className="doc-icon">{getDocumentIcon(doc.url)}</span>
                          <div className="doc-info">
                            <span className="doc-name">{doc.name}</span>
                            <span className="doc-size doc-url">{doc.url}</span>
                          </div>
                          <div className="doc-actions">
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-icon-action"
                              title="Открыть"
                            >
                              🔗
                            </a>
                            <button
                              className="btn-icon-action btn-delete-doc"
                              onClick={() => handleDeleteDocument(doc)}
                              title="Удалить"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Вкладка Смета */}
        {activeTab === 'estimate' && (
          <div className={`estimate-section ${isEstimateFullscreen ? 'fullscreen' : ''}`}>
            <div className="section-header">
              <h3>Сметы тендера ({getEstimateNames().length} смет, {estimateItems.length} позиций)</h3>
              <div className="section-actions">
                {selectedEstimateItems.size > 0 && (
                  <button className="btn-danger" onClick={handleDeleteSelectedItems}>
                    🗑️ Удалить выбранные ({selectedEstimateItems.size})
                  </button>
                )}
                <button className="btn-secondary" onClick={handleAddEstimateItem}>
                  + Добавить позицию
                </button>
                <button className="btn-primary" onClick={() => setShowImportEstimateModal(true)}>
                  📥 Импорт сметы
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setIsEstimateFullscreen(!isEstimateFullscreen)}
                  title={isEstimateFullscreen ? 'Свернуть (Esc)' : 'Развернуть на весь экран'}
                >
                  {isEstimateFullscreen ? '⬜ Свернуть' : '⛶ Развернуть'}
                </button>
              </div>
            </div>

            {estimateItems.length === 0 ? (
              <div className="empty-state">
                <p>Сметы еще не добавлены</p>
                <p className="hint">Импортируйте сметы из Excel файлов. Можно загрузить несколько смет.</p>
              </div>
            ) : (
              <div className="estimates-list">
                {getEstimateNames().map(estimateName => {
                  const items = getItemsByEstimate(estimateName)
                  const isExpanded = expandedEstimates.has(estimateName)

                  return (
                    <div key={estimateName} className="estimate-card">
                      <div
                        className="estimate-card-header"
                        onClick={() => toggleEstimateExpanded(estimateName)}
                      >
                        <div className="estimate-header-left">
                          <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                          <h4>{estimateName}</h4>
                          <span className="estimate-count">({items.length} позиций)</span>
                        </div>
                        <div className="estimate-header-actions" onClick={e => e.stopPropagation()}>
                          <button
                            className="btn-icon-small"
                            onClick={() => handleDeleteEstimate(estimateName)}
                            title="Удалить смету"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="estimate-card-content">
                          <table className="estimate-table compact">
                            <thead>
                              <tr>
                                <th className="col-checkbox">
                                  <input
                                    type="checkbox"
                                    checked={items.length > 0 && items.every(i => selectedEstimateItems.has(i.id))}
                                    onChange={() => {
                                      const allSelected = items.every(i => selectedEstimateItems.has(i.id))
                                      setSelectedEstimateItems(prev => {
                                        const newSet = new Set(prev)
                                        items.forEach(i => {
                                          if (allSelected) newSet.delete(i.id)
                                          else newSet.add(i.id)
                                        })
                                        return newSet
                                      })
                                    }}
                                    title="Выбрать все в этой смете"
                                  />
                                </th>
                                <th>№ п/п</th>
                                <th>№</th>
                                <th>КОД</th>
                                <th>Наименование</th>
                                <th>Ед.</th>
                                <th>Объём</th>
                                <th>Расход</th>
                                <th>Действия</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(item => (
                                <tr
                                  key={item.id}
                                  className={`${selectedEstimateItems.has(item.id) ? 'selected-row' : ''} ${item.is_section ? 'section-row' : ''}`}
                                >
                                  <td className="col-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={selectedEstimateItems.has(item.id)}
                                      onChange={() => handleToggleSelectItem(item.id)}
                                    />
                                  </td>
                                  <td className="center">{item.row_number}</td>
                                  <td className="center">
                                    {item.original_row_number || '-'}
                                  </td>
                                  <td>{item.code || '-'}</td>
                                  <td className={`col-name-compact ${item.is_section ? 'section-name' : ''}`}>
                                    {item.is_section && <span className="section-icon">📁 </span>}
                                    {item.cost_name}
                                  </td>
                                  <td className="center">{item.unit || '-'}</td>
                                  <td className="right">{item.work_volume ?? '-'}</td>
                                  <td className="right">{item.material_consumption ?? '-'}</td>
                                  <td className="actions">
                                    <button
                                      className="btn-icon-small"
                                      onClick={() => handleEditEstimateItem(item)}
                                      title="Редактировать"
                                    >
                                      ✏️
                                    </button>
                                    <button
                                      className="btn-icon-small"
                                      onClick={() => handleDeleteEstimateItem(item.id)}
                                      title="Удалить"
                                    >
                                      🗑️
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Вкладка Сравнение КП */}
        {activeTab === 'comparison' && (
          <div className={`comparison-section ${isComparisonFullscreen ? 'fullscreen' : ''}`}>
            <div className="section-header">
              <h3>Сравнительная таблица коммерческих предложений</h3>
              <div className="section-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setIsComparisonFullscreen(!isComparisonFullscreen)}
                  title={isComparisonFullscreen ? 'Свернуть' : 'Развернуть на весь экран'}
                >
                  {isComparisonFullscreen ? '⬜ Свернуть' : '⛶ Развернуть'}
                </button>
              </div>
            </div>

            {/* Под-вкладки для фильтрации */}
            <div className="comparison-sub-tabs">
              <button
                className={`comparison-sub-tab ${comparisonSubTab === 'all' ? 'active' : ''}`}
                onClick={() => setComparisonSubTab('all')}
              >
                Все позиции
              </button>
              <button
                className={`comparison-sub-tab ${comparisonSubTab === 'materials' ? 'active' : ''}`}
                onClick={() => setComparisonSubTab('materials')}
              >
                Материалы
              </button>
              <button
                className={`comparison-sub-tab ${comparisonSubTab === 'works' ? 'active' : ''}`}
                onClick={() => setComparisonSubTab('works')}
              >
                Работы
              </button>
              <button
                className={`comparison-sub-tab ${comparisonSubTab === 'summary' ? 'active' : ''}`}
                onClick={() => setComparisonSubTab('summary')}
              >
                Итоги по подрядчикам
              </button>
            </div>

            {estimateItems.length === 0 ? (
              <div className="empty-state">
                <p>Сначала добавьте позиции сметы</p>
              </div>
            ) : tenderCounterparties.length === 0 ? (
              <div className="empty-state">
                <p>Нет участников тендера для сравнения</p>
              </div>
            ) : comparisonSubTab === 'summary' ? (
              /* Сводная таблица итогов по подрядчикам */
              <div className="comparison-summary-container">
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>№</th>
                      <th>Подрядчик</th>
                      <th>Материалы</th>
                      <th>Работы</th>
                      <th>Общая сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getAllCounterpartyTotals().map((cp, index) => {
                      const isLowest = index === 0 && cp.totalCost > 0
                      return (
                        <tr key={cp.id} className={isLowest ? 'best-price-row' : ''}>
                          <td className="center">{index + 1}</td>
                          <td>{cp.name}</td>
                          <td className="right price-cell">{formatCurrency(cp.totalMaterials)}</td>
                          <td className="right price-cell">{formatCurrency(cp.totalWorks)}</td>
                          <td className={`right price-cell total-cell ${isLowest ? 'price-best' : ''}`}>
                            {formatCurrency(cp.totalCost)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="comparison-table-container">
                <table className="comparison-table">
                  <thead>
                    <tr className="header-row-1">
                      <th rowSpan="2" className="sticky-col">№</th>
                      <th rowSpan="2" className="sticky-col col-2">Наименование затрат</th>
                      <th rowSpan="2">Ед.</th>
                      <th rowSpan="2">Объем</th>
                      {tenderCounterparties.map((tc, cpIndex) => {
                        const groupClass = cpIndex % 2 === 0 ? 'cp-group-odd' : 'cp-group-even'
                        return (
                          <th key={tc.id} colSpan={comparisonSubTab === 'materials' || comparisonSubTab === 'works' ? 2 : 5} className={`counterparty-header ${groupClass}`}>
                            <div className="cp-name">{tc.counterparties?.name}</div>
                            <div className="cp-actions">
                              <button
                                className="btn-upload-small"
                                onClick={() => handleUploadClick(tc.counterparty_id)}
                                title="Загрузить КП"
                              >
                                📤 Загрузить КП
                              </button>
                            </div>
                          </th>
                        )
                      })}
                    </tr>
                    <tr className="header-row-2">
                      {tenderCounterparties.map((tc, cpIndex) => {
                        const groupClass = cpIndex % 2 === 0 ? 'cp-group-odd' : 'cp-group-even'
                        return (
                          <>
                            {comparisonSubTab !== 'works' && (
                              <th key={`${tc.id}-mat-price`} className={`sub-header ${groupClass} cp-first`}>Ед. мат.</th>
                            )}
                            {comparisonSubTab !== 'materials' && (
                              <th key={`${tc.id}-work-price`} className={`sub-header ${groupClass} ${comparisonSubTab === 'works' ? 'cp-first' : ''}`}>Ед. раб.</th>
                            )}
                            {comparisonSubTab !== 'works' && (
                              <th key={`${tc.id}-mat-total`} className={`sub-header ${groupClass}`}>Итого мат.</th>
                            )}
                            {comparisonSubTab !== 'materials' && (
                              <th key={`${tc.id}-work-total`} className={`sub-header ${groupClass}`}>Итого раб.</th>
                            )}
                            {comparisonSubTab === 'all' && (
                              <th key={`${tc.id}-sum`} className={`sub-header ${groupClass}`}>Общее итого</th>
                            )}
                          </>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {estimateItems
                      .filter(item => {
                        if (comparisonSubTab === 'all') return true
                        if (item.is_section) return false // Разделы не показываем в отфильтрованных вкладках

                        // Проверяем есть ли расценки от хотя бы одного подрядчика
                        const hasAnyProposal = tenderCounterparties.some(tc => {
                          const proposal = proposals[tc.counterparty_id]?.[item.id]
                          return proposal != null
                        })

                        if (comparisonSubTab === 'materials') {
                          // Показываем все позиции (расценки на материалы могут быть у любой позиции)
                          return true
                        }
                        if (comparisonSubTab === 'works') {
                          // Показываем все позиции (расценки на работы могут быть у любой позиции)
                          return true
                        }
                        return true
                      })
                      .map(item => {
                        // Для материалов берём "Общий расход по материалу", для остальных - "Объем по виду работ"
                        const code = (item.code || '').toLowerCase().trim()
                        const isMaterial = code.startsWith('мат') || code === 'мат.' || code === 'мат'
                        const volume = isMaterial
                          ? (item.material_consumption || item.work_volume || '-')
                          : (item.work_volume || '-')

                        return (
                      <tr key={item.id}>
                        <td className="sticky-col center">{item.row_number}</td>
                        <td className="sticky-col col-2">{item.cost_name}</td>
                        <td className="center">{item.unit || '-'}</td>
                        <td className="right">{volume}</td>
                        {tenderCounterparties.map((tc, cpIndex) => {
                          const proposal = proposals[tc.counterparty_id]?.[item.id]
                          const numVolume = typeof volume === 'number' ? volume : parseFloat(volume) || 0

                          // Для работ: если unit_price_works пустая, берём unit_price_materials
                          // Для материалов: если unit_price_materials пустая, берём unit_price_works
                          const effectiveMatPrice = proposal
                            ? (proposal.unit_price_materials || proposal.unit_price_works || 0)
                            : 0
                          const effectiveWorkPrice = proposal
                            ? (proposal.unit_price_works || proposal.unit_price_materials || 0)
                            : 0

                          const totalMaterials = effectiveMatPrice * numVolume
                          const totalWorks = effectiveWorkPrice * numVolume
                          const grandTotal = totalMaterials + totalWorks

                          const groupClass = cpIndex % 2 === 0 ? 'cp-group-odd' : 'cp-group-even'
                          const matPriceClass = proposal ? getPriceComparisonClass(item.id, 'materials', effectiveMatPrice) : ''
                          const workPriceClass = proposal ? getPriceComparisonClass(item.id, 'works', effectiveWorkPrice) : ''

                          // Проверяем отдельно материалы и работы
                          const isMaterialUnpriced = !proposal || effectiveMatPrice === 0
                          const isWorkUnpriced = !proposal || effectiveWorkPrice === 0
                          const matUnpricedClass = isMaterialUnpriced ? 'unpriced' : ''
                          const workUnpricedClass = isWorkUnpriced ? 'unpriced' : ''
                          // Итого подсвечиваем если обе позиции не расценены
                          const totalUnpricedClass = (isMaterialUnpriced && isWorkUnpriced) ? 'unpriced' : ''

                          return (
                            <>
                              {comparisonSubTab !== 'works' && (
                                <td key={`${tc.id}-${item.id}-mat-price`} className={`right price-cell ${groupClass} cp-first ${matPriceClass} ${matUnpricedClass}`}>
                                  {proposal ? formatCurrency(effectiveMatPrice) : '-'}
                                </td>
                              )}
                              {comparisonSubTab !== 'materials' && (
                                <td key={`${tc.id}-${item.id}-work-price`} className={`right price-cell ${groupClass} ${comparisonSubTab === 'works' ? 'cp-first' : ''} ${workPriceClass} ${workUnpricedClass}`}>
                                  {proposal ? formatCurrency(effectiveWorkPrice) : '-'}
                                </td>
                              )}
                              {comparisonSubTab !== 'works' && (
                                <td key={`${tc.id}-${item.id}-mat-total`} className={`right price-cell ${groupClass} ${matUnpricedClass}`}>
                                  {proposal ? formatCurrency(totalMaterials) : '-'}
                                </td>
                              )}
                              {comparisonSubTab !== 'materials' && (
                                <td key={`${tc.id}-${item.id}-work-total`} className={`right price-cell ${groupClass} ${workUnpricedClass}`}>
                                  {proposal ? formatCurrency(totalWorks) : '-'}
                                </td>
                              )}
                              {comparisonSubTab === 'all' && (
                                <td key={`${tc.id}-${item.id}-sum`} className={`right price-cell sum ${groupClass} ${totalUnpricedClass}`}>
                                  {proposal ? formatCurrency(grandTotal) : '-'}
                                </td>
                              )}
                            </>
                          )
                        })}
                      </tr>
                        )
                      })}
                  </tbody>
                  <tfoot>
                    <tr className="totals-row">
                      <td colSpan="4" className="sticky-col totals-label">ИТОГО:</td>
                      {tenderCounterparties.map((tc, cpIndex) => {
                        const totals = calculateTotals(tc.counterparty_id)
                        const groupClass = cpIndex % 2 === 0 ? 'cp-group-odd' : 'cp-group-even'
                        return (
                          <>
                            {comparisonSubTab !== 'works' && (
                              <td key={`${tc.id}-total-mat-price`} className={`right total-value ${groupClass} cp-first`}>-</td>
                            )}
                            {comparisonSubTab !== 'materials' && (
                              <td key={`${tc.id}-total-work-price`} className={`right total-value ${groupClass} ${comparisonSubTab === 'works' ? 'cp-first' : ''}`}>-</td>
                            )}
                            {comparisonSubTab !== 'works' && (
                              <td key={`${tc.id}-total-mat`} className={`right total-value ${groupClass}`}>
                                {formatCurrency(totals.totalMaterials)}
                              </td>
                            )}
                            {comparisonSubTab !== 'materials' && (
                              <td key={`${tc.id}-total-work`} className={`right total-value ${groupClass}`}>
                                {formatCurrency(totals.totalWorks)}
                              </td>
                            )}
                            {comparisonSubTab === 'all' && (
                              <td key={`${tc.id}-total-sum`} className={`right total-value grand-total ${groupClass}`}>
                                {formatCurrency(totals.totalCost)}
                              </td>
                            )}
                          </>
                        )
                      })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {/* Загруженные файлы */}
            {proposalFiles.length > 0 && (
              <div className="uploaded-files">
                <h4>Загруженные файлы КП</h4>
                <ul>
                  {proposalFiles.map(file => (
                    <li key={file.id}>
                      <div className="file-details">
                        <span className="file-name">{file.file_name}</span>
                        <span className="file-info">
                          {file.counterparties?.name} — {formatDate(file.uploaded_at)}
                        </span>
                      </div>
                      <button
                        className="btn-icon btn-delete-file"
                        onClick={() => handleDeleteProposalFile(file)}
                        title="Удалить КП"
                      >
                        🗑️
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Вкладка Участники */}
        {activeTab === 'participants' && (
          <div className="participants-section">
            <div className="section-header">
              <h3>Участники тендера</h3>
              <div className="section-actions">
                <button
                  className="btn-primary"
                  onClick={handleOpenAddParticipantModal}
                >
                  + Пригласить участников
                </button>
              </div>
            </div>

            {tenderCounterparties.length === 0 ? (
              <div className="empty-state">
                <p>Участники еще не добавлены</p>
                <p className="hint">Нажмите «Пригласить участников» чтобы добавить контрагентов</p>
              </div>
            ) : (
              <div className="participants-grid">
                {tenderCounterparties.map(tc => (
                  <div key={tc.id} className={`participant-card ${tender.winner?.id === tc.counterparty_id ? 'winner' : ''}`}>
                    {tender.winner?.id === tc.counterparty_id && (
                      <div className="winner-badge">🏆 Победитель</div>
                    )}
                    <div className="participant-name">{tc.counterparties?.name}</div>
                    {tc.counterparties?.work_type && (
                      <div className="participant-work-type">{tc.counterparties.work_type}</div>
                    )}
                    {tc.counterparties?.inn && (
                      <div className="participant-inn">ИНН: {tc.counterparties.inn}</div>
                    )}
                    <div className="participant-status-select">
                      <select
                        value={tc.status || 'request_sent'}
                        onChange={(e) => handleUpdateParticipantStatus(tc.id, e.target.value)}
                        style={{
                          padding: '0.375rem 0.75rem',
                          borderRadius: '6px',
                          border: '1px solid var(--border-color)',
                          background: 'var(--bg-secondary)',
                          color: getCounterpartyStatusColor(tc.status || 'request_sent'),
                          fontWeight: 600,
                          fontSize: '0.875rem',
                          cursor: 'pointer',
                          width: '100%'
                        }}
                      >
                        <option value="request_sent" style={{ color: '#6366f1' }}>Запрос отправлен</option>
                        <option value="declined" style={{ color: '#b91c1c' }}>Отказ</option>
                        <option value="proposal_provided" style={{ color: '#15803d' }}>КП предоставлено</option>
                      </select>
                    </div>
                    {tc.counterparties?.counterparty_contacts?.length > 0 && (
                      <div className="participant-contacts">
                        {tc.counterparties.counterparty_contacts.map(contact => (
                          <div key={contact.id} className="contact-item">
                            <div className="contact-name">
                              {contact.full_name}
                              {contact.position && <span className="contact-position"> ({contact.position})</span>}
                            </div>
                            {contact.phone && (
                              <a href={`tel:${contact.phone}`} className="contact-phone">{contact.phone}</a>
                            )}
                            {contact.email && (
                              <a href={`mailto:${contact.email}`} className="contact-email">{contact.email}</a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="participant-actions">
                      <button
                        className="btn-secondary"
                        onClick={() => handleUploadClick(tc.counterparty_id)}
                      >
                        📤 Загрузить КП
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Модал добавления ссылки на документ */}
      {showAddDocumentModal && (
        <div className="modal-overlay" onClick={() => setShowAddDocumentModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {addingDocumentType === 'estimate_template'
                  ? 'Добавить ссылку на шаблон сметы'
                  : 'Добавить ссылку на документ'}
              </h3>
              <button className="modal-close" onClick={() => setShowAddDocumentModal(false)}>×</button>
            </div>
            <form onSubmit={handleSaveDocument}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Название документа *</label>
                  <input
                    type="text"
                    value={documentFormData.name}
                    onChange={e => setDocumentFormData({...documentFormData, name: e.target.value})}
                    placeholder={addingDocumentType === 'estimate_template'
                      ? 'Например: Шаблон сметы - Объект N'
                      : 'Например: Чертежи фасада'}
                    required
                  />
                </div>
                <div className="form-group full-width">
                  <label>Ссылка на Google Drive *</label>
                  <input
                    type="url"
                    value={documentFormData.url}
                    onChange={e => setDocumentFormData({...documentFormData, url: e.target.value})}
                    placeholder="https://drive.google.com/..."
                    required
                  />
                  <small className="form-hint">
                    Скопируйте ссылку из Google Drive (Поделиться → Копировать ссылку)
                  </small>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowAddDocumentModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary" disabled={savingDocument}>
                  {savingDocument ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модал добавления/редактирования позиции сметы */}
      {showAddEstimateModal && (
        <div className="modal-overlay" onClick={() => setShowAddEstimateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingEstimateItem ? 'Редактировать позицию' : 'Добавить позицию сметы'}</h3>
              <button className="modal-close" onClick={() => setShowAddEstimateModal(false)}>×</button>
            </div>
            <form onSubmit={handleSaveEstimateItem}>
              <div className="form-grid">
                <div className="form-group">
                  <label>№ п/п *</label>
                  <input
                    type="number"
                    value={estimateFormData.row_number}
                    onChange={e => setEstimateFormData({...estimateFormData, row_number: e.target.value})}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>КОД</label>
                  <input
                    type="text"
                    value={estimateFormData.code}
                    onChange={e => setEstimateFormData({...estimateFormData, code: e.target.value})}
                    placeholder="мат. или Р-..."
                  />
                  <small className="form-hint">Тип автоопределяется: «мат.» = материалы, «Р-» = работы</small>
                </div>
                <div className="form-group full-width">
                  <label>Наименование затрат *</label>
                  <textarea
                    value={estimateFormData.cost_name}
                    onChange={e => setEstimateFormData({...estimateFormData, cost_name: e.target.value})}
                    required
                    rows="2"
                  />
                </div>
                <div className="form-group">
                  <label>Ед. изм.</label>
                  <input
                    type="text"
                    value={estimateFormData.unit}
                    onChange={e => setEstimateFormData({...estimateFormData, unit: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Объем работ (E)</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={estimateFormData.work_volume}
                    onChange={e => setEstimateFormData({...estimateFormData, work_volume: e.target.value})}
                  />
                </div>
                <div className="form-group">
                  <label>Расход материала (F)</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={estimateFormData.material_consumption}
                    onChange={e => setEstimateFormData({...estimateFormData, material_consumption: e.target.value})}
                  />
                </div>
                <div className="form-group full-width">
                  <label>Примечания (L)</label>
                  <textarea
                    value={estimateFormData.calculation_note}
                    onChange={e => setEstimateFormData({...estimateFormData, calculation_note: e.target.value})}
                    rows="2"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowAddEstimateModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingEstimateItem ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модал загрузки КП */}
      {showUploadModal && (
        <div className="modal-overlay" onClick={() => setShowUploadModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Загрузить коммерческое предложение</h3>
              <button className="modal-close" onClick={() => setShowUploadModal(false)}>×</button>
            </div>
            <div className="modal-content">
              <div className="upload-options">
                {/* Вариант 1: Упрощённый шаблон (рекомендуется) */}
                <div className="upload-option recommended">
                  <div className="upload-option-header">
                    <span className="option-badge">Рекомендуется</span>
                    <h4>📋 Загрузить упрощённый шаблон расценок</h4>
                  </div>
                  <p className="upload-option-desc">
                    Подрядчик заполняет цены только для уникальных позиций.
                    Система автоматически распределит их на все связанные позиции сметы.
                  </p>
                  <div className="upload-option-actions">
                    <label className="btn-primary upload-btn">
                      📤 Загрузить заполненный шаблон
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleImportPricesFromTemplate}
                        style={{ display: 'none' }}
                      />
                    </label>
                    <button
                      className="btn-secondary"
                      onClick={handleDownloadPriceTemplate}
                      disabled={estimateItems.length === 0}
                    >
                      📥 Скачать пустой шаблон
                    </button>
                  </div>
                </div>

                {/* Вариант 2: Полный формат */}
                <div className="upload-option">
                  <h4>📊 Загрузить в полном формате</h4>
                  <p className="upload-option-desc">
                    Excel с ценами для каждой строки сметы (старый формат).
                  </p>
                  <div className="upload-format-info">
                    <details className="format-details">
                      <summary>Требования к формату файла</summary>
                      <div className="format-details-content">
                        <p>Строки сопоставляются со сметой по столбцу <strong>A (№ п/п)</strong>. Строки с номером, которого нет в смете, будут пропущены.</p>
                        <table className="format-table">
                          <thead>
                            <tr>
                              <th>Столбец</th>
                              <th>Содержание</th>
                              <th>Обязательный</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td><strong>A</strong></td>
                              <td>№ п/п (номер строки сметы)</td>
                              <td>Да</td>
                            </tr>
                            <tr className="format-row-skip">
                              <td>B – H</td>
                              <td>КОД, наименование, ед. изм. и т.д.</td>
                              <td>Нет (не читаются)</td>
                            </tr>
                            <tr>
                              <td><strong>I</strong></td>
                              <td>Цена за ед. Матер./Обор. с НДС</td>
                              <td>Да</td>
                            </tr>
                            <tr>
                              <td><strong>J</strong></td>
                              <td>Цена за ед. СМР/ПНР с НДС</td>
                              <td>Да</td>
                            </tr>
                            <tr className="format-row-skip">
                              <td>K – O</td>
                              <td>Итого, стоимости</td>
                              <td>Нет (рассчитываются)</td>
                            </tr>
                            <tr>
                              <td><strong>P</strong></td>
                              <td>Примечание участника</td>
                              <td>Нет</td>
                            </tr>
                          </tbody>
                        </table>
                        <p className="format-note">Первая строка считается заголовком и пропускается. Объёмы берутся из загруженной сметы, итоговые суммы рассчитываются автоматически.</p>
                      </div>
                    </details>
                  </div>
                  <div className="upload-option-actions">
                    <label className="btn-secondary upload-btn">
                      Выбрать файл
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleFileSelect}
                        disabled={uploading}
                        style={{ display: 'none' }}
                      />
                    </label>
                  </div>
                  {uploading && <div className="uploading-indicator">Загрузка...</div>}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowUploadModal(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модал импорта сметы из Excel */}
      {showImportEstimateModal && (
        <div className="modal-overlay" onClick={() => setShowImportEstimateModal(false)}>
          <div className="modal import-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Импорт сметы из Excel</h3>
              <button className="modal-close" onClick={() => setShowImportEstimateModal(false)}>×</button>
            </div>
            <div className="modal-content">
              {/* Кнопка импорта */}
              <div className="import-upload-section">
                <label className="import-upload-btn">
                  <span className="import-upload-icon">📥</span>
                  <span className="import-upload-text">Выбрать файл для импорта</span>
                  <span className="import-upload-hint">Поддерживаются форматы .xlsx и .xls</span>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => {
                      handleImportEstimateFromExcel(e)
                      setShowImportEstimateModal(false)
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>

              {/* Кнопка скачивания шаблона */}
              <div className="import-template-section">
                <button className="btn-template" onClick={handleDownloadEstimateTemplate}>
                  <span className="template-icon">📄</span>
                  <span className="template-text">
                    <span className="template-title">Скачать шаблон для импорта</span>
                    <span className="template-desc">Excel файл с примерами заполнения</span>
                  </span>
                </button>
              </div>

              {/* Инструкция */}
              <div className="import-instruction">
                <h4>Инструкция по заполнению</h4>
                <p>Подготовьте Excel файл со следующей структурой (первая строка — заголовки):</p>

                <div className="instruction-table-wrapper">
                  <table className="instruction-table">
                    <thead>
                      <tr>
                        <th>Колонка</th>
                        <th>Название</th>
                        <th>Описание</th>
                        <th>Обязат.</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td>A</td><td>№ п/п</td><td>Порядковый номер (сохраняется)</td><td>Нет</td></tr>
                      <tr><td>B</td><td>КОД</td><td>Код позиции: Р-xxx (работы), мат. (материалы)</td><td>Нет</td></tr>
                      <tr><td>C</td><td>Наименование затрат</td><td>Описание позиции или название раздела</td><td className="required">Да</td></tr>
                      <tr><td>D</td><td>Ед. изм.</td><td>Единица измерения</td><td>Нет</td></tr>
                      <tr><td>E</td><td>Объем по виду работ</td><td>Количество (число)</td><td>Нет</td></tr>
                      <tr><td>F</td><td>Общий расход</td><td>Расход материала (число)</td><td>Нет</td></tr>
                    </tbody>
                  </table>
                </div>

                <div className="instruction-note">
                  <strong>Разделы:</strong> Строки без кода (Р или мат.) и без числовых данных автоматически распознаются как заголовки разделов и выделяются в таблице.
                </div>

                <div className="instruction-note warning">
                  <strong>Внимание:</strong> При импорте существующие позиции сметы с таким же названием будут заменены на новые из файла.
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn-secondary" onClick={() => setShowImportEstimateModal(false)}>
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Модал добавления участников */}
      {showAddParticipantModal && (
        <div className="modal-overlay" onClick={() => { setShowAddParticipantModal(false); setParticipantSearchQuery(''); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3>Пригласить участников</h3>
              <button className="modal-close" onClick={() => { setShowAddParticipantModal(false); setParticipantSearchQuery(''); }}>×</button>
            </div>
            <div className="modal-content">
              {loadingCounterparties ? (
                <div className="empty-state">
                  <p>Загрузка списка контрагентов...</p>
                </div>
              ) : availableCounterparties.length === 0 ? (
                <div className="empty-state">
                  <p>Нет доступных контрагентов</p>
                  <p className="hint">Все активные контрагенты уже добавлены в тендер</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <input
                      type="text"
                      placeholder="Поиск по названию, ИНН или виду работ..."
                      value={participantSearchQuery}
                      onChange={(e) => setParticipantSearchQuery(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.75rem 1rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.9375rem'
                      }}
                    />
                  </div>
                  <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>
                    Выберите контрагентов для приглашения в тендер:
                  </p>
                  <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                    {availableCounterparties
                      .filter(cp => {
                        if (!participantSearchQuery.trim()) return true
                        const query = participantSearchQuery.toLowerCase().trim()
                        return (
                          (cp.name && cp.name.toLowerCase().includes(query)) ||
                          (cp.inn && cp.inn.toLowerCase().includes(query)) ||
                          (cp.work_type && cp.work_type.toLowerCase().includes(query))
                        )
                      })
                      .map(cp => (
                      <div
                        key={cp.id}
                        onClick={() => handleToggleParticipant(cp.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          padding: '0.75rem 1rem',
                          marginBottom: '0.5rem',
                          background: selectedParticipants.has(cp.id) ? 'rgba(8, 145, 178, 0.1)' : 'var(--bg-tertiary)',
                          border: selectedParticipants.has(cp.id) ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedParticipants.has(cp.id)}
                          onChange={() => {}}
                          style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{cp.name}</div>
                          {cp.work_type && (
                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{cp.work_type}</div>
                          )}
                          {cp.inn && (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>ИНН: {cp.inn}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedParticipants.size > 0 && (
                    <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(8, 145, 178, 0.1)', borderRadius: '8px' }}>
                      Выбрано: {selectedParticipants.size} контрагент(ов)
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => { setShowAddParticipantModal(false); setParticipantSearchQuery(''); }}>
                Отмена
              </button>
              <button
                className="btn-primary"
                onClick={handleAddParticipants}
                disabled={selectedParticipants.size === 0}
              >
                Добавить выбранных
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TenderDetailPage
