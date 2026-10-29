// Общие константы раздела «Заявки на проверку ДП/ДС».
// Держим здесь всё, что нужно и доске, и реестру, и карточке — чтобы статусы,
// подписи и цвета не разъезжались между тремя видами (как в taskHelpers.js).
import { daysUntilDate } from './taskHelpers.js'

// Порядок в массиве = порядок колонок канбана (как на доске, где отдел вёл
// проверку до сайта). «Ожидаем скан» стоит ПОСЛЕ «Завершено» намеренно: по
// системе документ готов, но подписанный бумажный оригинал ещё не вернулся.
// board: true — статуса нет в базе до миграции 20261113 (колонки не показываем).
export const DOC_CHECK_STATUSES = [
  { value: 'new', label: 'Новые заявки', className: 'dcs-new' },
  { value: 'in_progress', label: 'В работе', className: 'dcs-progress' },
  { value: 'edo', label: 'Выгрузка по ЭДО', className: 'dcs-edo' },
  { value: 'signal', label: 'Загрузка в Signal', className: 'dcs-signal' },
  { value: 'accounting', label: 'Загрузка в 1С', className: 'dcs-accounting' },
  { value: 'done', label: 'Завершено', className: 'dcs-done' },
  { value: 'awaiting_scan', label: 'Ожидаем скан ДП/ДС, подписанного в бумажном виде', className: 'dcs-scan' },
  { value: 'tax_clause', label: 'Проверка документов (исключение налоговой оговорки)', className: 'dcs-tax', board: true },
]
export const DOC_CHECK_STATUS_LABEL = Object.fromEntries(DOC_CHECK_STATUSES.map(s => [s.value, s.label]))
export const DOC_CHECK_STATUS_CLASS = Object.fromEntries(DOC_CHECK_STATUSES.map(s => [s.value, s.className]))

// Статусы, доступные в базе: без колонок 20261113 — прежние семь.
export function availableStatuses(hasBoardFields) {
  return DOC_CHECK_STATUSES.filter(s => hasBoardFields || !s.board)
}

// Статусы, в которых заявка считается отработанной. «Ожидаем скан» сюда НЕ
// входит: пока бумага не пришла, заявку рано убирать из работы.
export const CLOSED_DOC_CHECK_STATUSES = new Set(['done'])

// «Сводка по ДП» — не статус, а колонка-выборка: те же заявки из других колонок
// по отбору (тип документа и статусы). Стоит там же, где на прежней доске, —
// между «Ожидаем скан» и «Проверкой документов».
export const SUMMARY_COLUMN = 'summary'
export const DEFAULT_SUMMARY = {
  types: ['dp'],
  statuses: DOC_CHECK_STATUSES.map(s => s.value).filter(v => !CLOSED_DOC_CHECK_STATUSES.has(v)),
}

export function boardColumns(hasBoardFields) {
  const cols = availableStatuses(hasBoardFields).map(s => ({ ...s, kind: 'status' }))
  const at = cols.findIndex(c => c.value === 'awaiting_scan') + 1
  cols.splice(at, 0, { value: SUMMARY_COLUMN, label: 'Сводка по ДП', className: 'dcs-summary', kind: 'summary' })
  return cols
}

// Отбор «Сводки» из сохранённой настройки. Пустой список — «все» (как пустой
// фильтр панели); нет настройки или она чужая — по умолчанию.
export function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_SUMMARY
  const pick = (list, known, fallback) => (Array.isArray(list) ? list.filter(v => known[v]) : fallback)
  return {
    types: pick(raw.types, DOC_TYPE_LABEL, DEFAULT_SUMMARY.types),
    statuses: pick(raw.statuses, DOC_CHECK_STATUS_LABEL, DEFAULT_SUMMARY.statuses),
  }
}

export function matchesSummary(request, summary) {
  return (!summary.types.length || summary.types.includes(request.doc_type))
    && (!summary.statuses.length || summary.statuses.includes(request.status))
}

