// Версии ВОР в расценке снабжением (src/utils/supplyVorVersions.js, миграция 20261029): когда спросить «новая версия
// или отдельный ВОР», что подсветить с последнего просмотра, какие цены убранных позиций предложить перенести и куда,
// когда цена — за другую ед. изм. Без базы и браузера.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  carrySuggestions, carryTargets, composeChanges, revisionCounts, revisionTitle, unitMismatch, versionQuestions,
} from '../../src/utils/supplyVorVersions.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const p = (name, unit, volume, extra = {}) => ({ name, unit, volume, k: normName(name), ...extra })
const list = (over) => ({ source: 'vor_file', s3_document_id: null, separate_at: null, created_at: '2026-10-01T00:00:00Z', ...over })
const file = (id) => ({ id })

describe('Новая версия ВОР или отдельный ВОР', () => {
  const OLD = [p('Труба медная Ø12,7', 'м', 1500), p('Кран шаровой Ду15', 'шт', 48), p('Изоляция K-Flex', 'м', 1100), p('Хомут', 'шт', 200)]

  it('прежний файл удалён, совпадает хоть один материал — спросить; без цен и документов у прежнего — не спрашивать', () => {
    const sources = [
      list({ estimate_name: 'ВОР ОВ', s3_document_id: 'gone', file_name: 'ВОР ОВ.xlsx', positions: OLD }),
      list({ estimate_name: 'ВОР ОВ изм.1', s3_document_id: 'f2', file_name: 'ВОР ОВ изм.1.xlsx', created_at: '2026-10-20T00:00:00Z',
        positions: [p('Труба медная Ø12,7', 'м', 1600), p('Отвод', 'шт', 30)] }),
    ]
    const qs = versionQuestions(sources, [file('f2')], new Set(['ВОР ОВ']))
    assert.equal(qs.length, 1)
    assert.equal(qs[0].name, 'ВОР ОВ изм.1')
    assert.deepEqual(qs[0].candidates.map((c) => [c.name, c.common, c.oldCount, c.stale]), [['ВОР ОВ', 1, 4, true]])
    assert.deepEqual(versionQuestions(sources, [file('f2')], new Set()), [], 'терять нечего — не спрашиваем')
    assert.deepEqual(versionQuestions([sources[0], { ...sources[1], separate_at: '2026-10-21' }], [file('f2')], new Set(['ВОР ОВ'])), [],
      'ответили «отдельный ВОР» — больше не спрашиваем')
  })

  it('оба файла на месте — только если материалы совпадают наполовину с обеих сторон; старший ВОР про младший не спрашивают', () => {
    const k1 = list({ estimate_name: 'Корпус 1', s3_document_id: 'f1', positions: OLD })
    const k2 = list({ estimate_name: 'Корпус 2', s3_document_id: 'f2', created_at: '2026-10-20T00:00:00Z',
      positions: [...OLD.slice(0, 2), p('Отвод', 'шт', 30), p('Заглушка', 'шт', 4)] })
    const vk = list({ estimate_name: 'ВОР ВК', s3_document_id: 'f3', created_at: '2026-10-20T00:00:00Z',
      positions: [OLD[0], p('Отвод', 'шт', 30), p('Заглушка', 'шт', 4), p('Фильтр', 'шт', 2), p('Манометр', 'шт', 2)] })
    const valuable = new Set(['Корпус 1', 'Корпус 2', 'ВОР ВК'])
    const qs = versionQuestions([k1, k2, vk], [file('f1'), file('f2'), file('f3')], valuable)
    assert.deepEqual(qs.map((q) => [q.name, q.candidates.map((c) => c.name)]), [['Корпус 2', ['Корпус 1']]],
      '2 из 4 с обеих сторон — спросить; 1 из 5 — нет; загруженные одновременно (Корпус 2 и ВК) — друг про друга не спрашивают')
  })

  it('позиции из вкладки «ВОР», а файлы уже есть — прежний ВОР устарел; файл без позиций или не на месте — не спрашиваем', () => {
    const tab = list({ estimate_name: 'Основная смета', source: 'vor_tab', positions: OLD })
    const f = list({ estimate_name: 'ВОР', s3_document_id: 'f1', created_at: '2026-10-20T00:00:00Z', positions: [OLD[3]] })
    const [q] = versionQuestions([tab, f], [file('f1')], new Set(['Основная смета']))
    assert.deepEqual(q.candidates.map((c) => [c.name, c.stale, c.source]), [['Основная смета', true, 'vor_tab']])
    assert.deepEqual(versionQuestions([tab, f], [], new Set(['Основная смета'])), [], 'файла нет в «ВОРах и РД»')
    assert.deepEqual(versionQuestions([tab, { ...f, positions: [] }], [file('f1')], new Set(['Основная смета'])), [])
  })
})

