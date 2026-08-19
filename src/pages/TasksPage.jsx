import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import { useNotifications } from '../contexts/NotificationsContext'
import { useIsPhone } from '../hooks/useMediaQuery'
import { fetchAllRows } from '../utils/fetchAllRows'
import { employeeName, employeesById, fetchEmployees } from '../services/employees'
import { logTaskEvent, reorderTasks, setTaskParticipants, updateTask } from '../services/tasks'
import FilterDropdown from '../components/FilterDropdown'
import TaskBoard from '../components/tasks/TaskBoard'
import TaskListTable from '../components/tasks/TaskListTable'
import TaskDetailModal from '../components/tasks/TaskDetailModal'
import TaskFormModal from '../components/tasks/TaskFormModal'
import {
  CLOSED_STATUSES,
  DUE_FILTERS,
  TASK_PRIORITIES,
  compareByField,
  matchesDueFilter,
} from '../utils/taskHelpers'
// ContractRegistry.css — общие для проекта модалка/кнопки/поля формы/бейджи статусов
// (тот же приём, что в DcRequestsPage): не дублируем базовые стили в разделе.
import '../components/ContractRegistry.css'
import '../components/MobileCards.css'
import './TasksPage.css'

// task 433: раздел «Задачи» — распределение работы по сотрудникам.
//
// Два вида одних и тех же данных: канбан-доска (ставим и двигаем) и реестр
// (контролируем сроки). Фильтрация и сортировка делаются в памяти: задач в
// работе десятки-сотни, отдельные запросы на каждый чих тут только мешают.

const TABS = [
  { key: 'mine', label: 'Мои' },
  { key: 'created', label: 'Я поставил' },
  { key: 'watching', label: 'Наблюдаю' },
  { key: 'all', label: 'Все' },
  { key: 'deleted', label: 'Удалённые' },
]

// Выпадашки связей не должны тянуть весь архив — берём свежие записи.
const LINK_OPTIONS_LIMIT = 500

const VIEW_KEY = 'tasksView'
const GROUP_KEY = 'tasksBoardGroup'

