// Распознавание счёта / КП / УПД поставщика для расценки снабжением (src/utils/supplierDoc.js, supplierDocRead.js) и
// сопоставление его строк с позициями ВОР (src/utils/supplyDocMatch.js). Excel — книги, собранные здесь же
// библиотекой xlsx (в том числе .xls и .csv); PDF — напечатанные Chromium из HTML (как печатают 1С и Excel: таблица с
// рамками и без, перенос длинного наименования и числа в узкой колонке, выравнивание по низу, двухъярусная шапка УПД,
// таблица на двух страницах, скан без текста) и прочитанные pdf.js. Без Chromium — только Excel и правила.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { browserLaunchOptions } from '../tender/lib/stand.mjs'
import { classifyHeader, parseNum, unitPriceWithVat, vatFromText } from '../../src/utils/supplierDoc.js'
import { parseSupplierPdfPages, parseSupplierWorkbook, readPdfPages, readWorkbookBytes } from '../../src/utils/supplierDocRead.js'
import { codeTokens, deliveryFactor, expandName, matchDocItems, offerMatches, positionGroups, searchGroups } from '../../src/utils/supplyDocMatch.js'
import { OFFER_LINES_MAX, offerNotes, readOffer } from '../../src/utils/supplyOffers.js'
import { normName } from '../../src/utils/supplyRateHelpers.js'

const launch = browserLaunchOptions()
// Книга → байты файла → книга, как её читает окно распознавания (readWorkbookBytes: CSV — текстом).
const workbook = (sheets, opts = {}) => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa, merges] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    if (merges) ws['!merges'] = merges
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  const bookType = opts.bookType || 'xlsx'
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType }))
  return readWorkbookBytes(XLSX, bytes, `счёт.${bookType === 'biff8' ? 'xls' : bookType}`)
}
// Текст в Windows-1251 (так сохраняет CSV русский Excel): кириллица — 0xC0…0xFF, «ё» / «Ё» — 0xB8 / 0xA8.
const cp1251 = (text) => Uint8Array.from([...text].map((ch) => {
  const c = ch.codePointAt(0)
  if (c < 0x80) return c
  if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0
  return ch === 'ё' ? 0xb8 : ch === 'Ё' ? 0xa8 : 0x3f
}))
const brief = (items) => items.map((i) => [i.name, i.unit, i.qty, i.price, i.sum])

