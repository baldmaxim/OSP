// Документ поставщика: несколько позиций в одной ячейке рамки и числа, которые нельзя склеивать (18.11.2026).
// Тендер № 546, КП «Тушино»: «Светильник „Баррель“…» и «Торшер „Румб“…» стояли в одной строке таблицы, цены «22 350» и «6 496»
// одна под другой — разбор склеил их в 223 506 496 ₽ за торшер, и цена встала в расценку. Здесь — копия по виду (настоящий файл
// в git не кладём): PDF печатает Chromium, читает pdf.js. Плюс правила без браузера: разряды в числе и дата документа из будущего.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { browserLaunchOptions } from '../tender/lib/stand.mjs'
import { docDateFromText, parseNum } from '../../src/utils/supplierDoc.js'
import { parseSupplierPdfPages, readPdfPages } from '../../src/utils/supplierDocRead.js'

describe('число из ячейки: пробелы — только разряды по три цифры', () => {
  it('«22 350 6 496» и «14 004 14 004» — два числа, а не одно; обычные записи — как раньше', () => {
    assert.equal(parseNum('22 350 6 496'), null)
    assert.equal(parseNum('14 004 14 004'), null)
    assert.equal(parseNum('12 34'), null)
    assert.equal(parseNum('18 450,00'), 18450)
    assert.equal(parseNum('1 234 567,89'), 1234567.89)
    assert.equal(parseNum('100 000.00'), 100000)
    assert.equal(parseNum('1 000 руб.'), 1000)
    assert.equal(parseNum('6 496'), 6496)
    assert.equal(parseNum('1.234,56'), 1234.56)
    assert.equal(parseNum('95,00 руб.'), 95)
    assert.equal(parseNum('22%'), 22)
  })
})

describe('дата документа: из будущего — не дата документа', () => {
  const today = new Date('2026-11-18T10:00:00Z')
  it('«03.10.54» (2054 год) пропускается — берётся следующая дата; «от …» важнее; до месяца вперёд — можно', () => {
    assert.equal(docDateFromText('Код 03.10.54 Спецификация № 21128544 от 16.11.2026', today), '2026-11-16')
    assert.equal(docDateFromText('Код 03.10.54, отгрузка 16.11.2026', today), '2026-11-16')
    assert.equal(docDateFromText('Код 03.10.54', today), null)
    assert.equal(docDateFromText('Счёт от 10.12.2026, действителен до 20.12.2026', today), '2026-12-10')
    assert.equal(docDateFromText('Счёт от 30.12.2026', today), null)
    assert.equal(docDateFromText('Счёт от 02 ноября 2026 г.', today), '2026-11-02')
  })
})

