// Цены, поставленные из файла счёта или КП (19.11.2026, просьба пользователя: «когда убираю счёт, как снять цены, которые из
// него проставлялись»): какие цены считаются ценами файла и какие следы удалённых файлов ещё живы. Правила без браузера;
// окно удаления и строка удалённого файла — «удаление счёта» в tests/tender/supply-pricing.test.mjs, таблица следов —
// tests/supply/removed-docs-db.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { offersByGroup, uniqueOfferDocs } from '../../src/utils/supplyAutoPick.js'
import { positionGroups } from '../../src/utils/supplyDocMatch.js'
import { pricesOfDoc, removedDocPrices, tracePriceSame } from '../../src/utils/supplyDocPrices.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const position = (name, unit = 'шт', volume = 10) => ({ name, unit, volume, k: normName(name) })
const NAMES = ['Кран шаровой Ду15', 'Кран шаровой Ду20', 'Манометр общего назначения', 'Хомут монтажный 20 мм']
const groups = positionGroups([{ name: 'ОВ', positions: NAMES.map((n) => position(n)) }])
const docOf = (id, lines, offer = {}) => ({ doc: { id, file_name: `${id}.xlsx`, created_at: '2026-11-01T00:00:00Z' }, offer: { date: '2026-11-01', currency: null, lines, ...offer } })
const line = (name, price) => ({ name, unit: 'шт', qty: 10, price, skip: false, k: null })
const keyOf = (name) => `ОВ∣${normName(name)}`
let seq = 0
const rate = (name, price, o = {}) => ({ id: `r${++seq}`, estimate_name: 'ОВ', material_name: name, material_key: normName(name), unit: 'шт', supply_price: price, supply_price_exact: price, price_input: 'unit', source_kind: null, ...o })
// Что сейчас у позиций: цены и файлы документов по ключу «ВОР∣ключ наименования».
const state = (rates, links) => (t) => {
  const key = `${t.doc}∣${t.position.k}`
  return { key, rate: rates.find((r) => r.estimate_name === t.doc && r.material_key === t.position.k) || null, docId: links[key] || null }
}
const names = (list) => list.map((x) => x.name).sort()

describe('цены, поставленные из файла', () => {
  it('только позиции, где файл — документ позиции и своя цена совпала с его строкой', () => {
    const docs = [docOf('a', [line(NAMES[0], 100), line(NAMES[1], 200), line(NAMES[2], 300)]), docOf('b', [line(NAMES[3], 50)])]
    const byGroup = offersByGroup(docs, groups)
    const rates = [rate(NAMES[0], 100), rate(NAMES[1], 250), rate(NAMES[2], 300), rate(NAMES[3], 50)]
    const links = { [keyOf(NAMES[0])]: 'a', [keyOf(NAMES[1])]: 'a', [keyOf(NAMES[3])]: 'b' }
    const res = pricesOfDoc('a', groups, byGroup, state(rates, links))
    // Ду20 — цену после применения исправили руками (250 вместо 200); манометр — цена совпала, но файл к позиции не приложен
    // (ввели сами); хомут — цена другого файла.
    assert.deepEqual(names(res), [NAMES[0]])
    assert.deepEqual([res[0].key, res[0].price, res[0].rate.id, res[0].estimate], [keyOf(NAMES[0]), 100, rates[0].id, 'ОВ'])
    assert.deepEqual(names(pricesOfDoc('b', groups, byGroup, state(rates, links))), [NAMES[3]])
    assert.deepEqual(pricesOfDoc('нет', groups, byGroup, state(rates, links)), [])
  })

  it('цена с другим НДС того же документа — тоже его; копия из другого тендера и цена из Excel — нет', () => {
    const net = docOf('a', [line(NAMES[0], 122), line(NAMES[1], 244), line(NAMES[2], 366)], { vat: { mode: 'net', rate: 22 } })
    const byGroup = offersByGroup([net], groups)
    const alt = byGroup.get(groups[0].key)[0].alts?.[0]
    assert.ok(alt > 0 && alt !== 122, 'у строки есть цена с другим НДС')
    const rates = [rate(NAMES[0], alt), rate(NAMES[1], 244, { source_kind: 'pick' }), rate(NAMES[2], 366, { price_input: 'import' })]
    const links = Object.fromEntries(NAMES.map((n) => [keyOf(n), 'a']))
    assert.deepEqual(names(pricesOfDoc('a', groups, byGroup, state(rates, links))), [NAMES[0]])
  })

  it('повтор документа своих строк не показывает — цен у него нет; у оставленного документа — только свои позиции', () => {
    const a = docOf('a', [line(NAMES[0], 100), line(NAMES[1], 200)])
    const copy = { ...a, doc: { ...a.doc, id: 'a-copy', file_name: 'копия.xlsx', created_at: '2026-11-05T00:00:00Z' } }
    const view = uniqueOfferDocs([a, copy], (doc) => (doc.id === 'a' ? 1 : 0))
    assert.deepEqual([view.docs.map((x) => x.doc.id), view.dupes.map((x) => [x.doc.id, x.of.id])], [['a'], [['a-copy', 'a']]])
    const byGroup = offersByGroup(view.docs, groups)
    const rates = [rate(NAMES[0], 100), rate(NAMES[1], 200)]
    const links = { [keyOf(NAMES[0])]: 'a', [keyOf(NAMES[1])]: 'a-copy' }
    assert.deepEqual(pricesOfDoc('a-copy', groups, byGroup, state(rates, links)), [], 'удаляют повтор — те же строки остаются у оставленного файла')
    assert.deepEqual(names(pricesOfDoc('a', groups, byGroup, state(rates, links))), [NAMES[0]], 'позиции повтора остаются при нём')
  })

  it('позиция без цены, документ без строк и цены в валюте — снимать нечего', () => {
    const links = { [keyOf(NAMES[0])]: 'a' }
    assert.deepEqual(pricesOfDoc('a', groups, offersByGroup([docOf('a', [line(NAMES[0], 100)])], groups), state([], links)), [])
    assert.deepEqual(pricesOfDoc('a', groups, new Map(), state([rate(NAMES[0], 100)], links)), [])
    const usd = offersByGroup([docOf('a', [line(NAMES[0], 100)], { currency: 'USD' })], groups)
    assert.deepEqual(pricesOfDoc('a', groups, usd, state([rate(NAMES[0], 100)], links)), [])
  })
})

