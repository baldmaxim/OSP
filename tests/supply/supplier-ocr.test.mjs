// Скан счёта: чистая часть распознавания (src/utils/supplierOcrPage.js) и разбор её результата тем же кодом, что у PDF с текстом. Сам
// распознаватель работает только в браузере: настоящее чтение скана — в tests/tender/supply-pricing.test.mjs (стенд) и
// tests/release/ocr-build.test.mjs (боевая сборка и политика содержимого).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanNumber, darkShare, eraseRulings, estimateSkew, findRulings, lanczosResize, looksSideways, numberBox, numberish, ocrChecked, ocrItems, ocrName,
  ocrUnit, otsuThreshold, pageImageInfo, reconcileWithTotal, repairBySum, rulingsToPage,
} from '../../src/utils/supplierOcrPage.js'
import { classifyHeader } from '../../src/utils/supplierDoc.js'
import { parseSupplierPdfPages } from '../../src/utils/supplierDocRead.js'
import { offerNotesOfDoc } from '../../src/utils/supplyDocPrice.js'
import { carryOfferMarks, offerNeedsRefresh, readOffer, READER_VERSION } from '../../src/utils/supplyOffers.js'

// Картинка в серых тонах: фон 250 и нарисованные тёмные прямоугольники.
function canvas(w, h) {
  const gray = new Uint8Array(w * h).fill(250)
  const box = (x0, y0, x1, y1, v = 20) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) gray[y * w + x] = v
  }
  return { w, h, gray, box }
}
// Строки текста: короткие штрихи с просветами. Наклон — сдвиг строк вниз по ходу вправо.
function textLines(c, { lines = 40, slope = 0, from = 100 } = {}) {
  for (let l = 0; l < lines; l++) {
    const base = from + l * 60
    for (let x = 100; x < c.w - 100; x += 26) {
      const y = base + Math.round(x * slope)
      if (y + 24 < c.h) c.box(x, y, x + 15, y + 24)
    }
  }
}

describe('скан: наклон, поворот, пустая страница', () => {
  it('порог по гистограмме делит чёрное и белое; пустая страница видна по доле тёмного', () => {
    const c = canvas(600, 800)
    textLines(c, { lines: 8 })
    const t = otsuThreshold(c.gray)
    assert.ok(t >= 20 && t < 250)
    assert.ok(darkShare(c.gray, t) > 0.05)
    const blank = canvas(600, 800)
    blank.box(10, 10, 12, 12)
    assert.ok(darkShare(blank.gray, 128) < 0.002, 'точка шума — пустая страница')
  })

  it('наклон находится по строкам текста; ровная страница — ноль, а не дрожание', () => {
    const level = canvas(1400, 2000)
    textLines(level, { lines: 30 })
    assert.equal(estimateSkew(level.gray, level.w, level.h, 128), 0)
    const tilted = canvas(1400, 2000)
    textLines(tilted, { lines: 30, slope: Math.tan((1 * Math.PI) / 180) })
    assert.ok(Math.abs(estimateSkew(tilted.gray, tilted.w, tilted.h, 128) - 1) <= 0.2, 'наклон 1° вниз вправо')
    const up = canvas(1400, 2000)
    textLines(up, { lines: 30, slope: -Math.tan((1 * Math.PI) / 180), from: 200 })
    assert.ok(Math.abs(estimateSkew(up.gray, up.w, up.h, 128) + 1) <= 0.2, 'наклон 1° вверх вправо')
  })

  it('лист на боку: строки стоят вертикально', () => {
    const page = canvas(1000, 1400)
    textLines(page, { lines: 20 })
    assert.equal(looksSideways(page.gray, page.w, page.h, 128), false)
    const side = canvas(1400, 1000)
    for (let y = 0; y < 1000; y++) for (let x = 0; x < 1400; x++) side.gray[y * 1400 + x] = page.gray[(999 - y) + x * 1000]
    assert.equal(looksSideways(side.gray, side.w, side.h, 128), true)
  })
})

