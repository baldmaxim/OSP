// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel» (utils/supplyRegistryImport): разбор файла в виде
// выгрузки вкладки (и с переставленными колонками, шапкой не в первой строке, датами-ячейками Excel, CSV русского Excel),
// распознавание объекта по неочевидному названию (примеры пользователя 20.11.2026), разовое правило «Primavera = к14»,
// тендер по номеру и описанию, повторы (уже в реестре, повтор в файле) и ошибки строк. Без базы и браузера.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { readWorkbookBytes } from '../../src/utils/supplierDocRead.js'
import {
  detectRegistryHeader, importPayload, isBarePrimavera, kpNormName, moscowDay, objectIndex, parseRateDate,
  parseRegistryWorkbook, prepareRegistryImport, primaveraK14, primaveraOnceUsed, registryRowKey, resolveObject, resolveTender,
} from '../../src/utils/supplyRegistryImport.js'

// Названия объектов портала, на которых видна разница (ЗИЛ — одним числом, три Primavera, «Дом 56» и «Реновация» — один адрес).
const OBJECTS = [
  ['o-zil33', 'ЖК  ЗИЛ 33'], ['o-zil31', 'ЖК ЗИЛ 31'], ['o-zil18', 'ЖК ЗИЛ 18; 19; 27'],
  ['o-injoy', 'ЖК INJOY'], ['o-king', 'ЖК King & Sons '], ['o-aliya', 'ЖК Алия'],
  ['o-prim1', 'ЖК PRIMAVERA (1-й ЭТАП)'], ['o-prim13', 'ЖК Primavera к13'], ['o-prim14', 'ЖК Primavera к14'],
  ['o-dom56', 'ЖК Дом 56'], ['o-renov', 'ЖК Реновация'],
  ['o-sob2', 'ЖК "СОБЫТИЕ -2"'], ['o-sob61', 'Событие 6.1'], ['o-sob62', 'Событие 6.2'],
  ['o-bay1', 'ЖК CITY BAY (1-й этап)'], ['o-bay2', 'ЖК CITY BAY (2-й этап)'],
  ['o-metro2', 'ЖК "Метрополия 2.0"'], ['o-metro', 'ЖК "Метрополия" (этапы 1; 1.1; 1.2; 3.0)'],
].map(([id, name]) => ({ id, name }))
const INDEX = objectIndex(OBJECTS)

const EXPORT_HEADERS = ['№ п/п', 'Источник', 'Объект', 'Наименование', 'Ед. изм.', 'Цена, ₽', 'Тендер', 'Дата расценки']
const bookBytes = (aoa, opts = {}) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa, opts)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Расценки СУ-10')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
const parseBytes = (bytes, name = 'файл.xlsx') => parseRegistryWorkbook(XLSX, readWorkbookBytes(XLSX, bytes, name))

