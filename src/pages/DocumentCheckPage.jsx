import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './DocumentCheckPage.css'

const COLUMNS = [
  { key: 'new', label: 'Новая заявка', accent: '#6366f1' },
  { key: 'in_progress', label: 'В работе', accent: '#0891b2' },
  { key: 'edo_export', label: 'Выгрузка по ЭДО', accent: '#ca8a04' },
  { key: '1c_entry', label: 'Занесение в 1С', accent: '#9333ea' },
  { key: 'completed', label: 'Завершено', accent: '#16a34a' },
]

const COLUMN_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]))

const emptyForm = () => ({
  object_id: '',
  counterparty_id: '',
  doc_type: 'ДП',
  doc_number: '',
  doc_date: new Date().toISOString().slice(0, 10),
  notes: '',
  document_link: '',
  responsible_contact_id: '',
})

function DocumentCheckPage() {
  const { userProfile } = useRole()
  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [dragOverColumn, setDragOverColumn] = useState(null)
  const [objectFilter, setObjectFilter] = useState('')

  // История заявки (модалка)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRequest, setHistoryRequest] = useState(null)
  const [historyEvents, setHistoryEvents] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Combobox для контрагента
  const [cpDropdownOpen, setCpDropdownOpen] = useState(false)
  const [cpQuery, setCpQuery] = useState('')
  const cpRef = useRef(null)

  // Закрытие комбобокса при клике вне
  useEffect(() => {
    const onDocClick = (e) => {
      if (cpRef.current && !cpRef.current.contains(e.target)) {
        setCpDropdownOpen(false)
      }
    }
    if (cpDropdownOpen) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [cpDropdownOpen])

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true)
      const [reqRes, objRes, cpRes, contactsRes] = await Promise.all([
        supabase
          .from('document_check_requests')
          .select('*, objects(name), counterparties(name), responsible:contacts!responsible_contact_id(id, full_name)')
          .order('created_at', { ascending: true }),
        supabase.from('objects').select('id, name').order('name'),
        supabase.from('counterparties').select('id, name').eq('status', 'active').order('name'),
        supabase.from('contacts').select('id, full_name, position').order('full_name'),
      ])
      if (reqRes.error) throw reqRes.error
      setRequests(reqRes.data || [])
      setObjects(objRes.data || [])
      setCounterparties(cpRes.data || [])
      setContacts(contactsRes.data || [])
    } catch (err) {
      console.error('Ошибка загрузки данных проверки документов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const logHistory = async (requestId, payload) => {
    if (!requestId) return
    try {
      const role = localStorage.getItem('userRole') || null
      await supabase.from('document_check_request_history').insert([{
        request_id: requestId,
        event_type: payload.event_type,
        from_status: payload.from_status || null,
        to_status: payload.to_status || null,
        field_name: payload.field_name || null,
        old_value: payload.old_value || null,
        new_value: payload.new_value || null,
        description: payload.description || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null,
      }])
    } catch (err) {
      console.error('Ошибка записи истории заявки:', err.message)
    }
  }

  const handleOpenAdd = () => {
    setEditing(null)
    setForm(emptyForm())
    setCpQuery('')
    setShowModal(true)
  }

  const handleOpenEdit = (req) => {
    setEditing(req)
    setForm({
      object_id: req.object_id || '',
      counterparty_id: req.counterparty_id || '',
      doc_type: req.doc_type,
      doc_number: req.doc_number,
      doc_date: req.doc_date,
      notes: req.notes || '',
      document_link: req.document_link || '',
      responsible_contact_id: req.responsible_contact_id || '',
    })
    setCpQuery('')
    setShowModal(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.doc_number.trim()) { alert('Укажите № договора / ДС'); return }
    if (!form.doc_date) { alert('Укажите дату документа'); return }
    const payload = {
      object_id: form.object_id || null,
      counterparty_id: form.counterparty_id || null,
      doc_type: form.doc_type,
      doc_number: form.doc_number.trim(),
      doc_date: form.doc_date,
      notes: form.notes.trim() || null,
      document_link: form.document_link.trim() || null,
      responsible_contact_id: form.responsible_contact_id || null,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editing) {
        const { error } = await supabase
          .from('document_check_requests')
          .update(payload)
          .eq('id', editing.id)
        if (error) throw error
        // Логируем заметные изменения по полям
        const oldRespName = editing.responsible?.full_name || null
        const newRespName = payload.responsible_contact_id
          ? (contacts.find(c => c.id === payload.responsible_contact_id)?.full_name || null)
          : null
        if (oldRespName !== newRespName) {
          await logHistory(editing.id, {
            event_type: 'field_updated',
            field_name: 'responsible_contact_id',
            old_value: oldRespName,
            new_value: newRespName,
            description: newRespName
              ? (oldRespName ? `Сменён ответственный: ${oldRespName} → ${newRespName}` : `Назначен ответственный: ${newRespName}`)
              : `Снят ответственный (был: ${oldRespName})`,
          })
        }
        if ((editing.document_link || '') !== (payload.document_link || '')) {
          await logHistory(editing.id, {
            event_type: 'field_updated',
            field_name: 'document_link',
            old_value: editing.document_link || null,
            new_value: payload.document_link,
            description: payload.document_link ? 'Изменена ссылка на документ' : 'Удалена ссылка на документ',
          })
        }
      } else {
        const { data: created, error } = await supabase
          .from('document_check_requests')
          .insert([{ ...payload, status: 'new' }])
          .select()
          .single()
        if (error) throw error
        await logHistory(created.id, {
          event_type: 'created',
          to_status: 'new',
          description: `Создана заявка: ${form.doc_type} № ${form.doc_number}`,
        })
      }
      setShowModal(false)
      setEditing(null)
      setForm(emptyForm())
      fetchAll()
    } catch (err) {
      console.error('Ошибка сохранения заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleDelete = async (req) => {
    if (!window.confirm(`Удалить заявку «${req.doc_type} № ${req.doc_number}»?`)) return
    try {
      const { error } = await supabase
        .from('document_check_requests')
        .delete()
        .eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.filter(r => r.id !== req.id))
    } catch (err) {
      console.error('Ошибка удаления заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleMove = async (reqId, newStatus) => {
    const req = requests.find(r => r.id === reqId)
    if (!req || req.status === newStatus) return
    try {
      const { error } = await supabase
        .from('document_check_requests')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', reqId)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === reqId ? { ...r, status: newStatus } : r))
      await logHistory(reqId, {
        event_type: 'status_changed',
        from_status: req.status,
        to_status: newStatus,
        description: `Перемещено: «${COLUMN_BY_KEY[req.status]?.label || req.status}» → «${COLUMN_BY_KEY[newStatus]?.label || newStatus}»`,
      })
    } catch (err) {
      console.error('Ошибка перемещения заявки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeResponsibleInline = async (req, newContactId) => {
    const value = newContactId || null
    const oldName = req.responsible?.full_name || null
    const newContact = value ? contacts.find(c => c.id === value) : null
    const newName = newContact?.full_name || null
    if (oldName === newName) return
    try {
      const { error } = await supabase
        .from('document_check_requests')
        .update({ responsible_contact_id: value, updated_at: new Date().toISOString() })
        .eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.map(r =>
        r.id === req.id
          ? { ...r, responsible_contact_id: value, responsible: newContact ? { id: newContact.id, full_name: newContact.full_name } : null }
          : r
      ))
      await logHistory(req.id, {
        event_type: 'field_updated',
        field_name: 'responsible_contact_id',
        old_value: oldName,
        new_value: newName,
        description: newName
          ? (oldName ? `Сменён ответственный: ${oldName} → ${newName}` : `Назначен ответственный: ${newName}`)
          : `Снят ответственный (был: ${oldName})`,
      })
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleOpenHistory = async (req) => {
    setHistoryRequest(req)
    setHistoryOpen(true)
    setHistoryLoading(true)
    try {
      const { data, error } = await supabase
        .from('document_check_request_history')
        .select('*')
        .eq('request_id', req.id)
        .order('changed_at', { ascending: false })
      if (error) throw error
      setHistoryEvents(data || [])
    } catch (err) {
      console.error('Ошибка загрузки истории:', err.message)
      setHistoryEvents([])
    } finally {
      setHistoryLoading(false)
    }
  }

  // DnD
  const handleDragStart = (e, reqId) => {
    e.dataTransfer.setData('text/plain', reqId)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e, columnKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverColumn !== columnKey) setDragOverColumn(columnKey)
  }
  const handleDragLeave = () => setDragOverColumn(null)
  const handleDrop = (e, columnKey) => {
    e.preventDefault()
    setDragOverColumn(null)
    const reqId = e.dataTransfer.getData('text/plain')
    if (!reqId) return
    const req = requests.find(r => r.id === reqId)
    if (req && req.status !== columnKey) handleMove(reqId, columnKey)
  }

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('ru-RU') : '—'
  const formatDateTime = (d) => {
    if (!d) return ''
    const dt = new Date(d)
    const dd = String(dt.getDate()).padStart(2, '0')
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const yyyy = dt.getFullYear()
    const hh = String(dt.getHours()).padStart(2, '0')
    const mi = String(dt.getMinutes()).padStart(2, '0')
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
  }

  // Применяем фильтр по объекту
  const visibleRequests = objectFilter
    ? requests.filter(r => r.object_id === objectFilter)
    : requests

  const requestsByColumn = COLUMNS.reduce((acc, col) => {
    acc[col.key] = visibleRequests.filter(r => r.status === col.key)
    return acc
  }, {})

  const selectedCp = counterparties.find(c => c.id === form.counterparty_id)
  const filteredCps = (cpQuery.trim()
    ? counterparties.filter(c => c.name && c.name.toLowerCase().includes(cpQuery.trim().toLowerCase()))
    : counterparties
  ).slice(0, 50)

  return (
    <div className="document-check-page">
      <div className="page-header page-header-doc-check">
        <h2><span className="page-icon" aria-hidden>📑</span> Проверка ДП/ДС</h2>
        <div className="doc-check-toolbar">
          <select
            className="doc-check-object-filter"
            value={objectFilter}
            onChange={(e) => setObjectFilter(e.target.value)}
            title="Фильтр по объекту"
          >
            <option value="">Все объекты</option>
            {objects.map(o => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleOpenAdd}>
            + Новая заявка
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="kanban-board">
          {COLUMNS.map(col => {
            const items = requestsByColumn[col.key]
            return (
              <div
                key={col.key}
                className={`kanban-column ${dragOverColumn === col.key ? 'drag-over' : ''}`}
                onDragOver={(e) => handleDragOver(e, col.key)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.key)}
              >
                <div className="kanban-column-header" style={{ borderTopColor: col.accent }}>
                  <span className="kanban-column-title">{col.label}</span>
                  <span className="kanban-column-count">{items.length}</span>
                </div>
                <div className="kanban-column-body">
                  {items.length === 0 ? (
                    <div className="kanban-empty">Пусто</div>
                  ) : (
                    items.map(req => {
                      const colIdx = COLUMNS.findIndex(c => c.key === req.status)
                      const prevKey = colIdx > 0 ? COLUMNS[colIdx - 1].key : null
                      const nextKey = colIdx < COLUMNS.length - 1 ? COLUMNS[colIdx + 1].key : null
                      return (
                        <div
                          key={req.id}
                          className="kanban-card"
                          draggable
                          onDragStart={(e) => handleDragStart(e, req.id)}
                        >
                          <div className="kanban-card-top">
                            <span className={`doc-type-badge doc-type-${req.doc_type === 'ДП' ? 'dp' : 'ds'}`}>
                              {req.doc_type}
                            </span>
                            <span className="kanban-card-number">№ {req.doc_number}</span>
                            <span className="kanban-card-date">от {formatDate(req.doc_date)}</span>
                          </div>
                          {req.counterparties?.name && (
                            <div className="kanban-card-row">
                              <span className="kanban-card-label">Контрагент:</span>
                              <span>{req.counterparties.name}</span>
                            </div>
                          )}
                          {req.objects?.name && (
                            <div className="kanban-card-row">
                              <span className="kanban-card-label">Объект:</span>
                              <span>{req.objects.name}</span>
                            </div>
                          )}
                          <div className="kanban-card-row">
                            <span className="kanban-card-label">Ответственный:</span>
                            <select
                              className="card-inline-select"
                              value={req.responsible_contact_id || ''}
                              onChange={(e) => handleChangeResponsibleInline(req, e.target.value)}
                              title="Назначить ответственного за проверку"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="">— не назначен —</option>
                              {contacts.map(c => (
                                <option key={c.id} value={c.id}>{c.full_name}</option>
                              ))}
                            </select>
                          </div>
                          {req.document_link && (
                            <div className="kanban-card-row">
                              <span className="kanban-card-label">Документ:</span>
                              <a
                                href={req.document_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link"
                                onClick={(e) => e.stopPropagation()}
                              >📎 Открыть</a>
                            </div>
                          )}
                          {req.notes && (
                            <div className="kanban-card-notes">{req.notes}</div>
                          )}
                          <div className="kanban-card-actions">
                            <button
                              className="kanban-btn"
                              disabled={!prevKey}
                              onClick={() => prevKey && handleMove(req.id, prevKey)}
                              title={prevKey ? `← ${COLUMN_BY_KEY[prevKey].label}` : 'Первая колонка'}
                            >←</button>
                            <button
                              className="kanban-btn"
                              onClick={() => handleOpenHistory(req)}
                              title="История изменений"
                            >🕘</button>
                            <button
                              className="kanban-btn kanban-btn-edit"
                              onClick={() => handleOpenEdit(req)}
                              title="Редактировать"
                            >✏️</button>
                            <button
                              className="kanban-btn kanban-btn-delete"
                              onClick={() => handleDelete(req)}
                              title="Удалить"
                            >🗑️</button>
                            <button
                              className="kanban-btn"
                              disabled={!nextKey}
                              onClick={() => nextKey && handleMove(req.id, nextKey)}
                              title={nextKey ? `${COLUMN_BY_KEY[nextKey].label} →` : 'Последняя колонка'}
                            >→</button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal doc-check-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Редактировать заявку' : 'Новая заявка на проверку'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit} className="doc-check-form">
              <div className="doc-check-grid">
                <div className="form-group">
                  <label>Тип *</label>
                  <select
                    value={form.doc_type}
                    onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
                    required
                  >
                    <option value="ДП">ДП — Договор подряда</option>
                    <option value="ДС">ДС — Доп. соглашение</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>№ договора / ДС *</label>
                  <input
                    type="text"
                    value={form.doc_number}
                    onChange={(e) => setForm({ ...form, doc_number: e.target.value })}
                    required
                    placeholder="Например, 12-А-2026"
                  />
                </div>
                <div className="form-group">
                  <label>Дата документа *</label>
                  <input
                    type="date"
                    value={form.doc_date}
                    onChange={(e) => setForm({ ...form, doc_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Ответственный за проверку</label>
                  <select
                    value={form.responsible_contact_id}
                    onChange={(e) => setForm({ ...form, responsible_contact_id: e.target.value })}
                  >
                    <option value="">— не назначен —</option>
                    {contacts.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group full-width">
                  <label>Контрагент</label>
                  <div className="cp-combobox" ref={cpRef}>
                    <input
                      type="text"
                      className="cp-combobox-input"
                      placeholder="Начните вводить название контрагента..."
                      value={cpDropdownOpen ? cpQuery : (selectedCp?.name || '')}
                      onFocus={() => { setCpDropdownOpen(true); setCpQuery('') }}
                      onChange={(e) => { setCpQuery(e.target.value); setCpDropdownOpen(true) }}
                    />
                    {form.counterparty_id && !cpDropdownOpen && (
                      <button
                        type="button"
                        className="cp-combobox-clear"
                        onClick={() => { setForm({ ...form, counterparty_id: '' }); setCpQuery('') }}
                        title="Очистить выбор"
                      >×</button>
                    )}
                    {cpDropdownOpen && (
                      <div className="cp-combobox-dropdown">
                        {filteredCps.length === 0 ? (
                          <div className="cp-combobox-empty">Ничего не найдено</div>
                        ) : (
                          filteredCps.map(c => (
                            <button
                              type="button"
                              key={c.id}
                              className={`cp-combobox-option ${c.id === form.counterparty_id ? 'selected' : ''}`}
                              onClick={() => {
                                setForm({ ...form, counterparty_id: c.id })
                                setCpDropdownOpen(false)
                                setCpQuery('')
                              }}
                            >
                              {c.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="form-group full-width">
                  <label>Объект</label>
                  <select
                    value={form.object_id}
                    onChange={(e) => setForm({ ...form, object_id: e.target.value })}
                  >
                    <option value="">— не выбран —</option>
                    {objects.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group full-width">
                  <label>Ссылка на документ</label>
                  <input
                    type="url"
                    value={form.document_link}
                    onChange={(e) => setForm({ ...form, document_link: e.target.value })}
                    placeholder="https://drive.google.com/..."
                  />
                </div>
                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    placeholder="Особенности проверки, ответственный, и т.д."
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editing ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* История заявки */}
      {historyOpen && historyRequest && (
        <div className="modal-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="modal doc-check-history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>История заявки: {historyRequest.doc_type} № {historyRequest.doc_number}</h3>
              <button className="modal-close" onClick={() => setHistoryOpen(false)}>×</button>
            </div>
            <div className="history-modal-body">
              {historyLoading ? (
                <div className="history-loading">Загрузка...</div>
              ) : historyEvents.length === 0 ? (
                <div className="history-empty">Записей пока нет</div>
              ) : (
                <ul className="history-timeline">
                  {historyEvents.map(ev => (
                    <li key={ev.id} className={`history-event history-event-${ev.event_type}`}>
                      <span className="history-icon" aria-hidden>
                        {ev.event_type === 'created' ? '🟢' : ev.event_type === 'status_changed' ? '🔄' : '📝'}
                      </span>
                      <div className="history-event-body">
                        <div className="history-event-title">
                          {ev.description || ev.event_type}
                        </div>
                        <div className="history-event-meta">
                          <span>{formatDateTime(ev.changed_at)}</span>
                          {ev.changed_by_name && <span> · {ev.changed_by_name}</span>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setHistoryOpen(false)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentCheckPage
