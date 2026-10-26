// Статистика «Заявок на ДС»: «Отчёты → Заявки на ДС».
//
// Строка — заявка (dc_requests) с объектом, контрагентом, ответственным и задачами. Удалённые (deleted_at)
// в статистику не входят — только счётчиком «в корзине». Суммы — «Было подано» (amount_before) и
// «Утверждено» (amount_after), в рублях с НДС, как в реестре.
//
// События во времени:
//  • создана — created_at;
//  • проверена по договору — checked_at (ставит окно «Результат проверки», миграция 20260912);
//  • завершена — последняя смена статуса на «Завершено» в журнале (dc_request_audit_log, status_changed).
//    Заявка «Завершено» без такой записи (журнала тогда ещё не было) в число завершённых за период не
//    входит, но в «Завершено сейчас» — да.
//
// Периоды — как в статистике КП: «сегодня» с полуночи, «неделя» с понедельника, «месяц» с 1-го числа,
// по местному времени браузера; у столбцов графика те же границы.
import { DS_TYPE_LABEL, DS_TYPE_OPTIONS, MATERIAL_LABEL, MATERIAL_OPTIONS, STATUS_OPTIONS } from './dcRequestOptions.js'
import { KP_PERIODS, bucketStart, makeBuckets, median, periodStarts } from './kpStats.js'

export const DC_STATUSES = STATUS_OPTIONS.map(o => o.value)
// Срок утверждения ближе этого числа дней — «скоро срок».
export const DC_DUE_SOON_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

const time = (iso) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}
const amount = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const jsonText = (v) => (v == null ? null : typeof v === 'string' ? v : String(v))

// Дата «ГГГГ-ММ-ДД» как местная полночь (срок утверждения хранится датой без времени).
const localDay = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null
}

/** Когда заявка в последний раз переведена в «Завершено»: Map<id заявки, мс>. */
export function completionTimes(statusEvents) {
  const out = new Map()
  for (const e of statusEvents || []) {
    if (jsonText(e.new_value) !== 'completed') continue
    const t = time(e.changed_at)
    if (t == null) continue
    const prev = out.get(e.dc_request_id)
    if (prev == null || t > prev) out.set(e.dc_request_id, t)
  }
  return out
}

/** Отбор по фильтрам отчёта: отдел (статус объекта), объект, ответственный, тип ДС. */
export function filterDcRequests(rows, { dept = 'all', objectId = 'all', respId = 'all', dsType = 'all' } = {}) {
  return (rows || []).filter(r => {
    if (dept !== 'all' && r.objects?.status !== dept) return false
    if (objectId !== 'all' && r.object_id !== objectId) return false
    if (respId !== 'all' && (r.responsible_contact_id || '_unassigned') !== respId) return false
    if (dsType !== 'all' && (r.ds_type || '_none') !== dsType) return false
    return true
  })
}

const emptyGroup = (id, name) => ({
  id, name, total: 0, contract_check: 0, check_result: 0, in_work: 0, completed: 0,
  overdue: 0, submitted: 0, approved: 0,
})

function addToGroup(g, r, overdue) {
  g.total += 1
  if (g[r.status] != null) g[r.status] += 1
  if (overdue) g.overdue += 1
  g.submitted += amount(r.amount_before) || 0
  g.approved += amount(r.amount_after) || 0
}

const byTotal = (a, b) => (b.total - a.total) || a.name.localeCompare(b.name, 'ru')

/**
 * Статистика по заявкам (уже отобранным фильтрами).
 * @param rows заявки, в т.ч. удалённые (их только считаем)
 * @param completed Map<id, мс> из completionTimes
 */
