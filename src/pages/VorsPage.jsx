import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useRole } from '../contexts/RoleContext'
import VorRdModal from '../components/VorRdModal'
import { countVorRdDocs, fetchVorRdDocCounts } from '../services/tenderVorRd'
import { fetchStoEmployees, vorResponsibleOf, isMissingStoColumnError, STO_MIGRATION_HINT } from '../services/stoEmployees'
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
  const { scopedObjectIds, userProfile, canEdit, canView } = useRole()
  // Править ВОРы может тот, у кого есть правка «Тендеров» или «ВОРов и РД».
  const canEditVors = canEdit('tenders') || canEdit('vors')
  // Без доступа к тендерам (сметно-технический отдел) карточку тендера не
  // открываем: клик по описанию показывает только ВОРы и РД.
  const canOpenTender = canView('tenders')
  const canOpenObject = canView('objects')

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
  // Сотрудники СТО из реестра «Администрирование» — варианты «Ответственного СТО».
  const [stoEmployees, setStoEmployees] = useState([])
  const [stoError, setStoError] = useState(null)
  // false — в базе ещё нет колонок vor_sto_* (миграция 20260922 не применена).
  const [stoSupported, setStoSupported] = useState(true)
  const [editingResponsibleId, setEditingResponsibleId] = useState(null)
  // task 432: сортировка по номеру тендера (клик по заголовку колонки «№ тендера»)
  const [sortKey, setSortKey] = useState('') // '' | 'public_tender_number'
  const [sortDir, setSortDir] = useState('asc') // 'asc' | 'desc'
  // task 393: документы «ВОРы и РД» (S3, категория 'vor')
  const [vorDocsModalTenderId, setVorDocsModalTenderId] = useState(null)
  const [vorDocCounts, setVorDocCounts] = useState({}) // tenderId → число документов

  const loadStoEmployees = async () => {
    try {
      setStoEmployees(await fetchStoEmployees())
      setStoError(null)
    } catch (err) {
      console.error('Ошибка загрузки сотрудников СТО:', err.message)
      setStoError(err.message)
    }
  }

  const fetchTenders = useCallback(async () => {
    try {
      setLoading(true)
      // Постранично: без .range() PostgREST молча отдал бы только первые 1000
      // тендеров, и часть реестра просто не появилась бы на странице.
      const load = (stoCols) => fetchAllRows((from, to) => supabase
        .from('tenders')
        .select(`
          id, object_id, public_tender_number, status, tender_type, department, vor_status, vor_link,
          vor_responsible_id, vor_start_date, vor_end_date,
          start_date, end_date, work_description, deleted_at${stoCols},
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position),
          responsible_contact:contacts!responsible_contact_id(id, full_name)
        `)
        .order('start_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))
      // Колонок СТО до миграции 20260922 нет — страница работает и без них.
      let data
      try {
        data = await load(', vor_sto_user_id, vor_sto_name')
        setStoSupported(true)
      } catch (err) {
        if (!isMissingStoColumnError(err)) throw err
        data = await load('')
        setStoSupported(false)
      }

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

  // Счётчики документов раздела (РД, ВОР и ранее загруженные) — для бейджа и
  // статус-гейта «Завершён». Порциями: сотни UUID одним IN-списком роняют запрос.
  const fetchVorDocCounts = async (tenderIds) => {
    try {
      setVorDocCounts(await fetchVorRdDocCounts(tenderIds))
    } catch (err) {
      console.error('Ошибка загрузки счётчиков документов ВОР:', err.message)
    }
  }

  // Пересчитать число документов для одного тендера (после изменений в окне)
  const refreshVorDocCount = async (tenderId) => {
    try {
      const count = await countVorRdDocs(tenderId)
      setVorDocCounts(prev => ({ ...prev, [tenderId]: count }))
    } catch (err) {
      console.error('Ошибка обновления счётчика документов ВОР:', err.message)
    }
  }

  useEffect(() => {
    fetchTenders()
  }, [fetchTenders])

  // Список СТО нужен только для назначения — грузим при первом открытии выбора.
  useEffect(() => {
    if (editingResponsibleId && stoEmployees.length === 0 && !stoError) loadStoEmployees()
  }, [editingResponsibleId]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Ответственный СТО — только пользователь реестра с ролью СТО (миграция 20260922).
  const handleChangeResponsible = async (tenderId, userId) => {
    if (!stoSupported) { alert(STO_MIGRATION_HINT); return }
    const value = userId || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldName = vorResponsibleOf(tender).name || null
    const emp = value ? stoEmployees.find(x => x.user_id === value) : null
    if (value && !emp) { alert('Выберите сотрудника сметно-технического отдела из списка.'); return }
    const newName = emp?.display_name || null
    const patch = { vor_sto_user_id: value, vor_sto_name: newName }
    try {
      const { error } = await supabase.from('tenders').update(patch).eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => (t.id === tenderId ? { ...t, ...patch } : t)))
      if (oldName !== newName) {
        logTenderEvent(tenderId, 'field_updated', {
          fieldName: 'vor_sto_user_id',
          oldValue: oldName,
          newValue: newName,
          description: newName
            ? (oldName ? `Сменён ответственный СТО: ${oldName} → ${newName}` : `Назначен ответственный СТО: ${newName}`)
            : `Снят ответственный СТО (был: ${oldName})`,
        })
      }
    } catch (err) {
      console.error('Ошибка назначения ответственного СТО:', err.message)
      alert(isMissingStoColumnError(err) ? STO_MIGRATION_HINT : 'Ошибка: ' + err.message)
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

  // Ключ ответственного для фильтра: СТО из реестра — по user_id, прежний
  // контакт — по id контакта, нет никого — UNASSIGNED.
  const responsibleKeyOf = (t) => (t.vor_sto_user_id ? `sto:${t.vor_sto_user_id}`
    : t.vor_responsible?.id ? `contact:${t.vor_responsible.id}` : UNASSIGNED)
  const responsibleMap = new Map()
  for (const t of tenders) {
    const key = responsibleKeyOf(t)
    if (key === UNASSIGNED) continue
    const entry = responsibleMap.get(key) || { key, name: vorResponsibleOf(t).name, count: 0 }
    entry.count += 1
    responsibleMap.set(key, entry)
  }
  const responsibles = Array.from(responsibleMap.values())
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))

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
    filtered = filtered.filter(t => responsibleFilters.includes(responsibleKeyOf(t)))
  }
  if (objectFilterIds.length > 0) filtered = filtered.filter(t => objectFilterIds.includes(t.object_id))
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(t =>
      String(t.public_tender_number ?? '').includes(q) ||
      (t.objects?.name || '').toLowerCase().includes(q) ||
      (t.work_description || '').toLowerCase().includes(q) ||
      (vorResponsibleOf(t).name || '').toLowerCase().includes(q) ||
      (t.responsible_contact?.full_name || '').toLowerCase().includes(q)
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
  const unassignedCount = tenders.filter(t => responsibleKeyOf(t) === UNASSIGNED).length

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
            Список тендеров основного строительства. Ответственный СТО выбирается из сотрудников сметно-технического отдела.
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
          searchPlaceholder="Поиск ответственного СТО…"
          allLabel="Все ответственные СТО"
          icon={<IconUser size={15} />}
          value={responsibleFilters}
          onChange={setResponsibleFilters}
          options={[
            { value: UNASSIGNED, label: `Не назначен (${unassignedCount})` },
            ...responsibles.map(r => ({
              value: r.key,
              label: `${r.name} (${r.count})`,
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
              <th style={{ width: '170px' }}>Ответственный СТО</th>
              <th style={{ width: '150px' }}>Ответственный<br />по тендеру</th>
              <th style={{ width: '170px' }}>Срок подготовки ВОР</th>
              <th style={{ width: '240px' }}>ВОРы и РД</th>
              <th style={{ width: '150px' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="no-data">
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
                    {t.object_id && canOpenObject ? (
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
                    {canOpenTender ? (
                      <Link
                        to={`/tenders/${t.id}`}
                        className="vor-desc-link"
                        title="Открыть тендер (Ctrl+клик — в новой вкладке)"
                      >
                        {t.work_description || '—'}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="vor-desc-link vor-desc-btn"
                        onClick={() => setVorDocsModalTenderId(t.id)}
                        title="Открыть ВОРы и РД по тендеру"
                      >
                        {t.work_description || '—'}
                      </button>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const resp = vorResponsibleOf(t)
                      if (canEditVors && editingResponsibleId === t.id) {
                        return (
                          <select
                            autoFocus
                            className="inline-responsible-select"
                            value={t.vor_sto_user_id || ''}
                            onChange={(e) => {
                              handleChangeResponsible(t.id, e.target.value)
                              setEditingResponsibleId(null)
                            }}
                            onBlur={() => setEditingResponsibleId(null)}
                          >
                            <option value="">— не назначен —</option>
                            {stoError && <option value="" disabled>{stoError}</option>}
                            {!stoError && stoEmployees.length === 0 && (
                              <option value="" disabled>Нет сотрудников с ролью СТО</option>
                            )}
                            {stoEmployees.map(emp => (
                              <option key={emp.user_id} value={emp.user_id}>{emp.display_name}</option>
                            ))}
                          </select>
                        )
                      }
                      return (
                        <>
                          <button
                            className="responsible-display"
                            onClick={() => canEditVors && setEditingResponsibleId(t.id)}
                            title={canEditVors ? 'Назначить ответственного СТО' : undefined}
                            disabled={!canEditVors}
                          >
                            {resp.name || <span className="responsible-empty">— не назначен —</span>}
                          </button>
                          {/* Прежний ответственный из справочника «Сотрудники» — пока
                              СТО из реестра не назначен. */}
                          {resp.name && !resp.fromRegistry && (
                            <div className="muted-tiny" title="Назначен до перехода на выбор из реестра СТО — переназначьте">
                              не из реестра СТО
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </td>
                  <td className="muted-text">
                    {t.responsible_contact?.full_name || <span className="muted-tiny">—</span>}
                  </td>
                  <td>
                    <div className="inline-date-range vor-date-range">
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.vor_start_date || ''}
                        disabled={!canEditVors}
                        onChange={(e) => handleChangeVorDate(t.id, 'vor_start_date', e.target.value)}
                        title="Начало"
                      />
                      <span className="dash">—</span>
                      <input
                        type="date"
                        className="inline-date-input"
                        value={t.vor_end_date || ''}
                        disabled={!canEditVors}
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
                          {canEditVors && <button
                            className="link-edit-btn"
                            onClick={() => handleChangeVorLink(t.id, t.vor_link)}
                            title="Изменить ссылку"
                            aria-label="Изменить ссылку"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>}
                        </div>
                      ) : canEditVors ? (
                        <button
                          className="link-add-btn"
                          onClick={() => handleChangeVorLink(t.id, '')}
                          title="Добавить ссылку на ВОРы и РД"
                        >
                          + ссылка
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`vor-docs-btn${vorDocCounts[t.id] ? ' has-docs' : ''}`}
                        onClick={() => setVorDocsModalTenderId(t.id)}
                        title="Рабочая документация (PDF с шифрами) и ведомости объёмов работ"
                      >
                        <PaperclipIcon size={12} />
                        <span>РД и ВОР</span>
                        {vorDocCounts[t.id] > 0 && <span className="vor-docs-count">{vorDocCounts[t.id]}</span>}
                      </button>
                    </div>
                  </td>
                  <td>
                    <select
                      className={`plan-status-select status-${t.vor_status}`}
                      value={t.vor_status || 'not_started'}
                      disabled={!canEditVors}
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

      {vorDocsModalTenderId && (() => {
        const t = tenders.find(x => x.id === vorDocsModalTenderId)
        const title = t
          ? `ВОРы и РД — № ${t.public_tender_number ?? '—'}${t.objects?.name ? `, ${t.objects.name}` : ''}`
          : 'ВОРы и РД'
        return (
          <VorRdModal
            tenderId={vorDocsModalTenderId}
            title={title}
            canEdit={canEditVors}
            onClose={() => setVorDocsModalTenderId(null)}
            onChange={() => refreshVorDocCount(vorDocsModalTenderId)}
          />
        )
      })()}
    </div>
  )
}

export default VorsPage
