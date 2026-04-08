import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import './BSMRatesPage.css'

function BSMRatesPage() {
  const [objects, setObjects] = useState([])
  const [selectedObjectId, setSelectedObjectId] = useState('')
  const [rates, setRates] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [editingRate, setEditingRate] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRate, setNewRate] = useState({ material_name: '', unit: '', supply_price: '', applied_at: '' })
  const [searchTerm, setSearchTerm] = useState('')
  const [showImportHelp, setShowImportHelp] = useState(false)
  const [selectedRates, setSelectedRates] = useState(new Set())
  const fileInputRef = useRef(null)

  // Состояние для диалога импорта
  const [showImportReport, setShowImportReport] = useState(false)
  const [importReport, setImportReport] = useState(null)
  const [conflictDecisions, setConflictDecisions] = useState({})
  const [isProcessingImport, setIsProcessingImport] = useState(false)

  // Загрузка объектов
  useEffect(() => {
    fetchObjects()
  }, [])

  // Загрузка расценок при выборе объекта
  useEffect(() => {
    if (selectedObjectId) {
      fetchRates()
    } else {
      setRates([])
    }
  }, [selectedObjectId])

  const fetchObjects = async () => {
    const { data, error } = await supabase
      .from('objects')
      .select('id, name')
      .order('name')

    if (!error && data) {
      setObjects(data)
    }
  }

  const fetchRates = async () => {
    setIsLoading(true)
    const { data, error } = await supabase
      .from('bsm_supply_rates')
      .select('*')
      .eq('object_id', selectedObjectId)
      .order('material_name')

    if (!error && data) {
      setRates(data)
    }
    setIsLoading(false)
  }

  const handleAddRate = async () => {
    if (!newRate.material_name || !newRate.supply_price) {
      alert('Заполните наименование материала и цену')
      return
    }

    const { error } = await supabase
      .from('bsm_supply_rates')
      .insert({
        object_id: selectedObjectId,
        material_name: newRate.material_name.trim(),
        unit: newRate.unit.trim(),
        supply_price: parseFloat(newRate.supply_price),
        applied_at: newRate.applied_at || null
      })

    if (error) {
      if (error.code === '23505') {
        alert('Материал с таким названием уже существует для этого объекта')
      } else {
        alert('Ошибка при добавлении: ' + error.message)
      }
    } else {
      setNewRate({ material_name: '', unit: '', supply_price: '', applied_at: '' })
      setShowAddForm(false)
      fetchRates()
    }
  }

  const handleUpdateRate = async (id, updates) => {
    const { error } = await supabase
      .from('bsm_supply_rates')
      .update(updates)
      .eq('id', id)

    if (error) {
      alert('Ошибка при обновлении: ' + error.message)
    } else {
      setEditingRate(null)
      fetchRates()
    }
  }

  const handleDeleteRate = async (id) => {
    if (!confirm('Удалить эту расценку?')) return

    const { error } = await supabase
      .from('bsm_supply_rates')
      .delete()
      .eq('id', id)

    if (!error) {
      fetchRates()
    }
  }

  // Удаление выбранных расценок
  const handleDeleteSelected = async () => {
    if (selectedRates.size === 0) return
    if (!confirm(`Удалить ${selectedRates.size} выбранных расценок?`)) return

    const idsToDelete = Array.from(selectedRates)
    const { error } = await supabase
      .from('bsm_supply_rates')
      .delete()
      .in('id', idsToDelete)

    if (!error) {
      setSelectedRates(new Set())
      fetchRates()
    } else {
      alert('Ошибка при удалении: ' + error.message)
    }
  }

  // Выбор/снятие выбора одной расценки
  const toggleSelectRate = (id) => {
    setSelectedRates(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  // Выбрать все / снять выбор со всех
  const toggleSelectAll = () => {
    if (selectedRates.size === filteredRates.length) {
      setSelectedRates(new Set())
    } else {
      setSelectedRates(new Set(filteredRates.map(r => r.id)))
    }
  }

  // Парсинг цены из различных форматов
  const parsePrice = (val) => {
    if (val === null || val === undefined || val === '') return 0
    const strVal = String(val)
      .replace(/\s/g, '')  // убираем все пробелы
      .replace(/,/g, '.')   // заменяем запятую на точку
    return parseFloat(strVal) || 0
  }

  // Парсинг даты из Excel (может быть число или строка)
  const parseExcelDate = (val) => {
    if (val === null || val === undefined || val === '') return null

    // Если это число (Excel serial date)
    if (typeof val === 'number') {
      // Excel хранит даты как количество дней с 1 января 1900
      const excelEpoch = new Date(1899, 11, 30) // 30 декабря 1899
      const date = new Date(excelEpoch.getTime() + val * 86400000)
      return date.toISOString().split('T')[0] // формат YYYY-MM-DD
    }

    // Если строка
    const strVal = String(val).trim()

    // Формат ДД.ММ.ГГГГ
    const ddmmyyyy = strVal.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
    if (ddmmyyyy) {
      const [, day, month, year] = ddmmyyyy
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }

    // Формат ГГГГ-ММ-ДД (уже в нужном формате)
    const yyyymmdd = strVal.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (yyyymmdd) {
      return strVal
    }

    // Попробуем распарсить как Date
    const parsed = new Date(strVal)
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0]
    }

    return null
  }

  // Шаг 1: Анализ файла и формирование отчёта
  const handleImportExcel = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const workbook = XLSX.read(event.target.result, { type: 'binary' })
        const sheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[sheetName]
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

        // Находим строку заголовка
        let headerRowIndex = 0
        for (let i = 0; i < Math.min(10, jsonData.length); i++) {
          const row = jsonData[i]
          if (row && row.some(cell =>
            cell && typeof cell === 'string' &&
            (cell.toLowerCase().includes('наименование') ||
             cell.toLowerCase().includes('материал'))
          )) {
            headerRowIndex = i
            break
          }
        }

        // Парсим данные из файла
        const newRates = []
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i]
          if (!row || !row[0]) continue

          const materialName = String(row[0]).trim()
          const unit = row[1] ? String(row[1]).trim() : ''
          const price = parsePrice(row[2]) || 0
          const appliedAt = parseExcelDate(row[3])

          if (materialName && price > 0) {
            newRates.push({
              object_id: selectedObjectId,
              material_name: materialName,
              unit: unit,
              supply_price: price,
              applied_at: appliedAt
            })
          }
        }

        if (newRates.length === 0) {
          alert('Не найдено данных для импорта')
          return
        }

        // Анализируем каждую позицию
        const newItems = []      // Новые позиции
        const sameItems = []     // Позиции с той же ценой
        const conflictItems = [] // Позиции с разной ценой

        for (const rate of newRates) {
          const { data: existing, error } = await supabase
            .from('bsm_supply_rates')
            .select('id, material_name, unit, supply_price')
            .eq('object_id', rate.object_id)
            .ilike('material_name', rate.material_name)
            .maybeSingle()

          if (error) {
            console.error('Ошибка поиска:', error)
            continue
          }

          if (!existing) {
            // Новая позиция
            newItems.push(rate)
          } else {
            const existingPrice = parseFloat(existing.supply_price) || 0
            const newPrice = rate.supply_price

            if (Math.abs(existingPrice - newPrice) < 0.01) {
              // Цена совпадает
              sameItems.push({
                ...rate,
                existingId: existing.id,
                existingPrice
              })
            } else {
              // Цена отличается - конфликт
              conflictItems.push({
                ...rate,
                existingId: existing.id,
                existingPrice,
                newPrice,
                difference: newPrice - existingPrice,
                percentDiff: existingPrice > 0 ? ((newPrice - existingPrice) / existingPrice * 100) : 0
              })
            }
          }
        }

        // Формируем отчёт
        const report = {
          fileName: file.name,
          totalParsed: newRates.length,
          newItems,
          sameItems,
          conflictItems
        }

        // Инициализируем решения для конфликтов (по умолчанию - оставить старую)
        const decisions = {}
        conflictItems.forEach((item, idx) => {
          decisions[idx] = 'keep' // 'keep' = оставить старую, 'update' = обновить на новую
        })

        setImportReport(report)
        setConflictDecisions(decisions)
        setShowImportReport(true)

      } catch (error) {
        console.error('Ошибка при чтении файла:', error)
        alert('Ошибка при чтении файла')
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
    reader.readAsBinaryString(file)
  }

  // Шаг 2: Применение импорта после подтверждения
  const handleConfirmImport = async () => {
    if (!importReport) return

    setIsProcessingImport(true)

    let importedCount = 0
    let updatedCount = 0
    let skippedCount = 0
    let errors = []

    // 1. Добавляем новые позиции
    for (const item of importReport.newItems) {
      const { error } = await supabase
        .from('bsm_supply_rates')
        .insert(item)

      if (error) {
        errors.push(`Добавление "${item.material_name}": ${error.message}`)
      } else {
        importedCount++
      }
    }

    // 2. Обрабатываем конфликты согласно решениям пользователя
    for (let idx = 0; idx < importReport.conflictItems.length; idx++) {
      const item = importReport.conflictItems[idx]
      const decision = conflictDecisions[idx]

      if (decision === 'update') {
        const { error } = await supabase
          .from('bsm_supply_rates')
          .update({
            unit: item.unit,
            supply_price: item.supply_price,
            applied_at: item.applied_at
          })
          .eq('id', item.existingId)

        if (error) {
          errors.push(`Обновление "${item.material_name}": ${error.message}`)
        } else {
          updatedCount++
        }
      } else {
        skippedCount++
      }
    }

    setIsProcessingImport(false)
    setShowImportReport(false)
    setImportReport(null)

    // Показываем итоговый результат
    let message = `Импорт завершён!\n\n`
    message += `Добавлено новых: ${importedCount}\n`
    message += `Обновлено (по выбору): ${updatedCount}\n`
    message += `Пропущено (без изменений): ${importReport.sameItems.length}\n`
    message += `Оставлено без изменений: ${skippedCount}\n`
    if (errors.length > 0) {
      message += `\nОшибок: ${errors.length}`
    }
    alert(message)

    fetchRates()
  }

  // Отмена импорта
  const handleCancelImport = () => {
    setShowImportReport(false)
    setImportReport(null)
    setConflictDecisions({})
  }

  // Выбор решения для конфликта
  const handleConflictDecision = (idx, decision) => {
    setConflictDecisions(prev => ({
      ...prev,
      [idx]: decision
    }))
  }

  // Выбрать все - обновить
  const handleSelectAllUpdate = () => {
    const decisions = {}
    importReport.conflictItems.forEach((_, idx) => {
      decisions[idx] = 'update'
    })
    setConflictDecisions(decisions)
  }

  // Выбрать все - оставить
  const handleSelectAllKeep = () => {
    const decisions = {}
    importReport.conflictItems.forEach((_, idx) => {
      decisions[idx] = 'keep'
    })
    setConflictDecisions(decisions)
  }

  const handleExportExcel = () => {
    if (rates.length === 0) return

    const selectedObject = objects.find(o => o.id === selectedObjectId)
    const exportData = rates.map((rate, idx) => ({
      '№': idx + 1,
      'Наименование материала': rate.material_name,
      'Ед. изм.': rate.unit,
      'Цена от снабжения': rate.supply_price,
      'Дата применения': rate.applied_at ? new Date(rate.applied_at).toLocaleDateString('ru-RU') : '',
      'Примечание': rate.notes || ''
    }))

    const ws = XLSX.utils.json_to_sheet(exportData)
    ws['!cols'] = [{ wch: 5 }, { wch: 50 }, { wch: 10 }, { wch: 18 }, { wch: 15 }, { wch: 30 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Расценки от снабжения')
    XLSX.writeFile(wb, `Расценки_снабжение_${selectedObject?.name || 'объект'}.xlsx`)
  }

  const filteredRates = rates.filter(rate =>
    rate.material_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const formatNumber = (num) => {
    return parseFloat(num).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  return (
    <div className="bsm-rates-page">
      <h1>Расценки от снабжения</h1>
      <p className="page-description">
        Актуальные расценки на материалы от отдела снабжения
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
              {selectedRates.size > 0 && (
                <button onClick={handleDeleteSelected} className="btn-delete-selected">
                  Удалить выбранные ({selectedRates.size})
                </button>
              )}
            </div>
            <div className="toolbar-right">
              <button onClick={() => setShowAddForm(true)} className="btn-add">
                + Добавить
              </button>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleImportExcel}
                ref={fileInputRef}
                style={{ display: 'none' }}
                id="import-rates"
              />
              <label htmlFor="import-rates" className="btn-import">
                Импорт из Excel
              </label>
              <button
                onClick={() => setShowImportHelp(!showImportHelp)}
                className="btn-help"
                title="Инструкция по импорту"
              >
                ?
              </button>
              <button onClick={handleExportExcel} className="btn-export" disabled={rates.length === 0}>
                Экспорт в Excel
              </button>
            </div>
          </div>

          {showImportHelp && (
            <div className="import-help">
              <div className="import-help-header">
                <h3>Инструкция по импорту из Excel</h3>
                <button onClick={() => setShowImportHelp(false)} className="btn-close">×</button>
              </div>
              <div className="import-help-content">
                <p><strong>Формат файла:</strong> Excel (.xlsx, .xls)</p>
                <p><strong>Структура столбцов:</strong></p>
                <table className="format-table">
                  <thead>
                    <tr>
                      <th>Столбец A</th>
                      <th>Столбец B</th>
                      <th>Столбец C</th>
                      <th>Столбец D</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Наименование материала *</td>
                      <td>Ед. изм.</td>
                      <td>Цена *</td>
                      <td>Дата применения</td>
                    </tr>
                    <tr className="example-row">
                      <td>Кабель ВВГнг 3x2.5</td>
                      <td>м</td>
                      <td>125.50</td>
                      <td>15.01.2025</td>
                    </tr>
                    <tr className="example-row">
                      <td>Труба ПНД 32</td>
                      <td>м</td>
                      <td>45.00</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
                <div className="import-notes">
                  <p><strong>Примечания:</strong></p>
                  <ul>
                    <li>Первая строка может содержать заголовки (будет пропущена автоматически)</li>
                    <li>Система ищет заголовок со словом &quot;наименование&quot; или &quot;материал&quot;</li>
                    <li>Строки без названия или с нулевой ценой будут пропущены</li>
                    <li>При совпадении названия материала цена будет обновлена</li>
                    <li>Дата применения (столбец D) необязательна</li>
                    <li>Дата может быть в формате ДД.ММ.ГГГГ или как дата Excel</li>
                  </ul>
                </div>
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
                  value={newRate.supply_price}
                  onChange={(e) => setNewRate({ ...newRate, supply_price: e.target.value })}
                />
                <input
                  type="date"
                  placeholder="Дата применения"
                  value={newRate.applied_at}
                  onChange={(e) => setNewRate({ ...newRate, applied_at: e.target.value })}
                  title="Дата применения расценки"
                />
                <button onClick={handleAddRate} className="btn-save">Сохранить</button>
                <button onClick={() => setShowAddForm(false)} className="btn-cancel">Отмена</button>
              </div>
            </div>
          )}

          {/* Диалог отчёта импорта */}
          {showImportReport && importReport && (
            <div className="import-report-overlay">
              <div className="import-report-modal">
                <div className="import-report-header">
                  <h2>Отчёт по импорту</h2>
                  <button onClick={handleCancelImport} className="btn-close">×</button>
                </div>

                <div className="import-report-summary">
                  <p><strong>Файл:</strong> {importReport.fileName}</p>
                  <p><strong>Найдено позиций:</strong> {importReport.totalParsed}</p>
                </div>

                <div className="import-report-stats">
                  <div className="stat-item new">
                    <span className="stat-value">{importReport.newItems.length}</span>
                    <span className="stat-label">Новых позиций</span>
                  </div>
                  <div className="stat-item same">
                    <span className="stat-value">{importReport.sameItems.length}</span>
                    <span className="stat-label">Без изменений</span>
                  </div>
                  <div className="stat-item conflict">
                    <span className="stat-value">{importReport.conflictItems.length}</span>
                    <span className="stat-label">Требуют решения</span>
                  </div>
                </div>

                {/* Секция новых позиций */}
                {importReport.newItems.length > 0 && (
                  <div className="import-section">
                    <h3>Новые позиции ({importReport.newItems.length})</h3>
                    <p className="section-hint">Будут добавлены автоматически</p>
                    <div className="import-items-list compact">
                      {importReport.newItems.slice(0, 5).map((item, idx) => (
                        <div key={idx} className="import-item new-item">
                          <span className="item-name">{item.material_name}</span>
                          <span className="item-price">{formatNumber(item.supply_price)}</span>
                          {item.applied_at && (
                            <span className="item-date" style={{ color: 'var(--text-tertiary)', fontSize: '0.85em', marginLeft: '8px' }}>
                              ({new Date(item.applied_at).toLocaleDateString('ru-RU')})
                            </span>
                          )}
                        </div>
                      ))}
                      {importReport.newItems.length > 5 && (
                        <div className="more-items">...и ещё {importReport.newItems.length - 5} позиций</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Секция конфликтов */}
                {importReport.conflictItems.length > 0 && (
                  <div className="import-section conflicts">
                    <h3>Расценки с разными ценами ({importReport.conflictItems.length})</h3>
                    <p className="section-hint">Выберите, какую цену применить для каждой позиции</p>

                    <div className="conflict-bulk-actions">
                      <button onClick={handleSelectAllUpdate} className="btn-bulk">
                        Обновить все на новую
                      </button>
                      <button onClick={handleSelectAllKeep} className="btn-bulk">
                        Оставить все старые
                      </button>
                    </div>

                    <div className="conflict-list">
                      <div className="conflict-header">
                        <span className="col-name">Наименование</span>
                        <span className="col-old">Текущая цена</span>
                        <span className="col-new">Новая цена</span>
                        <span className="col-diff">Разница</span>
                        <span className="col-date">Дата</span>
                        <span className="col-action">Действие</span>
                      </div>
                      {importReport.conflictItems.map((item, idx) => (
                        <div key={idx} className={`conflict-item ${conflictDecisions[idx]}`}>
                          <span className="col-name" title={item.material_name}>
                            {item.material_name}
                          </span>
                          <span className="col-old">{formatNumber(item.existingPrice)}</span>
                          <span className="col-new">{formatNumber(item.newPrice)}</span>
                          <span className={`col-diff ${item.difference > 0 ? 'up' : 'down'}`}>
                            {item.difference > 0 ? '+' : ''}{formatNumber(item.difference)}
                            <small>({item.percentDiff > 0 ? '+' : ''}{item.percentDiff.toFixed(1)}%)</small>
                          </span>
                          <span className="col-date" style={{ color: 'var(--text-tertiary)', fontSize: '0.85em' }}>
                            {item.applied_at ? new Date(item.applied_at).toLocaleDateString('ru-RU') : '—'}
                          </span>
                          <span className="col-action">
                            <label className={`radio-option ${conflictDecisions[idx] === 'keep' ? 'selected' : ''}`}>
                              <input
                                type="radio"
                                name={`conflict-${idx}`}
                                checked={conflictDecisions[idx] === 'keep'}
                                onChange={() => handleConflictDecision(idx, 'keep')}
                              />
                              Оставить
                            </label>
                            <label className={`radio-option ${conflictDecisions[idx] === 'update' ? 'selected' : ''}`}>
                              <input
                                type="radio"
                                name={`conflict-${idx}`}
                                checked={conflictDecisions[idx] === 'update'}
                                onChange={() => handleConflictDecision(idx, 'update')}
                              />
                              Обновить
                            </label>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="import-report-footer">
                  <button
                    onClick={handleCancelImport}
                    className="btn-cancel"
                    disabled={isProcessingImport}
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleConfirmImport}
                    className="btn-confirm"
                    disabled={isProcessingImport}
                  >
                    {isProcessingImport ? 'Обработка...' : 'Применить импорт'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="loading">Загрузка...</div>
          ) : filteredRates.length === 0 ? (
            <div className="empty-state">
              {rates.length === 0
                ? 'Нет расценок от снабжения для этого объекта. Добавьте расценки вручную или импортируйте из Excel.'
                : 'Ничего не найдено по запросу'}
            </div>
          ) : (
            <div className="table-container">
              <table className="rates-table">
                <thead>
                  <tr>
                    <th className="col-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedRates.size === filteredRates.length && filteredRates.length > 0}
                        onChange={toggleSelectAll}
                        title="Выбрать все"
                      />
                    </th>
                    <th className="col-num">№</th>
                    <th className="col-name">Наименование материала</th>
                    <th className="col-unit">Ед. изм.</th>
                    <th className="col-price">Цена от снабжения</th>
                    <th className="col-date">Дата применения</th>
                    <th className="col-actions">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRates.map((rate, idx) => (
                    <tr key={rate.id} className={selectedRates.has(rate.id) ? 'selected-row' : ''}>
                      <td className="col-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedRates.has(rate.id)}
                          onChange={() => toggleSelectRate(rate.id)}
                        />
                      </td>
                      <td className="col-num">{idx + 1}</td>
                      <td className="col-name">
                        {editingRate === rate.id ? (
                          <input
                            type="text"
                            defaultValue={rate.material_name}
                            onBlur={(e) => handleUpdateRate(rate.id, { material_name: e.target.value })}
                          />
                        ) : (
                          rate.material_name
                        )}
                      </td>
                      <td className="col-unit">
                        {editingRate === rate.id ? (
                          <input
                            type="text"
                            defaultValue={rate.unit}
                            onBlur={(e) => handleUpdateRate(rate.id, { unit: e.target.value })}
                          />
                        ) : (
                          rate.unit
                        )}
                      </td>
                      <td className="col-price">
                        {editingRate === rate.id ? (
                          <input
                            type="number"
                            step="0.01"
                            defaultValue={rate.supply_price}
                            onBlur={(e) => handleUpdateRate(rate.id, { supply_price: parseFloat(e.target.value) })}
                          />
                        ) : (
                          formatNumber(rate.supply_price)
                        )}
                      </td>
                      <td className="col-date">
                        {editingRate === rate.id ? (
                          <input
                            type="date"
                            defaultValue={rate.applied_at || ''}
                            onBlur={(e) => handleUpdateRate(rate.id, { applied_at: e.target.value || null })}
                          />
                        ) : (
                          rate.applied_at ? new Date(rate.applied_at).toLocaleDateString('ru-RU') : '—'
                        )}
                      </td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default BSMRatesPage
