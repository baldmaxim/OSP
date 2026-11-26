// Окно цен позиции и ступени похожести (26.11.2026): utils/supplyPriceSearch, supplyDocMatch.gradeNames, проверка по файлу реестра.
// Случай пользователя — тендер № 1158: «Извещатель пожарный дымовой» не находил «Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ»
// ни в похожих ценах, ни в реестре (похожесть 0,6 при пороге 0,75).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSimilar } from '../../src/utils/supplySimilarity.js'
import { gradeNames, itemCandidates, matchIndex, matchIndexInSlices, mergeSamePositions, offerMatches, positionGroups } from '../../src/utils/supplyDocMatch.js'
import {
  buildPriceIndex, countPrices, gradeSummary, groupOffers, moscowDay, positionPrices, registryPriceRows, tenderPriceRows,
} from '../../src/utils/supplyPriceSearch.js'
import { autoEntries, checkSupplyLines, lineCandidates, supplyCheckIndex, supplyCheckIndexInSlices } from '../../src/utils/supplyRegistryCheck.js'

const TODAY = '2026-11-26'
const DETECTOR = 'Извещатель пожарный дымовой'
const rate = (id, name, price, day, extra = {}) => ({
  id, tender_id: 't-other', tender_number: 1100, object_name: 'ЖК Тест', estimate_name: 'ВОР СС', material_key: name.toLowerCase(),
  material_name: name, unit: 'шт', price, price_date: day, ...extra,
})
const RATES = [
  rate('r1', 'Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ', 1335, '2026-11-17'),
  rate('r2', 'Извещатель пожарный дымовой оптико-электронный автономный ИП 212-142', 452, '2026-11-17'),
  rate('r3', 'Извещатель пожарный ручной ИПР 513-11ИКЗ-А-R3, Рубеж', 1069, '2026-11-17'),
  rate('r4', 'Извещатель пожарный дымовой ИП 212-64-R3 без б/о', 1209, '2026-05-02'),
  rate('r5', 'Кабель ППГнг(А)-HF 3х1,5', 61.2, '2026-11-10', { unit: 'м' }),
]
const reg = (id, name, price, day, extra = {}) => ({
  id, source_type: 'supply_import', source_name: 'СУ-10', item_name: name, unit: 'шт', price, tender_id: null, tender_desc: null,
  object_name: 'ЖК Север', rate_date: `${day}T21:00:00+00:00`, ...extra,
})
const REGISTRY = [
  reg('g1', 'Рубеж Извещатель пожарный дымовой оптико - электронный ИП 212-64-R3 без б/о', 1090, '2026-11-08'),
  reg('g2', 'Рубеж ИП 212-64-R3 с базовым основанием W1.03 Извещатель пожарный дымовой оптико электронный адресно-аналоговый', 1165.22, '2026-06-03'),
  reg('g3', 'Рубеж Извещатель охранный магнитоуправляемый адресный ИО 10220-2', 476.63, '2026-10-22'),
  // Строка счёта этого тендера — уже «цена поставщика» окна; строка счёта, чья цена стоит ценой тендера, — повтор.
  reg('d1', 'Извещатель пожарный дымовой ИП 212-64-R3', 1300, '2026-11-20', { source_type: 'supply_doc', tender_id: 'main' }),
  reg('d2', 'Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ', 1335, '2026-11-16', { source_type: 'supply_doc', tender_id: 't-other' }),
]

