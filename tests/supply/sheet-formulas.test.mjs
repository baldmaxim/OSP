// Объём ВОР формулой без сохранённого значения (18.11.2026, тендер № 772: файл из Estimat, на листе «МАТЕРИАЛЫ» объём —
// SUMIFS(КП!G:G, КП!D:D, B4, КП!B:B, "Мат"), значения в файле нет; объёмов в расценке не было, пока человек не вставил их
// руками). Расчёт таких ячеек (src/utils/sheetFormulas.js), разбор листа с ним (vorMaterialsSheet.js) и однократное
// перечитывание списков, разобранных раньше без расчёта (supplyAutoImport.needsVolumeRecalc). Книги собираются в тесте через
// xlsx: формула без значения пишется так же, как у Estimat, — без <v>. Настоящий файл (в git его нет — репозиторий открыт)
// проверяется, если лежит в корне репозитория или в VOR_FORMULA_SAMPLE.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import { createSheetCalc, hasUncalculated, referencedSheets } from '../../src/utils/sheetFormulas.js'
import { FORMULAS_MARK, parseVorFileBytes, readMaterialsByCodeBytes, readMaterialsFromWorkbook, readWorkbookBytes } from '../../src/utils/vorMaterialsSheet.js'
import { fileVersion, needsVolumeRecalc, planFileImports } from '../../src/utils/supplyAutoImport.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Лист из строк; ячейка-объект { f } — формула без значения, { f, v } — со значением, { e } — ошибка Excel.
function sheet(rows) {
  const ws = {}
  let maxC = 0
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v == null || v === '') return
    maxC = Math.max(maxC, c)
    const addr = XLSX.utils.encode_cell({ r, c })
    if (typeof v === 'object') ws[addr] = v.e ? { t: 'e', v: v.e } : { t: 'n', f: v.f, ...(v.v !== undefined ? { v: v.v } : {}) }
    else ws[addr] = { t: typeof v === 'number' ? 'n' : 's', v }
  }))
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: maxC } })
  return ws
}
function bookBytes(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, sheet(rows), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
// Лист «КП» как у Estimat: B — вид (Р / Мат), D — наименование, F — ед. изм., G — общий расход.
const KP = [
  ['№', 'Вид', 'Код', 'Наименование', '', 'Ед. изм.', 'Общий расход'],
  ['1', 'Р', '', 'Монтаж ограждений', '', 'т', 2.72],
  ['1.1', 'Мат', '', 'Труба профильная 40*20*3', '', 'м', 206.12],
  ['1.2', 'Мат', '', 'Уголок 70*70*6', '', 'т', 0.1377],
  ['2', 'Р', '', 'Монтаж площадок', '', 'т', 2.2],
  ['2.1', 'Мат', '', 'Труба профильная 40*20*3', '', 'м', 361.814],
  ['2.2', 'мат', '', 'Анкер забивной М12', '', 'шт', 269.28],
  ['2.3', 'Р', '', 'Труба профильная 40*20*3', '', 'м', 999],
]
const sumifs = (row) => ({ f: `SUMIFS(КП!G:G,КП!D:D,B${row},КП!B:B,"Мат")` })
const MATERIALS = [
  ['Стоимость материалов'],
  ['№ п/п', 'Наименование материала', 'Ед. изм.', 'Объем', 'ЦЕНА руб., с учетом доставки и НДС 22%', 'ИТОГО, руб.'],
  [1, 2, 3, 4, 5, 6],
  [1, 'Труба профильная 40*20*3', 'м', sumifs(4), '', { f: 'E4*D4' }],
  [2, 'Уголок 70*70*6', 'т', sumifs(5), '', { f: 'E5*D5' }],
  [3, 'Анкер забивной М12', 'шт', sumifs(6), '', { f: 'E6*D6' }],
]

describe('ВОР из Estimat: объём — формула без значения', () => {
  it('объём считается по листу «КП» (SUMIFS по целым колонкам, без учёта регистра «Мат»); карта колонок помечена calc', () => {
    const r = parseVorFileBytes(bookBytes({ 'КП': KP, 'МАТЕРИАЛЫ': MATERIALS }))
    assert.equal(r.error, undefined, JSON.stringify(r))
    assert.deepEqual(r.positions.map((p) => [p.name, p.unit, p.volume]), [
      ['Труба профильная 40*20*3', 'м', 567.934],
      ['Уголок 70*70*6', 'т', 0.1377],
      ['Анкер забивной М12', 'шт', 269.28],
    ])
    assert.equal(r.map.calc, FORMULAS_MARK)
  })

  it('значение, посчитанное Excel, важнее формулы; ошибка Excel (#Н/Д) — пусто, а не код ошибки 42', () => {
    const rows = MATERIALS.map((row) => [...row])
    rows[3][3] = { f: 'SUMIFS(КП!G:G,КП!D:D,B4)', v: 500 }
    rows[4][3] = { e: 42 }
    const r = parseVorFileBytes(bookBytes({ 'КП': KP, 'МАТЕРИАЛЫ': rows }))
    assert.deepEqual(r.positions.map((p) => p.volume), [500, null, 269.28])
  })

  it('формулу не посчитать (другая функция, нет листа, цикл) — объём пустой, позиция на месте', () => {
    const rows = MATERIALS.map((row) => [...row])
    rows[3][3] = { f: 'XLOOKUP(B4,КП!D:D,КП!G:G)' }
    rows[4][3] = { f: 'SUM(Нет!A:A)' }
    rows[5][3] = { f: 'D6+1' }
    const r = parseVorFileBytes(bookBytes({ 'КП': KP, 'МАТЕРИАЛЫ': rows }))
    assert.deepEqual(r.positions.map((p) => [p.name, p.volume]), [
      ['Труба профильная 40*20*3', null], ['Уголок 70*70*6', null], ['Анкер забивной М12', null],
    ])
  })

  it('без листа «Материалы»: лист ВОР по «КОД» — «Общий расход» формулой (объём × коэффициент)', () => {
    const bytes = bookBytes({
      'ВОР': [
        ['№', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Коэффициент', 'Общий расход'],
        [1, 'Р', 'Монтаж', 'т', 2, '', ''],
        [2, 'мат.', 'Труба профильная 40*20*3', 'м', 100, 1.02, { f: 'ROUND(E3*F3,2)' }],
        [3, 'мат.', 'Анкер забивной М12', 'шт', 264, 1.02, { f: 'E4*F4' }],
      ],
    })
    const r = readMaterialsByCodeBytes(bytes, ['ВОР'])
    assert.deepEqual(r.rows.map((x) => [x.name, Math.round(x.volume * 1e6) / 1e6]), [['Труба профильная 40*20*3', 102], ['Анкер забивной М12', 269.28]])
    assert.equal(r.map.calc, FORMULAS_MARK)
  })

  it('окно «Указать лист и колонки» (книга прочитана целиком без формул) — объём тоже считается', () => {
    const wb = readWorkbookBytes(bookBytes({ 'КП': KP, 'МАТЕРИАЛЫ': MATERIALS }))
    const r = readMaterialsFromWorkbook(wb, { sheetName: 'МАТЕРИАЛЫ', columns: { name: 1, unit: 2, volume: 3 } })
    assert.deepEqual(r.rows.map((x) => x.volume), [567.934, 0.1377, 269.28])
    assert.deepEqual(Object.keys(wb).includes('calcFor'), false, 'служебное у книги не перечисляется')
  })

  it('настоящий файл ВОР из Estimat (если лежит рядом): объёмы — как после «Разрешить редактирование»', { skip: !sampleFile() }, () => {
    const r = parseVorFileBytes(new Uint8Array(fs.readFileSync(sampleFile())))
    const byName = new Map(r.positions.map((p) => [p.name, p.volume]))
    assert.equal(r.positions.length, 9)
    assert.equal(byName.get('Труба профильная 100*40*3 (м/п=6,13 кг) (м)'), 3445.9425)
    assert.equal(byName.get('Уголок 70*70*6 (м/п=6,39 кг) (тн)'), 2.1797)
    assert.equal(byName.get('Анкер забивной М8 (цанга) (шт)'), 2258.28)
    assert.ok(r.positions.every((p) => p.volume > 0))
  })
})

function sampleFile() {
  const candidates = [process.env.VOR_FORMULA_SAMPLE, path.join(ROOT, 'ВОР Изготовление и монтаж площадок и ограждения технических балконов С1-5.xlsx')]
  return candidates.find((f) => f && fs.existsSync(f)) || null
}

describe('Расчёт формул листа', () => {
  const calcOf = (sheets) => {
    const books = Object.fromEntries(Object.entries(sheets).map(([n, rows]) => [n, sheet(rows)]))
    return createSheetCalc((name) => books[Object.keys(books).find((n) => n.toLowerCase() === String(name).toLowerCase())] || null)
  }
  const one = (f, extra = {}) => calcOf({ 'Лист': [[{ f }]], ...extra }).value('Лист', 0, 0)

  it('арифметика, приоритет, %, &, сравнения, IF / IFERROR, округление «половина — от нуля»', () => {
    assert.equal(one('2+3*4^2/8-1'), 7)
    assert.equal(one('-2^2'), 4, 'унарный минус — до степени, как в Excel')
    assert.equal(one('50%*10'), 5)
    assert.equal(one('"а"&1&TRUE'), 'а1TRUE')
    assert.equal(one('IF(2>1,"да","нет")'), 'да')
    assert.equal(one('IFERROR(1/0,7)'), 7)
    assert.equal(one('1/0'), null, 'ошибка — пусто')
    assert.deepEqual([one('ROUND(2.5,0)'), one('ROUND(-2.5,0)'), one('ROUND(1.005,2)'), one('ROUNDUP(1.001,2)'), one('ROUNDDOWN(1.999,1)')], [3, -3, 1.01, 1.01, 1.9])
    assert.equal(one('ABS(-3)+MIN(4,2,9)+MAX(1,5)+AVERAGE(2,4)'), 13)
  })

  it('ссылки: другой лист (в кавычках, с пробелом), целая колонка, строка, $; SUMIF с подстановкой и сравнением; SUMPRODUCT', () => {
    const data = { 'Лист 2': [['Кран Ду15', 10, 2], ['Кран Ду20', 20, 3], ['Труба', 5, 4], ['кран ду25', 1, 1]] }
    const v = (f) => calcOf({ 'Лист': [[{ f }]], ...data }).value('Лист', 0, 0)
    assert.equal(v("SUM('Лист 2'!B:B)"), 36)
    assert.equal(v("SUM('Лист 2'!$B$1:$C$2)"), 35)
    assert.equal(v("SUMIF('Лист 2'!A:A,\"кран*\",'Лист 2'!B:B)"), 31, 'подстановка без учёта регистра')
    assert.equal(v("SUMIF('Лист 2'!B:B,\">=10\")"), 30)
    assert.equal(v("SUMIFS('Лист 2'!B:B,'Лист 2'!A:A,\"<>Труба\",'Лист 2'!C:C,\">1\")"), 30)
    assert.equal(v("SUMPRODUCT('Лист 2'!B1:B3,'Лист 2'!C1:C3)"), 100)
    assert.equal(v("COUNTIF('Лист 2'!A:A,\"Кран?Ду*\")"), 3, '? — один знак (пробел), регистр не важен')
    assert.equal(v("SUM('Лист 2'!2:2)"), 23)
  })

  it('формула ссылается на формулу без значения — считается цепочкой; цикл — пусто', () => {
    const c = calcOf({ 'Л': [[1, { f: 'A1*2' }, { f: 'B1+A1' }], [{ f: 'B2' }, { f: 'A2' }]] })
    assert.equal(c.value('Л', 0, 2), 3)
    assert.equal(c.value('Л', 1, 0), null)
  })

  it('что читать: формулы без значения есть ли; на какие листы ссылаются', () => {
    const ws = sheet([[{ f: "SUMIFS(КП!G:G,КП!D:D,B4)+'Лист 2'!A1+МАТЕРИАЛЫ!A1" }, { f: 'A1', v: 1 }]])
    assert.equal(hasUncalculated(ws), true)
    assert.equal(hasUncalculated(sheet([[{ f: 'A1', v: 1 }, 2]])), false)
    assert.deepEqual(referencedSheets(ws, 'материалы').sort(), ['КП', 'Лист 2'])
  })
})

describe('Списки, разобранные до расчёта формул, служба перечитывает один раз', () => {
  const doc = { id: 'f1', file_name: 'ВОР ограждения.xlsx', created_at: '2026-11-13T12:00:00Z' }
  const source = (over) => ({ id: 's1', estimate_name: 'ВОР ограждения', source: 'vor_file', s3_document_id: 'f1', source_version: fileVersion(doc), ...over })

  it('нет объёмов и нет пометки calc — перечитать; пометка есть или объёмы на месте — нет', () => {
    const noVolumes = source({ column_map: { sheetName: 'МАТЕРИАЛЫ' }, positions: [{ name: 'Труба', volume: null }, { name: 'Уголок', volume: 2 }] })
    assert.equal(needsVolumeRecalc(noVolumes), true)
    const plan = planFileImports([doc], [noVolumes], [])
    assert.deepEqual([plan.jobs.length, plan.recalc.map((j) => j.doc.id)], [0, ['f1']], 'не «ещё не загружен»: перечитывает служба')
    const parsedMap = parseVorFileBytes(bookBytes({ 'КП': KP, 'МАТЕРИАЛЫ': MATERIALS })).map
    const recalculated = source({ column_map: parsedMap, positions: [{ name: 'Труба', volume: null }] })
    assert.equal(needsVolumeRecalc(recalculated), false, 'метка разбора совпадает с меткой автозагрузки')
    assert.deepEqual([planFileImports([doc], [recalculated], []).jobs.length, planFileImports([doc], [recalculated], []).recalc.length], [0, 0])
    assert.equal(needsVolumeRecalc(source({ column_map: {}, positions: [{ name: 'Труба', volume: 1 }] })), false)
    assert.equal(needsVolumeRecalc(source({ column_map: {}, positions: [{ name: 'Кран', units: [{ unit: 'шт', volume: 1 }] }] })), false, 'объёмы — в units')
  })

  it('служба позиций не читает — признак volume_gaps из базы', () => {
    assert.equal(needsVolumeRecalc(source({ column_map: {}, volume_gaps: true })), true)
    assert.equal(needsVolumeRecalc(source({ column_map: {}, volume_gaps: false, positions: [{ volume: null }] })), false)
    assert.equal(needsVolumeRecalc(source({ column_map: { calc: 1 }, volume_gaps: true })), false)
  })
})
