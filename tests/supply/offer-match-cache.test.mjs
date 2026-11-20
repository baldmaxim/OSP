// Скорость расценки снабжения на больших тендерах (№ 704, 20.11.2026: «страница стала адски долго и лагуче загружаться»).
// Сопоставление строк счетов и КП с позициями ВОР считалось дважды (таблица — offerMatches, окно «Счета и КП» — offersByGroup)
// и заново после каждого «Взять» / «Применить» / правки коллеги: 2,3 с на быстром компьютере. Теперь кандидаты строки ищутся
// один раз на набор позиций (sharedMatchIndex), первый поиск идёт порциями (primeOfferLine), а пересчёт не запускается, пока
// документы по сути те же (sameOfferView, keepSameOffers). Здесь — что результат от этого не меняется. Замер на данных 704 —
// вне репозитория (выгрузка прода); итог записан в docs/claude-reference/supply-pricing.md.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { keepSameLines, keepSameOffers, offersByGroup, sameOfferView, uniqueOfferDocs } from '../../src/utils/supplyAutoPick.js'
import { itemCandidates, MATCH_CANDIDATES, mergeSamePositions, offerMatches, positionGroups, primeOfferLine, sharedMatchIndex } from '../../src/utils/supplyDocMatch.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'
import { offerNotes, readOffer } from '../../src/utils/supplyOffers.js'

const position = (name, unit, volume = 10) => ({ name, unit, volume, k: normName(name) })
const views = () => [
  { name: 'ЭОМ-3', positions: [
    position('Кабель ВВГнг(А)-LS 3х2,5', 'м', 1200), position('Кабель ВВГнг(А)-LS 5х10', 'м', 300),
    position('Автоматический выключатель 1P 16А', 'шт', 40), position('Щит ЩРн-24', 'компл', 4),
    position('Труба гофрированная ПВХ d20', 'м', 900), position('Лоток перфорированный 100х50', 'м', 120),
  ] },
  { name: 'ЭОМ-6', positions: [
    position('Кабель ВВГнг(А)-LS 3х2,5', 'м', 800), position('Кабель ВВГнг(А)-LS 3х1,5', 'м', 600),
    position('Выключатель автоматический 1P 16A', 'шт', 25), position('Светильник светодиодный 36 Вт', 'шт', 70),
    position('Коробка распаячная 100х100', 'шт', 50),
  ] },
]
const groupsOf = () => mergeSamePositions(positionGroups(views()))
const line = (name, unit, price, extra = {}) => ({ name, unit, qty: 10, price, skip: false, k: null, ...extra })
const docLines = () => [
  line('Кабель ВВГнг(А)-LS 3х2,5 ок (N, PE)-0,66', 'м', 98.5),
  line('Кабель ВВГнг-LS 5x10', 'м', 640),
  line('Кабель ВВГнг(А)-LS 3х1,5', 'км', 61000),
  line('Выключатель автоматический ВА47-29 1Р 16А', 'шт', 210),
  line('Щит распределительный ЩРн-24', 'шт', 3100),
  line('Труба гофр. ПВХ 20 мм (бухта 100 м)', 'бухта', 1500),
  line('Лоток 100*50 перфорированный', 'м', 420, { name2: 'Лоток перфорированный 100х50 L=3000' }),
  line('Светильник LED 36W', 'шт', 890),
  line('Коробка распаячная 100х100х50', 'шт', 75, { skip: true }),
  line('Шпилька М8', 'шт', 12),
]
const doc = (id, lines, at = '2026-11-17T10:00:00Z') => ({ doc: { id, file_name: `${id}.xlsx`, created_at: at }, offer: { currency: null, lines } })
// Отпечаток без ссылок на объекты: что сопоставилось с чем и как.
const printMatches = (m) => [...m].map(([key, list]) => [key, list.map((o) => [o.line.name, o.group.key, o.score, !!o.exact, !!o.picked, !!o.unitOk, o.pack ?? null, !!o.same])])
const printPicks = (m) => [...m].map(([key, list]) => [key, list.map((o) => [o.id, o.price, o.score, o.exact, o.picked, o.unitOk, o.pack, o.same, (o.twins || []).map((d) => d.id)])])

