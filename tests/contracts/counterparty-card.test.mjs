// Карточка контрагента, вкладка «Общая информация»: НДС контрагента (ставка или «без НДС») и договоры с ДС
// контрагента группами «договор и его ДС».
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VAT_EXEMPT, VAT_NONE, vatFromSelect, vatSelectValue, vatText } from '../../src/utils/counterpartyVat.js'
import { docTitle, groupCounterpartyDocs } from '../../src/utils/counterpartyDocs.js'

describe('НДС контрагента', () => {
  it('выпадающий список ↔ поля базы', () => {
    assert.deepEqual(vatFromSelect(VAT_EXEMPT), { vat_rate: null, vat_exempt: true })
    assert.deepEqual(vatFromSelect(VAT_NONE), { vat_rate: null, vat_exempt: false })
    assert.deepEqual(vatFromSelect('22'), { vat_rate: 22, vat_exempt: false })
    assert.deepEqual(vatFromSelect('0'), { vat_rate: 0, vat_exempt: false })
    // Вне границ ограничения базы (0…100) — «не указан», а не ошибка записи.
    assert.deepEqual(vatFromSelect('150'), { vat_rate: null, vat_exempt: false })

    assert.equal(vatSelectValue({ vat_rate: '22.00', vat_exempt: false }), '22')
    assert.equal(vatSelectValue({ vat_rate: null, vat_exempt: true }), VAT_EXEMPT)
    assert.equal(vatSelectValue({ vat_rate: null, vat_exempt: false }), VAT_NONE)
    // До миграции колонок нет — тоже «не указан».
    assert.equal(vatSelectValue({}), VAT_NONE)
  })

  it('«без НДС» и 0 % — разные значения', () => {
    assert.equal(vatText({ vat_exempt: true, vat_rate: null }), 'Без НДС')
    assert.equal(vatText({ vat_exempt: false, vat_rate: 0 }), '0 %')
    assert.equal(vatText({ vat_rate: 22 }), '22 %')
    assert.equal(vatText({ vat_rate: '7.50' }), '7,5 %')
    assert.equal(vatText({}), 'не указан')
  })
})

const doc = (over) => ({
  record_type: 'dp', parent_contract_id: null, root_contract_id: null, status: 'in_work', deleted_at: null,
  contract_amount: null, psdc_total: null, currency: 'RUB', changed_fields: [], ...over,
})

describe('Договоры и ДС контрагента', () => {
  it('ДС — под своим договором, свежие договоры — выше', () => {
    const docs = [
      doc({ id: 'c1', display_id: 1, contract_number: '1', contract_date: '2025-03-01', contract_amount: 100 }),
      doc({ id: 'c2', display_id: 2, contract_number: '2', contract_date: '2026-01-15', contract_amount: 50 }),
      doc({ id: 'd1', display_id: 3, record_type: 'ds_extra', parent_contract_id: 'c1', root_contract_id: 'c1', contract_amount: 10 }),
      doc({ id: 'd2', display_id: 4, record_type: 'ds_vor', parent_contract_id: 'd1', root_contract_id: 'c1', contract_amount: 12 }),
    ]
    const groups = groupCounterpartyDocs(docs)
    assert.deepEqual(groups.map(g => g.root.id), ['c2', 'c1'])
    assert.deepEqual(groups[1].children.map(c => [c.doc.id, c.depth]), [['d1', 0], ['d2', 1]])
    assert.deepEqual(groups[0].children, [])
  })

  it('сумма с учётом ДС — только завершённые и только если отличается', () => {
    const docs = [
      doc({ id: 'c1', display_id: 1, contract_amount: 100 }),
      doc({ id: 'x1', display_id: 2, record_type: 'ds_extra', parent_contract_id: 'c1', root_contract_id: 'c1',
            contract_amount: 30, status: 'completed' }),
      doc({ id: 'x2', display_id: 3, record_type: 'ds_extra', parent_contract_id: 'c1', root_contract_id: 'c1',
            contract_amount: 999, status: 'in_work' }),
      doc({ id: 'c2', display_id: 4, contract_amount: 70 }),
    ]
    const byRoot = new Map(groupCounterpartyDocs(docs).map(g => [g.root.id, g]))
    assert.equal(byRoot.get('c1').actual, 130)
    assert.equal(byRoot.get('c2').actual, null)
  })

  it('ДС без загруженного договора не теряется — показывается отдельно', () => {
    const groups = groupCounterpartyDocs([
      doc({ id: 'd9', display_id: 9, record_type: 'ds_vor', parent_contract_id: 'gone', root_contract_id: 'gone', contract_amount: 5 }),
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].root.id, 'd9')
    assert.equal(groups[0].actual, null)
  })

  it('подпись документа', () => {
    assert.deepEqual(docTitle(doc({ contract_number: '15-П', contract_date: '2026-02-03' })),
      { kind: 'Договор', num: '№ 15-П', date: '03.02.2026' })
    assert.deepEqual(docTitle(doc({ record_type: 'ds_extra' })),
      { kind: 'ДС на дополнительные работы', num: 'без номера', date: '' })
  })
})
