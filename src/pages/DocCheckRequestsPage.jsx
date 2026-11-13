import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import DocCheckBoard from '../components/doccheck/DocCheckBoard'
import DocCheckFormModal from '../components/doccheck/DocCheckFormModal'
import DocCheckDetailModal from '../components/doccheck/DocCheckDetailModal'
import DocCheckAvatars from '../components/doccheck/DocCheckAvatars'
import DocCheckCardCounts from '../components/doccheck/DocCheckCardCounts'
import { panByDrag } from '../components/doccheck/boardGestures'
import FilterDropdown from '../components/FilterDropdown'
import IconTile from '../components/IconTile'
import { IconFilter, IconObject, IconSearch, IconUser } from '../components/icons/ToolbarIcons'
import { IconArchive, IconCalendar, IconFlag, IconRestore, IconTrash } from '../components/icons/ActionIcons'
import { IconDocCheck } from '../components/icons/NavIcons'
import { fetchAllRows } from '../utils/fetchAllRows'
import { counterpartyNumbers } from '../utils/counterpartyFilters'
import { counterpartyPickerOptions, filterCounterpartyOptions, isPickableCounterparty } from '../utils/counterpartyPicker'
import { fetchPickerCounterparties } from '../services/counterpartyPicker'
import { chunkList } from '../utils/inChunks'
import { employeeName, employeesById, fetchEmployees } from '../services/employees'
import { fetchCardCounts as readCardCounts, fetchDeletions, fetchTalkReads, prefetchCard, saveTalkRead } from '../services/docCheckCard'
import { uploadFile } from '../services/s3'
import useBodyClass from '../hooks/useBodyClass'
import { useIsPhone } from '../hooks/useMediaQuery'
import {
  DEADLINE_FILTERS,
  DOC_CHECK_PRIORITIES,
  DOC_CHECK_SELECTS,
  DOC_CHECK_STATUS_CLASS,
  DOC_CHECK_STATUS_LABEL,
  DOC_CHECK_STATUSES,
  DOC_TYPES,
  CLOSED_DOC_CHECK_STATUSES,
  NO_ASSIGNEE,
  NO_CARD_COUNTS,
  assigneeIdsToSave,
  assigneeStaffOptions,
  cardTitle,
  compareForBoard,
  dueState,
  fieldEvents,
  fmtDocDate,
  fmtDocDateTime,
  isMissingBoardColumn,
  labelSuggestions,
  matchesAssignees,
  matchesDeadline,
  mergeRequestCounts,
  nextSortOrder,
  normalizeRequest,
  placeInColumn,
  requestIdLabel,
  requestNumberQuery,
  sameCardCounts,
  shownAssigneeIds,
} from '../utils/docCheckHelpers'
import {
  dropLocalTalkReads, loadTalkReads, markTalkRead, normalizeTalkReads, readLocalTalkReads, readMarkOf, talkReadKey, unreadTalkCount,
  withSeen,
} from '../utils/docCheckTalkRead'
import '../styles/workUi.css'
import '../components/MobileCards.css'
import './DocCheckRequestsPage.css'

// Раздел «Заявки на проверку ДП/ДС».
//
// Раньше проверка договоров и допсоглашений шла письмами, потом — на внешней
// доске задач. Здесь та же доска на сайте (решение пользователя 29.10.2026 —
// «примерно такую же, как на фото»): колонки от «Новых заявок» до «Ожидаем скан»,
// карточки с цветом, метками, сроком и исполнителями, фильтры по исполнителю,
// сроку, приоритету и объекту, архив. «Сводку по ДП» и «Проверку документов
// (исключение налоговой оговорки)» убрали 10.11.2026 (решение пользователя).
//
// Заявка НЕ привязана к записи реестра «Договоры и ДС»: проверка идёт до того,
// как договор туда заводят, поэтому объект, контрагент, тип, № и дата вводятся
// руками.
//
// Без колонок миграции 20261113 (прежняя база) страница читает прежний набор
// полей и работает как раньше: без исполнителей, сроков, меток, цвета и архива.
// Без миграции 20261124 — без обсуждения. Шагов в заявке нет с 11.11.2026 (решение
// пользователя), ссылку на письмо при создании не вводят — у прежних заявок она видна.
// С миграцией 20270216 (hasChatFields): историю заявки пишет база (страница — нет), файлы в
// переписке, «Согласование ПСДЦ», «прочитано» — в базе, у каждого своё.

const VIEW_KEY = 'docCheckView'
const QUIET_RELOAD_MS = 30000

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : JSON.parse(v)
  } catch { return fallback }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* приватный режим */ }
}

// Что в шапке нажимается само и не двигает доску.
const HEAD_CONTROLS = 'button, a, input, select, textarea, label, .fdrop, [role="menu"], [role="listbox"], [role="dialog"]'

const sameCounts = (a, b) => a.size === b.size && [...b].every(([id, n]) => a.get(id) === n)

// Исполнители в строке реестра: кружки и ФИО.
function RowAssignees({ request, employees }) {
  const ids = shownAssigneeIds(request, employees)
  if (!ids.length) return '—'
  return (
    <span className="dc-row-people">
      <DocCheckAvatars ids={ids} employees={employees} />
      <span>{ids.map(id => employeeName(employees, id)).join(', ')}</span>
    </span>
  )
}

