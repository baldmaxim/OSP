// Реестр расценок → «Договорные расценки (Larix)» → «Проверить по файлу» — правила без базы и браузера: поиск аналогов
// среди договорных расценок (вес слов по редкости, разные размеры и марки — не аналог, приписки версии прайса не мешают),
// какая из двух цен сравнивается, одна цена подрядчика по объекту, ед. изм. (кг и т), разбор файла (незаполненный ВОР, две
// колонки цены), итоги и выгрузка. Данные вымышленные.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  ANALOG_MIN, CONTRACT_EXPORT_HEADERS, checkContractLines, cleanRateName, contractExportRows, contractIndex, contractStats, contractSummary,
  isWorkName, lineCandidates, lineMode, periodSince, pricePoints, rowPrice, splitPriceParts, unitFactor,
} from '../../src/utils/larixRateCheck.js'
import { readBidPriceDoc } from '../../src/utils/bidImport.js'

let seq = 0
const row = (item_name, unit, price_material, price_work = null, extra = {}) => ({
  id: ++seq, item_name, unit, price_material, price_work, contractor_id: 1, contractor_name: 'ООО Подряд', project_id: 1, project_name: 'ЖК Стенд',
  contract_id: 10, contract_number: 'Д-1', contract_date: '2026-05-01', object_type: 'Договор', comment: null, osp_contract_id: null, ...extra,
})
const item = (name, unit = 'шт', price = 100, extra = {}) => ({ name, unit, qty: 10, price, priceVat: 'gross', sum: null, sumVat: null, ...extra })
// Посторонние строки реестра: без них у редких и частых слов один вес.
const filler = () => Array.from({ length: 200 }, (_, i) => row(`Монтаж прочего оборудования шкаф кабель ${i}`, 'шт', 1000 + i))

const verdicts = (rows, lineItem) => {
  const ix = contractIndex([...filler(), ...rows])
  const cands = lineCandidates(lineItem, ix)
  return cands.map((c) => ({ name: c.group.name, analog: c.analog, apart: c.apart, weak: c.weak, exact: c.exact }))
}
const analogNames = (rows, lineItem) => verdicts(rows, lineItem).filter((c) => c.analog).map((c) => c.name)

