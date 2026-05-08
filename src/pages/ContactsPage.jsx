import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { formatPhone } from '../utils/phoneFormat'
import '../components/GeneralInfo.css'

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [objects, setObjects] = useState([])
  const [userProfiles, setUserProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [showContactModal, setShowContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [objectFilter, setObjectFilter] = useState('') // '' | 'office' | objectId
  const [activeTab, setActiveTab] = useState('contacts') // 'contacts' | 'departments'

  // --- Departments ---
  const [departments, setDepartments] = useState([])
  const [showDeptModal, setShowDeptModal] = useState(false)
  const [editingDept, setEditingDept] = useState(null)
  const [deptForm, setDeptForm] = useState({ name: '', description: '' })

  const [contactFormData, setContactFormData] = useState({
    full_name: '',
    position: '',
    phone: '',
    email: '',
    object_id: '',
  })
  const [isCustomPosition, setIsCustomPosition] = useState(false)

  const defaultPositions = ['Руководитель', 'Экономист', 'Старший инженер', 'Инженер', 'Прораб']

  // Собираем уникальные должности из существующих контактов + дефолтные
  const allPositions = [...new Set([
    ...defaultPositions,
    ...contacts.map(c => c.position).filter(Boolean)
  ])].sort()

  useEffect(() => {
    fetchContacts()
    fetchObjects()
    fetchUserProfiles()
    fetchDepartments()
  }, [])

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
        .select('*, objects(name)')
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

  const fetchUserProfiles = async () => {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('full_name, role, work_phone, work_email, email, is_approved')
        .eq('is_approved', true)
        .order('created_at', { ascending: true })

      if (error) throw error
      setUserProfiles(data || [])
    } catch (err) {
      console.error('Ошибка загрузки профилей:', err.message)
    }
  }

  const ROLE_LABELS = {
    admin: 'Администратор',
    engineer: 'Инженер ОСП',
    economist: 'Экономист ОСП',
    lawyer: 'Юрист ОСП'
  }

  const handleContactSubmit = async (e) => {
    e.preventDefault()
    try {
      // Преобразуем пустую строку в null для object_id
      const dataToSave = {
        ...contactFormData,
        object_id: contactFormData.object_id || null
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
      phone: contact.phone,
      email: contact.email || '',
      object_id: contact.object_id || '',
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

  const handleAddNewContact = () => {
    setEditingContact(null)
    setIsCustomPosition(false)
    setContactFormData({
      full_name: '',
      position: '',
      phone: '',
      email: '',
      object_id: '',
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
            <select
              className="contacts-object-filter"
              value={objectFilter}
              onChange={(e) => setObjectFilter(e.target.value)}
              title="Фильтр по объекту/офису"
            >
              <option value="">Все объекты/офис</option>
              <option value="office">Только офис</option>
              {objects.map(obj => (
                <option key={obj.id} value={obj.id}>{obj.name}</option>
              ))}
            </select>
            <button className="btn-primary" onClick={handleAddNewContact}>
              + Добавить
            </button>
          </div>

          <div className="table-container">
            <table className="data-table contacts-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>№</th>
                  <th>ФИО</th>
                  <th>Должность</th>
                  <th>Телефон</th>
                  <th>Email</th>
                  <th style={{ width: '220px' }}>Объект/Офис</th>
                  <th style={{ width: '72px' }}></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const q = searchQuery.trim().toLowerCase()
                  const matchesProfile = (p) => {
                    if (!q) return true
                    return [
                      p.full_name,
                      ROLE_LABELS[p.role] || p.role,
                      p.work_phone,
                      p.work_email || p.email,
                    ].some(v => v && String(v).toLowerCase().includes(q))
                  }
                  const matchesContact = (c) => {
                    if (!q) return true
                    return [
                      c.full_name,
                      c.position,
                      c.phone,
                      c.email,
                      c.objects?.name,
                    ].some(v => v && String(v).toLowerCase().includes(q))
                  }
                  // Профили из user_roles считаются «офисными»: object_id у них всегда null.
                  const profileMatchesObject = () =>
                    objectFilter === '' || objectFilter === 'office'
                  const contactMatchesObject = (c) => {
                    if (!objectFilter) return true
                    if (objectFilter === 'office') return !c.object_id
                    return c.object_id === objectFilter
                  }
                  const filteredProfiles = userProfiles
                    .filter(p => p.full_name && !contacts.some(c => c.full_name?.toLowerCase() === p.full_name.toLowerCase()))
                    .filter(matchesProfile)
                    .filter(profileMatchesObject)
                  const uniqueContacts = contacts
                    .filter((contact, index, self) =>
                      index === self.findIndex(c => c.full_name?.toLowerCase() === contact.full_name?.toLowerCase())
                    )
                    .filter(matchesContact)
                    .filter(contactMatchesObject)
                  return (
                    <>
                      {/* Профили из user_roles, которых нет в contacts */}
                      {filteredProfiles.map((profile, idx) => (
                        <tr key={`profile-${idx}`} className="profile-row">
                          <td className="num-cell">{idx + 1}</td>
                          <td>{profile.full_name}</td>
                          <td className="muted">{ROLE_LABELS[profile.role] || profile.role}</td>
                          <td>{profile.work_phone || '—'}</td>
                          <td>{profile.work_email || profile.email || '—'}</td>
                          <td className="muted">Офис</td>
                          <td></td>
                        </tr>
                      ))}
                      {/* Контакты из таблицы contacts (без дублей) */}
                      {uniqueContacts.map((contact, idx) => (
                        <tr key={contact.id}>
                          <td className="num-cell">{filteredProfiles.length + idx + 1}</td>
                          <td>{contact.full_name}</td>
                          <td className="muted">{contact.position}</td>
                          <td>{contact.phone}</td>
                          <td>{contact.email}</td>
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
                      ))}
                    </>
                  )
                })()}
                {(() => {
                  if (userProfiles.length === 0 && contacts.length === 0) {
                    return (
                      <tr>
                        <td colSpan="7" className="no-data">
                          Нет контактов. Добавьте первый контакт.
                        </td>
                      </tr>
                    )
                  }
                  const q = searchQuery.trim().toLowerCase()
                  if (!q && !objectFilter) return null
                  const profileFilter = (p) => {
                    if (!p.full_name) return false
                    if (contacts.some(c => c.full_name?.toLowerCase() === p.full_name.toLowerCase())) return false
                    if (objectFilter && objectFilter !== 'office') return false
                    if (q && ![p.full_name, ROLE_LABELS[p.role] || p.role, p.work_phone, p.work_email || p.email]
                      .some(v => v && String(v).toLowerCase().includes(q))) return false
                    return true
                  }
                  const contactFilter = (c) => {
                    if (objectFilter === 'office' && c.object_id) return false
                    if (objectFilter && objectFilter !== 'office' && c.object_id !== objectFilter) return false
                    if (q && ![c.full_name, c.position, c.phone, c.email, c.objects?.name]
                      .some(v => v && String(v).toLowerCase().includes(q))) return false
                    return true
                  }
                  if (!userProfiles.some(profileFilter) && !contacts.some(contactFilter)) {
                    return (
                      <tr>
                        <td colSpan="7" className="no-data">
                          Ничего не найдено{q && ` по запросу «${searchQuery}»`}
                        </td>
                      </tr>
                    )
                  }
                  return null
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal для добавления/редактирования контакта */}
      {showContactModal && (
        <div className="modal-overlay" onClick={() => setShowContactModal(false)}>
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
                  <label>Телефон *</label>
                  <input
                    type="tel"
                    value={contactFormData.phone}
                    onChange={(e) =>
                      setContactFormData({ ...contactFormData, phone: formatPhone(e.target.value) })
                    }
                    required
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
        <div className="modal-overlay" onClick={() => setShowDeptModal(false)}>
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
    </div>
  )
}

export default ContactsPage
