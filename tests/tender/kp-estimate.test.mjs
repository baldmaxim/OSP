// Смета КП / ПЗ во вкладке «Смета» карточки объекта (миграция 20270215): разбор файлов «КП до перекидок» и «Смета»
// (и одного файла «КП + план затрат»: листами одной книги или прямыми затратами столбцами строк КП), структура по
// SUBTOTAL, формулы, коэффициенты; объём — только «Количество (ГП)»; распределение «тендер + подрядчик + объём»,
// превышение, свод по разделам, поиск и «Показать», история, выгрузка в Excel одной таблицей с формулами и заливкой;
// файлы миграций и шлюза; интерфейс на стенде (route=/stand/kp-estimate, 13.11.2026 — одна таблица, окно строки):
// наименования целиком, примечания, объёмы, заливка строк и ячеек, тендер с победителем, правки коллег, новая версия с
// переносом отметок, только просмотр, база без миграции. Книги — вымышленные, в раскладке файлов К14
// (tests/tender/lib/kpEstimateSample.mjs). Настоящие файлы Примавера К14 проверяются, если лежат в корне репозитория
// (в git их нет: репозиторий открытый) или в каталоге KP_ESTIMATE_SAMPLES. База — kp-estimate-db.test.mjs.
// 27.11.2026: раскладки «King & Sons» (лист с ресурсами ПЗ, другие подписи) и «Событие 6.2» (КП с этапами ДГП / ДС, без
// номера позиции) — образцом sampleStagesWorkbook и настоящими файлами (если лежат рядом); цены администратора (20270308):
// действующая цена, пересчёт группы пропорционально, сопоставление документа, миграция и шлюз, режим «Цены» на стенде.
import { describe, it, before, after } from 'node:test'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  sampleBothSheetsWorkbook, sampleKpWorkbook, samplePzWorkbook, sampleStagesWorkbook, sampleTreeWorkbook, SAMPLE_TOTAL, stagesSampleExpect, TREE_COEF,
  TREE_VAT_ACCRUAL, treeSampleExpect,
} from './lib/kpEstimateSample.mjs'
import {
  buildEstimateRows, detectEstimateWorkbook, ESTIMATE_READ_OPTIONS, fitRowKey, masteringToAllocations, parseKpWorkbook, parsePzWorkbook, ROW_KEY_MAX,
} from '../../src/utils/kpEstimateImport.js'
import {
  allocQty, buildTree, collapseToLevel, computeStates, groupStatus, markPayload, originalQty, planTenderAllocation, positionState,
  rowMatchesShow, tenderWinners, visibleRowIds,
} from '../../src/utils/kpEstimate.js'
import { describeLogEntry } from '../../src/utils/kpEstimateLog.js'
import { buildWith, exportRowIds, PRICE_HEAD } from '../../src/utils/kpEstimateExport.js'
import { effectivePrices, priceOf } from '../../src/utils/kpEstimatePrices.js'
import {
  estimateDocLines, estimateTotals, genericDocLines, matchPriceLines, planPriceChanges, priceMatchIndex, pricesAfter,
} from '../../src/utils/kpEstimatePriceDoc.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const XLSXStyle = require('xlsx-js-style')
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')
const reread = (wb) => XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { cellFormula: true })
const launch = browserLaunchOptions()

function sample({ withMastering = false } = {}) {
  const kp = parseKpWorkbook(XLSX, reread(sampleKpWorkbook(XLSX)))
  const pz = parsePzWorkbook(XLSX, reread(samplePzWorkbook(XLSX, { withMastering })))
  return { kp, pz, built: buildEstimateRows({ kp, pz, kpFileName: 'КП.xlsx', pzFileName: 'Смета.xlsx' }) }
}
const withIds = (rows) => rows.map((r) => ({ ...r, id: `r${r.row_no}` }))
const byName = (rows, part) => rows.find((r) => r.name.includes(part))

