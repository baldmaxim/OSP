// Интеграция ПСДЦ с расчётом первого этапа (актуальная сумма договора) и
// автосопоставление файлов массовой загрузки. Чистый JS, без базы.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDocIndex, contractActualAmount, effectiveDocumentAmount, effectiveValues, branchAmount,
} from '../../src/utils/contractAmendments.js'
import { buildDocumentMatcher, matchFileName, normalizeForMatch } from '../../src/utils/psdcMatching.js'

const M = 1_000_000

function tree(docs) {
  return buildDocIndex(docs.map((d) => ({ deleted_at: null, changed_fields: [], ...d })))
}

describe('ПСДЦ и актуальная сумма договора', () => {
  it('приоритет ПСДЦ над ручной суммой и возврат к ручной после удаления (118)', () => {
    assert.equal(effectiveDocumentAmount({ contract_amount: 10 * M, psdc_total: null }), 10 * M)
    assert.equal(effectiveDocumentAmount({ contract_amount: 10 * M, psdc_total: String(11 * M) }), 11 * M)
    assert.equal(effectiveDocumentAmount({ contract_amount: null, psdc_total: null }), null)
  })

  it('основная ветка: завершённое изменение с ПСДЦ 105 млн заменяет 100 млн (66)', () => {
    const idx = tree([
      { id: 'c', display_id: 76, record_type: 'dp', status: 'in_work', contract_amount: 90 * M, psdc_total: 100 * M },
      { id: 'd1', display_id: 101, record_type: 'ds_vor', parent_contract_id: 'c', root_contract_id: 'c', status: 'completed', contract_amount: null, psdc_total: 105 * M },
    ])
    assert.equal(contractActualAmount(idx.byId.get('c'), idx), 105 * M)
  })

  it('доп. работы добавляются, их изменение заменяет сумму ветки (67, 68)', () => {
    const docs = [
      { id: 'c', display_id: 76, record_type: 'dp', status: 'completed', psdc_total: 100 * M },
      { id: 'd1', display_id: 101, record_type: 'ds_vor', parent_contract_id: 'c', root_contract_id: 'c', status: 'completed', psdc_total: 105 * M },
      { id: 'x', display_id: 110, record_type: 'ds_extra', parent_contract_id: 'c', root_contract_id: 'c', status: 'completed', psdc_total: 8 * M },
    ]
    assert.equal(contractActualAmount(tree(docs).byId.get('c'), tree(docs)), 113 * M)

    const withChange = [...docs, { id: 'x1', display_id: 130, record_type: 'ds_vor', parent_contract_id: 'x', root_contract_id: 'c', status: 'completed', psdc_total: 9 * M }]
    const idx = tree(withChange)
    assert.equal(contractActualAmount(idx.byId.get('c'), idx), 114 * M)
    assert.equal(branchAmount(idx.byId.get('x'), idx), 9 * M)
  })

  it('незавершённое ДС с применённой ПСДЦ не влияет на договор до «Завершено» (69, 119)', () => {
    const docs = [
      { id: 'c', display_id: 1, record_type: 'dp', status: 'in_work', contract_amount: 100 * M },
      { id: 'd', display_id: 2, record_type: 'ds_vor', parent_contract_id: 'c', root_contract_id: 'c', status: 'in_work', contract_amount: 100 * M, psdc_total: 105 * M },
    ]
    let idx = tree(docs)
    assert.equal(effectiveDocumentAmount(idx.byId.get('d')), 105 * M, 'карточка ДС показывает 105')
    assert.equal(contractActualAmount(idx.byId.get('c'), idx), 100 * M, 'договор пока 100')

    idx = tree(docs.map((d) => (d.id === 'd' ? { ...d, status: 'completed' } : d)))
    assert.equal(contractActualAmount(idx.byId.get('c'), idx), 105 * M)
  })

  it('незавершённые доп. работы не входят в сумму; ручные суммы без ПСДЦ считаются как раньше', () => {
    const idx = tree([
      { id: 'c', display_id: 1, record_type: 'dp', status: 'completed', contract_amount: 50 * M },
      { id: 'x', display_id: 2, record_type: 'ds_extra', parent_contract_id: 'c', root_contract_id: 'c', status: 'in_work', psdc_total: 7 * M },
      { id: 'd', display_id: 3, record_type: 'ds_vor', parent_contract_id: 'c', root_contract_id: 'c', status: 'completed', contract_amount: 60 * M, changed_fields: ['contract_amount'] },
    ])
    assert.equal(contractActualAmount(idx.byId.get('c'), idx), 60 * M)
    assert.equal(effectiveValues(idx.byId.get('c'), idx).contract_amount, 60 * M)
  })
})

