// Карточка контрагента, вкладка «Общая информация»: НДС контрагента (ставка или «без НДС»), договоры с ДС
// контрагента группами «договор и его ДС», дерево «объект → договоры → ДС и заявки на ДС» и поиск договора для
// «Прикрепить договор».
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VAT_EXEMPT, VAT_NONE, vatFromSelect, vatSelectValue, vatText } from '../../src/utils/counterpartyVat.js'
import { buildObjectTree, docTitle, groupCounterpartyDocs, searchContractChoices } from '../../src/utils/counterpartyDocs.js'

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

describe('Дерево «объект → договоры → ДС и заявки на ДС»', () => {
  const north = { id: 'o-n', name: 'ЖК Северный' }
  const east = { id: 'o-e', name: 'БЦ Восток' }
  const contract = (id, object, over = {}) => doc({
    id, display_id: Number(id.replace(/\D/g, '')), object_id: object?.id ?? null, objects: object ? { name: object.name } : null, ...over,
  })
  const request = (id, object, over = {}) => ({
    id, object_id: object?.id ?? null, objects: object ? { name: object.name } : null, contract_id: null, amendment_id: null,
    status: 'in_work', created_at: '2026-01-01T10:00:00Z', ...over,
  })

  it('объекты — только те, где есть договор или заявка; договоры и заявки внутри своего объекта', () => {
    const c1 = contract('c1', north, { contract_date: '2025-03-01' })
    const d1 = contract('d1', east, { record_type: 'ds_extra', parent_contract_id: 'c1', root_contract_id: 'c1', contract_date: '2025-05-01' })
    const c2 = contract('c2', east, { contract_date: '2026-02-01' })
    const objects = buildObjectTree([c1, d1, c2], [
      request('r1', north, { contract_id: 'c1' }),
      request('r2', north, { amendment_id: 'd1' }),
      request('r3', north),
    ])
    assert.deepEqual(objects.map(o => o.name), ['БЦ Восток', 'ЖК Северный'], 'свежие выше; другие объекты не появляются')
    const [e, n] = objects
    assert.deepEqual(e.groups.map(g => g.root.id), ['c2'])
    assert.deepEqual(n.groups.map(g => g.root.id), ['c1'])
    // ДС — под договором, хотя объект у него указан другой.
    assert.deepEqual(n.groups[0].children.map(c => c.doc.id), ['d1'])
    assert.deepEqual(n.groups[0].requests.map(r => r.id), ['r1', 'r2'], 'заявка находит договор и через своё ДС')
    assert.deepEqual(n.loose.map(r => r.id), ['r3'], 'заявка без договора — в своём объекте')
    assert.deepEqual(n.counts, { contracts: 1, amendments: 1, requests: 3 })
    assert.deepEqual(e.counts, { contracts: 1, amendments: 0, requests: 0 })
  })

  it('объект есть только у заявки; без объекта — в конце, а не теряется', () => {
    const objects = buildObjectTree(
      [contract('c1', null, { contract_date: '2026-06-01' })],
      [request('r1', east, { created_at: '2025-01-01T00:00:00Z' }), request('r2', null)],
    )
    assert.deepEqual(objects.map(o => [o.key, o.name]), [['o-e', 'БЦ Восток'], ['', '']])
    assert.deepEqual(objects[0].loose.map(r => r.id), ['r1'])
    assert.deepEqual(objects[1].groups.map(g => g.root.id), ['c1'])
    assert.deepEqual(objects[1].loose.map(r => r.id), ['r2'])
  })

  it('договор заявки вне договоров контрагента — строка дерева; удалённый — заявка «без договора»', () => {
    const foreign = contract('c8', north)
    const removed = contract('c9', north, { deleted_at: '2026-01-01' })
    const objects = buildObjectTree([], [
      request('r1', east, { contract_id: 'c8' }),
      request('r2', east, { contract_id: 'c9' }),
      request('r3', east, { contract_id: 'gone' }),
    ], new Map([['c8', foreign], ['c9', removed]]))
    assert.deepEqual(objects.map(o => o.name), ['БЦ Восток', 'ЖК Северный'])
    const byName = new Map(objects.map(o => [o.name, o]))
    assert.deepEqual(byName.get('ЖК Северный').groups.map(g => [g.root.id, g.requests.map(r => r.id)]), [['c8', ['r1']]])
    assert.deepEqual(byName.get('БЦ Восток').loose.map(r => r.id), ['r2', 'r3'])
  })

  it('пусто — пустое дерево; ДС без договора считается как ДС', () => {
    assert.deepEqual(buildObjectTree(), [])
    const [only] = buildObjectTree([contract('d9', north, { record_type: 'ds_vor', parent_contract_id: 'gone', root_contract_id: 'gone' })])
    assert.deepEqual(only.counts, { contracts: 0, amendments: 1, requests: 0 })
  })
})

describe('Выбор договора для «Прикрепить договор»', () => {
  const choices = [
    { id: 'a', contract_number: 'П-15/26', work_name: 'Устройство фасада', objects: { name: 'ЖК Северный' }, counterparties: { name: 'ООО «Фасад»' } },
    { id: 'b', contract_number: 'Т-7', work_name: 'Кровля', objects: { name: 'БЦ Восток' }, counterparties: { name: 'ООО «Кровля-Сервис»' } },
    { id: 'c', contract_number: 'Л-3', work_name: null, objects: null, counterparties: null },
  ]
  const ids = (list) => list.map(c => c.id)

  it('каждое слово — в номере, предмете, объекте или контрагенте, в любом порядке, без учёта регистра', () => {
    assert.deepEqual(ids(searchContractChoices(choices, 'п-15', new Set())), ['a'])
    assert.deepEqual(ids(searchContractChoices(choices, 'восток кровля', new Set())), ['b'])
    assert.deepEqual(ids(searchContractChoices(choices, 'фасад северный', new Set())), ['a'])
    // Слово из одного договора, второе — из другого: не совпадение.
    assert.deepEqual(ids(searchContractChoices(choices, 'фасад восток', new Set())), [])
    // Пустых полей не боится.
    assert.deepEqual(ids(searchContractChoices(choices, 'л-3', new Set())), ['c'])
  })

  it('пустой запрос — ничего; показанные в разделе — не предлагаются; не больше предела', () => {
    assert.deepEqual(searchContractChoices(choices, '   ', new Set()), [])
    assert.deepEqual(ids(searchContractChoices(choices, 'ооо', new Set(['a']))), ['b'])
    assert.deepEqual(ids(searchContractChoices(choices, 'ооо', new Set(), 1)), ['a'])
  })
})
