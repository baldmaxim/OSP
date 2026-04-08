import { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import './BSMPage.css'

function BSMPage() {
  const [pivotData, setPivotData] = useState([])
  const [materialsData, setMaterialsData] = useState([]) // только материалы
  const [worksData, setWorksData] = useState([]) // только работы

  // Накопительные данные из всех загруженных файлов
  const [loadedFiles, setLoadedFiles] = useState([]) // список загруженных файлов {name, rowCount}
  const [allRawRows, setAllRawRows] = useState([]) // все сырые строки из всех файлов

  const [isLoading, setIsLoading] = useState(false)
  const [stats, setStats] = useState(null)

  // Главная вкладка: материалы или работы
  const [mainTab, setMainTab] = useState('materials') // 'materials' | 'works'
  // Подвкладка для анализа
  const [activeTab, setActiveTab] = useState('all') // 'all', 'zero', 'different', 'units', 'compare', 'not_in_supply'

  const [expandedItems, setExpandedItems] = useState({}) // для раскрытия деталей

  // Данные анализа для материалов
  const [materialsGroupedDifferentPrices, setMaterialsGroupedDifferentPrices] = useState([])
  const [materialsDifferentUnitsData, setMaterialsDifferentUnitsData] = useState([])
  const [materialsStats, setMaterialsStats] = useState(null)

  // Данные анализа для работ
  const [worksGroupedDifferentPrices, setWorksGroupedDifferentPrices] = useState([])
  const [worksDifferentUnitsData, setWorksDifferentUnitsData] = useState([])
  const [worksStats, setWorksStats] = useState(null)

  const fileInputRef = useRef(null)

  // Для сравнения с согласованными расценками
  const [objects, setObjects] = useState([])
  const [selectedObjectId, setSelectedObjectId] = useState('')
  const [approvedRates, setApprovedRates] = useState([])
  const [comparisonData, setComparisonData] = useState([])
  const [comparisonStats, setComparisonStats] = useState(null)

  // Для общего реестра расценок (все объекты)
  const [globalRegistry, setGlobalRegistry] = useState([]) // все расценки из всех объектов
  const [selectedObjectIds, setSelectedObjectIds] = useState([]) // выбранные объекты для сравнения
  const [globalComparisonData, setGlobalComparisonData] = useState([])
  const [globalComparisonStats, setGlobalComparisonStats] = useState(null)

  // Вспомогательная функция округления до сотых (2 знака после запятой)
  const round2 = (num) => Math.round((parseFloat(num) || 0) * 100) / 100

  // Функция очистки числовых значений от пробелов, символов валют и форматирования
  const cleanNumericValue = (value) => {
    if (value === null || value === undefined || value === '') return 0
    // Если уже число - возвращаем как есть
    if (typeof value === 'number') return value
    // Преобразуем в строку
    let str = String(value)
    // Удаляем символы валют (₽, $, €, руб., р., USD, EUR и т.д.)
    str = str.replace(/[₽$€¥£]/g, '')
    str = str.replace(/\s*(руб\.?|р\.?|rub\.?|usd|eur|тыс\.?|млн\.?)\s*/gi, '')
    // Удаляем все пробелы (включая неразрывные)
    str = str.replace(/[\s\u00A0\u2007\u202F]/g, '')
    // Заменяем запятую на точку (для десятичных дробей)
    str = str.replace(',', '.')
    // Удаляем все символы кроме цифр, точки и минуса
    str = str.replace(/[^\d.\-]/g, '')
    // Парсим число
    const num = parseFloat(str)
    return isNaN(num) ? 0 : num
  }

  // Загрузка объектов и общего реестра при монтировании
  useEffect(() => {
    fetchObjects()
    fetchGlobalRegistry()
  }, [])

  // Загрузка согласованных расценок при выборе объекта
  useEffect(() => {
    if (selectedObjectId) {
      fetchApprovedRates()
    } else {
      setApprovedRates([])
      setComparisonData([])
      setComparisonStats(null)
    }
  }, [selectedObjectId])

  // Пересчёт сравнения при изменении данных материалов или расценок
  useEffect(() => {
    if (materialsData.length > 0 && approvedRates.length > 0) {
      // Создаём карту расценок от снабжения по названию материала
      const ratesMap = {}
      approvedRates.forEach(rate => {
        const key = String(rate.material_name || '').trim().toLowerCase()
        ratesMap[key] = round2(rate.supply_price)
      })

      // Сравниваем ВСЕ материалы из файла (даже без цен)
      const comparison = []
      let totalCurrentSum = 0      // Сумма по файлу
      let totalApprovedSum = 0     // Сумма по снабжению
      let totalDifference = 0      // Сумма разниц
      let foundCount = 0           // Найдено в снабжении
      let notFoundCount = 0        // Не найдено в снабжении
      let matchedCount = 0         // Цены совпадают
      let priceDiffCount = 0       // Цены различаются

      // Используем ВСЕ материалы из файла
      materialsData.forEach(item => {
        const key = String(item.name || '').trim().toLowerCase()
        const approvedPrice = ratesMap[key]
        const currentPrice = round2(item.priceMaterials || 0)
        const currentSum = round2(item.totalVolume * currentPrice)

        let approvedSum = 0
        let difference = 0
        let status = 'not_found'

        if (approvedPrice !== undefined) {
          // Найдена расценка от снабжения
          approvedSum = round2(item.totalVolume * approvedPrice)
          foundCount++

          // Если в файле есть цена - сравниваем
          if (currentPrice > 0) {
            difference = round2(approvedSum - currentSum)
            totalCurrentSum = round2(totalCurrentSum + currentSum)
            totalDifference = round2(totalDifference + difference)

            if (Math.abs(currentPrice - approvedPrice) < 0.01) {
              status = 'match'
              matchedCount++
            } else {
              status = 'different'
              priceDiffCount++
            }
          } else {
            // В файле нет цены, но есть расценка от снабжения
            status = 'found_no_file_price'
          }

          totalApprovedSum = round2(totalApprovedSum + approvedSum)
        } else {
          // Расценка не найдена в снабжении
          notFoundCount++
          if (currentPrice > 0) {
            totalCurrentSum = round2(totalCurrentSum + currentSum)
          }
        }

        comparison.push({
          ...item,
          price: currentPrice,
          approvedPrice: approvedPrice,
          currentSum: currentSum,
          approvedSum: approvedSum,
          difference: difference,
          status: status
        })
      })

      setComparisonData(comparison)
      setComparisonStats({
        totalCurrentSum,
        totalApprovedSum,
        totalDifference,
        foundCount,
        matchedCount,
        priceDiffCount,
        notFoundCount,
        totalItems: materialsData.length
      })
    } else if (materialsData.length > 0 && approvedRates.length === 0 && selectedObjectId) {
      // Если выбран объект, но расценок нет - показываем все позиции как не найденные
      const comparison = materialsData.map(item => ({
        ...item,
        price: round2(item.priceMaterials || 0),
        approvedPrice: undefined,
        currentSum: round2(item.totalVolume * (item.priceMaterials || 0)),
        approvedSum: 0,
        difference: 0,
        status: 'not_found'
      }))
      setComparisonData(comparison)
      setComparisonStats({
        totalCurrentSum: comparison.reduce((sum, item) => sum + item.currentSum, 0),
        totalApprovedSum: 0,
        totalDifference: 0,
        foundCount: 0,
        matchedCount: 0,
        priceDiffCount: 0,
        notFoundCount: materialsData.length,
        totalItems: materialsData.length
      })
    } else if (!selectedObjectId) {
      // Объект не выбран - очищаем
      setComparisonData([])
      setComparisonStats(null)
    }
  }, [materialsData, approvedRates, selectedObjectId])

  // Пересчёт сравнения с общим реестром при изменении выбранных объектов
  useEffect(() => {
    if (materialsData.length > 0 && globalRegistry.length > 0) {
      calculateGlobalComparison()
    }
  }, [materialsData, globalRegistry, selectedObjectIds])

  const fetchObjects = async () => {
    const { data, error } = await supabase
      .from('objects')
      .select('id, name')
      .order('name')

    if (!error && data) {
      setObjects(data)
    }
  }

  const fetchApprovedRates = async () => {
    const { data, error } = await supabase
      .from('bsm_supply_rates')
      .select('*')
      .eq('object_id', selectedObjectId)

    if (!error && data) {
      setApprovedRates(data)
    }
  }

  // Загрузка общего реестра (все расценки со всех объектов)
  const fetchGlobalRegistry = async () => {
    const { data, error } = await supabase
      .from('bsm_supply_rates')
      .select('*, objects(id, name)')
      .order('material_name')

    if (!error && data) {
      setGlobalRegistry(data)
    }
  }

  // Расчёт сравнения с общим реестром
  const calculateGlobalComparison = () => {
    // Фильтруем реестр по выбранным объектам (если выбраны)
    const filteredRegistry = selectedObjectIds.length > 0
      ? globalRegistry.filter(rate => selectedObjectIds.includes(rate.object_id))
      : globalRegistry

    if (filteredRegistry.length === 0) {
      setGlobalComparisonData([])
      setGlobalComparisonStats(null)
      return
    }

    // Создаём карту расценок по названию материала с группировкой по объектам
    const ratesMap = {}
    filteredRegistry.forEach(rate => {
      const key = String(rate.material_name || '').trim().toLowerCase()
      if (!ratesMap[key]) {
        ratesMap[key] = {
          materialName: rate.material_name,
          unit: rate.unit,
          prices: [],
          objectPrices: [] // массив {objectName, price}
        }
      }
      ratesMap[key].prices.push(round2(rate.supply_price))
      ratesMap[key].objectPrices.push({
        objectId: rate.object_id,
        objectName: rate.objects?.name || 'Неизвестный объект',
        price: round2(rate.supply_price),
        appliedAt: rate.applied_at
      })
    })

    // Расчёт мин/макс/средней для каждого материала
    Object.values(ratesMap).forEach(item => {
      item.minPrice = Math.min(...item.prices)
      item.maxPrice = Math.max(...item.prices)
      item.avgPrice = round2(item.prices.reduce((a, b) => a + b, 0) / item.prices.length)
      item.priceSpread = item.prices.length > 1 ? round2(item.maxPrice - item.minPrice) : 0
    })

    // Сравниваем материалы из файла с общим реестром
    const comparison = []
    let totalCurrentSum = 0
    let totalMinSum = 0
    let totalMaxSum = 0
    let totalAvgSum = 0
    let matchedCount = 0
    let notFoundCount = 0
    let cheaperCount = 0
    let expensiveCount = 0

    const materialsWithPrice = materialsData.filter(item => item.priceMaterials > 0)

    materialsWithPrice.forEach(item => {
      const key = String(item.name || '').trim().toLowerCase()
      const registryData = ratesMap[key]
      const currentPrice = round2(item.priceMaterials || 0)
      const currentSum = round2(item.totalVolume * currentPrice)

      let status = 'not_found'
      let minSum = 0, maxSum = 0, avgSum = 0
      let savings = 0

      if (registryData) {
        minSum = round2(item.totalVolume * registryData.minPrice)
        maxSum = round2(item.totalVolume * registryData.maxPrice)
        avgSum = round2(item.totalVolume * registryData.avgPrice)

        totalCurrentSum = round2(totalCurrentSum + currentSum)
        totalMinSum = round2(totalMinSum + minSum)
        totalMaxSum = round2(totalMaxSum + maxSum)
        totalAvgSum = round2(totalAvgSum + avgSum)

        // Сравниваем с минимальной ценой из реестра
        if (currentPrice <= registryData.minPrice + 0.01) {
          status = 'cheapest'
          cheaperCount++
        } else if (currentPrice >= registryData.maxPrice - 0.01) {
          status = 'expensive'
          expensiveCount++
        } else {
          status = 'in_range'
          matchedCount++
        }

        // Потенциальная экономия (если взять мин. цену)
        savings = round2(currentSum - minSum)

        comparison.push({
          ...item,
          price: currentPrice,
          registryData: registryData,
          minPrice: registryData.minPrice,
          maxPrice: registryData.maxPrice,
          avgPrice: registryData.avgPrice,
          currentSum,
          minSum,
          maxSum,
          avgSum,
          savings,
          status,
          objectPrices: registryData.objectPrices
        })
      } else {
        notFoundCount++
        comparison.push({
          ...item,
          price: currentPrice,
          registryData: null,
          currentSum,
          status: 'not_found'
        })
      }
    })

    setGlobalComparisonData(comparison)
    setGlobalComparisonStats({
      totalCurrentSum,
      totalMinSum,
      totalMaxSum,
      totalAvgSum,
      potentialSavings: round2(totalCurrentSum - totalMinSum),
      matchedCount,
      notFoundCount,
      cheaperCount,
      expensiveCount,
      totalItems: materialsWithPrice.length,
      registryItemsCount: Object.keys(ratesMap).length,
      selectedObjectsCount: selectedObjectIds.length || objects.length
    })
  }

  // Определение типа позиции по коду
  const getItemType = (code) => {
    if (!code) return 'material'
    const codeStr = String(code).trim().toLowerCase()
    // Если код начинается с "р" или равен "р" - это работа
    if (codeStr === 'р' || codeStr.startsWith('р-') || codeStr.startsWith('р ')) {
      return 'work'
    }
    // Если код содержит "мат" - это материал
    if (codeStr.includes('мат')) {
      return 'material'
    }
    // По умолчанию - материал
    return 'material'
  }

  // Создание сводной таблицы как в Excel
  const createPivotTable = (rows) => {
    // Две отдельные карты: для материалов и для работ
    const materialsMap = {}
    const worksMap = {}

    rows.forEach(row => {
      const name = String(row.name || '').trim()
      if (!name) return

      const priceMaterials = round2(row.priceMaterials)
      const priceWorks = round2(row.priceWorks)
      const volume = round2(row.volume)
      const itemType = row.type || 'material'

      // Для работ (тип "Р") - добавляем только в работы
      if (itemType === 'work') {
        const key = `${name.toLowerCase()}|work|${priceWorks.toFixed(2)}`
        if (!worksMap[key]) {
          worksMap[key] = {
            name: name,
            unit: row.unit || '',
            type: 'work',
            priceMaterials: 0,
            priceWorks: priceWorks,
            totalVolume: 0,
            count: 0,
            isZeroPrice: priceWorks === 0
          }
        }
        worksMap[key].totalVolume = round2(worksMap[key].totalVolume + volume)
        worksMap[key].count += 1
      } else {
        // Для материалов (тип "мат."):
        // 1. Если есть цена материалов - добавляем в материалы
        if (priceMaterials > 0) {
          const matKey = `${name.toLowerCase()}|material|${priceMaterials.toFixed(2)}`
          if (!materialsMap[matKey]) {
            materialsMap[matKey] = {
              name: name,
              unit: row.unit || '',
              type: 'material',
              priceMaterials: priceMaterials,
              priceWorks: 0,
              totalVolume: 0,
              count: 0,
              isZeroPrice: false
            }
          }
          materialsMap[matKey].totalVolume = round2(materialsMap[matKey].totalVolume + volume)
          materialsMap[matKey].count += 1
        }

        // 2. Если есть цена работ - добавляем в работы (монтаж материала)
        if (priceWorks > 0) {
          const workKey = `${name.toLowerCase()}|material_work|${priceWorks.toFixed(2)}`
          if (!worksMap[workKey]) {
            worksMap[workKey] = {
              name: name,
              unit: row.unit || '',
              type: 'material_work', // Работы по монтажу материала
              priceMaterials: 0,
              priceWorks: priceWorks,
              totalVolume: 0,
              count: 0,
              isZeroPrice: false
            }
          }
          worksMap[workKey].totalVolume = round2(worksMap[workKey].totalVolume + volume)
          worksMap[workKey].count += 1
        }

        // 3. Если нет ни цены материалов, ни цены работ - добавляем в материалы как "без расценки"
        if (priceMaterials === 0 && priceWorks === 0) {
          const zeroKey = `${name.toLowerCase()}|material|0.00`
          if (!materialsMap[zeroKey]) {
            materialsMap[zeroKey] = {
              name: name,
              unit: row.unit || '',
              type: 'material',
              priceMaterials: 0,
              priceWorks: 0,
              totalVolume: 0,
              count: 0,
              isZeroPrice: true
            }
          }
          materialsMap[zeroKey].totalVolume = round2(materialsMap[zeroKey].totalVolume + volume)
          materialsMap[zeroKey].count += 1
        }
      }
    })

    // Преобразуем в массивы и сортируем по названию
    const materials = Object.values(materialsMap).sort((a, b) =>
      a.name.localeCompare(b.name, 'ru')
    )
    const works = Object.values(worksMap).sort((a, b) =>
      a.name.localeCompare(b.name, 'ru')
    )

    // Общий массив для совместимости
    const pivotArray = [...materials, ...works].sort((a, b) =>
      a.name.localeCompare(b.name, 'ru')
    )

    // Помечаем материалы с разными ценами и добавляем список всех цен
    // Для материалов - группируем по названию среди материалов
    // Для работ - группируем по названию среди работ
    const materialsByName = {}
    materials.forEach(item => {
      const nameLower = item.name.toLowerCase()
      if (!materialsByName[nameLower]) materialsByName[nameLower] = []
      materialsByName[nameLower].push(item)
    })

    const worksByName = {}
    works.forEach(item => {
      const nameLower = item.name.toLowerCase()
      if (!worksByName[nameLower]) worksByName[nameLower] = []
      worksByName[nameLower].push(item)
    })

    materials.forEach(item => {
      const nameLower = item.name.toLowerCase()
      const group = materialsByName[nameLower]
      item.hasDifferentPrices = group.length > 1
      if (item.hasDifferentPrices) {
        item.allPrices = group.map(g => g.priceMaterials).sort((a, b) => a - b)
      }
    })

    works.forEach(item => {
      const nameLower = item.name.toLowerCase()
      const group = worksByName[nameLower]
      item.hasDifferentPrices = group.length > 1
      if (item.hasDifferentPrices) {
        item.allPrices = group.map(g => g.priceWorks).sort((a, b) => a - b)
      }
    })

    // Группируем материалы с разными ценами для отдельной вкладки (раздельно для материалов и работ)
    const materialsNameGroups = {}
    const worksNameGroups = {}

    // Материалы - только type === 'material'
    materials.forEach(item => {
      const nameLower = item.name.toLowerCase()
      if (!materialsNameGroups[nameLower]) {
        materialsNameGroups[nameLower] = []
      }
      materialsNameGroups[nameLower].push(item)
    })

    // Работы - type === 'work' или 'material_work'
    works.forEach(item => {
      const nameLower = item.name.toLowerCase()
      if (!worksNameGroups[nameLower]) {
        worksNameGroups[nameLower] = []
      }
      worksNameGroups[nameLower].push(item)
    })

    // Функция для создания сгруппированных позиций с разными ценами
    const createGroupedDifferent = (nameGroups, priceField) => {
      return Object.values(nameGroups)
        .filter(g => g.length > 1)
        .map(group => ({
          name: group[0].name,
          unit: group[0].unit,
          type: group[0].type,
          totalVolume: group.reduce((sum, item) => sum + item.totalVolume, 0),
          variants: group.map(item => ({
            price: item[priceField],
            volume: item.totalVolume,
            count: item.count
          })).sort((a, b) => a.price - b.price)
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    }

    const materialsGroupedDifferent = createGroupedDifferent(materialsNameGroups, 'priceMaterials')
    const worksGroupedDifferent = createGroupedDifferent(worksNameGroups, 'priceWorks')

    // Анализ единиц измерения - группируем по названию и типу, проверяем разные ед. изм.
    const materialsUnitsByName = {}
    const worksUnitsByName = {}

    rows.forEach(row => {
      const name = String(row.name || '').trim().toLowerCase()
      const unit = String(row.unit || '').trim()
      const itemType = row.type || 'material'
      if (!name) return

      const targetUnits = itemType === 'material' ? materialsUnitsByName : worksUnitsByName

      if (!targetUnits[name]) {
        targetUnits[name] = {
          originalName: row.name,
          units: {}
        }
      }
      if (!targetUnits[name].units[unit]) {
        targetUnits[name].units[unit] = {
          unit: unit,
          volume: 0,
          count: 0
        }
      }
      targetUnits[name].units[unit].volume += parseFloat(row.volume) || 0
      targetUnits[name].units[unit].count += 1
    })

    // Функция для создания списка позиций с разными ед. изм.
    const createDifferentUnits = (unitsByName) => {
      return Object.values(unitsByName)
        .filter(item => Object.keys(item.units).length > 1)
        .map(item => ({
          name: item.originalName,
          variants: Object.values(item.units).sort((a, b) => b.count - a.count)
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    }

    const materialsDifferentUnits = createDifferentUnits(materialsUnitsByName)
    const worksDifferentUnits = createDifferentUnits(worksUnitsByName)

    // Статистика для материалов
    const materialsZeroPriceCount = materials.filter(item => item.isZeroPrice).length
    const materialsDifferentPricesCount = Object.values(materialsNameGroups).filter(g => g.length > 1).length

    // Статистика для работ
    const worksZeroPriceCount = works.filter(item => item.isZeroPrice).length
    const worksDifferentPricesCount = Object.values(worksNameGroups).filter(g => g.length > 1).length

    return {
      pivotArray,
      materials,
      works,
      // Данные анализа для материалов
      materialsGroupedDifferent,
      materialsDifferentUnits,
      materialsStats: {
        totalItems: materials.length,
        zeroPriceCount: materialsZeroPriceCount,
        differentPricesCount: materialsDifferentPricesCount,
        differentUnitsCount: materialsDifferentUnits.length
      },
      // Данные анализа для работ
      worksGroupedDifferent,
      worksDifferentUnits,
      worksStats: {
        totalItems: works.length,
        zeroPriceCount: worksZeroPriceCount,
        differentPricesCount: worksDifferentPricesCount,
        differentUnitsCount: worksDifferentUnits.length
      },
      // Общая статистика
      stats: {
        totalRows: rows.length,
        uniqueLines: pivotArray.length,
        materialsCount: materials.length,
        worksCount: works.length
      }
    }
  }

  // Парсинг одного файла и возврат строк
  const parseExcelFile = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target.result, { type: 'binary' })
          const sheetName = workbook.SheetNames[0]
          const worksheet = workbook.Sheets[sheetName]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          const rows = []

          // Находим строку заголовка
          let headerRowIndex = 0
          for (let i = 0; i < Math.min(10, jsonData.length); i++) {
            const row = jsonData[i]
            if (row && row.some(cell =>
              cell && typeof cell === 'string' &&
              (cell.toLowerCase().includes('наименование') ||
               cell.toLowerCase().includes('материал') ||
               cell.toLowerCase().includes('код'))
            )) {
              headerRowIndex = i
              break
            }
          }

          // Парсим данные после заголовка
          // Новый формат: КОД | Наименование | Ед.изм. | Объем | Цена материалов | Цена работ
          for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row) continue

            const code = String(row[0] || '').trim()
            // Пропускаем строки без КОДа
            if (!code) continue

            const itemType = getItemType(code)

            rows.push({
              code: code,
              type: itemType,
              name: row[1] || '',
              unit: row[2] || '',
              volume: cleanNumericValue(row[3]),
              priceMaterials: cleanNumericValue(row[4]),
              priceWorks: cleanNumericValue(row[5]),
              sourceFile: file.name // для отслеживания источника
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

  // Пересчёт сводной таблицы из всех накопленных строк
  const recalculateFromRows = (rows) => {
    const result = createPivotTable(rows)
    setPivotData(result.pivotArray)
    setMaterialsData(result.materials)
    setWorksData(result.works)

    // Данные анализа для материалов
    setMaterialsGroupedDifferentPrices(result.materialsGroupedDifferent)
    setMaterialsDifferentUnitsData(result.materialsDifferentUnits)
    setMaterialsStats(result.materialsStats)

    // Данные анализа для работ
    setWorksGroupedDifferentPrices(result.worksGroupedDifferent)
    setWorksDifferentUnitsData(result.worksDifferentUnits)
    setWorksStats(result.worksStats)

    setStats(result.stats)
  }

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files)
    if (files.length === 0) return

    setIsLoading(true)

    try {
      // Парсим все выбранные файлы
      const results = await Promise.all(files.map(parseExcelFile))

      // Добавляем новые строки к существующим
      let newRows = [...allRawRows]
      const newFiles = [...loadedFiles]

      results.forEach(({ fileName, rows }) => {
        // Проверяем, не загружен ли уже файл с таким именем
        if (!loadedFiles.some(f => f.name === fileName)) {
          newRows = [...newRows, ...rows]
          newFiles.push({ name: fileName, rowCount: rows.length })
        } else {
          alert(`Файл "${fileName}" уже загружен`)
        }
      })

      setAllRawRows(newRows)
      setLoadedFiles(newFiles)
      recalculateFromRows(newRows)

    } catch (error) {
      console.error('Ошибка при чтении файла:', error)
      alert('Ошибка при чтении файла. Убедитесь, что это корректный Excel-файл.')
    } finally {
      setIsLoading(false)
      // Сбрасываем input для возможности повторной загрузки того же файла
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  // Удаление одного файла из списка
  const handleRemoveFile = (fileNameToRemove) => {
    const newFiles = loadedFiles.filter(f => f.name !== fileNameToRemove)
    const newRows = allRawRows.filter(row => row.sourceFile !== fileNameToRemove)

    setLoadedFiles(newFiles)
    setAllRawRows(newRows)

    if (newRows.length > 0) {
      recalculateFromRows(newRows)
    } else {
      // Если удалили все файлы - сбросить всё
      handleClear()
    }
  }

  const handleClear = () => {
    setPivotData([])
    setMaterialsData([])
    setWorksData([])

    // Сброс накопительных данных
    setLoadedFiles([])
    setAllRawRows([])

    // Сброс анализа материалов
    setMaterialsGroupedDifferentPrices([])
    setMaterialsDifferentUnitsData([])
    setMaterialsStats(null)

    // Сброс анализа работ
    setWorksGroupedDifferentPrices([])
    setWorksDifferentUnitsData([])
    setWorksStats(null)

    setStats(null)
    setMainTab('materials')
    setActiveTab('all')
    setExpandedItems({})
    setComparisonData([])
    setComparisonStats(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const toggleExpanded = (index) => {
    setExpandedItems(prev => ({
      ...prev,
      [index]: !prev[index]
    }))
  }

  // Функция расчёта суммы позиции
  // Для работ: объём × цена работ
  // Для материалов: объём × цена материалов + объём × цена работ (если есть)
  const calculateItemTotal = (item) => {
    if (item.type === 'work') {
      return round2(item.totalVolume * (item.priceWorks || 0))
    }
    // Для материалов: сумма материалов + сумма работ (если указана цена работ)
    const materialsSum = round2(item.totalVolume * (item.priceMaterials || 0))
    const worksSum = round2(item.totalVolume * (item.priceWorks || 0))
    return round2(materialsSum + worksSum)
  }

  // Расчёт суммы только по материалам (без работ)
  const calculateMaterialsSum = (item) => {
    return round2(item.totalVolume * (item.priceMaterials || 0))
  }

  // Расчёт суммы только по работам
  const calculateWorksSum = (item) => {
    return round2(item.totalVolume * (item.priceWorks || 0))
  }

  // Получение цены для позиции (в зависимости от типа)
  const getItemPrice = (item) => {
    return item.type === 'work' ? item.priceWorks : item.priceMaterials
  }

  // Получение текущих данных в зависимости от главной вкладки
  const getCurrentData = () => mainTab === 'materials' ? materialsData : worksData
  const getCurrentStats = () => mainTab === 'materials' ? materialsStats : worksStats
  const getCurrentGroupedDifferentPrices = () => mainTab === 'materials' ? materialsGroupedDifferentPrices : worksGroupedDifferentPrices
  const getCurrentDifferentUnitsData = () => mainTab === 'materials' ? materialsDifferentUnitsData : worksDifferentUnitsData

  // Фильтрация данных по активной подвкладке
  const getFilteredData = () => {
    const currentData = getCurrentData()
    switch (activeTab) {
      case 'zero':
        return currentData.filter(item => item.isZeroPrice)
      case 'different':
        return currentData.filter(item => item.hasDifferentPrices)
      default:
        return currentData
    }
  }

  const filteredData = getFilteredData()
  const currentStats = getCurrentStats()
  const currentGroupedDifferentPrices = getCurrentGroupedDifferentPrices()
  const currentDifferentUnitsData = getCurrentDifferentUnitsData()

  const handleExport = () => {
    if (pivotData.length === 0) return

    const wb = XLSX.utils.book_new()

    // Функция для установки ширины столбцов
    const setColWidths = (ws, widths) => {
      ws['!cols'] = widths.map(w => ({ wch: w }))
    }

    // Функция для создания заголовка отчета
    const addReportHeader = (ws, title, colCount) => {
      // Вставляем заголовок в начало
      XLSX.utils.sheet_add_aoa(ws, [[title]], { origin: 'A1' })
      // Объединяем ячейки для заголовка
      if (!ws['!merges']) ws['!merges'] = []
      ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } })
    }

    // Общие суммы
    // Для материалов: только стоимость материалов
    const totalMaterialsSum = round2(materialsData.reduce((sum, item) => sum + round2(item.totalVolume * (item.priceMaterials || 0)), 0))
    // Для работ: все работы (включая монтаж материалов)
    const totalWorksSum = round2(worksData.reduce((sum, item) => sum + round2(item.totalVolume * (item.priceWorks || 0)), 0))
    const totalSum = round2(totalMaterialsSum + totalWorksSum)

    // 1. Лист "Все позиции"
    const allHeaders = ['№', 'Тип', 'Наименование', 'Ед. изм.', 'Объем', 'Цена', 'Сумма', 'Кол-во', 'Примечание']
    const allRows = pivotData.map((item, idx) => {
      // Для материалов - цена материалов, для работ - цена работ
      const price = item.type === 'material' ? item.priceMaterials : item.priceWorks
      const itemSum = round2(item.totalVolume * (price || 0))
      const typeLabel = item.type === 'work' ? 'Р' : (item.type === 'material_work' ? 'монтаж' : 'мат.')
      return [
        idx + 1,
        typeLabel,
        item.name,
        item.unit,
        item.totalVolume,
        price || '',
        itemSum || '',
        item.count,
        item.isZeroPrice ? 'Нет расценки' : (item.hasDifferentPrices ? 'Разные цены' : '')
      ]
    })

    // Итоговая строка
    allRows.push(['', '', '', '', '', 'ИТОГО:', totalSum, '', ''])

    const wsAll = XLSX.utils.aoa_to_sheet([
      ['ОТЧЕТ ПО МАТЕРИАЛАМ И РАБОТАМ'],
      ['Дата формирования: ' + new Date().toLocaleDateString('ru-RU')],
      ['Материалы: ' + totalMaterialsSum.toLocaleString('ru-RU') + ' | Работы: ' + totalWorksSum.toLocaleString('ru-RU') + ' | ИТОГО: ' + totalSum.toLocaleString('ru-RU')],
      [],
      allHeaders,
      ...allRows
    ])

    // Объединение для заголовка
    wsAll['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } }
    ]

    setColWidths(wsAll, [5, 10, 45, 10, 12, 14, 18, 8, 15])
    XLSX.utils.book_append_sheet(wb, wsAll, 'Все позиции')

    // 2. Лист "Материалы"
    if (materialsData.length > 0) {
      const matHeaders = ['№', 'Наименование', 'Ед. изм.', 'Объем', 'Цена', 'Сумма', 'Кол-во']
      const matRows = materialsData.map((item, idx) => {
        const matSum = round2(item.totalVolume * (item.priceMaterials || 0))
        return [
          idx + 1,
          item.name,
          item.unit,
          item.totalVolume,
          item.priceMaterials || '',
          matSum || '',
          item.count
        ]
      })

      matRows.push(['', '', '', '', 'ИТОГО:', totalMaterialsSum, ''])

      const wsMat = XLSX.utils.aoa_to_sheet([
        ['МАТЕРИАЛЫ'],
        ['Позиций: ' + materialsData.length + ' | Сумма: ' + totalMaterialsSum.toLocaleString('ru-RU')],
        [],
        matHeaders,
        ...matRows
      ])

      wsMat['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }
      ]

      setColWidths(wsMat, [5, 50, 10, 12, 14, 18, 8])
      XLSX.utils.book_append_sheet(wb, wsMat, 'Материалы')
    }

    // 3. Лист "Работы"
    if (worksData.length > 0) {
      const workHeaders = ['№', 'Наименование', 'Ед. изм.', 'Объем', 'Цена работ', 'Сумма работ', 'Кол-во']
      const workRows = worksData.map((item, idx) => [
        idx + 1,
        item.name,
        item.unit,
        item.totalVolume,
        item.priceWorks || '',
        round2(item.totalVolume * (item.priceWorks || 0)) || '',
        item.count
      ])

      workRows.push(['', '', '', '', 'ИТОГО:', totalWorksSum, ''])

      const wsWork = XLSX.utils.aoa_to_sheet([
        ['РАБОТЫ (код "Р")'],
        ['Позиций: ' + worksData.length + ' | Сумма работ: ' + totalWorksSum.toLocaleString('ru-RU')],
        [],
        workHeaders,
        ...workRows
      ])

      wsWork['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }
      ]

      setColWidths(wsWork, [5, 50, 10, 12, 15, 18, 8])
      XLSX.utils.book_append_sheet(wb, wsWork, 'Работы')
    }

    // 3.1. Лист "Работы без расценки"
    const zeroWorksItems = worksData.filter(item => item.isZeroPrice)
    if (zeroWorksItems.length > 0) {
      const zeroWorksHeaders = ['№', 'Наименование', 'Ед. изм.', 'Объем', 'Кол-во']
      const zeroWorksRows = zeroWorksItems.map((item, idx) => [
        idx + 1,
        item.name,
        item.unit,
        item.totalVolume,
        item.count
      ])

      const wsZeroWorks = XLSX.utils.aoa_to_sheet([
        ['РАБОТЫ БЕЗ РАСЦЕНКИ'],
        ['Обнаружено позиций: ' + zeroWorksItems.length],
        [],
        zeroWorksHeaders,
        ...zeroWorksRows
      ])

      wsZeroWorks['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }
      ]

      setColWidths(wsZeroWorks, [5, 50, 10, 15, 8])
      XLSX.utils.book_append_sheet(wb, wsZeroWorks, 'Работы без расценки')
    }

    // 4. Лист "Материалы без расценки"
    const zeroItems = materialsData.filter(item => item.isZeroPrice)
    if (zeroItems.length > 0) {
      const zeroHeaders = ['№', 'Наименование', 'Ед. изм.', 'Объем', 'Кол-во']
      const zeroRows = zeroItems.map((item, idx) => [
        idx + 1,
        item.name,
        item.unit,
        item.totalVolume,
        item.count
      ])

      const wsZero = XLSX.utils.aoa_to_sheet([
        ['МАТЕРИАЛЫ БЕЗ РАСЦЕНКИ'],
        ['Обнаружено позиций: ' + zeroItems.length],
        [],
        zeroHeaders,
        ...zeroRows
      ])

      wsZero['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }
      ]

      setColWidths(wsZero, [5, 50, 10, 15, 8])
      XLSX.utils.book_append_sheet(wb, wsZero, 'Мат. без расценки')
    }

    // 5. Лист "Разные цены (мат.)" - только материалы с разными ценами
    if (materialsGroupedDifferentPrices.length > 0) {
      const diffMatPricesRows = [
        ['МАТЕРИАЛЫ С РАЗНЫМИ РАСЦЕНКАМИ'],
        ['Обнаружено позиций: ' + materialsGroupedDifferentPrices.length],
        [],
        ['№', 'Наименование', 'Ед. изм.', 'Общий объем', 'Цена', 'Объем по цене', 'Кол-во']
      ]

      materialsGroupedDifferentPrices.forEach((item, idx) => {
        // Строка с названием
        diffMatPricesRows.push([
          idx + 1,
          item.name,
          item.unit,
          item.totalVolume,
          '',
          '',
          ''
        ])
        // Варианты цен с отступом
        item.variants.forEach(variant => {
          diffMatPricesRows.push([
            '',
            '   → вариант цены:',
            '',
            '',
            variant.price || 'Не указана',
            variant.volume,
            variant.count
          ])
        })
        // Пустая строка
        diffMatPricesRows.push([])
      })

      const wsDiffMat = XLSX.utils.aoa_to_sheet(diffMatPricesRows)
      wsDiffMat['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }
      ]

      setColWidths(wsDiffMat, [5, 50, 10, 15, 15, 15, 8])
      XLSX.utils.book_append_sheet(wb, wsDiffMat, 'Разные цены (мат.)')
    }

    // 5.1. Лист "Разные цены (раб.)" - только работы с разными ценами
    if (worksGroupedDifferentPrices.length > 0) {
      const diffWorkPricesRows = [
        ['РАБОТЫ С РАЗНЫМИ РАСЦЕНКАМИ'],
        ['Обнаружено позиций: ' + worksGroupedDifferentPrices.length],
        [],
        ['№', 'Наименование', 'Ед. изм.', 'Общий объем', 'Цена', 'Объем по цене', 'Кол-во']
      ]

      worksGroupedDifferentPrices.forEach((item, idx) => {
        // Строка с названием
        diffWorkPricesRows.push([
          idx + 1,
          item.name,
          item.unit,
          item.totalVolume,
          '',
          '',
          ''
        ])
        // Варианты цен с отступом
        item.variants.forEach(variant => {
          diffWorkPricesRows.push([
            '',
            '   → вариант цены:',
            '',
            '',
            variant.price || 'Не указана',
            variant.volume,
            variant.count
          ])
        })
        // Пустая строка
        diffWorkPricesRows.push([])
      })

      const wsDiffWork = XLSX.utils.aoa_to_sheet(diffWorkPricesRows)
      wsDiffWork['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }
      ]

      setColWidths(wsDiffWork, [5, 50, 10, 15, 15, 15, 8])
      XLSX.utils.book_append_sheet(wb, wsDiffWork, 'Разные цены (раб.)')
    }

    // 6. Лист "Разные ед. изм."
    // Объединяем данные материалов и работ для экспорта
    const allDifferentUnitsData = [...materialsDifferentUnitsData, ...worksDifferentUnitsData]
    if (allDifferentUnitsData.length > 0) {
      const diffUnitsRows = [
        ['ОШИБКИ В ЕДИНИЦАХ ИЗМЕРЕНИЯ'],
        ['Обнаружено позиций с разными ед. изм.: ' + allDifferentUnitsData.length],
        [],
        ['№', 'Наименование', 'Единица измерения', 'Объем', 'Кол-во поз.']
      ]

      allDifferentUnitsData.forEach((item, idx) => {
        // Строка с названием материала
        diffUnitsRows.push([
          idx + 1,
          item.name,
          '',
          '',
          ''
        ])
        // Варианты единиц с отступом
        item.variants.forEach(variant => {
          diffUnitsRows.push([
            '',
            '   → единица:',
            variant.unit || '(пусто)',
            variant.volume,
            variant.count
          ])
        })
        // Пустая строка
        diffUnitsRows.push([])
      })

      const wsUnits = XLSX.utils.aoa_to_sheet(diffUnitsRows)
      wsUnits['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }
      ]

      setColWidths(wsUnits, [5, 50, 20, 15, 10])
      XLSX.utils.book_append_sheet(wb, wsUnits, 'Разные ед.изм.')
    }

    // 5. Лист "Нет в снабжении" - позиции отсутствующие в расценках от снабжения
    const notInSupplyItems = comparisonData.filter(item => item.status === 'not_found')
    if (notInSupplyItems.length > 0) {
      const notInSupplySum = notInSupplyItems.reduce((sum, item) => sum + item.currentSum, 0)
      const notInSupplyHeaders = ['№', 'Наименование материалов', 'Ед. изм.', 'Объем', 'Цена (файл)', 'Сумма (файл)']
      const notInSupplyRows = notInSupplyItems.map((item, idx) => [
        idx + 1,
        item.name,
        item.unit,
        item.totalVolume,
        item.price || '',
        item.currentSum || ''
      ])

      // Итоговая строка
      notInSupplyRows.push(['', '', '', '', 'ИТОГО:', notInSupplySum])

      const wsNotInSupply = XLSX.utils.aoa_to_sheet([
        ['ПОЗИЦИИ ОТСУТСТВУЮЩИЕ В РАСЦЕНКАХ ОТ СНАБЖЕНИЯ'],
        ['Объект: ' + (objects.find(o => o.id === selectedObjectId)?.name || 'Не выбран')],
        ['Обнаружено позиций: ' + notInSupplyItems.length],
        [],
        notInSupplyHeaders,
        ...notInSupplyRows
      ])

      wsNotInSupply['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: 5 } }
      ]

      setColWidths(wsNotInSupply, [5, 50, 10, 15, 18, 18])
      XLSX.utils.book_append_sheet(wb, wsNotInSupply, 'Нет в снабжении')
    }

    // 6. Лист "Сравнение с ценами от снабжения"
    const comparedItems = comparisonData.filter(item => item.status !== 'not_found')
    if (comparedItems.length > 0 && comparisonStats) {
      const comparisonHeaders = ['№', 'Наименование материалов', 'Ед. изм.', 'Объем', 'Цена (файл)', 'Цена (снабжение)', 'Сумма (файл)', 'Сумма (снабжение)', 'Удешевление']
      const comparisonRows = comparedItems.map((item, idx) => [
        idx + 1,
        item.name,
        item.unit,
        item.totalVolume,
        item.price || '',
        item.approvedPrice || '',
        item.currentSum || '',
        item.approvedSum || '',
        item.difference || 0
      ])

      // Итоговая строка
      comparisonRows.push(['', '', '', '', '', 'ИТОГО:', comparisonStats.totalCurrentSum, comparisonStats.totalApprovedSum, comparisonStats.totalDifference])

      const wsComparison = XLSX.utils.aoa_to_sheet([
        ['СРАВНЕНИЕ С ЦЕНАМИ ОТ СНАБЖЕНИЯ'],
        ['Объект: ' + (objects.find(o => o.id === selectedObjectId)?.name || 'Не выбран')],
        ['Позиций сравнено: ' + comparedItems.length + ' | Совпадают: ' + comparisonStats.matchedCount + ' | Разные цены: ' + comparisonStats.priceDiffCount],
        [],
        comparisonHeaders,
        ...comparisonRows
      ])

      wsComparison['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } }
      ]

      setColWidths(wsComparison, [5, 45, 10, 12, 15, 15, 18, 18, 18])
      XLSX.utils.book_append_sheet(wb, wsComparison, 'Сравнение с снабжением')
    }

    // 7. Лист "БСМ" - расценки от снабжения с объемами из файла
    if (approvedRates.length > 0 && materialsData.length > 0) {
      // Создаём карту объемов по названию материала (суммируем все объемы для одного названия)
      const volumesByName = {}
      materialsData.forEach(item => {
        const key = String(item.name || '').trim().toLowerCase()
        if (!volumesByName[key]) {
          volumesByName[key] = {
            name: item.name,
            unit: item.unit,
            totalVolume: 0
          }
        }
        volumesByName[key].totalVolume = round2(volumesByName[key].totalVolume + item.totalVolume)
      })

      // Формируем данные для листа БСМ
      const bsmRows = []
      let bsmTotalSum = 0

      approvedRates.forEach((rate, idx) => {
        const key = String(rate.material_name || '').trim().toLowerCase()
        const volumeData = volumesByName[key]
        const volume = volumeData ? volumeData.totalVolume : 0
        const sum = round2(volume * (rate.supply_price || 0))
        bsmTotalSum = round2(bsmTotalSum + sum)

        bsmRows.push([
          idx + 1,
          rate.material_name,
          rate.unit || (volumeData ? volumeData.unit : ''),
          volume || '',
          rate.supply_price || '',
          sum || '',
          rate.notes || ''
        ])
      })

      // Итоговая строка
      bsmRows.push(['', '', '', '', 'ИТОГО:', bsmTotalSum, ''])

      const bsmHeaders = ['№', 'Наименование материала', 'Ед. изм.', 'Объем', 'Расценка БСМ', 'Сумма', 'Примечание']

      const wsBsm = XLSX.utils.aoa_to_sheet([
        ['РАСЦЕНКИ ОТ СНАБЖЕНИЯ (БСМ)'],
        ['Объект: ' + (objects.find(o => o.id === selectedObjectId)?.name || 'Не выбран')],
        ['Позиций: ' + approvedRates.length + ' | Итого: ' + bsmTotalSum.toLocaleString('ru-RU')],
        [],
        bsmHeaders,
        ...bsmRows
      ])

      wsBsm['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: 6 } }
      ]

      setColWidths(wsBsm, [5, 50, 10, 12, 15, 18, 20])
      XLSX.utils.book_append_sheet(wb, wsBsm, 'БСМ')
    }

    // 8. Лист "Сводка"
    const filesListText = loadedFiles.map(f => f.name).join(', ')
    const summaryRows = [
      ['СВОДКА ПО АНАЛИЗУ МАТЕРИАЛОВ И РАБОТ'],
      [''],
      ['Дата формирования отчета:', new Date().toLocaleDateString('ru-RU') + ' ' + new Date().toLocaleTimeString('ru-RU')],
      ['Загруженные файлы:', filesListText],
      ['Всего файлов:', loadedFiles.length],
      [''],
      ['СТАТИСТИКА', ''],
      ['Исходных строк в файлах:', stats.totalRows],
      ['Уникальных позиций в сводной:', stats.uniqueLines],
      ['Материалов:', stats.materialsCount],
      ['Работ:', stats.worksCount],
      [''],
      ['ВЫЯВЛЕННЫЕ ПРОБЛЕМЫ (МАТЕРИАЛЫ)', ''],
      ['Без расценки:', materialsStats?.zeroPriceCount || 0],
      ['С разными ценами:', materialsStats?.differentPricesCount || 0],
      ['С разными ед. изм.:', materialsStats?.differentUnitsCount || 0],
      [''],
      ['ВЫЯВЛЕННЫЕ ПРОБЛЕМЫ (РАБОТЫ)', ''],
      ['Без расценки:', worksStats?.zeroPriceCount || 0],
      ['С разными ценами:', worksStats?.differentPricesCount || 0],
      ['С разными ед. изм.:', worksStats?.differentUnitsCount || 0],
      ...(comparisonStats ? [[''], ['Позиций нет в снабжении:', comparisonStats.notFoundCount]] : []),
      [''],
      ['ИТОГИ', ''],
      ['Сумма материалов:', totalMaterialsSum],
      ['Сумма работ:', totalWorksSum],
      ['Общая сумма:', totalSum],
      ...(comparisonStats ? [
        [''],
        ['СРАВНЕНИЕ С ЦЕНАМИ ОТ СНАБЖЕНИЯ', ''],
        ['Объект сравнения:', objects.find(o => o.id === selectedObjectId)?.name || 'Не выбран'],
        ['Сумма по файлу (найденные):', comparisonStats.totalCurrentSum],
        ['Сумма от снабжения:', comparisonStats.totalApprovedSum],
        ['Удешевление:', comparisonStats.totalDifference]
      ] : [])
    ]

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
    wsSummary['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }
    ]

    setColWidths(wsSummary, [35, 25])
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводка')

    // Формируем имя файла с датой
    const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-')
    XLSX.writeFile(wb, `БСМ_отчет_${dateStr}.xlsx`)
  }

  // Округление до сотых (2 знака после запятой)
  const roundToHundredths = (num) => {
    if (num === null || num === undefined || num === '') return 0
    const parsed = parseFloat(num)
    if (isNaN(parsed)) return 0
    return Math.round(parsed * 100) / 100
  }

  const formatNumber = (num) => {
    if (num === null || num === undefined || num === '') return '-'
    const parsed = parseFloat(num)
    if (isNaN(parsed)) return '-'
    return roundToHundredths(parsed).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  return (
    <div className="bsm-page">
      <h1>Анализ КП</h1>
      <p className="page-description">
        Загрузите Excel-файл для создания сводной таблицы по материалам
      </p>

      <div className="upload-section">
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileUpload}
          ref={fileInputRef}
          id="file-upload"
          className="file-input"
          multiple
        />
        <label htmlFor="file-upload" className="file-label">
          {loadedFiles.length > 0 ? 'Добавить файлы' : 'Выбрать файлы'}
        </label>
        {pivotData.length > 0 && (
          <>
            <button onClick={handleExport} className="export-btn">
              Экспорт в Excel
            </button>
            <button onClick={handleClear} className="clear-btn">
              Очистить всё
            </button>
          </>
        )}
      </div>

      {/* Список загруженных файлов */}
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
                <button
                  className="remove-file-btn"
                  onClick={() => handleRemoveFile(file.name)}
                  title="Удалить файл"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="expected-format">
        <strong>Ожидаемый формат столбцов:</strong>
        <ol>
          <li><strong>КОД</strong> — тип позиции: <code>Р</code> (работа) или <code>мат.</code> (материал)</li>
          <li>Наименование</li>
          <li>Ед. изм.</li>
          <li>Объем</li>
          <li>Цена материалов (с НДС)</li>
          <li>Цена работ (с НДС)</li>
        </ol>
        <p className="format-note">
          Расчёт: для работ (тип Р) — объём × цена работ; для материалов — объём × цена материалов + объём × цена работ (если указана)
        </p>
      </div>

      {isLoading && (
        <div className="loading">Загрузка и анализ данных...</div>
      )}

      {stats && (
        <div className="summary">
          <div className="summary-cards">
            <div className="summary-card">
              <span className="card-value">{stats.totalRows}</span>
              <span className="card-label">Исходных строк</span>
            </div>
            <div className="summary-card materials">
              <span className="card-value">{stats.materialsCount}</span>
              <span className="card-label">Материалы</span>
            </div>
            <div className="summary-card works">
              <span className="card-value">{stats.worksCount}</span>
              <span className="card-label">Работы</span>
            </div>
          </div>
        </div>
      )}

      {pivotData.length > 0 && (
        <div className="pivot-section">
          {/* Главные вкладки: Материалы / Работы */}
          <div className="main-tabs">
            <button
              className={`main-tab ${mainTab === 'materials' ? 'active' : ''} tab-materials`}
              onClick={() => { setMainTab('materials'); setActiveTab('all'); setExpandedItems({}); }}
              title="Стоимость материалов (код 'мат.')"
            >
              Материалы
              <span className="tab-count">{stats.materialsCount}</span>
            </button>
            <button
              className={`main-tab ${mainTab === 'works' ? 'active' : ''} tab-works`}
              onClick={() => { setMainTab('works'); setActiveTab('all'); setExpandedItems({}); }}
              title="Все работы: монтаж материалов + работы (код 'Р')"
            >
              Работы
              <span className="tab-count">{stats.worksCount}</span>
            </button>
          </div>

          {/* Подвкладки анализа */}
          <div className="tabs sub-tabs">
            <button
              className={`tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              Все {mainTab === 'materials' ? 'материалы' : 'работы'}
              <span className="tab-count">{currentStats?.totalItems || 0}</span>
            </button>
            <button
              className={`tab ${activeTab === 'zero' ? 'active' : ''} ${currentStats?.zeroPriceCount > 0 ? 'warning' : ''}`}
              onClick={() => setActiveTab('zero')}
            >
              Без расценки
              <span className="tab-count">{currentStats?.zeroPriceCount || 0}</span>
            </button>
            <button
              className={`tab ${activeTab === 'different' ? 'active' : ''} ${currentStats?.differentPricesCount > 0 ? 'alert' : ''}`}
              onClick={() => setActiveTab('different')}
            >
              Разные цены
              <span className="tab-count">{currentStats?.differentPricesCount || 0}</span>
            </button>
            <button
              className={`tab ${activeTab === 'units' ? 'active' : ''} ${currentStats?.differentUnitsCount > 0 ? 'error' : ''}`}
              onClick={() => setActiveTab('units')}
            >
              Разные ед. изм.
              <span className="tab-count">{currentStats?.differentUnitsCount || 0}</span>
            </button>
            {/* Сравнение с расценками только для материалов */}
            {mainTab === 'materials' && (
              <>
                <button
                  className={`tab ${activeTab === 'compare' ? 'active' : ''} ${comparisonStats && comparisonStats.totalDifference !== 0 ? 'compare' : ''}`}
                  onClick={() => setActiveTab('compare')}
                >
                  Сравнение с ценами от снабжения
                  {comparisonStats && (
                    <span className={`tab-count ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>
                      {formatNumber(comparisonStats.totalDifference)}
                    </span>
                  )}
                </button>
                <button
                  className={`tab ${activeTab === 'not_in_supply' ? 'active' : ''} ${comparisonStats && comparisonStats.notFoundCount > 0 ? 'warning' : ''}`}
                  onClick={() => setActiveTab('not_in_supply')}
                >
                  Нет в снабжении
                  {comparisonStats && (
                    <span className="tab-count">{comparisonStats.notFoundCount}</span>
                  )}
                </button>
                <button
                  className={`tab ${activeTab === 'global_registry' ? 'active' : ''} ${globalComparisonStats && globalComparisonStats.potentialSavings > 0 ? 'compare' : ''}`}
                  onClick={() => setActiveTab('global_registry')}
                >
                  Общий реестр
                  {globalComparisonStats && (
                    <span className={`tab-count ${globalComparisonStats.potentialSavings > 0 ? 'positive' : ''}`}>
                      {globalRegistry.length}
                    </span>
                  )}
                </button>
              </>
            )}
          </div>

          {activeTab === 'not_in_supply' ? (
            // Вкладка "Нет в снабжении" - позиции не найденные в расценках от снабжения
            <div className="compare-section">
              <div className="compare-header">
                <label>Позиции отсутствующие в расценках объекта:</label>
                <select
                  value={selectedObjectId}
                  onChange={(e) => setSelectedObjectId(e.target.value)}
                >
                  <option value="">-- Выберите объект --</option>
                  {objects.map(obj => (
                    <option key={obj.id} value={obj.id}>{obj.name}</option>
                  ))}
                </select>
                {selectedObjectId && approvedRates.length === 0 && (
                  <span className="no-rates-warning">Нет расценок от снабжения для этого объекта</span>
                )}
              </div>

              {comparisonStats && comparisonStats.notFoundCount > 0 && (
                <>
                  <div className="comparison-summary">
                    <div className="summary-card warning">
                      <span className="card-value">{comparisonStats.notFoundCount}</span>
                      <span className="card-label">Позиций не найдено</span>
                    </div>
                    <div className="summary-card">
                      <span className="card-value">
                        {formatNumber(comparisonData.filter(item => item.status === 'not_found').reduce((sum, item) => sum + item.currentSum, 0))}
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
                            <td className="col-price">{item.price ? formatNumber(item.price) : '—'}</td>
                            <td className="col-total">{formatNumber(item.currentSum)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="total-row">
                          <td colSpan="5" className="total-label">ИТОГО:</td>
                          <td className="col-total">
                            {formatNumber(comparisonData.filter(item => item.status === 'not_found').reduce((sum, item) => sum + item.currentSum, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}

              {comparisonStats && comparisonStats.notFoundCount === 0 && (
                <div className="empty-tab success">Все позиции найдены в расценках от снабжения</div>
              )}

              {!selectedObjectId && (
                <div className="empty-tab">Выберите объект для проверки наличия расценок</div>
              )}
            </div>
          ) : activeTab === 'compare' ? (
            // Вкладка "Сравнение с ценами от снабжения"
            <div className="compare-section">
              <div className="compare-header">
                <label>Сравнить с расценками объекта:</label>
                <select
                  value={selectedObjectId}
                  onChange={(e) => setSelectedObjectId(e.target.value)}
                >
                  <option value="">-- Выберите объект --</option>
                  {objects.map(obj => (
                    <option key={obj.id} value={obj.id}>{obj.name}</option>
                  ))}
                </select>
                {selectedObjectId && approvedRates.length === 0 && (
                  <span className="no-rates-warning">Нет расценок от снабжения для этого объекта</span>
                )}
              </div>

              {comparisonStats && (
                <>
                  <div className="comparison-summary">
                    <div className="summary-card">
                      <span className="card-value">{comparisonStats.totalItems}</span>
                      <span className="card-label">Всего в файле</span>
                    </div>
                    <div className="summary-card success">
                      <span className="card-value">{comparisonStats.foundCount || 0}</span>
                      <span className="card-label">Найдено в снабжении</span>
                    </div>
                    <div className="summary-card warning">
                      <span className="card-value">{comparisonStats.notFoundCount}</span>
                      <span className="card-label">Не найдено</span>
                    </div>
                    <div className="summary-card">
                      <span className="card-value">{formatNumber(comparisonStats.totalApprovedSum)}</span>
                      <span className="card-label">Сумма от снабжения</span>
                    </div>
                    {comparisonStats.totalCurrentSum > 0 && (
                      <div className={`summary-card ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>
                        <span className="card-value">
                          {formatNumber(comparisonStats.totalDifference)}
                        </span>
                        <span className="card-label">Разница</span>
                      </div>
                    )}
                  </div>

                  {(comparisonStats.foundCount || 0) > 0 && (
                    <div className="table-container">
                      <table className="pivot-table comparison-table">
                        <thead>
                          <tr>
                            <th>№</th>
                            <th>Наименование</th>
                            <th>Ед. изм.</th>
                            <th>Объем</th>
                            <th>Цена (файл)</th>
                            <th>Цена (снабжение)</th>
                            <th>Сумма (файл)</th>
                            <th>Сумма (снабжение)</th>
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
                              <td className="col-price">{item.price > 0 ? formatNumber(item.price) : '—'}</td>
                              <td className="col-price" style={{ fontWeight: '600', color: 'var(--success-color)' }}>
                                {formatNumber(item.approvedPrice)}
                              </td>
                              <td className="col-total">{item.price > 0 ? formatNumber(item.currentSum) : '—'}</td>
                              <td className="col-total" style={{ fontWeight: '600' }}>{formatNumber(item.approvedSum)}</td>
                              <td className={`col-diff ${item.difference < 0 ? 'positive' : item.difference > 0 ? 'negative' : ''}`}>
                                {item.price > 0 ? formatNumber(item.difference) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="total-row">
                            <td colSpan="5" className="total-label">ИТОГО:</td>
                            <td></td>
                            <td className="col-total">{comparisonStats.totalCurrentSum > 0 ? formatNumber(comparisonStats.totalCurrentSum) : '—'}</td>
                            <td className="col-total" style={{ fontWeight: '600' }}>{formatNumber(comparisonStats.totalApprovedSum)}</td>
                            <td className={`col-diff ${comparisonStats.totalDifference < 0 ? 'positive' : comparisonStats.totalDifference > 0 ? 'negative' : ''}`}>
                              {comparisonStats.totalCurrentSum > 0 ? formatNumber(comparisonStats.totalDifference) : '—'}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </>
              )}

              {comparisonStats && (comparisonStats.foundCount || 0) === 0 && (
                <div className="empty-tab warning">
                  Ни одна позиция из файла не найдена в расценках от снабжения.
                  <br />
                  <small>Проверьте, что названия материалов совпадают с расценками объекта.</small>
                </div>
              )}

              {!selectedObjectId && (
                <div className="empty-tab">Выберите объект для сравнения с расценками от снабжения</div>
              )}

              {selectedObjectId && !comparisonStats && materialsData.length === 0 && (
                <div className="empty-tab">Загрузите файл для сравнения</div>
              )}
            </div>
          ) : activeTab === 'global_registry' ? (
            // Вкладка "Общий реестр" - сравнение со всеми расценками из всех объектов
            <div className="compare-section">
              <div className="compare-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%', flexWrap: 'wrap' }}>
                  <label style={{ fontWeight: '600' }}>Фильтр по объектам:</label>
                  <button
                    className={`filter-btn ${selectedObjectIds.length === 0 ? 'active' : ''}`}
                    onClick={() => setSelectedObjectIds([])}
                    style={{
                      padding: '0.5rem 1rem',
                      borderRadius: '6px',
                      border: selectedObjectIds.length === 0 ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
                      background: selectedObjectIds.length === 0 ? 'var(--primary-light)' : 'var(--bg-secondary)',
                      cursor: 'pointer',
                      fontWeight: selectedObjectIds.length === 0 ? '600' : '400'
                    }}
                  >
                    Все объекты ({globalRegistry.length})
                  </button>
                  <span style={{ color: 'var(--text-secondary)' }}>или выберите:</span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', maxHeight: '120px', overflowY: 'auto', width: '100%' }}>
                  {objects.map(obj => {
                    const isSelected = selectedObjectIds.includes(obj.id)
                    const objectRatesCount = globalRegistry.filter(r => r.object_id === obj.id).length
                    return (
                      <label
                        key={obj.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.4rem 0.75rem',
                          borderRadius: '6px',
                          border: isSelected ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
                          background: isSelected ? 'var(--primary-light)' : 'var(--bg-secondary)',
                          cursor: 'pointer',
                          fontSize: '0.875rem',
                          transition: 'all 0.2s'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedObjectIds([...selectedObjectIds, obj.id])
                            } else {
                              setSelectedObjectIds(selectedObjectIds.filter(id => id !== obj.id))
                            }
                          }}
                        />
                        {obj.name}
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>({objectRatesCount})</span>
                      </label>
                    )
                  })}
                </div>
              </div>

              {globalRegistry.length === 0 ? (
                <div className="empty-tab">Общий реестр пуст. Добавьте расценки в разделе "Расценки от снабжения"</div>
              ) : materialsData.length === 0 ? (
                <div className="empty-tab">Загрузите Excel файл с материалами для сравнения</div>
              ) : globalComparisonStats && (
                <>
                  <div className="comparison-summary" style={{ marginBottom: '1rem' }}>
                    <div className="summary-card">
                      <span className="card-value">{globalComparisonStats.registryItemsCount}</span>
                      <span className="card-label">Позиций в реестре</span>
                    </div>
                    <div className="summary-card">
                      <span className="card-value">{formatNumber(globalComparisonStats.totalCurrentSum)}</span>
                      <span className="card-label">Сумма по файлу</span>
                    </div>
                    <div className="summary-card">
                      <span className="card-value">{formatNumber(globalComparisonStats.totalMinSum)}</span>
                      <span className="card-label">Мин. сумма (реестр)</span>
                    </div>
                    <div className={`summary-card ${globalComparisonStats.potentialSavings > 0 ? 'positive' : ''}`}>
                      <span className="card-value">{formatNumber(globalComparisonStats.potentialSavings)}</span>
                      <span className="card-label">Возможная экономия</span>
                    </div>
                    <div className="summary-card success">
                      <span className="card-value">{globalComparisonStats.cheaperCount}</span>
                      <span className="card-label">Дешевле мин.</span>
                    </div>
                    <div className="summary-card warning">
                      <span className="card-value">{globalComparisonStats.expensiveCount}</span>
                      <span className="card-label">Дороже макс.</span>
                    </div>
                    <div className="summary-card error">
                      <span className="card-value">{globalComparisonStats.notFoundCount}</span>
                      <span className="card-label">Нет в реестре</span>
                    </div>
                  </div>

                  <div className="table-container">
                    <table className="pivot-table comparison-table">
                      <thead>
                        <tr>
                          <th>№</th>
                          <th>Наименование</th>
                          <th>Ед.</th>
                          <th>Объем</th>
                          <th>Цена (файл)</th>
                          <th>Мин.</th>
                          <th>Макс.</th>
                          <th>Сред.</th>
                          <th>Сумма (файл)</th>
                          <th>Экономия</th>
                          <th>Объекты</th>
                        </tr>
                      </thead>
                      <tbody>
                        {globalComparisonData.map((item, idx) => (
                          <tr
                            key={idx}
                            className={`comparison-row status-${item.status}`}
                            style={{
                              background: item.status === 'not_found' ? 'var(--danger-light)' :
                                         item.status === 'expensive' ? 'var(--warning-light)' :
                                         item.status === 'cheapest' ? 'var(--success-light)' : ''
                            }}
                          >
                            <td>{idx + 1}</td>
                            <td className="col-name">{item.name}</td>
                            <td>{item.unit}</td>
                            <td className="col-volume">{formatNumber(item.totalVolume)}</td>
                            <td className="col-price">{formatNumber(item.price)}</td>
                            <td className="col-price" style={{ color: 'var(--success-color)' }}>
                              {item.minPrice ? formatNumber(item.minPrice) : '—'}
                            </td>
                            <td className="col-price" style={{ color: 'var(--danger-color)' }}>
                              {item.maxPrice ? formatNumber(item.maxPrice) : '—'}
                            </td>
                            <td className="col-price">
                              {item.avgPrice ? formatNumber(item.avgPrice) : '—'}
                            </td>
                            <td className="col-total">{formatNumber(item.currentSum)}</td>
                            <td className={`col-diff ${item.savings > 0 ? 'positive' : ''}`}>
                              {item.savings ? formatNumber(item.savings) : '—'}
                            </td>
                            <td style={{ fontSize: '0.75rem', maxWidth: '250px' }}>
                              {item.objectPrices ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                  {item.objectPrices.slice(0, 3).map((op, opIdx) => (
                                    <span key={opIdx} style={{
                                      padding: '2px 6px',
                                      borderRadius: '4px',
                                      background: item.price <= op.price + 0.01 ? 'var(--success-light)' : 'var(--warning-light)',
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis'
                                    }}>
                                      {op.objectName}: {formatNumber(op.price)}
                                      {op.appliedAt && (
                                        <span style={{ color: 'var(--text-tertiary)', marginLeft: '4px' }}>
                                          ({new Date(op.appliedAt).toLocaleDateString('ru-RU')})
                                        </span>
                                      )}
                                    </span>
                                  ))}
                                  {item.objectPrices.length > 3 && (
                                    <span style={{ color: 'var(--text-tertiary)' }}>
                                      +{item.objectPrices.length - 3} ещё
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="total-row">
                          <td colSpan="8" className="total-label">ИТОГО:</td>
                          <td className="col-total">{formatNumber(globalComparisonStats.totalCurrentSum)}</td>
                          <td className={`col-diff ${globalComparisonStats.potentialSavings > 0 ? 'positive' : ''}`}>
                            {formatNumber(globalComparisonStats.potentialSavings)}
                          </td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}
            </div>
          ) : activeTab === 'units' ? (
            // Вкладка "Разные ед. изм." - ошибки
            currentDifferentUnitsData.length === 0 ? (
              <div className="empty-tab success">Все единицы измерения корректны</div>
            ) : (
              <div className="accordion-list">
                {currentDifferentUnitsData.map((item, idx) => (
                  <div key={idx} className={`accordion-item error-item ${expandedItems[`unit-${idx}`] ? 'expanded' : ''}`}>
                    <div
                      className="accordion-header error-header"
                      onClick={() => toggleExpanded(`unit-${idx}`)}
                    >
                      <span className="accordion-toggle">
                        {expandedItems[`unit-${idx}`] ? '▼' : '▶'}
                      </span>
                      <span className="accordion-num">{idx + 1}</span>
                      <span className="accordion-name">{item.name}</span>
                      <span className="accordion-variants-count error-badge">
                        {item.variants.length} ед. изм.
                      </span>
                    </div>
                    {expandedItems[`unit-${idx}`] && (
                      <div className="accordion-body">
                        <table className="variants-table">
                          <thead>
                            <tr>
                              <th>Единица измерения</th>
                              <th>Объем</th>
                              <th>Кол-во позиций</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.variants.map((variant, vIdx) => (
                              <tr key={vIdx}>
                                <td><strong>{variant.unit || '(пусто)'}</strong></td>
                                <td>{formatNumber(variant.volume)}</td>
                                <td>{variant.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : activeTab === 'different' ? (
            // Вкладка "Разные цены" - выпадающий список
            currentGroupedDifferentPrices.length === 0 ? (
              <div className="empty-tab">Нет {mainTab === 'materials' ? 'материалов' : 'работ'} с разными ценами</div>
            ) : (
              <div className="accordion-list">
                {currentGroupedDifferentPrices.map((item, idx) => {
                  // Проверяем наличие расценки от снабжения (только для материалов)
                  const supplyRate = mainTab === 'materials' ? approvedRates.find(rate =>
                    String(rate.material_name || '').trim().toLowerCase() === String(item.name || '').trim().toLowerCase()
                  ) : null
                  const hasSupplyRate = !!supplyRate

                  // Расчёт потенциальной экономии
                  // Минимальная цена (исключая нулевые)
                  const nonZeroPrices = item.variants.filter(v => v.price > 0).map(v => v.price)
                  const minPrice = nonZeroPrices.length > 0 ? Math.min(...nonZeroPrices) : 0
                  // Текущая фактическая сумма (сумма всех: цена × объём)
                  const currentTotalSum = round2(item.variants.reduce((sum, v) => sum + round2(v.price * v.volume), 0))
                  // Сумма при минимальной цене
                  const minPriceSum = round2(item.totalVolume * minPrice)
                  // Потенциальная экономия
                  const potentialSavings = round2(currentTotalSum - minPriceSum)

                  return (
                  <div key={idx} className={`accordion-item ${expandedItems[idx] ? 'expanded' : ''}`}>
                    <div
                      className="accordion-header"
                      onClick={() => toggleExpanded(idx)}
                    >
                      <span className="accordion-toggle">
                        {expandedItems[idx] ? '▼' : '▶'}
                      </span>
                      <span className="accordion-num">{idx + 1}</span>
                      <span className="accordion-name">{item.name}</span>
                      <span className="accordion-unit">{item.unit}</span>
                      {mainTab === 'materials' && selectedObjectId && (
                        <span className={`supply-rate-badge ${hasSupplyRate ? 'has-rate' : 'no-rate'}`} title={hasSupplyRate ? `Цена от снабжения: ${formatNumber(supplyRate.supply_price)}` : 'Нет в снабжении'}>
                          {hasSupplyRate ? `₽ ${formatNumber(supplyRate.supply_price)}` : 'Нет в снабж.'}
                        </span>
                      )}
                      <span className="accordion-total">
                        Общий объем: <strong>{formatNumber(item.totalVolume)}</strong>
                      </span>
                      <span className="accordion-variants-count">
                        {item.variants.length} расценки
                      </span>
                    </div>
                    {expandedItems[idx] && (
                      <div className="accordion-body">
                        <table className="variants-table">
                          <thead>
                            <tr>
                              <th>Цена за ед. с НДС</th>
                              <th>Объем</th>
                              <th>Сумма</th>
                              <th>Кол-во позиций</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.variants.map((variant, vIdx) => (
                              <tr key={vIdx} className={`${variant.price === 0 ? 'zero-price-row' : ''} ${variant.price === minPrice && minPrice > 0 ? 'min-price-row' : ''}`}>
                                <td>
                                  {variant.price ? formatNumber(variant.price) : <span className="no-price">Не указана</span>}
                                  {variant.price === minPrice && minPrice > 0 && <span className="min-price-badge">мин</span>}
                                </td>
                                <td>{formatNumber(variant.volume)}</td>
                                <td>{formatNumber(round2(variant.price * variant.volume))}</td>
                                <td>{variant.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {/* Блок расчёта экономии */}
                        {minPrice > 0 && potentialSavings > 0 && (
                          <div className="savings-calculation">
                            <div className="savings-row">
                              <span className="savings-label">Текущая сумма (факт):</span>
                              <span className="savings-value">{formatNumber(currentTotalSum)}</span>
                            </div>
                            <div className="savings-row">
                              <span className="savings-label">Сумма при мин. цене ({formatNumber(minPrice)} × {formatNumber(item.totalVolume)}):</span>
                              <span className="savings-value">{formatNumber(minPriceSum)}</span>
                            </div>
                            <div className="savings-row savings-total">
                              <span className="savings-label">Потенциальная экономия:</span>
                              <span className="savings-value positive">{formatNumber(potentialSavings)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )
          ) : (
            // Остальные вкладки - таблица
            filteredData.length === 0 ? (
              <div className="empty-tab">
                {activeTab === 'zero' && `Все ${mainTab === 'materials' ? 'материалы' : 'работы'} имеют расценки`}
                {activeTab === 'all' && `Нет ${mainTab === 'materials' ? 'материалов' : 'работ'}`}
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
                    {filteredData.map((item, idx) => {
                      // Для материалов - цена и сумма материалов, для работ - цена и сумма работ
                      const price = mainTab === 'materials' ? item.priceMaterials : item.priceWorks
                      const itemSum = round2(item.totalVolume * (price || 0))
                      return (
                        <tr
                          key={idx}
                          className={`
                            ${item.isZeroPrice ? 'zero-price-row' : ''}
                            ${item.hasDifferentPrices ? 'different-price-row' : ''}
                          `}
                        >
                          <td className="col-num">{idx + 1}</td>
                          <td className="col-name">{item.name}</td>
                          <td className="col-unit">{item.unit}</td>
                          <td className="col-volume">{formatNumber(item.totalVolume)}</td>
                          <td className="col-price">
                            {price ? formatNumber(price) : <span className="no-price">—</span>}
                          </td>
                          <td className="col-total">
                            {itemSum ? formatNumber(itemSum) : <span className="no-price">—</span>}
                          </td>
                          <td className="col-count">{item.count}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <td colSpan="5" className="total-label">ИТОГО:</td>
                      <td className="col-total total-value">
                        {formatNumber(
                          filteredData.reduce((sum, item) => {
                            const price = mainTab === 'materials' ? item.priceMaterials : item.priceWorks
                            return sum + round2(item.totalVolume * (price || 0))
                          }, 0)
                        )}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

export default BSMPage
