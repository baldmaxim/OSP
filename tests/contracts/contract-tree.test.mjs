// «Дерево договоров» (/contracts/tree, эксперимент 12.11.2026): куда встаёт каждая заявка, что остаётся «без договора»
// и что подсказывается. Связи проверок и заявок на ДП в базе пока нет — они ищутся только однозначно; лишняя связь
// хуже пропущенной: заявка встала бы в чужой договор.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContractTree, contractRefOf, indexContracts, matchCheck, matchDc, matchDp, rootRequests, stepsOf, suggestTargets,
} from '../../src/utils/contractTree.js'
import { makeDemoData, nextDemoContractNumber } from '../../src/utils/contractTreeDemo.js'

const contract = (id, over = {}) => ({
  id, record_type: 'dp', contract_number: '', object_id: 'o1', counterparty_id: 'cp1', parent_contract_id: null,
  root_contract_id: null, deleted_at: null, contract_counterparties: [], ...over,
})
const ds = (id, root, number, over = {}) => contract(id, {
  record_type: 'ds_extra', parent_contract_id: root, root_contract_id: root, contract_number: number, counterparty_id: null, ...over,
})

describe('номер договора из текста заявки', () => {
  it('«к ДП №», «к Договору №», косая перед «к»', () => {
    assert.equal(contractRefOf('ООО «ГК «Олимпроект»/ ДС№8 к ДП №152/22-ГК Исполнители: …'), '152/22-ГК')
    assert.equal(contractRefOf('Геофасадпроект / ДС № 1 к Договору № 261П-26 от 25.05.26'), '261П-26')
    assert.equal(contractRefOf('ООО СМУ-9/ДС №2 к ДП №СУ2-ВЭЙВ-СП-Э015-12'), 'СУ2-ВЭЙВ-СП-Э015-12')
  })
  it('нет ссылки — пусто', () => {
    assert.equal(contractRefOf('ИП Кабанов Е. Н./ДС № 4'), '')
    assert.equal(contractRefOf(''), '')
  })
})

describe('проверка ДП/ДС → договор или ДС', () => {
  const docs = [
    contract('c1', { contract_number: 'СУ2-ЗИЛ-12' }),
    contract('c2', { contract_number: 'СУ2-ЗИЛ-13' }),
    ds('c1-1', 'c1', '1'),
    ds('c1-2', 'c1', '2'),
    ds('c2-1', 'c2', '1'),
    contract('c3', { contract_number: 'СУ2-ЗИЛ-12', counterparty_id: 'cp2' }),
  ]
  const idx = indexContracts(docs)

  it('поле договора важнее всего', () => {
    assert.deepEqual(matchCheck({ contract_id: 'c2', doc_type: 'dp', counterparty_id: 'cp1' }, idx), { targetId: 'c2', how: 'field' })
  })
  it('ДП — по контрагенту и номеру без пробелов и дефисов', () => {
    const m = matchCheck({ doc_type: 'dp', counterparty_id: 'cp1', object_id: 'o1', doc_number: 'су2 зил 12' }, idx)
    assert.deepEqual(m, { targetId: 'c1', how: 'number' })
  })
  it('другой контрагент с тем же номером — свой договор', () => {
    const m = matchCheck({ doc_type: 'dp', counterparty_id: 'cp2', object_id: 'o1', doc_number: 'СУ2-ЗИЛ-12' }, idx)
    assert.equal(m.targetId, 'c3')
  })
  it('другой объект — не тот договор', () => {
    assert.equal(matchCheck({ doc_type: 'dp', counterparty_id: 'cp1', object_id: 'o2', doc_number: 'СУ2-ЗИЛ-12' }, idx), null)
  })
  it('ДС № 1 у двух договоров контрагента — неоднозначно, без связи', () => {
    assert.equal(matchCheck({ doc_type: 'ds', counterparty_id: 'cp1', object_id: 'o1', doc_number: '1' }, idx), null)
  })
  it('ДС № 2 — одно на объекте: связь с ДС (контрагент — от договора)', () => {
    assert.deepEqual(matchCheck({ doc_type: 'ds', counterparty_id: 'cp1', object_id: 'o1', doc_number: 'ДС № 2' }, idx),
      { targetId: 'c1-2', how: 'number' })
  })
  it('номер договора в примечании снимает неоднозначность', () => {
    const m = matchCheck({ doc_type: 'ds', counterparty_id: 'cp1', object_id: 'o1', doc_number: '1', notes: 'ДС № 1 к ДП № СУ2-ЗИЛ-13' }, idx)
    assert.deepEqual(m, { targetId: 'c2-1', how: 'notes' })
  })
  it('договор из примечания есть, ДС нет в реестре — проверка на договоре с пометкой', () => {
    const m = matchCheck({ doc_type: 'ds', counterparty_id: 'cp1', object_id: 'o1', doc_number: '5', notes: 'к ДП № СУ2-ЗИЛ-13' }, idx)
    assert.deepEqual(m, { targetId: 'c2', how: 'notes', missingDs: '5' })
  })
  it('без контрагента — не ищем', () => {
    assert.equal(matchCheck({ doc_type: 'dp', doc_number: 'СУ2-ЗИЛ-13' }, idx), null)
  })
})