describe('смета КП / ПЗ: разбор файлов', () => {
  it('КП: вложенность по SUBTOTAL (у подробных позиций коды чужой группы, вставка без кода), виды строк, формулы сверены', () => {
    const { kp, pz, built } = sample()
    assert.equal(detectEstimateWorkbook(XLSX, reread(sampleKpWorkbook(XLSX))), 'kp')
    assert.equal(detectEstimateWorkbook(XLSX, reread(samplePzWorkbook(XLSX))), 'pz')
    assert.equal(kp.hasSubtotals, true)
    const rows = built.rows
    const kind = (part) => byName(rows, part).kind
    assert.equal(kind('Корпус 1'), 'title')
    assert.equal(kind('Раздел 1.'), 'section')
    assert.equal(kind('Нулевой цикл'), 'group')
    assert.equal(kind('Отделка пола автостоянки'), 'aggregate')
    assert.equal(kind('Мастертоп'), 'position')
    const agg = byName(rows, 'Отделка пола автостоянки')
    for (const part of ['Мастертоп', 'Бетонное основание', 'Обмазочная']) {
      const r = byName(rows, part)
      assert.equal(r.parent_row_no, agg.row_no, `${part}: внутри укрупнённой, хотя код 1.1.9.x`)
      assert.ok(r.code.startsWith('1.1.9.'))
    }
    const luk = byName(rows, 'Люк потолочный')
    assert.equal(luk.code, null)
    assert.equal(luk.pos_no, '11.1')
    assert.equal(luk.parent_row_no, byName(rows, 'Нулевой цикл').row_no, 'строка без кода — в своей группе по диапазону SUBTOTAL')
    assert.equal(built.meta.formula_check.issue_count, 0)
    assert.ok(Math.abs(built.meta.formula_check.totals.total - SAMPLE_TOTAL) < 0.01)
    assert.equal(built.stats.linked, 8)
    assert.equal(built.stats.pzOnly, 1)
    assert.equal(built.stats.kpLeavesWithoutPz, 1, 'нулевая «Учтено» — без ПЗ')
    const adjust = rows[rows.length - 1]
    assert.equal(adjust.kind, 'adjust')
    assert.equal(adjust.kp, null, 'округление сметы ПЗ не входит в итог КП')
    assert.equal(new Set(rows.map((r) => r.row_key)).size, rows.length)
    assert.equal(built.meta.title, 'ЖК Пример, корпус 1')
    assert.equal(built.meta.vat, '20%')
    assert.ok(built.meta.coefficients.some((r) => r[0] === 'Работы (раб)' && r[1] === 2.770111), 'коэффициенты — как в файле')
    assert.equal(byName(rows, 'Разработка грунта').pz.direct_works, 1795000)
    assert.equal(pz.positions.length, 9)
  })

  it('длинное наименование: ключ строки не длиннее предела базы, тот же текст — тот же ключ', () => {
    // К14: у видеосерверов SecurOS наименование 1,2–1,4 тыс. знаков — ключ «номер + наименование» база не пускала (≤ 1000).
    const tail = ' Специализированный 209 канальный видеосервер для записи и воспроизведения'.repeat(20)
    const a = `p:2939|видеосервер securos-ivs-nvr-industrial-a0.gapxhlpd${tail}`
    const b = `p:2940|видеосервер securos-ivs-nvr-industrial-a0.gapxhlpe${tail}`
    assert.ok(a.length > 1000)
    assert.ok(fitRowKey(a).length <= ROW_KEY_MAX)
    assert.equal(fitRowKey(a), fitRowKey(a))
    assert.notEqual(fitRowKey(a), fitRowKey(b), 'отличие в середине наименования — другой ключ')
    assert.notEqual(fitRowKey(a), fitRowKey(`${a}.`), 'отличие в конце — тоже')
    assert.equal(fitRowKey('p:3|стена'), 'p:3|стена', 'короткий ключ — как раньше')
    const { kp, pz } = sample()
    const positions = kp.items.filter((it) => it.pos)
    for (const it of positions.slice(0, 2)) it.name = `Видеосервер${tail}`
    const { rows } = buildEstimateRows({ kp, pz })
    const longRows = rows.filter((r) => r.name.length > 1000)
    assert.equal(longRows.length, 2)
    assert.ok(rows.every((r) => r.row_key.length <= ROW_KEY_MAX + 4), 'все ключи проходят ограничение базы')
    assert.equal(new Set(rows.map((r) => r.row_key)).size, rows.length)
    assert.deepEqual(buildEstimateRows({ kp, pz }).rows.map((r) => r.row_key), rows.map((r) => r.row_key), 'та же книга — те же ключи')
  })

  it('расхождение формулы видно до загрузки; книга без формул — вложенность по кодам', () => {
    const wb = reread(sampleKpWorkbook(XLSX))
    const ws = wb.Sheets['Комм. затраты']
    ws.J5.v = 123 // формула G5*O5 даёт 0: значение в файле разошлось с формулой
    const bad = buildEstimateRows({ kp: parseKpWorkbook(XLSX, wb) })
    assert.ok(bad.meta.formula_check.issue_count >= 1)
    assert.ok(bad.meta.formula_check.issues.some((x) => x.code === '1.1.1' && x.key === 'materials'))
    const flat = XLSX.read(XLSX.write(sampleKpWorkbook(XLSX), { type: 'buffer', bookType: 'xlsx' }))
    for (const ref of Object.keys(flat.Sheets['Комм. затраты'])) if (!ref.startsWith('!')) delete flat.Sheets['Комм. затраты'][ref].f
    const kp = parseKpWorkbook(XLSX, flat)
    assert.equal(kp.hasSubtotals, false)
    const rows = buildEstimateRows({ kp }).rows
    assert.equal(byName(rows, 'Разработка грунта').parent_row_no, byName(rows, 'Нулевой цикл').row_no)
    assert.equal(byName(rows, 'Стена').parent_row_no, byName(rows, 'Конструкции').row_no)
  })

  it('только смета ПЗ: разделы по «Коду раздела»; «Освоение» — распределения в объёме', () => {
    const { pz, built } = sample({ withMastering: true })
    const only = buildEstimateRows({ pz })
    assert.equal(only.rows.filter((r) => r.kind === 'section').length, 2)
    assert.equal(only.rows.filter((r) => r.pz).length, 9)
    const { allocations, skipped } = masteringToAllocations(pz.mastering, built.rows)
    assert.equal(skipped.length, 0)
    assert.equal(allocations.length, 1)
    assert.equal(allocations[0].tender_label, 'Тендер № 501')
    assert.ok(Math.abs(allocations[0].pz_qty - 6826800 / 68134) < 1e-5, 'сумма / цена за единицу')
  })

  it('один файл «КП + план затрат»: листами одной книги или прямыми затратами столбцами строк КП', () => {
    const both = reread(sampleBothSheetsWorkbook(XLSX))
    assert.equal(detectEstimateWorkbook(XLSX, both), 'both')
    const fromBoth = buildEstimateRows({ kp: parseKpWorkbook(XLSX, both), pz: parsePzWorkbook(XLSX, both) })
    assert.equal(fromBoth.stats.linked, 8)
    assert.equal(byName(fromBoth.rows, 'Стена').pz.direct, 12283200)
    const inline = reread(sampleKpWorkbook(XLSX, { inlinePz: true }))
    assert.equal(detectEstimateWorkbook(XLSX, inline), 'both')
    const kp = parseKpWorkbook(XLSX, inline)
    assert.equal(kp.hasInlinePz, true)
    const built = buildEstimateRows({ kp })
    assert.equal(built.meta.formula_check.issue_count, 0)
    const wall = byName(built.rows, 'Стена')
    assert.equal(wall.pz.direct, 12283200)
    assert.equal(wall.pz.direct_works, 8000000)
    assert.equal(wall.pz.comm_total, wall.kp.total, 'коммерция — стоимость КП той же строки')
    assert.equal(byName(built.rows, 'Армирование').pz, null, 'нулевая строка «Учтено» — без плана затрат')
    assert.equal(built.meta.kp_file.inline_pz, true)
  })

  // КП с ресурсами ПЗ одним листом (26.11.2026, раскладка «Алия — КП до перекидок после ДС1–8»). Книга читается так же,
  // как в окне загрузки (ESTIMATE_READ_OPTIONS: без cellStyles группировки строк не видно).
  const readTree = (wb, opts = ESTIMATE_READ_OPTIONS) => XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { ...opts })
  it('КП с ресурсами ПЗ: дерево — по группировке строк, ресурсы — в прямые затраты работы, итоги и контрольные расчёты — не строки', () => {
    const exp = treeSampleExpect()
    const wb = readTree(sampleTreeWorkbook(XLSX))
    assert.equal(detectEstimateWorkbook(XLSX, wb), 'both')
    const kp = parseKpWorkbook(XLSX, wb)
    assert.equal(kp.error, undefined, kp.message)
    assert.equal(kp.layout, 'tree')
    assert.equal(kp.nesting, 'outline')
    assert.equal(kp.hasInlinePz, true)
    assert.deepEqual([kp.resources.count, kp.resources.unpriced, kp.resources.orphan], [exp.resources, exp.unpriced, 0])
    const built = buildEstimateRows({ kp, kpFileName: 'Пример — КП до перекидок после ДС1–2.xlsx' })
    const rows = built.rows
    assert.equal(rows.length, exp.kpRows, 'строки — только строки КП')
    for (const name of ['КП после ДС2, с опционом', 'КП в сопоставимой базе', 'Бетон B30', 'Корректировка РД — добавка ДС2', 'Сваи — марку уточнить',
      'Сваи для вдавливания — из таблицы ДС', 'ИТОГО', 'КОНТРОЛЬНЫЕ', 'Коэффициенты', 'ЖК Пример']) {
      assert.ok(!rows.some((r) => r.name.startsWith(name)), `«${name}» — не строка сметы`)
    }
    const kind = (part) => byName(rows, part).kind
    assert.equal(kind('Проектные работы'), 'section')
    assert.equal(kind('Фундаменты'), 'aggregate', 'подраздел с единицей — укрупнённая позиция, как у К14')
    assert.equal(kind('Бетонирование'), 'group')
    assert.equal(kind('Бетонирование фундаментной плиты'), 'position')
    assert.equal(kind('Учтено в других строках'), 'note')
    assert.equal(kind('Входящее расхождение'), 'position', 'контроль ДС1 — деньги КП без единицы')
    assert.equal(kind('Устройство свай вдавливанием'), 'position')
    assert.equal(byName(rows, 'Бетонирование фундаментной плиты').parent_row_no, byName(rows, 'Бетонирование').row_no)
    assert.equal(byName(rows, 'Люк потолочный').parent_row_no, byName(rows, 'Корпус 1').row_no, 'вставка без кода — по группировке')
    assert.equal(byName(rows, 'Люк потолочный').pos_no, '7.1')
    // Глубже 7 уровней ресурсы стоят на уровне своей работы — относятся к строке КП над ними.
    const walls = byName(rows, 'Стены')
    assert.equal(byName(rows, 'Грунтовка стен').parent_row_no, walls.row_no)
    assert.equal(byName(rows, 'Шпаклёвка стен').parent_row_no, walls.row_no)
    assert.equal(byName(rows, 'Грунтовка стен').pz.direct, 2200)
    assert.equal(byName(rows, 'Шпаклёвка стен').pz.direct, 2000)
    assert.equal(byName(rows, 'Шпаклёвка стен').level, 8)

    const plate = byName(rows, 'Бетонирование фундаментной плиты')
    assert.equal(plate.kp.qty_gp, 400)
    assert.equal(plate.kp.total, 4800000)
    assert.equal(plate.customer_note, 'По РД КЖ')
    assert.deepEqual([plate.pz.direct, plate.pz.direct_main, plate.pz.direct_aux, plate.pz.direct_works], [3540000, 2900000, 40000, 600000])
    assert.equal(plate.pz.comm_total, plate.kp.total, 'коммерция — стоимость КП (по ней цена за единицу), не «ПЗ × коэфф.»')
    assert.ok(Math.abs(plate.pz.coef_total - (600000 * TREE_COEF['раб'] + (2800000 + 40000) * TREE_COEF['мат'] + 100000 * TREE_COEF['суб-мат'])) < 1e-6)
    assert.deepEqual([plate.pz.resources, plate.pz.unpriced], [5, 1])
    const rd = byName(rows, 'Разработка рабочей документации')
    assert.deepEqual([rd.pz.direct, rd.pz.direct_works, rd.pz.resources, rd.pz.unpriced], [2400000, 2400000, 2, 1], '«Работы» — ресурс, не строка')
    assert.equal(rd.gp_note, 'Финансовый лимит по ДС1')
    const ds = byName(rows, 'Устройство свай вдавливанием')
    assert.equal(ds.pz.direct, null, 'ресурс без цены — прямых затрат нет')
    assert.equal(ds.pz.note, 'Новая договорная позиция ДС1.', 'статус строки — примечанием ПЗ')

    // Сверка: только заголовок подраздела с постоянным 0 (его предки верны); итоги — как строка файла в базе строк.
    const fc = built.meta.formula_check
    assert.deepEqual(fc.issues.map((x) => `${x.code}:${x.key}`), ['К1.1.1:materials', 'К1.1.1:works', 'К1.1.1:total'])
    assert.equal(fc.issues[2].expected, 4800000)
    assert.equal(fc.issues[2].actual, 0)
    assert.equal(fc.totals.total, exp.total)
    assert.equal(fc.totals.direct, exp.direct)
    assert.equal(built.meta.kp_file.totals.label, 'КП в сопоставимой базе НДС 20%, с опционом')
    assert.equal(built.meta.kp_file.layout, 'tree')
    assert.equal(built.meta.title, 'Пример — КП до перекидок после ДС1–2')
    assert.match(built.meta.vat, /НДС 20% \/ 22%/)
    const pass = built.meta.passport
    assert.deepEqual(pass[0], ['ПРИМЕР  /  КП ДО ПЕРЕКИДОК'])
    const head = pass.find((r) => r[0] === 'КП после ДС2, с опционом')
    assert.ok(head?.[1].includes((exp.total + TREE_VAT_ACCRUAL).toLocaleString('ru-RU', { minimumFractionDigits: 2 })), 'итог с доначислением НДС — в паспорте')
    assert.deepEqual(built.meta.coefficients[0], ['Коэффициенты Пример · версия 1'])
    assert.deepEqual(built.meta.coefficients[1], [null, 'раб', 'мат', 'суб-раб', 'суб-мат', 'Позиций с ростом'])
    assert.deepEqual(built.meta.coefficients[2].slice(0, 5), ['ЖК Пример', 2.4, 1.6, 1.25, 1.25])

    const tree = buildTree(withIds(rows))
    const { total, sums } = computeStates(tree, new Map(), new Map())
    assert.equal(total.total, exp.total)
    assert.equal(total.direct, exp.direct)
    assert.deepEqual([total.directMain, total.directAux, total.directWorks], [exp.main, exp.aux, exp.dworks])
    assert.equal(sums.get(tree.rows.find((r) => r.name === 'Бетонирование').id).total, 4800000, 'группа — суммой строк, а не 0 из файла')
    assert.equal(new Set(rows.map((r) => r.row_key)).size, rows.length)
    assert.ok(rows.every((r) => !r.parent_row_no || r.parent_row_no < r.row_no))
  })

  it('КП с ресурсами ПЗ без группировки строк — отказ с объяснением, а не плоское дерево', () => {
    const flat = readTree(sampleTreeWorkbook(XLSX), { cellFormula: true }) // без cellStyles SheetJS не читает уровни
    assert.equal(detectEstimateWorkbook(XLSX, flat), 'both')
    const kp = parseKpWorkbook(XLSX, flat)
    assert.equal(kp.error, 'kp_outline')
    assert.match(kp.message, /группировки строк/)
    assert.equal(parseKpWorkbook(XLSX, readTree(sampleTreeWorkbook(XLSX, { outline: false }))).error, 'kp_outline')
  })

  const aliya = path.join(process.env.KP_ESTIMATE_SAMPLES || REPO, 'Алия — КП до перекидок после ДС1–8.xlsx')
  it('настоящий файл «Алия — КП до перекидок после ДС1–8»: 4933 строки КП, итоги и прямые затраты — как в файле, контрольные расчёты — не строки',
    { skip: !fs.existsSync(aliya) && 'нет файла «Алия» (в git его нет)' }, () => {
      const wb = XLSX.readFile(aliya, { ...ESTIMATE_READ_OPTIONS })
      assert.equal(detectEstimateWorkbook(XLSX, wb), 'both')
      const kp = parseKpWorkbook(XLSX, wb)
      assert.equal(kp.error, undefined, kp.message)
      const built = buildEstimateRows({ kp, kpFileName: path.basename(aliya) })
      assert.equal(built.rows.length, 4933)
      assert.equal(kp.resources.orphan, 0)
      // Суммы не записываем (репозиторий открытый): сверяем с итогами самого файла над деревом.
      const ft = kp.fileTotals
      assert.match(ft.label, /сопоставим/)
      const fc = built.meta.formula_check
      for (const key of ['materials', 'works', 'total', 'direct']) assert.ok(Math.abs(fc.totals[key] - ft[key]) < 0.05, key)
      // Расхождения — только у четырёх заголовков подразделов с постоянным 0 над оценённой работой.
      assert.equal(fc.issue_count, 12)
      assert.equal(new Set(fc.issues.map((x) => x.row)).size, 4)
      assert.ok(fc.issues.every((x) => x.row && x.key !== 'direct'))
      const tree = buildTree(withIds(built.rows))
      const { total } = computeStates(tree, new Map(), new Map())
      assert.ok(Math.abs(total.total - ft.total) < 0.05)
      assert.ok(Math.abs(total.direct - ft.direct) < 0.05)
      // Контрольные расчёты под деревом — не строки: все строки сметы выше их заголовка.
      const ws = wb.Sheets[kp.sheetName]
      let control = 0
      for (let r = 1; r <= XLSX.utils.decode_range(ws['!ref']).e.r + 1 && !control; r++) if (/^КОНТРОЛЬНЫЕ РАСЧ/i.test(String(ws[`A${r}`]?.v || ''))) control = r
      assert.ok(control > 0)
      assert.ok(built.rows.every((r) => r.kp.sheet_row < control))
      assert.ok(built.meta.coefficients.length >= 3)
      // Ни у одного ресурса нет цены — прямые затраты пусты, а не 0 (файл: «пустые цены — неизвестные, а не нулевые»).
      assert.ok(!built.rows.some((r) => r.pz?.direct === 0 && r.pz.resources && r.pz.unpriced === r.pz.resources))
      // Деньги без «Кол-ва (ГП)» (распределить объёмом нельзя) — только два «Контроль ДС1» и две работы «к-с» с ГП = 0 в файле.
      assert.equal(built.rows.filter((r) => r.kind === 'position' && r.kp?.total && !r.kp.qty_gp).length, 4)
      assert.ok(built.rows.every((r) => r.row_key.length <= 1000 && r.level <= 30 && (!r.parent_row_no || r.parent_row_no < r.row_no)))
      assert.equal(new Set(built.rows.map((r) => r.row_key)).size, built.rows.length)
    })

  const realDir = process.env.KP_ESTIMATE_SAMPLES || REPO
  const realKp = path.join(realDir, 'Примавера К14 - КП до перекидок.xlsx')
  const realPz = path.join(realDir, 'Смета.xlsx')
  it('настоящие файлы ЖК Примавера К14: 3808 строк, 13 укрупнённых, 3144 связи КП ↔ ПЗ, формулы и итоги сходятся',
    { skip: !(fs.existsSync(realKp) && fs.existsSync(realPz)) && 'нет файлов К14 (в git их нет)' }, () => {
      const kp = parseKpWorkbook(XLSX, XLSX.readFile(realKp, { cellFormula: true }))
      const pz = parsePzWorkbook(XLSX, XLSX.readFile(realPz, { cellFormula: true }))
      const built = buildEstimateRows({ kp, pz })
      assert.equal(built.rows.length, 3808)
      assert.equal(built.rows.filter((r) => r.kind === 'aggregate').length, 13)
      assert.equal(built.stats.linked, 3144)
      assert.equal(built.stats.pzOnly, 1)
      assert.equal(built.meta.formula_check.issue_count, 0)
      assert.ok(Math.abs(built.meta.formula_check.totals.total - 15800025574.65) < 0.01)
      const tree = buildTree(withIds(built.rows))
      const { total } = computeStates(tree, new Map(), new Map())
      assert.ok(Math.abs(total.total - 15800025574.65) < 0.02, 'итог — как в «Сводке» (с округлением)')
      assert.ok(Math.abs(total.direct - 11981170163.07) < 0.02, 'прямые затраты — как в «Паспорте»')
      assert.ok(JSON.stringify(built.rows).length < 3_500_000, 'строки без повторов названия раздела')
      assert.equal(built.rows.filter((r) => r.name.length > 1000).length, 3, 'видеосерверы SecurOS — наименования длиннее 1000 знаков')
      assert.ok(built.rows.every((r) => r.row_key.length <= 1000), 'ключи строк проходят kp_estimate_rows_row_key_check')
      // Объём — только «Количество (ГП)»: у позиций с кол-вом заказчика без ГП стоимость нулевая (учтены в других строках).
      const noGp = built.rows.filter((r) => r.unit && !r.kp?.qty_gp && (r.kp?.qty_customer || r.pz?.qty_customer))
      assert.equal(noGp.length, 324)
      assert.ok(noGp.every((r) => originalQty(r) === 0 && !(r.kp?.total || r.pz?.comm_total)))
    })
})

