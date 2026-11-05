// Распознавание счёта / КП / УПД поставщика для расценки снабжением (src/utils/supplierDoc.js, supplierDocRead.js) и
// сопоставление его строк с позициями ВОР (src/utils/supplyDocMatch.js). Excel — книги, собранные здесь же
// библиотекой xlsx (в том числе .xls и .csv); PDF — напечатанные Chromium из HTML (как печатают 1С и Excel: таблица с
// рамками и без, перенос длинного наименования и числа в узкой колонке, выравнивание по низу, двухъярусная шапка УПД,
// таблица на двух страницах, скан без текста) и прочитанные pdf.js; каждый PDF — ещё и без линий рамки (разбор по
// одному тексту даёт то же). Копии счёта ПСК и КП Стандартпарка тендера 841 (30.10.2026: цифры по центру двухстрочной
// ячейки, строки вплотную, первое слово наименования у границы с артикулом) — с рамкой, без неё и с половиной линий.
// Без Chromium — только Excel и правила.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { browserLaunchOptions } from '../tender/lib/stand.mjs'
import { classifyHeader, deliveryUnitWithVat, docDateFromText, parseNum, rulingsFromOps, unitPriceWithVat, vatFromText } from '../../src/utils/supplierDoc.js'
import { autoPickRows, offersByGroup, otherUnitIndex, otherUnitPrices, suspectPrice, unplacedLines } from '../../src/utils/supplyAutoPick.js'
import { parseSupplierPdfPages, parseSupplierWorkbook, readPdfPages, readWorkbookBytes } from '../../src/utils/supplierDocRead.js'
import { codeTokens, deliveryFactor, docPack, expandName, groupUnitOk, itemCandidates, matchDocItems, mergeSamePositions, offerMatches, offerPrice, positionConfidence, positionGroups, sameMaterial, searchGroups } from '../../src/utils/supplyDocMatch.js'
import { offerNotesOfDoc } from '../../src/utils/supplyDocPrice.js'
import { nameDiff } from '../../src/utils/supplyNameDiff.js'
import { lineForGroup, lineNotForGroup, OFFER_LINES_MAX, offerInRoubles, offerNotes, offerVatMode, offerWithVat, readOffer } from '../../src/utils/supplyOffers.js'
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

// Тендер 841 «Бетонные полы на автостоянке»: копии счёта ПСК № 072813 и КП Стандартпарк № 10067 (по виду оригиналов
// 27.10.2026: реквизиты, шапка, ширины колонок, выравнивание) и позиции листа «Материалы» его ВОР (снимок 30.10.2026).
const PSK_HTML = `<div style="font:9pt Arial">
<h2 style="text-align:center;font-size:14pt;margin:4mm 0 1mm">СЧЕТ № 072813 от 27 октября 2026 г.</h2>
<p style="font-weight:bold;width:80mm;margin:0 0 2mm 10mm">по договору № СУ-ПРИМ13/2023-15 от 18 октября 2023 г.</p>
<table class="b" style="font-size:9pt"><tr><th style="width:50%">ПОСТАВЩИК:</th><th>ПОКУПАТЕЛЬ:</th></tr>
<tr><td><b>АО "ПРОМСТРОЙКОНТРАКТ"</b><br><br>Почтовый адрес:<br>119421, г. Москва, ул. Обручева, 13Б<br><br>Телефон: (495) 234-25-02, Факс: (495) 234-25-03<br>Расчетный счет № 40702810477000000304<br>в Ф-Л ПАО "БАНК "САНКТ-ПЕТЕРБУРГ" в г.Москве<br>Кор. счет № 30101810045250000142<br>БИК 044525142<br>ИНН: 7729329533<br>КПП 772801001<br>Код по ОКОНХ 71100<br>Код по ОКПО 42903911</td>
<td><b>ООО "СУ-10"</b><br><br>Почтовый адрес:<br>127018, Г.МОСКВА, ВН.ТЕР.Г. МУНИЦИПАЛЬНЫЙ ОКРУГ МАРЬИНА РОЩА, УЛ. ПОЛКОВАЯ, Д. 3, СТР. 5<br>Телефон: +7 (495) 616-23-22, Факс:<br>Расчетный счет № 40702810238000081762<br>В ПАО "Сбербанк России" Г. МОСКВА<br>Кор. счет № 30101810400000000225<br>БИК 044525225<br>ИНН: 7736255508<br>КПП 774550001<br>Грузополучатель: ООО "СУ-10"</td></tr></table>
<p style="font-weight:bold;font-size:11pt;text-decoration:underline">ВНИМАНИЕ!!! Счет становится НЕ ДЕЙСТВИТЕЛЬНЫМ по истечении трёх банковских дней с даты выставления!</p>
<p style="font-weight:bold;font-size:11pt;text-decoration:underline">ССЫЛКА НА НОМЕР СЧЕТА В ПЛАТЕЖНОМ ПОРУЧЕНИИ - ОБЯЗАТЕЛЬНА!</p>
<p style="font-weight:bold;text-decoration:underline">При получении товара - обязательна ДОВЕРЕННОСТЬ и копия счета.</p>
<p style="margin:6mm 0 1mm">Доставка включена в стоимость товара.</p>
<table class="b psk"><tr><th style="width:4%">№</th><th style="width:50%">Предмет счета</th><th style="width:9%">Ед. изм.</th><th style="width:10%">Кол-во</th><th style="width:10%">Цена</th><th>Сумма</th></tr>
<tr><td class="c">1</td><td>Шов деформационный АКВАСТОП ДШКА-75-УГЛ/050 (кратно 3м)</td><td class="c">пог.м</td><td class="r">231,000</td><td class="r">3 733,79</td><td class="r">862 505,49</td></tr>
<tr><td class="c">2</td><td>Шов деформационный АКВАСТОП ДШКА-75/050 (кратно 3м)</td><td class="c">пог.м</td><td class="r">690,000</td><td class="r">4 225,44</td><td class="r">2 915 553,60</td></tr></table>
<table style="width:auto;margin-left:auto;font-weight:bold"><tr><td class="r">Итого:</td><td class="r">3 778 059,09 руб.</td></tr>
<tr><td class="r">В том числе НДС (22%):</td><td class="r">681 289,35 руб.</td></tr></table>
<p style="font-weight:bold;text-align:center">Сумма к оплате: Три миллиона семьсот семьдесят восемь тысяч пятьдесят девять рублей 09 копеек.<br>В том числе НДС (22%): 681 289,35 руб.</p>
<p style="margin-top:12mm;font-weight:bold">Руководитель предприятия <span style="margin-left:60mm;font-weight:normal">Караулов Д. В.</span></p>
<p style="font-weight:bold">Гл. бухгалтер <span style="margin-left:72mm;font-weight:normal">Рябов В. В.</span></p></div>`
// Ширина колонки наименования — как в оригинале: первое наименование переносится на вторую строку («3м)»).
const PSK_CSS = '.psk td{vertical-align:middle;padding:1px 3px}.psk th{font-weight:normal;padding:1px 3px}.c{text-align:center}'
  + '.psk td:nth-child(2){width:96mm}'

