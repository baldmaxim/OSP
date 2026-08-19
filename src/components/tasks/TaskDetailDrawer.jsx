import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../supabase'
import FilterDropdown from '../FilterDropdown'
import AutoGrowTextarea from '../AutoGrowTextarea'
import S3DocumentList from '../S3DocumentList'
import UserAvatar from './UserAvatar'
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
} from '../../utils/taskHelpers'

// task 433: карточка задачи. Открывается справа поверх доски/списка и
// синхронизирована с ?task=<id>, поэтому на неё можно дать прямую ссылку
// (уведомление ведёт именно сюда).
//
// Жизненный цикл вынесен в кнопки-действия, а не спрятан в выпадающий список:
// исполнитель нажимает «Взять в работу» / «Сдать на проверку», постановщик —
// «Принять» / «Вернуть в работу». Это модель Битрикса: работу принимает тот,
// кто её поставил.
function TaskDetailDrawer({
  task, employees, employeeMap, objectOptions, tenderOptions, contractOptions,
  canEdit, currentUserId, author, onClose, onChanged, onDelete, onRestore,
}) {
  const [tab, setTab] = useState('discussion')
  const [participants, setParticipants] = useState([])
  const [checklist, setChecklist] = useState([])
  const [comments, setComments] = useState([])
  const [history, setHistory] = useState([])
  const [newChecklistItem, setNewChecklistItem] = useState('')
  const [newComment, setNewComment] = useState('')
  const [busy, setBusy] = useState(false)

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
    const [pRes, cRes, cmRes, hRes] = await Promise.all([
      supabase.from('task_participants').select('user_id, kind').eq('task_id', task.id),
      supabase.from('task_checklist_items').select('*').eq('task_id', task.id)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
      supabase.from('task_comments').select('*').eq('task_id', task.id)
        .order('created_at', { ascending: true }),
      supabase.from('task_audit_log').select('*').eq('task_id', task.id)
        .order('changed_at', { ascending: false }).limit(200),
    ])
    if (pRes.error) console.error('Ошибка загрузки участников задачи:', pRes.error.message)
    if (cRes.error) console.error('Ошибка загрузки чек-листа:', cRes.error.message)
    if (cmRes.error) console.error('Ошибка загрузки обсуждения:', cmRes.error.message)
    if (hRes.error) console.error('Ошибка загрузки истории задачи:', hRes.error.message)
    setParticipants(pRes.data || [])
    setChecklist(cRes.data || [])
    setComments(cmRes.data || [])
    setHistory(hRes.data || [])
  }, [task.id])

  useEffect(() => { loadDetails() }, [loadDetails])

  // Escape закрывает карточку — как в остальных модалках проекта.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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
    const { error } = await supabase.from('task_checklist_items').insert([{
      task_id: task.id, title, sort_order: checklist.length * 10,
    }])
    if (error) { alert('Не удалось добавить пункт: ' + error.message); return }
    setNewChecklistItem('')
    await loadDetails()
    await onChanged()
  }
  const toggleChecklistItem = async (item) => {
    const { error } = await supabase.from('task_checklist_items')
      .update({ is_done: !item.is_done }).eq('id', item.id)
    if (error) { alert('Не удалось изменить пункт: ' + error.message); return }
    await loadDetails()
    await onChanged()
  }
  const removeChecklistItem = async (item) => {
    const { error } = await supabase.from('task_checklist_items').delete().eq('id', item.id)
    if (error) { alert('Не удалось удалить пункт: ' + error.message); return }
    await loadDetails()
    await onChanged()
  }

  // ── Обсуждение ─────────────────────────────────────────────────────────────
  const addComment = async () => {
    const body = newComment.trim()
    if (!body) return
    const { error } = await supabase.from('task_comments').insert([{
      task_id: task.id, author_user_id: currentUserId, author_name: author.name || null, body,
    }])
    if (error) { alert('Не удалось отправить сообщение: ' + error.message); return }
    setNewComment('')
    await loadDetails()
    await onChanged()
  }

  const doneCount = checklist.filter(i => i.is_done).length

  return (
    <>
      <div className="task-drawer-backdrop" onClick={onClose} aria-hidden />
      <aside className="task-drawer" role="dialog" aria-label="Карточка задачи">
        <header className="task-drawer-head">
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
          <button className="task-drawer-close" onClick={onClose} aria-label="Закрыть">×</button>
        </header>

        <div className="task-drawer-body">
          {/* Заголовок редактируется по клику: в покое выглядит как обычный
              заголовок, рамка и фон появляются на hover/focus. */}
          {canEditFields && !isDeleted ? (
            <AutoGrowTextarea
              key={`title-${task.id}-${task.title}`}
              className="task-drawer-title-input"
              defaultValue={task.title}
              minHeight={40}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== task.title) patch({ title: v })
              }}
              title="Название задачи — нажмите, чтобы изменить"
            />
          ) : (
            <h3 className="task-drawer-title">{task.title}</h3>
          )}

          {/* Действия жизненного цикла — главное, ради чего открывают карточку. */}
          {!isDeleted && canMove && (
            <div className="task-actions">
              {(task.status === 'new' || task.status === 'deferred') && (
                <button className="btn-primary" disabled={busy} onClick={() => patch({ status: 'in_progress' })}>
                  Взять в работу
                </button>
              )}
              {task.status === 'in_progress' && (
                <>
                  <button className="btn-primary" disabled={busy} onClick={() => patch({ status: 'review' })}>
                    Сдать на проверку
                  </button>
                  <button className="btn-secondary" disabled={busy} onClick={() => patch({ status: 'deferred' })}>
                    Отложить
                  </button>
                </>
              )}
              {task.status === 'review' && (canEditFields ? (
                <>
                  <button className="btn-primary" disabled={busy} onClick={() => patch({ status: 'done' })}>
                    Принять работу
                  </button>
                  <button className="btn-secondary" disabled={busy} onClick={() => patch({ status: 'in_progress' })}>
                    Вернуть в работу
                  </button>
                </>
              ) : (
                <span className="task-hint">Ждёт приёмки постановщиком — {nameOf(task.created_by_user_id)}</span>
              ))}
              {task.status === 'done' && canEditFields && (
                <button className="btn-secondary" disabled={busy} onClick={() => patch({ status: 'in_progress' })}>
                  Переоткрыть
                </button>
              )}
            </div>
          )}

          {/* Поля задачи */}
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
                  <span>{nameOf(task.assignee_user_id)}</span>
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
                <input
                  type="date"
                  value={task.due_date || ''}
                  onChange={(e) => patch({ due_date: e.target.value || null })}
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

          {/* Описание */}
          <div className="task-section task-card-block">
            <h4 className="task-section-title">Описание</h4>
            {canEditFields && !isDeleted ? (
              <AutoGrowTextarea
                key={`desc-${task.id}-${task.description}`}
                className="task-drawer-desc"
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
            <ul className="task-checklist">
              {checklist.map(item => (
                <li key={item.id} className={item.is_done ? 'is-done' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.is_done}
                      disabled={isDeleted || !canMove}
                      onChange={() => toggleChecklistItem(item)}
                    />
                    <span>{item.title}</span>
                  </label>
                  {canEditFields && !isDeleted && (
                    <button className="task-checklist-del" onClick={() => removeChecklistItem(item)} title="Удалить пункт">×</button>
                  )}
                </li>
              ))}
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
                className={tab === 'files' ? 'is-active' : ''} onClick={() => setTab('files')}>Файлы</button>
              <button role="tab" aria-selected={tab === 'history'}
                className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>История</button>
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

            {tab === 'files' && (
              <S3DocumentList ownerType="task" ownerId={task.id} title="Файлы задачи" canEdit={!isDeleted} />
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

        <footer className="task-drawer-foot">
          <span className="task-drawer-meta">
            Создана {formatDateTimeRu(task.created_at)}
            {task.completed_at ? ` · завершена ${formatDateTimeRu(task.completed_at)}` : ''}
          </span>
          {canEditFields && (isDeleted
            ? <button className="btn-secondary" onClick={() => onRestore(task)}>Восстановить</button>
            : <button className="task-delete-btn" onClick={() => onDelete(task)}>Удалить задачу</button>)}
        </footer>
      </aside>
    </>
  )
}

export default TaskDetailDrawer
