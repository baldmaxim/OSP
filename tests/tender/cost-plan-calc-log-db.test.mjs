// «Расчёт ПЗ»: журнал файлов и право экономиста ОСП (миграция 20261130), на слепке схемы прода: проверка до миграции —
// FAIL, а не ошибка; журнал пишет триггер при любом способе записи и переживает файл и объект; подделать, поправить или
// стереть запись нельзя никому; другие файлы в журнал не попадают; уже прикреплённые файлы — в журнале; экономист ОСП
// получает право, ручную настройку повтор миграции не трогает; откат оставляет записи. Второй блок — то же на копии прода
// как база Яндекса (одна учётка, настоящий migrate.sh с проверками прав). Страница — cost-plan-calc.test.mjs, сервер
// файлов — tests/osp-api/server.test.mjs. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20261130_cost_plan_calc_file_log'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261130.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  economist: '00000000-0000-4000-8000-0000000e1a01',
  engineer: '00000000-0000-4000-8000-0000000e1a02',
  contractor: '00000000-0000-4000-8000-0000000e1a03',
  admin: '00000000-0000-4000-8000-0000000e1a04',
}
const CP = '00000000-0000-4000-8000-0000000e2a01'
const OBJ = '00000000-0000-4000-8000-0000000e3a01'
const ANCHOR = '00000000-0000-4000-8000-0000000e4a01'
const DOC = (n) => `00000000-0000-4000-8000-0000000e5${String(n).padStart(3, '0')}`

// Вставка файла так, как её делает osp-api (под токеном вошедшего).
const insertFile = (n, category, { owner = OBJ, ownerType = 'object', name = `Файл ${n}.pdf` } = {}) =>
  `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category)
   values ('${DOC(n)}', '${ownerType}', '${owner}', 'k/${DOC(n)}', '${name}', '${category}')`
const LOG_FIELDS = `action || '|' || file_name || '|' || coalesce(object_name, '-') || '|' || coalesce(changed_by::text, '-') || '|' || coalesce(changed_by_name, '-')`

