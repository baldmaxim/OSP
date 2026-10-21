// Автозагрузка позиций ВОР в расценку и подстановка цены в одинаковые позиции (src/utils/supplyAutoImport.js):
// какие файлы загрузить и под каким именем ВОР, когда брать вкладку «ВОР» карточки, какие пустые списки убрать,
// куда подставить цену. Без базы и браузера.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  targetNameForFile, planFileImports, planTabImports, planCleanup, identicalTargets, unitSignature, fileVersion, estimateVersion,
} from '../../src/utils/supplyAutoImport.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const file = (id, name, at = '2026-10-10T10:00:00Z') => ({ id, file_name: name, created_at: at })
const src = (over) => ({ id: `s-${over.estimate_name}`, source: 'vor_file', s3_document_id: null, source_version: null, file_name: null, ...over })

describe('Автозагрузка: файлы ВОР', () => {
  it('имя ВОР: прежняя привязка файла → ВОР карточки → прежний список того же файла → имя файла', () => {
    const f = file('f1', 'ВОР ОВ.xlsx')
    assert.equal(targetNameForFile(f, [], []), 'ВОР ОВ')
    assert.equal(targetNameForFile(f, [], ['вор  ов', 'ВК']), 'вор  ов')
    assert.equal(targetNameForFile(f, [src({ estimate_name: 'Отопление', file_name: 'ВОР ОВ.xlsx' })], []), 'Отопление')
    assert.equal(targetNameForFile(f, [src({ estimate_name: 'Привязан', s3_document_id: 'f1' })], ['ВОР ОВ']), 'Привязан')
  })

  it('уже загруженный этой версией файл не грузится заново; новый и заменённый — грузятся', () => {
    const f1 = file('f1', 'ОВ.xlsx')
    const f2 = file('f2', 'ВК.xlsx')
    const sources = [src({ estimate_name: 'ОВ', s3_document_id: 'f1', source_version: fileVersion(f1) })]
    const { jobs } = planFileImports([f1, f2], sources, [])
    assert.deepEqual(jobs.map((j) => [j.doc.id, j.name, !!j.existing]), [['f2', 'ВК', false]])
    // Новая версия того же ВОР (другой файл с тем же именем) — обновляет прежний список.
    const f3 = file('f3', 'ОВ.xlsx', '2026-10-12T10:00:00Z')
    const plan = planFileImports([f3], sources, [])
    assert.deepEqual(plan.jobs.map((j) => [j.doc.id, j.name, j.existing?.estimate_name]), [['f3', 'ОВ', 'ОВ']])
  })

  it('прежняя версия ВОР (заменена файлом с другим именем, 20261029) — в свой ВОР, где её место уже занял новый файл', () => {
    const v1 = file('v1', 'ВОР ОВ.xlsx', '2026-10-01T00:00:00Z')
    const v2 = file('v2', 'ВОР ОВ изм.1.xlsx', '2026-10-20T00:00:00Z')
    const sources = [src({ estimate_name: 'Отопление', s3_document_id: 'v2', source_version: fileVersion(v2), prior_document_ids: ['v1'] })]
    assert.equal(targetNameForFile(v1, sources, []), 'Отопление')
    const { jobs, skipped } = planFileImports([v1, v2], sources, [])
    assert.deepEqual(jobs, [], 'новый уже загружен, старый — не отдельный ВОР')
    assert.deepEqual(skipped.map((x) => [x.doc.id, x.name]), [['v1', 'Отопление']])
    // Без отметки прежнего файла старый завёл бы отдельный ВОР «ВОР ОВ» — так было до 20261029.
    assert.deepEqual(planFileImports([v1, v2], [{ ...sources[0], prior_document_ids: undefined }], []).jobs.map((j) => j.name), ['ВОР ОВ'])
    // Новый файл удалили, старый на месте — ВОР возвращается к нему (и это будет новая версия ВОР).
    const back = planFileImports([v1], [{ ...sources[0], s3_document_id: null }], [])
    assert.deepEqual(back.jobs.map((j) => [j.doc.id, j.name, !!j.existing]), [['v1', 'Отопление', true]])
  })

  it('два файла в одно имя ВОР — берётся новый, старый отмечается', () => {
    const old = file('a', 'ОВ.xlsx', '2026-10-01T00:00:00Z')
    const fresh = file('b', 'ОВ.XLSX', '2026-10-15T00:00:00Z')
    const { jobs, skipped } = planFileImports([old, fresh], [], [])
    assert.deepEqual(jobs.map((j) => j.doc.id), ['b'])
    assert.deepEqual(skipped.map((s) => s.doc.id), ['a'])
  })
})

