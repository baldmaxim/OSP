// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel» (миграция 20270224_supply_registry_import) на слепке
// схемы прода: загруженные строки видны в реестре сразу (без пересчёта) с источником, объектом и тендером — портала или
// как в файле; дата — полночь дня по Москве; одна и та же расценка второй раз не записывается (тот же файл, повтор в
// файле); права (загружает и удаляет загрузку право правки реестра, читает читатель реестра, подрядчику и гостю — ничего);
// строки удаляются вместе с загрузкой; нормализация наименования в браузере — как kp_norm_name; проверка для прода до
// миграции — FAIL, а не ошибка; откат не трогает загруженное. Нужны Docker и psql.
// Второй блок — то же на копии прода, загруженной как база Яндекса (одна учётка, migration/yandex через migrate.sh — с
// проверкой прав и .check.sql в транзакции); нужна проверенная копия прода.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'
import { kpNormName } from '../../src/utils/supplyRegistryImport.js'

const NAME = '20270224_supply_registry_import'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270224.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  editor: '00000000-0000-4000-8000-0000000e1a01',     // «Реестр расценок»: правка
  viewer: '00000000-0000-4000-8000-0000000e1a02',     // «Реестр расценок»: просмотр
  contractor: '00000000-0000-4000-8000-0000000e1a03',
}
const CP = '00000000-0000-4000-8000-0000000e2a01'
const OBJ = '00000000-0000-4000-8000-0000000e3a01'
const T = '00000000-0000-4000-8000-0000000e4a01'

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const rowsJson = (rows) => q(JSON.stringify(rows))
const ROWS = [
  { source_name: 'СУ-10', item_name: '  Кабель   ВВГнг(А)-LS 3х2,5 ', unit: 'м', price: 95.504, object_id: OBJ, object_label: 'Зил33',
    tender_id: T, tender_label: 'Электромонтаж корпуса 1', rate_date: '2026-10-05', row_no: 2 },
  { source_name: 'Петрович', item_name: 'Гипсокартон 12,5 мм', unit: 'м2', price: 350.4, object_id: null, object_label: 'primavera',
    tender_id: null, tender_label: 'Отделка МОП', rate_date: '2026-10-06', row_no: 3 },
  // Повтор строки 2 в том же файле (другое написание) — пропускается.
  { source_name: 'су-10 ', item_name: 'кабель ВВГнг(А)-LS 3х2,5', unit: 'м', price: 95.5, object_id: OBJ, object_label: 'ЗИЛ 33',
    tender_id: null, tender_label: null, rate_date: '2026-10-05', row_no: 4 },
]

