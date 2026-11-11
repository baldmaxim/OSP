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
import { ANCHOR_HEADER, TEMPLATE_HEADERS, matchProposalRows } from '../../src/utils/contractorProposal.js'

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

  it('ставка НДС: варианты как у контрагентов (без 20 %, 10 % и «Без НДС»); прежний «Без НДС» — не 0 %; в т. ч. НДС — сумма × ставка / (100 + ставка)', () => {
    assert.deepEqual(VAT_OPTIONS, ['22 %', '7 %', '5 %', '0 %'])
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
    assert.equal(answerAllowed(fields[1], '5 %'), true)
    for (const gone of ['20 %', '10 %', 'Без НДС']) assert.equal(answerAllowed(fields[1], gone), false, `${gone} — не из списка`)
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

describe('Шаблон КП: чужой файл не читается', () => {
  const items = [{ id: 'i1', row_number: 1, cost_name: 'Монтаж', work_volume: 2, estimate_name: 'Основная смета' }]

  it('файл другого вида (например, сам ВОР): строки не читаются, а цены из чужих колонок не появляются', () => {
    const vor = [['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена', 'Итого', '', '', 100, 200], [1, 'Монтаж', 'м2', 2, 100, 200, '', '', 100, 200]]
    const res = matchProposalRows(vor, items)
    assert.equal(res.notTemplate, true)
    assert.deepEqual(res.rows, [])
  })

  it('шаблон без служебного столбца и с ним читается как раньше', () => {
    const headers = TEMPLATE_HEADERS.filter((h) => h !== ANCHOR_HEADER)
    const noAnchor = matchProposalRows([headers, [1, '', '', 'Монтаж', '', 'м2', 2, '', 100, 50]], items)
    assert.equal(noAnchor.notTemplate, undefined)
    assert.equal(noAnchor.matchedBy, 'number')
    assert.equal(noAnchor.rows[0].total_unit_price, 150)
    const row = Array(TEMPLATE_HEADERS.length).fill('')
    row[8] = 100
    row[TEMPLATE_HEADERS.indexOf(ANCHOR_HEADER)] = 'i1'
    const anchored = matchProposalRows([TEMPLATE_HEADERS, row], items)
    assert.equal(anchored.matchedBy, 'anchor')
    assert.equal(anchored.rows[0].unit_price_materials, 100)
  })

  it('суммы — как у КП, загруженного сотрудником: материалы на общий расход, работы на объём по виду работ', () => {
    // У строки материала объём работ пуст, количество — в общем расходе: раньше сумма материалов выходила 0.
    const vorItems = [
      { id: 'w1', row_number: 1, cost_name: 'Прокладка кабеля', work_volume: 4000, material_consumption: null, estimate_name: 'Основная смета' },
      { id: 'm1', row_number: 2, cost_name: 'Кабель ВВГнг 3x2,5', work_volume: null, material_consumption: 4000, estimate_name: 'Основная смета' },
    ]
    const anchorCol = TEMPLATE_HEADERS.indexOf(ANCHOR_HEADER)
    const line = (id, mat, work) => {
      const r = Array(TEMPLATE_HEADERS.length).fill('')
      r[8] = mat
      r[9] = work
      r[anchorCol] = id
      return r
    }
    const res = matchProposalRows([TEMPLATE_HEADERS, line('w1', '', 150), line('m1', 95, '')], vorItems)
    const byId = Object.fromEntries(res.rows.map((r) => [r.estimate_item_id, r]))
    assert.equal(byId.w1.total_works, 600000)
    assert.equal(byId.w1.total_cost, 600000)
    assert.equal(byId.m1.total_materials, 380000)
    assert.equal(byId.m1.total_cost, 380000)
  })
})

// Свой ВОР подрядчика с расценками (миграция 20270113, решение пользователя 11.11.2026): цены читает тот же разбор, что «Цены из
// файла», сумма ведомости — цена файла × объём ВОР отдела; сводка по ведомостям — как «ВОР × подрядчик» в «Сравнении КП».
describe('Свой ВОР с расценками: сводка по ведомости и по тендеру', async () => {
  const { summarizeBidFile, bidFileVat } = await import('../../src/utils/bidFileSummary.js')
  const { bidFilesTable, summaryCounted, summaryIncomplete, coverageText } = await import('../../src/utils/bidFiles.js')
  const { readBidPriceDoc } = await import('../../src/utils/bidImport.js')
  const vor = readBidFileBytes(bytesOf(CURRENT))
  const positions = [...vor.materials, ...vor.works]

  // Подрядчик заполнил цены в том же файле ВОР: бетон и арматура, из работ — только плита; объём у себя поправил — не в счёт.
  const filled = () => {
    const copy = JSON.parse(JSON.stringify(CURRENT))
    copy['Материалы'][3][4] = 7800
    copy['Материалы'][4][4] = '85 000'
    copy['Материалы'][5][4] = 7800
    copy['Материалы'][3][3] = 999
    copy['Работы'][1][4] = 2500
    return bytesOf(copy)
  }

  it('заполненный ВОР отдела: цена × объём ведомости, отдельно материалы и работы; сколько позиций с ценой', async () => {
    const s = summarizeBidFile(await readBidPriceDoc(filled(), 'ВОР к1 — Альфа.xlsx'), positions)
    assert.equal(s.error, undefined)
    assert.equal(s.materials, 7800 * 130.5 + 85000 * 3.25)
    assert.equal(s.works, 2500 * 130.5)
    assert.equal(s.total, s.materials + s.works)
    assert.deepEqual(s.items, { material: 2, work: 2 })
    assert.deepEqual(s.priced, { material: 2, work: 1 })
    assert.equal(s.vat, 'gross')
    assert.ok(summaryCounted(s))
    assert.equal(summaryIncomplete(s, 'material'), false)
    assert.equal(summaryIncomplete(s, 'work'), true, 'армирование без цены — итог неполный')
    assert.equal(coverageText(s, 'work'), 'Цены у 1 из 2 позиций работ')
  })

  it('НДС: «без НДС» в документе — НДС сверху; подрядчик без НДС — как есть', () => {
    const doc = { items: [{ name: 'Бетон В25 W8', unit: 'м3', price: 1000, priceVat: 'net' }], vat: { mode: 'net', rate: 22 } }
    assert.equal(summarizeBidFile(doc, positions).materials, 1220 * 130.5)
    assert.equal(summarizeBidFile(doc, positions).vat, 'net')
    const exempt = summarizeBidFile(doc, positions, { exempt: true })
    assert.equal(exempt.materials, 1000 * 130.5)
    assert.equal(exempt.vat, 'exempt')
    assert.equal(bidFileVat({ vat: null }, { rate: 7 }).rate, 7, 'ставка документа не указана — из анкеты')
  })

  it('не прочитался, ВОР отдела не разобран, цен по позициям нет — сумма не считается, причина записана', () => {
    assert.deepEqual(summarizeBidFile({ error: 'no_table' }, positions), { v: 1, error: 'no_table' })
    assert.equal(summarizeBidFile({ items: [{ name: 'Бетон В25 W8', unit: 'м3', price: 1 }] }, null).error, 'no_vor')
    const none = summarizeBidFile({ items: [{ name: 'Кирпич облицовочный', unit: 'шт', price: 30 }] }, positions)
    assert.equal(none.error, 'no_prices')
    assert.equal(summaryCounted(none), false)
  })

  it('сводка тендера: файл — к своей ведомости; ВОР заменили — файл прежней версии по имени, в итог не входит; ведомости нет — тоже', () => {
    const vors = [{ id: 'v1', file_name: 'ВОР к1.xlsx' }, { id: 'v2-new', file_name: 'ВОР к2.xlsx' }, { id: 'v3', file_name: 'ВОР к3.xlsx' }]
    const sum = (total, over = {}) => ({ v: 1, materials: total / 2, works: total / 2, total, items: { material: 1, work: 1 }, priced: { material: 1, work: 1 }, ...over })
    const mine = [
      { id: 'f1', vor_file_id: 'v1', vor_name: 'ВОР к1', summary: sum(100) },
      { id: 'f2', vor_file_id: 'v2-old', vor_name: 'ВОР к2', summary: sum(50, { priced: { material: 0, work: 1 } }) },
      { id: 'f4', vor_file_id: 'gone', vor_name: 'ВОР паркинга', summary: sum(1000) },
    ]
    const t = bidFilesTable(vors, mine)
    assert.deepEqual(t.rows.map((r) => [r.vor.id, r.file?.id || null, r.stale]), [['v1', 'f1', false], ['v2-new', 'f2', true], ['v3', null, false]])
    assert.deepEqual(t.orphans.map((f) => f.id), ['f4'])
    // Расценка к прежней версии посчитана по старым объёмам — видна у новой версии, но в ИТОГО не входит, пока её не загрузят заново.
    assert.deepEqual([t.totals.materials, t.totals.works, t.totals.total], [50, 50, 100])
    assert.deepEqual([t.totals.uploaded, t.totals.counted, t.totals.stale, t.totals.incomplete], [1, 1, 1, false])
    // Файл без суммы — загружен, но в итог не входит.
    const t2 = bidFilesTable(vors, [{ id: 'f1', vor_file_id: 'v1', vor_name: 'ВОР к1', summary: { v: 1, error: 'no_prices' } }])
    assert.deepEqual([t2.totals.uploaded, t2.totals.counted, t2.totals.total], [1, 0, 0])
  })
})

// Просьба пользователя 11.11.2026: «нигде нет багов с расценками». Случаи с настоящих заполненных ВОР подрядчиков (Примавера 14, вентиляция,
// ЦентрИнжиниринг): цены вписаны на листах корпусов, а «Материалы» / «Работы» остались с нулями — сводка была «0 ₽, цены у всех позиций».
describe('Свой ВОР с расценками: нули, повторы, две цены в строке', async () => {
  const { summarizeBidFile, priceBidPositions } = await import('../../src/utils/bidFileSummary.js')
  const { readBidPriceDoc, itemHasPrice } = await import('../../src/utils/bidImport.js')
  const vor = readBidFileBytes(bytesOf(CURRENT))
  const positions = [...vor.materials, ...vor.works]
  const zeroLists = () => {
    const copy = JSON.parse(JSON.stringify(CURRENT))
    for (const r of [3, 4, 5]) copy['Материалы'][r][4] = 0
    for (const r of [1, 2]) copy['Работы'][r][4] = 0
    return copy
  }

  it('ноль — не цена: листы «Материалы» / «Работы» с нулями, цены на листе корпуса — цены берутся с листа корпуса', async () => {
    const book = zeroLists()
    book['Корпус 1'] = [
      ['Наименование', 'Ед. изм.', 'Кол-во', 'Цена материалы', 'Цена СМР'],
      ['Устройство монолитной плиты', 'м3', 120.5, '', 2500],
      ['Бетон В25 W8', 'м3', 120.5, 7800, ''],
      ['Армирование плиты', 'т', 3.25, '', 30000],
      ['Арматура А500С d12', 'т', 3.25, 85000, ''],
    ]
    const doc = await readBidPriceDoc(bytesOf(book), 'ВОР — цены по корпусам.xlsx')
    assert.ok(doc.items.every(itemHasPrice), 'строк с нулём среди строк документа нет')
    const s = summarizeBidFile(doc, positions)
    assert.deepEqual(s.priced, { material: 2, work: 2 }, JSON.stringify(s))
    assert.equal(s.materials, 7800 * 130.5 + 85000 * 3.25)
    assert.equal(s.works, 2500 * 130.5 + 30000 * 3.25, 'у работы — цена СМР, а не пустая цена материалов')
  })

  it('одни нули во всём файле — «цен нет», а не «0 ₽ и цены у всех позиций»', async () => {
    const s = summarizeBidFile(await readBidPriceDoc(bytesOf(zeroLists()), 'Пустой ВОР.xlsx'), positions)
    assert.equal(s.error, 'no_prices', 'сумма не считается — кабинет пишет «цены не распознаны»')
    assert.deepEqual(s.priced, { material: 0, work: 0 })
  })

  it('незаполненный ВОР для проверки по договорным расценкам (keepBlank): нули — пустая цена, строки на месте', async () => {
    const doc = await readBidPriceDoc(bytesOf(zeroLists()), 'Пустой ВОР.xlsx', { keepBlank: true })
    assert.ok(doc.items.length >= 4)
    assert.ok(doc.items.every((it) => it.price == null && it.sum == null), JSON.stringify(doc.items[0]))
  })

  it('повтор позиции (листы корпусов) не забирает соседнюю позицию «по похожести»: у нерасценённой цены нет', () => {
    const near = [
      { kind: 'material', key: 'm|возд05', itemKey: 'воздуховод толщ 0 5', unitKey: 'м2', name: 'Воздуховод (толщ. 0,5)', unit: 'м2', volume: 100 },
      { kind: 'material', key: 'm|возд06', itemKey: 'воздуховод толщ 0 6', unitKey: 'м2', name: 'Воздуховод (толщ. 0,6)', unit: 'м2', volume: 50 },
    ]
    const items = [
      { name: 'Воздуховод (толщ. 0,5)', unit: 'м2', price: 1000, priceVat: 'gross', kindHint: 'material' },
      { name: 'Воздуховод (толщ. 0,5)', unit: 'м2', price: 1100, priceVat: 'gross', kindHint: 'material' },
      { name: 'Воздуховод (толщ. 0,6)', unit: 'м2', price: 0, priceVat: 'gross', kindHint: 'material' },
    ]
    const { prices } = priceBidPositions(items, near, { mode: 'gross' })
    assert.equal(prices.get('m|возд05'), 1000, 'первая строка с ценой')
    assert.equal(prices.has('m|возд06'), false, 'ноль у 0,6 — не расценено; повтор 0,5 цену ей не даёт')
    const s = summarizeBidFile({ items, vat: { mode: 'gross' } }, near)
    assert.deepEqual(s.priced, { material: 1, work: 0 })
    assert.equal(s.materials, 100000)
  })

  it('своё наименование подрядчика — по похожести, только к позиции без своей строки в файле', () => {
    const { prices, unmatched } = priceBidPositions(
      [{ name: 'Бетон B25 W8 (с доставкой)', unit: 'м3', price: 8000, priceVat: 'gross' }, { name: 'Кирпич', unit: 'шт', price: 30, priceVat: 'gross' }],
      positions, { mode: 'gross' })
    assert.equal(prices.get(positions.find((p) => p.name === 'Бетон В25 W8').key), 8000)
    assert.equal(unmatched, 1)
  })
})

// Тендер № 847: «ЗИЛ лот 33 ВОР ЭН» и «… от 03.11.2026 версия 2» — подрядчику только актуальная версия (миграция 20270114).
describe('Ведомости: только актуальная версия', async () => {
  const { currentVorFiles, bidFilesTable } = await import('../../src/utils/bidFiles.js')
  const vors = [{ id: 'old', file_name: 'ЗИЛ лот 33 ВОР ЭН.xlsx' }, { id: 'new', file_name: 'ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2.xlsx' }, { id: 'k2', file_name: 'ВОР к2.xlsx' }]

  it('заменённая ведомость не показывается; функции нет — все файлы', () => {
    const { current, priorOf } = currentVorFiles(vors, [{ file_id: 'old', current_file_id: 'new' }])
    assert.deepEqual(current.map((v) => v.id), ['new', 'k2'])
    assert.equal(priorOf.get('old'), 'new')
    assert.deepEqual(currentVorFiles(vors, null).current.map((v) => v.id), ['old', 'new', 'k2'])
  })

  it('заменившего файла среди ведомостей нет (отдел его удалил) — прежний остаётся: без ведомости подрядчик не останется', () => {
    assert.deepEqual(currentVorFiles(vors, [{ file_id: 'k2', current_file_id: 'gone' }]).current.map((v) => v.id), ['old', 'new', 'k2'])
  })

  it('расценка к прежней версии — у новой (по отметке версий, хоть имя другое), в итог не входит; есть своя к новой — прежняя в сиротах', () => {
    const { current, priorOf } = currentVorFiles(vors, [{ file_id: 'old', current_file_id: 'new' }])
    const sum = { v: 1, materials: 10, works: 0, total: 10, items: { material: 1, work: 0 }, priced: { material: 1, work: 0 } }
    const old = { id: 'f-old', vor_file_id: 'old', vor_name: 'ЗИЛ лот 33 ВОР ЭН', summary: sum, updated_at: '2026-10-20T00:00:00Z' }
    const t = bidFilesTable(current, [old], priorOf)
    const row = t.rows.find((r) => r.vor.id === 'new')
    assert.equal(row.file?.id, 'f-old')
    assert.equal(row.stale, true)
    assert.deepEqual([t.totals.counted, t.totals.total, t.totals.stale], [0, 0, 1])
    const fresh = { id: 'f-new', vor_file_id: 'new', vor_name: 'ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2', summary: sum, updated_at: '2026-11-10T00:00:00Z' }
    const t2 = bidFilesTable(current, [old, fresh], priorOf)
    assert.equal(t2.rows.find((r) => r.vor.id === 'new').file.id, 'f-new')
    assert.deepEqual(t2.orphans.map((f) => f.id), ['f-old'])
    assert.equal(t2.totals.total, 10)
  })
})

// Анкета и «Моя компания» — одни сведения (миграция 20270115).
describe('Анкета участника и «Моя компания»', async () => {
  const { companyFieldState, effectiveAnswers, fieldGroups, COMPANY_SOURCES, isCompanyField } = await import('../../src/utils/bidFormLinks.js')
  const fields = [
    { id: 'name', label: 'Наименование контрагента', kind: 'text', scope: 'company', source: 'name' },
    { id: 'vat', label: 'Ставка НДС', kind: 'select', options: ['22 %', '7 %', '5 %', '0 %'], code: 'vat', scope: 'company', source: 'vat' },
    { id: 'dir', label: 'Генеральный директор: ФИО, тел., e-mail', kind: 'text', scope: 'company', source: 'director' },
    { id: 'sro', label: 'Наличие СРО', kind: 'text', scope: 'company', source: null },
    { id: 'visit', label: 'Посещение объекта', kind: 'text', scope: 'tender', source: null },
  ]
  const card = {
    name: 'ООО Альфа', inn: '7707083893', legal_address: 'Москва, ул. Строителей, 1', actual_address: 'Москва, ул. Строителей, 1', vat_rate: 22,
    contacts: [{ full_name: 'Сметчикова С. С.', position: null, email: 'smeta@alpha.ru' }, { full_name: 'Директоров Д. Д.', position: 'Генеральный директор', phone: '+7 916 000-00-10', email: 'dir@alpha.ru' }],
  }

  it('связанное поле — из карточки и не меняется; адрес один, если юр. и факт. совпадают; руководитель — по должности', () => {
    assert.deepEqual(companyFieldState(fields[0], card, {}), { value: 'ООО Альфа', from: 'card', locked: true, cardRaw: null })
    assert.equal(companyFieldState(fields[1], card, {}).value, '22 %')
    assert.equal(companyFieldState(fields[2], card, {}).value, 'Директоров Д. Д., +7 916 000-00-10, dir@alpha.ru')
    assert.equal(COMPANY_SOURCES.find((s) => s.key === 'address').value(card), 'Москва, ул. Строителей, 1')
    assert.equal(COMPANY_SOURCES.find((s) => s.key === 'address').value({ ...card, actual_address: 'Химки' }), 'юр.: Москва, ул. Строителей, 1; факт.: Химки')
  })

  it('в карточке пусто или вариант не из списка анкеты — отвечает подрядчик, ответ — один на компанию', () => {
    const exempt = companyFieldState(fields[1], { vat_exempt: true }, { vat: { value: '0 %' } })
    assert.deepEqual([exempt.value, exempt.from, exempt.locked, exempt.cardRaw], ['0 %', 'company', false, 'Без НДС'])
    assert.equal(companyFieldState(fields[0], {}, { name: { value: 'ООО Альфа-2' } }).value, 'ООО Альфа-2')
    assert.equal(companyFieldState(fields[1], {}, { vat: { value: '20 %' } }).value, '', 'вариант, которого в списке больше нет, — как нет ответа')
  })

  it('анкета тендера: поля о компании — из «Моей компании», расхождение поправляется; по тендеру — как есть', () => {
    const { answers, patch } = effectiveAnswers(fields, { name: 'ООО Альфа', vat: '7 %', sro: 'нет', visit: 'были' }, card, { sro: { value: 'да' } })
    assert.deepEqual(patch, { vat: '22 %', dir: 'Директоров Д. Д., +7 916 000-00-10, dir@alpha.ru', sro: 'да' })
    assert.equal(answers.visit, 'были')
    // Таблицы ответов о компании нет (база раньше миграции): карточка работает, СРО — ответ тендера.
    assert.deepEqual(effectiveAnswers(fields, { sro: 'нет' }, card, null).answers.sro, 'нет')
    assert.deepEqual(fieldGroups(fields).tender.map((f) => f.id), ['visit'])
    assert.equal(isCompanyField({ scope: 'tender', source: 'gone' }), true, 'сведения нет в перечне — поле всё равно о компании, ответы не теряются')
  })
})
