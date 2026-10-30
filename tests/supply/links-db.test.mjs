// Ссылки на документы к позициям расценки снабжением (миграция 20261022_supply_links) — на слепке схемы прода
// после 20261020: права как у цен, закрытие после «Завершён», проверка адреса, одна ссылка на позицию (замена
// по ключу наименования, как upsert страницы), перенос ВОР вместе со ссылками, каскад удаления тендера,
// проверка для прода (до миграции — FAIL, а не ошибка) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const PRICING = path.join(ROOT, 'supabase', 'migrations', '20261020_supply_pricing.sql')
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261022_supply_links.sql')
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261022.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20261022_supply_links_rollback.sql')
const skip = skipReason()

const U = {
  admin: '00000000-0000-4000-8000-00000000c1a1',
  supply: '00000000-0000-4000-8000-00000000c1b1',
  tender: '00000000-0000-4000-8000-00000000c1b2',
  viewer: '00000000-0000-4000-8000-00000000c1b3',
  none: '00000000-0000-4000-8000-00000000c1b4',
  contractor: '00000000-0000-4000-8000-00000000c1b5',
}
const OBJ = '00000000-0000-4000-8000-00000000d101'
const T1 = '00000000-0000-4000-8000-00000000e101'
const M1 = '00000000-0000-4000-8000-00000000e111'
const T2 = '00000000-0000-4000-8000-00000000e102'
const M2 = '00000000-0000-4000-8000-00000000e112'