describe('Загрузка в реестр СУ-10: разбор файла', () => {
  it('выгрузка вкладки: все колонки, числа и даты текстом', () => {
    const res = parseBytes(bookBytes([
      EXPORT_HEADERS,
      [1, 'СУ-10', 'Зил33', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 95.5, 'Электромонтаж корпуса 1', '05.10.2026'],
      [2, 'Сайт СУ-10', 'injoy', 'Труба PE-Xa 16х2,2', 'м', '1 234,50', '', '20.11.2026'],
    ]))
    assert.equal(res.error, undefined)
    assert.equal(res.rows.length, 2)
    assert.deepEqual(
      { ...res.rows[0], sheet: undefined },
      { sheet: undefined, rowNo: 2, source: 'СУ-10', object: 'Зил33', name: 'Кабель ВВГнг(А)-LS 3х2,5', unit: 'м', price: 95.5, priceText: '95.5',
        tender: 'Электромонтаж корпуса 1', date: '2026-10-05', dateText: '05.10.2026' },
    )
    assert.equal(res.rows[1].price, 1234.5)
    assert.equal(res.rows[1].date, '2026-11-20')
  })

  it('шапка ниже первой строки, колонки в другом порядке, «Итого» и пустые строки — не позиции', () => {
    const grid = [
      ['Расценки снабжения'], [],
      ['Дата расценки', 'Цена за материал, ₽', 'Наименование материала', 'Объект', 'Описание работ (тендер)', 'Ед. изм.'],
      ['01.09.2026', 100, 'Грунтовка', 'Алия', '№ 1157', 'кг'],
      [],
      ['', 300, 'Итого', '', '', ''],
    ]
    const header = detectRegistryHeader(grid)
    assert.deepEqual(header, { row: 2, columns: { date: 0, price: 1, name: 2, object: 3, tender: 4, unit: 5 } })
    const res = parseBytes(bookBytes(grid))
    assert.equal(res.rows.length, 1)
    assert.equal(res.rows[0].tender, '№ 1157')
    assert.equal(res.rows[0].source, '')
  })

  it('дата — настоящей ячейкой Excel (число дней), а не текстом', () => {
    const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, [1, 'СУ-10', 'Алия', 'Грунтовка', 'кг', 100, '', new Date(Date.UTC(2026, 9, 5))]], { cellDates: true })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Лист1')
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
    const res = parseBytes(bytes)
    assert.equal(typeof res.rows[0].date, 'string')
    assert.equal(res.rows[0].date, '2026-10-05')
    // И номер дня Excel напрямую: 46300 — 05.10.2026.
    assert.equal(parseRateDate(46300), '2026-10-05')
  })

  it('CSV русского Excel: точка с запятой, Windows-1251, цена с запятой', () => {
    const text = 'Источник;Объект;Наименование;Ед. изм.;Цена, ₽;Дата расценки\r\nПетрович;Зил33;Гипсокартон 12,5 мм;м2;"350,40";5.10.26\r\n'
    // Windows-1251 вручную: в Node TextEncoder умеет только UTF-8.
    const cp = new Map([...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя'].map((ch, i) => [ch, 0xc0 + i]))
    const bytes = Uint8Array.from([...text].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : cp.get(ch) ?? (ch === '₽' ? 0x3f : 0x3f))))
    const res = parseBytes(bytes, 'расценки.csv')
    assert.equal(res.rows.length, 1)
    assert.equal(res.rows[0].source, 'Петрович')
    assert.equal(res.rows[0].name, 'Гипсокартон 12,5 мм')
    assert.equal(res.rows[0].price, 350.4)
    assert.equal(res.rows[0].date, '2026-10-05')
  })

  it('без наименования или цены в шапке — не таблица реестра', () => {
    assert.deepEqual(parseBytes(bookBytes([['Объект', 'Наименование'], ['Алия', 'Грунтовка']])), { error: 'no_table' })
    assert.deepEqual(parseBytes(bookBytes([EXPORT_HEADERS])), { error: 'empty' })
  })

  it('даты: разные написания; не дата — null, пусто — пустая строка', () => {
    assert.equal(parseRateDate('2026-10-05'), '2026-10-05')
    assert.equal(parseRateDate('5/10/2026'), '2026-10-05')
    assert.equal(parseRateDate('05 октября 2026 г.'), '2026-10-05')
    assert.equal(parseRateDate('31.02.2026'), null)
    assert.equal(parseRateDate('вчера'), null)
    assert.equal(parseRateDate(''), '')
    assert.equal(parseRateDate(null), '')
  })
})