export function computeDcStats(rows, completed = new Map(), now = new Date()) {
  const nowT = now.getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const starts = periodStarts(now)
  const inPeriod = (t, p) => t != null && (p === 'all' || t >= starts[p].getTime())

  const all = rows || []
  const live = all.filter(r => !r.deleted_at)
  const deleted = all.length - live.length

  const byStatus = Object.fromEntries(DC_STATUSES.map(s => [s, 0]))
  const verdicts = { matches: 0, matches_with_remarks: 0, not_matches: 0, not_checked: 0 }
  const amounts = { submitted: 0, approved: 0, withBoth: 0, bothBefore: 0, bothAfter: 0, withoutAmount: 0 }
  const deadlines = { overdue: 0, dueSoon: 0, noDeadline: 0, overdueList: [] }
  const tasks = { total: 0, done: 0, requestsWithOpen: 0 }
  const objects = new Map()
  const people = new Map()
  const counterparties = new Map()
  const dsTypes = new Map()
  const materials = new Map()

  const matrix = Object.fromEntries(['created', 'checked', 'checkedOk', 'checkedRemarks', 'checkedBad', 'completed',
    'submitted', 'approved'].map(k => [k, Object.fromEntries(KP_PERIODS.map(p => [p, 0]))]))
  const checkDurations = []
  const completeDurations = []

  for (const r of live) {
    const status = DC_STATUSES.includes(r.status) ? r.status : 'in_work'
    byStatus[status] += 1
    const isDone = status === 'completed'
    verdicts[r.check_status && verdicts[r.check_status] != null ? r.check_status : 'not_checked'] += 1

    const before = amount(r.amount_before)
    const after = amount(r.amount_after)
    if (before != null) amounts.submitted += before
    if (after != null) amounts.approved += after
    if (before != null && after != null) {
      amounts.withBoth += 1
      amounts.bothBefore += before
      amounts.bothAfter += after
    }
    if (before == null && after == null) amounts.withoutAmount += 1

    const due = localDay(r.expected_approval_date)
    const overdue = !isDone && due != null && due < today
    if (!isDone) {
      if (due == null) deadlines.noDeadline += 1
      else if (overdue) {
        deadlines.overdue += 1
        deadlines.overdueList.push({
          id: r.id,
          object: r.objects?.name || '—',
          counterparty: r.counterparties?.name || '—',
          dsNumber: r.ds_number || '',
          responsible: r.responsible?.full_name || 'Не назначен',
          status,
          due: r.expected_approval_date,
          days: Math.round((today - due) / DAY_MS),
        })
      } else if (due - today <= DC_DUE_SOON_DAYS * DAY_MS) deadlines.dueSoon += 1
    }

    const list = r.dc_request_tasks || []
    const open = list.filter(t => !t.is_completed).length
    tasks.total += list.length
    tasks.done += list.length - open
    if (open > 0 && !isDone) tasks.requestsWithOpen += 1

    const row = { ...r, status }
    const group = (map, id, name) => {
      if (!map.has(id)) map.set(id, emptyGroup(id, name))
      addToGroup(map.get(id), row, overdue)
    }
    group(objects, r.object_id || '_none', r.objects?.name || 'Без объекта')
    group(people, r.responsible_contact_id || '_unassigned', r.responsible?.full_name || 'Не назначен')
    group(counterparties, r.counterparty_id || '_none', r.counterparties?.name || 'Не указан')
    group(dsTypes, r.ds_type || '_none', r.ds_type ? (DS_TYPE_LABEL[r.ds_type] || r.ds_type) : 'Не указан')
    group(materials, r.material_type || '_none', r.material_type ? (MATERIAL_LABEL[r.material_type] || r.material_type) : 'Не указан')

    // События во времени.
    const created = time(r.created_at)
    const checked = r.check_status && r.check_status !== 'not_checked' ? time(r.checked_at) : null
    const done = isDone ? (completed.get(r.id) ?? null) : null
    for (const p of KP_PERIODS) {
      if (inPeriod(created, p)) {
        matrix.created[p] += 1
        matrix.submitted[p] += before || 0
      }
      if (inPeriod(checked, p)) {
        matrix.checked[p] += 1
        if (r.check_status === 'matches') matrix.checkedOk[p] += 1
        else if (r.check_status === 'matches_with_remarks') matrix.checkedRemarks[p] += 1
        else if (r.check_status === 'not_matches') matrix.checkedBad[p] += 1
      }
      if (inPeriod(done, p)) {
        matrix.completed[p] += 1
        matrix.approved[p] += after || 0
      }
    }
    if (created != null && checked != null && checked >= created) checkDurations.push(checked - created)
    if (created != null && done != null && done >= created) completeDurations.push(done - created)
  }

  deadlines.overdueList.sort((a, b) => b.days - a.days || a.object.localeCompare(b.object, 'ru'))

  // Справочники — в своём порядке, «Не указан» — в конце; пустые строки не показываем.
  const ordered = (map, options) => [
    ...options.map(o => map.get(o.value)).filter(Boolean),
    ...[...map.values()].filter(g => g.id !== '_none' && !options.some(o => o.value === g.id)),
    ...(map.has('_none') ? [map.get('_none')] : []),
  ]
  const unassignedLast = (list, key) => [...list.filter(g => g.id !== key).sort(byTotal), ...list.filter(g => g.id === key)]

  return {
    total: live.length,
    deleted,
    byStatus,
    active: live.length - byStatus.completed,
    verdicts,
    amounts: {
      ...amounts,
      diff: amounts.bothAfter - amounts.bothBefore,
      diffPct: amounts.bothBefore ? ((amounts.bothAfter - amounts.bothBefore) / amounts.bothBefore) * 100 : null,
    },
    deadlines,
    tasks,
    durations: {
      checkMedianMs: median(checkDurations),
      completeMedianMs: median(completeDurations),
      checkCount: checkDurations.length,
      completeCount: completeDurations.length,
    },
    matrix,
    byObject: unassignedLast([...objects.values()], '_none'),
    byResponsible: unassignedLast([...people.values()], '_unassigned'),
    byCounterparty: unassignedLast([...counterparties.values()], '_none'),
    byDsType: ordered(dsTypes, DS_TYPE_OPTIONS),
    byMaterial: ordered(materials, MATERIAL_OPTIONS),
    oldestActiveMs: live
      .filter(r => r.status !== 'completed')
      .reduce((max, r) => {
        const t = time(r.created_at)
        return t == null ? max : Math.max(max ?? 0, nowT - t)
      }, null),
  }
}

/** Динамика: создано и завершено по дням (14), неделям (12) или месяцам (12). */
export function buildDcDynamics(rows, completed = new Map(), granularity = 'month', now = new Date()) {
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
    if (r.status === 'completed') put(completed.get(r.id) ?? null, 'completed')
  }
  return buckets
}
