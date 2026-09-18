import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useRole } from '../contexts/RoleContext'
import VorRdModal from '../components/VorRdModal'
import VorRequestModal from '../components/VorRequestModal'
import {
  fetchVorRequests, fetchVorRequestDocCounts, countVorRequestDocs,
  VOR_REQUESTS_TABLE, VOR_REQUESTS_MIGRATION_HINT,
} from '../services/vorRequests'
import { countVorRdDocs, fetchVorRdDocCounts } from '../services/tenderVorRd'
import { fetchStoEmployees, vorResponsibleOf, isMissingStoColumnError, STO_MIGRATION_HINT } from '../services/stoEmployees'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import DateRangeCell from '../components/DateRangeCell'
import IconTile from '../components/IconTile'
import FilterDropdown from '../components/FilterDropdown'
import { IconObject, IconUser, IconSearch, IconTag } from '../components/icons/ToolbarIcons'
import { IconDocument } from '../components/icons/TenderHubIcons'
import { isConstructionTender } from '../utils/tenderDepartments'
import { shortPersonName } from '../utils/personName'
import { vorStartDate } from '../utils/vorDates'
import { DUTY_OVERRIDE_KEY, parseDutyOverride, currentDuty } from '../utils/tenderDuty'
import './CostPlansPage.css'

// Значение фильтра «Ответственный» для тендеров без ответственного.
const UNASSIGNED = '__unassigned__'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Завершён',
  // ВОР для тендера не готовится (миграция 20260926).
  not_required: 'Не требуется',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed', 'not_required']

// Подразделение, готовящее ВОР (tenders.vor_division, миграция 20260927).
const VOR_DIVISIONS = [
  { value: 'monolith', label: 'Монолит' },
  { value: 'nvf_spk', label: 'НВФ, СПК' },
  { value: 'general', label: 'Общестроительные работы' },
  { value: 'hvac_water', label: 'ОВ, ВК' },
  { value: 'electrical', label: 'ЭОМ, СС' },
]
const VOR_DIVISION_LABEL = Object.fromEntries(VOR_DIVISIONS.map(d => [d.value, d.label]))
const NO_DIVISION = '__none__'
const DIVISION_MIGRATION_HINT = 'Подразделение недоступно: в базе не применена миграция 20260927_tender_vor_division.'

function isMissingDivisionColumnError(err) {
  return (err?.code === '42703' || err?.code === 'PGRST204') && /vor_division/.test(String(err?.message || ''))
}

// Направления страницы: основное строительство и совместные тендеры.
const SCOPES = [
  { key: 'construction', label: 'Основное строительство' },
  { key: 'joint', label: 'Совместные тендеры' },
]
const SCOPE_STORAGE_KEY = 'vors:scope'

// Статусы, при которых срок подготовки ВОР больше не отслеживается.
const VOR_CLOSED = ['completed', 'not_required']