describe('Реестр СУ-10: загрузка из Excel — база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const load = (uid, rows, { importId = null, file = 'расценки.xlsx', options = '{}' } = {}) => as(uid,
    `select import_id || '|' || added || '|' || skipped from public.supply_registry_import(${importId ? q(importId) : 'null'}, ${q(file)}, ${q(options)}::jsonb, ${rowsJson(rows)}::jsonb)`)
  const registry = (uid, where = 'true') => JSON.parse(as(uid,
    `select coalesce(json_agg(r order by r.item_name), '[]') from public.supply_rates_registry r where ${where}`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(`
      insert into public.roles (key, label, is_system) values ('ri_editor', 'Тест: реестр, правка', false), ('ri_viewer', 'Тест: реестр, просмотр', false)
        on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('ri_editor', 'rates_registry', true, true), ('ri_viewer', 'rates_registry', true, false);
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Подрядчик загрузки');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.editor}', 'ri_editor', true, false, 'Загрузов З. З.', null),
        ('${U.viewer}', 'ri_viewer', true, false, 'Смотров С. С.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Тестовый 33', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
        ('${T}', 'Электромонтаж корпуса 1', '${OBJ}', 'Идет тендерная процедура', 9970);`)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('загрузка: строки сразу в реестре; повтор в файле и тот же файл второй раз — не пишутся', () => {
    const before = Number(as(U.viewer, 'select count(*) from public.supply_rates_registry'))
    const [importId, added, skipped] = load(U.editor, ROWS).split('|')
    assert.match(importId, /^[0-9a-f-]{36}$/)
    assert.deepEqual([added, skipped], ['2', '1'])
    assert.equal(Number(as(U.viewer, 'select count(*) from public.supply_rates_registry')), before + 2)
    assert.equal(sql(`select created_by_name || '|' || file_name from public.supply_registry_imports where id = '${importId}'`), 'Загрузов З. З.|расценки.xlsx')

    const mine = registry(U.viewer, `import_id = '${importId}'`)
    assert.deepEqual(mine.map((r) => [r.source_type, r.source_name, r.item_name, r.unit, Number(r.price), r.object_id, r.object_name, r.tender_id, r.tender_desc]), [
      ['supply_import', 'Петрович', 'Гипсокартон 12,5 мм', 'м2', 350.4, null, 'primavera', null, 'Отделка МОП'],
      ['supply_import', 'СУ-10', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 95.5, OBJ, 'ЖК Тестовый 33', T, 'Электромонтаж корпуса 1'],
    ])
    // День расценки — полночь по Москве, как у цен снабжения из тендеров.
    assert.equal(as(U.viewer, `select to_char(rate_date at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') from public.supply_rates_registry
      where import_id = '${importId}' and source_name = 'СУ-10'`), '2026-10-05 00:00')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry_filter_objects where object_id = '${OBJ}'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry_filter_tenders where tender_id = '${T}'`), '1')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry_units where unit = 'м2'`), '1')

    // Тот же файл ещё раз — новая загрузка без строк.
    const again = load(U.editor, ROWS).split('|')
    assert.deepEqual(again.slice(1), ['0', '3'])
    // Порция к начатой загрузке.
    const more = load(U.editor, [{ ...ROWS[1], item_name: 'Гипсокартон 9,5 мм', row_no: 5 }], { importId }).split('|')
    assert.deepEqual(more, [importId, '1', '0'])
  })

  it('права: загружает право правки; просмотр, подрядчик и гость — нет; читают только читатели реестра', () => {
    assert.throws(() => load(U.viewer, ROWS), /Нет права правки реестра расценок/)
    assert.throws(() => load(U.contractor, ROWS), /Нет права правки реестра расценок/)
    assert.throws(() => anon(`select * from public.supply_registry_import(null, 'x', '{}', '[]')`), /permission denied/)
    assert.throws(() => anon('select count(*) from public.supply_registry_rates'), /permission denied/)
    assert.throws(() => anon('select count(*) from public.supply_rates_registry'), /permission denied/)
    assert.equal(as(U.contractor, 'select count(*) from public.supply_registry_rates'), '0')
    assert.equal(as(U.contractor, 'select count(*) from public.supply_registry_imports'), '0')
    assert.equal(as(U.contractor, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), '0')
    // Строки напрямую не пишутся и не правятся — только функцией и удалением загрузки.
    assert.throws(() => as(U.editor, `update public.supply_registry_rates set price = 1`), /permission denied/)
    assert.throws(() => as(U.editor, `delete from public.supply_registry_rates`), /permission denied/)
  })

  it('ошибки строк: дата из будущего или пустая, цена не больше нуля, больше 1000 строк — порция не пишется целиком', () => {
    const count = () => sql('select count(*) from public.supply_registry_rates')
    const n = count()
    const ok = { ...ROWS[1], item_name: 'Профиль ПН 50', row_no: 9 }
    assert.throws(() => load(U.editor, [ok, { ...ok, item_name: 'Профиль ПН 75', rate_date: '2099-01-01' }]), /из будущего/)
    assert.throws(() => load(U.editor, [ok, { ...ok, item_name: 'Профиль ПН 75', rate_date: null }]), /не указана/)
    assert.throws(() => load(U.editor, [ok, { ...ok, item_name: 'Профиль ПН 75', price: 0 }]), /check constraint/)
    assert.throws(() => as(U.editor, `select * from public.supply_registry_import(null, 'x', '{}',
      (select jsonb_agg(jsonb_build_object('source_name', 'x', 'item_name', 'x' || g, 'price', 1, 'rate_date', '2026-10-01')) from generate_series(1, 1001) g))`),
    /не больше 1000/)
    assert.equal(count(), n, 'ничего не записано')
    assert.equal(sql(`select count(*) from public.supply_registry_imports where file_name = 'x'`), '0', 'пустая загрузка не осталась')
  })

  it('удаление загрузки: просмотр не удаляет; право правки удаляет вместе со строками', () => {
    const [importId] = load(U.editor, [{ ...ROWS[1], item_name: 'Удаляемая расценка', row_no: 7 }], { file: 'удалить.xlsx' }).split('|')
    assert.equal(as(U.viewer, `delete from public.supply_registry_imports where id = '${importId}' returning id`), '', 'просмотр не удаляет')
    assert.equal(as(U.editor, `delete from public.supply_registry_imports where id = '${importId}' returning id`), importId)
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where item_name = 'Удаляемая расценка'`), '0')
    assert.equal(sql(`select count(*) from public.supply_registry_rates where import_id = '${importId}'`), '0')
    // Объект удалён — строка остаётся, с названием из файла.
    const [id2] = load(U.editor, [{ ...ROWS[0], item_name: 'Объект удалят', row_no: 8 }]).split('|')
    sql(`delete from public.tenders where id = '${T}'; delete from public.objects where id = '${OBJ}'`)
    assert.equal(as(U.viewer, `select object_name || '|' || coalesce(object_id::text, 'нет') || '|' || tender_desc from public.supply_rates_registry
      where import_id = '${id2}'`), 'Зил33|нет|Электромонтаж корпуса 1')
  })

  it('нормализация наименования в браузере — как kp_norm_name базы (ключ уникального индекса)', () => {
    const samples = [' «Кабель»  ВВГнг(А)-LS 3х2.5 ', 'Плита 1200x600 ЁЛКА', 'Труба PPR "Pn20" 20х3,4', 'м²', 'М3', 'Уголок 50.50.5  ст3', 'ABCEHKMOPTXY']
    const db = sql(`select json_agg(public.kp_norm_name(s) order by i) from unnest(array[${samples.map(q).join(',')}]) with ordinality as t(s, i)`)
    assert.deepEqual(JSON.parse(db), samples.map(kpNormName))
  })

  it('аварийный откат: реестр — снова только цены из тендеров; загруженное остаётся в таблицах; миграция ложится снова', () => {
    const loaded = sql('select count(*) from public.supply_registry_rates')
    assert.ok(Number(loaded) > 0)
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_rates_registry'`), '11')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), '0')
    assert.equal(sql('select count(*) from public.supply_registry_rates'), loaded, 'загруженное не удалено')
    assert.throws(() => anon('select count(*) from public.supply_rates_registry'), /permission denied/, 'гостю реестр по-прежнему закрыт')
    assert.equal(as(U.viewer, 'select count(*) >= 0 from public.supply_rates_registry'), 't', 'читателю реестр открыт')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), loaded)
  })
})