describe('ступени похожести', () => {
  it('общая позиция и конкретная модель: старый порог не пропускал, теперь — «уточнение»', () => {
    // Так считала база (supply_name_score): 0,6 < 0,75 — цены не было в похожих.
    assert.equal(isSimilar(DETECTOR, RATES[0].material_name), false)
    assert.equal(gradeNames(DETECTOR, RATES[0].material_name, { score: 0.646, words: 0.667 }), 'refine')
    // Марка в начале наименования реестра — то же самое.
    assert.equal(gradeNames(DETECTOR, REGISTRY[1].item_name, { score: 0.38, words: 0.4 }), 'refine')
  })
  it('своё слово у каждой стороны без общих чисел — отдалённо; общий размер спор снимает', () => {
    assert.equal(gradeNames(DETECTOR, 'Извещатель пожарный ручной', { score: 0.71, words: 0.667 }), 'far')
    assert.equal(gradeNames('Решетка декоративная Рсв 700х400', 'Решетка вентиляционная АМН 700х400', { score: 0.62, words: 0.5 }), 'near')
  })
  it('то же наименование, артикул, выбор человека — та же позиция; другой размер — отдалённо', () => {
    assert.equal(gradeNames('Кран шаровой Ду15', 'Кран шаровой Ду15', { score: 1, exact: true }), 'same')
    assert.equal(gradeNames('Дюбель 5х30 арт.CM280530', 'Дюбель DKC CM280530', { score: 0.95, article: true }), 'same')
    assert.equal(gradeNames('Кабель ППГнг(А)-HF 3х1,5', 'Кабель ППГнг(А)-HF 3х2,5', { score: 0.5, words: 1, apart: true }), 'far')
    assert.equal(gradeNames('Кабель ППГнг(А)-HF 3х1,5', 'Кабель ППГнг(А)-HF 3х1,5 ок(N,PE)-0,66', { score: 0.8, words: 0.8 }), 'close')
  })
  it('без graded похожесть и порядок кандидатов — прежние (сопоставление счетов не меняется)', () => {
    const groups = positionGroups([{ name: 'СС', positions: [
      { k: 'a', name: DETECTOR, unit: 'шт', volume: 10 }, { k: 'b', name: 'Извещатель пожарный ручной', unit: 'шт', volume: 4 },
    ] }])
    const line = { name: 'Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ', unit: 'шт', price: 1335, qty: 10 }
    const plain = itemCandidates(line, groups, matchIndex(groups))
    const graded = itemCandidates(line, groups, matchIndex(groups), 12, { graded: true })
    assert.deepEqual(plain.map((c) => c.grade), plain.map(() => undefined))
    const scoreOf = new Map(plain.map((c) => [c.group.key, c.score]))
    for (const c of graded) if (scoreOf.has(c.group.key)) assert.equal(c.score, scoreOf.get(c.group.key))
  })
  it('указатель порциями — тот же, что сразу', async () => {
    const groups = positionGroups([{ name: 'СС', positions: RATES.map((r, i) => ({ k: `k${i}`, name: r.material_name, unit: r.unit })) }])
    const a = matchIndex(groups)
    let pauses = 0
    const b = await matchIndexInSlices(groups, { pause: async () => { pauses += 1 }, sliceMs: -1 })
    assert.ok(pauses > 0)
    for (const k of ['byKey', 'heads', 'tri', 'codes', 'articles', 'marked']) assert.deepEqual([...b[k].keys()].sort(), [...a[k].keys()].sort(), k)
  })
})

