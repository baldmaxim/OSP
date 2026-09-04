import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { generateUUID } from '../utils/uuid'
import * as XLSX from 'xlsx'
import '../components/GeneralInfo.css'

// Глобальная переменная для хранения экземпляра карты
let mapInstance = null

// «Базаркин Андрей Геннадьевич» → «Базаркин А. Г.»: в карточке объекта на полные
// ФИО нескольких человек места нет, а по фамилии с инициалами узнают сразу.
// Полные имена остаются в title.
function shortFio(full) {
  const parts = String(full || '').trim().split(/\s+/)
  if (parts.length < 2) return full || ''
  const initials = parts.slice(1, 3).map(w => `${w.charAt(0).toUpperCase()}.`).join(' ')
  return `${parts[0]} ${initials}`
}

function ObjectsPage() {
  const { scopedObjectIds, canEdit } = useRole()
  // task 333: гейт add/edit/delete объектов
  const canEditObjects = canEdit('objects')
  const [objects, setObjects] = useState([])
  // Ответственные по объектам: Map<object_id, { construction_manager: [], economist: [] }>
  const [staffByObject, setStaffByObject] = useState(() => new Map())
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [showObjectModal, setShowObjectModal] = useState(false)
  const [showMapModal, setShowMapModal] = useState(false)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapFilter, setMapFilter] = useState('all')
  const [editingObject, setEditingObject] = useState(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const fileInputRef = useRef(null)
  const photoInputRef = useRef(null)
  const mapInitialized = useRef(false)

  const [objectFormData, setObjectFormData] = useState({
    name: '',
    address: '',
    description: '',
    map_link: '',
    latitude: '',
    longitude: '',
    status: 'main_construction',
    cover_image_url: '',
  })

  // Фильтр по статусу
  const [statusFilter, setStatusFilter] = useState('main_construction')

  const getObjectCoordinates = (object) => {
    if (object.latitude !== null && object.latitude !== undefined &&
        object.longitude !== null && object.longitude !== undefined) {
      const lat = parseFloat(object.latitude)
      const lon = parseFloat(object.longitude)

      if (!isNaN(lat) && !isNaN(lon) &&
          lat >= -90 && lat <= 90 &&
          lon >= -180 && lon <= 180) {
        console.log(`✅ Используем прямые координаты для "${object.name}":`, [lat, lon])
        return [lat, lon]
      } else {
        console.warn(`❌ Координаты вне допустимого диапазона для "${object.name}":`, { lat, lon })
      }
    }

    console.warn(`❌ Объект "${object.name}" не имеет валидных координат`)
    return null
  }

  const initMap = useCallback(async () => {
    try {
      setMapLoading(true)
      console.log('Начало инициализации карты')

      if (mapInstance) {
        console.log('Уничтожение старого экземпляра карты')
        mapInstance.destroy()
      }

      const mapContainer = document.getElementById('yandex-map')
      if (!mapContainer) {
        console.error('Контейнер карты не найден!')
        alert('Ошибка: контейнер карты не найден!')
        setMapLoading(false)
        return
      }

      mapInstance = new window.ymaps.Map('yandex-map', {
        center: [55.75, 37.57],
        zoom: 10,
        controls: ['zoomControl', 'fullscreenControl', 'geolocationControl']
      })

      mapInitialized.current = true

      const filteredObjects = mapFilter === 'all'
        ? objects
        : objects.filter(obj => {
            const objectStatus = obj.status || 'main_construction'
            return objectStatus === mapFilter
          })

      const bounds = []
      let successCount = 0
      let failCount = 0

      for (let i = 0; i < filteredObjects.length; i++) {
        const object = filteredObjects[i]
        const coords = getObjectCoordinates(object)

        if (!coords || !Array.isArray(coords) || coords.length !== 2 ||
            isNaN(coords[0]) || isNaN(coords[1])) {
          failCount++
          continue
        }

        try {
          const [lat, lon] = coords
          if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
            failCount++
            continue
          }

          if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            failCount++
            continue
          }

          const placemark = new window.ymaps.Placemark(
            [lat, lon],
            {
              balloonContentHeader: `<strong>${object.name || 'Без названия'}</strong>`,
              balloonContentBody: `
                <p><strong>Адрес:</strong> ${object.address || 'Не указан'}</p>
                ${object.description ? `<p><strong>Описание:</strong> ${object.description}</p>` : ''}
                <p><strong>Статус:</strong> ${(object.status || 'main_construction') === 'warranty_service' ? 'Гарантийное обслуживание' : 'Основное строительство'}</p>
                ${object.map_link ? `<p><a href="${object.map_link}" target="_blank" rel="noopener noreferrer">Открыть в Яндекс.Картах</a></p>` : ''}
              `,
              hintContent: object.name || 'Объект',
              iconContent: String(i + 1)
            },
            {
              preset: 'islands#blueStretchyIcon',
              draggable: false
            }
          )

          // По клику на метку — приближаем карту и центрируем на объекте
          placemark.events.add('click', () => {
            mapInstance.setCenter([lat, lon], 16, { duration: 300 })
          })

          mapInstance.geoObjects.add(placemark)
          bounds.push([lat, lon])
          successCount++
        } catch (error) {
          console.error('❌ Ошибка при добавлении метки на карту:', error)
          failCount++
        }
      }

      if (bounds.length > 0) {
        const validBounds = bounds.filter(coord => {
          if (!Array.isArray(coord) || coord.length !== 2) return false
          const [lat, lon] = coord
          return typeof lat === 'number' && typeof lon === 'number' &&
                 !isNaN(lat) && !isNaN(lon) &&
                 lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
        })

        if (validBounds.length > 0) {
          try {
            if (validBounds.length === 1) {
              // Один объект — центрируем на нём с разумным зумом
              mapInstance.setCenter(validBounds[0], 14, { duration: 0 })
            } else {
              // Несколько объектов — вычисляем bounding box и подгоняем зум,
              // чтобы все метки помещались в одно поле без ручного масштабирования.
              const lats = validBounds.map(c => c[0])
              const lons = validBounds.map(c => c[1])
              const swLat = Math.min(...lats)
              const swLon = Math.min(...lons)
              const neLat = Math.max(...lats)
              const neLon = Math.max(...lons)
              mapInstance.setBounds([[swLat, swLon], [neLat, neLon]], {
                checkZoomRange: true,
                zoomMargin: 60
              })
            }
          } catch (boundsError) {
            console.error('Ошибка setBounds:', boundsError)
            if (validBounds.length > 0) {
              mapInstance.setCenter(validBounds[0], 12)
            }
          }
        }
      } else {
        const filterText = mapFilter === 'all'
          ? 'У всех объектов'
          : mapFilter === 'main_construction'
          ? 'У объектов со статусом "Основное строительство"'
          : 'У объектов со статусом "Гарантийное обслуживание"'
        alert(`Ни один объект не был добавлен на карту.\n\n${filterText} должны быть заполнены поля "Широта" и "Долгота".\n\nОткройте Яндекс.Карты, найдите объект, нажмите правой кнопкой мыши и выберите "Что здесь?" для получения координат.`)
      }

      setMapLoading(false)

      if (successCount > 0 && failCount > 0) {
        alert(`На карте отображено ${successCount} из ${filteredObjects.length} объектов.\n\n${failCount} объект(ов) пропущено - у них не заполнены координаты (широта и долгота).\n\nДля добавления координат отредактируйте объект и укажите широту и долготу.`)
      }
    } catch (error) {
      console.error('💥 КРИТИЧЕСКАЯ ОШИБКА при инициализации карты:', error)
      alert('Ошибка при загрузке карты: ' + error.message)
      setMapLoading(false)
    }
  }, [objects, mapFilter])

  const fetchObjects = useCallback(async () => {
    try {
      setLoading(true)
      let query = supabase
        .from('objects')
        .select('*')
        .order('name', { ascending: true })
      if (scopedObjectIds.length > 0) query = query.in('id', scopedObjectIds)
      const { data, error } = await query

      if (error) throw error
      setObjects(data || [])

      // Ответственные по объектам — одним запросом на весь список, а не по
      // запросу на карточку. Best-effort: до применения миграции 20260831
      // таблицы нет, и сетка объектов не должна из-за этого падать.
      const staffRes = await supabase
        .from('object_staff')
        .select('object_id, staff_role, sort_order, contacts(id, full_name)')
        .order('sort_order', { ascending: true })
      if (staffRes.error) {
        console.warn('Ответственные по объектам недоступны (миграция 20260831?):', staffRes.error.message)
        setStaffByObject(new Map())
      } else {
        const map = new Map()
        for (const row of staffRes.data || []) {
          if (!row.contacts) continue
          if (!map.has(row.object_id)) map.set(row.object_id, { construction_manager: [], economist: [] })
          const bucket = map.get(row.object_id)[row.staff_role]
          if (bucket) bucket.push(row.contacts)
        }
        setStaffByObject(map)
      }
    } catch (error) {
      console.error('Ошибка загрузки объектов:', error.message)
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => {
    fetchObjects()
  }, [fetchObjects])

  useEffect(() => {
    if (showMapModal && objects.length > 0) {
      const timer = setTimeout(() => {
        if (window.ymaps) {
          console.log('Инициализация/обновление карты...')
          window.ymaps.ready(() => {
            initMap()
          })
        }
      }, 100)

      return () => clearTimeout(timer)
    }

    return () => {
      if (mapInstance && !showMapModal) {
        console.log('Очистка карты...')
        mapInstance.destroy()
        mapInstance = null
        mapInitialized.current = false
      }
    }
  }, [showMapModal, objects, mapFilter, initMap])

  const handleObjectSubmit = async (e) => {
    e.preventDefault()
    try {
      // Преобразуем пустые строки в null для числовых полей,
      // иначе Postgres падает с "invalid input syntax for type numeric"
      const payload = {
        ...objectFormData,
        latitude: objectFormData.latitude === '' ? null : objectFormData.latitude,
        longitude: objectFormData.longitude === '' ? null : objectFormData.longitude,
        cover_image_url: objectFormData.cover_image_url || null,
      }

      if (editingObject) {
        const { error } = await supabase
          .from('objects')
          .update(payload)
          .eq('id', editingObject.id)

        if (error) throw error
      } else {
        const { error } = await supabase.from('objects').insert([payload])
        if (error) throw error
      }

      setShowObjectModal(false)
      setEditingObject(null)
      setObjectFormData({ name: '', address: '', description: '', map_link: '', latitude: '', longitude: '', status: 'main_construction', cover_image_url: '' })
      fetchObjects()
    } catch (error) {
      console.error('Ошибка сохранения объекта:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditObject = (object) => {
    setEditingObject(object)
    setObjectFormData({
      name: object.name,
      address: object.address,
      description: object.description || '',
      map_link: object.map_link || '',
      latitude: object.latitude || '',
      longitude: object.longitude || '',
      status: object.status || 'main_construction',
      cover_image_url: object.cover_image_url || '',
    })
    setShowObjectModal(true)
  }

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      alert('Выберите файл изображения (JPEG, PNG, WebP и т.п.)')
      e.target.value = ''
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      alert('Размер файла не должен превышать 5 МБ')
      e.target.value = ''
      return
    }

    setUploadingPhoto(true)
    try {
      const ext = file.name.split('.').pop()
      const fileName = `${generateUUID()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('object-photos')
        .upload(fileName, file, { cacheControl: '3600', upsert: false })

      if (uploadError) throw uploadError

      const { data: { publicUrl } } = supabase.storage
        .from('object-photos')
        .getPublicUrl(fileName)

      setObjectFormData(prev => ({ ...prev, cover_image_url: publicUrl }))
    } catch (err) {
      console.error('Ошибка загрузки фото:', err)
      alert('Ошибка загрузки фото: ' + err.message)
    } finally {
      setUploadingPhoto(false)
      e.target.value = ''
    }
  }

  const handleRemovePhoto = () => {
    setObjectFormData(prev => ({ ...prev, cover_image_url: '' }))
  }

  const handleDeleteObject = async (id, name) => {
    if (window.confirm(`Вы уверены, что хотите удалить объект "${name}"?`)) {
      try {
        const { error } = await supabase.from('objects').delete().eq('id', id)
        if (error) throw error
        fetchObjects()
      } catch (error) {
        console.error('Ошибка удаления объекта:', error.message)
        alert('Ошибка удаления: ' + error.message)
      }
    }
  }

  const handleAddNewObject = () => {
    setEditingObject(null)
    setObjectFormData({ name: '', address: '', description: '', map_link: '', latitude: '', longitude: '', status: 'main_construction', cover_image_url: '' })
    setShowObjectModal(true)
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileImport = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setImporting(true)

    try {
      const data = await file.arrayBuffer()
      const workbook = XLSX.read(data)
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(worksheet)

      const validObjects = []
      const errors = []

      jsonData.forEach((row, index) => {
        const rowNumber = index + 2

        if (!row['Название'] || !row['Адрес']) {
          errors.push(
            `Строка ${rowNumber}: отсутствуют обязательные поля (Название или Адрес)`
          )
          return
        }

        validObjects.push({
          name: String(row['Название']).trim(),
          address: String(row['Адрес']).trim(),
          description: row['Описание'] ? String(row['Описание']).trim() : '',
          map_link: row['Ссылка на карту'] ? String(row['Ссылка на карту']).trim() : '',
        })
      })

      if (errors.length > 0) {
        alert(
          `Обнаружены ошибки при импорте:\n\n${errors.join('\n')}\n\nКорректные данные будут импортированы.`
        )
      }

      if (validObjects.length === 0) {
        alert('Не найдено корректных данных для импорта.')
        setImporting(false)
        return
      }

      const { data: insertedData, error } = await supabase
        .from('objects')
        .insert(validObjects)
        .select()

      if (error) throw error

      alert(
        `Успешно импортировано ${insertedData.length} объект(ов)${errors.length > 0 ? ` (пропущено строк с ошибками: ${errors.length})` : ''}`
      )

      fetchObjects()
      event.target.value = ''
    } catch (error) {
      console.error('Ошибка импорта:', error)
      alert(`Ошибка при импорте файла: ${error.message}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="general-info">
      <div className="general-info-header">
        <h2>Объекты</h2>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="section-content">
          {/* Фильтр по статусу */}
          <div className="status-filter-tabs">
            <button
              className={`status-filter-tab ${statusFilter === 'main_construction' ? 'active' : ''}`}
              onClick={() => setStatusFilter('main_construction')}
            >
              🏗️ Основное строительство
              <span className="tab-count">
                {objects.filter(obj => (obj.status || 'main_construction') === 'main_construction').length}
              </span>
            </button>
            <button
              className={`status-filter-tab ${statusFilter === 'warranty_service' ? 'active' : ''}`}
              onClick={() => setStatusFilter('warranty_service')}
            >
              🛠️ Гарантийное обслуживание
              <span className="tab-count">
                {objects.filter(obj => obj.status === 'warranty_service').length}
              </span>
            </button>
          </div>

          <div className="section-actions">
            {/* task 333: add/import только при can_edit */}
            {canEditObjects && (
              <>
                <button className="btn-primary" onClick={handleAddNewObject}>
                  + Добавить объект
                </button>
                <button
                  className="btn-secondary"
                  onClick={handleImportClick}
                  disabled={importing}
                >
                  {importing ? 'Импорт...' : '📥 Импорт из Excel'}
                </button>
              </>
            )}
            <button
              className="btn-secondary"
              onClick={() => setShowMapModal(true)}
              disabled={objects.length === 0}
            >
              🗺️ Объекты на карте
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileImport}
              style={{ display: 'none' }}
            />
          </div>

          <div className="objects-grid">
            {(() => {
              const filteredObjects = objects.filter(obj => (obj.status || 'main_construction') === statusFilter)

              if (filteredObjects.length === 0) {
                return (
                  <div className="objects-empty">
                    Нет объектов с выбранным статусом.
                  </div>
                )
              }

              const formatDate = (d) => {
                if (!d) return null
                const date = new Date(d)
                if (isNaN(date.getTime())) return null
                return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
              }

              const formatBudget = (value) => {
                if (value === null || value === undefined || value === '') return null
                const num = Number(value)
                if (isNaN(num)) return null
                if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)} млн ₽`
                if (num >= 1_000) return `${(num / 1_000).toFixed(0)} тыс ₽`
                return `${num.toLocaleString('ru-RU')} ₽`
              }

              const formatArea = (value) => {
                if (value === null || value === undefined || value === '') return null
                const num = Number(value)
                if (isNaN(num)) return null
                return `${num.toLocaleString('ru-RU')} м²`
              }

              return filteredObjects.map((object) => {
                const start = formatDate(object.planned_start_date)
                const end = formatDate(object.planned_end_date)
                const area = formatArea(object.total_area)
                const budget = formatBudget(object.budget)

                return (
                  <Link
                    key={object.id}
                    to={`/general/objects/${object.id}`}
                    className="object-card"
                    title="Открыть карточку объекта (Ctrl+клик или средняя кнопка — в новой вкладке)"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    {canEditObjects && (
                      <div
                        className="object-card-actions"
                        onClick={(e) => { e.stopPropagation(); e.preventDefault() }}
                      >
                        <button
                          className="object-card-action-btn"
                          onClick={() => handleEditObject(object)}
                          title="Редактировать"
                        >
                          ✏️
                        </button>
                        <button
                          className="object-card-action-btn"
                          onClick={() => handleDeleteObject(object.id, object.name)}
                          title="Удалить"
                        >
                          🗑️
                        </button>
                      </div>
                    )}

                    {object.cover_image_url ? (
                      <div className="object-card-cover">
                        <img src={object.cover_image_url} alt={object.name} loading="lazy" />
                      </div>
                    ) : (
                      <div className="object-card-cover-placeholder">🏢</div>
                    )}

                    <div className="object-card-body">
                      <h3 className="object-card-name">{object.name}</h3>

                      {object.developer && (
                        <div className="object-card-developer">{object.developer}</div>
                      )}

                      {object.design && (
                        <div className="object-card-design">Проектирование: {object.design}</div>
                      )}

                      <div className="object-card-address">
                        <span className="object-card-address-icon">📍</span>
                        <span>{object.address}</span>
                      </div>

                      {object.description && (
                        <div className="object-card-description">{object.description}</div>
                      )}

                      {/* Ответственные по объекту: чаще всего с карточки нужен
                          именно контакт, а не площадь. Фамилии с инициалами —
                          полные ФИО в карточку не помещаются. */}
                      {(() => {
                        const s = staffByObject.get(object.id)
                        const cm = s?.construction_manager || []
                        const ec = s?.economist || []
                        if (cm.length === 0 && ec.length === 0) return null
                        return (
                          <div className="object-card-staff">
                            {cm.length > 0 && (
                              <div className="object-card-staff-row">
                                <span className="object-card-staff-role">
                                  {cm.length > 1 ? 'Рук. строительства' : 'Рук. строительства'}
                                </span>
                                <span className="object-card-staff-names" title={cm.map(p => p.full_name).join(', ')}>
                                  {cm.map(p => shortFio(p.full_name)).join(', ')}
                                </span>
                              </div>
                            )}
                            {ec.length > 0 && (
                              <div className="object-card-staff-row">
                                <span className="object-card-staff-role">
                                  {ec.length > 1 ? 'Экономисты' : 'Экономист'}
                                </span>
                                <span className="object-card-staff-names" title={ec.map(p => p.full_name).join(', ')}>
                                  {ec.map(p => shortFio(p.full_name)).join(', ')}
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {(area || budget || start || end) && (
                        <div className="object-card-meta">
                          {area && (
                            <span className="object-card-meta-item">📐 <strong>{area}</strong></span>
                          )}
                          {budget && (
                            <span className="object-card-meta-item">💰 <strong>{budget}</strong></span>
                          )}
                          {(start || end) && (
                            <span className="object-card-meta-item">
                              📅 <strong>{start || '...'} — {end || '...'}</strong>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                )
              })
            })()}
          </div>
        </div>
      )}

      {/* Modal для добавления/редактирования объекта */}
      {showObjectModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingObject ? 'Редактировать объект' : 'Добавить новый объект'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowObjectModal(false)
                  setEditingObject(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleObjectSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Фото объекта</label>
                  <div className="object-photo-upload">
                    {objectFormData.cover_image_url ? (
                      <div className="object-photo-preview">
                        <img src={objectFormData.cover_image_url} alt="Превью" />
                        <button
                          type="button"
                          className="object-photo-preview-remove"
                          onClick={handleRemovePhoto}
                          title="Удалить фото"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="object-photo-upload-btn"
                        onClick={() => photoInputRef.current?.click()}
                        disabled={uploadingPhoto}
                      >
                        {uploadingPhoto ? '⏳ Загрузка...' : '📷 Загрузить фото объекта'}
                      </button>
                    )}
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      style={{ display: 'none' }}
                    />
                  </div>
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
                    JPEG, PNG или WebP, до 5 МБ
                  </small>
                </div>

                <div className="form-group full-width">
                  <label>Название объекта *</label>
                  <input
                    type="text"
                    value={objectFormData.name}
                    onChange={(e) =>
                      setObjectFormData({ ...objectFormData, name: e.target.value })
                    }
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label>Адрес *</label>
                  <input
                    type="text"
                    value={objectFormData.address}
                    onChange={(e) =>
                      setObjectFormData({ ...objectFormData, address: e.target.value })
                    }
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label>Статус *</label>
                  <select
                    value={objectFormData.status}
                    onChange={(e) =>
                      setObjectFormData({ ...objectFormData, status: e.target.value })
                    }
                    required
                  >
                    <option value="main_construction">Основное строительство</option>
                    <option value="warranty_service">Гарантийное обслуживание</option>
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Описание</label>
                  <textarea
                    value={objectFormData.description}
                    onChange={(e) =>
                      setObjectFormData({
                        ...objectFormData,
                        description: e.target.value,
                      })
                    }
                    rows="3"
                  />
                </div>

                <div className="form-group full-width">
                  <label>Ссылка на карту</label>
                  <input
                    type="url"
                    value={objectFormData.map_link}
                    onChange={(e) =>
                      setObjectFormData({
                        ...objectFormData,
                        map_link: e.target.value,
                      })
                    }
                    placeholder="https://yandex.ru/maps/..."
                  />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
                    Необязательное поле. Можно указать ссылку на объект в Яндекс.Картах
                  </small>
                </div>

                <div className="form-group">
                  <label>Широта (Latitude)</label>
                  <input
                    type="number"
                    step="0.00000001"
                    value={objectFormData.latitude}
                    onChange={(e) =>
                      setObjectFormData({
                        ...objectFormData,
                        latitude: e.target.value,
                      })
                    }
                    placeholder="55.751244"
                  />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
                    Например: 55.751244 (для Москвы)
                  </small>
                </div>

                <div className="form-group">
                  <label>Долгота (Longitude)</label>
                  <input
                    type="number"
                    step="0.00000001"
                    value={objectFormData.longitude}
                    onChange={(e) =>
                      setObjectFormData({
                        ...objectFormData,
                        longitude: e.target.value,
                      })
                    }
                    placeholder="37.618423"
                  />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
                    Например: 37.618423 (для Москвы)
                  </small>
                </div>
              </div>

              <div className="form-info" style={{
                padding: '12px',
                backgroundColor: 'var(--bg-tertiary)',
                borderRadius: '6px',
                marginTop: '16px',
                fontSize: '14px',
                lineHeight: '1.5'
              }}>
                <strong>💡 Как узнать координаты объекта:</strong>
                <ol style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                  <li>Откройте <a href="https://yandex.ru/maps" target="_blank" rel="noopener noreferrer">Яндекс.Карты</a></li>
                  <li>Найдите нужный объект на карте</li>
                  <li>Нажмите правой кнопкой мыши на точку объекта</li>
                  <li>Выберите «Что здесь?» — координаты появятся внизу</li>
                  <li>Скопируйте широту и долготу в соответствующие поля</li>
                </ol>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowObjectModal(false)
                    setEditingObject(null)
                  }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingObject ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal для карты объектов */}
      {showMapModal && (
        <div className="modal-overlay">
          <div className="modal modal-map" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Объекты на карте</h3>
              <button className="modal-close" onClick={() => setShowMapModal(false)}>
                ×
              </button>
            </div>

            <div className="map-filters">
              <div className="map-filters-label">Показать на карте:</div>
              <div className="map-filter-buttons">
                <button
                  className={`map-filter-btn ${mapFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setMapFilter('all')}
                >
                  Все объекты ({objects.length})
                </button>
                <button
                  className={`map-filter-btn ${mapFilter === 'main_construction' ? 'active' : ''}`}
                  onClick={() => setMapFilter('main_construction')}
                >
                  Основное строительство ({objects.filter(obj => (obj.status || 'main_construction') === 'main_construction').length})
                </button>
                <button
                  className={`map-filter-btn ${mapFilter === 'warranty_service' ? 'active' : ''}`}
                  onClick={() => setMapFilter('warranty_service')}
                >
                  Гарантийное обслуживание ({objects.filter(obj => obj.status === 'warranty_service').length})
                </button>
              </div>
            </div>

            <div className="map-container">
              {mapLoading && (
                <div className="map-loading-overlay">
                  <div className="map-loading-spinner">
                    <div className="spinner"></div>
                    <p>Загрузка карты...</p>
                  </div>
                </div>
              )}
              <div id="yandex-map" className="yandex-map"></div>
              <div className="map-info">
                <p className="map-hint">
                  💡 Нажмите на метку, чтобы увидеть подробную информацию об объекте
                </p>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowMapModal(false)}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ObjectsPage
