// Реестр расценок → «Расценки от подрядчиков (КП)» (миграция 20261122_kp_registry_manual_sources) на слепке схемы
// прода: расценки, добавленные вручную, видны в реестре сразу (без пересчёта) с подрядчиком, объектом тендера и
// документом; права (добавляет и меняет право правки реестра, читает читатель реестра, подрядчику и гостю —
// ничего); кто и когда — триггером; документ — адрес или файл, не оба; у строк КП — ВОР и файл КП, сохранённый вместе
// с ценами; поиск похожих для проверки файла; проверка для прода до миграции — FAIL, а не ошибка; откат не трогает
// ручные расценки. Нужны Docker и psql.
// Второй блок — то же на копии прода, загруженной как база Яндекса (одна учётка, migration/yandex через migrate.sh):
// там ручные строки представления читают через функцию закрытой схемы; нужна проверенная копия прода.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20261122_kp_registry_manual_sources'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261122.sql')
const PREV_CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261103.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  editor: '00000000-0000-4000-8000-0000000d1a01',     // «Реестр расценок»: правка
  viewer: '00000000-0000-4000-8000-0000000d1a02',     // «Реестр расценок»: просмотр
  contractor: '00000000-0000-4000-8000-0000000d1a03',
}
const CP = '00000000-0000-4000-8000-0000000d2a01'
const CP2 = '00000000-0000-4000-8000-0000000d2a02'
const OBJ = '00000000-0000-4000-8000-0000000d3a01'
const T = '00000000-0000-4000-8000-0000000d4a01'
const ITEM = '00000000-0000-4000-8000-0000000d5a01'
const ITEM2 = '00000000-0000-4000-8000-0000000d5a02'
const DOC = '00000000-0000-4000-8000-0000000d6a01'
const DOC_LATE = '00000000-0000-4000-8000-0000000d6a02'
const DOC_MANUAL = '00000000-0000-4000-8000-0000000d6a03'

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