describe('Реестр СУ-10: загрузка из Excel — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const load = (uid, rows) => as(uid,
    `select import_id || '|' || added || '|' || skipped from public.supply_registry_import(null, 'расценки.xlsx', '{"primavera": "k14"}'::jsonb, ${rowsJson(rows)}::jsonb)`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-supply-import-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(`
      insert into public.roles (key, label, is_system) values ('ri_editor', 'Тест: реестр, правка', false), ('ri_viewer', 'Тест: реестр, просмотр', false)
        on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('ri_editor', 'rates_registry', true, true), ('ri_viewer', 'rates_registry', true, false) on conflict do nothing;
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Подрядчик загрузки');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.editor}', 'ri_editor', true, false, 'Загрузов З. З.', null),
        ('${U.viewer}', 'ri_viewer', true, false, 'Смотров С. С.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Тестовый 33', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status) values ('${T}', 'Электромонтаж корпуса 1', '${OBJ}', 'Идет тендерная процедура');`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('загружает право правки; строки сразу в реестре и в фильтрах; повтор не пишется; кто — триггером', () => {
    const before = Number(as(U.viewer, 'select count(*) from public.supply_rates_registry'))
    assert.ok(before > 1000, `цен снабжения в реестре копии: ${before}`)
    const [importId, added, skipped] = load(U.editor, ROWS).split('|')
    assert.deepEqual([added, skipped], ['2', '1'])
    assert.equal(Number(as(U.viewer, 'select count(*) from public.supply_rates_registry')), before + 2)
    assert.equal(as(U.viewer, `select source_name || '|' || object_name || '|' || tender_desc || '|' || price
      from public.supply_rates_registry where import_id = '${importId}' and object_id = '${OBJ}'`), 'СУ-10|ЖК Тестовый 33|Электромонтаж корпуса 1|95.50')
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry_filter_objects where object_id = '${OBJ}'`), '1')
    assert.equal(internal(`select created_by_name || '|' || (options->>'primavera') from public.supply_registry_imports where id = '${importId}'`), 'Загрузов З. З.|k14')
    assert.equal(load(U.editor, ROWS).split('|').slice(1).join('|'), '0|3')
  })

  it('просмотр и подрядчик не загружают; подрядчику и без входа строк нет', () => {
    assert.throws(() => load(U.viewer, ROWS), /Нет права правки реестра расценок/)
    assert.throws(() => load(U.contractor, ROWS), /Нет права правки реестра расценок/)
    assert.equal(as(U.contractor, 'select count(*) from public.supply_registry_rates'), '0')
    assert.equal(as(U.contractor, `select count(*) from public.supply_rates_registry where source_type = 'supply_import'`), '0')
    assert.equal(as(null, 'select count(*) from public.supply_rates_registry'), '0')
    assert.equal(as(null, 'select count(*) from public.supply_registry_imports'), '0')
  })

  it('удаление загрузки правом правки — со строками; просмотр не удаляет', () => {
    const id = as(U.viewer, `select id from public.supply_registry_imports where (options->>'primavera') = 'k14' limit 1`)
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(as(U.viewer, `delete from public.supply_registry_imports where id = '${id}' returning id`), '')
    assert.equal(as(U.editor, `delete from public.supply_registry_imports where id = '${id}' returning id`), id)
    assert.equal(as(U.viewer, `select count(*) from public.supply_rates_registry where import_id = '${id}'`), '0')
  })

  it('аварийный откат и здесь: реестр — только цены из тендеров (закрытая схема), загруженное остаётся; повтор безопасен', () => {
    load(U.editor, [{ ...ROWS[1], item_name: 'Останется после отката', row_no: 11 }])
    const loaded = internal('select count(*) from public.supply_registry_rates')
    const before = Number(as(U.viewer, `select count(*) from public.supply_rates_registry where source_type <> 'supply_import'`))
    db.sql(null, { file: ROLLBACK, appName: 'osp:internal' })
    db.sql(null, { file: ROLLBACK, appName: 'osp:internal' })
    assert.equal(internal(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_rates_registry'`), '11')
    assert.match(internal(`select pg_get_viewdef('public.supply_rates_registry'::regclass)`), /osp_private\.supply_rates_registry_mv/)
    assert.equal(Number(as(U.viewer, 'select count(*) from public.supply_rates_registry')), before)
    assert.equal(as(null, 'select count(*) from public.supply_rates_registry'), '0', 'без входа — по-прежнему ничего')
    assert.equal(internal('select count(*) from public.supply_registry_rates'), loaded, 'загруженное не удалено')
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
