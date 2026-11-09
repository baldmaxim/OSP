// Комментарии к расценкам позиций снабжением (миграция 20270105_supply_rate_comments) — на слепке схемы прода после
// расценки (20261020 и следующие): права как у цен, закрытие после «Завершён», один комментарий на позицию тендера
// (замена по ключу наименования, как upsert страницы), пустой и длиннее 2000 знаков — отказ, каскад удаления тендера,
// проверка для прода (до миграции — FAIL, а не ошибка) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270105_supply_rate_comments'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270105.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  admin: '00000000-0000-4000-8000-00000000c2a1',
  supply: '00000000-0000-4000-8000-00000000c2b1',
  tender: '00000000-0000-4000-8000-00000000c2b2',
  viewer: '00000000-0000-4000-8000-00000000c2b3',
  none: '00000000-0000-4000-8000-00000000c2b4',
  contractor: '00000000-0000-4000-8000-00000000c2b5',
}
const OBJ = '00000000-0000-4000-8000-00000000d201'
const T1 = '00000000-0000-4000-8000-00000000e201'
const M1 = '00000000-0000-4000-8000-00000000e211'
const T2 = '00000000-0000-4000-8000-00000000e202'
const M2 = '00000000-0000-4000-8000-00000000e212'

describe('Комментарии к расценкам снабжения: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  // Как upsert страницы (PostgREST on_conflict по ключу позиции).
  const upsert = (uid, tender, name, comment) => as(uid, `insert into public.tender_supply_comments (tender_id, material_name, comment)
    values ('${tender}', '${name}', '${comment.replace(/'/g, "''")}')
    on conflict (tender_id, material_key) do update set material_name = excluded.material_name, comment = excluded.comment`)
  const row = (where) => JSON.parse(sql(`select row_to_json(c) from public.tender_supply_comments c where ${where}`) || 'null')

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    // Кандидаты до этой миграции (в том числе расценка 20261020 — она нужна: ключ наименования, право записи, закрытие).
    const candidates = candidateMigrations()
    for (const m of candidates.slice(0, candidates.findIndex((c) => c.startsWith(NAME)))) {
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('c_supply', 'Тест: снабжение', false), ('c_tender', 'Тест: тендерный отдел', false),
        ('c_viewer', 'Тест: просмотр материалов', false), ('c_none', 'Тест: без разделов', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('c_supply', 'tenders_materials', true, true),
        ('c_tender', 'tenders', true, true),
        ('c_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a201', 'ООО Тест комментариев');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
        ('${U.supply}', 'c_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 'c_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 'c_viewer', true, false, 'Смотров В. В.', null),
        ('${U.none}', 'c_none', true, false, 'Безразделов Б. Б.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a201');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Комментарии', 'Москва');
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
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('комментарий к позиции без цены: без пробелов по краям, кто изменил, ключ наименования как у цен', () => {
    upsert(U.supply, T1, 'Кран шаровой Ду15', '  Цена по счёту ЭТМ, доставка отдельно  ')
    const c = row(`tender_id = '${T1}'`)
    assert.equal(c.comment, 'Цена по счёту ЭТМ, доставка отдельно')
    assert.equal(c.updated_by, U.supply)
    assert.equal(c.material_key, sql(`select public.supply_norm_name('Кран шаровой Ду15')`))
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}'`), '0', 'цены нет')
  })

  it('один комментарий на позицию тендера: тот же ключ (другое написание) — замена той же строки', () => {
    const id = row(`tender_id = '${T1}'`).id
    upsert(U.tender, T1, 'КРАН шаровой  Ду15', 'Брать у Мегастрой')
    assert.equal(sql(`select count(*) from public.tender_supply_comments where tender_id = '${T1}'`), '1')
    const c = row(`id = '${id}'`)
    assert.equal(c.comment, 'Брать у Мегастрой')
    assert.equal(c.updated_by, U.tender)
  })

  it('пустой и длиннее 2000 знаков — отказ базы', () => {
    for (const bad of ['', '   ', 'я'.repeat(2001)]) {
      assert.throws(() => upsert(U.supply, T1, `Проверка ${bad.length}`, bad), /check constraint|нарушает ограничение|violates/, String(bad.length))
    }
    upsert(U.supply, T1, 'Ровно 2000', 'я'.repeat(2000))
    sql(`delete from public.tender_supply_comments where material_name = 'Ровно 2000'`)
  })

  it('права: читают сотрудники, пишут только правка «Тендеры» / «Тендеры на материалы»; подрядчику — ничего', () => {
    const count = `select count(*) from public.tender_supply_comments where tender_id = '${T1}'`
    for (const u of [U.supply, U.tender, U.viewer, U.none, U.admin]) assert.equal(as(u, count), '1')
    assert.equal(as(U.contractor, count), '0')
    for (const u of [U.viewer, U.none, U.contractor]) {
      assert.throws(() => upsert(u, T1, `Чужое ${u}`, 'Комментарий'), /row-level security/)
      assert.equal(as(u, `with x as (update public.tender_supply_comments set comment = 'Чужое' where tender_id = '${T1}' returning 1)
        select count(*) from x`), '0')
      assert.equal(as(u, `with x as (delete from public.tender_supply_comments where tender_id = '${T1}' returning 1) select count(*) from x`), '0')
    }
    assert.equal(row(`tender_id = '${T1}'`).comment, 'Брать у Мегастрой')
    // Удаляет тот, кто вводит цены (так страница убирает пустой комментарий).
    upsert(U.supply, T1, 'Хомут монтажный', 'Со склада объекта')
    assert.equal(as(U.supply, `with x as (delete from public.tender_supply_comments where tender_id = '${T1}' and material_name = 'Хомут монтажный' returning 1)
      select count(*) from x`), '1')
  })

  it('тендер на материалы «Завершён» — только чтение; «Не требуется» не закрывает; удаление тендера проходит', () => {
    upsert(U.supply, T2, 'Кабель ВВГнг 3×2,5', 'Цена за бухту 100 м')
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    assert.throws(() => upsert(U.supply, T2, 'Щит', 'Новый'), /только для чтения/)
    assert.throws(() => as(U.tender, `update public.tender_supply_comments set comment = 'Иначе' where tender_id = '${T2}'`), /только для чтения/)
    assert.throws(() => as(U.admin, `delete from public.tender_supply_comments where tender_id = '${T2}'`), /только для чтения/)
    sql(`update public.tenders set status = 'Не требуется' where id = '${M2}'`)
    upsert(U.supply, T2, 'Щит', 'Новый')
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    sql(`delete from public.tenders where id = '${T2}'`)
    assert.equal(sql(`select count(*) from public.tender_supply_comments where tender_id = '${T2}'`), '0')
  })

  it('аварийный откат применяется и повторяется; комментарии остаются; миграция ложится снова', () => {
    const n = sql('select count(*) from public.tender_supply_comments')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_supply_comments'), n)
    assert.throws(() => as(U.supply, 'select count(*) from public.tender_supply_comments'), /permission denied/)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.viewer, 'select count(*) from public.tender_supply_comments'), n)
  })
})

it('файлы миграций, проверки и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
