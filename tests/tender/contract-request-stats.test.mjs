// «Отчёты → Договоры → Заключение ДП» и «Проверка ДП/ДС»: расчёт статистики (без браузера) — статусы и колонки доски, суммы,
// сроки, ожидание, незаполненные поля отдела, события за период, медианы, разрезы и фильтры.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDpDynamics, computeDpStats, dpFilterOptions, dpMissingFields, filterDpRequests,
} from '../../src/utils/dpRequestStats.js'
import {
  buildDocCheckDynamics, computeDocCheckStats, docCheckFilterOptions, docCheckStatusTimes, filterDocCheckRequests,
} from '../../src/utils/docCheckStats.js'

// «Сейчас» — среда 21.10.2026, 12:00 по местному времени: неделя с 19.10, месяц с 01.10.
const NOW = new Date(2026, 9, 21, 12, 0, 0)
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h).toISOString()
const OBJ_A = { id: 'obj-a', name: 'ЖК Альфа', status: 'main_construction' }
const OBJ_B = { id: 'obj-b', name: 'ЖК Бета', status: 'warranty_service' }

describe('Отчёты: заключение ДП', () => {
  const dp = (id, over = {}) => ({
    id, request_number: Number(id.slice(1)), object_id: OBJ_A.id, objects: OBJ_A, contract_title: `Договор ${id}`, amount: 1000000,
    responsible_name: 'Экономов А. П.', responsible_role: 'economist', status: 'new', status_changed_at: null,
    created_by_name: 'Строев Б. И.', created_at: at(2026, 9, 1), deleted_at: null, ...over,
  })
  const ROWS = [
    // Подана сегодня, ничего отделом не заполнено.
    dp('p1', { object_id: null, objects: null, contract_title: null, amount: null, responsible_name: null, responsible_role: null,
      created_at: at(2026, 10, 21, 9), status_changed_at: at(2026, 10, 21, 9) }),
    // Новая 10 дней — ждёт долго.
    dp('p2', { created_at: at(2026, 10, 11), status_changed_at: at(2026, 10, 11), amount: 500000 }),
    // В работе 20 дней — залежалась; ответственный — руководитель строительства, ФИО в другом регистре и с «ё».
    dp('p3', { status: 'in_work', status_changed_at: at(2026, 10, 1), responsible_name: 'строёв б. и.', responsible_role: 'construction_manager',
      object_id: OBJ_B.id, objects: OBJ_B }),
    // Завершена на неделе: 15 дней от подачи.
    dp('p4', { status: 'completed', created_at: at(2026, 10, 5), status_changed_at: at(2026, 10, 20), amount: 2000000 }),
    // Завершена давно: 5 дней от подачи.
    dp('p5', { status: 'completed', created_at: at(2026, 3, 1), status_changed_at: at(2026, 3, 6), amount: 300000 }),
    // Удалённая — только счётчик; черновик — не заявка.
    dp('p6', { deleted_at: at(2026, 10, 2), amount: 999999999 }),
    dp('p7', { status: 'draft', amount: 888888888 }),
  ]
  const s = computeDpStats(ROWS, NOW)

  it('статусы, суммы, удалённые и черновики', () => {
    assert.equal(s.total, 5)
    assert.equal(s.deleted, 1, 'черновик не считается и удалённым')
    assert.deepEqual(s.byStatus, { new: 2, in_work: 1, completed: 2 })
    assert.equal(s.active, 3)
    assert.equal(s.amounts.total, 500000 + 1000000 + 2000000 + 300000)
    assert.equal(s.amounts.completed, 2300000)
    assert.equal(s.amounts.withoutAmount, 1)
  })

  it('ожидание и незаполненные поля — только у незавершённых', () => {
    assert.equal(s.stale.newCount, 1, 'новая 10 дней — да, поданная сегодня — нет')
    assert.equal(s.stale.oldestNewDays, 10)
    assert.equal(s.stale.workCount, 1)
    assert.deepEqual(s.missing, { requests: 1, object: 1, contract: 1, amount: 1, responsible: 1 })
    assert.deepEqual(dpMissingFields({ object_id: 'x', contract_title: ' ', amount: 0, responsible_name: 'А' }), ['contract'],
      'сумма 0 — внесена')
    assert.deepEqual(s.waiting.map(w => w.id), ['p3', 'p2', 'p1'], 'дольше ждут — выше')
    assert.equal(s.waiting.find(w => w.id === 'p1').missing.length, 4)
  })

  it('события за период и медиана до завершения', () => {
    assert.deepEqual(s.matrix.created, { today: 1, week: 1, month: 3, all: 5 })
    assert.deepEqual(s.matrix.completed, { today: 0, week: 1, month: 1, all: 2 })
    assert.equal(s.matrix.completedAmount.all, 2300000)
    assert.equal(s.matrix.createdAmount.month, 2500000, 'p1 без суммы, p2 — 0,5 млн, p4 — 2 млн')
    assert.equal(s.durations.completeCount, 2)
    assert.equal(Math.round(s.durations.completeMedianMs / 86400000), 10, 'медиана 5 и 15 дней')
  })

  it('разрезы: ответственный по ФИО без учёта регистра и «ё», пустые — в конце', () => {
    assert.deepEqual(s.byObject.map(g => g.name), ['ЖК Альфа', 'ЖК Бета', 'Объект не указан'])
    const people = s.byResponsible.map(g => [g.name, g.total])
    assert.deepEqual(people, [['Экономов А. П.', 3], ['строёв б. и.', 1], ['Не указан', 1]])
    assert.equal(s.byResponsible[1].role, 'Руководитель строительства')
    assert.equal(s.byObject[0].stale, 1)
  })

  it('фильтры и списки фильтров', () => {
    const opts = dpFilterOptions(ROWS)
    assert.deepEqual(opts.objects.map(o => o.id), ['obj-a', 'obj-b', '_none'])
    assert.equal(opts.people.at(-1).id, '_none')
    assert.equal(computeDpStats(filterDpRequests(ROWS, { dept: 'warranty_service' }), NOW).total, 1)
    assert.equal(computeDpStats(filterDpRequests(ROWS, { objectId: '_none' }), NOW).total, 1)
    const boss = opts.people.find(p => /стр/i.test(p.name)).id
    assert.deepEqual(filterDpRequests(ROWS, { respKey: boss }).map(r => r.id), ['p3'])
  })

  it('динамика по месяцам: последний столбец совпадает с «месяцем»', () => {
    const buckets = buildDpDynamics(ROWS, 'month', NOW)
    assert.equal(buckets.length, 12)
    assert.equal(buckets.at(-1).created, s.matrix.created.month)
    assert.equal(buckets.at(-1).completed, s.matrix.completed.month)
    assert.equal(buckets.reduce((n, b) => n + b.created, 0), 5, 'удалённые и черновики не входят')
  })
})

