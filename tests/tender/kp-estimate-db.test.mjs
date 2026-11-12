// Смета КП / ПЗ объекта (миграция 20270215), база. Первый блок — слепок схемы прода (Supabase): проверка для прода до
// миграции — FAIL, а не ошибка; черновик → строки → действующая версия; отметка и распределение получают смету и объект
// от строки (подменить объект нельзя), кто и когда, версию строки; история «было / стало» — только триггером; объём —
// только у строк с единицей, распределение — только у позиции; та же пара «тендер + подрядчик» второй раз — отказ;
// строки сметы и история вошедшим не переписать; просмотр — право «Объекты», правка — «Смета КП/ПЗ», чужой объект и
// подрядчик — ничего; новая версия переносит отметки, распределения и историю по ключу строки, остальное — у прежней
// (её править нельзя); действующую удаляет только администратор (с историей); откат и повтор. Второй блок — копия прода
// как база Яндекса: настоящий migrate.sh с проверкой прав под одну учётку и те же правила от имени вошедшего.
// Страница — kp-estimate.test.mjs. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20270215_kp_estimate'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270215.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  economist: '00000000-0000-4000-8000-00000000ea01',
  engineer: '00000000-0000-4000-8000-00000000ea02',
  contractor: '00000000-0000-4000-8000-00000000ea03',
  admin: '00000000-0000-4000-8000-00000000ea04',
  scoped: '00000000-0000-4000-8000-00000000ea05',
}
const CP = '00000000-0000-4000-8000-00000000eb01'
const OBJ = '00000000-0000-4000-8000-00000000ec01'
const OBJ2 = '00000000-0000-4000-8000-00000000ec02'
const EST = '00000000-0000-4000-8000-00000000ed01'
const EST2 = '00000000-0000-4000-8000-00000000ed02'
const R = (n, est = EST) => `00000000-0000-4000-8000-0000000${est === EST ? 'e' : 'f'}e${String(n).padStart(3, '0')}`

const draft = (id, title) => `insert into public.kp_estimates (id, object_id, status, title, row_count, meta) values ('${id}', '${OBJ}', 'draft', '${title}', 3, '{}')`
// Раздел, позиция «Стена», позиция «Плита» (во второй версии — «Плита (новая)»: другой ключ).
const rowsOf = (est, slabName = 'Плита') => `insert into public.kp_estimate_rows (id, estimate_id, object_id, row_no, parent_row_no, level, kind, row_key, code, pos_no, name, unit, kp, pz) values
  ('${R(1, est)}', '${est}', '${OBJ2}', 1, null, 1, 'section', 'p:2|раздел 2', '2', '2', 'Раздел 2', null, null, null),
  ('${R(2, est)}', '${est}', '${OBJ2}', 2, 1, 2, 'position', 'p:3|стена', '2.1', '3', 'Стена', 'м3', '{"qty_gp": 200, "total": 1000}', '{"direct": 900}'),
  ('${R(3, est)}', '${est}', '${OBJ2}', 3, 1, 2, 'position', 'p:4|${slabName.toLowerCase()}', '2.2', '4', '${slabName}', 'м3', '{"qty_gp": 300, "total": 3000}', '{"direct": 2700}')`

