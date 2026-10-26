// «Отчёты → Заявки на ДС»: расчёт статистики (без браузера) — этапы, суммы «Было подано» / «Утверждено»,
// просрочка срока утверждения, итог проверки, задачи, события за период, разрезы и фильтры.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDcDynamics, completionTimes, computeDcStats, filterDcRequests,
} from '../../src/utils/dcRequestStats.js'

// «Сейчас» — среда 21.10.2026, 12:00 по местному времени: неделя с 19.10, месяц с 01.10.
const NOW = new Date(2026, 9, 21, 12, 0, 0)
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h).toISOString()

const OBJ_A = { id: 'obj-a', name: 'ЖК Альфа', status: 'main_construction' }
const OBJ_B = { id: 'obj-b', name: 'ЖК Бета', status: 'warranty_service' }

function req(id, over = {}) {
  return {
    id, object_id: OBJ_A.id, objects: OBJ_A, counterparty_id: 'cp-1', counterparties: { id: 'cp-1', name: 'ООО Ромашка' },
    responsible_contact_id: 'c-1', responsible: { id: 'c-1', full_name: 'Иванов И. И.' },
    ds_number: `ДС-${id}`, status: 'in_work', check_status: 'not_checked', checked_at: null,
    ds_type: 'psdc_change', material_type: null, amount_before: null, amount_after: null,
    expected_approval_date: null, created_at: at(2026, 9, 1), deleted_at: null, dc_request_tasks: [],
    ...over,
  }
}

const ROWS = [
  // Проверка по договору, создана сегодня, срок через 3 дня, сумма подана.
  req('r1', { status: 'contract_check', created_at: at(2026, 10, 21, 9), expected_approval_date: '2026-10-24', amount_before: 1000000 }),
  // Итог проверки: проверена вчера (на неделе) с замечаниями, срок вчера — просрочена.
  req('r2', {
    status: 'check_result', check_status: 'matches_with_remarks', created_at: at(2026, 10, 15), checked_at: at(2026, 10, 20),
    expected_approval_date: '2026-10-20', amount_before: 500000, dc_request_tasks: [{ id: 't1', is_completed: false }, { id: 't2', is_completed: true }],
  }),
  // В работе, без срока, другой ответственный, объект гарантийного отдела.
  req('r3', {
    object_id: OBJ_B.id, objects: OBJ_B, responsible_contact_id: null, responsible: null, check_status: 'matches',
    checked_at: at(2026, 9, 10), created_at: at(2026, 9, 5), ds_type: 'extra_out_contract', material_type: 'tolling',
  }),
  // Завершена в этом месяце: подано 2 млн, утверждено 1,8 млн; срок прошёл, но завершённая не просрочена.
  req('r4', {
    status: 'completed', check_status: 'matches', checked_at: at(2026, 9, 12), created_at: at(2026, 9, 2),
    amount_before: 2000000, amount_after: 1800000, expected_approval_date: '2026-10-01',
  }),
  // Завершена давно, журнала нет — в «завершено за период» не входит.
  req('r5', { status: 'completed', check_status: 'not_matches', checked_at: at(2026, 3, 3), created_at: at(2026, 3, 1), amount_after: 300000 }),
  // В «Удалённых» — только счётчик.
  req('r6', { deleted_at: at(2026, 10, 1), amount_before: 999999999 }),
]

const EVENTS = [
  { dc_request_id: 'r4', new_value: 'in_work', changed_at: at(2026, 9, 12) },
  { dc_request_id: 'r4', new_value: 'completed', changed_at: at(2026, 10, 5) },
  // Возвращали в работу и завершили снова — берётся последнее завершение.
  { dc_request_id: 'r2', new_value: 'completed', changed_at: at(2026, 10, 1) },
  { dc_request_id: 'r2', new_value: 'check_result', changed_at: at(2026, 10, 2) },
]

