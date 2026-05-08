import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import '../components/TenderDetail.css'

function TenderDetailPage() {
  const { tenderId } = useParams()
  const navigate = useNavigate()
  const { userProfile } = useRole()

  const [tender, setTender] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('participants') // 'participants' | 'history'

  // Состояния для добавления участников
  const [showAddParticipantModal, setShowAddParticipantModal] = useState(false)
  const [availableCounterparties, setAvailableCounterparties] = useState([])
  const [selectedParticipants, setSelectedParticipants] = useState(new Set())
  const [loadingCounterparties, setLoadingCounterparties] = useState(false)
  const [participantSearchQuery, setParticipantSearchQuery] = useState('')
  const [participantWorkTypeFilter, setParticipantWorkTypeFilter] = useState('')
  const [participantDepartmentFilter, setParticipantDepartmentFilter] = useState('')

  // История изменений тендера
  const [auditLog, setAuditLog] = useState([])
  const [loadingAuditLog, setLoadingAuditLog] = useState(false)
  const [auditLogError, setAuditLogError] = useState(null)

  // Примечание тендера (inline-редактирование)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSavedAt, setNotesSavedAt] = useState(null)

  useEffect(() => {
    if (tenderId) {
      fetchTenderData()
      loadAuditLog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenderId])

  const fetchTenderData = async () => {
    setLoading(true)
    try {
      const { data: tenderData, error: tenderError } = await supabase
        .from('tenders')
        .select('*, objects(name, status), winner:counterparties!winner_counterparty_id(id, name), cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name), vor_responsible:contacts!vor_responsible_id(id, full_name)')
        .eq('id', tenderId)
        .single()

      if (tenderError) throw tenderError
      setTender(tenderData)
      setNotesDraft(tenderData?.notes || '')

      const { data: counterpartiesData, error: cpError } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id,
            name,
            work_type,
            inn,
            counterparty_contacts(id, full_name, position, phone, email)
          )
        `)
        .eq('tender_id', tenderId)

      if (cpError) throw cpError
      setTenderCounterparties(counterpartiesData || [])
    } catch (error) {
      console.error('Ошибка загрузки данных тендера:', error.message)
      alert('Ошибка загрузки данных: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const loadAuditLog = async () => {
    try {
      setLoadingAuditLog(true)
      setAuditLogError(null)
      const { data, error } = await supabase
        .from('tender_audit_log')
        .select('*')
        .eq('tender_id', tenderId)
        .order('changed_at', { ascending: false })
      if (error) throw error
      setAuditLog(data || [])
    } catch (err) {
      console.error('Ошибка загрузки истории тендера:', err.message)
      setAuditLog([])
      setAuditLogError(err.message || 'Не удалось загрузить историю')
    } finally {
      setLoadingAuditLog(false)
    }
  }

  const handleSaveNotes = async () => {
    if (!tender) return
    const oldValue = tender.notes || ''
    const newValue = notesDraft || ''
    if (oldValue === newValue) return
    try {
      setNotesSaving(true)
      const { error } = await supabase
        .from('tenders')
        .update({ notes: newValue || null })
        .eq('id', tender.id)
      if (error) throw error

      const role = localStorage.getItem('userRole') || null
      await supabase.from('tender_audit_log').insert([{
        tender_id: tender.id,
        event_type: 'field_updated',
        field_name: 'notes',
        old_value: oldValue || null,
        new_value: newValue || null,
        description: 'Изменено: Примечание',
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])

      setTender(prev => prev ? { ...prev, notes: newValue } : prev)
      setNotesSavedAt(Date.now())
      loadAuditLog()
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка сохранения примечания: ' + err.message)
    } finally {
      setNotesSaving(false)
    }
  }

  const formatDateTime = (dt) => {
    if (!dt) return ''
    const d = new Date(dt)
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yyyy = d.getFullYear()
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
  }

  const ROLE_LABEL = {
    employee: 'Сотрудник',
    contractor: 'Подрядчик',
    admin: 'Администратор'
  }

  const HISTORY_FIELD_LABELS = {
    work_description: 'Описание работ',
    start_date: 'Дата начала',
    end_date: 'Дата окончания',
    tender_package_link: 'Ссылка на тендерный пакет',
    responsible_contact_id: 'Ответственный',
    object_id: 'Объект',
    notes: 'Примечание'
  }

  const formatHistoryValue = (val) => {
    if (val === null || val === undefined) return '—'
    if (typeof val === 'string' || typeof val === 'number') return String(val)
    if (typeof val === 'object') {
      if (val.name) return val.name
      return JSON.stringify(val)
    }
    return String(val)
  }

  const renderEventIcon = (eventType) => {
    switch (eventType) {
      case 'created': return '🟢'
      case 'status_changed': return '🔄'
      case 'winner_assigned': return '🏆'
      case 'field_updated': return '📝'
      default: return '•'
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const formatDateRangeOrDash = (start, end) => {
    if (!start && !end) return '—'
    if (start && end) return `${formatDate(start)} — ${formatDate(end)}`
    return formatDate(start || end)
  }

  const getStatusBadgeClass = (status) => {
    const classes = {
      'Заявка на тендер': 'status-not-started',
      'Подготовка ВОР': 'status-waiting-vor',
      'Идет тендерная процедура': 'status-in-progress',
      'Завершен': 'status-completed',
      'Приостановка тендера': 'status-suspended',
      'Не начат': 'status-not-started',
      'Ожидание ВОР': 'status-waiting-vor',
      'Принято в работу': 'status-completed'
    }
    return classes[status] || ''
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6366f1',
      'declined': '#b91c1c',
      'proposal_provided': '#15803d',
      'accepted_for_work': '#4338ca'
    }
    return colors[status] || '#64748b'
  }

  const uniqueAvailableWorkTypes = useMemo(() => [...new Set(
    availableCounterparties
      .flatMap(c => (c.work_type || '').split(',').map(wt => wt.trim()))
      .filter(wt => wt !== '')
  )].sort((a, b) => a.localeCompare(b, 'ru')), [availableCounterparties])

  const filteredAvailableCounterparties = useMemo(() => availableCounterparties.filter(cp => {
    if (participantWorkTypeFilter) {
      const types = (cp.work_type || '').split(',').map(wt => wt.trim())
      if (!types.includes(participantWorkTypeFilter)) return false
    }
    if (participantDepartmentFilter) {
      const depts = (cp.department || '').split(',').map(d => d.trim())
      if (!depts.includes(participantDepartmentFilter)) return false
    }
    if (!participantSearchQuery.trim()) return true
    const query = participantSearchQuery.toLowerCase().trim()
    return (
      (cp.name && cp.name.toLowerCase().includes(query)) ||
      (cp.inn && cp.inn.toLowerCase().includes(query)) ||
      (cp.work_type && cp.work_type.toLowerCase().includes(query))
    )
  }), [availableCounterparties, participantWorkTypeFilter, participantDepartmentFilter, participantSearchQuery])

  const closeAddParticipantModal = () => {
    setShowAddParticipantModal(false)
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
    setParticipantDepartmentFilter('')
  }

  const handleOpenAddParticipantModal = async () => {
    setShowAddParticipantModal(true)
    setSelectedParticipants(new Set())
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
    setParticipantDepartmentFilter('')
    setLoadingCounterparties(true)

    try {
      const { data, error } = await supabase
        .from('counterparties')
        .select('id, name, work_type, inn, department')
        .eq('status', 'active')
        .order('name')

      if (error) throw error

      const existingIds = tenderCounterparties.map(tc => tc.counterparty_id)
      const available = (data || []).filter(c => !existingIds.includes(c.id))

      setAvailableCounterparties(available)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error)
      alert('Ошибка загрузки списка контрагентов')
    } finally {
      setLoadingCounterparties(false)
    }
  }

  const handleToggleParticipant = (counterpartyId) => {
    setSelectedParticipants(prev => {
      const newSet = new Set(prev)
      if (newSet.has(counterpartyId)) {
        newSet.delete(counterpartyId)
      } else {
        newSet.add(counterpartyId)
      }
      return newSet
    })
  }

  const handleAddParticipants = async () => {
    if (selectedParticipants.size === 0) {
      alert('Выберите хотя бы одного контрагента')
      return
    }

    try {
      const participantsToAdd = Array.from(selectedParticipants).map(counterpartyId => ({
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        status: 'request_sent'
      }))

      const { error } = await supabase
        .from('tender_counterparties')
        .insert(participantsToAdd)

      if (error) throw error

      setShowAddParticipantModal(false)
      setSelectedParticipants(new Set())
      setParticipantSearchQuery('')
      fetchTenderData()
      alert(`Добавлено ${participantsToAdd.length} участников`)
    } catch (error) {
      console.error('Ошибка добавления участников:', error)
      alert('Ошибка добавления: ' + error.message)
    }
  }

  const handleUpdateParticipantStatus = async (tenderCounterpartyId, newStatus) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId
            ? { ...tc, status: newStatus }
            : tc
        )
      )
    } catch (error) {
      console.error('Ошибка обновления статуса:', error)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const handleUpdateParticipantNotes = async (tenderCounterpartyId, notes) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ notes })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, notes } : tc
        )
      )
    } catch (error) {
      console.error('Ошибка сохранения примечания:', error)
    }
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  if (!tender) {
    return (
      <div className="tender-detail-page">
        <div className="error-message">Тендер не найден</div>
        <button className="btn-secondary" onClick={() => navigate(-1)}>
          Назад
        </button>
      </div>
    )
  }

  return (
    <div className="tender-detail-page">
      {/* Шапка */}
      <div className="tender-detail-header">
        <button className="btn-back" onClick={() => navigate(-1)} title="Назад к списку">
          ←
        </button>
        <div className="tender-detail-title">
          <h2>{tender.objects?.name || 'Тендер'}</h2>
          {tender.work_description && (
            <p className="tender-work-description">
              <span className="tender-work-label">Выполняемые работы:</span> {tender.work_description}
            </p>
          )}
        </div>
        <div className="tender-header-right">
          {tender.created_at && (
            <span className="tender-created-at">Создан {formatDate(tender.created_at)}</span>
          )}
          <span className={`status-badge ${getStatusBadgeClass(tender.status)}`}>
            {tender.status}
          </span>
        </div>
      </div>

      {/* Информация о тендере */}
      <div className="tender-info-card">
        <div className="tender-info-grid">
          <div className="info-item">
            <span className="info-label">Дата начала</span>
            <span className="info-value">{formatDate(tender.start_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Дата окончания</span>
            <span className="info-value">{formatDate(tender.end_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Участников</span>
            <span className="info-value">{tenderCounterparties.length}</span>
          </div>
          {tender.winner && (
            <div className="info-item winner">
              <span className="info-label">Победитель</span>
              <span className="info-value winner-name">🏆 {tender.winner.name}</span>
            </div>
          )}
          {tender.tender_package_link && (
            <div className="info-item">
              <span className="info-label">Тендерный пакет</span>
              <a href={tender.tender_package_link} target="_blank" rel="noopener noreferrer" className="info-link">
                Открыть документ
              </a>
            </div>
          )}
          {(tender.cost_plan_start_date || tender.cost_plan_end_date || tender.cost_plan_responsible) && (
            <div className="info-item">
              <span className="info-label">Срок выполнения плана затрат</span>
              <span className="info-value">
                {formatDateRangeOrDash(tender.cost_plan_start_date, tender.cost_plan_end_date)}
                {tender.cost_plan_responsible?.full_name && (
                  <span className="info-sub"> · {tender.cost_plan_responsible.full_name}</span>
                )}
              </span>
            </div>
          )}
          {(tender.vor_start_date || tender.vor_end_date || tender.vor_responsible) && (
            <div className="info-item">
              <span className="info-label">Срок подготовки ВОР</span>
              <span className="info-value">
                {formatDateRangeOrDash(tender.vor_start_date, tender.vor_end_date)}
                {tender.vor_responsible?.full_name && (
                  <span className="info-sub"> · {tender.vor_responsible.full_name}</span>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="tender-notes">
          <div className="tender-notes-header">
            <span className="info-label">Примечание</span>
            {notesSaving && <span className="tender-notes-status">Сохранение…</span>}
            {!notesSaving && notesSavedAt && (Date.now() - notesSavedAt < 2500) && (
              <span className="tender-notes-status saved">Сохранено</span>
            )}
          </div>
          <textarea
            className="tender-notes-textarea"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={handleSaveNotes}
            placeholder="Свободные заметки по тендеру: ход переговоров, особые условия, риски, договорённости…"
            rows={2}
          />
        </div>
      </div>

      {/* Вкладки */}
      <div className="tender-tabs">
        <button
          className={`tender-tab ${activeTab === 'participants' ? 'active' : ''}`}
          onClick={() => setActiveTab('participants')}
        >
          Участники
          {tenderCounterparties.length > 0 && <span className="tab-count">{tenderCounterparties.length}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          История
          {auditLog.length > 0 && <span className="tab-count">{auditLog.length}</span>}
        </button>
      </div>

      {/* Контент вкладок */}
      <div className="tender-tab-content">
        {/* Вкладка Участники */}
        {activeTab === 'participants' && (
          <div className="participants-section">
            <div className="section-header">
              <h3>Участники тендера</h3>
              <div className="section-actions">
                <button
                  className="btn-primary"
                  onClick={handleOpenAddParticipantModal}
                >
                  + Пригласить участников
                </button>
              </div>
            </div>

            {tenderCounterparties.length === 0 ? (
              <div className="empty-state">
                <p>Участники еще не добавлены</p>
                <p className="hint">Нажмите «Пригласить участников» чтобы добавить контрагентов</p>
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table" style={{ fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>№</th>
                      <th>Наименование контрагента</th>
                      <th>Контакт</th>
                      <th>Телефон</th>
                      <th style={{ width: '190px' }}>Статус</th>
                      <th style={{ minWidth: '350px', width: '35%' }}>Примечание</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenderCounterparties.map((tc, idx) => {
                      const firstContact = tc.counterparties?.counterparty_contacts?.[0]
                      const isWinner = tender.winner?.id === tc.counterparty_id
                      return (
                        <tr key={tc.id} style={isWinner ? { background: 'rgba(22, 163, 74, 0.08)' } : {}}>
                          <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>
                              {isWinner && <span title="Победитель" style={{ marginRight: '0.25rem' }}>🏆</span>}
                              {tc.counterparties?.name}
                            </div>
                            {tc.counterparties?.work_type && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>{tc.counterparties.work_type}</div>
                            )}
                          </td>
                          <td>
                            {firstContact ? (
                              <div>
                                <div style={{ fontWeight: 500 }}>{firstContact.full_name}</div>
                                {firstContact.position && <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{firstContact.position}</div>}
                              </div>
                            ) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                          </td>
                          <td>
                            {firstContact?.phone ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                                {firstContact.phone.split(';').map((ph, i) => (
                                  ph.trim() && <a key={i} href={`tel:${ph.trim()}`} style={{ color: 'var(--primary-color)', textDecoration: 'none', fontSize: '0.8125rem' }}>{ph.trim()}</a>
                                ))}
                              </div>
                            ) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                          </td>
                          <td>
                            <select
                              value={tc.status || 'request_sent'}
                              onChange={(e) => handleUpdateParticipantStatus(tc.id, e.target.value)}
                              style={{
                                padding: '0.25rem 0.5rem',
                                borderRadius: '4px',
                                border: '1px solid var(--border-color)',
                                background: 'var(--bg-secondary)',
                                color: getCounterpartyStatusColor(tc.status || 'request_sent'),
                                fontWeight: 600,
                                fontSize: '0.8125rem',
                                cursor: 'pointer',
                                width: '100%'
                              }}
                            >
                              <option value="request_sent">Запрос отправлен</option>
                              <option value="accepted_for_work">Принято в работу</option>
                              <option value="proposal_provided">КП предоставлено</option>
                              <option value="declined">Отказ</option>
                            </select>
                          </td>
                          <td style={{ verticalAlign: 'top', padding: '0.5rem' }}>
                            <textarea
                              value={tc.notes || ''}
                              onChange={(e) => {
                                setTenderCounterparties(prev =>
                                  prev.map(item => item.id === tc.id ? { ...item, notes: e.target.value } : item)
                                )
                                e.target.style.height = 'auto'
                                e.target.style.height = e.target.scrollHeight + 'px'
                              }}
                              onBlur={(e) => handleUpdateParticipantNotes(tc.id, e.target.value)}
                              ref={(el) => {
                                if (el && tc.notes) {
                                  el.style.height = 'auto'
                                  el.style.height = el.scrollHeight + 'px'
                                }
                              }}
                              placeholder="Даты обзвонов, комментарии..."
                              style={{
                                width: '100%',
                                minHeight: '60px',
                                padding: '0.5rem',
                                fontSize: '0.8125rem',
                                border: '1px solid var(--border-color)',
                                borderRadius: '4px',
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                resize: 'none',
                                overflow: 'hidden',
                                fontFamily: 'inherit',
                                lineHeight: 1.5,
                                boxSizing: 'border-box',
                              }}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Вкладка История */}
        {activeTab === 'history' && (
          <div className="history-section">
            <div className="section-header">
              <h3>История изменений</h3>
            </div>
            {loadingAuditLog ? (
              <div className="empty-state">Загрузка истории...</div>
            ) : auditLogError ? (
              <div className="empty-state">
                <p>Не удалось загрузить историю</p>
                <p className="hint">Ошибка: {auditLogError}</p>
                <p className="hint">Проверьте, что таблица <code>tender_audit_log</code> создана (миграция <code>20260506_tender_audit_log.sql</code>) и доступна для текущего пользователя.</p>
              </div>
            ) : auditLog.length === 0 ? (
              <div className="empty-state">
                <p>Записей пока нет</p>
                <p className="hint">События будут появляться при создании тендера и изменении его данных</p>
              </div>
            ) : (
              <ul className="tender-history-timeline">
                {auditLog.map((event) => {
                  const fieldLabel = event.field_name ? (HISTORY_FIELD_LABELS[event.field_name] || event.field_name) : null
                  const oldStr = formatHistoryValue(event.old_value)
                  const newStr = formatHistoryValue(event.new_value)
                  const author = event.changed_by_name || ROLE_LABEL[event.changed_by_role] || event.changed_by_role || null
                  return (
                    <li key={event.id} className={`history-event history-event-${event.event_type}`}>
                      <div className="history-event-marker" aria-hidden>{renderEventIcon(event.event_type)}</div>
                      <div className="history-event-body">
                        <div className="history-event-title">
                          {event.description || event.event_type}
                        </div>
                        {(event.event_type === 'status_changed' || event.event_type === 'field_updated') && (
                          <div className="history-event-diff">
                            {event.event_type === 'field_updated' && fieldLabel && (
                              <span className="history-field-name">{fieldLabel}: </span>
                            )}
                            <span className="history-old">{oldStr}</span>
                            <span className="history-arrow">→</span>
                            <span className="history-new">{newStr}</span>
                          </div>
                        )}
                        <div className="history-event-meta">
                          <span>{formatDateTime(event.changed_at)}</span>
                          {author && <span> · автор: {author}</span>}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Modal: добавление участников */}
      {showAddParticipantModal && (
        <div className="modal-overlay" onClick={closeAddParticipantModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
            <div className="modal-header">
              <h3>Выбрать контрагентов для приглашения в тендер</h3>
              <button className="modal-close" onClick={closeAddParticipantModal}>×</button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              {loadingCounterparties ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                  Загрузка списка контрагентов...
                </p>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <input
                      type="text"
                      placeholder="🔍 Поиск по названию, виду работ, ИНН..."
                      value={participantSearchQuery}
                      onChange={(e) => setParticipantSearchQuery(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.75rem 1rem',
                        fontSize: '1rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '6px',
                        backgroundColor: 'var(--bg-color)',
                        color: 'var(--text-color)',
                        marginBottom: '0.75rem'
                      }}
                    />

                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <select
                        value={participantDepartmentFilter}
                        onChange={(e) => setParticipantDepartmentFilter(e.target.value)}
                        style={{
                          padding: '0.375rem 0.75rem',
                          fontSize: '0.8125rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: '4px',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="">Все категории</option>
                        <option value="Основное строительство">Основное строительство</option>
                        <option value="Гарантийный отдел">Гарантийный отдел</option>
                      </select>

                      {uniqueAvailableWorkTypes.length > 0 && (
                        <select
                          value={participantWorkTypeFilter}
                          onChange={(e) => setParticipantWorkTypeFilter(e.target.value)}
                          style={{
                            padding: '0.375rem 0.75rem',
                            fontSize: '0.8125rem',
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          <option value="">Все виды работ</option>
                          {uniqueAvailableWorkTypes.map(workType => (
                            <option key={workType} value={workType}>{workType}</option>
                          ))}
                        </select>
                      )}

                      {(participantDepartmentFilter || participantWorkTypeFilter) && (
                        <button
                          onClick={() => { setParticipantDepartmentFilter(''); setParticipantWorkTypeFilter('') }}
                          style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
                        >Сбросить</button>
                      )}
                    </div>
                  </div>

                  {availableCounterparties.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                      Все активные контрагенты уже добавлены в тендер
                    </p>
                  ) : filteredAvailableCounterparties.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                      Контрагенты не найдены по заданным критериям
                    </p>
                  ) : (
                    <>
                      <div style={{
                        maxHeight: '400px',
                        overflowY: 'auto',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        marginBottom: '1rem'
                      }}>
                        <table className="data-table" style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th style={{
                                width: '50px',
                                position: 'sticky',
                                top: 0,
                                backgroundColor: 'var(--card-bg)',
                                backdropFilter: 'blur(10px)',
                                zIndex: 11,
                                borderBottom: '2px solid var(--border-color)',
                                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                                padding: '0.75rem'
                              }}>
                                <input
                                  type="checkbox"
                                  checked={filteredAvailableCounterparties.length > 0 && filteredAvailableCounterparties.every(cp => selectedParticipants.has(cp.id))}
                                  onChange={(e) => {
                                    setSelectedParticipants(prev => {
                                      const newSet = new Set(prev)
                                      if (e.target.checked) {
                                        filteredAvailableCounterparties.forEach(cp => newSet.add(cp.id))
                                      } else {
                                        filteredAvailableCounterparties.forEach(cp => newSet.delete(cp.id))
                                      }
                                      return newSet
                                    })
                                  }}
                                  style={{ cursor: 'pointer' }}
                                />
                              </th>
                              <th style={{
                                position: 'sticky',
                                top: 0,
                                backgroundColor: 'var(--card-bg)',
                                backdropFilter: 'blur(10px)',
                                zIndex: 11,
                                borderBottom: '2px solid var(--border-color)',
                                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                                padding: '0.75rem'
                              }}>Наименование</th>
                              <th style={{
                                position: 'sticky',
                                top: 0,
                                backgroundColor: 'var(--card-bg)',
                                zIndex: 11,
                                borderBottom: '2px solid var(--border-color)',
                                padding: '0.75rem',
                                width: '80px',
                                textAlign: 'center'
                              }}>Категория</th>
                              <th style={{
                                position: 'sticky',
                                top: 0,
                                backgroundColor: 'var(--card-bg)',
                                zIndex: 11,
                                borderBottom: '2px solid var(--border-color)',
                                padding: '0.75rem'
                              }}>Вид работ</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredAvailableCounterparties.map((cp) => (
                              <tr
                                key={cp.id}
                                style={{
                                  cursor: 'pointer',
                                  backgroundColor: selectedParticipants.has(cp.id) ? 'var(--hover-bg, #f0f9ff)' : ''
                                }}
                                onClick={() => handleToggleParticipant(cp.id)}
                                onMouseEnter={(e) => {
                                  if (!selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = 'var(--hover-bg, #f9fafb)'
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = ''
                                  }
                                }}
                              >
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedParticipants.has(cp.id)}
                                    onChange={() => handleToggleParticipant(cp.id)}
                                    style={{ cursor: 'pointer' }}
                                  />
                                </td>
                                <td style={{ fontWeight: 500 }}>{cp.name}</td>
                                <td style={{ textAlign: 'center' }}>
                                  {cp.department ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', alignItems: 'center' }}>
                                      {cp.department.split(',').map((d, i) => {
                                        const dept = d.trim()
                                        const isCon = dept === 'Основное строительство'
                                        return (
                                          <span key={i} style={{
                                            padding: '0.1rem 0.35rem',
                                            fontSize: '0.6875rem',
                                            fontWeight: 700,
                                            borderRadius: '3px',
                                            background: isCon ? 'rgba(37,99,235,0.12)' : 'rgba(234,88,12,0.12)',
                                            color: isCon ? '#2563eb' : '#ea580c',
                                            border: `1px solid ${isCon ? 'rgba(37,99,235,0.25)' : 'rgba(234,88,12,0.25)'}`,
                                          }}>{isCon ? 'ОС' : 'ГО'}</span>
                                        )
                                      })}
                                    </div>
                                  ) : '-'}
                                </td>
                                <td>
                                  {cp.work_type ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                                      {cp.work_type.split(',').map((wt, i) => (
                                        <span key={i} style={{
                                          display: 'block',
                                          padding: '0.1rem 0.35rem',
                                          fontSize: '0.75rem',
                                          background: 'var(--bg-tertiary)',
                                          borderRadius: '3px',
                                          borderLeft: '2px solid var(--primary-color)',
                                          color: 'var(--text-secondary)',
                                        }}>{wt.trim()}</span>
                                      ))}
                                    </div>
                                  ) : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                          {selectedParticipants.size > 0 && (
                            <span>Выбрано: <strong>{selectedParticipants.size}</strong></span>
                          )}
                        </div>
                        <button
                          onClick={handleAddParticipants}
                          disabled={selectedParticipants.size === 0}
                          style={{
                            backgroundColor: selectedParticipants.size > 0 ? 'var(--primary-color)' : '#9ca3af',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            padding: '0.75rem 2rem',
                            cursor: selectedParticipants.size > 0 ? 'pointer' : 'not-allowed',
                            fontSize: '1rem',
                            fontWeight: '600',
                            transition: 'all 0.2s',
                            boxShadow: selectedParticipants.size > 0 ? '0 4px 6px rgba(0, 0, 0, 0.1)' : 'none'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedParticipants.size > 0) {
                              e.target.style.transform = 'scale(1.05)'
                              e.target.style.boxShadow = '0 6px 8px rgba(0, 0, 0, 0.15)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.target.style.transform = 'scale(1)'
                            if (selectedParticipants.size > 0) {
                              e.target.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        >
                          ✓ Пригласить выбранных ({selectedParticipants.size})
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TenderDetailPage