describe('следы удалённых файлов', () => {
  const trace = (id, r, price, doc = 'a', at = '2026-11-19T10:00:00Z') => ({ id, rate_id: r.id, doc_id: doc, doc_name: `${doc}.xlsx`, price, removed_at: at })
  const byId = (rates) => new Map(rates.map((r) => [r.id, r]))

  it('след жив, пока цену не трогали: та же цена, своя, у позиции нет нового документа', () => {
    const same = rate(NAMES[0], 100)
    const edited = rate(NAMES[1], 250)
    const copied = rate(NAMES[2], 300, { source_kind: 'pick' })
    const redoc = rate(NAMES[3], 50)
    const traces = [trace('t1', same, 100), trace('t2', edited, 200), trace('t3', copied, 300), trace('t4', redoc, 50), trace('t5', { id: 'нет цены' }, 10)]
    const res = removedDocPrices(traces, byId([same, edited, copied, redoc]), { hasDoc: (r) => r.id === redoc.id })
    assert.equal(res.length, 1)
    assert.deepEqual([res[0].docId, res[0].name, res[0].rows.map((x) => x.trace.id)], ['a', 'a.xlsx', ['t1']])
    assert.equal(tracePriceSame(traces[0], same), true)
    assert.equal(tracePriceSame({ price: '100.004' }, same), true, 'копейки округления — та же цена')
    assert.equal(tracePriceSame(traces[1], edited), false)
    assert.equal(tracePriceSame(traces[0], null), false)
  })

  it('по файлам, недавно удалённые первыми; файл, который не удалился, не считается', () => {
    const r1 = rate(NAMES[0], 100)
    const r2 = rate(NAMES[1], 200)
    const r3 = rate(NAMES[2], 300)
    const traces = [trace('t1', r1, 100, 'a', '2026-11-18T10:00:00Z'), trace('t2', r2, 200, 'b', '2026-11-19T10:00:00Z'), trace('t3', r3, 300, 'a', '2026-11-18T10:00:05Z')]
    const res = removedDocPrices(traces, byId([r1, r2, r3]))
    assert.deepEqual(res.map((d) => [d.docId, d.rows.length, d.at]), [['b', 1, '2026-11-19T10:00:00Z'], ['a', 2, '2026-11-18T10:00:05Z']])
    assert.deepEqual(removedDocPrices(traces, byId([r1, r2, r3]), { alive: new Set(['a']) }).map((d) => d.docId), ['b'])
    assert.deepEqual(removedDocPrices(null, new Map()), [])
  })
})
