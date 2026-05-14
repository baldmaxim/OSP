import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { formatPhone } from '../utils/phoneFormat'
import './GeneralInfo.css'

function GeneralInfo() {
  const [activeSection, setActiveSection] = useState('objects')
  const [objects, setObjects] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showObjectModal, setShowObjectModal] = useState(false)
  const [showContactModal, setShowContactModal] = useState(false)

  const [objectFormData, setObjectFormData] = useState({
    name: '',
    address: '',
    description: '',
  })

  const [contactFormData, setContactFormData] = useState({
    full_name: '',
    position: '',
    phone: '',
    email: '',
    object_id: '',
  })

  useEffect(() => {
    if (activeSection === 'objects') {
      fetchObjects()
    } else if (activeSection === 'contacts') {
      fetchContacts()
    }
  }, [activeSection])

  const fetchObjects = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('objects')
        .select('*')
        .order('name', { ascending: true })

      if (error) throw error
      setObjects(data || [])
    } catch (error) {
      console.error('Ошибка загрузки объектов:', error.message)
    } finally {
      setLoading(false)
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

  const handleObjectSubmit = async (e) => {
    e.preventDefault()
    try {
      const { error } = await supabase.from('objects').insert([objectFormData])

      if (error) throw error

      setShowObjectModal(false)
      setObjectFormData({ name: '', address: '', description: '' })
      fetchObjects()
    } catch (error) {
      console.error('Ошибка добавления объекта:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleContactSubmit = async (e) => {
    e.preventDefault()
    try {
      const { error } = await supabase.from('contacts').insert([contactFormData])

      if (error) throw error

      setShowContactModal(false)
      setContactFormData({
        full_name: '',
        position: '',
        phone: '',
        email: '',
        object_id: '',
      })
      fetchContacts()
    } catch (error) {
      console.error('Ошибка добавления контакта:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const getSectionTitle = () => {
    switch (activeSection) {
      case 'objects':
        return 'Объекты'
      case 'contacts':
        return 'Контакты сотрудников'
      default:
        return 'Общая информация'
    }
  }

  return (
    <div className="general-info">
      <div className="general-info-header">
        <h2>{getSectionTitle()}</h2>
      </div>

      <div className="section-tabs">
        <button
          className={`section-tab ${activeSection === 'objects' ? 'active' : ''}`}
          onClick={() => setActiveSection('objects')}
        >
          Объекты
        </button>
        <button
          className={`section-tab ${activeSection === 'contacts' ? 'active' : ''}`}
          onClick={() => setActiveSection('contacts')}
        >
          Контакты сотрудников
        </button>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <>
          {activeSection === 'objects' && (
            <div className="section-content">
              <div className="section-actions">
                <button
                  className="btn-primary"
                  onClick={() => setShowObjectModal(true)}
                >
                  + Добавить объект
                </button>
              </div>

              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Название объекта</th>
                      <th>Адрес</th>
                      <th>Описание</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objects.length === 0 ? (
                      <tr>
                        <td colSpan="3" className="no-data">
                          Нет объектов. Добавьте первый объект.
                        </td>
                      </tr>
                    ) : (
                      objects.map((object) => (
                        <tr key={object.id}>
                          <td>{object.name}</td>
                          <td>{object.address}</td>
                          <td>{object.description}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeSection === 'contacts' && (
            <div className="section-content">
              <div className="section-actions">
                <button
                  className="btn-primary"
                  onClick={() => setShowContactModal(true)}
                >
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
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="no-data">
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
                          <td>{contact.objects?.name || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Modal для добавления объекта */}
      {showObjectModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Добавить новый объект</h3>
              <button
                className="modal-close"
                onClick={() => setShowObjectModal(false)}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleObjectSubmit}>
              <div className="form-grid">
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
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowObjectModal(false)}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal для добавления контакта */}
      {showContactModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Добавить новый контакт</h3>
              <button
                className="modal-close"
                onClick={() => setShowContactModal(false)}
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
                    <option value="Руководитель">Руководитель</option>
                    <option value="Экономист">Экономист</option>
                    <option value="Старший инженер">Старший инженер</option>
                    <option value="Инженер">Инженер</option>
                    <option value="Прораб">Прораб</option>
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
                    <option value="">Не привязан к объекту</option>
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
                  onClick={() => setShowContactModal(false)}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default GeneralInfo