describe('Договорные расценки: поиск аналогов', () => {
  it('приписки версии прайса и единица в скобках — не часть наименования', () => {
    assert.equal(cleanRateName('Изготовление гильз до Ду 50 (Дн 57) мм (04.24г)'), 'Изготовление гильз до Ду 50 (Дн 57) мм')
    assert.equal(cleanRateName('Монтаж трубы ( 04.25г )'), 'Монтаж трубы')
    assert.equal(cleanRateName('Теплоизоляция цилиндрами (07.2020г)'), 'Теплоизоляция цилиндрами')
    assert.equal(cleanRateName('Стеклопакет 28мм (шт) (июнь)'), 'Стеклопакет 28мм')
    assert.equal(cleanRateName('Кабель ВВГ 3х2,5 (м)'), 'Кабель ВВГ 3х2,5')
    // Разные версии одной расценки — одно наименование, а не «разные числа».
    const v = verdicts([row('Монтаж трубы ПНД Д: до 50 мм (04.24г)', 'м', null, 100), row('Монтаж трубы ПНД Д: до 50 мм (04.25г)', 'м', null, 120)],
      item('Монтаж трубы ПНД Д: до 50 мм', 'м'))
    assert.equal(v[0].exact, true)
    assert.equal(v.filter((c) => c.exact).length, 1)
  })

  it('разные размеры и числа у обеих сторон — не аналог, как бы ни совпали слова', () => {
    const rows = [row('Кабель ВВГнг(А)-LS 3х2,5', 'м', 100), row('Кабель ВВГнг(А)-LS 4х16', 'м', 900),
      row('Затвор дисковый 65 / Machaon BFV DN65 PN16', 'шт', 6000), row('Затвор дисковый 100 / Machaon BFV DN100 PN16', 'шт', 9000)]
    assert.deepEqual(analogNames(rows, item('Кабель ВВГнг(А)-LS 3х2,5', 'м')), ['Кабель ВВГнг(А)-LS 3х2,5'])
    const zatvor = verdicts(rows, item('Затвор дисковый 100 Machaon BFV DN100 PN16'))
    assert.deepEqual(zatvor.filter((c) => c.analog).map((c) => c.name), ['Затвор дисковый 100 / Machaon BFV DN100 PN16'])
    assert.ok(zatvor.some((c) => c.name.includes('DN65') && c.apart && !c.analog), 'другой диаметр виден как возможный')
  })

  it('разные марки: М-50 и М150, другая марка кабеля — не аналог; своя марка в другом написании — аналог', () => {
    const rows = [row('Керамзитобетон М150', 'м3', 8000), row('Керамзитобетон М-50', 'м3', 6000), row('Кабель ППГнг(А)-HF 3х2,5', 'м', 300),
      row('Кабель ВВГ нг LS 3*2.5', 'м', 100)]
    assert.deepEqual(analogNames(rows, item('Керамзитобетон М50', 'м3')), ['Керамзитобетон М-50'])
    assert.deepEqual(analogNames(rows, item('Кабель ВВГнг(А)-LS 3х2,5', 'м')), ['Кабель ВВГ нг LS 3*2.5'], 'запись марки и размера не важна, ППГ — другая марка')
  })

  it('одно редкое слово решает больше, чем много частых: «Шкаф АСКУЭ-2» и «Шкаф распределительный наружный-2» — разные', () => {
    const rows = [row('Шкаф АСКУЭ-2', 'шт', 15000), row('Шкаф 2', 'шт', 500)]
    assert.ok(!analogNames(rows, item('Шкаф распределительный наружный PR SHNG-2')).includes('Шкаф АСКУЭ-2'))
  })

  it('«вентиль» — не «вентилятор»: начало слова совпадает только у сокращения с точкой', () => {
    const rows = [row('Монтаж вентиляторов', 'шт', null, 49000), row('Труба оцинкованная Ду 20', 'м', 300)]
    assert.deepEqual(analogNames(rows, item('Монтаж вентиля пожарного')), [])
    assert.deepEqual(analogNames(rows, item('Труба оцинк. Ду 20', 'м')), ['Труба оцинкованная Ду 20'])
  })

  it('«Ду 25» и «Ду 25*3,2» — один размер; опечатка в конце слова не мешает', () => {
    const rows = [row('Труба стальная Ду 25*3,2', 'м', 170), row('Труба стальная Ду 32*3,2', 'м', 190), row('Монтаж безраструбнных чугунных труб Ду 50', 'м', null, 500)]
    assert.deepEqual(analogNames(rows, item('Труба стальная Ду 25', 'м')), ['Труба стальная Ду 25*3,2'])
    assert.deepEqual(analogNames(rows, item('Монтаж безраструбных чугунных труб Ду 50', 'м')), ['Монтаж безраструбнных чугунных труб Ду 50'])
  })

  it('слово только у одной стороны — уточнение, и порядок слов не важен', () => {
    const rows = [row('Кабель силовой ВВГнг-LS 5х16', 'м', 900), row('Лоток перфорированный оцинкованный 100х50', 'м', 450)]
    assert.deepEqual(analogNames(rows, item('Кабель ВВГнг-LS 5х16', 'м')), ['Кабель силовой ВВГнг-LS 5х16'])
    assert.deepEqual(analogNames(rows, item('Оцинкованный перфорированный лоток 100х50', 'м')), ['Лоток перфорированный оцинкованный 100х50'])
  })

  it('размер только у одной стороны, работа против материала, другое главное слово — только «возможные»', () => {
    const rows = [row('Лоток перфорированный', 'м', 450), row('Монтаж сетки 100х100', 'м2', 145, 1120), row('Декоративная штукатурка', 'м2', 800)]
    const lot = verdicts(rows, item('Лоток перфорированный 200х100', 'м'))
    assert.deepEqual(lot.filter((c) => c.analog), [])
    assert.ok(lot.some((c) => c.name === 'Лоток перфорированный' && c.weak))
    const net = verdicts(rows, item('Сетка 100х100', 'м2'))
    assert.deepEqual(net.filter((c) => c.analog), [])
    assert.deepEqual(analogNames(rows, item('Грунтовка под декоративную штукатурку', 'м2')), [])
  })

  it('артикул сам по себе не довод, с общими словами — аналог', () => {
    const rows = [row('Коробка ответвительная, арт.53800, ДКС', 'шт', 300), row('Установка приточная L=1015 м3/ч', 'шт', 45000)]
    assert.deepEqual(analogNames(rows, item('Коробка распаячная IP55, арт. 53800')), ['Коробка ответвительная, арт.53800, ДКС'])
    assert.deepEqual(analogNames(rows, item('Дверной блок L=1015')), [])
  })

  it('порог: то же наименование — всегда, почти такое же — от ANALOG_MIN', () => {
    assert.ok(ANALOG_MIN > 0.5)
    const v = verdicts([row('Бетон B25', 'м3', 8000), row('Бетон В25 (М350)', 'м3', 7000)], item('Бетон В25', 'м3'))
    assert.deepEqual(v.map((c) => [c.name, c.exact, c.analog]), [['Бетон B25', true, true], ['Бетон В25 (М350)', false, true]])
  })
})

