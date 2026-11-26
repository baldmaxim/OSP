// ВОР отдела с ценами подрядчика (просьба пользователя 25.11.2026): цены, примечания и анкета вписываются в исходную книгу, всё
// остальное в архиве книги не меняется; формулы остаются, их результаты — посчитанные по вписанным ценам (вторая просьба того же дня:
// «проверь, что работают формулы и корректно лист КП отображается» — защищённый просмотр Excel книгу не пересчитывает), что не посчитано
// наверняка — убирается, Excel пересчитывает книгу при открытии. Модули: src/utils/bidVorFill.js, xlsxFormula.js, xlsxXml.js,
// bidVorArchive.js. Сверка вычислителя с LibreOffice на настоящем ВОР отдела (895 формул «КП» / «МАТЕРИАЛОВ» / «РАБОТ», все совпали) —
// вручную 25.11.2026: файлы подрядчиков в репозиторий не кладём.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import PizZip from 'pizzip'
import { fillBidVorBytes, labelScore, priceColumns } from '../../src/utils/bidVorFill.js'
import { patchSheetXml, setFullCalcOnLoad, stripFormulaValues, setFormulaValues } from '../../src/utils/xlsxXml.js'
import { workbookEvaluator, isXlError } from '../../src/utils/xlsxFormula.js'
import { bidKey } from '../../src/utils/bidPrice.js'
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
    assert.equal(wb.Sheets['Материалы'].F2.v, 939960.25, 'результат формулы посчитан по вписанной цене — виден и без пересчёта книги')
    assert.equal(wb.Sheets['КП'].H2.v, 500, 'VLOOKUP шаблона посчитан по вписанной цене работы')
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

// Шаблон как у отдела (выгрузка Estimat, ВОР «3М Групп»): цены «КП» — XLOOKUP по «Материалам» / «Работам», цена материалов работы —
// SUMPRODUCT, разделы и итог — вложенные SUBTOTAL(9), объёмы «Материалов» / «Работ» — SUMIFS по «КП».
// Формула с сохранённым результатом «0» — как в файле отдела до расценки.
const F = (f) => ({ f, v: 0 })
const DEPT = {
  'Материалы': [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС', 'Итого', 'Примечание контрагента'],
    [1, 'Бетон В25 W8', 'м3', F('SUMIFS(КП!E:E,КП!C:C,B2,КП!B:B,"мат.")'), 0, F('D2*E2'), ''],
    [2, 'Сетка 1000*500 ВЕ', 'шт', F('SUMIFS(КП!E:E,КП!C:C,B3,КП!B:B,"мат.")'), 0, F('D3*E3'), ''],
    ['', '', '', '', '', F('SUBTOTAL(9,F2:F3)'), ''],
  ],
  'Работы': [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС', 'Итого'],
    [1, 'Устройство монолитной плиты', 'м3', F('SUMIFS(КП!E:E,КП!C:C,B2,КП!B:B,"Р")'), 0, F('D2*E2')],
  ],
  'КП': [
    ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Цена материалы', 'Цена СМР', 'Стоимость материалы', 'Стоимость СМР', 'Справка'],
    ['', '', 'Плита паркинга', '', '', '', '', F('SUBTOTAL(9,H3:H6)'), F('SUBTOTAL(9,I3:I6)'), ''],
    ['1', 'Р', 'Устройство монолитной плиты', 'м3', 120.5, F('IFERROR(SUMPRODUCT(E4:E5,F4:F5)/E3,0)'),
      F('_xlfn.XLOOKUP(C3,Работы!B:B,Работы!E:E,0,0,1)'), F('F3*E3'), F('G3*E3'), ''],
    ['', 'мат.', 'Бетон В25 W8', 'м3', 120.5, F('_xlfn.XLOOKUP(C4,Материалы!B:B,Материалы!E:E,0,0,1)'), '', '', '', ''],
    ['', 'мат.', 'Сетка 1000*500 ВЕ', 'шт', 4, F('_xlfn.XLOOKUP(C5,Материалы!B:B,Материалы!E:E,0,0,1)'), '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', 'ИТОГО с НДС 22%', '', '', '', '', F('SUBTOTAL(9,H2:H6)'), F('SUBTOTAL(9,I2:I6)'), ''],
    ['', '', 'в т.ч. НДС 22%', '', '', '', '', F('H7/122*22'), F('I7/122*22'), ''],
  ],
}
const DEPT_RATES = new Map([
  [bidKey('material', 'Бетон В25 W8', 'м3'), { price: 7800 }],
  [bidKey('work', 'Устройство монолитной плиты', 'м3'), { price: 500 }],
])

