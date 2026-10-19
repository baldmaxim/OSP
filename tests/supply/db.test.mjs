// Расценка снабжением на сайте (миграция 20261020_supply_pricing) — на слепке схемы прода.
//
// Слепок migration/schema/prod-schema.sql + миграции после него + кандидаты + эта миграция: настоящие
// таблицы, правила по строкам, osp_can и auth.uid() из JWT, как при запросе через PostgREST. Проверяется:
// расчёт цены и суммы в базе, права ролей, «изменено другим» по версии строки, прежний импорт Excel,
// закрытие после завершения тендера на материалы, журнал, списки позиций, перенос ВОР, каскадное удаление.
// Нужны Docker и psql; без них набор пропускается.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261020_supply_pricing.sql')
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261020.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20261020_supply_pricing_rollback.sql')
const skip = skipReason()

const U = {
  admin: '00000000-0000-4000-8000-00000000c0a1',
  supply: '00000000-0000-4000-8000-00000000c0b1',     // «Тендеры на материалы»: просмотр и правка
  tender: '00000000-0000-4000-8000-00000000c0b2',     // «Тендеры»: просмотр и правка
  viewer: '00000000-0000-4000-8000-00000000c0b3',     // «Тендеры на материалы»: только просмотр
  none: '00000000-0000-4000-8000-00000000c0b4',       // сотрудник без разделов
  contractor: '00000000-0000-4000-8000-00000000c0b5', // подрядчик своей организации
}
const OBJ = '00000000-0000-4000-8000-00000000d001'
const T1 = '00000000-0000-4000-8000-00000000e001'   // основной тендер, тендер на материалы «В работе»
const M1 = '00000000-0000-4000-8000-00000000e011'
const T2 = '00000000-0000-4000-8000-00000000e002'   // основной тендер, тендер на материалы «Завершён»
const M2 = '00000000-0000-4000-8000-00000000e012'
const T3 = '00000000-0000-4000-8000-00000000e003'   // основной тендер без тендера на материалы
const DOC = '00000000-0000-4000-8000-00000000f001'