describe('Журнал файлов «Расчёта ПЗ» — база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const logOf = (n) => sql(`select ${LOG_FIELDS} from public.cost_plan_calc_file_log where document_id = '${DOC(n)}' order by id`)
    .split('\n').filter(Boolean)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(`
      -- В слепке схемы справочник ролей пуст, а право выдаётся только существующей роли.
      insert into public.roles (key, label, is_system) values ('economist', 'Экономист ОСП', true) on conflict (key) do nothing;
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Журнал');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
        ('${U.economist}', 'economist', true, false, ' Экономистова Э. Э. ', 'e@example.invalid', null),
        ('${U.engineer}', 'engineer', true, false, '  ', 'i@example.invalid', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}'),
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid', null);
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Журнальный', 'Москва', 'main_construction');
      -- Файл, прикреплённый до миграции: должен оказаться в журнале с датой и автором загрузки.
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, uploaded_by, uploaded_by_name, created_at)
        values ('${DOC(1)}', 'general', '${ANCHOR}', 'k/before', 'Инструкция.pdf', 'cost_plan_calc', '${U.admin}', 'Админов А. А.', '2026-10-29 10:00+03');`)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется, записи не двоятся', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 5)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
    assert.equal(sql(`select count(*) from public.cost_plan_calc_file_log where document_id = '${DOC(1)}'`), '1')
  })

  it('файлы, прикреплённые до миграции, — в журнале записью «прикреплён» с датой и автором загрузки', () => {
    assert.deepEqual(logOf(1), [`attach|Инструкция.pdf|-|${U.admin}|Админов А. А.`])
    assert.equal(sql(`select changed_at = '2026-10-29 10:00+03' from public.cost_plan_calc_file_log where document_id = '${DOC(1)}'`), 't')
  })

  it('прикрепил и открепил: кто, когда, объект, файл — от имени вошедшего, не из полей строки', () => {
    as(U.economist, `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, uploaded_by, uploaded_by_name)
      values ('${DOC(2)}', 'object', '${OBJ}', 'k/2', 'ПЗ.xlsx', 'cost_plan_direct_costs', '${U.admin}', 'Кто-то другой')`)
    assert.deepEqual(logOf(2), [`attach|ПЗ.xlsx|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`])
    assert.equal(sql(`select now() - changed_at < interval '1 minute' from public.cost_plan_calc_file_log where document_id = '${DOC(2)}'`), 't')

    as(U.engineer, `delete from public.s3_documents where id = '${DOC(2)}'`)
    // ФИО не заполнено — почта. Строки файла уже нет, запись осталась.
    assert.deepEqual(logOf(2), [
      `attach|ПЗ.xlsx|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`,
      `detach|ПЗ.xlsx|ЖК Журнальный|${U.engineer}|i@example.invalid`,
    ])
    assert.equal(sql(`select count(*) from public.s3_documents where id = '${DOC(2)}'`), '0')
  })

  it('все три категории — в журнале, другие файлы объекта — нет; служебная операция — без автора', () => {
    as(U.economist, insertFile(3, 'cost_plan_kp_before_transfers'))
    as(U.admin, insertFile(4, 'cost_plan_calc', { owner: ANCHOR, ownerType: 'general' }))
    as(U.economist, insertFile(5, 'dgp'))
    as(U.economist, insertFile(6, 'general'))
    assert.equal(logOf(3).length, 1)
    assert.deepEqual(logOf(4), [`attach|Файл 4.pdf|-|${U.admin}|Админов А. А.`])
    assert.deepEqual([logOf(5), logOf(6)], [[], []])
    sql(`delete from public.s3_documents where id = '${DOC(3)}'`)
    assert.equal(logOf(3)[1], 'detach|Файл 3.pdf|ЖК Журнальный|-|-')
    as(U.economist, `update public.s3_documents set notes = 'заметка', file_name = 'Новое имя.pdf' where id = '${DOC(4)}'`)
    assert.equal(logOf(4).length, 1, 'правка заметки и имени — не прикрепление')
  })

  it('перенос в категорию и из неё мимо журнала не пройдёт', () => {
    as(U.economist, `update public.s3_documents set doc_category = 'cost_plan_direct_costs' where id = '${DOC(5)}'`)
    assert.deepEqual(logOf(5), [`attach|Файл 5.pdf|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`])
    as(U.economist, `update public.s3_documents set doc_category = 'cost_plan_kp_before_transfers' where id = '${DOC(5)}'`)
    assert.equal(logOf(5).length, 3, 'смена вида: откреплён оттуда и прикреплён сюда')
    as(U.economist, `update public.s3_documents set doc_category = 'general' where id = '${DOC(5)}'`)
    assert.equal(logOf(5).at(-1), `detach|Файл 5.pdf|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`)
    // Вне журнала запись не появляется, и удаление такого файла уже не наше дело.
    as(U.economist, `delete from public.s3_documents where id = '${DOC(5)}'`)
    assert.equal(logOf(5).length, 4)
  })

  it('журнал не подделать, не поправить и не стереть: ни сотруднику, ни администратору, ни служебному ключу', () => {
    for (const uid of [U.economist, U.admin]) {
      assert.throws(() => as(uid, `insert into public.cost_plan_calc_file_log (action, document_id, file_name, owner_type, owner_id, doc_category)
        values ('attach', '${DOC(9)}', 'Подделка.pdf', 'object', '${OBJ}', 'cost_plan_direct_costs')`), /permission denied/)
      assert.throws(() => as(uid, `update public.cost_plan_calc_file_log set changed_by_name = 'Другой'`), /permission denied/)
      assert.throws(() => as(uid, 'delete from public.cost_plan_calc_file_log'), /permission denied/)
    }
    assert.throws(() => psqlAt(db.port, 'begin; set local role service_role; delete from public.cost_plan_calc_file_log; commit;'), /permission denied/)
    assert.equal(sql(`select count(*) from public.cost_plan_calc_file_log where file_name = 'Подделка.pdf'`), '0')
  })

  it('читает сотрудник; подрядчику строк нет, гостю закрыто; функцию триггера напрямую не вызвать', () => {
    assert.ok(Number(as(U.engineer, 'select count(*) from public.cost_plan_calc_file_log')) > 0)
    assert.equal(as(U.contractor, 'select count(*) from public.cost_plan_calc_file_log'), '0')
    assert.throws(() => psqlAt(db.port, 'begin; set local role anon; select count(*) from public.cost_plan_calc_file_log; commit;'), /permission denied/)
    assert.throws(() => as(U.economist, 'select public.cost_plan_calc_file_log_write()'), /permission denied|trigger functions can only be called/)
    assert.equal(sql(`select has_function_privilege('authenticated', 'public.cost_plan_calc_file_log_write()', 'execute')`), 'f')
  })

  it('удаление объекта запись не трогает; название — слепок на момент действия', () => {
    const other = '00000000-0000-4000-8000-0000000e3a02'
    sql(`insert into public.objects (id, name, address, status) values ('${other}', 'ЖК Временный', 'Москва', 'main_construction')`)
    as(U.economist, insertFile(7, 'cost_plan_direct_costs', { owner: other }))
    sql(`update public.objects set name = 'ЖК Переименованный' where id = '${other}'`)
    as(U.economist, `delete from public.s3_documents where id = '${DOC(7)}'`)
    sql(`delete from public.objects where id = '${other}'`)
    assert.deepEqual(logOf(7).map((l) => l.split('|')[2]), ['ЖК Временный', 'ЖК Переименованный'])
  })

  it('право: экономисту ОСП выдано, другим ролям — нет; osp_can видит его и администратора', () => {
    const can = (uid) => as(uid, `select public.osp_can('cost_plan_docs', 'edit')`)
    assert.equal(sql(`select can_edit from public.role_permissions where role = 'economist' and section = 'cost_plan_docs'`), 't')
    assert.equal(sql(`select count(*) from public.role_permissions where section = 'cost_plan_docs' and role <> 'economist'`), '0')
    assert.deepEqual([U.economist, U.engineer, U.contractor, U.admin].map(can), ['t', 'f', 'f', 't'])
  })

  it('снятую администратором галочку повтор миграции не возвращает', () => {
    sql(`update public.role_permissions set can_edit = false where role = 'economist' and section = 'cost_plan_docs'`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql(`select can_edit from public.role_permissions where role = 'economist' and section = 'cost_plan_docs'`), 'f')
    sql(`update public.role_permissions set can_edit = true where role = 'economist' and section = 'cost_plan_docs'`)
  })

  it('аварийный откат: право снято, новые действия не пишутся, записи на месте; миграция накатывается снова', () => {
    const before = sql('select count(*) from public.cost_plan_calc_file_log')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.cost_plan_calc_file_log'), before)
    assert.equal(sql(`select count(*) from public.role_permissions where section = 'cost_plan_docs'`), '0')
    assert.equal(as(U.economist, `select public.osp_can('cost_plan_docs', 'edit')`), 'f')
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    as(U.admin, insertFile(8, 'cost_plan_direct_costs'))
    assert.deepEqual(logOf(8), [], 'триггера нет')

    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(logOf(8).length, 1, 'файл, прикреплённый за время отката, — в журнале')
    as(U.economist, `delete from public.s3_documents where id = '${DOC(8)}'`)
    assert.equal(logOf(8).length, 2)
  })
})

