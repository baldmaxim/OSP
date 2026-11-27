// Реестр «Реестр по договорам» (/contracts/registry): вкладки статусов и счётчики для вида «Документ».
// Раньше «Договоры и ДС» считали одни договоры — то же число, что «Договоры», а ДС «В работе» к
// завершённому договору на вкладке «В работе» не было видно вовсе.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TAB_KEYS, kindCounts, registryCounts, registryRows, signalReviewCount, signalReviewCountShown, signalReviewIds } from '../../src/utils/contractRegistryTabs.js'
import { docTender, tenderChoices, tenderOptionLabel, tenderTitle } from '../../src/utils/contractTender.js'

const doc = (id, over = {}) => ({
  id, display_id: Number(id.replace(/\D/g, '')) || 0, record_type: 'dp', status: 'in_work',
  parent_contract_id: null, root_contract_id: null, deleted_at: null, handled_by_us: true, ...over,
})
const ds = (id, root, over = {}) => doc(id, { record_type: 'ds_extra', parent_contract_id: root, root_contract_id: root, ...over })

const DOCS = [
  doc('k1', { status: 'completed' }),
  ds('d12', 'k1', { status: 'in_work' }),
  ds('d11', 'k1', { status: 'completed' }),
  ds('d13', 'k1', { status: 'new_request', deleted_at: '2026-10-01' }),
  doc('k2', { status: 'in_work', handled_by_us: false }),
  ds('d21', 'k2', { status: 'in_work', handled_by_us: false }),
  // ДС к ДС без root_contract_id — договор ищется по родителям.
  ds('d22', 'd21', { root_contract_id: null, status: 'paused' }),
  doc('k3', { status: 'new_request', deleted_at: '2026-10-02' }),
  ds('d31', 'k3', { status: 'in_work' }),
  // Договор не загружен.
  ds('d99', 'k-missing', { status: 'in_work' }),
]

const ids = (list) => list.map(d => d.id).sort()

describe('счётчики', () => {
  it('«Договоры и ДС» = «Договоры» + «ДС» на каждой вкладке и в каждом охвате', () => {
    for (const scope of ['all', 'ours']) {
      const all = registryCounts(DOCS, { docKind: 'all', scope })
      const contracts = registryCounts(DOCS, { docKind: 'contracts', scope })
      const amendments = registryCounts(DOCS, { docKind: 'amendments', scope })
      for (const k of TAB_KEYS) assert.equal(all.tabs[k], contracts.tabs[k] + amendments.tabs[k], `${scope}/${k}`)
      for (const k of ['all', 'ours']) assert.equal(all.scopes[k], contracts.scopes[k] + amendments.scopes[k], k)
    }
  })

  it('каждый документ — по своему статусу', () => {
    const { tabs, scopes } = registryCounts(DOCS, { docKind: 'all', scope: 'all' })
    assert.equal(tabs.all, 8)
    assert.equal(tabs.in_work, 5) // k2, d12, d21, d31, d99
    assert.equal(tabs.completed, 2) // k1, d11
    assert.equal(tabs.paused, 1)
    assert.equal(tabs.deleted, 2) // k3, d13
    assert.deepEqual(scopes, { all: 8, ours: 6 })
    assert.equal(registryCounts(DOCS, { docKind: 'contracts', scope: 'all' }).tabs.all, 2)
  })
})

// Вкладки вида документа (11.11.2026: вкладки «Все» нет — её число теперь у «Договоров и ДС»): то же, что счётчик статуса
// выбранного вида, при любом статусе, охвате и отделе.
describe('числа вида документа', () => {
  it('совпадают со счётчиком статуса своего вида; «Договоры и ДС» = договоры + ДС', () => {
    for (const scope of ['all', 'ours']) {
      for (const tab of TAB_KEYS) {
        const k = kindCounts(DOCS, { scope, tab })
        for (const docKind of ['all', 'contracts', 'amendments']) {
          assert.equal(k[docKind], registryCounts(DOCS, { docKind, scope }).tabs[tab], `${scope}/${tab}/${docKind}`)
        }
        assert.equal(k.all, k.contracts + k.amendments)
      }
    }
    assert.deepEqual(kindCounts(DOCS, { scope: 'all' }), { all: 8, contracts: 2, amendments: 6 })
    assert.deepEqual(kindCounts(DOCS, { scope: 'all', tab: 'in_work' }), { all: 5, contracts: 1, amendments: 4 })
  })
})