describe('Расценка снабжением на сайте: база', { skip, timeout: 600000 }, () => {
  let db
  const sql = (text) => psqlAt(db.port, text)
  // Запрос от имени пользователя, как через PostgREST: роль authenticated и JWT; одна транзакция.
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const rate = (where) => JSON.parse(sql(`select row_to_json(r) from public.tender_vor_supply_rates r where ${where}`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      // Эта миграция — ниже; 20261022 (ссылки на документы) и 20261023 (цены из других тендеров) требуют её и
      // проверяются в links-db.test.mjs и reuse-db.test.mjs.
      if (/^2026102[023]_/.test(m)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('t_supply', 'Тест: снабжение', false), ('t_tender', 'Тест: тендерный отдел', false),
        ('t_viewer', 'Тест: просмотр материалов', false), ('t_none', 'Тест: без разделов', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('t_supply', 'tenders_materials', true, true),
        ('t_tender', 'tenders', true, true),
        ('t_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a001', 'ООО Тест');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
        ('${U.supply}', 't_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 't_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 't_viewer', true, false, 'Смотров В. В.', null),
        ('${U.none}', 't_none', true, false, 'Безразделов Б. Б.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a001');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Тест', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ('${T1}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура'),
        ('${T2}', 'Электрика', '${OBJ}', 'Идет тендерная процедура'),
        ('${T3}', 'Прочее', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${M1}', 'ОВ и ВК', '${OBJ}', 'В работе', 'materials', '${T1}'),
        ('${M2}', 'Электрика', '${OBJ}', 'В работе', 'materials', '${T2}');
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category)
        values ('${DOC}', 'tender', '${T1}', 'tenders/${T1}/x-ВОР_ОВ.xlsx', 'ВОР_ОВ.xlsx', 'vor_statement');`)
  })
  after(() => db?.stop())

  it('миграция повторяется без ошибок, проверка для прода — все OK', () => {
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 9, out)
  })

  it('цена за единицу → сумма = round(цена × объём, 2); версия 1; ключ наименования', () => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${T1}', 'ОВ', 'Труба МЕДНАЯ Ø12,7', 'м', 'unit', 412.504, 1250.5)`)
    const r = rate(`tender_id = '${T1}' and material_name = 'Труба МЕДНАЯ Ø12,7'`)
    assert.equal(Number(r.supply_price), 412.5)
    assert.equal(Number(r.supply_total), 515831.25)
    assert.equal(r.supply_price_exact, null)
    assert.equal(r.price_input, 'unit')
    assert.equal(r.row_version, 1)
    assert.equal(r.updated_by, U.supply)
    assert.equal(r.material_key, 'tpyбameдhaя12.7')
  })

  it('сумма → точная цена; карточка по строкам ВОР получает ту же сумму до копейки', () => {
    const id = rate(`tender_id = '${T1}' and material_name = 'Труба МЕДНАЯ Ø12,7'`).id
    const n = as(U.supply, `update public.tender_vor_supply_rates set price_input = 'total', input_value = 100000, volume_at_input = 1500
      where id = '${id}' and row_version = 1 returning 1`)
    assert.equal(n, '1')
    const r = rate(`id = '${id}'`)
    assert.equal(Number(r.supply_total), 100000)
    assert.equal(Number(r.supply_price), 66.67)
    assert.equal(r.row_version, 2)
    // Объём позиции ВОР разбит по трём строкам ВОР; карточка: Σ расход × точная цена.
    const card = sql(`select round(sum(c * (select supply_price_exact from public.tender_vor_supply_rates where id = '${id}')), 2)
      from (values (333.3333::numeric), (666.6667), (500)) v(c)`)
    assert.equal(Number(card), 100000)
  })

  it('правка со старой версией не проходит (изменено другим)', () => {
    const id = rate(`tender_id = '${T1}' and material_name = 'Труба МЕДНАЯ Ø12,7'`).id
    const n = as(U.tender, `with u as (update public.tender_vor_supply_rates set price_input = 'unit', input_value = 1
      where id = '${id}' and row_version = 1 returning 1) select count(*) from u`)
    assert.equal(n, '0')
    assert.equal(Number(rate(`id = '${id}'`).supply_total), 100000)
  })

  it('прежний импорт Excel (только supply_price) сбрасывает точную цену и сумму, помечается import', () => {
    const id = rate(`tender_id = '${T1}' and material_name = 'Труба МЕДНАЯ Ø12,7'`).id
    as(U.tender, `update public.tender_vor_supply_rates set unit = 'м', supply_price = 70 where id = '${id}'`)
    const r = rate(`id = '${id}'`)
    assert.equal(r.price_input, 'import')
    assert.equal(Number(r.supply_price), 70)
    assert.equal(r.supply_price_exact, null)
    assert.equal(r.supply_total, null)
    as(U.tender, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price)
      values ('${T1}', 'ОВ', 'Кран шаровой Ду15', 'шт', 1200)`)
    assert.equal(rate(`material_name = 'Кран шаровой Ду15'`).price_input, 'import')
  })

  it('неверные значения отклоняются: ноль, сумма без объёма, цена меньше копейки', () => {
    const ins = (cols, vals) => as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, ${cols})
      values ('${T1}', 'ОВ', 'Проверка ${Math.random()}', ${vals})`)
    assert.throws(() => ins('price_input, input_value', `'unit', 0`), /больше нуля/)
    assert.throws(() => ins('price_input, input_value', `'total', 100`), /только у позиции с объёмом/)
    assert.throws(() => ins('price_input, input_value, volume_at_input', `'total', 0.01, 1000`), /меньше копейки/)
    assert.throws(() => ins('supply_price', '0'), /больше нуля/)
  })

  it('права: читают сотрудники, пишут только правка «Тендеры» / «Тендеры на материалы»', () => {
    const count = `select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}'`
    for (const u of [U.supply, U.tender, U.viewer, U.none, U.admin]) assert.equal(as(u, count), '2')
    assert.equal(as(U.contractor, count), '0')
    for (const u of [U.viewer, U.none, U.contractor]) {
      assert.throws(() => as(u, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, supply_price)
        values ('${T1}', 'ОВ', 'Чужое ${u}', 10)`), /row-level security/)
      assert.equal(as(u, `with x as (update public.tender_vor_supply_rates set supply_price = 1 where tender_id = '${T1}' returning 1)
        select count(*) from x`), '0')
      assert.equal(as(u, `with x as (delete from public.tender_vor_supply_rates where tender_id = '${T1}' returning 1)
        select count(*) from x`), '0')
    }
    as(U.admin, `update public.tender_vor_supply_rates set supply_price = 1250 where material_name = 'Кран шаровой Ду15'`)
  })

  it('журнал: каждое изменение — было / стало, кто; пустая правка не пишется', () => {
    const id = rate(`tender_id = '${T1}' and material_name = 'Труба МЕДНАЯ Ø12,7'`).id
    const before = Number(sql(`select count(*) from public.tender_supply_rate_log where rate_id = '${id}'`))
    as(U.supply, `update public.tender_vor_supply_rates set id = id where id = '${id}'`)
    assert.equal(Number(sql(`select count(*) from public.tender_supply_rate_log where rate_id = '${id}'`)), before)
    const log = sql(`select string_agg(op || ':' || coalesce(old_price::text, '-') || '>' || coalesce(new_price::text, '-')
      || ':' || coalesce(new_input, '-') || ':' || coalesce(changed_by_name, '-'), ' | ' order by id)
      from public.tender_supply_rate_log where rate_id = '${id}'`)
    assert.equal(log, 'insert:->412.50:unit:Снабженцев С. С. | update:412.50>66.67:total:Снабженцев С. С. | update:66.67>70.00:import:Тендеров Т. Т.')
    assert.equal(as(U.contractor, `select count(*) from public.tender_supply_rate_log`), '0')
    assert.throws(() => as(U.supply, `delete from public.tender_supply_rate_log`), /permission denied|row-level security/)
  })

  it('списки позиций: ключ k и число позиций считает база; без наименования — отказ', () => {
    const positions = JSON.stringify([
      { name: 'Труба МЕДНАЯ Ø12,7', unit: 'м', volume: 1500, order: 1 },
      { name: 'Кран шаровой Ду15', unit: 'шт', volume: 48, order: 2 },
      { name: 'Изоляция K-Flex 13×15', unit: 'м', volume: 1100, order: 3 },
    ])
    as(U.supply, `insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, sheet_name, positions)
      values ('${T1}', 'ОВ', 'vor_file', '${DOC}', 'ВОР_ОВ.xlsx', 'Материалы', '${positions}'::jsonb)`)
    const s = JSON.parse(sql(`select row_to_json(s) from public.tender_supply_sources s where tender_id = '${T1}'`))
    assert.equal(s.positions_count, 3)
    assert.equal(s.positions[0].k, 'tpyбameдhaя12.7')
    assert.equal(s.parsed_by, U.supply)
    assert.equal(as(U.viewer, `select priced_count || '/' || positions_count from public.tender_supply_progress where tender_id = '${T1}'`), '2/3')
    assert.throws(() => as(U.supply, `update public.tender_supply_sources set positions = '[{"unit":"м"}]' where tender_id = '${T1}'`),
      /без наименования/)
    assert.equal(as(U.viewer, `with x as (update public.tender_supply_sources set file_name = 'x' where tender_id = '${T1}' returning 1)
      select count(*) from x`), '0')
    assert.throws(() => as(U.viewer, `insert into public.tender_supply_sources (tender_id, estimate_name, source)
      values ('${T1}', 'ВК', 'vor_tab')`), /row-level security/)
  })

  it('новая версия списка позиций не трогает цены', () => {
    const before = sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}'`)
    as(U.supply, `update public.tender_supply_sources set positions = '[{"name":"Кран шаровой Ду15","unit":"шт","volume":50}]'
      where tender_id = '${T1}' and estimate_name = 'ОВ'`)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}'`), before)
    assert.equal(sql(`select positions_count || '/' || row_version from public.tender_supply_sources where tender_id = '${T1}'`), '1/2')
  })

  it('перенос на другое имя ВОР — расценки и список вместе; пересечение цен — отказ целиком', () => {
    const res = JSON.parse(as(U.tender, `select public.supply_estimate_rename('${T1}', 'ОВ', 'ОВ-1')`))
    assert.deepEqual(res, { rates: 2, sources: 1 })
    as(U.tender, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, supply_price)
      values ('${T1}', 'ВК', 'Кран шаровой ДУ15', 900)`)
    assert.throws(() => as(U.tender, `select public.supply_estimate_rename('${T1}', 'ВК', 'ОВ-1')`), /уже есть цены/)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}' and estimate_name = 'ВК'`), '1')
    assert.throws(() => as(U.viewer, `select public.supply_estimate_rename('${T1}', 'ОВ-1', 'ОВ')`), /Нет права/)
    const log = sql(`select old_estimate_name || '>' || estimate_name from public.tender_supply_rate_log
      where tender_id = '${T1}' and old_estimate_name is not null order by id limit 1`)
    assert.equal(log, 'ОВ>ОВ-1')
  })

  it('тендер на материалы «Завершён» — только чтение; пустая правка проходит; «Не требуется» не закрывает', () => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${T2}', 'ЭОМ', 'Кабель ВВГнг 3×2,5', 'м', 'unit', 95, 4000)`)
    as(U.supply, `insert into public.tender_supply_sources (tender_id, estimate_name, source, positions)
      values ('${T2}', 'ЭОМ', 'vor_tab', '[{"name":"Кабель ВВГнг 3×2,5","unit":"м","volume":4000}]')`)
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    assert.equal(as(U.supply, `select public.supply_rates_locked('${T2}')::text`), 'true')
    assert.equal(as(U.supply, `select public.supply_rates_locked('${T1}')::text`), 'false')
    assert.throws(() => as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, supply_price)
      values ('${T2}', 'ЭОМ', 'Щит', 10)`), /только для чтения/)
    assert.throws(() => as(U.tender, `update public.tender_vor_supply_rates set supply_price = 1 where tender_id = '${T2}'`), /только для чтения/)
    assert.throws(() => as(U.admin, `delete from public.tender_vor_supply_rates where tender_id = '${T2}'`), /только для чтения/)
    assert.throws(() => as(U.supply, `update public.tender_supply_sources set positions = '[]' where tender_id = '${T2}'`), /только для чтения/)
    as(U.supply, `update public.tender_vor_supply_rates set id = id where tender_id = '${T2}'`)
    // Старое написание статуса тоже закрывает; «Не требуется» — нет.
    sql(`update public.tenders set status = 'Завершен' where id = '${M2}'`)
    assert.equal(as(U.supply, `select public.supply_rates_locked('${T2}')::text`), 'true')
    sql(`update public.tenders set status = 'Не требуется' where id = '${M2}'`)
    as(U.supply, `update public.tender_vor_supply_rates set price_input = 'unit', input_value = 96 where tender_id = '${T2}'`)
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    // Удалённый тендер на материалы не закрывает; без тендера на материалы закрывать нечем.
    sql(`update public.tenders set deleted_at = now() where id = '${M2}'`)
    assert.equal(as(U.supply, `select public.supply_rates_locked('${T2}')::text`), 'false')
    sql(`update public.tenders set deleted_at = null where id = '${M2}'`)
    assert.equal(as(U.supply, `select public.supply_rates_locked('${T3}')::text`), 'false')
  })

  it('файл ВОР удалён — ссылка в списке позиций обнуляется; удаление тендера с закрытыми расценками проходит', () => {
    assert.equal(sql(`select count(*) from public.tender_supply_sources where s3_document_id = '${DOC}'`), '1')
    sql(`delete from public.s3_documents where id = '${DOC}'`)
    assert.equal(sql(`select count(*) from public.tender_supply_sources where s3_document_id is not null`), '0')
    // T2 закрыт («Завершён»): каскад удаления тендера не упирается в закрытие, журнал пишет удаление.
    sql(`delete from public.tenders where id = '${T2}'`)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T2}'`), '0')
    assert.equal(sql(`select count(*) from public.tender_supply_sources where tender_id = '${T2}'`), '0')
    assert.match(sql(`select string_agg(op, ',') from public.tender_supply_rate_log where tender_id = '${T2}'`), /delete/)
  })

  it('аварийный откат применяется и повторяется; данные остаются; миграция ложится снова', () => {
    const rates = sql('select count(*) from public.tender_vor_supply_rates')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_vor_supply_rates'), rates)
    assert.equal(as(U.none, `with x as (update public.tender_vor_supply_rates set supply_price = supply_price returning 1) select count(*) from x`), rates)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

describe('Проверка 20261020 до миграции', { skip, timeout: 600000 }, () => {
  it('отвечает FAIL, а не падает', () => {
    const db = startSnapshot()
    try {
      for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
      const out = psqlAt(db.port, null, { file: CHECK })
      assert.match(out, /^FAIL /m)
      assert.equal(out.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 9)
    } finally {
      db.stop()
    }
  })
})

// Файлы на месте — иначе набор молча проверял бы не то.
it('файлы миграции, проверки и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK]) assert.ok(fs.existsSync(f), f)
})
