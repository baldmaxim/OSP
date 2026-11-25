// Реестр расценок → «Расценки от снабжения СУ-10» → «Проверить по файлу» — правила без базы и браузера: позиции реестра ищутся так
// же, как в тендерах на материалы строке счёта (utils/supplyDocMatch: то же наименование, артикул «арт.», разные размеры — не та
// позиция, упаковка пересчитывается на единицу); сами в сравнение идут те же позиции, что строка счёта закрыла бы сама (autoChosen);
// остальные — «возможные»; галочка и поиск по реестру; период расценок; НДС файла; строки работ; итоги и выгрузка. Данные вымышленные.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  SUPPLY_CHECK_EXPORT_HEADERS, checkSupplyLines, lineCandidates, materialLines, periodStart, pickedCandidate, supplyCheckExportRows,
  supplyCheckIndex, supplyCheckSummary,
} from '../../src/utils/supplyRegistryCheck.js'
import { autoChosen, itemCandidates, matchIndex, offerMatches } from '../../src/utils/supplyDocMatch.js'
import { readBidPriceDoc } from '../../src/utils/bidImport.js'

const MSK = (day) => new Date(`${day}T00:00:00+03:00`).toISOString()
let seq = 0
const row = (item_name, unit, price, day = '2026-10-01', extra = {}) => ({
  id: `r${++seq}`, source_name: 'СУ-10', item_name, unit, price, rate_date: MSK(day), object_name: 'ЖК Тестовый', tender_id: null, tender_desc: null, ...extra,
})
const REGISTRY = [
  row('Кабель ВВГнг(А)-LS 3х2,5', 'м', 100, '2026-10-01'),
  row('Кабель ВВГнг(А)-LS 3х2,5', 'м', 110, '2026-11-01', { source_name: 'Петрович', object_name: 'ЖК Второй' }),
  row('Кабель ВВГнг(А)-LS 3х2,5', 'м', 120, '2024-01-15'),
  row('Кабель ВВГнг(А)-LS 3х1,5', 'м', 70),
  row('Стяжка кабельная 4,8х200 нейлон', 'шт', 2.5),
  row('Дюбель металлический универсальный 5х30 мм, арт.СМ280530, ДКС', 'шт', 12),
  row('Клей плиточный', 'кг', 30),
  row('Клей плиточный', 'шт', 600),
  row('Гипсокартон 12,5 мм', 'м2', 350),
  row('Мешок для мусора', 'шт', 0),
  row('Шпатлёвка финишная', 'кг', 40, '2024-03-01'),
]
const index = supplyCheckIndex(REGISTRY)
const run = (items, opts = {}) => {
  const found = new Map(items.map((it, i) => [i, lineCandidates(it, index)]))
  return checkSupplyLines(items, found, opts)
}
const line = (name, unit, price, extra = {}) => ({ name, unit, price, priceVat: 'gross', ...extra })