describe('Отчёты: проверка ДП/ДС', () => {
  const LAWYER_1 = { user_id: 'u-1', display_name: 'Юристова М. А.', role: 'lawyer' }
  const LAWYER_2 = { user_id: 'u-2', display_name: 'Правов П. П.', role: 'lawyer' }
  const OTHER = { user_id: 'u-3', display_name: 'Сметчик С. С.', role: 'estimator' }
  const employees = new Map([LAWYER_1, LAWYER_2, OTHER].map(e => [e.user_id, e]))
  const req = (id, over = {}) => ({
    id, request_number: Number(id.slice(1)), object_id: OBJ_A.id, objects: OBJ_A, counterparty_id: 'cp-1',
    counterparties: { id: 'cp-1', name: 'ООО Ромашка' }, doc_type: 'ds', doc_number: id, status: 'new', due_date: null,
    priority: null, assignee_ids: [], archived_at: null, created_at: at(2026, 9, 1), deleted_at: null, ...over,
  })
  const ROWS = [
    // Новая, создана сегодня, срок через 3 дня, исполнителя нет (сметчик не юрист — не исполнитель).
    req('r1', { created_at: at(2026, 10, 21, 9), due_date: '2026-10-24', assignee_ids: ['u-3'] }),
    // Новая 5 дней — не взята в работу; высокий приоритет.
    req('r2', { created_at: at(2026, 10, 16), priority: 'high', assignee_ids: ['u-1'] }),
    // В работе, срок вчера — просрочена; два исполнителя; ДП по объекту Бета.
    req('r3', { status: 'in_progress', doc_type: 'dp', object_id: OBJ_B.id, objects: OBJ_B, due_date: '2026-10-20',
      assignee_ids: ['u-1', 'u-2'], created_at: at(2026, 10, 10) }),
    // Завершена на неделе, в архиве; срок прошёл, но завершённая не просрочена.
    req('r4', { status: 'done', archived_at: at(2026, 10, 20), due_date: '2026-10-01', assignee_ids: ['u-2'], created_at: at(2026, 10, 2) }),
    // Ждём скан 40 дней; срок прошёл — как на доске, просрочена (заявка не в «Завершено»).
    req('r5', { status: 'awaiting_scan', due_date: '2026-10-15', assignee_ids: ['u-1'], created_at: at(2026, 8, 1) }),
    // Завершена, переноса в истории нет — в «завершено за период» не входит.
    req('r6', { status: 'done', doc_type: 'dp', counterparty_id: null, counterparties: null }),
    // Удалённая — только счётчик.
    req('r7', { deleted_at: at(2026, 10, 3), due_date: '2026-01-01' }),
  ]
  const EVENTS = [
    { request_id: 'r3', new_value: 'in_progress', changed_at: at(2026, 10, 12) },
    { request_id: 'r4', new_value: 'in_progress', changed_at: at(2026, 10, 4) },
    { request_id: 'r4', new_value: 'done', changed_at: at(2026, 10, 8) },
    { request_id: 'r4', new_value: 'edo', changed_at: at(2026, 10, 9) },
    // Вернули и завершили снова — берётся последнее завершение.
    { request_id: 'r4', new_value: 'done', changed_at: at(2026, 10, 20) },
    { request_id: 'r5', new_value: 'awaiting_scan', changed_at: at(2026, 9, 11) },
  ]
  const times = docCheckStatusTimes(EVENTS)
  const s = computeDocCheckStats(ROWS, times, employees, NOW)

  it('колонки доски, ДП/ДС, архив и удалённые', () => {
    assert.equal(s.total, 6)
    assert.equal(s.deleted, 1)
    assert.equal(s.archived, 1)
    assert.equal(s.byStatus.new, 2)
    assert.equal(s.byStatus.in_progress, 1)
    assert.equal(s.byStatus.done, 2)
    assert.equal(s.byStatus.awaiting_scan, 1)
    assert.deepEqual(s.byType, { dp: 2, ds: 4 })
    assert.equal(s.open, 4, '«Ожидаем скан» открыта')
    assert.equal(s.inWork, 3, 'у отдела — без ждущих скан')
  })

  it('сроки и «Требуют внимания»', () => {
    assert.equal(s.deadlines.overdue, 2, 'r3 и r5; завершённая и удалённая — нет')
    assert.deepEqual(s.deadlines.overdueList.map(r => r.id), ['r5', 'r3'], 'дольше просрочена — выше')
    assert.deepEqual(s.deadlines.overdueList[1].assignees, ['Юристова М. А.', 'Правов П. П.'])
    assert.equal(s.deadlines.dueSoon, 1)
    assert.equal(s.deadlines.noDeadline, 1)
    assert.equal(s.attention.unassigned, 1, 'r1: сметчик — не исполнитель')
    assert.equal(s.attention.highPriority, 1)
    assert.equal(s.attention.staleNew, 1)
    assert.equal(s.attention.oldestNewDays, 5)
    assert.equal(s.attention.staleScan, 1)
  })

  it('события за период и медианы по истории', () => {
    assert.deepEqual(s.matrix.created, { today: 1, week: 1, month: 4, all: 6 })
    assert.equal(s.matrix.createdDp.all, 2)
    assert.equal(s.matrix.createdDs.month, 3)
    assert.deepEqual(s.matrix.taken, { today: 0, week: 0, month: 2, all: 3 })
    assert.deepEqual(s.matrix.completed, { today: 0, week: 1, month: 1, all: 1 }, 'r6 без записи в истории — нет')
    assert.equal(s.durations.takeCount, 3)
    assert.equal(s.durations.doneCount, 1)
    assert.equal(Math.round(s.durations.doneMedianMs / 86400000), 18)
  })

  it('разрезы: заявка у каждого исполнителя, «без исполнителя» и «не указан» — в конце', () => {
    assert.deepEqual(s.byAssignee.map(g => [g.name, g.total]),
      [['Юристова М. А.', 3], ['Правов П. П.', 2], ['Без исполнителя', 2]])
    assert.deepEqual(s.byObject.map(g => g.name), ['ЖК Альфа', 'ЖК Бета'])
    assert.equal(s.byObject[1].dp, 1)
    assert.equal(s.byObject[1].overdue, 1)
    assert.equal(s.byCounterparty.at(-1).name, 'Не указан')
  })

  it('фильтры и списки фильтров', () => {
    const opts = docCheckFilterOptions(ROWS, employees)
    assert.deepEqual(opts.people.map(p => p.id), ['u-2', 'u-1', '_none'], 'по алфавиту, сметчика нет')
    const of = (f) => filterDocCheckRequests(ROWS, f, employees).filter(r => !r.deleted_at).map(r => r.id)
    assert.deepEqual(of({ assignee: 'u-2' }), ['r3', 'r4'])
    assert.deepEqual(of({ assignee: '_none' }), ['r1', 'r6'])
    assert.deepEqual(of({ docType: 'dp' }), ['r3', 'r6'])
    assert.deepEqual(of({ dept: 'warranty_service' }), ['r3'])
  })

  it('динамика: последний столбец совпадает с «месяцем»', () => {
    const buckets = buildDocCheckDynamics(ROWS, times, 'month', NOW)
    assert.equal(buckets.at(-1).created, s.matrix.created.month)
    assert.equal(buckets.at(-1).completed, s.matrix.completed.month)
  })

  it('без справочника сотрудников исполнителей нет ни у кого', () => {
    const bare = computeDocCheckStats(ROWS, times, new Map(), NOW)
    assert.deepEqual(bare.byAssignee.map(g => g.id), ['_none'])
  })
})
