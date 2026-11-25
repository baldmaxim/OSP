// ВОР отдела с ценами подрядчика (просьба пользователя 25.11.2026): цены, примечания и анкета вписываются в исходную книгу, всё
// остальное в архиве книги не меняется; формулы остаются, их результаты убираются, Excel пересчитывает книгу при открытии.
// Модули: src/utils/bidVorFill.js, xlsxXml.js, bidVorArchive.js.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import PizZip from 'pizzip'
import { fillBidVorBytes, labelScore, priceColumns } from '../../src/utils/bidVorFill.js'
import { patchSheetXml, setFullCalcOnLoad, stripFormulaValues } from '../../src/utils/xlsxXml.js'
import { buildVorArchive, pricedFileName, NOT_FILLED_NAME } from '../../src/utils/bidVorArchive.js'
import { readBidFileBytes } from '../../src/utils/bidVor.js'

const book = (sheets) => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

const VOR = {
  'Главный лист': [
    ['', 'Особые условия, которые необходимо учесть в стоимости'],
    ['', 'ГУ в размере 5 % (Пять процентов)'],
    [],
    [],
    ['Квалификационная и контактная информация (обязательно к заполнению)'],
    [1, 'Наименование контрагента', '', ''],
    [2, 'ИНН', '', ''],
    [4, 'Указать % НДС из выпадающего списка', '', 22],
    [5, 'Наличие авансирования', '', ''],
  ],
  'Материалы': [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС', 'Итого', 'Примечание контрагента'],
    [1, 'Бетон В25 W8', 'м3', 120.5, 0, { f: 'D2*E2', v: 0 }, ''],
    [2, 'Арматура А500С d12', 'т', { f: '3+0.25', v: 3.25 }, 0, { f: 'D3*E3', v: 0 }, ''],
  ],
  'Работы': [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС', 'Итого'],
    [1, 'Устройство монолитной плиты', 'м3', 120.5, 0, { f: 'D2*E2', v: 0 }],
  ],
  'КП': [
    ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу', 'Цена материалы', 'Цена СМР'],
    ['1', 'Р', 'Устройство монолитной плиты', 'м3', 120.5, '', '', { f: 'VLOOKUP(C2,Работы!B:E,4,0)', v: 0 }],
    ['', 'мат.', 'Бетон В25 W8', 'м3', 120.5, 120.5, '', ''],
    ['', 'мат.', 'Арматура А500С d12', 'т', 3.25, 3.25, '', ''],
    ['', '', 'ИТОГО с НДС 22%', '', '', '', '', ''],
  ],
}
const FIELDS = [
  { id: 'n', label: 'Наименование контрагента' }, { id: 'i', label: 'ИНН' },
  { id: 'v', label: 'Ставка НДС', code: 'vat' }, { id: 'a', label: 'Наличие авансирования' },
]

function ratesOf(bytes, price) {
  const parsed = readBidFileBytes(bytes)
  return new Map([...parsed.materials, ...parsed.works].filter((p) => price(p) != null).map((p) => [p.key, { price: price(p), note: p.kind === 'material' ? 'с доставкой' : '' }]))
}

