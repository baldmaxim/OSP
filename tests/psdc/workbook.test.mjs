// XLSX ПСДЦ: чтение старого формата, безопасность архива, экспорт с формулами,
// копия с подсветкой ошибок. Сквозные проверки проходят через настоящий
// расчётный движок в локальном PostgreSQL.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import * as XLSXNs from 'xlsx'
import PizZip from 'pizzip'
import { setupDatabase, pgAvailable } from './lib/pg.mjs'
import { HEADER, createUser, createDocument, stage, rpc, q } from './lib/fixtures.mjs'
import { buildLegacyWorkbook, legacySample } from './lib/legacyWorkbook.mjs'
import { createEvaluator, excelRound } from './lib/formula.mjs'
import {
  readPsdcWorkbook, inspectXlsxArchive, buildPsdcWorkbook, buildPsdcTemplate, buildErrorCopy,
  formatDecimal, exactNumberString, PSDC_SHEET_NAME, PsdcFileError,
} from '../../src/utils/psdcWorkbook.js'

const XLSX = XLSXNs.read ? XLSXNs : XLSXNs.default

function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.method, 8)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.usize, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, e.data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.method, 10)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.usize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]))
}

describe('ПСДЦ: чтение XLSX старого формата', () => {
  it('однолистовой старый файл читается без изменений структуры', async () => {
    const parsed = await readPsdcWorkbook(legacySample())
    assert.deepEqual(parsed.fatal, [])
    assert.equal(parsed.sheetName, PSDC_SHEET_NAME)
    assert.equal(parsed.hasU, true)
    assert.deepEqual(parsed.header, HEADER)
    assert.deepEqual(parsed.rows.map((r) => r.r), [2, 3, 4, 7, 9], 'пустые строки пропущены, итоговые не импортируются')
    assert.equal(parsed.rows.find((r) => r.r === 7).c.A.v, '5.10')
    assert.equal(parsed.totals.row, 38)
    assert.equal(parsed.totals.vat_row, 39)
    assert.match(parsed.totals.vat_text, /в том числе ндс 22%/)
    assert.deepEqual(parsed.rows.find((r) => r.r === 3).c.K, { f: 1, t: 'n', v: '10000', w: '10000' })
    assert.deepEqual(parsed.rows.find((r) => r.r === 4).c.I, { t: 's', v: '2,5' })
  })

  it('лист выбирается по имени, иначе однозначно по шапке; иначе понятная ошибка', async () => {
    const rows = [{ r: 2, A: '1', B: 'Секция', F: 'С' }]
    const renamed = await readPsdcWorkbook(buildLegacyWorkbook({ sheetName: 'Ведомость объемов  работ', rows }))
    assert.equal(renamed.sheetName, 'Ведомость объемов  работ')

    const byHeader = await readPsdcWorkbook(buildLegacyWorkbook({ sheetName: 'ВОР корпус 2', rows, extraSheets: [{ name: 'Прочее', data: [['x']] }] }))
    assert.equal(byHeader.sheetName, 'ВОР корпус 2')

    const wrong = await readPsdcWorkbook(buildLegacyWorkbook({ sheetName: 'Лист1', header: HEADER.map((h, i) => (i === 3 ? 'ДМ' : h)), rows }))
    assert.match(wrong.fatal[0], /Не найден лист/)

    const two = buildLegacyWorkbook({ sheetName: 'А', rows, extraSheets: [{ name: 'Б', data: [HEADER] }] })
    assert.match((await readPsdcWorkbook(two)).fatal[0], /несколько листов/)

    // Лист с каноническим именем и сломанной шапкой не отбрасывается — шапку
    // проверит база и покажет ошибку конкретной ячейки.
    const badHeader = await readPsdcWorkbook(buildLegacyWorkbook({ header: HEADER.map((h, i) => (i === 8 ? 'Кол-во' : h)), rows }))
    assert.equal(badHeader.fatal.length, 0)
    assert.equal(badHeader.header[8], 'Кол-во')
  })

  it('числа ячеек передаются точной десятичной записью', () => {
    assert.equal(exactNumberString(10.12345), '10.12345')
    assert.equal(exactNumberString(0.1 + 0.2), '0.30000000000000004')
    assert.equal(exactNumberString(1e21), '1e+21')
    assert.equal(exactNumberString(-0), '0')
    assert.equal(exactNumberString(NaN), null)
  })

  it('отображение денег без float: пробелы-разделители и запятая', () => {
    assert.equal(formatDecimal('1000000.25'), '1\u00A0000\u00A0000,25')
    assert.equal(formatDecimal('10.1', 5), '10,10000')
    assert.equal(formatDecimal('-0.00'), '0,00')
    assert.equal(formatDecimal('-1234.5'), '−1\u00A0234,50')
    assert.equal(formatDecimal(null), '')
  })
})

