// Версии ВОР в расценке снабжением (src/utils/supplyVorVersions.js, миграция 20261029): когда спросить «новая версия
// или отдельный ВОР», что подсветить с последнего просмотра, какие цены убранных позиций предложить перенести и куда,
// когда цена — за другую ед. изм. Без базы и браузера.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  carrySuggestions, carryTargets, composeChanges, revisionCounts, revisionTitle, unitMismatch, versionQuestions, versionlessName, vorTitle,
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

  // Тендер № 704, 18.11.2026: файл «ЭОМ-6 V1» заменили на «ЭОМ-6 v2» — страница спросила про все ВОР ЭОМ, заведённые позже
  // «ЭОМ-6» (у соседних секций треть материалов общая: кабель, лотки), в том числе про «ЭОМ-3», уже принятый на свою v2. «Да» у
  // такого вопроса слило бы два разных ВОР; после ответа у верного вопроса остальные исчезли, и казалось, что «ЭОМ-3 не обновился».
  it('удалён файл прежнего: соседний ВОР с частью общих материалов — не версия; версия — файл с тем же именем, кроме редакции', () => {
    const cable = Array.from({ length: 30 }, (_, i) => p(`Кабель ВВГнг-LS 3x${i + 1}`, 'м', 100))
    const own = (tag, n) => Array.from({ length: n }, (_, i) => p(`Светильник ${tag}-${i + 1}`, 'шт', 10))
    const at = (s) => `2026-10-19T10:39:${s}Z`
    const eom6 = list({ estimate_name: 'ВОР ЭОМ-6 V1', s3_document_id: 'gone', file_name: 'ВОР ЭОМ-6 V1.xlsx', created_at: at(24), positions: [...cable, ...own('6', 50)] })
    const eom5 = list({ estimate_name: 'ВОР ЭОМ-5 v1', s3_document_id: 'f5', file_name: 'ВОР ЭОМ-5 v1.xlsx', created_at: at(25), positions: [...cable, ...own('5', 40)] })
    // «ЭОМ-3» уже принят на свою v2: имя ВОР прежнее, файл новый.
    const eom3 = list({ estimate_name: 'ВОР ЭОМ-3 V1', s3_document_id: 'f3', file_name: 'ВОР ЭОМ-3 v2.xlsx', created_at: at(26), positions: [...cable, ...own('3', 45)] })
    const eom6v2 = list({ estimate_name: 'ВОР ЭОМ-6 v2', s3_document_id: 'f6', file_name: 'ВОР ЭОМ-6 v2.xlsx', created_at: '2026-11-18T08:50:19Z',
      positions: [...cable, ...own('6', 52)] })
    const files = [file('f5'), file('f3'), file('f6')]
    const valuable = new Set(['ВОР ЭОМ-6 V1', 'ВОР ЭОМ-5 v1', 'ВОР ЭОМ-3 V1'])
    const qs = versionQuestions([eom6, eom5, eom3, eom6v2], files, valuable)
    assert.deepEqual(qs.map((q) => [q.name, q.candidates.map((c) => [c.name, c.named])]), [['ВОР ЭОМ-6 v2', [['ВОР ЭОМ-6 V1', true]]]])

    // Без «ЭОМ-6 v2»: соседние ВОР не спрашиваются — общих материалов меньше половины.
    assert.deepEqual(versionQuestions([eom6, eom5, eom3], [file('f5'), file('f3')], valuable), [])
    // Соседний ВОР, похожий больше чем наполовину, при найденной версии про «ЭОМ-6» не спрашивается.
    const twin = list({ estimate_name: 'ВОР ЭОМ-7 v1', s3_document_id: 'f7', file_name: 'ВОР ЭОМ-7 v1.xlsx', created_at: at(27), positions: eom6.positions })
    assert.deepEqual(versionQuestions([eom6, twin], [file('f7')], valuable).map((q) => q.name), ['ВОР ЭОМ-7 v1'], 'версии нет — спросить по совпадению')
    assert.deepEqual(versionQuestions([eom6, twin, eom6v2], [file('f7'), file('f6')], valuable).map((q) => q.name), ['ВОР ЭОМ-6 v2'])
    // Новое имя файла без общей основы (ВОР переименовали) — по совпадению материалов, как с живым файлом.
    const renamed = { ...eom6v2, estimate_name: 'ВОР ЭО секции 6', file_name: 'ВОР ЭО секции 6.xlsx' }
    assert.deepEqual(versionQuestions([eom6, renamed], [file('f6')], valuable)[0].candidates.map((c) => [c.name, c.named]), [['ВОР ЭОМ-6 V1', false]])
  })

  it('имя без отметки редакции: v2, изм., версия, ред., дата, копия «(1)», подчёркивания — то же; номер раздела — нет', () => {
    const same = [
      ['ВОР ЭОМ-6 V1', 'ВОР ЭОМ-6 v2'], ['ВОР ОВ', 'ВОР ОВ изм.1'], ['ЭОМ-2-РД', 'ЭОМ-2-РД_Изм.2'], ['ВОР ЭН', 'ВОР ЭН от 03.11.2026 версия 2'],
      ['ВОР площадок С1-5', 'ВОР площадок С1-5 (1)'], ['ВОР полов (-1,-2 эт)', 'ВОР_полов_1,_2_эт'], ['ВОР 2026-10-28 — 14.6', 'ВОР 2026-10-28 14.6'],
      ['ВОР АСУД ред. 3', 'ВОР АСУД'], ['ВОР Корпус 5 17.11.2026', 'ВОР_Корпус_5 '],
    ]
    for (const [a, b] of same) assert.equal(versionlessName(a), versionlessName(b), `${a} = ${b}`)
    const differ = [['ВОР ЭОМ-3 V1', 'ВОР ЭОМ-6 V1'], ['ВОР ЭОМ-АС v1', 'ВОР ЭОМ.НС v1'], ['ВОР 14.6', 'ВОР 14.5'], ['ВОР Редуктор 2', 'ВОР 2'], ['Секция 1.3', 'ВОР 1.3']]
    for (const [a, b] of differ) assert.notEqual(versionlessName(a), versionlessName(b), `${a} ≠ ${b}`)
  })

  it('имя ВОР на странице: устаревшая редакция в имени — по файлу, который скачивается; имя ВОР карточки — как есть', () => {
    const title = (estimate_name, file_name, o = {}) => vorTitle(list({ estimate_name, file_name, ...o }))
    assert.equal(title('ВОР ЭОМ-6 V1', 'ВОР ЭОМ-6 v2.xlsx'), 'ВОР ЭОМ-6 v2', 'после «новой версии» ключ прежний')
    assert.equal(title('ВОР ЭМ1-ПА, ЭО1-ПА v1', 'ВОР ЭО1-ПА v2.xlsx'), 'ВОР ЭО1-ПА v2', 'в прежнем имени — редакция: она устарела')
    assert.equal(title('ВОР ЭН', 'ВОР ЭН от 03.11.2026 версия 2.xlsx'), 'ВОР ЭН от 03.11.2026 версия 2', 'то же имя с новой отметкой')
    assert.equal(title('ОВ', 'ВОР_ОВ изм.1.xlsx'), 'ОВ', 'привязан к ВОР карточки')
    assert.equal(title('Секция 1.3', 'ВОР 2026-10-26 1.3.xlsx'), 'Секция 1.3')
    assert.equal(title('ВОР полов (-1,-2 эт)', 'ВОР_полов_1,_2_эт.xlsx'), 'ВОР полов (-1,-2 эт)', 'другое написание того же имени')
    assert.equal(title('ВОР ОВ', null), 'ВОР ОВ')
    assert.equal(title('Основная смета', 'x.xlsx', { source: 'vor_tab' }), 'Основная смета')
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
