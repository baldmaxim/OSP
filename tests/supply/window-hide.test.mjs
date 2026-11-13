// Окно «Счета и КП тендера» (13.11.2026, просьба пользователя): позиции, которые не стали расценивать, убираются разом и не
// смешиваются с ценами нового документа. Правила без браузера: что хранится при файле, какие цены видит окно, что убирается.
// Окно в браузере — «Счета и КП: убрать неотмеченные» в tests/tender/supply-pricing.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { autoPickRows, groupHideKeys, hideKeysByDoc, isHiddenAt, offersByGroup, windowOffers } from '../../src/utils/supplyAutoPick.js'
import { mergeSamePositions, positionGroups } from '../../src/utils/supplyDocMatch.js'
import { OFFER_HIDDEN_MAX, offerNotes, readOffer } from '../../src/utils/supplyOffers.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const position = (name, unit, volume = 10) => ({ name, unit, volume, k: normName(name) })
const groups = positionGroups([{ name: 'ОВ', positions: [
  position('Кран шаровой Ду15', 'шт'), position('Кран шаровой Ду20', 'шт'), position('Манометр общего назначения', 'шт'),
] }])
const docOf = (id, date, lines, hidden = []) => ({ doc: { id, file_name: `${id}.xlsx`, created_at: '2026-10-01T00:00:00Z' }, offer: { date, currency: null, lines, hidden } })
const line = (name, price) => ({ name, unit: 'шт', qty: 10, price, skip: false, k: null })
const empty = () => ({ own: [], copies: 0, empty: 1, ownAt: null })
const rowsOf = (byGroup) => autoPickRows(byGroup, groups, { currentOf: empty }).rows
const names = (rows) => rows.map((r) => r.group.name).sort()

describe('окно «Счета и КП»: убранные позиции и цены по документам', () => {
  it('убранное хранится при файле: запись и чтение notes, повторы и пустые ключи — нет; без убранного поля нет', () => {
    const notes = offerNotes({ lines: [line('Кран шаровой Ду15', 100)], hidden: ['a|шт', 'a|шт', '', null, 'b  c|м'] })
    assert.deepEqual(JSON.parse(notes).xh, ['a|шт', 'b  c|м'], 'ключ — как есть, пробелы не схлопываются')
    assert.deepEqual(readOffer(notes).hidden, ['a|шт', 'b  c|м'])
    const plain = offerNotes({ lines: [line('Кран шаровой Ду15', 100)] })
    assert.equal('xh' in JSON.parse(plain), false)
    assert.deepEqual(readOffer(plain).hidden, [])
    const many = Array.from({ length: OFFER_HIDDEN_MAX + 5 }, (_, i) => `k${i}`)
    const kept = readOffer(offerNotes({ lines: [line('Кран', 1)], hidden: many })).hidden
    assert.equal(kept.length, OFFER_HIDDEN_MAX)
    assert.equal(kept.at(-1), `k${OFFER_HIDDEN_MAX + 4}`, 'остаются последние убранные')
  })

  it('убрали неотмеченные — их цены из этих документов окно не предлагает; новый документ предлагает их заново', () => {
    const a = docOf('a', '2026-10-01', [line('Кран шаровой Ду15', 100), line('Кран шаровой Ду20', 150), line('Манометр общего назначения', 300)])
    const all = rowsOf(windowOffers(offersByGroup([a], groups), [a]).byGroup)
    assert.deepEqual(names(all), ['Кран шаровой Ду15', 'Кран шаровой Ду20', 'Манометр общего назначения'])
    // Человек отметил только Ду15 и убрал остальные.
    const byDoc = hideKeysByDoc(all.filter((r) => r.group.name !== 'Кран шаровой Ду15'))
    assert.deepEqual([...byDoc.keys()], ['a'])
    const aHidden = { ...a, offer: { ...a.offer, hidden: [...byDoc.get('a')] } }
    const view = windowOffers(offersByGroup([aHidden], groups), [aHidden])
    assert.deepEqual(names(rowsOf(view.byGroup)), ['Кран шаровой Ду15'])
    assert.equal(view.hidden, 2, 'сколько убрано — для «вернуть»')

    // Новый документ: Ду20 снова предлагается — его ценой; манометра в нём нет — не всплывает.
    const b = docOf('b', '2026-10-20', [line('Кран шаровой Ду20', 140)])
    const docs = [aHidden, b]
    const both = windowOffers(offersByGroup(docs, groups), docs)
    const du20 = rowsOf(both.byGroup).find((r) => r.group.name === 'Кран шаровой Ду20')
    assert.deepEqual([du20.shown.doc.id, du20.shown.price, du20.offers.length], ['b', 140, 1], 'убранная цена прежнего документа не вернулась')
    assert.equal(both.hidden, 2, 'убрано у Ду20 (цена «a») и у манометра — обе можно вернуть')
    assert.equal(isHiddenAt(docs, 'a', du20.group), true)
    assert.equal(isHiddenAt(docs, 'b', du20.group), false)
  })

  it('цены одного документа: автовыбор только среди его строк, прежние документы не мешают', () => {
    const a = docOf('a', '2026-10-25', [line('Кран шаровой Ду15', 100), line('Манометр общего назначения', 300)])
    const b = docOf('b', '2026-10-01', [line('Кран шаровой Ду15', 120)])
    const docs = [a, b]
    const byGroup = offersByGroup(docs, groups)
    // Все документы: Ду15 — из более свежего «a».
    assert.equal(rowsOf(windowOffers(byGroup, docs).byGroup).find((r) => r.group.name === 'Кран шаровой Ду15').shown.doc.id, 'a')
    // Только «b»: одна строка, цена «b», манометра нет.
    const onlyB = rowsOf(windowOffers(byGroup, docs, new Set(['b'])).byGroup)
    assert.deepEqual(onlyB.map((r) => [r.group.name, r.shown.doc.id, r.shown.price]), [['Кран шаровой Ду15', 'b', 120]])
  })

  it('убрать позицию — у всех документов окна, где она есть: на её месте не всплывает цена другого', () => {
    const a = docOf('a', '2026-10-01', [line('Кран шаровой Ду15', 100)])
    const b = docOf('b', '2026-10-20', [line('Кран шаровой Ду15', 120)])
    const docs = [a, b]
    const rows = rowsOf(windowOffers(offersByGroup(docs, groups), docs).byGroup)
    const byDoc = hideKeysByDoc(rows)
    assert.deepEqual([...byDoc.keys()].sort(), ['a', 'b'])
    const hidden = docs.map((x) => ({ ...x, offer: { ...x.offer, hidden: [...byDoc.get(x.doc.id)] } }))
    assert.equal(rowsOf(windowOffers(offersByGroup(hidden, groups), hidden).byGroup).length, 0)
    // В окне одного документа — убирается только у него.
    const onlyB = rowsOf(windowOffers(offersByGroup(docs, groups), docs, new Set(['b'])).byGroup)
    assert.deepEqual([...hideKeysByDoc(onlyB).keys()], ['b'])
  })

  it('сложенная позиция (одна и та же в разных ВОР) убирается всеми своими записями', () => {
    const merged = mergeSamePositions(positionGroups([
      { name: 'ОВ', positions: [position('Кран шаровой латунный Ду15', 'шт')] },
      { name: 'ВК', positions: [position('Кран шаровой латунный Ду15 ', 'шт')] },
    ]))
    for (const g of merged) {
      const keys = groupHideKeys(g)
      assert.equal(keys[0], g.key)
      assert.deepEqual(keys.slice(1), (g.sameAs || []).map((s) => s.key))
    }
  })
})