describe('Реестр КП: ручные расценки и документ-источник — база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const registry = (uid, where = 'true') => JSON.parse(as(uid,
    `select coalesce(json_agg(r order by r.source_kind, r.item_name), '[]') from public.kp_rates_registry r where ${where}`))
  const manual = (uid, fields) => as(uid, `insert into public.kp_manual_rates (item_type, item_name, unit, price, counterparty_id, tender_id, object_id, doc_url, s3_document_id, note)
    values (${q(fields.item_type || 'material')}, ${q(fields.item_name)}, ${fields.unit ? q(fields.unit) : 'null'}, ${fields.price},
      ${q(fields.counterparty_id || CP)}, ${fields.tender_id ? q(fields.tender_id) : 'null'}, ${fields.object_id ? q(fields.object_id) : 'null'},
      ${fields.doc_url ? q(fields.doc_url) : 'null'}, ${fields.s3_document_id ? q(fields.s3_document_id) : 'null'}, ${fields.note ? q(fields.note) : 'null'})
    returning id`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(`
      insert into public.roles (key, label, is_system) values ('km_editor', 'Тест: реестр, правка', false), ('km_viewer', 'Тест: реестр, просмотр', false)
        on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('km_editor', 'rates_registry', true, true), ('km_viewer', 'rates_registry', true, false);
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Ручная расценка'), ('${CP2}', 'ООО Поздний файл');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.editor}', 'km_editor', true, false, 'Реестров Р. Р.', null),
        ('${U.viewer}', 'km_viewer', true, false, 'Смотров С. С.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Ручной', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
        ('${T}', 'Электромонтаж корпуса 1', '${OBJ}', 'Идет тендерная процедура', 9960);
      insert into public.tender_estimate_items (id, tender_id, row_number, code, cost_name, unit, work_volume, material_consumption, estimate_name) values
        ('${ITEM}', '${T}', 1, 'мат.', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 0, 500, 'ВОР ЭОМ'),
        ('${ITEM2}', '${T}', 2, 'Р', 'Прокладка кабеля', 'м', 500, 0, 'ВОР ЭОМ');
      -- КП из окна загрузки: цены, через секунды — файл КП того же подрядчика. Второй подрядчик — файл через 2 часа.
      insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials, unit_price_works, proposal_date, created_at) values
        ('${T}', '${CP}', '${ITEM}', 120, 0, '2026-10-01', '2026-10-01 10:00:00+00'),
        ('${T}', '${CP}', '${ITEM2}', 0, 45, '2026-10-01', '2026-10-01 10:00:00+00'),
        ('${T}', '${CP2}', '${ITEM}', 130, 0, '2026-10-01', '2026-10-01 10:00:00+00');
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, created_at) values
        ('${DOC}', 'tender', '${T}', 'tenders/t/kp.xlsx', 'КП ООО Ручная расценка.xlsx', '2026-10-01 10:00:04+00'),
        ('${DOC_LATE}', 'tender', '${T}', 'tenders/t/late.xlsx', 'КП позже.xlsx', '2026-10-01 12:00:00+00'),
        ('${DOC_MANUAL}', 'general', '${T}', 'general/m/doc.pdf', 'Прайс подрядчика.pdf', now());
      insert into public.tender_proposal_files (tender_id, counterparty_id, s3_document_id, file_kind, proposal_group_id, created_at) values
        ('${T}', '${CP}', '${DOC}', 'commercial_proposal', gen_random_uuid(), '2026-10-01 10:00:04+00'),
        ('${T}', '${CP2}', '${DOC_LATE}', 'commercial_proposal', gen_random_uuid(), '2026-10-01 12:00:00+00');`)
    psqlAt(db.port, null, { file: MIGRATION })
    sql('refresh materialized view public.kp_rates_registry_mv')
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется; прежняя проверка — OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 6)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
    assert.doesNotMatch(psqlAt(db.port, null, { file: PREV_CHECK }), /^FAIL/m)
  })

  it('строки КП: ВОР позиции и файл КП, сохранённый вместе с ценами; файл через 2 часа — не тот', () => {
    const rows = registry(U.viewer, `tender_id = '${T}'`)
    const mine = rows.filter((r) => r.counterparty_id === CP)
    assert.deepEqual(mine.map((r) => [r.item_type, r.source_kind, r.estimate_name, r.source_doc_id, r.source_doc_name]), [
      ['material', 'kp', 'ВОР ЭОМ', DOC, 'КП ООО Ручная расценка.xlsx'],
      ['work', 'kp', 'ВОР ЭОМ', DOC, 'КП ООО Ручная расценка.xlsx'],
    ])
    const late = rows.find((r) => r.counterparty_id === CP2)
    assert.equal(late.estimate_name, 'ВОР ЭОМ')
    assert.equal(late.source_doc_id, null)
    assert.ok(mine.every((r) => r.manual_id === null && r.source_url === null))
  })

  it('ручная расценка — в реестре сразу, без пересчёта: подрядчик, объект тендера, документ, кто добавил', () => {
    const id = manual(U.editor, { item_name: '  Кабель   ВВГнг(А)-LS 3х2,5 ', unit: 'м', price: 135.5, tender_id: T, s3_document_id: DOC_MANUAL, note: 'цена до 31.12' })
    const [r] = registry(U.viewer, `manual_id = '${id}'`)
    assert.equal(r.source_kind, 'manual')
    assert.equal(r.item_name, 'Кабель ВВГнг(А)-LS 3х2,5', 'лишние пробелы убраны')
    assert.equal(Number(r.price), 135.5)
    assert.equal(r.counterparty_name, 'ООО Ручная расценка')
    assert.equal(r.object_id, OBJ, 'объект — объект тендера')
    assert.equal(r.object_name, 'ЖК Ручной')
    assert.equal(r.tender_desc, 'Электромонтаж корпуса 1')
    assert.equal(r.source_doc_name, 'Прайс подрядчика.pdf')
    assert.equal(r.note, 'цена до 31.12')
    assert.equal(r.proposal_date, sql(`select (now() at time zone 'Europe/Moscow')::date`))
    assert.equal(sql(`select created_by_name from public.kp_manual_rates where id = '${id}'`), 'Реестров Р. Р.')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_counterparties where counterparty_id = '${CP}'`), '1')
    // Подрядчик без КП — в фильтре сразу, вместе со своей ручной расценкой; ед. изм. — в списке единиц.
    sql(`insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-0000000d2a09', 'ООО Только вручную')`)
    manual(U.editor, { item_name: 'Монтаж лотка', item_type: 'work', unit: 'пог.м', price: 300, counterparty_id: '00000000-0000-4000-8000-0000000d2a09', object_id: OBJ })
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_counterparties where counterparty_name = 'ООО Только вручную'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_objects where object_id = '${OBJ}'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_units where unit = 'пог.м'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry where item_type = 'work' and source_kind = 'manual'`), '1')
  })

  it('права: правит право правки реестра; просмотр — только читает; подрядчику и гостю — ничего', () => {
    assert.throws(() => manual(U.viewer, { item_name: 'Песок', price: 900 }), /row-level security|permission denied/)
    assert.throws(() => manual(U.contractor, { item_name: 'Песок', price: 900 }), /row-level security|permission denied/)
    assert.equal(as(U.contractor, 'select count(*) from public.kp_manual_rates'), '0')
    assert.equal(as(U.contractor, `select count(*) from public.kp_rates_registry where source_kind = 'manual'`), '0')
    assert.throws(() => anon('select count(*) from public.kp_manual_rates'), /permission denied/)
    const id = manual(U.editor, { item_name: 'Песок карьерный', unit: 'м3', price: 900 })
    assert.equal(as(U.viewer, `update public.kp_manual_rates set price = 1 where id = '${id}' returning id`), '', 'просмотр не меняет')
    assert.equal(as(U.viewer, `delete from public.kp_manual_rates where id = '${id}' returning id`), '', 'просмотр не удаляет')
    // Правка: кто добавил и когда — прежние, кто изменил — вошедший; подменить нельзя.
    as(U.editor, `update public.kp_manual_rates set price = 950, created_by = '${U.viewer}', created_by_name = 'Чужой' where id = '${id}'`)
    assert.equal(sql(`select price || '|' || created_by || '|' || created_by_name || '|' || updated_by from public.kp_manual_rates where id = '${id}'`),
      `950.00|${U.editor}|Реестров Р. Р.|${U.editor}`)
    assert.equal(as(U.editor, `delete from public.kp_manual_rates where id = '${id}' returning id`), id)
  })

  it('документ — адрес http(s) или сетевой путь, либо файл, не оба; цена — больше нуля', () => {
    assert.ok(manual(U.editor, { item_name: 'Щебень', price: 1500, doc_url: 'https://disk.example.ru/kp.pdf' }))
    assert.ok(manual(U.editor, { item_name: 'Щебень 2', price: 1500, doc_url: '\\\\192.168.5.55\\share\\kp.pdf' }))
    assert.throws(() => manual(U.editor, { item_name: 'Щебень 3', price: 1500, doc_url: 'C:/kp.pdf' }), /check constraint/)
    assert.throws(() => manual(U.editor, { item_name: 'Щебень 4', price: 1500, doc_url: 'https://x.ru/a', s3_document_id: DOC_MANUAL }), /kp_manual_rates_one_doc/)
    assert.throws(() => manual(U.editor, { item_name: 'Щебень 5', price: 0 }), /check constraint/)
    // Файл удалён — у строки документа больше нет, сама строка остаётся.
    const id = manual(U.editor, { item_name: 'Гравий', price: 700, s3_document_id: DOC_MANUAL })
    sql(`delete from public.s3_documents where id = '${DOC_MANUAL}'`)
    assert.equal(sql(`select coalesce(s3_document_id::text, 'нет') from public.kp_manual_rates where id = '${id}'`), 'нет')
  })

  it('поиск похожих для проверки файла: по наименованию, лучшие первыми, с видом; только читателю реестра', () => {
    const rows = JSON.parse(as(U.viewer, `select json_agg(x order by x.idx, x.sim desc) from public.kp_rates_lookup(array['Кабель ВВГнг-LS 3х2,5', 'Прокладка кабеля в лотке', 'Абракадабра'], null) x`))
    const first = rows.filter((r) => r.idx === 1)
    assert.ok(first.length >= 3, 'КП обоих подрядчиков и ручная расценка')
    assert.ok(first.every((r) => r.item_name.startsWith('Кабель')))
    assert.ok(first.some((r) => r.source_kind === 'manual') && first.some((r) => r.source_kind === 'kp'))
    assert.ok(rows.some((r) => r.idx === 2 && r.item_type === 'work'))
    assert.ok(!rows.some((r) => r.idx === 3))
    const works = JSON.parse(as(U.viewer, `select coalesce(json_agg(x), '[]') from public.kp_rates_lookup(array['Кабель ВВГнг-LS 3х2,5'], 'work') x`))
    assert.deepEqual(works, [])
    assert.equal(as(U.contractor, `select count(*) from public.kp_rates_lookup(array['Кабель ВВГнг-LS 3х2,5'], null)`), '0')
    assert.throws(() => as(U.viewer, `select count(*) from public.kp_rates_lookup(array_fill('x'::text, array[301]), null)`), /не больше 300/)
    assert.throws(() => anon(`select count(*) from public.kp_rates_lookup(array['x'], null)`), /permission denied/)
  })

  it('страница реестра может читать материализованное по индексу и сливать с ручными строками (Merge Append)', () => {
    // Условие «читатель реестра» — один раз, над объединением: с условием в каждой части планировщик не сливал части и
    // сортировал весь вид расценки (на копии прода 15.10 — 33 мс вместо 1,7 мс на страницу).
    const def = sql(`select pg_get_viewdef('public.kp_rates_registry'::regclass)`)
    assert.match(def, /UNION ALL/)
    assert.equal(def.match(/osp_registry_reader\(\)/g).length, 1, def)
    // На маленьком слепке перебор дешевле индекса — запрещаем его, чтобы увидеть, что слить части план может.
    const plan = as(U.viewer, `set local enable_seqscan = off; set local enable_bitmapscan = off; set local enable_sort = off;
      explain (costs off) select id from public.kp_rates_registry where item_type = 'material' order by item_name, id limit 100`)
    assert.match(plan, /Merge Append/, plan)
    assert.match(plan, /Index (Only )?Scan using idx_kp_rates_mv_type_name/)
  })

  it('аварийный откат: реестр — как после 20261103, ручные расценки остаются в таблице; миграция ложится снова', () => {
    const manualCount = sql('select count(*) from public.kp_manual_rates')
    assert.ok(Number(manualCount) > 0)
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.doesNotMatch(psqlAt(db.port, null, { file: PREV_CHECK }), /^FAIL/m)
    assert.equal(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'kp_rates_registry' and column_name = 'source_kind'`), '0')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry where tender_id = '${T}'`), '3', 'только КП из файлов')
    assert.equal(sql('select count(*) from public.kp_manual_rates'), manualCount, 'ручные расценки не удалены')
    assert.throws(() => anon('select count(*) from public.kp_rates_registry'), /permission denied/, 'гостю реестр по-прежнему закрыт')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry where source_kind = 'manual'`), manualCount)
  })
})

