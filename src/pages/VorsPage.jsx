import { useState, useEffect } from 'react'
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

function VorsPage() {
  const navigate = useNavigate()
  const { scopedObjectId } = useRole()
  const [tenders, setTenders] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('in_work')
  const [responsibleFilter, setResponsibleFilter] = useState('')
  const [allContacts, setAllContacts] = useState([])
  const [editingResponsibleId, setEditingResponsibleId] = useState(null)

  useEffect(() => {
    fetchTenders()
    fetchAllContacts()
  }, [])

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

  const fetchTenders = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select(`
          id, object_id, status, vor_status, vor_link,
          vor_responsible_id, vor_start_date, vor_end_date,
          start_date, end_date, work_description,
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position)
        `)
        .is('deleted_at', null)
        .order('start_date', { ascending: false })

      if (error) throw error
      let filtered = (data || []).filter(t => t.objects?.status === 'main_construction')
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
  }

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
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ vor_responsible_id: value })
        .eq('id', tenderId)
      if (error) throw error
      const c = value ? allContacts.find(x => x.id === value) : null
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, vor_responsible_id: value, vor_responsible: c ? { id: c.id, full_name: c.full_name, position: c.position } : null }
          : t
      ))
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

  const filtered = responsibleFilter
    ? tenders.filter(t => t.vor_responsible?.id === responsibleFilter)
    : tenders

  const inWork = filtered.filter(t => t.vor_status !== 'completed')
  const completed = filtered.filter(t => t.vor_status === 'completed')
  const visible = activeTab === 'completed' ? completed : inWork

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
          Ответственный:
          <select
            value={responsibleFilter}
            onChange={(e) => setResponsibleFilter(e.target.value)}
          >
            <option value="">Все ({tenders.length})</option>
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
        {responsibleFilter && (
          <button className="reset-btn" onClick={() => setResponsibleFilter('')}>Сбросить</button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Объект</th>
              <th>Описание работ</th>
              <th>Ответственный</th>
              <th>Срок подготовки ВОР</th>
              <th>ВОРы и РД</th>
              <th style={{ width: '180px' }}>Статус</th>
              <th className="actions-column">Действия</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="no-data">
                  {activeTab === 'completed'
                    ? 'Завершённых ВОРов нет'
                    : tenders.length === 0
                      ? 'Нет тендеров. Создайте тендер на странице «Тендеры».'
                      : 'Все ВОРы для выбранного фильтра завершены — переключитесь на вкладку «Завершено».'}
                </td>
              </tr>
            ) : (
              visible.map((t) => (
                <tr key={t.id}>
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
                  <td className="actions-cell">
                    <button
                      className="btn-secondary btn-small"
                      onClick={() => navigate(`/tenders/${t.id}`)}
                      title="Открыть тендер"
                    >
                      Тендер
                    </button>
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