const SP_HTML = `<div style="font:7pt Arial">
<p style="font-weight:bold;font-size:8pt;width:70mm">Филиал общества с ограниченной ответственностью "Торговая сеть Стандартпарк" в г.Москва</p>
<p style="margin:0">ИНН 7728609697, КПП775143001<br>108811, Город Москва, вн.тер.г. муниципальный округ Коммунарка, д Саларьево, влд. 5, стр. 1<br>Тел.: +7 (495) 385-87-24<br><b>www.standartpark.ru</b></p>
<h3 style="font-size:11pt;margin:10mm 0 6mm 4mm">Коммерческое предложение № 10067 от 27.10.2026</h3>
<p style="text-align:right;font-weight:bold;font-size:8pt">Заказчик: ООО "СУ-10"</p>
<table class="b sp"><tr><th style="width:4.5mm">№</th><th style="width:14mm">Артикул</th><th style="width:55mm">Наименование</th><th style="width:10.5mm">Длина<br>мм</th><th style="width:9.5mm">Ширина<br>мм</th><th style="width:10mm">Высота<br>мм</th><th style="width:6.5mm">Ед.</th><th style="width:17mm">Кол-во</th><th style="width:21.5mm">Цена, шт с<br>НДС</th><th style="width:20.5mm">Сумма, руб. с<br>НДС</th></tr>
<tr><td>1</td><td>7010</td><td>Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П полимербетонный 7010</td><td class="r">1 008</td><td class="r">138,00</td><td class="r">60,00</td><td>шт</td><td class="c">59</td><td class="r">1 163,12</td><td class="r">68 624,08</td></tr>
<tr><td>2</td><td>20403</td><td>Решетка водоприемная Basic РВ-10.14.50 ячеиcтая чугунная ВЧ, кл.С 20403</td><td class="r">498</td><td class="r">136,00</td><td class="r">16,00</td><td>шт</td><td class="c">118</td><td class="r">651,24</td><td class="r">76 846,32</td></tr>
<tr><td>3</td><td>6080</td><td>Крепеж стальной ЛВ-10.11.08-ОС к лотку водоотводному 6080</td><td class="r">100</td><td class="r">40,00</td><td class="r">32,00</td><td>шт</td><td class="c">118</td><td class="r">105,00</td><td class="r">12 390,00</td></tr>
<tr><td>4</td><td>0805033-М</td><td>Лоток водоотводный PolyMax Drive ЛВ-10.16.06-ПП пластиковый с решеткой щелевой чугунной ВЧ кл. C (комплект) 0805033-М</td><td class="r">1 024</td><td class="r">164,00</td><td class="r">76,00</td><td>шт</td><td class="c">1 191</td><td class="r">2 809,98</td><td class="r">3 346 686,18</td></tr>
<tr><td>5</td><td></td><td>Доставка товара (без разгрузочных работ)</td><td></td><td></td><td></td><td>шт</td><td class="c">1</td><td class="r">60 000,00</td><td class="r">60 000,00</td></tr></table>
<table style="width:auto;margin-left:auto;font-weight:bold;font-size:8pt"><tr><td class="r">Итого:</td><td class="r">3 564 546,58</td></tr><tr><td class="r">В том числе НДС:</td><td class="r">642 787,08</td></tr></table>
<p style="font-family:serif;font-size:8pt"><b>Прочие условия:</b><br><b>Срок действия:</b> &nbsp; 5 календарных дней</p>
<p style="font-family:serif;font-size:8pt;margin-top:20mm"><b>С уважением,<br>Менеджер по развитию клиентов<br>Абрамов Николай Ильич</b><br>Тел.: +79167701708<br>e-mail:n.abramov@standartpark.ru</p></div>`
// Строки вплотную, наименование по верху ячейки, шапка по центру — как в 1С.
const SP_CSS = '.sp{width:170mm;margin-left:4mm;font-size:6.5pt;table-layout:fixed}.sp td{padding:0 2px;vertical-align:top;line-height:1.15}.sp th{background:#ccc;font-weight:normal;padding:0 2px;vertical-align:middle;line-height:1.15}.c{text-align:center}'
const SP_ITEMS = [
  ['7010', 'Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П полимербетонный 7010', 'шт', 59, 1163.12, 68624.08, 'gross', false],
  ['20403', 'Решетка водоприемная Basic РВ-10.14.50 ячеиcтая чугунная ВЧ, кл.С 20403', 'шт', 118, 651.24, 76846.32, 'gross', false],
  ['6080', 'Крепеж стальной ЛВ-10.11.08-ОС к лотку водоотводному 6080', 'шт', 118, 105, 12390, 'gross', false],
  ['0805033-М', 'Лоток водоотводный PolyMax Drive ЛВ-10.16.06-ПП пластиковый с решеткой щелевой чугунной ВЧ кл. C (комплект) 0805033-М', 'шт', 1191, 2809.98, 3346686.18, 'gross', false],
  [null, 'Доставка товара (без разгрузочных работ)', 'шт', 1, 60000, 60000, 'gross', true],
]
const VOR_841 = [
  ['Раствор М-300 (м3)', 'м3', 0.2548], ['Керамзитобетон М-50 (м3)', 'м3', 52.2439], ['Техноэласт Барьер БО (м2)', 'м2', 2489.711],
  ['Праймер битумный Технониколь №04', 'кг', 497.1392], ['Сетка сварная (дорожная) яч. 5Ср (5Вр-I-100)/(5Вр-I-100) (м2)', 'м2', 1453.21],
  ['Сетка сварная (дорожная) яч. 4Ср (5Вр-I-100)/(5Вр-I-100) (м2)', 'м2', 19009.1], ['полиуретан цемент QTP 2640', 'кг', 46669.77],
  ['Кварцевый песок QTP QS 0.4-0.8', 'кг', 69140.4], ['Дилатационное устройство АКВАСТОП  Тип ДШКА-75-УГЛ/050-(К3-054)', 'м. пог.', 229.586],
  ['Дилатационное устройство АКВАСТОП Тип ДШКА-75/050-(К3-074)', 'м. пог.', 689.61], ['Лоток водоотводный Poli Max Drive  ЛВ-10.16.06-ПП', 'шт', 1191],
  ['Решетка щелевая чугунная РВ-ВЧ-ЩЗ', 'шт', 1191], ['Бетон М-450 (В35) (м3)', 'м3', 1828.3186], ['Смесь сухая Mastertop 450 (кг)', 'кг', 91937],
  ['Пропитка Мастертоп (средство для ухода за бетоном, 1кг=1л) (л)', 'л', 91937], ['Лента демпферная 10мм/0,1м-11м Energoflex super (м)', 'м', 9589.5932],
  ['Пенополистирол экструдированный CARBON PROF 1180х580х100 (м3)', 'м3', 0.9765], ['Раствор М-150 (м3)', 'м3', 34.8029],
  ['Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П полимербетонный (шт)', 'шт', 58.242], ['Решетка водоприемная чугунная РВ-10.14.50 (шт)', 'шт', 58.242],
].map(([name, unit, volume]) => ({ name, unit, volume, k: normName(name) }))

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
    // Доставка: колонкой — отдельно (сумма по строке или за единицу); «с доставкой» — уже в цене; срок — не нужен.
    assert.equal(f('Доставка, руб.'), 'delivery')
    assert.equal(f('Стоимость доставки с НДС'), 'delivery:gross')
    assert.equal(classifyHeader('Доставка за ед.').perUnit, true)
    assert.equal(classifyHeader('Цена доставки').perUnit, true)
    assert.equal(classifyHeader('Стоимость доставки').perUnit, false)
    assert.equal(f('Цена с доставкой, руб.'), 'price')
    assert.equal(f('ЦЕНА руб., с учетом доставки и НДС 22%'), 'price')
    assert.equal(f('Срок доставки'), 'skip')
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
    // Доставка колонкой строки: сумма — на количество, НДС — как у цены (или своя пометка колонки).
    const d = (value, perUnit, vat = null, o = {}) => item({ price: 100, qty: 4, deliveryDoc: { value, perUnit, vat }, ...o })
    assert.equal(deliveryUnitWithVat(d(20, false), null), 5)
    assert.equal(deliveryUnitWithVat(d(5, true), null), 5)
    assert.equal(deliveryUnitWithVat(d(20, false, null, { priceVat: 'net' }), null), 6.1, 'цена без НДС — и доставка без НДС')
    assert.equal(deliveryUnitWithVat(d(20, false, 'gross', { priceVat: 'net' }), null), 5, 'своя пометка колонки')
    assert.equal(deliveryUnitWithVat(item({ price: 100, qty: null, deliveryDoc: { value: 20, perUnit: false } }), null), null, 'сумма без количества')
    assert.equal(deliveryUnitWithVat(item({ price: 100 }), null), null)
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

  it('доставка колонкой: сумма по строке и за единицу; строка «Доставка» — отдельно; «Тележка транспортная» — товар', () => {
    const r = parseSupplierWorkbook(XLSX, workbook([['КП', [
      ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена с НДС', 'Сумма с НДС', 'Доставка, руб.'],
      [1, 'Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П', 'шт', 59, 1163.12, 68624.08, 1180],
      [2, 'Тележка транспортная платформенная', 'шт', 2, 9500, 19000, ''],
      [3, 'Доставка товара (без разгрузочных работ)', 'шт', 1, 60000, 60000, ''],
      ['', 'Итого', '', '', '', 147624.08, 1180],
    ]]]))
    assert.deepEqual(r.items.map((i) => [i.name, i.delivery, i.deliveryDoc && deliveryUnitWithVat(i, r.vat)]), [
      ['Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П', false, 20],
      ['Тележка транспортная платформенная', false, null],
      ['Доставка товара (без разгрузочных работ)', true, null],
    ])
    const unit = parseSupplierWorkbook(XLSX, workbook([['КП', [
      ['Наименование', 'Кол-во', 'Цена без НДС', 'Доставка за ед.'], ['Решетка РВ-10.14.50', 118, 533.8, 10],
    ]]]))
    assert.equal(Math.round(deliveryUnitWithVat(unit.items[0], unit.vat) * 100) / 100, 12.2, 'за единицу, без НДС — как цена')
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
  // PDF из HTML → распознанное; тот же файл без линий рамки (разбор по одному тексту) должен дать то же самое.
  async function pages(body, { css = '', landscape = false } = {}) {
    await page.setContent(`<html><head><meta charset="utf-8"><style>${STYLE}${css}</style></head><body>${body}</body></html>`)
    const pdf = await page.pdf({ format: 'A4', landscape, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } })
    return readPdfPages(pdfjs, new Uint8Array(pdf))
  }
  const strip = (list, keep = () => ({ h: [], v: [] })) => list.map((p) => ({ ...p, rulings: p.rulings ? keep(p.rulings) : null }))
  async function read(body, opts = {}) {
    const list = await pages(body, opts)
    const r = parseSupplierPdfPages(list)
    assert.deepEqual(parseSupplierPdfPages(strip(list)).items, r.items, 'без линий рамки — то же')
    return r
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

  // Тендер 841: оба документа — с рамкой, без неё, только с вертикальными и только с горизонтальными линиями.
  const variants = (list) => [['с рамкой', list], ['без линий', strip(list)],
    ['только колонки', strip(list, (r) => ({ h: [], v: r.v }))], ['только строки', strip(list, (r) => ({ h: r.h, v: [] }))]]

  it('счёт ПСК (тендер 841): цифры по центру двухстрочной ячейки, первая строка наименования — не шапка; «в том числе НДС (22%)»', async () => {
    const list = await pages(PSK_HTML, { css: PSK_CSS })
    for (const [label, v] of variants(list)) {
      const r = parseSupplierPdfPages(v)
      assert.deepEqual(brief(r.items), [
        ['Шов деформационный АКВАСТОП ДШКА-75-УГЛ/050 (кратно 3м)', 'пог.м', 231, 3733.79, 862505.49],
        ['Шов деформационный АКВАСТОП ДШКА-75/050 (кратно 3м)', 'пог.м', 690, 4225.44, 2915553.6],
      ], label)
      assert.deepEqual([r.vat.mode, r.vat.rate], ['gross', 22], label)
    }
  })

  it('КП Стандартпарк (тендер 841): строки вплотную, наименование на 2–3 строки, артикул рядом с наименованием, доставка строкой', async () => {
    const list = await pages(SP_HTML, { css: SP_CSS })
    assert.ok(list[0].rulings.h.length > 5 && list[0].rulings.v.length > 5, 'рамку таблицы видно')
    for (const [label, v] of variants(list)) {
      const r = parseSupplierPdfPages(v)
      assert.deepEqual(r.items.map((i) => [i.code, i.name, i.unit, i.qty, i.price, i.sum, i.priceVat, i.delivery]), SP_ITEMS, label)
    }
  })

  it('тендер 841: строки обоих документов — свои позиции ВОР сами (артикул ДШКА, РВ-10.14.50; «пог.м» = «м. пог.»), крепежа в ВОР нет', async () => {
    const groups = positionGroups([{ name: 'ВОР Устройство бетонных полов на автостоянке (-1,-2 эт)', positions: VOR_841 }])
    const items = []
    for (const [html, css] of [[PSK_HTML, PSK_CSS], [SP_HTML, SP_CSS]]) items.push(...parseSupplierPdfPages(await pages(html, { css })).items)
    const res = matchDocItems(items.filter((i) => !i.delivery), groups)
    assert.deepEqual(res.map((m) => m.match && [m.match.group.name, m.match.unitOk]), [
      ['Дилатационное устройство АКВАСТОП  Тип ДШКА-75-УГЛ/050-(К3-054)', true],
      ['Дилатационное устройство АКВАСТОП Тип ДШКА-75/050-(К3-074)', true],
      ['Лоток водоотводный CompoMax Basic ЛВ-10.14.06-П полимербетонный (шт)', true],
      ['Решетка водоприемная чугунная РВ-10.14.50 (шт)', true],
      null,
      ['Лоток водоотводный Poli Max Drive  ЛВ-10.16.06-ПП', true],
    ])
    assert.ok(res.every((m) => !m.match || m.match.score >= 0.85), 'уверенно, а не на грани')
  })
})

