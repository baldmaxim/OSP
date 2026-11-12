// Статистика «Заявок на заключение ДП»: «Отчёты → Договоры → Заключение ДП» (12.11.2026, просьба пользователя).
//
// Строка — заявка (dp_requests, миграции 20261227, 20261231) с объектом. Черновики (status = draft) живут секунды, пока грузятся
// файлы, и в отчёт не читаются; удалённые (deleted_at) — только счётчиком «в «Удалённых»».
//
// Журнала смен статуса у заявки на ДП нет — есть только время последней смены (status_changed_at, ставит триггер базы):
//  • подана — created_at (черновик подаётся в ту же минуту);
//  • завершена — status_changed_at заявки в статусе «Завершена» (вернули в работу и завершили снова — последнее завершение);
//  • с какого времени заявка в своём статусе — status_changed_at, у новой — время подачи, иначе created_at.
// Поэтому «от подачи до взятия в работу» у уже завершённых не узнать: время взятия перезаписано завершением.
//
// Объект, договор, сумму и ответственного вносит тот, кто работает с заявками, частями (решение пользователя 05.11.2026):
// у незавершённой заявки пустое поле — работа отдела, она в «Требуют внимания».
//
// Периоды и столбцы графика — как в статистике КП и заявок на ДС (utils/kpStats.js): «сегодня» с полуночи, «неделя» с понедельника,
// «месяц» с 1-го числа, по местному времени браузера.
import { DP_ROLE_LABEL, DP_STATUS_OPTIONS } from './dpRequests.js'
import { KP_PERIODS, bucketStart, makeBuckets, median, periodStarts } from './kpStats.js'

export const DP_STATS_STATUSES = DP_STATUS_OPTIONS.map(o => o.value)
// Новая заявка дольше этого числа дней не взята в работу — «ждёт долго».
export const DP_NEW_STALE_DAYS = 3
// В работе дольше этого числа дней — «залежалась».
export const DP_WORK_STALE_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

