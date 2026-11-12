// Статистика «Заявок на проверку ДП/ДС»: «Отчёты → Договоры → Проверка ДП/ДС» (12.11.2026, просьба пользователя).
//
// Строка — заявка (doc_check_requests) с объектом и контрагентом. Удалённые (deleted_at) — только счётчиком «в «Удалённых»»;
// заявки в архиве (archived_at, только из «Завершено») — обычные завершённые.
//
// Этапы — колонки доски (DOC_CHECK_STATUSES). Отработанной заявка считается только в «Завершено» (CLOSED_DOC_CHECK_STATUSES):
// «Ожидаем скан» стоит после «Завершено», но пока бумажный оригинал не вернулся, заявка открыта — так же считает доска и
// срок на карточке. «У отдела в работе» — открытые без «Ожидаем скан».
//
// События во времени — журнал заявки (doc_check_request_audit_log, event_type = status_changed, пишет страница при переносе):
//  • создана — created_at;
//  • взята в работу — первая смена статуса не на «Новые заявки»;
//  • завершена — последний перенос в «Завершено» у заявки, которая и сейчас там. Заявка «Завершено» без такой записи
//    (перенесли до журнала, загрузили с прежней доски) в «завершено за период» не входит, но в «Завершено сейчас» — да.
//
// Исполнители — только действующие юристы ОСП (shownAssigneeIds, решение пользователя 05.11.2026), как на доске. У заявки их
// бывает несколько — в разрезе по исполнителям она у каждого.
//
// Периоды и столбцы графика — как в статистике КП и заявок на ДС (utils/kpStats.js).
import { CLOSED_DOC_CHECK_STATUSES, DOC_CHECK_STATUSES, shownAssigneeIds } from './docCheckHelpers.js'
import { KP_PERIODS, bucketStart, makeBuckets, median, periodStarts } from './kpStats.js'

export const DOC_CHECK_STAT_STATUSES = DOC_CHECK_STATUSES.map(s => s.value)
export const DOC_CHECK_SCAN = 'awaiting_scan'
// Срок ближе этого числа дней — «скоро срок».
export const DOC_CHECK_DUE_SOON_DAYS = 7
// В «Новых заявках» дольше этого числа дней — «не взята в работу».
export const DOC_CHECK_NEW_STALE_DAYS = 3
// Ждём бумажный оригинал дольше этого числа дней — «скан не вернулся».
export const DOC_CHECK_SCAN_STALE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

const time = (iso) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}
const jsonText = (v) => (v == null ? null : typeof v === 'string' ? v : String(v))
const text = (v) => String(v ?? '').trim()
// Дата «ГГГГ-ММ-ДД» как местная полночь (срок хранится датой без времени).
const localDay = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null
}

/** По журналу смен статуса: Map<id заявки, { taken, done, last }> — взята в работу, последнее завершение, последняя смена (мс). */
export function docCheckStatusTimes(statusEvents) {
  const out = new Map()
  for (const e of statusEvents || []) {
    const t = time(e.changed_at)
    const status = jsonText(e.new_value)
    if (t == null || !status) continue
    const cur = out.get(e.request_id) || { taken: null, done: null, last: null }
    if (status !== 'new' && (cur.taken == null || t < cur.taken)) cur.taken = t
    if (status === 'done' && (cur.done == null || t > cur.done)) cur.done = t
    if (cur.last == null || t > cur.last) cur.last = t
    out.set(e.request_id, cur)
  }
  return out
}

/** Отбор по фильтрам отчёта: отдел (статус объекта), объект, исполнитель, вид документа. Удалённые остаются — их только считаем. */
export function filterDocCheckRequests(rows, { dept = 'all', objectId = 'all', assignee = 'all', docType = 'all' } = {}, employees = new Map()) {
  return (rows || []).filter(r => {
    if (dept !== 'all' && r.objects?.status !== dept) return false
    if (objectId !== 'all' && (r.object_id || '_none') !== objectId) return false
    if (docType !== 'all' && r.doc_type !== docType) return false
    if (assignee !== 'all') {
      const ids = shownAssigneeIds(r, employees)
      if (assignee === '_none' ? ids.length > 0 : !ids.includes(assignee)) return false
    }
    return true
  })
}