// «Иванов Иван Иванович» → «ИИ»: две первые буквы фамилии и имени.
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

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
    // Заявки без тендера в журнал тендера не пишутся (там FK на tenders).
    if (tendersRef.current.find(t => t.id === tenderId)?._kind === 'request') return
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
  // Строки страницы: тендеры (_kind 'tender') и заявки на ВОР без тендера (_kind 'request').
  const [tenders, setTenders] = useState([])
  const tendersRef = useRef([])
  tendersRef.current = tenders
  // Направление: основное строительство / совместные тендеры (запоминается).
  const [scope, setScope] = useState(() => {
    try {
      const saved = localStorage.getItem(SCOPE_STORAGE_KEY)
      return SCOPES.some(x => x.key === saved) ? saved : 'construction'
    } catch {
      return 'construction'
    }
  })
  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope) } catch { /* приватный режим */ }
  }, [scope])
  // false — таблицы заявок ещё нет (миграция 20261003 не применена).
  const [requestsSupported, setRequestsSupported] = useState(true)
  // Окно заявки: { mode: 'create' } | { id } | null.
  const [requestModal, setRequestModal] = useState(null)
  // Объекты для формы новой заявки — грузятся при первом открытии формы.
  const [formObjects, setFormObjects] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all') // 'all' | 'not_started' | 'in_progress' | 'completed'
  // task 241: статус-вкладки скрыты под кнопкой «ВОРы и РД по статусам»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  // Фильтры — множественный выбор, как в «Планах затрат» (FilterDropdown).
  const [responsibleFilters, setResponsibleFilters] = useState([])
  const [objectFilterIds, setObjectFilterIds] = useState([]) // task 239: фильтр по объектам
  const [divisionFilter, setDivisionFilter] = useState([]) // подразделения; NO_DIVISION — не указано
  const [divisionSupported, setDivisionSupported] = useState(true)
  // Ручная замена дежурного по тендерам (app_settings); сам дежурный — по расписанию.
  const [dutyOverride, setDutyOverride] = useState(null)
  const [searchQuery, setSearchQuery] = useState('') // task 239: поиск
  // Сотрудники СТО из реестра «Администрирование» — варианты «Ответственного СТО».
  const [stoEmployees, setStoEmployees] = useState([])
  const [stoError, setStoError] = useState(null)
  // false — в базе ещё нет колонок vor_sto_* (миграция 20260922 не применена).
  const [stoSupported, setStoSupported] = useState(true)
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
      const load = (extraCols) => fetchAllRows((from, to) => supabase
        .from('tenders')
        .select(`
          id, object_id, public_tender_number, status, tender_type, department, vor_status, vor_link,
          vor_responsible_id, vor_start_date, vor_end_date, created_at,
          start_date, end_date, work_description, deleted_at${extraCols},
          objects(name, status),
          vor_responsible:contacts!vor_responsible_id(id, full_name, position),
          responsible_contact:contacts!responsible_contact_id(id, full_name)
        `)
        // Отбор направления на сервере; для основного строительства окончательная
        // проверка — isConstructionTender ниже.
        .or(scope === 'joint' ? 'department.eq.joint' : 'department.is.null,department.eq.construction')
        .order('start_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))
      // Колонок СТО (миграция 20260922) и подразделения (20260927) может ещё не
      // быть — убираем недостающие по одной, страница работает и без них.
      let sto = true
      let division = true
      let data
      for (;;) {
        try {
          data = await load((sto ? ', vor_sto_user_id, vor_sto_name' : '') + (division ? ', vor_division' : ''))
          break
        } catch (err) {
          if (sto && isMissingStoColumnError(err)) { sto = false; continue }
          if (division && isMissingDivisionColumnError(err)) { division = false; continue }
          throw err
        }
      }
      setStoSupported(sto)
      setDivisionSupported(division)

      // Только основные тендеры (без дочерних на материалы) по основному строительству.
      // Направление берём из tenders.department (миграция 20260820), а не из статуса
      // объекта: у «совместных» и «прочих» объект может быть тот же самый.
      // Без тендеров гарантийного отдела и «прочего»: см. isConstructionTender
      // (объект в гарантии или тендер без объекта из реестра — не наш раздел).
      let filtered = (data || []).filter(t =>
        (scope === 'joint' ? t.department === 'joint' : isConstructionTender(t))
        && (!t.tender_type || t.tender_type === 'main')
      ).map(t => ({ ...t, _kind: 'tender' }))

      // Заявки на ВОР без тендера того же направления (миграция 20261003).
      let requests = []
      try {
        const res = await fetchVorRequests(scope)
        setRequestsSupported(res.supported)
        requests = res.rows.map(r => ({ ...r, _kind: 'request' }))
      } catch (err) {
        console.error('Ошибка загрузки заявок на ВОР:', err.message)
      }

      let rows = [...requests, ...filtered]
      if (scopedObjectIds.length > 0) {
        rows = rows.filter(t => scopedObjectIds.includes(t.object_id))
      }
      setTenders(rows)
      fetchVorDocCounts(rows)
    } catch (err) {
      console.error('Ошибка загрузки ВОРов:', err.message)
      alert('Ошибка загрузки: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [scopedObjectIds, scope])

  // Счётчики документов раздела (РД, ВОР и ранее загруженные) — для бейджа и
  // статус-гейта «Завершён». Порциями: сотни UUID одним IN-списком роняют запрос.
  const fetchVorDocCounts = async (rows) => {
    try {
      const tenderIds = rows.filter(r => r._kind !== 'request').map(r => r.id)
      const requestIds = rows.filter(r => r._kind === 'request').map(r => r.id)
      const [tenderCounts, requestCounts] = await Promise.all([
        fetchVorRdDocCounts(tenderIds),
        requestIds.length ? fetchVorRequestDocCounts(requestIds) : {},
      ])
      setVorDocCounts({ ...tenderCounts, ...requestCounts })
    } catch (err) {
      console.error('Ошибка загрузки счётчиков документов ВОР:', err.message)
    }
  }

  // Пересчитать число документов для одного тендера (после изменений в окне)
  const refreshVorDocCount = async (tenderId) => {
    try {
      const isRequest = tendersRef.current.find(t => t.id === tenderId)?._kind === 'request'
      const count = isRequest ? await countVorRequestDocs(tenderId) : await countVorRdDocs(tenderId)
      setVorDocCounts(prev => ({ ...prev, [tenderId]: count }))
    } catch (err) {
      console.error('Ошибка обновления счётчика документов ВОР:', err.message)
    }
  }

  useEffect(() => {
    fetchTenders()
  }, [fetchTenders])

  // Список небольшой (сотрудники СТО) — грузим сразу: выпадашка есть в каждой строке.
  useEffect(() => { loadStoEmployees() }, [])

  useEffect(() => {
    let alive = true
    supabase.from('app_settings').select('value').eq('key', DUTY_OVERRIDE_KEY).maybeSingle()
      .then(({ data }) => { if (alive) setDutyOverride(parseDutyOverride(data?.value)) })
    return () => { alive = false }
  }, [])

  // Поля ВОР у заявки названы так же, как у тендера, — отличается только таблица.
  const tableOf = (id) => (tendersRef.current.find(t => t.id === id)?._kind === 'request' ? VOR_REQUESTS_TABLE : 'tenders')

  const openCreateRequest = async () => {
    if (!requestsSupported) { alert(VOR_REQUESTS_MIGRATION_HINT); return }
    setRequestModal({ mode: 'create' })
    if (formObjects) return
    try {
      const { data, error } = await supabase.from('objects').select('id, name, status').order('name', { ascending: true })
      if (error) throw error
      // У основного строительства — без объектов гарантийного отдела, как и у тендеров.
      setFormObjects(data || [])
    } catch (err) {
      console.error('Ошибка загрузки объектов:', err.message)
      setFormObjects([])
    }
  }

  const handleChangeDivision = async (tenderId, value) => {
    if (!divisionSupported) { alert(DIVISION_MIGRATION_HINT); return }
    const next = value || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldValue = tender?.vor_division || null
    if (oldValue === next) return
    try {
      const { error } = await supabase.from(tableOf(tenderId)).update({ vor_division: next }).eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => (t.id === tenderId ? { ...t, vor_division: next } : t)))
      const oldLabel = VOR_DIVISION_LABEL[oldValue] || null
      const newLabel = VOR_DIVISION_LABEL[next] || null
      logTenderEvent(tenderId, 'field_updated', {
        fieldName: 'vor_division',
        oldValue: oldLabel,
        newValue: newLabel,
        description: newLabel
          ? (oldLabel ? `Сменено подразделение ВОР: ${oldLabel} → ${newLabel}` : `Указано подразделение ВОР: ${newLabel}`)
          : `Снято подразделение ВОР (было: ${oldLabel})`,
      })
    } catch (err) {
      console.error('Ошибка изменения подразделения ВОР:', err.message)
      alert(isMissingDivisionColumnError(err) ? DIVISION_MIGRATION_HINT : 'Ошибка: ' + err.message)
    }
  }

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
        .from(tableOf(tenderId))
        .update({ vor_status: newStatus })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, vor_status: newStatus } : t))
    } catch (err) {
      console.error('Ошибка изменения статуса ВОР:', err.message)
      alert(newStatus === 'not_required' && (err.code === '23514' || /vor_status/.test(err.message || ''))
        ? 'Не удалось поставить «Не требуется»: в базе не применена миграция 20260926_vor_status_not_required.'
        : 'Ошибка: ' + err.message)
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
      const { error } = await supabase.from(tableOf(tenderId)).update(patch).eq('id', tenderId)
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
        .from(tableOf(tenderId))
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
        .from(tableOf(tenderId))
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
  if (divisionFilter.length > 0) filtered = filtered.filter(t => divisionFilter.includes(t.vor_division || NO_DIVISION))
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(t =>
      String(t.public_tender_number ?? '').includes(q) ||
      (t._kind === 'request' && `заявка ${t.request_number}`.includes(q)) ||
      (t.objects?.name || '').toLowerCase().includes(q) ||
      (t.work_description || '').toLowerCase().includes(q) ||
      (VOR_DIVISION_LABEL[t.vor_division] || '').toLowerCase().includes(q) ||
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
  const hasActiveFilters = responsibleFilters.length > 0 || objectFilterIds.length > 0 || divisionFilter.length > 0 || searchQuery.trim() !== ''
  const duty = currentDuty(dutyOverride)
  const unassignedCount = tenders.filter(t => responsibleKeyOf(t) === UNASSIGNED).length

  // task 241: разбивка по статусам ВОР (не начат / в работе / завершён)
  const notStarted = liveRows.filter(t => (t.vor_status || 'not_started') === 'not_started')
  const inProgress = liveRows.filter(t => t.vor_status === 'in_progress')
  const completed = liveRows.filter(t => t.vor_status === 'completed')
  const notRequired = liveRows.filter(t => t.vor_status === 'not_required')
  const visible = activeTab === 'deleted' ? deletedRows
    : activeTab === 'all' ? liveRows
    : activeTab === 'completed' ? completed
    : activeTab === 'not_required' ? notRequired
    : activeTab === 'in_progress' ? inProgress
    : notStarted

  return (
    <div className="cost-plans-page">
      <div className="page-header page-header-vors">
        <h2>
          <IconTile tone="amber" className="page-icon-tile"><IconDocument size={16} /></IconTile>
          ВОРы и РД
        </h2>
        <div className="vor-scope-switch" role="tablist" aria-label="Направление">
          {SCOPES.map(x => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={scope === x.key}
              className={`vor-scope-btn${scope === x.key ? ' is-active' : ''}`}
              onClick={() => { if (scope !== x.key) { setScope(x.key); setObjectFilterIds([]) } }}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="cp-header-right">
          {/* Тот же дежурный, что в шапке «Тендеров»; меняется там (админ). */}
          <div className="vor-duty-chip" title={`Дежурный по тендерам на этой неделе: ${duty.name}${duty.overridden ? ' (ручная замена)' : ''}`}>
            <IconUser size={15} />
            <span className="vor-duty-label">Дежурный по тендерам:</span>
            <span className="vor-duty-name">{duty.name}</span>
            {duty.overridden && <span className="vor-duty-dot" aria-hidden />}
          </div>
          <div className="page-header-hint">
            {scope === 'joint' ? 'Совместные тендеры' : 'Тендеры основного строительства'} и заявки на ВОР без тендера. Ответственный СТО выбирается из сотрудников сметно-технического отдела.
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
          className={`tab cost-plans-status-toggle ${['not_started', 'in_progress', 'completed', 'not_required'].includes(activeTab) ? 'active' : ''} ${statusMenuOpen ? 'open' : ''}`}
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
            <button
              className={`tab ${activeTab === 'not_required' ? 'active' : ''}`}
              onClick={() => setActiveTab('not_required')}
            >
              Не требуется
              <span className="tab-count">{notRequired.length}</span>
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
          label="" multiple
          allLabel="Все подразделения"
          icon={<IconTag size={15} />}
          value={divisionFilter}
          onChange={setDivisionFilter}
          options={[
            ...VOR_DIVISIONS.map(d => ({
              value: d.value,
              label: `${d.label} (${tenders.filter(t => t.vor_division === d.value).length})`,
            })),
            { value: NO_DIVISION, label: `Не указано (${tenders.filter(t => !t.vor_division).length})` },
          ]}
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
          {canEditVors && (
            <button
              type="button"
              className="vor-request-add"
              onClick={openCreateRequest}
              title="Заявка на подготовку ВОР без привязки к тендеру"
            >
              + Заявка на ВОР
            </button>
          )}
          <span className="cp-shown">Показано: <b>{activeTab === 'deleted' ? deletedRows.length : visible.length}</b></span>
          {hasActiveFilters && (
            <button
              type="button"
              className="reset-btn"
              onClick={() => { setResponsibleFilters([]); setObjectFilterIds([]); setDivisionFilter([]); setSearchQuery('') }}
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
              <th style={{ width: '150px' }}>Объект</th>
              <th>Описание работ</th>
              <th style={{ width: '125px' }}>Подразделение</th>
              <th style={{ width: '150px' }}>Ответственный СТО</th>
              <th style={{ width: '135px' }}>Ответственный<br />по тендеру</th>
              <th style={{ width: '165px' }}>Срок подготовки ВОР</th>
              <th style={{ width: '195px' }}>ВОРы и РД</th>
              <th style={{ width: '130px' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={9} className="no-data">
                  {tenders.length === 0
                    ? 'Нет тендеров и заявок. Создайте тендер на странице «Тендеры» или заявку на ВОР кнопкой выше.'
                    : activeTab === 'deleted'
                      ? 'Удалённых ВОРов нет'
                      : activeTab === 'completed'
                        ? 'Завершённых ВОРов нет'
                        : activeTab === 'not_required'
                          ? 'Нет тендеров, для которых ВОР не требуется'
                        : activeTab === 'in_progress'
                          ? 'Нет ВОРов в работе'
                          : activeTab === 'not_started'
                            ? 'Нет ВОРов со статусом «Не начат»'
                            : 'Нет ВОРов по выбранному фильтру'}
                </td>
              </tr>
            ) : (
              visible.map((t) => (
                <tr key={t.id} className={t._kind === 'request' ? 'vor-request-row' : undefined}>
                  <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {t._kind === 'request'
                      ? <span className="vor-request-badge" title="Заявка на ВОР без тендера">Заявка<br />№ {t.request_number}</span>
                      : (t.public_tender_number ?? '—')}
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
                    {t._kind === 'request' ? (
                      <button
                        type="button"
                        className="vor-desc-link vor-desc-btn"
                        onClick={() => setRequestModal({ id: t.id })}
                        title="Открыть заявку на ВОР"
                      >
                        {t.work_description || '—'}
                      </button>
                    ) : canOpenTender ? (
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
                    <FilterDropdown
                      className="vor-resp-fdrop vor-div-fdrop"
                      label=""
                      allLabel="— не указано —"
                      value={t.vor_division || ''}
                      onChange={(v) => handleChangeDivision(t.id, v)}
                      disabled={!canEditVors}
                      options={[{ value: '', label: '— не указано —' }, ...VOR_DIVISIONS]}
                      formatTrigger={() => (
                        t.vor_division
                          ? <span className="vor-div-chip">{VOR_DIVISION_LABEL[t.vor_division] || t.vor_division}</span>
                          : <span className="vor-resp-empty">— не указано —</span>
                      )}
                    />
                  </td>
                  <td>
                    {(() => {
                      const resp = vorResponsibleOf(t)
                      return (
                        <>
                          {/* Тот же портальный выпадающий список с поиском, что в
                              фильтрах страницы: нативный <select> в строке таблицы
                              выглядел чужеродно и не искал по фамилии. */}
                          <FilterDropdown
                            className="vor-resp-fdrop"
                            label="" searchable
                            searchPlaceholder="Поиск сотрудника СТО…"
                            allLabel="— не назначен —"
                            value={t.vor_sto_user_id || ''}
                            onChange={(v) => handleChangeResponsible(t.id, v)}
                            disabled={!canEditVors}
                            options={[
                              { value: '', label: '— не назначен —' },
                              ...stoEmployees.map(emp => ({ value: emp.user_id, label: emp.display_name })),
                            ]}
                            formatTrigger={() => (
                              resp.name
                                ? <span className="vor-resp-person" title={resp.name}>
                                    <span className="vor-resp-avatar" aria-hidden>{initialsOf(resp.name)}</span>
                                    <span className="vor-resp-name">{shortPersonName(resp.name)}</span>
                                  </span>
                                : <span className="vor-resp-empty">— не назначен —</span>
                            )}
                            renderOption={(o) => (
                              o.value
                                ? <span className="vor-resp-person">
                                    <span className="vor-resp-avatar" aria-hidden>{initialsOf(o.label)}</span>
                                    <span className="vor-resp-name">{o.label}</span>
                                  </span>
                                : <span className="vor-resp-empty">— не назначен —</span>
                            )}
                          />
                          {stoError && <div className="muted-tiny vor-resp-warn">{stoError}</div>}
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
                    {t._kind === 'request'
                      ? (t.created_by_name
                        ? <span title="Автор заявки">{t.created_by_name}<div className="muted-tiny">автор заявки</div></span>
                        : <span className="muted-tiny">—</span>)
                      : (t.responsible_contact?.full_name || <span className="muted-tiny">—</span>)}
                  </td>
                  <td>
                    {/* Срок — читаемым текстом; правка в окошке. Просрочен, если
                        окончание прошло, а ВОР ещё не завершён. */}
                    <DateRangeCell
                      start={vorStartDate(t)}
                      lockStart
                      lockStartHint={t._kind === 'request' ? 'дата создания заявки' : 'дата создания тендера'}
                      end={t.vor_end_date}
                      disabled={!canEditVors}
                      overdue={!!t.vor_end_date && !VOR_CLOSED.includes(t.vor_status)
                        && t.vor_end_date < new Date().toISOString().slice(0, 10)}
                      showCountdown={!VOR_CLOSED.includes(t.vor_status)}
                      onChange={(field, value) => { if (field === 'end') handleChangeVorDate(t.id, 'vor_end_date', value) }}
                    />
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
                        onClick={() => (t._kind === 'request' ? setRequestModal({ id: t.id }) : setVorDocsModalTenderId(t.id))}
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

      {requestModal && (() => {
        const request = requestModal.id ? tenders.find(x => x.id === requestModal.id) : null
        if (requestModal.id && !request) return null
        const objectsForForm = (formObjects || []).filter(o => scope === 'joint' || o.status !== 'warranty_service')
        return (
          <VorRequestModal
            key={requestModal.id || 'create'}
            request={request}
            department={scope}
            canEdit={canEditVors}
            objects={objectsForForm}
            stoEmployees={stoEmployees}
            divisions={VOR_DIVISIONS}
            byName={userProfile?.full_name || null}
            onClose={() => setRequestModal(null)}
            onCreated={(row) => {
              setTenders(prev => [{ ...row, _kind: 'request' }, ...prev])
              setRequestModal({ id: row.id })
            }}
            onUpdated={(id, patch) => setTenders(prev => prev.map(x => (x.id === id ? { ...x, ...patch } : x)))}
            onDocsChanged={() => refreshVorDocCount(request?.id)}
          />
        )
      })()}

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
