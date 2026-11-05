// Постоянный номер контрагента и отметка «есть регистрация на сайте» (миграция 20261225_counterparty_number) на слепке схемы
// прода и на копии прода под одной учёткой:
//   • номер: у каждого, без повторов, порядком страницы; новому — следующий; задать и поменять запросом нельзя; повтор миграции
//     ничего не перенумеровывает; присвоение номера — не правка: updated_at не меняется, триггер снова включён;
//   • функция: только id организации и число; действующие учётки подрядчика; без раздела, подрядчику и гостю — ничего;
//   • проверка для прода до миграции — FAIL, а не ошибка; откат работает. Страница — counterparty-filters.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'
import { counterpartyNumbers } from '../../src/utils/counterpartyFilters.js'

const NAME = '20261225_counterparty_number'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261225.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  viewer: '00000000-0000-4000-8000-0000000ca101',   // раздел «Контрагенты»: просмотр
  none: '00000000-0000-4000-8000-0000000ca102',     // сотрудник без раздела
  one: '00000000-0000-4000-8000-0000000ca103',      // подрядчик ООО Два, действует
  two: '00000000-0000-4000-8000-0000000ca104',      // подрядчик ООО Два, действует
  blocked: '00000000-0000-4000-8000-0000000ca105',  // подрядчик ООО Три, заблокирован
  pending: '00000000-0000-4000-8000-0000000ca106',  // подрядчик ООО Четыре, не одобрен
}
const CP = {
  a: '00000000-0000-4000-8000-0000000ca201', // ООО Два: две действующие учётки
  b: '00000000-0000-4000-8000-0000000ca202', // ООО Три: только заблокированная
  c: '00000000-0000-4000-8000-0000000ca203', // ООО Четыре: только неодобренная
}
const FIXTURE = `
  insert into public.roles (key, label, is_system) values ('cn_viewer', 'Тест: контрагенты', false), ('cn_none', 'Тест: без раздела', false) on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values ('cn_viewer', 'counterparties', true, false) on conflict do nothing;
  insert into public.counterparties (id, name) values ('${CP.a}', 'ООО Два'), ('${CP.b}', 'ООО Три'), ('${CP.c}', 'ООО Четыре');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.viewer}', 'cn_viewer', true, false, 'Смотров', 'v@example.invalid', null),
    ('${U.none}', 'cn_none', true, false, 'Безразделов', 'n@example.invalid', null),
    ('${U.one}', 'contractor', true, false, 'Первый', 'c1@example.invalid', '${CP.a}'),
    ('${U.two}', 'contractor', true, false, 'Второй', 'c2@example.invalid', '${CP.a}'),
    ('${U.blocked}', 'contractor', false, true, 'Заблокированный', 'c3@example.invalid', '${CP.b}'),
    ('${U.pending}', 'contractor', false, false, 'Ждущий', 'c4@example.invalid', '${CP.c}');`
const FILTER = `counterparty_id in ('${CP.a}', '${CP.b}', '${CP.c}')`

describe('Постоянный номер контрагента: файлы миграции', () => {
  const read = (p) => fs.readFileSync(p, 'utf8')
  const body = (text) => text.slice(text.indexOf('ALTER TABLE public.counterparties'), text.indexOf('CREATE OR REPLACE FUNCTION'))

  it('номер в обеих базах присваивается одинаково; функция отличается только служебной отметкой', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.equal(body(b), body(a))
    const fn = (text) => text.slice(text.indexOf('CREATE OR REPLACE FUNCTION'), text.indexOf('COMMENT ON FUNCTION'))
    assert.equal(fn(b).replace("  SET application_name = 'osp:internal'\n", ''), fn(a))
  })

  it('кандидат проверки прав; в списке шлюза — только функция, только вошедшему; учётке с регистрации её нет', () => {
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')))
    assert.deepEqual(allow.rpc.counterparty_site_accounts, ['authenticated'])
    const self = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow-self-contractor.json')))
    assert.equal(self.rpc.counterparty_site_accounts, undefined)
  })
})