describe('документ поставщика: числа, шапка, НДС', () => {
  it('числа как в документах: пробелы-разряды, запятая, точка, «руб.», «%»; не число — null', () => {
    for (const [v, n] of [['18 450,00', 18450], ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['95,00 руб.', 95], ['22%', 22],
      ['1 234 567', 1234567], [' 7 100,50 ', 7100.5], ['−5', -5], [12.5, 12.5], ['0,5', 0.5], ['1.234.567', 1234567]]) {
      assert.equal(parseNum(v), n, String(v))
    }
    for (const v of ['', null, 'X', 'шт', '1а', '12-34', 'ГОСТ']) assert.equal(parseNum(v), null, String(v))
  })

  it('колонки по шапке: 1С, КП, УПД; «с НДС» / «без НДС»; код ед. изм. и акциз — не нужны', () => {
    const f = (t) => { const k = classifyHeader(t); return k && (k.vat ? `${k.field}:${k.vat}` : k.field) }
    assert.equal(f('Товары (работы, услуги)'), 'name')
    assert.equal(f('Наименование товара (описание выполненных работ, оказанных услуг), имущественного права'), 'name')
    assert.equal(f('Код товара/ работ, услуг'), 'code')
    assert.equal(f('Артикул'), 'code')
    assert.equal(f('Единица измерения код'), 'skip')
    assert.equal(f('Единица измерения условное обозначение (национальное)'), 'unit')
    assert.equal(f('Ед. изм.'), 'unit')
    assert.equal(f('Кол-во'), 'qty')
    assert.equal(f('Количество (объем)'), 'qty')
    assert.equal(f('Цена'), 'price')
    assert.equal(f('Цена с НДС, руб.'), 'price:gross')
    assert.equal(f('Цена без НДС, руб.'), 'price:net')
    assert.equal(f('Цена (тариф) за единицу измерения'), 'price')
    assert.equal(f('Стоимость товаров (работ, услуг), имущественных прав без налога - всего'), 'sum:net')
    assert.equal(f('Стоимость товаров (работ, услуг), имущественных прав с налогом - всего'), 'sum:gross')
    assert.equal(f('Сумма налога, предъявляемая покупателю'), 'vat')
    assert.equal(f('Налоговая ставка'), 'vatRate')
    assert.equal(f('В том числе сумма акциза'), 'skip')
    assert.equal(f('№ п/п'), 'num')
    assert.equal(f('Примечание'), 'skip')
  })

  it('НДС по тексту документа и цена за единицу с НДС для расценки', () => {
    assert.equal(vatFromText('Итого: 100. В том числе НДС (22%): 18,03').mode, 'gross')
    assert.deepEqual(vatFromText('Итого без НДС: 55 100,00. НДС 22%: 12 122,00'), { mode: 'net', rate: 22, cue: 'итого без ндс' })
    assert.equal(vatFromText('Без налога (НДС). Поставщик применяет УСН').mode, 'none')
    assert.equal(vatFromText('Цены указаны с НДС 20%').rate, 20)
    assert.equal(vatFromText('Итого 100').mode, null)
    const item = (o) => ({ price: null, priceVat: null, sum: null, sumVat: null, qty: null, vatRate: null, ...o })
    assert.equal(unitPriceWithVat(item({ price: 100, priceVat: 'gross' }), { mode: 'net', rate: 22 }), 100, 'колонка «с НДС» — как есть')
    assert.equal(unitPriceWithVat(item({ price: 95, sum: 57950, sumVat: 'gross', qty: 500 }), null), 115.9, 'сумма с НДС / количество (УПД)')
    assert.equal(unitPriceWithVat(item({ price: 100, priceVat: 'net' }), null), 122, 'колонка «без НДС» — плюс 22 %')
    assert.equal(unitPriceWithVat(item({ price: 100, priceVat: 'net' }), { mode: 'none' }), 100, '«НДС не облагается» — как есть')
    assert.equal(unitPriceWithVat(item({ price: 100 }), { mode: 'net', rate: 20 }), 120, 'документ: НДС сверху, 20 %')
    assert.equal(unitPriceWithVat(item({ price: 100 }), { mode: 'gross' }), 100)
    assert.equal(unitPriceWithVat(item({ price: 100 }), null), 100, 'не сказано — как есть')
    assert.equal(unitPriceWithVat(item({ price: 100, priceVat: 'net' }), { mode: 'gross', force: true }), 100, 'человек выбрал «с НДС»')
    assert.equal(unitPriceWithVat(item({ price: 100, vatRate: 10 }), { mode: 'net', rate: 22, force: true }), 122, 'выбранная ставка — главнее')
    assert.equal(unitPriceWithVat(item({ sum: 500, qty: 4 }), null), 125, 'цены нет — сумма / количество')
  })
})

