import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'
import './BSMRatesPage.css'

function BSMContractRatesPage() {
  // Режим отображения: 'list' - список БСМ, 'detail' - детальный просмотр расценок
  const [viewMode, setViewMode] = useState('list')

  // ========== Список существующих БСМ ==========
  const [existingBsmList, setExistingBsmList] = useState([])
  const [bsmListLoading, setBsmListLoading] = useState(true)
  const [showAddBsmModal, setShowAddBsmModal] = useState(false)
  const [newBsmObjectId, setNewBsmObjectId] = useState('')
  const [bsmSearchTerm, setBsmSearchTerm] = useState('')
  const [bsmFilterObject, setBsmFilterObject] = useState('')

  // ========== Общие данные ==========
  const [objects, setObjects] = useState([])
  const [selectedObjectId, setSelectedObjectId] = useState('')
  const [selectedObjectName, setSelectedObjectName] = useState('')

  // ========== Данные для вкладки "Расценки" ==========
  const [rates, setRates] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [editingRate, setEditingRate] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRate, setNewRate] = useState({ material_name: '', unit: '', contract_price: '' })
  const [searchTerm, setSearchTerm] = useState('')
  const [showImportHelp, setShowImportHelp] = useState(false)
  const [selectedRates, setSelectedRates] = useState(new Set())
  const fileInputRef = useRef(null)

  // ========== Загрузка данных ==========
  useEffect(() => {
    fetchObjects()
    fetchExistingBsmList()
  }, [])

  // Загрузка списка существующих БСМ (уникальные объекты с расценками)
  const fetchExistingBsmList = async () => {
    setBsmListLoading(true)
    try {
      const { data, error } = await supabase
        .from('bsm_contract_rates')
        .select(`
          object_id,
          objects(id, name)
        `)

      if (error) throw error

      // Группируем по уникальным объектам
      const uniqueMap = new Map()
      data.forEach(item => {
        const key = item.object_id
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, {
            object_id: item.object_id,
            object_name: item.objects?.name || 'Неизвестный объект',
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
      .from('bsm_contract_rates')
      .select('*')
      .eq('object_id', selectedObjectId)
      .order('material_name')

    if (!error && data) {
      setRates(data)
    }
    setIsLoading(false)
  }

  // ========== Функции для работы со списком БСМ ==========
  const handleSelectBsm = (bsm) => {
    setSelectedObjectId(bsm.object_id)
    setSelectedObjectName(bsm.object_name)
    setViewMode('detail')
  }

  const handleBackToList = () => {
    setViewMode('list')
    setSelectedObjectId('')
    setSelectedObjectName('')
    setRates([])
    // Обновим список БСМ
    fetchExistingBsmList()
  }

  const handleAddNewBsm = async () => {
    if (!newBsmObjectId) {
      alert('Выберите объект')
      return
    }

    // Проверим, не существует ли уже БСМ для этого объекта
    const exists = existingBsmList.some(b => b.object_id === newBsmObjectId)
    if (exists) {
      alert('БСМ для этого объекта уже существует')
      return
    }

    // Находим название объекта
    const objName = objects.find(o => o.id === newBsmObjectId)?.name || ''

    // Переходим к детальному просмотру (расценки можно будет добавить там)
    setSelectedObjectId(newBsmObjectId)
    setSelectedObjectName(objName)
    setShowAddBsmModal(false)
    setNewBsmObjectId('')
    setViewMode('detail')
  }

  const handleDeleteBsm = async (objectId) => {
    const objName = existingBsmList.find(b => b.object_id === objectId)?.object_name

    if (!confirm(`Удалить все расценки БСМ для объекта "${objName}"?`)) return

    const { error } = await supabase
      .from('bsm_contract_rates')
      .delete()
      .eq('object_id', objectId)

    if (error) {
      alert('Ошибка удаления: ' + error.message)
    } else {
      fetchExistingBsmList()
    }
  }

  // ========== Функции для расценок ==========
  const handleAddRate = async () => {
    if (!newRate.material_name || !newRate.contract_price) {
      alert('Заполните наименование материала и цену')
      return
    }

    const { error } = await supabase
      .from('bsm_contract_rates')
      .insert({
        object_id: selectedObjectId,
        material_name: newRate.material_name.trim(),
        unit: newRate.unit.trim(),
        contract_price: parseFloat(newRate.contract_price)
      })

    if (error) {
      if (error.code === '23505') {
        alert('Материал с таким названием уже существует для этого объекта')
      } else {
        alert('Ошибка при добавлении: ' + error.message)
      }
    } else {
      setNewRate({ material_name: '', unit: '', contract_price: '' })
      setShowAddForm(false)
      fetchRates()
    }
  }

  const handleUpdateRate = async (id, updates) => {
    const { error } = await supabase
      .from('bsm_contract_rates')
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
      .from('bsm_contract_rates')
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
      .from('bsm_contract_rates')
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

  const handleImportExcel = (e) => {
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

        // Парсим данные
        const newRates = []
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i]
          if (!row || !row[0]) continue

          const materialName = String(row[0]).trim()
          const unit = row[1] ? String(row[1]).trim() : ''
          const parsePrice = (val) => {
            if (val === null || val === undefined || val === '') return 0
            const strVal = String(val)
              .replace(/\s/g, '')
              .replace(/,/g, '.')
            return parseFloat(strVal) || 0
          }
          const price = parsePrice(row[2]) || parsePrice(row[3]) || 0

          if (materialName && price > 0) {
            newRates.push({
              object_id: selectedObjectId,
              material_name: materialName,
              unit: unit,
              contract_price: price
            })
          }
        }

        if (newRates.length === 0) {
          alert('Не найдено данных для импорта')
          return
        }

        // Импортируем по одному с обработкой дубликатов
        let importedCount = 0
        let updatedCount = 0
        let errors = []

        for (const rate of newRates) {
          const { data: existing, error: searchError } = await supabase
            .from('bsm_contract_rates')
            .select('id')
            .eq('object_id', rate.object_id)
            .ilike('material_name', rate.material_name)
            .maybeSingle()

          if (searchError) {
            errors.push(`Поиск: ${searchError.message}`)
            continue
          }

          if (existing) {
            const { error: updateError } = await supabase
              .from('bsm_contract_rates')
              .update({
                unit: rate.unit,
                contract_price: rate.contract_price
              })
              .eq('id', existing.id)

            if (updateError) {
              errors.push(`Обновление: ${updateError.message}`)
            } else {
              updatedCount++
            }
          } else {
            const { error: insertError } = await supabase
              .from('bsm_contract_rates')
              .insert(rate)

            if (insertError) {
              errors.push(`Вставка: ${insertError.message}`)
            } else {
              importedCount++
            }
          }
        }

        const totalProcessed = importedCount + updatedCount
        if (totalProcessed === 0) {
          const errorMsg = errors.length > 0
            ? `Ошибки:\n${errors.slice(0, 3).join('\n')}`
            : 'Проверьте формат файла.'
          alert(`Не удалось импортировать данные.\n${errorMsg}`)
        } else {
          let message = `Обработано: ${totalProcessed} расценок`
          if (importedCount > 0) message += `\nДобавлено новых: ${importedCount}`
          if (updatedCount > 0) message += `\nОбновлено: ${updatedCount}`
          if (errors.length > 0) message += `\nОшибок: ${errors.length}`
          alert(message)
          fetchRates()
        }
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

  const handleExportExcel = () => {
    if (rates.length === 0) return

    const exportData = rates.map((rate, idx) => ({
      '№': idx + 1,
      'Наименование материала': rate.material_name,
      'Ед. изм.': rate.unit,
      'Согласованная цена': rate.contract_price,
      'Примечание': rate.notes || ''
    }))

    const ws = XLSX.utils.json_to_sheet(exportData)
    ws['!cols'] = [{ wch: 5 }, { wch: 50 }, { wch: 10 }, { wch: 18 }, { wch: 30 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Согласованные расценки')
    XLSX.writeFile(wb, `БСМ_заказчик_${selectedObjectName || 'объект'}.xlsx`)
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

  // Фильтрация списка БСМ
  const filteredBsmList = existingBsmList.filter(bsm => {
    const searchLower = bsmSearchTerm.toLowerCase()
    const matchesSearch = !bsmSearchTerm || bsm.object_name.toLowerCase().includes(searchLower)
    const matchesObject = !bsmFilterObject || bsm.object_id === bsmFilterObject
    return matchesSearch && matchesObject
  })

  // Уникальные объекты для фильтров
  const uniqueObjectsInBsm = [...new Map(existingBsmList.map(b => [b.object_id, { id: b.object_id, name: b.object_name }])).values()]

  // ========== РЕЖИМ СПИСКА БСМ ==========
  if (viewMode === 'list') {
    return (
      <div className="bsm-rates-page bsm-list-page">
        <div className="bsm-list-header">
          <div className="bsm-list-header-content">
            <div className="bsm-list-title-section">
              <h1>БСМ с заказчиком</h1>
              <p className="page-description">
                Ведомость стоимости материалов, согласованных с заказчиком
              </p>
            </div>
            <button className="btn-add-bsm" onClick={() => setShowAddBsmModal(true)}>
              <span className="btn-icon-plus">+</span>
              <span>Добавить БСМ</span>
            </button>
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
              placeholder="Поиск по объекту..."
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
            {(bsmFilterObject || bsmSearchTerm) && (
              <button
                className="btn-clear-filters"
                onClick={() => {
                  setBsmSearchTerm('')
                  setBsmFilterObject('')
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
            <p>Нет созданных БСМ с заказчиком</p>
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
                  <th className="col-count">Позиций</th>
                  <th className="col-actions">Действия</th>
                </tr>
              </thead>
              <tbody>
                {filteredBsmList.map((bsm, index) => (
                  <tr
                    key={bsm.object_id}
                    className="bsm-list-row"
                    onClick={() => handleSelectBsm(bsm)}
                  >
                    <td className="col-number">{index + 1}</td>
                    <td className="col-object">{bsm.object_name}</td>
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
                      <button
                        className="btn-action btn-delete"
                        onClick={() => handleDeleteBsm(bsm.object_id)}
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

        {/* Модалка добавления БСМ */}
        {showAddBsmModal && (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Добавить БСМ с заказчиком</h3>
                <button className="modal-close" onClick={() => setShowAddBsmModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>Объект *</label>
                  <select
                    value={newBsmObjectId}
                    onChange={(e) => setNewBsmObjectId(e.target.value)}
                    className="form-select"
                  >
                    <option value="">-- Выберите объект --</option>
                    {objects.filter(obj => !existingBsmList.some(b => b.object_id === obj.id)).map(obj => (
                      <option key={obj.id} value={obj.id}>{obj.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn-cancel" onClick={() => setShowAddBsmModal(false)}>Отмена</button>
                <button className="btn-save" onClick={handleAddNewBsm}>Создать</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ========== РЕЖИМ ДЕТАЛЬНОГО ПРОСМОТРА ==========
  return (
    <div className="bsm-rates-page">
      <div className="detail-header">
        <button className="btn-back" onClick={handleBackToList}>
          ← Назад к списку
        </button>
        <div className="detail-title">
          <h1>БСМ с заказчиком</h1>
          <p className="object-name">{selectedObjectName}</p>
        </div>
      </div>

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
            id="import-contract-rates"
          />
          <label htmlFor="import-contract-rates" className="btn-import">
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
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Наименование материала *</td>
                  <td>Ед. изм.</td>
                  <td>Цена *</td>
                </tr>
                <tr className="example-row">
                  <td>Кабель ВВГнг 3x2.5</td>
                  <td>м</td>
                  <td>125.50</td>
                </tr>
              </tbody>
            </table>
            <div className="import-notes">
              <p><strong>Примечания:</strong></p>
              <ul>
                <li>Первая строка может содержать заголовки (будет пропущена автоматически)</li>
                <li>При совпадении названия материала цена будет обновлена</li>
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
              value={newRate.contract_price}
              onChange={(e) => setNewRate({ ...newRate, contract_price: e.target.value })}
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
          {rates.length === 0
            ? 'Нет согласованных расценок для этого объекта. Добавьте расценки вручную или импортируйте из Excel.'
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
                <th className="col-price">Согласованная цена</th>
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
                        defaultValue={rate.contract_price}
                        onBlur={(e) => handleUpdateRate(rate.id, { contract_price: parseFloat(e.target.value) })}
                      />
                    ) : (
                      formatNumber(rate.contract_price)
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
    </div>
  )
}

export default BSMContractRatesPage