describe('Смета КП / ПЗ — база (слепок схемы прода)', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(`
      insert into public.roles (key, label, is_system) values ('economist', 'Экономист ОСП', true), ('engineer', 'Инженер ОСП', true)
        on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values ('engineer', 'objects', true, false)
        on conflict (role, section) do update set can_view = true, can_edit = false;
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Смета');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
        ('${U.economist}', 'economist', true, false, 'Экономова Е. Е.', 'e@example.invalid', null, '{}'),
        ('${U.engineer}', 'engineer', true, false, 'Инженеров И. И.', 'i@example.invalid', null, '{}'),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}', '{}'),
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid', null, '{}'),
        ('${U.scoped}', 'economist', true, false, 'Чужой Ч. Ч.', 's@example.invalid', null, array['${OBJ2}']::uuid[]);
      insert into public.objects (id, name, address, status) values
        ('${OBJ}', 'ЖК Пример', 'Москва', 'main_construction'), ('${OBJ2}', 'ЖК Другой', 'Москва', 'main_construction');`)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор безопасен; право — у экономиста ОСП', () => {
    assert.match(checkBefore, /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
    assert.equal(sql(`select can_view and can_edit from public.role_permissions where role = 'economist' and section = 'kp_estimate'`), 't')
  })

  it('черновик → строки (объект — от сметы) → действующая; пишет только право правки сметы', () => {
    assert.throws(() => as(U.engineer, draft(EST, 'К1')), /row-level security/)
    assert.throws(() => as(U.economist, `insert into public.kp_estimates (object_id, status, title) values ('${OBJ}', 'active', 'x')`), /kp_estimate_insert_draft/)
    as(U.economist, draft(EST, 'К1'))
    as(U.economist, rowsOf(EST))
    assert.equal(sql(`select string_agg(distinct object_id::text, ',') from public.kp_estimate_rows where estimate_id = '${EST}'`), OBJ, 'объект строки — от сметы')
    assert.equal(sql(`select created_by_name from public.kp_estimates where id = '${EST}'`), 'Экономова Е. Е.')
    const res = JSON.parse(as(U.economist, `select public.kp_estimate_activate('${EST}')`))
    assert.equal(res.rows, 3)
    assert.equal(res.previous_id, null)
    assert.equal(sql(`select status from public.kp_estimates where id = '${EST}'`), 'active')
    assert.throws(() => as(U.economist, `select public.kp_estimate_activate('${EST}')`), /kp_estimate_not_draft/)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_rows (estimate_id, object_id, row_no, level, kind, row_key, name) values ('${EST}', '${OBJ}', 9, 1, 'note', 'x', 'x')`), /kp_estimate_rows_locked/)
    assert.throws(() => as(U.economist, `update public.kp_estimates set title = 'Другое' where id = '${EST}'`), /kp_estimate_locked/)
  })

  it('отметка: смета и объект — от строки, кто, версия; история «было / стало»; объём — только у строки с единицей', () => {
    as(U.economist, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, note, actual_qty) values ('${EST}', '${OBJ2}', '${R(2)}', '  Проверить  ', 180)`)
    assert.equal(sql(`select object_id || '|' || note || '|' || actual_qty || '|' || row_version || '|' || updated_by_name from public.kp_estimate_marks where row_id = '${R(2)}'`),
      `${OBJ}|Проверить|180|1|Экономова Е. Е.`)
    as(U.economist, `update public.kp_estimate_marks set fill = '#fff3bf', note = 'Проверено' where row_id = '${R(2)}' and row_version = 1`)
    assert.equal(sql(`select row_version from public.kp_estimate_marks where row_id = '${R(2)}'`), '2')
    assert.equal(as(U.economist, `update public.kp_estimate_marks set note = 'старая версия' where row_id = '${R(2)}' and row_version = 1 returning id`), '', 'устаревшая версия — 0 строк')
    const log = sql(`select action || ':' || (changes ? 'note') || ':' || coalesce(changes -> 'note' ->> 'old', '-') || '>' || (changes -> 'note' ->> 'new') || ':' || changed_by_name
      from public.kp_estimate_log where row_id = '${R(2)}' order by id`).split('\n')
    assert.deepEqual(log, ['insert:true:->Проверить:Экономова Е. Е.', 'update:true:Проверить>Проверено:Экономова Е. Е.'])
    assert.equal(sql(`select row_label from public.kp_estimate_log where row_id = '${R(2)}' limit 1`), '2.1 Стена')
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, actual_qty) values ('${EST}', '${OBJ}', '${R(1)}', 5)`), /kp_estimate_no_volume/)
  })

  it('распределение: только позиция; пара «тендер + подрядчик» одна; кто добавил', () => {
    as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label, pz_qty, counterparty_id, counterparty_name, contract_qty)
      values ('${EST}', '${OBJ}', '${R(2)}', '№ 501', 120, '${CP}', 'ООО Смета', 100)`)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label, pz_qty, counterparty_id)
      values ('${EST}', '${OBJ}', '${R(2)}', ' № 501 ', 10, '${CP}')`), /kp_estimate_allocations_pair/)
    as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label, pz_qty) values ('${EST}', '${OBJ}', '${R(2)}', '№ 502', 30)`)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label) values ('${EST}', '${OBJ}', '${R(1)}', '№ 1')`), /kp_estimate_not_position/)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, pz_qty) values ('${EST}', '${OBJ}', '${R(2)}', 1)`), /kp_estimate_allocations_target/)
    assert.equal(sql(`select created_by_name from public.kp_estimate_allocations where tender_label = '№ 502'`), 'Экономова Е. Е.')
    assert.equal(sql(`select count(*) from public.kp_estimate_log where entity = 'allocation' and changes -> '_allocation' ->> 'tender' = '№ 501'`), '1')
  })

  it('права: строки и историю не переписать; «Объекты» — только смотреть; чужой объект и подрядчик — ничего', () => {
    assert.throws(() => as(U.economist, `update public.kp_estimate_rows set name = 'x' where id = '${R(2)}'`), /permission denied/)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_log (estimate_id, object_id, entity, action) values ('${EST}', '${OBJ}', 'mark', 'insert')`), /permission denied/)
    assert.throws(() => as(U.economist, `delete from public.kp_estimate_log`), /permission denied/)
    assert.equal(as(U.engineer, `select count(*) from public.kp_estimate_rows where estimate_id = '${EST}'`), '3')
    assert.equal(as(U.engineer, `select count(*) from public.kp_estimate_log where estimate_id = '${EST}'`), sql(`select count(*) from public.kp_estimate_log where estimate_id = '${EST}'`))
    assert.equal(as(U.engineer, `update public.kp_estimate_marks set note = 'инженер' returning id`), '')
    assert.throws(() => as(U.engineer, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, note) values ('${EST}', '${OBJ}', '${R(3)}', 'x')`), /row-level security/)
    assert.equal(as(U.contractor, 'select count(*) from public.kp_estimate_rows'), '0')
    assert.equal(as(U.scoped, 'select count(*) from public.kp_estimates'), '0', 'не его объект')
    assert.throws(() => as(U.scoped, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, note) values ('${EST}', '${OBJ2}', '${R(3)}', 'x')`), /row-level security|не найдена/)
    assert.throws(() => psqlAt(db.port, `begin; set local role anon; select count(*) from public.kp_estimate_rows; commit;`), /permission denied/)
  })

  it('новая версия: перенос по ключу строки (с историей), остальное — у прежней, её не править; удаляет действующую только администратор', () => {
    as(U.economist, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, note) values ('${EST}', '${OBJ}', '${R(3)}', 'Плита: уточнить')`)
    as(U.economist, draft(EST2, 'К1 v2'))
    as(U.economist, rowsOf(EST2, 'Плита (новая)'))
    const res = JSON.parse(as(U.economist, `select public.kp_estimate_activate('${EST2}')`))
    assert.deepEqual([res.previous_id, res.moved_marks, res.moved_allocations, res.left_marks, res.left_allocations], [EST, 1, 2, 1, 0])
    assert.equal(sql(`select status from public.kp_estimates where id = '${EST}'`), 'archived')
    assert.equal(sql(`select row_id || '|' || row_version || '|' || note from public.kp_estimate_marks where estimate_id = '${EST2}'`), `${R(2, EST2)}|2|Проверено`, 'перенос не меняет отметку')
    assert.ok(Number(sql(`select count(*) from public.kp_estimate_log where estimate_id = '${EST2}' and row_id = '${R(2, EST2)}'`)) >= 4, 'история перешла со строкой')
    assert.equal(sql(`select count(*) from public.kp_estimate_log where estimate_id = '${EST2}' and entity = 'estimate' and action = 'activate'`), '1')
    assert.throws(() => as(U.economist, `update public.kp_estimate_marks set note = 'x' where row_id = '${R(3)}'`), /kp_estimate_not_active/)
    assert.equal(as(U.economist, `delete from public.kp_estimates where id = '${EST2}' returning id`), '', 'экономист действующую не удаляет')
    as(U.admin, `delete from public.kp_estimates where id = '${EST}'`)
    assert.equal(sql(`select count(*) from public.kp_estimate_log where estimate_id = '${EST}'`), '0', 'история удалённой версии ушла с ней')
    assert.equal(sql(`select count(*) from public.kp_estimate_marks where estimate_id = '${EST2}'`), '1', 'действующая не задета')
  })

  it('откат: права у вошедших сняты, данные на месте; повтор миграции возвращает', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    assert.throws(() => as(U.economist, 'select count(*) from public.kp_estimate_rows'), /permission denied/)
    assert.equal(sql('select count(*) from public.kp_estimate_rows'), '3')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

describe('Смета КП / ПЗ — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-kpe-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 25 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout.slice(-4000) + res.stderr.slice(-4000))
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(`
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Смета');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
        ('${U.economist}', 'economist', true, false, 'Экономова Е. Е.', 'e@example.invalid', null),
        ('${U.engineer}', 'engineer', true, false, 'Инженеров И. И.', 'i@example.invalid', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Пример', 'Москва', 'main_construction');
      insert into public.role_permissions (role, section, can_view, can_edit) values ('engineer', 'objects', true, false)
        on conflict (role, section) do update set can_view = true, can_edit = false;
      insert into public.role_permissions (role, section, can_view, can_edit) values ('engineer', 'kp_estimate', false, false)
        on conflict (role, section) do update set can_view = false, can_edit = false;`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK; право — у экономиста ОСП', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 9, out)
    assert.equal(as(U.economist, `select public.kp_estimate_can('edit')`), 't')
    assert.equal(as(U.engineer, `select public.kp_estimate_can('edit')::text || public.kp_estimate_can('view')::text`), 'falsetrue')
  })

  it('экономист загружает и отмечает; история от его имени; инженер смотрит; подрядчик и гость — ничего', () => {
    as(U.economist, draft(EST, 'К1'))
    as(U.economist, rowsOf(EST))
    assert.equal(as(U.economist, `select public.kp_estimate_activate('${EST}') ->> 'rows'`), '3')
    as(U.economist, `insert into public.kp_estimate_marks (estimate_id, object_id, row_id, note, actual_qty) values ('${EST}', '${OBJ}', '${R(2)}', 'Проверить', 180)`)
    as(U.economist, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label, pz_qty) values ('${EST}', '${OBJ}', '${R(2)}', '№ 501', 120)`)
    assert.equal(internal(`select string_agg(entity || ':' || changed_by_name, ',' order by id) from public.kp_estimate_log where estimate_id = '${EST}'`),
      'estimate:Экономова Е. Е.,mark:Экономова Е. Е.,allocation:Экономова Е. Е.')
    assert.equal(as(U.engineer, `select count(*) from public.kp_estimate_marks`), '1')
    assert.equal(as(U.engineer, `update public.kp_estimate_marks set note = 'x' returning id`), '')
    assert.throws(() => as(U.engineer, `insert into public.kp_estimate_allocations (estimate_id, object_id, row_id, tender_label) values ('${EST}', '${OBJ}', '${R(3)}', '№ 1')`), /row-level security/)
    assert.throws(() => as(U.economist, `insert into public.kp_estimate_log (estimate_id, object_id, entity, action) values ('${EST}', '${OBJ}', 'mark', 'insert')`), /row-level security/)
    assert.equal(as(U.economist, `update public.kp_estimate_rows set name = 'x' returning id`), '')
    assert.equal(as(U.contractor, 'select count(*) from public.kp_estimate_rows'), '0')
    assert.equal(as(null, 'select count(*) from public.kp_estimates'), '0')
  })
})