describe('скан: линии рамки', () => {
  // Таблица 3 × 2 с линиями толщиной 3, цифра «задевает» нижнюю линию, штрих буквы пересекает верхнюю.
  const table = () => {
    const c = canvas(1200, 800)
    for (const y of [100, 200, 300]) c.box(100, y, 1100, y + 2)
    for (const x of [100, 500, 800, 1100]) c.box(x, 100, x + 2, 302)
    c.box(600, 170, 610, 215) // штрих через линию y=200
    c.box(300, 130, 330, 150) // «буква» внутри ячейки
    return c
  }

  it('линии находятся с координатами, буквы линиями не считаются', () => {
    const { gray, w, h } = table()
    const r = findRulings(gray, w, h, 128)
    assert.deepEqual(r.h.map((l) => l.y), [101, 201, 301])
    assert.deepEqual(r.v.map((l) => l.x), [101, 501, 801, 1101])
    assert.ok(r.h.every((l) => l.x0 <= 102 && l.x1 >= 1098))
    assert.ok(r.v.every((l) => l.y0 <= 102 && l.y1 >= 300))
    const page = rulingsToPage(r, 2)
    assert.equal(page.h[0].y, 50.5)
    assert.equal(page.v[1].x, 250.5)
  })

  it('заливка и логотип — не линии: слишком толстые', () => {
    const c = canvas(1200, 800)
    c.box(100, 100, 1100, 180)
    const r = findRulings(c.gray, c.w, c.h, 128)
    assert.deepEqual(r.h, [])
  })

  it('стирание убирает линии, штрих буквы и букву не задевает', () => {
    const { gray, w, h } = table()
    const r = findRulings(gray, w, h, 128)
    eraseRulings(gray, w, h, 128, r)
    const at = (x, y) => gray[y * w + x]
    assert.ok(at(300, 101) > 128, 'горизонтальная стёрта')
    assert.ok(at(501, 250) > 128, 'вертикальная стёрта')
    assert.ok(at(605, 201) < 128, 'штрих поверх линии остался')
    assert.ok(at(315, 140) < 128, 'буква осталась')
    assert.deepEqual(findRulings(gray, w, h, 128).h, [], 'линий больше нет')
  })

  it('крючок буквы у самой рамки цел: край линии стираем, только если за ним светло', () => {
    const c = canvas(1200, 800)
    c.box(100, 100, 102, 700)
    c.box(90, 300, 99, 303) // крючок слева от вертикальной линии, вплотную к ней
    const r = findRulings(c.gray, c.w, c.h, 128)
    eraseRulings(c.gray, c.w, c.h, 128, r)
    assert.ok(c.gray[300 * c.w + 99] < 128, 'край крючка остался')
    assert.ok(c.gray[500 * c.w + 101] > 128, 'сама линия стёрта')
  })
})

// Ответ распознавателя: строка — { words: [[текст, x0, x1, уверенность]] }, как blocks у tesseract.js.
const line = (y, words, { height = 30, baseline = y + 26 } = {}) => ({
  bbox: { x0: words[0][1], y0: y, x1: words[words.length - 1][2], y1: y + height },
  baseline: { x0: words[0][1], y0: baseline, x1: words[words.length - 1][2], y1: baseline },
  rowAttributes: { rowHeight: height, descenders: 6, ascenders: 6 },
  words: words.map(([text, x0, x1, confidence = 90]) => ({ text, confidence, bbox: { x0, y0: y + 2, x1, y1: y + height - 2 } })),
})
const blocks = (...lines) => [{ paragraphs: [{ lines }] }]