describe('строки вкладки', () => {
  it('«Договоры» и «ДС» — документы своего вида, без вложенных', () => {
    const c = registryRows(DOCS, { docKind: 'contracts', scope: 'all', tab: 'in_work' })
    assert.deepEqual(ids(c.rows), ['k2'])
    assert.equal(c.nested.size, 0)
    const a = registryRows(DOCS, { docKind: 'amendments', scope: 'all', tab: 'in_work' })
    assert.deepEqual(ids(a.rows), ['d12', 'd21', 'd31', 'd99'])
  })

  it('ДС на вкладке — под своим договором, даже если договор в другом статусе', () => {
    const v = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'in_work' })
    // k1 — «Завершено», k3 — удалён: строки ради своих ДС; d99 без договора — своей строкой.
    assert.deepEqual(ids(v.rows), ['d99', 'k1', 'k2', 'k3'])
    assert.deepEqual([...v.context].sort(), ['k1', 'k3'])
    assert.deepEqual(ids(v.nested.get('k1')), ['d12'])
    assert.deepEqual(ids(v.nested.get('k2')), ['d21'])
    // Строки и вложенные ДС вкладки — ровно её счётчик плюс договоры-«контекст».
    const shown = v.rows.length - v.context.size + [...v.nested.values()].reduce((n, l) => n + l.length, 0)
    assert.equal(shown, registryCounts(DOCS, { docKind: 'all', scope: 'all' }).tabs.in_work)
  })

  it('«Все» — живые ДС по порядку; удалённое ДС живого договора — в «Удаленных» под ним', () => {
    const all = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'all' })
    assert.deepEqual(all.nested.get('k1').map(d => d.id), ['d11', 'd12'])
    assert.deepEqual(all.nested.get('k2').map(d => d.id), ['d21', 'd22'])
    assert.deepEqual([...all.context], ['k3'])
    const del = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'deleted' })
    assert.deepEqual(ids(del.rows), ['k1', 'k3'])
    assert.deepEqual([...del.context], ['k1'])
    assert.deepEqual(ids(del.nested.get('k1')), ['d13'])
  })

  it('«Наши договоры» — по своей отметке у договора и у ДС', () => {
    const v = registryRows(DOCS, { docKind: 'all', scope: 'ours', tab: 'all' })
    // k2 не наш, но его ДС d22 наше — договор строкой ради него.
    assert.deepEqual(ids(v.nested.get('k2')), ['d22'])
    assert.ok(v.context.has('k2'))
    assert.ok(!v.context.has('k1'))
  })
})

