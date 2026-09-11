// Расчётный движок ПСДЦ, жизненный цикл, права, пакетная загрузка — на
// настоящих миграциях проекта во временном локальном PostgreSQL.
//
//   node --test tests/psdc/
//
// Нужны бинарники PostgreSQL 17+ (initdb, pg_ctl, psql) в PATH или PG_BIN.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupDatabase, pgAvailable, sqlJson } from './lib/pg.mjs'
import { dec, mul, add, round, fixed, sum } from './lib/decimal.mjs'
import {
  HEADER, createUser, createObject, createDocument, row, section, process, stage, rpc, tryRpc, q,
} from './lib/fixtures.mjs'

const skip = !pgAvailable() && 'PostgreSQL (initdb/pg_ctl/psql) не найден — задайте PG_BIN'

describe('ПСДЦ: база данных', { skip }, () => {
  let db
  let admin
  let lawyer
  let viewer

  before(() => {
    db = setupDatabase()
    admin = createUser(db, { role: 'admin', name: 'Админ' })
    lawyer = createUser(db, { role: 'lawyer', canEdit: true, name: 'Юрист' })
    viewer = createUser(db, { role: 'economist', canView: true, canEdit: false, name: 'Экономист' })
  })

  after(() => db?.stop())

  const newContract = (extra = {}) => createDocument(db, { record_type: 'dp', status: 'in_work', contract_amount: 1000, vat_rate: 22, ...extra })
  const docTotal = (id) => db.exec(`SELECT COALESCE(psdc_total::text, 'null') || '|' || COALESCE(contract_amount::text, 'null') FROM contracts WHERE id = '${id}';`).trim()
  const rowsOf = (psdcId) => rpc(db, admin, 'psdc_get_rows', q(psdcId))
  const byNumber = (rows, n) => rows.find((r) => r.number === n)

  // ── 110: обычная строка ───────────────────────────────────────────────────
  it('обычный процесс: K, M, N, O с округлением Excel ROUND на строке', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'Отделка'), process(3, '1.1', 'Грунтовка', { volume: 10.12345, materialPrice: 1234.56, workPrice: 789.12 })],
    })
    assert.equal(result.state, 'validated', JSON.stringify(result.issues))

    const I = dec('10.12345'); const J = dec('1234.56'); const L = dec('789.12')
    const K = round(mul(round(I, 5), round(J, 2)), 2)
    const M = round(mul(round(I, 5), round(L, 2)), 2)
    const N = round(add(round(J, 2), round(L, 2)), 2)
    const O = round(add(K, M), 2)

    const p = byNumber(rowsOf(id), '1.1')
    assert.equal(p.material_cost, fixed(K))
    assert.equal(p.work_cost, fixed(M))
    assert.equal(p.unit_price, fixed(N))
    assert.equal(p.total_cost, fixed(O))
    assert.equal(p.volume, '10.12345')
    assert.equal(result.total, fixed(O))
    assert.equal(result.total_material, fixed(K))
    assert.equal(result.total_work, fixed(M))
  })

  it('округление половины от нуля, как Excel ROUND', () => {
    const doc = newContract()
    const { id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'Половина', { volume: 0.5, materialPrice: 0.01, workPrice: 0.03 })],
    })
    const p = byNumber(rowsOf(id), '1.1')
    assert.equal(p.material_cost, '0.01') // 0.005 → 0.01
    assert.equal(p.work_cost, '0.02')     // 0.015 → 0.02
  })

  // ── 111: ДМ ───────────────────────────────────────────────────────────────
  it('ДМ: материал считается информационно, работа входит в итог', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'Плитка ДМ', { volume: '10,00000', materialPrice: '1 000,00', workPrice: '500,00', dm: true })],
    })
    const p = byNumber(rowsOf(id), '1.1')
    assert.equal(p.material_cost, '10000.00')
    assert.equal(p.work_cost, '5000.00')
    assert.equal(p.unit_price, '1500.00')
    assert.equal(p.total_cost, '5000.00')
    assert.equal(p.is_customer_material, true)
    assert.equal(result.total, '5000.00')
    assert.equal(result.total_material, '0.00')
    assert.equal(result.total_work, '5000.00')
    assert.equal(result.dm_material_excluded, '10000.00')
  })

  it('ДМ распознаётся без учёта регистра и внешних пробелов, прочие значения — не ДМ', () => {
    const doc = newContract()
    const { id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '1', 'С'),
        process(3, '1.1', 'a', { volume: 1, materialPrice: 100, workPrice: 10, D: '  дм ' }),
        process(4, '1.2', 'b', { volume: 1, materialPrice: 100, workPrice: 10, D: 'давальческий' }),
      ],
    })
    const rows = rowsOf(id)
    assert.equal(byNumber(rows, '1.1').total_cost, '10.00')
    assert.equal(byNumber(rows, '1.2').total_cost, '110.00')
  })

  // ── 112: секция с ДМ ──────────────────────────────────────────────────────
  it('секция с ДМ: K = 10 000, M = 5 000, O = 15 000', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '1', 'Секция'),
        process(3, '1.1', 'Обычная', { volume: 1, materialPrice: 10000, workPrice: 2000 }),
        process(4, '1.2', 'ДМ', { volume: 1, materialPrice: 20000, workPrice: 3000, dm: true }),
      ],
    })
    const s = byNumber(rowsOf(id), '1')
    assert.equal(s.material_cost, '10000.00')
    assert.equal(s.work_cost, '5000.00')
    assert.equal(s.total_cost, '15000.00')
    assert.equal(s.unit_price, null)
    assert.equal(result.total, '15000.00')
  })

  // ── 113: deleted ─────────────────────────────────────────────────────────
  it('строка U = deleted хранится, но не входит ни в секцию, ни в итог', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      hasU: true,
      rows: [
        section(2, '1', 'Секция'),
        process(3, '1.1', 'a', { volume: 1, materialPrice: 100, workPrice: 10 }),
        process(4, '1.2', 'b', { volume: 1, materialPrice: 200, workPrice: 20, U: '' }),
        process(5, '1.3', 'удалена', { volume: 1, materialPrice: 999, workPrice: 99, U: ' Deleted ' }),
      ],
    })
    const rows = rowsOf(id)
    const s = byNumber(rows, '1')
    assert.equal(s.material_cost, '300.00')
    assert.equal(s.work_cost, '30.00')
    assert.equal(s.total_cost, '330.00')
    assert.equal(result.total_material, '300.00')
    assert.equal(result.total_work, '30.00')
    assert.equal(result.total, '330.00')
    const del = byNumber(rows, '1.3')
    assert.equal(del.legacy_deleted, true)
    assert.equal(del.total_cost, null)
    assert.equal(result.legacy_deleted_count, 1)
  })

  it('без столбца U значение deleted в U не интерпретируется, другие значения U не статусы', () => {
    const doc = newContract()
    const { result } = stage(db, lawyer, {
      documentId: doc.id,
      hasU: true,
      rows: [
        section(2, '1', 'Секция'),
        process(3, '1.1', 'a', { volume: 1, materialPrice: 100, U: 'changed' }),
        process(4, '1.2', 'b', { volume: 1, materialPrice: 100, U: 'added' }),
      ],
    })
    assert.equal(result.total, '200.00')
    assert.equal(result.legacy_deleted_count, 0)
  })

  // ── 114: № 5.10 ──────────────────────────────────────────────────────────
  it('№ п/п — текст: 5.10 не превращается в 5.1 и относится к секции 5', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '5', 'Секция 5'),
        process(3, '5.1', 'a', { volume: 1, materialPrice: 1 }),
        process(4, '5.2', 'b', { volume: 1, materialPrice: 2 }),
        process(5, '5.10', 'c', { volume: 1, materialPrice: 10 }),
        // числовая ячейка с отображением «5.11»
        process(6, { t: 'n', v: '5.11', w: '5.11' }, 'd', { volume: 1, materialPrice: 11 }),
        section(7, '51', 'Секция 51'),
        process(8, '51.1', 'e', { volume: 1, materialPrice: 100 }),
      ],
    })
    assert.equal(result.state, 'validated', JSON.stringify(result.issues))
    const rows = rowsOf(id)
    const s5 = byNumber(rows, '5')
    assert.ok(byNumber(rows, '5.10'), 'строка 5.10 сохранена')
    assert.ok(byNumber(rows, '5.1'), 'строка 5.1 отдельная')
    assert.equal(byNumber(rows, '5.10').parent_section_id, s5.id)
    assert.equal(byNumber(rows, '5.11').parent_section_id, s5.id)
    assert.equal(s5.material_cost, '24.00') // 1 + 2 + 10 + 11, без секции 51
    assert.equal(byNumber(rows, '51').material_cost, '100.00')
    assert.deepEqual(rows.map((r) => r.number), ['5', '5.1', '5.2', '5.10', '5.11', '51', '51.1'])
  })

  it('порядок строк — фактический порядок Excel, а не сортировка номеров', () => {
    const doc = newContract()
    const { id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '2', 'Вторая'), process(3, '2.10', 'x', { volume: 1 }), process(4, '2.2', 'y', { volume: 1 }),
        section(10, '1', 'Первая'), process(12, '1.1', 'z', { volume: 1 }),
      ],
    })
    assert.deepEqual(rowsOf(id).map((r) => [r.number, r.row_order, r.excel_row]), [
      ['2', 1, 2], ['2.10', 2, 3], ['2.2', 3, 4], ['1', 4, 10], ['1.1', 5, 12],
    ])
  })

  // ── 18: числа ─────────────────────────────────────────────────────────────
  it('разбор чисел: числовые ячейки, точка, запятая, пробелы и неразрывные пробелы', () => {
    const doc = newContract()
    const { result, id } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '1', 'С'),
        process(3, '1.1', 'a', { volume: 1, materialPrice: '1000000.25' }),
        process(4, '1.2', 'b', { volume: 1, materialPrice: '1000000,25' }),
        process(5, '1.3', 'c', { volume: 1, materialPrice: '1 000 000,25' }),
        process(6, '1.4', 'd', { volume: 1, materialPrice: '1\u00A0000\u00A0000,25' }),
        process(7, '1.5', 'e', { volume: { t: 'n', v: '1' }, materialPrice: { t: 'n', v: '1000000.25' } }),
      ],
    })
    assert.equal(result.state, 'validated', JSON.stringify(result.issues))
    for (const n of ['1.1', '1.2', '1.3', '1.4', '1.5']) {
      assert.equal(byNumber(rowsOf(id), n).material_price, '1000000.25', n)
    }
    assert.equal(result.total, '5000001.25')
  })

  // ── 20: формулы в исходных полях ─────────────────────────────────────────
  it('формула в I с сохранённым числом — предупреждение, без значения — ошибка ячейки', () => {
    const doc = newContract()
    const ok = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: { t: 'n', v: '2', f: 1 }, materialPrice: 5 })],
    }).result
    assert.equal(ok.state, 'validated')
    assert.ok(ok.issues.some((i) => i.code === 'source_formula' && i.cell === 'I3'))
    assert.equal(ok.total, '10.00')

    const bad = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: { t: 's', v: '', f: 1 }, materialPrice: 5 })],
    }).result
    assert.equal(bad.state, 'invalid')
    assert.ok(bad.issues.some((i) => i.severity === 'error' && i.cell === 'I3'))
  })

  // ── 19/49: сохранённые K/M/N/O и итог файла — только диагностика ────────
  it('старые сохранённые значения K/M/O и итог файла сравниваются, но не блокируют', () => {
    const doc = newContract()
    const { result } = stage(db, lawyer, {
      documentId: doc.id,
      totals: { row: 6, k: { t: 'n', v: '0', f: 1 }, m: { t: 'n', v: '0', f: 1 }, o: { t: 'n', v: '999', f: 1 } },
      rows: [
        section(2, '1', 'С', { K: { t: 'n', v: '0', f: 1 }, M: { t: 'n', v: '0', f: 1 }, O: { t: 'n', v: '0', f: 1 } }),
        // старая формула исключала работы ДМ: M = 0
        process(3, '1.1', 'ДМ', { volume: 1, materialPrice: 100, workPrice: 50, dm: true, M: { t: 'n', v: '0', f: 1 }, O: { t: 'n', v: '0', f: 1 } }),
      ],
    })
    assert.equal(result.state, 'validated')
    assert.equal(result.total, '50.00')
    assert.ok(result.issues.some((i) => i.code === 'legacy_value' && i.cell === 'M3'))
    assert.ok(result.issues.some((i) => i.code === 'legacy_total' && i.cell === 'O6'))
  })

  // ── 96: структурные ошибки ───────────────────────────────────────────────
  it('критические ошибки: тип, секция, дубль секции, объём, обязательные поля', () => {
    const doc = newContract()
    const { result } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [
        section(2, '1', 'С'),
        section(3, '1', 'Дубль'),
        process(4, '1.1', 'нет ед.', { volume: 1, unit: '' }),
        process(5, '2.1', 'без секции', { volume: 1 }),
        row(6, { A: '1.2', B: 'Материал', F: 'x', G: 'шт', I: 1 }),
        process(7, '1.3', 'плохой объём', { volume: 'много' }),
        process(8, '1.4', 'отриц', { volume: -1 }),
        process(9, '', 'без номера', { volume: 1 }),
        process(10, '1.5', '', { volume: 1 }),
        process(11, '1.6', 'без объёма', {}),
      ],
    })
    assert.equal(result.state, 'invalid')
    const has = (cellRef, re) => result.issues.some((i) => i.severity === 'error' && i.cell === cellRef && re.test(i.message))
    assert.ok(has('A2', /повторяется/))
    assert.ok(has('A3', /повторяется/))
    assert.ok(has('G4', /единица измерения/))
    assert.ok(has('A5', /Не найдена секция/))
    assert.ok(has('B6', /Неизвестный тип ресурса/))
    assert.ok(has('I7', /некорректное число/))
    assert.ok(has('I8', /отрицательное/))
    assert.ok(has('A9', /не заполнен/))
    assert.ok(has('F10', /наименование/))
    assert.ok(has('I11', /Не заполнен объём/))
  })

  it('ошибка шапки блокирует разбор строк; ошибка файла сохраняется как ошибка', () => {
    const doc = newContract()
    const header = [...HEADER]
    header[8] = 'Количество'
    const bad = stage(db, lawyer, { documentId: doc.id, header, rows: [section(2, '1', 'С')] }).result
    assert.equal(bad.state, 'invalid')
    assert.ok(bad.issues.some((i) => i.cell === 'I1'))
    assert.equal(bad.process_count, null)

    const tolerant = [...HEADER]
    tolerant[8] = ' Объем\n'
    const good = stage(db, lawyer, {
      documentId: doc.id, header: tolerant, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1 })],
    }).result
    assert.equal(good.state, 'validated', 'пробелы, перенос и ё/е в заголовке допустимы')

    const fatal = stage(db, lawyer, { documentId: doc.id, fatal: ['Не найден лист'], rows: [] }).result
    assert.equal(fatal.state, 'invalid')
    assert.equal(fatal.issues[0].message, 'Не найден лист')
  })

  it('объём 0 и нулевые цены — не ошибки; объём 0 даёт предупреждение', () => {
    const doc = newContract()
    const { result } = stage(db, lawyer, {
      documentId: doc.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 0, materialPrice: 0, workPrice: 0 })],
    })
    assert.equal(result.state, 'validated')
    assert.ok(result.issues.some((i) => i.code === 'volume_zero'))
  })

  // ── 46–48: НДС ───────────────────────────────────────────────────────────
  it('НДС из документа: 22% в том числе; без НДС = 0; подпись файла — предупреждение', () => {
    const vat22 = newContract({ vat_rate: 22, amount_includes_vat: true })
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 1000 })]
    const r22 = stage(db, lawyer, { documentId: vat22.id, rows, totals: { vat_text: 'в том числе НДС 20%', vat_row: 5 } }).result
    assert.equal(r22.vat_amount, '180.33') // 1000 × 22 / 122 = 180.327…
    assert.equal(r22.vat_rate, '22.00')
    assert.ok(r22.issues.some((i) => i.code === 'vat_rate_mismatch'))

    const noVat = newContract({ vat_rate: null })
    assert.equal(stage(db, lawyer, { documentId: noVat.id, rows }).result.vat_amount, '0.00')
    const net = newContract({ vat_rate: 22, amount_includes_vat: false })
    assert.equal(stage(db, lawyer, { documentId: net.id, rows }).result.vat_amount, '0.00')
  })

  it('ДС на изменение без изменения НДС наследует ставку изменяемого документа', () => {
    const base = newContract({ vat_rate: 20, status: 'completed' })
    const ds = createDocument(db, { record_type: 'ds_vor', parent_contract_id: base.id, status: 'in_work', vat_rate: null })
    const r = stage(db, lawyer, { documentId: ds.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 120 })] }).result
    assert.equal(r.vat_rate, '20.00')
    assert.equal(r.vat_amount, '20.00')
  })

  // ── 118: жизненный цикл и ручная сумма ───────────────────────────────────
  it('жизненный цикл: сумма документа меняется только при применении и возвращается при удалении', () => {
    const doc = newContract({ contract_amount: 10000000 })
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 11000000 })]
    const meta = { source_filename: 'ВОР.xlsx', header: HEADER, totals: {}, fatal: [] }
    const id = rpc(db, lawyer, 'psdc_create', q(doc.id), 'NULL', sqlJson(meta))
    assert.equal(docTotal(doc.id), 'null|10000000.00', 'после загрузки')
    rpc(db, lawyer, 'psdc_add_rows', q(id), sqlJson(rows))
    const v = rpc(db, lawyer, 'psdc_validate', q(id))
    assert.equal(v.total, '11000000.00')
    assert.equal(docTotal(doc.id), 'null|10000000.00', 'после проверки')

    rpc(db, lawyer, 'psdc_apply', q(id))
    assert.equal(docTotal(doc.id), '11000000.00|10000000.00', 'после применения: ручная сумма сохранена')

    rpc(db, lawyer, 'psdc_delete', q(id))
    assert.equal(docTotal(doc.id), 'null|10000000.00', 'после удаления')
    assert.equal(db.exec(`SELECT state FROM psdc WHERE id = '${id}';`).trim(), 'deleted', 'история сохранена')
  })

  it('отмена загрузки не меняет документ и освобождает строки', () => {
    const doc = newContract({ contract_amount: 500 })
    const { id } = stage(db, lawyer, { documentId: doc.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 9 })] })
    rpc(db, lawyer, 'psdc_cancel', q(id))
    assert.equal(docTotal(doc.id), 'null|500.00')
    assert.equal(db.exec(`SELECT state || ':' || (SELECT count(*) FROM psdc_rows WHERE psdc_id = '${id}') FROM psdc WHERE id = '${id}';`).trim(), 'cancelled:0')
    assert.equal(tryRpc(db, lawyer, 'psdc_apply', q(id)).ok, false)
  })

  it('невалидную ПСДЦ применить нельзя', () => {
    const doc = newContract()
    const { id } = stage(db, lawyer, { documentId: doc.id, rows: [process(3, '1.1', 'a', { volume: 1 })] })
    const res = tryRpc(db, lawyer, 'psdc_apply', q(id))
    assert.equal(res.ok, false)
    assert.match(res.error, /содержит ошибки/)
    assert.equal(docTotal(doc.id), 'null|1000.00')
  })

  // ── 58/101: одна применённая, конкурентное применение ────────────────────
  it('вторая ПСДЦ не применяется, пока не удалена первая; повторная загрузка из карточки заменяет черновик', () => {
    const doc = newContract()
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 7 })]
    const a = stage(db, lawyer, { documentId: doc.id, rows })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    const b = stage(db, lawyer, { documentId: doc.id, rows })
    const res = tryRpc(db, lawyer, 'psdc_apply', q(b.id))
    assert.equal(res.ok, false)
    assert.match(res.error, /уже есть применённая ПСДЦ/)
    const c = stage(db, lawyer, { documentId: doc.id, rows })
    assert.equal(db.exec(`SELECT state FROM psdc WHERE id = '${b.id}';`).trim(), 'cancelled')
    assert.equal(db.exec(`SELECT state FROM psdc WHERE id = '${c.id}';`).trim(), 'validated')
    // И напрямую в обход функций — уникальный индекс.
    const direct = db.tryAsUser(admin, `UPDATE psdc SET state = 'applied' WHERE id = '${c.id}';`)
    assert.equal(direct.ok, false)
    const sup = (() => { try { db.exec(`UPDATE psdc SET state = 'applied' WHERE id = '${c.id}';`); return true } catch { return false } })()
    assert.equal(sup, false, 'уникальный индекс не даёт двух применённых даже суперпользователю')
  })

  it('конкурентное применение двух версий к одному документу: побеждает одна', async () => {
    const doc = newContract()
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 3 })]
    // Две временные версии: одна из карточки, вторая — через пакет.
    const a = stage(db, lawyer, { documentId: doc.id, rows })
    const batch = rpc(db, lawyer, 'psdc_batch_create', `'конкуренция'`)
    const b = stage(db, lawyer, { batchId: batch, rows })
    rpc(db, lawyer, 'psdc_batch_set_documents', sqlJson([{ psdc_id: b.id, document_id: doc.id, method: 'manual' }]))

    const slow = (id) => `BEGIN; SELECT psdc_apply('${id}'); SELECT pg_sleep(1); COMMIT;`
    const [r1, r2] = await Promise.all([db.spawnAsUser(lawyer, slow(a.id)), db.spawnAsUser(lawyer, slow(b.id))])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1, `${r1.error} | ${r2.error}`)
    const loser = r1.ok ? r2 : r1
    assert.match(loser.error, /уже есть применённая ПСДЦ/)
    assert.equal(db.exec(`SELECT count(*) FROM psdc WHERE document_id = '${doc.id}' AND state = 'applied';`).trim(), '1')
  })

  // ── 2: защита суммы и таблиц ─────────────────────────────────────────────
  it('сумму ПСДЦ и таблицы ПСДЦ нельзя изменить в обход функций', () => {
    const doc = newContract()
    const upd = db.tryAsUser(admin, `UPDATE contracts SET psdc_total = 1 WHERE id = '${doc.id}';`)
    assert.equal(upd.ok, false)
    assert.match(upd.error, /только действиями/)
    const ins = db.tryAsUser(admin, `INSERT INTO psdc (source_filename, document_id) VALUES ('x', '${doc.id}');`)
    assert.equal(ins.ok, false)
    // Обычное редактирование договора (без psdc_total) не ломается.
    assert.equal(db.tryAsUser(admin, `UPDATE contracts SET contract_amount = 1234 WHERE id = '${doc.id}';`).ok, true)
  })

  // ── 70/71/120/121: статусы ───────────────────────────────────────────────
  it('завершённое ДС: ПСДЦ не меняется до возврата на доработку', () => {
    const base = newContract({ status: 'completed' })
    const ds = createDocument(db, { record_type: 'ds_vor', parent_contract_id: base.id, status: 'in_work', contract_amount: 100 })
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 105 })]
    const a = stage(db, lawyer, { documentId: ds.id, rows })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    assert.equal(docTotal(ds.id), '105.00|100.00', 'карточка ДС показывает сумму ПСДЦ до завершения')

    db.exec(`UPDATE contracts SET status = 'completed' WHERE id = '${ds.id}';`)
    const meta = sqlJson({ source_filename: 'x.xlsx', header: HEADER })
    assert.match(tryRpc(db, lawyer, 'psdc_create', q(ds.id), 'NULL', meta).error, /завершено/)
    assert.match(tryRpc(db, lawyer, 'psdc_delete', q(a.id)).error, /завершено/)

    db.exec(`UPDATE contracts SET status = 'in_work' WHERE id = '${ds.id}';`)
    rpc(db, lawyer, 'psdc_delete', q(a.id))
    const b = stage(db, lawyer, { documentId: ds.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 110 })] })
    rpc(db, lawyer, 'psdc_apply', q(b.id))
    db.exec(`UPDATE contracts SET status = 'completed' WHERE id = '${ds.id}';`)
    assert.equal(docTotal(ds.id), '110.00|100.00')
  })

  it('старый завершённый договор без ПСДЦ принимает первичную ПСДЦ; новый завершённый — нет', () => {
    const old = newContract({ status: 'completed', contract_amount: 777, created_at: '2020-01-01T00:00:00Z' })
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 800 })]
    const a = stage(db, lawyer, { documentId: old.id, rows })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    assert.equal(docTotal(old.id), '800.00|777.00')
    assert.equal(db.exec(`SELECT status || '|' || record_type FROM contracts WHERE id = '${old.id}';`).trim(), 'completed|dp')

    const fresh = newContract({ status: 'completed' })
    const meta = sqlJson({ source_filename: 'x.xlsx', header: HEADER })
    assert.match(tryRpc(db, lawyer, 'psdc_create', q(fresh.id), 'NULL', meta).error, /завершён/)
  })

  // ── 103: права ───────────────────────────────────────────────────────────
  it('права: без редактирования нельзя загрузить и применить; просмотр и экспорт — можно', () => {
    const doc = newContract()
    const meta = sqlJson({ source_filename: 'x.xlsx', header: HEADER })
    assert.match(tryRpc(db, viewer, 'psdc_create', q(doc.id), 'NULL', meta).error, /Недостаточно прав/)

    const { id } = stage(db, lawyer, { documentId: doc.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1 })] })
    assert.match(tryRpc(db, viewer, 'psdc_apply', q(id)).error, /Недостаточно прав/)
    rpc(db, lawyer, 'psdc_apply', q(id))
    assert.match(tryRpc(db, viewer, 'psdc_delete', q(id)).error, /Недостаточно прав/)
    assert.equal(rpc(db, viewer, 'psdc_get', q(id)).state, 'applied')
    assert.equal(tryRpc(db, viewer, 'psdc_log_export', q(id)).ok, true)
    const state = rpc(db, viewer, 'psdc_document_state', q(doc.id))
    assert.equal(state.can_edit, false)
    assert.equal(state.applied.total, '0.00')

    const other = createUser(db, { role: 'engineer', canView: true, canEdit: true, objectIds: [createObject(db)] })
    assert.equal(tryRpc(db, other, 'psdc_get', q(id)).ok, false, 'чужой объект')
    assert.equal(db.asUser(other, `SELECT count(*) FROM psdc WHERE id = '${id}';`), '0', 'RLS скрывает')
    const unapproved = createUser(db, { role: 'lawyer', approved: false })
    assert.equal(tryRpc(db, unapproved, 'psdc_document_state', q(doc.id)).ok, false)
  })

  // ── 5/55: предыдущая ПСДЦ и ID строк ─────────────────────────────────────
  it('предыдущая ПСДЦ — в той же ветке; ID строки T сохраняется только при однозначном совпадении', () => {
    const contract = newContract({ status: 'completed', created_at: '2020-01-01T00:00:00Z' })
    const a = stage(db, lawyer, {
      documentId: contract.id,
      rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: 10 }), process(4, '1.2', 'b', { volume: 1, materialPrice: 20 })],
    })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    const aRows = rowsOf(a.id)
    const idA11 = byNumber(aRows, '1.1').logical_line_id
    const idA12 = byNumber(aRows, '1.2').logical_line_id

    const ds1 = createDocument(db, { record_type: 'ds_vor', parent_contract_id: contract.id, status: 'completed' })
    const ds2 = createDocument(db, { record_type: 'ds_vor', parent_contract_id: ds1.id, status: 'in_work' })
    const b = stage(db, lawyer, {
      documentId: ds2.id,
      rows: [
        section(2, '1', 'С', { T: byNumber(aRows, '1').logical_line_id }),
        process(3, '1.1', 'a', { volume: 2, materialPrice: 10, T: idA11 }),
        process(4, '1.3', 'новая', { volume: 1, materialPrice: 5, T: 'чужой-id' }),
        process(5, '1.4', 'дубль1', { volume: 1, materialPrice: 5, T: idA12 }),
        process(6, '1.5', 'дубль2', { volume: 1, materialPrice: 5, T: idA12 }),
      ],
    })
    assert.equal(b.result.previous_psdc_id, a.id)
    assert.equal(b.result.state, 'validated', 'неизвестный T не блокирует')
    const bRows = rowsOf(b.id)
    assert.equal(byNumber(bRows, '1.1').logical_line_id, idA11)
    assert.notEqual(byNumber(bRows, '1.3').logical_line_id, 'чужой-id')
    assert.notEqual(byNumber(bRows, '1.4').logical_line_id, idA12)
    assert.notEqual(byNumber(bRows, '1.5').logical_line_id, idA12)
    assert.ok(b.result.issues.some((i) => i.code === 't_unknown' && i.cell === 'T4'))
    assert.ok(b.result.issues.some((i) => i.code === 't_duplicate' && i.cell === 'T5'))

    const cmp = rpc(db, lawyer, 'psdc_compare', q(b.id))
    assert.equal(cmp.previous.id, a.id)
    assert.equal(cmp.rows[byNumber(bRows, '1.1').id].status, 'changed')
    assert.ok(cmp.rows[byNumber(bRows, '1.1').id].fields.includes('volume'))
    assert.equal(cmp.rows[byNumber(bRows, '1.3').id].status, 'new')
    assert.ok(cmp.removed.some((r) => r.number === '1.2'))

    // Отдельная ветка доп. работ не видит ПСДЦ договора.
    const extra = createDocument(db, { record_type: 'ds_extra', parent_contract_id: contract.id, status: 'completed' })
    const extraChange = createDocument(db, { record_type: 'ds_vor', parent_contract_id: extra.id, status: 'in_work' })
    const c = stage(db, lawyer, { documentId: extraChange.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, T: idA11 })] })
    assert.equal(c.result.previous_psdc_id, null)
    assert.notEqual(byNumber(rowsOf(c.id), '1.1').logical_line_id, idA11)
    assert.equal(c.result.state, 'validated', 'отсутствие предыдущей ПСДЦ не блокирует')
  })

  // ── 76–87: пакет ─────────────────────────────────────────────────────────
  it('пакет: независимые файлы, сопоставление, конфликты, существующая ПСДЦ, доступ', () => {
    const obj = createObject(db, 'Скоуп')
    const scoped = createUser(db, { role: 'engineer', canEdit: true, objectIds: [obj] })
    const good1 = newContract({ contract_amount: 1 })
    const good2 = newContract({ contract_amount: 2 })
    const conflictDoc = newContract()
    const withApplied = newContract()
    const deletedDoc = newContract({ deleted_at: '2026-01-01T00:00:00Z' })
    const foreignDoc = newContract({ object_id: createObject(db, 'Чужой') })
    const completedDs = createDocument(db, { record_type: 'ds_extra', parent_contract_id: newContract({ status: 'completed' }).id, status: 'completed' })

    const rows = (price) => [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1, materialPrice: price })]
    rpc(db, lawyer, 'psdc_apply', q(stage(db, lawyer, { documentId: withApplied.id, rows: rows(1) }).id))

    const batch = rpc(db, lawyer, 'psdc_batch_create', `'Пакет'`)
    const f = (name, r) => stage(db, lawyer, { batchId: batch, rows: r, fileName: name }).id
    const files = {
      good1: f('ВОР ID ' + good1.display_id + '.xlsx', rows(100)),
      good2: f('ВОР_2.xlsx', rows(200)),
      invalid: f('ВОР_плохой.xlsx', [process(3, '9.1', 'x', { volume: 1 })]),
      unmapped: f('ВОР_неизвестно.xlsx', rows(1)),
      conflictA: f('ВОР_к1.xlsx', rows(1)),
      conflictB: f('ВОР_к2.xlsx', rows(1)),
      existing: f('ВОР_сущ.xlsx', rows(1)),
      completed: f('ВОР_завершено.xlsx', rows(1)),
    }
    assert.equal(db.exec(`SELECT count(*) FROM psdc WHERE batch_id = '${batch}' AND document_id IS NULL;`).trim(), '8', 'до сопоставления документ не задан')

    const map = rpc(db, lawyer, 'psdc_batch_set_documents', sqlJson([
      { psdc_id: files.good1, document_id: good1.id, method: 'auto' },
      { psdc_id: files.good2, display_id: String(good2.display_id), method: 'table' },
      { psdc_id: files.invalid, document_id: newContract().id, method: 'manual' },
      { psdc_id: files.conflictA, document_id: conflictDoc.id, method: 'manual' },
      { psdc_id: files.conflictB, document_id: conflictDoc.id, method: 'manual' },
      { psdc_id: files.existing, document_id: withApplied.id, method: 'manual' },
      { psdc_id: files.completed, document_id: completedDs.id, method: 'manual' },
      { psdc_id: files.unmapped, display_id: '99999999', method: 'table' },
      { psdc_id: files.unmapped, document_id: deletedDoc.id, method: 'manual' },
    ]))
    const mapErr = (i) => map[i].error || ''
    assert.equal(map.filter((m) => m.ok).length, 7)
    assert.match(mapErr(7), /не найден/)
    assert.match(mapErr(8), /удалён/)

    const denied = rpc(db, scoped, 'psdc_batch_set_documents', sqlJson([{ psdc_id: files.unmapped, document_id: foreignDoc.id }]))
    assert.equal(denied[0].ok, false)
    assert.match(denied[0].error, /Нет доступа/)

    const items = rpc(db, lawyer, 'psdc_batch_items', q(batch))
    const item = (id) => items.find((x) => x.id === id)
    assert.equal(item(files.conflictA).conflict, true)
    assert.equal(item(files.conflictB).conflict, true)
    assert.equal(item(files.existing).document_has_applied, true)
    assert.match(item(files.completed).lock_reason, /завершено/)
    assert.equal(item(files.good2).match_method, 'table')
    assert.equal(item(files.good2).state, 'validated')

    const applied = rpc(db, lawyer, 'psdc_batch_apply', `ARRAY[${Object.values(files).map(q).join(',')}]::uuid[]`)
    const res = Object.fromEntries(Object.entries(files).map(([k, id]) => [k, applied.find((a) => a.psdc_id === id)]))
    assert.equal(res.good1.ok, true)
    assert.equal(res.good2.ok, true)
    assert.equal(res.invalid.ok, false)
    assert.equal(res.unmapped.ok, false)
    assert.equal(res.conflictA.ok, false)
    assert.equal(res.conflictB.ok, false)
    assert.equal(res.existing.ok, false)
    assert.equal(res.completed.ok, false)
    assert.equal(docTotal(good1.id), '100.00|1.00')
    assert.equal(docTotal(good2.id), '200.00|2.00')
    assert.equal(docTotal(conflictDoc.id), 'null|1000.00')

    const issues = rpc(db, lawyer, 'psdc_batch_issues', q(batch), `'error'`)
    assert.ok(issues.some((i) => i.file === 'ВОР_плохой.xlsx' && i.cell === 'A3'))
  })

  // ── 102: аудит ───────────────────────────────────────────────────────────
  it('аудит пишет загрузку, проверку, применение, отмену, удаление и экспорт', () => {
    const doc = newContract()
    const rows = [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1 })]
    const a = stage(db, lawyer, { documentId: doc.id, rows })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    rpc(db, lawyer, 'psdc_log_export', q(a.id))
    rpc(db, lawyer, 'psdc_delete', q(a.id))
    const b = stage(db, lawyer, { documentId: doc.id, rows })
    rpc(db, lawyer, 'psdc_cancel', q(b.id))
    const events = db.exec(`SELECT string_agg(DISTINCT event_type, ',' ORDER BY event_type) FROM contract_audit_log WHERE contract_id = '${doc.id}';`).trim()
    assert.equal(events, 'psdc_applied,psdc_deleted,psdc_exported,psdc_upload_cancelled,psdc_uploaded,psdc_validated')
    const who = db.exec(`SELECT changed_by_name || '|' || (new_value->>'psdc_id') FROM contract_audit_log WHERE contract_id = '${doc.id}' AND event_type = 'psdc_applied';`).trim()
    assert.equal(who, `Юрист|${a.id}`)
  })

  // ── 122: регрессия правил первого этапа ──────────────────────────────────
  it('правила первого этапа не нарушены: иерархия ДС и защита завершённого документа', () => {
    const contract = newContract()
    const change = createDocument(db, { record_type: 'ds_vor', parent_contract_id: contract.id, status: 'in_work' })
    assert.throws(() => createDocument(db, { record_type: 'ds_vor', parent_contract_id: contract.id }), /уже изменён/)
    assert.throws(() => createDocument(db, { record_type: 'ds_extra', parent_contract_id: change.id }), /только к основному договору/)
    db.exec(`UPDATE contracts SET status = 'completed' WHERE id = '${change.id}';`)
    assert.throws(() => db.exec(`UPDATE contracts SET contract_amount = 5 WHERE id = '${change.id}';`), /завершён/)
    // Применение ПСДЦ к договору не трогает защищённые поля завершённого ДС.
    const a = stage(db, lawyer, { documentId: contract.id, rows: [section(2, '1', 'С'), process(3, '1.1', 'a', { volume: 1 })] })
    rpc(db, lawyer, 'psdc_apply', q(a.id))
    assert.equal(db.exec(`SELECT root_contract_id = '${contract.id}' FROM contracts WHERE id = '${change.id}';`).trim(), 't')
  })

  // ── 115: большой файл ────────────────────────────────────────────────────
  it('большой файл: 6 000 строк проверяются и применяются за разумное время', () => {
    const doc = newContract()
    const rows = []
    let r = 2
    const expected = []
    for (let s = 1; s <= 60; s++) {
      rows.push(section(r++, String(s), `Секция ${s}`))
      for (let k = 1; k <= 99; k++) {
        const volume = `${k}.${String(k * 7).padStart(5, '0').slice(0, 5)}`
        const price = `${s * 10}.${String(k).padStart(2, '0')}`
        const dm = k % 10 === 0
        rows.push(process(r++, `${s}.${k}`, `Работа ${s}.${k}`, { volume, materialPrice: price, workPrice: '12.34', dm }))
        const K = round(mul(round(dec(volume), 5), round(dec(price), 2)), 2)
        const M = round(mul(round(dec(volume), 5), round(dec('12.34'), 2)), 2)
        expected.push({ K, M, dm })
      }
    }
    const t0 = Date.now()
    const { id, result } = stage(db, lawyer, { documentId: doc.id, rows })
    const tValidate = Date.now() - t0
    assert.equal(result.state, 'validated')
    assert.equal(result.process_count, 5940)
    const tm = sum(expected.filter((e) => !e.dm).map((e) => e.K))
    const tw = sum(expected.map((e) => e.M))
    assert.equal(result.total_material, fixed(tm))
    assert.equal(result.total_work, fixed(tw))
    assert.equal(result.total, fixed(add(tm, tw)))

    const t1 = Date.now()
    rpc(db, lawyer, 'psdc_apply', q(id))
    const tApply = Date.now() - t1
    const t2 = Date.now()
    assert.equal(rowsOf(id).length, 6000)
    const tRows = Date.now() - t2
    console.log(`    большой файл: загрузка+проверка ${tValidate} мс, применение ${tApply} мс, чтение строк ${tRows} мс`)
    assert.ok(tApply < 20000)
  })
})
