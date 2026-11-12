// Смета КП / ПЗ во вкладке «Смета» карточки объекта (миграция 20270215): разбор файлов «КП до перекидок» и «Смета»
// (структура по SUBTOTAL, формулы, коэффициенты, связь КП ↔ ПЗ), остаток без двойного списания, превышение, свод по
// разделам, поиск и фильтры, история, выгрузка в Excel с формулами и заливкой; файлы миграций и шлюза; интерфейс на стенде
// (route=/stand/kp-estimate): переходы КП ↔ ПЗ, примечания, объёмы, заливка строк и ячеек, распределения, правки коллег,
// новая версия с переносом отметок, только просмотр, база без миграции. Книги — вымышленные, в раскладке файлов К14
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
import { sampleKpWorkbook, samplePzWorkbook, SAMPLE_TOTAL } from './lib/kpEstimateSample.mjs'
import { buildEstimateRows, detectEstimateWorkbook, masteringToAllocations, parseKpWorkbook, parsePzWorkbook } from '../../src/utils/kpEstimateImport.js'
import {
  buildTree, collapseToLevel, computeStates, groupStatus, linkedKpIds, linkedPzIds, markPayload, planTenderAllocation, positionState,
  rowMatchesFilters, sectionTree, visibleRowIds, EMPTY_FILTERS,
} from '../../src/utils/kpEstimate.js'
import { describeLogEntry } from '../../src/utils/kpEstimateLog.js'
import { buildWith, exportRowIds, masteringRows } from '../../src/utils/kpEstimateExport.js'

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
      assert.ok(Math.abs(total.commTotal - 15800025574.65) < 0.02, 'итог сметы ПЗ — как в «Сводке» (с округлением)')
      assert.ok(Math.abs(total.direct - 11981170163.07) < 0.02, 'прямые затраты — как в «Паспорте»')
      assert.ok(JSON.stringify(built.rows).length < 3_500_000, 'строки без повторов названия раздела')
    })
})