const employeeName = (employees, id) => {
  const e = employees?.get(id)
  return e?.display_name || e?.full_name || e?.email || 'Сотрудник'
}

/** Списки фильтров — из самих заявок: объекты и исполнители, которые встречаются. */
export function docCheckFilterOptions(rows, employees = new Map()) {
  const objects = new Map()
  const people = new Map()
  let noObject = false
  let noAssignee = false
  for (const r of rows || []) {
    if (r.deleted_at) continue
    if (r.object_id) objects.set(r.object_id, r.objects?.name || 'Объект')
    else noObject = true
    const ids = shownAssigneeIds(r, employees)
    if (!ids.length) noAssignee = true
    for (const id of ids) people.set(id, employeeName(employees, id))
  }
  const sort = (m) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return {
    objects: [...sort(objects), ...(noObject ? [{ id: '_none', name: 'Объект не указан' }] : [])],
    people: [...sort(people), ...(noAssignee ? [{ id: '_none', name: 'Без исполнителя' }] : [])],
  }
}

const emptyGroup = (id, name) => ({
  id, name, total: 0, open: 0, overdue: 0, dp: 0, ds: 0, other: 0,
  ...Object.fromEntries(DOC_CHECK_STAT_STATUSES.map(s => [s, 0])),
})
const byTotal = (a, b) => (b.total - a.total) || a.name.localeCompare(b.name, 'ru')
const noneLast = (list) => [...list.filter(g => g.id !== '_none').sort(byTotal), ...list.filter(g => g.id === '_none')]

/**
 * Статистика по заявкам (уже отобранным фильтрами).
 * @param rows заявки, в т.ч. удалённые (их только считаем)
 * @param times Map из docCheckStatusTimes
 * @param employees Map<user_id, сотрудник> — справочник (исполнители)
 */