describe('расценка снабжения: кандидаты строк документов — один раз на набор позиций', () => {
  it('с общим указателем таблица и окно сопоставляют так же, как без него', () => {
    const docs = [doc('a', docLines()), doc('b', [line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 101), line('Светильник светодиодный 36 Вт', 'шт', 905)])]
    const lines = docs.flatMap((d) => d.offer.lines)
    const plain = groupsOf()
    const shared = groupsOf()
    const ix = sharedMatchIndex(shared)
    assert.deepEqual(printMatches(offerMatches(lines, shared, ix)), printMatches(offerMatches(lines, plain)))
    assert.deepEqual(printPicks(offersByGroup(docs, shared, ix)), printPicks(offersByGroup(docs, plain)))
    // Второй раз — из памяти, то же самое.
    assert.deepEqual(printMatches(offerMatches(lines, shared, ix)), printMatches(offerMatches(lines, plain)))
    assert.deepEqual(printPicks(offersByGroup(docs, shared, ix)), printPicks(offersByGroup(docs, plain)))
    assert.ok(printMatches(offerMatches(lines, plain)).length >= 6, 'строки действительно сопоставились')
  })

  it('прогрев порциями (primeOfferLine) не меняет результата', () => {
    const docs = [doc('a', docLines())]
    const lines = docs[0].offer.lines
    const fresh = groupsOf()
    const primed = groupsOf()
    const ix = sharedMatchIndex(primed)
    for (const l of lines) primeOfferLine(l, primed, ix)
    assert.deepEqual(printMatches(offerMatches(lines, primed, ix)), printMatches(offerMatches(lines, fresh)))
    assert.deepEqual(printPicks(offersByGroup(docs, primed, ix)), printPicks(offersByGroup(docs, fresh)))
  })

  it('указатель — один на тот же массив позиций; новые позиции — новый указатель и новый поиск', () => {
    const groups = groupsOf()
    assert.equal(sharedMatchIndex(groups), sharedMatchIndex(groups))
    const other = groupsOf()
    assert.notEqual(sharedMatchIndex(other), sharedMatchIndex(groups))
    // Позиции сменились (новая версия ВОР): кандидаты ищутся среди новых позиций, а не берутся из памяти прежних.
    const l = line('Светильник LED 36W', 'шт', 890)
    assert.ok(itemCandidates(l, groups, sharedMatchIndex(groups)).length > 0)
    const without = mergeSamePositions(positionGroups(views().map((v) => ({ ...v, positions: v.positions.filter((p) => !/Светильник/.test(p.name)) }))))
    assert.deepEqual(itemCandidates(l, without, sharedMatchIndex(without)).map((c) => c.group.key), itemCandidates(l, without).map((c) => c.group.key))
  })

  it('список кандидатов — копия: сортировка у вызывающего память не портит; другая строка — свой поиск', () => {
    const groups = groupsOf()
    const ix = sharedMatchIndex(groups)
    const l = line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 98.5)
    const first = itemCandidates(l, groups, ix, MATCH_CANDIDATES, { packs: true })
    const keys = first.map((c) => c.group.key)
    assert.ok(keys.length >= 2, 'кандидатов несколько — порядок есть что портить')
    first.reverse()
    first.length = 0
    assert.deepEqual(itemCandidates(l, groups, ix, MATCH_CANDIDATES, { packs: true }).map((c) => c.group.key), keys)
    // Те же условия поиска — разные списки для разных packs и limit.
    assert.deepEqual(itemCandidates(l, groups, ix, 1, { packs: true }).map((c) => c.group.key), itemCandidates(l, groups, null, 1, { packs: true }).map((c) => c.group.key))
    const pack = line('Труба гофр. ПВХ 20 мм (бухта 100 м)', 'бухта', 1500)
    assert.deepEqual(itemCandidates(pack, groups, ix, MATCH_CANDIDATES, { packs: false }).map((c) => [c.group.key, c.unitOk, c.pack]),
      itemCandidates(pack, groups, null, MATCH_CANDIDATES, { packs: false }).map((c) => [c.group.key, c.unitOk, c.pack]))
    assert.deepEqual(itemCandidates(pack, groups, ix, MATCH_CANDIDATES, { packs: true }).map((c) => [c.group.key, c.unitOk, c.pack]),
      itemCandidates(pack, groups, null, MATCH_CANDIDATES, { packs: true }).map((c) => [c.group.key, c.unitOk, c.pack]))
    // Изменённая строка документа — новый объект (новый разбор notes): прежние кандидаты ей не достаются.
    const changed = { ...l, name: 'Светильник LED 36W', unit: 'шт' }
    assert.deepEqual(itemCandidates(changed, groups, ix).map((c) => c.group.key), itemCandidates(changed, groups).map((c) => c.group.key))
  })

  it('без общего указателя — без памяти, как прежде (проверка КП, кабинет подрядчика)', () => {
    const groups = groupsOf()
    const l = line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 98.5)
    const a = itemCandidates(l, groups)
    const b = itemCandidates(l, groups)
    assert.notEqual(a[0], b[0], 'каждый вызов ищет заново')
    assert.deepEqual(a.map((c) => c.group.key), b.map((c) => c.group.key))
  })
})

