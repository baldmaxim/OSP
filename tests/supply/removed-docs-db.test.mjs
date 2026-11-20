// Следы удалённых файлов счетов и КП в расценке снабжением (миграция 20270223_supply_removed_docs) — на слепке схемы прода
// после расценки (20261020 и следующие): страница перед удалением файла записывает, какие цены поставлены из него, и по
// этим строкам позже предлагает их снять. Одна цена — один след (замена, как upsert страницы), тендер следа — тендер цены,
// очистили цену — след ушёл сам, права как у цен, закрытие после «Завершён», проверка для прода (до миграции — FAIL, а не
// ошибка) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270223_supply_removed_docs'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270223.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  admin: '00000000-0000-4000-8000-00000000f2a1',
  supply: '00000000-0000-4000-8000-00000000f2b1',
  tender: '00000000-0000-4000-8000-00000000f2b2',
  viewer: '00000000-0000-4000-8000-00000000f2b3',
  none: '00000000-0000-4000-8000-00000000f2b4',
  contractor: '00000000-0000-4000-8000-00000000f2b5',
}
const OBJ = '00000000-0000-4000-8000-00000000f301'
const T1 = '00000000-0000-4000-8000-00000000f311'
const M1 = '00000000-0000-4000-8000-00000000f321'
const T2 = '00000000-0000-4000-8000-00000000f312'
const M2 = '00000000-0000-4000-8000-00000000f322'
const DOC_A = '00000000-0000-4000-8000-00000000f401'
const DOC_B = '00000000-0000-4000-8000-00000000f402'