describe('документ поставщика: линии рамки из команд pdf.js', () => {
  // Команды как в getOperatorList: OPS — номера pdf.js; путь — [moveTo 0, lineTo 1, curveTo 2, …, closePath 4].
  const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23,
    fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 }
  const path = (op, ...cmds) => [OPS.constructPath, [op, [Float32Array.from(cmds.flat())], null]]
  const list = (...ops) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) })

  it('обводка отрезков и прямоугольника, тонкие закрашенные прямоугольники; кривые и заливка фона — не линии; стык в стык — одна линия', () => {
    const r = rulingsFromOps(list(
      path(OPS.stroke, [0, 10, 700], [1, 110, 700], [0, 110, 700], [1, 210, 700]), // две ячейки — одна линия y = 100
      path(OPS.closeStroke, [0, 10, 600], [1, 60, 600], [1, 60, 650], [1, 10, 650], [4]), // рамка ячейки: 2 гориз. + 2 верт.
      path(OPS.fill, [0, 300, 500], [1, 400, 500], [1, 400, 500.8], [1, 300, 500.8], [4]), // тонкий прямоугольник — линия
      path(OPS.fill, [0, 300, 400], [1, 400, 400], [1, 400, 430], [1, 300, 430], [4]), // заливка шапки — нет
      path(OPS.stroke, [0, 10, 300], [2, 20, 310, 30, 310, 40, 300]), // кривая — нет
      path(OPS.endPath, [0, 10, 200], [1, 300, 200]), // обрезка — нет
    ), OPS, { pageHeight: 800 })
    const h = r.h.map((x) => [Math.round(x.y * 10) / 10, x.x0, x.x1])
    assert.deepEqual(h, [[100, 10, 210], [150, 10, 60], [200, 10, 60], [299.6, 300, 400]])
    assert.deepEqual(r.v.map((x) => [x.x, x.y0, x.y1]), [[10, 150, 200], [60, 150, 200]])
  })

  it('преобразования: save / transform / restore и форма (XObject) со своей матрицей', () => {
    const r = rulingsFromOps(list(
      [OPS.save, []], [OPS.transform, [2, 0, 0, 2, 100, 0]],
      path(OPS.stroke, [0, 0, 100], [1, 50, 100]), // → x 100…200, y = 800 − 200
      [OPS.restore, []],
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, -100], [0, 0, 500, 500]]],
      path(OPS.stroke, [0, 20, 300], [1, 20, 400]), // вертикаль x = 20, y 500…600 от верха
      [OPS.paintFormXObjectEnd, []],
      path(OPS.stroke, [0, 0, 50], [1, 30, 50]), // после restore и конца формы — без преобразований
    ), OPS, { pageHeight: 800 })
    assert.deepEqual(r.h.map((x) => [x.y, x.x0, x.x1]), [[600, 100, 200], [750, 0, 30]])
    assert.deepEqual(r.v.map((x) => [x.x, x.y0, x.y1]), [[20, 500, 600]])
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

