// Общие константы раздела «Заявки на проверку ДП/ДС».
// Держим здесь всё, что нужно и доске, и реестру, и карточке — чтобы статусы,
// подписи и цвета не разъезжались между тремя видами (как в taskHelpers.js).
import { ROLES } from '../contexts/roleConstants.js'
import { daysUntilDate, splitChecklistLines } from './taskHelpers.js'

// Порядок в массиве = порядок колонок канбана (как на доске, где отдел вёл
// проверку до сайта). «Ожидаем скан» стоит ПОСЛЕ «Завершено» намеренно: по
// системе документ готов, но подписанный бумажный оригинал ещё не вернулся.
// board: true — статуса нет в базе до миграции 20261113 (колонки не показываем); сейчас таких нет.
export const DOC_CHECK_STATUSES = [
  { value: 'new', label: 'Новые заявки', className: 'dcs-new' },
  { value: 'in_progress', label: 'В работе', className: 'dcs-progress' },
  { value: 'edo', label: 'Выгрузка по ЭДО', className: 'dcs-edo' },
  { value: 'signal', label: 'Загрузка в Signal', className: 'dcs-signal' },
  { value: 'accounting', label: 'Загрузка в 1С', className: 'dcs-accounting' },
  { value: 'done', label: 'Завершено', className: 'dcs-done' },
  { value: 'awaiting_scan', label: 'Ожидаем скан ДП/ДС, подписанного в бумажном виде', className: 'dcs-scan' },
]

// Убранные колонки (10.11.2026, решение пользователя: «Сводку по ДП» и «Проверку документов (исключение налоговой
// оговорки)» удалить вообще). Статус tax_clause остаётся в базе (ограничение 20261113 не трогаем) только ради подписи у
// заявок, которые в нём ещё стоят: такую заявку не предлагают ни колонкой, ни выбором, бросить в неё нельзя. Пока она
// есть на доске, для неё рисуется колонка без «+» и без приёма карточек (как для любого статуса вне справочника); перенесли
// или отправили в архив последнюю — колонка пропала сама. Разово: migration/data/20261110_doc_check_tax_clause_archive.sql.
export const RETIRED_DOC_CHECK_STATUSES = [
  { value: 'tax_clause', label: 'Проверка документов (исключение налоговой оговорки)', className: 'dcs-tax' },
]
export const DOC_CHECK_STATUS_LABEL = Object.fromEntries([...DOC_CHECK_STATUSES, ...RETIRED_DOC_CHECK_STATUSES].map(s => [s.value, s.label]))
export const DOC_CHECK_STATUS_CLASS = Object.fromEntries([...DOC_CHECK_STATUSES, ...RETIRED_DOC_CHECK_STATUSES].map(s => [s.value, s.className]))

// Статусы, доступные в базе: без колонок 20261113 — прежние семь (сейчас список один и тот же).
export function availableStatuses(hasBoardFields) {
  return DOC_CHECK_STATUSES.filter(s => hasBoardFields || !s.board)
}

// Статусы, в которых заявка считается отработанной. «Ожидаем скан» сюда НЕ
// входит: пока бумага не пришла, заявку рано убирать из работы.
export const CLOSED_DOC_CHECK_STATUSES = new Set(['done'])

export function boardColumns(hasBoardFields) {
  return availableStatuses(hasBoardFields).map(s => ({ ...s, kind: 'status' }))
}

