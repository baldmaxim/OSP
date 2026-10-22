// Статистика по коммерческим предложениям: «Отчёты → Тендеры → Коммерческие предложения».
//
// Строка — файл КП (tender_proposal_files, file_kind='commercial_proposal'). Каждая
// загрузка считается отдельно, в том числе новая версия того же КП (со скидкой,
// исправленное): версия — файл с тем же proposal_group_id, загруженный не первым.
//
// Проверка аналитиком есть только у КП с review_required — загруженных после запуска
// «Проверки КП» (миграция 20260802). Прежние КП входят в загрузку, но не в проверку.
// Этап проверки — stageOf из kpReviewStages, как на странице «Проверка КП».
//
// Периоды календарные, по местному времени браузера (как в «Работе инженеров»):
// «сегодня» — с полуночи, «неделя» — с понедельника, «месяц» — с 1-го числа. У
// столбцов графика те же границы, поэтому последний столбец графика совпадает с
// числом в таблице.
import { stageOf } from './kpReviewStages.js'

export const KP_PERIODS = ['today', 'week', 'month', 'all']

// КП на проверке дольше этого числа суток — «ждут долго».
export const KP_STALE_DAYS = 2

const DAY_MS = 24 * 60 * 60 * 1000
const pad = (n) => String(n).padStart(2, '0')

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const startOfWeek = (d) => {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1)

// Начала периодов; у «всего» начала нет.
export function periodStarts(now = new Date()) {
  return { today: startOfDay(now), week: startOfWeek(now), month: startOfMonth(now), all: null }
}

const time = (iso) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

// Медиана; пусто — null.
function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// «35 мин», «5 ч», «1,5 дн.» — длительность для таблиц.
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const min = Math.max(0, ms) / 60000
  if (min < 60) return `${Math.max(1, Math.round(min))} мин`
  const h = min / 60
  if (h < 24) return `${Math.round(h)} ч`
  const days = h / 24
  const text = days < 10 ? (Math.round(days * 10) / 10).toLocaleString('ru-RU') : String(Math.round(days))
  return `${text} дн.`
}

// Файлы, загруженные не первыми в своей группе версий.
function versionIds(rows) {
  const first = new Map()
  for (const r of rows) {
    const g = r.proposal_group_id
    if (!g) continue
    const cur = first.get(g)
    const t = time(r.created_at) ?? Infinity
    if (!cur || t < cur.t || (t === cur.t && String(r.id) < String(cur.id))) first.set(g, { id: r.id, t })
  }
  const ids = new Set()
  for (const r of rows) {
    const g = r.proposal_group_id
    if (g && first.get(g)?.id !== r.id) ids.add(r.id)
  }
  return ids
}

// События одной строки: когда загружено, проверено, внесено в сводную, отправлено.
// Отметки берутся только там, где шаг действительно сделан (а не осталась дата
// от снятой отметки).
function eventsOf(r) {
  const reviewed = r.review_required === true
    && (r.review_status === 'approved' || r.review_status === 'has_remarks')
    ? time(r.reviewed_at) : null
  return {
    uploaded: time(r.created_at),
    reviewed,
    summary: r.review_required === true && r.summary_added ? time(r.summary_added_at) : null,
    sent: r.review_required === true && r.remarks_sent ? time(r.remarks_sent_at) : null,
  }
}

const inPeriod = (t, start) => t != null && (start == null || t >= start.getTime())

const personName = (s) => (typeof s === 'string' && s.trim()) || 'Не указан'

function emptyCounts() {
  return Object.fromEntries(KP_PERIODS.map((p) => [p, 0]))
}

