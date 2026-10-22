// «Отчёты → Тендеры → Коммерческие предложения»: расчёт статистики КП (src/utils/kpStats.js).
// Даты — в местном времени (как в отчёте), поэтому тест не зависит от часового пояса машины.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKpDynamics, computeKpStats, formatDuration, periodStarts,
} from '../../src/utils/kpStats.js'

const H = 60 * 60 * 1000
// Четверг, 22.10.2026, 15:00: неделя — с пн 19.10, месяц — с 01.10.
const NOW = new Date(2026, 9, 22, 15, 0)
const at = (month, day, hour = 10) => new Date(2026, month - 1, day, hour).toISOString()

let seq = 0
function kp(over = {}) {
  seq += 1
  return {
    id: `f${seq}`,
    tender_id: 't1',
    counterparty_id: 'c1',
    proposal_group_id: `g${seq}`,
    created_at: at(10, 22),
    review_required: true,
    review_status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    remarks_send_required: true,
    remarks_sent: false,
    remarks_sent_at: null,
    summary_added: false,
    summary_added_at: null,
    s3: { uploaded_by_name: 'Иванов И. И.' },
    tenders: { object_id: 'o1', department: 'construction' },
    ...over,
  }
}

describe('Статистика КП: периоды', () => {
  it('сегодня — с полуночи, неделя — с понедельника, месяц — с 1-го числа', () => {
    const s = periodStarts(NOW)
    assert.deepEqual(s.today, new Date(2026, 9, 22))
    assert.deepEqual(s.week, new Date(2026, 9, 19))
    assert.deepEqual(s.month, new Date(2026, 9, 1))
    assert.equal(s.all, null)
  })

  it('в воскресенье неделя всё ещё с понедельника', () => {
    assert.deepEqual(periodStarts(new Date(2026, 9, 25, 23)).week, new Date(2026, 9, 19))
    assert.deepEqual(periodStarts(new Date(2026, 9, 19, 0, 5)).week, new Date(2026, 9, 19))
  })
})

