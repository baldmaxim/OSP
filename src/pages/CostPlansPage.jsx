import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './CostPlansPage.css'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
  not_required: 'Не требуется',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed', 'not_required']

// Статусы, при которых план затрат считается «закрытым» (вкладка «Завершено»)
const DONE_STATUSES = ['completed', 'not_required']

function CostPlansPage() {
  const { scopedObjectIds, userProfile } = useRole()

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
  const [activeTab, setActiveTab] = useState('all') // 'all' | 'not_started' | 'in_work' | 'completed'
  // task 234: статус-вкладки скрыты под кнопкой «Статусы планов затрат»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('') // task 209
  // task 211: модалка редактирования ссылки на план затрат
  const [linkModal, setLinkModal] = useState(null) // { tenderId, value }
  const [objectFilter, setObjectFilter] = useState('') // task 178: фильтр по объектам
  const [allContacts, setAllContacts] = useState([])
  const [editingResponsibleId, setEditingResponsibleId] = useState(null)
  // task 179: сортировка по срокам тендерных процедур
  const [sortKey, setSortKey] = useState('') // '' | 'tender_start_date' | 'tender_end_date'
  const [sortDir, setSortDir] = useState('asc') // 'asc' | 'desc'

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
          id, object_id, status, tender_type, cost_plan_status, cost_plan_link,
          cost_plan_responsible_id, cost_plan_start_date, cost_plan_end_date,
          start_date, end_date, tender_start_date, tender_end_date,
          work_description, cost_plan_notes, deleted_at,
          objects(name, status),
          cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name, position)
        `)
        .order('start_date', { ascending: false })

      if (error) throw error
      // Только основные тендеры по основному строительству — план затрат имеет смысл только там.
      // Дочерние тендеры на материалы (tender_type='materials') исключаем, чтобы не дублировать.
      let filtered = (data || []).filter(t =>
        t.objects?.status === 'main_construction'
        && (!t.tender_type || t.tender_type === 'main')
      )
      if (scopedObjectIds.length > 0) {
        // Скоуп: сотрудник видит только тендеры своих объектов.
        filtered = filtered.filter(t => scopedObjectIds.includes(t.object_id))
      }
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки планов затрат:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => {
    fetchTenders()
    fetchAllContacts()
  }, [fetchTenders])

  const handleChangeStatus = async (tenderId, newStatus) => {
    if (newStatus === 'completed') {
      const tender = tenders.find(t => t.id === tenderId)
      if (!tender?.cost_plan_link) {
        alert('Нельзя установить статус «Завершён» без ссылки на план затрат. Сначала прикрепите документ.')
        return
      }
    }
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ cost_plan_status: newStatus })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, cost_plan_status: newStatus } : t))
    } catch (err) {
      console.error('Ошибка изменения статуса плана затрат:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeResponsible = async (tenderId, newContactId) => {
    const value = newContactId || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldName = tender?.cost_plan_responsible?.full_name || null
    const c = value ? allContacts.find(x => x.id === value) : null
    const newName = c?.full_name || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ cost_plan_responsible_id: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, cost_plan_responsible_id: value, cost_plan_responsible: c ? { id: c.id, full_name: c.full_name, position: c.position } : null }
          : t
      ))
      if (oldName !== newName) {
        logTenderEvent(tenderId, 'field_updated', {
          fieldName: 'cost_plan_responsible_id',
          oldValue: oldName,
          newValue: newName,
          description: newName
            ? (oldName ? `Сменён ответственный за план затрат: ${oldName} → ${newName}` : `Назначен ответственный за план затрат: ${newName}`)
            : `Снят ответственный за план затрат (был: ${oldName})`,
        })
      }
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // task 211: открыть модалку редактирования ссылки
  const openLinkModal = (tenderId, currentLink) => {
    setLinkModal({ tenderId, value: currentLink || '' })
  }

  const handleSaveCostPlanLink = async () => {
    if (!linkModal) return
    const { tenderId } = linkModal
    const value = linkModal.value.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ cost_plan_link: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, cost_plan_link: value } : t))
      setLinkModal(null)
    } catch (err) {
      console.error('Ошибка сохранения ссылки на план затрат:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleChangeCostPlanDate = async (tenderId, field, value) => {
    const next = value || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ [field]: next })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, [field]: next } : t))
    } catch (err) {
      console.error('Ошибка изменения срока плана затрат:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // task 177: сохранение примечания к плану затрат (по blur, без спама запросами)
  const handleChangeCostPlanNotes = async (tenderId, value) => {
    const next = value.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ cost_plan_notes: next })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, cost_plan_notes: next } : t))
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // task 179: переключатель сортировки по колонкам с датами тендера
  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }
  const sortIndicator = (key) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''


  if (loading) {
    return (
      <div className="cost-plans-page">
        <div className="page-header"><h2>Планы затрат</h2></div>
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  // task 216: уникальные ответственные для фильтра — по ФИО (без дублей разных
  // контактов с одинаковым именем, привязанных к разным объектам)
  const responsibleNameSet = new Set()
  const responsibles = []
  for (const t of tenders) {
    const name = t.cost_plan_responsible?.full_name
    if (name && !responsibleNameSet.has(name.toLowerCase())) {
      responsibleNameSet.add(name.toLowerCase())
      responsibles.push(name)
    }
  }
  responsibles.sort((a, b) => a.localeCompare(b, 'ru'))

  // task 216: контакты для назначения ответственного — без дублей по ФИО
  const seenContactNames = new Set()
  const uniqueContacts = allContacts.filter(c => {
    const key = (c.full_name || '').toLowerCase()
    if (!key || seenContactNames.has(key)) return false
    seenContactNames.add(key)
    return true
  })

  // task 178: уникальные объекты для фильтра
  const objectMap = new Map()
  for (const t of tenders) {
    const o = t.objects
    if (t.object_id && !objectMap.has(t.object_id)) {
      objectMap.set(t.object_id, { id: t.object_id, name: o?.name || '—' })
    }
  }
  const objectsList = Array.from(objectMap.values())
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))

  // Фильтрация по ответственному, объекту и поиску
  let filtered = tenders
  if (responsibleFilter) filtered = filtered.filter(t => (t.cost_plan_responsible?.full_name || '') === responsibleFilter)
  if (objectFilter) filtered = filtered.filter(t => t.object_id === objectFilter)
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(t =>
      (t.work_description || '').toLowerCase().includes(q) ||
      (t.objects?.name || '').toLowerCase().includes(q) ||
      (t.cost_plan_responsible?.full_name || '').toLowerCase().includes(q) ||
      (t.cost_plan_notes || '').toLowerCase().includes(q)
    )
  }

  // task 179: сортировка по выбранной колонке (даты тендерных процедур)
  if (sortKey) {
    filtered = [...filtered].sort((a, b) => {
      const av = a[sortKey] || ''
      const bv = b[sortKey] || ''
      if (av === bv) return 0
      // пустые значения уходят в конец независимо от направления
      if (!av) return 1
      if (!bv) return -1
      const cmp = av < bv ? -1 : 1
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  // task 267: удалённые тендеры — в отдельной вкладке «Удалённые»
  const deletedRows = filtered.filter(t => t.deleted_at)
  const liveRows = filtered.filter(t => !t.deleted_at)

  // Разделение по табам (task 210: «Не начат» / «В работе» / «Завершено»)
  // task 208: «Не требуется» относится к «Завершено»
  const notStarted = liveRows.filter(t => (t.cost_plan_status || 'not_started') === 'not_started')
  const inWork = liveRows.filter(t => t.cost_plan_status === 'in_progress')
  const completed = liveRows.filter(t => DONE_STATUSES.includes(t.cost_plan_status))
  const visible = activeTab === 'deleted' ? deletedRows
    : activeTab === 'all' ? liveRows
    : activeTab === 'completed' ? completed
    : activeTab === 'in_work' ? inWork
    : notStarted

  return (
    <div className="cost-plans-page">
      <div className="page-header page-header-cost-plans">
        <h2><span className="page-icon" aria-hidden>💰</span> Планы затрат</h2>
        <div className="page-header-hint">
          Список тендеров основного строительства. Ответственного за план затрат можно назначить в карточке тендера.
        </div>
      </div>

      <div className="cost-plans-tabs">
        <button
          className={`tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все планы затрат
          <span className="tab-count">{liveRows.length}</span>
        </button>
        <button
          type="button"
          className={`tab cost-plans-status-toggle ${['not_started', 'in_work', 'completed'].includes(activeTab) ? 'active' : ''}`}
          onClick={() => setStatusMenuOpen(o => !o)}
          aria-expanded={statusMenuOpen}
          title="Развернуть/свернуть статусы планов затрат"
        >
          Статусы планов затрат
          <span className="tab-chevron" aria-hidden>{statusMenuOpen ? '▾' : '▸'}</span>
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
              className={`tab ${activeTab === 'in_work' ? 'active' : ''}`}
              onClick={() => setActiveTab('in_work')}
            >
              В работе
              <span className="tab-count">{inWork.length}</span>
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
        {/* task 267: удалённые планы затрат (тендер удалён → сюда) */}
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
            {responsibles.map(name => {
              const cnt = tenders.filter(t => (t.cost_plan_responsible?.full_name || '') === name).length
              return (
                <option key={name} value={name}>
                  {name} ({cnt})
                </option>
              )
            })}
          </select>
        </label>
        {(responsibleFilter || objectFilter || searchQuery) && (
          <button className="reset-btn" onClick={() => { setResponsibleFilter(''); setObjectFilter(''); setSearchQuery('') }}>Сбросить</button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '52px' }}>№ п/п</th>
              <th style={{ width: '150px' }}>Объект</th>
              <th>Описание работ</th>
              <th>Ответственный</th>
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_start_date')}
                title="Сортировать по началу тендерной процедуры"
                style={{ width: '120px', cursor: 'pointer', userSelect: 'none' }}
              >
                Начало<br />тендера{sortIndicator('tender_start_date')}
              </th>
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_end_date')}
                title="Сортировать по окончанию тендерной процедуры"
                style={{ width: '120px', cursor: 'pointer', userSelect: 'none' }}
              >
                Окончание<br />тендера{sortIndicator('tender_end_date')}
              </th>
              <th>Срок выполнения плана затрат</th>
              <th>План затрат</th>
              <th style={{ width: '180px' }}>Статус плана</th>
              <th style={{ minWidth: '220px' }}>Примечание</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="no-data">
                  {tenders.length === 0
                    ? 'Нет тендеров. Создайте тендер на странице «Тендеры».'
                    : activeTab === 'deleted'
                      ? 'Удалённых планов затрат нет'
                      : activeTab === 'all'
                        ? 'Нет планов затрат'
                        : activeTab === 'completed'
                          ? 'Завершённых планов затрат нет'
                          : activeTab === 'in_work'
                            ? 'Нет планов затрат в работе'
                            : 'Нет планов затрат со статусом «Не начат»'}
                </td>
              </tr>
            ) : (
              visible.map((t, idx) => (
                <tr key={t.id}>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</td>
                  <td style={{ width: '150px', maxWidth: '150px', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                    {t.objects?.name || '—'}
                  </td>
                  <td className="muted-text">
                    <Link
                      to={`/tenders/${t.id}`}
                      className="row-link primary"
                      title="Открыть тендер (Ctrl+клик или средняя кнопка — в новой вкладке)"
                      style={{ whiteSpace: 'normal', textAlign: 'left', wordBreak: 'break-word', display: 'inline-block' }}
                    >
                      {t.work_description || '—'}
                    </Link>
                  </td>
                  <td>
                    {editingResponsibleId === t.id ? (
                      <select
                        autoFocus
                        className="inline-responsible-select"
                        value={t.cost_plan_responsible_id || ''}
                        onChange={(e) => {
                          handleChangeResponsible(t.id, e.target.value)
                          setEditingResponsibleId(null)
                        }}
                        onBlur={() => setEditingResponsibleId(null)}
                      >
                        <option value="">— не назначен —</option>
                        {uniqueContacts.map(c => (
                          <option key={c.id} value={c.id}>{c.full_name}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        className="responsible-display"
                        onClick={() => setEditingResponsibleId(t.id)}
                        title="Назначить ответственного"
                      >
                        {t.cost_plan_responsible?.full_name || (
                          <span className="responsible-empty">— не назначен —</span>
                        )}
                      </button>
                    )}
                    {t.cost_plan_responsible?.position && (
                      <div className="muted-tiny">{t.cost_plan_responsible.position}</div>
                    )}
                  </td>
                  <td className="muted-text" style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {t.tender_start_date
                      ? new Date(t.tender_start_date).toLocaleDateString('ru-RU')
                      : <span className="muted-tiny">—</span>}
                  </td>
                  <td className="muted-text" style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {t.tender_end_date
                      ? new Date(t.tender_end_date).toLocaleDateString('ru-RU')
                      : <span className="muted-tiny">—</span>}
                  </td>
                  <td>
                    <div className="inline-date-range">
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.cost_plan_start_date || ''}
                        onChange={(e) => handleChangeCostPlanDate(t.id, 'cost_plan_start_date', e.target.value)}
                        title="Начало"
                      />
                      <span className="dash">—</span>
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.cost_plan_end_date || ''}
                        onChange={(e) => handleChangeCostPlanDate(t.id, 'cost_plan_end_date', e.target.value)}
                        title="Окончание"
                      />
                    </div>
                  </td>
                  <td>
                    {t.cost_plan_link ? (
                      <div className="cost-plan-link-cell">
                        <a
                          href={t.cost_plan_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          Открыть
                        </a>
                        <button
                          className="link-edit-btn"
                          onClick={() => openLinkModal(t.id, t.cost_plan_link)}
                          title="Изменить ссылку"
                          aria-label="Изменить ссылку"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        className="link-add-btn"
                        onClick={() => openLinkModal(t.id, '')}
                        title="Добавить ссылку на план затрат"
                      >
                        + ссылка
                      </button>
                    )}
                  </td>
                  <td>
                    <select
                      className={`plan-status-select status-${t.cost_plan_status}`}
                      value={t.cost_plan_status || 'not_started'}
                      onChange={(e) => handleChangeStatus(t.id, e.target.value)}
                    >
                      {STATUS_OPTIONS.map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <textarea
                      className="cost-plan-notes"
                      defaultValue={t.cost_plan_notes || ''}
                      placeholder="Примечание…"
                      rows={1}
                      onInput={(e) => {
                        // auto-grow: подстраиваем высоту под содержимое
                        e.target.style.height = 'auto'
                        e.target.style.height = e.target.scrollHeight + 'px'
                      }}
                      onBlur={(e) => {
                        const v = e.target.value
                        if ((t.cost_plan_notes || '') !== (v.trim() || '')) {
                          handleChangeCostPlanNotes(t.id, v)
                        }
                      }}
                      ref={(el) => {
                        if (!el) return
                        // первая инициализация — растягиваем под существующее содержимое
                        el.style.height = 'auto'
                        el.style.height = el.scrollHeight + 'px'
                      }}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* task 211: модалка редактирования ссылки на план затрат */}
      {linkModal && (
        <div className="cp-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setLinkModal(null) }}>
          <div className="cp-modal" role="dialog" aria-modal="true">
            <div className="cp-modal-header">
              <h3>Ссылка на план затрат</h3>
              <button className="cp-modal-close" onClick={() => setLinkModal(null)} aria-label="Закрыть">×</button>
            </div>
            <div className="cp-modal-body">
              <label className="cp-modal-label">Ссылка (Google Drive / Яндекс.Диск)</label>
              <input
                type="url"
                className="cp-modal-input"
                placeholder="https://…"
                autoFocus
                value={linkModal.value}
                onChange={(e) => setLinkModal(m => ({ ...m, value: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveCostPlanLink()
                  if (e.key === 'Escape') setLinkModal(null)
                }}
              />
              {linkModal.value.trim() && (
                <a
                  href={linkModal.value.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cp-modal-preview-link"
                >
                  Открыть введённую ссылку →
                </a>
              )}
            </div>
            <div className="cp-modal-footer">
              {linkModal.value.trim() && (
                <button
                  className="cp-modal-btn-ghost"
                  onClick={() => setLinkModal(m => ({ ...m, value: '' }))}
                >
                  Очистить
                </button>
              )}
              <button className="cp-modal-btn-secondary" onClick={() => setLinkModal(null)}>Отмена</button>
              <button className="cp-modal-btn-primary" onClick={handleSaveCostPlanLink}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CostPlansPage