function TasksPage() {
  const { canEdit, user, userProfile, role } = useRole()
  const { refresh: refreshNotifications } = useNotifications()
  const isPhone = useIsPhone()
  const [searchParams, setSearchParams] = useSearchParams()

  const canEditTasks = canEdit('tasks')
  const currentUserId = user?.id || null
  const author = useMemo(
    () => ({ name: userProfile?.full_name || user?.email || '', role }),
    [userProfile?.full_name, user?.email, role])

  const [tasks, setTasks] = useState([])
  const [employees, setEmployees] = useState([])
  const [objects, setObjects] = useState([])
  const [tenderOptions, setTenderOptions] = useState([])
  const [contractOptions, setContractOptions] = useState([])
  const [myParticipation, setMyParticipation] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [tab, setTab] = useState('mine')
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || 'board')
  const [boardGroup, setBoardGroup] = useState(() => localStorage.getItem(GROUP_KEY) || 'status')
  const [showCreate, setShowCreate] = useState(false)

  // Фильтры
  const [assigneeFilter, setAssigneeFilter] = useState([])
  const [priorityFilter, setPriorityFilter] = useState('')
  const [objectFilter, setObjectFilter] = useState('')
  const [dueFilter, setDueFilter] = useState('')
  const [search, setSearch] = useState('')
  const [showClosed, setShowClosed] = useState(false)

  // Список
  const [sort, setSort] = useState({ field: 'due_date', dir: 'asc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const employeeMap = useMemo(() => employeesById(employees), [employees])
  const openTaskId = searchParams.get('task')
  // На телефоне доска нечитаема (колонки шириной в экран, перетаскивание пальцем
  // конфликтует со скроллом) — там всегда список карточками.
  const effectiveView = isPhone ? 'list' : view

  useEffect(() => { localStorage.setItem(VIEW_KEY, view) }, [view])
  useEffect(() => { localStorage.setItem(GROUP_KEY, boardGroup) }, [boardGroup])

  // ── Загрузка ────────────────────────────────────────────────────────────────
  const loadTasks = useCallback(async () => {
    try {
      // Счётчики чек-листа и обсуждения нужны на каждой карточке, поэтому берём
      // их одним махом и складываем в мапы, а не запросом на задачу.
      const [rows, checklist, comments, participation] = await Promise.all([
        fetchAllRows((from, to) => supabase
          .from('tasks')
          .select('*, objects(name), tenders(public_tender_number), contracts(contract_number)')
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: false })
          .order('id')                     // тайбрейкер: без него постраничная выборка теряет строки
          .range(from, to)),
        fetchAllRows((from, to) => supabase
          .from('task_checklist_items').select('task_id, is_done')
          .order('task_id').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase
          .from('task_comments').select('task_id')
          .order('task_id').order('id').range(from, to)),
        currentUserId
          ? supabase.from('task_participants').select('task_id').eq('user_id', currentUserId)
          : Promise.resolve({ data: [] }),
      ])

      const checkTotal = new Map()
      const checkDone = new Map()
      for (const c of checklist) {
        checkTotal.set(c.task_id, (checkTotal.get(c.task_id) || 0) + 1)
        if (c.is_done) checkDone.set(c.task_id, (checkDone.get(c.task_id) || 0) + 1)
      }
      const commentCount = new Map()
      for (const c of comments) commentCount.set(c.task_id, (commentCount.get(c.task_id) || 0) + 1)

      setTasks(rows.map(t => ({
        ...t,
        checklistTotal: checkTotal.get(t.id) || 0,
        checklistDone: checkDone.get(t.id) || 0,
        commentsCount: commentCount.get(t.id) || 0,
      })))
      setMyParticipation(new Set((participation.data || []).map(p => p.task_id)))
    } catch (err) {
      console.error('Ошибка загрузки задач:', err.message)
      alert('Не удалось загрузить задачи: ' + err.message)
    }
  }, [currentUserId])

  const loadDictionaries = useCallback(async () => {
    try {
      const [emp, objRes, tendersRes, contractsRes] = await Promise.all([
        fetchEmployees(),
        supabase.from('objects').select('id, name').order('name', { ascending: true }),
        supabase.from('tenders')
          .select('id, public_tender_number, work_description')
          .is('deleted_at', null)
          .order('public_tender_number', { ascending: false, nullsFirst: false })
          .limit(LINK_OPTIONS_LIMIT),
        supabase.from('contracts')
          .select('id, contract_number, work_name')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(LINK_OPTIONS_LIMIT),
      ])
      setEmployees(emp)
      if (objRes.error) throw objRes.error
      setObjects(objRes.data || [])
      setTenderOptions((tendersRes.data || []).map(t => ({
        value: t.id,
        label: `${t.public_tender_number != null ? `№${t.public_tender_number} — ` : ''}${t.work_description || 'без описания'}`,
      })))
      setContractOptions((contractsRes.data || []).map(c => ({
        value: c.id,
        label: `${c.contract_number ? `№ ${c.contract_number} — ` : ''}${c.work_name || 'без описания'}`,
      })))
    } catch (err) {
      console.error('Ошибка загрузки справочников:', err.message)
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([loadTasks(), loadDictionaries()]).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [loadTasks, loadDictionaries])

  // ── Фильтрация ──────────────────────────────────────────────────────────────
  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter(t => {
      if (tab === 'deleted') {
        if (!t.deleted_at) return false
      } else if (t.deleted_at) return false

      if (tab === 'mine' && t.assignee_user_id !== currentUserId) return false
      if (tab === 'created' && t.created_by_user_id !== currentUserId) return false
      if (tab === 'watching' && !myParticipation.has(t.id)) return false

      // Завершённые прячем по умолчанию — иначе доска зарастает историей.
      if (!showClosed && CLOSED_STATUSES.has(t.status) && tab !== 'deleted') return false

      if (assigneeFilter.length && !assigneeFilter.includes(t.assignee_user_id)) return false
      if (priorityFilter && t.priority !== priorityFilter) return false
      if (objectFilter && t.object_id !== objectFilter) return false
      if (!matchesDueFilter(t, dueFilter)) return false
      if (q && !(t.title || '').toLowerCase().includes(q)
        && !(t.description || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [tasks, tab, currentUserId, myParticipation, showClosed, assigneeFilter,
    priorityFilter, objectFilter, dueFilter, search])

  const sortedTasks = useMemo(
    () => [...visibleTasks].sort((a, b) => compareByField(a, b, sort.field, sort.dir)),
    [visibleTasks, sort])

  const totalPages = Math.max(1, Math.ceil(sortedTasks.length / pageSize))
  const pageTasks = useMemo(() => {
    const start = (Math.min(page, totalPages) - 1) * pageSize
    return sortedTasks.slice(start, start + pageSize)
  }, [sortedTasks, page, pageSize, totalPages])

  // Смена фильтра/вкладки не должна оставлять пользователя на несуществующей странице.
  useEffect(() => { setPage(1) }, [tab, assigneeFilter, priorityFilter, objectFilter, dueFilter, search, showClosed])

  const openTask = tasks.find(t => t.id === openTaskId) || null

  // ── Мутации ────────────────────────────────────────────────────────────────
  const auditCtx = useMemo(() => ({
    employeeMap,
    objectNames: new Map(objects.map(o => [o.id, o.name])),
    tenderNames: new Map(tenderOptions.map(o => [o.value, o.label])),
    contractNames: new Map(contractOptions.map(o => [o.value, o.label])),
  }), [employeeMap, objects, tenderOptions, contractOptions])

  const afterChange = useCallback(async () => {
    await loadTasks()
    refreshNotifications()
  }, [loadTasks, refreshNotifications])

  const handleCreate = async (form, participants) => {
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description || '',
        assignee_user_id: form.assignee_user_id,
        created_by_user_id: currentUserId,
        due_date: form.due_date || null,
        priority: form.priority || 'normal',
        object_id: form.object_id || null,
        tender_id: form.tender_id || null,
        contract_id: form.contract_id || null,
        status: 'new',
        sort_order: 0,
      }
      const { data, error } = await supabase.from('tasks').insert([payload]).select('id').single()
      if (error) throw error
      await setTaskParticipants(data.id, 'coassignee', participants.coassignees)
      await setTaskParticipants(data.id, 'watcher', participants.watchers)
      await logTaskEvent(data.id, 'created', {
        description: `Задача поставлена: ${employeeName(employeeMap, form.assignee_user_id)}`,
      }, author)
      setShowCreate(false)
      await afterChange()
    } catch (err) {
      alert('Не удалось создать задачу: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Перетаскивание карточки: колонка = статус либо исполнитель.
  const handleMove = async (task, columnKey, orderedIds) => {
    const updates = boardGroup === 'status'
      ? (task.status === columnKey ? {} : { status: columnKey })
      : (task.assignee_user_id === columnKey ? {} : { assignee_user_id: columnKey })
    // Оптимистично двигаем карточку — иначе она «прыгает» назад до ответа сервера.
    setTasks(prev => prev.map(t => {
      if (t.id === task.id) return { ...t, ...updates, sort_order: orderedIds.indexOf(t.id) * 10 }
      const idx = orderedIds.indexOf(t.id)
      return idx >= 0 ? { ...t, sort_order: idx * 10 } : t
    }))
    try {
      if (Object.keys(updates).length) {
        await updateTask(task, updates, { author, ctx: auditCtx })
      }
      await reorderTasks(orderedIds)
      await afterChange()
    } catch (err) {
      alert('Не удалось переместить задачу: ' + err.message)
      await loadTasks()
    }
  }

  const handleStatusChange = async (task, status) => {
    try {
      await updateTask(task, { status }, { author, ctx: auditCtx })
      await afterChange()
    } catch (err) {
      alert('Не удалось изменить статус: ' + err.message)
    }
  }

  const handleDelete = async (task) => {
    if (!confirm(`Удалить задачу «${task.title}»? Её можно будет восстановить во вкладке «Удалённые».`)) return
    try {
      const { error } = await supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', task.id)
      if (error) throw error
      await logTaskEvent(task.id, 'soft_deleted', {}, author)
      closeTaskCard()
      await afterChange()
    } catch (err) {
      alert('Не удалось удалить задачу: ' + err.message)
    }
  }

  const handleRestore = async (task) => {
    try {
      const { error } = await supabase.from('tasks').update({ deleted_at: null }).eq('id', task.id)
      if (error) throw error
      await logTaskEvent(task.id, 'restored', {}, author)
      await afterChange()
    } catch (err) {
      alert('Не удалось восстановить задачу: ' + err.message)
    }
  }

  const openTaskCard = (taskId) => {
    const next = new URLSearchParams(searchParams)
    next.set('task', taskId)
    setSearchParams(next, { replace: false })
  }
  const closeTaskCard = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('task')
    setSearchParams(next, { replace: true })
  }

  const handleSort = (field) => {
    setSort(prev => (prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: 'asc' }))
  }

  // ── Счётчики вкладок ───────────────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const live = tasks.filter(t => !t.deleted_at && !CLOSED_STATUSES.has(t.status))
    return {
      mine: live.filter(t => t.assignee_user_id === currentUserId).length,
      created: live.filter(t => t.created_by_user_id === currentUserId).length,
      watching: live.filter(t => myParticipation.has(t.id)).length,
      all: live.length,
      deleted: tasks.filter(t => t.deleted_at).length,
    }
  }, [tasks, currentUserId, myParticipation])

  const peopleOptions = useMemo(
    () => employees.map(e => ({ value: e.user_id, label: e.display_name || e.email })),
    [employees])
  const objectDropdownOptions = useMemo(
    () => [{ value: '', label: 'Все объекты' }, ...objects.map(o => ({ value: o.id, label: o.name }))],
    [objects])

  return (
    <div className="tasks-page">
      <div className="tasks-header">
        <h2>Задачи</h2>
        <div className="tasks-header-actions">
          {!isPhone && (
            <div className="tasks-view-switch" role="tablist" aria-label="Вид">
              <button role="tab" aria-selected={view === 'board'}
                className={view === 'board' ? 'is-active' : ''} onClick={() => setView('board')}>Доска</button>
              <button role="tab" aria-selected={view === 'list'}
                className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}>Список</button>
            </div>
          )}
          {canEditTasks && (
            <button className="btn-primary" onClick={() => setShowCreate(true)}>Новая задача</button>
          )}
        </div>
      </div>

      <div className="tasks-tabs" role="tablist" aria-label="Мои задачи">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tasks-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            <span className="tasks-tab-count">{tabCounts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="tasks-toolbar">
        <input
          type="search"
          className="tasks-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по названию и описанию"
        />
        <FilterDropdown
          label="Исполнитель" value={assigneeFilter} onChange={setAssigneeFilter}
          options={peopleOptions} multiple searchable searchPlaceholder="Поиск сотрудника…"
          allLabel="Все"
        />
        <FilterDropdown
          label="Приоритет" value={priorityFilter} onChange={setPriorityFilter}
          options={[{ value: '', label: 'Любой' }, ...TASK_PRIORITIES.map(p => ({ value: p.value, label: p.label }))]}
          allLabel="Любой"
        />
        <FilterDropdown
          label="Объект" value={objectFilter} onChange={setObjectFilter}
          options={objectDropdownOptions} searchable searchPlaceholder="Поиск объекта…"
          allLabel="Все объекты"
        />
        <FilterDropdown
          label="Срок" value={dueFilter} onChange={setDueFilter}
          options={DUE_FILTERS} allLabel="Любой срок"
        />
        <label className="tasks-check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Показывать завершённые
        </label>
        {effectiveView === 'board' && (
          <FilterDropdown
            label="Колонки" value={boardGroup} onChange={(v) => setBoardGroup(v || 'status')}
            options={[{ value: 'status', label: 'По статусу' }, { value: 'assignee', label: 'По исполнителю' }]}
            allLabel="По статусу"
          />
        )}
      </div>

      {loading ? (
        <div className="tasks-empty">Загрузка…</div>
      ) : sortedTasks.length === 0 ? (
        <div className="tasks-empty">
          <p>Задач нет.</p>
          <p className="tasks-empty-hint">
            {tab === 'mine'
              ? 'Здесь появятся задачи, назначенные на вас.'
              : 'Измените фильтры или поставьте первую задачу.'}
          </p>
        </div>
      ) : effectiveView === 'board' ? (
        <TaskBoard
          tasks={sortedTasks}
          groupBy={boardGroup}
          employees={employees}
          employeeMap={employeeMap}
          onOpen={openTaskCard}
          onMove={handleMove}
          canEdit={canEditTasks && tab !== 'deleted'}
        />
      ) : (
        <>
          <TaskListTable
            tasks={pageTasks}
            employeeMap={employeeMap}
            onOpen={openTaskCard}
            onStatusChange={handleStatusChange}
            sort={sort}
            onSort={handleSort}
            isPhone={isPhone}
            canEdit={canEditTasks}
          />
          <div className="tasks-pagination">
            <span>Всего: {sortedTasks.length}</span>
            <div className="tasks-pagination-controls">
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>←</button>
              <span>{Math.min(page, totalPages)} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>→</button>
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
        </>
      )}

      {showCreate && (
        <TaskFormModal
          employees={employees}
          objects={objects}
          tenders={tenderOptions}
          contracts={contractOptions}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
          saving={saving}
        />
      )}

      {openTask && (
        <TaskDetailModal
          task={openTask}
          employees={employees}
          employeeMap={employeeMap}
          objectOptions={objects.map(o => ({ value: o.id, label: o.name }))}
          tenderOptions={tenderOptions}
          contractOptions={contractOptions}
          canEdit={canEditTasks}
          currentUserId={currentUserId}
          author={author}
          onClose={closeTaskCard}
          onChanged={afterChange}
          onDelete={handleDelete}
          onRestore={handleRestore}
        />
      )}
    </div>
  )
}

export default TasksPage