describe('ПСДЦ: автосопоставление имени файла', () => {
  const docs = [
    { id: 'c45', display_id: 45, record_type: 'dp', contract_number: '45-П/2024' },
    { id: 'c46', display_id: 46, record_type: 'dp', contract_number: 'СУ10-777' },
    { id: 'c47', display_id: 47, record_type: 'dp', contract_number: '12' },
    { id: 'ds1', display_id: 101, record_type: 'ds_vor', contract_number: '3', root_contract_id: 'c45', parent_contract_id: 'c45' },
    { id: 'ds2', display_id: 102, record_type: 'ds_extra', contract_number: '3', root_contract_id: 'c46', parent_contract_id: 'c46' },
    { id: 'dup1', display_id: 200, record_type: 'dp', contract_number: 'ДУБЛЬ-1' },
    { id: 'dup2', display_id: 201, record_type: 'dp', contract_number: 'ДУБЛЬ-1' },
    { id: 'del', display_id: 300, record_type: 'dp', contract_number: 'УДАЛ-300', deleted_at: '2026-01-01' },
  ]
  const matcher = buildDocumentMatcher(docs)
  const match = (name) => matchFileName(name, matcher)

  it('явный ID документа', () => {
    assert.equal(match('ВОР ID 46.xlsx').doc?.id, 'c46')
    assert.equal(match('ПСДЦ_ид-101.xlsx').doc?.id, 'ds1')
    assert.equal(match('ID 99999.xlsx').status, 'none')
  })

  it('номер договора целиком (с «/» в номере), номер ДС внутри договора', () => {
    assert.equal(match('ВОР 45-П_2024.xlsx').doc?.id, 'c45')
    assert.equal(match('СУ10-777 ПСДЦ.xlsx').doc?.id, 'c46')
    assert.equal(match('ВОР 45-П_2024 ДС №3.xlsx').doc?.id, 'ds1')
    assert.equal(match('СУ10-777 доп соглашение 3.xlsx').doc?.id, 'ds2')
    assert.equal(match('СУ10-777 ДС 9.xlsx').status, 'none', 'ДС не найдено — договор не подставляется')
  })

  it('короткие номера, похожие фрагменты и удалённые документы не сопоставляются', () => {
    assert.equal(match('ВОР 12.xlsx').status, 'none')
    assert.equal(match('ВОР 145-П_20245.xlsx').status, 'none')
    assert.equal(match('УДАЛ-300.xlsx').status, 'none')
    assert.equal(match('Отделка МОП ООО Ромашка.xlsx').status, 'none')
  })

  it('несколько кандидатов — неоднозначно, документ не назначается', () => {
    const r = match('ДУБЛЬ-1.xlsx')
    assert.equal(r.status, 'ambiguous')
    assert.equal(r.doc, null)
    assert.match(r.reason, /ID 200, ID 201/)
    assert.equal(match('ID 46 45-П_2024.xlsx').status, 'ambiguous')
  })

  it('нормализация имени', () => {
    assert.equal(normalizeForMatch(' Договор №45-П/2024 (ред.)'), 'договор_45-п_2024_ред.')
  })
})