describe('Реестр СУ-10: проверка цен по файлу — правила', () => {
  it('указатель: группа — наименование в одной ед. изм.; строки без цены не входят', () => {
    assert.equal(index.rowCount, 10)
    const glue = index.groups.filter((g) => g.name === 'Клей плиточный')
    assert.equal(glue.length, 2, 'кг и шт — разные группы')
    assert.equal(index.groups.find((g) => g.name.startsWith('Кабель ВВГнг(А)-LS 3х2,5')).rows.length, 3)
    assert.ok(!index.groups.some((g) => g.name === 'Мешок для мусора'))
  })

  it('то же наименование — само в сравнении, все его цены; другое сечение — не само', () => {
    const [l] = run([line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 115)])
    const auto = l.entries.filter((e) => e.auto)
    assert.equal(auto.length, 1)
    assert.ok(auto[0].c.exact)
    assert.equal(l.stats.n, 3)
    assert.deepEqual([l.stats.min, l.stats.median, l.stats.max], [100, 110, 120])
    assert.equal(l.verdict, 'ok')
    assert.equal(l.dev, 4.5)
    const other = l.entries.find((e) => e.group.name.includes('3х1,5'))
    assert.ok(!other || (!other.auto && !other.on), 'кабель 3х1,5 — не аналог 3х2,5')
  })

  it('свежая цена — первой; последняя расценка в итогах', () => {
    const [l] = run([line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 115)])
    const e = l.entries.find((x) => x.auto)
    assert.deepEqual(e.points.map((p) => p.price), [110, 100, 120])
    assert.equal(l.stats.newest.price, 110)
    assert.equal(l.stats.newest.row.source_name, 'Петрович')
  })

  it('выбор — как у строки счёта в тендере на материалы (autoChosen, общий с offerMatches)', () => {
    const items = [line('Кабель ВВГнг(А)-LS 3х2,5 мм2', 'м', 115), line('Дюбель для газобетона 5х30 DKC CM280530', 'шт', 15)]
    const lines = run(items)
    const ix = matchIndex(index.groups)
    for (const [i, l] of lines.entries()) {
      const expected = autoChosen(itemCandidates(items[i], index.groups, ix, 40, { packs: true })).map((c) => c.group.key)
      assert.deepEqual(l.entries.filter((e) => e.auto).map((e) => e.key), expected)
      // Те же позиции окно счетов поставило бы строке само.
      const offers = offerMatches([items[i]], index.groups, ix)
      for (const key of expected) assert.ok(offers.has(key), `offerMatches выбирает ${key}`)
    }
  })

  it('артикул позиции («арт.») в наименовании строки — та же позиция, как бы её ни назвал поставщик', () => {
    const [l] = run([line('Дюбель для газобетона 5х30 DKC CM280530', 'шт', 15)])
    const e = l.entries.find((x) => x.group.name.startsWith('Дюбель'))
    assert.ok(e?.auto && e.on, 'дюбель — сам')
    assert.equal(l.stats.median, 12)
    assert.equal(l.verdict, 'high')
    assert.equal(l.dev, 25)
  })

  it('упаковка пересчитывается на единицу позиции: цена реестра — за единицу строки файла', () => {
    const [l] = run([line('Стяжка кабельная нейлон 4,8х200 (100 шт.)', 'упак', 270)])
    const e = l.entries.find((x) => x.group.name.startsWith('Стяжка'))
    assert.ok(e, 'стяжка найдена')
    assert.equal(e.factor, 100)
    assert.equal(e.points[0].price, 250)
    assert.ok(e.on)
    assert.equal(l.stats.median, 250)
    assert.equal(l.dev, 8)
  })

  it('другая ед. изм. без пересчёта — видна, но в сравнение не идёт', () => {
    const [l] = run([line('Гипсокартон 12,5 мм', 'лист', 900)])
    assert.equal(l.entries.length, 0)
    assert.equal(l.otherUnit.length, 1)
    assert.equal(l.otherUnit[0].group.unit, 'м2')
    assert.equal(l.stats, null)
    assert.equal(l.verdict, 'none')
  })

  it('та же позиция в двух ед. изм.: сравнивается с подходящей', () => {
    const [l] = run([line('Клей плиточный', 'кг', 33)])
    assert.deepEqual(l.entries.filter((e) => e.on).map((e) => e.group.unit), ['кг'])
    assert.equal(l.stats.median, 30)
  })

  it('период: старые цены не считаются; позиция только со старыми — в счётчике', () => {
    const since = periodStart(12, '2026-11-25')
    assert.equal(since, Date.parse('2025-11-25T00:00:00+03:00'))
    const [l] = run([line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 115)], { since })
    assert.equal(l.stats.n, 2, 'цена 2024 года — за периодом')
    const [old] = run([line('Шпатлёвка финишная', 'кг', 45)], { since })
    assert.equal(old.entries.length, 0)
    assert.equal(old.older, 1, 'позиция только с ценой 2024 года')
    assert.equal(old.verdict, 'none')
    const [all] = run([line('Шпатлёвка финишная', 'кг', 45)])
    assert.equal(all.stats.median, 40)
    assert.equal(periodStart(0, '2026-11-25'), null)
  })

  it('галочки: снять свою — нет аналогов; включить возможную — в медиане', () => {
    const items = [line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 115)]
    const found = new Map([[0, lineCandidates(items[0], index)]])
    const auto = checkSupplyLines(items, found)[0].entries.find((e) => e.auto)
    const off = checkSupplyLines(items, found, { choices: new Map([[`0|${auto.key}`, false]]) })[0]
    assert.equal(off.stats, null)
    assert.equal(off.verdict, 'none')
    assert.ok(off.entries.find((e) => e.key === auto.key).auto, 'снятая своя остаётся на виду')
    const possible = checkSupplyLines(items, found)[0].entries.find((e) => !e.auto)
    assert.equal(possible?.group.name, 'Кабель ВВГнг(А)-LS 3х1,5', 'другое сечение — возможная, не своя')
    assert.equal(possible.on, false)
    const on = checkSupplyLines(items, found, { choices: new Map([[`0|${possible.key}`, true]]) })[0]
    assert.equal(on.stats.n, 4)
    assert.equal(on.stats.min, 70)
  })

  it('найдено поиском — в сравнении, с пересчётом единиц', () => {
    const items = [line('Хомут нейлоновый 200 мм, упаковка 100 шт', 'упак', 300)]
    const g = index.groups.find((x) => x.name.startsWith('Стяжка'))
    const c = pickedCandidate(items[0], g)
    assert.equal(c.manual, true)
    assert.equal(c.pack, 100)
    const [l] = checkSupplyLines(items, new Map([[0, []]]), { picked: new Map([[0, [g]]]) })
    const e = l.entries.find((x) => x.key === g.key)
    assert.ok(e.manual && e.on && !e.auto)
    assert.equal(l.stats.median, 250)
    assert.equal(l.verdict, 'high')
  })

  it('НДС файла: цены без НДС — плюс ставка; выбор в окне сильнее', () => {
    const [l] = run([{ name: 'Клей плиточный', unit: 'кг', price: 25, priceVat: 'net' }], { vat: { mode: null, rate: 20 } })
    assert.equal(l.price, 30)
    assert.equal(l.verdict, 'ok')
    const [forced] = run([{ name: 'Клей плиточный', unit: 'кг', price: 25, priceVat: 'net' }], { vat: { mode: 'gross', rate: 20, force: true } })
    assert.equal(forced.price, 25)
  })

  it('строки работ не проверяются; у строки с двумя ценами — цена материалов', () => {
    const { items, works } = materialLines([
      { name: 'Кабель ВВГнг(А)-LS 3х2,5', unit: 'м', price: 100, kindHint: 'material' },
      { name: 'Прокладка кабеля', unit: 'м', price: 50, kindHint: 'work' },
      { name: 'Клей плиточный', unit: 'кг', parts: { material: { price: 31, priceVat: 'gross' }, work: { price: 10 } } },
      { name: 'Монтаж щита', unit: 'шт', parts: { material: { price: null, sum: null }, work: { price: 900 } } },
      { name: 'Гипсокартон 12,5 мм', unit: 'м2', price: null },
    ])
    assert.equal(works, 2)
    assert.deepEqual(items.map((it) => [it.name, it.price ?? null]), [['Кабель ВВГнг(А)-LS 3х2,5', 100], ['Клей плиточный', 31], ['Гипсокартон 12,5 мм', null]])
    assert.equal(items[1].parts, null)
  })

  it('строка без цены (незаполненный ВОР) — цены реестра видны, итог «нет цены»; доставка — не позиция', () => {
    const lines = run([line('Гипсокартон 12,5 мм', 'м2', null), { name: 'Доставка', unit: 'усл', price: 5000, delivery: true }])
    assert.equal(lines[0].verdict, 'noprice')
    assert.equal(lines[0].stats.median, 350)
    assert.equal(lines[1].verdict, 'delivery')
    assert.equal(lines[1].entries.length, 0)
  })

  it('итоги и выгрузка', () => {
    const lines = run([
      line('Кабель ВВГнг(А)-LS 3х2,5', 'м', 115, { qty: 100 }),
      line('Дюбель для газобетона 5х30 DKC CM280530', 'шт', 15, { qty: 10 }),
      line('Гайка особая редкая', 'шт', 99),
      line('Гипсокартон 12,5 мм', 'м2', null),
    ])
    const s = supplyCheckSummary(lines)
    assert.deepEqual([s.total, s.ok, s.high, s.none, s.noprice, s.withStats], [4, 1, 1, 1, 1, 3])
    assert.equal(s.fileSum, 11650)
    assert.equal(s.medianSum, 11120)
    const rows = supplyCheckExportRows(lines)
    assert.equal(rows.length, 4)
    assert.equal(rows[0].length, SUPPLY_CHECK_EXPORT_HEADERS.length)
    assert.deepEqual(rows[0].slice(0, 6), [1, 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 100, 115, 3])
    assert.equal(rows[0][13], 'в рынке')
    assert.deepEqual(rows[0].slice(14, 22), ['Кабель ВВГнг(А)-LS 3х2,5', 'м', 110, 110, 'Петрович', 'ЖК Второй', '', '01.11.2026'])
    assert.equal(rows[3][13], 'цены в файле нет')
  })

  it('счёт из Excel: разбор, как в проверке реестра КП, и проверка', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Счёт на оплату № 12'], [],
      ['№', 'Товар', 'Кол-во', 'Ед.', 'Цена', 'Сумма'],
      [1, 'Кабель ВВГнг(А)-LS 3х2,5', 100, 'м', 150, 15000],
      [2, 'Клей плиточный', 50, 'кг', 31, 1550],
      ['', 'Итого', '', '', '', 16550], ['В том числе НДС 22 %'],
    ]), 'TDSheet')
    const r = await readBidPriceDoc(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), 'Счёт.xlsx', { keepBlank: true })
    assert.ok(!r.error, r.error)
    const { items } = materialLines(r.items)
    const lines = run(items, { vat: r.vat })
    assert.deepEqual(lines.map((l) => l.verdict), ['high', 'ok'])
    assert.equal(lines[0].dev, 36.4)
  })
})