describe('цены для позиции', () => {
  it('другие тендеры и реестр: модели — «уточнение», ручной и охранный — отдалённо, старше 3 месяцев — с пометкой', async () => {
    const tenderRows = tenderPriceRows(RATES, TODAY)
    const tix = await buildPriceIndex(tenderRows)
    const found = positionPrices({ name: DETECTOR, unit: 'шт' }, tix)
    const byName = new Map(found.map((e) => [e.group.name, e]))
    assert.equal(byName.get(RATES[0].material_name).grade, 'refine')
    assert.equal(byName.get(RATES[1].material_name).grade, 'refine')
    assert.equal(byName.get(RATES[2].material_name)?.grade ?? 'far', 'far')
    const old = byName.get(RATES[3].material_name)
    assert.equal(old.grade, 'refine')
    assert.equal(old.points[0].stale, true, 'цена от 02.05 — старше 3 месяцев, но предлагается')
    assert.ok(!found.some((e) => e.group.unit === 'м'), 'другая ед. изм. — не здесь')
    assert.equal(countPrices(found), 3)
    assert.equal(countPrices(found, 'r1'), 2, 'источник скопированной цены не считается')

    const regRows = registryPriceRows(REGISTRY, { mainId: 'main', tenderRows, today: TODAY })
    assert.deepEqual(regRows.map((r) => r.id).sort(), ['reg:g1', 'reg:g2', 'reg:g3'], 'строки счетов: своего тендера и повтор цены тендера — прочь')
    const rix = await buildPriceIndex(regRows)
    const inRegistry = positionPrices({ name: DETECTOR, unit: 'шт' }, rix)
    assert.deepEqual(inRegistry.filter((e) => e.grade === 'refine').map((e) => e.group.name).sort(), [REGISTRY[0].item_name, REGISTRY[1].item_name].sort())
    assert.equal(inRegistry.find((e) => e.group.name === REGISTRY[1].item_name).points[0].stale, true)
    assert.equal(countPrices(inRegistry), 2)
  })
  it('сама позиция среди цен тендера не показывается; день реестра — по Москве', async () => {
    const own = rate('own', DETECTOR, 1000, '2026-11-20', { tender_id: 'main', estimate_name: 'ВОР СС', material_key: 'own-k' })
    const tix = await buildPriceIndex(tenderPriceRows([...RATES, own], TODAY))
    const skip = (r) => r.tenderId === 'main' && r.materialKey === 'own-k'
    assert.ok(positionPrices({ name: DETECTOR, unit: 'шт' }, tix).some((e) => e.exact))
    assert.ok(!positionPrices({ name: DETECTOR, unit: 'шт' }, tix, { skip }).some((e) => e.exact))
    assert.equal(moscowDay('2026-08-25T21:00:00+00:00'), '2026-08-26')
    assert.equal(moscowDay('2026-08-25'), '2026-08-25')
  })
  it('сводка ступени: мин., медиана, макс.', () => {
    assert.deepEqual(gradeSummary([1335, 452, 1209]), { n: 3, min: 452, max: 1335, median: 1209 })
    assert.equal(gradeSummary([]), null)
  })
  it('цены поставщиков тендера: и строка ниже порога сопоставления — в окне со ступенью', () => {
    const groups = mergeSamePositions(positionGroups([{ name: 'СС', positions: [{ k: normK(DETECTOR), name: DETECTOR, unit: 'шт', volume: 12 }] }]))
    const doc = { id: 'doc-1', file_name: 'счёт.xlsx', created_at: '2026-11-20T10:00:00Z' }
    const lines = [
      { name: 'Извещатель пожарный дымовой ИП 212-64-R3 W2.03, РУБЕЖ', unit: 'шт', price: 1335, qty: 12 },
      { name: 'Рубеж ИП 212-64-R3 с базовым основанием W1.03 Извещатель пожарный дымовой оптико электронный адресно-аналоговый', unit: 'шт', price: 1176.7 },
    ]
    const ix = matchIndex(groups)
    // Сопоставление счёта (таблица) — как раньше: длинная запись модели ниже порога сама не сопоставляется.
    const auto = offerMatches(lines, groups, ix).get(groups[0].key) || []
    assert.ok(!auto.some((o) => o.line === lines[1]))
    const list = groupOffers(groups[0], [{ doc, offer: { lines } }], groups, ix)
    assert.equal(list.length, 2)
    assert.deepEqual(list.map((o) => o.grade), ['refine', 'refine'])
    assert.equal(list[0].line.doc, doc)
  })
})

describe('проверка по файлу реестра', () => {
  it('общая строка файла: в сравнение — все уточнённые модели, а не две самые короткие записи', async () => {
    const rows = [
      ...RATES.filter((r) => r.unit === 'шт').map((r) => ({ id: r.id, item_name: r.material_name, unit: 'шт', price: r.price, rate_date: `${r.price_date}T00:00:00+03:00` })),
      ...REGISTRY.filter((r) => r.source_type === 'supply_import'),
    ]
    const index = supplyCheckIndex(rows)
    const sliced = await supplyCheckIndexInSlices(rows, async () => {})
    assert.deepEqual(sliced.groups.map((g) => g.key), index.groups.map((g) => g.key))
    const item = { name: DETECTOR, unit: 'шт', price: 1200, qty: 10 }
    const cands = lineCandidates(item, index)
    const chosen = autoEntries(cands)
    const names = [...chosen].map((c) => c.group.name)
    assert.ok(names.includes(REGISTRY[1].item_name), 'модель с маркой впереди — в сравнении')
    assert.ok(!names.some((n) => /ручной|охранный/.test(n)), 'ручной и охранный — нет')
    const [line] = checkSupplyLines([item], new Map([[0, cands]]), { vat: 'gross' })
    assert.ok(line.stats && line.stats.names >= 4)
    assert.equal(line.stats.models, true, 'медиана по разным моделям — отмечено')
    assert.ok(line.entries.every((e) => e.grade))
  })
})

function normK(s) { return s.toLowerCase() }