describe('Что изменилось с последнего просмотра', () => {
  const rev = (id, changes, over = {}) => ({ id, kind: 'update', estimate_name: 'ОВ', reviewed_at: null, created_at: `2026-10-2${id}T10:00:00Z`, changes, ...over })
  const c = (op, name, extra = {}) => ({ op, k: normName(name), name, ...extra })

  it('одна версия: новые, объём, ед. изм., убранные с ценой — по текущим позициям', () => {
    const view = [{ name: 'ОВ', positions: [p('Кран шаровой Ду15', 'шт', 60), p('Кабель', 'м', 2000), p('Опора', 'шт', 12)] }]
    const m = composeChanges([rev(1, [
      c('volume', 'Кран шаровой Ду15', { old_unit: 'шт', old_volume: 48, price: 512.5 }),
      c('unit', 'Кабель', { old_unit: 'т', old_volume: 2 }),
      c('added', 'Опора'),
      c('removed', 'Хомут', { old_unit: 'шт', old_volume: 200, price: 35, rate_id: 'r1' }),
    ])], view).get('ОВ')
    assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, v.op])), {
      [normName('Кран шаровой Ду15')]: 'volume', [normName('Кабель')]: 'unit', [normName('Опора')]: 'added', [normName('Хомут')]: 'removed',
    })
    assert.equal(m.get(normName('Кран шаровой Ду15')).oldVolume, 48)
    assert.equal(m.get(normName('Кабель')).oldUnit, 'т')
    assert.equal(m.get(normName('Хомут')).price, 35)
  })

  it('несколько версий складываются: «было» — до первой; добавили и убрали — ничего; вернули как было — ничего; просмотренные — не в счёт', () => {
    const view = [{ name: 'ОВ', positions: [p('Кран шаровой Ду15', 'шт', 75), p('Труба', 'м', 100), p('Кабель', 'т', 2)] }]
    const m = composeChanges([
      rev(1, [c('volume', 'Кран шаровой Ду15', { old_unit: 'шт', old_volume: 48 }), c('added', 'Отвод'), c('volume', 'Труба', { old_unit: 'м', old_volume: 100 }),
        c('unit', 'Кабель', { old_unit: 'т', old_volume: 2 })]),
      rev(2, [c('volume', 'Кран шаровой Ду15', { old_unit: 'шт', old_volume: 60 }), c('removed', 'Отвод', { old_unit: 'шт', old_volume: 30 }),
        c('volume', 'Труба', { old_unit: 'м', old_volume: 120 }), c('unit', 'Кабель', { old_unit: 'м', old_volume: 2000 })]),
      rev(0, [c('added', 'Кран шаровой Ду15')], { reviewed_at: '2026-10-19' }),
    ], view).get('ОВ')
    assert.deepEqual([...m.keys()], [normName('Кран шаровой Ду15')])
    assert.equal(m.get(normName('Кран шаровой Ду15')).oldVolume, 48, 'было — до первой непросмотренной версии')
  })

  it('«штук» = «шт»: ед. изм. не изменилась; ВОР без непросмотренных версий — пусто', () => {
    const view = [{ name: 'ОВ', positions: [p('Заглушка', 'штук', 4)] }, { name: 'ВК', positions: [p('Кран', 'шт', 1)] }]
    const m = composeChanges([rev(1, [c('unit', 'Заглушка', { old_unit: 'шт.', old_volume: 4 })])], view)
    assert.equal(m.size, 0)
  })
})