describe('Отчёты: статистика заявок на ДС', () => {
  const completed = completionTimes(EVENTS)
  const s = computeDcStats(ROWS, completed, NOW)

  it('этапы, удалённые отдельно', () => {
    assert.equal(s.total, 5)
    assert.equal(s.deleted, 1)
    assert.deepEqual(s.byStatus, { contract_check: 1, check_result: 1, in_work: 1, completed: 2 })
    assert.equal(s.active, 3)
  })

  it('суммы: подано и утверждено, разница — только по заявкам с обеими суммами', () => {
    assert.equal(s.amounts.submitted, 3500000)
    assert.equal(s.amounts.approved, 2100000)
    assert.equal(s.amounts.withBoth, 1)
    assert.equal(s.amounts.diff, -200000)
    assert.equal(Math.round(s.amounts.diffPct), -10)
    assert.equal(s.amounts.withoutAmount, 1)
  })

  it('сроки: просрочка только у незавершённых, «скоро» — в пределах 7 дней, без срока', () => {
    assert.equal(s.deadlines.overdue, 1)
    assert.equal(s.deadlines.overdueList[0].id, 'r2')
    assert.equal(s.deadlines.overdueList[0].days, 1)
    assert.equal(s.deadlines.dueSoon, 1)
    assert.equal(s.deadlines.noDeadline, 1)
  })

  it('итог проверки, задачи, медианы', () => {
    assert.deepEqual(s.verdicts, { matches: 2, matches_with_remarks: 1, not_matches: 1, not_checked: 1 })
    assert.deepEqual(s.tasks, { total: 2, done: 1, requestsWithOpen: 1 })
    assert.equal(s.durations.checkCount, 4)
    assert.equal(s.durations.completeCount, 1)
    assert.ok(s.durations.completeMedianMs > 30 * 24 * 3600 * 1000)
  })

  it('события за период: создано, проверено, завершено, суммы', () => {
    assert.deepEqual(s.matrix.created, { today: 1, week: 1, month: 2, all: 5 })
    assert.deepEqual(s.matrix.checked, { today: 0, week: 1, month: 1, all: 4 })
    assert.deepEqual(s.matrix.checkedRemarks, { today: 0, week: 1, month: 1, all: 1 })
    // r2 снова не завершена — её прежнее «Завершено» не считается; r5 без журнала.
    assert.deepEqual(s.matrix.completed, { today: 0, week: 0, month: 1, all: 1 })
    assert.deepEqual(s.matrix.approved, { today: 0, week: 0, month: 1800000, all: 1800000 })
    assert.equal(s.matrix.submitted.month, 1500000)
  })

  it('разрезы: «Не назначен» и «Не указан» — в конце, справочники в своём порядке', () => {
    assert.deepEqual(s.byResponsible.map(g => [g.name, g.total, g.overdue]), [['Иванов И. И.', 4, 1], ['Не назначен', 1, 0]])
    assert.deepEqual(s.byObject.map(g => [g.name, g.total]), [['ЖК Альфа', 4], ['ЖК Бета', 1]])
    assert.deepEqual(s.byDsType.map(g => g.name), ['Изменение ПСДЦ', 'Доп. работы вне договора'])
    assert.deepEqual(s.byMaterial.map(g => [g.name, g.total]), [['Давальческие (М-15)', 1], ['Не указан', 4]])
    const alpha = s.byObject[0]
    assert.equal(alpha.submitted, 3500000)
    assert.equal(alpha.completed, 2)
  })

  it('фильтры: отдел, объект, ответственный (в т.ч. «Не назначен»), тип ДС', () => {
    assert.equal(filterDcRequests(ROWS, { dept: 'warranty_service' }).length, 1)
    assert.equal(filterDcRequests(ROWS, { objectId: 'obj-a' }).length, 5)
    assert.deepEqual(filterDcRequests(ROWS, { respId: '_unassigned' }).map(r => r.id), ['r3'])
    assert.deepEqual(filterDcRequests(ROWS, { dsType: 'extra_out_contract' }).map(r => r.id), ['r3'])
  })

  it('динамика по месяцам: последний столбец — текущий месяц', () => {
    const dyn = buildDcDynamics(ROWS, completed, 'month', NOW)
    assert.equal(dyn.length, 12)
    const last = dyn.at(-1)
    assert.equal(last.label, 'окт')
    assert.equal(last.created, 2)
    assert.equal(last.completed, 1)
    assert.equal(dyn.at(-2).created, 2) // сентябрь: r3, r4 (удалённая r6 не в счёт)
  })
})
