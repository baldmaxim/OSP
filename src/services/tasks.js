import { supabase } from '../supabase'
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, formatDateRu } from '../utils/taskHelpers'

// task 433: работа с задачами — запросы и запись истории в одном месте,
// потому что менять задачу можно из трёх точек (доска, список, карточка),
// и история должна писаться одинаково из любой.

export const TASK_EVENT_LABEL = {
  created: 'Создание',
  status_changed: 'Смена статуса',
  assignee_changed: 'Смена исполнителя',
  field_updated: 'Изменение поля',
  soft_deleted: 'В «Удалённые»',
  restored: 'Восстановление',
}

export const TASK_FIELD_LABEL = {
  title: 'Название',
  description: 'Описание',
  assignee_user_id: 'Исполнитель',
  due_date: 'Срок',
  priority: 'Приоритет',
  status: 'Статус',
  object_id: 'Объект',
  tender_id: 'Тендер',
  contract_id: 'Договор',
}

// Человекочитаемое значение поля для истории: id → имя, коды → подписи.
export function taskValueText(field, value, ctx = {}) {
  if (value === null || value === undefined || value === '') return '—'
  switch (field) {
    case 'status': return TASK_STATUS_LABEL[value] || String(value)
    case 'priority': return TASK_PRIORITY_LABEL[value] || String(value)
    case 'due_date': return formatDateRu(value)
    case 'assignee_user_id': return ctx.employeeMap?.get(value)?.display_name || 'Пользователь'
    case 'object_id': return ctx.objectNames?.get(value) || 'Объект'
    case 'tender_id': return ctx.tenderNames?.get(value) || 'Тендер'
    case 'contract_id': return ctx.contractNames?.get(value) || 'Договор'
    default: return String(value)
  }
}

// Запись в историю. Best-effort: сбой лога не должен ронять само изменение задачи.
export async function logTaskEvent(taskId, eventType, payload = {}, author = {}) {
  try {
    await supabase.from('task_audit_log').insert([{
      task_id: taskId,
      event_type: eventType,
      field_name: payload.fieldName || null,
      old_value: payload.oldValue ?? null,
      new_value: payload.newValue ?? null,
      description: payload.description || null,
      changed_by_role: author.role || null,
      changed_by_name: author.name || null,
    }])
  } catch (err) {
    console.error('Ошибка записи истории задачи:', err.message)
  }
}

// Обновление задачи с автоматической записью изменившихся полей в историю.
// updates — «плоский» объект колонок tasks. Возвращает обновлённую строку.
export async function updateTask(task, updates, { author = {}, ctx = {} } = {}) {
  const patch = { ...updates }

  // Переход в «Завершена» фиксирует момент закрытия; выход из него — снимает.
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    if (patch.status === 'done' && task.status !== 'done') patch.completed_at = new Date().toISOString()
    if (patch.status !== 'done' && task.status === 'done') patch.completed_at = null
  }

  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', task.id)
    .select('*')
    .single()
  if (error) throw error

  for (const [field, newValue] of Object.entries(updates)) {
    const oldValue = task[field] ?? null
    if ((oldValue ?? '') === (newValue ?? '')) continue
    const eventType = field === 'status' ? 'status_changed'
      : field === 'assignee_user_id' ? 'assignee_changed'
        : 'field_updated'
    await logTaskEvent(task.id, eventType, {
      fieldName: field,
      oldValue: taskValueText(field, oldValue, ctx),
      newValue: taskValueText(field, newValue, ctx),
      description: `${TASK_FIELD_LABEL[field] || field}: ${taskValueText(field, oldValue, ctx)} → ${taskValueText(field, newValue, ctx)}`,
    }, author)
  }
  return data
}

// Пересчёт порядка карточек в колонке доски после перетаскивания.
// Пишем шагом 10 — чтобы будущие вставки не требовали переписывать всю колонку.
export async function reorderTasks(orderedIds) {
  const updates = orderedIds.map((id, index) => supabase
    .from('tasks')
    .update({ sort_order: index * 10 })
    .eq('id', id))
  const results = await Promise.all(updates)
  const failed = results.find(r => r.error)
  if (failed?.error) throw failed.error
}

// Участники задачи: полностью переписываем набор нужного вида (соисполнители
// или наблюдатели) — их единицы, диффить дороже, чем перезаписать.
export async function setTaskParticipants(taskId, kind, userIds) {
  const { error: delError } = await supabase
    .from('task_participants')
    .delete()
    .eq('task_id', taskId)
    .eq('kind', kind)
  if (delError) throw delError
  if (!userIds?.length) return
  const { error } = await supabase
    .from('task_participants')
    .insert(userIds.map(user_id => ({ task_id: taskId, user_id, kind })))
  if (error) throw error
}