describe('скан: слова распознавателя → куски текста для разбора', () => {
  const SCALE = 4
  const items = (b, rules = null) => ocrItems(b, { pageHeight: 800, scale: SCALE, rules }).items

  it('рамка, прилипшая к слову, срезается; шум убирается; слово с рамкой посередине делится', () => {
    const got = items(blocks(line(100, [
      ['|', 40, 44], ['5|лист', 50, 170], ['г/к', 180, 230], ['°', 400, 410, 58], ['©', 420, 430, 22], ['Ш', 440, 460, 20], ['т', 470, 490, 95], ['|теор.т', 500, 620], ['НДС]', 640, 720],
    ])))
    assert.deepEqual(got.map((i) => i.str), ['5', 'лист', 'г/к', 'т', 'теор.т', 'НДС'])
    assert.ok(got[0].transform[4] * SCALE < 75, 'номер слева')
    assert.ok(got[1].transform[4] * SCALE >= 65, 'наименование правее рамки')
  })

  it('число с пробелом-разрядом — один кусок, через линию рамки — нет', () => {
    const noRule = items(blocks(line(100, [['2', 100, 118], ['496,49', 130, 240], ['14', 400, 430], ['60', 600, 640], ['890', 650, 710]])))
    assert.deepEqual(noRule.map((i) => i.str), ['2 496,49', '14', '60 890'])
    const ruled = items(blocks(line(100, [['48', 100, 140], ['500,00', 155, 260]])), { v: [{ x: 148, y0: 0, y1: 2000 }] })
    assert.deepEqual(ruled.map((i) => i.str), ['48', '500,00'], 'соседние ячейки')
  })

  it('буква вместо цифры в числе исправляется, в наименовании — нет', () => {
    const got = items(blocks(line(100, [['6О', 100, 140], ['89О', 150, 220], ['З1', 400, 440], ['О2', 500, 540], ['Ст3пс', 600, 700]])))
    assert.deepEqual(got.map((i) => i.str), ['6О', '890', 'З1', 'О2', 'Ст3пс'], 'цифр меньше двух — не трогаем')
  })

  it('координаты — в точках страницы, базовая линия одна на строку', () => {
    const [a, b] = items(blocks(line(400, [['Цена', 400, 480], ['Сумма', 800, 900]], { baseline: 430 })))
    assert.equal(a.transform[4], 100)
    assert.equal(a.transform[5], 800 - 430 / SCALE)
    assert.equal(a.transform[5], b.transform[5])
    assert.equal(a.width, 20)
  })
})