// Спецификация ЭТМ (тендер № 850, 02.11.2026): «Код товара» — внутренний код ЭТМ, «Артикул» — артикул производителя,
// его и пишет смета. Спецификацию считают по объёму ВОР, с округлением до упаковки. Цена — за единицу документа:
// упаковка стяжек, бухта кабеля. Позиции и строки — как в файлах, цены условные. Те же расчёты — в окне и у цен поставщиков.
describe('спецификация ЭТМ: артикул, упаковка и бухта, одна строка на несколько позиций (тендер 850)', () => {
  const vor = {
    'СОУЭ': [
      ['Громкоговоритель трансляционный настенный SWS-106-103, арт.SNR-361112, ООО "Сонар"', 'шт', 7],
      ['Фильтр оконечный Sonar SFT-2300-M, ООО "Рубеж"', 'шт', 1],
      ['Шкаф ШСОУЭ 7.1', 'компл', 1],
      ['Кабель КПСнг(А)-FRHF 1х2х0,75, Спецкабель', 'м', 301.92],
      ['Стяжка кабельная из нержавеющей стали, AISI 304 4,6х150, DKC', 'шт', 690],
      ['Труба, гофрированная с протяжкой, ПВХ, d16мм, арт.91916, ДКС', 'м', 67.32],
      ['Держатель оцинкованный односторонний, д.16мм, арт. 53331, DKC', 'шт', 200],
      ['Коробка огнестойкая пластиковая с кабельными вводами и клеммниками 4п., IP55, 100х100х50мм, арт.FSB11404, DKC', 'шт', 7],
      ['Пена огнестойкая двухкомпонентная, FIREFIX, Техстронг', 'шт', 1],
      ['Герметик огнестойкий FIREFIX, 310мл, ТЕХСТРОНГ', 'шт', 1],
      ['Труба стальная ненарезная 32х1,2x3000мм, арт. CTR12-032-3, IEK', 'м', 10.5],
      ['Стяжка нейлоновая СК-300 (100шт.)', 'уп', 10],
      ['Бирка маркировочная треугольная 62х62х62х0,8мм, У136 М2914 ЗАО, «МПО Электромонтаж»', 'шт', 10],
    ],
    'СОТ': [
      ['Пена огнестойкая двухкомпонентная «FIREFIX», картридж 380 мл, Техстронг', 'шт', 2],
      ['Герметик огнестойкий FIREFIX, Техстронг', 'шт', 4],
      ['Видеокамера IP цилиндрическая RVi-2NCT2362 (2.8) RU, RVI', 'шт', 14],
      ['Видеокамера IP цилиндрическая RVi-2NCT2479 (2.7-13.5), RVI', 'шт', 1],
      ['Коробка монтажная для цилиндрической камеры, RVi-2BMB-5, RVi', 'шт', 15],
      ['Розетка RJ-45(8P8C), категория 5е, одинарная SB1-1-8P8C-C5e-WH, Hyperline', 'шт', 1],
      ['Патч-корд PC-LPM-UTP-RJ45-C5E-2M-LSZH-BK (2 м), Hyperline', 'шт', 1],
      ['Кабель «витая пара» UTP-4P-Cat.5e-SOLID-OUT-LSZH-UV, Cabeus', 'м', 1453.5],
      ['Кабель U/UTP Cat5e PVCLS нг(A)-LSLTx 4х2х0,52, Паритет', 'м', 989.4],
      ['Кабель «витая пара» U/UTP Cat5e ZHнг(А)-HF 4х2х0,52, Паритет', 'м', 22.44],
      ['Труба ПВХ гибкая гофрированная d=16мм, арт.91916, DKC', 'м', 1071],
      ['Труба ПП гибкая гофрированная, лёгкая с протяжкой, д.16мм, 11916, ДКС', 'м', 153],
      ['Труба гофрированная d16 мм,черная, арт. PR02.0101, Промрукав', 'м', 81.6],
      ['Крепеж-клипса с дюбелем, чёрная, d16 мм арт.PR13.0303, Промрукав', 'шт', 3850],
      ['Патрубок-муфта, чёрная, d16 мм, PR13.0163, Промрукав', 'шт', 20],
      ['Бирка маркировочная, У136, DKC', 'шт', 200],
      ['Стяжка нейлоновая СК-300', 'шт', 200],
    ],
    'СОВ': [
      ['Розетка компьютерная RJ-45(8P8C), кат. 6, SB1-1-8P8C-C6-WH, Hyperline', 'шт', 1],
      ['Труба гофрированная ПА негорючая, d16 мм, чёрная с/з, арт. PR02.0101, Промрукав', 'м', 61.2],
      ['Кабель «витая пара» UTP-4P-Cat.5e-SOLID-OUT-LSZH-UV, Cabeus', 'м', 147.9],
    ],
  }
  const groups = positionGroups(Object.entries(vor).map(([name, list]) => ({
    name, positions: list.map(([n, unit, volume]) => ({ name: n, unit, volume, k: normName(n) })),
  })))
  const HEAD = ['N', 'Код товара', 'Имя товара', 'Производитель', 'Артикул', 'Кол-во', 'Ед.изм.', 'Цена без НДС', 'Цена с НДС', 'Сумма без НДС', 'Сумма с НДС', 'Срок поставки', 'Штрих-код']
  const row = (n, code, name, maker, art, qty, unit, price) => [n, code, name, maker, art, qty, unit, Math.round(price / 1.22 * 100) / 100, price, Math.round(price / 1.22 * qty * 100) / 100, Math.round(price * qty * 100) / 100, 'в наличии', 4600000000000 + n]
  const top = [[null, null, null, null, null, null, null, null, null, null, null, 'www.etm.ru'],
    [null, null, null, null, 'Коммерческое предложение / Спецификация № ', '201/1'], [],
    ['Представляем Вашему вниманию цены на продукцию, которая может быть Вам интересна:'], ['Примечание:', null, 'соуэ'], HEAD]
  const tail = (a, b) => [[null, null, null, null, null, null, null, null, 'Всего', a, b], ['Итого к оплате, с учетом НДС:', null, null, 'сумма прописью']]
  const SOUE = [
    row(1, 106843968, 'Громкоговоритель трансляционный настенный SWS-106-103, 100В, мощность 6/3/1.5Вт', 'Sonar Rubezh', 'Sonar SWS-106-103', 7, 'шт', 2500),
    row(2, 9106234, 'Фильтр оконечный для трансляционной линии при     контроле линии переменным током', 'Sonar Rubezh', 'Sonar SFT-2300-M', 1, 'шт', 4500),
    row(3, 7611092, 'Кабель парной скрутки КПСнг(A)-FRHF 1х2х0.75', 'Технокабель', 'КПСнг(А)-FRHF 1х2х0.75', 301, 'м', 38),
    row(4, 9867404, 'Хомут 4.6х150 нержавеющая сталь (50шт)', 'DKC', 27403, 13, 'упак', 1200),
    row(5, 87860000, 'Труба гофрированная ПВХ 16 мм с протяжкой легкая серая (100м)', 'DKC', 91916, 100, 'м', 19),
    row(6, 4272244, 'Скоба крепежная (держатель) однолапковая оцинкованная, д.16мм с крепежным отверстием 8,5 х 6 мм', 'DKC', 53331, 200, 'шт', 12),
    row(7, 8325936, 'Коробка пластиковая FS с кабельными вводами и клеммниками IP55 100х100х50мм', 'DKC', 'FSB11404', 7, 'шт', 1000),
    row(8, 6193989, 'Пена противопожарная FIREFIX (двухкомпонентная картридж 380 мл)', 'EKF', 'pp-ff', 1, 'шт', 8000),
    row(9, 3099668, 'Герметик огнестойкий монтажный акриловый EI240 FIREFORT 310 мл', 'КМ-профиль', 'LO52676', 1, 'шт', 800),
    row(10, 3615385, 'Труба стальная ненарезная 32х1,2x3000мм ГЦ', 'IEK', 'CTR12-032-3', 12, 'м', 700),
    row(11, 4502923, 'Стяжка нейлоновая 7.6х300 черный (100 шт.)', 'Крепдил', 4502923, 10, 'упак', 330),
    row(12, 9536258, 'Бирки маркировочные У136 У3,5', 'ПЭМИ', '43Б27У136Н', 1000, 'шт', 2),
  ]
  const SOT = [
    row(3, 9321824, 'Видеокамера IP 2Мп цилиндрическая ИК-30м (2.8мм)', 'RVi', 'RVi-2NCT2362 (2.8) RU', 14, 'шт', 40000),
    row(4, 1132277, 'Видеокамера IP 2Мп цилиндрическая ИК-50м IP67', 'RVi', 'RVi-2NCT2479 (2.7-13.5) white', 1, 'шт', 84000),
    row(5, 331690, 'Коробка монтажная для камер видеонаблюдения', 'RVi', 'RVi-2BMB-5', 15, 'шт', 12000),
    row(6, 6705579, 'Компьютерная розетка 8P8C (RJ-45), UTP, Cat.5e, 2 порта', 'Suprlan', '10-0309', 1, 'шт', 190),
    row(7, 461315, 'Патч-корд оптический переходнойMM 50/125 OM2 SC/UPC-LC/UPC двойной LSZH 2мм', 'NIKOMAX', 'NMF-PC2M2C2-SCU-LCU-005', 1, 'шт', 580),
    row(8, 8239633, 'Витая пара U/UTP Cat 5e 4 пары 24 AWG solid OUT(+75 C - -40) LSZH-UV 305м', 'Cabeus', 'UTP-4P-Cat.5e-SOLID-OUT-LSZH-U', 5, 'шт', 16775),
    row(9, 2171143, 'Витая пара ParLan U/UTP Cat 5e PVCLS нг(A)-LSLTx 4х2х0.52', 'Паритет', 108771, 989, 'м', 100),
    row(12, 7434267, 'Труба гофрированная ПА стойкая к ультрафиолету    (УФ) не распространяющая горение с зондом д16', 'Промрукав', 'PR02.0101', 100, 'м', 150),
    row(13, 8094274, 'Крепеж-клипса с дюбелем черная д16 в малой упаковке (10шт/900шт уп/кор)', 'Промрукав', 'PR13.0303', 3850, 'шт', 18),
    row(14, 3538740, 'Патрубок-муфта черная д16 (10шт/800шт уп/кор)', 'Промрукав', 'PR13.0163', 20, 'шт', 17),
    row(11, 9710984, 'Труба гофрированная ППЛ 16 мм с протяжкой легкая синяя (100м)', 'DKC', 11916, 200, 'м', 85),
  ]
  const read = (rows) => {
    const r = parseSupplierWorkbook(XLSX, workbook([['Лист1', [...top, ...rows, ...tail(1, 2)]]], { bookType: 'biff8' }))
    assert.equal(r.kind, 'excel', r.error)
    return r
  }
  const names = (m) => (m.match ? [m.match, ...m.also] : []).map((c) => c.group.name)
  const lineOf = (res, text) => res.find((m) => m.item.name.includes(text))

  it('«Артикул» важнее «Кода товара»: второй — запасной; НДС и количество не теряются; итог — конец таблицы', () => {
    const r = read(SOUE)
    assert.equal(r.items.length, SOUE.length)
    const i = r.items.find((x) => x.name.startsWith('Хомут'))
    assert.deepEqual([i.code, i.code2, i.unit, i.qty, i.price, i.priceVat], ['27403', '9867404', 'упак', 13, 1200, 'gross'])
    // Без колонки «Артикул» «Код товара» — как прежде: это и есть артикул (УПД).
    const upd = parseSupplierWorkbook(XLSX, workbook([['Л', [['Код товара', 'Наименование', 'Цена с НДС'], ['А-100', 'Болт', 10]]]]))
    assert.deepEqual([upd.items[0].code, upd.items[0].code2], ['А-100', null])
  })

  it('спецификация СОУЭ: все строки нашли позиции, большинство — по артикулу; цена за упаковку — за штуку', () => {
    const res = matchDocItems(read(SOUE).items, groups, { packs: true })
    assert.equal(res.filter((m) => m.match).length, SOUE.length, res.filter((m) => !m.match).map((m) => m.item.name).join('; '))
    for (const a of ['Громкоговоритель', 'Фильтр оконечный', 'Скоба крепежная', 'Коробка пластиковая', 'Труба стальная']) {
      assert.equal(lineOf(res, a).match.article, true, a)
    }
    assert.deepEqual(names(lineOf(res, 'Фильтр оконечный')), ['Фильтр оконечный Sonar SFT-2300-M, ООО "Рубеж"'])
    assert.deepEqual(names(lineOf(res, 'Скоба крепежная')), ['Держатель оцинкованный односторонний, д.16мм, арт. 53331, DKC'])
    // Хомут: артикула в ВОР нет, но размер, слова и количество (13 упак × 50 = 650 из 690) — та же позиция.
    const hose = lineOf(res, 'Хомут 4.6х150')
    assert.match(hose.match.group.name, /^Стяжка кабельная из нержавеющей стали/)
    assert.deepEqual([hose.match.pack, hose.match.unitOk, hose.match.qty], [50, true, true])
  })

  it('спецификация СОТ: обрезанный артикул и бухта 305 м — цена за метр; разные товары сами не сопоставляются', () => {
    const res = matchDocItems(read(SOT).items, groups, { packs: true })
    const utp = lineOf(res, 'LSZH-UV 305м')
    assert.equal(utp.match.group.name, 'Кабель «витая пара» UTP-4P-Cat.5e-SOLID-OUT-LSZH-UV, Cabeus')
    assert.deepEqual([utp.match.article, utp.match.pack, utp.match.unitOk], [true, 305, true])
    assert.equal(utp.match.group.targets.length, 2, 'сразу в двух ВОР')
    assert.equal(offerPrice({ line: { price: 16775 }, pack: utp.match.pack }), 55)
    assert.match(lineOf(res, 'ИК-30м').match.group.name, /RVi-2NCT2362/)
    assert.match(lineOf(res, 'ИК-50м').match.group.name, /RVi-2NCT2479/)
    assert.match(lineOf(res, 'Коробка монтажная').match.group.name, /RVi-2BMB-5/)
    assert.equal(lineOf(res, 'ParLan').match.group.name, 'Кабель U/UTP Cat5e PVCLS нг(A)-LSLTx 4х2х0,52, Паритет', 'та же марка, а не любой 4х2х0,52')
    // Патч-корд — не розетка, хотя у них общие RJ-45 и UTP; другой товар (оптический) — только в списке.
    const socket = lineOf(res, 'Компьютерная розетка')
    assert.equal(socket.match, null)
    assert.match(socket.candidates[0].group.name, /^Розетка RJ-45/)
    const patch = lineOf(res, 'Патч-корд оптический')
    assert.equal(patch.match, null)
    assert.match(patch.candidates[0].group.name, /^Патч-корд/)
  })

  it('одна строка — несколько позиций: тот же артикул или материал под другой записью; другое сечение и ед. изм. без пересчёта — нет', () => {
    const res = matchDocItems(read(SOUE).items, groups, { packs: true })
    assert.deepEqual(names(lineOf(res, 'Труба гофрированная ПВХ')).sort(), ['Труба ПВХ гибкая гофрированная d=16мм, арт.91916, DKC', 'Труба, гофрированная с протяжкой, ПВХ, d16мм, арт.91916, ДКС'].sort())
    assert.deepEqual(names(lineOf(res, 'Пена противопожарная')).sort(), ['Пена огнестойкая двухкомпонентная «FIREFIX», картридж 380 мл, Техстронг', 'Пена огнестойкая двухкомпонентная, FIREFIX, Техстронг'].sort())
    const tie = lineOf(res, 'Стяжка нейлоновая')
    assert.deepEqual(names(tie).sort(), ['Стяжка нейлоновая СК-300', 'Стяжка нейлоновая СК-300 (100шт.)'].sort())
    assert.deepEqual([tie.match, ...tie.also].map((c) => [c.group.unit, c.pack]).sort(), [['уп', null], ['шт', 100]].sort())
    assert.deepEqual(names(lineOf(res, 'Кабель парной')), ['Кабель КПСнг(А)-FRHF 1х2х0,75, Спецкабель'], 'КСПВПГнг той же жильности — другой кабель')
    const [a, b] = ['Кабель КСПВПнг(А)-HF 1х2х0,80, Паритет', 'Кабель КСПВПнг(А)-HF 1х2х1,13'].map((name) => positionGroups([{ name: 'В', positions: [{ name, unit: 'м', k: normName(name) }] }])[0])
    assert.equal(sameMaterial(a, b), false, 'другое сечение — другой материал')
  })

  it('без пересчёта (проверка реестра КП, кабинет подрядчика: цена как есть) упаковка — другая ед. изм., а не цена за штуку', () => {
    const [hose] = read([SOUE[3]]).items
    const near = itemCandidates(hose, groups).find((c) => /нержавеющей/.test(c.group.name))
    assert.deepEqual([near.pack, near.unitOk], [null, false])
    const packed = itemCandidates(hose, groups, null, 12, { packs: true }).find((c) => /нержавеющей/.test(c.group.name))
    assert.deepEqual([packed.pack, packed.unitOk], [50, true])
  })

  it('упаковка и длина — только то, что написал поставщик', () => {
    const pack = (name, unit, to) => docPack({ name, unit }, to)
    assert.equal(pack('Стяжка нейлоновая 7.6х300 черный (100 шт.)', 'упак', 'шт'), 100)
    assert.equal(pack('Стяжка нейлоновая 7.6х300 черный (100 шт.)', 'упак', 'уп'), null, 'упаковка за упаковку — как есть')
    assert.equal(pack('Витая пара … LSZH-UV 305м', 'шт', 'м'), 305)
    assert.equal(pack('Кабель в бухте 100 м', 'бухта', 'м.п.'), 100)
    assert.equal(pack('Лоток 100х50 L3000', 'шт', 'м'), 3)
    assert.equal(pack('Труба стальная 32х1,2x3000мм', 'шт', 'м'), 3)
    assert.equal(pack('Труба гофрированная ПВХ 16 мм (100м)', 'м', 'м'), null, 'цена уже за метр')
    assert.equal(pack('Видеокамера ИК-30м', 'шт', 'м'), null, '30 м — дальность, а не длина')
    assert.equal(pack('Кабель 2х0,75', 'шт', 'м'), null)
    assert.equal(pack('Болт М6', 'упак', 'шт'), null, 'сколько в упаковке, не сказано')
    assert.equal(pack('Клипса (10шт/900шт уп/кор)', 'шт', 'шт'), null)
    assert.equal(pack('Краска 5л', 'кг', 'м'), null)
  })

  it('цены поставщиков: по артикулу — у всех позиций с ним, цена за единицу позиции; выбор окна сохраняет и вторую позицию', () => {
    const r = read(SOT)
    const lines = readOffer(offerNotesOfDoc(r).notes).lines.map((l) => ({ ...l, doc: { id: 'd' } }))
    const res = offerMatches(lines, groups)
    const group = (name) => groups.find((g) => g.name === name)
    for (const name of ['Труба гофрированная d16 мм,черная, арт. PR02.0101, Промрукав', 'Труба гофрированная ПА негорючая, d16 мм, чёрная с/з, арт. PR02.0101, Промрукав']) {
      assert.deepEqual(res.get(group(name).key).map((o) => offerPrice(o)), [150], name)
    }
    const utp = res.get(group('Кабель «витая пара» UTP-4P-Cat.5e-SOLID-OUT-LSZH-UV, Cabeus').key)
    assert.deepEqual(utp.map((o) => [offerPrice(o), o.pack, o.unitOk]), [[55, 305, true]])
    const kept = readOffer(offerNotes({ lines: [{ name: 'Стяжка (100 шт.)', unit: 'упак', price: 330, k: group('Стяжка нейлоновая СК-300 (100шт.)').k, also: [group('Стяжка нейлоновая СК-300').k] }] })).lines
    assert.equal(kept[0].also.length, 1)
    const picked = offerMatches(kept.map((l) => ({ ...l, doc: { id: 'd' } })), groups)
    assert.deepEqual(picked.get(group('Стяжка нейлоновая СК-300').key).map((o) => [o.picked, offerPrice(o)]), [[true, 3.3]])
    assert.deepEqual(picked.get(group('Стяжка нейлоновая СК-300 (100шт.)').key).map((o) => [o.picked, offerPrice(o)]), [[true, 330]])
  })
})