describe('документ поставщика: Excel', () => {
  it('счёт 1С: реквизиты над таблицей, итоги и подписи — не позиции; лучший лист книги', () => {
    const wb = workbook([
      ['Реквизиты', [['ИНН 7701234567'], ['Банк: ПАО Сбербанк']]],
      ['Счёт', [
        ['ООО «ТеплоСнаб»'], ['Счет на оплату № 1532 от 14 октября 2026 г.'], [],
        ['№', 'Товары (работы, услуги)', 'Кол-во', 'Ед.', 'Цена', 'Сумма'],
        [1, 'Клапан Сигмавент-90-НО-400х300 SVF 220 к', 4, 'шт', 18450, 73800],
        [null, 'Раздел: Трубы', null, null, null, null],
        [2, 'Труба стальная ВГП оцинк. Ду20х2,8', '36,5', 'м', '312,40', '11 402,60'],
        [3, 'Доставка', 1, 'усл', 5000, 5000],
        [null, null, null, null, 'Итого:', 90202.6],
        [null, null, null, null, 'В том числе НДС:', 16266.13],
        ['Всего наименований 3, на сумму 90 202,60 руб.'],
        ['Руководитель', null, 'Бухгалтер'],
      ]],
    ])
    const r = parseSupplierWorkbook(XLSX, wb)
    assert.equal(r.kind, 'excel')
    assert.equal(r.sheetName, 'Счёт')
    assert.deepEqual(brief(r.items), [
      ['Клапан Сигмавент-90-НО-400х300 SVF 220 к', 'шт', 4, 18450, 73800],
      ['Труба стальная ВГП оцинк. Ду20х2,8', 'м', 36.5, 312.4, 11402.6],
      ['Доставка', 'усл', 1, 5000, 5000],
    ])
    assert.deepEqual(r.items.map((i) => i.delivery), [false, false, true])
    assert.equal(r.vat.mode, 'gross')
  })

  it('двухъярусная шапка: «Цена, руб.» над «без НДС» и «с НДС» (объединённая ячейка) — берётся с НДС', () => {
    const wb = workbook([['КП', [
      ['№', 'Наименование', 'Ед. изм.', 'Кол-во', 'Цена, руб.', null, 'Сумма, руб.', null],
      [null, null, null, null, 'без НДС', 'с НДС', 'без НДС', 'с НДС'],
      [1, 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 500, 95, 115.9, 47500, 57950],
      [2, 'Щит ЩРН-12', 'шт', 2, 10000, 12200, 20000, 24400],
    ], [{ s: { r: 0, c: 4 }, e: { r: 0, c: 5 } }, { s: { r: 0, c: 6 }, e: { r: 0, c: 7 } }]]])
    const r = parseSupplierWorkbook(XLSX, wb)
    assert.deepEqual(r.items.map((i) => [i.name, i.price, i.priceVat, i.sum, i.sumVat]), [
      ['Кабель ВВГнг(А)-LS 3х2,5', 115.9, 'gross', 57950, 'gross'],
      ['Щит ЩРН-12', 12200, 'gross', 24400, 'gross'],
    ])
    assert.equal(unitPriceWithVat(r.items[0], r.vat), 115.9)
  })

  it('.xls и .csv читаются так же; нет шапки — no_table; шапка без строк с ценой — empty', () => {
    const aoa = [['Наименование', 'Ед.', 'Количество', 'Цена с НДС'], ['Грунтовка глубокого проникновения', 'л', 40, '250,00']]
    for (const bookType of ['biff8', 'csv']) {
      const r = parseSupplierWorkbook(XLSX, workbook([['Лист1', aoa]], { bookType }))
      assert.deepEqual(brief(r.items), [['Грунтовка глубокого проникновения', 'л', 40, 250, null]], bookType)
    }
    // CSV из русского Excel: «;», десятичная запятая, Windows-1251.
    const csv = readWorkbookBytes(XLSX, cp1251('Наименование;Ед. изм.;Кол-во;Цена без НДС\r\nЭмаль ПФ-115 серая;кг;20;312,40\r\n'), 'прайс.csv')
    const r = parseSupplierWorkbook(XLSX, csv)
    assert.deepEqual([...brief(r.items)[0], r.items[0].priceVat], ['Эмаль ПФ-115 серая', 'кг', 20, 312.4, null, 'net'])
    assert.equal(parseSupplierWorkbook(XLSX, workbook([['Лист1', [['просто текст'], ['и ещё']]]])).error, 'no_table')
    assert.equal(parseSupplierWorkbook(XLSX, workbook([['Лист1', [['Наименование', 'Цена'], ['Итого', '']]]])).error, 'empty')
  })
})

