import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import DocCheckBoard from '../components/doccheck/DocCheckBoard'
import DocCheckFormModal from '../components/doccheck/DocCheckFormModal'
import DocCheckDetailModal from '../components/doccheck/DocCheckDetailModal'
import DocCheckAvatars from '../components/doccheck/DocCheckAvatars'
import DocCheckCardCounts from '../components/doccheck/DocCheckCardCounts'
import FilterDropdown from '../components/FilterDropdown'
import IconTile from '../components/IconTile'
import { IconObject, IconSearch, IconTag, IconUser } from '../components/icons/ToolbarIcons'
import { IconArchive, IconCalendar, IconFlag, IconRestore, IconTrash } from '../components/icons/ActionIcons'
import { IconDocCheck } from '../components/icons/NavIcons'
import { panByDrag } from '../components/doccheck/boardGestures'
import { fetchAllRows, fetchAllActiveCounterparties } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { employeeName, employeesById, fetchEmployees } from '../services/employees'
import { fetchCardCounts as readCardCounts, fetchDeletions } from '../services/docCheckCard'
import useBodyClass from '../hooks/useBodyClass'
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
  assigneeNames,
  cardTitle,
  compareForBoard,
  dueState,
  fieldEvents,
  fmtDocDate,
  fmtDocDateTime,
  isMissingBoardColumn,
  labelSuggestions,
  manualAssigneeKey,
  manualAssigneeSuggestions,
  matchesAssignees,
  matchesDeadline,
  mergeRequestCounts,
  nextSortOrder,
  normalizeRequest,
  normalizeSummary,
  placeInColumn,
} from '../utils/docCheckHelpers'
import '../styles/workUi.css'
import '../components/MobileCards.css'
import './DocCheckRequestsPage.css'

// Раздел «Заявки на проверку ДП/ДС».
//
// Раньше проверка договоров и допсоглашений шла письмами, потом — на внешней
// доске задач. Здесь та же доска на сайте (решение пользователя 29.10.2026 —
// «примерно такую же, как на фото»): колонки от «Новых заявок» до «Проверки
// документов (исключение налоговой оговорки)», «Сводка по ДП», карточки с
// цветом, метками, сроком и исполнителями, фильтры по исполнителю, сроку,
// приоритету, метке и объекту, архив.
//
// Заявка НЕ привязана к записи реестра «Договоры и ДС»: проверка идёт до того,
// как договор туда заводят, поэтому объект, контрагент, тип, № и дата вводятся
// руками.
//
// Без колонок миграции 20261113 (прежняя база) страница читает прежний набор
// полей и работает как раньше: без исполнителей, сроков, меток, цвета и архива.
// Без миграции 20261124 — без обсуждения, шагов, ссылки на письмо и исполнителей
// без учётной записи.

const SUMMARY_KEY = 'docCheckSummary'
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

const sameCounts = (a, b) => a.size === b.size && [...b].every(([id, n]) => a.get(id) === n)

// Плашки объектов: не помещаются в строку — тянуть мышью, как доску (нажатие без сдвига остаётся щелчком по плашке).
const panQuickChips = (e) => {
  const box = e.currentTarget
  if (e.button === 0 && e.pointerType === 'mouse' && box.scrollWidth > box.clientWidth) panByDrag(e, box, () => {})
}

