import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect, useDeferredValue, memo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useRole } from '../contexts/RoleContext'
import FolderPathCell from '../components/FolderPathCell'
import IconTile from '../components/IconTile'
import FilterDropdown from '../components/FilterDropdown'
import RootFolderPathButton from '../components/RootFolderPathButton'
import { IconCoins, IconObject, IconUser, IconSearch } from '../components/icons/ToolbarIcons'
import CostPlanInstructionModal from '../components/CostPlanInstructionModal'
import DateRangeCell from '../components/DateRangeCell'
import ClampText from '../components/ClampText'
import PersonName from '../components/PersonName'
import useBodyClass from '../hooks/useBodyClass'
import './CostPlansPage.css'
// Общий рабочий стиль разделов (docs/UI_GUIDELINES.md) — после стилей страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

const STATUS_LABELS = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  // План посчитан, но ждём КП подрядчиков, чтобы его закрыть.
  awaiting_kp: 'Ожидание КП',
  completed: 'Завершён',
  not_required: 'Не требуется',
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'awaiting_kp', 'completed', 'not_required']

// Статусы, при которых план затрат считается «закрытым» (вкладка «Завершено»)
const DONE_STATUSES = ['completed', 'not_required']

function CostPlansPage() {
  const { scopedObjectIds, userProfile, canEdit } = useRole()
  // Путь к папке — поле самого тендера, поэтому и право на правку от тендеров.
  const canEditTenders = canEdit('tenders')
  // Всплывающие списки фильтров и окошко срока рисуются в <body> — им нужен
  // тот же шрифт, что и странице.
  useBodyClass('ui-work-portal')

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

  // Путь к папке с документами тендера (tenders.folder_path, миграция 20260903).
  // Общее поле с реестром тендеров: правка отсюда видна и там.
  const handleSaveFolderPath = async (tenderId, value) => {
    const next = value.trim() || null
    const prev = tenders.find(t => t.id === tenderId)?.folder_path ?? null
    if ((prev || null) === next) return
    try {
      const { error } = await supabase.from('tenders').update({ folder_path: next }).eq('id', tenderId)
      if (error) throw error
      setTenders(list => list.map(t => (t.id === tenderId ? { ...t, folder_path: next } : t)))
      logTenderEvent(tenderId, 'field_updated', {
        fieldName: 'folder_path',
        oldValue: prev,
        newValue: next,
        description: 'Изменено: Путь к папке',
      })
    } catch (err) {
      console.error('Ошибка сохранения пути к папке:', err.message)
      alert('Не удалось сохранить путь: ' + err.message)
    }
  }
  const [activeTab, setActiveTab] = useState('all') // 'all' | 'not_started' | 'in_work' | 'awaiting_kp' | 'completed'
  // task 234: статус-вкладки скрыты под кнопкой «Статусы планов затрат»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  // Инструкция по расчёту плана затрат (иконка «?» в шапке раздела).
  const [showInstruction, setShowInstruction] = useState(false)
  // Фильтры множественные: и объектов, и ответственных обычно смотрят пачкой.
  const [responsibleFilters, setResponsibleFilters] = useState([])
  const [searchQuery, setSearchQuery] = useState('') // task 209
  // task 211: модалка редактирования ссылки на план затрат
  const [linkModal, setLinkModal] = useState(null) // { tenderId, value }
  const [objectFilterIds, setObjectFilterIds] = useState([]) // task 178: фильтр по объектам
  const [allContacts, setAllContacts] = useState([])
  // Справочник сотрудников нужен только для назначения ответственного — грузим
  // его при первом открытии выбора, а не вместе со страницей.
  const [contactsRequested, setContactsRequested] = useState(false)
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
      // Постранично: без .range() PostgREST молча отдал бы только первые 1000
      // тендеров, и часть реестра просто не появилась бы на странице.
      const data = await fetchAllRows((from, to) => supabase
        .from('tenders')
        .select(`
          id, object_id, public_tender_number, status, tender_type, department, cost_plan_status, cost_plan_link,
          cost_plan_responsible_id, cost_plan_start_date, cost_plan_end_date,
          start_date, end_date, tender_start_date, tender_end_date,
          work_description, cost_plan_notes, folder_path, deleted_at,
          objects(name, status),
          cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name, position)
        `)
        // Отбор на сервере: раньше тянулись все тендеры всех направлений и типов
        // (с джойнами объектов и сотрудников), а лишнее отбрасывалось в браузере.
        // Пустые department/tender_type — старые записи, они считаются основным
        // строительством и основным тендером, как и в фильтре ниже.
        .or('and(or(department.is.null,department.eq.construction),or(tender_type.is.null,tender_type.eq.main))')
        .order('start_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))

      // Только основные тендеры по основному строительству — план затрат имеет смысл только там.
      // Дочерние тендеры на материалы (tender_type='materials') исключаем, чтобы не дублировать.
      // Направление — из tenders.department (миграция 20260820), а не из статуса объекта:
      // «совместные» и «прочие» могут ссылаться на тот же объект основного строительства.
      let filtered = (data || []).filter(t =>
        (t.department || 'construction') === 'construction'
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
  }, [fetchTenders])

  useEffect(() => {
    if (editingResponsibleId && !contactsRequested) {
      setContactsRequested(true)
      fetchAllContacts()
    }
  }, [editingResponsibleId, contactsRequested])

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


  // Производные данные — в useMemo. Раньше всё это (включая счётчики фильтров
  // перебором «объект × все тендеры») пересчитывалось на КАЖДУЮ перерисовку:
  // раскрыть статусы, набрать символ в поиске, сменить статус.

  // task 216: уникальные ответственные для фильтра — по ФИО (без дублей разных
  // контактов с одинаковым именем, привязанных к разным объектам)
  const { responsibles, responsibleCounts, objectsList, objectCounts } = useMemo(() => {
    const nameSet = new Set()
    const names = []
    const rCounts = new Map()
    const objMap = new Map()
    const oCounts = new Map()
    for (const t of tenders) {
      const name = t.cost_plan_responsible?.full_name || ''
      rCounts.set(name, (rCounts.get(name) || 0) + 1)
      if (name && !nameSet.has(name.toLowerCase())) {
        nameSet.add(name.toLowerCase())
        names.push(name)
      }
      // task 178: уникальные объекты для фильтра
      if (t.object_id) {
        oCounts.set(t.object_id, (oCounts.get(t.object_id) || 0) + 1)
        if (!objMap.has(t.object_id)) objMap.set(t.object_id, { id: t.object_id, name: t.objects?.name || '—' })
      }
    }
    names.sort((a, b) => a.localeCompare(b, 'ru'))
    const objs = Array.from(objMap.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
    return { responsibles: names, responsibleCounts: rCounts, objectsList: objs, objectCounts: oCounts }
  }, [tenders])

  const objectOptions = useMemo(() => objectsList.map(o => ({
    value: o.id,
    label: `${o.name} (${objectCounts.get(o.id) || 0})`,
  })), [objectsList, objectCounts])
  const responsibleOptions = useMemo(() => responsibles.map(name => ({
    value: name,
    label: `${name} (${responsibleCounts.get(name) || 0})`,
  })), [responsibles, responsibleCounts])

  // task 216: контакты для назначения ответственного — без дублей по ФИО
  const uniqueContacts = useMemo(() => {
    const seen = new Set()
    return allContacts.filter(c => {
      const key = (c.full_name || '').toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [allContacts])

  // Поиск откладываем: ввод в поле остаётся мгновенным, таблица догоняет.
  const deferredSearch = useDeferredValue(searchQuery)

  const { deletedRows, liveRows, notStarted, inWork, awaitingKp, completed } = useMemo(() => {
    // Фильтрация по ответственному, объекту и поиску
    let rows = tenders
    if (responsibleFilters.length > 0) {
      rows = rows.filter(t => responsibleFilters.includes(t.cost_plan_responsible?.full_name || ''))
    }
    if (objectFilterIds.length > 0) rows = rows.filter(t => objectFilterIds.includes(t.object_id))
    const q = deferredSearch.trim().toLowerCase()
    if (q) {
      rows = rows.filter(t =>
        String(t.public_tender_number ?? '').includes(q) ||
        (t.work_description || '').toLowerCase().includes(q) ||
        (t.objects?.name || '').toLowerCase().includes(q) ||
        (t.cost_plan_responsible?.full_name || '').toLowerCase().includes(q) ||
        (t.cost_plan_notes || '').toLowerCase().includes(q)
      )
    }
    // task 179: сортировка по выбранной колонке (даты тендерных процедур)
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
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
    const live = rows.filter(t => !t.deleted_at)
    // Разделение по табам (task 210); task 208: «Не требуется» относится к «Завершено»
    return {
      deletedRows: rows.filter(t => t.deleted_at),
      liveRows: live,
      notStarted: live.filter(t => (t.cost_plan_status || 'not_started') === 'not_started'),
      inWork: live.filter(t => t.cost_plan_status === 'in_progress'),
      awaitingKp: live.filter(t => t.cost_plan_status === 'awaiting_kp'),
      completed: live.filter(t => DONE_STATUSES.includes(t.cost_plan_status)),
    }
  }, [tenders, responsibleFilters, objectFilterIds, deferredSearch, sortKey, sortDir])

  const hasActiveFilters = responsibleFilters.length > 0 || objectFilterIds.length > 0 || searchQuery.trim() !== ''
  const visible = activeTab === 'deleted' ? deletedRows
    : activeTab === 'all' ? liveRows
    : activeTab === 'completed' ? completed
    : activeTab === 'in_work' ? inWork
    : activeTab === 'awaiting_kp' ? awaitingKp
    : notStarted

  // Действия строки — стабильные ссылки: иначе каждая перерисовка страницы давала
  // бы новые функции, и мемоизированные строки (CostPlanRow) перерисовывались бы
  // все 300 разом. Обёртки создаются один раз и зовут актуальный обработчик.
  const handlersRef = useRef({})
  handlersRef.current = {
    handleSaveFolderPath, handleChangeResponsible, handleChangeCostPlanDate,
    openLinkModal, handleChangeStatus, handleChangeCostPlanNotes,
  }
  const rowActions = useMemo(() => ({
    saveFolderPath: (...a) => handlersRef.current.handleSaveFolderPath(...a),
    changeResponsible: (...a) => handlersRef.current.handleChangeResponsible(...a),
    changeDate: (...a) => handlersRef.current.handleChangeCostPlanDate(...a),
    openLink: (...a) => handlersRef.current.openLinkModal(...a),
    changeStatus: (...a) => handlersRef.current.handleChangeStatus(...a),
    changeNotes: (...a) => handlersRef.current.handleChangeCostPlanNotes(...a),
    editResponsible: (id) => setEditingResponsibleId(id),
  }), [])

  if (loading) {
    return (
      <div className="cost-plans-page ui-work">
        <div className="page-header"><h2>Планы затрат</h2></div>
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  return (
    <div className="cost-plans-page ui-work">
      <div className="page-header page-header-cost-plans">
        <h2>
          <IconTile tone="green" className="page-icon-tile"><IconCoins /></IconTile>
          Планы затрат
          {/* Инструкция по расчёту: правило знают на словах, новичку негде посмотреть. */}
          <button
            type="button"
            className="cpi-open-btn"
            onClick={() => setShowInstruction(true)}
            title="Инструкция по расчёту плана затрат"
            aria-label="Инструкция по расчёту плана затрат"
          >?</button>
        </h2>
        <div className="cp-header-right">
          {/* Общая папка раздела в сетевом хранилище — одна на все планы затрат. */}
          <RootFolderPathButton
            settingKey="cost_plans_root_folder_path"
            title="Общая папка планов затрат"
            canEdit={canEditTenders}
            placeholder="\\192.168.2.55\SharA_Tender\Отдел Субподряда\Планы затрат"
          />
          <div className="page-header-hint">
            Список тендеров основного строительства. Ответственного за план затрат можно назначить в карточке тендера.
          </div>
        </div>
      </div>

      {showInstruction && <CostPlanInstructionModal onClose={() => setShowInstruction(false)} />}

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
          className={`tab cost-plans-status-toggle ${['not_started', 'in_work', 'awaiting_kp', 'completed'].includes(activeTab) ? 'active' : ''}`}
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
              className={`tab ${activeTab === 'awaiting_kp' ? 'active' : ''}`}
              onClick={() => setActiveTab('awaiting_kp')}
            >
              Ожидание КП
              <span className="tab-count">{awaitingKp.length}</span>
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
          className={`tab tab-deleted ${activeTab === 'deleted' ? 'active' : ''}`}
          onClick={() => setActiveTab('deleted')}
        >
          Удалённые
          {deletedRows.length > 0 && <span className="tab-count">{deletedRows.length}</span>}
        </button>
      </div>

      {/* Фильтры — те же портальные выпадашки, что в реестрах тендеров и
          договоров: с поиском внутри и множественным выбором. Нативные <select>
          на 300+ объектов листались тяжело и выглядели чужеродно. */}
      <div className="cost-plans-toolbar">
        <div className="cp-search-wrap ui-search">
          <IconSearch />
          {/* Подсказка короткая, чтобы помещалась целиком; полный перечень
              того, где ищет поле, — в aria-label. */}
          <input
            type="search"
            className="cost-plans-search"
            placeholder="№, объект, описание, ФИО"
            aria-label="Поиск по номеру тендера, объекту, описанию работ, ответственному и примечанию"
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
          options={objectOptions}
        />
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск ответственного…"
          allLabel="Все ответственные"
          icon={<IconUser size={15} />}
          value={responsibleFilters}
          onChange={setResponsibleFilters}
          options={responsibleOptions}
        />
        <div className="cp-toolbar-tail">
          <span className="cp-shown">Показано: <b>{liveRows.length}</b></span>
          {hasActiveFilters && (
            <button
              type="button"
              className="reset-btn"
              onClick={() => { setResponsibleFilters([]); setObjectFilterIds([]); setSearchQuery('') }}
            >Сбросить</button>
          )}
        </div>
      </div>

      <div className="table-container cp-table-container">
        {/* Ширины — долями окна (colgroup + table-layout: fixed в CSS): таблица
            помещается в рабочую область без горизонтального ползунка. При
            авто-раскладке длинное описание растягивалось в одну строку, а
            «Объект» ужимался до пары букв в строке. */}
        <table className="data-table cp-table">
          {/* Доли столбцов — в CSS (.cp-col-*): на узких экранах они другие. */}
          <colgroup>
            <col className="cp-col-num" />
            <col className="cp-col-object" />
            <col className="cp-col-desc" />
            <col className="cp-col-resp" />
            <col className="cp-col-date" />
            <col className="cp-col-date" />
            <col className="cp-col-term" />
            <col className="cp-col-link" />
            <col className="cp-col-status" />
            <col className="cp-col-notes" />
          </colgroup>
          <thead>
            <tr>
              <th
                className="sortable-th"
                onClick={() => toggleSort('public_tender_number')}
                title="Номер тендера. Кликните для сортировки"
                style={{ textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
              >
                №<br />тендера{sortIndicator('public_tender_number')}
              </th>
              <th>Объект</th>
              <th>Описание работ</th>
              <th>Ответственный</th>
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_start_date')}
                title="Сортировать по началу тендерной процедуры"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                Начало<br />тендера{sortIndicator('tender_start_date')}
              </th>
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_end_date')}
                title="Сортировать по окончанию тендерной процедуры"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                Окончание<br />тендера{sortIndicator('tender_end_date')}
              </th>
              <th>Срок выполнения<br />плана затрат</th>
              <th>План<br />затрат</th>
              <th>Статус<br />плана</th>
              <th>Примечание</th>
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
                            : activeTab === 'awaiting_kp'
                              ? 'Нет планов затрат в ожидании КП'
                            : 'Нет планов затрат со статусом «Не начат»'}
                </td>
              </tr>
            ) : (
              visible.map((t) => (
                <CostPlanRow
                  key={t.id}
                  t={t}
                  canEditTenders={canEditTenders}
                  isEditingResponsible={editingResponsibleId === t.id}
                  contacts={editingResponsibleId === t.id ? uniqueContacts : NO_CONTACTS}
                  actions={rowActions}
                />
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


const NO_CONTACTS = []

// Строка таблицы. memo: при раскрытии статусов, вводе в поиск или смене статуса
// одной строки остальные ~300 строк не перерисовываются. Все пропсы стабильны:
// t меняется только у изменённого тендера, actions создаётся один раз.
const CostPlanRow = memo(function CostPlanRow({ t, canEditTenders, isEditingResponsible, contacts, actions }) {
  return (
    <tr>
      <td className="ui-rownum" style={{ textAlign: 'center' }}>
        {t.public_tender_number ?? '—'}
      </td>
      <td className="cp-object-cell">
        {t.objects?.name || '—'}
      </td>
      <td>
        {/* До трёх строк; длиннее — «Показать полностью» под текстом. Переход
            в тендер — по самому тексту, раскрытие — отдельной кнопкой. */}
        <ClampText
          text={t.work_description}
          wrap={(body) => (
            <Link
              to={`/tenders/${t.id}`}
              className="row-link primary cp-desc-link ui-title-link"
              title="Открыть тендер (Ctrl+клик или средняя кнопка — в новой вкладке)"
            >
              {body}
            </Link>
          )}
        />
        {/* Путь к папке с документами тендера — то же поле, что в
            реестре тендеров: правка здесь видна и там. */}
        <FolderPathCell
          value={t.folder_path}
          canEdit={canEditTenders}
          onSave={(v) => actions.saveFolderPath(t.id, v)}
        />
      </td>
      <td>
        {isEditingResponsible ? (
          <select
            autoFocus
            className="inline-responsible-select"
            value={t.cost_plan_responsible_id || ''}
            onChange={(e) => {
              actions.changeResponsible(t.id, e.target.value)
              actions.editResponsible(null)
            }}
            onBlur={() => actions.editResponsible(null)}
          >
            <option value="">Не назначен</option>
            {contacts.length === 0 && <option value="" disabled>Загрузка сотрудников…</option>}
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.full_name}</option>
            ))}
          </select>
        ) : (
          <button
            className="responsible-display"
            onClick={() => actions.editResponsible(t.id)}
            title="Назначить ответственного"
          >
            {t.cost_plan_responsible?.full_name
              ? <PersonName full={t.cost_plan_responsible.full_name} />
              : <span className="responsible-empty">Не назначен</span>}
          </button>
        )}
        {t.cost_plan_responsible?.position && (
          <div className="ui-sub">{t.cost_plan_responsible.position}</div>
        )}
      </td>
      <td className="ui-num">
        {t.tender_start_date
          ? new Date(t.tender_start_date).toLocaleDateString('ru-RU')
          : <span className="ui-empty">—</span>}
      </td>
      <td className="ui-num">
        {t.tender_end_date
          ? new Date(t.tender_end_date).toLocaleDateString('ru-RU')
          : <span className="ui-empty">—</span>}
      </td>
      <td>
        {/* Окошко с черновиком: нативное поле даты сохраняло каждую цифру года
            («0002», «0020»…), и набор сбивался. */}
        <DateRangeCell
          start={t.cost_plan_start_date}
          end={t.cost_plan_end_date}
          overdue={!!t.cost_plan_end_date
            && !['completed', 'not_required'].includes(t.cost_plan_status)
            && t.cost_plan_end_date < new Date().toISOString().slice(0, 10)}
          showCountdown={!['completed', 'not_required'].includes(t.cost_plan_status)}
          onChange={(field, value) => actions.changeDate(t.id, field === 'start' ? 'cost_plan_start_date' : 'cost_plan_end_date', value)}
        />
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
              onClick={() => actions.openLink(t.id, t.cost_plan_link)}
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
            onClick={() => actions.openLink(t.id, '')}
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
          onChange={(e) => actions.changeStatus(t.id, e.target.value)}
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
      </td>
      <td>
        <NotesCell tender={t} onSave={actions.changeNotes} />
      </td>
    </tr>
  )
})

// Примечание с автоподгонкой высоты.
//
// Раньше высота подгонялась в ref-колбэке, заданном прямо в разметке: такой
// колбэк React вызывает на КАЖДУЮ перерисовку, а он пишет style.height и сразу
// читает scrollHeight — браузер пересчитывает раскладку всей таблицы. На ~300
// строках это 300 принудительных пересчётов на любое действие на странице.
// Теперь подгонка — один раз при появлении и при смене текста.
const NotesCell = memo(function NotesCell({ tender, onSave }) {
  const ref = useRef(null)
  const fit = (el) => {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }
  useLayoutEffect(() => {
    // Пустое поле подгонять незачем: высота одной строки задана rows={1}.
    if (ref.current && tender.cost_plan_notes) fit(ref.current)
  }, [tender.cost_plan_notes])
  // Шрифт раздела (Inter) приезжает после первой отрисовки, и текст в нём
  // занимает больше строк — без повторной подгонки последняя строка обрезалась.
  useEffect(() => {
    if (!tender.cost_plan_notes || !document.fonts?.ready) return undefined
    let alive = true
    document.fonts.ready.then(() => { if (alive && ref.current) fit(ref.current) })
    return () => { alive = false }
  }, [tender.cost_plan_notes])
  return (
    <textarea
      ref={ref}
      className="cost-plan-notes"
      defaultValue={tender.cost_plan_notes || ''}
      placeholder="Примечание…"
      rows={1}
      onInput={(e) => fit(e.target)}
      onBlur={(e) => {
        const v = e.target.value
        if ((tender.cost_plan_notes || '') !== (v.trim() || '')) onSave(tender.id, v)
      }}
    />
  )
})
