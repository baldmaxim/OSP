// Суммы договоров в отчётах (reportAmounts): по дереву договора, а не по строкам реестра. ДС на изменение ВОР хранит полную
// новую сумму ветки — простое сложение строк считало договор ещё раз на каждое такое ДС.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reportAmounts } from '../../src/utils/contractAmendments.js'

const doc = (id, display_id, extra) => ({
  id, display_id, status: 'completed', deleted_at: null, record_type: 'dp', parent_contract_id: null,
  contract_amount: null, psdc_total: null, changed_fields: [], ...extra,
})

describe('суммы договоров для отчётов', () => {
  it('договор 10 млн, ДС только про сроки и ДС на 12 млн — 12 млн, а не 32', () => {
    const rows = [
      doc('c', 1, { contract_amount: 10_000_000 }),
      doc('d1', 2, { record_type: 'ds_vor', parent_contract_id: 'c', contract_amount: 10_000_000, changed_fields: ['end_date'] }),
      doc('d2', 3, { record_type: 'ds_vor', parent_contract_id: 'd1', contract_amount: 12_000_000, changed_fields: ['contract_amount'] }),
    ]
    const amounts = reportAmounts(rows)
    assert.equal(amounts.get('c'), 12_000_000)
    assert.equal(amounts.get('d1'), 0)
    assert.equal(amounts.get('d2'), 0)
    assert.equal([...amounts.values()].reduce((a, b) => a + b, 0), 12_000_000)
  })

  it('незавершённое ДС суммы не меняет; завершённые доп. работы прибавляются; ПСДЦ договора важнее ручной суммы', () => {
    const rows = [
      doc('c', 1, { contract_amount: 5_000_000, psdc_total: 6_000_000 }),
      doc('d', 2, { record_type: 'ds_vor', parent_contract_id: 'c', status: 'in_work', contract_amount: 9_000_000, changed_fields: ['contract_amount'] }),
      doc('x', 3, { record_type: 'ds_extra', parent_contract_id: 'c', contract_amount: 1_000_000 }),
      doc('y', 4, { record_type: 'ds_extra', parent_contract_id: 'c', status: 'in_work', contract_amount: 7_000_000 }),
    ]
    const amounts = reportAmounts(rows)
    assert.equal(amounts.get('c'), 7_000_000)
    assert.equal(amounts.get('x'), 0)
    assert.equal(amounts.get('y'), 0)
  })

  it('ДС без договора в выборке считается своей суммой; строка без record_type — как раньше, своей суммой', () => {
    const amounts = reportAmounts([
      doc('d', 2, { record_type: 'ds_vor', parent_contract_id: 'missing', contract_amount: 3_000_000 }),
      { id: 'old', contract_amount: 4_000_000 },
    ])
    assert.equal(amounts.get('d'), 3_000_000)
    assert.equal(amounts.get('old'), 4_000_000)
  })
})