describe('смета КП / ПЗ: объёмы, распределения, свод', () => {
  const row = { id: 'p', kind: 'position', unit: 'м3', kp: { qty_gp: 100, qty_customer: 120, total: 1_000_000 }, pz: { comm_total: 1_000_000 } }
  it('объём — только «Количество (ГП)», кол-во заказчика не подставляется', () => {
    assert.equal(originalQty(row), 100)
    assert.equal(originalQty({ ...row, kp: { qty_gp: null, qty_customer: 50, total: 0 } }), 0)
    assert.equal(positionState({ ...row, kp: { qty_gp: 0, qty_customer: 9100, total: 0 }, pz: null }, null, []).status, 'empty')
  })
  it('распределения «тендер + подрядчик + объём» складываются; старые строки с договором — по большему из двух объёмов', () => {
    const s = positionState(row, null, [
      { id: 'a1', tender_id: 'T1', counterparty_id: 'C1', pz_qty: 30 },
      { id: 'a2', tender_id: 'T1', counterparty_id: 'C2', pz_qty: 20 },
      { id: 'a3', counterparty_name: 'ООО Без тендера', pz_qty: 10 },
      { id: 'a4', tender_id: 'T2', pz_qty: 5, contract_qty: 15 },
    ])
    assert.equal(allocQty({ pz_qty: 5, contract_qty: 15 }), 15)
    assert.equal(s.distributed, 75, '30 + 20 + 10 + 15')
    assert.equal(s.free, 25)
    assert.equal(s.status, 'partial')
    assert.equal(s.price, 10000)
    assert.equal(s.distributedMoney, 750000)
  })
  it('превышение актуального — «превышение», распределения не меняются', () => {
    const allocs = [{ id: 'a1', tender_id: 'T1', counterparty_id: 'C', pz_qty: 70 }]
    const s = positionState(row, { actual_qty: 60 }, allocs)
    assert.equal(s.distributed, 70)
    assert.equal(s.free, -10)
    assert.equal(s.status, 'over')
    assert.equal(s.diff, -40)
    assert.equal(s.changed, true)
    assert.equal(allocs[0].pz_qty, 70, 'распределения — как были')
    assert.equal(positionState(row, null, []).status, 'none')
    assert.equal(positionState(row, null, [{ id: 'x', tender_id: 'T', pz_qty: 100 }]).status, 'full')
  })
  it('свод по разделам, видимые строки, распределение выделенного: тендер + подрядчик, пара не дублируется', () => {
    const rows = withIds(sample().built.rows)
    const tree = buildTree(rows)
    const id = (part) => byName(rows, part).id
    const marks = new Map([[id('Стена'), { actual_qty: 150, note: 'проверить' }]])
    const allocs = new Map([[id('Стена'), [{ id: 'a', row_id: id('Стена'), tender_id: 'T', counterparty_id: 'C', pz_qty: 160 }]]])
    const { states, sums, total } = computeStates(tree, marks, allocs)
    assert.equal(states.get(id('Стена')).status, 'over')
    assert.equal(groupStatus(sums.get(id('Раздел 2.'))), 'over')
    assert.equal(sums.get(id('Раздел 2.')).counts.over, 1)
    assert.ok(Math.abs(total.total - SAMPLE_TOTAL) < 0.01)
    assert.ok(total.direct > 0, 'прямые затраты — тем же сводом')
    assert.equal(total.notes, 1)
    const lv1 = visibleRowIds(tree, { collapsed: collapseToLevel(tree, 1) })
    assert.deepEqual(lv1.map((x) => tree.byId.get(x).kind), ['title', 'section', 'section', 'adjust'])
    const found = visibleRowIds(tree, { match: new Set([id('Обмазочная')]), collapsed: collapseToLevel(tree, 1) })
    assert.deepEqual(found, [id('Раздел 1.'), id('Нулевой цикл'), id('Отделка пола автостоянки'), id('Обмазочная')], 'найденная — с предками, свёртка не мешает')
    const target = { tender_id: 'T2', tender_label: '№ 2', counterparty_id: 'C9', counterparty_name: 'ООО Девять' }
    const plan = planTenderAllocation({ rowIds: [id('Стена'), id('Плита'), id('Раздел 1.')], tree, states, allocsByRow: allocs, target })
    assert.deepEqual(plan.inserts.map((x) => [x.row_id, x.pz_qty, x.tender_id, x.counterparty_id]), [[id('Плита'), 300, 'T2', 'C9']], 'стена без остатка — пропущена, раздел — не позиция')
    assert.deepEqual(plan.skipped, [id('Стена')])
    // У плиты уже есть эта пара (100) — строка не дублируется, её объём растёт на остаток 200.
    const allocs2 = new Map([[id('Плита'), [{ id: 'b', row_id: id('Плита'), tender_id: 'T2', counterparty_id: 'C9', pz_qty: 100, row_version: 3 }]]])
    const again = planTenderAllocation({ rowIds: [id('Плита')], tree, states: computeStates(tree, new Map(), allocs2).states, allocsByRow: allocs2, target })
    assert.equal(again.inserts.length, 0)
    assert.deepEqual(again.updates.map((u) => [u.id, u.pz_qty, u.row_version]), [['b', 300, 3]])
    // Тот же тендер, другой подрядчик — новая строка.
    const other = planTenderAllocation({ rowIds: [id('Плита')], tree, states: computeStates(tree, new Map(), allocs2).states, allocsByRow: allocs2, target: { tender_id: 'T2' } })
    assert.equal(other.inserts.length, 1)
  })
  it('победители тендера, «Показать», отметки, история', () => {
    const pickers = { counterparties: [{ id: 'c1', name: 'А' }, { id: 'c2', name: 'Б' }], winners: [{ tender_id: 't1', counterparty_id: 'c2' }] }
    assert.deepEqual(tenderWinners(pickers, 't1').map((c) => c.name), ['Б'])
    assert.deepEqual(tenderWinners(pickers, null), [])
    const r = { kind: 'position', unit: 'м' }
    assert.equal(rowMatchesShow(r, { note: 'x' }, { status: 'none' }, 'note'), true)
    assert.equal(rowMatchesShow(r, null, { status: 'none' }, 'over'), false)
    assert.equal(rowMatchesShow(r, null, { status: 'over' }, 'over'), true)
    assert.equal(rowMatchesShow({ kind: 'group' }, null, null, 'none'), false)
    assert.equal(rowMatchesShow(r, null, { status: 'partial', changed: true }, 'changed'), true)
    assert.equal(rowMatchesShow(r, null, null, 'all'), true)
    assert.deepEqual(markPayload({ fill: '#123456', cell_fills: { actual: '#fff3bf', bad: 'red', 'x y': '#fff3bf' }, note: 'a'.repeat(5000), actual_qty: '12.5', responsible_id: 'u1' }),
      { fill: null, cell_fills: { actual: '#fff3bf' }, note: 'a'.repeat(4000), actual_qty: 12.5 }, 'ответственного больше нет — не пишется')
    const d = describeLogEntry({ entity: 'mark', action: 'update', changes: { actual_qty: { old: null, new: 120 }, note: { old: 'был', new: 'стал' }, fill: { old: null, new: '#fff3bf' } } })
    assert.deepEqual(d.lines, ['Примечание: «был» → «стал»', 'Заливка строки: — → жёлтый', 'Актуальный объём: — → 120'])
    const a = describeLogEntry({ entity: 'allocation', action: 'insert', changes: { tender_label: { old: null, new: '№ 501' }, pz_qty: { old: null, new: 120 }, counterparty_name: { old: null, new: 'ООО Монолит' }, _allocation: { tender: '№ 501' } } })
    assert.equal(a.title, 'Распределение добавлено')
    assert.deepEqual(a.lines, ['Тендер: «№ 501»', 'Объём: 120', 'Подрядчик: «ООО Монолит»'])
    const e = describeLogEntry({ entity: 'estimate', action: 'activate', changes: { title: 'К1', kp_file: 'КП.xlsx', rows: 16, previous_id: 'x', moved_marks: 2, moved_allocations: 1, left_marks: 1 } })
    assert.match(e.lines.join(' '), /Перенесено с прежней версии: отметок 2, распределений 1.*отметок 1/)
  })
})