export function computeDocCheckStats(rows, times = new Map(), employees = new Map(), now = new Date()) {
  const nowT = now.getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const starts = periodStarts(now)
  const inPeriod = (t, p) => t != null && (p === 'all' || t >= starts[p].getTime())

  const all = rows || []
  const live = all.filter(r => !r.deleted_at)

  const byStatus = { ...Object.fromEntries(DOC_CHECK_STAT_STATUSES.map(s => [s, 0])), other: 0 }
  const byType = { dp: 0, ds: 0 }
  const deadlines = { overdue: 0, dueSoon: 0, noDeadline: 0, overdueList: [] }
  const attention = { unassigned: 0, highPriority: 0, staleNew: 0, oldestNewDays: null, staleScan: 0 }
  let archived = 0
  const objects = new Map()
  const people = new Map()
  const counterparties = new Map()
  const matrix = Object.fromEntries(['created', 'createdDp', 'createdDs', 'taken', 'completed']
    .map(k => [k, Object.fromEntries(KP_PERIODS.map(p => [p, 0]))]))
  const takeDurations = []
  const doneDurations = []

  for (const r of live) {
    const known = DOC_CHECK_STAT_STATUSES.includes(r.status)
    const status = known ? r.status : 'other'
    byStatus[status] += 1
    if (byType[r.doc_type] != null) byType[r.doc_type] += 1
    if (r.archived_at) archived += 1
    const isOpen = !CLOSED_DOC_CHECK_STATUSES.has(r.status)
    const ev = times.get(r.id) || { taken: null, done: null, last: null }
    const created = time(r.created_at)
    const since = ev.last ?? created
    const days = since == null ? null : Math.max(0, Math.floor((nowT - since) / DAY_MS))

    // Срок — как на карточке доски: прошёл, а заявка не в «Завершено».
    const due = localDay(r.due_date)
    const overdue = isOpen && due != null && due < today
    if (isOpen) {
      if (due == null) deadlines.noDeadline += 1
      else if (overdue) deadlines.overdue += 1
      else if (due - today <= DOC_CHECK_DUE_SOON_DAYS * DAY_MS) deadlines.dueSoon += 1
    }
    const assignees = shownAssigneeIds(r, employees)
    if (overdue) {
      deadlines.overdueList.push({
        id: r.id,
        number: r.request_number ?? null,
        object: r.objects?.name || '',
        counterparty: r.counterparties?.name || '',
        docType: r.doc_type,
        docNumber: text(r.doc_number),
        assignees: assignees.map(id => employeeName(employees, id)),
        status: r.status,
        due: r.due_date,
        days: Math.round((today - due) / DAY_MS),
      })
    }
    if (isOpen) {
      if (!assignees.length) attention.unassigned += 1
      if (r.priority === 'high') attention.highPriority += 1
      if (r.status === 'new' && days != null) {
        if (days >= DOC_CHECK_NEW_STALE_DAYS) attention.staleNew += 1
        attention.oldestNewDays = Math.max(attention.oldestNewDays ?? 0, days)
      }
      if (r.status === DOC_CHECK_SCAN && days != null && days >= DOC_CHECK_SCAN_STALE_DAYS) attention.staleScan += 1
    }

    const add = (map, id, name) => {
      if (!map.has(id)) map.set(id, emptyGroup(id, name))
      const g = map.get(id)
      g.total += 1
      g[status] += 1
      if (isOpen) g.open += 1
      if (overdue) g.overdue += 1
      if (r.doc_type === 'dp' || r.doc_type === 'ds') g[r.doc_type] += 1
    }
    add(objects, r.object_id || '_none', r.object_id ? (r.objects?.name || 'Объект') : 'Объект не указан')
    add(counterparties, r.counterparty_id || '_none', r.counterparty_id ? (r.counterparties?.name || 'Контрагент') : 'Не указан')
    if (assignees.length) for (const id of assignees) add(people, id, employeeName(employees, id))
    else add(people, '_none', 'Без исполнителя')

    const done = r.status === 'done' ? ev.done : null
    const taken = ev.taken != null && created != null && ev.taken >= created ? ev.taken : null
    for (const p of KP_PERIODS) {
      if (inPeriod(created, p)) {
        matrix.created[p] += 1
        if (r.doc_type === 'dp') matrix.createdDp[p] += 1
        if (r.doc_type === 'ds') matrix.createdDs[p] += 1
      }
      if (inPeriod(taken, p)) matrix.taken[p] += 1
      if (inPeriod(done, p)) matrix.completed[p] += 1
    }
    if (taken != null) takeDurations.push(taken - created)
    if (created != null && done != null && done >= created) doneDurations.push(done - created)
  }

  deadlines.overdueList.sort((a, b) => b.days - a.days || a.object.localeCompare(b.object, 'ru'))
  const open = live.length - byStatus.done

  return {
    total: live.length,
    deleted: all.length - live.length,
    archived,
    byStatus,
    byType,
    open,
    // У отдела в работе: открытые, кроме ждущих бумажный оригинал.
    inWork: open - byStatus[DOC_CHECK_SCAN],
    deadlines,
    attention,
    durations: {
      takeMedianMs: median(takeDurations),
      takeCount: takeDurations.length,
      doneMedianMs: median(doneDurations),
      doneCount: doneDurations.length,
    },
    matrix,
    byObject: noneLast([...objects.values()]),
    byAssignee: noneLast([...people.values()]),
    byCounterparty: noneLast([...counterparties.values()]),
  }
}

/** Динамика: создано и завершено по дням (14), неделям (12) или месяцам (12). */
export function buildDocCheckDynamics(rows, times = new Map(), granularity = 'month', now = new Date()) {
  const { granularity: g, buckets } = makeBuckets(granularity, now, ['created', 'completed'])
  const idx = new Map(buckets.map((b, i) => [b.key, i]))
  const put = (t, field) => {
    if (t == null) return
    const i = idx.get(bucketStart(t, g).getTime())
    if (i != null) buckets[i][field] += 1
  }
  for (const r of rows || []) {
    if (r.deleted_at) continue
    put(time(r.created_at), 'created')
    if (r.status === 'done') put(times.get(r.id)?.done ?? null, 'completed')
  }
  return buckets
}