function deptBook(edit = null) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(DEPT)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    if (edit) edit(name, ws)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('ВОР с ценами: результаты формул («КП» без пересчёта)', () => {
  it('шаблон отдела: XLOOKUP, SUMPRODUCT, SUMIFS (с * в наименовании), вложенные SUBTOTAL — посчитаны по вписанным ценам', () => {
    const res = fillBidVorBytes(deptBook(), { rates: DEPT_RATES })
    assert.ok(res.bytes, JSON.stringify(res))
    assert.equal(res.stats.uncomputed, 0)
    // Без cellFormula и пересчёта — как защищённый просмотр Excel и почта: видны сохранённые результаты.
    const wb = XLSX.read(res.bytes, { type: 'array' })
    const v = (sheet, ref) => wb.Sheets[sheet][ref]?.v
    assert.equal(v('Материалы', 'D2'), 120.5, 'объём — SUMIFS по «КП»')
    assert.equal(v('Материалы', 'D3'), 4, '* в наименовании — подстановка SUMIFS, как в Excel')
    assert.equal(v('Материалы', 'F2'), 939900)
    assert.equal(v('Материалы', 'F4'), 939900)
    assert.equal(v('Работы', 'F2'), 60250)
    assert.equal(v('КП', 'F4'), 7800, 'цена материала — XLOOKUP по «Материалам»')
    assert.equal(v('КП', 'F5'), 0, 'позиция без цены — ноль, как в шаблоне')
    assert.equal(v('КП', 'F3'), 7800, 'цена материалов работы — SUMPRODUCT / объём')
    assert.equal(v('КП', 'G3'), 500)
    assert.equal(v('КП', 'H2'), 939900)
    assert.equal(v('КП', 'H7'), 939900, 'итог — без повторного счёта вложенного SUBTOTAL раздела')
    assert.equal(v('КП', 'I7'), 60250)
    assert.ok(Math.abs(v('КП', 'H8') - 939900 / 122 * 22) < 1e-6)
  })

  it('незнакомая функция, скрытая строка под SUBTOTAL — результат убран у неё и у всех, кто от неё зависит; остальное посчитано', () => {
    const bytes = deptBook((name, ws) => {
      if (name !== 'КП') return
      ws.J3 = { t: 'n', f: 'INDIRECT("A1")', v: 5 }
      ws.J7 = { t: 'n', f: 'J3*2+H7', v: 10 }
      ws['!rows'] = []
      ws['!rows'][5] = { hidden: true }
    })
    const res = fillBidVorBytes(bytes, { rates: DEPT_RATES })
    const wb = XLSX.read(res.bytes, { type: 'array' })
    const v = (ref) => wb.Sheets['КП'][ref]?.v
    assert.equal(v('J3'), undefined, 'INDIRECT не считаем — Excel посчитает при открытии')
    assert.equal(v('J7'), undefined, 'зависящая от неё — тоже')
    assert.equal(v('H2'), undefined, 'SUBTOTAL над скрытой строкой — не считаем')
    assert.equal(v('H7'), undefined)
    assert.equal(v('H3'), 939900, 'строка без скрытых и незнакомого — посчитана')
    assert.ok(res.stats.uncomputed >= 4, JSON.stringify(res.stats))
    assert.match(new PizZip(res.bytes).file('xl/workbook.xml').asText(), /fullCalcOnLoad="1"/, 'Excel всё равно пересчитает книгу')
  })

  it('вычислитель: приоритеты, ROUND, IFERROR, подстановки, ошибки', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Сетка 1000*500', 2, { f: '-2^2' }, { f: '2+3*4' }, { f: 'ROUND(1.005,2)' }, { f: 'ROUND(-2.5,0)' }],
      ['Сетка 800*300', 3, { f: 'IFERROR(1/0,7)' }, { f: 'SUMIF(A1:A3,"Сетка 1000~*500",B1:B3)' }, { f: 'SUMIF(A1:A3,"Сетка*",B1:B3)' }, { f: 'COUNTIFS(A1:A3,"<>")' }],
      ['Труба', 4, { f: 'XLOOKUP("нет",A1:A3,B1:B3)' }, { f: '"а"&"б"' }, { f: 'SUM(B1:B3)*50%' }, { f: 'MAX(B1:B3)-MIN(B1:B3)' }],
    ])
    const ev = workbookEvaluator(XLSX, { Sheets: { Л: ws }, SheetNames: ['Л'] })
    const val = (ref) => { const at = XLSX.utils.decode_cell(ref); return ev.value('Л', at.r, at.c) }
    const nums = { C1: 4, D1: 14, E1: 1.01, F1: -3, C2: 7, D2: 2, E2: 5, F2: 3, E3: 4.5, F3: 2 }
    for (const [ref, want] of Object.entries(nums)) assert.equal(val(ref).value, want, ref)
    assert.ok(isXlError(val('C3').value) && val('C3').value.code === '#N/A')
    assert.equal(val('D3').value, 'аб')
    const bad = XLSX.utils.aoa_to_sheet([[{ f: 'Цена*2' }, { f: '[1]БСМ!A1' }, { f: 'OFFSET(A1,1,1)' }]])
    const ev2 = workbookEvaluator(XLSX, { Sheets: { Л: bad }, SheetNames: ['Л'] })
    for (let c = 0; c < 3; c++) assert.equal(ev2.value('Л', 0, c).ok, false, `колонка ${c}: имя, внешняя книга, незнакомая функция — не считаем`)
  })

  it('XML: результат пишется числом, тип прежнего результата снимается; без результата — встаёт после формулы', () => {
    const xml = '<row><c r="A1" t="str"><f>B1&amp;"x"</f><v>old</v></c><c r="B1"><f>C1*2</f></c><c r="C1"><f t="shared" si="0"/></c></row>'
    const { xml: out, written, cleared } = setFormulaValues(xml, ({ ref }) => (ref === 'A1' ? { value: 1.5 } : ref === 'B1' ? { value: 4 } : { strip: true }))
    assert.equal(written, 2)
    assert.equal(cleared, 0)
    assert.equal(out, '<row><c r="A1"><f>B1&amp;"x"</f><v>1.5</v></c><c r="B1"><f>C1*2</f><v>4</v></c><c r="C1"><f t="shared" si="0"/></c></row>')
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