// Главный расчёт. rows — строки tender_proposal_files с полями проверки и
// s3.uploaded_by_name; now — «сейчас» (параметр — ради тестов).
export function computeKpStats(rows, now = new Date()) {
  const starts = periodStarts(now)
  const nowT = now.getTime()
  const versions = versionIds(rows)

  const matrix = {
    uploaded: emptyCounts(),
    versions: emptyCounts(),
    tenders: emptyCounts(),
    counterparties: emptyCounts(),
    reviewed: emptyCounts(),
    approved: emptyCounts(),
    remarks: emptyCounts(),
    summary: emptyCounts(),
    sent: emptyCounts(),
    reviewTime: emptyCounts(),
  }
  const tenderSets = Object.fromEntries(KP_PERIODS.map((p) => [p, new Set()]))
  const cpSets = Object.fromEntries(KP_PERIODS.map((p) => [p, new Set()]))
  const reviewDurations = Object.fromEntries(KP_PERIODS.map((p) => [p, []]))

  const uploaders = new Map()
  const reviewers = new Map()
  const stages = {}
  const queue = { pending: 0, stale: 0, oldestPendingMs: null, toSummary: 0, toSend: 0, required: 0 }

  for (const r of rows) {
    const ev = eventsOf(r)

    if (ev.uploaded != null) {
      const who = personName(r.s3?.uploaded_by_name)
      if (!uploaders.has(who)) uploaders.set(who, { name: who, ...emptyCounts() })
      const u = uploaders.get(who)
      for (const p of KP_PERIODS) {
        if (!inPeriod(ev.uploaded, starts[p])) continue
        matrix.uploaded[p] += 1
        if (versions.has(r.id)) matrix.versions[p] += 1
        if (r.tender_id) tenderSets[p].add(r.tender_id)
        if (r.counterparty_id) cpSets[p].add(r.counterparty_id)
        u[p] += 1
      }
    }

    if (ev.reviewed != null) {
      const who = personName(r.reviewed_by)
      if (!reviewers.has(who)) reviewers.set(who, { name: who, ...emptyCounts(), remarks: 0, durations: [] })
      const rv = reviewers.get(who)
      const duration = ev.uploaded != null ? Math.max(0, ev.reviewed - ev.uploaded) : null
      for (const p of KP_PERIODS) {
        if (!inPeriod(ev.reviewed, starts[p])) continue
        matrix.reviewed[p] += 1
        if (r.review_status === 'has_remarks') matrix.remarks[p] += 1
        else matrix.approved[p] += 1
        if (duration != null) reviewDurations[p].push(duration)
        rv[p] += 1
      }
      if (r.review_status === 'has_remarks') rv.remarks += 1
      if (duration != null) rv.durations.push(duration)
    }

    for (const p of KP_PERIODS) {
      if (inPeriod(ev.summary, starts[p])) matrix.summary[p] += 1
      if (inPeriod(ev.sent, starts[p])) matrix.sent[p] += 1
    }

    // Очередь — текущее состояние, без периода.
    if (r.review_required === true) {
      queue.required += 1
      const st = stageOf(r)
      stages[st] = (stages[st] || 0) + 1
      if (st === 'pending') {
        queue.pending += 1
        if (ev.uploaded != null) {
          const age = nowT - ev.uploaded
          if (age > KP_STALE_DAYS * DAY_MS) queue.stale += 1
          if (queue.oldestPendingMs == null || age > queue.oldestPendingMs) queue.oldestPendingMs = age
        }
      }
      if (st === 'ok_summary' || st === 'nosend_summary' || (st === 'remarks_work' && !r.summary_added)) queue.toSummary += 1
      if (st === 'remarks_work' && !r.remarks_sent) queue.toSend += 1
    }
  }

  for (const p of KP_PERIODS) {
    matrix.tenders[p] = tenderSets[p].size
    matrix.counterparties[p] = cpSets[p].size
    matrix.reviewTime[p] = median(reviewDurations[p])
  }

  const byActivity = (a, b) => (b.month - a.month) || (b.all - a.all) || a.name.localeCompare(b.name, 'ru')
  return {
    matrix,
    queue,
    stages,
    uploaders: [...uploaders.values()].sort(byActivity),
    reviewers: [...reviewers.values()]
      .map(({ durations, ...rv }) => ({ ...rv, medianMs: median(durations) }))
      .sort(byActivity),
  }
}

// Динамика: загружено и проверено по дням (14), неделям (12) или месяцам (12).
export const KP_GRANULARITY = {
  day: { label: 'По дням', count: 14 },
  week: { label: 'По неделям', count: 12 },
  month: { label: 'По месяцам', count: 12 },
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const ddmm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`

function bucketStart(t, granularity) {
  const d = new Date(t)
  if (granularity === 'month') return startOfMonth(d)
  if (granularity === 'week') return startOfWeek(d)
  return startOfDay(d)
}

function shiftBucket(d, granularity, n) {
  if (granularity === 'month') return new Date(d.getFullYear(), d.getMonth() + n, 1)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n * (granularity === 'week' ? 7 : 1))
}

export function buildKpDynamics(rows, granularity = 'week', now = new Date()) {
  const g = KP_GRANULARITY[granularity] ? granularity : 'week'
  const count = KP_GRANULARITY[g].count
  const last = bucketStart(now.getTime(), g)
  const buckets = []
  for (let i = count - 1; i >= 0; i--) {
    const start = shiftBucket(last, g, -i)
    const end = shiftBucket(start, g, 1)
    const label = g === 'month' ? MONTHS_SHORT[start.getMonth()] : ddmm(start)
    const title = g === 'month'
      ? `${MONTHS_SHORT[start.getMonth()]} ${start.getFullYear()}`
      : g === 'week'
        ? `${ddmm(start)}–${ddmm(new Date(end.getTime() - DAY_MS))}.${end.getFullYear()}`
        : `${ddmm(start)}.${start.getFullYear()}`
    buckets.push({ key: start.getTime(), label, title, uploaded: 0, reviewed: 0 })
  }
  const idx = new Map(buckets.map((b, i) => [b.key, i]))
  for (const r of rows) {
    const ev = eventsOf(r)
    if (ev.uploaded != null) {
      const i = idx.get(bucketStart(ev.uploaded, g).getTime())
      if (i != null) buckets[i].uploaded += 1
    }
    if (ev.reviewed != null) {
      const i = idx.get(bucketStart(ev.reviewed, g).getTime())
      if (i != null) buckets[i].reviewed += 1
    }
  }
  return buckets
}