describe('Следы удалённых файлов счетов и КП: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const price = (tender, name, value) => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${tender}', 'ОВ', ${q(name)}, 'шт', 'unit', ${value}, 4)`)
    return sql(`select id from public.tender_vor_supply_rates where tender_id = '${tender}' and estimate_name = 'ОВ' and material_name = ${q(name)}`)
  }
  // Как upsert страницы (PostgREST on_conflict по цене).
  const trace = (uid, tender, rateId, doc, name, value) => as(uid, `insert into public.tender_supply_removed_docs (tender_id, rate_id, doc_id, doc_name, price)
    values ('${tender}', '${rateId}', '${doc}', ${q(name)}, ${value})
    on conflict (rate_id) do update set doc_id = excluded.doc_id, doc_name = excluded.doc_name, price = excluded.price`)
  const row = (where) => JSON.parse(sql(`select row_to_json(d) from public.tender_supply_removed_docs d where ${where}`) || 'null')
  const count = (where = 'true') => sql(`select count(*) from public.tender_supply_removed_docs where ${where}`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    // Кандидаты до этой миграции (в том числе расценка 20261020 — она нужна: цены, право записи, закрытие).
    const candidates = candidateMigrations()
    for (const m of candidates.slice(0, candidates.findIndex((c) => c.startsWith(NAME)))) {
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('f_supply', 'Тест: снабжение', false), ('f_tender', 'Тест: тендерный отдел', false),
        ('f_viewer', 'Тест: просмотр материалов', false), ('f_none', 'Тест: без разделов', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('f_supply', 'tenders_materials', true, true),
        ('f_tender', 'tenders', true, true),
        ('f_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000f501', 'ООО Тест следов');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
        ('${U.supply}', 'f_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 'f_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 'f_viewer', true, false, 'Смотров В. В.', null),
        ('${U.none}', 'f_none', true, false, 'Безразделов Б. Б.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000f501');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Следы', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ('${T1}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура'),
        ('${T2}', 'Электрика', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${M1}', 'ОВ и ВК', '${OBJ}', 'В работе', 'materials', '${T1}'),
        ('${M2}', 'Электрика', '${OBJ}', 'В работе', 'materials', '${T2}');`)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 5)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('след цены: имя файла без пробелов по краям, кто и когда; тендер — тендер цены, даже если передан другой', () => {
    const r = price(T1, 'Кран шаровой Ду15', 100)
    trace(U.supply, T2, r, DOC_A, '  Счёт ЭТМ 123.pdf  ', 100)
    const d = row(`rate_id = '${r}'`)
    assert.deepEqual([d.doc_name, d.removed_by, d.tender_id, d.doc_id, Number(d.price)], ['Счёт ЭТМ 123.pdf', U.supply, T1, DOC_A, 100])
    assert.ok(Date.now() - new Date(d.removed_at).getTime() < 600000)
  })

  it('одна цена — один след: удалили следующий файл — замена той же строки', () => {
    const r = sql(`select id from public.tender_vor_supply_rates where tender_id = '${T1}' and material_name = 'Кран шаровой Ду15'`)
    const id = row(`rate_id = '${r}'`).id
    trace(U.tender, T1, r, DOC_B, 'КП Мегастрой.xlsx', 120)
    assert.equal(count(`rate_id = '${r}'`), '1')
    const d = row(`id = '${id}'`)
    assert.deepEqual([d.doc_id, d.doc_name, Number(d.price), d.removed_by], [DOC_B, 'КП Мегастрой.xlsx', 120, U.tender])
  })

  it('цены нет, пустое имя файла, имя длиннее 500 знаков, цена меньше нуля — отказ базы', () => {
    const r = price(T1, 'Проверка ограничений', 10)
    assert.throws(() => trace(U.supply, T1, '00000000-0000-4000-8000-0000000000aa', DOC_A, 'Файл.pdf', 10), /foreign key|внешнего ключа/)
    for (const bad of ['', '   ', 'я'.repeat(501)]) {
      assert.throws(() => trace(U.supply, T1, r, DOC_A, bad, 10), /check constraint|нарушает ограничение|violates/, String(bad.length))
    }
    assert.throws(() => trace(U.supply, T1, r, DOC_A, 'Файл.pdf', -1), /check constraint|нарушает ограничение|violates/)
    trace(U.supply, T1, r, DOC_A, 'я'.repeat(500), 0)
    sql(`delete from public.tender_vor_supply_rates where id = '${r}'`)
  })

  it('цену очистили — след ушёл сам; правка цены след не трогает (страница сравнивает цену)', () => {
    const gone = price(T1, 'Хомут монтажный', 50)
    const kept = price(T1, 'Манометр', 300)
    trace(U.supply, T1, gone, DOC_A, 'Счёт.pdf', 50)
    trace(U.supply, T1, kept, DOC_A, 'Счёт.pdf', 300)
    as(U.supply, `delete from public.tender_vor_supply_rates where id = '${gone}'`)
    assert.equal(count(`rate_id = '${gone}'`), '0')
    as(U.supply, `update public.tender_vor_supply_rates set input_value = 350 where id = '${kept}'`)
    assert.equal(Number(row(`rate_id = '${kept}'`).price), 300)
  })

  it('права: читают сотрудники, пишут только правка «Тендеры» / «Тендеры на материалы»; подрядчику — ничего', () => {
    const n = count(`tender_id = '${T1}'`)
    const mine = `select count(*) from public.tender_supply_removed_docs where tender_id = '${T1}'`
    for (const u of [U.supply, U.tender, U.viewer, U.none, U.admin]) assert.equal(as(u, mine), n)
    assert.equal(as(U.contractor, mine), '0')
    const r = price(T1, 'Чужая запись', 10)
    for (const u of [U.viewer, U.none, U.contractor]) {
      assert.throws(() => trace(u, T1, r, DOC_A, 'Файл.pdf', 10), /row-level security/)
      assert.equal(as(u, `with x as (update public.tender_supply_removed_docs set doc_name = 'Чужое' where tender_id = '${T1}' returning 1)
        select count(*) from x`), '0')
      assert.equal(as(u, `with x as (delete from public.tender_supply_removed_docs where tender_id = '${T1}' returning 1) select count(*) from x`), '0')
    }
    assert.equal(count(`tender_id = '${T1}'`), n)
    // «Оставить цены» — след убирает тот, кто вводит цены.
    trace(U.supply, T1, r, DOC_A, 'Файл.pdf', 10)
    assert.equal(as(U.tender, `with x as (delete from public.tender_supply_removed_docs where rate_id = '${r}' returning 1) select count(*) from x`), '1')
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where id = '${r}'`), '1', 'цена на месте')
  })

  it('тендер на материалы «Завершён» — только чтение; «Не требуется» не закрывает; удаление тендера проходит', () => {
    const r = price(T2, 'Кабель ВВГнг 3×2,5', 90)
    const r2 = price(T2, 'Щит ЩР', 5000)
    trace(U.supply, T2, r, DOC_A, 'Счёт.pdf', 90)
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    assert.throws(() => trace(U.supply, T2, r2, DOC_A, 'Счёт.pdf', 5000), /только для чтения/)
    assert.throws(() => as(U.tender, `update public.tender_supply_removed_docs set price = 1 where tender_id = '${T2}'`), /только для чтения/)
    assert.throws(() => as(U.admin, `delete from public.tender_supply_removed_docs where tender_id = '${T2}'`), /только для чтения/)
    sql(`update public.tenders set status = 'Не требуется' where id = '${M2}'`)
    trace(U.supply, T2, r2, DOC_A, 'Счёт.pdf', 5000)
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    sql(`delete from public.tenders where id = '${T2}'`)
    assert.equal(count(`tender_id = '${T2}'`), '0')
  })

  it('аварийный откат применяется и повторяется; цены на месте; миграция ложится снова', () => {
    const rates = sql('select count(*) from public.tender_vor_supply_rates')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select to_regclass('public.tender_supply_removed_docs') is null`), 't')
    assert.equal(sql('select count(*) from public.tender_vor_supply_rates'), rates)
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    // Цена без таблицы следов очищается, как раньше.
    const r = price(T1, 'После отката', 10)
    as(U.supply, `delete from public.tender_vor_supply_rates where id = '${r}'`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.viewer, 'select count(*) from public.tender_supply_removed_docs'), '0')
  })
})

it('файлы миграций, проверки и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