describe('ПСДЦ: безопасность XLSX', () => {
  it('не-XLSX и повреждённый архив отклоняются', async () => {
    assert.match((await readPsdcWorkbook(new TextEncoder().encode('просто текст'))).fatal[0], /не является книгой XLSX/)
    const cut = legacySample().slice(0, 500)
    assert.equal((await readPsdcWorkbook(cut)).fatal.length, 1)
  })

  it('zip-бомба: заявленный размер больше лимита', async () => {
    const zip = makeZip([{ name: 'xl/worksheets/sheet1.xml', method: 8, data: zlib.deflateRawSync(Buffer.alloc(1024)), usize: 250 * 1024 * 1024 }])
    await assert.rejects(inspectXlsxArchive(zip), (e) => e instanceof PsdcFileError && /слишком велик/.test(e.message))
  })

  it('zip-бомба: фактическая распаковка больше заявленной останавливается', async () => {
    const payload = zlib.deflateRawSync(Buffer.alloc(40 * 1024 * 1024))
    const zip = makeZip([{ name: 'xl/sharedStrings.xml', method: 8, data: payload, usize: 1024 }])
    const started = Date.now()
    await assert.rejects(inspectXlsxArchive(zip), (e) => e instanceof PsdcFileError && /повреждён|большой объём/.test(e.message))
    assert.ok(Date.now() - started < 5000)
  })

  it('XML с DOCTYPE/ENTITY отклоняется до разбора книги', async () => {
    const xml = Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><sst>&a;</sst>')
    const zip = makeZip([{ name: 'xl/sharedStrings.xml', method: 8, data: zlib.deflateRawSync(xml), usize: xml.length }])
    await assert.rejects(inspectXlsxArchive(zip), /сущностей/)
  })

  it('обычный файл проходит проверку архива', async () => {
    const info = await inspectXlsxArchive(legacySample())
    assert.ok(info.entries > 3)
  })
})