const launch = browserLaunchOptions()
describe('КП в PDF: несколько позиций в одной ячейке рамки', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let browser
  let page
  let pdfjs
  before(async () => {
    browser = await chromium.launch({ ...launch, headless: true })
    page = await browser.newPage()
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  })
  after(async () => { await browser?.close() })

  const STYLE = 'body{font:10pt Arial,sans-serif}table{border-collapse:collapse;width:100%}td,th{padding:2px 4px;vertical-align:top;border:1px solid #000}.r{text-align:right}'
  async function read(body, css = '') {
    await page.setContent(`<html><head><meta charset="utf-8"><style>${STYLE}${css}</style></head><body>${body}</body></html>`)
    const pdf = await page.pdf({ format: 'A4', margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } })
    return parseSupplierPdfPages(await readPdfPages(pdfjs, new Uint8Array(pdf)))
  }
  const brief = (items) => items.map((i) => [i.code, i.name, i.price, !!i.unsure])

  // Как КП «Тушино»: наименование, артикул, цена; две позиции в одной ячейке — через перенос строки.
  const TUSHINO = `<h3>Коммерческое предложение № 14 от 06.11.2026</h3><table>
    <tr><th>Наименование</th><th>Артикул</th><th>Цена, руб. с НДС</th></tr>
    <tr><td>Торшер "Луга К" LED 20 Вт 3000K, опаловый рассеиватель, высота 0,8 м</td><td>LUGA K O 3K</td><td class="r">32 299</td></tr>
    <tr><td>Торшер "Пони Декор" LED 2 Вт 3000K, прямой, высота 1,2 м (блок питания заказывается отдельно)<br>Торшер "Пони Декор" LED 2 Вт 3000K, изогнутый, высота 1,1 м (блок питания заказывается отдельно)</td><td>TP DECOR 90 3K<br>TP DECOR R 90 3K</td><td class="r">14 004<br>14 004</td></tr>
    <tr><td>Светильник типа "Баррель" LED 14 Вт 3000K для установки на торшер<br>Торшер "Румб" для установки светильника "Баррель", ø108 мм, высота 0,8 м</td><td>BRL 3K<br>RMB08</td><td class="r">22 350<br>6 496</td></tr>
    <tr><td>Анкерный закладной элемент для торшера "Румб"</td><td>ANK-R</td><td class="r">1 453</td></tr>
    </table><p>Итого: 90 606</p>`
  const EXPECTED = [
    ['LUGA K O 3K', 'Торшер "Луга К" LED 20 Вт 3000K, опаловый рассеиватель, высота 0,8 м', 32299, false],
    ['TP DECOR 90 3K', 'Торшер "Пони Декор" LED 2 Вт 3000K, прямой, высота 1,2 м (блок питания заказывается отдельно)', 14004, false],
    ['TP DECOR R 90 3K', 'Торшер "Пони Декор" LED 2 Вт 3000K, изогнутый, высота 1,1 м (блок питания заказывается отдельно)', 14004, false],
    ['BRL 3K', 'Светильник типа "Баррель" LED 14 Вт 3000K для установки на торшер', 22350, false],
    ['RMB08', 'Торшер "Румб" для установки светильника "Баррель", ø108 мм, высота 0,8 м', 6496, false],
    ['ANK-R', 'Анкерный закладной элемент для торшера "Румб"', 1453, false],
  ]

  it('тендер № 546: каждая позиция ячейки — своей строкой со своей ценой; узкое наименование и артикул по словам — тоже', async () => {
    for (const width of ['20em', '40em']) {
      const r = await read(TUSHINO, `td:first-child{width:${width}}`)
      assert.deepEqual(brief(r.items), EXPECTED, `наименование шириной ${width}`)
      assert.ok(r.items.every((i) => i.price < 100000), 'ни одной склеенной цены')
    }
  })

  it('наименование не делится по строкам — позиции свои, цены свои, но «сверьте с файлом» (unsure), сами не берутся', async () => {
    const r = await read(`<table><tr><th>Наименование</th><th>Артикул</th><th>Цена, руб.</th></tr>
      <tr><td>Опора наружного освещения</td><td>OP-6</td><td class="r">5 000</td></tr>
      <tr><td>светильник и опора в одном описании без заглавных букв, перенос на несколько строк подряд</td><td>A-1<br>B-2</td><td class="r">1 250<br>4 800</td></tr>
      </table>`, 'td:first-child{width:14em}')
    assert.deepEqual(r.items.map((i) => [i.code, i.price, !!i.unsure]), [['OP-6', 5000, false], ['A-1', 1250, true], ['B-2', 4800, true]])
  })

  it('одна позиция: перенос числа «18» + «450,00» и цифры по центру ячейки — одна строка, как раньше', async () => {
    const r = await read(`<table><tr><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr>
      <tr><td>Клапан противопожарный Сигмавент-90-НО-400х300 SVF 220 к, нормально открытый, с электроприводом</td><td class="r">4</td><td class="r" style="width:2.6em">18 450,00</td><td class="r">73 800,00</td></tr>
      <tr><td>Решетка вентиляционная АМН 400х350</td><td class="r">12</td><td class="r">1 120,50</td><td class="r">13 446,00</td></tr>
      </table>`)
    assert.deepEqual(r.items.map((i) => [i.name, i.qty, i.price, i.sum, !!i.unsure]), [
      ['Клапан противопожарный Сигмавент-90-НО-400х300 SVF 220 к, нормально открытый, с электроприводом', 4, 18450, 73800, false],
      ['Решетка вентиляционная АМН 400х350', 12, 1120.5, 13446, false],
    ])
  })
})