export default function DocCheckRequestsPage() {
  useBodyClass('ui-work-portal')
  const { canEdit, role, userProfile, user, isAdmin, isSuperAdmin, scopedObjectIds } = useRole()
  const canEditSection = canEdit('doc_check_requests')
  // Право только создавать (20270102, по умолчанию — руководитель строительства и экономист объекта): новая заявка — только в
  // «Новые заявки», менять её потом — право правки раздела. То же держит база (doc_check_requests_write_guard).
  const createOnly = !canEditSection && canEdit('doc_check_requests_create')
  const canCreate = canEditSection || createOnly
  // Телефон: фильтры, «Архив» и «Удалённые» — по кнопке «Фильтры» (шапка над доской — три низкие строки вместо половины
  // экрана), реестр — карточками вместо таблицы.
  const isPhone = useIsPhone()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const myId = user?.id || null
  // Сотрудник с привязкой к объектам (руководитель строительства, экономист объекта) видит заявки только своих объектов
  // (06.11.2026, решение пользователя); заявки без объекта ему не видны. Пусто — все объекты (администратор, офис). То же
  // правило — в базе (миграция 20270101, doc_check_scope()); здесь — ещё и для «Посмотреть от имени роли» и базы до миграции.
  const scopeKey = (scopedObjectIds || []).join(',')
  const scopeIds = useMemo(() => (scopeKey ? scopeKey.split(',') : []), [scopeKey])

  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [objectsState, setObjectsState] = useState('loading') // loading | ready | failed
  const [counterparties, setCounterparties] = useState([])
  const [employees, setEmployees] = useState(() => new Map())
  const [docCounts, setDocCounts] = useState(() => new Map())
  const [cardCounts, setCardCounts] = useState(() => new Map())
  const [hasBoardFields, setHasBoardFields] = useState(true)
  const [hasCardFields, setHasCardFields] = useState(false)
  const [hasChatFields, setHasChatFields] = useState(false)
  // Какая база — известно после первого чтения заявок: до него «прочитано» не берётся ни из браузера, ни из базы.
  const [schemaKnown, setSchemaKnown] = useState(false)
  // Историю пишет база (20270216) — страница её не пишет: иначе запись страницы отбросила бы сама база, а лишний запрос не нужен.
  const historyByDb = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [view, setView] = useState(() => (readStored(VIEW_KEY, 'board') === 'list' ? 'list' : 'board'))
  const [mode, setMode] = useState('active')   // active | archive | deleted
  const [search, setSearch] = useState('')
  const [filterObjectIds, setFilterObjectIds] = useState([])
  const [filterCounterpartyIds, setFilterCounterpartyIds] = useState([])
  const [filterTypes, setFilterTypes] = useState([])
  const [filterAssignees, setFilterAssignees] = useState([])
  const [filterDeadline, setFilterDeadline] = useState('')
  const [filterPriorities, setFilterPriorities] = useState([])

  const [formFor, setFormFor] = useState(null)   // { request, status } | null
  const [detailId, setDetailId] = useState(null)
  const [detailRefresh, setDetailRefresh] = useState(0)

  useEffect(() => { writeStored(VIEW_KEY, view) }, [view])

  // Имя в истории — и «кто удалил» в «Удалённых»: без ФИО в профиле — почта, а не безликое «Пользователь».
  const author = userProfile?.full_name || user?.email || 'Пользователь'

  // ── Загрузка ──────────────────────────────────────────────────────────────
  const loadSeq = useRef(0)
  const lastLoad = useRef(0)
  // Какая выборка подошла базе: при тихих перечитываниях заведомо неподходящие не повторяем.
  const selectAt = useRef(0)
  // Своя запись началась или закончилась. Чтение, которое шло в это время, вернуло бы то, что было до неё, и перенесённая
  // карточка уехала бы обратно — такой ответ не применяем.
  const writeEpoch = useRef(0)
  const fetchRequests = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++loadSeq.current
    const epoch = writeEpoch.current
    if (!quiet) setLoading(true)
    const scoped = (query) => (scopeIds.length ? query.in('object_id', scopeIds) : query)
    const read = (select) => fetchAllRows((from, to) => scoped(db
      .from('doc_check_requests')
      .select(select))
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))
    try {
      let rows
      for (;;) {
        try {
          rows = await read(DOC_CHECK_SELECTS[selectAt.current].select)
          break
        } catch (err) {
          if (!isMissingBoardColumn(err) || selectAt.current === DOC_CHECK_SELECTS.length - 1) throw err
          selectAt.current += 1
        }
      }
      if (seq !== loadSeq.current || epoch !== writeEpoch.current) return
      lastLoad.current = Date.now()
      setHasBoardFields(DOC_CHECK_SELECTS[selectAt.current].board)
      setHasCardFields(DOC_CHECK_SELECTS[selectAt.current].card)
      setHasChatFields(DOC_CHECK_SELECTS[selectAt.current].chat)
      historyByDb.current = DOC_CHECK_SELECTS[selectAt.current].chat
      setSchemaKnown(true)
      setRequests(rows.map(normalizeRequest))
      setError(null)
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.error('Ошибка загрузки заявок на проверку ДП/ДС:', err.message)
      setError(err.message)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [scopeIds])

  // Сколько файлов у заявок — скрепка на карточке.
  const fetchDocCounts = useCallback(async () => {
    try {
      const rows = await fetchAllRows((from, to) => db
        .from('s3_documents')
        .select('id, owner_id')
        .eq('owner_type', 'doc_check_request')
        .order('id', { ascending: true })
        .range(from, to))
      const map = new Map()
      for (const r of rows) map.set(r.owner_id, (map.get(r.owner_id) || 0) + 1)
      setDocCounts(prev => (sameCounts(prev, map) ? prev : map))
    } catch (err) {
      console.warn('Не удалось посчитать файлы заявок:', err.message)
    }
  }, [])

  // Сколько сообщений — на карточке. Число, которое открытая карточка заявки сообщила, пока шло чтение, новее
  // прочитанного — его не трогаем.
  const countsChanged = useRef(new Set())
  const fetchCardCounts = useCallback(async () => {
    countsChanged.current = new Set()
    try {
      const map = await readCardCounts(myId)
      setCardCounts(prev => {
        for (const id of countsChanged.current) map.set(id, prev.get(id) || NO_CARD_COUNTS)
        return map
      })
    } catch (err) {
      console.warn('Не удалось посчитать сообщения заявок:', err.message)
    }
  }, [myId])
  const handleCardCounts = useCallback((id, counts) => {
    countsChanged.current.add(id)
    setCardCounts(prev => {
      const cur = prev.get(id) || NO_CARD_COUNTS
      if (sameCardCounts(cur, counts)) return prev
      return new Map(prev).set(id, counts)
    })
  }, [])

  // Непрочитанные сообщения обсуждения (11.11.2026, docCheckTalkRead.js). С миграцией 20270216 отметки «прочитано» — в базе, у
  // каждого сотрудника свои и одни на всех его устройствах (12.11.2026, решение пользователя); отметки этого браузера при первом
  // входе переносятся туда. До миграции — в браузере, по пользователю; другая вкладка узнаёт об отметке из события storage.
  // Окно заявки с перепиской отмечает её прочитанной. Пока не прочитано, откуда брать отметки, непрочитанных нет.
  const [talkReads, setTalkReads] = useState(null)
  const talkReadsRef = useRef(null)
  talkReadsRef.current = talkReads
  const talkSeq = useRef(0)
  const loadTalkFromDb = useCallback(async () => {
    if (!myId) return
    const seq = ++talkSeq.current
    try {
      const local = readLocalTalkReads(myId)
      const state = normalizeTalkReads(await fetchTalkReads(local))
      if (local) dropLocalTalkReads(myId)
      if (seq !== talkSeq.current || !state) return
      // Отметка, поставленная, пока шёл запрос, не теряется.
      setTalkReads(prev => {
        if (!prev) return state
        let next = state
        for (const [id, ms] of Object.entries(prev.seen)) next = withSeen(next, id, ms)
        return next
      })
    } catch (err) {
      console.warn('Не удалось прочитать отметки «прочитано»:', err.message)
    }
  }, [myId])
  useEffect(() => {
    talkSeq.current += 1
    setTalkReads(null)
    if (!myId || !schemaKnown) return undefined
    if (hasChatFields) {
      loadTalkFromDb()
      return undefined
    }
    setTalkReads(loadTalkReads(myId))
    const onStorage = (e) => { if (e.key === talkReadKey(myId)) setTalkReads(loadTalkReads(myId)) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [myId, schemaKnown, hasChatFields, loadTalkFromDb])
  const handleTalkSeen = useCallback((id, at) => {
    if (!myId) return
    if (historyByDb.current) {
      const prev = talkReadsRef.current
      if (prev && at <= readMarkOf(prev, id)) return
      if (prev) setTalkReads(cur => withSeen(cur, id, at))
      saveTalkRead(id, at).catch(err => console.warn('Не удалось отметить сообщения прочитанными:', err.message))
      return
    }
    setTalkReads(prev => (at > readMarkOf(prev, id) ? markTalkRead(myId, id, at, prev) : prev))
  }, [myId])
  // Таблицы обсуждения нет, пока нет колонок той же миграции — до этого не обращаемся.
  useEffect(() => { if (hasCardFields) fetchCardCounts() }, [hasCardFields, fetchCardCounts])

  // Кто удалил — только когда открыты «Удалённые». null — ещё не прочитано или не удалось: имени просто нет.
  const [deletions, setDeletions] = useState(null)
  const deletedIds = useMemo(() => requests.filter(r => r.deleted_at).map(r => r.id).join(','), [requests])
  useEffect(() => {
    if (mode !== 'deleted' || !deletedIds) return undefined
    let cancelled = false
    fetchDeletions(deletedIds.split(','))
      .then(map => { if (!cancelled) setDeletions(map) })
      .catch(err => console.warn('Не удалось прочитать, кто удалил заявки:', err.message))
    return () => { cancelled = true }
  }, [mode, deletedIds])

  useEffect(() => {
    fetchRequests()
    fetchDocCounts()
    // Объекты обоих отделов и контрагенты — для формы и фильтров. С привязкой к объектам — только свои.
    let objectsQuery = db.from('objects').select('id, name, status')
    if (scopeIds.length) objectsQuery = objectsQuery.in('id', scopeIds)
    setObjectsState('loading')
    objectsQuery
      .order('status', { ascending: true }).order('name', { ascending: true })
      .then(({ data, error: e }) => {
        if (e) { setObjectsState('failed'); return }
        setObjects(data || [])
        setObjectsState('ready')
      }, () => setObjectsState('failed'))
    fetchPickerCounterparties()
      .then(setCounterparties)
      .catch(err => console.warn('Не удалось загрузить контрагентов:', err.message))
    fetchEmployees()
      .then(list => setEmployees(employeesById(list)))
      .catch(err => console.warn('Не удалось загрузить сотрудников:', err.message))
  }, [fetchRequests, fetchDocCounts, scopeIds])

  // Правки коллег — при возврате на вкладку браузера, не чаще раза в 30 с.
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastLoad.current < QUIET_RELOAD_MS) return
      fetchRequests({ quiet: true })
      fetchDocCounts()
      if (hasCardFields) fetchCardCounts()
      // «Прочитано» с другого устройства или вкладки.
      if (hasChatFields) loadTalkFromDb()
      setDetailRefresh(n => n + 1)
    }
    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)
    return () => {
      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
    }
  }, [fetchRequests, fetchDocCounts, fetchCardCounts, hasCardFields, hasChatFields, loadTalkFromDb])

  // ── История ───────────────────────────────────────────────────────────────
  const logEvent = useCallback(async (requestId, entry) => {
    if (historyByDb.current) return
    try {
      const { error: e } = await db.from('doc_check_request_audit_log').insert({
        request_id: requestId,
        changed_by_role: role,
        changed_by_name: author,
        ...entry,
      })
      if (e) throw e
    } catch (err) {
      // История не должна ронять основное действие.
      console.warn('Не удалось записать историю заявки:', err.message)
    }
  }, [role, author])

  // ── Действия ──────────────────────────────────────────────────────────────
  // Правка одной заявки: сразу на экране, затем в базу; отказ — вернуть как в базе.
  const patchRequest = useCallback(async (request, patch, events = []) => {
    writeEpoch.current += 1
    setRequests(prev => prev.map(r => (r.id === request.id ? { ...r, ...patch } : r)))
    const { error: e } = await db.from('doc_check_requests').update(patch).eq('id', request.id)
    writeEpoch.current += 1
    if (e) {
      alert('Не удалось сохранить заявку: ' + (e.message || e))
      fetchRequests({ quiet: true })
      return false
    }
    for (const ev of events) await logEvent(request.id, ev)
    return true
  }, [fetchRequests, logEvent])

  const statusEvent = (request, status) => ({
    event_type: 'status_changed', field_name: 'status', old_value: request.status, new_value: status,
  })

  // files — файлы новой заявки создателя ({ file, category }: понятийное соглашение — своя категория): строки ещё нет, поэтому
  // сначала заявка, затем файлы (база пускает автора к файлам своей заявки, пока она в «Новых»). Файл не загрузился — заявка
  // остаётся, причина — сообщением, остальные файлы грузятся.
  const handleSave = async (payload, files = []) => {
    try {
      if (formFor?.request) {
        const prev = formFor.request
        const ok = await patchRequest(prev, payload, fieldEvents(prev, payload))
        if (!ok) return
      } else {
        const status = createOnly ? 'new' : (formFor?.status || 'new')
        const { data, error: e } = await db
          .from('doc_check_requests')
          .insert({ ...payload, status, sort_order: nextSortOrder(requests, status), created_by_name: author })
          .select('id')
          .single()
        if (e) throw e
        await logEvent(data.id, { event_type: 'created', description: 'Заявка создана' })
        const failed = []
        for (const { file, category } of files) {
          try {
            await uploadFile({ file, ownerType: 'doc_check_request', ownerId: data.id, category })
          } catch (err) {
            failed.push(`${file.name}: ${err.message || err}`)
          }
        }
        if (files.length) fetchDocCounts()
        if (failed.length) alert(`Заявка создана, но не все файлы загрузились:\n${failed.join('\n')}`)
      }
      setFormFor(null)
      // Объект и контрагент приходят из базы встраиванием — перечитываем.
      await fetchRequests({ quiet: true })
    } catch (err) {
      alert('Не удалось сохранить заявку: ' + (err.message || err))
    }
  }

  // Новая колонка — наверх: свежее там сверху.
  const moveTo = (request, status) => {
    if (request.status === status) return
    patchRequest(request, { status, sort_order: nextSortOrder(requests, status) }, [statusEvent(request, status)])
  }

  // Исполнители из окна заявки — сразу, без формы (11.11.2026, решение пользователя). Пишется то же, что пишет форма: отмеченные
  // юристы плюс те, кого выбор не показывал (assigneeIdsToSave), и смена — в историю.
  const handleAssign = (request, selected) => {
    const patch = { assignee_ids: assigneeIdsToSave(request.assignee_ids, selected, employees) }
    const events = fieldEvents(request, patch)
    if (events.length) patchRequest(request, patch, events)
  }

  // Ответственный за согласование ПСДЦ (20270216) — из окна заявки, сразу. История — от базы.
  const handlePsdcAssign = (request, id) => {
    const patch = { psdc_responsible_id: id || null }
    if ((request.psdc_responsible_id || null) !== patch.psdc_responsible_id) patchRequest(request, patch)
  }

  // Кружок на карточке: завершить / вернуть в работу.
  const handleToggleDone = (request) => {
    moveTo(request, CLOSED_DOC_CHECK_STATUSES.has(request.status) ? 'in_progress' : 'done')
  }

  // Перетаскивание на доске: смена колонки и место перед карточкой beforeId (null — в конец). Порядок считается по всей
  // колонке, а не по тому, что оставил фильтр. В базу — карточка и только те соседи, которых пришлось сдвинуть.
  const handleMove = async (request, status, beforeId) => {
    const statusChanged = request.status !== status
    const column = requests
      .filter(r => r.status === status && r.id !== request.id && !r.deleted_at && !r.archived_at)
      .sort(compareForBoard)
    const { sortOrder, shifted } = placeInColumn(column, beforeId)
    // Оптимистично двигаем карточку: ждать круга к серверу на каждый бросок —
    // заметно и раздражает.
    const orderOf = new Map(shifted.map(u => [u.id, u.sort_order]))
    writeEpoch.current += 1
    setRequests(prev => prev.map(r => {
      if (r.id === request.id) return { ...r, status, sort_order: sortOrder }
      return orderOf.has(r.id) ? { ...r, sort_order: orderOf.get(r.id) } : r
    }))
    try {
      const { error: e } = await db
        .from('doc_check_requests').update({ status, sort_order: sortOrder }).eq('id', request.id)
      if (e) throw e
      if (statusChanged) await logEvent(request.id, statusEvent(request, status))
      for (const part of chunkList(shifted, 10)) {
        const results = await Promise.all(part.map(u => db
          .from('doc_check_requests').update({ sort_order: u.sort_order }).eq('id', u.id)))
        const failed = results.find(r => r.error)
        if (failed) throw failed.error
      }
      writeEpoch.current += 1
    } catch (err) {
      writeEpoch.current += 1
      alert('Не удалось переместить заявку: ' + (err.message || err))
      await fetchRequests({ quiet: true })
    }
  }

  const handleDelete = async (request) => {
    if (!confirm(`Удалить заявку «${cardTitle(request)}»?`)) return
    const ok = await patchRequest(request, { deleted_at: new Date().toISOString() },
      [{ event_type: 'soft_deleted', description: 'Заявка удалена' }])
    if (ok) setDetailId(null)
  }

  const handleRestore = (request) => {
    patchRequest(request, { deleted_at: null }, [{ event_type: 'restored', description: 'Заявка восстановлена' }])
  }

  const archive = (request) => patchRequest(request, { archived_at: new Date().toISOString() },
    [{ event_type: 'archived', description: 'Заявка отправлена в архив' }])
  const unarchive = (request) => patchRequest(request, { archived_at: null },
    [{ event_type: 'unarchived', description: 'Заявка возвращена из архива' }])

  // «В архив» в шапке колонки «Завершено»: все показанные в ней карточки.
  const handleArchiveDone = async (list) => {
    if (!confirm(`Отправить в архив завершённые заявки (${list.length})? Их можно вернуть из «Архива».`)) return
    const at = new Date().toISOString()
    const ids = new Set(list.map(r => r.id))
    writeEpoch.current += 1
    setRequests(prev => prev.map(r => (ids.has(r.id) ? { ...r, archived_at: at } : r)))
    let failed = 0
    for (const part of chunkList(list, 10)) {
      const results = await Promise.all(part.map(r => db
        .from('doc_check_requests').update({ archived_at: at }).eq('id', r.id)))
      results.forEach((res, k) => {
        if (res.error) failed++
        else logEvent(part[k].id, { event_type: 'archived', description: 'Заявка отправлена в архив' })
      })
    }
    writeEpoch.current += 1
    if (failed) {
      alert(`Не удалось отправить в архив: ${failed} из ${list.length}`)
      fetchRequests({ quiet: true })
    }
  }

  const handleCardAction = (request, type, value) => {
    if (type === 'open') setDetailId(request.id)
    else if (type === 'color') {
      if ((request.color || null) !== value) {
        patchRequest(request, { color: value }, fieldEvents(request, { color: value }))
      }
    } else if (type === 'status') moveTo(request, value)
    else if (type === 'archive') archive(request)
    else if (type === 'unarchive') unarchive(request)
    else if (type === 'delete') handleDelete(request)
  }

  // Число файлов всех заявок перечитываем, только если в окне файлы загружали, удаляли или переименовывали.
  const closeDetail = (filesChanged) => {
    setDetailId(null)
    if (filesChanged) fetchDocCounts()
  }

  // Доска и реестр получают одни и те же функции всё время жизни страницы: окно заявки, фильтры и ввод в них не должны
  // перерисовывать сотни карточек (03.11: окно открывалось с задержкой — заново рисовалось 850 карточек; 0,57 с при
  // процессоре в 4 раза медленнее, закрытие — 1,1 с). Функции внутри читают свежее состояние через ref.
  const actionsRef = useRef(null)
  actionsRef.current = {
    onMove: handleMove,
    onAdd: (status) => setFormFor({ request: null, status: createOnly ? 'new' : status }),
    onToggleDone: handleToggleDone,
    onCardAction: handleCardAction,
    onArchiveDone: handleArchiveDone,
    onRestore: handleRestore,
    onUnarchive: unarchive,
  }
  const actions = useMemo(() => {
    const call = (name) => (...args) => actionsRef.current[name](...args)
    return Object.fromEntries(Object.keys(actionsRef.current).map(name => [name, call(name)]))
  }, [])

  // ── Фильтрация ────────────────────────────────────────────────────────────
  // Заявка, у которой ничего не изменилось, остаётся тем же объектом: её карточка не перерисовывается.
  const mergedRows = useRef(new WeakMap())
  const withCounts = useMemo(
    () => mergeRequestCounts(requests, docCounts, cardCounts, mergedRows.current,
      (id, counts) => unreadTalkCount(counts, readMarkOf(talkReads, id))),
    [requests, docCounts, cardCounts, talkReads],
  )
  const inMode = useMemo(() => withCounts.filter(r => {
    if (mode === 'deleted') return !!r.deleted_at
    if (r.deleted_at) return false
    return mode === 'archive' ? !!r.archived_at : !r.archived_at
  }), [withCounts, mode])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const byNumber = requestNumberQuery(q)
    return inMode.filter(r => {
      if (filterObjectIds.length && !filterObjectIds.includes(r.object_id)) return false
      if (filterCounterpartyIds.length && !filterCounterpartyIds.includes(r.counterparty_id)) return false
      if (filterTypes.length && !filterTypes.includes(r.doc_type)) return false
      if (!matchesAssignees(r, filterAssignees, employees)) return false
      if (filterPriorities.length && !filterPriorities.includes(r.priority)) return false
      if (!matchesDeadline(r, filterDeadline)) return false
      if (!q) return true
      // Номер заявки (ID): «ID 12» / «№ 12» / «#12» — только она; «12» — она и тексты с «12».
      if (byNumber && r.request_number === byNumber.number) return true
      if (byNumber?.only) return false
      return [
        r.doc_number, r.notes, r.objects?.name, r.counterparties?.name, cardTitle(r), ...r.labels,
        ...shownAssigneeIds(r, employees).map(id => employeeName(employees, id, '')),
      ].some(v => (v || '').toLowerCase().includes(q))
    })
  }, [inMode, search, filterObjectIds, filterCounterpartyIds, filterTypes, filterAssignees,
    filterPriorities, filterDeadline, employees])

  // Реестр — в порядке колонок доски, внутри колонки — как на доске; удалённые — сначала последние.
  const listRows = useMemo(() => {
    if (mode === 'deleted') return [...visible].sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at))
    const at = new Map(DOC_CHECK_STATUSES.map((st, i) => [st.value, i]))
    return [...visible].sort((a, b) => ((at.get(a.status) ?? 99) - (at.get(b.status) ?? 99)) || compareForBoard(a, b))
  }, [visible, mode])

  const allLabels = useMemo(() => labelSuggestions(requests.filter(r => !r.deleted_at)), [requests])

  // Сколько заявок открытого списка на объекте — в подписи выпадающего списка «Объект» (03.11.2026, вместо плашек над доской).
  const objectCounts = useMemo(() => {
    const counts = new Map()
    for (const r of inMode) if (r.object_id) counts.set(r.object_id, (counts.get(r.object_id) || 0) + 1)
    return counts
  }, [inMode])

  const assigneeOptions = useMemo(() => [
    { value: NO_ASSIGNEE, label: 'Без исполнителя' },
    ...assigneeStaffOptions(employees),
  ], [employees])

  // Объекты с заявками — первыми, частые выше; остальные — по алфавиту, как в справочнике.
  const objectOptions = useMemo(() => objects
    .map(o => ({ value: o.id, label: objectCounts.get(o.id) ? `${o.name} (${objectCounts.get(o.id)})` : o.name, n: objectCounts.get(o.id) || 0, name: o.name }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ru')), [objects, objectCounts])
  // Контрагенты — весь реестр (номера без колонки считаются по нему), выбрать — только из «Активных» реестра контрагентов.
  // Поиск — по названию, ИНН и постоянному номеру (06.11.2026), и в форме, и в фильтре.
  const counterpartyOptions = useMemo(() => {
    const numbers = counterpartyNumbers(counterparties)
    return counterpartyPickerOptions(counterparties.filter(isPickableCounterparty), numbers)
  }, [counterparties])

  const detail = detailId ? withCounts.find(r => r.id === detailId) : null

  // Ссылка на заявку — /doc-check-requests?request=<id> (уведомление автору, 11.11.2026): после загрузки заявка открывается,
  // параметр снимается. Заявки нет или она не видна — просто доска.
  const [searchParams, setSearchParams] = useSearchParams()
  const linkedId = searchParams.get('request')
  useEffect(() => {
    if (!linkedId || loading) return
    if (requests.some(r => r.id === linkedId)) setDetailId(linkedId)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('request')
      return next
    }, { replace: true })
  }, [linkedId, loading, requests, setSearchParams])
  // Сколько фильтров панели выбрано (поиск — в шапке, не считается): число на кнопке «Фильтры» телефона.
  const activeFilters = [filterObjectIds, filterCounterpartyIds, filterTypes, filterAssignees, filterPriorities]
    .filter(list => list.length > 0).length + (filterDeadline ? 1 : 0)
  const hasFilters = activeFilters > 0 || search.trim() !== ''
  const resetFilters = () => {
    setSearch(''); setFilterObjectIds([]); setFilterCounterpartyIds([]); setFilterTypes([])
    setFilterAssignees([]); setFilterPriorities([]); setFilterDeadline('')
  }
  const deletedCount = requests.filter(r => r.deleted_at).length
  const archivedCount = requests.filter(r => !r.deleted_at && r.archived_at).length
  const showBoard = view === 'board' && mode === 'active'

  // Шапка над доской (название, поиск, фильтры) тоже двигает доску: нажать мышью на свободное место и вести влево-вправо
  // (11.11.2026, просьба пользователя). Кнопки, поля и списки работают как обычно. Тот же жест, что на самой доске.
  const pageRef = useRef(null)
  const headPan = useRef(null)
  const panFromHead = useCallback((e) => {
    if (!showBoard || e.button !== 0 || e.pointerType !== 'mouse' || headPan.current || e.target.closest(HEAD_CONTROLS)) return
    const box = pageRef.current?.querySelector(':scope > .dc-board')
    if (!box || box.scrollWidth <= box.clientWidth) return
    headPan.current = panByDrag(e, box, () => { headPan.current = null })
  }, [showBoard])
  useEffect(() => () => headPan.current?.(), [])

  // Нажали на заявку (карточку доски, строку реестра) — переписка и файлы окна читаются уже сейчас, пока кнопку не отпустили
  // (13.11.2026: «окно медленно открывается»). Отметка «готово» и меню карточки окно не открывают — им чтение не нужно.
  const prefetchOnPress = useCallback((e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return
    const el = e.target.closest('.dc-card[data-id], [data-dc-open]')
    if (!el || e.target.closest('.dc-card-check, .dc-card-more')) return
    prefetchCard(el.getAttribute('data-dc-open') || el.getAttribute('data-id'), { comments: hasCardFields })
  }, [hasCardFields])

  // Номера заявок (ID) есть — после миграции 20270123; до неё столбца «ID» в реестре нет.
  const hasNumbers = useMemo(() => requests.some(r => r.request_number != null), [requests])

  // Реестр — тем же значением, пока не изменились его данные: окно заявки сотни строк не перерисовывает.
  const listTable = useMemo(() => (isPhone ? (
      <div className="mcard-list dc-mcards">
        {listRows.map(r => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            className={`mcard is-tappable dc-mcard${r.color ? ` has-color dc-c-${r.color}` : ''}`}
            data-dc-open={r.id}
            onClick={() => setDetailId(r.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(r.id) } }}
          >
            <div className="mcard-head">
              <span className="mcard-title dc-row-title">
                {r.request_number != null && <span className="dc-chip dc-chip--id">{requestIdLabel(r)}</span>} {cardTitle(r)}
              </span>
              <span className={`dc-status-chip ${DOC_CHECK_STATUS_CLASS[r.status] || ''}`}>
                {DOC_CHECK_STATUS_LABEL[r.status] || r.status}
              </span>
            </div>
            {r.notes && <div className="mcard-desc">{r.notes}</div>}
            <div className="mcard-rows">
              <div className="mcard-row"><span className="mcard-label">Объект</span><span className="mcard-value">{r.objects?.name || '—'}</span></div>
              {hasBoardFields && r.assignee_ids.length > 0 && (
                <div className="mcard-row"><span className="mcard-label">Исполнители</span><span className="mcard-value"><RowAssignees request={r} employees={employees} /></span></div>
              )}
              {hasBoardFields && r.due_date && (
                <div className="mcard-row">
                  <span className="mcard-label">Срок</span>
                  <span className={`mcard-value ui-num dc-due-text is-${dueState(r)}`}>{fmtDocDate(r.due_date)}</span>
                </div>
              )}
              <div className="mcard-row">
                <span className="mcard-label">Создал</span>
                <span className="mcard-value">{r.created_by_name || '—'} · <span className="ui-num">{fmtDocDate(r.created_at)}</span></span>
              </div>
              {mode === 'deleted' && (
                <div className="mcard-row">
                  <span className="mcard-label">Удалил</span>
                  <span className="mcard-value">
                    {deletions ? (deletions.get(r.id)?.name || 'не записано') : '…'} · <span className="ui-num">{fmtDocDateTime(r.deleted_at)}</span>
                  </span>
                </div>
              )}
            </div>
            {(hasBoardFields && r.labels.length > 0) && (
              <span className="dc-card-chips">{r.labels.map(l => <span key={l} className="dc-chip dc-chip--label">{l}</span>)}</span>
            )}
            <div className="mcard-foot">
              <span className="dc-row-counts"><DocCheckCardCounts request={r} /></span>
              {mode !== 'active' && canEditSection && (
                <button
                  type="button"
                  className="dc-restore"
                  onClick={(e) => { e.stopPropagation(); if (mode === 'deleted') actions.onRestore(r); else actions.onUnarchive(r) }}
                ><IconRestore size={14} />{mode === 'deleted' ? 'Восстановить' : 'Вернуть'}</button>
              )}
            </div>
          </div>
        ))}
      </div>
  ) : (
      <div className="table-container dc-table-wrap">
        <table className="data-table dc-table">
          <thead>
            <tr>
              {hasNumbers && <th className="dc-col-id">ID</th>}
              <th>Документ</th>
              <th>Объект</th>
              {hasBoardFields && <th>Исполнители</th>}
              {hasBoardFields && <th>Срок</th>}
              <th>Статус</th>
              {hasBoardFields && <th>Метки</th>}
              <th>Создал</th>
              {mode === 'deleted' && <th>Удалил</th>}
              {mode !== 'active' && canEditSection && <th aria-label="Действия" />}
            </tr>
          </thead>
          <tbody>
            {listRows.map(r => (
              <tr key={r.id} data-dc-open={r.id} onClick={() => setDetailId(r.id)} className={`dc-row${r.color ? ` has-color dc-c-${r.color}` : ''}`}>
                {hasNumbers && <td className="dc-col-id ui-num">{r.request_number ?? '—'}</td>}
                <td>
                  <div className="dc-row-title">{cardTitle(r)}</div>
                  {r.notes && <div className="dc-row-notes">{r.notes}</div>}
                  <div className="dc-row-counts"><DocCheckCardCounts request={r} /></div>
                </td>
                <td>{r.objects?.name || '—'}</td>
                {hasBoardFields && <td><RowAssignees request={r} employees={employees} /></td>}
                {hasBoardFields && (
                  <td className="ui-num">
                    <span className={r.due_date ? `dc-due-text is-${dueState(r)}` : ''}>{fmtDocDate(r.due_date) || '—'}</span>
                  </td>
                )}
                <td>
                  <span className={`dc-status-chip ${DOC_CHECK_STATUS_CLASS[r.status] || ''}`}>
                    {DOC_CHECK_STATUS_LABEL[r.status] || r.status}
                  </span>
                </td>
                {hasBoardFields && (
                  <td>
                    <span className="dc-card-chips">
                      {r.labels.map(l => <span key={l} className="dc-chip dc-chip--label">{l}</span>)}
                    </span>
                  </td>
                )}
                <td className="dc-col-who">
                  <div>{r.created_by_name || '—'}</div>
                  <div className="dc-row-notes ui-num">{fmtDocDate(r.created_at)}</div>
                </td>
                {mode === 'deleted' && (
                  <td className="dc-col-who dc-col-deleted">
                    <div>{deletions ? (deletions.get(r.id)?.name || 'не записано') : '…'}</div>
                    <div className="dc-row-notes ui-num">{fmtDocDateTime(r.deleted_at)}</div>
                  </td>
                )}
                {mode !== 'active' && canEditSection && (
                  <td className="dc-row-action">
                    <button
                      type="button"
                      className="dc-restore"
                      onClick={(e) => { e.stopPropagation(); if (mode === 'deleted') actions.onRestore(r); else actions.onUnarchive(r) }}
                    ><IconRestore size={14} />{mode === 'deleted' ? 'Восстановить' : 'Вернуть'}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  )), [isPhone, listRows, employees, hasBoardFields, hasNumbers, mode, canEditSection, actions, deletions])

  // «Архив» и «Удалённые»: на компьютере — в шапке, на телефоне — в панели фильтров.
  const modeButtons = (
    <>
      {hasBoardFields && (
        <button
          type="button"
          className={`dc-mode-toggle${mode === 'archive' ? ' is-active' : ''}`}
          aria-pressed={mode === 'archive'}
          onClick={() => setMode(m => (m === 'archive' ? 'active' : 'archive'))}
        ><IconArchive size={15} />Архив{archivedCount > 0 ? ` (${archivedCount})` : ''}</button>
      )}
      <button
        type="button"
        className={`dc-mode-toggle dc-mode-toggle--deleted${mode === 'deleted' ? ' is-active' : ''}`}
        aria-pressed={mode === 'deleted'}
        onClick={() => setMode(m => (m === 'deleted' ? 'active' : 'deleted'))}
      ><IconTrash size={15} />Удалённые{deletedCount > 0 ? ` (${deletedCount})` : ''}</button>
    </>
  )

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div ref={pageRef} className={`doc-check-page ui-work${showBoard ? ' is-board' : ''}`} onPointerDownCapture={prefetchOnPress}>
      {/* Шапка — две низкие строки (решение пользователя 03.11.2026: больше заявок на экране): название, вид, поиск и
          действия; под ними фильтры. */}
      <div className="page-header dc-head" onPointerDown={panFromHead}>
        <h2>
          {/* Тон тот же, что у пункта меню, — раздел узнаётся по цвету. */}
          <IconTile tone="violet" className="page-icon-tile"><IconDocCheck /></IconTile>
          Заявки на проверку ДП/ДС
        </h2>
        <div className="dc-view-switch" role="tablist" aria-label="Вид">
          {[{ key: 'board', label: 'Доска' }, { key: 'list', label: 'Реестр' }].map(v => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              className={`dc-view-btn${view === v.key ? ' is-active' : ''}`}
              onClick={() => setView(v.key)}
            >{v.label}</button>
          ))}
        </div>
        <div className="dc-search-wrap">
          <IconSearch size={15} />
          <input
            type="search"
            className="dc-search"
            aria-label="Поиск заявок: контрагент, номер, объект, метка, примечание, исполнитель"
            placeholder={isPhone ? 'Поиск заявок' : 'Поиск: контрагент, номер, объект…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="dc-header-actions">
          {!isPhone && modeButtons}
          {isPhone && (
            <button
              type="button"
              className={`dc-mode-toggle dc-filters-btn${filtersOpen ? ' is-active' : ''}`}
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(o => !o)}
            ><IconFilter size={15} />Фильтры{activeFilters > 0 ? ` (${activeFilters})` : ''}</button>
          )}
          {canCreate && (
            <button className="btn-primary dc-new-btn" onClick={() => setFormFor({ request: null, status: 'new' })}>
              + Новая заявка
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dc-error" role="alert">
          Не удалось загрузить заявки: {error}. Возможно, не применена миграция
          <code> 20260905_doc_check_requests.sql</code>.
        </div>
      )}
      {!error && !hasBoardFields && isAdmin && (
        <div className="dc-note">
          Исполнители, сроки, приоритет, метки, цвет карточек и архив появятся после
          миграции <code>20261113_doc_check_board</code>. До неё доска работает как раньше.
        </div>
      )}
      {!error && hasBoardFields && !hasCardFields && isAdmin && (
        <div className="dc-note">
          Обсуждение появится после
          миграции <code>20261124_doc_check_card</code>.
        </div>
      )}

      {(!isPhone || filtersOpen) && (
      <div className="dc-toolbar" onPointerDown={panFromHead}>
        {isPhone && <div className="dc-toolbar-modes">{modeButtons}</div>}
        {hasBoardFields && (
          <>
            <FilterDropdown
              label="" multiple searchable
              searchPlaceholder="Поиск юриста…" allLabel="Исполнитель"
              icon={<IconUser size={15} />}
              value={filterAssignees} onChange={setFilterAssignees}
              options={assigneeOptions}
            />
            <FilterDropdown
              label="" allLabel="Срок"
              icon={<IconCalendar size={15} />}
              value={filterDeadline} onChange={(v) => setFilterDeadline(v || '')}
              options={[{ value: '', label: 'Любой срок' }, ...DEADLINE_FILTERS]}
            />
            <FilterDropdown
              label="" multiple allLabel="Приоритет"
              icon={<IconFlag size={15} />}
              value={filterPriorities} onChange={setFilterPriorities}
              options={DOC_CHECK_PRIORITIES}
            />
          </>
        )}
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Поиск объекта…" allLabel="Объект"
          icon={<IconObject size={15} />}
          value={filterObjectIds} onChange={setFilterObjectIds}
          options={objectOptions}
        />
        <FilterDropdown
          label="" multiple searchable
          searchPlaceholder="Название, ИНН или №" allLabel="Контрагент"
          icon={<IconUser size={15} />}
          value={filterCounterpartyIds} onChange={setFilterCounterpartyIds}
          options={counterpartyOptions}
          filterOptions={filterCounterpartyOptions}
        />
        <FilterDropdown
          label="" multiple allLabel="ДП и ДС"
          value={filterTypes} onChange={setFilterTypes}
          options={DOC_TYPES.map(t => ({ value: t.value, label: `${t.label} — ${t.title}` }))}
        />
        {hasFilters && (
          <button type="button" className="dc-reset" onClick={resetFilters}>Сбросить</button>
        )}
      </div>
      )}

      {mode !== 'active' && (
        <div className="dc-mode-banner">
          {mode === 'archive' ? 'Архив: заявки, убранные с доски. «Вернуть» ставит заявку обратно в её колонку.'
            : 'Удалённые заявки. «Восстановить» возвращает заявку на доску.'}
          <button type="button" className="dc-reset" onClick={() => setMode('active')}>К доске</button>
        </div>
      )}

      {showBoard ? (
        <DocCheckBoard
          requests={visible}
          employees={employees}
          canEdit={canEditSection}
          addOnly={createOnly ? 'new' : null}
          hasBoardFields={hasBoardFields}
          onOpen={setDetailId}
          onMove={actions.onMove}
          onAdd={actions.onAdd}
          onToggleDone={actions.onToggleDone}
          onCardAction={actions.onCardAction}
          onArchiveDone={actions.onArchiveDone}
        />
      ) : visible.length === 0 ? (
        <div className="dc-empty">
          {hasFilters && inMode.length > 0 ? 'Ничего не найдено — попробуйте изменить фильтры'
            : mode === 'deleted' ? 'Удалённых заявок нет'
              : mode === 'archive' ? 'В архиве пусто'
                : scopeIds.length ? 'По вашим объектам заявок пока нет.'
                  : canCreate ? 'Заявок пока нет. Создайте первую — она попадёт в колонку «Новые заявки».'
                    : 'Заявок пока нет.'}
        </div>
      ) : (
        listTable
      )}

      {formFor && (
        <DocCheckFormModal
          request={formFor.request}
          status={formFor.status}
          objects={objects}
          counterpartyOptions={counterpartyOptions}
          employees={employees}
          labelSuggestions={allLabels}
          hasBoardFields={hasBoardFields}
          hasCardFields={hasCardFields}
          canEditCreated={isAdmin || isSuperAdmin}
          creatorOnly={createOnly}
          ownObjects={scopeIds.length ? (objectsState === 'loading' ? null : objects) : undefined}
          ownObjectsFailed={objectsState === 'failed'}
          onSave={handleSave}
          onClose={() => setFormFor(null)}
        />
      )}

      {detail && (
        <DocCheckDetailModal
          key={detail.id}
          request={detail}
          employees={employees}
          objects={objects}
          counterparties={counterparties}
          canEdit={canEditSection}
          canCreateOwn={createOnly}
          hasBoardFields={hasBoardFields}
          hasCardFields={hasCardFields}
          hasChatFields={hasChatFields}
          currentUserId={myId}
          deletion={deletions?.get(detail.id) || null}
          refreshKey={detailRefresh}
          onCardCounts={handleCardCounts}
          talkReadMark={readMarkOf(talkReads, detail.id)}
          onTalkSeen={handleTalkSeen}
          onStatusChange={(r, status) => moveTo(r, status)}
          onAssign={handleAssign}
          onPsdcAssign={handlePsdcAssign}
          onEdit={(r) => { setDetailId(null); setFormFor({ request: r }) }}
          onDelete={handleDelete}
          onClose={closeDetail}
        />
      )}
    </div>
  )
}