const time = (iso) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}
const text = (v) => String(v ?? '').trim()
const normName = (s) => text(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
const amountOf = (r) => {
  const n = r.amount == null || r.amount === '' ? null : Number(r.amount)
  return Number.isFinite(n) ? n : null
}

// Заявка с незнакомым статусом (база без ограничения) считается «В работе»: не новая и не завершена.
const statusOf = (r) => (DP_STATS_STATUSES.includes(r.status) ? r.status : 'in_work')

/** Время завершения заявки (мс) или null. */
export const dpCompletedAt = (r) => (statusOf(r) === 'completed' ? time(r.status_changed_at) : null)

/** С какого времени заявка в своём статусе (мс). */
export const dpStageSince = (r) => time(r.status_changed_at) ?? time(r.created_at)

/** Что из полей отдела не заполнено: ['object', 'contract', 'amount', 'responsible']. */
export function dpMissingFields(r) {
  const out = []
  if (!r.object_id) out.push('object')
  if (!text(r.contract_title)) out.push('contract')
  if (amountOf(r) == null) out.push('amount')
  if (!text(r.responsible_name)) out.push('responsible')
  return out
}

// Ответственный — по ФИО (контакта может не быть: ответственный без карточки в «Контактах»), без учёта регистра и «ё».
const responsibleKey = (r) => (text(r.responsible_name) ? `n:${normName(r.responsible_name)}` : '_none')
const authorKey = (r) => (text(r.created_by_name) ? `n:${normName(r.created_by_name)}` : '_none')

/** Отбор по фильтрам отчёта: отдел (статус объекта), объект, ответственный. Удалённые остаются — их только считаем. */
export function filterDpRequests(rows, { dept = 'all', objectId = 'all', respKey = 'all' } = {}) {
  return (rows || []).filter(r => {
    if (r.status === 'draft') return false
    if (dept !== 'all' && r.objects?.status !== dept) return false
    if (objectId !== 'all' && (r.object_id || '_none') !== objectId) return false
    if (respKey !== 'all' && responsibleKey(r) !== respKey) return false
    return true
  })
}

/** Списки фильтров — из самих заявок: объекты и ответственные, которые встречаются. */
export function dpFilterOptions(rows) {
  const objects = new Map()
  const people = new Map()
  let noObject = false
  let noResp = false
  for (const r of rows || []) {
    if (r.deleted_at || r.status === 'draft') continue
    if (r.object_id) objects.set(r.object_id, r.objects?.name || 'Объект')
    else noObject = true
    const key = responsibleKey(r)
    if (key === '_none') noResp = true
    else if (!people.has(key)) people.set(key, text(r.responsible_name))
  }
  const sort = (m) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return {
    objects: [...sort(objects), ...(noObject ? [{ id: '_none', name: 'Объект не указан' }] : [])],
    people: [...sort(people), ...(noResp ? [{ id: '_none', name: 'Не указан' }] : [])],
  }
}

const emptyGroup = (id, name, extra = {}) => ({ id, name, ...extra, total: 0, new: 0, in_work: 0, completed: 0, amount: 0, stale: 0 })
const byTotal = (a, b) => (b.total - a.total) || a.name.localeCompare(b.name, 'ru')
const noneLast = (list) => [...list.filter(g => g.id !== '_none').sort(byTotal), ...list.filter(g => g.id === '_none')]

/**
 * Статистика по заявкам (уже отобранным фильтрами).
 * @param rows заявки, в т.ч. удалённые (их только считаем)
 */
export function computeDpStats(rows, now = new Date()) {
  const nowT = now.getTime()
  const starts = periodStarts(now)
  const inPeriod = (t, p) => t != null && (p === 'all' || t >= starts[p].getTime())

  const all = (rows || []).filter(r => r.status !== 'draft')
  const live = all.filter(r => !r.deleted_at)

  const byStatus = Object.fromEntries(DP_STATS_STATUSES.map(s => [s, 0]))
  const amounts = { total: 0, completed: 0, active: 0, withAmount: 0, withoutAmount: 0 }
  const missing = { requests: 0, object: 0, contract: 0, amount: 0, responsible: 0 }
  const stale = { newCount: 0, workCount: 0, oldestNewDays: null }
  const waiting = []
  const objects = new Map()
  const people = new Map()
  const authors = new Map()
  const matrix = Object.fromEntries(['created', 'completed', 'createdAmount', 'completedAmount']
    .map(k => [k, Object.fromEntries(KP_PERIODS.map(p => [p, 0]))]))
  const completeDurations = []

  for (const r of live) {
    const status = statusOf(r)
    byStatus[status] += 1
    const isDone = status === 'completed'
    const amount = amountOf(r)
    if (amount != null) {
      amounts.total += amount
      amounts.withAmount += 1
      if (isDone) amounts.completed += amount
      else amounts.active += amount
    } else amounts.withoutAmount += 1

    const since = dpStageSince(r)
    const days = since == null ? null : Math.max(0, Math.floor((nowT - since) / DAY_MS))
    const isStale = !isDone && days != null && days >= (status === 'new' ? DP_NEW_STALE_DAYS : DP_WORK_STALE_DAYS)
    if (!isDone) {
      const gaps = dpMissingFields(r)
      if (gaps.length) {
        missing.requests += 1
        for (const g of gaps) missing[g] += 1
      }
      if (status === 'new') {
        if (isStale) stale.newCount += 1
        if (days != null) stale.oldestNewDays = Math.max(stale.oldestNewDays ?? 0, days)
      } else if (isStale) stale.workCount += 1
      waiting.push({
        id: r.id,
        number: r.request_number ?? null,
        object: r.objects?.name || '',
        contract: text(r.contract_title),
        amount,
        responsible: text(r.responsible_name),
        responsibleRole: DP_ROLE_LABEL[r.responsible_role] || '',
        author: text(r.created_by_name),
        status,
        since: since == null ? null : new Date(since).toISOString(),
        days,
        stale: isStale,
        missing: gaps,
      })
    }

    const group = (map, id, name, extra) => {
      if (!map.has(id)) map.set(id, emptyGroup(id, name, extra))
      const g = map.get(id)
      g.total += 1
      g[status] += 1
      g.amount += amount || 0
      if (isStale) g.stale += 1
    }
    group(objects, r.object_id || '_none', r.object_id ? (r.objects?.name || 'Объект') : 'Объект не указан')
    group(people, responsibleKey(r), text(r.responsible_name) || 'Не указан',
      { role: DP_ROLE_LABEL[r.responsible_role] || '' })
    group(authors, authorKey(r), text(r.created_by_name) || 'Не записан')

    const created = time(r.created_at)
    const done = dpCompletedAt(r)
    for (const p of KP_PERIODS) {
      if (inPeriod(created, p)) {
        matrix.created[p] += 1
        matrix.createdAmount[p] += amount || 0
      }
      if (inPeriod(done, p)) {
        matrix.completed[p] += 1
        matrix.completedAmount[p] += amount || 0
      }
    }
    if (created != null && done != null && done >= created) completeDurations.push(done - created)
  }

  // Ждут дольше — выше; новые раньше заявок в работе при равном сроке: их ещё никто не взял.
  waiting.sort((a, b) => (b.days ?? -1) - (a.days ?? -1)
    || (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1)
    || (a.number ?? 0) - (b.number ?? 0))

  return {
    total: live.length,
    deleted: all.length - live.length,
    byStatus,
    active: live.length - byStatus.completed,
    amounts,
    missing,
    stale,
    waiting,
    durations: { completeMedianMs: median(completeDurations), completeCount: completeDurations.length },
    matrix,
    byObject: noneLast([...objects.values()]),
    byResponsible: noneLast([...people.values()]),
    byAuthor: noneLast([...authors.values()]),
  }
}

/** Динамика: подано и завершено по дням (14), неделям (12) или месяцам (12). */
export function buildDpDynamics(rows, granularity = 'month', now = new Date()) {
  const { granularity: g, buckets } = makeBuckets(granularity, now, ['created', 'completed'])
  const idx = new Map(buckets.map((b, i) => [b.key, i]))
  const put = (t, field) => {
    if (t == null) return
    const i = idx.get(bucketStart(t, g).getTime())
    if (i != null) buckets[i][field] += 1
  }
  for (const r of rows || []) {
    if (r.deleted_at || r.status === 'draft') continue
    put(time(r.created_at), 'created')
    put(dpCompletedAt(r), 'completed')
  }
  return buckets
}