// «Сверка Signal» (23.11.2026): набор id (only) применяется ДО построения дерева. ДС с замечанием остаётся под своим договором,
// договор без замечаний показан один раз строкой «ради ДС» (context); число — по документам, без таких договоров.
describe('«Сверка Signal»: фильтр до дерева и число', () => {
  const marks = new Map([
    ['k1', { id: 'k1', state: 'verified' }],
    ['d12', { id: 'd12', state: 'conflict' }],
    ['d11', { id: 'd11', state: 'suggested' }],
    ['k2', { id: 'k2', state: 'attention' }],
    ['d21', { id: 'd21', state: 'unverified', pending: true }],
    ['d22', { id: 'd22', state: 'missing' }],
    ['d31', { id: 'd31', state: 'suggested', pending: true }],
    ['k3', { id: 'k3', state: 'none' }],
  ])

  it('набор: предложение, противоречие, папка не видна, файл удалён; сверено, не сверено, нет ссылки и «ожидает» — нет', () => {
    assert.deepEqual([...signalReviewIds(marks)].sort(), ['d11', 'd12', 'd22', 'k2'])
    assert.deepEqual([...signalReviewIds([{ id: 'a', state: 'suggested' }, { id: 'b', state: 'verified' }, null])], ['a'])
    assert.equal(signalReviewIds(null).size, 0)
  })

  it('ДС с замечанием — под своим договором; договор без замечаний — один раз «ради ДС»; ДС без замечаний не показан', () => {
    const only = signalReviewIds(marks)
    const v = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'all', only })
    // k1 — сверен (без замечаний), но у него ДС d11 и d12 с замечаниями; k2 — с замечанием, его d22 тоже; d21 — «ожидает».
    assert.deepEqual(ids(v.rows), ['k1', 'k2'])
    assert.deepEqual(v.nested.get('k1').map(d => d.id), ['d11', 'd12'])
    assert.deepEqual(v.nested.get('k2').map(d => d.id), ['d22'])
    assert.deepEqual([...v.context], ['k1'], 'k1 показан ради ДС, k2 — сам по себе')
    assert.equal(v.rows.filter(r => r.id === 'k1').length, 1)
    // Фильтр по массиву до вызова потерял бы договор ДС: d22 стал бы строкой без родителя.
    const naive = registryRows(DOCS.filter(d => only.has(d.id)), { docKind: 'all', scope: 'all', tab: 'all' })
    assert.ok(naive.rows.some(r => r.id === 'd12'), 'так нельзя: ДС потерял договор')
  })

  it('число — по документам вкладки (договор ради ДС не считается), вид документа, статус и «Наши» — как у строк', () => {
    const only = signalReviewIds(marks)
    const count = (o) => signalReviewCount(DOCS, only, { scope: 'all', tab: 'all', docKind: 'all', ...o })
    assert.equal(count(), 4)
    assert.equal(count({ docKind: 'contracts' }), 1, 'k2')
    assert.equal(count({ docKind: 'amendments' }), 3)
    // Вкладка «В работе»: k2 и d12; d22 — приостановлен, d11 — завершён.
    assert.equal(count({ tab: 'in_work' }), 2)
    assert.equal(count({ scope: 'ours' }), 3, 'k2 — не наш договор')
    assert.equal(signalReviewCount(DOCS, null, { scope: 'all', tab: 'all', docKind: 'all' }), 0)
    assert.equal(signalReviewCount(DOCS, new Set(), { scope: 'all', tab: 'all', docKind: 'all' }), 0)
    // Число совпадает со строками: договоры и ДС набора на вкладке минус договоры «ради ДС».
    const v = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'all', only })
    const docs = v.rows.length - v.context.size + [...v.nested.values()].reduce((n, l) => n + l.length, 0)
    assert.equal(docs, count())
  })

  it('без набора (only не задан) строки прежние', () => {
    const base = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'all' })
    const same = registryRows(DOCS, { docKind: 'all', scope: 'all', tab: 'all', only: null })
    assert.deepEqual(ids(same.rows), ids(base.rows))
    assert.deepEqual([...same.context], [...base.context])
  })
})

