import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { formatPhone } from '../utils/phoneFormat'
import '../components/GeneralInfo.css'

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [objects, setObjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showContactModal, setShowContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [objectFilter, setObjectFilter] = useState('') // '' | 'office' | objectId
  const [activeTab, setActiveTab] = useState('contacts') // 'contacts' | 'departments' | 'positions'

  // --- Departments ---
  const [departments, setDepartments] = useState([])
  const [showDeptModal, setShowDeptModal] = useState(false)
  const [editingDept, setEditingDept] = useState(null)
  const [deptForm, setDeptForm] = useState({ name: '', description: '' })

  // --- Positions (должности) ---
  const [positions, setPositions] = useState([])
  const [showPosModal, setShowPosModal] = useState(false)
  const [editingPos, setEditingPos] = useState(null)
  const [posForm, setPosForm] = useState({ name: '', description: '' })

  const [contactFormData, setContactFormData] = useState({
    full_name: '',
    position: '',
    phone: '',
    email: '',
    object_id: '',
    department_id: '',
    notes: '',
  })
  const [isCustomPosition, setIsCustomPosition] = useState(false)

  const defaultPositions = ['Руководитель', 'Экономист', 'Старший инженер', 'Инженер', 'Прораб']

  // Собираем уникальные должности: справочник positions + использованные в контактах + дефолтные
  const allPositions = [...new Set([
    ...defaultPositions,
    ...positions.map(p => p.name),
    ...contacts.map(c => c.position).filter(Boolean)
  ])].sort()

  useEffect(() => {
    fetchContacts()
    fetchObjects()
    fetchDepartments()
    fetchPositions()
  }, [])

  const fetchPositions = async () => {
    try {
      const { data, error } = await supabase
        .from('positions')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      setPositions(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить справочник должностей (таблица positions?):', err.message)
      setPositions([])
    }
  }

  const handleOpenAddPos = () => {
    setEditingPos(null)
    setPosForm({ name: '', description: '' })
    setShowPosModal(true)
  }

  const handleOpenEditPos = (pos) => {
    setEditingPos(pos)
    setPosForm({ name: pos.name, description: pos.description || '' })
    setShowPosModal(true)
  }

  const handleSubmitPos = async (e) => {
    e.preventDefault()
    const name = posForm.name.trim()
    if (!name) {
      alert('Укажите название должности')
      return
    }
    const payload = {
      name,
      description: posForm.description.trim() || null,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editingPos) {
        const { error } = await supabase
          .from('positions')
          .update(payload)
          .eq('id', editingPos.id)
        if (error) throw error
        // Если у должности было старое имя — обновим всех contacts с этим position
        if (editingPos.name !== name) {
          await supabase
            .from('contacts')
            .update({ position: name })
            .eq('position', editingPos.name)
        }
      } else {
        const { error } = await supabase.from('positions').insert([payload])
        if (error) throw error
      }
      setShowPosModal(false)
      setEditingPos(null)
      setPosForm({ name: '', description: '' })
      fetchPositions()
      fetchContacts()
    } catch (err) {
      if (err.code === '23505') {
        alert('Должность с таким названием уже существует')
      } else {
        alert('Ошибка сохранения должности: ' + err.message)
      }
    }
  }

  const handleDeletePos = async (pos) => {
    const used = contacts.filter(c => c.position === pos.name).length
    const msg = used > 0
      ? `Должность «${pos.name}» используется у ${used} сотрудник(ов). Удалить из справочника? У сотрудников значение останется текстом.`
      : `Удалить должность «${pos.name}»?`
    if (!window.confirm(msg)) return
    try {
      const { error } = await supabase.from('positions').delete().eq('id', pos.id)
      if (error) throw error
      fetchPositions()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  const fetchDepartments = async () => {
    try {
      const { data, error } = await supabase
        .from('departments')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      setDepartments(data || [])
    } catch (err) {
      console.error('Ошибка загрузки отделов:', err.message)
    }
  }

  const handleOpenAddDept = () => {
    setEditingDept(null)
    setDeptForm({ name: '', description: '' })
    setShowDeptModal(true)
  }

  const handleOpenEditDept = (dept) => {
    setEditingDept(dept)
    setDeptForm({ name: dept.name, description: dept.description || '' })
    setShowDeptModal(true)
  }

  const handleSubmitDept = async (e) => {
    e.preventDefault()
    const name = deptForm.name.trim()
    if (!name) {
      alert('Укажите название отдела')
      return
    }
    const payload = {
      name,
      description: deptForm.description.trim() || null,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editingDept) {
        const { error } = await supabase
          .from('departments')
          .update(payload)
          .eq('id', editingDept.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('departments').insert([payload])
        if (error) throw error
      }
      setShowDeptModal(false)
      setEditingDept(null)
      setDeptForm({ name: '', description: '' })
      fetchDepartments()
    } catch (err) {
      if (err.code === '23505') {
        alert('Отдел с таким названием уже существует')
      } else {
        console.error('Ошибка сохранения отдела:', err.message)
        alert('Ошибка: ' + err.message)
      }
    }
  }

  const handleDeleteDept = async (dept) => {
    if (!window.confirm(`Удалить отдел «${dept.name}»?`)) return
    try {
      const { error } = await supabase.from('departments').delete().eq('id', dept.id)
      if (error) throw error
      setDepartments(prev => prev.filter(d => d.id !== dept.id))
    } catch (err) {
      console.error('Ошибка удаления отдела:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const fetchContacts = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('contacts')
        .select('*, objects(name), departments(id, name)')
        .order('full_name', { ascending: true })

      if (error) throw error
      setContacts(data || [])
    } catch (error) {
      console.error('Ошибка загрузки контактов:', error.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchObjects = async () => {
    try {
      const { data, error } = await supabase
        .from('objects')
        .select('*')
        .order('name', { ascending: true })

      if (error) throw error
      setObjects(data || [])
    } catch (error) {
      console.error('Ошибка загрузки объектов:', error.message)
    }
  }

  const handleContactSubmit = async (e) => {
    e.preventDefault()
    try {
      // Преобразуем пустые строки в null для FK-полей и для необязательных текстовых полей
      const dataToSave = {
        ...contactFormData,
        object_id: contactFormData.object_id || null,
        department_id: contactFormData.department_id || null,
        phone: contactFormData.phone?.trim() || null,
        notes: contactFormData.notes?.trim() || null,
      }

      if (editingContact) {
        const { error } = await supabase
          .from('contacts')
          .update(dataToSave)
          .eq('id', editingContact.id)

        if (error) throw error
      } else {
        const { error } = await supabase.from('contacts').insert([dataToSave])
        if (error) throw error
      }

      setShowContactModal(false)
      setEditingContact(null)
      setContactFormData({
        full_name: '',
        position: '',
        phone: '',
        email: '',
        object_id: '',
        department_id: '',
        notes: '',
      })
      fetchContacts()
    } catch (error) {
      console.error('Ошибка сохранения контакта:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditContact = (contact) => {
    setEditingContact(contact)
    const knownPosition = allPositions.includes(contact.position)
    setIsCustomPosition(!knownPosition)
    setContactFormData({
      full_name: contact.full_name,
      position: contact.position,
      phone: contact.phone || '',
      email: contact.email || '',
      object_id: contact.object_id || '',
      department_id: contact.department_id || '',
      notes: contact.notes || '',
    })
    setShowContactModal(true)
  }

  const handleDeleteContact = async (id, name) => {
    if (window.confirm(`Вы уверены, что хотите удалить контакт "${name}"?`)) {
      try {
        const { error } = await supabase.from('contacts').delete().eq('id', id)
        if (error) throw error
        fetchContacts()
      } catch (error) {
        console.error('Ошибка удаления контакта:', error.message)
        alert('Ошибка удаления: ' + error.message)
      }
    }
  }

  const handleInlineObjectChange = async (contactId, newObjectId) => {
    const value = newObjectId || null
    try {
      const { error } = await supabase
        .from('contacts')
        .update({ object_id: value })
        .eq('id', contactId)
      if (error) throw error
      const newObj = value ? objects.find(o => o.id === value) : null
      setContacts(prev => prev.map(c =>
        c.id === contactId
          ? { ...c, object_id: value, objects: newObj ? { name: newObj.name } : null }
          : c
      ))
    } catch (err) {
      console.error('Ошибка изменения объекта:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleInlineDepartmentChange = async (contactId, newDeptId) => {
    const value = newDeptId || null
    try {
      const { error } = await supabase
        .from('contacts')
        .update({ department_id: value })
        .eq('id', contactId)
      if (error) throw error
      const newDept = value ? departments.find(d => d.id === value) : null
      setContacts(prev => prev.map(c =>
        c.id === contactId
          ? { ...c, department_id: value, departments: newDept ? { id: newDept.id, name: newDept.name } : null }
          : c
      ))
    } catch (err) {
      console.error('Ошибка изменения отдела:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleInlinePositionChange = async (contactId, newPosition) => {
    const value = newPosition?.trim() || null
    try {
      const { error } = await supabase
        .from('contacts')
        .update({ position: value })
        .eq('id', contactId)
      if (error) throw error
      setContacts(prev => prev.map(c =>
        c.id === contactId ? { ...c, position: value } : c
      ))
    } catch (err) {
      console.error('Ошибка изменения должности:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleInlineNotesChange = async (contactId, newNotes) => {
    const value = newNotes?.trim() || null
    try {
      const { error } = await supabase
        .from('contacts')
        .update({ notes: value })
        .eq('id', contactId)
      if (error) throw error
      setContacts(prev => prev.map(c =>
        c.id === contactId ? { ...c, notes: value } : c
      ))
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleAddNewContact = () => {
    setEditingContact(null)
    setIsCustomPosition(false)
    setContactFormData({
      full_name: '',
      position: '',
      phone: '',
      email: '',
      object_id: '',
      department_id: '',
      notes: '',
    })
    setShowContactModal(true)
  }

  return (
    <div className="general-info">
      <div className="general-info-header">
        <h2>Контактные данные сотрудников</h2>
      </div>

      <div className="contacts-tabs">
        <button
          className={`contacts-tab ${activeTab === 'contacts' ? 'active' : ''}`}
          onClick={() => setActiveTab('contacts')}
        >
          Сотрудники
        </button>
        <button
          className={`contacts-tab ${activeTab === 'departments' ? 'active' : ''}`}
          onClick={() => setActiveTab('departments')}
        >
          Отделы
          {departments.length > 0 && <span className="contacts-tab-count">{departments.length}</span>}
        </button>
        <button
          className={`contacts-tab ${activeTab === 'positions' ? 'active' : ''}`}
          onClick={() => setActiveTab('positions')}
        >
          Должности
          {positions.length > 0 && <span className="contacts-tab-count">{positions.length}</span>}
        </button>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : activeTab === 'departments' ? (
        <div className="section-content">
          <div className="section-actions contacts-toolbar">
            <button className="btn-primary" onClick={handleOpenAddDept}>
              + Добавить отдел
            </button>
          </div>
          <div className="table-container">
            <table className="data-table contacts-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>№</th>
                  <th>Название отдела</th>
                  <th>Описание</th>
                  <th style={{ width: '72px' }}></th>
                </tr>
              </thead>
              <tbody>
                {departments.length === 0 ? (
                  <tr>
                    <td colSpan="4" className="no-data">
                      Отделов нет. Добавьте первый отдел.
                    </td>
                  </tr>
                ) : (
                  departments.map((dept, idx) => (
                    <tr key={dept.id}>
                      <td className="num-cell">{idx + 1}</td>
                      <td>{dept.name}</td>
                      <td className="muted">{dept.description || '—'}</td>
                      <td className="actions-cell">
                        <button
                          className="btn-icon btn-edit"
                          onClick={() => handleOpenEditDept(dept)}
                          title="Редактировать"
                        >✏️</button>
                        <button
                          className="btn-icon btn-delete"
                          onClick={() => handleDeleteDept(dept)}
                          title="Удалить"
                        >🗑️</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeTab === 'positions' ? (
        <div className="section-content">
          <div className="section-actions contacts-toolbar">
            <button className="btn-primary" onClick={handleOpenAddPos}>
              + Добавить должность
            </button>
          </div>
          <div className="table-container">
            <table className="data-table contacts-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>№</th>
                  <th>Название должности</th>
                  <th>Описание</th>
                  <th style={{ width: '120px', textAlign: 'right' }}>Сотрудников</th>
                  <th style={{ width: '72px' }}></th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="no-data">
                      Должностей нет. Добавьте первую должность.
                    </td>
                  </tr>
                ) : (
                  positions.map((pos, idx) => {
                    const used = contacts.filter(c => c.position === pos.name).length
                    return (
                      <tr key={pos.id}>
                        <td className="num-cell">{idx + 1}</td>
                        <td>{pos.name}</td>
                        <td className="muted">{pos.description || '—'}</td>
                        <td className="num-cell">{used}</td>
                        <td className="actions-cell">
                          <button
                            className="btn-icon btn-edit"
                            onClick={() => handleOpenEditPos(pos)}
                            title="Редактировать"
                          >✏️</button>
                          <button
                            className="btn-icon btn-delete"
                            onClick={() => handleDeletePos(pos)}
                            title="Удалить"
                          >🗑️</button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="section-content">
          <div className="section-actions contacts-toolbar">
            <input
              type="search"
              className="contacts-search"
              placeholder="🔍 Поиск по ФИО, должности, телефону, email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="contacts-filter-pills" role="tablist" aria-label="Фильтр по объекту/офису">
              <button
                type="button"
                role="tab"
                aria-selected={objectFilter === ''}
                className={`contacts-filter-pill ${objectFilter === '' ? 'active' : ''}`}
                onClick={() => setObjectFilter('')}
              >
                <span className="contacts-filter-pill-icon" aria-hidden>📋</span>
                <span>Все</span>
                <span className="contacts-filter-pill-count">{contacts.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={objectFilter === 'office'}
                className={`contacts-filter-pill ${objectFilter === 'office' ? 'active' : ''}`}
                onClick={() => setObjectFilter('office')}
              >
                <span className="contacts-filter-pill-icon" aria-hidden>🏢</span>
                <span>Офис</span>
                <span className="contacts-filter-pill-count">
                  {contacts.filter(c => !c.object_id).length}
                </span>
              </button>
              <div className={`contacts-filter-object-wrap ${objectFilter && objectFilter !== 'office' ? 'active' : ''}`}>
                <span className="contacts-filter-pill-icon" aria-hidden>🏗️</span>
                <select
                  className="contacts-filter-object-select"
                  value={objectFilter && objectFilter !== 'office' ? objectFilter : ''}
                  onChange={(e) => setObjectFilter(e.target.value || '')}
                  title="Выбрать объект"
                >
                  <option value="">Объект…</option>
                  {objects.map(obj => {
                    const cnt = contacts.filter(c => c.object_id === obj.id).length
                    return (
                      <option key={obj.id} value={obj.id}>{obj.name} ({cnt})</option>
                    )
                  })}
                </select>
              </div>
            </div>
            <button className="btn-primary" onClick={handleAddNewContact}>
              + Добавить
            </button>
          </div>

          <div className="table-container">
            <table className="data-table contacts-table people-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>№</th>
                  <th style={{ width: '180px' }}>ФИО</th>
                  <th style={{ width: '190px' }}>Объект/Офис</th>
                  <th style={{ width: '230px' }}>Должность</th>
                  <th style={{ width: '150px' }}>Отдел</th>
                  <th style={{ width: '140px' }}>Телефон</th>
                  <th style={{ width: '170px' }}>Email</th>
                  <th>Примечания</th>
                  <th style={{ width: '64px' }}></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const q = searchQuery.trim().toLowerCase()
                  const matchesContact = (c) => {
                    if (!q) return true
                    return [
                      c.full_name,
                      c.position,
                      c.phone,
                      c.email,
                      c.objects?.name,
                      c.departments?.name,
                    ].some(v => v && String(v).toLowerCase().includes(q))
                  }
                  const contactMatchesObject = (c) => {
                    if (!objectFilter) return true
                    if (objectFilter === 'office') return !c.object_id
                    return c.object_id === objectFilter
                  }
                  const visibleContacts = contacts
                    .filter(matchesContact)
                    .filter(contactMatchesObject)
                  if (contacts.length === 0) {
                    return (
                      <tr>
                        <td colSpan="9" className="no-data" style={{ textAlign: 'center' }}>
                          Нет контактов. Добавьте первый контакт.
                        </td>
                      </tr>
                    )
                  }
                  if (visibleContacts.length === 0) {
                    return (
                      <tr>
                        <td colSpan="9" className="no-data" style={{ textAlign: 'center' }}>
                          Ничего не найдено{q && ` по запросу «${searchQuery}»`}
                        </td>
                      </tr>
                    )
                  }
                  return visibleContacts.map((contact, idx) => (
                    <tr key={contact.id}>
                      <td className="num-cell">{idx + 1}</td>
                      <td>{contact.full_name}</td>
                      <td>
                        <select
                          className="inline-object-select"
                          value={contact.object_id || ''}
                          onChange={(e) => handleInlineObjectChange(contact.id, e.target.value)}
                          title="Привязать к объекту или оставить «Офис»"
                        >
                          <option value="">Офис</option>
                          {objects.map(obj => (
                            <option key={obj.id} value={obj.id}>{obj.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className="inline-object-select"
                          value={contact.position || ''}
                          onChange={(e) => handleInlinePositionChange(contact.id, e.target.value)}
                          title={contact.position || 'Должность сотрудника'}
                        >
                          <option value="">— не указана —</option>
                          {allPositions.map(pos => (
                            <option key={pos} value={pos}>{pos}</option>
                          ))}
                          {/* Если у контакта установлена должность, которой нет в справочнике — показываем как опцию */}
                          {contact.position && !allPositions.includes(contact.position) && (
                            <option value={contact.position}>{contact.position}</option>
                          )}
                        </select>
                      </td>
                      <td>
                        <select
                          className="inline-object-select"
                          value={contact.department_id || ''}
                          onChange={(e) => handleInlineDepartmentChange(contact.id, e.target.value)}
                          title="Отдел сотрудника"
                        >
                          <option value="">— не указан —</option>
                          {departments.map(dept => (
                            <option key={dept.id} value={dept.id}>{dept.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>{contact.phone || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>—</span>}</td>
                      <td>{contact.email}</td>
                      <td>
                        <textarea
                          ref={(el) => {
                            if (el) {
                              el.style.height = 'auto'
                              el.style.height = Math.max(el.scrollHeight, 32) + 'px'
                            }
                          }}
                          defaultValue={contact.notes || ''}
                          onInput={(e) => {
                            e.target.style.height = 'auto'
                            e.target.style.height = Math.max(e.target.scrollHeight, 32) + 'px'
                          }}
                          onBlur={(e) => {
                            const next = e.target.value
                            if ((contact.notes || '') !== next) {
                              handleInlineNotesChange(contact.id, next)
                            }
                          }}
                          placeholder="Примечание…"
                          rows={1}
                          className="contact-notes-input"
                        />
                      </td>
                      <td className="actions-cell">
                        <button
                          className="btn-icon btn-edit"
                          onClick={() => handleEditContact(contact)}
                          title="Редактировать"
                        >
                          ✏️
                        </button>
                        <button
                          className="btn-icon btn-delete"
                          onClick={() => handleDeleteContact(contact.id, contact.full_name)}
                          title="Удалить"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal для добавления/редактирования контакта */}
      {showContactModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingContact ? 'Редактировать контакт' : 'Добавить новый контакт'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowContactModal(false)
                  setEditingContact(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleContactSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>ФИО *</label>
                  <input
                    type="text"
                    value={contactFormData.full_name}
                    onChange={(e) =>
                      setContactFormData({
                        ...contactFormData,
                        full_name: e.target.value,
                      })
                    }
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Должность *</label>
                  {isCustomPosition ? (
                    <div className="input-with-action">
                      <input
                        type="text"
                        value={contactFormData.position}
                        onChange={(e) =>
                          setContactFormData({
                            ...contactFormData,
                            position: e.target.value,
                          })
                        }
                        required
                        placeholder="Введите должность"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => {
                          setIsCustomPosition(false)
                          setContactFormData({ ...contactFormData, position: '' })
                        }}
                        title="Выбрать из списка"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="input-with-action">
                      <select
                        value={contactFormData.position}
                        onChange={(e) =>
                          setContactFormData({
                            ...contactFormData,
                            position: e.target.value,
                          })
                        }
                        required
                      >
                        <option value="">Выберите должность</option>
                        {allPositions.map(pos => (
                          <option key={pos} value={pos}>{pos}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => {
                          setIsCustomPosition(true)
                          setContactFormData({ ...contactFormData, position: '' })
                        }}
                        title="Добавить новую должность"
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label>Отдел</label>
                  <select
                    value={contactFormData.department_id}
                    onChange={(e) =>
                      setContactFormData({
                        ...contactFormData,
                        department_id: e.target.value,
                      })
                    }
                  >
                    <option value="">— не указан —</option>
                    {departments.map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Объект</label>
                  <select
                    value={contactFormData.object_id}
                    onChange={(e) =>
                      setContactFormData({
                        ...contactFormData,
                        object_id: e.target.value,
                      })
                    }
                  >
                    <option value="">Офис</option>
                    {objects.map((obj) => (
                      <option key={obj.id} value={obj.id}>
                        {obj.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Телефон</label>
                  <input
                    type="tel"
                    value={contactFormData.phone}
                    onChange={(e) =>
                      setContactFormData({ ...contactFormData, phone: formatPhone(e.target.value) })
                    }
                    placeholder="+7(916)712-69-10"
                  />
                </div>

                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={contactFormData.email}
                    onChange={(e) =>
                      setContactFormData({ ...contactFormData, email: e.target.value })
                    }
                    placeholder="email@example.com"
                  />
                </div>

                <div className="form-group full-width">
                  <label>Примечания</label>
                  <textarea
                    value={contactFormData.notes}
                    onChange={(e) =>
                      setContactFormData({ ...contactFormData, notes: e.target.value })
                    }
                    rows={3}
                    placeholder="Произвольное примечание (необязательно)"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowContactModal(false)
                    setEditingContact(null)
                  }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingContact ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: добавление/редактирование отдела */}
      {showDeptModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h3>{editingDept ? 'Редактировать отдел' : 'Новый отдел'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowDeptModal(false); setEditingDept(null) }}
              >×</button>
            </div>
            <form onSubmit={handleSubmitDept}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Название отдела *</label>
                  <input
                    type="text"
                    value={deptForm.name}
                    onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
                    required
                    autoFocus
                    placeholder="Например, Отдел сопровождения подрядчиков"
                  />
                </div>
                <div className="form-group full-width">
                  <label>Описание</label>
                  <textarea
                    value={deptForm.description}
                    onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
                    rows={3}
                    placeholder="Краткое описание отдела (необязательно)"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowDeptModal(false); setEditingDept(null) }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingDept ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: добавление/редактирование должности */}
      {showPosModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h3>{editingPos ? 'Редактировать должность' : 'Новая должность'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowPosModal(false); setEditingPos(null) }}
              >×</button>
            </div>
            <form onSubmit={handleSubmitPos}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Название должности *</label>
                  <input
                    type="text"
                    value={posForm.name}
                    onChange={(e) => setPosForm({ ...posForm, name: e.target.value })}
                    required
                    autoFocus
                    placeholder="Например, Инженер ОСП"
                  />
                </div>
                <div className="form-group full-width">
                  <label>Описание</label>
                  <textarea
                    value={posForm.description}
                    onChange={(e) => setPosForm({ ...posForm, description: e.target.value })}
                    rows={3}
                    placeholder="Краткое описание должности (необязательно)"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowPosModal(false); setEditingPos(null) }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingPos ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default ContactsPage