describe('Реестр КП: ручные расценки — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-kp-manual-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(`
      insert into public.roles (key, label, is_system) values ('km_editor', 'Тест: реестр, правка', false), ('km_viewer', 'Тест: реестр, просмотр', false)
        on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('km_editor', 'rates_registry', true, true), ('km_viewer', 'rates_registry', true, false) on conflict do nothing;
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Ручная расценка');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.editor}', 'km_editor', true, false, 'Реестров Р. Р.', null),
        ('${U.viewer}', 'km_viewer', true, false, 'Смотров С. С.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Ручной', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status) values ('${T}', 'Электромонтаж корпуса 1', '${OBJ}', 'Идет тендерная процедура');`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('добавляет право правки реестра; строка сразу в реестре с подрядчиком и объектом тендера; в фильтрах', () => {
    const id = as(U.editor, `insert into public.kp_manual_rates (item_type, item_name, unit, price, counterparty_id, tender_id)
      values ('material', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 135.5, '${CP}', '${T}') returning id`)
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(internal(`select created_by_name from public.kp_manual_rates where id = '${id}'`), 'Реестров Р. Р.')
    assert.equal(as(U.viewer, `select source_kind || '|' || counterparty_name || '|' || object_name || '|' || tender_desc || '|' || price
      from public.kp_rates_registry where manual_id = '${id}'`), 'manual|ООО Ручная расценка|ЖК Ручной|Электромонтаж корпуса 1|135.50')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_counterparties where counterparty_id = '${CP}'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_objects where object_id = '${OBJ}'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.kp_rates_registry_filter_tenders where tender_id = '${T}'`), '1')
    assert.ok(Number(as(U.viewer, `select count(*) from public.kp_rates_lookup(array['Кабель ВВГнг-LS 3х2,5'], 'material') where manual_id = '${id}'`)) === 1)
  })

  it('просмотр и подрядчик не добавляют; подрядчику и без входа строк нет', () => {
    assert.throws(() => as(U.viewer, `insert into public.kp_manual_rates (item_type, item_name, price, counterparty_id) values ('material', 'Песок', 900, '${CP}')`),
      /row-level security/)
    assert.throws(() => as(U.contractor, `insert into public.kp_manual_rates (item_type, item_name, price, counterparty_id) values ('material', 'Песок', 900, '${CP}')`),
      /row-level security/)
    assert.equal(as(U.contractor, 'select count(*) from public.kp_manual_rates'), '0')
    assert.equal(as(U.contractor, `select count(*) from public.kp_rates_registry where source_kind = 'manual'`), '0')
    assert.equal(as(null, 'select count(*) from public.kp_rates_registry'), '0')
    assert.equal(as(null, 'select count(*) from public.kp_manual_rates'), '0')
  })

  it('строки КП копии прода — с ВОР, у большинства — файл КП', () => {
    const [n, vor, files] = as(U.viewer, `select count(*) || '|' || count(estimate_name) || '|' || count(source_doc_id)
      from public.kp_rates_registry where source_kind = 'kp'`).split('|').map(Number)
    assert.ok(n > 1000, `строк КП: ${n}`)
    assert.equal(vor, n, 'у каждой строки КП — ВОР')
    assert.ok(files / n > 0.8, `с файлом КП: ${files} из ${n}`)
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