describe('Загрузка в реестр СУ-10: объект по неочевидному названию', () => {
  const found = (label) => {
    const r = resolveObject(label, INDEX)
    return r.status === 'found' ? r.object.id : `${r.status}:${r.candidates.map((c) => c.id).join(',')}`
  }

  it('примеры пользователя — однозначно', () => {
    assert.equal(found('18 19 27'), 'o-zil18')
    assert.equal(found('injoy'), 'o-injoy')
    assert.equal(found('king&sons'), 'o-king')
    assert.equal(found('Алия'), 'o-aliya')
    assert.equal(found('дом56(не реновация)'), 'o-dom56')
    assert.equal(found('Зил33'), 'o-zil33')
  })

  it('«primavera» без корпуса — несколько объектов, сам не выбирается', () => {
    assert.equal(found('primavera'), 'many:o-prim1,o-prim13,o-prim14')
    assert.equal(found('Примавера'), 'many:o-prim1,o-prim13,o-prim14')
    assert.equal(found('Примавера 14'), 'o-prim14')
    assert.equal(found('Primavera k13'), 'o-prim13')
    assert.equal(found('ЖК Primavera к14 корпус 22'), 'o-prim14')
  })

  it('одно число или слово разницы — не путаются; адрес и похожесть не используются', () => {
    assert.equal(found('ЗИЛ 31'), 'o-zil31')
    assert.equal(found('33'), 'o-zil33')
    assert.equal(found('реновация'), 'o-renov')
    assert.equal(found('Дом 56'), 'o-dom56')
    assert.equal(found('дом 56 реновация'), 'many:o-dom56,o-renov')
    assert.equal(found('Дом 56, не реновация'), 'o-dom56')
    assert.equal(found('Событие 6.1'), 'o-sob61')
    assert.equal(found('событие-2'), 'o-sob2')
    assert.equal(found('Сити Бэй 2'), 'o-bay2')
    assert.equal(found('Метрополия 2.0'), 'o-metro2')
    assert.equal(found('Метрополия'), 'many:o-metro2,o-metro')
    assert.equal(found('Сиреневый парк'), 'none:')
    assert.equal(found(''), 'empty:')
  })

  it('каждое название портала узнаёт само себя', () => {
    for (const o of OBJECTS) assert.equal(found(o.name), o.id, o.name)
  })
})

describe('Загрузка в реестр СУ-10: разовое правило «Primavera = к14»', () => {
  it('голое «primavera» — только оно; к14 — один объект', () => {
    assert.equal(isBarePrimavera('primavera'), true)
    assert.equal(isBarePrimavera(' Примавера '), true)
    assert.equal(isBarePrimavera('ЖК Primavera'), true)
    assert.equal(isBarePrimavera('primavera 14'), false)
    assert.equal(primaveraK14(INDEX).id, 'o-prim14')
  })

  it('пока нет загрузки с правилом — предлагается; после — нет', () => {
    assert.equal(primaveraOnceUsed([]), false)
    assert.equal(primaveraOnceUsed([{ options: {} }, { options: null }]), false)
    assert.equal(primaveraOnceUsed([{ options: { primavera: 'k14' } }]), true)
  })

  it('с правилом «primavera» строк файла — к14, без него — не выбран; ручной выбор сильнее', () => {
    const rows = [{ rowNo: 2, source: 'СУ-10', object: 'primavera', name: 'Плитка', unit: 'м2', price: 1000, priceText: '1000', tender: '', date: '2026-10-01', dateText: '' }]
    const base = { index: INDEX, today: '2026-11-20' }
    const on = prepareRegistryImport(rows, { ...base, primaveraOnce: true })
    assert.equal(on.lines[0].objectId, 'o-prim14')
    assert.deepEqual([on.labels[0].once, on.labels[0].auto], [true, 'o-prim14'])
    const off = prepareRegistryImport(rows, { ...base, primaveraOnce: false })
    assert.equal(off.lines[0].objectId, null)
    assert.equal(off.labels[0].resolution.status, 'many')
    const manual = prepareRegistryImport(rows, { ...base, primaveraOnce: true, choices: new Map([['primavera', 'o-prim13']]) })
    assert.equal(manual.lines[0].objectId, 'o-prim13')
  })
})