// То, чего в спецификациях ЭТМ нет, а у других поставщиков встречается: иначе цена вышла бы неверной или строки потерялись.
describe('казусы документов поставщиков', () => {
  const one = (sheetRows, name = 'Л') => parseSupplierWorkbook(XLSX, workbook([[name, sheetRows]]))
  const f = (t) => classifyHeader(t)

  it('цена со скидкой важнее прайсовой; прайс и РРЦ — запасные; рубли важнее валюты; «Скидка, %» — не цена', () => {
    assert.equal(f('Скидка, %').field, 'skip')
    assert.equal(f('Цена без скидки').field, 'skip')
    assert.equal(f('Цена со скидкой, руб').field, 'price')
    const r = one([['Наименование', 'Ед.', 'Кол-во', 'Цена', 'Скидка, %', 'Цена со скидкой', 'Сумма'], ['Кран', 'шт', 2, 100, 10, 90, 180]])
    assert.equal(r.items[0].price, 90)
    const rrc = one([['Наименование', 'Кол-во', 'РРЦ', 'Ваша цена', 'Сумма'], ['Кран', 2, 100, 80, 160]])
    assert.equal(rrc.items[0].price, 80)
    const both = one([['Наименование', 'Кол-во', 'Цена, USD', 'Цена, руб.'], ['Кран', 2, 1, 95]])
    assert.deepEqual([both.items[0].price, both.currency], [95, null])
  })

  it('цена в валюте: документ это говорит, цена как есть; в рублях — не валюта', () => {
    assert.equal(one([['Наименование', 'Кол-во', 'Цена, USD', 'Сумма, USD'], ['Кран', 2, 10, 20]]).currency, 'USD')
    assert.equal(one([['Цены указаны в евро'], ['Наименование', 'Цена'], ['Кран', 10]]).currency, 'EUR')
    assert.equal(one([['Наименование', 'Цена, руб'], ['Кран', 10]]).currency, null)
    assert.equal(one([['Оплата в рублях по курсу USD ЦБ'], ['Наименование', 'Цена'], ['Кран', 10]]).currency, null, 'упоминание курса — не цены в валюте')
  })

  it('цена за 100 или 1000 единиц: из шапки и по сумме; не сходится иначе — пометка, цена не меняется', () => {
    const head = one([['Наименование', 'Ед.', 'Кол-во', 'Цена за 1000 шт', 'Сумма'], ['Болт', 'шт', 2000, 5000, 10000]])
    assert.deepEqual([head.items[0].price, head.items[0].per, head.items[0].sumOff], [5, 1000, false])
    const bySum = one([['Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма'], ['Болт', 'шт', 500, 330, 1650]])
    assert.deepEqual([bySum.items[0].price, bySum.items[0].per], [3.3, 100])
    const vat = one([['Наименование', 'Кол-во', 'Цена без НДС', 'Сумма с НДС'], ['Кран', 10, 100, 1220]])
    assert.deepEqual([vat.items[0].price, vat.items[0].per, vat.items[0].sumOff], [100, null, false], 'разница в НДС — не ошибка')
    const off = one([['Наименование', 'Кол-во', 'Цена', 'Сумма'], ['Кран', 10, 100, 5000]])
    assert.deepEqual([off.items[0].price, off.items[0].sumOff], [100, true])
    assert.equal(one([['Наименование', 'Цена за км', 'Сумма'], ['Кабель', 90000, 90000]]).items[0].unit, 'км', 'ед. изм. из шапки, если колонки нет')
  })

  it('два наименования: ищем по обоим, показываем предложенное; «Марка» — как артикул; колонка «В упаковке»', () => {
    const r = one([['Наименование по запросу', 'Предлагаемый товар', 'Тип, марка', 'Ед.', 'В упаковке', 'Цена'], ['Кран шаровой Ду15', 'Кран VT.214 1/2', 'VT.214', 'упак', '100 шт', 5000]])
    assert.deepEqual([r.items[0].name, r.items[0].name2, r.items[0].code, r.items[0].packQty], ['Кран VT.214 1/2', 'Кран шаровой Ду15', 'VT.214', 100])
    const groups = positionGroups([{ name: 'В', positions: [{ name: 'Кран шаровой Ду15', unit: 'шт', volume: 3, k: normName('Кран шаровой Ду15') }] }])
    const m = matchDocItems(r.items, groups, { packs: true })[0]
    assert.equal(m.match.exact, true, 'наименование по запросу совпало')
    assert.deepEqual([m.match.pack, m.match.unitOk], [100, true], 'сколько в упаковке — из колонки')
  })

  it('все видимые листы, без повторов и скрытых; итог документа сверяется со строками', () => {
    const wb = XLSX.utils.book_new()
    const add = (name, aoa, hidden = 0) => {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
      wb.Workbook ||= { Sheets: [] }
      wb.Workbook.Sheets ||= []
      wb.Workbook.Sheets.push({ name, Hidden: hidden })
    }
    add('Кабель', [['Наименование', 'Цена'], ['Кабель ВВГ', 10]])
    add('Лотки', [['Наименование', 'Цена'], ['Лоток 100х50', 20], ['Кабель ВВГ', 10]])
    add('Черновик', [['Наименование', 'Цена'], ['Старая цена', 1]], 1)
    const r = parseSupplierWorkbook(XLSX, readWorkbookBytes(XLSX, new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), 'к.xlsx'))
    assert.deepEqual(r.items.map((i) => [i.name, i.source]), [['Кабель ВВГ', 'лист «Кабель», строка 2'], ['Лоток 100х50', 'лист «Лотки», строка 2']])
    assert.equal(r.sheetName, 'Кабель, Лотки')
    const lost = one([['Наименование', 'Кол-во', 'Цена', 'Сумма'], ['Кран', 1, 100, 100], ['Всего', '', '', 150]])
    assert.deepEqual(lost.total, { ok: false, read: 100, doc: 150 })
    const fine = one([['Наименование', 'Кол-во', 'Цена без НДС', 'Сумма без НДС'], ['Кран', 1, 100, 100], ['Итого с НДС', '', '', 122]])
    assert.equal(fine.total.ok, true, 'итог с НДС поверх сумм без НДС сходится')
  })

  it('дата документа: из заголовка, словами, из имени файла', () => {
    assert.equal(docDateFromText('Спецификация № 201/1 от 02.11.2026'), '2026-11-02')
    assert.equal(docDateFromText('Заказ покупателя № 4804 от 02 ноября 2026 г.'), '2026-11-02')
    assert.equal(docDateFromText('Счет-Заказ №072813 от 27.10.26_1.pdf'), '2026-10-27')
    assert.equal(docDateFromText('КП 29.10.2026 СУ-10'), '2026-10-29')
    assert.equal(docDateFromText('Счёт без даты'), null)
  })

  it('единицы: тн = т, комп = компл, пара = пар; км, т и кг, тысячи — пересчёт; м3 и м2 — через толщину; поперёк единиц — нет', () => {
    const groupOf = (name, unit) => positionGroups([{ name: 'В', positions: [{ name, unit, volume: 10, k: normName(name) }] }])[0]
    assert.equal(groupUnitOk('тн', groupOf('Арматура', 'т')), true)
    assert.equal(groupUnitOk('комп', groupOf('Прибор', 'компл.')), true)
    assert.equal(groupUnitOk('пара', groupOf('Перчатки', 'пар')), true)
    assert.equal(groupUnitOk('метр', groupOf('Кабель', 'м. пог.')), true)
    assert.equal(groupUnitOk('шт', groupOf('Прибор', 'компл')), false)
    const pack = (name, unit, to, g) => docPack({ name, unit }, to, g)
    assert.equal(pack('Кабель ВВГ', 'км', 'м'), 1000)
    assert.equal(pack('Арматура', 'т', 'кг'), 1000)
    assert.equal(pack('Арматура', 'кг', 'т'), 0.001)
    assert.equal(pack('Болт', 'тыс. шт', 'шт'), 1000)
    assert.equal(pack('Болт', '100 шт', 'шт'), 100)
    assert.equal(pack('Утеплитель толщ. 50 мм', 'м3', 'м2'), 20)
    assert.equal(pack('Утеплитель', 'м3', 'м2', 'Утеплитель толщиной 100мм'), 10)
    assert.equal(pack('Утеплитель толщ. 50 мм', 'м2', 'м3'), 0.05)
    assert.equal(pack('Утеплитель', 'м3', 'м2'), null, 'толщина не сказана')
    assert.equal(pack('Стяжка', 'шт', 'уп', 'Стяжка СК-300 (100шт.)'), 0.01)
    assert.equal(pack('Арматура', 'м', 'шт', 'Арматура 35ГС 10мм, 11,7м'), 1 / 11.7)
  })

  it('артикул: кириллица вместо латиницы, съеденные Excel нули, «арт. PR13.0303» — не размер', () => {
    assert.deepEqual([...codeTokens('Труба арт. СТR12-032-3')], [...codeTokens('Труба арт. CTR12-032-3')])
    const groups = positionGroups([{ name: 'В', positions: [
      { name: 'Мини-канал ПВХ 25х17 мм, 2 м, арт. 00304, DKC', unit: 'м', volume: 10, k: normName('Мини-канал ПВХ 25х17 мм, 2 м, арт. 00304, DKC') },
      { name: 'Труба стальная арт. СТR12-032-3', unit: 'м', volume: 10, k: normName('Труба стальная арт. СТR12-032-3') },
    ] }])
    const items = [{ name: 'Кабель-канал белый', unit: 'м', code: '304', qty: 10, price: 5 }, { name: 'Труба ГЦ', unit: 'м', code: 'CTR12-032-3', qty: 10, price: 7 }]
    const res = matchDocItems(items, groups)
    assert.match(res[0].match.group.name, /Мини-канал/)
    assert.match(res[1].match.group.name, /Труба стальная/)
  })
})