describe('Автозагрузка: вкладка «ВОР» и уборка', () => {
  const docs = new Map([['Корпус 1', [{ name: 'Труба', unit: 'м', volume: 1 }]], ['Пусто', []]])
  const sigs = new Map([['Корпус 1', { count: 10, latest: '2026-10-10' }]])

  it('вкладка «ВОР» — только без файловых списков; новые и перезагруженные ВОР, пустые — нет', () => {
    assert.deepEqual(planTabImports([], docs, sigs).map((j) => j.name), ['Корпус 1'])
    const same = [src({ estimate_name: 'Корпус 1', source: 'vor_tab', source_version: estimateVersion(sigs.get('Корпус 1')) })]
    assert.deepEqual(planTabImports(same, docs, sigs), [])
    const old = [src({ estimate_name: 'Корпус 1', source: 'vor_tab', source_version: 'vor:9:2026-10-01' })]
    assert.equal(planTabImports(old, docs, sigs)[0].existing.estimate_name, 'Корпус 1')
    assert.deepEqual(planTabImports([src({ estimate_name: 'ОВ', s3_document_id: 'f1' })], docs, sigs), [])
  })

  it('прежний список (старое правило «всё, что не Р») обновляется один раз — и до пустого, если материалов нет', () => {
    const sig = new Map([['Корпус 1', { count: 10, latest: '2026-10-10' }], ['Пусто', { count: 3, latest: '2026-10-10' }]])
    const old = [
      src({ estimate_name: 'Корпус 1', source: 'vor_tab', source_version: 'vor:10:2026-10-10' }),
      src({ estimate_name: 'Пусто', source: 'vor_tab', source_version: 'vor:3:2026-10-10' }),
    ]
    const jobs = planTabImports(old, docs, sig)
    assert.deepEqual(jobs.map((j) => [j.name, j.positions.length, j.version]), [['Корпус 1', 1, 'vor2:10:2026-10-10'], ['Пусто', 0, 'vor2:3:2026-10-10']])
    // Новый ВОР без материалов списка не заводит.
    assert.deepEqual(planTabImports([], new Map([['Пусто', []]]), sig), [])
  })

  it('уборка: пустые списки из вкладки «ВОР» при файлах и от удалённых файлов; с ценами — остаются', () => {
    const sources = [
      src({ estimate_name: 'ОВ', s3_document_id: 'f1' }),
      src({ estimate_name: 'Корпус 1', source: 'vor_tab' }),
      src({ estimate_name: 'Корпус 2', source: 'vor_tab' }),
      src({ estimate_name: 'Старый', s3_document_id: null }),
    ]
    const rates = [{ estimate_name: 'Корпус 2' }]
    assert.deepEqual(planCleanup(sources, rates).map((s) => s.estimate_name), ['Корпус 1', 'Старый'])
    // Без файловых списков вкладку «ВОР» не убираем.
    assert.deepEqual(planCleanup([src({ estimate_name: 'Корпус 1', source: 'vor_tab' })], []), [])
  })
})

describe('Одинаковые позиции', () => {
  const pos = (name, unit, extra = {}) => ({ name, unit, volume: 1, k: normName(name), ...extra })
  const views = [
    { name: 'ОВ', positions: [pos('Труба медная Ø12,7', 'м'), pos('Кран шаровой Ду15', 'шт')] },
    { name: 'ВК', positions: [pos('труба МЕДНАЯ ∅12.7', ' М '), pos('Кран шаровой Ду15', 'компл')] },
    { name: 'ЭОМ', positions: [pos('Труба медная Ø12,7', 'м')] },
  ]

  it('то же наименование и та же единица, только где цены нет; свой ВОР и другая единица — нет', () => {
    const priced = new Set(['ЭОМ∣' + normName('Труба медная Ø12,7')])
    const t = identicalTargets(views, 'ОВ', views[0].positions[0], (name, k) => priced.has(`${name}∣${k}`))
    assert.deepEqual(t.map((x) => x.name), ['ВК'])
    assert.deepEqual(identicalTargets(views, 'ОВ', views[0].positions[1], () => false), [])
  })

  it('подпись единиц: регистр и пробелы не важны, набор единиц — важен', () => {
    assert.equal(unitSignature({ unit: ' М ' }), unitSignature({ unit: 'м' }))
    assert.notEqual(unitSignature({ unit: 'шт' }), unitSignature({ units: [{ unit: 'шт' }, { unit: 'компл' }] }))
    assert.equal(unitSignature({ units: [{ unit: 'компл' }, { unit: 'шт' }] }), unitSignature({ units: [{ unit: 'ШТ' }, { unit: 'компл' }] }))
  })
})