describe('документ поставщика: PDF (Chromium печатает, pdf.js читает)', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let browser
  let page
  let pdfjs
  before(async () => {
    browser = await chromium.launch({ ...launch, headless: true })
    page = await browser.newPage()
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  })
  after(async () => { await browser?.close() })

  const STYLE = 'body{font:10pt Arial,sans-serif}table{border-collapse:collapse;width:100%}td,th{padding:2px 4px;vertical-align:top}'
    + '.b td,.b th{border:1px solid #000}.r{text-align:right}'
  async function read(body, { css = '', landscape = false } = {}) {
    await page.setContent(`<html><head><meta charset="utf-8"><style>${STYLE}${css}</style></head><body>${body}</body></html>`)
    const pdf = await page.pdf({ format: 'A4', landscape, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } })
    return parseSupplierPdfPages(await readPdfPages(pdfjs, new Uint8Array(pdf)))
  }

  it('счёт 1С: перенос наименования и числа в узкой колонке, «4 шт» одним куском, доставка, «в том числе НДС»', async () => {
    const r = await read(`<h3>Счет на оплату № 1532 от 14 октября 2026 г.</h3><p>Поставщик: ООО "ТеплоСнаб", ИНН 7701234567</p>
      <table class="b"><tr><th>№</th><th>Товары (работы, услуги)</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr>
      <tr><td>1</td><td>Клапан противопожарный Сигмавент-90-НО-400х300 SVF 220 к, нормально открытый, с электроприводом</td><td class="r">4</td><td>шт</td><td class="r">18 450,00</td><td class="r">73 800,00</td></tr>
      <tr><td>2</td><td>Решетка вентиляционная АМН 400х350</td><td class="r">12</td><td>шт</td><td class="r">1 120,50</td><td class="r">13 446,00</td></tr>
      <tr><td>3</td><td>Труба стальная ВГП оцинк. Ду20х2,8 ГОСТ 3262-75</td><td class="r">36,5</td><td>м</td><td class="r">312,40</td><td class="r">11 402,60</td></tr>
      <tr><td>4</td><td>Доставка</td><td class="r">1</td><td>усл</td><td class="r">5 000,00</td><td class="r">5 000,00</td></tr></table>
      <p class="r">Итого: 103 648,60<br>В том числе НДС (22%): 18 690,90<br>Всего к оплате: 103 648,60</p>
      <p>Всего наименований 4, на сумму 103 648,60 руб.<br>Сто три тысячи шестьсот сорок восемь рублей 60 копеек</p>`)
    assert.equal(r.kind, 'pdf')
    assert.deepEqual(brief(r.items), [
      ['Клапан противопожарный Сигмавент-90-НО-400х300 SVF 220 к, нормально открытый, с электроприводом', 'шт', 4, 18450, 73800],
      ['Решетка вентиляционная АМН 400х350', 'шт', 12, 1120.5, 13446],
      ['Труба стальная ВГП оцинк. Ду20х2,8 ГОСТ 3262-75', 'м', 36.5, 312.4, 11402.6],
      ['Доставка', 'усл', 1, 5000, 5000],
    ])
    assert.deepEqual([r.vat.mode, r.vat.rate], ['gross', 22])
  })

  it('КП без рамок, длинное наименование по низу строки, «Цена без НДС» — НДС сверху', async () => {
    const r = await read(`<h3>Коммерческое предложение</h3>
      <table><tr><th>№ п/п</th><th>Артикул</th><th>Наименование</th><th>Ед. изм.</th><th>Кол-во</th><th>Цена без НДС, руб.</th><th>Сумма без НДС, руб.</th></tr>
      <tr><td>1</td><td>R206CY104</td><td style="width:12em">Клапан балансировочный ручной с измерительными ниппелями DN20</td><td>шт.</td><td class="r">10</td><td class="r">2 500,00</td><td class="r">25 000,00</td></tr>
      <tr><td>2</td><td>FMK42</td><td>Конвектор внутрипольный Aquilo FMK 42 150 11</td><td>шт.</td><td class="r">3</td><td class="r">41 000</td><td class="r">123 000</td></tr>
      </table><p>Итого без НДС: 148 000,00. НДС 22%: 32 560,00. Всего с НДС: 180 560,00</p>`, { css: 'td{vertical-align:bottom}' })
    assert.deepEqual(r.items.map((i) => [i.code, i.name, i.qty, i.price, i.priceVat]), [
      ['R206CY104', 'Клапан балансировочный ручной с измерительными ниппелями DN20', 10, 2500, 'net'],
      ['FMK42', 'Конвектор внутрипольный Aquilo FMK 42 150 11', 3, 41000, 'net'],
    ])
    assert.equal(r.vat.mode, 'net')
    assert.equal(Math.round(unitPriceWithVat(r.items[0], r.vat) * 100) / 100, 3050)
  })

  it('УПД: двухъярусная шапка, строка номеров колонок, цена без НДС и стоимость с налогом — цена с НДС из стоимости', async () => {
    const r = await read(`<h4>Универсальный передаточный документ</h4><table class="b" style="font-size:7pt">
      <tr><th rowspan="2">Код товара/ работ, услуг</th><th rowspan="2">№ п/п</th><th rowspan="2">Наименование товара (описание выполненных работ, оказанных услуг), имущественного права</th><th colspan="2">Единица измерения</th><th rowspan="2">Количество (объем)</th><th rowspan="2">Цена (тариф) за единицу измерения</th><th rowspan="2">Стоимость товаров (работ, услуг), имущественных прав без налога - всего</th><th rowspan="2">Налоговая ставка</th><th rowspan="2">Сумма налога, предъявляемая покупателю</th><th rowspan="2">Стоимость товаров (работ, услуг), имущественных прав с налогом - всего</th></tr>
      <tr><th>код</th><th>условное обозначение (национальное)</th></tr>
      <tr><td>А</td><td>1</td><td>1а</td><td>2</td><td>2а</td><td>3</td><td>4</td><td>5</td><td>7</td><td>8</td><td>9</td></tr>
      <tr><td></td><td>1</td><td>Кабель силовой ВВГнг(А)-LS 3х2,5 ок(N)-0,66</td><td>006</td><td>м</td><td class="r">500</td><td class="r">95,00</td><td class="r">47 500,00</td><td>22%</td><td class="r">10 450,00</td><td class="r">57 950,00</td></tr>
      <tr><td></td><td>2</td><td>Щит распределительный ЩР-КНД</td><td>796</td><td>шт</td><td class="r">2</td><td class="r">10 000,00</td><td class="r">20 000,00</td><td>22%</td><td class="r">4 400,00</td><td class="r">24 400,00</td></tr>
      <tr><td></td><td></td><td>Всего к оплате</td><td></td><td></td><td></td><td></td><td class="r">67 500,00</td><td>X</td><td class="r">14 850,00</td><td class="r">82 350,00</td></tr>
      </table>`, { landscape: true })
    assert.deepEqual(r.items.map((i) => [i.name, i.unit, i.qty, i.price, i.sum, i.sumVat, i.vatRate]), [
      ['Кабель силовой ВВГнг(А)-LS 3х2,5 ок(N)-0,66', 'м', 500, 95, 57950, 'gross', 22],
      ['Щит распределительный ЩР-КНД', 'шт', 2, 10000, 24400, 'gross', 22],
    ])
    assert.equal(unitPriceWithVat(r.items[0], r.vat), 115.9)
  })

  it('таблица на двух страницах: шапка повторена — пропускается; итог — конец таблицы', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>${i + 1}</td><td>Хомут монтажный М${8 + (i % 5)} исп. ${i + 1}</td><td>шт</td><td class="r">${10 + i}</td><td class="r">${(35 + i).toFixed(2).replace('.', ',')}</td></tr>`)
    const r = await read(`<table class="b"><thead><tr><th>№</th><th>Наименование</th><th>Ед.</th><th>Кол-во</th><th>Цена с НДС</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table><p>Итого: 1 000,00</p>`)
    assert.equal(r.items.length, 60)
    assert.deepEqual([r.items[0].name, r.items[59].name, r.items[59].price], ['Хомут монтажный М8 исп. 1', 'Хомут монтажный М12 исп. 60', 94])
    assert.ok(!r.items.some((i) => /Наименование|Итого/.test(i.name)))
  })

  it('скан без текста — scan; нет таблицы с ценами — no_table', async () => {
    assert.equal((await read('<svg width="500" height="300"><rect width="500" height="300" fill="#bbb"/></svg>')).error, 'scan')
    assert.equal((await read('<h3>Письмо поставщика</h3><p>Направляем вам каталог продукции на 2026 год. Цены по запросу.</p>')).error, 'no_table')
  })
})

describe('сопоставление строк документа с позициями ВОР', () => {
  const docViews = [
    { name: 'ВК', positions: [
      { name: 'труба медная ∅12.7', unit: 'м', volume: 200 },
      { name: 'Кран шаровой Ду15', unit: 'компл', volume: 5 },
    ] },
    { name: 'ОВ', positions: [
      { name: 'Труба медная Ø12,7', unit: 'м', volume: 1500 },
      { name: 'Кран шаровой Ду15', unit: 'шт', volume: 48 },
      { name: 'Клапан Сигмавент-90-НО-400x300-SVF(220)-к', unit: 'шт', volume: 4 },
      { name: 'Клапан Сигмавент-90-НО-450x350-SVF(220)-к', unit: 'шт', volume: 2 },
    ] },
  ].map((d) => ({ ...d, positions: d.positions.map((p) => ({ ...p, k: normName(p.name) })) }))
  const groups = positionGroups(docViews)
  const item = (name, unit = 'шт', o = {}) => ({ name, unit, code: null, qty: 1, price: 100, priceVat: null, sum: null, sumVat: null, vatRate: null, delivery: false, ...o })

  it('одинаковые позиции разных ВОР (наименование и ед. изм.) — одна группа; другая ед. изм. — своя', () => {
    const truba = groups.find((g) => g.k === normName('Труба медная Ø12,7'))
    assert.deepEqual(truba.targets.map((t) => t.doc), ['ВК', 'ОВ'])
    assert.equal(groups.filter((g) => g.k === normName('Кран шаровой Ду15')).length, 2)
  })

  it('точно — по наименованию (с той же ед. изм.), иначе похожая; другой размер — не сопоставляется; одна позиция — одной строке', () => {
    const res = matchDocItems([
      item('КРАН ШАРОВОЙ ДУ 15'),
      item('Клапан противопожарный Сигмавент-90-НО-300 х 400 SVF 220 к'),
      item('Клапан Сигмавент-90-НО-500x500-SVF(220)-к'),
      item('Трубы медные 12,7 мм', 'м.п.'),
      item('Труба медная Ø12,7 (вторая строка)', 'м'),
    ], groups)
    const m = res.map((r) => r.match && [r.match.group.name, r.match.group.unit, r.match.exact])
    assert.deepEqual(m[0], ['Кран шаровой Ду15', 'шт', true])
    assert.deepEqual(m[1], ['Клапан Сигмавент-90-НО-400x300-SVF(220)-к', 'шт', false])
    assert.equal(m[2], null, 'размер 500x500 есть только в документе')
    assert.equal(res[3].match.group.targets.length, 2, 'труба — сразу в двух ВОР; м.п. = м')
    assert.equal(res[4].match, null, 'труба уже у строки, где совпадение лучше')
    assert.ok(res[4].candidates.length > 0, 'но в списке выбора она есть')
  })

  it('поиск позиции вручную и доставка пропорционально сумме', () => {
    assert.equal(searchGroups('сигмавент 450', groups)[0].name, 'Клапан Сигмавент-90-НО-450x350-SVF(220)-к')
    const d = deliveryFactor([item('Труба', 'м', { qty: 10, price: 100 }), item('Доставка', 'усл', { qty: 1, price: 50, delivery: true })], (i) => i.price)
    assert.deepEqual([d.delivery, d.goods, d.factor], [50, 1000, 1.05])
    assert.equal(deliveryFactor([item('Труба')], (i) => i.price).factor, 1)
  })
})

// Позиции ВОР тендера 914 «ЗИЛ 33, АСУД.И» (снимок 29.10.2026, часть) и строки счетов так, как их пишут дистрибьюторы
// (ЭТМ, DKC, IEK, WAGO): другой порядок слов, сокращения, артикул вместо названия, слитное написание.
describe('сопоставление: похожесть текста, артикулы, сокращения (тендер 914)', () => {
  const names = [
    ['Труба гофрированная ПВХ с протяжкой D=20мм, арт.91920, DKC', 'м'],
    ['Труба гофрированная ПВХ легкая, D=32мм, арт.91932, DKC', 'м'],
    ['Держатель пластиковый с защёлкой d20мм, 51020R, DKC', 'шт'],
    ['Металлорукав оцинкованный РЗ-ЦХ-10, Ду=10 мм, IEK', 'м'],
    ['Металлорукав оцинкованный РЗ-ЦХ-12, Ду=12 мм, IEK', 'м'],
    ['Кабель МКШВнг(А)-HF 2х2х0,75; СегментЭнерго', 'м'],
    ['Кабель МКШВнг(А)-HF 4х2х0,75; СегментЭнерго', 'м'],
    ['Клемма строительно-монтажная трехпроводная, арт.221-413, WAGO', 'шт'],
    ['Клемма строительно-монтажная двухпроводная, арт.221-412, WAGO', 'шт'],
    ['Скоба металлическая двухлапковая d=12-13 мм, арт.CMAT11-12-010', 'шт'],
    ['Труба стальная водогазопроводная 25х2,8', 'м'],
    ['Шкаф управления SK-712/d-2-1.5, Wilo', 'шт'],
    ['Шкаф управления SK-712/d-1-1.5, Wilo', 'шт'],
    ['Переговорное голосовое устройство ПГУ-RS, RS485, Текон-Автоматика', 'шт'],
    ['Плата для подключения RS485 к щитам управления SK-712, арт.2785193, Wilo', 'шт'],
  ]
  const groups = positionGroups([{ name: 'ПЧ', positions: names.map(([name, unit]) => ({ name, unit, volume: 1, k: normName(name) })) }])
  const item = (name, unit) => ({ name, unit, code: null, qty: 1, price: 100, priceVat: null, sum: null, sumVat: null, vatRate: null, delivery: false })
  const matchOf = (name, unit) => matchDocItems([item(name, unit)], groups)[0]

  it('артикул, который в тендере только у одной позиции, — почти наверняка она; общий у нескольких («RS485») — нет', () => {
    assert.deepEqual([...codeTokens('Клемма WAGO 221-413 3-проводная с рычагами 0,2-4мм2')], ['221413'])
    assert.deepEqual([...codeTokens('Кабель МКШВнг(А)-HF 2х2х0,75 ГОСТ 10348-80 d20мм')], [], 'размеры и ГОСТ — не артикулы')
    const m = matchOf('Клемма WAGO 221-413 3-проводная с рычагами', 'шт')
    assert.match(m.match.group.name, /трехпроводная/)
    assert.equal(m.match.code, true)
    assert.match(matchOf('WILO Модуль RS-485 для SK-712 арт. 2785193', 'шт').match.group.name, /^Плата для подключения RS485/)
    assert.match(matchOf('Прибор управления насосом SK-712/D-2-1,5 WILO', 'шт').match.group.name, /d-2-1\.5/)
  })

  it('сокращения и другая запись: ВГП, «2-лапковая», гофротруба с зондом, другой порядок слов', () => {
    assert.match(expandName('Скоба 2-лапковая, 5 штук'), /Скоба двухлапковая, 5 штук/)
    assert.match(matchOf('Труба ВГП 25х2,8 ГОСТ 3262-75', 'м').match.group.name, /водогазопроводная 25х2,8/)
    assert.match(matchOf('Скоба 2-лапковая d12-13 мм IEK', 'шт').match.group.name, /d=12-13/)
    assert.match(matchOf('Гофротруба ПВХ 20мм с зондом DKC (100м)', 'м').match.group.name, /D=20мм/)
    assert.match(matchOf('МКШвнг(А)-HF 4х2х0,75 кабель монтажный', 'м').match.group.name, /4х2х0,75/)
  })

  it('другой размер, сечение, диаметр — в списке выбора, но не сопоставляется сам', () => {
    for (const [name, unit] of [['Кабель МКШВнг(А)-HF 3х2х0,75', 'м'], ['Труба гофрированная ПВХ d25 мм с протяжкой DKC 91925', 'м'],
      ['Металлорукав РЗ-ЦХ-16 IEK', 'м']]) {
      const m = matchOf(name, unit)
      assert.equal(m.match, null, name)
      assert.ok(m.candidates.length > 0 && m.candidates.every((c) => c.score <= 0.5), name)
    }
  })

  it('цены документа как похожие цены: выбранная в окне позиция; «не сопоставлять» — никуда; без выбора — самые похожие', () => {
    const pipe20 = groups.find((g) => /D=20мм/.test(g.name))
    const res = offerMatches([
      { name: 'Что-то своё', unit: 'м', k: pipe20.k },
      { name: 'Клемма WAGO 221-412 2-проводная', unit: 'шт', skip: true },
      { name: 'Кабель МКШвнг(А)-HF 2х2х0,75', unit: 'м' },
      { name: 'Болт М12х80', unit: 'шт' },
    ], groups)
    assert.deepEqual(res.get(pipe20.key).map((o) => [o.line.name, o.picked]), [['Что-то своё', true]])
    const cable = groups.find((g) => /2х2х0,75/.test(g.name))
    assert.deepEqual(res.get(cable.key).map((o) => o.line.name), ['Кабель МКШвнг(А)-HF 2х2х0,75'])
    assert.equal(res.has(groups.find((g) => /4х2х0,75/.test(g.name)).key), false, 'другое сечение — не туда')
    assert.equal([...res.values()].flat().some((o) => /Болт|Клемма/.test(o.line.name)), false)
  })
})

describe('цены документа «в похожие цены»: строки в notes файла', () => {
  it('строки без цены и доставка не хранятся; выбор окна — k, «не сопоставлять» — x; чтение обратно', () => {
    const notes = offerNotes({ source: 'pdf', vat: { mode: 'net', rate: 22, cue: 'без НДС' }, delivery: 1.0123456, lines: [
      { name: '  Кран  шаровой Ду15 ', unit: 'шт', qty: 48, code: 'КШ-15', price: 1220.004, docPrice: 1000, docVat: 'net', k: 'kpah' },
      { name: 'Болт', unit: 'шт', price: null },
      { name: 'Хомут', unit: 'шт', price: 43.31, skip: true },
    ] })
    const o = readOffer(notes)
    assert.equal(o.source, 'pdf')
    assert.deepEqual(o.vat, { mode: 'net', rate: 22 })
    assert.equal(o.delivery, 1.0123)
    assert.deepEqual(o.lines, [
      { name: 'Кран шаровой Ду15', price: 1220, unit: 'шт', qty: 48, code: 'КШ-15', docPrice: 1000, docVat: 'net', k: 'kpah', skip: false },
      { name: 'Хомут', price: 43.31, unit: 'шт', qty: null, code: null, docPrice: null, docVat: null, k: null, skip: true },
    ])
  })

  it('не наш JSON, испорченный, другая версия — null; строк не больше OFFER_LINES_MAX', () => {
    assert.equal(readOffer(null), null)
    assert.equal(readOffer('{"passport":1}'), null)
    assert.equal(readOffer('{"kind":"supply_offer","v":1,'), null)
    assert.equal(readOffer(JSON.stringify({ kind: 'supply_offer', v: 2, lines: [] })), null)
    const many = Array.from({ length: OFFER_LINES_MAX + 10 }, (_, i) => ({ name: `Позиция ${i}`, price: 1 }))
    assert.equal(readOffer(offerNotes({ lines: many })).lines.length, OFFER_LINES_MAX)
  })
})