describe('смета КП / ПЗ: выгрузка в Excel', () => {
  const rows = withIds(sample().built.rows)
  const tree = buildTree(rows)
  const id = (part) => byName(rows, part).id
  const marks = new Map([[id('Стена'), { actual_qty: 150, fill: '#fff3bf', cell_fills: { note: '#ffe3e3' }, note: 'проверить' }]])
  const allocsByRow = new Map([[id('Стена'), [
    { id: 'a', row_id: id('Стена'), tender_id: 'T', tender_label: '№ 501', counterparty_name: 'ООО Монолит', pz_qty: 120 },
    { id: 'b', row_id: id('Стена'), tender_label: null, counterparty_name: 'ООО Отделка', pz_qty: 10 },
  ]]])
  const c = computeStates(tree, marks, allocsByRow)
  const ctx = { tree, marks, allocsByRow, states: c.states, sums: c.sums, total: c.total, meta: sample().built.meta, estimate: { title: 'К1' } }

  it('вся смета: одна таблица КП + ПЗ с формулами, распределение, заливка, коэффициенты', () => {
    const buf = buildWith(XLSXStyle, ctx, { ids: exportRowIds(tree, null) })
    const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellStyles: true })
    assert.deepEqual(wb.SheetNames, ['Смета', 'Распределение', 'Коэффициенты', 'Паспорт'])
    const ws = wb.Sheets['Смета']
    const R = rows.findIndex((r) => r.name.includes('Стена')) + 2
    assert.equal(ws[`E${R}`].v, 200, 'кол-во ГП')
    assert.equal(ws[`H${R}`].f, `F${R}+G${R}`)
    assert.equal(ws[`I${R}`].f, `IF(E${R}<>0,H${R}/E${R},"")`)
    assert.equal(ws[`J${R}`].v, 12283200, 'прямые затраты — в той же строке')
    assert.equal(ws[`N${R}`].v, 150)
    assert.equal(ws[`P${R}`].v, 130)
    assert.equal(ws[`Q${R}`].f, `N${R}-P${R}`)
    assert.match(ws[`R${R}`].v, /№ 501 · ООО Монолит: 120; ООО Отделка: 10/)
    const aggRow = rows.findIndex((r) => r.kind === 'aggregate') + 2
    assert.equal(ws[`H${aggRow}`].f, `SUBTOTAL(9,H${aggRow + 1}:H${aggRow + 3})`)
    assert.equal(ws[`J${aggRow}`].f, `SUBTOTAL(9,J${aggRow + 1}:J${aggRow + 3})`)
    const last = rows.length + 2
    assert.equal(ws[`C${last}`].v, 'ИТОГО')
    assert.equal(ws[`H${last}`].f, `SUBTOTAL(9,H2:H${last - 1})`)
    const dist = XLSX.utils.sheet_to_json(wb.Sheets['Распределение'], { header: 1 })
    assert.equal(dist.length, 3)
    assert.deepEqual([dist[1][3], dist[1][4], dist[1][5]], ['№ 501', 'ООО Монолит', 120])
    assert.equal(wb.Sheets['Распределение'].H2.f, 'F2*G2')
    const fill = (sheet, ref) => sheet[ref]?.s?.fgColor?.rgb || sheet[ref]?.s?.fill?.fgColor?.rgb
    assert.match(String(fill(ws, `C${R}`)), /FFF3BF/i, 'заливка строки')
    assert.match(String(fill(ws, `S${R}`)), /FFE3E3/i, 'заливка ячейки «Примечание»')
    assert.ok(XLSX.utils.sheet_to_json(wb.Sheets['Коэффициенты'], { header: 1 }).some((r) => r[0] === 'Материалы (мат)'))
  })

  it('выделенное: строки с предками, SUBTOTAL группы — по выгруженным строкам', () => {
    const ids = exportRowIds(tree, [id('Обмазочная')])
    assert.deepEqual(ids, [id('Раздел 1.'), id('Нулевой цикл'), id('Отделка пола автостоянки'), id('Обмазочная')])
    const wb = XLSX.read(buildWith(XLSXStyle, ctx, { ids }), { type: 'array', cellFormula: true })
    assert.equal(wb.Sheets['Смета'].H2.f, 'SUBTOTAL(9,H3:H5)')
    assert.equal(wb.Sheets['Смета'].H4.f, 'SUBTOTAL(9,H5:H5)')
  })
})

describe('смета КП / ПЗ: миграция, шлюз, права', () => {
  const sb = read('supabase/migrations/20270215_kp_estimate.sql')
  const ya = read('migration/yandex/20270215_kp_estimate.sql')
  it('обе базы: те же таблицы, функции и триггеры; права — каждая по-своему', () => {
    const body = (text) => text.slice(text.indexOf('-- ── Таблицы'), text.search(/-- ── Права (под одну учётку|──)/)).replace(/-- osp:allow[^\n]*\n/g, '')
    assert.equal(body(sb), body(ya))
    assert.match(ya, /FORCE ROW LEVEL SECURITY/)
    assert.match(ya, /osp_object_scope\(\)/)
    assert.match(sb, /kp_estimate_in_scope\(object_id\)/)
    assert.match(sb, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/)
    for (const t of ['kp_estimates', 'kp_estimate_rows', 'kp_estimate_marks', 'kp_estimate_allocations', 'kp_estimate_log']) assert.match(ya, new RegExp(`-- osp:allow table ${t} authenticated=`))
    assert.match(ya, /-- osp:allow rpc kp_estimate_activate authenticated/)
    assert.match(read('migration/yandex/20270215_kp_estimate.check.sql'), /OK/)
    assert.match(read('migration/backup/checks/20270215.sql'), /to_regclass/)
    assert.match(read('migration/rollback/20270215_kp_estimate_rollback.sql'), /Данные НЕ удаляются/)
  })
  it('шлюз: таблицы в списке и карте прав разделов, раздел прав kp_estimate, место загрузки исходных файлов', () => {
    const allow = JSON.parse(read('server/osp-api/src/data/allow.json'))
    assert.deepEqual(allow.tables.kp_estimate_rows, { authenticated: ['insert', 'select'] })
    assert.deepEqual(allow.tables.kp_estimate_log, { authenticated: ['select'] })
    assert.deepEqual(allow.rpc.kp_estimate_activate, ['authenticated'])
    const map = JSON.parse(read('server/osp-api/src/data/db-sections.json'))
    assert.equal(map.tables.kp_estimate_rows.update, 'none')
    assert.deepEqual(map.tables.kp_estimate_marks.update, [{ any: [['kp_estimate', 'edit']] }])
    assert.match(read('src/contexts/roleConstants.js'), /kp_estimate: 'Объекты: смета КП\/ПЗ'/)
    assert.match(read('server/osp-api/src/routes/s3Presign.js'), /kp_estimate_kp: \[\['kp_estimate', 'edit'\]\]/)
    assert.match(read('tests/osp-api/lib/upload-sites.mjs'), /src\/services\/kpEstimate\.js/)
  })
})

describe('смета КП / ПЗ: раскладки «Событие 6.2» и «King & Sons» (27.11.2026)', () => {
  const stagesWb = () => XLSX.read(XLSX.write(sampleStagesWorkbook(XLSX), { type: 'buffer', bookType: 'xlsx' }), { ...ESTIMATE_READ_OPTIONS })

  it('КП с этапами договора: без номера позиции, вложенность по SUBTOTAL материалов и работ, объём по кол-ву заказчика, этапы — в паспорт', () => {
    const wb = stagesWb()
    assert.equal(detectEstimateWorkbook(XLSX, wb), 'kp')
    const kp = parseKpWorkbook(XLSX, wb)
    assert.equal(kp.layout, 'stages')
    assert.equal(kp.nesting, 'subtotal', 'итог строки — SUM(материалы:работы), SUBTOTAL — у материалов и работ: не по кодам')
    const built = buildEstimateRows({ kp, kpFileName: 'Событие_пример.xlsx' })
    const exp = stagesSampleExpect()
    assert.equal(built.meta.title, 'Событие пример')
    assert.deepEqual(built.rows.map((r) => [r.kind, r.parent_row_no, r.code]), [
      ['section', null, '01'], ['position', 1, '01.01.01'], ['position', 1, '01.01.02'], ['position', 1, '01.01.03'],
      ['section', null, '02'], ['position', 5, '02.01.01'], ['position', 5, '02.01.02'], ['position', null, null],
    ])
    assert.equal(built.meta.formula_check.issue_count, 0)
    assert.equal(Math.round(built.meta.formula_check.totals.total * 100), Math.round(exp.kp * 100))
    // «Кол-во ГП» пусто, сумма — от кол-ва заказчика: объём позиции тот же; «Учтено в …» без денег — с ГП (0).
    const rasp = built.rows.find((r) => r.code === '02.01.01')
    assert.equal(rasp.kp.qty_gp, 44.654)
    assert.equal(rasp.kp.qty_basis, 'customer')
    assert.equal(rasp.kp.qty_gp_file, null)
    assert.equal(built.rows.find((r) => r.code === '01.01.03').kp.qty_gp, 0)
    assert.equal(kp.qtyByCustomer, exp.customerBasis)
    // Этапы — в паспорт и meta, в строки сметы не идут; строки под итогом («Новые позиции ПСДЦ») — не строки сметы.
    assert.deepEqual(kp.stages.map((st) => st.short), ['ДГП', 'ДС №1 01.03.2026'])
    assert.equal(kp.stages[0].totals.total, exp.dgp + 200000)
    assert.match(kp.stages[0].note, /подписанное ПСДЦ/)
    assert.ok(built.meta.kp_file.stages.length === 2)
    assert.ok(built.meta.passport.some(([k, v]) => k === 'Ниже итога файла (в смету не вошло)' && /Новые позиции ПСДЦ/.test(v)))
    assert.ok(!built.rows.some((r) => r.code === '06.01.07'))
    assert.ok(!('stages' in built.rows[1].kp))
  })

  const samples = process.env.KP_ESTIMATE_SAMPLES || REPO
  const ks = path.join(samples, 'King_Sons_КП_до_перекидок_единый_ДС1-14.xlsx')
  it('настоящий файл King & Sons: лист с ресурсами ПЗ другими подписями — 1934 строки, КП и ПЗ = итогу над шапкой, цена договора — в паспорт',
    { skip: !fs.existsSync(ks) && 'нет файла King & Sons (в git его нет)' }, () => {
      const kp = parseKpWorkbook(XLSX, XLSX.readFile(ks, { ...ESTIMATE_READ_OPTIONS }))
      assert.equal(kp.layout, 'tree')
      const built = buildEstimateRows({ kp, kpFileName: path.basename(ks) })
      assert.equal(built.rows.length, 1934)
      assert.equal(built.meta.formula_check.issue_count, 0)
      assert.equal(kp.fileTotals.label, 'ИТОГО ПО РЕСУРСНОМУ РАСЧЁТУ')
      assert.ok(Math.abs(built.meta.formula_check.totals.total - kp.fileTotals.total) < 0.05)
      assert.ok(Math.abs(built.meta.formula_check.totals.direct - kp.fileTotals.direct) < 0.05)
      assert.ok(built.meta.passport.some(([k]) => /Цена договора/.test(k)))
      // Раздел с единицей («Планировочная организация земельного участка», компл) — раздел, не укрупнённая позиция.
      assert.equal(built.rows.filter((r) => r.kind === 'aggregate').length, 0)
      assert.equal(built.rows.filter((r) => r.kind === 'section').length, 9)
    })

  const ev = path.join(samples, 'Событие_6_2_КП_до_перекидок,_ДГП,_Допники.xlsx')
  it('настоящий файл «Событие 6.2»: 1331 строка, итог КП = ИТОГО файла, этапы ДГП и ДС №1–3, объём по кол-ву заказчика у 70 позиций',
    { skip: !fs.existsSync(ev) && 'нет файла «Событие 6.2» (в git его нет)' }, async () => {
      const kp = parseKpWorkbook(XLSX, XLSX.readFile(ev, { ...ESTIMATE_READ_OPTIONS }))
      assert.equal(kp.layout, 'stages')
      const built = buildEstimateRows({ kp, kpFileName: path.basename(ev) })
      assert.equal(built.rows.length, 1331)
      assert.equal(built.meta.formula_check.issue_count, 0)
      assert.ok(Math.abs(built.meta.formula_check.totals.total - kp.fileTotals.total) < 0.05)
      assert.deepEqual(kp.stages.map((st) => st.short), ['ДГП', 'ДС №1 01.03.2026', 'ДС №2 03.07.2026', 'ДС №3 23.09.2026'])
      assert.equal(kp.qtyByCustomer, 70)
      // Цены этапа ДГП — документом по тому же файлу: все строки по ключу, итог = сумма ДГП позиций сметы (без «новых позиций ПСДЦ»).
      const tree = buildTree(built.rows.map((r) => ({ ...r, id: `r${r.row_no}` })))
      const lines = estimateDocLines(kp, 0)
      const matched = await matchPriceLines(lines, await priceMatchIndex(tree))
      assert.equal(matched.filter((m) => m.match?.via === 'key').length, lines.length)
      const plan = planPriceChanges(matched, { tree, effective: new Map() })
      const after = estimateTotals(tree, new Map(), effectivePrices(tree, pricesAfter(new Map(), plan.items))).after
      const dgpLeaves = lines.reduce((sum, l) => sum + (l.total || 0), 0)
      assert.ok(Math.abs(after - dgpLeaves) < 1, `${after} ≈ ${dgpLeaves}`)
    })
})