// С-8: число на «Сверке Signal» учитывает фильтры реестра (объект, поиск, контрагент…) — оно равно числу документов, которые
// покажет реестр при включённом переключателе. Договоры здесь — как в базе: у ДП root_contract_id = его id (триггер 20270122, С-14).
describe('«Сверка Signal»: число с фильтрами реестра (С-8)', () => {
  const dp = (id, over = {}) => doc(id, { root_contract_id: id, ...over })
  const DOCS2 = [
    dp('k1', { object_id: 'A', cp: 'x' }), ds('d11', 'k1', { object_id: 'A', cp: 'x' }), ds('d12', 'k1', { object_id: 'A', cp: 'x' }),
    dp('k2', { object_id: 'B', cp: 'y' }), ds('d21', 'k2', { object_id: 'B', cp: 'y' }),
    dp('k3', { object_id: 'A', cp: 'y' }),
    dp('k4', { object_id: 'B', cp: 'x' }),
  ]
  // В набор: ДС d11 и d12 (договор k1 — «ради ДС»), договор k2 и его ДС d21, договор k3. k4 — без замечаний.
  const only = new Set(['d11', 'd12', 'k2', 'd21', 'k3'])
  const view = registryRows(DOCS2, { docKind: 'all', scope: 'all', tab: 'all', only })
  const byField = (field, value) => (row) => row[field] === value

  it('без фильтров — как прежнее число по документам набора', () => {
    assert.equal(signalReviewCountShown(view, only), 5)
    assert.equal(signalReviewCountShown(view, only), signalReviewCount(DOCS2, only, { docKind: 'all', scope: 'all', tab: 'all' }))
  })

  it('объект: ДС и договор считаются, если прошла строка договора; договор «ради ДС» не считается', () => {
    assert.equal(signalReviewCountShown(view, only, byField('object_id', 'A')), 3, 'k1 (ради ДС): d11, d12; k3')
    assert.equal(signalReviewCountShown(view, only, byField('object_id', 'B')), 2, 'k2 и d21')
    assert.equal(signalReviewCountShown(view, only, byField('object_id', 'C')), 0)
  })

  it('поиск и контрагент: те же правила, число сходится с числом показанных документов', () => {
    const shownDocs = (rowOk) => {
      const v = registryRows(DOCS2, { docKind: 'all', scope: 'all', tab: 'all', only })
      const rows = v.rows.filter(rowOk)
      return rows.filter((r) => !v.context.has(r.id)).length + rows.reduce((n, r) => n + (v.nested.get(r.id) || []).length, 0)
    }
    for (const rowOk of [byField('cp', 'x'), byField('cp', 'y'), (r) => r.id === 'k2', () => false, () => true]) {
      assert.equal(signalReviewCountShown(view, only, rowOk), shownDocs(rowOk))
    }
    assert.equal(signalReviewCountShown(view, only, byField('cp', 'x')), 2, 'только d11 и d12 под k1')
  })

  it('виды «Договоры» и «ДС» — число по документам своего вида после фильтра', () => {
    const contracts = registryRows(DOCS2, { docKind: 'contracts', scope: 'all', tab: 'all', only })
    const amendments = registryRows(DOCS2, { docKind: 'amendments', scope: 'all', tab: 'all', only })
    assert.equal(signalReviewCountShown(contracts, only), 2, 'k2, k3')
    assert.equal(signalReviewCountShown(amendments, only), 3, 'd11, d12, d21')
    assert.equal(signalReviewCountShown(contracts, only, byField('object_id', 'A')), 1)
    assert.equal(signalReviewCountShown(amendments, only, byField('object_id', 'A')), 2)
  })

  it('нет набора или он пуст — 0', () => {
    assert.equal(signalReviewCountShown(view, null), 0)
    assert.equal(signalReviewCountShown(view, new Set()), 0)
    assert.equal(signalReviewCountShown(null, only), 0)
  })

  it('ДП с root_contract_id = id остаётся договором: ДС находит его, сам он не становится ДС', () => {
    const v = registryRows(DOCS2, { docKind: 'all', scope: 'all', tab: 'all' })
    assert.deepEqual(v.nested.get('k1').map((d) => d.id), ['d11', 'd12'])
    assert.ok(!v.nested.has('k3') && v.rows.some((r) => r.id === 'k3'))
  })
})

describe('«В работе» объединяет незавершённую работу (03.11)', () => {
  const statuses = ['new_request', 'in_work', 'awaiting_paper_sign', 'pending', null]
  it('новая заявка, в работе, ожидание подписания и статус вне справочника — на одной вкладке, ни один не теряется', () => {
    const docs = statuses.map((status, i) => doc(`s${i}`, { status }))
    assert.equal(registryCounts(docs, { docKind: 'all', scope: 'all' }).tabs.in_work, statuses.length)
    assert.deepEqual(ids(registryRows(docs, { docKind: 'all', scope: 'all', tab: 'in_work' }).rows), docs.map(d => d.id).sort())
  })
  it('приостановка и завершённые — на своих вкладках; вместе с «В работе» дают весь реестр', () => {
    const docs = [...statuses, 'paused', 'completed'].map((status, i) => doc(`s${i}`, { status }))
    const { tabs } = registryCounts(docs, { docKind: 'all', scope: 'all' })
    assert.deepEqual([tabs.in_work, tabs.paused, tabs.completed, tabs.all], [5, 1, 1, 7])
    assert.equal(tabs.in_work + tabs.paused + tabs.completed, tabs.all)
  })
})

