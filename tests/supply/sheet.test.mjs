// Лист «Материалы» файла ВОР → позиции для расценки снабжением (src/utils/vorMaterialsSheet.js,
// src/utils/vorMaterials.js). Книги собираются в тесте через xlsx: разные шапки, разделы и «Итого», числа с
// пробелами и запятой, лист в другом регистре, нет листа, ручное сопоставление колонок.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  findMaterialsSheet, detectMaterialsColumns, parseMaterialsSheet, readMaterialsFromWorkbook, parseVolume, isWorkbookFileName,
} from '../../src/utils/vorMaterialsSheet.js'
import { buildSupplyPositions, positionsFromEstimate, aggregateEstimate, isWorkItem } from '../../src/utils/vorMaterials.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

function book(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  // Через запись и чтение — как настоящий файл.
  return XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
}

describe('Лист «Материалы» файла ВОР', () => {
  it('лист находится по имени без учёта регистра и пробелов; нет листа — no_sheet', () => {
    assert.equal(findMaterialsSheet(book({ 'Исходный ВОР': [['x']], ' материалы ВОР ': [['y']] })), ' материалы ВОР ')
    assert.equal(findMaterialsSheet(book({ 'ВОР': [['x']] })), null)
    assert.equal(readMaterialsFromWorkbook(book({ 'ВОР': [['x']] })).error, 'no_sheet')
  })

  it('шапка не в первой строке, колонки в любом порядке; разделы, «Итого», пустые строки пропускаются', () => {
    const wb = book({
      'Материалы': [
        ['ВОР: Отопление и вентиляция'],
        [],
        ['№', 'Ед. изм.', 'Наименование материала', 'Кол-во', 'Цена за ед.', 'Стоимость'],
        ['', '', 'Трубопроводы', '', '', ''],
        [1, 'м', 'Труба медная Ø12,7', '1 250,5', '', ''],
        [2, 'шт', 'Кран шаровой Ду15', 48, '', ''],
        [3, '', '', '', '', ''],
        [4, 'м', 'Изоляция K-Flex 13×15', '1100', 100, 110000],
        ['', '', 'Итого', '', '', 110000],
      ],
    })
    const r = readMaterialsFromWorkbook(wb)
    assert.equal(r.error, undefined)
    assert.equal(r.sheetName, 'Материалы')
    assert.equal(r.map.headerRow, 3)
    assert.deepEqual(r.map.columns, { name: 2, unit: 1, volume: 3 })
    assert.deepEqual(r.rows.map((x) => [x.name, x.unit, x.volume]), [
      ['Труба медная Ø12,7', 'м', 1250.5],
      ['Кран шаровой Ду15', 'шт', 48],
      ['Изоляция K-Flex 13×15', 'м', 1100],
    ])
    assert.deepEqual(r.skipped, { sections: 1, totals: 1, empty: 1 })
  })

  it('объём важнее количества и расхода; «Кол-во позиций» (выгрузка карточки) — не объём', () => {
    const wb = book({
      'Материалы': [
        ['№', 'Наименование', 'Ед. изм.', 'Объём (сумма)', 'Кол-во позиций', 'Стоимость от снабжения'],
        [1, 'Кабель ВВГнг 3×2,5', 'м', 4000, 12, ''],
        ['', 'ИТОГО', '', 4000, 12, ''],
      ],
    })
    const r = readMaterialsFromWorkbook(wb)
    assert.deepEqual(r.map.columns, { name: 1, unit: 2, volume: 3 })
    assert.deepEqual(r.rows.map((x) => x.volume), [4000])
  })

  it('без колонки единиц шапка распознаётся; без колонки объёма — no_header; ручная карта и строки', () => {
    const noUnit = book({ 'Материалы': [['Наименование', 'Количество'], ['Щит ЩРН-12', 3]] })
    assert.deepEqual(detectMaterialsColumns(noUnit.Sheets['Материалы']).columns, { name: 0, unit: null, volume: 1 })
    const odd = book({ 'Материалы': [['Позиция', 'Ед', 'Q'], ['Щит ЩРН-12', 'шт', 3], ['Автомат 16А', 'шт', '12,0']] })
    assert.equal(readMaterialsFromWorkbook(odd).error, 'no_header')
    const manual = readMaterialsFromWorkbook(odd, { sheetName: 'Материалы', startRow: 2, columns: { name: 0, unit: 1, volume: 2 } })
    assert.deepEqual(manual.rows.map((x) => [x.name, x.volume, x.row]), [['Щит ЩРН-12', 3, 2], ['Автомат 16А', 12, 3]])
    const until = readMaterialsFromWorkbook(odd, { sheetName: 'Материалы', startRow: 2, endRow: 2, columns: { name: 0, unit: 1, volume: 2 } })
    assert.equal(until.rows.length, 1)
    // Колонки вручную, без строки начала: данные после строки с «Наименование» в колонке наименования.
    const titled = book({ 'Материалы': [['Спецификация'], ['Наименование', 'Ед', 'Q'], ['Щит', 'шт', 1]] })
    const auto = readMaterialsFromWorkbook(titled, { sheetName: 'Материалы', columns: { name: 0, unit: 1, volume: 2 } })
    assert.deepEqual(auto.rows.map((x) => x.name), ['Щит'])
  })

  it('числа: пробелы, неразрывные пробелы, запятая; не число — пусто', () => {
    assert.equal(parseVolume('1 250,75'), 1250.75)
    assert.equal(parseVolume(' 12.5 '), 12.5)
    assert.equal(parseVolume(7), 7)
    assert.equal(parseVolume(''), null)
    assert.equal(parseVolume('—'), null)
    assert.equal(parseVolume('по месту'), null)
  })

  it('годятся только книги Excel (в старой категории «vor» бывают PDF)', () => {
    assert.ok(isWorkbookFileName('ВОР ОВ.XLSX'))
    assert.ok(isWorkbookFileName('a.xls') && isWorkbookFileName('a.xlsm'))
    assert.ok(!isWorkbookFileName('РД.pdf'))
  })
})