describe('ВОР отдела с ценами подрядчика', () => {
  const bytes = book(VOR)
  const rates = ratesOf(bytes, (p) => (/Арматура/.test(p.name) ? null : p.kind === 'work' ? 500 : 7800.5))

  it('цены и примечания — в «Материалы» / «Работы», «КП» — где нет формулы; позиция без цены не тронута', () => {
    const res = fillBidVorBytes(bytes, { rates, fields: FIELDS, answers: { n: 'ООО Альфа', i: '7701234567', v: '22 %', a: 'нет' } })
    assert.ok(res.bytes, JSON.stringify(res))
    const wb = XLSX.read(res.bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    const v = (sheet, ref) => wb.Sheets[sheet][ref]?.v ?? null
    assert.equal(v('Материалы', 'E2'), 7800.5)
    assert.equal(v('Материалы', 'G2'), 'с доставкой')
    assert.equal(v('Материалы', 'E3'), 0, 'без цены — как в файле отдела')
    assert.equal(v('Работы', 'E2'), 500)
    assert.equal(v('КП', 'G3'), 7800.5, 'цена материала — в колонку материалов')
    assert.equal(wb.Sheets['КП'].H2.f, 'VLOOKUP(C2,Работы!B:E,4,0)', 'формула шаблона не перебита')
    assert.equal(wb.Sheets['Материалы'].F2.f, 'D2*E2')
    assert.equal(wb.Sheets['Материалы'].F2.v, undefined, 'результат формулы, зависящей от цены, убран — книгу пересчитает программа')
    assert.equal(wb.Sheets['Материалы'].D3.v, 3.25, 'объём от цен не зависит — его результат остаётся (книга читается и без пересчёта)')
  })

  it('«Главный лист»: ответы анкеты — в колонку ответов блока; ставка НДС — числом, как в выпадающем списке', () => {
    for (const [answer, want] of [['22 %', 22], ['5 %', 5], ['Без НДС', 'Без НДС']]) {
      const res = fillBidVorBytes(bytes, { rates, fields: FIELDS, answers: { n: 'ООО Альфа', i: '7701234567', v: answer, a: 'нет' } })
      const ws = XLSX.read(res.bytes, { type: 'array' }).Sheets['Главный лист']
      assert.deepEqual(['D6', 'D7', 'D8', 'D9'].map((c) => ws[c]?.v), ['ООО Альфа', '7701234567', want, 'нет'], answer)
      assert.equal(res.stats.answers, 4)
    }
  })

  it('в архиве книги меняются только листы с правками и workbook.xml (пересчёт при открытии)', () => {
    const res = fillBidVorBytes(bytes, { rates, fields: FIELDS, answers: { n: 'ООО Альфа' } })
    const a = new PizZip(bytes)
    const b = new PizZip(res.bytes)
    const changed = Object.keys(a.files).filter((n) => !a.files[n].dir && a.file(n).asText() !== b.file(n)?.asText())
    assert.ok(changed.every((n) => n === 'xl/workbook.xml' || n.startsWith('xl/worksheets/')), changed.join(', '))
    assert.match(b.file('xl/workbook.xml').asText(), /<calcPr[^>]*fullCalcOnLoad="1"/)
    assert.deepEqual(Object.keys(b.files).sort(), Object.keys(a.files).sort())
  })

  it('не книга .xlsx и книга без колонки цен — ошибка, а не «заполненный» файл', () => {
    assert.equal(fillBidVorBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), {}).error, 'format')
    const noPrice = book({ 'Материалы': [['Наименование', 'Ед. изм.', 'Объём'], ['Бетон', 'м3', 1]] })
    assert.equal(fillBidVorBytes(noPrice, { rates }).error, 'no_columns')
  })

  it('архив: каждый ВОР своим файлом, с ценами — с организацией в имени; не заполнившийся — как есть и в списке', async () => {
    const files = [{ id: '1', file_name: 'ВОР паркинга.xlsx' }, { id: '2', file_name: 'Старый.xls' }]
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])
    const res = await buildVorArchive(files, async (f) => (f.id === '1' ? bytes : xls), { fill: { rates, fields: FIELDS, answers: {} }, company: 'ООО Альфа' })
    const zip = new PizZip(res.bytes)
    assert.deepEqual(Object.keys(zip.files).sort(), ['Старый.xls', NOT_FILLED_NAME, 'ВОР паркинга — ООО Альфа.xlsx'].sort())
    assert.equal(res.unfilled.length, 1)
    assert.equal(pricedFileName('ВОР: корпус 1.xlsx', ''), 'ВОР корпус 1 — с ценами.xlsx', 'знаки, недопустимые в Windows, убраны')
  })
})

describe('Правка XML книги', () => {
  it('ячейка: стиль сохраняется, формулу не трогаем, недостающие строка и ячейка встают по порядку', () => {
    const xml = '<worksheet><sheetData><row r="2" spans="1:2"><c r="A2" s="3"><v>1</v></c><c r="C2"><f>A2*2</f><v>2</v></c></row>'
      + '<row r="5"><c r="A5"/></row></sheetData></worksheet>'
    const res = patchSheetXml(xml, new Map([[2, new Map([[1, 9], [2, 'текст & <да>'], [3, 7]])], [3, new Map([[1, 4]])]]))
    assert.equal(res.written, 3)
    assert.deepEqual(res.skipped, ['C2'])
    assert.match(res.xml, /<row r="2"><c r="A2" s="3"><v>9<\/v><\/c><c r="B2" t="inlineStr"><is><t xml:space="preserve">текст &amp; &lt;да&gt;<\/t><\/is><\/c><c r="C2"><f>A2\*2<\/f><v>2<\/v><\/c><\/row><row r="3"><c r="A3"><v>4<\/v><\/c><\/row><row r="5">/)
  })

  it('calcPr: добавляется на место по схеме; результаты формул убираются, пустые ячейки не задеваются', () => {
    assert.match(setFullCalcOnLoad('<workbook><sheets><sheet/></sheets><definedNames></definedNames></workbook>'), /<\/definedNames><calcPr fullCalcOnLoad="1"\/><\/workbook>/)
    assert.match(setFullCalcOnLoad('<workbook><calcPr calcId="1"/></workbook>'), /<calcPr fullCalcOnLoad="1" calcId="1"\/>/)
    const { xml, cleared } = stripFormulaValues('<row><c r="A1" s="2"/><c r="B1" t="str"><f>"a"</f><v>a</v></c><c r="C1"><v>5</v></c></row>')
    assert.equal(cleared, 1)
    assert.equal(xml, '<row><c r="A1" s="2"/><c r="B1"><f>"a"</f></c><c r="C1"><v>5</v></c></row>')
  })

  it('подписи анкеты и колонки цен', () => {
    assert.equal(labelScore('Адрес (юр., факт.)', 'Адрес (юр. факт.)'), 1)
    assert.ok(labelScore('Наличие СРО', 'Наличие СРО (да/нет)') >= 0.9)
    assert.ok(labelScore('ИНН', 'Наименование контрагента') < 0.6)
    const ws = XLSX.utils.aoa_to_sheet([
      ['Наименование', 'Цена за единицу, руб. с НДС', '', 'Цена за единицу ИТОГО', 'Стоимость', 'Примечание (комментарии) от контрагента'],
      ['', 'Материалы/ оборудование', 'СМР, ПНР', '', '', ''],
    ])
    ws['!merges'] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }]
    assert.deepEqual(priceColumns(ws, 0), { price: [{ col: 1, kind: 'material' }, { col: 2, kind: 'work' }], note: 5 })
  })
})