describe('Загрузка в реестр СУ-10: тендер', () => {
  const TENDERS = [
    { id: 't-main', work_description: 'Отделочные работы ФОК', object_id: 'o-injoy', public_tender_number: 1153, tender_type: 'main' },
    { id: 't-mat', work_description: 'Отделочные работы ФОК', object_id: 'o-injoy', public_tender_number: 1154, tender_type: 'materials' },
    { id: 't-a', work_description: 'Благоустройство', object_id: 'o-aliya', public_tender_number: 900, tender_type: 'main' },
    { id: 't-b', work_description: 'Благоустройство', object_id: 'o-zil33', public_tender_number: 901, tender_type: 'main' },
    { id: 't-2', work_description: 'Фасад', object_id: 'o-aliya', public_tender_number: 2, tender_type: 'main' },
  ]
  it('номер — тот тендер; описание основного и тендера на материалы — основной', () => {
    assert.equal(resolveTender('№ 1154', TENDERS)?.id, 't-mat')
    assert.equal(resolveTender('1153', TENDERS)?.id, 't-main')
    assert.equal(resolveTender('Отделочные  работы ФОК', TENDERS)?.id, 't-main')
  })
  it('одно описание у тендеров разных объектов — только по объекту строки, иначе текстом', () => {
    assert.equal(resolveTender('Благоустройство', TENDERS), null)
    assert.equal(resolveTender('Благоустройство', TENDERS, 'o-zil33')?.id, 't-b')
    assert.equal(resolveTender('Неизвестный тендер', TENDERS), null)
    assert.equal(resolveTender('', TENDERS), null)
  })
  it('«№» внутри описания — не номер тендера; номер тендера другого объекта — не он', () => {
    assert.equal(resolveTender('Монтаж лифтов корпус № 2', TENDERS), null)
    assert.equal(resolveTender('Тендер № 2', TENDERS)?.id, 't-2')
    assert.equal(resolveTender('№ 1153', TENDERS, 'o-aliya'), null)
    assert.equal(resolveTender('№ 1153', TENDERS, 'o-injoy')?.id, 't-main')
  })
})

describe('Загрузка в реестр СУ-10: итог строк', () => {
  const row = (over) => ({ rowNo: 2, source: 'СУ-10', object: 'Зил33', name: 'Кабель ВВГ 3х2,5', unit: 'м', price: 95.5, priceText: '95,5',
    tender: '', date: '2026-10-05', dateText: '05.10.2026', ...over })

  it('уже в реестре (выгрузка обратно), повтор в файле, ошибки; к загрузке — остальное', () => {
    // Строка реестра — цена с сайта: полночь 05.10.2026 по Москве, тот же объект, другое написание наименования и ед. изм.
    const existing = new Set([registryRowKey({ item_name: 'кабель  ВВГ 3х2,5', unit: 'м.', price: '95.50', object_id: 'o-zil33', rate_date: '2026-10-04T21:00:00+00:00' })])
    const rows = [
      row({ rowNo: 2 }),
      row({ rowNo: 3, price: 96 }),
      row({ rowNo: 4, price: 96, name: 'Кабель ВВГ 3х2,5 ' }),
      row({ rowNo: 5, price: null, priceText: 'по запросу' }),
      row({ rowNo: 6, date: null, dateText: '32.13.2026' }),
      row({ rowNo: 7, date: '2027-01-01' }),
      row({ rowNo: 8, date: '', source: '' }),
      row({ rowNo: 9, name: '' }),
      row({ rowNo: 10, price: -5 }),
    ]
    const res = prepareRegistryImport(rows, { index: INDEX, existing, today: '2026-11-20', defaults: { source: 'Снабжение', date: '2026-11-19' } })
    assert.deepEqual(res.lines.map((l) => [l.rowNo, l.status, l.problem || '']), [
      [2, 'exists', ''], [3, 'ok', ''], [4, 'dup', ''],
      [5, 'error', 'цена не число: «по запросу»'], [6, 'error', 'дата не распознана: «32.13.2026»'], [7, 'error', 'дата из будущего'],
      [8, 'ok', ''], [9, 'error', 'нет наименования'], [10, 'error', 'цена не больше нуля'],
    ])
    assert.deepEqual(res.counts, { total: 9, ok: 2, exists: 1, dup: 1, error: 5 })
    const eight = res.lines.find((l) => l.rowNo === 8)
    assert.deepEqual(importPayload(eight), {
      source_name: 'Снабжение', item_name: 'Кабель ВВГ 3х2,5', unit: 'м', price: 95.5, object_id: 'o-zil33', object_label: 'Зил33',
      tender_id: null, tender_label: null, rate_date: '2026-11-19', row_no: 8,
    })
  })

  it('нормализация наименования — как kp_norm_name базы (ключ уникального индекса)', () => {
    assert.equal(kpNormName(' «Кабель»  ВВГнг(А)-LS 3х2.5 '), 'кабель ввгнга-ls 3х2 5')
    assert.equal(kpNormName('Плита 1200x600'), kpNormName('плита 1200х600'))
    assert.equal(moscowDay('2026-10-04T21:00:00Z'), '2026-10-05')
  })
})
