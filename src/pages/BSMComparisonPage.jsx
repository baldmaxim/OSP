import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import './BSMComparisonPage.css'

function BSMComparisonPage() {
  const [objects, setObjects] = useState([])
  const [selectedObjectId, setSelectedObjectId] = useState('')
  const [contractRates, setContractRates] = useState([])
  const [supplyRates, setSupplyRates] = useState([])
  const [comparisonData, setComparisonData] = useState([])
  const [stats, setStats] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all') // all, match, different, not_in_supply, not_in_contract

  // Загрузка объектов
  useEffect(() => {
    fetchObjects()
  }, [])

  const fetchObjects = async () => {
    const { data, error } = await supabase
      .from('objects')
      .select('id, name')
      .order('name')

    if (!error && data) {
      setObjects(data)
    }
  }

  const fetchAllRates = useCallback(async () => {
    setIsLoading(true)

    // Загружаем обе таблицы параллельно
    const [contractResult, supplyResult] = await Promise.all([
      supabase
        .from('bsm_contract_rates')
        .select('*')
        .eq('object_id', selectedObjectId)
        .order('material_name'),
      supabase
        .from('bsm_supply_rates')
        .select('*')
        .eq('object_id', selectedObjectId)
        .order('material_name')
    ])

    if (!contractResult.error) {
      setContractRates(contractResult.data || [])
    }
    if (!supplyResult.error) {
      setSupplyRates(supplyResult.data || [])
    }

    setIsLoading(false)
  }, [selectedObjectId])

  const calculateComparison = useCallback(() => {
    // Создаём карты расценок по названию материала (в нижнем регистре)
    const contractMap = {}
    contractRates.forEach(rate => {
      const key = rate.material_name.trim().toLowerCase()
      contractMap[key] = rate
    })

    const supplyMap = {}
    supplyRates.forEach(rate => {
      const key = rate.material_name.trim().toLowerCase()
      supplyMap[key] = rate
    })

    // Собираем все уникальные названия материалов
    const allMaterialNames = new Set([
      ...Object.keys(contractMap),
      ...Object.keys(supplyMap)
    ])

    const comparison = []
    let matchCount = 0
    let differentCount = 0
    let notInSupplyCount = 0
    let notInContractCount = 0
    let totalDifference = 0

    allMaterialNames.forEach(key => {
      const contractRate = contractMap[key]
      const supplyRate = supplyMap[key]

      let status = 'match'
      let difference = 0
      let percentDiff = 0

      if (contractRate && supplyRate) {
        const contractPrice = parseFloat(contractRate.contract_price) || 0
        const supplyPrice = parseFloat(supplyRate.supply_price) || 0
        difference = contractPrice - supplyPrice

        if (Math.abs(difference) < 0.01) {
          status = 'match'
          matchCount++
        } else {
          status = 'different'
          differentCount++
          percentDiff = supplyPrice > 0 ? ((difference / supplyPrice) * 100) : 0
        }
        totalDifference += difference
      } else if (contractRate && !supplyRate) {
        status = 'not_in_supply'
        notInSupplyCount++
      } else if (!contractRate && supplyRate) {
        status = 'not_in_contract'
        notInContractCount++
      }

      comparison.push({
        materialName: contractRate?.material_name || supplyRate?.material_name,
        unit: contractRate?.unit || supplyRate?.unit,
        contractPrice: contractRate?.contract_price,
        supplyPrice: supplyRate?.supply_price,
        difference,
        percentDiff,
        status,
        contractId: contractRate?.id,
        supplyId: supplyRate?.id
      })
    })

    // Сортируем: сначала с разницей, потом остальные
    comparison.sort((a, b) => {
      const statusOrder = { different: 0, not_in_supply: 1, not_in_contract: 2, match: 3 }
      if (statusOrder[a.status] !== statusOrder[b.status]) {
        return statusOrder[a.status] - statusOrder[b.status]
      }
      return a.materialName.localeCompare(b.materialName, 'ru')
    })

    setComparisonData(comparison)
    setStats({
      total: comparison.length,
      matchCount,
      differentCount,
      notInSupplyCount,
      notInContractCount,
      totalDifference,
      contractTotal: contractRates.length,
      supplyTotal: supplyRates.length
    })
  }, [contractRates, supplyRates])

  // Загрузка расценок при выборе объекта
  useEffect(() => {
    if (selectedObjectId) {
      fetchAllRates()
    } else {
      setContractRates([])
      setSupplyRates([])
      setComparisonData([])
      setStats(null)
    }
  }, [selectedObjectId, fetchAllRates])

  // Пересчёт сравнения при изменении данных
  useEffect(() => {
    if (contractRates.length > 0 || supplyRates.length > 0) {
      calculateComparison()
    }
  }, [contractRates, supplyRates, calculateComparison])

  const handleExportExcel = () => {
    if (comparisonData.length === 0) return

    const selectedObject = objects.find(o => o.id === selectedObjectId)

    const exportData = filteredData.map((item, idx) => ({
      '№': idx + 1,
      'Наименование материала': item.materialName,
      'Ед. изм.': item.unit || '',
      'Согласованная цена': item.contractPrice || '',
      'Цена от снабжения': item.supplyPrice || '',
      'Разница': item.status === 'different' ? item.difference : '',
      'Разница %': item.status === 'different' ? `${item.percentDiff.toFixed(1)}%` : '',
      'Статус': getStatusText(item.status)
    }))

    const ws = XLSX.utils.json_to_sheet(exportData)
    ws['!cols'] = [
      { wch: 5 }, { wch: 50 }, { wch: 10 },
      { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 12 }, { wch: 20 }
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Сравнение расценок')
    XLSX.writeFile(wb, `Сравнение_расценок_${selectedObject?.name || 'объект'}.xlsx`)
  }

  const getStatusText = (status) => {
    switch (status) {
      case 'match': return 'Совпадают'
      case 'different': return 'Разные цены'
      case 'not_in_supply': return 'Нет в снабжении'
      case 'not_in_contract': return 'Нет в договоре'
      default: return ''
    }
  }

  const getStatusClass = (status) => {
    switch (status) {
      case 'match': return 'status-match'
      case 'different': return 'status-different'
      case 'not_in_supply': return 'status-not-in-supply'
      case 'not_in_contract': return 'status-not-in-contract'
      default: return ''
    }
  }

  const formatNumber = (num) => {
    if (num === null || num === undefined || num === '') return '—'
    const parsed = parseFloat(num)
    if (isNaN(parsed)) return '—'
    return parsed.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  // Фильтрация данных
  const filteredData = comparisonData.filter(item => {
    const matchesSearch = item.materialName.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesFilter = filterStatus === 'all' || item.status === filterStatus
    return matchesSearch && matchesFilter
  })

  return (
    <div className="bsm-comparison-page">
      <h1>Сравнение расценок</h1>
      <p className="page-description">
        Сравнение согласованных расценок с актуальными ценами от снабжения
      </p>

      <div className="object-selector">
        <label>Выберите объект:</label>
        <select
          value={selectedObjectId}
          onChange={(e) => setSelectedObjectId(e.target.value)}
        >
          <option value="">-- Выберите объект --</option>
          {objects.map(obj => (
            <option key={obj.id} value={obj.id}>{obj.name}</option>
          ))}
        </select>
      </div>

      {selectedObjectId && (
        <>
          {isLoading ? (
            <div className="loading">Загрузка данных...</div>
          ) : stats ? (
            <>
              {/* Статистика */}
              <div className="comparison-stats">
                <div className="stat-card">
                  <span className="stat-value">{stats.contractTotal}</span>
                  <span className="stat-label">В договоре</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats.supplyTotal}</span>
                  <span className="stat-label">От снабжения</span>
                </div>
                <div className="stat-card success">
                  <span className="stat-value">{stats.matchCount}</span>
                  <span className="stat-label">Совпадают</span>
                </div>
                <div className="stat-card warning">
                  <span className="stat-value">{stats.differentCount}</span>
                  <span className="stat-label">Разные цены</span>
                </div>
                <div className="stat-card info">
                  <span className="stat-value">{stats.notInSupplyCount}</span>
                  <span className="stat-label">Нет в снабжении</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats.notInContractCount}</span>
                  <span className="stat-label">Нет в договоре</span>
                </div>
              </div>

              {stats.differentCount > 0 && (
                <div className={`total-difference ${stats.totalDifference > 0 ? 'positive' : 'negative'}`}>
                  <span>Общая разница по расценкам с разными ценами:</span>
                  <strong>
                    {stats.totalDifference > 0 ? '+' : ''}{formatNumber(stats.totalDifference)} ₽
                  </strong>
                  <span className="hint">
                    {stats.totalDifference > 0
                      ? '(договор дороже снабжения)'
                      : '(снабжение дороже договора)'}
                  </span>
                </div>
              )}

              {/* Панель инструментов */}
              <div className="comparison-toolbar">
                <div className="toolbar-left">
                  <input
                    type="text"
                    placeholder="Поиск материала..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="search-input"
                  />
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="filter-select"
                  >
                    <option value="all">Все ({stats.total})</option>
                    <option value="different">Разные цены ({stats.differentCount})</option>
                    <option value="match">Совпадают ({stats.matchCount})</option>
                    <option value="not_in_supply">Нет в снабжении ({stats.notInSupplyCount})</option>
                    <option value="not_in_contract">Нет в договоре ({stats.notInContractCount})</option>
                  </select>
                  <span className="count-label">
                    Показано: {filteredData.length}
                  </span>
                </div>
                <div className="toolbar-right">
                  <button
                    onClick={handleExportExcel}
                    className="btn-export"
                    disabled={comparisonData.length === 0}
                  >
                    Экспорт в Excel
                  </button>
                </div>
              </div>

              {/* Таблица сравнения */}
              {filteredData.length === 0 ? (
                <div className="empty-state">
                  {comparisonData.length === 0
                    ? 'Нет данных для сравнения. Добавьте расценки в обе таблицы.'
                    : 'Ничего не найдено по заданным фильтрам'}
                </div>
              ) : (
                <div className="table-container">
                  <table className="comparison-table">
                    <thead>
                      <tr>
                        <th className="col-num">№</th>
                        <th className="col-name">Наименование материала</th>
                        <th className="col-unit">Ед. изм.</th>
                        <th className="col-price">Согласованная цена</th>
                        <th className="col-price">Цена от снабжения</th>
                        <th className="col-diff">Разница</th>
                        <th className="col-percent">%</th>
                        <th className="col-status">Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredData.map((item, idx) => (
                        <tr key={idx} className={getStatusClass(item.status)}>
                          <td className="col-num">{idx + 1}</td>
                          <td className="col-name">{item.materialName}</td>
                          <td className="col-unit">{item.unit || ''}</td>
                          <td className="col-price">
                            {item.contractPrice ? formatNumber(item.contractPrice) : <span className="no-data">—</span>}
                          </td>
                          <td className="col-price">
                            {item.supplyPrice ? formatNumber(item.supplyPrice) : <span className="no-data">—</span>}
                          </td>
                          <td className={`col-diff ${item.difference > 0 ? 'positive' : item.difference < 0 ? 'negative' : ''}`}>
                            {item.status === 'different' ? (
                              <>{item.difference > 0 ? '+' : ''}{formatNumber(item.difference)}</>
                            ) : '—'}
                          </td>
                          <td className={`col-percent ${item.percentDiff > 0 ? 'positive' : item.percentDiff < 0 ? 'negative' : ''}`}>
                            {item.status === 'different' ? (
                              <>{item.percentDiff > 0 ? '+' : ''}{item.percentDiff.toFixed(1)}%</>
                            ) : '—'}
                          </td>
                          <td className="col-status">
                            <span className={`status-badge ${item.status}`}>
                              {getStatusText(item.status)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              Выберите объект для сравнения расценок
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default BSMComparisonPage