describe('смета КП / ПЗ: цены администратора (20270308)', () => {
  const stagesTree = () => {
    const kp = parseKpWorkbook(XLSX, XLSX.read(XLSX.write(sampleStagesWorkbook(XLSX), { type: 'buffer', bookType: 'xlsx' }), { ...ESTIMATE_READ_OPTIONS }))
    const built = buildEstimateRows({ kp, kpFileName: 'Событие_пример.xlsx' })
    return { kp, tree: buildTree(built.rows.map((r) => ({ ...r, id: `r${r.row_no}` }))) }
  }
  const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)

  it('без изменений — цены файла; своя цена позиции; сумма группы — состав пропорционально, своя цена внутри закреплена', () => {
    const { tree } = stagesTree()
    assert.equal(effectivePrices(tree, new Map()).size, 0)
    const sec = tree.byId.get('r1')
    const road = tree.byId.get('r2')
    const fence = tree.byId.get('r3')
    const base = (r) => r.kp.total
    // Своя цена позиции: стоимость = цена × кол-во ГП.
    let eff = effectivePrices(tree, new Map([['r2', { unit_price: 3000 }]]))
    near(eff.get('r2').total, 3000 * 765)
    assert.equal(eff.get('r2').own.unit_price, 3000)
    near(eff.get('r1').total, 3000 * 765 + base(fence))
    assert.equal(priceOf(eff, road), 3000)
    // Сумма раздела: позиции пересчитаны одним множителем, сумма раздела — заданная.
    const target = 5000000
    eff = effectivePrices(tree, new Map([['r1', { total: target }]]))
    const f = target / (base(road) + base(fence))
    near(eff.get('r2').total, base(road) * f)
    near(eff.get('r3').total, base(fence) * f)
    near(eff.get('r2').factor, f, 1e-9)
    assert.ok(eff.get('r2').scaled && eff.get('r2').changed)
    near(eff.get('r1').total, target)
    // Своя цена позиции внутри + сумма раздела: своя — как введена (закреплена), остаток суммы — остальным позициям.
    eff = effectivePrices(tree, new Map([['r1', { total: target }], ['r2', { unit_price: 3000 }]]))
    near(eff.get('r2').total, 3000 * 765)
    assert.equal(eff.get('r2').unit, 3000)
    assert.equal(eff.get('r2').scaled, false)
    near(eff.get('r3').total, target - 3000 * 765)
    near(eff.get('r1').total, target)
    // Закреплённое больше суммы раздела — сумма не достигнута, остальное — 0.
    const over = effectivePrices(tree, new Map([['r1', { total: 1000 }], ['r2', { unit_price: 3000 }]]))
    assert.equal(over.get('r1').unreached, true)
    near(over.get('r3').total, 0)
    // Итог сметы и деньги остатка — по действующей цене.
    const states = computeStates(tree, new Map(), new Map(), eff)
    near(states.sums.get('r1').current, target, 0.05)
    assert.equal(states.total.priceChanged, 2)
    assert.equal(sec.kind, 'section')
  })

  it('позиция без «Кол-ва (ГП)» — новой суммой; группа с нулевым составом — без множителя', () => {
    const tree = buildTree([
      { id: 'a', row_no: 1, parent_row_no: null, level: 1, kind: 'section', name: 'Раздел', kp: { total: 0 } },
      { id: 'b', row_no: 2, parent_row_no: 1, level: 2, kind: 'position', name: 'Без объёма', unit: 'к-с', kp: { qty_gp: null, total: 100 } },
      { id: 'c', row_no: 3, parent_row_no: null, level: 1, kind: 'section', name: 'Пустой', kp: { total: 0 } },
      { id: 'd', row_no: 4, parent_row_no: 3, level: 2, kind: 'note', name: 'Строка', kp: { total: 0 } },
    ])
    const eff = effectivePrices(tree, new Map([['b', { unit_price: null, total: 250 }], ['c', { total: 999 }]]))
    assert.equal(eff.get('b').total, 250)
    assert.equal(eff.get('a').total, 250)
    assert.equal(eff.get('c').total, 0, 'распределять не на что — сумма группы = сумма состава')
    assert.equal(eff.get('d').factor, 1)
  })

  it('документ в раскладке сметы: этап ДГП по тому же файлу — все строки по ключу, «было → станет», итог; объём — по желанию', async () => {
    const { kp, tree } = stagesTree()
    const lines = estimateDocLines(kp, 0)
    assert.equal(lines.length, 6, 'строки без вложенных: 5 позиций и [ДОП]')
    const index = await priceMatchIndex(tree)
    const matched = await matchPriceLines(lines, index)
    assert.ok(matched.every((m) => m.match?.via === 'key'))
    const plan = planPriceChanges(matched, { tree, effective: new Map() })
    const road = plan.lines.find((l) => l.row?.code === '01.01.01')
    near(road.before, 2900)
    near(road.after, 1600000 / 765)
    assert.ok(road.changed && road.pct < 0)
    assert.equal(plan.items.find((it) => it.row_id === road.row.id).unit_price, Math.round((1600000 / 765) * 1e6) / 1e6)
    assert.equal(plan.items.find((it) => it.row_id === road.row.id).unit_materials, Math.round((1300000 / 765) * 1e6) / 1e6)
    const totals = estimateTotals(tree, new Map(), effectivePrices(tree, pricesAfter(new Map(), plan.items)))
    near(totals.after, stagesSampleExpect().dgp)
    // Объём документа в «Актуальный» — только по выбору и только где отличается.
    assert.ok(!plan.items.some((it) => 'actual_qty' in it))
    const withVol = planPriceChanges(matched, { tree, effective: new Map(), withVolumes: true, states: new Map([[road.row.id, { actual: 700 }]]), docTitle: 'ДГП' })
    const vol = withVol.items.find((it) => it.row_id === road.row.id)
    assert.equal(vol.actual_qty, 765)
    assert.equal(vol.actual_reason, 'По документу «ДГП»')
    // «Не применять» — строка без позиции и без записи.
    const skip = planPriceChanges(matched, { tree, effective: new Map(), picks: new Map([[road.i, null]]) })
    assert.ok(!skip.items.some((it) => it.row_id === road.row.id))
  })

  it('документ без ключей: наименование — как счёт с ВОР; одинаковые наименования у нескольких позиций — только человеком', async () => {
    const tree = buildTree([
      { id: 's', row_no: 1, parent_row_no: null, level: 1, kind: 'section', name: 'Раздел', row_key: 'c:|раздел|section' },
      { id: 'p1', row_no: 2, parent_row_no: 1, level: 2, kind: 'position', name: 'Демонтаж бытового городка (модуля)', unit: 'шт', row_key: 'p:1', kp: { qty_gp: 16, total: 160 } },
      { id: 'p2', row_no: 3, parent_row_no: 1, level: 2, kind: 'position', name: 'Демонтаж бытового городка (модуля)', unit: 'шт', row_key: 'p:2', kp: { qty_gp: 1, total: 10 } },
      { id: 'p3', row_no: 4, parent_row_no: 1, level: 2, kind: 'position', name: 'Устройство временной автодороги из ж/б плит', unit: 'м2', row_key: 'p:3', kp: { qty_gp: 1000, total: 4000 } },
    ])
    const lines = genericDocLines([
      { name: 'Демонтаж бытового городка (модуля)', unit: 'шт', qty: 16, price: 12, priceVat: 'gross' },
      { name: 'Устройство временной автодороги из железобетонных плит', unit: 'м2', qty: 1000, price: 5, priceVat: 'gross' },
      { name: 'Доставка', delivery: true, price: 100 },
    ])
    assert.equal(lines.length, 2, 'доставка — не строка цены')
    const matched = await matchPriceLines(lines, await priceMatchIndex(tree))
    assert.equal(matched[0].match, null, 'то же наименование у двух позиций — не сама')
    assert.ok(matched[0].cands.length >= 2)
    assert.equal(matched[1].match?.group.key, 'p3')
    const plan = planPriceChanges(matched, { tree, effective: new Map(), picks: new Map([[0, matched[0].cands.find((c) => c.group.key === 'p1').group]]) })
    assert.deepEqual(plan.items.map((it) => [it.row_id, it.unit_price]), [['p1', 12], ['p3', 5]])
  })

  it('по наименованию сама не ставится другая позиция: другой размер, толщина, сечение — только человеком', async () => {
    const names = ['Распор D630х7 мм', 'Плита перекрытия монолитная B30 толщ. 200 мм', 'Демонтаж ограждения строительной площадки из проф.листа']
    const tree = buildTree([{ id: 's', row_no: 1, parent_row_no: null, level: 1, kind: 'section', name: 'Раздел', row_key: 's' },
      ...names.map((name, i) => ({ id: `p${i}`, row_no: i + 2, parent_row_no: 1, level: 2, kind: 'position', name, unit: 'тн', row_key: `k${i}`, kp: { qty_gp: 10, total: 100 } }))])
    const lines = genericDocLines(['Распор D630х9 мм', 'Плита перекрытия монолитная B30 толщ. 250 мм', 'Демонтаж ограждения площадки из профлиста']
      .map((name) => ({ name, unit: 'тн', qty: 10, price: 5, priceVat: 'gross' })))
    const matched = await matchPriceLines(lines, await priceMatchIndex(tree))
    assert.equal(matched[0].match, null)
    assert.equal(matched[1].match, null, 'толщина другая — не сама, хотя похожесть 0,8')
    assert.ok(matched[1].cands.some((c) => c.group.key === 'p1'), 'но в «Найти» — первой')
    assert.equal(matched[2].match?.group.key, 'p2')
  })

  it('история и выгрузка: правки цен словами, столбцы действующей цены только при изменённых ценах', () => {
    assert.deepEqual(describeLogEntry({ entity: 'price', action: 'update', changes: { unit_price: { old: 1, new: 2 }, _doc: { title: 'ДС №4' } } }),
      { title: 'Цена по документу «ДС №4»', lines: ['Цена за ед.: 1,00 ₽ → 2,00 ₽'] })
    assert.equal(describeLogEntry({ entity: 'price', action: 'insert', changes: { total: { old: null, new: 10 } } }).title, 'Цена изменена вручную')
    assert.equal(describeLogEntry({ entity: 'price', action: 'delete', changes: {} }).title, 'Цена возвращена из файла')
    assert.equal(describeLogEntry({ entity: 'price', action: 'import', changes: { title: 'ДГП', stage: 'ДГП 12.01.2026' } }).lines[0], 'Этап: ДГП 12.01.2026')
    const { tree } = stagesTree()
    const eff = effectivePrices(tree, new Map([['r2', { unit_price: 3000 }]]))
    const states = computeStates(tree, new Map(), new Map(), eff)
    const ctx = { tree, marks: new Map(), allocsByRow: new Map(), states: states.states, sums: states.sums, total: states.total, meta: {}, estimate: {}, effective: eff,
      priceDocs: [{ title: 'ДС №4', stage: null, applied_by_name: 'Тест', applied_at: '2026-11-27T10:00:00Z', summary: { applied: 1 } }] }
    const wb = XLSX.read(buildWith(XLSXStyle, ctx, { ids: exportRowIds(tree, null) }), { type: 'array' })
    const head = XLSX.utils.sheet_to_json(wb.Sheets['Смета'], { header: 1 })[0]
    assert.deepEqual(head.slice(-3), PRICE_HEAD)
    assert.ok(XLSX.utils.sheet_to_json(wb.Sheets['Паспорт'], { header: 1 }).some((r) => r[0] === 'Документ цен: ДС №4'))
    const plain = XLSX.read(buildWith(XLSXStyle, { ...ctx, effective: new Map() }, { ids: exportRowIds(tree, null) }), { type: 'array' })
    assert.ok(!XLSX.utils.sheet_to_json(plain.Sheets['Смета'], { header: 1 })[0].includes(PRICE_HEAD[0]))
  })

  it('миграция обеих баз: цены пишет только администратор функциями базы, вошедшему — чтение; перенос на новую версию; шлюз', () => {
    const ya = read('migration/yandex/20270308_kp_estimate_prices.sql')
    const sb = read('supabase/migrations/20270308_kp_estimate_prices.sql')
    const body = (text) => text.slice(text.indexOf('-- ── Таблицы'), text.search(/-- ── Права(: читать| под одну учётку)/)).replace(/-- osp:allow[^\n]*\n/g, '')
    assert.equal(body(sb), body(ya))
    for (const fn of ['kp_estimate_price_apply', 'kp_estimate_price_reset']) {
      const def = ya.slice(ya.indexOf(`FUNCTION public.${fn}`))
      assert.match(def.slice(0, def.indexOf('$$;')), /IF NOT public\.is_admin\(\) THEN/)
      assert.match(def.slice(0, def.indexOf('$$;')), /psdc_object_in_scope/)
      assert.match(ya, new RegExp(`-- osp:allow rpc ${fn} authenticated`))
    }
    assert.match(ya, /UPDATE public\.kp_estimate_prices p SET row_id = m\.new_id/)
    assert.match(ya, /CHECK \(entity IN \('estimate', 'mark', 'allocation', 'price'\)\)/)
    assert.doesNotMatch(ya, /FOR (INSERT|UPDATE|DELETE) TO PUBLIC/)
    assert.match(ya, /-- osp:allow table kp_estimate_prices authenticated=select\n/)
    assert.match(sb, /GRANT SELECT ON TABLE public\.%I TO authenticated/)
    assert.doesNotMatch(sb, /GRANT (INSERT|UPDATE|DELETE|ALL) ON TABLE public\.%I TO authenticated/)
    assert.match(read('migration/yandex/20270308_kp_estimate_prices.check.sql'), /только администратор/)
    assert.match(read('migration/backup/checks/20270308.sql'), /to_regclass/)
    assert.match(read('migration/rollback/20270308_kp_estimate_prices_rollback.sql'), /Данные НЕ удаляются/)
    assert.match(read('migration/rollback/20270308_kp_estimate_prices_yandex_rollback.sql'), /DROP FUNCTION IF EXISTS public\.kp_estimate_price_apply/)
    const allow = JSON.parse(read('server/osp-api/src/data/allow.json'))
    assert.deepEqual(allow.tables.kp_estimate_prices, { authenticated: ['select'] })
    assert.deepEqual(allow.tables.kp_estimate_price_docs, { authenticated: ['select'] })
    assert.deepEqual(allow.rpc.kp_estimate_price_apply, ['authenticated'])
    const map = JSON.parse(read('server/osp-api/src/data/db-sections.json'))
    assert.equal(map.rpc.kp_estimate_price_apply.call, 'admin')
    assert.equal(map.rpc.kp_estimate_price_reset.call, 'admin')
    assert.equal(map.tables.kp_estimate_prices.insert, 'none')
    assert.equal(map.tables.kp_estimate_price_docs.update, 'none')
  })
})