describe('Договорные расценки: какая цена и какая единица', () => {
  it('работа и материал по первому слову', () => {
    assert.equal(isWorkName('Монтаж лотка'), true)
    assert.equal(isWorkName('  Устройство стяжки'), true)
    assert.equal(isWorkName('Лоток перфорированный'), false)
    assert.equal(isWorkName('Кабель силовой'), false)
  })

  it('вид из файла важнее выбора в окне; выбор в окне важнее догадки по строке', () => {
    assert.equal(lineMode(item('Кабель', 'м', 1, { kindHint: 'work' }), 'material'), 'work')
    assert.equal(lineMode(item('Кабель'), 'work'), 'work')
    assert.equal(lineMode(item('Монтаж кабеля')), 'total')
    assert.equal(lineMode(item('Кабель')), 'position')
  })

  it('цена строки: материалы, работы, обе; цены нет — null', () => {
    const both = row('Х', 'м', 100, 40)
    const work = row('Х', 'м', null, 40)
    assert.equal(rowPrice(both, 'material'), 100)
    assert.equal(rowPrice(both, 'work'), 40)
    assert.equal(rowPrice(both, 'total'), 140)
    assert.equal(rowPrice(both, 'position'), 100)
    assert.equal(rowPrice(work, 'material'), null)
    assert.equal(rowPrice(work, 'position'), 40, 'нет цены материалов — цена работ');
    assert.equal(rowPrice(work, 'total'), 40)
  })

  it('единицы: записи одного и того же, кг и т пересчитываются, остальное — другая единица', () => {
    assert.equal(unitFactor('м', 'м.пог.'), 1)
    assert.equal(unitFactor('п.м.', 'м. пог.'), 1)
    assert.equal(unitFactor('шт.', 'штук'), 1)
    assert.equal(unitFactor('компл.', 'комплекс'), 1)
    assert.equal(unitFactor('к-с', 'комплект'), 1)
    assert.equal(unitFactor('тн', 'т'), 1)
    assert.equal(unitFactor('т', 'кг'), 1000)
    assert.equal(unitFactor('кг', 'т'), 0.001)
    assert.equal(unitFactor('м2', 'м3'), null)
    assert.equal(unitFactor('м', 'шт'), null)
    assert.equal(unitFactor(null, 'шт'), 1, 'не указана — не мешает')
  })

  it('договор и его ДС: от подрядчика на объекте — цена самого свежего документа; разные подрядчики и объекты — разные цены', () => {
    const rows = [
      row('Х', 'м', 100, null, { contract_date: '2025-01-01' }),
      row('Х', 'м', 110, null, { contract_date: '2026-01-01' }),
      row('Х', 'м', 110, null, { contract_date: '2026-01-01', contract_id: 11 }), // та же цена в другом ДС той же даты
      row('Х', 'м', 130, null, { contractor_id: 2, contract_date: '2025-06-01' }),
      row('Х', 'м', 140, null, { project_id: 2, contract_date: '2025-06-01' }),
    ]
    const { points } = pricePoints(rows, { unit: 'м', mode: 'material' })
    assert.deepEqual(points.map((p) => p.price).sort((a, b) => a - b), [110, 130, 140])
    assert.equal(points.find((p) => p.price === 110).older, 1)
    const stats = contractStats(points)
    assert.deepEqual([stats.n, stats.min, stats.median, stats.max, stats.contractors], [3, 110, 130, 140, 2])
  })

  it('разные цены в одном свежем документе остаются; период отсекает старые; другая единица — отдельно', () => {
    const rows = [row('Х', 'м', 100), row('Х', 'м', 120), row('Х', 'шт', 5000), row('Х', 'м', 90, null, { contractor_id: 2, contract_date: '2020-01-01' })]
    const all = pricePoints(rows, { unit: 'м', mode: 'material' })
    assert.deepEqual(all.points.map((p) => p.price).sort((a, b) => a - b), [90, 100, 120])
    assert.equal(all.otherUnit.length, 1)
    const fresh = pricePoints(rows, { unit: 'м', mode: 'material', since: '2025-01-01' })
    assert.deepEqual(fresh.points.map((p) => p.price).sort((a, b) => a - b), [100, 120])
  })

  it('кг в договоре и т в файле: цена пересчитана на единицу файла', () => {
    const { points } = pricePoints([row('Арматура', 'кг', 70)], { unit: 'т', mode: 'material' })
    assert.equal(points[0].price, 70000)
  })

  it('период: месяцы назад, конец месяца не перескакивает', () => {
    assert.equal(periodSince(0, '2026-11-02'), null)
    assert.equal(periodSince(6, '2026-11-02'), '2026-05-02')
    assert.equal(periodSince(12, '2026-11-02'), '2025-11-02')
    assert.equal(periodSince(6, '2026-08-31'), '2026-02-28')
  })
})