describe('Статистика КП: загрузка и проверка', () => {
  const rows = [
    // сегодня, на проверке
    kp({ created_at: at(10, 22, 9) }),
    // во вторник — новая версия КП, загруженного в сентябре
    kp({ created_at: at(10, 20), proposal_group_id: 'gv', counterparty_id: 'c2', tender_id: 't2' }),
    kp({ created_at: at(9, 10), proposal_group_id: 'gv', counterparty_id: 'c2', tender_id: 't2', review_required: false }),
    // 05.10: проверено сегодня без замечаний (через 17 суток), внесено в сводную
    kp({
      created_at: at(10, 5), review_status: 'approved', reviewed_at: at(10, 22, 12), reviewed_by: 'Петрова А.',
      summary_added: true, summary_added_at: at(10, 22, 13),
    }),
    // 13.10: с замечаниями, проверено через 4 часа, ещё не отправлено и не внесено
    kp({
      created_at: at(10, 13, 8), review_status: 'has_remarks', reviewed_at: at(10, 13, 12), reviewed_by: 'Петрова А.',
      s3: { uploaded_by_name: null },
    }),
    // 21.10: с замечаниями без отправки подрядчику, внесено в сводную
    kp({
      created_at: at(10, 21, 9), review_status: 'has_remarks', remarks_send_required: false,
      reviewed_at: at(10, 21, 11), reviewed_by: 'Сидоров В.', summary_added: true, summary_added_at: at(10, 21, 12),
    }),
    // старое КП на проверке — ждёт давно
    kp({ created_at: at(10, 1) }),
    // старое КП до «Проверки КП»: только в загрузке
    kp({ created_at: at(8, 1), review_required: false, review_status: 'pending' }),
  ]
  const st = computeKpStats(rows, NOW)
  const m = st.matrix

  it('загружено по периодам, версии, тендеры и подрядчики', () => {
    assert.deepEqual(m.uploaded, { today: 1, week: 3, month: 6, all: 8 })
    assert.deepEqual(m.versions, { today: 0, week: 1, month: 1, all: 1 })
    assert.deepEqual(m.tenders, { today: 1, week: 2, month: 2, all: 2 })
    assert.deepEqual(m.counterparties, { today: 1, week: 2, month: 2, all: 2 })
  })

  it('проверено — по дате решения; прежние КП в проверку не входят', () => {
    assert.deepEqual(m.reviewed, { today: 1, week: 2, month: 3, all: 3 })
    assert.deepEqual(m.approved, { today: 1, week: 1, month: 1, all: 1 })
    assert.deepEqual(m.remarks, { today: 0, week: 1, month: 2, all: 2 })
    assert.deepEqual(m.summary, { today: 1, week: 2, month: 2, all: 2 })
    assert.deepEqual(m.sent, { today: 0, week: 0, month: 0, all: 0 })
  })

  it('время проверки — медиана от загрузки до решения', () => {
    assert.equal(m.reviewTime.today, 17 * 24 * H + 2 * H)
    // за месяц: 4 ч, 2 ч, 17 сут 2 ч → медиана 4 ч
    assert.equal(m.reviewTime.month, 4 * H)
  })

  it('очередь: этапы, давно ждущие, следующий шаг', () => {
    assert.equal(st.queue.required, 6)
    assert.equal(st.queue.pending, 3)
    assert.equal(st.queue.stale, 2, 'больше 2 суток ждут КП от 01.10 и от 20.10 (2 сут. 5 ч), сегодняшнее — нет')
    assert.equal(st.queue.oldestPendingMs, NOW.getTime() - new Date(at(10, 1)).getTime())
    assert.equal(st.queue.toSummary, 1, 'с замечаниями, не внесено')
    assert.equal(st.queue.toSend, 1)
    assert.deepEqual(st.stages, { pending: 3, ok_done: 1, remarks_work: 1, nosend_done: 1 })
  })

  it('люди: кто загружает и кто проверяет', () => {
    const iv = st.uploaders.find(u => u.name === 'Иванов И. И.')
    assert.deepEqual({ ...iv }, { name: 'Иванов И. И.', today: 1, week: 3, month: 5, all: 7 })
    assert.equal(st.uploaders.find(u => u.name === 'Не указан').all, 1)
    const pt = st.reviewers.find(r => r.name === 'Петрова А.')
    assert.equal(pt.all, 2)
    assert.equal(pt.today, 1)
    assert.equal(pt.remarks, 1)
    assert.equal(st.reviewers[0].name, 'Петрова А.', 'больше проверок за месяц — выше')
  })

  it('пустой набор — нули и прочерки', () => {
    const e = computeKpStats([], NOW)
    assert.deepEqual(e.matrix.uploaded, { today: 0, week: 0, month: 0, all: 0 })
    assert.equal(e.matrix.reviewTime.month, null)
    assert.equal(e.queue.oldestPendingMs, null)
    assert.equal(formatDuration(e.matrix.reviewTime.month), '—')
  })
})

describe('Статистика КП: динамика', () => {
  const rows = [
    kp({ created_at: at(10, 22) }),
    kp({ created_at: at(10, 19, 0) }),
    kp({ created_at: at(10, 18, 23), review_status: 'approved', reviewed_at: at(10, 20) }),
    kp({ created_at: new Date(2025, 9, 5).toISOString() }),
  ]

  it('по неделям: 12 столбцов, последний — эта неделя, как в таблице', () => {
    const d = buildKpDynamics(rows, 'week', NOW)
    assert.equal(d.length, 12)
    const last = d[d.length - 1]
    assert.equal(last.label, '19.10')
    assert.equal(last.uploaded, computeKpStats(rows, NOW).matrix.uploaded.week)
    assert.equal(last.reviewed, 1)
    assert.equal(d[d.length - 2].uploaded, 1, 'воскресенье 18.10 — прошлая неделя')
  })

  it('по дням: 14 столбцов; по месяцам: 12, прошлогодний октябрь вне окна', () => {
    const days = buildKpDynamics(rows, 'day', NOW)
    assert.equal(days.length, 14)
    assert.equal(days.at(-1).label, '22.10')
    assert.equal(days.at(-1).uploaded, 1)
    const months = buildKpDynamics(rows, 'month', NOW)
    assert.equal(months.length, 12)
    assert.equal(months[0].label, 'ноя')
    assert.equal(months.at(-1).uploaded, 3)
    assert.equal(months.reduce((s, b) => s + b.uploaded, 0), 3)
  })
})

describe('Статистика КП: длительность', () => {
  it('минуты, часы, дни', () => {
    assert.equal(formatDuration(20 * 1000), '1 мин')
    assert.equal(formatDuration(35 * 60 * 1000), '35 мин')
    assert.equal(formatDuration(5 * H), '5 ч')
    assert.equal(formatDuration(36 * H), '1,5 дн.')
    assert.equal(formatDuration(12 * 24 * H), '12 дн.')
  })
})