describe('Позиции для расценки', () => {
  it('группировка по ключу цены (normName): двойники и пробелы сливаются, объёмы складываются', () => {
    const p = buildSupplyPositions([
      { name: 'Труба медная Ø12,7', unit: 'м', volume: 1000 },
      { name: 'труба  медная ∅12.7', unit: 'М', volume: 250.5 },
      { name: 'Кран шаровой Ду15', unit: 'шт', volume: null },
    ])
    assert.equal(p.length, 2)
    assert.deepEqual(p[0], { name: 'Труба медная Ø12,7', unit: 'м', volume: 1250.5, order: 1 })
    assert.deepEqual(p[1], { name: 'Кран шаровой Ду15', unit: 'шт', volume: null, order: 2 })
  })

  it('одно наименование с разными ед. изм. — одна позиция с units (сумму не ввести)', () => {
    const [p] = buildSupplyPositions([
      { name: 'Хомут', unit: 'шт', volume: 10 },
      { name: 'Хомут', unit: 'компл', volume: 2 },
      { name: 'ХОМУТ', unit: 'шт', volume: 5 },
    ])
    assert.equal(p.unit, null)
    assert.equal(p.volume, null)
    assert.deepEqual(p.units, [{ unit: 'шт', volume: 15 }, { unit: 'компл', volume: 2 }])
  })

  it('объёмы без хвостов float (0,1 + 0,2)', () => {
    const [p] = buildSupplyPositions([{ name: 'A', unit: 'м', volume: 0.1 }, { name: 'a', unit: 'м', volume: 0.2 }])
    assert.equal(p.volume, 0.3)
  })

  it('из вкладки «ВОР» карточки: только материалы (КОД не «Р»), по документам, как подвкладка «Материалы»', () => {
    const items = [
      { estimate_name: 'ОВ', code: 'Р', cost_name: 'Монтаж трубы', unit: 'м', material_consumption: null, is_section: false },
      { estimate_name: 'ОВ', code: 'мат.', cost_name: 'Труба медная Ø12,7', unit: 'м', material_consumption: 600, is_section: false },
      { estimate_name: 'ОВ', code: null, cost_name: 'Раздел 1', unit: null, material_consumption: null, is_section: true },
      { estimate_name: 'ОВ', code: 'мат.', cost_name: 'Труба медная Ø12,7', unit: 'м', material_consumption: 400, is_section: false },
      { estimate_name: 'ВК', code: 'мат.', cost_name: 'Кран шаровой Ду15', unit: 'шт', material_consumption: 48, is_section: false },
    ]
    const docs = positionsFromEstimate(items)
    assert.deepEqual([...docs.keys()], ['ВК', 'ОВ'])
    assert.deepEqual(docs.get('ОВ'), [{ name: 'Труба медная Ø12,7', unit: 'м', volume: 1000, order: 1 }])
    // Та же сумма, что у подвкладки «Материалы» карточки (aggregateEstimate).
    const agg = aggregateEstimate(items.filter((it) => it.estimate_name === 'ОВ'), 'materials')
    assert.equal(agg[0].total, 1000)
    assert.ok(isWorkItem({ code: ' р-12' }) && !isWorkItem({ code: 'мат.' }))
  })

  it('ключ позиции совпадает с ключом цены карточки', () => {
    const [p] = buildSupplyPositions([{ name: 'Труба МЕДНАЯ Ø12,7', unit: 'м', volume: 1 }])
    assert.equal(normName(p.name), 'tpyбameдhaя12.7')
  })
})
