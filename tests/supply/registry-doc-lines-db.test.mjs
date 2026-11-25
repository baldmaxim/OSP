// Реестр расценок → «Расценки от снабжения СУ-10»: строки счетов и КП, загруженных в тендер (миграция
// 20270306_supply_registry_doc_lines, просьба пользователя 25.11.2026). Копия прода как база Яндекса (одна учётка, migrate.sh с
// проверкой прав и .check.sql): файлы, загруженные до миграции, попадают в реестр при миграции; строки — те же, что читает
// браузер (readOffer: те же строки и цены, в том числе документ «из двух частей» с НДС колонкой); новый файл, правка выбора и
// переименование — сразу; испорченные notes и сбой разбора не мешают работе с файлом; удалили файл — строки остаются с отметкой;
// повтор файла — в реестре один раз; статус «применена в тендере» — по документу позиции и следу удалённого файла; подрядчику и
// без входа — ничего; поиск и порядок — по индексу; откат и повторное применение. Нужны Docker, psql и проверенная копия прода.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { offerNotes, readOffer, unreadableOfferNotes } from '../../src/utils/supplyOffers.js'

const NAME = '20270306_supply_registry_doc_lines'
const Y_DIR = path.join(ROOT, 'migration', 'yandex')
const Y_MIGRATION = path.join(Y_DIR, `${NAME}.sql`)
const Y_CHECK = path.join(Y_DIR, `${NAME}.check.sql`)
const Y_ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  viewer: '00000000-0000-4000-8000-0000000f1b02',     // «Реестр расценок»: просмотр
  contractor: '00000000-0000-4000-8000-0000000f1b03',
}
const CP = '00000000-0000-4000-8000-0000000f2b01'
const OBJ = '00000000-0000-4000-8000-0000000f3b01'
const T = '00000000-0000-4000-8000-0000000f4b01'
const DOC = { early: '00000000-0000-4000-8000-0000000f5b01', mixed: '00000000-0000-4000-8000-0000000f5b02',
  usd: '00000000-0000-4000-8000-0000000f5b03', scan: '00000000-0000-4000-8000-0000000f5b04', late: '00000000-0000-4000-8000-0000000f5b05',
  twin: '00000000-0000-4000-8000-0000000f5b06', orphan: '00000000-0000-4000-8000-0000000f5b07' }
const COLUMNS = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id,'
  + 'contractor_label,doc_number,order_number,source_file,invoice_url,object_label,tender_label,row_no,doc_id,doc_deleted_at'

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const SEED = `
  insert into public.roles (key, label, is_system) values ('dl_viewer', 'Тест: реестр, просмотр', false) on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values ('dl_viewer', 'rates_registry', true, false) on conflict do nothing;
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Подрядчик счетов');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
    ('${U.viewer}', 'dl_viewer', true, false, 'Смотров С. С.', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Счётный 7', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status) values ('${T}', 'ЭОМ корпус 1', '${OBJ}', 'Идет тендерная процедура');`

// Счета так, как их сохраняет окно «Счета и КП тендера» (utils/supplyOffers.offerNotes).
const NOTES = {
  early: offerNotes({ source: 'pdf', vat: { mode: 'gross', rate: null }, date: '2026-11-20', lines: [
    { name: 'Кабель ВВГнг(А)-LS 3х2,5', unit: 'м', qty: 100, code: 'ВВГ-325', price: 95.5 },
    { name: 'Строка без цены', unit: 'шт', price: null },
    { name: 'Розетка двойная', unit: 'шт', qty: 3, price: 230 },
    { name: 'Автомат 1P 16A (скан)', unit: 'шт', price: 410, unsure: true, packQty: 12 },
  ] }),
  // Документ из двух частей (прайс без НДС + таблица «с НДС»), переключатель «без НДС» умножил все строки — как «…_MLN.pdf» № 704.
  mixed: offerNotes({ source: 'pdf', vat: { mode: 'net', rate: 22 }, date: '2054-10-03', lines: [
    { name: 'Лоток 100х50 (прайс)', unit: 'м', price: 1634.8, docPrice: 1340 },
    { name: 'Лоток 200х50 (таблица с НДС)', unit: 'м', price: 2058.75, docPrice: 1687.5, docVat: 'gross' },
    { name: 'Крышка лотка (таблица без НДС)', unit: 'шт', price: 1220, docPrice: 1000, docVat: 'net' },
  ] }),
  usd: offerNotes({ source: 'sheet', currency: 'USD', lines: [{ name: 'Светильник импортный', unit: 'шт', price: 120 }] }),
  scan: unreadableOfferNotes('scan'),
}
const browserLines = (notes) => {
  const o = readOffer(notes)
  return !o || o.currency ? [] : o.lines.map((l) => [l.name, l.unit, l.qty, l.code, Math.round(l.price * 100) / 100])
}