// Колонка для статуса вне справочника (убранный или после ручной правки в базе): не теряем заявку, но и не принимаем в неё.
export function extraColumn(value) {
  return { value, label: DOC_CHECK_STATUS_LABEL[value] || value, className: DOC_CHECK_STATUS_CLASS[value] || '', kind: 'extra' }
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

// Список текстов: без лишних пробелов, без повторов (без учёта регистра), с пределом длины и числа.
function uniqueTexts(list, limit, maxLength) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

// Метки: не длиннее 60 знаков, не больше 12 — как ограничение в базе.
export const MAX_LABELS = 12
export function normalizeLabels(list) {
  return uniqueTexts(list, MAX_LABELS, 60)
}

// Подсказки меток — то, чем уже пользуются: частые первыми.
export function labelSuggestions(requests) {
  const counts = new Map()
  for (const request of requests || []) {
    for (const text of request.labels || []) {
      const key = text.toLowerCase()
      const cur = counts.get(key)
      counts.set(key, { text: cur?.text || text, n: (cur?.n || 0) + 1 })
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.text.localeCompare(b.text, 'ru'))
    .map(x => x.text)
}

// Исполнитель заявки — только действующий юрист ОСП (решение пользователя 05.11.2026). Заблокированных в справочнике
// сотрудников нет: там только подтверждённые учётки, а блокировка снимает подтверждение (ограничение в user_roles).
// Поэтому всё считается по справочнику: уволили юриста или сменили ему роль — со всех карточек он пропадает сам.
// Кто стоял исполнителем раньше (другие сотрудники, колонка manual_assignees с прежней доски), остаётся в базе, но не
// показывается и не считается исполнителем.
const isAssigneeStaff = (employee) => employee?.role === ROLES.LAWYER

export function shownAssigneeIds(request, employees) {
  return (request?.assignee_ids || []).filter(id => isAssigneeStaff(employees?.get(id)))
}

// Кого можно выбрать: варианты для выпадающего списка, по алфавиту.
export function assigneeStaffOptions(employees) {
  return [...(employees?.values() || [])]
    .filter(isAssigneeStaff)
    .map(e => ({ value: e.user_id, label: e.display_name || e.full_name || e.email || 'Без имени' }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

// Что записать после формы: выбранные плюс те, кого форма не показывала. Правка заявки не должна менять то, чего человек
// не видел: и прежних исполнителей, и всех сразу, если справочник не загрузился. Порядок прежний: иначе в истории заявки
// появлялась бы смена исполнителей, которой не было.
export function assigneeIdsToSave(prevIds, selected, employees) {
  const chosen = new Set(selected)
  const kept = (prevIds || []).filter(id => chosen.has(id) || !isAssigneeStaff(employees?.get(id)))
  return [...kept, ...selected.filter(id => !kept.includes(id))]
}

// Фильтр «Исполнитель»: «Без исполнителя» — когда на карточке нет ни одного.
export const NO_ASSIGNEE = '__none'
export function matchesAssignees(request, selected, employees) {
  if (!selected?.length) return true
  const ids = shownAssigneeIds(request, employees)
  return selected.some(a => (a === NO_ASSIGNEE ? ids.length === 0 : ids.includes(a)))
}

// Обсуждение и шаги заявки (миграция 20261124). Пределы — как ограничения в базе.
export const MAX_COMMENT_LENGTH = 4000
export const MAX_STEP_TITLE = 500
// Поле «Добавить шаг» → шаги: каждая строка — отдельный шаг, как в чек-листе задачи.
export function stepTitles(text) {
  return splitChecklistLines(text).map(title => title.slice(0, MAX_STEP_TITLE))
}
export function compareSteps(a, b) {
  return (a.sort_order - b.sort_order)
    || String(a.created_at).localeCompare(String(b.created_at))
    || String(a.id).localeCompare(String(b.id))
}

// Счётчики на карточке доски: заявка → шагов всего, сделано, сообщений.
export const NO_CARD_COUNTS = { stepsTotal: 0, stepsDone: 0, commentsCount: 0 }
export function cardCountsById(steps, comments) {
  const map = new Map()
  const entry = (id) => {
    if (!map.has(id)) map.set(id, { ...NO_CARD_COUNTS })
    return map.get(id)
  }
  for (const s of steps || []) {
    const e = entry(s.request_id)
    e.stepsTotal += 1
    if (s.is_done) e.stepsDone += 1
  }
  for (const c of comments || []) entry(c.request_id).commentsCount += 1
  return map
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

// «23.10» — когда заявку добавили, на карточке доски: без года (полная дата — в подсказке).
export function createdShort(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

export const fmtDocDateTime = (value) => (value ? new Date(value).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '')

// Значение поля datetime-local: время браузера, как и на экране.
export function toDateTimeInput(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// Дата создания и автор заявки — правка администратора (решение пользователя 05.11.2026; в базе —
// триггер doc_check_requests_created_guard). В запись идёт только изменённое: поле показывает время до минуты, и
// неизменённая дата не должна терять секунды и появляться в истории заявки.
export const MAX_CREATOR_NAME = 200
export function createdFieldsPatch(request, createdAtInput, creatorInput, now = Date.now()) {
  const patch = {}
  if (createdAtInput !== toDateTimeInput(request?.created_at)) {
    const at = new Date(createdAtInput)
    if (!createdAtInput || Number.isNaN(at.getTime())) return { error: 'Укажите дату создания заявки' }
    if (at.getTime() > now) return { error: 'Дата создания не может быть позже текущего времени' }
    patch.created_at = at.toISOString()
  }
  const name = String(creatorInput ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CREATOR_NAME) || null
  if (name !== (request?.created_by_name || null)) patch.created_by_name = name
  return { patch }
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

// Порядок карточек внутри колонки доски — новые сверху (решение пользователя 05.11.2026): больший sort_order выше, при
// равенстве — та, что добавлена позже. Сверху вниз номера убывают: новая карточка берёт следующий номер (nextSortOrder) и
// сама встаёт наверх, а прежние данные менять не нужно.
export function compareForBoard(a, b) {
  if (a.sort_order !== b.sort_order) return b.sort_order - a.sort_order
  return new Date(b.created_at) - new Date(a.created_at)
}

// По дате добавления — порядок колонки «Новые» / «Старые» (кнопка в шапке колонки).
export function compareNewestFirst(a, b) {
  return (new Date(b.created_at) - new Date(a.created_at)) || (b.sort_order - a.sort_order)
}
export function compareOldestFirst(a, b) {
  return (new Date(a.created_at) - new Date(b.created_at)) || (a.sort_order - b.sort_order)
}

// Порядок карточек колонки — кнопка в шапке колонки, нажатие переключает по кругу (06.11.2026, просьба пользователя):
// свой порядок → новые сверху → старые сверху → свой порядок. «Свой» — как расставили мышью (sort_order в базе), поэтому
// переживает обновление страницы и не теряется, пока колонка показана по дате: по дате только сортируется показ, в базу
// ничего не пишется. Дата — добавления заявки (created_at), та, что на карточке. Выбор — у каждой колонки свой, в браузере.
export const COLUMN_SORTS = {
  manual: { label: 'Свой порядок', short: '', compare: compareForBoard },
  newest: { label: 'Новые сверху', short: 'Новые', compare: compareNewestFirst },
  oldest: { label: 'Старые сверху', short: 'Старые', compare: compareOldestFirst },
}
const sortCycle = () => ['manual', 'newest', 'oldest']

// Порядок колонки по сохранённому выбору: нет выбора или он колонке не подходит — по умолчанию.
export function columnSortOf(sorts, column) {
  const cycle = sortCycle(column)
  return cycle.includes(sorts?.[column]) ? sorts[column] : cycle[0]
}
export function nextColumnSort(sorts, column) {
  const cycle = sortCycle(column)
  return cycle[(cycle.indexOf(columnSortOf(sorts, column)) + 1) % cycle.length]
}
// Сохранённый выбор из браузера: только известные значения; порядок по умолчанию не хранится.
export function normalizeColumnSorts(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [column, mode] of Object.entries(raw)) {
    if (sortCycle(column).includes(mode) && mode !== sortCycle(column)[0]) out[column] = mode
  }
  return out
}
export function withColumnSort(sorts, column, mode) {
  const next = { ...sorts }
  if (mode === sortCycle(column)[0]) delete next[column]
  else next[column] = mode
  return next
}

// Куда встанет карточка в колонке, показанной по дате: перед первой, что должна идти после неё (null — в конец). list — колонка
// в порядке показа; сама карточка в ней может быть — её пропускаем.
export function datePlaceBefore(list, request, compare) {
  return list.find(r => r.id !== request.id && compare(request, r) < 0)?.id ?? null
}

// Место карточки в колонке: её номер и какие соседи сдвигаются. rows — вся колонка в порядке доски, без самой карточки,
// вместе с теми, кого сейчас скрывает фильтр (иначе новые номера совпали бы с номерами скрытых, и порядок рассыпался бы);
// beforeId — перед какой встать, null — в конец. Соседей трогаем, только если между ними нет места, и с той стороны, где
// сдвигать меньше: бросок к верху «Завершено» (сотни карточек) — несколько записей, а не сотни. Сверху вниз номера убывают;
// могут быть отрицательными и повторяться (при равных порядок задаёт дата создания).
export function placeInColumn(rows, beforeId) {
  const found = beforeId ? rows.findIndex(r => r.id === beforeId) : -1
  const at = found >= 0 ? found : rows.length
  const above = rows[at - 1]
  const below = rows[at]
  if (!above && !below) return { sortOrder: 1, shifted: [] }
  if (!below) return { sortOrder: above.sort_order - 1, shifted: [] }
  if (!above) return { sortOrder: below.sort_order + 1, shifted: [] }
  if (above.sort_order - below.sort_order > 1) return { sortOrder: above.sort_order - 1, shifted: [] }

  const down = []
  let cur = above.sort_order - 1
  for (let i = at; i < rows.length && rows[i].sort_order >= cur; i++) {
    cur -= 1
    down.push({ id: rows[i].id, sort_order: cur })
  }
  const up = []
  cur = below.sort_order + 1
  for (let i = at - 1; i >= 0 && rows[i].sort_order <= cur; i--) {
    cur += 1
    up.push({ id: rows[i].id, sort_order: cur })
  }
  return down.length <= up.length
    ? { sortOrder: above.sort_order - 1, shifted: down }
    : { sortOrder: below.sort_order + 1, shifted: up }
}

// Верх колонки: номер для новой карточки и для той, что перешла сюда из другой колонки не перетаскиванием.
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
// Поля карточки (миграция 20261124): та же миграция заводит обсуждение и шаги, поэтому их колонки — признак всего набора.
export const CARD_FIELDS = ['email_link']
// Что читать — от полного набора к прежнему: первая выборка, на которую база ответила без 42703.
export const DOC_CHECK_SELECTS = [
  { board: true, card: true, select: `${BASE_SELECT}, ${BOARD_FIELDS.join(', ')}, ${CARD_FIELDS.join(', ')}${EMBED}` },
  { board: true, card: false, select: `${BASE_SELECT}, ${BOARD_FIELDS.join(', ')}${EMBED}` },
  { board: false, card: false, select: `${BASE_SELECT}${EMBED}` },
]

// Колонок ещё нет: PostgREST отвечает 42703 (или PGRST204 на записи).
export function isMissingBoardColumn(err) {
  return ['42703', 'PGRST204'].includes(String(err?.code || ''))
}

// Строка из базы — к виду доски: массивы вместо NULL (прежняя база их не отдаёт).
export function normalizeRequest(r) {
  return { ...r, assignee_ids: r.assignee_ids || [], labels: r.labels || [] }
}

// Заявки с числом файлов, шагов и сообщений. Заявка, у которой числа прежние, остаётся тем же объектом (cache — WeakMap
// на время жизни страницы): карточка доски сравнивает его и не перерисовывается. На доске сотни карточек, а меняется одна.
export function mergeRequestCounts(requests, docCounts, cardCounts, cache) {
  return requests.map((r) => {
    const docsCount = docCounts.get(r.id) || 0
    const counts = cardCounts.get(r.id) || NO_CARD_COUNTS
    const hit = cache.get(r)
    if (hit && hit.docsCount === docsCount && hit.stepsTotal === counts.stepsTotal
      && hit.stepsDone === counts.stepsDone && hit.commentsCount === counts.commentsCount) return hit
    const row = { ...r, docsCount, ...counts }
    cache.set(r, row)
    return row
  })
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
  manual_assignees: 'Исполнители без учётной записи',
  email_link: 'Ссылка на письмо',
  due_date: 'Срок',
  priority: 'Приоритет',
  color: 'Цвет',
  labels: 'Метки',
  archived_at: 'Архив',
  created_at: 'Дата создания',
  created_by_name: 'Кто создал',
}

// Поле изменилось? Массивы (исполнители, метки) — по составу и порядку.
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || [])
  return (a ?? null) === (b ?? null)
}