// Автовыбор: одна цена на позицию по всем документам тендера.
describe('автовыбор цен по документам тендера', () => {
  const position = (name, unit, volume = 10) => ({ name, unit, volume, k: normName(name) })
  const groups = positionGroups([{ name: 'ОВ', positions: [
    position('Кран шаровой Ду15', 'шт'), position('Кабель ВВГнг 3х1,5', 'м', 305), position('Кран шаровой Ду20', 'шт'), position('Манометр общего назначения', 'шт'),
  ] }])
  const docOf = (id, date, lines) => ({ doc: { id, file_name: `${id}.xlsx`, created_at: '2026-10-01T00:00:00Z' }, offer: { date, currency: null, lines } })
  const line = (name, price, o = {}) => ({ name, unit: 'шт', qty: 10, price, skip: false, k: null, ...o })
  const rowsOf = (docs, opts = {}) => {
    const byGroup = offersByGroup(docs, groups)
    return autoPickRows(byGroup, groups, { currentOf: () => ({ own: [], copies: 0, empty: 1 }), ...opts })
  }
  const rowFor = (res, name) => res.rows.find((r) => r.group.name === name)

  it('то же наименование важнее дешёвого похожего; среди одинаковых — самый свежий документ; выбор человека важнее', () => {
    const docs = [
      docOf('a', '2026-10-01', [line('Кран шаровой Ду15', 100)]),
      docOf('b', '2026-10-20', [line('Кран шаровой Ду15', 120)]),
      docOf('c', '2026-10-25', [line('Кран шаровой полнопроходной латунный Ду15 PN40', 50)]),
    ]
    const r = rowFor(rowsOf(docs), 'Кран шаровой Ду15')
    assert.deepEqual([r.choice.price, r.choice.doc.id, r.sure, r.auto], [120, 'b', true, true])
    assert.equal(r.offers.length, 3, 'остальные — на выбор')
    assert.equal(r.offers[0].exact, true, 'самые похожие первыми')
    const similar = r.offers.find((o) => !o.exact)
    assert.equal(rowFor(rowsOf(docs, { chosen: new Map([[r.group.key, similar.id]]) }), 'Кран шаровой Ду15').choice.price, 50, 'ручной выбор важнее')
  })

  it('только похожие строки: самая похожая, а не самая дешёвая; до 60 % — показана, но не отмечена', () => {
    const near = 'Манометр специального назначения латунный'
    const far = 'Манометр точных измерений специальный корпусной'
    const res = rowFor(rowsOf([docOf('a', '2026-10-01', [line(near, 500)]), docOf('b', '2026-10-25', [line(far, 90)])]), 'Манометр общего назначения')
    assert.equal(res.choice.line.name, near, 'похожая строка важнее дешёвой и более свежей')
    assert.equal(res.check, true, 'не наверняка — на проверку')
    assert.equal(res.auto, res.choice.score >= 0.6)
  })

  it('высокая похожесть, но другая длина или марка — не «та же позиция»: на проверку, а не сама', () => {
    const position = 'Патч-корд UTP, кат. 5е, RJ45/RJ45, 5м'
    const gs = positionGroups([{ name: 'ОВ', positions: [{ name: position, unit: 'шт', volume: 4, k: normName(position) }] }])
    const res = autoPickRows(offersByGroup([docOf('a', '2026-10-01', [line('Патч-корд UTP, кат. 5е, RJ45/RJ45, 0,3м', 100)])], gs), gs, { currentOf: () => ({ own: [], copies: 0, empty: 1 }) })
    for (const r of res.rows) assert.deepEqual([r.sure, r.check], [false, true])
  })

  it('что показывать: цена стоит правильно — строки нет; свежий документ заменяет цену из старого; руками после загрузки — решение человека', () => {
    const name = 'Кран шаровой Ду15'
    const cur = (own, ownAt) => () => ({ own, copies: 0, empty: 0, ownAt })
    const stamp = (id, created, date, price) => ({ doc: { id, file_name: `${id}.xlsx`, created_at: created }, offer: { date, currency: null, lines: [line(name, price)] } })
    const a = stamp('a', '2026-10-30T10:00:00Z', '2026-10-30', 100)
    const b = stamp('b', '2026-11-02T10:00:00Z', '2026-11-02', 120)
    // Та же цена — нет строки.
    const same = rowsOf([a], { currentOf: cur([100], '2026-11-05T09:00:00Z') })
    assert.deepEqual([same.rows.length, same.hidden], [0, 1])
    // Цена поставлена сегодня из A, загружен B: свежее A, хотя дата B раньше дня ввода цены, — заменит и отмечено.
    const fresh = rowFor(rowsOf([a, b], { currentOf: cur([100], '2026-11-05T09:00:00Z') }), name)
    assert.deepEqual([fresh.choice.doc.id, fresh.choice.price, fresh.status.kind, fresh.auto], ['b', 120, 'replace', true])
    // Руками до загрузки документа — документ свежее; после — решение человека, строки нет.
    const before = rowFor(rowsOf([a], { currentOf: cur([90], '2026-10-01T09:00:00Z') }), name)
    assert.deepEqual([before.status.kind, before.auto], ['replace', true])
    assert.equal(rowsOf([a], { currentOf: cur([90], '2026-11-01T09:00:00Z') }).rows.length, 0)
    // Просто похожая строка — не повод считать свою цену неверной.
    const analog = stamp('c', '2026-11-02T10:00:00Z', '2026-11-02', 300)
    analog.offer.lines = [line('Кран шаровой полнопроходной латунный Ду15 PN40', 300)]
    assert.equal(rowsOf([analog], { currentOf: cur([100], '2026-10-01T09:00:00Z') }).rows.length, 0)
  })

  it('своя цена похожа на ошибку — показывается, даже если введена после документа; разброс цен — отметку ставит человек', () => {
    const name = 'Кран шаровой Ду15'
    const doc = { doc: { id: 'a', file_name: 'a.xlsx', created_at: '2026-10-30T10:00:00Z' }, offer: { date: '2026-10-30', currency: null, lines: [line(name, 100)] } }
    const wrong = rowFor(rowsOf([doc], { currentOf: () => ({ own: [900], copies: 0, empty: 0, ownAt: '2026-11-05T09:00:00Z' }) }), name)
    assert.deepEqual([wrong.status.kind, !!wrong.wrong], ['replace', true])
    const spread = rowFor(rowsOf([docOf('a', '2026-10-01', [line(name, 100)]), docOf('b', '2026-10-20', [line(name, 500)])]), name)
    assert.deepEqual([spread.spread, spread.auto, spread.check], [5, false, true])
  })

  it('не берётся сама: другая ед. изм. без пересчёта, цена × кол-во ≠ сумма, цены в валюте; строка видна, человек решает', () => {
    const unit = rowFor(rowsOf([docOf('a', null, [line('Кран шаровой Ду15', 100, { unit: 'упак' })])]), 'Кран шаровой Ду15')
    assert.deepEqual([unit.choice, unit.shown.unitOk, unit.auto], [null, false, false])
    const off = rowFor(rowsOf([docOf('a', null, [line('Кран шаровой Ду15', 100, { sumOff: true })])]), 'Кран шаровой Ду15')
    assert.deepEqual([off.choice, off.shown.price, off.check], [null, 100, true])
    const fx = rowsOf([{ doc: { id: 'a', file_name: 'a' }, offer: { currency: 'USD', lines: [line('Кран шаровой Ду15', 100)] } }])
    assert.equal(fx.rows.length, 0)
    const k = normName('Манометр общего назначения')
    const picked = rowFor(rowsOf([docOf('a', null, [line('Что-то своё', 70, { k }), line('Кран шаровой Ду15', 100, { skip: true })])]), 'Манометр общего назначения')
    assert.deepEqual([picked.choice.price, picked.choice.picked], [70, true])
  })

  it('выбор человека при строке: отказ больше не предлагает, указанный пересчёт — цена за единицу позиции; строки без позиции — отдельно', () => {
    const name = 'Кран шаровой Ду15'
    const k = normName(name)
    const refused = rowsOf([docOf('a', null, [line(name, 100, { no: [k] })])])
    assert.equal(rowFor(refused, name), undefined, 'отвергнутая строка не возвращается')
    const docs = [docOf('a', null, [line(name, 100, { no: [k] }), line('Болт М12х80', 15)])]
    const placed = offersByGroup(docs, groups)
    assert.deepEqual(unplacedLines(docs, placed).map((u) => u.line.name).sort(), ['Болт М12х80', name].sort())
    const packed = rowFor(rowsOf([docOf('a', null, [line(name, 1000, { unit: 'упак', packs: { [k]: 50 } })])]), name)
    assert.deepEqual([packed.choice.price, packed.choice.pack, packed.choice.unitOk], [20, 50, true])
    // Строка выбрана для позиции: другие её позиции остаются, отказ снимается; отказ — снимает выбор.
    const chosen = lineForGroup({ k: 'x', also: [], no: [k] }, [k])
    assert.deepEqual([chosen.k, chosen.also, chosen.no], ['x', [k], []])
    const declined = lineNotForGroup(chosen, [k])
    assert.deepEqual([declined.k, declined.also, declined.no], ['x', [], [k]])
    assert.deepEqual([lineNotForGroup({ k, also: [] }, [k]).k], [null], 'других нет — строка снова ищет сама')
    const round = readOffer(offerNotes({ lines: [{ name, price: 10, no: [k], packs: { [k]: 5 } }] })).lines[0]
    assert.deepEqual([round.no, round.packs], [[k], { [k]: 5 }], 'и то и другое хранится при файле')
  })

  it('НДС и курс у файла: строки пересчитываются; «как есть» в обе стороны — та же цена', () => {
    const offer = { vat: { mode: 'gross', rate: 22 }, delivery: 1, lines: [{ name: 'А', price: 100, docPrice: 100 }] }
    assert.equal(offerVatMode(offer), 'gross')
    const net = offerWithVat(offer, 'net')
    assert.equal(net.lines[0].price, 122)
    assert.equal(offerVatMode(net), 'net')
    assert.equal(offerWithVat(net, 'gross').lines[0].price, 100)
    assert.equal(offerWithVat(offer, 'gross'), offer, 'тот же режим — без изменений')
    const rub = offerInRoubles({ currency: 'USD', lines: [{ name: 'А', price: 10 }] }, 90)
    assert.deepEqual([rub.currency, rub.lines[0].price], [null, 900])
  })

  it('пересчёт, после которого количество не похоже на объём, сам не берётся: неверная упаковка или ед. изм. в ВОР', () => {
    const near = rowFor(rowsOf([docOf('a', null, [line('Кабель ВВГнг 3х1,5 305м', 16775, { qty: 1 })])]), 'Кабель ВВГнг 3х1,5')
    assert.deepEqual([near.choice?.price, near.choice?.pack], [55, 305])
    const far = rowFor(rowsOf([docOf('a', null, [line('Кабель ВВГнг 3х1,5 305м', 16775, { qty: 50 })])]), 'Кабель ВВГнг 3х1,5')
    assert.equal(far.choice, null)
    assert.equal(far.offers[0].qtyFar, true)
  })

  it('своя цена подозрительна: цена бухты вместо цены за метр; в 5 раз от того же наименования; близкая — нет', () => {
    const offer = (o) => ({ line: { price: 16764.53, unit: 'шт', doc: { file_name: 'с.xls' } }, pack: 305, unitOk: true, article: true, exact: false, picked: false, ...o })
    assert.equal(suspectPrice(16764.53, [offer()]).kind, 'pack')
    const plainOffer = { line: { price: 100, unit: 'шт', doc: { file_name: 'с.xls' } }, pack: null, unitOk: true, exact: true }
    const far = suspectPrice(900, [plainOffer])
    assert.deepEqual([far.kind, far.times, far.higher], ['far', 9, true])
    assert.equal(suspectPrice(120, [plainOffer]), null)
    assert.equal(suspectPrice(900, [{ ...plainOffer, exact: false, score: 0.7 }]), null, 'аналог может стоить иначе')
    assert.equal(suspectPrice(null, [plainOffer]), null)
  })
})