describe('расценка снабжения: пересчёт цен документов — только когда документы по сути другие', () => {
  const entry = (id, notes, extra = {}) => ({ doc: { id, file_name: `${id}.pdf`, created_at: '2026-11-17T10:00:00Z', ...extra }, offer: { lines: [line(`Позиция ${id}`, 'шт', 10)] }, notes })

  it('сменился только вес документов (документы позиций) — повторы те же, вид прежний', () => {
    const a = { doc: { id: 'a', created_at: '2026-11-01' }, offer: { lines: [line('Кабель', 'м', 10)] } }
    const b = { doc: { id: 'b', created_at: '2026-11-02' }, offer: { lines: [line('Кабель', 'м', 10)] } } // повтор «a»
    const c = { doc: { id: 'c', created_at: '2026-11-03' }, offer: { lines: [line('Лоток', 'м', 50)] } }
    const before = uniqueOfferDocs([a, b, c], () => 0)
    assert.deepEqual(before.docs.map((x) => x.doc.id), ['a', 'c'])
    // У «c» стало больше позиций — на выбор повтора это не влияет.
    assert.equal(sameOfferView(before, uniqueOfferDocs([a, b, c], (d) => (d.id === 'c' ? 5 : 0))), true)
    // У повтора «b» позиций больше — оставляется он: вид другой, цены пересчитываются.
    const flipped = uniqueOfferDocs([a, b, c], (d) => (d.id === 'b' ? 3 : 0))
    assert.deepEqual(flipped.docs.map((x) => x.doc.id), ['b', 'c'])
    assert.equal(sameOfferView(before, flipped), false)
    // Документ убрали — другой вид.
    assert.equal(sameOfferView(before, uniqueOfferDocs([a, b], () => 0)), false)
  })

  it('документы перечитаны из базы: те же файлы и строки — прежний список; изменённое — заменяется', () => {
    const prev = [entry('a', '{"v":1}'), entry('b', '{"v":2}')]
    const same = keepSameOffers(prev, [entry('a', '{"v":1}'), entry('b', '{"v":2}')])
    assert.equal(same, prev, 'ничего не изменилось — тот же массив, пересчёта нет')

    const edited = keepSameOffers(prev, [entry('a', '{"v":1}'), entry('b', '{"v":3}')])
    assert.notEqual(edited, prev)
    assert.equal(edited[0], prev[0], 'неизменённый документ — прежняя запись (его строки не ищутся заново)')
    assert.notEqual(edited[1], prev[1], 'строки документа изменились (выбор в окне у коллеги)')

    const renamed = keepSameOffers(prev, [entry('a', '{"v":1}', { file_name: 'Счёт.pdf' }), entry('b', '{"v":2}')])
    assert.equal(renamed[0].doc.file_name, 'Счёт.pdf', 'новое имя файла видно')
    assert.equal(renamed[1], prev[1])

    const added = keepSameOffers(prev, [entry('c', '{"v":9}'), ...prev.map((x) => entry(x.doc.id, x.notes))])
    assert.deepEqual(added.map((x) => x.doc.id), ['c', 'a', 'b'])
    assert.equal(added[1], prev[0])
    assert.deepEqual(keepSameOffers(prev, [entry('a', '{"v":1}')]).map((x) => x.doc.id), ['a'], 'удалённый коллегой документ уходит')
    assert.equal(keepSameOffers(null, prev), prev)
    // Запись без строк базы (не из неё) не считается той же.
    const local = [{ ...prev[0], notes: undefined }]
    assert.notEqual(keepSameOffers(local, [entry('a', '{"v":1}')])[0], local[0])
  })

  it('выбор строки в окне: неизменённые строки файла — прежние объекты, позиции ищутся только для изменённой', () => {
    const groups = groupsOf()
    const ix = sharedMatchIndex(groups)
    const before = readOffer(offerNotes({ lines: [...docLines(), line('Шпилька М8', 'шт', 12)] }))
    assert.ok(before.lines.length >= 10)
    for (const l of before.lines) primeOfferLine(l, groups, ix)
    // Человек выбрал позицию для первой строки: notes переписаны целиком, разбор — новые объекты.
    const picked = before.lines.map((l, i) => (i === 0 ? { ...l, k: groups[0].k } : l))
    const reread = readOffer(offerNotes({ ...before, lines: picked }))
    assert.notEqual(reread.lines[1], before.lines[1], 'без сохранения строк все объекты новые')
    const after = keepSameLines(reread, before)
    assert.notEqual(after.lines[0], before.lines[0], 'изменённая строка — новая')
    assert.equal(after.lines[0].k, groups[0].k)
    after.lines.slice(1).forEach((l, i) => assert.equal(l, before.lines[i + 1], `строка ${i + 1} — прежний объект`))
    // Одинаковые строки (две «Шпилька М8») остаются разными объектами.
    const studs = after.lines.filter((l) => l.name === 'Шпилька М8')
    assert.equal(studs.length, 2)
    assert.notEqual(studs[0], studs[1])
    // Результат тот же, что у полного поиска по новым строкам.
    const docsAfter = [doc('a', after.lines)]
    const fresh = groupsOf()
    assert.deepEqual(printPicks(offersByGroup(docsAfter, groups, ix)), printPicks(offersByGroup([doc('a', reread.lines)], fresh)))
    // Ничего общего — без изменений; тот же объект — как есть.
    const other = readOffer(offerNotes({ lines: [line('Гвоздь', 'кг', 1)] }))
    assert.equal(keepSameLines(other, before), other)
    assert.equal(keepSameLines(before, before), before)
    // Коллега правил файл: при перечитывании прежние строки сохраняются и через keepSameOffers.
    const was = [{ doc: { id: 'a' }, offer: before, notes: offerNotes(before) }]
    const got = keepSameOffers(was, [{ doc: { id: 'a' }, offer: reread, notes: offerNotes(reread) }])
    assert.equal(got[0].offer.lines[1], before.lines[1])
    assert.equal(got[0].notes, offerNotes(reread))
  })
})