export const DOC_TYPES = [
  { value: 'dp', label: 'ДП', title: 'Договор подряда' },
  { value: 'ds', label: 'ДС', title: 'Дополнительное соглашение' },
]
export const DOC_TYPE_LABEL = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.label]))
export const DOC_TYPE_TITLE = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.title]))

export const DOC_CHECK_PRIORITIES = [
  { value: 'high', label: 'Высокий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'low', label: 'Низкий' },
]
export const DOC_CHECK_PRIORITY_LABEL = Object.fromEntries(DOC_CHECK_PRIORITIES.map(p => [p.value, p.label]))

// Цвет карточки — как на прежней доске: красный — проблема, жёлтый — ждём и т. п.
// Значение пишется в базу (ограничение doc_check_requests_color_check), оттенок —
// в CSS (dc-card--c-<цвет>), чтобы светлая и тёмная темы подбирали его сами.
export const DOC_CHECK_COLORS = [
  { value: 'red', label: 'Красный' },
  { value: 'orange', label: 'Оранжевый' },
  { value: 'yellow', label: 'Жёлтый' },
  { value: 'green', label: 'Зелёный' },
  { value: 'teal', label: 'Бирюзовый' },
  { value: 'blue', label: 'Синий' },
  { value: 'violet', label: 'Фиолетовый' },
  { value: 'pink', label: 'Розовый' },
]
export const DOC_CHECK_COLOR_LABEL = Object.fromEntries(DOC_CHECK_COLORS.map(c => [c.value, c.label]))

// Срок: фильтр панели и «светофор» на карточке.
export const DEADLINE_FILTERS = [
  { value: 'overdue', label: 'Просрочено' },
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'В ближайшие 7 дней' },
  { value: 'none', label: 'Без срока' },
]

export function dueState(request) {
  if (!request?.due_date) return 'none'
  if (CLOSED_DOC_CHECK_STATUSES.has(request.status)) return 'closed'
  const days = daysUntilDate(request.due_date)
  if (days == null) return 'none'
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days <= 3) return 'soon'
  return 'upcoming'
}

export function matchesDeadline(request, filter) {
  if (!filter) return true
  if (filter === 'none') return !request.due_date
  if (!request.due_date || CLOSED_DOC_CHECK_STATUSES.has(request.status)) return false
  const days = daysUntilDate(request.due_date)
  if (filter === 'overdue') return days < 0
  if (filter === 'today') return days === 0
  if (filter === 'week') return days >= 0 && days <= 7
  return true
}

// «12.11» — срок на карточке; другой год — с годом.
export function dueShort(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (!m) return ''
  return m[1] === String(new Date().getFullYear()) ? `${m[3]}.${m[2]}` : `${m[3]}.${m[2]}.${m[1].slice(2)}`
}

// Метки: без лишних пробелов, без повторов (без учёта регистра), не длиннее 60
// знаков, не больше 12 — как ограничение в базе.
export const MAX_LABELS = 12
export function normalizeLabels(list) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    const label = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= MAX_LABELS) break
  }
  return out
}

// Метки, которыми уже пользуются, — подсказки при вводе: частые первыми.
export function labelSuggestions(requests) {
  const counts = new Map()
  for (const r of requests || []) {
    for (const l of r.labels || []) {
      const key = l.toLowerCase()
      const cur = counts.get(key)
      counts.set(key, { label: cur?.label || l, n: (cur?.n || 0) + 1 })
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ru'))
    .map(x => x.label)
}

// Инициалы для кружка исполнителя: «Иванова Роза Петровна» → «ИР», почта → две буквы.
export function initials(name) {
  const words = String(name || '').replace(/@.*$/, '').split(/[\s._-]+/).filter(w => /\p{L}/u.test(w))
  if (!words.length) return '?'
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return letters.toUpperCase()
}

// Цвет кружка — постоянный у человека: от его id, а не от места в списке.
export const AVATAR_TONES = 9
export function avatarTone(id) {
  let h = 0
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % AVATAR_TONES
}

// Дата в формате дд.мм.гггг; пустое значение отдаём как пустую строку, чтобы
// вызывающий сам решал, ставить ли прочерк.
export function fmtDocDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU')
}

// «ДП № 12 от 01.03.2026» — одна строка-подпись документа для карточки и списка.
export function docTitle(req) {
  const parts = [DOC_TYPE_LABEL[req?.doc_type] || 'Документ']
  if (req?.doc_number) parts.push(`№ ${req.doc_number}`)
  const date = fmtDocDate(req?.doc_date)
  if (date) parts.push(`от ${date}`)
  return parts.join(' ')
}

// «ООО "Ромашка" / ДС № 1» — заголовок карточки, как на прежней доске.
export function cardTitle(req) {
  const cp = req?.counterparties?.name
  return cp ? `${cp} / ${docTitle(req)}` : docTitle(req)
}

// Порядок карточек внутри колонки доски: сначала заданный перетаскиванием
// sort_order, при равенстве — старые сверху (порядок поступления заявок).
export function compareForBoard(a, b) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return new Date(a.created_at) - new Date(b.created_at)
}

