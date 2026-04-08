import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import '../components/GeneralInfo.css'

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [objects, setObjects] = useState([])
  const [userProfiles, setUserProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [showContactModal, setShowContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState(null)

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
  }, [])

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
        <h2>Контакты сотрудников</h2>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="section-content">
          {/* Сотрудники ОСП (из профилей) */}
          {userProfiles.length > 0 && (
            <>
              <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                Сотрудники ОСП ({userProfiles.length})
              </h3>
              <div className="table-container" style={{ marginBottom: '1.5rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>УН</th>
                      <th>ФИО</th>
                      <th>Должность</th>
                      <th>Рабочий телефон</th>
                      <th>Рабочая почта</th>
                      <th>Email аккаунта</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userProfiles.map((profile, idx) => (
                      <tr key={idx}>
                        <td style={{ fontFamily: 'Consolas, Monaco, monospace', fontWeight: 700, color: 'var(--primary-color)', textAlign: 'center', width: '40px' }}>{idx + 1}</td>
                        <td style={{ fontWeight: 500 }}>{profile.full_name || <span style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>Не указано</span>}</td>
                        <td>{ROLE_LABELS[profile.role] || profile.role}</td>
                        <td>{profile.work_phone || <span style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>—</span>}</td>
                        <td>{profile.work_email || <span style={{ color: 'var(--text-tertiary)', opacity: 0.5 }}>—</span>}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{profile.email || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Контакты на объектах */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Контакты на объектах ({contacts.length})
            </h3>
            <button className="btn-primary" onClick={handleAddNewContact}>
              + Добавить контакт
            </button>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Должность</th>
                  <th>Телефон</th>
                  <th>Email</th>
                  <th>Объект</th>
                  <th className="actions-column">Действия</th>
                </tr>
              </thead>
              <tbody>
                {contacts.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="no-data">
                      Нет контактов. Добавьте первый контакт.
                    </td>
                  </tr>
                ) : (
                  contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td>{contact.full_name}</td>
                      <td>{contact.position}</td>
                      <td>{contact.phone}</td>
                      <td>{contact.email}</td>
                      <td>{contact.objects?.name || 'Офис'}</td>
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
                )}
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
                      setContactFormData({ ...contactFormData, phone: e.target.value })
                    }
                    required
                    placeholder="+7 (999) 123-45-67"
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
    </div>
  )
}

export default ContactsPage