describe('заявка на ДС и заявка на ДП', () => {
  const idx = indexContracts([contract('c1'), ds('c1-3', 'c1', '3'), contract('c9', { contract_number: 'ПРП-ДП-26-009', object_id: 'o2' })])
  it('ДС из заявки — его узел; без ДС — договор; ДС с тем же номером — оно', () => {
    assert.deepEqual(matchDc({ contract_id: 'c1', amendment_id: 'c1-3' }, idx), { targetId: 'c1-3', how: 'field' })
    assert.deepEqual(matchDc({ contract_id: 'c1', ds_number: '7' }, idx), { targetId: 'c1', how: 'field' })
    assert.deepEqual(matchDc({ contract_id: 'c1', ds_number: 'ДС №3' }, idx), { targetId: 'c1-3', how: 'number' })
    assert.equal(matchDc({ contract_id: null }, idx), null)
    assert.equal(matchDc({ contract_id: 'удалён' }, idx), null)
  })
  it('заявка на ДП — поле или номер договора, вписанный отделом', () => {
    assert.deepEqual(matchDp({ contract_id: 'c1' }, idx), { targetId: 'c1', how: 'field' })
    assert.deepEqual(matchDp({ contract_title: 'прп-дп-26-009', object_id: 'o2' }, idx), { targetId: 'c9', how: 'title' })
    assert.equal(matchDp({ contract_title: 'ПРП-ДП-26-009', object_id: 'o1' }, idx), null)
    assert.equal(matchDp({ contract_title: '' }, idx), null)
  })
})

describe('дерево', () => {
  it('ДС — под договором, заявки — под своим документом, основание — отдельно', () => {
    const tree = buildContractTree({
      contracts: [contract('c1', { contract_number: 'A-1' }), ds('c1-1', 'c1', '1'), contract('c2')],
      dcRequests: [{ id: 'r1', status: 'in_work', contract_id: 'c1', amendment_id: 'c1-1' }, { id: 'r2', status: 'contract_check', contract_id: 'c1' }],
      checks: [{ id: 'k1', status: 'signal', doc_type: 'dp', counterparty_id: 'cp1', object_id: 'o1', doc_number: 'A-1' }],
      dpRequests: [{ id: 'p1', status: 'completed', contract_id: 'c1' }, { id: 'p2', status: 'draft' }],
    })
    assert.deepEqual(tree.roots.map((r) => r.key), ['c1', 'c2'])
    const c1 = tree.roots[0]
    assert.deepEqual(c1.ds.map((n) => n.doc.id), ['c1-1'])
    assert.deepEqual(c1.ds[0].requests.map((r) => r.key), ['dc:r1'])
    assert.deepEqual(c1.node.requests.map((r) => r.key).sort(), ['check:k1', 'dc:r2'])
    assert.deepEqual(c1.node.basis.map((r) => r.key), ['dp:p1'])
    assert.equal(c1.stats.total, 4)
    assert.equal(c1.stats.active, 3)
    assert.equal(rootRequests(c1).length, 4)
    assert.equal(tree.items.has('dp:p2'), false, 'черновик заявки на ДП не показывается')
  })
  it('удалённые заявки и копии «Проверки документов» (tax_clause) не попадают', () => {
    const tree = buildContractTree({
      contracts: [contract('c1')],
      checks: [{ id: 'k1', status: 'tax_clause', contract_id: 'c1' }, { id: 'k2', status: 'new', contract_id: 'c1', deleted_at: '2026-11-01' }],
    })
    assert.equal(tree.items.size, 0)
  })
  it('ручная привязка в браузере важнее поиска; ссылка на исчезнувший договор не держит заявку', () => {
    const contracts = [contract('c1', { contract_number: 'X' }), contract('c2')]
    const checks = [{ id: 'k1', status: 'new', doc_type: 'dp', counterparty_id: 'cp1', object_id: 'o1', doc_number: 'X' }]
    let tree = buildContractTree({ contracts, checks, links: { 'check:k1': 'c2' } })
    assert.deepEqual(tree.items.get('check:k1').link, { targetId: 'c2', how: 'local' })
    tree = buildContractTree({ contracts, checks, links: { 'check:k1': 'нет такого' } })
    assert.equal(tree.items.get('check:k1').link.targetId, 'c1')
  })
  it('ДС, договора которого нет, — своей строкой', () => {
    const tree = buildContractTree({ contracts: [ds('d1', 'нет', '4')] })
    assert.deepEqual(tree.roots.map((r) => r.key), ['d1'])
  })
})

