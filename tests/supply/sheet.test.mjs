// Лист «Материалы» файла ВОР → позиции для расценки снабжением (src/utils/vorMaterialsSheet.js,
// src/utils/vorMaterials.js). Книги собираются в тесте через xlsx: разные шапки, разделы и «Итого», числа с
// пробелами и запятой, лист в другом регистре, нет листа, ручное сопоставление колонок.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  findMaterialsSheet, detectMaterialsColumns, parseMaterialsSheet, readMaterialsFromWorkbook, parseVolume, isWorkbookFileName,
  readMaterialsWorkbookBytes, readMaterialsByCodeBytes, detectCodeColumns,
} from '../../src/utils/vorMaterialsSheet.js'
import { buildSupplyPositions, positionsFromEstimate, aggregateEstimate, isWorkItem, isSupplyMaterial } from '../../src/utils/vorMaterials.js'
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

  it('как в ВОР тендера 785: заголовок над шапкой, строка номеров колонок 1…7, цена и итог от снабжения', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Стоимость материалов'],
      ['№ п/п', 'Наименование материала', 'Ед. изм.', 'Объем', 'ЦЕНА руб., с учетом доставки и НДС 22%', 'ИТОГО, руб. с учетом НДС 22%', 'Примечание от контрагента'],
      [1, 2, 3, 4, 5, 6, 7],
      [1, 'Кирпич "КМС" Гангут 59, 210*100*50 с косым резом для облицовки пояса (размер и цвет по согласованию с Заказчиком)', 'м2', 385.671, null, 0, null],
      [2, 'Прочие материалы для монтажа кирпича "КМС" Гангут 59 на подсистему под углом с затиркой швов', 'м2', 350.61, null, 0, null],
      [9, 'Кирпич "КМС" Гангут 59, 210*50*21 (размер и цвет по согласованию с Заказчиком)', 'м2', '1 035,3464', null, 0, null],
      [15, 'Устройство противопожарных отсечек из оцинкованной стали с полимерным покрытием толщиной 0,7 мм', 'м. пог.', 2168.22, null, 0, null],
    ])
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }]
    const wb = XLSX.utils.book_new()
    for (const [name, sheet] of [['КП', XLSX.utils.aoa_to_sheet([['x']])], ['МАТЕРИАЛЫ', ws], ['РАБОТЫ', XLSX.utils.aoa_to_sheet([['y']])], ['ДАННЫЕ', XLSX.utils.aoa_to_sheet([['z']])]]) {
      XLSX.utils.book_append_sheet(wb, sheet, name)
    }
    const r = readMaterialsFromWorkbook(XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' }))
    assert.equal(r.sheetName, 'МАТЕРИАЛЫ')
    assert.equal(r.map.headerRow, 2)
    assert.deepEqual(r.map.columns, { name: 1, unit: 2, volume: 3 })
    assert.deepEqual(r.rows.map((x) => [x.unit, x.volume, x.row]), [['м2', 385.671, 4], ['м2', 350.61, 5], ['м2', 1035.3464, 6], ['м. пог.', 2168.22, 7]])
    assert.equal(r.skipped.empty, 1, 'строка номеров колонок пропущена')
    assert.equal(buildSupplyPositions(r.rows).length, 4)
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

describe('Чтение файла ВОР для автозагрузки — только нужные листы', () => {
  const bytes = (sheets) => {
    const wb = XLSX.utils.book_new()
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  }
  const big = Array.from({ length: 3000 }, (_, i) => [`Работа ${i}`, 'м', i])
  const file = bytes({
    КП: big,
    МАТЕРИАЛЫ: [['Стоимость материалов'], ['№ п/п', 'Наименование материала', 'Ед. изм.', 'Объем'], [1, 2, 3, 4], [1, 'Труба', 'м', 5]],
    РАБОТЫ: big,
    'Лист 7': [['Наименование', 'Кол-во'], ['Кран', 2]],
  })

  it('разбирается только лист «Материалы»; имена всех листов — для подсказки', () => {
    const wb = readMaterialsWorkbookBytes(file)
    assert.deepEqual(wb.SheetNames, ['КП', 'МАТЕРИАЛЫ', 'РАБОТЫ', 'Лист 7'])
    assert.deepEqual(Object.keys(wb.Sheets), ['МАТЕРИАЛЫ'])
    const r = readMaterialsFromWorkbook(wb)
    assert.deepEqual(r.rows.map((x) => [x.name, x.unit, x.volume]), [['Труба', 'м', 5]])
  })

  it('лист из сохранённой карты колонок разбирается вместе с «Материалами»', () => {
    const wb = readMaterialsWorkbookBytes(file, ['Лист 7', 'Нет такого'])
    assert.deepEqual(Object.keys(wb.Sheets).sort(), ['Лист 7', 'МАТЕРИАЛЫ'])
  })

  it('листа «Материалы» нет — ни один лист не разбирается, причина — «нет листа» со списком листов', () => {
    const wb = readMaterialsWorkbookBytes(bytes({ КП: big, РАБОТЫ: big }))
    assert.deepEqual(Object.keys(wb.Sheets), [])
    assert.deepEqual(readMaterialsFromWorkbook(wb), { error: 'no_sheet', sheetNames: ['КП', 'РАБОТЫ'] })
  })

  it('испорченная книга — исключение (автозагрузка запоминает «файл не читается»); не книга — «нет листа»', () => {
    assert.throws(() => readMaterialsWorkbookBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])))
    // Текст (например, PDF с расширением .xlsx) SheetJS читает как таблицу из одного листа.
    const wb = readMaterialsWorkbookBytes(new TextEncoder().encode('%PDF-1.4 не книга'))
    assert.equal(readMaterialsFromWorkbook(wb).error, 'no_sheet')
  })
})