describe('Журнал файлов «Расчёта ПЗ» — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const logOf = (n) => internal(`select ${LOG_FIELDS} from public.cost_plan_calc_file_log where document_id = '${DOC(n)}' order by id`)
    .split('\n').filter(Boolean)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-cp-log-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(`
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Журнал');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
        ('${U.economist}', 'economist', true, false, 'Экономистова Э. Э.', 'e@example.invalid', null),
        ('${U.engineer}', 'engineer', true, false, 'Инженеров И. И.', 'i@example.invalid', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Журнальный', 'Москва', 'main_construction');`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK; право — у экономиста ОСП', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
    assert.equal(as(U.economist, `select public.osp_can('cost_plan_docs', 'edit')`), 't')
    assert.equal(as(U.engineer, `select public.osp_can('cost_plan_docs', 'edit')`), 'f')
  })

  it('триггер пишет журнал от имени вошедшего, хотя у вошедшего права на запись нет', () => {
    as(U.economist, insertFile(2, 'cost_plan_direct_costs', { name: 'ПЗ.xlsx' }))
    as(U.economist, `delete from public.s3_documents where id = '${DOC(2)}'`)
    assert.deepEqual(logOf(2), [
      `attach|ПЗ.xlsx|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`,
      `detach|ПЗ.xlsx|ЖК Журнальный|${U.economist}|Экономистова Э. Э.`,
    ])
  })

  it('журнал не подделать, не поправить и не стереть; читает сотрудник, подрядчику и без входа — пусто', () => {
    for (const statement of [
      `insert into public.cost_plan_calc_file_log (action, document_id, file_name, owner_type, owner_id, doc_category)
        values ('attach', '${DOC(9)}', 'Подделка.pdf', 'object', '${OBJ}', 'cost_plan_direct_costs')`,
    ]) assert.throws(() => as(U.economist, statement), /row-level security/)
    assert.equal(as(U.economist, `update public.cost_plan_calc_file_log set changed_by_name = 'Другой' returning id`), '')
    assert.equal(as(U.economist, 'delete from public.cost_plan_calc_file_log returning id'), '')
    assert.equal(logOf(2).length, 2)
    assert.ok(Number(as(U.engineer, 'select count(*) from public.cost_plan_calc_file_log')) >= 2)
    assert.equal(as(U.contractor, 'select count(*) from public.cost_plan_calc_file_log'), '0')
    assert.equal(as(null, 'select count(*) from public.cost_plan_calc_file_log'), '0')
  })
})

describe('Журнал файлов «Расчёта ПЗ»: файлы миграций', () => {
  it('миграции обеих баз делают одно и то же: те же таблица, функция, триггер, начальные записи и право', () => {
    const shared = (file) => {
      const sql = fs.readFileSync(file, 'utf8')
      return sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS'), sql.indexOf('-- ── Права'))
        .replace(/ *SET application_name = 'osp:internal'\n/, '')
    }
    assert.ok(shared(MIGRATION).length > 1000)
    assert.equal(shared(YANDEX), shared(MIGRATION))
  })

  it('миграция — в списке кандидатов проверки прав; в списке шлюза журнал только на чтение', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'tests/db/baseline/candidate-migrations.txt'), 'utf8'), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/osp-api/src/data/allow.json'), 'utf8'))
    assert.deepEqual(allow.tables.cost_plan_calc_file_log, { authenticated: ['select'] })
    assert.equal(allow.rpc?.cost_plan_calc_file_log_write, undefined, 'функцию триггера шлюз не отдаёт')
  })

  it('файлы проверок и отката есть', () => {
    for (const f of [MIGRATION, YANDEX, YANDEX_CHECK, CHECK, ROLLBACK]) assert.ok(fs.existsSync(f), f)
  })
})
