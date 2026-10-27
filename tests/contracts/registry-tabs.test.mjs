// Реестр «Договоры и ДС» (/contracts): вкладки статусов и счётчики для вида «Документ».
// Раньше «Договоры и ДС» считали одни договоры — то же число, что «Договоры», а ДС «В работе» к
// завершённому договору на вкладке «В работе» не было видно вовсе.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TAB_KEYS, registryCounts, registryRows } from '../../src/utils/contractRegistryTabs.js'

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
    assert.equal(tabs.requests, 0)
    assert.equal(tabs.deleted, 2) // k3, d13
    assert.deepEqual(scopes, { all: 8, ours: 6 })
    assert.equal(registryCounts(DOCS, { docKind: 'contracts', scope: 'all' }).tabs.all, 2)
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

  it('«Общий реестр» — живые ДС по порядку; удалённое ДС живого договора — в «Удаленных» под ним', () => {
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