describe('Без листа «Материалы»: сам лист ВОР по колонке «КОД»', () => {
  const bytes = (sheets) => {
    const wb = XLSX.utils.book_new()
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  }
  // Как ВОР тендера 445 «ОЗДС»: шапка тендера в колонке «КОД», строка номеров колонок, разделы, работы «Р»,
  // материалы «мат.», материал без кода с расходом, «Итого», анкета претендента с единицами «да/нет».
  const VOR = [
    ['', 'Предмет тендера:', 'Выполнение комплекса электромонтажных работ'],
    ['', 'Объект:', 'Многофункциональный жилой комплекс (ЛОТ 33)'],
    ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход'],
    [1, 2, 3, 4, 5, 6],
    ['', '', 'Монтаж кабельно-проводниковой продукции'],
    ['1', 'Р', 'Монтаж (протяжка) кабеля слаботочных систем', 'м. пог.', 1110, ''],
    ['', 'мат.', 'Кабель силовой ППГнг(А)-HF 2х1,5', 'м', '', 1050.6],
    ['', 'Мат', 'Труба гофрированная из ПВХ, ∅20мм', 'м', '', '1 132,2'],
    ['', '', 'Грунтовка ГФ-021 (ГОСТ 25129-82) - 2 слоя', 'кг', '', 25.16],
    ['', '', 'Итого'],
    ['', '', 'Наличие авансирования', 'да (%) / нет'],
    ['', '', 'Сайт компании', 'ссылка'],
  ]

  it('материалы — строки «мат.» и без кода с расходом; объём — «Общий расход»; шапка, работы и анкета — нет', () => {
    const r = readMaterialsByCodeBytes(bytes({ 'КП': [['Коммерческое предложение']], 'Зил33 ВОР ОЗДС': VOR }), ['КП', 'Зил33 ВОР ОЗДС'])
    assert.equal(r.error, undefined)
    assert.equal(r.sheetName, 'Зил33 ВОР ОЗДС')
    assert.equal(r.map.mode, 'code')
    assert.deepEqual(r.rows.map((x) => [x.name, x.unit, x.volume]), [
      ['Кабель силовой ППГнг(А)-HF 2х1,5', 'м', 1050.6],
      ['Труба гофрированная из ПВХ, ∅20мм', 'м', 1132.2],
      ['Грунтовка ГФ-021 (ГОСТ 25129-82) - 2 слоя', 'кг', 25.16],
    ])
  })

  it('лист с «ВОР» в имени — первым, даже если «КП» тоже с колонкой «КОД»', () => {
    const kp = [['КОД', 'Наименование', 'Ед. изм.', 'Общий расход'], ['мат.', 'Из КП подрядчика', 'шт', 1]]
    const r = readMaterialsByCodeBytes(bytes({ 'КП': kp, 'ВОР': VOR }), ['КП', 'ВОР'])
    assert.equal(r.sheetName, 'ВОР')
  })

  it('колонки «КОД» нет нигде — «нет листа» с пометкой; «КОД» есть, а материалов нет — своя причина', () => {
    const none = readMaterialsByCodeBytes(bytes({ 'РАБОТЫ': [['Наименование', 'Объём'], ['Монтаж', 5]] }), ['РАБОТЫ'])
    assert.deepEqual(none, { error: 'no_sheet', codeTried: true, sheetNames: ['РАБОТЫ'] })
    const works = readMaterialsByCodeBytes(bytes({ 'ВОР': [['КОД', 'Наименование', 'Ед. изм.', 'Объем по виду работ'], ['Р', 'Монтаж', 'м', 5]] }), ['ВОР'])
    assert.equal(works.error, 'no_material_codes')
    assert.equal(works.sheetName, 'ВОР')
  })

  it('сохранённая карта mode: code — тот же разбор (новая версия файла — сразу, без поиска листов)', () => {
    const wb = book({ 'ВОР': VOR })
    const r = readMaterialsFromWorkbook(wb, { mode: 'code', sheetName: 'ВОР' })
    assert.equal(r.rows.length, 3)
    assert.equal(detectCodeColumns(wb.Sheets['ВОР']).consumption, true)
  })
})