describe('этапы', () => {
  it('проверка: шесть шагов, «Ожидаем скан» — на месте ЭДО', () => {
    const s = stepsOf('check', 'signal')
    assert.equal(s.steps.length, 6)
    assert.equal(s.index, 3)
    assert.equal(stepsOf('check', 'awaiting_scan').index, 2)
    assert.equal(stepsOf('check', 'нечто').index, -1)
  })
  it('заявка на ДС — четыре, на ДП — три', () => {
    assert.equal(stepsOf('dc', 'check_result').index, 1)
    assert.equal(stepsOf('dc', 'completed').steps.length, 4)
    assert.equal(stepsOf('dp', 'in_work').index, 1)
  })
})

describe('пример страницы', () => {
  const tree = buildContractTree(makeDemoData())
  const byNumber = (n) => tree.roots.find((r) => r.doc.contract_number === n)

  it('есть каждый случай', () => {
    const full = byNumber('ПРП-ДП-26-001')
    assert.equal(full.node.basis.length, 1, 'основание — заявка на ДП')
    assert.equal(full.ds.length, 3, 'три ДС, одно — к другому ДС')
    assert.ok(full.ds.some((n) => n.doc.parent_contract_id !== full.doc.id), 'ДС к ДС')
    assert.ok(full.node.requests.some((r) => r.kind === 'dc'), 'заявка на ДС, по которой ДС ещё нет')
    assert.ok(full.stats.overdue > 0, 'просроченная проверка')
    assert.equal(byNumber('ПРС-ДП-25-014').stats.active, 0, 'всё завершено — без «в работе»')
    assert.equal(byNumber('ПРС-ДП-26-003').stats.total, 0, 'договор без веток')
    const statuses = new Set([...tree.items.values()].filter((i) => i.kind === 'check').map((i) => i.raw.status))
    for (const s of ['new', 'in_progress', 'awaiting_scan', 'signal', 'done']) assert.ok(statuses.has(s), `проверка «${s}»`)
  })
  it('без договора: заявки на ДП ждут договора, у заявки на ДС и проверок — подсказки', () => {
    assert.deepEqual(tree.loose.dp.map((i) => i.active), [true, true])
    assert.equal(tree.loose.dc.length, 1)
    assert.equal(suggestTargets(tree.loose.dc[0], tree.idx)[0].doc.contract_number, 'ПРП-ДП-26-001')
    const done = tree.loose.check.filter((i) => !i.active)
    assert.equal(done.length, 1, 'завершённая без договора — под «ещё N завершённых»')
    for (const item of tree.loose.check) assert.ok(suggestTargets(item, tree.idx).length > 0, item.key)
  })
  it('следующий номер по нумерации объекта', () => {
    const yy = String(new Date().getFullYear()).slice(-2)
    assert.equal(nextDemoContractNumber(makeDemoData().contracts, 'demo-obj-park'), `ПРП-ДП-${yy}-003`)
  })
})