describe('скан: разбор строк и проверка цифр', () => {
  // Так распознаватель читает счёт металлобазы (тендер № 902, копия по виду): шапка с «Eg.» вместо «Ед.», наименование на две строки,
  // рамка отдельно.
  const SCALE = 4.1667
  const rules = (rows) => ({
    h: rows.map((y) => ({ y, x0: 60, x1: 2400, t0: y - 1, t1: y + 1 })),
    v: [60, 150, 1040, 1200, 1460, 1640, 1830, 2130, 2400].map((x) => ({ x, y0: rows[0], y1: rows[rows.length - 1], t0: x - 1, t1: x + 1 })),
  })
  const page = (lines, rows) => {
    const r = rules(rows)
    const height = 3508 / SCALE
    return { ...ocrItems(blocks(...lines), { pageHeight: height, scale: SCALE, rules: r }), height, rulings: rulingsToPage(r, SCALE) }
  }
  const scan = (data = {}) => {
    const { rows = [1063, 1130, 1222, 1315], price2 = '890', sum1 = '583,14', qty1 = '0,026' } = data
    return [page([
      line(900, [['Счет', 300, 380], ['№', 390, 420], ['123456', 430, 560], ['от', 570, 610], ['2', 620, 640], ['Ноября', 650, 790], ['2026', 800, 880], ['г.', 890, 920]]),
      line(1077, [['№', 90, 120], ['Товар', 500, 620], ['Склад', 1070, 1180], ['Цена', 1230, 1310], ['с', 1320, 1340], ['НДС', 1350, 1430], ['Кол-во', 1490, 1610], ['Eg.', 1700, 1770], ['Сумма,', 1860, 1990], ['руб', 2000, 2070], ['Прим.', 2200, 2310]], { baseline: 1103 }),
      line(1135, [['1', 110, 125], ['трубы', 160, 270], ['электросварные', 280, 600], ['квадрат', 610, 750], ['20х2', 760, 850], ['14', 1100, 1130], ['60', 1330, 1370], [price2, 1380, 1440], [qty1, 1540, 1630], ['теор.т', 1660, 1810], ['1', 1880, 1900], [sum1, 1915, 2110], ['4шт', 2140, 2200]], { baseline: 1165 }),
      line(1185, [['ГОСТ', 160, 240], ['дл.6000', 250, 380], ['ГОСТ13663-86', 390, 650]], { baseline: 1215 }),
      line(1229, [['2', 110, 125], ['лист', 160, 240], ['г/к', 250, 300], ['10x1500x3000', 310, 600], ['18', 1100, 1130], ['63', 1330, 1370], ['790', 1380, 1440], ['0,36', 1560, 1630], ['reop.T', 1660, 1810], ['22', 1860, 1900], ['964,40', 1915, 2110]], { baseline: 1259 }),
      line(1400, [['Итого:', 1320, 1440], ['24', 1800, 1850], ['547,54', 1860, 2000], ['руб.', 2010, 2080]], { baseline: 1430 }),
      line(1460, [['В', 1000, 1020], ['том', 1030, 1100], ['числе', 1110, 1210], ['НДС:', 1220, 1310], ['4', 1800, 1830], ['426,77', 1860, 2000]], { baseline: 1490 }),
    ], rows)]
  }
  const read = (data) => {
    const r = parseSupplierPdfPages(scan(data))
    return { ...r, items: ocrChecked(r.items) }
  }

  it('счёт со скана: строки, цены, единицы (и нечитаемая шапка, и латиница), итог, дата', () => {
    const r = read()
    assert.equal(r.kind, 'pdf')
    assert.deepEqual(r.items.map((i) => [i.name, i.unit, i.qty, i.price, i.sum, i.sumOff, i.unsure]), [
      ['трубы электросварные квадрат 20х2 ГОСТ дл.6000 ГОСТ13663-86', 'теор.т', 0.026, 60890, 1583.14, false, false],
      ['лист г/к 10x1500x3000', 'теор.т', 0.36, 63790, 22964.4, false, false],
    ])
    assert.equal(r.date, '2026-11-02')
    assert.equal(r.vat.mode, 'gross')
    assert.deepEqual(r.total, { ok: true, read: 24547.54, doc: 24547.54 })
  })

  it('одна неверная цифра исправляется по сумме строки; две — строка помечена, итог не сошёлся', () => {
    // 27.11.2026: «60 390» при количестве 0,026 и сумме 1 583,14 — единственная правка одной цифры, при которой сходится до копеек.
    const fixed = read({ price2: '390' }).items[0]
    assert.equal(fixed.price, 60890)
    assert.equal(fixed.sumOff, false)
    assert.equal(fixed.unsure, false)
    assert.equal(fixed.ocrFixed, true)
    const r = read({ sum1: '983,14' })
    assert.equal(r.items[0].sumOff, true, 'сумма с двумя ошибками одной правкой не исправляется')
    assert.equal(r.items[0].unsure, true)
    assert.equal(r.total.ok, false)
  })

  it('нечем сверить (нет суммы или количества) — строка не внушает доверия', () => {
    const [it] = ocrChecked([{ name: 'Труба', price: 100, qty: null, sum: null, unit: 'м' }])
    assert.equal(it.unsure, true)
    assert.equal(it.sumOff, undefined, 'тут не «не сошлось», а «нечем сверить»')
    assert.equal(ocrChecked([{ name: 'Труба', price: 100, qty: 2, sum: 244, unit: 'м' }])[0].unsure, false, 'цена без НДС, сумма с НДС 22 %')
    assert.equal(ocrChecked([{ name: 'Труба', price: 122, qty: 2, sum: 200, unit: 'м' }])[0].unsure, false, 'цена с НДС, сумма без НДС')
  })

  it('единицы со скана — к понятному виду', () => {
    assert.equal(ocrUnit('reop.T'), 'теор.т')
    assert.equal(ocrUnit('геор.т'), 'теор.т')
    assert.equal(ocrUnit('wT'), 'шт')
    assert.equal(ocrUnit('°т'), 'т')
    assert.equal(ocrUnit(''), null)
    assert.equal(ocrUnit(null), null)
  })

  it('при файле: отметка скана и строки без сверки переживают запись', () => {
    const r = { kind: 'pdf', ocr: true, vat: { mode: 'gross', rate: null }, date: '2026-11-02', total: null, currency: null, items: [
      { name: 'Труба 20х2', unit: 'теор.т', qty: 1, price: 100, sum: 100, priceVat: 'gross', unsure: false },
      { name: 'Лист', unit: 'т', price: 200, priceVat: 'gross', unsure: true },
    ] }
    const offer = readOffer(offerNotesOfDoc(r).notes)
    assert.equal(offer.ocr, true)
    assert.equal(offer.rv, READER_VERSION)
    assert.equal(offer.lines[0].unsure, undefined)
    assert.equal(offer.lines[1].unsure, true)
  })
})