describe('Договорные расценки: строки проверки', () => {
  const rows = [
    row('Кабель ВВГнг-LS 3х2,5', 'м', 100, null, { contractor_id: 1 }),
    row('Кабель ВВГнг-LS 3х2,5 (м)', 'м', 140, null, { contractor_id: 2, contractor_name: 'ООО Другой' }),
    row('Кабель силовой ВВГнг-LS 3х2,5', 'м', 500, null, { contractor_id: 3 }),
    row('Кабель силовой ВВГнг-LS медный 3х2,5 пониженной горючести', 'м', 700, null, { contractor_id: 4 }),
    row('Устройство стяжки цементной 50 мм', 'м2', 400, 900),
    row('Устройство стяжки цементной 50 мм', 'м2', null, 1000, { contractor_id: 2 }),
    row('Монтаж кабеля ВВГнг-LS 3х2,5', 'м', null, 50),
  ]
  const run = (items, opts) => {
    const ix = contractIndex([...filler(), ...rows])
    const cands = new Map(items.map((it, i) => [i, lineCandidates(it, ix)]))
    return checkContractLines(items, cands, opts)
  }

  it('есть то же наименование — медиана по нему; похожие видны, но не считаются', () => {
    const [l] = run([item('Кабель ВВГнг-LS 3х2,5', 'м', 180)])
    assert.deepEqual([l.stats.n, l.stats.min, l.stats.median, l.stats.max], [2, 100, 120, 140])
    assert.equal(l.dev, 50)
    assert.equal(l.verdict, 'high')
    assert.ok(l.possible.some((p) => p.row.price_material === 500 && !p.on))
    assert.ok(!l.analogs.some((p) => p.row.item_name.startsWith('Монтаж')), 'работа в сравнение материала не идёт')
  })

  it('человек снимает расценку и включает возможную — медиана пересчитывается', () => {
    const [l] = run([item('Кабель ВВГнг-LS 3х2,5', 'м', 180)])
    const off = l.analogs.find((p) => p.row.price_material === 140)
    const on = l.possible.find((p) => p.row.price_material === 500)
    const [l2] = run([item('Кабель ВВГнг-LS 3х2,5', 'м', 180)], { choices: new Map([[`0|${off.row.id}`, false]]) })
    assert.deepEqual([l2.stats.n, l2.stats.median], [1, 100])
    assert.equal(l2.analogs.find((p) => p.row.price_material === 140).on, false, 'снятая видна и снята')
    const [l3] = run([item('Кабель ВВГнг-LS 3х2,5', 'м', 180)], { choices: new Map([[`0|${on.row.id}`, true]]) })
    assert.deepEqual([l3.stats.n, l3.stats.median], [3, 140])
  })

  it('две цены строки реестра: материал — с ценой материалов, работа — с ценой работ, монтаж без вида — с обеими', () => {
    const material = run([item('Устройство стяжки цементной 50 мм', 'м2', 400, { kindHint: 'material' })])[0]
    assert.deepEqual([material.stats.n, material.stats.median, material.verdict], [1, 400, 'ok'])
    const work = run([item('Устройство стяжки цементной 50 мм', 'м2', 950, { kindHint: 'work' })])[0]
    assert.deepEqual([work.stats.n, work.stats.median, work.verdict], [2, 950, 'ok'])
    const whole = run([item('Устройство стяжки цементной 50 мм', 'м2', 1300)])[0]
    assert.equal(whole.mode, 'total')
    assert.deepEqual([whole.stats.min, whole.stats.max], [1000, 1300])
    const forced = run([item('Устройство стяжки цементной 50 мм', 'м2', 400)], { priceMode: 'material' })[0]
    assert.deepEqual([forced.stats.n, forced.stats.median], [1, 400])
  })

  it('нет аналогов; другая единица — не в сравнении; строка без цены всё равно показывает договорные цены', () => {
    const [none, otherUnit, noPrice] = run([item('Абракадабра редкая', 'шт', 100), item('Кабель ВВГнг-LS 3х2,5', 'шт', 100),
      item('Кабель ВВГнг-LS 3х2,5', 'м', null)])
    assert.equal(none.verdict, 'none')
    assert.equal(otherUnit.verdict, 'none')
    assert.ok(otherUnit.otherUnit.length > 0)
    assert.equal(noPrice.verdict, 'noprice')
    assert.equal(noPrice.stats.median, 120)
    assert.equal(noPrice.dev, null)
  })

  it('доставка — не позиция; итоги считаются только там, где есть цена, количество и договорные цены', () => {
    const lines = run([item('Кабель ВВГнг-LS 3х2,5', 'м', 180), item('Доставка', 'усл', 5000, { delivery: true }), item('Абракадабра редкая', 'шт', 7)])
    assert.equal(lines[1].verdict, 'delivery')
    const s = contractSummary(lines)
    assert.deepEqual([s.total, s.high, s.none, s.withStats], [2, 1, 1, 1])
    assert.equal(s.fileSum, 1800)
    assert.equal(s.medianSum, 1200)
    const out = contractExportRows(lines)
    assert.equal(out.length, 2, 'доставка не выгружается')
    assert.equal(out[0].length, CONTRACT_EXPORT_HEADERS.length)
    assert.deepEqual(out[0].slice(0, 2), [1, 'Кабель ВВГнг-LS 3х2,5'])
    assert.equal(out[0][CONTRACT_EXPORT_HEADERS.indexOf('Итог')], 'дороже договоров')
    assert.equal(out[0][CONTRACT_EXPORT_HEADERS.indexOf('Медиана, ₽')], 120)
  })

  it('указатель большого реестра строится быстро и находит нужное среди 45 тыс. строк', () => {
    const many = Array.from({ length: 45000 }, (_, i) => row(`Монтаж позиции номер ${i % 15000} кабель лоток`, 'шт', 100 + i))
    const started = Date.now()
    const ix = contractIndex([...many, row('Кабель ВВГнг-LS 5х95', 'м', 3000)])
    const cands = lineCandidates(item('Кабель ВВГнг-LS 5х95', 'м'), ix)
    assert.equal(cands[0].group.name, 'Кабель ВВГнг-LS 5х95')
    assert.ok(Date.now() - started < 20000)
  })
})