// Одна и та же позиция в разных ВОР (решение пользователя 05.11.2026: схлопывать, кроме неуверенных, меньше 90 %). Пары — с копии базы:
// похожесть текста от 0,9 склеивала и разные материалы, поэтому «уверенность» строже похожести.
describe('одна и та же позиция в разных ВОР', () => {
  const group = (name, unit = 'шт', doc = 'А') => positionGroups([{ name: doc, positions: [{ name, unit, volume: 10, k: normName(name) }] }])[0]
  const conf = (a, b, unit = 'шт') => positionConfidence(group(a, unit, 'А'), group(b, unit, 'Б'))

  for (const [a, b, unit] of [
    ['Шаровой кран полнопроходной DN25 R850X025', 'Кран шаровой полнопроходной, резьба ВН/ВН, DN25 R850X025 Giacomini'],
    ['Клапан балансировочный статический DN15 R206BY003', 'Клапан балансировочный статический с измерительными штуцерами со сливом DN15 R206BY003 Giacomini'],
    ['Фланец свободный металлический Ø225', 'Фланец свободный металлический Ф225'],
    ['Трубопровод из стальных ВГП оц. труб Ø20x2,8', 'Трубопровод из стальных водогазопроводных оцинкованных труб Ø20x2.8', 'м'],
    ['Прут 10х10 мм', 'Прут 10х10 мм ГОСТ 2591-2006', 'т'],
    ['Коммутатор на 8 портов Sonar SNA-800 (шт)', 'Коммутатор на 8 портов Sonar SNA-800 (Калибр+) (шт)'],
  ]) {
    it(`одно и то же: «${a}» = «${b}»`, () => assert.ok(conf(a, b, unit) >= 0.9, String(conf(a, b, unit))))
  }
  for (const [a, b, unit] of [
    ['Трубопровод из стальных водогазопроводных неоцинкованных труб Ø20x2.8', 'Трубопровод из стальных водогазопроводных оцинкованных труб Ø20x2.8', 'м'],
    ['Патч-корд UTP, кат. 5е, RJ45/RJ45, 0,3м (шт)', 'Патч-корд UTP, кат. 5е, RJ45/RJ45, 5м (шт)'],
    ['Модуль адресный релейный РМ-4К (шт)', 'Модуль адресный релейный РМ-4 (шт)'],
    ['Коллектор этажный на 5 отводов 0-Л-32-Ф-Р25', 'Коллектор этажный на 6 отводов 0-Л-32-Ф-Р32'],
    ['Шкаф управления ШУН/В-1,5-03-УК15-R3 (шт)', 'Шкаф управления ШУН/В-1,5-03-ПЧ/УК15-R3 (шт)'],
    ['Крышка д/угла гориз. 90гр. осн.100 (0,7мм) ДКС (шт)', 'Консоль с опорой ML осн.100 ДКС (шт)'],
    ['Теплосчётчик Пульсар модификации У DN 15 RS-485', 'Счетчик воды крыльчатый DN15 (RS485), универсальный'],
    ['Винт М6х10 оц. (шт)', 'Винт М6х10 (шт)'],
    ['Шпилька М12х1000', 'Анкер М12х1000'],
    ['Кабель ВВГнг-FRLS 4*1,5 (м)', 'Кабель ВВГнг-LS 4*1,5 (м)', 'м'],
  ]) {
    it(`разное: «${a}» ≠ «${b}»`, () => assert.ok(conf(a, b, unit) < 0.9, String(conf(a, b, unit))))
  }
  it('другая ед. изм. — не одно и то же; та же, записанная иначе, — одно', () => {
    assert.equal(positionConfidence(group('Кран шаровой Ду15', 'шт', 'А'), group('Кран шаровой Ду15', 'компл', 'Б')), 0)
    assert.equal(positionConfidence(group('Кран шаровой Ду15', 'шт', 'А'), group('Кран шаровой Ду15', 'шт.', 'Б')), 1)
  })
  const views = (...docs) => docs.map(([name, list]) => ({ name, positions: list.map(([n, unit = 'шт', volume = 10]) => ({ name: n, unit, volume, k: normName(n) })) }))
  it('складывает разные ВОР, ищется по любой записи; разделённое и уже разное — отдельно; один ВОР не складывает', () => {
    const a = 'Шаровой кран полнопроходной DN25 R850X025'
    const b = 'Кран шаровой полнопроходной, резьба ВН/ВН, DN25 R850X025 Giacomini'
    const groups = positionGroups(views(['ОВ', [[a], ['Хомут монтажный']]], ['ВК', [[b], ['Хомут монтажный']]]))
    assert.equal(groups.length, 3)
    const merged = mergeSamePositions(groups)
    assert.equal(merged.length, 2)
    const pipe = merged.find((g) => g.name === a)
    assert.deepEqual(pipe.targets.map((t) => t.doc), ['ОВ', 'ВК'])
    assert.deepEqual([pipe.sameAs.length, pipe.sameAs[0].name], [1, b])
    assert.deepEqual(pipe.ks, [normName(a), normName(b)])
    assert.equal(itemCandidates({ name: b, unit: 'шт' }, merged)[0].exact, true, 'строка счёта находит позицию по второй записи')
    assert.equal(mergeSamePositions(groups, { split: new Set([pipe.key]) }).length, 3, 'разделённое не складывается')
    const one = positionGroups(views(['ОВ', [[a], [b]]]))
    assert.equal(mergeSamePositions(one).length, 2, 'сметчик записал их разными строками')
    const both = positionGroups(views(['ОВ', [[a], [b]]], ['ВК', [[b]]]))
    assert.equal(mergeSamePositions(both).length, 2, 'в ОВ это разные строки, значит, и в ВК складывать только с той же записью')
  })
  it('цепочка: A = B и B = C ещё не значит A = C', () => {
    const a = 'Кран шаровой полнопроходной DN15 R850X023 Giacomini'
    const b = 'Кран шаровой полнопроходной DN15 R850X023'
    const c = 'Кран шаровой полнопроходной DN15 R850X023 Valtec'
    const merged = mergeSamePositions(positionGroups(views(['А', [[a]]], ['Б', [[b]]], ['В', [[c]]])))
    assert.ok(merged.length <= 2)
    for (const g of merged) for (const s of g.sameAs || []) assert.ok(s.confidence >= 0.9)
  })
  it('подсветка отличий: совпавшее не отмечено; другой размер, марка — отмечены; сокращение и порядок слов — не отличие', () => {
    const marks = (x, y) => nameDiff(x, y).filter((p) => p.differs).map((p) => p.text.trim())
    assert.deepEqual(marks('Герметик FIREFIX 310 мл', 'Герметик FIREFIX 600 мл'), ['310'])
    assert.deepEqual(marks('Труба ВГП Ø20', 'Труба водогазопроводная Ø20'), [])
    assert.deepEqual(marks('Кран шаровой Ду15', 'Шаровой кран Ду15'), [])
    assert.deepEqual(marks('Труба медная 12,7 мм', 'труба медная ∅12.7'), [], 'число с запятой — одно значение')
    assert.equal(nameDiff('Кабель ВВГ, 3х1,5', 'Кабель').map((p) => p.text).join(''), 'Кабель ВВГ, 3х1,5', 'текст не теряется')
  })
})

