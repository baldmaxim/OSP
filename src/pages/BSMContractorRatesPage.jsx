import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import { useRole } from '../contexts/RoleContext'
import './BSMRatesPage.css'
import './BSMPage.css'

function BSMContractorRatesPage() {
  const { canEdit } = useRole()
  const canEditBsm = canEdit('bsm')
  // Режим отображения: 'list' - список БСМ, 'detail' - детальный просмотр расценок
  const [viewMode, setViewMode] = useState('list')

  // Главная вкладка (для режима detail)
  const [mainTab, setMainTab] = useState('rates') // 'rates' | 'analysis'

  // ========== Список существующих БСМ ==========
  const [existingBsmList, setExistingBsmList] = useState([])
  const [bsmListLoading, setBsmListLoading] = useState(true)
  const [showAddBsmModal, setShowAddBsmModal] = useState(false)
  const [newBsmObjectId, setNewBsmObjectId] = useState('')
  const [newBsmCounterpartyId, setNewBsmCounterpartyId] = useState('')
  const [bsmSearchTerm, setBsmSearchTerm] = useState('')
  const [bsmFilterObject, setBsmFilterObject] = useState('')
  const [bsmFilterCounterparty, setBsmFilterCounterparty] = useState('')

  // ========== Общие данные ==========
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [selectedObjectId, setSelectedObjectId] = useState('')
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState('')
  const [selectedObjectName, setSelectedObjectName] = useState('')
  const [selectedCounterpartyName, setSelectedCounterpartyName] = useState('')

  // ========== Данные для вкладки "Расценки" ==========
  const [rates, setRates] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [editingRate, setEditingRate] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRate, setNewRate] = useState({ material_name: '', unit: '', contractor_price: '' })
  const [searchTerm, setSearchTerm] = useState('')
  const [showImportHelp, setShowImportHelp] = useState(false)
  const [selectedRates, setSelectedRates] = useState(new Set())
  const fileInputRef = useRef(null)

  // Состояние для диалога импорта расценок
  const [showImportReport, setShowImportReport] = useState(false)
  const [importReport, setImportReport] = useState(null)
  const [conflictDecisions, setConflictDecisions] = useState({})
  const [isProcessingImport, setIsProcessingImport] = useState(false)

  // Состояние для отображения ошибок импорта
  const [showErrorsModal, setShowErrorsModal] = useState(false)
  const [importErrors, setImportErrors] = useState([])

  // ========== Данные для вкладки "Анализ материалов" ==========
  const [materialsData, setMaterialsData] = useState([])
  const [loadedFiles, setLoadedFiles] = useState([])
  const [allRawRows, setAllRawRows] = useState([])
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisStats, setAnalysisStats] = useState(null)
  const [activeAnalysisTab, setActiveAnalysisTab] = useState('all') // 'all', 'zero', 'different', 'compare', 'not_in_rates'
  const [expandedItems, setExpandedItems] = useState({})
  const [groupedDifferentPrices, setGroupedDifferentPrices] = useState([])
  const [comparisonData, setComparisonData] = useState([])
  const [comparisonStats, setComparisonStats] = useState(null)
  const analysisFileInputRef = useRef(null)

  // Вспомогательная функция округления
  const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100

  // ========== Загрузка данных ==========
  useEffect(() => {
    fetchObjects()
    fetchCounterparties()
    fetchExistingBsmList()
  }, [])

  // Загрузка списка существующих БСМ (уникальные комбинации объект + подрядчик)
  const fetchExistingBsmList = async () => {
    setBsmListLoading(true)
    try {
      const { data, error } = await supabase
        .from('bsm_contractor_rates')
        .select(`
          object_id,
          counterparty_id,
          objects(id, name),
          counterparties(id, name)
        `)

      if (error) throw error

      // Группируем по уникальным комбинациям object_id + counterparty_id
      const uniqueMap = new Map()
      data.forEach(item => {
        const key = `${item.object_id}_${item.counterparty_id}`
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, {
            object_id: item.object_id,
            counterparty_id: item.counterparty_id,
            object_name: item.objects?.name || 'Неизвестный объект',
            counterparty_name: item.counterparties?.name || 'Неизвестный подрядчик',
            rates_count: 1
          })
        } else {
          uniqueMap.get(key).rates_count++
        }
      })

      setExistingBsmList(Array.from(uniqueMap.values()))
    } catch (err) {
      console.error('Ошибка загрузки списка БСМ:', err)
    }
    setBsmListLoading(false)
  }

  const fetchObjects = async () => {
    const { data, error } = await supabase
      .from('objects')
      .select('id, name')
      .order('name')
    if (!error && data) setObjects(data)
  }

  const fetchCounterparties = async () => {
    const { data, error } = await supabase
      .from('counterparties')
      .select('id, name')
      .eq('status', 'active')
      .order('name')
    if (!error && data) setCounterparties(data)
  }

  const fetchRates = useCallback(async () => {
    setIsLoading(true)
    const { data, error } = await supabase
      .from('bsm_contractor_rates')
      .select('*')
      .eq('object_id', selectedObjectId)
      .eq('counterparty_id', selectedCounterpartyId)
      .order('material_name')
    if (!error && data) setRates(data)
    setIsLoading(false)
  }, [selectedObjectId, selectedCounterpartyId])

  useEffect(() => {
    if (selectedObjectId && selectedCounterpartyId) {
      fetchRates()
    } else {
      setRates([])
    }
  }, [selectedObjectId, selectedCounterpartyId, fetchRates])

  // ========== Функции для работы со списком БСМ ==========
  const handleSelectBsm = (bsm) => {
    setSelectedObjectId(bsm.object_id)
    setSelectedCounterpartyId(bsm.counterparty_id)
    setSelectedObjectName(bsm.object_name)
    setSelectedCounterpartyName(bsm.counterparty_name)
    setViewMode('detail')
  }

  const handleBackToList = () => {
    setViewMode('list')
    setSelectedObjectId('')
    setSelectedCounterpartyId('')
    setSelectedObjectName('')
    setSelectedCounterpartyName('')
    setRates([])
    setMainTab('rates')
    // Обновим список БСМ
    fetchExistingBsmList()
  }

  const handleAddNewBsm = async () => {
    if (!newBsmObjectId || !newBsmCounterpartyId) {
      alert('Выберите объект и подрядчика')
      return
    }

    // Проверим, не существует ли уже такая комбинация
    const exists = existingBsmList.some(
      b => b.object_id === newBsmObjectId && b.counterparty_id === newBsmCounterpartyId
    )
    if (exists) {
      alert('БСМ для этой комбинации объект + подрядчик уже существует')
      return
    }

    // Находим названия
    const objName = objects.find(o => o.id === newBsmObjectId)?.name || ''
    const cpName = counterparties.find(c => c.id === newBsmCounterpartyId)?.name || ''

    // Переходим к детальному просмотру (расценки можно будет добавить там)
    setSelectedObjectId(newBsmObjectId)
    setSelectedCounterpartyId(newBsmCounterpartyId)
    setSelectedObjectName(objName)
    setSelectedCounterpartyName(cpName)
    setShowAddBsmModal(false)
    setNewBsmObjectId('')
    setNewBsmCounterpartyId('')
    setViewMode('detail')
  }

  const handleDeleteBsm = async (objectId, counterpartyId) => {
    const objName = existingBsmList.find(b => b.object_id === objectId && b.counterparty_id === counterpartyId)?.object_name
    const cpName = existingBsmList.find(b => b.object_id === objectId && b.counterparty_id === counterpartyId)?.counterparty_name

    if (!confirm(`Удалить все расценки БСМ для объекта "${objName}" и подрядчика "${cpName}"?`)) return

    const { error } = await supabase
      .from('bsm_contractor_rates')
      .delete()
      .eq('object_id', objectId)
      .eq('counterparty_id', counterpartyId)

    if (error) {
      alert('Ошибка удаления: ' + error.message)
    } else {
      fetchExistingBsmList()
    }
  }

  // ========== Функции для расценок ==========
  const handleAddRate = async () => {
    if (!newRate.material_name || !newRate.contractor_price) {
      alert('Заполните наименование материала и цену')
      return
    }
    const { error } = await supabase
      .from('bsm_contractor_rates')
      .insert({
        object_id: selectedObjectId,
        counterparty_id: selectedCounterpartyId,
        material_name: newRate.material_name.trim(),
        unit: newRate.unit.trim(),
        contractor_price: parseFloat(newRate.contractor_price)
      })
    if (error) {
      if (error.code === '23505') {
        alert('Материал с таким названием уже существует')
      } else {
        alert('Ошибка: ' + error.message)
      }
    } else {
      setNewRate({ material_name: '', unit: '', contractor_price: '' })
      setShowAddForm(false)
      fetchRates()
    }
  }

  const handleUpdateRate = async (id, updates) => {
    const { error } = await supabase
      .from('bsm_contractor_rates')
      .update(updates)
      .eq('id', id)
    if (error) {
      alert('Ошибка: ' + error.message)
    } else {
      setEditingRate(null)
      fetchRates()
    }
  }

  const handleDeleteRate = async (id) => {
    if (!confirm('Удалить эту расценку?')) return
    const { error } = await supabase
      .from('bsm_contractor_rates')
      .delete()
      .eq('id', id)
    if (!error) fetchRates()
  }

  const handleDeleteSelected = async () => {
    if (selectedRates.size === 0) return
    if (!confirm(`Удалить ${selectedRates.size} выбранных расценок?`)) return
    const { error } = await supabase
      .from('bsm_contractor_rates')
      .delete()
      .in('id', Array.from(selectedRates))
    if (!error) {
      setSelectedRates(new Set())
      fetchRates()
    }
  }

  const toggleSelectRate = (id) => {
    setSelectedRates(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) newSet.delete(id)
      else newSet.add(id)
      return newSet
    })
  }

  const toggleSelectAll = () => {
    if (selectedRates.size === filteredRates.length) {
      setSelectedRates(new Set())
    } else {
      setSelectedRates(new Set(filteredRates.map(r => r.id)))
    }
  }

  const parsePrice = (val) => {
    if (val === null || val === undefined || val === '') return 0
    return parseFloat(String(val).replace(/\s/g, '').replace(/,/g, '.')) || 0
  }

  // Импорт расценок из Excel
  const handleImportRatesExcel = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const workbook = XLSX.read(event.target.result, { type: 'binary' })
        const worksheet = workbook.Sheets[workbook.SheetNames[0]]
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

        let headerRowIndex = 0
        for (let i = 0; i < Math.min(10, jsonData.length); i++) {
          const row = jsonData[i]
          if (row && row.some(cell => cell && typeof cell === 'string' &&
            (cell.toLowerCase().includes('наименование') || cell.toLowerCase().includes('материал'))
          )) {
            headerRowIndex = i
            break
          }
        }

        const newRates = []
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i]
          if (!row || !row[0]) continue
          const materialName = String(row[0]).trim()
          const unit = row[1] ? String(row[1]).trim() : ''
          const price = parsePrice(row[2]) || parsePrice(row[3]) || 0
          if (materialName && price > 0) {
            newRates.push({
              object_id: selectedObjectId,
              counterparty_id: selectedCounterpartyId,
              material_name: materialName,
              unit: unit,
              contractor_price: price
            })
          }
        }

        if (newRates.length === 0) {
          alert('Не найдено данных для импорта')
          return
        }

        const newItems = []
        const sameItems = []
        const conflictItems = []

        for (const rate of newRates) {
          const { data: existing } = await supabase
            .from('bsm_contractor_rates')
            .select('id, material_name, unit, contractor_price')
            .eq('object_id', rate.object_id)
            .eq('counterparty_id', rate.counterparty_id)
            .ilike('material_name', rate.material_name)
            .maybeSingle()

          if (!existing) {
            newItems.push(rate)
          } else {
            const existingPrice = parseFloat(existing.contractor_price) || 0
            if (Math.abs(existingPrice - rate.contractor_price) < 0.01) {
              sameItems.push({ ...rate, existingId: existing.id, existingPrice })
            } else {
              conflictItems.push({
                ...rate,
                existingId: existing.id,
                existingPrice,
                newPrice: rate.contractor_price,
                difference: rate.contractor_price - existingPrice,
                percentDiff: existingPrice > 0 ? ((rate.contractor_price - existingPrice) / existingPrice * 100) : 0
              })
            }
          }
        }

        const decisions = {}
        conflictItems.forEach((_, idx) => { decisions[idx] = 'keep' })

        setImportReport({ fileName: file.name, totalParsed: newRates.length, newItems, sameItems, conflictItems })
        setConflictDecisions(decisions)
        setShowImportReport(true)
      } catch (error) {
        alert('Ошибка при чтении файла')
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsBinaryString(file)
  }

  const handleConfirmImport = async () => {
    if (!importReport) return
    setIsProcessingImport(true)

    let importedCount = 0, updatedCount = 0, skippedCount = 0
    const errors = []

    for (const item of importReport.newItems) {
      const { error } = await supabase.from('bsm_contractor_rates').insert(item)
      if (error) errors.push(`"${item.material_name}": ${error.message}`)
      else importedCount++
    }

    for (let idx = 0; idx < importReport.conflictItems.length; idx++) {
      const item = importReport.conflictItems[idx]
      if (conflictDecisions[idx] === 'update') {
        const { error } = await supabase
          .from('bsm_contractor_rates')
          .update({ unit: item.unit, contractor_price: item.contractor_price })
          .eq('id', item.existingId)
        if (error) errors.push(`"${item.material_name}": ${error.message}`)
        else updatedCount++
      } else {
        skippedCount++
      }
    }

    setIsProcessingImport(false)
    setShowImportReport(false)
    setImportReport(null)

    if (errors.length > 0) {
      setImportErrors(errors)
      setShowErrorsModal(true)
    } else {
      alert(`Импорт завершён!\n\nДобавлено: ${importedCount}\nОбновлено: ${updatedCount}\nПропущено: ${importReport.sameItems.length + skippedCount}`)
    }
    fetchRates()
  }

  const handleCancelImport = () => {
    setShowImportReport(false)
    setImportReport(null)
    setConflictDecisions({})
  }

  const handleConflictDecision = (idx, decision) => {
    setConflictDecisions(prev => ({ ...prev, [idx]: decision }))
  }

  const handleSelectAllUpdate = () => {
    const decisions = {}
    importReport.conflictItems.forEach((_, idx) => { decisions[idx] = 'update' })
    setConflictDecisions(decisions)
  }

  const handleSelectAllKeep = () => {
    const decisions = {}
    importReport.conflictItems.forEach((_, idx) => { decisions[idx] = 'keep' })
    setConflictDecisions(decisions)
  }

  const handleExportRates = () => {
    if (rates.length === 0) return
    const selectedObject = objects.find(o => o.id === selectedObjectId)
    const selectedCounterparty = counterparties.find(c => c.id === selectedCounterpartyId)

    const exportData = rates.map((rate, idx) => ({
      '№': idx + 1,
      'Наименование материала': rate.material_name,
      'Ед. изм.': rate.unit,
      'Цена от подрядчика': rate.contractor_price,
      'Примечание': rate.notes || ''
    }))

    const ws = XLSX.utils.json_to_sheet(exportData)
    ws['!cols'] = [{ wch: 5 }, { wch: 50 }, { wch: 10 }, { wch: 18 }, { wch: 30 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'БСМ с подрядчиком')
    XLSX.writeFile(wb, `БСМ_${selectedCounterparty?.name || 'подрядчик'}_${selectedObject?.name || 'объект'}.xlsx`)
  }

  const filteredRates = rates.filter(rate =>
    rate.material_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // ========== Функции для анализа материалов ==========
  const parseAnalysisFile = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target.result, { type: 'binary' })
          const worksheet = workbook.Sheets[workbook.SheetNames[0]]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          const rows = []
          let headerRowIndex = 0
          for (let i = 0; i < Math.min(10, jsonData.length); i++) {
            const row = jsonData[i]
            if (row && row.some(cell => cell && typeof cell === 'string' &&
              (cell.toLowerCase().includes('наименование') || cell.toLowerCase().includes('материал'))
            )) {
              headerRowIndex = i
              break
            }
          }

          for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row) continue
            const code = String(row[0] || '').trim()
            if (!code) continue
            // Только материалы (не работы)
            if (code.toLowerCase() === 'р' || code.toLowerCase().startsWith('р-')) continue

            rows.push({
              code,
              name: row[1] || '',
              unit: row[2] || '',
              volume: parseFloat(row[3]) || 0,
              priceMaterials: parseFloat(row[4]) || 0,
              sourceFile: file.name
            })
          }
          resolve({ fileName: file.name, rows })
        } catch (error) {
          reject(error)
        }
      }
      reader.onerror = reject
      reader.readAsBinaryString(file)
    })
  }

  const createMaterialsPivot = (rows) => {
    const materialsMap = {}

    rows.forEach(row => {
      const name = (row.name || '').trim()
      if (!name) return
      const priceMaterials = round2(row.priceMaterials)
      const volume = round2(row.volume)
      const key = `${name.toLowerCase()}|${priceMaterials.toFixed(2)}`

      if (!materialsMap[key]) {
        materialsMap[key] = {
          name,
          unit: row.unit || '',
          priceMaterials,
          totalVolume: 0,
          count: 0,
          isZeroPrice: priceMaterials === 0
        }
      }
      materialsMap[key].totalVolume = round2(materialsMap[key].totalVolume + volume)
      materialsMap[key].count += 1
    })

    const materials = Object.values(materialsMap).sort((a, b) => a.name.localeCompare(b.name, 'ru'))

    // Группировка по названию для определения разных цен
    const byName = {}
    materials.forEach(item => {
      const nameLower = item.name.toLowerCase()
      if (!byName[nameLower]) byName[nameLower] = []
      byName[nameLower].push(item)
    })

    materials.forEach(item => {
      const group = byName[item.name.toLowerCase()]
      item.hasDifferentPrices = group.length > 1
      if (item.hasDifferentPrices) {
        item.allPrices = group.map(g => g.priceMaterials).sort((a, b) => a - b)
      }
    })

    // Сгруппированные позиции с разными ценами
    const grouped = Object.values(byName)
      .filter(g => g.length > 1)
      .map(group => ({
        name: group[0].name,
        unit: group[0].unit,
        totalVolume: group.reduce((sum, item) => sum + item.totalVolume, 0),
        variants: group.map(item => ({
          price: item.priceMaterials,
          volume: item.totalVolume,
          count: item.count
        })).sort((a, b) => a.price - b.price)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))

    const zeroPriceCount = materials.filter(item => item.isZeroPrice).length
    const differentPricesCount = Object.values(byName).filter(g => g.length > 1).length

    return {
      materials,
      grouped,
      stats: {
        totalItems: materials.length,
        zeroPriceCount,
        differentPricesCount
      }
    }
  }

  const recalculateAnalysis = (rows) => {
    const result = createMaterialsPivot(rows)
    setMaterialsData(result.materials)
    setGroupedDifferentPrices(result.grouped)
    setAnalysisStats(result.stats)
  }

  const handleAnalysisFileUpload = async (e) => {
    const files = Array.from(e.target.files)
    if (files.length === 0) return

    setAnalysisLoading(true)
    try {
      const results = await Promise.all(files.map(parseAnalysisFile))
      let newRows = [...allRawRows]
      const newFiles = [...loadedFiles]

      results.forEach(({ fileName, rows }) => {
        if (!loadedFiles.some(f => f.name === fileName)) {
          newRows = [...newRows, ...rows]
          newFiles.push({ name: fileName, rowCount: rows.length })
        }
      })

      setAllRawRows(newRows)
      setLoadedFiles(newFiles)
      recalculateAnalysis(newRows)
    } catch (error) {
      alert('Ошибка при чтении файла')
    } finally {
      setAnalysisLoading(false)
      if (analysisFileInputRef.current) analysisFileInputRef.current.value = ''
    }
  }

  const handleRemoveFile = (fileNameToRemove) => {
    const newFiles = loadedFiles.filter(f => f.name !== fileNameToRemove)
    const newRows = allRawRows.filter(row => row.sourceFile !== fileNameToRemove)

    setLoadedFiles(newFiles)
    setAllRawRows(newRows)

    if (newRows.length > 0) {
      recalculateAnalysis(newRows)
    } else {
      handleClearAnalysis()
    }
  }

  const handleClearAnalysis = () => {
    setMaterialsData([])
    setLoadedFiles([])
    setAllRawRows([])
    setGroupedDifferentPrices([])
    setAnalysisStats(null)
    setActiveAnalysisTab('all')
    setExpandedItems({})
    setComparisonData([])
    setComparisonStats(null)
  }

  const calculateComparison = useCallback(() => {
    const ratesMap = {}
    rates.forEach(rate => {
      ratesMap[rate.material_name.trim().toLowerCase()] = round2(rate.contractor_price)
    })

    const comparison = []
    let totalCurrentSum = 0, totalContractorSum = 0, totalDifference = 0
    let matchedCount = 0, notFoundCount = 0, priceDiffCount = 0

    const materialsWithPrice = materialsData.filter(item => item.priceMaterials > 0)

    materialsWithPrice.forEach(item => {
      const key = item.name.trim().toLowerCase()
      const contractorPrice = ratesMap[key]
      const currentPrice = round2(item.priceMaterials)
      const currentSum = round2(item.totalVolume * currentPrice)

      let contractorSum = 0, difference = 0, status = 'not_found'

      if (contractorPrice !== undefined) {
        contractorSum = round2(item.totalVolume * contractorPrice)
        difference = round2(contractorSum - currentSum)
        totalCurrentSum = round2(totalCurrentSum + currentSum)
        totalContractorSum = round2(totalContractorSum + contractorSum)
        totalDifference = round2(totalDifference + difference)

        if (Math.abs(currentPrice - contractorPrice) < 0.01) {
          status = 'match'
          matchedCount++
        } else {
          status = 'different'
          priceDiffCount++
        }
      } else {
        notFoundCount++
      }

      comparison.push({
        ...item,
        price: currentPrice,
        contractorPrice,
        currentSum,
        contractorSum,
        difference,
        status
      })
    })

    setComparisonData(comparison)
    setComparisonStats({
      totalCurrentSum,
      totalContractorSum,
      totalDifference,
      matchedCount,
      priceDiffCount,
      notFoundCount,
      totalItems: materialsWithPrice.length
    })
  }, [materialsData, rates])

  // Пересчёт сравнения при изменении данных
  useEffect(() => {
    if (materialsData.length > 0 && rates.length > 0) {
      calculateComparison()
    }
  }, [materialsData, rates, calculateComparison])

  const toggleExpanded = (index) => {
    setExpandedItems(prev => ({ ...prev, [index]: !prev[index] }))
  }

  const getFilteredAnalysisData = () => {
    switch (activeAnalysisTab) {
      case 'zero':
        return materialsData.filter(item => item.isZeroPrice)
      case 'different':
        return materialsData.filter(item => item.hasDifferentPrices)
      default:
        return materialsData
    }
  }

  const formatNumber = (num) => {
    if (num === null || num === undefined || num === '') return '-'
    const parsed = parseFloat(num)
    if (isNaN(parsed)) return '-'
    return round2(parsed).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  // ========== RENDER ==========

  // Фильтрация списка БСМ
  const filteredBsmList = existingBsmList.filter(bsm => {
    const searchLower = bsmSearchTerm.toLowerCase()
    const matchesSearch = !bsmSearchTerm ||
      bsm.object_name.toLowerCase().includes(searchLower) ||
      bsm.counterparty_name.toLowerCase().includes(searchLower)
    const matchesObject = !bsmFilterObject || bsm.object_id === bsmFilterObject
    const matchesCounterparty = !bsmFilterCounterparty || bsm.counterparty_id === bsmFilterCounterparty
    return matchesSearch && matchesObject && matchesCounterparty
  })

  // Уникальные объекты и подрядчики для фильтров
  const uniqueObjectsInBsm = [...new Map(existingBsmList.map(b => [b.object_id, { id: b.object_id, name: b.object_name }])).values()]
  const uniqueCounterpartiesInBsm = [...new Map(existingBsmList.map(b => [b.counterparty_id, { id: b.counterparty_id, name: b.counterparty_name }])).values()]

  // Режим списка БСМ
  if (viewMode === 'list') {
    return (
      <div className="bsm-rates-page bsm-list-page">
        <div className="bsm-list-header">
          <div className="bsm-list-header-content">
            <div className="bsm-list-title-section">
              <h1>БСМ с подрядчиком</h1>
              <p className="page-description">
                Ведомость стоимости материалов по подрядчикам
              </p>
            </div>
            {canEditBsm && (
              <button className="btn-add-bsm" onClick={() => setShowAddBsmModal(true)}>
                <span className="btn-icon-plus">+</span>
                <span>Добавить БСМ</span>
              </button>
            )}
          </div>

          {/* Статистика */}
          <div className="bsm-stats-row">
            <div className="bsm-stat-card">
              <span className="stat-icon">📋</span>
              <div className="stat-info">
                <span className="stat-value">{existingBsmList.length}</span>
                <span className="stat-label">Всего БСМ</span>
              </div>
            </div>
            <div className="bsm-stat-card">
              <span className="stat-icon">🏢</span>
              <div className="stat-info">
                <span className="stat-value">{uniqueObjectsInBsm.length}</span>
                <span className="stat-label">Объектов</span>
              </div>
            </div>
            <div className="bsm-stat-card">
              <span className="stat-icon">🤝</span>
              <div className="stat-info">
                <span className="stat-value">{uniqueCounterpartiesInBsm.length}</span>
                <span className="stat-label">Подрядчиков</span>
              </div>
            </div>
            <div className="bsm-stat-card">
              <span className="stat-icon">📊</span>
              <div className="stat-info">
                <span className="stat-value">{existingBsmList.reduce((sum, b) => sum + b.rates_count, 0)}</span>
                <span className="stat-label">Позиций</span>
              </div>
            </div>
          </div>
        </div>

        {/* Панель поиска и фильтров */}
        <div className="bsm-search-panel">
          <div className="search-input-wrapper">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Поиск по объекту или подрядчику..."
              value={bsmSearchTerm}
              onChange={(e) => setBsmSearchTerm(e.target.value)}
              className="bsm-search-input"
            />
            {bsmSearchTerm && (
              <button className="clear-search" onClick={() => setBsmSearchTerm('')}>×</button>
            )}
          </div>
          <div className="bsm-filters">
            <div className="filter-group">
              <label>Объект:</label>
              <select
                value={bsmFilterObject}
                onChange={(e) => setBsmFilterObject(e.target.value)}
                className="filter-select"
              >
                <option value="">Все объекты</option>
                {uniqueObjectsInBsm.map(obj => (
                  <option key={obj.id} value={obj.id}>{obj.name}</option>
                ))}
              </select>
            </div>
            <div className="filter-group">
              <label>Подрядчик:</label>
              <select
                value={bsmFilterCounterparty}
                onChange={(e) => setBsmFilterCounterparty(e.target.value)}
                className="filter-select"
              >
                <option value="">Все подрядчики</option>
                {uniqueCounterpartiesInBsm.map(cp => (
                  <option key={cp.id} value={cp.id}>{cp.name}</option>
                ))}
              </select>
            </div>
            {(bsmFilterObject || bsmFilterCounterparty || bsmSearchTerm) && (
              <button
                className="btn-clear-filters"
                onClick={() => {
                  setBsmSearchTerm('')
                  setBsmFilterObject('')
                  setBsmFilterCounterparty('')
                }}
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        </div>

        {bsmListLoading ? (
          <div className="loading">Загрузка списка БСМ...</div>
        ) : existingBsmList.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <p>Нет созданных БСМ с подрядчиками</p>
            <p className="empty-hint">Нажмите «Добавить БСМ» чтобы создать новую ведомость</p>
          </div>
        ) : filteredBsmList.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <p>Ничего не найдено</p>
            <p className="empty-hint">Попробуйте изменить параметры поиска или фильтра</p>
          </div>
        ) : (
          <div className="bsm-table-container">
            <div className="table-info">
              Показано: <strong>{filteredBsmList.length}</strong> из <strong>{existingBsmList.length}</strong>
            </div>
            <table className="bsm-list-table">
              <thead>
                <tr>
                  <th className="col-number">№</th>
                  <th className="col-object">Объект</th>
                  <th className="col-counterparty">Контрагент</th>
                  <th className="col-count">Позиций</th>
                  <th className="col-actions">Действия</th>
                </tr>
              </thead>
              <tbody>
                {filteredBsmList.map((bsm, index) => (
                  <tr
                    key={`${bsm.object_id}_${bsm.counterparty_id}`}
                    className="bsm-list-row"
                    onClick={() => handleSelectBsm(bsm)}
                  >
                    <td className="col-number">{index + 1}</td>
                    <td className="col-object">{bsm.object_name}</td>
                    <td className="col-counterparty">{bsm.counterparty_name}</td>
                    <td className="col-count">
                      <span className="count-badge">{bsm.rates_count}</span>
                    </td>
                    <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn-action btn-view"
                        onClick={() => handleSelectBsm(bsm)}
                        title="Открыть"
                      >
                        👁️
                      </button>
                      {canEditBsm && (
                        <button
                          className="btn-action btn-delete"
                          onClick={() => handleDeleteBsm(bsm.object_id, bsm.counterparty_id)}
                          title="Удалить"
                        >
                          🗑️
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Модалка добавления БСМ */}
        {showAddBsmModal && (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Добавить БСМ с подрядчиком</h3>
                <button className="modal-close" onClick={() => setShowAddBsmModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>Объект *</label>
                  <select
                    value={newBsmObjectId}
                    onChange={(e) => setNewBsmObjectId(e.target.value)}
                  >
                    <option value="">-- Выберите объект --</option>
                    {objects.map(obj => (
                      <option key={obj.id} value={obj.id}>{obj.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Подрядчик *</label>
                  <select
                    value={newBsmCounterpartyId}
                    onChange={(e) => setNewBsmCounterpartyId(e.target.value)}
                  >
                    <option value="">-- Выберите подрядчика --</option>
                    {counterparties.map(cp => (
                      <option key={cp.id} value={cp.id}>{cp.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn-secondary" onClick={() => setShowAddBsmModal(false)}>Отмена</button>
                <button className="btn-primary" onClick={handleAddNewBsm}>Создать</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Режим детального просмотра расценок
  return (
    <div className="bsm-rates-page">
      <div className="detail-header">
        <button className="btn-back" onClick={handleBackToList} title="Назад к списку">
          ←
        </button>
        <div className="detail-title">
          <h1>БСМ с подрядчиком</h1>
          <p className="page-description">
            <strong>{selectedObjectName}</strong> — <strong>{selectedCounterpartyName}</strong>
          </p>
        </div>
      </div>

      {/* Заменили селекторы на информацию о выбранном БСМ */}
      {selectedObjectId && selectedCounterpartyId && (
        <>
          {/* Главные вкладки */}
          <div className="main-tabs" style={{ marginTop: '20px' }}>
            <button
              className={`main-tab ${mainTab === 'rates' ? 'active' : ''}`}
              onClick={() => setMainTab('rates')}
            >
              БСМ с подрядчиком
              <span className="tab-count">{rates.length}</span>
            </button>
            <button
              className={`main-tab ${mainTab === 'analysis' ? 'active' : ''}`}
              onClick={() => setMainTab('analysis')}
            >
              Анализ материалов
              {analysisStats && <span className="tab-count">{analysisStats.totalItems}</span>}
            </button>
          </div>

          {/* ========== ВКЛАДКА: Расценки ========== */}
          {mainTab === 'rates' && (
            <>
              <div className="rates-toolbar">
                <div className="toolbar-left">
                  <input
                    type="text"
                    placeholder="Поиск материала..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="search-input"
                  />
                  <span className="rates-count">
                    Найдено: {filteredRates.length} из {rates.length}
                  </span>
                  {canEditBsm && selectedRates.size > 0 && (
                    <button onClick={handleDeleteSelected} className="btn-delete-selected">
                      Удалить выбранные ({selectedRates.size})
                    </button>
                  )}
                </div>
                <div className="toolbar-right">
                  {canEditBsm && (
                    <>
                      <button onClick={() => setShowAddForm(true)} className="btn-add">+ Добавить</button>
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleImportRatesExcel}
                        ref={fileInputRef}
                        style={{ display: 'none' }}
                        id="import-rates"
                      />
                      <label htmlFor="import-rates" className="btn-import">Импорт из Excel</label>
                      <button onClick={() => setShowImportHelp(!showImportHelp)} className="btn-help" title="Инструкция">?</button>
                    </>
                  )}
                  <button onClick={handleExportRates} className="btn-export" disabled={rates.length === 0}>Экспорт в Excel</button>
                </div>
              </div>

              {showImportHelp && (
                <div className="import-help">
                  <div className="import-help-header">
                    <h3>Инструкция по импорту</h3>
                    <button onClick={() => setShowImportHelp(false)} className="btn-close">×</button>
                  </div>
                  <div className="import-help-content">
                    <p><strong>Формат:</strong> Excel (.xlsx, .xls)</p>
                    <p><strong>Столбцы:</strong> A - Наименование, B - Ед.изм., C - Цена</p>
                  </div>
                </div>
              )}

              {showAddForm && (
                <div className="add-form">
                  <h3>Добавить расценку</h3>
                  <div className="form-row">
                    <input
                      type="text"
                      placeholder="Наименование материала *"
                      value={newRate.material_name}
                      onChange={(e) => setNewRate({ ...newRate, material_name: e.target.value })}
                    />
                    <input
                      type="text"
                      placeholder="Ед. изм."
                      value={newRate.unit}
                      onChange={(e) => setNewRate({ ...newRate, unit: e.target.value })}
                    />
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Цена *"
                      value={newRate.contractor_price}
                      onChange={(e) => setNewRate({ ...newRate, contractor_price: e.target.value })}
                    />
                    <button onClick={handleAddRate} className="btn-save">Сохранить</button>
                    <button onClick={() => setShowAddForm(false)} className="btn-cancel">Отмена</button>
                  </div>
                </div>
              )}

              {isLoading ? (
                <div className="loading">Загрузка...</div>
              ) : filteredRates.length === 0 ? (
                <div className="empty-state">
                  {rates.length === 0 ? 'Нет расценок. Добавьте вручную или импортируйте из Excel.' : 'Ничего не найдено'}
                </div>
              ) : (
                <div className="table-container">
                  <table className="rates-table">
                    <thead>
                      <tr>
                        {canEditBsm && (
                          <th className="col-checkbox">
                            <input type="checkbox" checked={selectedRates.size === filteredRates.length && filteredRates.length > 0} onChange={toggleSelectAll} />
                          </th>
                        )}
                        <th className="col-num">№</th>
                        <th className="col-name">Наименование материала</th>
                        <th className="col-unit">Ед. изм.</th>
                        <th className="col-price">Цена от подрядчика</th>
                        {canEditBsm && <th className="col-actions">Действия</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRates.map((rate, idx) => (
                        <tr key={rate.id} className={selectedRates.has(rate.id) ? 'selected-row' : ''}>
                          {canEditBsm && (
                            <td className="col-checkbox">
                              <input type="checkbox" checked={selectedRates.has(rate.id)} onChange={() => toggleSelectRate(rate.id)} />
                            </td>
                          )}
                          <td className="col-num">{idx + 1}</td>
                          <td className="col-name">
                            {editingRate === rate.id ? (
                              <input type="text" defaultValue={rate.material_name} onBlur={(e) => handleUpdateRate(rate.id, { material_name: e.target.value })} />
                            ) : rate.material_name}
                          </td>
                          <td className="col-unit">
                            {editingRate === rate.id ? (
                              <input type="text" defaultValue={rate.unit} onBlur={(e) => handleUpdateRate(rate.id, { unit: e.target.value })} />
                            ) : rate.unit}
                          </td>
                          <td className="col-price">
                            {editingRate === rate.id ? (
                              <input type="number" step="0.01" defaultValue={rate.contractor_price} onBlur={(e) => handleUpdateRate(rate.id, { contractor_price: parseFloat(e.target.value) })} />
                            ) : formatNumber(rate.contractor_price)}
                          </td>
                          {canEditBsm && (
                            <td className="col-actions">
                              {editingRate === rate.id ? (
                                <button onClick={() => setEditingRate(null)} className="btn-done">✓</button>
                              ) : (
                                <>
                                  <button onClick={() => setEditingRate(rate.id)} className="btn-edit">✎</button>
                                  <button onClick={() => handleDeleteRate(rate.id)} className="btn-delete">✕</button>
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ========== ВКЛАДКА: Анализ материалов ========== */}
          {mainTab === 'analysis' && (
            <div className="pivot-section">
              <div className="upload-section">
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleAnalysisFileUpload}
                  ref={analysisFileInputRef}
                  id="analysis-file-upload"
                  className="file-input"
                  multiple
                />
                <label htmlFor="analysis-file-upload" className="file-label">
                  {loadedFiles.length > 0 ? 'Добавить файлы' : 'Выбрать файлы'}
                </label>
                {materialsData.length > 0 && (
                  <button onClick={handleClearAnalysis} className="clear-btn">Очистить</button>
                )}
              </div>

              {loadedFiles.length > 0 && (
                <div className="loaded-files-section">
                  <h3>Загруженные файлы ({loadedFiles.length})</h3>
                  <div className="loaded-files-list">
                    {loadedFiles.map((file, idx) => (
                      <div key={idx} className="loaded-file-item">
                        <span className="file-icon">📄</span>
                        <span className="file-info">
                          <span className="file-name">{file.name}</span>
                          <span className="file-rows">{file.rowCount} строк</span>
                        </span>
                        <button className="remove-file-btn" onClick={() => handleRemoveFile(file.name)}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysisLoading && <div className="loading">Загрузка...</div>}

              {analysisStats && (
                <>
                  <div className="summary">
                    <div className="summary-cards">
                      <div className="summary-card">
                        <span className="card-value">{analysisStats.totalItems}</span>
                        <span className="card-label">Позиций</span>
                      </div>
                      <div className="summary-card warning">
                        <span className="card-value">{analysisStats.zeroPriceCount}</span>
                        <span className="card-label">Без расценки</span>
                      </div>
                      <div className="summary-card">
                        <span className="card-value">{analysisStats.differentPricesCount}</span>
                        <span className="card-label">Разные цены</span>
                      </div>
                    </div>
                  </div>

                  {/* Подвкладки анализа */}
                  <div className="tabs sub-tabs">
                    <button className={`tab ${activeAnalysisTab === 'all' ? 'active' : ''}`} onClick={() => setActiveAnalysisTab('all')}>
                      Все материалы <span className="tab-count">{analysisStats.totalItems}</span>
                    </button>
                    <button className={`tab ${activeAnalysisTab === 'zero' ? 'active' : ''} ${analysisStats.zeroPriceCount > 0 ? 'warning' : ''}`} onClick={() => setActiveAnalysisTab('zero')}>
                      Без расценки <span className="tab-count">{analysisStats.zeroPriceCount}</span>
                    </button>
                    <button className={`tab ${activeAnalysisTab === 'different' ? 'active' : ''}`} onClick={() => setActiveAnalysisTab('different')}>
                      Разные цены <span className="tab-count">{analysisStats.differentPricesCount}</span>
                    </button>
                    <button className={`tab ${activeAnalysisTab === 'compare' ? 'active' : ''}`} onClick={() => setActiveAnalysisTab('compare')}>
                      Сравнение с БСМ
                      {comparisonStats && <span className={`tab-count ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>{formatNumber(comparisonStats.totalDifference)}</span>}
                    </button>
                    <button className={`tab ${activeAnalysisTab === 'not_in_rates' ? 'active' : ''} ${comparisonStats && comparisonStats.notFoundCount > 0 ? 'warning' : ''}`} onClick={() => setActiveAnalysisTab('not_in_rates')}>
                      Нет в БСМ
                      {comparisonStats && <span className="tab-count">{comparisonStats.notFoundCount}</span>}
                    </button>
                  </div>

                  {/* Контент вкладок анализа */}
                  {activeAnalysisTab === 'compare' ? (
                    <div className="compare-section">
                      {rates.length === 0 ? (
                        <div className="empty-tab">Нет расценок подрядчика для сравнения. Добавьте расценки на вкладке &quot;БСМ с подрядчиком&quot;.</div>
                      ) : comparisonStats ? (
                        <>
                          <div className="comparison-summary">
                            <div className="summary-card">
                              <span className="card-value">{formatNumber(comparisonStats.totalCurrentSum)}</span>
                              <span className="card-label">Сумма по файлу</span>
                            </div>
                            <div className="summary-card">
                              <span className="card-value">{formatNumber(comparisonStats.totalContractorSum)}</span>
                              <span className="card-label">Сумма по БСМ</span>
                            </div>
                            <div className={`summary-card ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>
                              <span className="card-value">{formatNumber(comparisonStats.totalDifference)}</span>
                              <span className="card-label">Разница</span>
                            </div>
                            <div className="summary-card success">
                              <span className="card-value">{comparisonStats.matchedCount}</span>
                              <span className="card-label">Совпадают</span>
                            </div>
                            <div className="summary-card warning">
                              <span className="card-value">{comparisonStats.priceDiffCount}</span>
                              <span className="card-label">Разные цены</span>
                            </div>
                          </div>

                          <div className="table-container">
                            <table className="pivot-table comparison-table">
                              <thead>
                                <tr>
                                  <th>№</th>
                                  <th>Наименование</th>
                                  <th>Ед. изм.</th>
                                  <th>Объем</th>
                                  <th>Цена (файл)</th>
                                  <th>Цена (БСМ)</th>
                                  <th>Сумма (файл)</th>
                                  <th>Сумма (БСМ)</th>
                                  <th>Разница</th>
                                </tr>
                              </thead>
                              <tbody>
                                {comparisonData.filter(item => item.status !== 'not_found').map((item, idx) => (
                                  <tr key={idx} className={`comparison-row status-${item.status}`}>
                                    <td>{idx + 1}</td>
                                    <td className="col-name">{item.name}</td>
                                    <td>{item.unit}</td>
                                    <td className="col-volume">{formatNumber(item.totalVolume)}</td>
                                    <td className="col-price">{formatNumber(item.price)}</td>
                                    <td className="col-price">{formatNumber(item.contractorPrice)}</td>
                                    <td className="col-total">{formatNumber(item.currentSum)}</td>
                                    <td className="col-total">{formatNumber(item.contractorSum)}</td>
                                    <td className={`col-diff ${item.difference < 0 ? 'positive' : item.difference > 0 ? 'negative' : ''}`}>
                                      {formatNumber(item.difference)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="total-row">
                                  <td colSpan="6" className="total-label">ИТОГО:</td>
                                  <td className="col-total">{formatNumber(comparisonStats.totalCurrentSum)}</td>
                                  <td className="col-total">{formatNumber(comparisonStats.totalContractorSum)}</td>
                                  <td className={`col-diff ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>
                                    {formatNumber(comparisonStats.totalDifference)}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : activeAnalysisTab === 'not_in_rates' ? (
                    <div className="compare-section">
                      {rates.length === 0 ? (
                        <div className="empty-tab">Добавьте расценки на вкладке &quot;БСМ с подрядчиком&quot;</div>
                      ) : comparisonStats && comparisonStats.notFoundCount > 0 ? (
                        <>
                          <div className="comparison-summary">
                            <div className="summary-card warning">
                              <span className="card-value">{comparisonStats.notFoundCount}</span>
                              <span className="card-label">Позиций не найдено</span>
                            </div>
                            <div className="summary-card">
                              <span className="card-value">
                                {formatNumber(comparisonData.filter(i => i.status === 'not_found').reduce((s, i) => s + i.currentSum, 0))}
                              </span>
                              <span className="card-label">Сумма без расценок</span>
                            </div>
                          </div>

                          <div className="table-container">
                            <table className="pivot-table comparison-table">
                              <thead>
                                <tr>
                                  <th>№</th>
                                  <th>Наименование</th>
                                  <th>Ед. изм.</th>
                                  <th>Объем</th>
                                  <th>Цена (файл)</th>
                                  <th>Сумма (файл)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {comparisonData.filter(item => item.status === 'not_found').map((item, idx) => (
                                  <tr key={idx} className="comparison-row status-not_found">
                                    <td>{idx + 1}</td>
                                    <td className="col-name">{item.name}</td>
                                    <td>{item.unit}</td>
                                    <td className="col-volume">{formatNumber(item.totalVolume)}</td>
                                    <td className="col-price">{formatNumber(item.price)}</td>
                                    <td className="col-total">{formatNumber(item.currentSum)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      ) : (
                        <div className="empty-tab success">Все позиции найдены в БСМ</div>
                      )}
                    </div>
                  ) : activeAnalysisTab === 'different' ? (
                    groupedDifferentPrices.length === 0 ? (
                      <div className="empty-tab">Нет материалов с разными ценами</div>
                    ) : (
                      <div className="accordion-list">
                        {groupedDifferentPrices.map((item, idx) => {
                          const contractorRate = rates.find(r => r.material_name.trim().toLowerCase() === item.name.trim().toLowerCase())
                          return (
                            <div key={idx} className={`accordion-item ${expandedItems[idx] ? 'expanded' : ''}`}>
                              <div className="accordion-header" onClick={() => toggleExpanded(idx)}>
                                <span className="accordion-toggle">{expandedItems[idx] ? '▼' : '▶'}</span>
                                <span className="accordion-num">{idx + 1}</span>
                                <span className="accordion-name">{item.name}</span>
                                <span className="accordion-unit">{item.unit}</span>
                                {contractorRate && (
                                  <span className="supply-rate-badge has-rate" title={`Цена БСМ: ${formatNumber(contractorRate.contractor_price)}`}>
                                    ₽ {formatNumber(contractorRate.contractor_price)}
                                  </span>
                                )}
                                <span className="accordion-total">Общий объем: <strong>{formatNumber(item.totalVolume)}</strong></span>
                                <span className="accordion-variants-count">{item.variants.length} расценки</span>
                              </div>
                              {expandedItems[idx] && (
                                <div className="accordion-body">
                                  <table className="variants-table">
                                    <thead>
                                      <tr><th>Цена</th><th>Объем</th><th>Кол-во</th></tr>
                                    </thead>
                                    <tbody>
                                      {item.variants.map((v, vIdx) => (
                                        <tr key={vIdx} className={v.price === 0 ? 'zero-price-row' : ''}>
                                          <td>{v.price ? formatNumber(v.price) : <span className="no-price">Не указана</span>}</td>
                                          <td>{formatNumber(v.volume)}</td>
                                          <td>{v.count}</td>
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
                    )
                  ) : (
                    getFilteredAnalysisData().length === 0 ? (
                      <div className="empty-tab">
                        {activeAnalysisTab === 'zero' ? 'Все материалы имеют расценки' : 'Нет данных'}
                      </div>
                    ) : (
                      <div className="table-container">
                        <table className="pivot-table">
                          <thead>
                            <tr>
                              <th className="col-num">№</th>
                              <th className="col-name">Наименование</th>
                              <th className="col-unit">Ед. изм.</th>
                              <th className="col-volume">Объем</th>
                              <th className="col-price">Цена</th>
                              <th className="col-total">Сумма</th>
                              <th className="col-count">Кол-во</th>
                            </tr>
                          </thead>
                          <tbody>
                            {getFilteredAnalysisData().map((item, idx) => (
                              <tr key={idx} className={`${item.isZeroPrice ? 'zero-price-row' : ''} ${item.hasDifferentPrices ? 'different-price-row' : ''}`}>
                                <td className="col-num">{idx + 1}</td>
                                <td className="col-name">{item.name}</td>
                                <td className="col-unit">{item.unit}</td>
                                <td className="col-volume">{formatNumber(item.totalVolume)}</td>
                                <td className="col-price">{item.priceMaterials ? formatNumber(item.priceMaterials) : <span className="no-price">—</span>}</td>
                                <td className="col-total">{formatNumber(round2(item.totalVolume * item.priceMaterials))}</td>
                                <td className="col-count">{item.count}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="total-row">
                              <td colSpan="5" className="total-label">ИТОГО:</td>
                              <td className="col-total total-value">
                                {formatNumber(getFilteredAnalysisData().reduce((sum, item) => sum + round2(item.totalVolume * item.priceMaterials), 0))}
                              </td>
                              <td></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {selectedObjectId && !selectedCounterpartyId && (
        <div className="empty-state">Выберите подрядчика</div>
      )}

      {/* Модальные окна */}
      {showImportReport && importReport && (
        <div className="import-report-overlay">
          <div className="import-report-modal">
            <div className="import-report-header">
              <h2>Отчёт по импорту</h2>
              <button onClick={handleCancelImport} className="btn-close">×</button>
            </div>
            <div className="import-report-summary">
              <p><strong>Файл:</strong> {importReport.fileName}</p>
              <p><strong>Найдено:</strong> {importReport.totalParsed}</p>
            </div>
            <div className="import-report-stats">
              <div className="stat-item new"><span className="stat-value">{importReport.newItems.length}</span><span className="stat-label">Новых</span></div>
              <div className="stat-item same"><span className="stat-value">{importReport.sameItems.length}</span><span className="stat-label">Без изменений</span></div>
              <div className="stat-item conflict"><span className="stat-value">{importReport.conflictItems.length}</span><span className="stat-label">Конфликты</span></div>
            </div>

            {importReport.conflictItems.length > 0 && (
              <div className="import-section conflicts">
                <h3>Конфликты ({importReport.conflictItems.length})</h3>
                <div className="conflict-bulk-actions">
                  <button onClick={handleSelectAllUpdate} className="btn-bulk">Обновить все</button>
                  <button onClick={handleSelectAllKeep} className="btn-bulk">Оставить все</button>
                </div>
                <div className="conflict-list">
                  <div className="conflict-header">
                    <span className="col-name">Наименование</span>
                    <span className="col-old">Текущая</span>
                    <span className="col-new">Новая</span>
                    <span className="col-action">Действие</span>
                  </div>
                  {importReport.conflictItems.map((item, idx) => (
                    <div key={idx} className={`conflict-item ${conflictDecisions[idx]}`}>
                      <span className="col-name">{item.material_name}</span>
                      <span className="col-old">{formatNumber(item.existingPrice)}</span>
                      <span className="col-new">{formatNumber(item.newPrice)}</span>
                      <span className="col-action">
                        <label className={`radio-option ${conflictDecisions[idx] === 'keep' ? 'selected' : ''}`}>
                          <input type="radio" checked={conflictDecisions[idx] === 'keep'} onChange={() => handleConflictDecision(idx, 'keep')} />
                          Оставить
                        </label>
                        <label className={`radio-option ${conflictDecisions[idx] === 'update' ? 'selected' : ''}`}>
                          <input type="radio" checked={conflictDecisions[idx] === 'update'} onChange={() => handleConflictDecision(idx, 'update')} />
                          Обновить
                        </label>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="import-report-footer">
              <button onClick={handleCancelImport} className="btn-cancel" disabled={isProcessingImport}>Отмена</button>
              <button onClick={handleConfirmImport} className="btn-confirm" disabled={isProcessingImport}>
                {isProcessingImport ? 'Обработка...' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showErrorsModal && (
        <div className="import-report-overlay">
          <div className="import-report-modal" style={{ maxWidth: '700px' }}>
            <div className="import-report-header" style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
              <h2 style={{ color: '#dc2626' }}>Ошибки при импорте</h2>
              <button onClick={() => setShowErrorsModal(false)} className="btn-close">×</button>
            </div>
            <div style={{ padding: '20px' }}>
              <p style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>
                Не добавлено позиций: {importErrors.length}
              </p>
              <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                {importErrors.map((error, idx) => (
                  <div key={idx} style={{ padding: '12px 16px', borderBottom: idx < importErrors.length - 1 ? '1px solid var(--border-color)' : 'none', background: idx % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)' }}>
                    <span style={{ display: 'inline-block', width: '24px', color: 'var(--text-secondary)', fontWeight: '500' }}>{idx + 1}.</span>
                    <span style={{ color: 'var(--text-primary)' }}>{error}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="import-report-footer">
              <button onClick={() => setShowErrorsModal(false)} className="btn-confirm">Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default BSMContractorRatesPage
