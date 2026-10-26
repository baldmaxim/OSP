import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../../api'
import FilterDropdown from '../FilterDropdown'
import AutoGrowTextarea from '../AutoGrowTextarea'
import S3DocumentList from '../S3DocumentList'
import UserAvatar from './UserAvatar'
import { IconPencil } from '../icons/ActionIcons'
import {
  TASK_EVENT_LABEL,
  TASK_FIELD_LABEL,
  setTaskParticipants,
  updateTask,
} from '../../services/tasks'
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_CLASS,
  TASK_STATUSES,
  TASK_STATUS_CLASS,
  TASK_STATUS_LABEL,
  dueClass,
  dueLabel,
  formatDateRu,
  formatDateTimeRu,
  nextChecklistOrder,
  reorderChecklist,
} from '../../utils/taskHelpers'

// task 433: карточка задачи. Открывается модальным окном по центру поверх
// доски/списка и синхронизирована с ?task=<id>, поэтому на неё можно дать
// прямую ссылку (уведомление ведёт именно сюда).
//
// Раскладка в две колонки: слева работа (описание, чек-лист, обсуждение),
// справа свойства. Колонки прокручиваются независимо, поэтому исполнитель,
// срок и статус всегда перед глазами — не нужно листать к началу карточки.
//
// Жизненный цикл вынесен в кнопки-действия, а не спрятан в выпадающий список:
// исполнитель нажимает «Взять в работу» / «Сдать на проверку», постановщик —
// «Принять» / «Вернуть в работу». Это модель Битрикса: работу принимает тот,
// кто её поставил.
// Срок задачи. Поле даты шлёт change на каждую цифру года («0002», «0020»…):
// сохранение с перерисовкой сбивало набор. Держим черновик и сохраняем по уходу
// из поля или Enter — только полную дату (или пустую).
function DueDateInput({ value, onCommit }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => {
    if (draft === value) return
    if (draft && !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(draft)) { setDraft(value); return }
    onCommit(draft)
  }
  return (
    <input
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
    />
  )
}

// Ближайший прокручиваемый предок: на компьютере — левая колонка карточки,
// на узком экране (одна колонка) — общая прокрутка колонок.
function scrollParentOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

// Автопрокрутка при перетаскивании пункта: зона у края области прокрутки и
// наибольший шаг за кадр (у самого края — быстрее).
const AUTOSCROLL_ZONE = 56
const AUTOSCROLL_MAX_STEP = 16

