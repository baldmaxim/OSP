// Реестр расценок → «Расценки от снабжения СУ-10»: подробности загруженной расценки, колонка «Документ» и поиск по индексу
// (миграция 20270227_supply_registry_rate_details, просьба пользователя 23.11.2026).
// Первый блок — слепок схемы прода (Supabase): новые поля строки (подрядчик по папке, № документа, № заявки / заказа,
// файл-источник, ссылка на счёт) пишутся функцией загрузки и видны в реестре в конце колонок; ссылка — только http/https
// (иначе пусто, строка пишется); длинное обрезается; прежние строки целы; права прежние; поиск может идти по индексу;
// откат возвращает 12 колонок и оставляет данные; миграция ложится снова.
// Второй блок — копия прода как база Яндекса (одна учётка, migrate.sh с проверкой прав): строки, загруженные до 20270227,
// переезжают в закрытую схему с прежними id и временем загрузки; поиск и порядок — по индексу закрытой таблицы;
// переименование объекта и тендера — сразу в реестре, удаление объекта — снова название из файла; подрядчику и без входа
// ничего; откат возвращает строки в прежнюю таблицу, повторное применение сливает их обратно. Нужны Docker и psql (второй
// блок — ещё проверенная копия прода).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270227_supply_registry_rate_details'
const BASE = '20270224_supply_registry_import'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270227.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const Y_DIR = path.join(ROOT, 'migration', 'yandex')
const Y_MIGRATION = path.join(Y_DIR, `${NAME}.sql`)
const Y_CHECK = path.join(Y_DIR, `${NAME}.check.sql`)
const Y_ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_yandex_rollback.sql`)

const U = {
  editor: '00000000-0000-4000-8000-0000000e1b01',     // «Реестр расценок»: правка
  viewer: '00000000-0000-4000-8000-0000000e1b02',     // «Реестр расценок»: просмотр
  contractor: '00000000-0000-4000-8000-0000000e1b03',
}
const CP = '00000000-0000-4000-8000-0000000e2b01'
const OBJ = '00000000-0000-4000-8000-0000000e3b01'
const T = '00000000-0000-4000-8000-0000000e4b01'
const COLUMNS = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id,'
  + 'contractor_label,doc_number,order_number,source_file,invoice_url,object_label,tender_label,row_no'

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const rowsJson = (rows) => q(JSON.stringify(rows))
const SEED = `
  insert into public.roles (key, label, is_system) values ('rd_editor', 'Тест: реестр, правка', false), ('rd_viewer', 'Тест: реестр, просмотр', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('rd_editor', 'rates_registry', true, true), ('rd_viewer', 'rates_registry', true, false) on conflict do nothing;
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Подрядчик подробностей');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
    ('${U.editor}', 'rd_editor', true, false, 'Загрузов З. З.', null),
    ('${U.viewer}', 'rd_viewer', true, false, 'Смотров С. С.', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Подробный 7', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status) values ('${T}', 'Электромонтаж секции 3', '${OBJ}', 'Идет тендерная процедура');`
// Строка файла из папок счетов: подробности — как их отдаёт окно (utils/supplyRegistryImport → importPayload).
const detailed = (over = {}) => ({
  source_name: 'Счета', item_name: 'Кабель ВВГнг(А)-LS 3х2,5', unit: 'м', price: 95.5, object_id: OBJ, object_label: 'подробный7',
  tender_id: T, tender_label: '№ 1157', rate_date: '2026-10-05', row_no: 2,
  contractor_label: '  ООО   «Электро» ', doc_number: '4512', order_number: 'З-118/2',
  source_file: '\\\\fs\\Счета\\Электро\\Счёт 4512.pdf', invoice_url: 'https://disk.example/s/4512', ...over,
})

describe('Реестр СУ-10: подробности расценки — база (Supabase)', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const load = (uid, rows, file = 'счета.xlsx') => as(uid,
    `select import_id || '|' || added || '|' || skipped from public.supply_registry_import(null, ${q(file)}, '{}'::jsonb, ${rowsJson(rows)}::jsonb)`)
  const registry = (uid, where) => JSON.parse(as(uid,
    `select coalesce(json_agg(r order by r.item_name, r.price), '[]') from public.supply_rates_registry r where ${where}`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME) || m.startsWith(BASE)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    psqlAt(db.port, null, { file: path.join(MIGRATIONS, `${BASE}.sql`) })
    sql(SEED)
    // Строка, загруженная до 20270227 (прежний вид функции, без подробностей).
    load(U.editor, [{ source_name: 'СУ-10', item_name: 'Грунтовка до миграции', unit: 'кг', price: 100, object_id: OBJ,
      object_label: 'подробный7', tender_id: null, tender_label: null, rate_date: '2026-09-01', row_no: 2 }], 'старый.xlsx')
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('подробности строки — в реестре, в конце колонок; прежняя строка цела, подробности пусты', () => {
    assert.equal(sql(`select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'supply_rates_registry'`), COLUMNS)
    const [importId, added] = load(U.editor, [detailed()]).split('|')
    assert.equal(added, '1')
    const [row] = registry(U.viewer, `import_id = '${importId}'`)
    assert.deepEqual([row.contractor_label, row.doc_number, row.order_number, row.source_file, row.invoice_url, row.object_label,
      row.tender_label, row.row_no, row.object_name, row.tender_desc],
    ['ООО «Электро»', '4512', 'З-118/2', '\\\\fs\\Счета\\Электро\\Счёт 4512.pdf', 'https://disk.example/s/4512', 'подробный7',
      '№ 1157', 2, 'ЖК Подробный 7', 'Электромонтаж секции 3'])
    const [old] = registry(U.viewer, `item_name = 'Грунтовка до миграции'`)
    assert.deepEqual([old.source_type, old.doc_number, old.invoice_url, old.object_name], ['supply_import', null, null, 'ЖК Подробный 7'])
  })

  it('ссылка на счёт — только http/https (иначе пусто, строка пишется); длинное — обрезается', () => {
    const [importId, added] = load(U.editor, [
      detailed({ item_name: 'Ссылка-скрипт', invoice_url: 'javascript:alert(1)' }),
      detailed({ item_name: 'Ссылка-путь', invoice_url: '\\\\fs\\Счета\\4512.pdf' }),
      detailed({ item_name: 'Ссылка с пробелами', invoice_url: '  http://x.ru/4512  ', doc_number: 'Д'.repeat(300) }),
    ], 'ссылки.xlsx').split('|')
    assert.equal(added, '3')
    const byName = Object.fromEntries(registry(U.viewer, `import_id = '${importId}'`).map((r) => [r.item_name, [r.invoice_url, r.doc_number.length]]))
    assert.deepEqual(byName, {
      'Ссылка с пробелами': ['http://x.ru/4512', 200], 'Ссылка-путь': [null, 4], 'Ссылка-скрипт': [null, 4],
    })
    assert.throws(() => sql(`update public.supply_registry_rates set invoice_url = 'ftp://x' where import_id = '${importId}'`), /check constraint/)
  })

  it('права прежние: загружает право правки; подрядчику загруженного не видно; гостю реестр закрыт', () => {
    assert.throws(() => load(U.viewer, [detailed({ item_name: 'Просмотр' })]), /Нет права правки реестра расценок/)
    assert.equal(as(U.contractor, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), '0')
    assert.throws(() => anon('select count(*) from public.supply_rates_registry'), /permission denied/)
    assert.throws(() => as(U.editor, `update public.supply_registry_rates set invoice_url = 'https://x.ru'`), /permission denied/)
  })

  it('поиск подстрокой и порядок по наименованию загруженных строк могут идти по индексу', () => {
    const plan = sql(`begin; set local enable_seqscan = off;
      explain select id from public.supply_rates_registry where item_name ilike '%кабель%' order by item_name, id limit 100; rollback;`)
    assert.match(plan, /supply_registry_rates_name_(trgm|idx)/, plan)
  })

  it('аварийный откат: 12 колонок, данные и колонки подробностей на месте, загрузка работает; миграция ложится снова', () => {
    const withDoc = sql('select count(*) from public.supply_registry_rates where doc_number is not null')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_rates_registry'`), '12')
    assert.equal(sql('select count(*) from public.supply_registry_rates where doc_number is not null'), withDoc, 'подробности не удалены')
    assert.throws(() => anon('select count(*) from public.supply_rates_registry'), /permission denied/, 'гостю реестр по-прежнему закрыт')
    assert.equal(load(U.editor, [detailed({ item_name: 'После отката' })]).split('|')[1], '1')
    assert.equal(sql(`select doc_number is null from public.supply_registry_rates where item_name = 'После отката'`), 't')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

describe('Реестр СУ-10: подробности расценки — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  let early
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const load = (uid, rows, file = 'счета.xlsx') => as(uid,
    `select import_id || '|' || added || '|' || skipped from public.supply_registry_import(null, ${q(file)}, '{}'::jsonb, ${rowsJson(rows)}::jsonb)`)
  const migrate = (dir) => {
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 25 * 60 * 1000,
      env: { ...process.env, OSP_MIGRATIONS_DIR: dir, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'),
        PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    return res.stdout
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-supply-details-'))
    // Сначала — всё до 20270227: строки загружаются в прежнюю таблицу (как на проде до выкладки).
    const before20270227 = path.join(tmp, 'yandex-before')
    fs.mkdirSync(before20270227)
    for (const f of fs.readdirSync(Y_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith(NAME))) {
      fs.copyFileSync(path.join(Y_DIR, f), path.join(before20270227, f))
    }
    db = startSingleOwner(latestVerifiedCopy())
    migrate(before20270227)
    internal(SEED)
    early = load(U.editor, [
      { source_name: 'СУ-10', item_name: 'Грунтовка до переноса', unit: 'кг', price: 100, object_id: OBJ, object_label: 'подробный7',
        tender_id: T, tender_label: null, rate_date: '2026-09-01', row_no: 2 },
      { source_name: 'СУ-10', item_name: 'Профиль до переноса', unit: 'м', price: 50, object_id: null, object_label: 'неизвестный',
        tender_id: null, tender_label: 'Отделка', rate_date: '2026-09-02', row_no: 3 },
    ], 'до переноса.xlsx').split('|')[0]
    internal(`update public.supply_registry_rates set created_at = '2026-11-01 10:00+03' where import_id = '${early}'`)
    // Теперь — 20270227 настоящим migrate.sh: перенос строк, проверка прав и .check.sql в транзакции.
    assert.match(migrate(Y_DIR), new RegExp(`OK ${NAME}: применена`))
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('строки, загруженные раньше, — в закрытой схеме с прежними id и временем; в реестре те же id', () => {
    assert.equal(internal(`select to_regclass('public.supply_registry_rates') is null`), 't')
    assert.equal(internal(`select count(*) || '|' || min(created_at at time zone 'Europe/Moscow')::text from osp_private.supply_registry_rates
      where import_id = '${early}'`), '2|2026-11-01 10:00:00')
    assert.equal(as(U.viewer, `select string_agg(item_name || ':' || object_name || ':' || coalesce(tender_desc, '-'), ' ; ' order by item_name)
      from public.supply_rates_registry where import_id = '${early}'`),
    'Грунтовка до переноса:ЖК Подробный 7:Электромонтаж секции 3 ; Профиль до переноса:неизвестный:Отделка')
    assert.equal(internal(`select bool_and(r.reg_id = md5('import|' || r.id::text)) from osp_private.supply_registry_rates r`), 't')
    assert.equal(internal(`select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'supply_rates_registry'`), COLUMNS)
  })

  it('загрузка с подробностями: поля — в реестре, ссылка не http/https — пусто; повтор не пишется', () => {
    const [importId, added] = load(U.editor, [detailed(), detailed({ item_name: 'Ссылка-путь', invoice_url: '\\\\fs\\4512.pdf' })]).split('|')
    assert.equal(added, '2')
    assert.equal(as(U.viewer, `select string_agg(concat_ws('|', item_name, contractor_label, doc_number, order_number, coalesce(invoice_url, '-'),
      object_name, tender_desc), ' ; ' order by item_name) from public.supply_rates_registry where import_id = '${importId}'`),
    'Кабель ВВГнг(А)-LS 3х2,5|ООО «Электро»|4512|З-118/2|https://disk.example/s/4512|ЖК Подробный 7|Электромонтаж секции 3 ; '
      + 'Ссылка-путь|ООО «Электро»|4512|З-118/2|-|ЖК Подробный 7|Электромонтаж секции 3')
    assert.equal(load(U.editor, [detailed()]).split('|').slice(1).join('|'), '0|1')
  })

  it('переименовали объект и тендер — в реестре сразу; удалили объект — название из файла', () => {
    internal(`update public.objects set name = 'ЖК Подробный 7 (новое)' where id = '${OBJ}'`)
    internal(`update public.tenders set work_description = 'Электромонтаж секции 3 и 4' where id = '${T}'`)
    assert.equal(as(U.viewer, `select string_agg(distinct object_name || '|' || tender_desc, ' ; ') from public.supply_rates_registry
      where source_type = 'supply_import' and object_id = '${OBJ}' and tender_id = '${T}'`), 'ЖК Подробный 7 (новое)|Электромонтаж секции 3 и 4')
    internal(`delete from public.tenders where id = '${T}'; delete from public.objects where id = '${OBJ}'`)
    assert.equal(as(U.viewer, `select string_agg(distinct coalesce(object_name, '-') || '|' || coalesce(tender_desc, '-'), ' ; ')
      from public.supply_rates_registry where item_name = 'Грунтовка до переноса'`), 'подробный7|-')
  })

  it('подрядчику и без входа ничего; закрытой таблицы вне служебного доступа нет в public', () => {
    assert.equal(as(U.contractor, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), '0')
    assert.equal(as(null, 'select count(*) from public.supply_rates_registry'), '0')
    assert.equal(as(U.contractor, 'select count(*) from public.supply_registry_imports'), '0')
    assert.throws(() => load(U.viewer, [detailed({ item_name: 'Просмотр' })]), /Нет права правки реестра расценок/)
  })

  it('поиск подстрокой и порядок по наименованию — по индексу закрытой таблицы', () => {
    const plan = as(U.viewer, `set local enable_seqscan = off;
      explain select id from public.supply_rates_registry where item_name ilike '%кабель%' order by item_name, id limit 100`)
    assert.match(plan, /supply_registry_rates_name_(trgm|idx)/, plan)
    assert.doesNotMatch(plan, /view_supply_registry_rates/)
  })

  it('аварийный откат: строки — снова в прежней таблице и в реестре; повторно 20270227 — сливает обратно', () => {
    const n = internal('select count(*) from osp_private.supply_registry_rates')
    db.sql(null, { file: Y_ROLLBACK, appName: 'osp-test' })
    db.sql(null, { file: Y_ROLLBACK, appName: 'osp-test' })
    assert.equal(internal('select count(*) from public.supply_registry_rates'), n)
    assert.equal(internal(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_rates_registry'`), '12')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), n)
    assert.equal(load(U.editor, [detailed({ item_name: 'После отката', object_id: null, tender_id: null })]).split('|')[1], '1')
    // Повторное применение (как migrate.sh: одна транзакция, служебная отметка) — строки после отката переезжают тоже.
    const again = path.join(tmp, 'again.sql')
    fs.writeFileSync(again, `begin;\nset local application_name = 'osp:internal';\n\\i ${Y_MIGRATION}\ncommit;\n`)
    db.sql(null, { file: again, appName: 'osp:internal' })
    assert.doesNotMatch(db.sql(null, { file: Y_CHECK, appName: 'osp:internal' }), /^FAIL/m)
    assert.equal(internal('select count(*) from osp_private.supply_registry_rates'), String(Number(n) + 1))
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where item_name = 'После отката'`), '1')
  })
})

it('файлы миграций, проверок и откатов есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, Y_MIGRATION, Y_CHECK, Y_ROLLBACK]) assert.ok(fs.existsSync(f), f)
})
