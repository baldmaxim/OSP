// task 433: общие константы и хелперы раздела «Задачи».
// Держим здесь всё, что нужно и доске, и списку, и карточке — чтобы статусы,
// цвета и логика сроков не разъезжались между тремя видами.

// Жизненный цикл (Битрикс-модель с приёмкой постановщиком):
//   new → in_progress → review → done. deferred — «отложена», вне основного потока.
export const TASK_STATUSES = [
  { value: 'new', label: 'Новая', className: 'ts-new' },
  { value: 'in_progress', label: 'В работе', className: 'ts-progress' },
  { value: 'review', label: 'На проверке', className: 'ts-review' },
  { value: 'done', label: 'Завершена', className: 'ts-done' },
  { value: 'deferred', label: 'Отложена', className: 'ts-deferred' },
]
export const TASK_STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map(s => [s.value, s.label]))
export const TASK_STATUS_CLASS = Object.fromEntries(TASK_STATUSES.map(s => [s.value, s.className]))

// Статусы, в которых задача считается закрытой (не показываем по умолчанию).
export const CLOSED_STATUSES = new Set(['done'])

export const TASK_PRIORITIES = [
  { value: 'high', label: 'Высокий', className: 'tp-high' },
  { value: 'normal', label: 'Обычный', className: 'tp-normal' },
  { value: 'low', label: 'Низкий', className: 'tp-low' },
]
export const TASK_PRIORITY_LABEL = Object.fromEntries(TASK_PRIORITIES.map(p => [p.value, p.label]))
export const TASK_PRIORITY_CLASS = Object.fromEntries(TASK_PRIORITIES.map(p => [p.value, p.className]))
// Порядок сортировки «важное сверху».
const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 }

// ── Сроки ───────────────────────────────────────────────────────────────────
export function todayMidnight() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Дней до даты: >0 впереди, 0 сегодня, <0 просрочено. null — срока нет.
export function daysUntilDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  d.setHours(0, 0, 0, 0)
  return Math.round((d - todayMidnight()) / 86400000)
}

// «Светофор» дедлайна — те же градации, что в уведомлениях.
export function dueClass(dateStr, status) {
  if (CLOSED_STATUSES.has(status)) return 'is-closed'
  const days = daysUntilDate(dateStr)
  if (days == null) return 'is-none'
  if (days < 0) return 'is-overdue'
  if (days === 0) return 'is-today'
  if (days <= 3) return 'is-soon'
  return 'is-upcoming'
}

export function isOverdue(task) {
  if (!task?.due_date || CLOSED_STATUSES.has(task.status)) return false
  return daysUntilDate(task.due_date) < 0
}

export function formatDateRu(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

export function formatDateTimeRu(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

// Короткая подпись срока для карточки: «просрочено 3 дн.» / «сегодня» / «12.09».
export function dueLabel(dateStr) {
  const days = daysUntilDate(dateStr)
  if (days == null) return ''
  if (days < 0) return `просрочено ${Math.abs(days)} ${plural(Math.abs(days), 'день', 'дня', 'дней')}`
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  return formatDateRu(dateStr)
}

export function plural(n, one, few, many) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

// ── Люди ────────────────────────────────────────────────────────────────────
// Инициалы для аватарки: «Садовников Данила» → «СД».
export function initialsOf(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const letters = parts.slice(0, 2).map(p => p[0].toUpperCase()).join('')
  return letters || '?'
}

// Устойчивый цвет аватарки по id — чтобы у сотрудника всегда был один и тот же тон.
const AVATAR_TONES = 8
export function avatarTone(userId) {
  if (!userId) return 0
  let hash = 0
  const str = String(userId)
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 100000
  return hash % AVATAR_TONES
}

// ── Сортировка ──────────────────────────────────────────────────────────────
// Порядок в колонке доски: ручной sort_order, затем срок, затем приоритет.
export function compareForBoard(a, b) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  const ad = a.due_date || '9999-12-31'
  const bd = b.due_date || '9999-12-31'
  if (ad !== bd) return ad < bd ? -1 : 1
  return (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1)
}

// Сортировка списка по колонке таблицы.
export function compareByField(a, b, field, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1
  let av
  let bv
  switch (field) {
    case 'priority':
      av = PRIORITY_WEIGHT[a.priority] ?? 1
      bv = PRIORITY_WEIGHT[b.priority] ?? 1
      break
    case 'due_date':
      // Задачи без срока — всегда в конце, независимо от направления.
      if (!a.due_date && !b.due_date) return 0
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      av = a.due_date
      bv = b.due_date
      break
    default:
      av = a[field] ?? ''
      bv = b[field] ?? ''
  }
  if (typeof av === 'string' && typeof bv === 'string') return sign * av.localeCompare(bv, 'ru')
  if (av === bv) return 0
  return sign * (av < bv ? -1 : 1)
}

// ── Фильтр по сроку ─────────────────────────────────────────────────────────
export const DUE_FILTERS = [
  { value: '', label: 'Любой срок' },
  { value: 'overdue', label: 'Просрочено' },
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Ближайшая неделя' },
  { value: 'none', label: 'Без срока' },
]

export function matchesDueFilter(task, filter) {
  if (!filter) return true
  const days = daysUntilDate(task.due_date)
  if (filter === 'none') return days == null
  if (days == null) return false
  if (filter === 'overdue') return days < 0 && !CLOSED_STATUSES.has(task.status)
  if (filter === 'today') return days === 0
  if (filter === 'week') return days >= 0 && days <= 7
  return true
}