describe('Вкладка «ВОР» карточки: материалы — по коду «мат»', () => {
  it('строки тендера 445: шапка, номера колонок, работы и анкета — не материалы; 181: материал без кода с расходом — материал', () => {
    const items = [
      { estimate_name: 'ОЗДС', code: 'Предмет тендера:', cost_name: 'Выполнение комплекса работ', is_section: false },
      { estimate_name: 'ОЗДС', code: 'КОД', cost_name: 'Наименование затрат', unit: 'Ед. изм.', is_section: false },
      { estimate_name: 'ОЗДС', code: '2', cost_name: '3', unit: '5', material_consumption: 7, is_section: false },
      { estimate_name: 'ОЗДС', code: 'Р', cost_name: 'Монтаж ДР', unit: 'шт', material_consumption: null, is_section: false },
      { estimate_name: 'ОЗДС', code: 'мат.', cost_name: 'Дератизатор (ДР)', unit: 'шт', material_consumption: 4, is_section: false },
      { estimate_name: 'ОЗДС', code: null, cost_name: 'Наличие авансирования', unit: 'да (%) / нет', material_consumption: null, is_section: false },
      { estimate_name: 'ОЗДС', code: null, cost_name: 'Субподрядные работы объекта', is_section: true },
      { estimate_name: 'Лот 33', code: 'Мат', cost_name: 'Труба Ø16х1,6', unit: 'тн', material_consumption: 0.02, is_section: false },
      { estimate_name: 'Лот 33', code: 'Работа', cost_name: 'Монтаж ограждения', unit: 'м', material_consumption: 10, is_section: false },
      { estimate_name: 'Лот 33', code: null, cost_name: 'Грунтовка ГФ-021', unit: 'кг', material_consumption: 25.16, is_section: false },
      { estimate_name: 'Пустой', code: 'Р', cost_name: 'Только работа', unit: 'м', is_section: false },
    ]
    const docs = positionsFromEstimate(items)
    assert.deepEqual(docs.get('ОЗДС').map((p) => p.name), ['Дератизатор (ДР)'])
    assert.deepEqual(docs.get('Лот 33').map((p) => p.name), ['Труба Ø16х1,6', 'Грунтовка ГФ-021'])
    assert.deepEqual(docs.get('Пустой'), [], 'ВОР без материалов — пустой список, а не пропуск')
    assert.ok(isSupplyMaterial({ code: ' МАТ. ' }) && isSupplyMaterial({ code: 'материал' }))
    assert.ok(!isSupplyMaterial({ code: '', unit: 'кг', volume: 0 }) && !isSupplyMaterial({ code: '', unit: '', volume: 5 }))
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
