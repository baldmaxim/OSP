// Реестр расценок → «Расценки от подрядчиков (КП)» (миграция 20261122) — правила без базы и браузера: проверка
// расценок по файлу (разбор файла как у «Цен из счёта / КП» снабжения, сопоставление строк файла с найденными
// расценками реестра тем же расчётом похожести, аналоги только той же ед. изм., минимум / медиана / максимум,
// отклонение и итог с допуском, выгрузка), поля расценки, добавленной вручную, и документ-ссылка.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  checkLines, checkSummary, checkExportRows, priceStats, deviation, verdictOf, registryGroups, chunks, lineKind,
  CHECK_EXPORT_HEADERS, DEFAULT_TOLERANCE,
} from '../../src/utils/kpRateCheck.js'
import { readBidPriceDoc } from '../../src/utils/bidImport.js'
import { normalizeDocUrl, isWebLink, moscowToday, validateManualRate, tenderLabel, SOURCE_KINDS } from '../../src/utils/kpRegistrySources.js'

// Строка реестра, как её отдаёт kp_rates_lookup.
let seq = 0
const reg = (item_name, price, unit = 'шт', extra = {}) => ({
  id: `r${++seq}`, item_type: 'material', item_name, unit, price, counterparty_name: 'ООО Подряд', tender_id: 't1',
  tender_desc: 'Электромонтаж', proposal_date: '2026-09-01', source_kind: 'kp', estimate_name: 'ВОР ЭОМ', ...extra,
})
const item = (name, price, unit = 'шт', extra = {}) => ({ name, unit, qty: 10, price, priceVat: 'gross', sum: null, sumVat: null, ...extra })