// 27.11.2026, тендер № 1157: КП «Металлсервиса» — страница-картинка 90 dpi. Числа и наименования — как их читал распознаватель.
describe('скан мелкой картинкой: цифры, итог, наименования', () => {
  it('одна ошибка в строке: потерянная цифра, лишняя цифра, потерянная точка, другая цифра — исправляются по сумме', () => {
    assert.deepEqual(repairBySum(1.392, 4990, 104386.08), { qty: 1.392, price: 74990, sum: 104386.08 }, '«74990» без «7»')
    assert.deepEqual(repairBySum(2.297, 130090, 2986816.73), { qty: 2.297, price: 130090, sum: 298816.73 }, 'лишняя «6» в сумме')
    assert.deepEqual(repairBySum(35.573, 62090, 220872757), { qty: 35.573, price: 62090, sum: 2208727.57 }, 'сумма без точки')
    assert.deepEqual(repairBySum(2.297, 130080, 298816.73), { qty: 2.297, price: 130090, sum: 298816.73 }, '«8» вместо «9»: допуск 0,2 % такую ошибку пропускал')
    assert.equal(repairBySum(1, 100, 350), null, 'нет единственной правки — не исправляем')
  })

  it('сверка строки — до копеек: неверная цифра десятков не проходит как «сошлось»', () => {
    const [it] = ocrChecked([{ name: 'трубы', unit: 'т', qty: 2.297, price: 130080, sum: 298816.73 }])
    assert.equal(it.price, 130090)
    assert.equal(it.ocrFixed, true)
    const [own] = ocrChecked([{ name: 'Труба', price: 100, qty: 2, sum: 244, unit: 'м' }])
    assert.equal(own.unsure, false, 'НДС сверху — по-прежнему сходится')
  })

  it('две ошибки в строке: сумма исправляется по итогу документа, затем цена — по сумме', () => {
    const items = ocrChecked([
      { name: 'а', unit: 'т', qty: 1, price: 1000, sum: 1000 },
      { name: 'б', unit: 'т', qty: 8.181, price: 108580, sum: 688374.79 },
    ])
    assert.equal(items[1].sumOff, true)
    const done = reconcileWithTotal(items, 889374.79)
    assert.deepEqual([done[1].qty, done[1].price, done[1].sum, done[1].sumOff, done[1].unsure], [8.181, 108590, 888374.79, false, false])
    assert.equal(reconcileWithTotal(items, 5000), items, 'итог не близок — ничего не трогаем')
  })

  it('наименование со скана: латиница в ГОСТ и ТУ, «з» вместо «э», «an.» вместо «дл.», «З» и «Б» вместо цифр', () => {
    assert.equal(ocrName('трубы злектросварные 108x4 ГОСТ an. 12000 MOCT10705-80,MOCT10704-91'), 'трубы электросварные 108x4 ГОСТ дл.12000 ГОСТ10705-80,ГОСТ10704-91')
    assert.equal(ocrName('швеллер ГОСТ 8240/TY СтЗпс/сп5 16П дл 12м'), 'швеллер ГОСТ 8240/ТУ Ст3пс/сп5 16П дл 12м')
    assert.equal(ocrName('уголок неравнополочный ГОСТ 8510 СтЭпс/сп5 Б3х40х5'), 'уголок неравнополочный ГОСТ 8510 Ст3пс/сп5 63х40х5')
    assert.equal(ocrName('вод/газ 25x2.8 оцинк ДУ дл.Б000 ГОСТ3262-75'), 'вод/газ 25x2.8 оцинк ДУ дл.6000 ГОСТ3262-75')
    assert.equal(ocrName('трубы оцинк 89%3.5'), 'трубы оцинк 89х3.5')
    assert.equal(ocrName('Блок Б12 ГОСТ'), 'Блок Б12 ГОСТ', 'верное наименование не меняется')
    assert.equal(ocrName('Кабель MOCTRON'), 'Кабель MOCTRON')
  })

  it('шапка латиницей («Kon-Bo») — колонка количества; английская шапка — как была', () => {
    assert.deepEqual(classifyHeader('Kon-Bo'), { field: 'qty' })
    assert.equal(classifyHeader('Qty'), null)
    assert.equal(classifyHeader('Ед.из').field, 'unit')
  })

  it('второе чтение чисел: что похоже на число и где его перечитать', () => {
    assert.equal(numberish('#15622.70'), true)
    assert.equal(numberish('g86374.79'), true)
    assert.equal(numberish('ГОСТ3262-75'), false)
    assert.equal(numberish('7'), false, 'одна цифра — номер строки')
    assert.equal(cleanNumber('2208727 57'), '220872757')
    assert.equal(cleanNumber('74990.00'), '74990.00')
    assert.equal(cleanNumber('7#990'), null)
    // Слово «26374.54» в ячейке суммы: рамка — от соседа слева (в другой ячейке, за линией) до линии справа.
    const words = [{ text: '1.392', bbox: { x0: 300, y0: 100, x1: 360, y1: 130 } }, { text: '26374.54', bbox: { x0: 520, y0: 100, x1: 620, y1: 130 } }]
    const box = numberBox(words, 1, [400, 640], 2000, 3000)
    assert.ok(box.x0 > 400 && box.x0 < 520, 'расширено влево, но не за линию ячейки')
    assert.ok(box.x1 <= 640 && box.x1 >= 620)
    assert.ok(box.y0 < 100 && box.y1 > 130)
  })

  it('картинка страницы и её разрешение — по командам pdf.js; увеличение Lanczos сохраняет чёрное и белое', () => {
    const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5, paintFormXObjectBegin: 6, paintFormXObjectEnd: 7 }
    const info = pageImageInfo([1, 3, 4, 2], [null, [699, 0, 0, 849, 0, 0], ['img_1', 877, 1077], null], OPS, 699, 849)
    assert.ok(Math.abs(info.sx * 72 - 90.3) < 0.1, 'около 90 dpi по ширине')
    assert.equal(info.cover, 1)
    assert.equal(pageImageInfo([], [], OPS, 595, 842), null)
    const g = new Uint8Array(4 * 4).fill(255)
    g[5] = 0; g[6] = 0; g[9] = 0; g[10] = 0
    const big = lanczosResize(g, 4, 4, 16, 16)
    assert.equal(big.length, 256)
    assert.ok(big[6 * 16 + 6] < 60, 'середина чёрного квадрата — тёмная')
    assert.ok(big[0] > 200, 'угол — светлый')
  })
})

