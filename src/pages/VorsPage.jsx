import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useRole } from '../contexts/RoleContext'
import VorDocsModal from '../components/VorDocsModal'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import IconTile from '../components/IconTile'
import FilterDropdown from '../components/FilterDropdown'
import { IconObject, IconUser, IconSearch } from '../components/icons/ToolbarIcons'
import { IconDocument } from '../components/icons/TenderHubIcons'
import './CostPlansPage.css'

// Значение фильтра «Ответственный» для тендеров без ответственного.
const UNASSIGNED = '__unassigned__'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed']

function VorsPage() {
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
  const [activeTab, setActiveTab] = useState('all') // 'all' | 'not_started' | 'in_progress' | 'completed'
  // task 241: статус-вкладки скрыты под кнопкой «ВОРы и РД по статусам»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  // Фильтры — множественный выбор, как в «Планах затрат» (FilterDropdown).
  const [responsibleFilters, setResponsibleFilters] = useState([])
  const [objectFilterIds, setObjectFilterIds] = useState([]) // task 239: фильтр по объектам
  const [searchQuery, setSearchQuery] = useState('') // task 239: поиск
  const [allContacts, setAllContacts] = useState([])
  const [editingResponsibleId, setEditingResponsibleId] = useState(null)
  // task 432: сортировка по номеру тендера (клик по заголовку колонки «№ тендера»)
  const [sortKey, setSortKey] = useState('') // '' | 'public_tender_number'
  const [sortDir, setSortDir] = useState('asc') // 'asc' | 'desc'
  // task 393: документы «ВОРы и РД» (S3, категория 'vor')
  const [vorDocsModalTenderId, setVorDocsModalTenderId] = useState(null)
  const [vorDocCounts, setVorDocCounts] = useState({}) // tenderId → число документов

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
      // Постранично: без .range() PostgREST молча отдал бы только первые 1000
      // тендеров, и часть реестра просто не появилась бы на странице.
      const data = await fetchAllRows((from, to) => supabase
        .from('tenders')
        .select(`
          id, object_id, public_tender_number, status, tender_type, department, vor_status, vor_link,
          vor_responsible_id, vor_start_date, vor_end_date,
          start_date, end_date, work_description, deleted_at,
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position)
        `)
        .order('start_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))

      // Только основные тендеры (без дочерних на материалы) по основному строительству.
      // Направление берём из tenders.department (миграция 20260820), а не из статуса
      // объекта: у «совместных» и «прочих» объект может быть тот же самый.
      let filtered = (data || []).filter(t =>
        (t.department || 'construction') === 'construction'
        && (!t.tender_type || t.tender_type === 'main')
      )
      if (scopedObjectIds.length > 0) {
        filtered = filtered.filter(t => scopedObjectIds.includes(t.object_id))
      }
      setTenders(filtered)
      fetchVorDocCounts(filtered.map(t => t.id))
    } catch (err) {
      console.error('Ошибка загрузки ВОРов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds])

  // task 393: счётчики ВОР-документов одним запросом (для бейджа и статус-гейта)
  const fetchVorDocCounts = async (tenderIds) => {
    if (!tenderIds || tenderIds.length === 0) { setVorDocCounts({}); return }
    try {
      const { data, error } = await supabase
        .from('s3_documents')
        .select('owner_id')
        .eq('owner_type', 'tender')
        .eq('doc_category', 'vor')
        .in('owner_id', tenderIds)
      if (error) throw error
      const counts = {}
      for (const row of data || []) {
        counts[row.owner_id] = (counts[row.owner_id] || 0) + 1
      }
      setVorDocCounts(counts)
    } catch (err) {
      console.error('Ошибка загрузки счётчиков документов ВОР:', err.message)
    }
  }

  // Пересчитать число документов для одного тендера (после загрузки/удаления в модалке)
  const refreshVorDocCount = async (tenderId) => {
    try {
      const { count, error } = await supabase
        .from('s3_documents')
        .select('id', { count: 'exact', head: true })
        .eq('owner_type', 'tender')
        .eq('doc_category', 'vor')
        .eq('owner_id', tenderId)
      if (error) throw error
      setVorDocCounts(prev => ({ ...prev, [tenderId]: count || 0 }))
    } catch (err) {
      console.error('Ошибка обновления счётчика документов ВОР:', err.message)
    }
  }

  useEffect(() => {
    fetchTenders()
    fetchAllContacts()
  }, [fetchTenders])

  const handleChangeStatus = async (tenderId, newStatus) => {
    if (newStatus === 'completed') {
      const tender = tenders.find(t => t.id === tenderId)
      const hasDocs = (vorDocCounts[tenderId] || 0) > 0
      if (!tender?.vor_link && !hasDocs) {
        alert('Нельзя установить статус «Завершён»: нет ни ссылки, ни прикреплённого документа на ВОРы и РД.')
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

  // task 432: сортировка по клику на заголовок колонки
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
  if (responsibleFilters.length > 0) {
    filtered = filtered.filter(t => responsibleFilters.includes(t.vor_responsible?.id || UNASSIGNED))
  }
  if (objectFilterIds.length > 0) filtered = filtered.filter(t => objectFilterIds.includes(t.object_id))
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(t =>
      String(t.public_tender_number ?? '').includes(q) ||
      (t.objects?.name || '').toLowerCase().includes(q) ||
      (t.work_description || '').toLowerCase().includes(q) ||
      (t.vor_responsible?.full_name || '').toLowerCase().includes(q)
    )
  }

  // task 432: сортировка по выбранной колонке (сейчас — только № тендера)
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
  const hasActiveFilters = responsibleFilters.length > 0 || objectFilterIds.length > 0 || searchQuery.trim() !== ''
  const unassignedCount = tenders.filter(t => !t.vor_responsible?.id).length

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
        <h2>
          <IconTile tone="amber" className="page-icon-tile"><IconDocument size={16} /></IconTile>
          ВОРы и РД
        </h2>
        <div className="cp-header-right">
          <div className="page-header-hint">
            Список тендеров основного строительства. Ответственного за ВОРы и РД можно назначить в карточке тендера.
          </div>
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

      {/* Фильтры — те же выпадашки, что в «Планах затрат» и реестрах: с поиском
          внутри и множественным выбором. Нативные <select> на 300+ объектов
          выглядели чужеродно и листались тяжело. */}
      <div className="cost-plans-toolbar">
        <div className="cp-search-wrap">
          <IconSearch />
          <input
            type="search"
            className="cost-plans-search"
            placeholder="Поиск по № тендера, объекту, описанию, ответственному…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск объекта…"
          allLabel="Все объекты"
          icon={<IconObject size={15} />}
          value={objectFilterIds}
          onChange={setObjectFilterIds}
          options={objectsList.map(o => ({
            value: o.id,
            label: `${o.name} (${tenders.filter(t => t.object_id === o.id).length})`,
          }))}
        />
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск ответственного…"
          allLabel="Все ответственные"
          icon={<IconUser size={15} />}
          value={responsibleFilters}
          onChange={setResponsibleFilters}
          options={[
            { value: UNASSIGNED, label: `Не назначен (${unassignedCount})` },
            ...responsibles.map(r => ({
              value: r.id,
              label: `${r.full_name} (${tenders.filter(t => t.vor_responsible?.id === r.id).length})`,
            })),
          ]}
        />
        <div className="cp-toolbar-tail">
          <span className="cp-shown">Показано: <b>{activeTab === 'deleted' ? deletedRows.length : visible.length}</b></span>
          {hasActiveFilters && (
            <button
              type="button"
              className="reset-btn"
              onClick={() => { setResponsibleFilters([]); setObjectFilterIds([]); setSearchQuery('') }}
            >Сбросить</button>
          )}
        </div>
      </div>

      <div className="table-container">
        <table className="data-table vors-table">
          <thead>
            <tr>
              <th
                className="sortable-th"
                onClick={() => toggleSort('public_tender_number')}
                title="Номер тендера. Кликните для сортировки"
                style={{ width: '64px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                №<br />тендера{sortIndicator('public_tender_number')}
              </th>
              <th style={{ width: '160px' }}>Объект</th>
              <th>Описание работ</th>
              <th style={{ width: '170px' }}>Ответственный</th>
              <th style={{ width: '170px' }}>Срок подготовки ВОР</th>
              <th style={{ width: '240px' }}>ВОРы и РД</th>
              <th style={{ width: '150px' }}>Статус</th>
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
              visible.map((t) => (
                <tr key={t.id}>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {t.public_tender_number ?? '—'}
                  </td>
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
                  <td>
                    <Link
                      to={`/tenders/${t.id}`}
                      className="vor-desc-link"
                      title="Открыть тендер (Ctrl+клик — в новой вкладке)"
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
                    <div className="inline-date-range vor-date-range">
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
                    <div className="vor-links-cell">
                      {t.vor_link ? (
                        <div className="cost-plan-link-cell">
                          <a
                            href={t.vor_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="link"
                          >
                            Открыть
                          </a>
                          <button
                            className="link-edit-btn"
                            onClick={() => handleChangeVorLink(t.id, t.vor_link)}
                            title="Изменить ссылку"
                            aria-label="Изменить ссылку"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <button
                          className="link-add-btn"
                          onClick={() => handleChangeVorLink(t.id, '')}
                          title="Добавить ссылку на ВОРы и РД"
                        >
                          + ссылка
                        </button>
                      )}
                      <button
                        type="button"
                        className={`vor-docs-btn${vorDocCounts[t.id] ? ' has-docs' : ''}`}
                        onClick={() => setVorDocsModalTenderId(t.id)}
                        title="Документы ВОР и РД"
                      >
                        <PaperclipIcon size={12} />
                        <span>Документы</span>
                        {vorDocCounts[t.id] > 0 && <span className="vor-docs-count">{vorDocCounts[t.id]}</span>}
                      </button>
                    </div>
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

      {vorDocsModalTenderId && (
        <VorDocsModal
          tenderId={vorDocsModalTenderId}
          onClose={() => setVorDocsModalTenderId(null)}
          onChange={() => refreshVorDocCount(vorDocsModalTenderId)}
        />
      )}
    </div>
  )
}

export default VorsPage