function bytesOf(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('Проверка расценок по файлу: сопоставление и цены', () => {
  it('то же наименование и похожие той же ед. изм. — аналоги; минимум, медиана, максимум; отклонение от медианы', () => {
    const items = [item('Кабель ВВГнг(А)-LS 3х2,5', 180)]
    const rows = new Map([[0, [
      reg('Кабель ВВГнг(А)-LS 3х2,5', 100, 'м'),
      reg('Кабель ВВГнг(А)-LS 3х2,5', 120, 'м'),
      reg('Кабель силовой ВВГнг(А)-LS 3x2,5 мм2', 140, 'м'),
      reg('Кабель ВВГнг(А)-LS 3х4', 210, 'м'), // другое сечение — не аналог
    ]]])
    const [l] = checkLines([{ ...items[0], unit: 'м' }], rows)
    assert.deepEqual(l.analogs.map((c) => Number(c.group.row.price)).sort((a, b) => a - b), [100, 120, 140])
    assert.ok(l.candidates.some((c) => c.group.row.item_name.endsWith('3х4') && c.apart), 'другое сечение — в списке, но не аналог')
    assert.deepEqual(l.stats, { n: 3, min: 100, max: 140, median: 120, exact: 2 })
    assert.equal(l.dev, 50)
    assert.equal(l.verdict, 'high')
  })

  it('другая ед. изм. — не в сравнении цен, а отдельным списком; «м» = «м.п.», «шт.» = «штук»', () => {
    const rows = new Map([[0, [reg('Грунтовка глубокого проникновения', 300, 'л'), reg('Грунтовка глубокого проникновения', 2500, 'кан.')]],
      [1, [reg('Труба гофрированная ПНД 20 мм', 30, 'м.п.')]],
      [2, [reg('Коробка распаячная 100х100', 80, 'штук')]]])
    const lines = checkLines([item('Грунтовка глубокого проникновения', 320, 'л'), item('Труба гофрированная ПНД 20 мм', 31, 'м'),
      item('Коробка распаячная 100х100', 80, 'шт.')], rows)
    assert.equal(lines[0].analogs.length, 1)
    assert.equal(lines[0].otherUnit.length, 1)
    assert.equal(lines[0].verdict, 'ok')
    assert.equal(lines[1].analogs.length, 1, 'м = м.п.')
    assert.equal(lines[2].analogs.length, 1, 'шт. = штук')
    assert.equal(lines[2].dev, 0)
  })

  it('итог с допуском: в рынке, дороже, дешевле, нет аналогов, нет цены; доставка — не позиция', () => {
    const stats = { median: 100 }
    assert.equal(verdictOf(115, stats), 'ok')
    assert.equal(verdictOf(116, stats), 'high')
    assert.equal(verdictOf(84, stats), 'low')
    assert.equal(verdictOf(116, stats, 20), 'ok')
    assert.equal(verdictOf(100, null), 'none')
    assert.equal(verdictOf(null, stats), 'noprice')
    assert.equal(DEFAULT_TOLERANCE, 15)
    assert.equal(deviation(90, { median: 120 }), -25)
    const lines = checkLines([item('Доставка', 5000, 'усл.', { delivery: true }), item('Песок', 900, 'м3'), item('Щебень', null, 'м3')],
      new Map([[1, [reg('Песок', 1000, 'м3')]]]))
    assert.deepEqual(lines.map((l) => l.verdict), ['delivery', 'ok', 'noprice'])
    assert.deepEqual(checkSummary(lines), { total: 2, ok: 1, high: 0, low: 0, none: 0, noprice: 1 })
  })

  it('цена файла приводится к цене с НДС, как в реестре: «без НДС» — плюс ставка', () => {
    const rows = new Map([[0, [reg('Бетон В25', 7320, 'м3')]]])
    const net = item('Бетон В25', 6000, 'м3', { priceVat: 'net' })
    assert.equal(checkLines([net], rows)[0].price, 7320, 'колонка «без НДС» — плюс 22 %')
    assert.equal(checkLines([net], rows, { vat: { mode: 'gross', rate: 22, force: true } })[0].price, 6000, 'выбрано «с НДС — как есть»')
    assert.equal(checkLines([net], rows)[0].verdict, 'ok')
  })

  it('медиана чётного числа цен — среднее двух средних; нулевые и пустые цены не считаются', () => {
    const groups = registryGroups([reg('А', 10), reg('А', 20), reg('А', 40), reg('А', 0), reg('А', null)])
    const s = priceStats(groups.map((g) => ({ group: g, exact: true })))
    assert.deepEqual(s, { n: 3, min: 10, max: 40, median: 20, exact: 5 })
    const s2 = priceStats(registryGroups([reg('А', 10), reg('А', 15)]).map((g) => ({ group: g, exact: false })))
    assert.equal(s2.median, 12.5)
    assert.equal(priceStats([]), null)
  })

  it('порции поиска, вид строки и выгрузка проверки', () => {
    assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
    assert.equal(lineKind({ kindHint: 'work' }, 'material'), 'work', 'лист файла важнее выбора')
    assert.equal(lineKind({}, 'all'), null)
    assert.equal(lineKind({}, 'material'), 'material')
    const lines = checkLines([item('Песок', 1200, 'м3'), item('Доставка', 1, 'усл.', { delivery: true })], new Map([[0, [reg('Песок', 1000, 'м3')]]]))
    const out = checkExportRows(lines)
    assert.equal(out.length, 1, 'доставка не выгружается')
    assert.equal(out[0].length, CHECK_EXPORT_HEADERS.length)
    assert.deepEqual(out[0].slice(0, 11), [1, 'Песок', 'м3', 10, 1200, 1, 1000, 1000, 1000, 20, 'дороже реестра'])
    assert.equal(out[0][11], 'Песок')
    assert.equal(out[0][12], 'ООО Подряд')
  })
})

describe('Проверка расценок по файлу: разбор файла', () => {
  it('заполненный ВОР — листы «Материалы» и «Работы» со своим видом; счёт — одной таблицей', async () => {
    const vor = await readBidPriceDoc(bytesOf({
      'Материалы': [['№', 'Наименование', 'Ед. изм.', 'Кол-во', 'Цена с НДС'], [1, 'Бетон В25', 'м3', 100, 7500]],
      'Работы': [['№', 'Наименование работ', 'Ед. изм.', 'Объём', 'Цена с НДС'], [1, 'Устройство стяжки', 'м2', 500, 950]],
    }), 'КП Подряд.xlsx')
    assert.equal(vor.kind, 'excel')
    assert.deepEqual(vor.items.map((it) => [it.name, it.kindHint, it.price]), [['Бетон В25', 'material', 7500], ['Устройство стяжки', 'work', 950]])
    const invoice = await readBidPriceDoc(bytesOf({
      'TDSheet': [['Счёт на оплату № 15'], [], ['№', 'Товар', 'Кол-во', 'Ед.', 'Цена', 'Сумма'], [1, 'Песок карьерный', 20, 'м3', 900, 18000],
        ['', 'Итого', '', '', '', 18000], ['В том числе НДС 22 %']],
    }), 'Счёт.xlsx')
    assert.deepEqual(invoice.items.map((it) => [it.name, it.unit, it.qty, it.price, it.kindHint ?? null]), [['Песок карьерный', 'м3', 20, 900, null]])
    assert.equal(invoice.vat.mode, 'gross')
  })
})

describe('Расценка, добавленная вручную: поля и документ', () => {
  const base = { item_type: 'material', item_name: '  Грунтовка   глубокого  ', unit: ' л ', price: '1 234,567', counterparty_id: 'cp', rate_date: '2026-10-30' }

  it('поля приводятся к виду базы: пробелы, цена до копеек, пустое — null', () => {
    assert.deepEqual(validateManualRate(base).rate, {
      item_type: 'material', item_name: 'Грунтовка глубокого', unit: 'л', price: 1234.57, counterparty_id: 'cp', object_id: null,
      tender_id: null, rate_date: '2026-10-30', doc_url: null, note: null,
    })
  })

  it('обязательные поля и пределы — понятный отказ', () => {
    assert.match(validateManualRate({ ...base, item_name: ' ' }).error, /наименование/i)
    assert.match(validateManualRate({ ...base, item_type: 'x' }).error, /материал или работа/)
    assert.match(validateManualRate({ ...base, price: '0' }).error, /больше нуля/)
    assert.match(validateManualRate({ ...base, price: '' }).error, /больше нуля/)
    assert.match(validateManualRate({ ...base, counterparty_id: '' }).error, /подрядчика/)
    assert.match(validateManualRate({ ...base, rate_date: '' }).error, /дату/)
    assert.match(validateManualRate({ ...base, unit: 'x'.repeat(51) }).error, /50/)
    assert.match(validateManualRate({ ...base, doc_url: 'C:/папка' }).error, /https/)
  })

  it('документ — адрес http(s) или сетевой путь, как проверяет база', () => {
    assert.deepEqual(normalizeDocUrl(' https://disk.example.ru/kp.pdf '), { url: 'https://disk.example.ru/kp.pdf' })
    assert.deepEqual(normalizeDocUrl('\\\\192.168.5.55\\SharA_Tender\\КП.pdf'), { url: '\\\\192.168.5.55\\SharA_Tender\\КП.pdf' })
    assert.deepEqual(normalizeDocUrl(''), { url: null })
    assert.ok(normalizeDocUrl('ftp://x').error)
    assert.ok(normalizeDocUrl(`https://${'a'.repeat(2000)}`).error)
    assert.equal(isWebLink('https://x'), true)
    assert.equal(isWebLink('\\\\srv\\x'), false)
  })

  it('день по Москве, подпись тендера, источники', () => {
    assert.equal(moscowToday(new Date('2026-10-30T21:30:00Z')), '2026-10-31', 'после 21:00 UTC в Москве уже завтра')
    assert.equal(moscowToday(new Date('2026-10-30T20:59:00Z')), '2026-10-30')
    assert.equal(tenderLabel({ public_tender_number: 412, work_description: 'Полы паркинга' }), '№ 412 · Полы паркинга')
    assert.equal(tenderLabel({ work_description: 'Кровля' }), 'Кровля')
    assert.deepEqual(Object.keys(SOURCE_KINDS), ['kp', 'site', 'manual'])
  })
})