describe('Постоянный номер контрагента: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  let stampsBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const accounts = `select counterparty_id || '=' || accounts from public.counterparty_site_accounts() where ${FILTER} order by 1`

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    // До миграции: те же контрагенты в перепутанном порядке; вернём updated_at из прошлого — миграция его не должна тронуть.
    sql(`insert into public.counterparties (name, status, deleted_at) values
        ('Яблоко', 'active', null), ('альфа', 'active', null), ('Бета', 'limited', null),
        ('Вчера удалён', 'active', '2026-01-01'), ('Абзац из ЧС', 'blacklist', null);
      update public.counterparties set updated_at = '2020-01-02 03:04:05+00'`)
    stampsBefore = sql(`select count(*) from public.counterparties where updated_at = '2020-01-02 03:04:05+00'`)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.ok(!/^FAIL /m.test(out), out)
    assert.equal(out.split('\n').filter((l) => /^OK /.test(l)).length, 8, out)
  })

  it('номера — порядком страницы: действующие по названию, затем чёрный список, затем удалённые; отметка времени не тронута', () => {
    assert.equal(sql(`select count(*) from public.counterparties where updated_at = '2020-01-02 03:04:05+00'`), stampsBefore, 'updated_at не изменился')
    const rows = sql(`select json_agg(json_build_object('id', id, 'name', name, 'status', status, 'deleted_at', deleted_at, 'no', counterparty_number)) from public.counterparties`)
    const list = JSON.parse(rows)
    const byNumber = [...list].sort((a, b) => a.no - b.no).map((c) => c.name)
    assert.ok(byNumber.indexOf('альфа') < byNumber.indexOf('Бета'), 'регистр не влияет')
    assert.ok(byNumber.indexOf('Бета') < byNumber.indexOf('Яблоко'))
    assert.ok(byNumber.indexOf('Яблоко') < byNumber.indexOf('Абзац из ЧС'), 'чёрный список после действующих')
    assert.ok(byNumber.indexOf('Абзац из ЧС') < byNumber.indexOf('Вчера удалён'), 'удалённые в конце')
    // Страница до миграции считает так же: при переходе номера те же.
    const withoutColumn = list.map(({ no, ...c }) => c) // eslint-disable-line no-unused-vars
    const computed = counterpartyNumbers(withoutColumn)
    for (const c of list) assert.equal(computed.get(c.id), c.no, c.name)
  })

  it('новому — следующий; задать и поменять нельзя; удаление не освобождает номер; повтор миграции ничего не меняет', () => {
    const max = Number(sql('select max(counterparty_number) from public.counterparties'))
    const id = sql(`insert into public.counterparties (name) values ('Новый') returning id`).split('\n')[0]
    assert.equal(Number(sql(`select counterparty_number from public.counterparties where id = '${id}'`)), max + 1)
    assert.throws(() => sql(`insert into public.counterparties (name, counterparty_number) values ('Подделка', 5)`), /non-DEFAULT|can only be updated to DEFAULT/)
    assert.throws(() => sql(`update public.counterparties set counterparty_number = 1 where id = '${id}'`), /non-DEFAULT|can only be updated to DEFAULT/)
    const before = sql('select md5(string_agg(id::text || counterparty_number, \',\' order by id)) from public.counterparties')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql('select md5(string_agg(id::text || counterparty_number, \',\' order by id)) from public.counterparties'), before, 'повтор не перенумеровывает')
    sql(`delete from public.counterparties where id = '${id}'`)
    assert.equal(Number(sql(`insert into public.counterparties (name) values ('Следующий') returning counterparty_number`).split('\n')[0]), max + 2)
    assert.equal(sql(`select tgenabled from pg_trigger where tgrelid = 'public.counterparties'::regclass and tgname = 'trigger_update_counterparties_updated_at'`), 'O')
  })

  it('функция: только действующие учётки подрядчика и число; ни почты, ни ФИО; без раздела, подрядчику и гостю — ничего', () => {
    sql(FIXTURE)
    assert.equal(as(U.viewer, accounts), `${CP.a}=2`)
    assert.equal(sql(`select pg_get_function_result('public.counterparty_site_accounts()'::regprocedure)`), 'TABLE(counterparty_id uuid, accounts integer)')
    assert.equal(as(U.none, accounts), '')
    assert.equal(as(U.one, accounts), '')
    assert.throws(() => anon(accounts), /permission denied/)
    // Строки учёток сотруднику по-прежнему закрыты.
    assert.equal(as(U.viewer, `select count(*) from public.user_roles where ${FILTER}`), '0')
  })

  it('откат убирает номер и функцию; миграция потом применяется снова', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'counterparties' and column_name = 'counterparty_number'`), '0')
    assert.equal(sql(`select to_regprocedure('public.counterparty_site_accounts()') is null`), 't')
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.ok(!/^FAIL /m.test(out), out)
  })
})

describe('Постоянный номер контрагента: база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const accounts = `select counterparty_id || '=' || accounts from public.counterparty_site_accounts() where ${FILTER} order by 1`

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-counterparty-number-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(FIXTURE)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('номер у каждого на настоящих данных, порядком страницы; отметка времени не менялась при присвоении', () => {
    const rows = JSON.parse(internal(`select json_agg(json_build_object('id', id, 'name', name, 'status', status, 'deleted_at', deleted_at, 'no', counterparty_number))
      from public.counterparties where id not in ('${CP.a}', '${CP.b}', '${CP.c}')`))
    assert.ok(rows.length > 100, 'копия прода')
    assert.equal(new Set(rows.map((c) => c.no)).size, rows.length, 'без повторов')
    const computed = counterpartyNumbers(rows.map(({ no, ...c }) => c)) // eslint-disable-line no-unused-vars
    const same = rows.filter((c) => computed.get(c.id) === c.no).length
    assert.equal(same, rows.length, `порядок миграции и страницы разошёлся у ${rows.length - same} из ${rows.length}`)
    assert.ok(Number(internal(`select count(*) from public.counterparties where updated_at > now() - interval '1 hour' and id not in ('${CP.a}', '${CP.b}', '${CP.c}')`)) === 0, 'updated_at не тронут')
  })

  it('функция через отметку: сотрудник с разделом видит число; без раздела, подрядчику и гостю — ничего', () => {
    assert.equal(as(U.viewer, accounts), `${CP.a}=2`)
    assert.equal(as(U.none, accounts), '')
    assert.equal(as(U.one, accounts), '')
    assert.equal(as(null, accounts), '')
    assert.equal(as(U.viewer, `select count(*) from public.user_roles where ${FILTER}`), '0', 'строки учёток по-прежнему закрыты')
  })
})