describe('Перенос цены убранной позиции', () => {
  const rate = (id, name, unit, price, over = {}) => ({ id, estimate_name: 'ОВ', material_name: name, material_key: normName(name), unit, supply_price: price, ...over })
  const view = [{ name: 'ОВ', positions: [p('Хомут монтажный Ø57', 'шт', 200), p('Опора скользящая Ду57', 'шт', 12), p('Кран шаровой Ду15', 'шт', 48), p('Кабель ВВГнг 3×2,5', 'м', 100)] }]
  const own = new Set([`ОВ∣${normName('Кран шаровой Ду15')}`])
  const ownRateAt = (doc, k) => own.has(`${doc}∣${k}`)

  it('похожая позиция без своей цены, совместимая ед. изм.; одна пара на цену и на позицию; «не то» и подставленные — нет', () => {
    const orphans = [
      rate('r1', 'Хомут монтажный Ø 57', 'шт', 35),
      rate('r2', 'Хомут монтажный Ø57 оцинк.', 'шт', 40),
      rate('r3', 'Кран шаровой Ду 15', 'шт', 500),          // у крана своя цена — некуда
      rate('r4', 'Кабель ВВГнг 3х2,5', 'т', 99000),          // другая ед. изм.
      rate('r5', 'Опора скользящая Ду57', 'шт', 640, { source_kind: 'auto' }),
    ]
    const { byTarget, byRate } = carrySuggestions(view, orphans, ownRateAt)
    assert.deepEqual([...byRate.keys()], ['r1'], 'лучшая пара — у одной цены')
    assert.equal(byTarget.get(`ОВ∣${normName('Хомут монтажный Ø57')}`).rate.id, 'r1')
    const skip = carrySuggestions(view, orphans, ownRateAt, (r) => r.id === 'r1')
    assert.deepEqual([...skip.byRate.keys()], ['r2'], '«не то» у первой — предлагаем следующую')
  })

  it('список позиций для переноса вручную: без своей цены, сначала та же ед. изм. и похожие', () => {
    const t = carryTargets(view[0], rate('r1', 'Хомут монтажный Ø 57', 'шт', 35), ownRateAt)
    assert.ok(!t.some((x) => x.position.name === 'Кран шаровой Ду15'), 'у крана своя цена')
    assert.equal(t[0].position.name, 'Хомут монтажный Ø57', 'самая похожая — первой')
    assert.equal(t.at(-1).position.name, 'Кабель ВВГнг 3×2,5', 'другая ед. изм. — в конце')
    assert.equal(t.at(-1).sameUnit, false)
  })

  it('цена за другую ед. изм.: «т» и «м» — да; «м» и «пог. м», «шт» и «штук» — нет; без единицы или несколько единиц — нет', () => {
    assert.equal(unitMismatch({ unit: 'т' }, p('Кабель', 'м', 1)), true)
    assert.equal(unitMismatch({ unit: 'пог. м' }, p('Кабель', 'м', 1)), false)
    assert.equal(unitMismatch({ unit: 'штук' }, p('Кран', 'шт', 1)), false)
    assert.equal(unitMismatch({ unit: null }, p('Кран', 'шт', 1)), false)
    assert.equal(unitMismatch({ unit: 'т' }, { name: 'x', units: [{ unit: 'м' }, { unit: 'шт' }] }), false)
  })
})

it('подпись версии: что случилось и сколько', () => {
  assert.equal(revisionCounts({ added: 3, removed: 2, priced_removed: 1, volume_changed: 5, unit_changed: 0 }), 'новых 3 · убрано 2 (с ценой 1) · объём 5')
  assert.equal(revisionTitle({ kind: 'update', old_file_name: 'ВОР ОВ.xlsx', new_file_name: 'ВОР ОВ.xlsx', added: 1 }), 'файл «ВОР ОВ.xlsx» заменён новым: новых 1')
  assert.equal(revisionTitle({ kind: 'update', old_file_name: 'ВОР ОВ.xlsx', new_file_name: 'ВОР ОВ изм.1.xlsx' }), 'новый файл «ВОР ОВ изм.1.xlsx» вместо «ВОР ОВ.xlsx», материалы те же')
  assert.match(revisionTitle({ kind: 'removed', old_file_name: 'ВОР ОВ.xlsx' }), /удалён из «ВОРов и РД» — позиции и цены остались/)
  assert.match(revisionTitle({ kind: 'added', new_file_name: 'ВОР ВК.xlsx', positions_after: 12 }), /позиций 12/)
})