describe('смета КП / ПЗ: объёмы, распределения, свод', () => {
  const row = { id: 'p', kind: 'position', unit: 'м3', kp: { qty_gp: 100, total: 1_000_000 }, pz: { comm_total: 1_000_000 } }
  it('тендер и договоры по нему — один объём (по большему); разные тендеры и договор без тендера — складываются', () => {
    const s = positionState(row, null, [
      { id: 'a1', tender_id: 'T1', pz_qty: 60, contract_qty: 0 },
      { id: 'a2', tender_id: 'T1', counterparty_id: 'C1', pz_qty: 0, contract_qty: 30 },
      { id: 'a3', tender_id: 'T1', counterparty_id: 'C2', pz_qty: 0, contract_qty: 20 },
      { id: 'a4', tender_label: 'Лот 2', pz_qty: 10, contract_qty: 0 },
      { id: 'a5', counterparty_id: 'C3', pz_qty: 0, contract_qty: 5 },
    ])
    assert.equal(s.distributed, 75, '60 (тендер 1, договоры 50 внутри) + 10 + 5')
    assert.equal(s.free, 25)
    assert.equal(s.status, 'partial')
    assert.equal(s.contractOver, false)
    assert.equal(s.price, 10000)
    assert.equal(s.distributedMoney, 750000)
  })
  it('договоров по тендеру больше, чем взято в ПЗ, — подсветка; превышение актуального — «превышение», данные не меняются', () => {
    const allocs = [{ id: 'a1', tender_id: 'T1', pz_qty: 40, contract_qty: 0 }, { id: 'a2', tender_id: 'T1', counterparty_id: 'C', pz_qty: 0, contract_qty: 70 }]
    const s = positionState(row, { actual_qty: 60 }, allocs)
    assert.equal(s.contractOver, true)
    assert.equal(s.distributed, 70)
    assert.equal(s.free, -10)
    assert.equal(s.status, 'over')
    assert.equal(s.diff, -40)
    assert.equal(s.changed, true)
    assert.equal(allocs[1].contract_qty, 70, 'распределения — как были')
    assert.equal(positionState(row, null, []).status, 'none')
    assert.equal(positionState(row, null, [{ id: 'x', tender_id: 'T', pz_qty: 100 }]).status, 'full')
    assert.equal(positionState({ ...row, kp: { qty_gp: 0, total: 0 }, pz: null }, null, []).status, 'empty')
  })
  it('свод по разделам, дерево, переходы КП ↔ ПЗ, видимые строки, выбор в тендер', () => {
    const rows = withIds(sample().built.rows)
    const tree = buildTree(rows)
    const id = (part) => byName(rows, part).id
    const marks = new Map([[id('Стена'), { actual_qty: 150, note: 'проверить' }]])
    const allocs = new Map([[id('Стена'), [{ id: 'a', row_id: id('Стена'), tender_id: 'T', pz_qty: 160, contract_qty: 0 }]]])
    const { states, sums, total } = computeStates(tree, marks, allocs)
    assert.equal(states.get(id('Стена')).status, 'over')
    assert.equal(groupStatus(sums.get(id('Раздел 2.'))), 'over')
    assert.equal(sums.get(id('Раздел 2.')).counts.over, 1)
    assert.ok(Math.abs(total.total - SAMPLE_TOTAL) < 0.01)
    assert.equal(total.notes, 1)
    assert.deepEqual(linkedPzIds(tree, id('Отделка пола автостоянки')), [id('Мастертоп'), id('Бетонное основание'), id('Обмазочная')])
    assert.deepEqual(linkedKpIds(tree, id('Мастертоп')), [id('Отделка пола автостоянки'), id('Мастертоп')])
    assert.deepEqual(linkedPzIds(tree, id('Стена')), [id('Стена')])
    const pzOnly = visibleRowIds(tree, { view: 'pz' })
    assert.ok(!pzOnly.includes(id('Армирование')), 'нулевой строки нет в ПЗ')
    assert.ok(pzOnly.includes(id('Отделка пола автостоянки')), 'укрупнённая — заголовком своих позиций ПЗ')
    const lv1 = visibleRowIds(tree, { collapsed: collapseToLevel(tree, 1) })
    assert.deepEqual(lv1.map((x) => tree.byId.get(x).kind), ['title', 'section', 'section', 'adjust'])
    const found = visibleRowIds(tree, { match: new Set([id('Обмазочная')]), collapsed: collapseToLevel(tree, 1) })
    assert.deepEqual(found, [id('Раздел 1.'), id('Нулевой цикл'), id('Отделка пола автостоянки'), id('Обмазочная')], 'найденная — с предками, свёртка не мешает')
    assert.deepEqual(visibleRowIds(tree, { scope: id('Конструкции') }), [id('Конструкции'), id('Стена'), id('Плита')])
    assert.deepEqual(sectionTree(tree, 'конструкц').ids, [id('Раздел 2.'), id('Конструкции')])
    const plan = planTenderAllocation({ rowIds: [id('Стена'), id('Плита'), id('Раздел 1.')], tree, states, allocsByRow: allocs, tender: { tender_id: 'T2', tender_label: '№ 2' } })
    assert.deepEqual(plan.inserts.map((x) => [x.row_id, x.pz_qty]), [[id('Плита'), 300]], 'стена без остатка — пропущена, раздел — не позиция')
    assert.deepEqual(plan.skipped, [id('Стена')])
    // У плиты уже взято в этот тендер 100 (без подрядчика) — строка не дублируется, её объём растёт на остаток 200.
    const allocs2 = new Map([[id('Плита'), [{ id: 'b', row_id: id('Плита'), tender_id: 'T2', pz_qty: 100, contract_qty: 0, row_version: 3 }]]])
    const again = planTenderAllocation({ rowIds: [id('Плита')], tree, states: computeStates(tree, new Map(), allocs2).states, allocsByRow: allocs2, tender: { tender_id: 'T2' } })
    assert.equal(again.inserts.length, 0)
    assert.deepEqual(again.updates.map((u) => [u.id, u.pz_qty, u.row_version]), [['b', 300, 3]])
  })
  it('фильтры, отметки, история', () => {
    const r = { kind: 'position', unit: 'м' }
    assert.equal(rowMatchesFilters(r, { note: 'x' }, [], { status: 'none' }, { ...EMPTY_FILTERS, withNote: true }), true)
    assert.equal(rowMatchesFilters(r, null, [], { status: 'none' }, { ...EMPTY_FILTERS, statuses: ['over'] }), false)
    assert.equal(rowMatchesFilters({ kind: 'group' }, null, [], null, { ...EMPTY_FILTERS, statuses: ['none'] }), false)
    assert.equal(rowMatchesFilters(r, null, [{ tender_id: 'T' }], { status: 'partial' }, { ...EMPTY_FILTERS, tender: 't:T' }), true)
    assert.deepEqual(markPayload({ fill: '#123456', cell_fills: { actual: '#fff3bf', bad: 'red', 'x y': '#fff3bf' }, note: 'a'.repeat(5000), actual_qty: '12.5' }),
      { fill: null, cell_fills: { actual: '#fff3bf' }, note: 'a'.repeat(4000), actual_qty: 12.5 })
    const d = describeLogEntry({ entity: 'mark', action: 'update', changes: { actual_qty: { old: null, new: 120 }, note: { old: 'был', new: 'стал' }, fill: { old: null, new: '#fff3bf' } } })
    assert.deepEqual(d.lines, ['Примечание: «был» → «стал»', 'Заливка строки: — → жёлтый', 'Актуальный объём: — → 120'])
    const a = describeLogEntry({ entity: 'allocation', action: 'insert', changes: { tender_label: { old: null, new: '№ 501' }, pz_qty: { old: null, new: 120 }, _allocation: { tender: '№ 501' } } })
    assert.equal(a.title, 'Распределение добавлено')
    assert.deepEqual(a.lines, ['Тендер: «№ 501»', 'Объём в расчёте ПЗ: 120'])
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
    { id: 'a', row_id: id('Стена'), tender_id: 'T', tender_label: '№ 501', pz_qty: 120, contract_qty: 0, counterparty_name: null },
    { id: 'b', row_id: id('Стена'), tender_id: 'T', tender_label: '№ 501', counterparty_name: 'ООО Монолит', contract_label: 'ДП 1', pz_qty: 0, contract_qty: 100 },
  ]]])
  const c = computeStates(tree, marks, allocsByRow)
  const ctx = { tree, marks, allocsByRow, states: c.states, sums: c.sums, total: c.total, meta: sample().built.meta, estimate: { title: 'К1' } }
  const all = { kp: true, pz: true, mastering: true, allocations: true, coefficients: true, passport: true }

  it('вся смета: формулы КП и сметы, «Освоение» = распределённое × цена, заливка, коэффициенты', () => {
    const buf = buildWith(XLSXStyle, ctx, { ids: exportRowIds(tree, null), sheets: all })
    const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellStyles: true })
    assert.deepEqual(wb.SheetNames, ['КП', 'Смета', 'Освоение', 'Распределение', 'Коэффициенты', 'Паспорт'])
    const kp = wb.Sheets['КП']
    const kpRow = rows.findIndex((r) => r.name.includes('Стена')) + 2
    assert.equal(kp[`J${kpRow}`].f, `G${kpRow}*O${kpRow}`)
    assert.equal(kp[`L${kpRow}`].f, `J${kpRow}+K${kpRow}`)
    assert.equal(kp[`R${kpRow}`].f, `Q${kpRow}-G${kpRow}`)
    assert.equal(kp[`Q${kpRow}`].v, 150)
    assert.equal(kp[`T${kpRow}`].v, 120, 'тендер 120 и договор 100 по нему — 120')
    const aggRow = rows.findIndex((r) => r.kind === 'aggregate') + 2
    assert.equal(kp[`L${aggRow}`].f, `SUBTOTAL(9,L${aggRow + 1}:L${aggRow + 3})`)
    const last = rows.length + 2
    assert.equal(kp[`C${last}`].v, 'ИТОГО')
    assert.equal(kp[`L${last}`].f, `SUBTOTAL(9,L2:L${last - 1})`)
    const sm = wb.Sheets['Смета']
    const smRow = rows.filter((r) => r.pz).findIndex((r) => r.name.includes('Стена')) + 2
    assert.equal(sm[`S${smRow}`].f, `SUMIF(Освоение!C:C,A${smRow},Освоение!F:F)`)
    assert.equal(sm[`T${smRow}`].f, `P${smRow}-S${smRow}`)
    assert.match(sm[`U${smRow}`].f, /не начато/)
    const os = XLSX.utils.sheet_to_json(wb.Sheets['Освоение'], { header: 1 })
    assert.equal(os.length, 2, 'одна группа распределения — одна строка')
    assert.equal(os[1][2], '2.1.1')
    assert.equal(os[1][5], 120 * 68134)
    assert.match(os[1][4], /№ 501.*ООО Монолит/)
    const fill = (ws, ref) => ws[ref]?.s?.fgColor?.rgb || ws[ref]?.s?.fill?.fgColor?.rgb
    assert.match(String(fill(kp, `C${kpRow}`)), /FFF3BF/i, 'заливка строки')
    assert.match(String(fill(kp, `Y${kpRow}`)), /FFE3E3/i, 'заливка ячейки «Примечание»')
    assert.ok(XLSX.utils.sheet_to_json(wb.Sheets['Коэффициенты'], { header: 1 }).some((r) => r[0] === 'Материалы (мат)'))
  })

  it('выделенное: строки с предками, SUBTOTAL группы — по выгруженным строкам', () => {
    const ids = exportRowIds(tree, [id('Обмазочная')])
    assert.deepEqual(ids, [id('Раздел 1.'), id('Нулевой цикл'), id('Отделка пола автостоянки'), id('Обмазочная')])
    const wb = XLSX.read(buildWith(XLSXStyle, ctx, { ids, sheets: { kp: true } }), { type: 'array', cellFormula: true })
    assert.equal(wb.Sheets['КП'].L2.f, 'SUBTOTAL(9,L3:L5)')
    assert.equal(wb.Sheets['КП'].L4.f, 'SUBTOTAL(9,L5:L5)')
    assert.equal(masteringRows(ctx, [tree.byId.get(id('Плита'))]).length, 0)
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

  it('итоги, переход КП → ПЗ от укрупнённой позиции и обратно, подробности с формулами', async () => {
    const { page, errors, context } = await open()
    await page.waitForSelector('.kpe-table tbody tr[data-id]')
    assert.match(await page.textContent('.kpe-summary'), /Превышение\s*1/)
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 7).locator('.kpe-link-btn').click()
    assert.equal(await page.getAttribute('.kpe-seg button:has-text("ПЗ")', 'aria-pressed'), 'true')
    for (const no of [8, 9, 10]) assert.match(await row(page, no).getAttribute('class'), /is-highlight/)
    await row(page, 9).locator('.kpe-link-btn').click()
    assert.equal(await page.getAttribute('.kpe-seg button:has-text("КП")', 'aria-pressed'), 'true')
    assert.match(await row(page, 7).getAttribute('class'), /is-highlight/, 'укрупнённая позиция КП подсвечена')
    await row(page, 14).locator('td.kpe-c-name').click()
    const detail = (await page.locator('.kpe-detail').textContent()).replace(/[\u00a0\u202f]/g, ' ')
    assert.match(detail, /200 × 19 416,00 = 3 883 200,00/)
    assert.match(detail, /Коммерция \/ прямые/)
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('примечание и актуальный объём — сами сохраняются, с историей; превышение подсвечено, распределения не меняются', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 4).locator('td.kpe-c-note').click()
    assert.equal(await page.locator('.kpe-detail').count(), 0, 'правка в ячейке — без панели (она сдвигала бы таблицу)')
    await page.fill('.kpe-inline--note', 'Сверить с ВОР')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_marks.some((m) => m.row_id === 'kr-4' && m.note === 'Сверить с ВОР'))
    await page.waitForSelector('.kpe-save:has-text("Все изменения сохранены")')
    await row(page, 14).locator('td.kpe-c-name').click()
    const actual = page.locator('.kpe-detail input[aria-label="Актуальный объём"]')
    await actual.fill('100')
    await actual.press('Enter')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_marks.find((m) => m.row_id === 'kr-14')?.actual_qty === 100)
    await page.waitForSelector('tr[data-id="kr-14"].is-over')
    assert.match(await page.textContent('.kpe-detail'), /Распределено больше актуального объёма на 20/)
    const allocs = (await db(page, 'kp_estimate_allocations')).filter((a) => a.row_id === 'kr-14')
    assert.deepEqual(allocs.map((a) => [a.pz_qty, a.contract_qty]), [[120, 100]], 'тендер и договор не тронуты')
    await page.waitForSelector('.kpe-detail .kpe-log li')
    assert.match(await page.textContent('.kpe-detail .kpe-log'), /Актуальный объём: — → 100/)
    const log = await db(page, 'kp_estimate_log')
    assert.ok(log.some((e) => e.row_id === 'kr-4' && e.changes.note?.new === 'Сверить с ВОР'))
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
    await page.click('.kpe-selbar button:has-text("Выделять ячейки")')
    const a = row(page, 14).locator('td.kpe-c-total')
    const b = row(page, 15).locator('td.kpe-c-price')
    await a.hover()
    await page.mouse.down()
    await b.hover()
    await page.mouse.up()
    assert.match(await page.textContent('.kpe-selbar'), /Ячеек: 4/)
    await page.click('.kpe-selbar button[aria-label="Залить: Красный"]')
    await page.waitForFunction(() => ['kr-14', 'kr-15'].every((r) => {
      const cf = window.__fakeDb.kp_estimate_marks.find((m) => m.row_id === r)?.cell_fills || {}
      return cf.total === '#ffe3e3' && cf.price === '#ffe3e3'
    }))
    assert.match(await row(page, 14).locator('td.kpe-c-total').getAttribute('class'), /has-cell-fill/)
    assert.deepEqual(errors, [])
    await context.close()
  })

  it('распределение: тендер с объёмом свободного остатка; та же пара тендер + подрядчик второй раз — отказ', async () => {
    const { page, errors, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 4).locator('td.kpe-c-name').click()
    await page.click('.kpe-detail button:has-text("+ Добавить распределение")')
    await page.selectOption('.kpe-alloc.is-new select[aria-label="Тендер"]', 'kt-502')
    assert.equal(await page.inputValue('.kpe-alloc.is-new input[aria-label="Объём в расчёте ПЗ"]'), '1000', 'весь свободный остаток')
    await page.click('.kpe-alloc.is-new button:has-text("Добавить")')
    await page.waitForFunction(() => window.__fakeDb.kp_estimate_allocations.some((a) => a.row_id === 'kr-4' && a.tender_id === 'kt-502' && a.pz_qty === 1000))
    await page.waitForSelector('tr[data-id="kr-4"] .kpe-chip:has-text("№ 502")')
    assert.match(await page.textContent('.kpe-detail .kpe-dist-summary'), /Свободно: 0/)
    await page.click('.kpe-detail button:has-text("+ Добавить распределение")')
    await page.selectOption('.kpe-alloc.is-new select[aria-label="Тендер"]', 'kt-502')
    await page.click('.kpe-alloc.is-new button:has-text("Добавить")')
    await page.waitForSelector('.kpe-notice--error:has-text("уже есть")')
    assert.equal((await db(page, 'kp_estimate_allocations')).filter((a) => a.row_id === 'kr-4').length, 1)
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

  it('поиск и фильтры: найденные — с разделами; «Превышение» — плиты', async () => {
    const { page, context } = await open()
    await page.fill('.kpe-search', 'плита перекрытия')
    await page.waitForSelector('.kpe-found:has-text("Найдено: 1")')
    const shown = await page.locator('.kpe-table tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => t.dataset.id))
    assert.deepEqual(shown, ['kr-12', 'kr-13', 'kr-15'])
    await page.fill('.kpe-search', '')
    await page.click('.kpe-tile--btn:has-text("Превышение")')
    await page.waitForSelector('.kpe-found')
    assert.deepEqual(await page.locator('.kpe-table tbody tr[data-id]').evaluateAll((trs) => trs.map((t) => t.dataset.id)), ['kr-12', 'kr-13', 'kr-15'])
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
    await page.setInputFiles('.kpe-modal input[type=file]', [
      { name: 'Пример К1 - КП до перекидок v2.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(files.kp, 'base64') },
      { name: 'Смета v2.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(files.pz, 'base64') },
    ])
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

  it('выгрузка выделенного: файл с листами и формулами', async () => {
    const { page, context } = await open()
    await page.click('.kpe-seg button:has-text("Все")')
    await row(page, 14).locator('td.kpe-c-sel input').click()
    await page.click('.kpe-selbar button:has-text("Выгрузить выделенное")')
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.kpe-modal-foot button:has-text("Выгрузить")')])
    const wb = XLSX.read(fs.readFileSync(await download.path()), { cellFormula: true })
    assert.deepEqual(wb.SheetNames.slice(0, 4), ['КП', 'Смета', 'Освоение', 'Распределение'])
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['КП'], { header: 1 }).length, 5, 'шапка, раздел, группа, стена, ИТОГО')
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
    await ro.page.waitForSelector('.kpe-detail', { timeout: 5000 })
    await ro.context.close()
    const miss = await open('&kpe=missing')
    await miss.page.waitForSelector('.kpe-root--empty')
    assert.match(await miss.page.textContent('.kpe-root'), /миграция 20270215/)
    await miss.context.close()
  })
})