describe('отдел ОС / ГО — по объекту документа', () => {
  const OS = { status: 'main_construction' }
  const GO = { status: 'warranty_service' }
  const DEPT_DOCS = [
    doc('o1', { objects: OS, status: 'in_work' }),
    ds('o2', 'o1', { objects: OS, status: 'completed' }),
    doc('g1', { objects: GO, status: 'completed' }),
    doc('g2', { objects: GO, status: 'in_work', handled_by_us: false }),
    // Объект не указан или не загружен — только в «Все договоры»: прятать документ нельзя.
    doc('x1', { objects: null, status: 'in_work', handled_by_us: false }),
    doc('o3', { objects: OS, status: 'in_work', deleted_at: '2026-10-01' }),
  ]

  it('счётчики отделов и вкладок', () => {
    const all = registryCounts(DEPT_DOCS, { docKind: 'all', scope: 'all', dept: 'all' })
    assert.deepEqual(all.depts, { all: 5, main_construction: 2, warranty_service: 2 })
    const go = registryCounts(DEPT_DOCS, { docKind: 'all', scope: 'all', dept: 'warranty_service' })
    assert.deepEqual([go.tabs.all, go.tabs.in_work, go.tabs.completed, go.tabs.deleted], [2, 1, 1, 0])
    assert.deepEqual(go.scopes, { all: 2, ours: 1 })
    // Отделы — с учётом «Наших договоров».
    assert.deepEqual(registryCounts(DEPT_DOCS, { docKind: 'all', scope: 'ours', dept: 'all' }).depts, { all: 3, main_construction: 2, warranty_service: 1 })
  })

  it('строки и ДС — своего отдела', () => {
    const os = registryRows(DEPT_DOCS, { docKind: 'all', scope: 'all', tab: 'all', dept: 'main_construction' })
    assert.deepEqual(ids(os.rows), ['o1'])
    assert.deepEqual(os.nested.get('o1').map(d => d.id), ['o2'])
    const go = registryRows(DEPT_DOCS, { docKind: 'all', scope: 'all', tab: 'all', dept: 'warranty_service' })
    assert.deepEqual(ids(go.rows), ['g1', 'g2'])
    assert.equal(go.nested.size, 0)
    // Без отдела — как раньше, документ без объекта на месте.
    assert.ok(ids(registryRows(DEPT_DOCS, { docKind: 'all', scope: 'all', tab: 'all' }).rows).includes('x1'))
  })
})

describe('тендер договора и ДС', () => {
  const contract = doc('t1', { tender_id: 'T', tenders: { public_tender_number: 77, work_description: 'Кровля' } })
  const own = ds('t3', 't1', { tender_id: 'T2', tenders: { public_tender_number: 80, work_description: 'Фасад' } })
  const inheriting = ds('t2', 't1')
  const deep = ds('t4', 't2', { root_contract_id: null })
  const orphan = ds('t5', 'нет такого')
  const none = doc('t6')
  const byId = new Map([contract, own, inheriting, deep, orphan, none].map(d => [d.id, d]))

  it('ДС без своего тендера берёт тендер договора, в том числе через другое ДС', () => {
    assert.deepEqual(docTender(contract, byId), { id: 'T', number: 77, description: 'Кровля', inherited: false })
    assert.deepEqual(docTender(inheriting, byId), { id: 'T', number: 77, description: 'Кровля', inherited: true })
    assert.equal(docTender(deep, byId).id, 'T')
  })
  it('своё значение ДС важнее; нет ни у кого — null', () => {
    assert.equal(docTender(own, byId).id, 'T2')
    assert.equal(docTender(own, byId).inherited, false)
    assert.equal(docTender(none, byId), null)
    assert.equal(docTender(orphan, byId), null)
  })
  it('подписи', () => {
    assert.equal(tenderTitle({ number: 77 }), 'Тендер № 77')
    assert.equal(tenderTitle({ number: null }), 'Тендер')
    assert.equal(tenderOptionLabel({ public_tender_number: 5, work_description: ' Кровля ' }), '№ 5 · Кровля')
    assert.equal(tenderOptionLabel({ public_tender_number: null, work_description: '' }), 'без номера · описания нет')
    assert.ok(tenderOptionLabel({ public_tender_number: 5, work_description: 'я'.repeat(500) }).length < 160)
  })
  it('в выборе — основные живые тендеры объекта; выбранный остаётся любым', () => {
    const list = [
      { id: 'main', object_id: 'o1' },
      { id: 'other', object_id: 'o2' },
      { id: 'mat', object_id: 'o1', parent_tender_id: 'main' },
      { id: 'gone', object_id: 'o1', deleted_at: '2026-01-01' },
    ]
    const got = (o) => tenderChoices(list, o).map(t => t.id)
    assert.deepEqual(got({ objectId: 'o1' }), ['main'])
    assert.deepEqual(got({ objectId: '' }), ['main', 'other'])
    assert.deepEqual(got({ objectId: 'o1', selectedId: 'mat' }), ['main', 'mat'])
    assert.deepEqual(got({ objectId: 'o1', selectedId: 'gone' }), ['main', 'gone'])
  })
})
