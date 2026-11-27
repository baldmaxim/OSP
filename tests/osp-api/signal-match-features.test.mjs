// Сопоставитель OSP ↔ SIGNAL: корпус, очередь, секция; ранжирование и полнота предложений (пакет ПР-2 волны исправлений).
// Находки: С-34 и С-35 (формы записи признаков), В-11 (расхождение корпуса — мягкое предупреждение), С-42 (предвыборка узлов),
// С-44 (общее начало названия организации), С-45 (синоним и звено пути), С-53/С-54 (отказ и узел), С-55, С-56, С-57.
// Данные — только синтетика. Чистые функции, без базы и сети.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as M from '../../server/osp-api/src/lib/signalMatch.js'
import { numberKey } from '../../server/osp-api/src/shared/contractNumbering.js'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'

const id = (p, n) => `${p.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = id('a', 1)
const OBJ_A = id('b', 1)
const OBJ_B = id('b', 2)
const CP1 = id('e', 1)
const FOLDER_URL = 'https://signal.example.test/projects/{projectId}/folders/{folderId}'
const FORMATS = [FOLDER_URL]
const GEN = 7
const objectOf = (name, code = 'АЛФ', extra = {}) => ({ id: OBJ_A, name, code, aliases: [], ...extra })
const OTHER_OBJECT = { id: OBJ_B, name: 'ЖК Другой', code: 'ЗИЛ', aliases: [] }

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
const dp = (number, extra = {}) => ({
  id: id('d', 1), recordType: 'dp', number, numberKey: numberKey(number), objectId: OBJ_A, parentId: null, rootId: null, signalLink: null,
  deleted: false, counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn: null }], family: { dp: null, cycle: false }, candidates: [],
  revision: 1, stateVersion: 0, state: null, ...extra,
})
const run = (contract, nodes, object = objectOf('ЖК Альфа'), opts = {}) =>
  M.matchContract({ ...contract, nodes, objects: [object, OTHER_OBJECT] }, { formats: FORMATS, generation: GEN, ...opts })
const evaluate = (contract, nodes, nodeId, object = objectOf('ЖК Альфа')) =>
  M.evaluateNode({ ...contract, nodes, objects: [object, OTHER_OBJECT] }, nodeId, { generation: GEN })
const label = (r) => `${r.state}:${r.reason}`
const NUM = 'АЛФ-ДП-26-001'
// Итог введённой ссылки на папку договора НUM: объект с названием objName, путь folderPath.
const feat = (objName, folderPath, number = NUM) => {
  const name = folderPath.split(' / ').at(-1)
  const nd = node(name, { path: folderPath })
  return label(run(dp(number, { signalLink: urlOf(nd) }), [nd], objectOf(objName)))
}

describe('С-34, С-35: формы записи корпуса, очереди и секции', () => {
  const f = (text) => M.pathFeatures(text)
  it('«.0» и «,0» — то же число: «Очередь 3.0» = «3», «корпус 1.0» = «1»; «6-1» = «6.1»', () => {
    assert.deepEqual(f('Очередь 3.0').queue, ['3'])
    assert.deepEqual(f('Очередь 3').queue, ['3'])
    assert.deepEqual(f('ЖК Альфа, корпус 1.0').building, ['1'])
    assert.deepEqual(f('Корпус 6-1').building, ['6.1'])
    assert.deepEqual(f('корп. 6.1').building, ['6.1'])
    assert.deepEqual(f('Корпус 6,1').building, ['6.1'])
  })

  it('перечни и диапазоны: «14 и 15», «14, 15», «14,15», «14/15», «14-15»', () => {
    for (const t of ['Корпус 14 и 15', 'Корпус 14, 15', 'Корпус 14,15', 'Корпус 14/15', 'Корпус 14-15', 'корп.14 и 15']) assert.deepEqual(f(t).building, ['14', '15'], t)
    assert.deepEqual(f('Корпус 14-17').building, ['14', '15', '16', '17'])
    assert.deepEqual(f('Корпус 14, секция 2'), { building: ['14'], queue: [], section: ['2'] })
  })

  it('записи «14к», «К-14», «К 14», латинская «K14» и «k.14» — корпус', () => {
    for (const t of ['14к', 'К-14', 'К 14', 'K14', 'K-14', 'k14', 'к14', 'к.14', 'К.14', 'корп.14', 'Корпус 14', 'Bldg 14', 'building 14', 'корпус №14', 'корпуса 14', '14-й корпус']) {
      assert.deepEqual(f(t).building, ['14'], t)
    }
    assert.deepEqual(f('15к').building, ['15'])
  })

  it('«3 корпус», «1 очередь», «2-я очередь», римская «очередь II», секции', () => {
    assert.deepEqual(f('3 корпус').building, ['3'])
    assert.deepEqual(f('1 очередь').queue, ['1'])
    assert.deepEqual(f('2-я очередь').queue, ['2'])
    assert.deepEqual(f('очередь II').queue, ['2'])
    assert.deepEqual(f('Очередь 2').queue, ['2'])
    assert.deepEqual(f('Секция 3').section, ['3'])
    assert.deepEqual(f('сек. 2').section, ['2'])
    assert.deepEqual(f('2-я секция').section, ['2'])
  })

  it('не признаки: годы, версии, номера приложений и договоров, предлог «к», «№15 корпус 14»', () => {
    for (const t of ['2026', 'v2', 'ред. 3', 'Приложение 3', 'ДС 1 к договору', 'Акт к 12', 'корпус 2026', 'Очаково 5', 'Корсаков 3', 'ПРИМ-ДП-26-001']) {
      assert.deepEqual(M.pathFeatures(t), { building: [], queue: [], section: [] }, t)
    }
    assert.deepEqual(f('№15 корпус 14').building, ['14'])
  })

  it('объект: признаки по названию и коду', () => {
    assert.deepEqual(M.objectFeatures('Дом 14, корп. 2', 'ДОМ14К2').building, ['2'])
    assert.deepEqual(M.prepareNode({ name: 'Корпус 3.0 / ДП', path: 'Проект / Очередь 2.0 / Корпус 3.0' }).features, { building: ['3'], queue: ['2'] })
  })
})

describe('С-34, С-35: ложные расхождения исчезли', () => {
  it('«3.0» против «3» и «1.0» против «1» — сверено, без предупреждения', () => {
    assert.equal(feat('Очередь 3.0', 'Док / Очередь 3 / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
    assert.equal(feat('ЖК Альфа, корпус 1.0', 'Док / Корпус 1 / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
    assert.equal(feat('ЖК Альфа, корпус 1', 'Док / Корпус 1.0 / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
    assert.equal(feat('ЖК Альфа, корп. 6.1', 'Док / Корпус 6-1 / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
  })

  it('«Корпус 14 и 15», «14, 15», «14-15»: оба корпуса сходятся', () => {
    for (const objName of ['ЖК Альфа, корпус 14', 'ЖК Альфа, корпус 15']) {
      for (const folder of ['Корпус 14 и 15', 'Корпус 14, 15', 'Корпус 14-15']) {
        assert.equal(feat(objName, `Док / ${folder} / ДП АЛФ-ДП-26-001`), 'verified:existing_url', `${objName} ← ${folder}`)
      }
    }
  })

  it('«14к», «К-14», «К 14», «K14» теперь видны: чужой корпус даёт предупреждение, свой — нет', () => {
    for (const own of ['14к', 'К-14', 'К 14', 'K14']) assert.equal(feat('ЖК Альфа, корпус 14', `Док / ${own} / ДП АЛФ-ДП-26-001`), 'verified:existing_url', own)
    for (const other of ['15к', 'К-15', 'К 15', 'K15']) assert.equal(feat('ЖК Альфа, корпус 14', `Док / ${other} / ДП АЛФ-ДП-26-001`), 'attention:building_mismatch', other)
  })

  it('папка с тем же номером и записью «Очередь 3» предлагается объекту «Очередь 3.0»', () => {
    const nd = node('ДП АЛФ-ДП-26-001 ООО Ромашка', { path: 'Док / Очередь 3 / ДП АЛФ-ДП-26-001 ООО Ромашка' })
    const r = run(dp(NUM), [nd], objectOf('Очередь 3.0'))
    assert.equal(label(r), 'suggested:candidates')
    assert.ok(r.candidates[0].reasons.includes('features'))
    assert.ok(!r.candidates[0].flags.includes('building_mismatch'))
  })
})

describe('В-11: расхождение корпуса — мягкое предупреждение, номер и объект — жёсткий отказ', () => {
  it('введённая ссылка: attention:building_mismatch; подтверждать можно, warning = building_mismatch', () => {
    const nd = node('ДП АЛФ-ДП-26-001', { path: 'Док / корп.22 / ДП АЛФ-ДП-26-001' })
    const c = dp(NUM, { signalLink: urlOf(nd) })
    const r = run(c, [nd], objectOf('ЖК Альфа, корпус 14'))
    assert.equal(label(r), 'attention:building_mismatch')
    assert.equal(r.nodeId, nd.nodeId)
    const e = evaluate(c, [nd], nd.nodeId, objectOf('ЖК Альфа, корпус 14'))
    assert.deepEqual([e.state, e.reason, e.confirmable, e.warning], ['attention', 'building_mismatch', true, 'building_mismatch'])
    // очередь и секция — так же
    assert.equal(feat('Очередь 2', 'Док / Очередь 3 / ДП АЛФ-ДП-26-001'), 'attention:building_mismatch')
    assert.equal(feat('Секция 1', 'Док / Секция 4 / ДП АЛФ-ДП-26-001'), 'attention:building_mismatch')
  })

  it('предупреждение главнее «номер найден» и «номер не найден»; без признаков с одной стороны — нет предупреждения', () => {
    assert.equal(feat('ЖК Альфа, корпус 14', 'Док / корп.22 / Договор ООО Ромашка'), 'attention:building_mismatch')
    assert.equal(feat('ЖК Альфа', 'Док / корп.22 / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
    assert.equal(feat('ЖК Альфа, корпус 14', 'Док / Договоры / ДП АЛФ-ДП-26-001'), 'verified:existing_url')
  })

  it('жёсткое противоречие главнее предупреждения: чужой номер и чужой корпус — conflict', () => {
    assert.equal(feat('ЖК Альфа, корпус 14', 'Док / корп.22 / ДП АЛФ-ДП-26-002'), 'conflict:number_mismatch')
  })

  it('решение человека сохраняется и при расхождении корпуса: confirmed не превращается в предупреждение', () => {
    const nd = node('ДП АЛФ-ДП-26-001', { path: 'Док / корп.22 / ДП АЛФ-ДП-26-001' })
    const state = { state: 'verified', reason: 'confirmed', nodeId: nd.nodeId, confirmedBy: id('f', 1) }
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(nd), state }), [nd], objectOf('ЖК Альфа, корпус 14'))), 'verified:confirmed')
  })

  it('кандидат: флаг building_mismatch, балл ниже на 30, из выдачи не исключается', () => {
    const wrong = node('ДП АЛФ-ДП-26-001 ООО Ромашка', { path: 'Док / корп.22 / ДП АЛФ-ДП-26-001 ООО Ромашка' })
    const right = node('ДП АЛФ-ДП-26-001 ООО Ромашка', { path: 'Док / корп.14 / ДП АЛФ-ДП-26-001 ООО Ромашка' })
    const none = node('ДП АЛФ-ДП-26-001 ООО Ромашка', { path: 'Док / Разное / ДП АЛФ-ДП-26-001 ООО Ромашка' })
    const object = objectOf('ЖК Альфа, корпус 14')
    const r = run(dp(NUM), [wrong, right, none], object)
    const by = (n) => r.candidates.find((c) => c.nodeId === n.nodeId)
    assert.equal(r.candidates.length, 3)
    assert.deepEqual(by(wrong).flags, ['building_mismatch'])
    assert.deepEqual(by(right).flags, [])
    assert.equal(by(none).score - by(wrong).score, 30 + 0) // у «none» нет и признака «features» (+10): 10 - 10 + 30
    assert.equal(r.candidates[0].nodeId === wrong.nodeId, false)
    assert.equal(r.candidates.at(-1).nodeId, wrong.nodeId)
  })

  it('«К12/21» и «К140-2025» в номере договора в названии: расхождение мягкое, а не conflict', () => {
    const n = node('ДП №К12/21 ООО Альфа', { path: 'Primavera / ДП №К12/21 ООО Альфа' })
    const r = run(dp('К12/21', { signalLink: urlOf(n) }), [n], objectOf('Primavera к.14', 'ПРИМ'))
    assert.equal(label(r), 'attention:building_mismatch')
  })

  it('номер и объект — по-прежнему жёсткие: чужой код объекта → object_mismatch', () => {
    const nd = node('ЗИЛ-ДП-26-001 ООО Ромашка')
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(nd) }), [nd])), 'conflict:object_mismatch')
  })
})

describe('С-53, С-54: отказ действует, пока тот же договор и тот же узел', () => {
  it('nodeKeyOf: зависит от названия и ключей номера, не от пути, id и порядка', () => {
    const a = node('ДП АЛФ-ДП-26-001 ООО Ромашка')
    const same = node('ДП АЛФ-ДП-26-001 ООО Ромашка', { parentPath: 'Другой / Путь' })
    const renamed = node('ДП АЛФ-ДП-26-001 ООО Ромашка (копия)')
    assert.match(M.nodeKeyOf(a), /^[0-9a-f]{32}$/)
    assert.equal(M.nodeKeyOf(a), M.nodeKeyOf(same))
    assert.notEqual(M.nodeKeyOf(a), M.nodeKeyOf(renamed))
    assert.notEqual(M.nodeKeyOf(node('АЛФ-ДП-26-001')), M.nodeKeyOf(node('АЛФ-ДП-26-002')))
    assert.equal(M.nodeKeyOf({ name: 'ДП  АЛФ-ДП-26-001 ООО  Ромашка' }), M.nodeKeyOf({ name: 'дп алф-дп-26-001 ооо ромашка' }))
  })

  it('кандидат несёт nodeKey, совпадающий с nodeKeyOf(узла)', () => {
    const nd = node('АЛФ-ДП-26-001 ООО Ромашка')
    const r = run(dp(NUM), [nd])
    assert.equal(r.candidates[0].nodeKey, M.nodeKeyOf(nd))
  })

  it('слабый признак отклонён; папку переименовали в точный номер — возвращается с флагом «ранее отклоняли»', () => {
    const c = dp(NUM)
    const weak = node('Ромашка договор')
    const stored = [{ nodeId: weak.nodeId, status: 'rejected', ctxKey: M.contractContextKey(c), nodeKey: M.nodeKeyOf(weak) }]
    assert.equal(run({ ...c, candidates: stored }, [weak]).candidates.length, 0, 'отказ действует')
    const renamed = { ...weak, name: 'АЛФ-ДП-26-001 Ромашка', path: 'Проект / АЛФ-ДП-26-001 Ромашка' }
    const after = run({ ...c, candidates: stored }, [renamed])
    assert.equal(label(after), 'suggested:candidates')
    assert.ok(after.candidates[0].reasons.includes('number'))
    assert.deepEqual(after.candidates[0].flags, ['previously_rejected'])
  })

  it('отказ без nodeKey (прежняя запись) действует как раньше — по контексту', () => {
    const c = dp(NUM)
    const nd = node('АЛФ-ДП-26-001 Ромашка')
    const stored = [{ nodeId: nd.nodeId, status: 'rejected', ctxKey: M.contractContextKey(c) }]
    assert.equal(label(run({ ...c, candidates: stored }, [nd])), 'none:none')
    // смена контекста договора возвращает пару с флагом
    const other = { ...c, objectId: OBJ_A, counterparties: [{ id: id('e', 7), name: 'ООО «Ромашка»', inn: null }] }
    assert.deepEqual(run({ ...other, candidates: stored }, [nd]).candidates[0].flags, ['previously_rejected'])
  })

  it('отвязанная пара: после переименования папки подавление снимается, при том же узле — остаётся (none:unlinked)', () => {
    const c = dp('ДП №12', { numberKey: null })
    const f = node('Ромашка договор')
    const key = M.contractContextKey(c)
    const stored = [{ nodeId: f.nodeId, status: 'unlinked', ctxKey: key, nodeKey: M.nodeKeyOf(f) }]
    const renamed = { ...f, name: 'ДП №12 Ромашка', path: 'Проект / ДП №12 Ромашка' }
    assert.equal(label(run({ ...c, candidates: stored }, [f])), 'none:unlinked')
    const res = run({ ...c, candidates: stored }, [renamed])
    assert.equal(label(res), 'suggested:candidates')
    assert.deepEqual(res.candidates[0].flags, ['previously_unlinked'])
  })
})

describe('С-55, С-56: порядок предложений', () => {
  it('«ДП №12»: точная папка выше «ДП №12/2023» и «ДП №12-1», даже если её путь по алфавиту позже', () => {
    const other1 = node('ДП №12/2023 Ромашка')
    const other2 = node('ДП №12-1 Ромашка')
    const exact = node('Ромашка ДП №12')
    const res = run(dp('ДП №12', { numberKey: null }), [other1, other2, exact])
    assert.equal(res.candidates[0].nodeId, exact.nodeId)
    assert.ok(res.candidates[0].score > res.candidates[1].score)
    assert.ok(res.candidates.every((c) => c.reasons.includes('number_legacy')))
  })

  it('равные баллы: путь по ICU en-US (как в SQL на проде), затем nodeId', () => {
    const paths = ['Проект / Договоры / АЛФ-ДП-26-001 Ромашка', 'Проект / ДС / АЛФ-ДП-26-001 Ромашка', 'Проект / архив / АЛФ-ДП-26-001', 'Проект / Архив старый / АЛФ-ДП-26-001']
    const nodes = paths.map((p, i) => node(p.split(' / ').at(-1), { path: p, nodeId: id('c', 900 + i) }))
    const res = run(dp(NUM, { counterparties: [] }), nodes)
    const order = res.candidates.map((c) => nodes.find((n) => n.nodeId === c.nodeId).path)
    const collator = new Intl.Collator('en-US')
    assert.deepEqual(order, [...new Set(order)].sort((a, b) => collator.compare(a, b)))
    // кодовые единицы UTF-16 дали бы другой порядок («Архив…» < «архив» < «Договоры…»)
    assert.notDeepEqual(order, [...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    const same = nodes.map((n) => ({ ...n, path: 'Проект / Один путь', nodeId: n.nodeId }))
    assert.deepEqual(run(dp(NUM, { counterparties: [] }), same).candidates.map((c) => c.nodeId), [...same].map((n) => n.nodeId).sort())
  })

  it('кандидатов не больше десяти; порядок: баллы, путь, id', () => {
    const nodes = Array.from({ length: 14 }, (_, i) => node('АЛФ-ДП-26-001 Ромашка', { path: `Проект / Раздел ${String(i).padStart(2, '0')} / АЛФ-ДП-26-001 Ромашка` }))
    const res = run(dp(NUM), nodes)
    assert.equal(res.candidates.length, 10)
    const paths = res.candidates.map((c) => nodes.find((n) => n.nodeId === c.nodeId).path)
    assert.deepEqual(paths, [...paths].sort())
  })
})

// Порядок равных кандидатов в SQL (ORDER BY path на проде — ICU en_US) и в JS (Intl.Collator('en-US')) один и тот же.
describe('С-56: порядок путей как в базе (ICU en-US)', { skip: signalDbSkip, timeout: 300000 }, () => {
  let db
  before(async () => { db = await startSignalDb({ migrate: false }) })
  after(async () => { await db?.stop() })

  it('на наборе путей с разным регистром, дефисом, пробелом, «ДС» и «ё»: порядок JS = порядок базы с COLLATE "en-US-x-icu"', (t) => {
    const paths = [
      'Проект / Договоры / АЛФ-ДП-26-001 Ромашка', 'Проект / ДС / ДС 2 к АЛФ-ДП-26-001', 'Проект / архив / АЛФ-ДП-26-001', 'Проект / Архив старый / АЛФ-ДП-26-001',
      'Проект / ДП №12 Ромашка', 'Проект / ДП №12-1 Ромашка', 'Проект / ДП №12/2023 Ромашка', 'Проект / Ёлка / 1', 'Проект / Елка / 1', 'Проект / елка / 2',
      'Проект / Корпус 1 / а', 'Проект / Корпус 10 / а', 'Проект / Корпус 2 / а', 'Проект / корпус 2 / б', 'Проект / A1', 'Проект / а1', 'Проект / A-1', 'Проект / A 1',
    ]
    const collations = db.sql("select string_agg(collname, ',') from pg_collation where collname = 'en-US-x-icu'")
    if (!/icu/.test(collations)) { t.skip('в базе нет ICU-сортировок'); return }
    const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
    const fromDb = db.sql(`select p from (values ${paths.map((p) => `(${lit(p)})`).join(',')}) v(p) order by p collate "en-US-x-icu"`).split('\n').filter(Boolean)
    const collator = new Intl.Collator('en-US')
    assert.deepEqual([...paths].sort((a, b) => collator.compare(a, b)), fromDb)
  })
})

describe('С-44: общее начало названия организации', () => {
  const cases = [
    ['ООО «Монолит»', 'ДП №15 ООО «Монолит-Сервис»', 'ООО Монолит договор'],
    ['ООО «Строй»', 'Строй-Инвест ДП 3', 'Договор ООО Строй'],
    ['АО «Альфа»', 'Альфа-Банк гарантия', 'Договор АО Альфа'],
  ]
  for (const [party, wrong, right] of cases) {
    it(`сторона ${party}: «${wrong}» — «похоже», «${right}» — точное название`, () => {
      const c = dp('СУ2-ПРИМ14-0999', { counterparties: [{ id: CP1, name: party, inn: null }] })
      const w = node(wrong.replace(/ДП №15 /, ''))
      const r = node(right)
      const res = run(c, [w, r], objectOf('ЖК Альфа'))
      const cw = res.candidates.find((x) => x.nodeId === w.nodeId)
      const cr = res.candidates.find((x) => x.nodeId === r.nodeId)
      assert.ok(cw && cr)
      assert.deepEqual(cr.flags, [])
      assert.deepEqual(cw.flags, ['similar'])
      assert.ok(cw.reasons.includes('name_similar') && !cw.reasons.includes('counterparty'))
      assert.ok(cr.score > cw.score)
      assert.equal(res.candidates[0].nodeId, r.nodeId)
    })
  }

  it('дефис перед «ДП»/«ДС» — не продолжение названия: «Альфа-ДП-26-001» — точное название стороны', () => {
    const c = dp('ПРИМ-ДП-26-009', { counterparties: [{ id: CP1, name: 'АО «Альфа»', inn: null }] })
    const nd = node('Альфа-ДП 7 договор')
    assert.deepEqual(run(c, [nd], objectOf('ЖК Альфа')).candidates[0].flags, [])
  })
})

describe('С-42: предвыборка узлов не слабее сопоставителя', () => {
  const NUM2 = 'СУ2-ПРИМ14-0215'
  const legacyObject = objectOf('Примавера', 'ПРИМ')
  const row = (r) => `${label(r)}[${r.candidates.map((c) => c.reasons.join('+')).join(',')}]`

  for (const name of ['ДП №СУ2-ПРИМ14-0215', 'ДП №CУ2-ПРИМ14-0215', 'ДП №СУ2-ПPИM14-0215', 'ДП_СУ2_ПРИМ14_0215', 'ДП СУ2/ПРИМ14/0215', 'ДП №СУ2–ПРИМ14–0215',
    'ДП №СУ2 - ПРИМ14 - 0215', 'ДП СУ2.ПРИМ14.0215', 'ДП СУ2 ПРИМ14 0215']) {
    it(`«${name}»: с выборкой договора находится так же, как при всех узлах`, () => {
      const n = node(name)
      const scoped = run(dp(NUM2), [n], legacyObject)
      const full = run(dp(NUM2), [n], legacyObject, { scoped: false })
      assert.equal(scoped.state, 'suggested', row(scoped))
      assert.equal(row(scoped), row(full))
    })
  }

  it('термины запроса: разные разделители, числовой якорь; «_» разрешён (SQL экранирует шаблон), «%» и «\\» нет', () => {
    const q = M.nodeQueryFor(dp(NUM2), { formats: FORMATS })
    for (const t of ['су2-прим14-0215', 'су2 прим14 0215', 'су2_прим14_0215', 'су2/прим14/0215', 'су2.прим14.0215', '0215']) assert.ok(q.terms.includes(t), t)
    assert.ok(q.terms.length <= 30)
    const odd = M.nodeQueryFor(dp('СУ2-100%-0215', { counterparties: [{ id: CP1, name: 'ООО «Аль\\фа 100%»', inn: null }] }), { formats: FORMATS })
    assert.ok(odd.terms.every((t) => !/[%\\]/.test(t)))
  })

  it('NFD: контрагент «Берёзка» и номер с «Й» в названии папки находятся так же, как в NFC', () => {
    for (const party of ['Стройинвест', 'Берёзка']) {
      const c = dp('СУ2-ПРИМ14-0999', { counterparties: [{ id: CP1, name: `ООО «${party}»`, inn: null }] })
      const nfc = run(c, [node(`${party} корп.14`)], legacyObject)
      const nfd = run(c, [node(`${party.normalize('NFD')} корп.14`)], legacyObject)
      assert.equal(nfc.state, 'suggested', party)
      assert.equal(row(nfd), row(nfc), party)
    }
    const num = 'СУ2-ЛЕНИНСКИЙ-0215'
    const nfc = run(dp(num), [node(`ДП №${num}`)], legacyObject)
    const nfd = run(dp(num), [node(`ДП №${num}`.normalize('NFD'))], legacyObject)
    assert.equal(nfc.state, 'suggested')
    assert.equal(row(nfd), row(nfc))
  })

  it('prepareNode: nameNorm в NFC, тире унифицированы', () => {
    assert.equal(M.prepareNode({ name: 'Берёзка'.normalize('NFD') }).nameNorm, 'березка')
    assert.equal(M.prepareNode({ name: 'СУ2–ПРИМ14' }).nameNorm, 'су2-прим14')
    assert.equal(M.searchNorm('«Ромашка»  ООО'), 'ромашка ооо')
  })

  it('ДС: термины — «ДС N», «ДС-N», «ДС №N», «Д/С N», «соглашение № N»; без папки ДП и с папкой', () => {
    const dpFolder = node('АЛФ-ДП-26-001')
    const parent = dp(NUM)
    const noFolder = M.nodeQueryFor({ ...parent, id: id('d', 2), recordType: 'ds_vor', number: 'ДС №3', numberKey: null, family: { dp: { ...parent, signalLink: null }, cycle: false } }, { formats: FORMATS })
    const withFolder = M.nodeQueryFor({ ...parent, id: id('d', 2), recordType: 'ds_vor', number: 'ДС №3', numberKey: null, family: { dp: { ...parent, signalLink: urlOf(dpFolder) }, cycle: false } }, { formats: FORMATS })
    for (const q of [noFolder, withFolder]) for (const t of ['дс 3', 'дс-3', 'дс №3', 'д/с 3', 'соглашение № 3']) assert.ok(q.terms.includes(t), t)
    assert.deepEqual(withFolder.under, [dpFolder.nodeId])
    assert.deepEqual(noFolder.under, [])
  })
})

describe('С-45: название или синоним объекта сравнивается со всем путём от границы объекта', () => {
  it('синоним в названии верхней папки объекта усиливает предложение («object_name»)', () => {
    const object = objectOf('ЖК Альфа', 'ТЕСТ', { aliases: [{ text: 'Северный квартал', key: 'северный квартал' }] })
    const top = node('Северный квартал', { path: 'Северный квартал' })
    const inner = child(top, 'АЛФ-ДП-26-001 Ромашка')
    const other = node('АЛФ-ДП-26-001 Ромашка', { path: 'Прочее / АЛФ-ДП-26-001 Ромашка' })
    const r = run(dp(NUM, { counterparties: [] }), [inner, other], object)
    const byNode = (n) => r.candidates.find((c) => c.nodeId === n.nodeId)
    assert.ok(byNode(inner).reasons.includes('object_name'))
    assert.ok(!byNode(other).reasons.includes('object_name'))
    assert.ok(byNode(inner).score > byNode(other).score)
    // objectPath главнее path: звено выше границы объекта не учитывается
    const cut = { ...inner, objectPath: inner.name }
    assert.ok(!run(dp(NUM, { counterparties: [] }), [cut], objectOf('ЖК Альфа', 'ТЕСТ', { aliases: [{ text: 'Северный квартал', key: 'северный квартал' }] })).candidates[0].reasons.includes('object_name'))
  })
})

describe('С-57: договор без объекта', () => {
  it('без ссылки — none:no_object; со ссылкой — unverified:no_object; узел и кандидаты не выдаются', () => {
    const nd = node('АЛФ-ДП-26-001 Ромашка')
    const a = run(dp(NUM, { objectId: null }), [nd])
    assert.deepEqual([label(a), a.nodeId, a.candidates.length], ['none:no_object', null, 0])
    const b = run(dp(NUM, { objectId: null, signalLink: urlOf(nd) }), [nd])
    assert.deepEqual([label(b), b.nodeId, b.candidates.length], ['unverified:no_object', null, 0])
    const e = evaluate(dp(NUM, { objectId: null }), [nd], nd.nodeId)
    assert.deepEqual([e.state, e.reason, e.confirmable], ['unverified', 'no_object', false])
  })
})

describe('objectPath: уровни и признаки берутся от границы объекта', () => {
  it('путь выше границы объекта (с чужим корпусом и номером) не влияет на сверку', () => {
    const nd = node('Договор Ромашка', { path: 'Корпус 22 / ДП АЛФ-ДП-26-009 / Договор Ромашка', objectPath: 'Договор Ромашка' })
    const object = objectOf('ЖК Альфа, корпус 14')
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(nd) }), [nd], object)), 'accepted:number_not_found')
    const same = { ...nd, objectPath: undefined }
    assert.equal(label(run(dp(NUM, { signalLink: urlOf(same) }), [same], object)), 'conflict:number_mismatch')
  })

  it('кандидаты сортируются по объектному пути', () => {
    const a = node('АЛФ-ДП-26-001 Ромашка', { path: 'Я / АЛФ-ДП-26-001 Ромашка', objectPath: 'А / АЛФ-ДП-26-001 Ромашка' })
    const b = node('АЛФ-ДП-26-001 Ромашка', { path: 'А / АЛФ-ДП-26-001 Ромашка', objectPath: 'Я / АЛФ-ДП-26-001 Ромашка' })
    assert.deepEqual(run(dp(NUM), [a, b]).candidates.map((c) => c.nodeId), [a.nodeId, b.nodeId])
  })
})
