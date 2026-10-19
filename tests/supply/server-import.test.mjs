// Позиции ВОР для расценки — заранее, службой osp-api (server/osp-api/src/lib/supplyImport.js, миграция
// 20261024_supply_import_state) — на слепке схемы прода с настоящими миграциями 20261020/22/23/24, настоящим
// разборщиком в отдельном процессе и хранилищем-подделкой с настоящими книгами Excel. Проверяется: позиции те же,
// что даёт разбор страницы (один код), лист «Материалы» и лист ВОР по «КОД», вкладка «ВОР» без файлов, итог по
// тендеру (ok / no_vor / issues / locked / pending), неразборный файл не скачивается снова до новой версии,
// большой — не скачивается вовсе, бюджет прохода, пустой устаревший список убирается, повторный проход ничего
// не пишет, чужой список (браузер успел раньше) не перетирается. Нужны Docker, psql и зависимости сервера.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'
import { parseVorFileBytes } from '../../src/utils/vorMaterialsSheet.js'

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = skipReason() || (!fs.existsSync(path.join(SERVER, 'node_modules', 'pg')) && 'нет зависимостей: npm ci --prefix server/osp-api')

const OBJ = '00000000-0000-4000-8000-00000000d301'
const T = {
  files: '00000000-0000-4000-8000-00000000e301',   // файлы ВОР: «Материалы», лист ВОР по «КОД», битый, PDF
  tab: '00000000-0000-4000-8000-00000000e302',     // без файлов, вкладка «ВОР» с материалами
  none: '00000000-0000-4000-8000-00000000e303',    // ни файлов, ни вкладки
  locked: '00000000-0000-4000-8000-00000000e304',  // тендер на материалы «Завершён»
  big: '00000000-0000-4000-8000-00000000e305',     // файл больше предела
  noMat: '00000000-0000-4000-8000-00000000e306',   // основного без тендера на материалы — не берётся
}
const M = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.replace('e3', 'f3')]))
const DOC = {
  mat: '00000000-0000-4000-8000-00000000a301',
  code: '00000000-0000-4000-8000-00000000a302',
  broken: '00000000-0000-4000-8000-00000000a303',
  pdf: '00000000-0000-4000-8000-00000000a304',
  locked: '00000000-0000-4000-8000-00000000a305',
  big: '00000000-0000-4000-8000-00000000a306',
}

