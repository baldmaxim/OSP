import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './CostPlansPage.css'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed']

function CostPlansPage() {
  const navigate = useNavigate()
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
  const [activeTab, setActiveTab] = useState('in_work') // 'in_work' | 'completed'
  const [responsibleFilter, setResponsibleFilter] = useState('')
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
          work_description, cost_plan_notes,
          objects(name, status),
          cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name, position)
        `)
        .is('deleted_at', null)
        .order('start_date', { ascending: false })

      if (error) throw error
      // Только основные тендеры по основному строительству — план затрат имеет смысл только там.
      // Дочерние тендеры на материалы (tender_type='materials') исключаем, чтобы не дублировать.
      let filtered = (data || []).filter(t =>
        t.objects?.status === 'main_construction'
        && (!t.tender_type || t.tender_type === 'main')
      )
      if (scopedObjectId) {
        // Запрос вернул объект только в JOIN — фильтруем дополнительно через REST-запрос id-объекта,
        // но здесь данные уже содержат objects.id неявно. Используем другой путь:
        filtered = filtered.filter(t => t.object_id === scopedObjectId)
      }
      setTenders(filtered)
    } catch (err) {
      console.error('Ошибка загрузки планов затрат:', err.message)
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

  const handleChangeCostPlanLink = async (tenderId, currentLink) => {
    const next = window.prompt('Ссылка на план затрат (Google/Yandex Drive):', currentLink || '')
    if (next === null) return
    const value = next.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ cost_plan_link: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, cost_plan_link: value } : t))
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

  // Уникальные ответственные для фильтра
  const responsibleMap = new Map()
  for (const t of tenders) {
    const r = t.cost_plan_responsible
    if (r?.id && !responsibleMap.has(r.id)) responsibleMap.set(r.id, r)
  }
  const responsibles = Array.from(responsibleMap.values())
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'))

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

  // Фильтрация по ответственному и объекту
  let filtered = tenders
  if (responsibleFilter) filtered = filtered.filter(t => t.cost_plan_responsible?.id === responsibleFilter)
  if (objectFilter) filtered = filtered.filter(t => t.object_id === objectFilter)

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

  // Разделение по табу
  const inWork = filtered.filter(t => t.cost_plan_status !== 'completed')
  const completed = filtered.filter(t => t.cost_plan_status === 'completed')
  const visible = activeTab === 'completed' ? completed : inWork

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
      </div>

      <div className="cost-plans-toolbar">
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
            {responsibles.map(r => {
              const cnt = tenders.filter(t => t.cost_plan_responsible?.id === r.id).length
              return (
                <option key={r.id} value={r.id}>
                  {r.full_name} ({cnt})
                </option>
              )
            })}
          </select>
        </label>
        {(responsibleFilter || objectFilter) && (
          <button className="reset-btn" onClick={() => { setResponsibleFilter(''); setObjectFilter('') }}>Сбросить</button>
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
              <th className="actions-column">Действия</th>
              <th style={{ minWidth: '220px' }}>Примечание</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={11} className="no-data">
                  {activeTab === 'completed'
                    ? 'Завершённых планов затрат нет'
                    : tenders.length === 0
                      ? 'Нет тендеров. Создайте тендер на странице «Тендеры».'
                      : 'Все планы для выбранного фильтра завершены — переключитесь на вкладку «Завершено».'}
                </td>
              </tr>
            ) : (
              visible.map((t, idx) => (
                <tr key={t.id}>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</td>
                  <td>
                    <button
                      className="row-link primary"
                      onClick={() => navigate(`/tenders/${t.id}`)}
                      title="Открыть тендер"
                    >
                      {t.objects?.name || '—'}
                    </button>
                  </td>
                  <td className="muted-text">{t.work_description}</td>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        <a
                          href={t.cost_plan_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          Открыть
                        </a>
                        <button
                          className="btn-icon btn-edit"
                          onClick={() => handleChangeCostPlanLink(t.id, t.cost_plan_link)}
                          title="Изменить ссылку"
                          style={{ fontSize: '0.75rem' }}
                        >
                          ✏️
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleChangeCostPlanLink(t.id, '')}
                        style={{
                          background: 'none',
                          border: '1px dashed var(--border-color)',
                          borderRadius: '4px',
                          padding: '0.1875rem 0.5rem',
                          color: 'var(--text-tertiary)',
                          cursor: 'pointer',
                          fontSize: '0.75rem'
                        }}
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
                  <td className="actions-cell">
                    <button
                      className="btn-secondary btn-small"
                      onClick={() => navigate(`/tenders/${t.id}`)}
                      title="Открыть тендер"
                    >
                      Тендер
                    </button>
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
    </div>
  )
}

export default CostPlansPage