describe('смета КП / ПЗ: интерфейс (стенд)', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser
  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open(query = '', viewport = { width: 1600, height: 1000 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=/stand/kp-estimate&latency=0${query}`)
    await page.waitForSelector('.kpe-root')
    return { page, errors, context }
  }
  const db = (page, table) => page.evaluate((t) => window.__fakeDb[t], table)
  const row = (page, no) => page.locator(`tr[data-id="kr-${no}"]`)

  const xlsxFile = (name, b64) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(b64, 'base64') })
  const openRow = async (page, no) => {
    await row(page, no).locator('td.kpe-c-name').click()
    await page.waitForSelector('.kpe-row-dialog')
  }

  it('одна таблица: без видов КП / ПЗ, переходов, дерева, кол-ва заказчика и ответственного; наименование целиком; окно строки', async () => {
    const { page, errors, context } = await open()
    await page.waitForSelector('.kpe-table tbody tr[data-id]')
    assert.match(await page.textContent('.kpe-summary'), /Превышение: 1/)
    const heads = await page.locator('.kpe-table thead th').allTextContents()
    assert.deepEqual(heads.filter(Boolean), ['Код', 'Наименование', 'Кол-во (ГП)', 'Актуальный', 'Стоимость КП, ₽', 'Прямые затраты, ₽', 'Свободно', 'Тендер и подрядчик', 'Примечание'])
    for (const sel of ['.kpe-link-btn', '.kpe-tree', '.kpe-tile', 'button:has-text("ПЗ")', 'text=Ответственный', 'text=Кол-во заказчика']) {
      assert.equal(await page.locator(sel).count(), 0, `нет: ${sel}`)
    }
    await page.click('.kpe-seg button:has-text("Все")')
    // Наименование — одной строкой и целиком: столбец не уже текста, переноса нет.
    const fit = await row(page, 7).locator('td.kpe-c-name').evaluate((td) => {
      const t = td.querySelector('.kpe-name-text')
      return { text: t.getBoundingClientRect().right <= td.getBoundingClientRect().right, oneLine: t.getBoundingClientRect().height < 24 }
    })
    assert.deepEqual(fit, { text: true, oneLine: true })
    // Ушло под закреплённые справа столбцы — при наведении видно целиком (в узком окне закрепления нет — и прятать нечего).
    await page.setViewportSize({ width: 1500, height: 1000 })
    assert.equal(await row(page, 7).locator('td.kpe-c-total').evaluate((td) => getComputedStyle(td).position), 'sticky')
    await row(page, 7).locator('.kpe-name-text').hover()
    await page.waitForSelector('.kpe-peek')
    assert.equal(await page.textContent('.kpe-peek'), 'Отделка пола автостоянки, тип П1 (покрытие, основание, гидроизоляция)')
    await page.setViewportSize({ width: 1100, height: 1000 })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('tr[data-id="kr-7"] td.kpe-c-total')).position !== 'sticky')
    await page.setViewportSize({ width: 1600, height: 1000 })
    await openRow(page, 14)
    const dlg = (await page.textContent('.kpe-row-dialog')).replace(/[  ]/g, ' ')
    assert.match(dlg, /Кол-во \(ГП\)200 м3/)
    assert.match(dlg, /Стоимость КП13 626 800,00/)
    assert.match(dlg, /Прямые затраты12 283 200,00/)
    assert.doesNotMatch(dlg, /заказчика|Ответственный|Показать в/)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.kpe-row-dialog', { state: 'detached' })
    await page.click('.kpe-fs-btn')
    await page.waitForSelector('.kpe-root.is-fullscreen')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.kpe-root:not(.is-fullscreen)')
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('примечание и актуальный объём — сами сохраняются, с историей; превышение подсвечено, распределения не меняются', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 4).locator('td.kpe-c-note').click()
    assert.equal(await page.locator('.kpe-row-dialog').count(), 0, 'правка в ячейке — без окна')
    await page.fill('.kpe-inline--note', 'Сверить с ВОР')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_marks.some((m) => m.row_id === 'kr-4' && m.note === 'Сверить с ВОР'))
    await page.waitForSelector('.kpe-save:has-text("Все изменения сохранены")')
    await openRow(page, 14)
    const actual = page.locator('.kpe-row-dialog input[aria-label="Актуальный объём"]')
    await actual.fill('100')
    await actual.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_marks.find((m) => m.row_id === 'kr-14')?.actual_qty === 100)
    await page.waitForSelector('tr[data-id="kr-14"].is-over')
    assert.match(await page.textContent('.kpe-row-dialog'), /Распределено больше актуального объёма на 20/)
    const allocs = (await db(page, 'kp_estimate_allocations')).filter((a) => a.row_id === 'kr-14')
    assert.deepEqual(allocs.map((a) => [a.pz_qty, a.contract_qty]), [[120, 100]], 'распределение не тронуто')
    await page.click('.kpe-row-log summary')
    await page.waitForSelector('.kpe-row-log .kpe-log li')
    assert.match(await page.textContent('.kpe-row-log'), /Актуальный объём: — → 100/)
    assert.equal(await row(page, 14).locator('td.kpe-c-actual').textContent(), '100')
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('заливка: строки флажками (Shift — диапазон) и прямоугольник ячеек', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 4).locator('td.kpe-c-sel input').click()
    await row(page, 5).locator('td.kpe-c-sel input').click({ modifiers: ['Shift'] })
    await page.click('.kpe-selbar button[aria-label="Залить: Зелёный"]')
    await page.waitForFunction(() => ['kr-4', 'kr-5'].every((r) => window.__fakeDb.kp_estimate_marks.find((m) => m.row_id === r)?.fill === '#d3f9d8'))
    await page.click('.kpe-selbar .kpe-text-btn:has-text("Снять выделение")')
    await page.click('.kpe-selbar button:has-text("ячейки")')
    const a = row(page, 14).locator('td.kpe-c-total')
    const b = row(page, 15).locator('td.kpe-c-direct')
    await a.hover()
    await page.mouse.down()
    await b.hover()
    await page.mouse.up()
    assert.match(await page.textContent('.kpe-selbar'), /Ячеек: 4/)
    await page.click('.kpe-selbar button[aria-label="Залить: Красный"]')
    await page.waitForFunction(() => ['kr-14', 'kr-15'].every((r) => {
      const cf = window.__fakeDb.kp_estimate_marks.find((m) => m.row_id === r)?.cell_fills || {}
      return cf.total === '#ffe3e3' && cf.direct === '#ffe3e3'
    }))
    assert.match(await row(page, 14).locator('td.kpe-c-total').getAttribute('class'), /has-cell-fill/)
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('одно окно: тендер → победитель подставляется сам; без тендера — подрядчик; та же пара второй раз — отказ', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await openRow(page, 4)
    const add = page.locator('.kpe-alloc-add')
    assert.equal(await add.locator('input[aria-label="Объём"]').inputValue(), '1000', 'весь свободный остаток')
    await add.locator('input[aria-label="Тендер"]').fill('501')
    await page.click('.kpe-options li:has-text("№ 501")')
    assert.equal(await add.locator('input[aria-label="Подрядчик"]').inputValue(), 'ООО «Монолит-Строй»', 'победитель тендера')
    await add.locator('input[aria-label="Объём"]').fill('400')
    await add.locator('button:has-text("Добавить")').click()
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_allocations.some((a) => a.row_id === 'kr-4' && a.tender_id === 'kt-501' && a.counterparty_id === 'kc-1' && a.pz_qty === 400))
    await page.waitForSelector('tr[data-id="kr-4"] .kpe-chip:has-text("№ 501 · ООО «Монолит-Строй» · 400")')
    assert.equal(await add.locator('input[aria-label="Объём"]').inputValue(), '600', 'остаток — следующему')
    await add.locator('input[aria-label="Подрядчик"]').fill('Полы')
    await page.click('.kpe-options li:has-text("АО «Полы и кровли»")')
    await add.locator('button:has-text("Добавить")').click()
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_allocations.some((a) => a.row_id === 'kr-4' && !a.tender_id && a.counterparty_id === 'kc-2' && a.pz_qty === 600))
    await page.waitForFunction(() => /свободно 0/.test(document.querySelector('.kpe-row-dialog .kpe-dist-summary')?.textContent || ''))
    await add.locator('input[aria-label="Тендер"]').fill('501')
    await page.click('.kpe-options li:has-text("№ 501")')
    await add.locator('input[aria-label="Объём"]').fill('5')
    await add.locator('button:has-text("Добавить")').click()
    await page.waitForSelector('.kpe-alloc-add .kpe-error-line:has-text("уже есть")')
    assert.equal((await db(page, 'kp_estimate_allocations')).filter((a) => a.row_id === 'kr-4').length, 2)
    assert.equal(await row(page, 4).locator('td.kpe-c-free').textContent(), '0')
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('выделенные строки — тендер и подрядчик одним окном, каждой — свободный остаток', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 8).locator('td.kpe-c-sel input').click()
    await row(page, 9).locator('td.kpe-c-sel input').click({ modifiers: ['Shift'] })
    await page.click('.kpe-selbar button:has-text("Тендер и подрядчик")')
    await page.locator('.kpe-modal input[aria-label="Тендер"]').fill('501')
    await page.click('.kpe-options li:has-text("№ 501")')
    assert.equal(await page.locator('.kpe-modal input[aria-label="Подрядчик"]').inputValue(), 'ООО «Монолит-Строй»')
    assert.match(await page.textContent('.kpe-modal .kpe-note-box'), /позиций — 2/)
    await page.click('.kpe-modal-foot button:has-text("Распределить")')
    await page.waitForFunction(() => ['kr-8', 'kr-9'].every((r) => window.__fakeDb.kp_estimate_allocations.some((a) => a.row_id === r && a.tender_id === 'kt-501' && a.counterparty_id === 'kc-1' && a.pz_qty === 500)))
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('правка коллеги приходит сама: строка подсвечена, отметка обновлена', async () => {
    const { page, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await page.waitForSelector('tr[data-id="kr-5"]')
    await page.evaluate(() => window.__kpeColleague(5, { note: 'Коллега: объём уточнить' }))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForSelector('.kpe-notice--remote:has-text("Сметов Сергей")')
    assert.match(await row(page, 5).getAttribute('class'), /is-remote/)
    assert.match(await row(page, 5).locator('td.kpe-c-note').textContent(), /Коллега: объём уточнить/)
    await context.close()
  })

  it('поиск и «Показать»: найденные — с разделами; «Превышение» — плиты', async () => {
    const { page, context } = await open()
    await page.fill('.kpe-search', 'плита перекрытия')
    await page.waitForSelector('.kpe-found:has-text("Найдено: 1")')
    const shown = await page.locator('.kpe-table tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => t.dataset.id))
    assert.deepEqual(shown, ['kr-12', 'kr-13', 'kr-15'])
    await page.fill('.kpe-search', '')
    await page.selectOption('select[aria-label="Показать"]', 'over')
    await page.waitForSelector('.kpe-found')
    assert.deepEqual(await page.locator('.kpe-table tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => t.dataset.id)), ['kr-12', 'kr-13', 'kr-15'])
    await page.click('.kpe-found .kpe-text-btn:has-text("сбросить")')
    await page.waitForSelector('.kpe-found', { state: 'detached' })
    await context.close()
  })

  it('новая версия файла: отметки и распределения переходят по номеру позиции и наименованию, остальное — у прежней', async () => {
    const { page, errors, context } = await open()
    await page.click('button:has-text("Загрузить новую версию")')
    // Новая версия: стена переименована (её отметка и распределение останутся у прежней), плиты — те же.
    const files = await page.evaluate(async () => {
      const X = window.__kpeXLSX
      const mod = window.__kpeSample
      const kp = mod.sampleKpWorkbook(X)
      const ws = kp.Sheets['Комм. затраты']
      for (const ref of Object.keys(ws)) if (ws[ref].v === 'Стена железобетонная монолитная B30') ws[ref].v = 'Стена монолитная B30 (новая редакция)'
      const toB64 = (wb) => { const a = X.write(wb, { type: 'array', bookType: 'xlsx' }); let s = ''; new Uint8Array(a).forEach((b) => { s += String.fromCharCode(b) }); return btoa(s) }
      return { kp: toB64(kp), pz: toB64(mod.samplePzWorkbook(X)) }
    })
    await page.setInputFiles('.kpe-modal input[type=file]', [xlsxFile('Пример К1 - КП до перекидок v2.xlsx', files.kp), xlsxFile('Смета v2.xlsx', files.pz)])
    await page.waitForSelector('.kpe-import-summary .kpe-note-box')
    assert.match(await page.textContent('.kpe-note-box'), /перейдут отметки: 1, распределения: 1.*1 отметок и 1 распределений/)
    await page.click('.kpe-modal-foot button:has-text("Загрузить новую версию")')
    await page.waitForSelector('.kpe-banner--ok')
    assert.match(await page.textContent('.kpe-banner--ok'), /Перенесено отметок 1, распределений 1\..*отметок 1, распределений 1/)
    const ests = await db(page, 'kp_estimates')
    assert.deepEqual(ests.map((e) => e.status).sort(), ['active', 'archived'])
    const active = ests.find((e) => e.status === 'active')
    const marks = await db(page, 'kp_estimate_marks')
    assert.equal(marks.filter((m) => m.estimate_id === active.id).length, 1, 'плиты — на новой версии')
    await page.selectOption('select[aria-label="Версия документа"]', ests.find((e) => e.status === 'archived').id)
    await page.waitForSelector('.kpe-banner--muted:has-text("Прежняя версия — только просмотр")')
    assert.equal(await page.locator('.kpe-selbar').count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('один файл «КП + план затрат»: прямые затраты — из той же строки КП', async () => {
    const { page, errors, context } = await open('&kpe=empty')
    await page.click('button:has-text("Загрузить смету")')
    const b64 = await page.evaluate(() => {
      const X = window.__kpeXLSX
      const a = X.write(window.__kpeSample.sampleKpWorkbook(X, { inlinePz: true }), { type: 'array', bookType: 'xlsx' })
      let s = ''
      new Uint8Array(a).forEach((b) => { s += String.fromCharCode(b) })
      return btoa(s)
    })
    await page.setInputFiles('.kpe-modal input[type=file]', [xlsxFile('Пример К1 - КП и ПЗ.xlsx', b64)])
    await page.waitForSelector('.kpe-import-summary')
    assert.match(await page.textContent('.kpe-import-summary'), /План затратстолбцами строк КП/)
    await page.click('.kpe-modal-foot button:has-text("Загрузить")')
    await page.waitForSelector('.kpe-banner--ok')
    await page.click('.kpe-seg button:has-text("Все")')
    const wall = (await db(page, 'kp_estimate_rows')).find((r) => r.name === 'Стена железобетонная монолитная B30')
    assert.equal(wall.pz.direct, 12283200)
    assert.equal((await page.locator(`tr[data-id="${wall.id}"] td.kpe-c-direct`).textContent()).replace(/[  ]/g, ' '), '12 283 200,00')
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('КП с ресурсами ПЗ одним листом (раскладка «Алии»): вложенность по группировке, прямые затраты — из ресурсов', async () => {
    const { page, errors, context } = await open('&kpe=empty')
    await page.click('button:has-text("Загрузить смету")')
    const b64 = await page.evaluate(() => {
      const X = window.__kpeXLSX
      const a = X.write(window.__kpeSample.sampleTreeWorkbook(X), { type: 'array', bookType: 'xlsx' })
      let s = ''
      new Uint8Array(a).forEach((b) => { s += String.fromCharCode(b) })
      return btoa(s)
    })
    await page.setInputFiles('.kpe-modal input[type=file]', [xlsxFile('Пример — КП до перекидок после ДС1–2.xlsx', b64)])
    await page.waitForSelector('.kpe-import-summary')
    const summary = (await page.textContent('.kpe-import-summary')).replace(/[\u00a0\u202f]/g, ' ')
    assert.match(summary, /вложенность — по группировке строк файла/)
    assert.match(summary, /как «КП в сопоставимой базе НДС 20%, с опционом» в файле/)
    assert.match(summary, /ресурсами под строками КП \(15, без цены — 3\)/)
    assert.match(summary, /расхождений: 3/)
    await page.click('.kpe-modal-foot button:has-text("Загрузить")')
    await page.waitForSelector('.kpe-banner--ok')
    await page.click('.kpe-seg button:has-text("Все")')
    const rows = await db(page, 'kp_estimate_rows')
    assert.equal(rows.length, 19)
    const plate = rows.find((r) => r.name === 'Бетонирование фундаментной плиты B30')
    assert.equal((await page.locator(`tr[data-id="${plate.id}"] td.kpe-c-direct`).textContent()).replace(/[\u00a0\u202f]/g, ' '), '3 540 000,00')
    await page.locator(`tr[data-id="${plate.id}"] td.kpe-c-name`).click()
    await page.waitForSelector('.kpe-row-dialog')
    const dlg = (await page.textContent('.kpe-row-dialog')).replace(/[\u00a0\u202f]/g, ' ')
    assert.match(dlg, /осн\. материалы 2 900 000,00 · вспом\. 40 000,00 · работы 600 000,00/)
    assert.match(dlg, /без цены 1 из 5 ресурсов/)
    assert.match(dlg, /ПЗ × коэфф\./)
    assert.match(dlg, /Цена за ед\.12 000,00 ₽ \/ м3/, 'цена — по стоимости КП, не по «ПЗ × коэфф.»')
    await page.keyboard.press('Escape')
    const group = rows.find((r) => r.name === 'Бетонирование')
    assert.equal((await page.locator(`tr[data-id="${group.id}"] td.kpe-c-total`).textContent()).replace(/[\u00a0\u202f]/g, ' '), '4 800 000,00', 'группа — суммой строк, а не 0 из файла')
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('выгрузка выделенного: одна таблица КП + ПЗ и распределение', async () => {
    const { page, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 14).locator('td.kpe-c-sel input').click()
    assert.match(await page.getAttribute('.kpe-head-actions button:has-text("Excel")', 'title'), /выделенные строки \(1\)/)
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.kpe-head-actions button:has-text("Excel")')])
    const wb = XLSX.read(fs.readFileSync(await download.path()), { cellFormula: true })
    assert.deepEqual(wb.SheetNames.slice(0, 2), ['Смета', 'Распределение'])
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Смета'], { header: 1 }).length, 5, 'шапка, раздел, группа, стена, ИТОГО')
    assert.match(download.suggestedFilename(), /^Смета КП-ПЗ — ЖК Пример, корпус 1 — /)
    await context.close()
  })

  it('режим «Цены» (администратор): цена позиции и сумма укрупнённой — в ячейке, состав пропорционально; деньги — по новой цене; вернуть цену файла', async () => {
    const { page, errors, context } = await open()
    await page.waitForSelector('.kpe-table tbody tr[data-id]')
    await page.click('.kpe-seg button:has-text("Все")')
    await page.click('.kpe-head-actions button:has-text("Цены")')
    await page.waitForSelector('.kpe-pricebar')
    const heads = (await page.locator('.kpe-table thead th').allTextContents()).filter(Boolean)
    assert.deepEqual(heads, ['Код', 'Наименование', 'Кол-во (ГП)', 'Стоимость КП, ₽', 'Цена КП за ед., ₽', 'Цена за ед., ₽', 'Стоимость, ₽', 'Изм., %', 'Откуда цена'])
    // Позиция: своя цена за единицу.
    await row(page, 14).locator('td.kpe-c-new_unit').click()
    await page.fill('.kpe-inline', '70000')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_prices.some((x) => x.row_id === 'kr-14' && x.unit_price === 70000))
    await page.waitForFunction(() => /14\s000\s000,00/.test(document.querySelector('tr[data-id="kr-14"] td.kpe-c-new_total')?.textContent || ''))
    assert.match(await row(page, 14).locator('td.kpe-c-source').textContent(), /вручную/)
    // Укрупнённая позиция: новая сумма — подробные позиции пересчитаны одним множителем.
    await row(page, 7).locator('td.kpe-c-new_total').click()
    await page.fill('.kpe-inline', '3000000')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_prices.some((x) => x.row_id === 'kr-7' && x.total === 3000000))
    await page.waitForFunction(() => /356\s756,76/.test(document.querySelector('tr[data-id="kr-8"] td.kpe-c-new_total')?.textContent || ''))
    assert.match(await row(page, 8).locator('td.kpe-c-source').textContent(), /группа ×0,85/)
    const log = (await db(page, 'kp_estimate_log')).filter((e) => e.entity === 'price')
    assert.equal(log.length, 2)
    // Обычный вид: «Актуальная стоимость» и деньги распределения — по новой цене (120 м3 × 70 000).
    await page.click('.kpe-head-actions button:has-text("Цены")')
    await page.waitForSelector('.kpe-pricebar', { state: 'detached' })
    assert.ok((await page.locator('.kpe-table thead th').allTextContents()).includes('Актуальная стоимость, ₽'))
    assert.match(await page.textContent('.kpe-summary'), /Актуальная стоимость/)
    await openRow(page, 14)
    const dlg = (await page.textContent('.kpe-row-dialog')).replace(/[  ]/g, ' ')
    assert.match(dlg, /Действующая за ед\.70 000,00 ₽ \/ м3 \(в файле 68 134,00, \+2,7 %\)/)
    assert.match(dlg, /8 400 000,00 ₽/)
    await page.click('.kpe-row-dialog button:has-text("Вернуть цену файла")')
    await page.waitForFunction(() => !window.__fakeDb.kp_estimate_prices.some((x) => x.row_id === 'kr-14'))
    await page.waitForFunction(() => /8\s176\s080,00/.test(document.querySelector('.kpe-row-dialog')?.textContent || ''))
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('«Цены по документу»: файл сметы с этапами — этап ДГП, «было → станет», запись одной функцией; не администратору кнопки нет', async () => {
    const { page, errors, context } = await open('&kpe=noprices')
    await page.waitForSelector('.kpe-table tbody tr[data-id]')
    assert.equal(await page.locator('.kpe-head-actions button:has-text("Цены")').isDisabled(), true, 'база без 20270308 — кнопка выключена')
    await context.close()
    const econ = await open('&asRole=economist&asUser=econ-1')
    await econ.page.waitForSelector('.kpe-table tbody tr[data-id]')
    assert.equal(await econ.page.locator('.kpe-head-actions button:has-text("Цены")').count(), 0)
    const denied = await econ.page.evaluate(() => window.__fakeRpc.kp_estimate_price_apply({ p_estimate: 'est-1', p_doc: null, p_items: [{ row_id: 'kr-14', unit_price: 1 }] }))
    assert.match(denied.error.message, /kp_estimate_price_admin/)
    await econ.context.close()
    // Документ — книга в раскладке сметы К14 (та же, что загружена): по КП цены не меняются; изменённая цена одной позиции — меняется.
    const adm = await open()
    await adm.page.waitForSelector('.kpe-table tbody tr[data-id]')
    await adm.page.click('.kpe-head-actions button:has-text("Цены")')
    await adm.page.click('.kpe-pricebar button:has-text("Цены по документу")')
    await adm.page.waitForSelector('.kpe-pd-dialog')
    const b64 = await adm.page.evaluate(() => {
      const X = window.__kpeXLSX
      const wb = window.__kpeSample.sampleKpWorkbook(X)
      const ws = wb.Sheets[wb.SheetNames[0]]
      // Стена (№ 14, 200 м3): материалы 3 883 200 → 4 000 000 и итог строки — суммы, как их сохранил бы Excel (формулы
      // SheetJS не пересчитывает).
      for (const ref of Object.keys(ws)) {
        if (ws[ref]?.v === 3883200) ws[ref] = { t: 'n', v: 4000000 }
        else if (ws[ref]?.v === 13626800) ws[ref] = { t: 'n', v: 13743600 }
      }
      return X.write(wb, { type: 'base64', bookType: 'xlsx' })
    })
    await adm.page.setInputFiles('.kpe-pd-dialog input[type=file]', xlsxFile('ДС №4.xlsx', b64))
    await adm.page.waitForSelector('.kpe-pd-stats')
    assert.match(await adm.page.textContent('.kpe-pd-stats'), /изменится цен 1/)
    await adm.page.fill('.kpe-pd-dialog input[aria-label="Название документа"]', 'ДС №4 от 01.12.2026')
    await adm.page.click('.kpe-pd-dialog button:has-text("Применить: 1")')
    await adm.page.waitForSelector('.kpe-pd-dialog', { state: 'detached' })
    const prices = await db(adm.page, 'kp_estimate_prices')
    assert.equal(prices.length, 1)
    assert.equal(prices[0].row_id, 'kr-14')
    assert.equal(prices[0].source, 'document')
    assert.equal(prices[0].unit_price, 68718)
    assert.equal(prices[0].unit_materials, 20000)
    assert.equal((await db(adm.page, 'kp_estimate_price_docs'))[0].title, 'ДС №4 от 01.12.2026')
    assert.match(await adm.page.textContent('.kpe-notice'), /Цены по документу «ДС №4 от 01\.12\.2026»: изменено строк 1/)
    assert.deepEqual(adm.errors, [])
    await adm.context.close()
    assert.deepEqual(errors, [])
  })

  it('без права правки — только просмотр; база без миграции — подсказка', async () => {
    const ro = await open('&noEdit=kp_estimate')
    await ro.page.waitForSelector('.kpe-table tbody tr[data-id]')
    assert.equal(await ro.page.locator('.kpe-selbar').count(), 0)
    assert.equal(await ro.page.locator('button:has-text("Загрузить новую версию")').count(), 0)
    assert.match(await ro.page.textContent('.kpe-save'), /Только просмотр/)
    await ro.page.click('.kpe-seg button:has-text("Все")')
    await row(ro.page, 4).locator('td.kpe-c-note').click()
    assert.equal(await ro.page.locator('.kpe-inline').count(), 0)
    await ro.page.waitForSelector('.kpe-row-dialog', { timeout: 5000 })
    assert.equal(await ro.page.locator('.kpe-alloc-add').count(), 0)
    assert.equal(await ro.page.locator('.kpe-row-dialog textarea[aria-label="Примечание к строке"]').isDisabled(), true)
    await ro.context.close()
    const miss = await open('&kpe=missing')
    await miss.page.waitForSelector('.kpe-root--empty')
    assert.match(await miss.page.textContent('.kpe-root'), /миграция 20270215/)
    await miss.context.close()
  })
})
