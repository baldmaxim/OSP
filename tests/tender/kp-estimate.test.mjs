// Смета КП / ПЗ во вкладке «Смета» карточки объекта (миграция 20270215): разбор файлов «КП до перекидок» и «Смета»
// (и одного файла «КП + план затрат»: листами одной книги или прямыми затратами столбцами строк КП), структура по
// SUBTOTAL, формулы, коэффициенты; объём — только «Количество (ГП)»; распределение «тендер + подрядчик + объём»,
// превышение, свод по разделам, поиск и «Показать», история, выгрузка в Excel одной таблицей с формулами и заливкой;
// файлы миграций и шлюза; интерфейс на стенде (route=/stand/kp-estimate, 13.11.2026 — одна таблица, окно строки):
// наименования целиком, примечания, объёмы, заливка строк и ячеек, тендер с победителем, правки коллег, новая версия с
// переносом отметок, только просмотр, база без миграции. Книги — вымышленные, в раскладке файлов К14
// (tests/tender/lib/kpEstimateSample.mjs). Настоящие файлы Примавера К14 проверяются, если лежат в корне репозитория
// (в git их нет: репозиторий открытый) или в каталоге KP_ESTIMATE_SAMPLES. База — kp-estimate-db.test.mjs.
import { describe, it, before, after } from 'node:test'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { sampleBothSheetsWorkbook, sampleKpWorkbook, samplePzWorkbook, SAMPLE_TOTAL } from './lib/kpEstimateSample.mjs'
import { buildEstimateRows, detectEstimateWorkbook, fitRowKey, masteringToAllocations, parseKpWorkbook, parsePzWorkbook, ROW_KEY_MAX } from '../../src/utils/kpEstimateImport.js'
import {
  allocQty, buildTree, collapseToLevel, computeStates, groupStatus, markPayload, originalQty, planTenderAllocation, positionState,
  rowMatchesShow, tenderWinners, visibleRowIds,
} from '../../src/utils/kpEstimate.js'
import { describeLogEntry } from '../../src/utils/kpEstimateLog.js'
import { buildWith, exportRowIds } from '../../src/utils/kpEstimateExport.js'

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
