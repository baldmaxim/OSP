import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { formatPhone } from '../utils/phoneFormat'
import FilterDropdown from '../components/FilterDropdown'
import RowActionsMenu from '../components/RowActionsMenu'
import { useIsPhone } from '../hooks/useMediaQuery'
import '../components/GeneralInfo.css'
import '../components/MobileCards.css'

// Инициалы из ФИО (для нейтрального аватара — без фотографий).
const initials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

function ContactsPage() {
  const isPhone = useIsPhone()
  // task 333: гейт add/edit/delete и inline-editing для раздела «contacts».
  const { canEdit } = useRole()
  const canEditContacts = canEdit('contacts')
  const [contacts, setContacts] = useState([])
  const [objects, setObjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showContactModal, setShowContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Фильтры реестра сотрудников
  const [fLoc, setFLoc] = useState('all')      // 'all' | 'office' | 'object' — Офис / объект
  const [fObject, setFObject] = useState('')   // '' | objectId — конкретный объект
  const [fDept, setFDept] = useState('')       // '' | departmentId
  const [fPos, setFPos] = useState('')         // '' | название должности
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)
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

  // Снимаем шаблон «X и X» (исторические дубли в данных) → оставляем один X.
  const normalizePosition = (p) => {
    if (!p) return p
    return p.replace(/^(.+?)\s+и\s+\1$/i, '$1').trim()
  }

  // task 318: список должностей берём ТОЛЬКО из официального справочника
  // (таблица «positions»). Хардкод-дефолты и исторические значения из contacts.position
  // больше не подмешиваем — иначе в дропдауне всплывают опечатки/переименованные/
  // удалённые должности. Если у конкретного контакта стоит non-standard должность,
  // она дополнительно отрисовывается как отдельная option в селекте этого контакта.
  const allPositions = [...new Set(
    positions.map(p => normalizePosition(p.name)).filter(Boolean)
  )].sort()

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

  const resetEmpFilters = () => { setSearchQuery(''); setFLoc('all'); setFObject(''); setFDept(''); setFPos('') }
  const copyText = (t) => { if (t && navigator.clipboard) navigator.clipboard.writeText(t) }
  const empFiltersActive = Boolean(searchQuery || fLoc !== 'all' || fObject || fDept || fPos)

  // Сбрасываем страницу при смене фильтров/поиска/размера/вкладки.
  useEffect(() => { setPage(0) }, [searchQuery, fLoc, fObject, fDept, fPos, pageSize, activeTab])

  // Единая отфильтрованная выборка сотрудников (поиск + Офис/объект + Объект + Отдел + Должность).
  const visibleContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return contacts.filter(c => {
      if (q && ![c.full_name, c.position, c.phone, c.email, c.objects?.name, c.departments?.name, c.notes]
        .some(v => v && String(v).toLowerCase().includes(q))) return false
      if (fLoc === 'office' && c.object_id) return false
      if (fLoc === 'object' && !c.object_id) return false
      if (fObject && c.object_id !== fObject) return false
      if (fDept && c.department_id !== fDept) return false
      if (fPos && normalizePosition(c.position) !== fPos) return false
      return true
    })
  }, [contacts, searchQuery, fLoc, fObject, fDept, fPos])

  // Пагинация (клиентская): безопасная страница + срез.
  const empTotalPages = Math.max(1, Math.ceil(visibleContacts.length / pageSize))
  const empPage = Math.min(page, empTotalPages - 1)
  const empPageStart = visibleContacts.length === 0 ? 0 : empPage * pageSize
  const empPaged = visibleContacts.slice(empPageStart, empPageStart + pageSize)

  return (
    <div className="general-info">
      <div className="general-info-header emp-header">
        <div>
          <h2>Сотрудники СУ-10</h2>
          <div className="emp-subtitle">Внутренний реестр сотрудников отдела</div>
        </div>
        {canEditContacts && activeTab === 'contacts' && (
          <button className="btn-primary" onClick={handleAddNewContact}>+ Добавить сотрудника</button>
        )}
      </div>

      <div className="contacts-tabs">
        <button
          className={`contacts-tab ${activeTab === 'contacts' ? 'active' : ''}`}
          onClick={() => setActiveTab('contacts')}
        >
          Сотрудники
          {contacts.length > 0 && <span className="contacts-tab-count">{contacts.length}</span>}
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
            {/* task 333: add только при can_edit */}
            {canEditContacts && (
              <button className="btn-primary" onClick={handleOpenAddDept}>
                + Добавить отдел
              </button>
            )}
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
                        {canEditContacts && (
                          <>
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
                          </>
                        )}
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
            {canEditContacts && (
              <button className="btn-primary" onClick={handleOpenAddPos}>
                + Добавить должность
              </button>
            )}
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
                          {canEditContacts && (
                            <>
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
                            </>
                          )}
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
          {/* Summary: только Всего / Офис / Объекты */}
          <div className="emp-summary">
            <div className="emp-summary-card">
              <span className="emp-summary-ico" aria-hidden>👥</span>
              <div>
                <div className="emp-summary-val">{contacts.length}</div>
                <div className="emp-summary-label">Всего сотрудников</div>
              </div>
            </div>
            <div className="emp-summary-card">
              <span className="emp-summary-ico emp-ico-blue" aria-hidden>🏢</span>
              <div>
                <div className="emp-summary-val">{contacts.filter(c => !c.object_id).length}</div>
                <div className="emp-summary-label">Офис</div>
              </div>
            </div>
            <div className="emp-summary-card">
              <span className="emp-summary-ico emp-ico-green" aria-hidden>🏗️</span>
              <div>
                <div className="emp-summary-val">{contacts.filter(c => c.object_id).length}</div>
                <div className="emp-summary-label">Объекты</div>
              </div>
            </div>
          </div>

          {/* Поиск + кастомные фильтры (Офис / объект, Объект, Отдел, Должность) */}
          <div className="emp-filters">
            <input
              type="search"
              className="emp-search"
              placeholder="🔍 Поиск по ФИО, должности, телефону, email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <FilterDropdown
              label="Офис / объект"
              value={fLoc}
              onChange={(v) => { setFLoc(v); if (v === 'office') setFObject('') }}
              options={[
                { value: 'all', label: 'Все' },
                { value: 'office', label: 'Офис' },
                { value: 'object', label: 'Объект' },
              ]}
            />
            <FilterDropdown
              label="Объект"
              value={fObject}
              onChange={setFObject}
              disabled={fLoc === 'office'}
              searchable
              searchPlaceholder="🔍 Поиск объектов…"
              options={[{ value: '', label: 'Все' }, ...objects.map(o => ({ value: o.id, label: o.name }))]}
            />
            <FilterDropdown
              label="Отдел"
              value={fDept}
              onChange={setFDept}
              searchable
              searchPlaceholder="🔍 Поиск отделов…"
              options={[{ value: '', label: 'Все' }, ...departments.map(d => ({ value: d.id, label: d.name }))]}
            />
            <FilterDropdown
              label="Должность"
              value={fPos}
              onChange={setFPos}
              searchable
              searchPlaceholder="🔍 Поиск должностей…"
              options={[{ value: '', label: 'Все' }, ...allPositions.map(p => ({ value: p, label: p }))]}
            />
            {empFiltersActive && (
              <button type="button" className="emp-filter-reset" onClick={resetEmpFilters}>↺ Сбросить</button>
            )}
          </div>

          {isPhone && visibleContacts.length > 0 ? (
            <div className="mcard-list">
              {empPaged.map((contact) => {
                const loc = contact.object_id ? (contact.objects?.name || 'Объект') : 'Офис'
                const posName = normalizePosition(contact.position) || ''
                const deptName = contact.departments?.name || ''
                return (
                  <div
                    key={contact.id}
                    className="mcard is-tappable"
                    onClick={() => handleEditContact(contact)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleEditContact(contact) }}
                  >
                    <div className="mcard-head">
                      <span className="mcard-title" style={{ fontSize: '0.9375rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span className="emp-avatar" aria-hidden>{initials(contact.full_name)}</span>
                        {contact.full_name}
                      </span>
                    </div>
                    <div className="mcard-rows">
                      <div className="mcard-row"><span className="mcard-label">Офис / объект</span><span className="mcard-value">{loc}</span></div>
                      {posName && <div className="mcard-row"><span className="mcard-label">Должность</span><span className="mcard-value">{posName}</span></div>}
                      {deptName && <div className="mcard-row"><span className="mcard-label">Отдел</span><span className="mcard-value">{deptName}</span></div>}
                      {(contact.phone || contact.email) && (
                        <div className="mcard-row">
                          <span className="mcard-label">Контакты</span>
                          <span className="mcard-value">{[contact.phone, contact.email].filter(Boolean).join(' · ')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
          <div className="table-container emp-table-wrap">
            <table className="data-table emp-table">
              <thead>
                <tr>
                  <th className="emp-col-name">Сотрудник</th>
                  <th className="emp-col-loc">Офис / объект</th>
                  <th className="emp-col-pos">Должность</th>
                  <th className="emp-col-dept">Отдел</th>
                  <th className="emp-col-contacts">Контакты</th>
                  <th className="emp-col-note">Примечание</th>
                  <th className="emp-col-act"></th>
                </tr>
              </thead>
              <tbody>
                {contacts.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="no-data" style={{ textAlign: 'center' }}>
                      Сотрудников нет. Добавьте первого.
                    </td>
                  </tr>
                ) : visibleContacts.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="no-data emp-empty">
                      <div className="emp-empty-title">
                        Ничего не найдено{searchQuery && ` по запросу «${searchQuery}»`}
                      </div>
                      <div className="emp-empty-sub">Попробуйте изменить фильтры или сбросить параметры.</div>
                      {empFiltersActive && (
                        <button type="button" className="emp-filter-reset" onClick={resetEmpFilters}>↺ Сбросить фильтры</button>
                      )}
                    </td>
                  </tr>
                ) : (
                  empPaged.map((contact) => {
                    const loc = contact.object_id ? (contact.objects?.name || 'Объект') : 'Офис'
                    const posName = normalizePosition(contact.position) || ''
                    const deptName = contact.departments?.name || ''
                    const note = contact.notes || ''
                    const notePreview = note.length > 70 ? note.slice(0, 70) + '…' : note
                    return (
                      <tr key={contact.id} className="emp-row" onClick={() => handleEditContact(contact)}>
                        <td>
                          <div className="emp-person">
                            <span className="emp-avatar" aria-hidden>{initials(contact.full_name)}</span>
                            <span className="emp-person-name">{contact.full_name}</span>
                          </div>
                        </td>
                        <td className="emp-ell" title={loc}>{loc}</td>
                        <td className={`emp-ell ${posName ? '' : 'muted'}`} title={posName || undefined}>{posName || '—'}</td>
                        <td className={`emp-ell ${deptName ? '' : 'muted'}`} title={deptName || undefined}>{deptName || '—'}</td>
                        <td className="emp-contacts">
                          {contact.phone && <span className="emp-phone">{contact.phone}</span>}
                          {contact.email && <span className="emp-email">{contact.email}</span>}
                          {!contact.phone && !contact.email && <span className="muted">—</span>}
                        </td>
                        <td className="emp-note" title={note || undefined}>
                          {notePreview || <span className="muted">—</span>}
                        </td>
                        <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                          {canEditContacts && (
                            <RowActionsMenu
                              onEdit={() => handleEditContact(contact)}
                              onDelete={() => handleDeleteContact(contact.id, contact.full_name)}
                            />
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          )}

          {visibleContacts.length > 0 && (
            <div className="emp-pagination">
              <span className="emp-pagination-info">
                {empPageStart + 1}–{Math.min(empPageStart + pageSize, visibleContacts.length)} из {visibleContacts.length}
              </span>
              <div className="emp-pagination-controls">
                <button type="button" className="emp-page-btn" disabled={empPage === 0} onClick={() => setPage(empPage - 1)}>←</button>
                <span className="emp-page-num">{empPage + 1} / {empTotalPages}</span>
                <button type="button" className="emp-page-btn" disabled={empPage >= empTotalPages - 1} onClick={() => setPage(empPage + 1)}>→</button>
              </div>
              <label className="emp-pagesize">
                Показывать по
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      {/* Drawer «Карточка сотрудника» — просмотр / редактирование / создание */}
      {showContactModal && (() => {
        const close = () => { setShowContactModal(false); setEditingContact(null) }
        const deptName = departments.find(d => d.id === contactFormData.department_id)?.name || ''
        const headSub = [normalizePosition(contactFormData.position), deptName].filter(Boolean).join(' · ')
        const notesLen = (contactFormData.notes || '').length
        return (
        <div className="emp-drawer-overlay" onClick={close}>
          <aside className="emp-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="emp-drawer-head">
              <div className="emp-drawer-head-top">
                <span className="emp-drawer-title">{editingContact ? 'Карточка сотрудника' : 'Новый сотрудник'}</span>
                <button className="modal-close" onClick={close} aria-label="Закрыть">×</button>
              </div>
              <div className="emp-drawer-id">
                <span className="emp-avatar emp-avatar-lg" aria-hidden>{initials(contactFormData.full_name)}</span>
                <div className="emp-drawer-id-text">
                  <div className="emp-drawer-name">{contactFormData.full_name || (editingContact ? '—' : 'Добавить сотрудника')}</div>
                  {headSub && <div className="emp-drawer-sub">{headSub}</div>}
                </div>
              </div>
            </div>

            <form onSubmit={handleContactSubmit} className="emp-drawer-form">
              <div className="emp-drawer-body">
                <fieldset className="emp-fieldset" disabled={!canEditContacts}>
                  <section className="emp-group">
                    <h4 className="emp-group-title">Основная информация</h4>
                    <div className="form-group">
                      <label>ФИО *</label>
                      <input
                        type="text"
                        value={contactFormData.full_name}
                        onChange={(e) => setContactFormData({ ...contactFormData, full_name: e.target.value })}
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
                            onChange={(e) => setContactFormData({ ...contactFormData, position: e.target.value })}
                            required
                            placeholder="Введите должность"
                            autoFocus
                          />
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => { setIsCustomPosition(false); setContactFormData({ ...contactFormData, position: '' }) }}
                            title="Выбрать из списка"
                          >✕</button>
                        </div>
                      ) : (
                        <div className="input-with-action">
                          <select
                            value={contactFormData.position}
                            onChange={(e) => setContactFormData({ ...contactFormData, position: e.target.value })}
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
                            onClick={() => { setIsCustomPosition(true); setContactFormData({ ...contactFormData, position: '' }) }}
                            title="Добавить новую должность"
                          >+</button>
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label>Отдел</label>
                      <select
                        value={contactFormData.department_id}
                        onChange={(e) => setContactFormData({ ...contactFormData, department_id: e.target.value })}
                      >
                        <option value="">— не указан —</option>
                        {departments.map((dept) => (
                          <option key={dept.id} value={dept.id}>{dept.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Офис / объект</label>
                      <select
                        value={contactFormData.object_id}
                        onChange={(e) => setContactFormData({ ...contactFormData, object_id: e.target.value })}
                      >
                        <option value="">Офис</option>
                        {objects.map((obj) => (
                          <option key={obj.id} value={obj.id}>{obj.name}</option>
                        ))}
                      </select>
                    </div>
                  </section>

                  <section className="emp-group">
                    <h4 className="emp-group-title">Контакты</h4>
                    <div className="form-group">
                      <label>Телефон</label>
                      <div className="emp-contact-field">
                        <input
                          type="tel"
                          value={contactFormData.phone}
                          onChange={(e) => setContactFormData({ ...contactFormData, phone: formatPhone(e.target.value) })}
                          placeholder="+7(916)712-69-10"
                        />
                        <a className={`emp-contact-act ${contactFormData.phone ? '' : 'is-off'}`}
                          href={contactFormData.phone ? `tel:${contactFormData.phone}` : undefined}
                          title="Позвонить" aria-label="Позвонить">☎</a>
                        <button type="button" className="emp-contact-act" onClick={() => copyText(contactFormData.phone)}
                          title="Скопировать телефон" aria-label="Скопировать">⧉</button>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Email</label>
                      <div className="emp-contact-field">
                        <input
                          type="email"
                          value={contactFormData.email}
                          onChange={(e) => setContactFormData({ ...contactFormData, email: e.target.value })}
                          placeholder="email@example.com"
                        />
                        <a className={`emp-contact-act ${contactFormData.email ? '' : 'is-off'}`}
                          href={contactFormData.email ? `mailto:${contactFormData.email}` : undefined}
                          title="Написать письмо" aria-label="Написать">✉</a>
                        <button type="button" className="emp-contact-act" onClick={() => copyText(contactFormData.email)}
                          title="Скопировать email" aria-label="Скопировать">⧉</button>
                      </div>
                    </div>
                  </section>

                  <section className="emp-group">
                    <h4 className="emp-group-title">Примечание</h4>
                    <div className="form-group">
                      <textarea
                        value={contactFormData.notes}
                        onChange={(e) => setContactFormData({ ...contactFormData, notes: e.target.value })}
                        rows={4}
                        maxLength={500}
                        placeholder="Произвольное примечание (необязательно)"
                      />
                      <div className="emp-char-count">{notesLen} / 500</div>
                    </div>
                  </section>
                </fieldset>
              </div>

              <div className="emp-drawer-footer">
                <button type="button" className="btn-secondary" onClick={close}>
                  {canEditContacts ? 'Отмена' : 'Закрыть'}
                </button>
                {canEditContacts && (
                  <button type="submit" className="btn-primary">
                    {editingContact ? 'Сохранить' : 'Добавить'}
                  </button>
                )}
              </div>
            </form>
          </aside>
        </div>
        )
      })()}

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