// Новый порядок колонки после броска: номера 1…N, но в базу — только те строки,
// чей номер сменился (в «Завершено» сотня карточек: раньше каждый бросок
// переписывал их все).
export function reorderUpdates(rows, orderedIds) {
  const byId = new Map((rows || []).map(r => [r.id, r]))
  const out = []
  orderedIds.forEach((id, i) => {
    const r = byId.get(id)
    if (!r || r.sort_order !== i + 1) out.push({ id, sort_order: i + 1 })
  })
  return out
}

// Конец колонки: номер для карточки, которую ставят последней.
export function nextSortOrder(rows, status) {
  return (rows || [])
    .filter(r => r.status === status && !r.deleted_at && !r.archived_at)
    .reduce((m, r) => Math.max(m, r.sort_order || 0), 0) + 1
}

// Поля доски (миграция 20261113). Без них страница читает прежний набор и
// работает как раньше: без исполнителей, сроков, меток, цвета и архива.
export const BOARD_FIELDS = ['assignee_ids', 'due_date', 'priority', 'color', 'labels', 'archived_at']
const BASE_SELECT = `
  id, object_id, counterparty_id, doc_type, doc_number, doc_date, status, notes,
  sort_order, deleted_at, created_at, updated_at, created_by_name`
const EMBED = `,
  objects(id, name, status),
  counterparties(id, name)`
export const DOC_CHECK_SELECT = `${BASE_SELECT}, ${BOARD_FIELDS.join(', ')}${EMBED}`
export const DOC_CHECK_SELECT_LEGACY = `${BASE_SELECT}${EMBED}`

// Колонок 20261113 ещё нет: PostgREST отвечает 42703 (или PGRST204 на записи).
export function isMissingBoardColumn(err) {
  return ['42703', 'PGRST204'].includes(String(err?.code || ''))
}

// Строка из базы — к виду доски: массивы вместо NULL (прежняя база их не отдаёт).
export function normalizeRequest(r) {
  return { ...r, assignee_ids: r.assignee_ids || [], labels: r.labels || [] }
}

// События истории для правки из формы: только изменившиеся поля.
export function fieldEvents(prev, patch) {
  return Object.entries(patch)
    .filter(([field, value]) => FIELD_LABEL[field] && field !== 'archived_at' && !sameValue(prev[field], value))
    .map(([field, value]) => ({
      event_type: 'field_updated',
      field_name: field,
      old_value: prev[field] ?? null,
      new_value: value ?? null,
    }))
}

// Подписи полей в истории заявки.
export const FIELD_LABEL = {
  object_id: 'Объект',
  counterparty_id: 'Контрагент',
  doc_type: 'Тип документа',
  doc_number: 'Номер',
  doc_date: 'Дата документа',
  notes: 'Примечание',
  assignee_ids: 'Исполнители',
  due_date: 'Срок',
  priority: 'Приоритет',
  color: 'Цвет',
  labels: 'Метки',
  archived_at: 'Архив',
}

// Поле изменилось? Массивы (исполнители, метки) — по составу и порядку.
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || [])
  return (a ?? null) === (b ?? null)
}