export default function DocCheckRequestsPage() {
  useBodyClass('ui-work-portal')
  const { canEdit, role, userProfile, user, isAdmin } = useRole()
  const canEditSection = canEdit('doc_check_requests')
  const myId = user?.id || null

  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [employees, setEmployees] = useState(() => new Map())
  const [docCounts, setDocCounts] = useState(() => new Map())
  const [cardCounts, setCardCounts] = useState(() => new Map())
  const [hasBoardFields, setHasBoardFields] = useState(true)
  const [hasCardFields, setHasCardFields] = useState(false)
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
  const [filterLabels, setFilterLabels] = useState([])
  const [onlyMine, setOnlyMine] = useState(false)
  const [summary, setSummary] = useState(() => normalizeSummary(readStored(SUMMARY_KEY, null)))

  const [formFor, setFormFor] = useState(null)   // { request, status } | null
  const [detailId, setDetailId] = useState(null)
  const [detailRefresh, setDetailRefresh] = useState(0)

  useEffect(() => { writeStored(VIEW_KEY, view) }, [view])
  const changeSummary = (next) => { setSummary(next); writeStored(SUMMARY_KEY, next) }

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
    const read = (select) => fetchAllRows((from, to) => db
      .from('doc_check_requests')
      .select(select)
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
      setRequests(rows.map(normalizeRequest))
      setError(null)
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.error('Ошибка загрузки заявок на проверку ДП/ДС:', err.message)
      setError(err.message)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

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

  // Сколько шагов сделано и сколько сообщений — на карточке. Числа, которые открытая карточка заявки сообщила, пока шло
  // чтение, новее прочитанного — их не трогаем.
  const countsChanged = useRef(new Set())
  const fetchCardCounts = useCallback(async () => {
    countsChanged.current = new Set()
    try {
      const map = await readCardCounts()
      setCardCounts(prev => {
        for (const id of countsChanged.current) map.set(id, prev.get(id) || NO_CARD_COUNTS)
        return map
      })
    } catch (err) {
      console.warn('Не удалось посчитать шаги и сообщения заявок:', err.message)
    }
  }, [])
  const handleCardCounts = useCallback((id, counts) => {
    countsChanged.current.add(id)
    setCardCounts(prev => {
      const cur = prev.get(id) || NO_CARD_COUNTS
      if (cur.stepsTotal === counts.stepsTotal && cur.stepsDone === counts.stepsDone
        && cur.commentsCount === counts.commentsCount) return prev
      return new Map(prev).set(id, counts)
    })
  }, [])
  // Таблиц обсуждения и шагов нет, пока нет колонок той же миграции — до этого не обращаемся.
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
    // Объекты обоих отделов и контрагенты — для формы и фильтров.
    db.from('objects').select('id, name, status')
      .order('status', { ascending: true }).order('name', { ascending: true })
      .then(({ data, error: e }) => { if (!e) setObjects(data || []) })
    fetchAllActiveCounterparties()
      .then(setCounterparties)
      .catch(err => console.warn('Не удалось загрузить контрагентов:', err.message))
    fetchEmployees()
      .then(list => setEmployees(employeesById(list)))
      .catch(err => console.warn('Не удалось загрузить сотрудников:', err.message))
  }, [fetchRequests, fetchDocCounts])

  // Правки коллег — при возврате на вкладку браузера, не чаще раза в 30 с.
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastLoad.current < QUIET_RELOAD_MS) return
      fetchRequests({ quiet: true })
      fetchDocCounts()
      if (hasCardFields) fetchCardCounts()
      setDetailRefresh(n => n + 1)
    }
    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)
    return () => {
      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
    }
  }, [fetchRequests, fetchDocCounts, fetchCardCounts, hasCardFields])

  // ── История ───────────────────────────────────────────────────────────────
  const logEvent = useCallback(async (requestId, entry) => {
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

  const handleSave = async (payload) => {
    try {
      if (formFor?.request) {
        const prev = formFor.request
        const ok = await patchRequest(prev, payload, fieldEvents(prev, payload))
        if (!ok) return
      } else {
        const status = formFor?.status || 'new'
        const { data, error: e } = await db
          .from('doc_check_requests')
          .insert({ ...payload, status, sort_order: nextSortOrder(requests, status), created_by_name: author })
          .select('id')
          .single()
        if (e) throw e
        await logEvent(data.id, { event_type: 'created', description: 'Заявка создана' })
      }
      setFormFor(null)
      // Объект и контрагент приходят из базы встраиванием — перечитываем.
      await fetchRequests({ quiet: true })
    } catch (err) {
      alert('Не удалось сохранить заявку: ' + (err.message || err))
    }
  }

  // Новая колонка — в её конец.
  const moveTo = (request, status) => {
    if (request.status === status) return
    patchRequest(request, { status, sort_order: nextSortOrder(requests, status) }, [statusEvent(request, status)])
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

  // Файлы могли поменяться, только если открывали их вкладку: иначе перечитывать число файлов всех заявок незачем.
  const closeDetail = (docsOpened) => {
    setDetailId(null)
    if (docsOpened) fetchDocCounts()
  }

  // Доска и реестр получают одни и те же функции всё время жизни страницы: окно заявки, фильтры и ввод в них не должны
  // перерисовывать сотни карточек (03.11: окно открывалось с задержкой — заново рисовалось 850 карточек; 0,57 с при
  // процессоре в 4 раза медленнее, закрытие — 1,1 с). Функции внутри читают свежее состояние через ref.
  const actionsRef = useRef(null)
  actionsRef.current = {
    onMove: handleMove,
    onAdd: (status) => setFormFor({ request: null, status }),
    onToggleDone: handleToggleDone,
    onCardAction: handleCardAction,
    onArchiveDone: handleArchiveDone,
    onSummaryChange: changeSummary,
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
    () => mergeRequestCounts(requests, docCounts, cardCounts, mergedRows.current),
    [requests, docCounts, cardCounts],
  )
  const inMode = useMemo(() => withCounts.filter(r => {
    if (mode === 'deleted') return !!r.deleted_at
    if (r.deleted_at) return false
    return mode === 'archive' ? !!r.archived_at : !r.archived_at
  }), [withCounts, mode])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inMode.filter(r => {
      if (filterObjectIds.length && !filterObjectIds.includes(r.object_id)) return false
      if (filterCounterpartyIds.length && !filterCounterpartyIds.includes(r.counterparty_id)) return false
      if (filterTypes.length && !filterTypes.includes(r.doc_type)) return false
      if (onlyMine && !(myId && r.assignee_ids.includes(myId))) return false
      if (!matchesAssignees(r, filterAssignees)) return false
      if (filterPriorities.length && !filterPriorities.includes(r.priority)) return false
      if (filterLabels.length && !filterLabels.some(l => r.labels.includes(l))) return false
      if (!matchesDeadline(r, filterDeadline)) return false
      if (!q) return true
      return [
        r.doc_number, r.notes, r.objects?.name, r.counterparties?.name, cardTitle(r), ...r.labels,
        ...assigneeNames(r, id => employeeName(employees, id, '')),
      ].some(v => (v || '').toLowerCase().includes(q))
    })
  }, [inMode, search, filterObjectIds, filterCounterpartyIds, filterTypes, onlyMine, myId, filterAssignees,
    filterPriorities, filterLabels, filterDeadline, employees])

  // Реестр — в порядке колонок доски, внутри колонки — как на доске; удалённые — сначала последние.
  const listRows = useMemo(() => {
    if (mode === 'deleted') return [...visible].sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at))
    const at = new Map(DOC_CHECK_STATUSES.map((st, i) => [st.value, i]))
    return [...visible].sort((a, b) => ((at.get(a.status) ?? 99) - (at.get(b.status) ?? 99)) || compareForBoard(a, b))
  }, [visible, mode])

  const allLabels = useMemo(() => labelSuggestions(requests.filter(r => !r.deleted_at)), [requests])
  const allManualAssignees = useMemo(() => manualAssigneeSuggestions(requests.filter(r => !r.deleted_at)), [requests])

  // Объекты открытого списка — плашки быстрого отбора, частые первыми. Видны и в «Архиве», и в «Удалённых»: выбранный отбор
  // действует и там, и спрятанный он молча скрывал бы заявки.
  const objectChips = useMemo(() => {
    const counts = new Map()
    for (const r of inMode) {
      if (!r.object_id) continue
      const cur = counts.get(r.object_id)
      if (cur) cur.n += 1
      else counts.set(r.object_id, { id: r.object_id, n: 1, name: r.objects?.name || 'Объект' })
    }
    return [...counts.values()]
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 14)
  }, [inMode])

  const assigneeOptions = useMemo(() => {
    const ids = new Set()
    const manual = new Map()
    for (const r of requests) {
      for (const id of r.assignee_ids) ids.add(id)
      for (const name of r.manual_assignees) if (!manual.has(manualAssigneeKey(name))) manual.set(manualAssigneeKey(name), name)
    }
    return [
      { value: NO_ASSIGNEE, label: 'Без исполнителя' },
      ...[
        ...[...ids].map(id => ({ value: id, label: employeeName(employees, id) })),
        ...[...manual].map(([value, name]) => ({ value, label: `${name} (нет в справочнике)` })),
      ].sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    ]
  }, [requests, employees])

  const objectOptions = useMemo(() => objects.map(o => ({ value: o.id, label: o.name })), [objects])
  const counterpartyOptions = useMemo(() => counterparties.map(c => ({ value: c.id, label: c.name })), [counterparties])

  const detail = detailId ? withCounts.find(r => r.id === detailId) : null
  const hasFilters = filterObjectIds.length > 0 || filterCounterpartyIds.length > 0 || filterTypes.length > 0
    || filterAssignees.length > 0 || filterPriorities.length > 0 || filterLabels.length > 0
    || !!filterDeadline || onlyMine || search.trim() !== ''
  const resetFilters = () => {
    setSearch(''); setFilterObjectIds([]); setFilterCounterpartyIds([]); setFilterTypes([])
    setFilterAssignees([]); setFilterPriorities([]); setFilterLabels([]); setFilterDeadline(''); setOnlyMine(false)
  }
  const toggleObject = (id) => setFilterObjectIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  const deletedCount = requests.filter(r => r.deleted_at).length
  const archivedCount = requests.filter(r => !r.deleted_at && r.archived_at).length
  const showBoard = view === 'board' && mode === 'active'

  // Реестр — тем же значением, пока не изменились его данные: окно заявки сотни строк не перерисовывает.
  const listTable = useMemo(() => (
      <div className="table-container dc-table-wrap">
        <table className="data-table dc-table">
          <thead>
            <tr>
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
              <tr key={r.id} onClick={() => setDetailId(r.id)} className={`dc-row${r.color ? ` has-color dc-c-${r.color}` : ''}`}>
                <td>
                  <div className="dc-row-title">{cardTitle(r)}</div>
                  {r.notes && <div className="dc-row-notes">{r.notes}</div>}
                  <div className="dc-row-counts"><DocCheckCardCounts request={r} /></div>
                </td>
                <td>{r.objects?.name || '—'}</td>
                {hasBoardFields && (
                  <td>
                    {r.assignee_ids.length || r.manual_assignees.length ? (
                      <span className="dc-row-people">
                        <DocCheckAvatars ids={r.assignee_ids} manual={r.manual_assignees} employees={employees} />
                        <span>{assigneeNames(r, id => employeeName(employees, id)).join(', ')}</span>
                      </span>
                    ) : '—'}
                  </td>
                )}
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
  ), [listRows, employees, hasBoardFields, mode, canEditSection, actions, deletions])

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className={`doc-check-page ui-work${showBoard ? ' is-board' : ''}`}>
      {/* Шапка — две низкие строки (решение пользователя 03.11.2026: больше заявок на экране): название, вид, поиск и
          действия; под ними фильтры и быстрый отбор. */}
      <div className="page-header dc-head">
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
            placeholder="Поиск: контрагент, номер, объект…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="dc-header-actions">
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
          {canEditSection && (
            <button className="btn-primary" onClick={() => setFormFor({ request: null, status: 'new' })}>
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
          Исполнители, сроки, приоритет, метки, цвет карточек, архив и колонка «Проверка документов» появятся после
          миграции <code>20261113_doc_check_board</code>. До неё доска работает как раньше.
        </div>
      )}
      {!error && hasBoardFields && !hasCardFields && isAdmin && (
        <div className="dc-note">
          Обсуждение, шаги, ссылка на письмо и исполнители без учётной записи появятся после
          миграции <code>20261124_doc_check_card</code>.
        </div>
      )}

      <div className="dc-toolbar">
        {hasBoardFields && (
          <>
            <FilterDropdown
              label="" multiple searchable
              searchPlaceholder="Поиск сотрудника…" allLabel="Исполнитель"
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
            {allLabels.length > 0 && (
              <FilterDropdown
                label="" multiple searchable
                searchPlaceholder="Поиск метки…" allLabel="Метка"
                icon={<IconTag size={15} />}
                value={filterLabels} onChange={setFilterLabels}
                options={allLabels.map(l => ({ value: l, label: l }))}
              />
            )}
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
          searchPlaceholder="Поиск контрагента…" allLabel="Контрагент"
          icon={<IconUser size={15} />}
          value={filterCounterpartyIds} onChange={setFilterCounterpartyIds}
          options={counterpartyOptions}
        />
        <FilterDropdown
          label="" multiple allLabel="ДП и ДС"
          value={filterTypes} onChange={setFilterTypes}
          options={DOC_TYPES.map(t => ({ value: t.value, label: `${t.label} — ${t.title}` }))}
        />
        {hasFilters && (
          <button type="button" className="dc-reset" onClick={resetFilters}>Сбросить</button>
        )}
        {(objectChips.length > 0 || (hasBoardFields && myId)) && (
          <div className="dc-quick" aria-label="Быстрый отбор" onPointerDown={panQuickChips}>
            {hasBoardFields && myId && (
              <button
                type="button"
                className={`dc-quick-chip dc-quick-chip--mine${onlyMine ? ' is-active' : ''}`}
                aria-pressed={onlyMine}
                onClick={() => setOnlyMine(v => !v)}
              ><IconUser size={13} />Мои заявки</button>
            )}
            {objectChips.map(o => (
              <button
                key={o.id}
                type="button"
                className={`dc-quick-chip${filterObjectIds.includes(o.id) ? ' is-active' : ''}`}
                aria-pressed={filterObjectIds.includes(o.id)}
                onClick={() => toggleObject(o.id)}
                title={`${o.name}: ${o.n}`}
              >{o.name}<span className="dc-quick-n">{o.n}</span></button>
            ))}
          </div>
        )}
      </div>

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
          hasBoardFields={hasBoardFields}
          summary={summary}
          onSummaryChange={actions.onSummaryChange}
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
                : 'Заявок пока нет. Создайте первую — она попадёт в колонку «Новые заявки».'}
        </div>
      ) : (
        listTable
      )}

      {formFor && (
        <DocCheckFormModal
          request={formFor.request}
          status={formFor.status}
          objects={objects}
          counterparties={counterparties}
          employees={employees}
          labelSuggestions={allLabels}
          manualSuggestions={allManualAssignees}
          hasBoardFields={hasBoardFields}
          hasCardFields={hasCardFields}
          onSave={handleSave}
          onClose={() => setFormFor(null)}
        />
      )}

      {detail && (
        <DocCheckDetailModal
          request={detail}
          employees={employees}
          objects={objects}
          counterparties={counterparties}
          canEdit={canEditSection}
          hasBoardFields={hasBoardFields}
          hasCardFields={hasCardFields}
          currentUserId={myId}
          deletion={deletions?.get(detail.id) || null}
          refreshKey={detailRefresh}
          onCardCounts={handleCardCounts}
          onStatusChange={(r, status) => moveTo(r, status)}
          onEdit={(r) => { setDetailId(null); setFormFor({ request: r }) }}
          onDelete={handleDelete}
          onClose={closeDetail}
        />
      )}
    </div>
  )
}