describe('Реестр СУ-10: строки счетов и КП тендеров — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const migrate = (dir) => {
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 25 * 60 * 1000,
      env: { ...process.env, OSP_MIGRATIONS_DIR: dir, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'),
        PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    return res.stdout
  }
  const addDoc = (id, notes, { name = `${id.slice(-4)}.pdf`, at = '2026-11-25 10:00+03', owner = T } = {}) => internal(`
    insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, mime_type, size_bytes, notes, doc_category, created_at)
    values ('${id}', 'tender', '${owner}', 'tenders/${owner}/${id}.pdf', ${q(name)}, 'application/pdf', 1024, ${notes == null ? 'null' : q(notes)},
            'supply_doc', '${at}')`)
  const dbLines = (doc) => JSON.parse(internal(`select coalesce(json_agg(json_build_array(item_name, unit, qty, code, price) order by line_no), '[]')
    from osp_private.supply_doc_rates where doc_id = '${doc}' and doc_deleted_at is null`))
  const registry = (where) => as(U.viewer, `select count(*) from public.supply_rates_registry where source_type = 'supply_doc' and ${where}`)
  const status = (doc) => as(U.viewer, `select coalesce(string_agg(r.item_name || '=' || s.applied, ' ; ' order by r.line_no), '-')
    from public.supply_doc_rates_status((select array_agg(reg_id) from osp_private.supply_doc_rates where doc_id = '${doc}')) s
    join osp_private.supply_doc_rates r on r.reg_id = s.id`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-supply-doc-lines-'))
    // Сначала — всё до 20270306: счета загружены раньше (как на проде до выкладки).
    const before = path.join(tmp, 'yandex-before')
    fs.mkdirSync(before)
    for (const f of fs.readdirSync(Y_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith(NAME))) {
      fs.copyFileSync(path.join(Y_DIR, f), path.join(before, f))
    }
    db = startSingleOwner(latestVerifiedCopy())
    migrate(before)
    internal(SEED)
    addDoc(DOC.early, NOTES.early, { name: 'Счёт 101 от 20.11.2026.pdf', at: '2026-11-21 09:00+03' })
    addDoc(DOC.mixed, NOTES.mixed, { name: 'Прайс и таблица.pdf' })
    addDoc(DOC.usd, NOTES.usd)
    addDoc(DOC.scan, NOTES.scan)
    // Теперь — 20270306 настоящим migrate.sh: заполнение, проверка прав и .check.sql в транзакции.
    assert.match(migrate(Y_DIR), new RegExp(`OK ${NAME}: применена`))
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('счета, загруженные раньше, — в реестре при миграции; строки и цены — как в браузере', () => {
    for (const k of ['early', 'mixed', 'usd', 'scan']) assert.deepEqual(dbLines(DOC[k]), browserLines(NOTES[k]), k)
    assert.deepEqual(dbLines(DOC.mixed).map((l) => l[4]), [1634.8, 1687.5, 1220], 'цена «с НДС» колонкой — по колонке')
    assert.equal(registry(`doc_id = '${DOC.early}'`), '3')
    assert.equal(as(U.viewer, `select string_agg(distinct concat_ws('|', source_name, object_name, tender_desc, source_file,
      (rate_date at time zone 'Europe/Moscow')::date), ' ; ') from public.supply_rates_registry where doc_id = '${DOC.early}'`),
    'Счёт / КП|ЖК Счётный 7|ЭОМ корпус 1|Счёт 101 от 20.11.2026.pdf|2026-11-20')
    assert.equal(as(U.viewer, `select string_agg(distinct (rate_date at time zone 'Europe/Moscow')::date::text, ',')
      from public.supply_rates_registry where doc_id = '${DOC.mixed}'`), '2026-11-25', 'дата из будущего — день загрузки')
    assert.equal(internal(`select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'supply_rates_registry'`), COLUMNS)
  })

  it('новый файл и правка выбора — сразу; испорченные notes и файл без тендера — работа с файлом не прерывается', () => {
    addDoc(DOC.late, NOTES.early.replace('Розетка двойная', 'Розетка одинарная'), { name: 'Счёт 102.pdf' })
    assert.equal(registry(`doc_id = '${DOC.late}' and item_name = 'Розетка одинарная'`), '1')
    const ids = internal(`select string_agg(reg_id, ',' order by line_no) from osp_private.supply_doc_rates where doc_id = '${DOC.late}'`)
    internal(`update public.s3_documents set notes = '{"kind":"supply_offer", "v": 1, "lines": [' where id = '${DOC.late}'`)
    assert.equal(registry(`doc_id = '${DOC.late}'`), '0', 'файл есть, строк нет — нет и в реестре')
    internal(`update public.s3_documents set notes = ${q(NOTES.early)} where id = '${DOC.late}'`)
    assert.equal(internal(`select string_agg(reg_id, ',' order by line_no) from osp_private.supply_doc_rates where doc_id = '${DOC.late}'`), ids,
      'id строк в реестре — прежние')
    internal(`update public.s3_documents set file_name = 'Счёт 102 (исправлен).pdf' where id = '${DOC.late}'`)
    assert.equal(internal(`select string_agg(distinct file_name, ',') from osp_private.supply_doc_rates where doc_id = '${DOC.late}'`),
      'Счёт 102 (исправлен).pdf')
    // Владелец — не тендер портала: строк нет, файл записан.
    assert.doesNotThrow(() => addDoc(DOC.orphan, NOTES.early, { owner: '00000000-0000-4000-8000-0000000f4bff' }))
  })

  it('та же строка в другом файле тендера — один раз; удалили файл — строки остаются, источник «удалён»', () => {
    // DOC.late — тот же счёт, загруженный позже: его строки в реестре не повторяются.
    assert.equal(registry(`item_name = 'Кабель ВВГнг(А)-LS 3х2,5'`), '1')
    internal(`delete from public.s3_documents where id = '${DOC.early}'`)
    assert.equal(registry(`item_name = 'Кабель ВВГнг(А)-LS 3х2,5' and doc_id = '${DOC.late}' and doc_deleted_at is null`), '1',
      'файл удалён — видна строка файла, который есть')
    internal(`delete from public.s3_documents where id = '${DOC.late}'`)
    assert.equal(registry(`item_name = 'Кабель ВВГнг(А)-LS 3х2,5' and doc_id = '${DOC.early}' and doc_deleted_at is not null`), '1',
      'оба удалены — строка загруженного раньше, отмечена удалённой')
    assert.equal(internal(`select count(*) from osp_private.supply_doc_rates where doc_id = '${DOC.early}' and doc_deleted_at is not null`), '3')
  })

  it('статус «применена в тендере»: цена позиции из файла (и с другим НДС) — да, ручная правка и из Excel — нет, след удалённого файла', () => {
    // Цена «за единицу», как её ставит страница (price_input unit, input_value → supply_price — триггер расчёта).
    const rate = internal(`insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value)
      values ('${T}', 'ВОР ЭОМ', 'Лоток перфорированный 100х50', 'м', 'unit', 1340) returning id`).split('\n')[0]
    // Файл — документ позиции (material_key у документа вычисляется по наименованию, как у цены).
    internal(`insert into public.tender_supply_links (tender_id, estimate_name, material_name, s3_document_id)
      values ('${T}', 'ВОР ЭОМ', 'Лоток перфорированный 100х50', '${DOC.mixed}')`)
    assert.equal(status(DOC.mixed), 'Лоток 100х50 (прайс)=true ; Лоток 200х50 (таблица с НДС)=false ; Крышка лотка (таблица без НДС)=false')
    internal(`update public.tender_vor_supply_rates set input_value = 1500 where id = '${rate}'`)
    assert.doesNotMatch(status(DOC.mixed), /=true/, 'цену поправили руками — не из файла')
    internal(`update public.tender_vor_supply_rates set price_input = 'import', supply_price = 1340 where id = '${rate}'`)
    assert.doesNotMatch(status(DOC.mixed), /=true/, 'цена из Excel — не из файла')
    internal(`update public.tender_vor_supply_rates set price_input = 'unit', input_value = 1340 where id = '${rate}';
      insert into public.tender_supply_removed_docs (tender_id, rate_id, doc_id, doc_name, price) values ('${T}', '${rate}', '${DOC.mixed}', 'Прайс и таблица.pdf', 1340);
      delete from public.s3_documents where id = '${DOC.mixed}'`)
    assert.match(status(DOC.mixed), /Лоток 100х50 \(прайс\)=true/, 'файл удалён, цена ещё стоит — по следу')
    assert.equal(as(U.contractor, `select count(*) from public.supply_doc_rates_status((select array_agg(reg_id) from osp_private.supply_doc_rates))`), '0')
    assert.equal(as(null, `select count(*) from public.supply_doc_rates_status((select array_agg(reg_id) from osp_private.supply_doc_rates))`), '0')
  })

  it('подрядчику и без входа строк нет; поиск и порядок по наименованию — по индексу; переименования — сразу', () => {
    assert.equal(as(U.contractor, `select count(*) from public.supply_rates_registry where source_type = 'supply_doc'`), '0')
    assert.equal(as(null, `select count(*) from public.supply_rates_registry`), '0')
    const plan = as(U.viewer, `set local enable_seqscan = off;
      explain select id from public.supply_rates_registry where item_name ilike '%лоток%' order by item_name, id limit 100`)
    assert.match(plan, /supply_doc_rates_name_(trgm|idx)/, plan)
    internal(`update public.objects set name = 'ЖК Счётный 7 (новое)' where id = '${OBJ}';
      update public.tenders set work_description = 'ЭОМ корпус 1 и 2' where id = '${T}'`)
    assert.equal(as(U.viewer, `select string_agg(distinct object_name || '|' || tender_desc, ' ; ') from public.supply_rates_registry
      where source_type = 'supply_doc'`), 'ЖК Счётный 7 (новое)|ЭОМ корпус 1 и 2')
  })

  it('сбой разбора и записи строк — загрузка, правка выбора и удаление файла всё равно проходят (транзакция, без следа)', () => {
    const X = '00000000-0000-4000-8000-0000000f5b09'
    // В одной транзакции: файл со строками; разбор начинает падать; строкам запрещено становиться «удалёнными»; откат в конце.
    const out = internal(`begin;
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, notes, doc_category)
        values ('${X}', 'tender', '${T}', 'tenders/x.pdf', 'x.pdf', ${q(NOTES.early)}, 'supply_doc');
      create or replace function osp_private.supply_doc_rates_sync(p_doc uuid) returns integer language plpgsql as
        $f$ begin raise exception 'сбой разбора (тест)'; end $f$;
      insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, notes, doc_category)
        values ('tender', '${T}', 'tenders/y.pdf', 'y.pdf', ${q(NOTES.early)}, 'supply_doc');
      update public.s3_documents set notes = ${q(NOTES.mixed)} where id = '${X}';
      alter table osp_private.supply_doc_rates add constraint test_no_delete check (doc_deleted_at is null) not valid;
      delete from public.s3_documents where id = '${X}';
      select 'файлов осталось: ' || count(*) from public.s3_documents where id = '${X}';
      rollback;`)
    assert.match(out, /файлов осталось: 0/)
    assert.equal(internal(`select count(*) from pg_constraint where conname = 'test_no_delete'`), '0')
    assert.match(internal(`select prosrc from pg_proc where proname = 'supply_doc_rates_sync'`), /supply_offer_lines/, 'функция прежняя')
  })

  it('аварийный откат: 20 колонок, строк счетов нет; повторно 20270306 — строки снова, удалённые после отката — с отметкой', () => {
    addDoc(DOC.twin, NOTES.early, { name: 'Счёт 103.pdf' })
    db.sql(null, { file: Y_ROLLBACK, appName: 'osp-test' })
    db.sql(null, { file: Y_ROLLBACK, appName: 'osp-test' })
    assert.equal(internal(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_rates_registry'`), '20')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where source_type = 'supply_doc'`), '0')
    internal(`delete from public.s3_documents where id = '${DOC.twin}'`)
    const again = path.join(tmp, 'again.sql')
    fs.writeFileSync(again, `begin;\nset local application_name = 'osp:internal';\n\\i ${Y_MIGRATION}\ncommit;\n`)
    db.sql(null, { file: again, appName: 'osp:internal' })
    assert.doesNotMatch(db.sql(null, { file: Y_CHECK, appName: 'osp:internal' }), /^FAIL/m)
    assert.equal(internal(`select count(*) from osp_private.supply_doc_rates where doc_id = '${DOC.twin}' and doc_deleted_at is not null`), '3')
  })
})

it('файлы миграции, проверки и отката есть', () => {
  for (const f of [Y_MIGRATION, Y_CHECK, Y_ROLLBACK]) assert.ok(fs.existsSync(f), f)
})
