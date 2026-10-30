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
import { classifyHeader, deliveryUnitWithVat, parseNum, rulingsFromOps, unitPriceWithVat, vatFromText } from '../../src/utils/supplierDoc.js'
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