function TaskDetailModal({
  task, employees, employeeMap, objectOptions, tenderOptions, contractOptions,
  canEdit, currentUserId, author, onClose, onChanged, onDelete, onRestore,
}) {
  const [tab, setTab] = useState('discussion')
  const [participants, setParticipants] = useState([])
  const [checklist, setChecklist] = useState([])
  const [comments, setComments] = useState([])
  const [history, setHistory] = useState([])
  const [filesCount, setFilesCount] = useState(0)
  const [newChecklistItem, setNewChecklistItem] = useState('')
  const [newComment, setNewComment] = useState('')
  const [busy, setBusy] = useState(false)
  // Перетаскивание пункта чек-листа: { id, overId, position: 'before' | 'after' }.
  // Ref — для отпускания: обработчик видит последнее место, а не прошлую отрисовку.
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  const checklistRef = useRef(null)
  // Палец у края области прокрутки: { y, frame } — последняя высота указателя и кадр.
  const autoScrollRef = useRef({ y: 0, frame: 0 })
  // Пункт в правке: { id, title }. Ref не даёт сохранить дважды (Enter, затем уход из поля).
  const [editingItem, setEditingItem] = useState(null)
  const editingRef = useRef(null)

  const isAssignee = task.assignee_user_id === currentUserId
  const isCreator = task.created_by_user_id === currentUserId
  // Поля задачи правит тот, кто её поставил (или сотрудник с правом на раздел).
  const canEditFields = canEdit || isCreator
  // Статус двигает и исполнитель — иначе он не может отчитаться о своей работе.
  const canMove = canEditFields || isAssignee
  const isDeleted = !!task.deleted_at

  const peopleOptions = employees.map(e => ({ value: e.user_id, label: e.display_name || e.email }))
  const nameOf = (userId) => (userId
    ? (employeeMap.get(userId)?.display_name || 'Пользователь удалён')
    : 'Не назначен')

  const loadDetails = useCallback(async () => {
    const [pRes, cRes, cmRes, hRes, fRes] = await Promise.all([
      db.from('task_participants').select('user_id, kind').eq('task_id', task.id),
      db.from('task_checklist_items').select('*').eq('task_id', task.id)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
      db.from('task_comments').select('*').eq('task_id', task.id)
        .order('created_at', { ascending: true }),
      db.from('task_audit_log').select('*').eq('task_id', task.id)
        .order('changed_at', { ascending: false }).limit(200),
      // Только счётчик для бейджа вкладки — сами файлы грузит S3DocumentList.
      db.from('s3_documents').select('id', { count: 'exact', head: true })
        .eq('owner_type', 'task').eq('owner_id', task.id),
    ])
    if (pRes.error) console.error('Ошибка загрузки участников задачи:', pRes.error.message)
    if (cRes.error) console.error('Ошибка загрузки чек-листа:', cRes.error.message)
    if (cmRes.error) console.error('Ошибка загрузки обсуждения:', cmRes.error.message)
    if (hRes.error) console.error('Ошибка загрузки истории задачи:', hRes.error.message)
    if (fRes.error) console.error('Ошибка подсчёта файлов задачи:', fRes.error.message)
    setParticipants(pRes.data || [])
    setChecklist(cRes.data || [])
    setComments(cmRes.data || [])
    setHistory(hRes.data || [])
    setFilesCount(fRes.count || 0)
  }, [task.id])

  useEffect(() => { loadDetails() }, [loadDetails])

  // Карточка закрывается только кнопкой «×» в шапке: ни клик по подложке рядом
  // с окном, ни Escape её не закрывают — так карточка терялась посреди работы
  // (промах мимо окна, Escape в поле ввода).

  const coassignees = participants.filter(p => p.kind === 'coassignee').map(p => p.user_id)
  const watchers = participants.filter(p => p.kind === 'watcher').map(p => p.user_id)

  const patch = async (updates) => {
    if (busy) return
    setBusy(true)
    try {
      const ctx = {
        employeeMap,
        objectNames: new Map(objectOptions.map(o => [o.value, o.label])),
        tenderNames: new Map(tenderOptions.map(o => [o.value, o.label])),
        contractNames: new Map(contractOptions.map(o => [o.value, o.label])),
      }
      await updateTask(task, updates, { author, ctx })
      await onChanged()
      await loadDetails()
    } catch (err) {
      alert('Не удалось сохранить: ' + err.message)
    } finally {
      setBusy(false)
    }
  }

  const saveParticipants = async (kind, userIds) => {
    try {
      await setTaskParticipants(task.id, kind, userIds)
      await loadDetails()
    } catch (err) {
      alert('Не удалось сохранить участников: ' + err.message)
    }
  }

  // ── Чек-лист ───────────────────────────────────────────────────────────────
  const addChecklistItem = async () => {
    const title = newChecklistItem.trim()
    if (!title) return
    const { error } = await db.from('task_checklist_items').insert([{
      task_id: task.id, title, sort_order: nextChecklistOrder(checklist),
    }])
    if (error) { alert('Не удалось добавить пункт: ' + error.message); return }
    setNewChecklistItem('')
    await loadDetails()
    await onChanged()
  }
  const toggleChecklistItem = async (item) => {
    const { error } = await db.from('task_checklist_items')
      .update({ is_done: !item.is_done }).eq('id', item.id)
    if (error) { alert('Не удалось изменить пункт: ' + error.message); return }
    await loadDetails()
    await onChanged()
  }
  const removeChecklistItem = async (item) => {
    const { error } = await db.from('task_checklist_items').delete().eq('id', item.id)
    if (error) { alert('Не удалось удалить пункт: ' + error.message); return }
    await loadDetails()
    await onChanged()
  }

  const startEditItem = (item) => {
    editingRef.current = { id: item.id, title: item.title }
    setEditingItem(editingRef.current)
  }
  const changeEditItem = (title) => {
    editingRef.current = { ...editingRef.current, title }
    setEditingItem(editingRef.current)
  }
  const cancelEditItem = () => {
    editingRef.current = null
    setEditingItem(null)
  }
  // Пустой текст пункт не удаляет — для этого есть «×»; правка просто отменяется.
  const commitEditItem = async () => {
    const edit = editingRef.current
    if (!edit) return
    cancelEditItem()
    const item = checklist.find(i => i.id === edit.id)
    const title = edit.title.trim()
    if (!item || !title || title === item.title) return
    setChecklist(prev => prev.map(i => (i.id === item.id ? { ...i, title } : i)))
    const { error } = await db.from('task_checklist_items').update({ title }).eq('id', item.id)
    if (error) alert('Не удалось изменить пункт: ' + error.message)
    await loadDetails()
  }

  // Порядок: сразу на экране, затем в базе — только у пунктов, чей номер изменился.
  const saveChecklistOrder = async (draggedId, targetId, position) => {
    const result = reorderChecklist(checklist, draggedId, targetId, position)
    if (!result) return
    setChecklist(result.ordered)
    try {
      const results = await Promise.all(result.updates.map(u => db
        .from('task_checklist_items').update({ sort_order: u.sort_order }).eq('id', u.id)))
      const failed = results.find(r => r.error)
      if (failed) throw failed.error
    } catch (err) {
      alert('Не удалось изменить порядок пунктов: ' + err.message)
    }
    await loadDetails()
  }

  // Ручка двигается указателем (мышь, палец, перо): HTML5-перетаскивание на
  // телефоне не работает. Место вставки — по строке под указателем: верхняя
  // половина — перед ней, нижняя — после.
  const dropPlace = (clientY) => {
    const rows = [...(checklistRef.current?.querySelectorAll('li[data-item-id]') || [])]
    if (!rows.length) return null
    const first = rows[0].getBoundingClientRect()
    if (clientY < first.top) return { overId: rows[0].dataset.itemId, position: 'before' }
    for (const li of rows) {
      const rect = li.getBoundingClientRect()
      if (clientY <= rect.bottom) {
        return { overId: li.dataset.itemId, position: clientY - rect.top < rect.height / 2 ? 'before' : 'after' }
      }
    }
    return { overId: rows[rows.length - 1].dataset.itemId, position: 'after' }
  }
  const setDragState = (next) => {
    dragRef.current = next
    setDrag(next)
  }
  const updateDropPlace = (clientY) => {
    const cur = dragRef.current
    if (!cur) return
    const place = dropPlace(clientY)
    if (!place) return
    // Над самим перетаскиваемым пунктом — не вставка, а «на месте».
    const next = place.overId === cur.id ? { ...cur, overId: null, position: null } : { ...cur, ...place }
    if (next.overId !== cur.overId || next.position !== cur.position) setDragState(next)
  }
  // Палец держат у верхнего или нижнего края области прокрутки — карточка едет
  // сама, место вставки пересчитывается: на телефоне чек-лист длиннее экрана,
  // и без этого пункт не дотащить за видимый край. Цикл кадров идёт, пока
  // указатель в зоне и есть куда прокручивать; только рефы — замыкание не стареет.
  const autoScrollStep = () => {
    const state = autoScrollRef.current
    state.frame = 0
    const box = dragRef.current && scrollParentOf(checklistRef.current)
    if (!box) return
    const rect = box.getBoundingClientRect()
    const zone = Math.min(AUTOSCROLL_ZONE, rect.height / 4)
    const depth = state.y < rect.top + zone ? state.y - (rect.top + zone)
      : state.y > rect.bottom - zone ? state.y - (rect.bottom - zone) : 0
    if (!depth) return
    const step = Math.sign(depth) * Math.min(AUTOSCROLL_MAX_STEP, Math.ceil((Math.abs(depth) / zone) * AUTOSCROLL_MAX_STEP))
    const before = box.scrollTop
    box.scrollTop = before + step
    if (box.scrollTop === before) return
    updateDropPlace(state.y)
    state.frame = requestAnimationFrame(autoScrollStep)
  }
  const stopAutoScroll = () => {
    cancelAnimationFrame(autoScrollRef.current.frame)
    autoScrollRef.current.frame = 0
  }
  // Карточку закрыли посреди перетаскивания — кадр не должен пережить окно.
  useEffect(() => {
    const state = autoScrollRef.current
    return () => cancelAnimationFrame(state.frame)
  }, [])
  const onHandlePointerDown = (e, item) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragState({ id: item.id, overId: null, position: null })
  }
  const onHandlePointerMove = (e) => {
    if (!dragRef.current) return
    updateDropPlace(e.clientY)
    autoScrollRef.current.y = e.clientY
    if (!autoScrollRef.current.frame) autoScrollRef.current.frame = requestAnimationFrame(autoScrollStep)
  }
  const onHandlePointerUp = () => {
    const cur = dragRef.current
    stopAutoScroll()
    setDragState(null)
    if (cur?.overId) saveChecklistOrder(cur.id, cur.overId, cur.position)
  }
  // С клавиатуры: стрелки вверх / вниз на ручке переставляют пункт на одно место.
  const onHandleKeyDown = (e, item) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const idx = checklist.findIndex(i => i.id === item.id)
    const up = e.key === 'ArrowUp'
    const target = checklist[up ? idx - 1 : idx + 1]
    if (!target) return
    saveChecklistOrder(item.id, target.id, up ? 'before' : 'after').then(() => {
      checklistRef.current?.querySelector(`li[data-item-id="${item.id}"] .task-checklist-handle`)?.focus()
    })
  }

  // ── Обсуждение ─────────────────────────────────────────────────────────────
  const addComment = async () => {
    const body = newComment.trim()
    if (!body) return
    const { error } = await db.from('task_comments').insert([{
      task_id: task.id, author_user_id: currentUserId, author_name: author.name || null, body,
    }])
    if (error) { alert('Не удалось отправить сообщение: ' + error.message); return }
    setNewComment('')
    await loadDetails()
    await onChanged()
  }

  const doneCount = checklist.filter(i => i.is_done).length

  return (
    <div className="modal-overlay task-modal-overlay">
      <div
        className={`modal task-modal${task.priority === 'high' ? ' is-high' : ''}`}
        role="dialog" aria-modal="true" aria-label="Карточка задачи"
      >
        <header className="task-modal-head">
          <span className={`status-badge ${TASK_STATUS_CLASS[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
          {task.priority !== 'normal' && (
            <span className={`task-priority-badge ${TASK_PRIORITY_CLASS[task.priority]}`}>
              {TASK_PRIORITIES.find(p => p.value === task.priority)?.label}
            </span>
          )}
          {task.due_date && (
            <span className={`task-due ${dueClass(task.due_date, task.status)}`}>
              {formatDateRu(task.due_date)} · {dueLabel(task.due_date)}
            </span>
          )}
          {isDeleted && <span className="status-badge status-deleted">Удалена</span>}
          <button className="task-modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </header>

        {/* Заголовок — на всю ширину над колонками: это имя задачи, в колонке ему тесно.
            Редактируется по клику: в покое выглядит как обычный заголовок. */}
        <div className="task-modal-title">
          {canEditFields && !isDeleted ? (
            <AutoGrowTextarea
              key={`title-${task.id}-${task.title}`}
              className="task-modal-title-input"
              defaultValue={task.title}
              minHeight={40}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== task.title) patch({ title: v })
              }}
              title="Название задачи — нажмите, чтобы изменить"
            />
          ) : (
            <h3 className="task-modal-title-text">{task.title}</h3>
          )}
        </div>

        <div className="task-modal-columns">
          {/* ── Левая колонка: работа ──────────────────────────────────────── */}
          <div className="task-modal-main">
            {/* Кнопки жизненного цикла («Взять в работу», «Сдать на проверку»
                и т.д.) убраны: они дублировали поле «Статус» справа и сбивали с
                толку — на только что созданной задаче висела кнопка, хотя статус
                меняется списком. Единственный способ сменить статус — выпадающий
                список в свойствах. Подсказку исполнителю оставляем: без кнопки
                «Принять работу» иначе непонятно, чьего действия ждёт задача. */}
            {!isDeleted && task.status === 'review' && !canEditFields && (
              <div className="task-actions">
                <span className="task-hint">Ждёт приёмки постановщиком — {nameOf(task.created_by_user_id)}</span>
              </div>
            )}

            {/* Описание */}
            <div className="task-section task-card-block">
              <h4 className="task-section-title">Описание</h4>
              {canEditFields && !isDeleted ? (
                <AutoGrowTextarea
                  key={`desc-${task.id}-${task.description}`}
                  className="task-modal-desc"
                  defaultValue={task.description || ''}
                  placeholder="Детали, ссылки, что считать результатом"
                  minHeight={72}
                  onBlur={(e) => {
                    const v = e.target.value
                    if (v !== (task.description || '')) patch({ description: v })
                  }}
                />
              ) : (
                <p className="task-desc-text">{task.description || <span className="task-muted">Описания нет</span>}</p>
              )}
            </div>

            {/* Чек-лист */}
            <div className="task-section task-card-block">
              <h4 className="task-section-title">
                Чек-лист {checklist.length > 0 && <span className="task-muted">{doneCount} / {checklist.length}</span>}
              </h4>
              {checklist.length > 0 && (
                <div className="task-checklist-progress">
                  <span style={{ width: `${Math.round((doneCount / checklist.length) * 100)}%` }} />
                </div>
              )}
              <ul className={`task-checklist${drag ? ' is-sorting' : ''}`} ref={checklistRef}>
                {checklist.map(item => {
                  const canArrange = canEditFields && !isDeleted
                  const isEditing = editingItem?.id === item.id
                  const rowClass = [
                    item.is_done ? 'is-done' : '',
                    drag?.id === item.id ? 'is-dragging' : '',
                    drag?.overId === item.id ? `drop-${drag.position}` : '',
                  ].filter(Boolean).join(' ')
                  return (
                    <li key={item.id} data-item-id={item.id} className={rowClass}>
                      {canArrange && checklist.length > 1 && (
                        <button
                          type="button"
                          className="task-checklist-handle"
                          aria-label={`Переместить пункт «${item.title}»`}
                          title="Перетащите, чтобы изменить порядок (или стрелки ↑ ↓)"
                          onPointerDown={(e) => onHandlePointerDown(e, item)}
                          onPointerMove={onHandlePointerMove}
                          onPointerUp={onHandlePointerUp}
                          onPointerCancel={() => { stopAutoScroll(); setDragState(null) }}
                          onKeyDown={(e) => onHandleKeyDown(e, item)}
                        >⋮⋮</button>
                      )}
                      {isEditing ? (
                        <input
                          type="text"
                          className="task-checklist-edit"
                          aria-label="Текст пункта"
                          autoFocus
                          value={editingItem.title}
                          onChange={(e) => changeEditItem(e.target.value)}
                          onBlur={commitEditItem}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEditItem() }
                            if (e.key === 'Escape') { e.preventDefault(); cancelEditItem() }
                          }}
                        />
                      ) : (
                        <label>
                          <input
                            type="checkbox"
                            checked={item.is_done}
                            disabled={isDeleted || !canMove}
                            onChange={() => toggleChecklistItem(item)}
                          />
                          <span>{item.title}</span>
                        </label>
                      )}
                      {canArrange && !isEditing && (
                        <button
                          type="button"
                          className="task-checklist-edit-btn"
                          onClick={() => startEditItem(item)}
                          aria-label={`Изменить пункт «${item.title}»`}
                          title="Изменить пункт"
                        ><IconPencil size={14} /></button>
                      )}
                      {canArrange && (
                        <button className="task-checklist-del" onClick={() => removeChecklistItem(item)} title="Удалить пункт">×</button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {canEditFields && !isDeleted && (
                <div className="task-inline-add">
                  <input
                    type="text"
                    value={newChecklistItem}
                    onChange={(e) => setNewChecklistItem(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem() } }}
                    placeholder="Добавить пункт"
                  />
                  <button className="btn-secondary" onClick={addChecklistItem}>Добавить</button>
                </div>
              )}
            </div>

            {/* Вкладки: обсуждение / файлы / история */}
            <div className="task-section task-card-block task-talk">
              <div className="task-tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'discussion'}
                  className={tab === 'discussion' ? 'is-active' : ''} onClick={() => setTab('discussion')}>
                  Обсуждение {comments.length > 0 && <span className="task-tab-count">{comments.length}</span>}
                </button>
                <button role="tab" aria-selected={tab === 'files'}
                  className={tab === 'files' ? 'is-active' : ''} onClick={() => setTab('files')}>
                  Файлы {filesCount > 0 && <span className="task-tab-count">{filesCount}</span>}
                </button>
                <button role="tab" aria-selected={tab === 'history'}
                  className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
                  История {history.length > 0 && <span className="task-tab-count">{history.length}</span>}
                </button>
              </div>

              {tab === 'discussion' && (
                <div className="task-comments">
                  {comments.length === 0 && <p className="task-muted">Сообщений пока нет.</p>}
                  {comments.map(c => (
                    <div key={c.id} className={`task-comment${c.author_user_id === currentUserId ? ' is-mine' : ''}`}>
                      <div className="task-comment-head">
                        <b>{c.author_name || 'Сотрудник'}</b>
                        <span className="task-muted">{formatDateTimeRu(c.created_at)}</span>
                      </div>
                      <p className="task-comment-body">{c.body}</p>
                    </div>
                  ))}
                  {!isDeleted && (
                    <div className="task-inline-add">
                      <input
                        type="text"
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addComment() } }}
                        placeholder="Написать сообщение…"
                      />
                      <button className="btn-primary" onClick={addComment}>Отправить</button>
                    </div>
                  )}
                </div>
              )}

              {/* onChange держит счётчик вкладки в согласии со списком файлов. */}
              {tab === 'files' && (
                <S3DocumentList
                  ownerType="task"
                  ownerId={task.id}
                  title="Файлы задачи"
                  canEdit={!isDeleted}
                  onChange={loadDetails}
                />
              )}

              {tab === 'history' && (
                <ul className="task-history">
                  {history.length === 0 && <li className="task-muted">История пуста.</li>}
                  {history.map(h => (
                    <li key={h.id}>
                      <span className="task-history-when">{formatDateTimeRu(h.changed_at)}</span>
                      <span className="task-history-what">
                        <b>{TASK_EVENT_LABEL[h.event_type] || h.event_type}</b>
                        {h.description
                          ? ` — ${h.description}`
                          : h.field_name ? ` — ${TASK_FIELD_LABEL[h.field_name] || h.field_name}` : ''}
                      </span>
                      {h.changed_by_name && <span className="task-muted">{h.changed_by_name}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Правая колонка: свойства ───────────────────────────────────── */}
          <aside className="task-modal-side">
            <div className="task-fields task-card-block">
              <div className="task-field">
                <span className="task-field-label">Исполнитель</span>
                {canEditFields && !isDeleted ? (
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={task.assignee_user_id || ''}
                    onChange={(v) => patch({ assignee_user_id: v || null })}
                    options={peopleOptions}
                    searchable
                    searchPlaceholder="Поиск сотрудника…"
                    allLabel="Не назначен"
                  />
                ) : (
                  <span className="task-person task-field-value">
                    <UserAvatar userId={task.assignee_user_id} name={nameOf(task.assignee_user_id)} />
                    <span className="task-person-name">{nameOf(task.assignee_user_id)}</span>
                  </span>
                )}
              </div>

              <div className="task-field">
                <span className="task-field-label">Постановщик</span>
                <span className="task-person task-field-value">
                  <UserAvatar userId={task.created_by_user_id} name={nameOf(task.created_by_user_id)} />
                  <span className="task-person-name">{nameOf(task.created_by_user_id)}</span>
                </span>
              </div>

              <div className="task-field">
                <span className="task-field-label">Срок</span>
                {canEditFields && !isDeleted ? (
                  <DueDateInput
                    value={task.due_date || ''}
                    onCommit={(v) => patch({ due_date: v || null })}
                  />
                ) : (
                  <span className="task-field-value">
                    <span className={`task-due ${dueClass(task.due_date, task.status)}`}>
                      {task.due_date ? `${formatDateRu(task.due_date)} · ${dueLabel(task.due_date)}` : '—'}
                    </span>
                  </span>
                )}
              </div>

              <div className="task-field">
                <span className="task-field-label">Приоритет</span>
                {canEditFields && !isDeleted ? (
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={task.priority}
                    onChange={(v) => patch({ priority: v || 'normal' })}
                    options={TASK_PRIORITIES.map(p => ({ value: p.value, label: p.label }))}
                    allLabel="Обычный"
                  />
                ) : (
                  <span className="task-field-value">{TASK_PRIORITIES.find(p => p.value === task.priority)?.label || '—'}</span>
                )}
              </div>

              <div className="task-field">
                <span className="task-field-label">Статус</span>
                {canMove && !isDeleted ? (
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={task.status}
                    onChange={(v) => v && patch({ status: v })}
                    options={TASK_STATUSES.map(s => ({ value: s.value, label: s.label }))}
                    allLabel={TASK_STATUS_LABEL[task.status]}
                  />
                ) : (
                  <span className="task-field-value">{TASK_STATUS_LABEL[task.status]}</span>
                )}
              </div>

              <div className="task-field">
                <span className="task-field-label">Соисполнители</span>
                {canEditFields && !isDeleted ? (
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={coassignees}
                    onChange={(v) => saveParticipants('coassignee', v)}
                    options={peopleOptions}
                    multiple
                    searchable
                    searchPlaceholder="Поиск сотрудника…"
                    allLabel="Нет"
                  />
                ) : (
                  <span className="task-field-value">{coassignees.length ? coassignees.map(nameOf).join(', ') : '—'}</span>
                )}
              </div>

              <div className="task-field">
                <span className="task-field-label">Наблюдатели</span>
                {canEditFields && !isDeleted ? (
                  <FilterDropdown
                    className="task-field-picker"
                    label=""
                    value={watchers}
                    onChange={(v) => saveParticipants('watcher', v)}
                    options={peopleOptions}
                    multiple
                    searchable
                    searchPlaceholder="Поиск сотрудника…"
                    allLabel="Нет"
                  />
                ) : (
                  <span className="task-field-value">{watchers.length ? watchers.map(nameOf).join(', ') : '—'}</span>
                )}
              </div>
            </div>

            {/* Связи с разделами системы */}
            <div className="task-section task-card-block">
              <h4 className="task-section-title">Связано с</h4>
              <div className="task-fields">
                <div className="task-field">
                  <span className="task-field-label">Объект</span>
                  {canEditFields && !isDeleted ? (
                    <FilterDropdown
                      className="task-field-picker" label=""
                      value={task.object_id || ''}
                      onChange={(v) => patch({ object_id: v || null })}
                      options={objectOptions} searchable searchPlaceholder="Поиск объекта…" allLabel="Без привязки"
                    />
                  ) : task.object_id ? (
                    <Link to={`/general/objects/${task.object_id}`} className="task-chip chip-object">{task.objects?.name || 'Объект'}</Link>
                  ) : <span className="task-field-value task-muted">—</span>}
                </div>
                <div className="task-field">
                  <span className="task-field-label">Тендер</span>
                  {canEditFields && !isDeleted ? (
                    <FilterDropdown
                      className="task-field-picker" label=""
                      value={task.tender_id || ''}
                      onChange={(v) => patch({ tender_id: v || null })}
                      options={tenderOptions} searchable searchPlaceholder="Поиск тендера…" allLabel="Без привязки"
                    />
                  ) : task.tender_id ? (
                    <Link to={`/tenders/${task.tender_id}`} className="task-chip chip-tender">
                      Тендер{task.tenders?.public_tender_number != null ? ` №${task.tenders.public_tender_number}` : ''}
                    </Link>
                  ) : <span className="task-field-value task-muted">—</span>}
                </div>
                <div className="task-field">
                  <span className="task-field-label">Договор</span>
                  {canEditFields && !isDeleted ? (
                    <FilterDropdown
                      className="task-field-picker" label=""
                      value={task.contract_id || ''}
                      onChange={(v) => patch({ contract_id: v || null })}
                      options={contractOptions} searchable searchPlaceholder="Поиск договора…" allLabel="Без привязки"
                    />
                  ) : task.contract_id ? (
                    <Link to={`/contracts/${task.contract_id}`} className="task-chip chip-contract">
                      Договор{task.contracts?.contract_number ? ` № ${task.contracts.contract_number}` : ''}
                    </Link>
                  ) : <span className="task-field-value task-muted">—</span>}
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="task-modal-foot">
          <span className="task-modal-meta">
            Создана {formatDateTimeRu(task.created_at)}
            {task.completed_at ? ` · завершена ${formatDateTimeRu(task.completed_at)}` : ''}
          </span>
          {canEditFields && (isDeleted
            ? <button className="btn-secondary" onClick={() => onRestore(task)}>Восстановить</button>
            : <button className="task-delete-btn" onClick={() => onDelete(task)}>Удалить задачу</button>)}
        </footer>
      </div>
    </div>
  )
}

export default TaskDetailModal