const book = (sheets) => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
const MATERIALS = book({
  КП: [['Наименование', 'Цена']],
  Материалы: [['МАТЕРИАЛЫ'], ['№', 'Наименование', 'Ед. изм.', 'Объём', 'Цена с доставкой и НДС', 'Итого'],
    [1, 2, 3, 4, 5, 6], [1, 'Труба стальная Ø57×3,5', 'м', 120, null, null], [2, 'Отвод 90° 57х3,5', 'шт', 8, null, null],
    [3, 'Труба стальная Ø57×3,5', 'м', 30, null, null]],
})
// Начало архива zip, дальше мусор — книга не читается (причина «broken», как у страницы).
const BROKEN = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 200 }, (_, i) => (i * 37) % 256)])
const BIG = new Uint8Array(300000)
const CODE = book({
  'ВОР ВК': [['№', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход'],
    [1, 'Р', 'Монтаж трубопровода', 'м', 150, null], [2, 'мат.', 'Кран шаровой Ду15', 'шт', null, 48],
    [3, 'мат', 'Фильтр сетчатый Ду50', 'шт', null, 2]],
})

describe('Позиции ВОР — заранее, службой osp-api', { skip, timeout: 600000 }, () => {
  let db
  let pg
  let createSupplyImport
  let parseInChild
  const store = new Map()
  const calls = []
  const sql = (text) => psqlAt(db.port, text)
  const s3 = {
    async send(cmd) {
      const kind = cmd.constructor.name
      calls.push(`${kind}:${cmd.input.Key}`)
      const bytes = store.get(cmd.input.Key)
      if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
      if (kind === 'HeadObjectCommand') return { ContentLength: bytes.length }
      return { Body: { transformToByteArray: async () => bytes } }
    },
  }
  const log = { info() {}, warn() {} }
  const job = (options = {}) => createSupplyImport({ db: pg, s3, bucket: 'osp', log, options: { maxFilesPerRun: 40, ...options } })
  const state = (t) => JSON.parse(sql(`select row_to_json(s) from public.tender_supply_import_state s where tender_id = '${t}'`) || 'null')
  const sources = (t) => JSON.parse(sql(`select coalesce(json_agg(s order by estimate_name), '[]') from public.tender_supply_sources s where tender_id = '${t}'`))
  const strip = (positions) => positions.map(({ k, ...p }) => p)
  const doc = (id, tender, name, key) => `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category)
    values ('${id}', 'tender', '${tender}', '${key}', '${name}', 'vor_statement');`

  before(async () => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of ['20261020_supply_pricing', '20261022_supply_links', '20261023_supply_rate_reuse', '20261024_supply_import_state']) {
      if (!candidateMigrations().includes(`${m}.sql`)) psqlAt(db.port, null, { file: path.join(MIGRATIONS, `${m}.sql`) })
    }
    ;({ createSupplyImport, parseInChild } = await import(path.join(SERVER, 'src', 'lib', 'supplyImport.js')))
    const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
    pg = createDb({ url: `postgres://postgres@127.0.0.1:${db.port}/postgres`, max: 2 })
    sql(`
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Разбор', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ${Object.values(T).map((t) => `('${t}', 'ОВ', '${OBJ}', 'Идет тендерная процедура')`).join(', ')};
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ${Object.entries(M).filter(([k]) => k !== 'noMat').map(([k, m]) => `('${m}', 'ОВ', '${OBJ}', '${k === 'locked' ? 'Завершён' : 'В работе'}', 'materials', '${T[k]}')`).join(', ')};
      ${doc(DOC.mat, T.files, 'ВОР_ОВ.xlsx', 'k/mat.xlsx')}
      ${doc(DOC.code, T.files, 'ВОР_ВК.xlsx', 'k/code.xlsx')}
      ${doc(DOC.broken, T.files, 'ВОР_ЭОМ.xlsx', 'k/broken.xlsx')}
      ${doc(DOC.pdf, T.files, 'РД_ОВ.pdf', 'k/rd.pdf')}
      ${doc(DOC.locked, T.locked, 'ВОР_ОВ.xlsx', 'k/locked.xlsx')}
      ${doc(DOC.big, T.big, 'ВОР_большой.xlsx', 'k/big.xlsx')}
      insert into public.tender_estimate_items (tender_id, row_number, estimate_name, code, cost_name, unit, material_consumption, is_section) values
        ('${T.tab}', 1, 'Корпус 1', null, 'Раздел 1', null, null, true),
        ('${T.tab}', 2, 'Корпус 1', 'Р', 'Прокладка кабеля', 'м', null, false),
        ('${T.tab}', 3, 'Корпус 1', 'мат.', 'Кабель ВВГнг 3×2,5', 'м', 4000, false),
        ('${T.tab}', 4, 'Корпус 1', 'мат.', 'Щит ЩРН-12', 'шт', 3, false),
        ('${T.files}', 1, 'ВОР_ОВ', 'мат.', 'Из вкладки', 'шт', 1, false);`)
    store.set('k/mat.xlsx', MATERIALS)
    store.set('k/code.xlsx', CODE)
    store.set('k/broken.xlsx', BROKEN)
    store.set('k/locked.xlsx', MATERIALS)
    store.set('k/big.xlsx', BIG)
  })
  after(async () => {
    await pg?.close()
    db?.stop()
  })

  it('разборщик в отдельном процессе даёт то же, что разбор страницы; долгий — снимается по таймауту', async () => {
    const got = await parseInChild(MATERIALS, null)
    assert.deepEqual(got, parseVorFileBytes(MATERIALS))
    assert.equal(got.positions.length, 2, 'одинаковые наименования сложены')
    assert.deepEqual(await parseInChild(BROKEN, null), parseVorFileBytes(BROKEN))
    assert.equal(parseVorFileBytes(BROKEN).error, 'broken')
    assert.equal((await parseInChild(MATERIALS, null, { timeoutMs: 1 })).error, 'timeout')
  })

  it('проход: файлы — лист «Материалы» и лист ВОР по «КОД», без файлов — вкладка «ВОР»; итог по каждому тендеру', async () => {
    const stats = await job({ maxFileBytes: 100000 }).runOnce()
    assert.equal(stats.errors, 0, JSON.stringify(stats))

    const fs1 = sources(T.files)
    assert.deepEqual(fs1.map((s) => [s.estimate_name, s.source, s.s3_document_id]),
      [['ВОР_ВК', 'vor_file', DOC.code], ['ВОР_ОВ', 'vor_file', DOC.mat]])
    const ov = fs1.find((s) => s.s3_document_id === DOC.mat)
    assert.deepEqual(strip(ov.positions), parseVorFileBytes(MATERIALS).positions, 'позиции — как у страницы')
    assert.equal(ov.sheet_name, 'Материалы')
    assert.equal(ov.parsed_by, null, 'загружено службой — без пользователя')
    assert.equal(ov.source_version, sql(`select 'file:' || id || ':' || (to_json(created_at) #>> '{}') from public.s3_documents where id = '${DOC.mat}'`),
      'версия файла — как у страницы (время в виде PostgREST)')
    const vk = fs1.find((s) => s.s3_document_id === DOC.code)
    assert.deepEqual(strip(vk.positions).map((p) => [p.name, p.unit, p.volume]), [['Кран шаровой Ду15', 'шт', 48], ['Фильтр сетчатый Ду50', 'шт', 2]])
    assert.equal(vk.column_map.mode, 'code')

    const st = state(T.files)
    assert.equal(st.status, 'ok')
    assert.equal(st.positions_count, 4)
    assert.deepEqual(st.issues.map((i) => [i.doc_id, i.kind]), [[DOC.broken, 'broken']], 'PDF не берётся, битый — причина')

    const tab = sources(T.tab)
    assert.deepEqual(tab.map((s) => [s.estimate_name, s.source]), [['Корпус 1', 'vor_tab']])
    // Порядок — по строкам вкладки (id), как у страницы.
    assert.deepEqual(strip(tab[0].positions).map((p) => p.name).sort(), ['Кабель ВВГнг 3×2,5', 'Щит ЩРН-12'])
    assert.match(tab[0].source_version, /^vor2:4:/)
    assert.equal(state(T.tab).status, 'ok')

    assert.equal(state(T.none).status, 'no_vor')
    assert.deepEqual(sources(T.none), [])
    assert.equal(state(T.locked).status, 'locked', 'завершён — позиции не загружаются')
    assert.deepEqual(sources(T.locked), [])
    assert.deepEqual(state(T.big).issues.map((i) => i.kind), ['too_large'])
    assert.ok(!calls.includes('GetObjectCommand:k/big.xlsx'), 'большой файл не скачивается')
    assert.equal(state(T.noMat), null, 'тендер без тендера на материалы не смотрим')
  })

  it('файла нет в хранилище — причина «missing» до новой версии, предел прохода он не съедает', async () => {
    const T3 = '00000000-0000-4000-8000-00000000e308'
    const D3 = '00000000-0000-4000-8000-00000000a309'
    sql(`insert into public.tenders (id, work_description, object_id, status) values ('${T3}', 'ЭОМ', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id)
        values ('${T3.replace('e3', 'f3')}', 'ЭОМ', '${OBJ}', 'В работе', 'materials', '${T3}');
      ${doc(D3, T3, 'ВОР_нет.xlsx', 'k/gone.xlsx')}`)
    await job().runOnce()
    assert.deepEqual(state(T3).issues.map((i) => i.kind), ['missing'])
    calls.length = 0
    await job().runOnce()
    assert.ok(!calls.some((c) => c.endsWith('k/gone.xlsx')), 'второй раз не спрашиваем')
  })

  it('повторный проход ничего не пишет и не скачивает: неразборный и большой файл — до новой версии', async () => {
    const before = sql(`select string_agg(tender_id || ':' || checked_at, ',' order by tender_id) from public.tender_supply_import_state`)
    const versions = sql(`select string_agg(id || ':' || row_version, ',' order by id) from public.tender_supply_sources`)
    calls.length = 0
    const stats = await job({ maxFileBytes: 100000 }).runOnce()
    assert.deepEqual([stats.imported, stats.failed, stats.states, stats.errors], [0, 0, 0, 0], JSON.stringify(stats))
    assert.deepEqual(calls.filter((c) => c.startsWith('GetObject')), [])
    assert.equal(sql(`select string_agg(tender_id || ':' || checked_at, ',' order by tender_id) from public.tender_supply_import_state`), before)
    assert.equal(sql(`select string_agg(id || ':' || row_version, ',' order by id) from public.tender_supply_sources`), versions)

    // Новая версия битого файла (заменили в «ВОРах и РД») — разбирается снова.
    sql(`update public.s3_documents set created_at = now() where id = '${DOC.broken}'`)
    store.set('k/broken.xlsx', CODE)
    await job().runOnce()
    assert.ok(calls.includes('GetObjectCommand:k/broken.xlsx'))
    assert.deepEqual(state(T.files).issues, [])
    assert.ok(sources(T.files).some((s) => s.s3_document_id === DOC.broken))
  })

  it('бюджет прохода: не успели — «pending», следующий проход догоняет; чужой список не перетирается', async () => {
    const T2 = '00000000-0000-4000-8000-00000000e307'
    const D2 = ['00000000-0000-4000-8000-00000000a307', '00000000-0000-4000-8000-00000000a308']
    sql(`insert into public.tenders (id, work_description, object_id, status) values ('${T2}', 'ВК', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id)
        values ('${T2.replace('e3', 'f3')}', 'ВК', '${OBJ}', 'В работе', 'materials', '${T2}');
      ${doc(D2[0], T2, 'ВОР_1.xlsx', 'k/b1.xlsx')} ${doc(D2[1], T2, 'ВОР_2.xlsx', 'k/b2.xlsx')}`)
    store.set('k/b1.xlsx', MATERIALS)
    store.set('k/b2.xlsx', CODE)
    await job({ maxFilesPerRun: 1 }).runOnce()
    assert.equal(sources(T2).length, 1)
    // Пока служба ждала, второй файл загрузила страница (другая версия списка) — служба его не трогает.
    const name = sources(T2)[0].estimate_name === 'ВОР_1' ? 'ВОР_2' : 'ВОР_1'
    sql(`insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, source_version, positions)
      select '${T2}', '${name}', 'vor_file', d.id, d.file_name, 'file:' || d.id || ':' || (to_json(d.created_at) #>> '{}'), '[{"name":"Из браузера","unit":"шт","volume":1}]'
      from public.s3_documents d where d.file_name = '${name}.xlsx'`)
    await job({ maxFilesPerRun: 1 }).runOnce()
    const list = sources(T2)
    assert.equal(list.length, 2)
    assert.deepEqual(strip(list.find((s) => s.estimate_name === name).positions).map((p) => p.name), ['Из браузера'])
    assert.equal(state(T2).status, 'ok')
  })

  it('появились файлы — пустой список из вкладки «ВОР» убирается; с ценами — остаётся', async () => {
    sql(`insert into public.tender_supply_sources (tender_id, estimate_name, source, source_version, positions)
      values ('${T.files}', 'Из вкладки', 'vor_tab', 'vor2:1:x', '[{"name":"Из вкладки","unit":"шт","volume":1}]'),
             ('${T.files}', 'С ценой', 'vor_tab', 'vor2:1:x', '[{"name":"Позиция с ценой","unit":"шт","volume":1}]');
      insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price)
      values ('${T.files}', 'С ценой', 'Позиция с ценой', 'шт', 100);`)
    await job().runOnce()
    const names = sources(T.files).map((s) => s.estimate_name)
    assert.ok(!names.includes('Из вкладки'))
    assert.ok(names.includes('С ценой'))
  })

  it('настройка: OSP_SUPPLY_IMPORT=1 без базы или хранилища — служба не запускается', async () => {
    const { parseSupplyImport } = await import(path.join(SERVER, 'src', 'config.js'))
    assert.equal(parseSupplyImport({}), false)
    assert.throws(() => parseSupplyImport({ OSP_SUPPLY_IMPORT: '1', S3_ENDPOINT: 'x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' }), /OSP_DB_URL/)
    assert.throws(() => parseSupplyImport({ OSP_SUPPLY_IMPORT: '1', OSP_DB_URL: 'postgres://x' }), /хранилище/)
    assert.equal(parseSupplyImport({ OSP_SUPPLY_IMPORT: '1', OSP_DB_URL: 'postgres://x', S3_ENDPOINT: 'x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's' }), true)
  })
})
