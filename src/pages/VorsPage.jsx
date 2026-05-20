import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './CostPlansPage.css'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed']

function VorsPage() {
  const { scopedObjectId, userProfile } = useRole()

  // Лог изменений в журнал тендера (используется при смене ответственного / ссылки).
  const logTenderEvent = async (tenderId, eventType, payload = {}) => {
    if (!tenderId || !eventType) return
    try {
      const role = localStorage.getItem('userRole') || null
      await supabase.from('tender_audit_log').insert([{
        tender_id: tenderId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])
    } catch (err) {
      console.error('Ошибка записи истории тендера:', err.message)
    }
  }
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all') // 'all' | 'not_started' | 'in_progress' | 'completed'
  // task 241: статус-вкладки скрыты под кнопкой «ВОРы и РД по статусам»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [objectFilter, setObjectFilter] = useState('') // task 239: фильтр по объектам
  const [searchQuery, setSearchQuery] = useState('') // task 239: поиск
  const [allContacts, setAllContacts] = useState([])
  const [editingResponsibleId, setEditingResponsibleId] = useState(null)

  const fetchAllContacts = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, full_name, position')
        .order('full_name', { ascending: true })
      if (error) throw error
      setAllContacts(data || [])
    } catch (err) {
      console.error('Ошибка загрузки сотрудников:', err.message)
    }
  }

  const fetchTenders = useCallback(async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select(`
          id, object_id, status, tender_type, vor_status, vor_link,
          vor_responsible_id, vor_start_date, vor_end_date,
          start_date, end_date, work_description, deleted_at,
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position)
        `)
        .order('start_date', { ascending: false })

      if (error) throw error
      // Только основные тендеры (без дочерних на материалы) по основному строительству.
      let filtered = (data || []).filter(t =>
        t.objects?.status === 'main_construction'
        && (!t.tender_type || t.tender_type === 'main')
      )
      if (scopedObjectId) {
        filtered = filtered.filter(t => t.object_id === scopedObjectId)
      }
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки ВОРов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [scopedObjectId])

  useEffect(() => {
    fetchTenders()
    fetchAllContacts()
  }, [fetchTenders])

  const handleChangeStatus = async (tenderId, newStatus) => {
    if (newStatus === 'completed') {
      const tender = tenders.find(t => t.id === tenderId)
      if (!tender?.vor_link) {
        alert('Нельзя установить статус «Завершён» без ссылки на ВОРы и РД. Сначала прикрепите документ.')
        return
      }
    }
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ vor_status: newStatus })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, vor_status: newStatus } : t))
    } catch (err) {
      console.error('Ошибка изменения статуса ВОР:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeResponsible = async (tenderId, newContactId) => {
    const value = newContactId || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldName = tender?.vor_responsible?.full_name || null
    const c = value ? allContacts.find(x => x.id === value) : null
    const newName = c?.full_name || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ vor_responsible_id: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, vor_responsible_id: value, vor_responsible: c ? { id: c.id, full_name: c.full_name, position: c.position } : null }
          : t
      ))
      if (oldName !== newName) {
        logTenderEvent(tenderId, 'field_updated', {
          fieldName: 'vor_responsible_id',
          oldValue: oldName,
          newValue: newName,
          description: newName
            ? (oldName ? `Сменён ответственный за ВОРы и РД: ${oldName} → ${newName}` : `Назначен ответственный за ВОРы и РД: ${newName}`)
            : `Снят ответственный за ВОРы и РД (был: ${oldName})`,
        })
      }
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeVorLink = async (tenderId, currentLink) => {
    const next = window.prompt('Ссылка на ВОРы и РД (Google/Yandex Drive):', currentLink || '')
    if (next === null) return
    const value = next.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ vor_link: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, vor_link: value } : t))
    } catch (err) {
      console.error('Ошибка сохранения ссылки на ВОР:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeVorDate = async (tenderId, field, value) => {
    const next = value || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ [field]: next })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, [field]: next } : t))
    } catch (err) {
      console.error('Ошибка изменения срока ВОР:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }


  if (loading) {
    return (
      <div className="cost-plans-page">
        <div className="page-header"><h2>ВОРы и РД</h2></div>
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  const responsibleMap = new Map()
  for (const t of tenders) {
    const r = t.vor_responsible
    if (r?.id && !responsibleMap.has(r.id)) responsibleMap.set(r.id, r)
  }
  const responsibles = Array.from(responsibleMap.values())
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'))

  // task 239: уникальные объекты для фильтра
  const objectMap = new Map()
  for (const t of tenders) {
    if (t.object_id && !objectMap.has(t.object_id)) {
      objectMap.set(t.object_id, { id: t.object_id, name: t.objects?.name || '—' })
    }
  }
  const objectsList = Array.from(objectMap.values())
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))

  // task 239: фильтрация по ответственному, объекту и поиску
  let filtered = tenders
  if (responsibleFilter === '__unassigned__') {
    filtered = filtered.filter(t => !t.vor_responsible?.id)
  } else if (responsibleFilter) {
    filtered = filtered.filter(t => t.vor_responsible?.id === responsibleFilter)
  }
  if (objectFilter) filtered = filtered.filter(t => t.object_id === objectFilter)
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(t =>
      (t.objects?.name || '').toLowerCase().includes(q) ||
      (t.work_description || '').toLowerCase().includes(q) ||
      (t.vor_responsible?.full_name || '').toLowerCase().includes(q)
    )
  }

  // task 267: удалённые тендеры — в отдельной вкладке «Удалённые»
  const deletedRows = filtered.filter(t => t.deleted_at)
  const liveRows = filtered.filter(t => !t.deleted_at)

  // task 241: разбивка по статусам ВОР (не начат / в работе / завершён)
  const notStarted = liveRows.filter(t => (t.vor_status || 'not_started') === 'not_started')
  const inProgress = liveRows.filter(t => t.vor_status === 'in_progress')
  const completed = liveRows.filter(t => t.vor_status === 'completed')
  const visible = activeTab === 'deleted' ? deletedRows
    : activeTab === 'all' ? liveRows
    : activeTab === 'completed' ? completed
    : activeTab === 'in_progress' ? inProgress
    : notStarted

  return (
    <div className="cost-plans-page">
      <div className="page-header page-header-vors">
        <h2><span className="page-icon" aria-hidden>📐</span> ВОРы и РД</h2>
        <div className="page-header-hint">
          Список тендеров основного строительства. Ответственного за ВОРы и РД можно назначить в карточке тендера.
        </div>
      </div>

      <div className="cost-plans-tabs">
        <button
          className={`tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все ВОРы и РД
          <span className="tab-count">{liveRows.length}</span>
        </button>
        <button
          type="button"
          className={`tab cost-plans-status-toggle ${['not_started', 'in_progress', 'completed'].includes(activeTab) ? 'active' : ''} ${statusMenuOpen ? 'open' : ''}`}
          onClick={() => setStatusMenuOpen(o => !o)}
          aria-expanded={statusMenuOpen}
          title="Развернуть/свернуть ВОРы и РД по статусам"
        >
          ВОРы и РД по статусам
          <span className="tab-chevron" aria-hidden>▸</span>
        </button>
        {statusMenuOpen && (
          <>
            <button
              className={`tab ${activeTab === 'not_started' ? 'active' : ''}`}
              onClick={() => setActiveTab('not_started')}
            >
              Не начат
              <span className="tab-count">{notStarted.length}</span>
            </button>
            <button
              className={`tab ${activeTab === 'in_progress' ? 'active' : ''}`}
              onClick={() => setActiveTab('in_progress')}
            >
              В работе
              <span className="tab-count">{inProgress.length}</span>
            </button>
            <button
              className={`tab ${activeTab === 'completed' ? 'active' : ''}`}
              onClick={() => setActiveTab('completed')}
            >
              Завершено
              <span className="tab-count completed">{completed.length}</span>
            </button>
          </>
        )}
        {/* task 267: удалённые ВОРы (тендер удалён → сюда) */}
        <button
          className={`tab ${activeTab === 'deleted' ? 'active' : ''}`}
          onClick={() => setActiveTab('deleted')}
        >
          Удалённые
          {deletedRows.length > 0 && <span className="tab-count">{deletedRows.length}</span>}
        </button>
      </div>

      <div className="cost-plans-toolbar">
        <input
          type="search"
          className="cost-plans-search"
          placeholder="🔍 Поиск по объекту, описанию, ответственному…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <label className="toolbar-label">
          Объект:
          <select
            value={objectFilter}
            onChange={(e) => setObjectFilter(e.target.value)}
          >
            <option value="">Все ({tenders.length})</option>
            {objectsList.map(o => {
              const cnt = tenders.filter(t => t.object_id === o.id).length
              return (
                <option key={o.id} value={o.id}>{o.name} ({cnt})</option>
              )
            })}
          </select>
        </label>
        <label className="toolbar-label">
          Ответственный:
          <select
            value={responsibleFilter}
            onChange={(e) => setResponsibleFilter(e.target.value)}
          >
            <option value="">Все ({tenders.length})</option>
            <option value="__unassigned__">
              Не назначен ({tenders.filter(t => !t.vor_responsible?.id).length})
            </option>
            {responsibles.map(r => {
              const cnt = tenders.filter(t => t.vor_responsible?.id === r.id).length
              return (
                <option key={r.id} value={r.id}>
                  {r.full_name} ({cnt})
                </option>
              )
            })}
          </select>
        </label>
        {(responsibleFilter || objectFilter || searchQuery) && (
          <button
            className="reset-btn"
            onClick={() => { setResponsibleFilter(''); setObjectFilter(''); setSearchQuery('') }}
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '52px' }}>№ п/п</th>
              <th>Объект</th>
              <th>Описание работ</th>
              <th>Ответственный</th>
              <th>Срок подготовки ВОР</th>
              <th>ВОРы и РД</th>
              <th style={{ width: '180px' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="no-data">
                  {tenders.length === 0
                    ? 'Нет тендеров. Создайте тендер на странице «Тендеры».'
                    : activeTab === 'deleted'
                      ? 'Удалённых ВОРов нет'
                      : activeTab === 'completed'
                        ? 'Завершённых ВОРов нет'
                        : activeTab === 'in_progress'
                          ? 'Нет ВОРов в работе'
                          : activeTab === 'not_started'
                            ? 'Нет ВОРов со статусом «Не начат»'
                            : 'Нет ВОРов по выбранному фильтру'}
                </td>
              </tr>
            ) : (
              visible.map((t, idx) => (
                <tr key={t.id}>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</td>
                  <td>
                    {t.object_id ? (
                      <Link
                        to={`/general/objects/${t.object_id}`}
                        className="row-link primary"
                        title="Открыть карточку объекта (Ctrl+клик — в новой вкладке)"
                      >
                        {t.objects?.name || '—'}
                      </Link>
                    ) : (
                      <span>{t.objects?.name || '—'}</span>
                    )}
                  </td>
                  <td className="muted-text">
                    <Link
                      to={`/tenders/${t.id}`}
                      className="row-link primary"
                      title="Открыть тендер (Ctrl+клик — в новой вкладке)"
                      style={{ color: 'var(--primary-color)', textDecoration: 'underline' }}
                    >
                      {t.work_description || '—'}
                    </Link>
                  </td>
                  <td>
                    {editingResponsibleId === t.id ? (
                      <select
                        autoFocus
                        className="inline-responsible-select"
                        value={t.vor_responsible_id || ''}
                        onChange={(e) => {
                          handleChangeResponsible(t.id, e.target.value)
                          setEditingResponsibleId(null)
                        }}
                        onBlur={() => setEditingResponsibleId(null)}
                      >
                        <option value="">— не назначен —</option>
                        {allContacts.map(c => (
                          <option key={c.id} value={c.id}>{c.full_name}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        className="responsible-display"
                        onClick={() => setEditingResponsibleId(t.id)}
                        title="Назначить ответственного"
                      >
                        {t.vor_responsible?.full_name || (
                          <span className="responsible-empty">— не назначен —</span>
                        )}
                      </button>
                    )}
                    {t.vor_responsible?.position && (
                      <div className="muted-tiny">{t.vor_responsible.position}</div>
                    )}
                  </td>
                  <td>
                    <div className="inline-date-range">
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.vor_start_date || ''}
                        onChange={(e) => handleChangeVorDate(t.id, 'vor_start_date', e.target.value)}
                        title="Начало"
                      />
                      <span className="dash">—</span>
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.vor_end_date || ''}
                        onChange={(e) => handleChangeVorDate(t.id, 'vor_end_date', e.target.value)}
                        title="Окончание"
                      />
                    </div>
                  </td>
                  <td>
                    {t.vor_link ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        <a
                          href={t.vor_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          Открыть
                        </a>
                        <button
                          className="btn-icon btn-edit"
                          onClick={() => handleChangeVorLink(t.id, t.vor_link)}
                          title="Изменить ссылку"
                          style={{ fontSize: '0.75rem' }}
                        >
                          ✏️
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleChangeVorLink(t.id, '')}
                        style={{
                          background: 'none',
                          border: '1px dashed var(--border-color)',
                          borderRadius: '4px',
                          padding: '0.1875rem 0.5rem',
                          color: 'var(--text-tertiary)',
                          cursor: 'pointer',
                          fontSize: '0.75rem'
                        }}
                        title="Добавить ссылку на ВОРы и РД"
                      >
                        + ссылка
                      </button>
                    )}
                  </td>
                  <td>
                    <select
                      className={`plan-status-select status-${t.vor_status}`}
                      value={t.vor_status || 'not_started'}
                      onChange={(e) => handleChangeStatus(t.id, e.target.value)}
                    >
                      {STATUS_OPTIONS.map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default VorsPage
