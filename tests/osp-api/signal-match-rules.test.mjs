// Сопоставитель OSP ↔ SIGNAL: состояния, причины и правила итога (пакеты ПР-1, ПР-2 волны исправлений).
// Проверяется контракт: таблица состояний и причин (spec §1), единая причина «папка недоступна» (С-20), состояние accepted
// (В-1), мягкое и жёсткое противоречие (В-11, В-3, В-4), проверка узла перед подтверждением и неизменность границы объекта.
// Данные — только синтетика. Чистые функции, без базы и сети.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as M from '../../server/osp-api/src/lib/signalMatch.js'
import { numberKey } from '../../server/osp-api/src/shared/contractNumbering.js'

const id = (p, n) => `${p.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = id('a', 1)
const OBJ_A = id('b', 1)
const OBJ_B = id('b', 2)
const CP1 = id('e', 1)
const FOLDER_URL = 'https://signal.example.test/projects/{projectId}/folders/{folderId}'
const FILE_URL = 'https://signal.example.test/projects/{projectId}/files/{itemId}'
const FORMATS = [FOLDER_URL, FILE_URL]
const GEN = 7
const OBJECTS = [
  { id: OBJ_A, name: 'ЖК Альфа', code: 'АЛФ', aliases: [] },
  { id: OBJ_B, name: 'ЖК Другой', code: 'ЗИЛ', aliases: [] },
]

let seq = 0
const node = (name, extra = {}) => {
  const parentPath = extra.parentPath ?? 'Проект'
  return {
    nodeId: extra.nodeId || id('c', ++seq), projectId: PROJECT, sourceId: 1, kind: 'folder', parentId: null, name,
    path: extra.path ?? `${parentPath} / ${name}`, pathIds: [], objectId: OBJ_A, numberKeys: [], features: {}, nameNorm: '',
    observed: true, absentNights: 0, deleted: false, sourceEnabled: true, sourceReady: true, ...extra, parentPath: undefined,
  }
}
const child = (parent, name, extra = {}) => node(name, { parentPath: parent.path, pathIds: [...parent.pathIds, parent.nodeId], parentId: parent.nodeId, ...extra })
const urlOf = (n) => M.buildSignalUrl(FOLDER_URL, { projectId: n.projectId, nodeId: n.nodeId })
const fileUrlOf = (n) => M.buildSignalUrl(FILE_URL, { projectId: n.projectId, nodeId: n.nodeId })
const NUM = 'АЛФ-ДП-26-001'
const dp = (number = NUM, extra = {}) => ({
  id: id('d', 1), recordType: 'dp', number, numberKey: numberKey(number), objectId: OBJ_A, parentId: null, rootId: null, signalLink: null,
  deleted: false, counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn: null }], family: { dp: null, cycle: false }, candidates: [],
  revision: 1, stateVersion: 0, state: null, ...extra,
})
const ds = (parent, number, extra = {}) => ({
  ...dp(number, { id: id('d', 2), recordType: 'ds_vor', numberKey: null, parentId: parent.id, rootId: parent.id }),
  family: { dp: { id: parent.id, number: parent.number, numberKey: parent.numberKey, objectId: parent.objectId, signalLink: parent.signalLink, nodeId: null, deleted: false }, cycle: false },
  ...extra,
})
const label = (r) => `${r.state}:${r.reason}`

// Инварианты каждого ответа: пара state:reason из таблицы; скрытые причины не выдают узел; кандидат всегда из границы объекта.
const NO_NODE = new Set(['unsupported_url', 'unavailable', 'no_snapshot', 'no_object'])
function run(contract, nodes, extra = {}, opts = {}) {
  const res = M.matchContract({ ...contract, nodes, objects: OBJECTS, ...extra }, { formats: FORMATS, generation: GEN, ...opts })
  assert.ok(M.STATE_REASONS[res.state]?.includes(res.reason), `${label(res)} вне таблицы`)
  assert.ok(M.STATES[res.state] && M.REASONS[res.reason])
  if (NO_NODE.has(res.reason)) assert.equal(res.nodeId, null, `${res.reason}: узел не выдаётся`)
  for (const c of res.candidates) {
    const n = nodes.find((x) => x.nodeId === c.nodeId)
    assert.ok(n && n.objectId === contract.objectId && n.kind === 'folder' && n.observed && n.sourceEnabled && n.sourceReady, 'кандидат вне границы объекта')
    for (const r of c.reasons) assert.ok(M.MATCH_REASONS[r], r)
    for (const f of c.flags) assert.ok(M.MATCH_FLAGS[f], f)
  }
  assert.match(res.fingerprint, /^[0-9a-f]{32}$/)
  assert.match(res.ctxKey, /^[0-9a-f]{32}$/)
  return res
}
const evaluate = (contract, nodes, nodeId, opts = {}) => M.evaluateNode({ ...contract, nodes, objects: OBJECTS }, nodeId, { generation: GEN, ...opts })

describe('Таблица состояний и причин (spec §1)', () => {
  it('набор пар state:reason ровно как в спецификации', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(M.STATE_REASONS).map(([k, v]) => [k, [...v]])), {
      none: ['none', 'unlinked', 'no_object'],
      suggested: ['candidates'],
      verified: ['existing_url', 'confirmed'],
      accepted: ['number_not_found'],
      unverified: ['unsupported_url', 'unavailable', 'no_snapshot', 'not_observed', 'no_object', 'pending'],
      attention: ['not_visible', 'file_not_visible', 'building_mismatch', 'kind_mismatch'],
      missing: ['deleted'],
      conflict: ['number_mismatch', 'object_mismatch', 'ambiguous', 'foreign_dp', 'ds_mismatch', 'foreign_party'],
    })
  })

  it('у каждого состояния и причины есть текст; удалённые причины отсутствуют', () => {
    for (const [state, reasons] of Object.entries(M.STATE_REASONS)) {
      assert.ok(M.STATES[state], state)
      for (const r of reasons) assert.ok(M.REASONS[r], r)
    }
    for (const gone of ['family_unknown', 'outside_roots', 'root_disabled', 'not_in_snapshot', 'object_unassigned']) assert.ok(!(gone in M.REASONS), gone)
    assert.ok(!M.STATE_REASONS.conflict.includes('building_mismatch') && !M.STATE_REASONS.conflict.includes('kind_mismatch'))
    assert.equal(M.STATES.accepted, 'Ссылка принята, номер в папке не найден')
    assert.equal(M.REASONS.number_not_found, 'Ссылка принята, номер в папке не найден')
    assert.equal(M.REASONS.unavailable, 'Папка недоступна для сверки')
    assert.equal(M.REASONS.no_object, 'У договора не указан объект')
    assert.equal(M.REASONS.file_not_visible, 'Файл не виден в Signal')
    assert.equal(M.REASONS.ds_mismatch, 'Номер ДС не совпал с номером в названии папки')
    assert.equal(M.REASONS.kind_mismatch, 'Папка относится к допсоглашению — проверьте')
    assert.equal(M.REASONS.foreign_party, 'В названии папки ИНН другой организации')
    assert.deepEqual(Object.keys(M.MATCH_FLAGS), ['similar', 'building_mismatch', 'kind_mismatch', 'previously_rejected', 'previously_unlinked'])
    assert.equal(M.MATCH_FLAGS.kind_mismatch, 'Папка допсоглашения, а не договора — проверьте')
  })
})

describe('С-20: все недоступные узлы — одна причина «папка недоступна»', () => {
  const link = (nd, extra = {}) => dp(NUM, { signalLink: urlOf(nd), ...extra })
  const cases = {
    'узел другого объекта': (nd) => [{ ...nd, objectId: OBJ_B }, {}],
    'узел без объекта': (nd) => [{ ...nd, objectId: null }, {}],
    'корень выключен': (nd) => [{ ...nd, sourceEnabled: false }, {}],
    'корень не готов': (nd) => [{ ...nd, sourceReady: false }, {}],
    'проект вне списка корней': (nd) => [nd, { rootProjectIds: [id('a', 2)] }],
    'узел другого проекта': (nd) => [{ ...nd, projectId: id('a', 3) }, {}],
    'ссылка на файл при узле-папке': (nd) => [{ ...nd, kind: 'item' }, {}],
  }
  for (const [what, make] of Object.entries(cases)) {
    it(`${what} → unverified:unavailable, без узла и пути`, () => {
      const base = node('ПРИМ-ДП-26-001 ООО Чужая')
      const [nd, extra] = make(base)
      const r = run(link(base), [nd], extra)
      assert.equal(label(r), 'unverified:unavailable')
      assert.equal(r.nodeId, null)
      assert.ok(!JSON.stringify(r).includes('Чужая'))
    })
  }

  it('узла нет в снимке: поколение есть — unavailable, снимка ещё нет — no_snapshot; неподдержанный формат — unsupported_url', () => {
    const ghost = node('Призрак')
    assert.equal(label(run(link(ghost), [])), 'unverified:unavailable')
    assert.equal(label(run(link(ghost), [], {}, { generation: 0 })), 'unverified:no_snapshot')
    assert.equal(label(run(dp(NUM, { signalLink: 'https://elsewhere.test/x' }), [])), 'unverified:unsupported_url')
  })

  it('evaluateNode: недоступный узел не подтверждается и причина — unavailable', () => {
    const nd = { ...node('АЛФ-ДП-26-001'), objectId: OBJ_B }
    const e = evaluate(dp(), [nd], nd.nodeId)
    assert.deepEqual([e.state, e.reason, e.confirmable, e.warning, e.nodeId], ['unverified', 'unavailable', false, null, null])
    assert.equal(evaluate(dp(), [], id('c', 12345)).reason, 'unavailable')
    assert.equal(evaluate(dp(), [], id('c', 12345), { generation: 0 }).reason, 'no_snapshot')
  })
})

describe('Состояния по введённой ссылке', () => {
  it('сверено / ссылка принята / предупреждение / противоречие — по одному узлу под каждое', () => {
    const own = node('АЛФ-ДП-26-001 ООО Ромашка')
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(own) }), [own])), 'verified:existing_url')
    const plain = node('Договора подряда')
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(plain) }), [plain])), 'accepted:number_not_found')
    const foreign = node('АЛФ-ДП-26-002 ООО Ромашка')
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(foreign) }), [foreign])), 'conflict:number_mismatch')
  })

  it('не виден в последнем обходе: меньше двух ночей — not_observed, две и больше — not_visible; для файла — file_not_visible', () => {
    const f = node('АЛФ-ДП-26-001', { observed: false, absentNights: 1 })
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(f) }), [f])), 'unverified:not_observed')
    const g = node('АЛФ-ДП-26-001', { observed: false, absentNights: 2 })
    const rg = run(dp(NUM, { signalLink: urlOf(g) }), [g])
    assert.equal(label(rg), 'attention:not_visible')
    assert.equal(rg.nodeId, g.nodeId)
    const item = node('АЛФ-ДП-26-001.pdf', { kind: 'item', observed: false, absentNights: 2 })
    assert.equal(label(run(dp(NUM, { signalLink: fileUrlOf(item) }), [item])), 'attention:file_not_visible')
    const young = node('АЛФ-ДП-26-001.pdf', { kind: 'item', observed: false, absentNights: 1 })
    assert.equal(label(run(dp(NUM, { signalLink: fileUrlOf(young) }), [young])), 'unverified:not_observed')
  })

  it('файл: удалён → missing:deleted (в своём объекте); чужого объекта — без утечки', () => {
    const del = node('АЛФ-ДП-26-001.pdf', { kind: 'item', deleted: true })
    const r = run(dp(NUM, { signalLink: fileUrlOf(del) }), [del])
    assert.deepEqual([label(r), r.nodeId], ['missing:deleted', del.nodeId])
    const alien = node('АЛФ-ДП-26-001.pdf', { kind: 'item', deleted: true, objectId: OBJ_B })
    const ra = run(dp(NUM, { signalLink: fileUrlOf(alien) }), [alien])
    assert.deepEqual([label(ra), ra.nodeId], ['unverified:unavailable', null])
  })

  it('файл: чужой номер в названии — conflict; свой — сверено; имя без номера — accepted', () => {
    const own = node('Договор АЛФ-ДП-26-001 подписан.pdf', { kind: 'item' })
    const wrong = node('Договор АЛФ-ДП-26-002 подписан.pdf', { kind: 'item' })
    const plain = node('Скан.pdf', { kind: 'item' })
    assert.equal(label(run(dp(NUM, { signalLink: fileUrlOf(own) }), [own])), 'verified:existing_url')
    assert.equal(label(run(dp(NUM, { signalLink: fileUrlOf(wrong) }), [wrong])), 'conflict:number_mismatch')
    assert.equal(label(run(dp(NUM, { signalLink: fileUrlOf(plain) }), [plain])), 'accepted:number_not_found')
  })

  it('все причины conflict достижимы; порядок: неоднозначность → номер/ДС → чужая сторона; вид — мягкое предупреждение', () => {
    const reach = (c, nd, others = []) => label(run({ ...c, signalLink: urlOf(nd) }, [nd, ...others]))
    assert.equal(reach(dp(NUM), node('АЛФ-ДП-26-001 и АЛФ-ДП-26-002')), 'conflict:ambiguous')
    assert.equal(reach(dp(NUM), node('АЛФ-ДП-26-002')), 'conflict:number_mismatch')
    assert.equal(reach(dp(NUM), node('ЗИЛ-ДП-26-001')), 'conflict:object_mismatch')
    assert.equal(reach(dp(NUM), node('ДС 2 к АЛФ-ДП-26-001')), 'attention:kind_mismatch')
    assert.equal(reach(dp(NUM), node('ДС 2 к АЛФ-ДП-26-002')), 'conflict:number_mismatch')
    const dpF = node('АЛФ-ДП-26-001 Ромашка')
    const sub = child(dpF, 'ДС 2')
    const dsc = ds(dp(NUM, { signalLink: urlOf(dpF) }), 'ДС 1')
    assert.equal(reach(dsc, sub, [dpF]), 'conflict:ds_mismatch')
    const alien = child(dpF, 'ДС 1 к АЛФ-ДП-26-005')
    assert.equal(reach(dsc, alien, [dpF]), 'conflict:foreign_dp')
    // номер и вид главнее чужой стороны
    const inn = (nine) => { const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]; const d = [...nine].map(Number); return `${nine}${(d.reduce((s, x, i) => s + x * w[i], 0) % 11) % 10}` }
    const c = dp(NUM, { counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn: inn('781000001') }] })
    assert.equal(reach(c, node(`АЛФ-ДП-26-002 ИНН ${inn('782000002')}`)), 'conflict:number_mismatch')
    assert.equal(reach(c, node(`АЛФ-ДП-26-001 ИНН ${inn('782000002')}`)), 'conflict:foreign_party')
    assert.equal(reach(c, node(`АЛФ-ДП-26-001 и АЛФ-ДП-26-002 ИНН ${inn('782000002')}`)), 'conflict:ambiguous')
  })

  it('чужой ИНН выше по цепочке учитывается на ближайшем уровне с ИНН', () => {
    const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    const inn = (nine) => { const d = [...nine].map(Number); return `${nine}${(d.reduce((s, x, i) => s + x * w[i], 0) % 11) % 10}` }
    const c = dp(NUM, { counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn: inn('781000001') }] })
    const top = node(`ООО Бета ИНН ${inn('782000002')}`)
    const mid = child(top, `ИНН ${inn('781000001')}`)
    const low = child(mid, 'АЛФ-ДП-26-001')
    assert.equal(label(run({ ...c, signalLink: urlOf(low) }, [top, mid, low])), 'verified:existing_url')
    const lowTop = child(top, 'АЛФ-ДП-26-001')
    assert.equal(label(run({ ...c, signalLink: urlOf(lowTop) }, [top, lowTop])), 'conflict:foreign_party')
  })
})

describe('Подтверждение (evaluateNode)', () => {
  it('таблица: verified, accepted, предупреждение — можно; конфликт, не виден, не наблюдается — нельзя', () => {
    const cases = [
      ['свой номер', node('АЛФ-ДП-26-001'), ['verified', 'existing_url', true, null]],
      ['без номера', node('Договора'), ['accepted', 'number_not_found', true, null]],
      ['корпус не совпал', node('АЛФ-ДП-26-001', { path: 'Проект / корп.22 / АЛФ-ДП-26-001' }), ['attention', 'building_mismatch', true, 'building_mismatch']],
      ['папка ДС для ДП', node('ДС 2 к АЛФ-ДП-26-001'), ['attention', 'kind_mismatch', true, 'kind_mismatch']],
      ['чужой номер', node('АЛФ-ДП-26-002'), ['conflict', 'number_mismatch', false, null]],
      ['не виден давно', node('АЛФ-ДП-26-001', { observed: false, absentNights: 3 }), ['attention', 'not_visible', false, null]],
      ['не наблюдается', node('АЛФ-ДП-26-001', { observed: false, absentNights: 0 }), ['unverified', 'not_observed', false, null]],
    ]
    for (const [what, nd, want] of cases) {
      const object = what === 'корпус не совпал' ? [{ ...OBJECTS[0], name: 'ЖК Альфа, корпус 14' }, OBJECTS[1]] : OBJECTS
      const e = M.evaluateNode({ ...dp(), nodes: [nd], objects: object }, nd.nodeId, { generation: GEN })
      assert.deepEqual([e.state, e.reason, e.confirmable, e.warning], want, what)
    }
  })

  it('результат совпадает с тем, что даёт matchContract для той же ссылки (один код у очереди и подтверждения)', () => {
    for (const name of ['АЛФ-ДП-26-001', 'Договора', 'АЛФ-ДП-26-002', 'ДС 2 к АЛФ-ДП-26-001']) {
      const nd = node(name)
      const c = dp(NUM, { signalLink: urlOf(nd) })
      const m = run(c, [nd])
      const e = evaluate(c, [nd], nd.nodeId)
      assert.equal(`${e.state}:${e.reason}`, label(m), name)
    }
  })

  it('ДС: папка ДП без номера ДС подтверждается как «сверено» по номеру ДП; чужая ветка — нет', () => {
    const own = node('АЛФ-ДП-26-001 Ромашка')
    const other = node('АЛФ-ДП-26-002 Ромашка')
    const c = ds(dp(NUM, { signalLink: urlOf(own) }), 'ДС №1')
    assert.deepEqual([evaluate(c, [own, other], own.nodeId).state, evaluate(c, [own, other], own.nodeId).confirmable], ['verified', true])
    const e = evaluate(c, [own, other], other.nodeId)
    assert.deepEqual([e.state, e.reason, e.confirmable], ['conflict', 'foreign_dp', false])
  })
})

describe('Граница объекта и кандидаты', () => {
  it('узел чужого или неназначенного объекта, не наблюдаемый, из выключенного корня, файл — не кандидат', () => {
    const good = node('АЛФ-ДП-26-001 ООО Ромашка')
    const bad = [
      node('АЛФ-ДП-26-001 ООО Ромашка 2', { objectId: OBJ_B }), node('АЛФ-ДП-26-001 ООО Ромашка 3', { objectId: null }),
      node('АЛФ-ДП-26-001 ООО Ромашка 4', { observed: false }), node('АЛФ-ДП-26-001 ООО Ромашка 5', { sourceEnabled: false }),
      node('АЛФ-ДП-26-001 ООО Ромашка 6', { sourceReady: false }), node('АЛФ-ДП-26-001 ООО Ромашка 7', { kind: 'item' }),
    ]
    const r = run(dp(), [good, ...bad])
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [good.nodeId])
  })

  it('при conflict рядом показываются другие кандидаты для замены; при verified — нет', () => {
    const wrong = node('АЛФ-ДП-26-002 ООО Ромашка')
    const right = node('АЛФ-ДП-26-001 ООО Ромашка')
    const r = run(dp(NUM, { signalLink: urlOf(wrong) }), [wrong, right])
    assert.deepEqual([label(r), r.candidates.map((c) => c.nodeId)], ['conflict:number_mismatch', [right.nodeId]])
    const ok = run(dp(NUM, { signalLink: urlOf(right) }), [wrong, right])
    assert.deepEqual([label(ok), ok.candidates], ['verified:existing_url', []])
  })

  it('удалённый договор — none:none; чужие узлы не меняют ответ', () => {
    const nd = node('АЛФ-ДП-26-001 ООО Ромашка')
    assert.equal(label(run(dp(NUM, { deleted: true, signalLink: urlOf(nd) }), [nd])), 'none:none')
    assert.equal(label(run(dp(NUM), [])), 'none:none')
  })
})

describe('Детерминизм и синхронность с очередью', () => {
  it('одинаковый вход — одинаковый результат; запрос узлов договора достаточен для сопоставления', () => {
    const dpF = node('АЛФ-ДП-26-001 Ромашка')
    const subs = [child(dpF, 'ДС 3'), child(dpF, 'ДС 4'), node('Прочее')]
    const c = ds(dp(NUM, { signalLink: urlOf(dpF) }), 'ДС №3')
    const all = [dpF, ...subs]
    const scoped = M.matchContract({ ...c, nodes: all, objects: OBJECTS }, { formats: FORMATS, generation: GEN })
    const full = M.matchContract({ ...c, nodes: all, objects: OBJECTS }, { formats: FORMATS, generation: GEN, scoped: false })
    assert.deepEqual(scoped.candidates.map((x) => x.nodeId), [subs[0].nodeId])
    assert.deepEqual(scoped.candidates, full.candidates)
    assert.deepEqual(M.matchContract({ ...c, nodes: [...all].reverse(), objects: OBJECTS }, { formats: FORMATS, generation: GEN }), scoped)
  })

  it('результат не зависит от узлов, пришедших по запросам других договоров той же порции', () => {
    const mine = node('АЛФ-ДП-26-001 ООО Ромашка')
    const noise = [node('ООО Бета договор'), node('АЛФ-ДП-26-077 ООО Ромашка'), node('Прочее')]
    const a = M.matchContract({ ...dp(), nodes: [mine], objects: OBJECTS }, { formats: FORMATS, generation: GEN })
    const b = M.matchContract({ ...dp(), nodes: [...noise, mine], objects: OBJECTS }, { formats: FORMATS, generation: GEN })
    assert.deepEqual(a, b)
  })
})