describe('Ссылки на документы к позициям расценки: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  // Как upsert страницы (PostgREST on_conflict по ключу позиции).
  const upsert = (uid, tender, doc, name, url) => as(uid, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, url)
    values ('${tender}', '${doc}', '${name}', '${url.replace(/'/g, "''")}')
    on conflict (tender_id, estimate_name, material_key) do update set material_name = excluded.material_name, url = excluded.url`)
  const link = (where) => JSON.parse(sql(`select row_to_json(l) from public.tender_supply_links l where ${where}`) || 'null')

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (/^2026(102[02359]|1120)_/.test(m)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    psqlAt(db.port, null, { file: PRICING })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('l_supply', 'Тест: снабжение', false), ('l_tender', 'Тест: тендерный отдел', false),
        ('l_viewer', 'Тест: просмотр материалов', false), ('l_none', 'Тест: без разделов', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('l_supply', 'tenders_materials', true, true),
        ('l_tender', 'tenders', true, true),
        ('l_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a101', 'ООО Тест ссылок');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
        ('${U.supply}', 'l_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 'l_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 'l_viewer', true, false, 'Смотров В. В.', null),
        ('${U.none}', 'l_none', true, false, 'Безразделов Б. Б.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a101');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Ссылки', 'Москва');
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

  it('ссылка к позиции без цены: адрес без пробелов по краям, кто изменил, ключ наименования как у цен', () => {
    upsert(U.supply, T1, 'ОВ', 'Кран шаровой Ду15', '  https://disk.example.ru/d/chek-1  ')
    const l = link(`tender_id = '${T1}'`)
    assert.equal(l.url, 'https://disk.example.ru/d/chek-1')
    assert.equal(l.updated_by, U.supply)
    assert.equal(l.material_key, sql(`select public.supply_norm_name('Кран шаровой Ду15')`))
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T1}'`), '0', 'цены нет')
  })

  it('одна ссылка на позицию: тот же ключ (другое написание) — замена той же строки', () => {
    const id = link(`tender_id = '${T1}'`).id
    upsert(U.tender, T1, 'ОВ', 'КРАН шаровой  Ду15', '\\\\su10-fs\\Снабжение\\Счёт 15.pdf')
    assert.equal(sql(`select count(*) from public.tender_supply_links where tender_id = '${T1}'`), '1')
    const l = link(`id = '${id}'`)
    assert.equal(l.url, '\\\\su10-fs\\Снабжение\\Счёт 15.pdf')
    assert.equal(l.updated_by, U.tender)
  })

  it('неверный адрес — отказ базы (javascript:, ftp, пустой, без адреса после схемы)', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://example.ru/x', '   ', 'https://', 'disk.example.ru/x']) {
      assert.throws(() => upsert(U.supply, T1, 'ОВ', `Проверка ${bad}`, bad), /check constraint|нарушает ограничение|violates/, bad)
    }
  })

  it('права: читают сотрудники, пишут только правка «Тендеры» / «Тендеры на материалы»; подрядчику — ничего', () => {
    const count = `select count(*) from public.tender_supply_links where tender_id = '${T1}'`
    for (const u of [U.supply, U.tender, U.viewer, U.none, U.admin]) assert.equal(as(u, count), '1')
    assert.equal(as(U.contractor, count), '0')
    for (const u of [U.viewer, U.none, U.contractor]) {
      assert.throws(() => upsert(u, T1, 'ОВ', `Чужое ${u}`, 'https://example.ru/x'), /row-level security/)
      assert.equal(as(u, `with x as (update public.tender_supply_links set url = 'https://example.ru/y' where tender_id = '${T1}' returning 1)
        select count(*) from x`), '0')
      assert.equal(as(u, `with x as (delete from public.tender_supply_links where tender_id = '${T1}' returning 1) select count(*) from x`), '0')
    }
  })

  it('перенос ВОР на другое имя переносит ссылки; пересечение ссылок — отказ целиком', () => {
    const res = JSON.parse(as(U.tender, `select public.supply_estimate_rename('${T1}', 'ОВ', 'ОВ-1')`))
    assert.deepEqual(res, { rates: 0, sources: 0, links: 1 })
    upsert(U.supply, T1, 'ВК', 'Кран шаровой Ду15', 'https://example.ru/vk')
    assert.throws(() => as(U.tender, `select public.supply_estimate_rename('${T1}', 'ВК', 'ОВ-1')`), /уже есть ссылки/)
    assert.equal(sql(`select count(*) from public.tender_supply_links where tender_id = '${T1}' and estimate_name = 'ВК'`), '1')
  })

  it('тендер на материалы «Завершён» — ссылки только для чтения; «Не требуется» не закрывает; удаление тендера проходит', () => {
    upsert(U.supply, T2, 'ЭОМ', 'Кабель ВВГнг 3×2,5', 'https://example.ru/kabel')
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    assert.throws(() => upsert(U.supply, T2, 'ЭОМ', 'Щит', 'https://example.ru/shit'), /только для чтения/)
    assert.throws(() => as(U.tender, `update public.tender_supply_links set url = 'https://example.ru/z' where tender_id = '${T2}'`), /только для чтения/)
    assert.throws(() => as(U.admin, `delete from public.tender_supply_links where tender_id = '${T2}'`), /только для чтения/)
    sql(`update public.tenders set status = 'Не требуется' where id = '${M2}'`)
    upsert(U.supply, T2, 'ЭОМ', 'Щит', 'https://example.ru/shit')
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    sql(`delete from public.tenders where id = '${T2}'`)
    assert.equal(sql(`select count(*) from public.tender_supply_links where tender_id = '${T2}'`), '0')
  })

  it('аварийный откат применяется и повторяется; ссылки остаются; миграция ложится снова', () => {
    const n = sql('select count(*) from public.tender_supply_links')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_supply_links'), n)
    assert.throws(() => as(U.supply, 'select count(*) from public.tender_supply_links'), /permission denied/)
    assert.deepEqual(JSON.parse(as(U.tender, `select public.supply_estimate_rename('${T1}', 'нет такого', 'тоже нет')`)), { rates: 0, sources: 0 })
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.viewer, 'select count(*) from public.tender_supply_links'), n)
  })
})

it('файлы миграций, проверки и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', '20261022_supply_links.sql'),
    path.join(ROOT, 'migration', 'yandex', '20261022_supply_links.check.sql')]) assert.ok(fs.existsSync(f), f)
})