describe('Договорные расценки: разбор файла', () => {
  const bytesOf = (sheets) => {
    const wb = XLSX.utils.book_new()
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
  }

  it('незаполненный ВОР: позиции без цен читаются только по просьбе', async () => {
    const blank = bytesOf({
      'МАТЕРИАЛЫ': [['№ п/п', 'Наименование материала', 'Ед. изм.', 'Объем', 'ЦЕНА руб., с учетом доставки и НДС 22%', 'ИТОГО, руб. с учетом НДС 22%'],
        [1, 2, 3, 4, 5, 6], [1, 'Раствор М-300 (м3)', 'м3', 0.25, '', '']],
      'РАБОТЫ': [['№ п/п', 'Наименование работ', 'Ед. изм.', 'Объем', 'ЦЕНА руб., с НДС 22%', 'ИТОГО, руб. с учетом НДС 22%'],
        [1, 2, 3, 4, 5, 6], [1, 'Устройство стяжек', 'м3', 0.25, '', '']],
    })
    const asked = await readBidPriceDoc(blank, 'ВОР.xlsx', { keepBlank: true })
    assert.deepEqual(asked.items.map((it) => [it.name, it.kindHint, it.unit, it.price]),
      [['Раствор М-300 (м3)', 'material', 'м3', null], ['Устройство стяжек', 'work', 'м3', null]])
    const plain = await readBidPriceDoc(blank, 'ВОР.xlsx')
    assert.ok(plain.error, 'проверка реестра КП и кабинет подрядчика — как раньше: строк с ценой нет')
  })

  it('незаполненный ВОР: заголовки разделов без ед. изм. не считаются позициями', async () => {
    const doc = await readBidPriceDoc(bytesOf({ 'МАТЕРИАЛЫ': [['№', 'Наименование материала', 'Ед. изм.', 'Объем', 'ЦЕНА с НДС'], ['', 'Отделочные работы', '', '', ''], [1, 'Бетон В25', 'м3', 1, '']] }), 'ВОР.xlsx', { keepBlank: true })
    assert.deepEqual(doc.items.map((it) => it.name), ['Бетон В25'])
  })

  it('две колонки цены — материалы и работы — две строки проверки, каждая со своим видом', async () => {
    const doc = await readBidPriceDoc(bytesOf({ 'КП': [
      ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Цена материалов с НДС', 'Цена работ с НДС', 'Сумма материалов', 'Сумма работ'],
      [1, 'Стяжка 55 мм', 'м2', 100, 990, 1740, 99000, 174000],
      [2, 'Демонтаж кладки', 'м3', 5, '', 3000, '', 15000],
    ] }), 'КП.xlsx')
    assert.equal(doc.items[0].price, 990, 'цена строки — прежняя, первая: снабжение и кабинет работают как раньше')
    assert.deepEqual(splitPriceParts(doc.items).map((it) => [it.name, it.kindHint, it.price]),
      [['Стяжка 55 мм', 'material', 990], ['Стяжка 55 мм', 'work', 1740], ['Демонтаж кладки', 'work', 3000]])
  })

  it('«Стоимость материалов и работ», «Стоимость товаров (работ, услуг)» — не разбивка; одна цена — одна строка', async () => {
    const doc = await readBidPriceDoc(bytesOf({ 'Счёт': [
      ['№', 'Товар', 'Кол-во', 'Ед.', 'Цена', 'Стоимость товаров (работ, услуг), всего с налогом'], [1, 'Песок', 2, 'м3', 900, 1800],
    ] }), 'Счёт.xlsx')
    assert.equal(doc.items[0].parts, undefined)
    assert.deepEqual(splitPriceParts(doc.items).map((it) => it.kindHint ?? null), [null])
    const mixed = await readBidPriceDoc(bytesOf({ 'КП': [
      ['№', 'Наименование', 'Кол-во', 'Ед.', 'Цена', 'Стоимость материалов и работ'], [1, 'Стяжка', 2, 'м2', 900, 1800],
    ] }), 'КП.xlsx')
    assert.equal(mixed.items[0].parts, undefined)
  })
})
