// Расценка ВОР подрядчиком в кабинете (миграция 20261102) — правила без базы и браузера: разбор файла ВОР
// (листы «Материалы», «Работы», «КП»; ВОР прежнего вида — один лист с колонкой «КОД»), одна позиция на тендер
// из нескольких файлов, суммы листа «КП» по разделам, цены из файла подрядчика (свой прайс или заполненный ВОР)
// и сопоставление строк с позициями — точно, затем по похожести, с учётом вида (материал / работа).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  readBidWorkbook, readBidFileBytes, findBidSheets, parseKpSheet, detectKpColumns, kpRowKind, consumptionIsFactor,
  mergeBidFiles, priceStructure, sectionLevel, bidKey, bidItemKey, bidUnitKey, rateKey, lineTotal,
} from '../../src/utils/bidVor.js'
import { itemsFromBidWorkbook, bidGroups, matchBidItems, searchBidGroups } from '../../src/utils/bidImport.js'
import {
  VAT_OPTIONS, VAT_FIELD_CODE, parseVatAnswer, vatIncluded, vatLabel, vatFromAnswers, parseOptions, answerAllowed,
} from '../../src/utils/bidForm.js'
import { readMainConditions } from '../../src/utils/bidVor.js'

function bytesOf(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
const book = (sheets) => XLSX.read(bytesOf(sheets), { type: 'array' })

// ВОР нынешнего вида: главный лист, списки «Материалы» и «Работы», полный «КП».
const CURRENT = {
  'Главный лист': [
    ['', 'РАБОТЫ'],
    [],
    ['', 'Особые условия, которые необходимо учесть в стоимости', ''],
    ['', 'ГУ в размере 5 % (Пять процентов)'],
    ['', 'Гарантия на материалы/оборудование 60 мес.'],
    ['', 'Шаблон договора подряда в тендерном пакете'],
    ['', 'График производства работ в соответствии с документом в тендерном пакете'],
    [],
    [],
    ['Квалификационная и контактная информация (обязательно к заполнению)'],
    [1, 'Наименование контрагента', '', ''],
    [4, 'Указать % НДС из выпадающего списка', '', 22],
  ],
  'Материалы': [
    ['Базовая стоимость материалов'],
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС', 'Итого', 'Примечание контрагента'],
    [1, 2, 3, 4, 5, 6, 7],
    [1, 'Бетон В25 W8', 'м3', 120.5, '', '', ''],
    [2, 'Арматура А500С d12', 'т', '3,25', '', '', ''],
    [3, 'Бетон В25 W8', 'м3', 10, '', '', ''],
    ['', 'Итого', '', '', '', 0, ''],
  ],
  'Работы': [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС', 'Итого'],
    [1, 'Устройство монолитной плиты', 'м3', 130.5, '', ''],
    [2, 'Армирование плиты', 'т', 3.25, '', ''],
  ],
  'КП': [
    ['Заполняются только ячейки, выделенные синим цветом.'],
    ['№ п/п', 'КОД', 'Наименование затрат', 'Примечание контрагента', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу', 'Цена материалы', 'Цена СМР'],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ['', '', 'Монолитные работы', '', '', '', '', '', ''],
    ['1', '', 'Плита паркинга', '', '', '', '', '', ''],
    ['1.1', 'Р', 'Устройство монолитной плиты', '', 'м3', 120.5, '', '', ''],
    ['', 'мат.', 'Бетон В25 W8', '', 'м3', 120.5, 122.9, '', ''],
    ['1.2', 'Работа', 'Армирование плиты', '', 'т', 3.25, '', '', ''],
    ['', 'Мат', 'Арматура А500С d12', '', 'т', 3.25, 3.25, '', ''],
    ['2', '', 'Приямки', '', '', '', '', '', ''],
    ['2.1', 'Р', 'Устройство монолитной плиты', '', 'м3', 10, '', '', ''],
    ['', 'мат.', 'Бетон В25 W8', '', 'м3', 10, 10.2, '', ''],
    ['', '', 'ИТОГО с НДС 22%', '', '', '', '', '', ''],
    ['1', '', 'Наличие авансирования', '', 'да (%) / нет', '', '', '', ''],
  ],
}

describe('Файл ВОР для расценки подрядчиком', () => {
  it('листы находятся по началу имени; КП — «КП» или «ВОР»', () => {
    assert.deepEqual(findBidSheets(['Главный лист', ' материалы ', 'РАБОТЫ', 'КП']),
      { materials: ' материалы ', works: 'РАБОТЫ', kp: 'КП', main: 'Главный лист' })
    assert.equal(findBidSheets(['ВОР', 'БСМ']).kp, 'ВОР')
    assert.equal(findBidSheets(['КПП']).kp, null, '«КПП» — не лист КП')
  })

  it('нынешний вид: позиции — из листов «Материалы» и «Работы», повторы складываются, «Итого» и номера колонок — мимо', () => {
    const r = readBidFileBytes(bytesOf(CURRENT))
    assert.equal(r.error, undefined)
    assert.deepEqual(r.sources, { material: 'sheet', work: 'sheet' })
    assert.equal(r.materials.length, 2)
    const concrete = r.materials.find((p) => p.name === 'Бетон В25 W8')
    assert.equal(concrete.volume, 130.5)
    assert.equal(concrete.rows, 2)
    assert.equal(concrete.key, bidKey('material', 'Бетон В25 W8', 'м3'))
    assert.equal(concrete.itemKey, bidItemKey('бетон  в25 w8'))
    assert.equal(r.materials.find((p) => p.name.startsWith('Арматура')).volume, 3.25, '«3,25» — число')
    assert.deepEqual(r.works.map((p) => [p.name, p.volume]), [['Устройство монолитной плиты', 130.5], ['Армирование плиты', 3.25]])
  })

  it('лист «КП»: разделы по уровням, работы и материалы; объём материала — «Общий расход»; анкета после «Итого» — не ВОР', () => {
    const r = readBidWorkbook(book(CURRENT))
    assert.deepEqual(r.structure.map((x) => [x.type, x.num, x.name, x.volume]), [
      ['section', '', 'Монолитные работы', null],
      ['section', '1', 'Плита паркинга', null],
      ['work', '1.1', 'Устройство монолитной плиты', 120.5],
      ['material', '', 'Бетон В25 W8', 122.9],
      ['work', '1.2', 'Армирование плиты', 3.25],
      ['material', '', 'Арматура А500С d12', 3.25],
      ['section', '2', 'Приямки', null],
      ['work', '2.1', 'Устройство монолитной плиты', 10],
      ['material', '', 'Бетон В25 W8', 10.2],
    ])
  })

  it('ВОР прежнего вида (один лист «ВОР», «Общий расход» — коэффициент): позиции из него, объём материала — «Объём»', () => {
    const r = readBidFileBytes(bytesOf({
      'ВОР': [
        ['№ п/п', 'КОД', 'Наименование затрат', 'Примечание', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу'],
        ['1', '', 'Вентиляция', '', '', '', ''],
        ['1.1', 'Работа', 'Прокладка воздуховодов', '', 'м2', 1081.2, ''],
        ['', 'Мат', 'Воздуховод 0,5', '', 'м2', 1081.2, 1],
        ['1.2', 'Работа', 'Прокладка гибких', '', 'м', 53, ''],
        ['', 'Мат', 'Воздуховод гибкий D100', '', 'м', 34.68, 1.02],
        ['', 'Мат', 'Воздуховод гибкий D160', '', 'м', 19.38, 1.02],
      ],
      'БСМ': [['Наименование материала', 'Ед. изм.', 'ЦЕНА']],
    }))
    assert.deepEqual(r.sources, { material: 'kp', work: 'kp' })
    assert.deepEqual(r.materials.map((p) => p.volume), [1081.2, 34.68, 19.38])
    assert.deepEqual(r.works.map((p) => p.volume), [1081.2, 53])
    assert.equal(consumptionIsFactor([{ volume: 10, consumption: 1.02 }, { volume: 5, consumption: 1 }, { volume: 3, consumption: 1.2 }]), true)
    assert.equal(consumptionIsFactor([{ volume: 10, consumption: 10.2 }, { volume: 5, consumption: 5.1 }, { volume: 3, consumption: 3.06 }]), false)
  })

  it('код строки: «Р», «Работа», «раб.» — работа; «мат.», «Мат», «Обор.» — материал; прочее — не позиция', () => {
    assert.deepEqual(['Р', 'р-1', 'Работа', 'раб.', 'мат.', 'Мат', 'Обор.', 'КОД', ''].map(kpRowKind),
      ['work', 'work', 'work', 'work', 'material', 'material', 'material', 'other', null])
    assert.equal(sectionLevel(''), 0)
    assert.equal(sectionLevel('2'), 1)
    assert.equal(sectionLevel('2.1.'), 2)
  })

  it('нет ни списков, ни таблицы с «КОД» — no_positions; не книга — ошибка, а не падение', () => {
    assert.equal(readBidFileBytes(bytesOf({ 'Лист1': [['просто текст']] })).error, 'no_positions')
    assert.ok(readBidFileBytes(new Uint8Array([1, 2, 3, 4])).error)
    assert.equal(detectKpColumns(book({ x: [['Наименование', 'Объём']] }).Sheets.x), null, 'без «КОД» — не КП')
    assert.equal(parseKpSheet(book({ x: [['a']] }).Sheets.x).rows.length, 0)
  })

  it('несколько файлов ВОР тендера: одна позиция — одна цена, объёмы складываются, видно, в каких ВОР', () => {
    const a = readBidFileBytes(bytesOf(CURRENT))
    const b = readBidFileBytes(bytesOf({
      'Материалы': [['Наименование', 'Ед. изм.', 'Кол-во'], ['БЕТОН  В25 W8', 'м³', 5], ['Песок', 'м3', 2]],
      'Работы': [['Наименование', 'Ед. изм.', 'Объём'], ['Устройство монолитной плиты', 'м3', 5]],
    }))
    const m = mergeBidFiles([{ id: 1, name: 'ВОР КЖ', parsed: a }, { id: 2, name: 'ВОР КЖ изм.1', parsed: b }])
    const concrete = m.materials.find((p) => p.itemKey === bidItemKey('Бетон В25 W8'))
    assert.equal(concrete.volume, 135.5, '«м³» = «м3», регистр и пробелы не важны')
    assert.deepEqual(concrete.docs, ['ВОР КЖ', 'ВОР КЖ изм.1'])
    assert.equal(m.materials.length, 3)
    assert.equal(m.works.find((p) => p.name === 'Устройство монолитной плиты').volume, 135.5)
    assert.equal(bidUnitKey('м³'), bidUnitKey('м3'))
    assert.equal(rateKey({ kind: 'material', item_key: concrete.itemKey, unit_key: concrete.unitKey }), concrete.key)
  })

  it('суммы листа «КП»: цена × объём, по разделам с вложенностью и по всему ВОР; строки без цены — «нет цены»', () => {
    const r = readBidWorkbook(book(CURRENT))
    const prices = new Map([
      [bidKey('material', 'Бетон В25 W8', 'м3'), 7800],
      [bidKey('work', 'Устройство монолитной плиты', 'м3'), 2500],
    ])
    const s = priceStructure(r.structure, prices)
    const byName = Object.fromEntries(s.rows.filter((x) => x.type === 'section').map((x) => [x.name, x]))
    assert.equal(byName['Плита паркинга'].materials, lineTotal(7800, 122.9))
    assert.equal(byName['Плита паркинга'].works, lineTotal(2500, 120.5))
    assert.equal(byName['Приямки'].materials, lineTotal(7800, 10.2))
    assert.equal(byName['Монолитные работы'].works, lineTotal(2500, 120.5) + lineTotal(2500, 10), 'верхний раздел — сумма вложенных')
    assert.equal(s.totals.items, 6)
    assert.equal(s.totals.priced, 4)
    assert.equal(s.rows.find((x) => x.name.startsWith('Арматура')).price, null)
    assert.equal(lineTotal(7800.456, 2), 15600.91)
    assert.equal(lineTotal(null, 2), null)
  })
})

describe('Главный лист и анкета', () => {
  it('«Особые условия» — строки под заголовком до пустой строки; анкета и «РАБОТЫ» — мимо', () => {
    assert.deepEqual(readBidWorkbook(book(CURRENT)).conditions, [
      'ГУ в размере 5 % (Пять процентов)',
      'Гарантия на материалы/оборудование 60 мес.',
      'Шаблон договора подряда в тендерном пакете',
      'График производства работ в соответствии с документом в тендерном пакете',
    ])
    assert.deepEqual(readBidFileBytes(bytesOf(CURRENT)).conditions.length, 4, 'главный лист читается и из байтов')
    // Условия вплотную к анкете — останавливаемся на её заголовке.
    const tight = book({ x: [['Особые условия'], ['ГУ 5 %'], ['Квалификационная и контактная информация'], ['ИНН']] })
    assert.deepEqual(readMainConditions(tight.Sheets.x), ['ГУ 5 %'])
    assert.deepEqual(readMainConditions(book({ x: [['Анкета'], ['ИНН']] }).Sheets.x), [])
    const noMain = readBidFileBytes(bytesOf({ 'Материалы': CURRENT['Материалы'] }))
    assert.deepEqual(noMain.conditions, [])
  })

  it('ставка НДС: варианты как у контрагентов; «Без НДС» — не 0 %; в т. ч. НДС — сумма × ставка / (100 + ставка)', () => {
    assert.deepEqual(VAT_OPTIONS, ['22 %', '20 %', '10 %', '7 %', '5 %', '0 %', 'Без НДС'])
    assert.deepEqual(parseVatAnswer('22 %'), { rate: 22, exempt: false })
    assert.deepEqual(parseVatAnswer('22'), { rate: 22, exempt: false }, 'как в ячейке Excel')
    assert.deepEqual(parseVatAnswer('без НДС'), { rate: 0, exempt: true })
    assert.deepEqual(parseVatAnswer('0 %'), { rate: 0, exempt: false })
    assert.equal(parseVatAnswer(''), null)
    assert.equal(parseVatAnswer('да'), null)
    assert.equal(vatIncluded(1220, { rate: 22, exempt: false }), 220)
    assert.equal(vatIncluded(1000, { rate: 0, exempt: true }), 0)
    assert.equal(vatIncluded(1000, null), 0)
    assert.equal(vatLabel({ rate: 5, exempt: false }), '5 %')
    assert.equal(vatLabel(null), 'не указан')
    const fields = [{ id: 'a', code: null }, { id: 'v', code: VAT_FIELD_CODE, kind: 'select', options: VAT_OPTIONS }]
    assert.deepEqual(vatFromAnswers(fields, { v: '10 %' }), { rate: 10, exempt: false })
    assert.equal(vatFromAnswers([{ id: 'a' }], { a: '10 %' }), null, 'без поля НДС — ставки нет')
    assert.equal(answerAllowed(fields[1], '18 %'), false)
    assert.equal(answerAllowed(fields[1], 'Без НДС'), true)
    assert.equal(answerAllowed(fields[1], ''), true, 'пусто — убрать ответ')
    assert.equal(answerAllowed({ kind: 'text' }, 'что угодно'), true)
    assert.deepEqual(parseOptions(' да \nнет; да\n\n  частично  '), ['да', 'нет', 'частично'])
  })
})

describe('Цены из файла подрядчика', () => {
  const positions = (() => {
    const r = readBidFileBytes(bytesOf(CURRENT))
    return mergeBidFiles([{ id: 1, name: 'ВОР', parsed: r }])
  })()
  const all = [...positions.materials, ...positions.works]
  const groups = bidGroups(all)

  it('заполненный ВОР отдела: строки листов «Материалы» и «Работы» — со своим видом', () => {
    const wb = book({
      'Материалы': [['Наименование', 'Ед. изм.', 'Кол-во', 'Цена за ед. с НДС'], ['Бетон В25 W8', 'м3', 120.5, 7800], ['Арматура А500С d12', 'т', 3.25, '85 000,50']],
      'Работы': [['Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС'], ['Устройство монолитной плиты', 'м3', 130.5, 2500]],
    })
    const doc = itemsFromBidWorkbook(XLSX, wb)
    assert.equal(doc.items.length, 3)
    assert.deepEqual(doc.items.map((i) => i.kindHint), ['material', 'material', 'work'])
    const matched = matchBidItems(doc.items, groups)
    assert.deepEqual(matched.map((m) => m.match?.group.position.kind), ['material', 'material', 'work'])
    assert.ok(matched.every((m) => m.match.exact))
    assert.equal(doc.items[1].price, 85000.5)
    assert.equal(itemsFromBidWorkbook(XLSX, book({ Прайс: [['Наименование', 'Цена'], ['x', 1]] })), null, 'не ВОР — общий разбор')
  })

  it('свой прайс: точное совпадение наименования (регистр, пробелы, ё), иначе похожее — со степенью похожести', () => {
    const items = [
      { name: 'бетон в25  w8', unit: 'м3', price: 7700 },
      { name: 'Арматура А500С диаметр 12', unit: 'т', price: 80000 },
      { name: 'Кирпич облицовочный', unit: 'шт', price: 30 },
    ]
    const matched = matchBidItems(items, groups)
    assert.equal(matched[0].match.exact, true)
    assert.equal(matched[0].match.group.position.name, 'Бетон В25 W8')
    assert.equal(matched[1].match?.group.position.name, 'Арматура А500С d12')
    assert.equal(matched[1].match.exact, false)
    assert.equal(matched[2].match, null, 'непохожее — не сопоставляется')
    assert.deepEqual(searchBidGroups('плиты', groups, 'work').map((g) => g.name).sort(), ['Армирование плиты', 'Устройство монолитной плиты'])
    assert.deepEqual(searchBidGroups('плиты', groups, 'material'), [], 'поиск — среди позиций своего вида')
  })

  it('одна позиция — одной строке файла: дубль строки остаётся без пары', () => {
    const matched = matchBidItems([
      { name: 'Бетон В25 W8', unit: 'м3', price: 7700 },
      { name: 'Бетон В25 W8', unit: 'м3', price: 7900 },
    ], groups)
    assert.ok(matched[0].match)
    assert.equal(matched[1].match, null)
  })
})