describe('ПСДЦ: экспорт, копия ошибок, сквозной путь через базу', { skip: !pgAvailable() && 'PostgreSQL не найден' }, () => {
  let db
  let lawyer

  before(() => {
    db = setupDatabase()
    lawyer = createUser(db, { role: 'lawyer', canEdit: true, name: 'Юрист' })
  })
  after(() => db?.stop())

  const stageParsed = (parsed, documentId, fileName = 'ВОР.xlsx') => stage(db, lawyer, {
    documentId, rows: parsed.rows, header: parsed.header, hasU: parsed.hasU, totals: parsed.totals, fatal: parsed.fatal, fileName,
  })

  it('старый файл → проверка базой: ДМ исключает только материал, deleted не входит, НДС из документа', async () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work', vat_rate: 22, contract_amount: 1 })
    const parsed = await readPsdcWorkbook(legacySample())
    const { result } = stageParsed(parsed, doc.id)
    assert.equal(result.state, 'validated', JSON.stringify(result.issues))
    assert.equal(result.total_material, '13000.00')
    assert.equal(result.total_work, '2000.00')
    assert.equal(result.total, '15000.00')
    assert.equal(result.dm_material_excluded, '2000.00')
    assert.equal(result.vat_amount, '2704.92')
    assert.equal(result.section_count, 1)
    assert.equal(result.process_count, 3)
    assert.equal(result.legacy_deleted_count, 1)
    assert.ok(result.issues.some((i) => i.code === 'legacy_value' && i.cell === 'M7'), 'старая формула ДМ по работам — предупреждение')
    assert.ok(result.issues.some((i) => i.code === 'legacy_total' && i.cell === 'O38'))
    assert.ok(result.issues.every((i) => i.severity === 'warning'))
  })

  it('экспорт: один лист A:T(+U), формулы Excel дают те же значения, что и база; повторный импорт совпадает', async () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work', vat_rate: 22, contract_amount: 1 })
    const parsed = await readPsdcWorkbook(legacySample())
    const staged = stageParsed(parsed, doc.id)
    rpc(db, lawyer, 'psdc_apply', q(staged.id))
    const psdc = rpc(db, lawyer, 'psdc_get', q(staged.id))
    const rows = rpc(db, lawyer, 'psdc_get_rows', q(staged.id))

    const bytes = new Uint8Array(buildPsdcWorkbook({ rows, psdc }))
    const wb = XLSX.read(bytes, { type: 'array', cellFormula: true })
    assert.deepEqual(wb.SheetNames, [PSDC_SHEET_NAME], 'в экспорте только лист ведомости')
    const ws = wb.Sheets[PSDC_SHEET_NAME]
    HEADER.forEach((h, i) => assert.equal(ws[`${'ABCDEFGHIJKLMNOPQRST'[i]}1`].v, h))
    assert.equal(ws['A5'].t, 's')
    assert.equal(ws['A5'].v, '5.10')
    assert.equal(ws['U6'].v, 'deleted')

    const ev = createEvaluator(ws)
    const money = (v) => excelRound(Number(v), 2).toFixed(2)
    rows.forEach((row, idx) => {
      const r = idx + 2
      if (row.legacy_deleted) return
      for (const [col, key] of [['K', 'material_cost'], ['M', 'work_cost'], ['O', 'total_cost']]) {
        assert.equal(money(ev.value(`${col}${r}`)), row[key], `${col}${r}`)
      }
      if (row.row_kind === 'process') assert.equal(money(ev.value(`N${r}`)), row.unit_price, `N${r}`)
    })
    const t = rows.length + 2
    assert.equal(ws[`B${t}`].v, 'Итого по всей ведомости, руб.')
    assert.equal(money(ev.value(`K${t}`)), psdc.total_material)
    assert.equal(money(ev.value(`M${t}`)), psdc.total_work)
    assert.equal(money(ev.value(`O${t}`)), psdc.total)
    assert.equal(ws[`B${t + 1}`].v, 'в том числе НДС 22%')
    assert.equal(money(ev.value(`O${t + 1}`)), psdc.vat_amount)

    // Экспорт снова импортируется: структура та же, итоги те же, ID строк
    // сохраняются для ДС на изменение этой ветки.
    const reparsed = await readPsdcWorkbook(bytes)
    assert.deepEqual(reparsed.fatal, [])
    const change = createDocument(db, { record_type: 'ds_vor', parent_contract_id: doc.id, status: 'in_work' })
    const again = stageParsed(reparsed, change.id, 'экспорт.xlsx')
    assert.equal(again.result.state, 'validated', JSON.stringify(again.result.issues))
    assert.equal(again.result.total, psdc.total)
    assert.equal(again.result.previous_psdc_id, staged.id)
    const newRows = rpc(db, lawyer, 'psdc_get_rows', q(again.id))
    assert.deepEqual(newRows.map((r) => r.logical_line_id), rows.map((r) => r.logical_line_id))
    assert.ok(!again.result.issues.some((i) => /^legacy/.test(i.code)), 'формулы экспорта совпадают с расчётом системы')
  })

  it('обычная строка 110 и ДМ 111: формула экспорта совпадает с базой', () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work', vat_rate: null })
    const rows = [
      { r: 2, c: { A: { t: 's', v: '1' }, B: { t: 's', v: 'Секция' }, F: { t: 's', v: 'С' } } },
      { r: 3, c: { A: { t: 's', v: '1.1' }, B: { t: 's', v: 'Комплексный процесс' }, F: { t: 's', v: 'a' }, G: { t: 's', v: 'м2' }, I: { t: 'n', v: '10.12345' }, J: { t: 'n', v: '1234.56' }, L: { t: 'n', v: '789.12' } } },
      { r: 4, c: { A: { t: 's', v: '1.2' }, B: { t: 's', v: 'Комплексный процесс' }, D: { t: 's', v: 'ДМ' }, F: { t: 's', v: 'b' }, G: { t: 's', v: 'м2' }, I: { t: 'n', v: '10' }, J: { t: 'n', v: '1000' }, L: { t: 'n', v: '500' } } },
    ]
    const { id } = stage(db, lawyer, { documentId: doc.id, rows })
    const psdc = rpc(db, lawyer, 'psdc_get', q(id))
    const dbRows = rpc(db, lawyer, 'psdc_get_rows', q(id))
    const ws = XLSX.read(buildPsdcWorkbook({ rows: dbRows, psdc }), { type: 'array', cellFormula: true }).Sheets[PSDC_SHEET_NAME]
    const ev = createEvaluator(ws)
    const m = (ref) => excelRound(Number(ev.value(ref)), 2).toFixed(2)
    assert.deepEqual([m('K3'), m('M3'), m('N3'), m('O3')], [dbRows[1].material_cost, dbRows[1].work_cost, dbRows[1].unit_price, dbRows[1].total_cost])
    assert.deepEqual([m('K4'), m('M4'), m('N4'), m('O4')], ['10000.00', '5000.00', '1500.00', '5000.00'])
    assert.equal(m('O2'), psdc.total)
    assert.equal(ws['B6'].v, 'в том числе НДС')
    assert.equal(m('O6'), '0.00')
  })

  it('текст, похожий на формулу, экспортируется текстом', () => {
    const rows = [
      { row_kind: 'section', number: '1', name: '=HYPERLINK("http://x","y")', material_cost: '0.00', work_cost: '0.00', total_cost: '0.00', logical_line_id: 'a' },
      { row_kind: 'process', number: '1.1', name: '+cmd', code: '@SUM(A1)', unit: '-1', comment: '=1+1', volume: '1.00000', material_cost: '0.00', work_cost: '0.00', unit_price: '0.00', total_cost: '0.00', logical_line_id: 'b' },
    ]
    const ws = XLSX.read(buildPsdcWorkbook({ rows, psdc: { total: '0.00' } }), { type: 'array', cellFormula: true }).Sheets[PSDC_SHEET_NAME]
    for (const ref of ['F2', 'F3', 'C3', 'G3', 'S3']) {
      assert.equal(ws[ref].f, undefined, ref)
      assert.equal(ws[ref].t, 's', ref)
    }
    assert.equal(ws.F2.v, '=HYPERLINK("http://x","y")')
  })

  it('копия с ошибками: тот же файл, только светло-красная заливка ошибочных ячеек', async () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work' })
    const original = buildLegacyWorkbook({
      rows: [
        { r: 2, A: '1', B: 'Секция', F: 'С' },
        { r: 3, A: '1.1', B: 'Материал', F: 'неизвестный тип', G: 'шт', I: 1 },
        { r: 4, A: '1.2', B: 'Комплексный процесс', F: 'нет ед.', I: 'много' },
        { r: 6, A: '7.1', B: 'Комплексный процесс', F: 'без секции', G: 'шт', I: 1 },
      ],
      extraSheets: [{ name: 'Служебный', data: [['x']] }],
    })
    const parsed = await readPsdcWorkbook(original)
    const { result } = stageParsed(parsed, doc.id, 'ошибки.xlsx')
    assert.equal(result.state, 'invalid')
    const errorCells = result.issues.filter((i) => i.severity === 'error').map((i) => i.cell).sort()
    assert.deepEqual(errorCells, ['A6', 'B3', 'G4', 'I4'])

    const copy = buildErrorCopy(original, parsed.sheetName, result.issues.filter((i) => i.severity === 'error'))
    const before = new PizZip(original)
    const after = new PizZip(copy)
    assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort(), 'нет новых частей книги (комментариев, листов)')

    const wbA = XLSX.read(original, { type: 'array' })
    const wbB = XLSX.read(copy, { type: 'array', cellStyles: true })
    assert.deepEqual(wbB.SheetNames, wbA.SheetNames)
    const a = wbA.Sheets[PSDC_SHEET_NAME]
    const b = wbB.Sheets[PSDC_SHEET_NAME]
    for (const ref of Object.keys(a).filter((k) => k[0] !== '!')) {
      assert.equal(b[ref]?.v, a[ref].v, `значение ${ref} не изменилось`)
    }
    const red = Object.keys(b).filter((k) => k[0] !== '!' && /FFC7CE/i.test(JSON.stringify(b[k].s || {}))).sort()
    assert.deepEqual(red, ['A6', 'B3', 'G4', 'I4'], 'подсвечены ровно ошибочные ячейки, включая пустую G4')
    assert.equal(b.G4.v ?? '', '', 'пустая ячейка осталась пустой')
  })

  it('шаблон: одна шапка A:T, итоговые строки, лист ведомости', async () => {
    const bytes = new Uint8Array(buildPsdcTemplate())
    const parsed = await readPsdcWorkbook(bytes)
    assert.deepEqual(parsed.fatal, [])
    assert.deepEqual(parsed.header, HEADER)
    assert.equal(parsed.rows.length, 0, 'заготовленные формулы без исходных данных не считаются строками')
    assert.equal(parsed.totals.row, 502)
  })

  it('чтение большого файла (6 000 строк) укладывается в секунды', async () => {
    const rows = []
    let r = 2
    for (let s = 1; s <= 60; s++) {
      rows.push({ r: r++, A: String(s), B: 'Секция', F: `Секция ${s}` })
      for (let k = 1; k <= 99; k++) {
        rows.push({ r: r++, A: `${s}.${k}`, B: 'Комплексный процесс', F: `Работа ${s}.${k}`, G: 'м2', I: k + 0.12345, J: 100.5, L: 12.34, D: k % 10 === 0 ? 'ДМ' : undefined })
      }
    }
    const bytes = buildLegacyWorkbook({ rows, withU: false })
    const started = Date.now()
    const parsed = await readPsdcWorkbook(bytes)
    const elapsed = Date.now() - started
    console.log(`    чтение 6 000 строк: ${elapsed} мс, ${Math.round(bytes.length / 1024)} КБ`)
    assert.equal(parsed.rows.length, 6000)
    assert.ok(elapsed < 15000)
  })
})