// Скан, прочитанный прежней версией, перечитывается новой — с выбором человека (27.11.2026: в КП «Металлсервиса» тендера № 1157 уже
// 13 строк сопоставлены вручную).
describe('скан прежней версии: перечитать, выбор человека перенести', () => {
  const old = (lines, extra = {}) => ({ at: null, source: 'pdf', vat: null, delivery: 1, failed: null, date: null, currency: null, total: null, ocr: true, rv: 3, hidden: ['x|т'], lines, ...extra })

  it('скан со строками без сверки — перечитать, даже с выбором человека; без строк без сверки или не скан — по-старому', () => {
    assert.equal(offerNeedsRefresh(old([{ name: 'а', price: 1, unsure: true, k: 'key' }])), true)
    assert.equal(offerNeedsRefresh(old([{ name: 'а', price: 1 }])), false, 'все строки сверены')
    assert.equal(offerNeedsRefresh(old([{ name: 'а', price: 1, unsure: true, k: 'key' }], { ocr: false })), false, 'не скан, есть выбор человека')
    assert.equal(offerNeedsRefresh(old([{ name: 'а', price: 1, unsure: true }], { rv: READER_VERSION })), false, 'уже новой версией')
  })

  it('выбор переносится по коду поставщика, по наименованию, по месту в таблице; не найти — файл не трогаем', () => {
    const before = old([
      { name: 'швеллер ГОСТ 8240/TY СтЗпс 160', code: '1266425', price: 4990, k: 'шв16п' },
      { name: 'лист рифленый 5х1500х3000', code: null, price: 62790, no: ['лист10'] },
      { name: 'полоса 4x40', code: null, price: 72490 },
    ])
    const fresh = { ...old([
      { name: 'швеллер ГОСТ 8240/ТУ Ст3пс 16П', code: '1266425', price: 74990 },
      { name: 'лист рифленый 5х1500х3000', code: null, price: 62790 },
      { name: 'полоса 4х40', code: null, price: 72490 },
    ]), rv: READER_VERSION, hidden: [] }
    const got = carryOfferMarks(fresh, before)
    assert.equal(got.lines[0].k, 'шв16п', 'по коду')
    assert.equal(got.lines[0].price, 74990, 'цена — нового чтения')
    assert.deepEqual(got.lines[1].no, ['лист10'], 'по наименованию')
    assert.deepEqual(got.hidden, ['x|т'], 'убранные из окна позиции — как были')
    // Строка с выбором, которую не найти (ни кода, ни того же наименования, строк другое число), — выбор дороже нового чтения.
    const lost = carryOfferMarks({ ...fresh, lines: fresh.lines.slice(1) }, old([{ name: 'другое', price: 1, k: 'key' }, { name: 'ещё', price: 1 }, { name: 'и ещё', price: 1 }]))
    assert.equal(lost, null)
  })
})