// Тендер № 821 и № 845 (02.11.2026): те же наименования, у одного м2, у другого м3. Сами не подставляются, в похожих — с пометкой.
describe('цены других тендеров в другой ед. изм.', () => {
  const N50 = 'Минераловатный утеплитель "Rockwool" толщ. 50 мм, плотностью 90 кг/м3'
  const N100 = 'Минераловатный утеплитель "Rockwool" толщ. 100 мм, плотностью 36 кг/м3'
  const pos = (name, unit, volume) => ({ name, unit, volume, k: normName(name) })
  const vor144 = [pos('Лист 0,7 оц. с полимерным покрытием, RAL', 'м2', 258.3915), pos(N100, 'м2', 27.838), pos(N50, 'м2', 13.919), pos('Расходные материалы для монтажа утеплителя', 'м2', 278.38)]
  const rate = (id, name, unit, price, date = '2026-11-02') => ({ id, tender_id: 't845', tender_number: 845, estimate_name: 'ВОР 14.5', material_name: name, material_key: normName(name), unit, price, price_date: date })
  const index = otherUnitIndex([rate('r50', N50, 'м3', 8198.89), rate('r100', N100, 'м3', 3759.17)])

  it('№ 821 поз. 16, 17: та же позиция из № 845 — в списке, цена за м3 как есть: объём позиции сам в м3 (ошибка ед. изм. в ВОР), пересчёт занизил бы итог', () => {
    const [o] = otherUnitPrices(vor144[1], index, vor144)
    assert.deepEqual([o.rate.id, o.sameName, o.spelled, o.converted], ['r100', true, false, null])
    assert.deepEqual(o.cubic, { area: 278.38, thickness: 0.1 })
    const [o50] = otherUnitPrices(vor144[2], index, vor144)
    assert.equal(o50.rate.id, 'r50')
    assert.equal(o50.cubic.area, 278.38, 'ближайшая площадь, а не первая подходящая (258,39 м2 листа)')
  })

  it('объём в м2 на самом деле: пересчёт через толщину; та же ед. изм. — не здесь, это дело базы; другая запись единицы — как есть', () => {
    const area = [pos(N50, 'м2', 278.38), pos('Расходные материалы для монтажа утеплителя', 'м2', 278.38)]
    const o = otherUnitPrices(area[0], index, area).find((x) => x.rate.id === 'r50')
    assert.equal(o.cubic, null)
    assert.deepEqual(o.converted, { price: 409.94, pack: 20 })
    assert.deepEqual(otherUnitPrices(pos(N50, 'м3', 20), index), [], 'в той же ед. изм. подбирает база')
    const steel = 'Арматура А500 d12'
    const [t] = otherUnitPrices(pos(steel, 'т', 5), otherUnitIndex([rate('s', steel, 'тн', 70000)]))
    assert.deepEqual([t.spelled, t.converted], [true, null])
    const [kg] = otherUnitPrices(pos(steel, 'кг', 500), otherUnitIndex([rate('s', steel, 'т', 70000)]))
    assert.deepEqual(kg.converted, { price: 70, pack: 1000 })
    assert.deepEqual([...otherUnitPrices(pos(steel, 'м', 5), otherUnitIndex([rate('s', steel, 'кг', 70)]))].map((x) => x.converted), [null], 'пересчёт неизвестен — цена видна, решает человек')
  })

  it('похожие наименования — тоже; то же наименование выше; чужое слово — нет', () => {
    const near = 'Минераловатный утеплитель "Rockwool" толщ. 50 мм плотность 90 кг/м3'
    const list = otherUnitPrices(pos(N50, 'м2', 10), otherUnitIndex([rate('near', near, 'м3', 8000, '2026-11-03'), rate('same', N50, 'м3', 8198.89), rate('other', 'Кран шаровой Ду15', 'м3', 100)]))
    assert.deepEqual(list.map((x) => [x.rate.id, x.sameName]), [['same', true], ['near', false]])
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
