// Заявки на проверку ДП/ДС: руководитель строительства и экономист объекта — просмотр, только своих объектов (миграция
// 20270101, решение пользователя 06.11.2026). Первый блок — файлы. Второй — миграция на слепке схемы прода: до неё сотрудник
// с привязкой к объектам видит все заявки, после — заявки, историю, обсуждение и шаги только своих объектов, остальные — как
// раньше; права ролей; проверка для прода до миграции — FAIL, а не ошибка; откат. Третий — копия прода как база Яндекса
// (одна учётка, настоящий migrate.sh с проверкой прав). Нужны Docker и psql. Страница — doc-check-scope.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20270101_doc_check_object_scope'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270101.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const O = { a: '00000000-0000-4000-8000-0000000dd101', b: '00000000-0000-4000-8000-0000000dd102' }
const U = {
  admin: '00000000-0000-4000-8000-0000000dd201',      // администратор с привязкой — всё равно все объекты
  manager: '00000000-0000-4000-8000-0000000dd202',    // руководитель строительства, объект A
  economist: '00000000-0000-4000-8000-0000000dd203',  // экономист объекта, объект B
  engineer: '00000000-0000-4000-8000-0000000dd204',   // инженер ОСП без привязки — все
  office: '00000000-0000-4000-8000-0000000dd205',     // руководитель строительства без привязки — все (как на странице)
  both: '00000000-0000-4000-8000-0000000dd206',       // руководитель строительства, объекты A и B — заявки обоих, а не первого
}
const R = { a: '00000000-0000-4000-8000-0000000dd301', b: '00000000-0000-4000-8000-0000000dd302', none: '00000000-0000-4000-8000-0000000dd303' }
const IN = `(${Object.values(R).map((id) => `'${id}'`).join(',')})`
const ALL = [R.a, R.b, R.none].join(',')

// Имена вымышленные. До миграции у руководителя строительства просмотр снят (как на копии прода), у экономиста объекта
// строки нет.
const SEED = `
  insert into public.roles (key, label, is_system) values
    ('admin', 'Администратор', true), ('engineer', 'Инженер ОСП', true),
    ('construction_manager', 'Руководитель строительства', true), ('economist_object', 'Экономист', false)
  on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('construction_manager', 'doc_check_requests', false, false), ('engineer', 'doc_check_requests', true, true)
  on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  delete from public.role_permissions where role = 'economist_object' and section = 'doc_check_requests';
  insert into public.objects (id, name, address) values
    ('${O.a}', 'Тест: объект А', 'Адрес А'), ('${O.b}', 'Тест: объект Б', 'Адрес Б');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, object_ids) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'dd-a@example.invalid', array['${O.b}']::uuid[]),
    ('${U.manager}', 'construction_manager', true, false, 'Стройкин С. С.', 'dd-m@example.invalid', array['${O.a}']::uuid[]),
    ('${U.economist}', 'economist_object', true, false, 'Сметова Е. Е.', 'dd-e@example.invalid', array['${O.b}']::uuid[]),
    ('${U.engineer}', 'engineer', true, false, 'Инженеров И. И.', 'dd-i@example.invalid', '{}'),
    ('${U.office}', 'construction_manager', true, false, 'Офисов О. О.', 'dd-o@example.invalid', '{}'),
    ('${U.both}', 'construction_manager', true, false, 'Двоеобъектов Д. Д.', 'dd-b@example.invalid', array['${O.b}', '${O.a}']::uuid[]);
  insert into public.doc_check_requests (id, object_id, doc_type, created_by_name) values
    ('${R.a}', '${O.a}', 'ds', 'Тест'), ('${R.b}', '${O.b}', 'dp', 'Тест'), ('${R.none}', null, 'ds', 'Тест');
  insert into public.doc_check_request_audit_log (request_id, event_type, description)
    select id, 'created', 'Заявка создана' from public.doc_check_requests where id in ${IN};
  insert into public.doc_check_request_comments (request_id, author_name, body)
    select id, 'Тест', 'Сообщение' from public.doc_check_requests where id in ${IN};
  insert into public.doc_check_request_steps (request_id, title)
    select id, 'Шаг' from public.doc_check_requests where id in ${IN};`

// Что видно вошедшему: id заявок через запятую по порядку, в каждой таблице.
const SEEN = ['doc_check_requests', 'doc_check_request_audit_log', 'doc_check_request_comments', 'doc_check_request_steps']
  .map((t) => `(select coalesce(string_agg(distinct ${t === 'doc_check_requests' ? 'id' : 'request_id'}::text, ','), '')
                from public.${t} where ${t === 'doc_check_requests' ? 'id' : 'request_id'} in ${IN})`)
  .join(` || '|' || `)
const seen = (ids) => [ids, ids, ids, ids].join('|')
const PERMS = `select string_agg(role || ':' || can_view::text || ':' || can_edit::text, ',' order by role) from public.role_permissions
  where section = 'doc_check_requests' and role in ('construction_manager', 'economist_object')`

const COMMENT_ON = (id) => `insert into public.doc_check_request_comments (request_id, body) values ('${id}', 'Вопрос по заявке') returning body`
const MOVE_A_TO_B = `update public.doc_check_requests set object_id = '${O.b}' where id = '${R.a}' returning id`
const NOTE_ON_B = `update public.doc_check_requests set notes = 'чужая' where id = '${R.b}' returning id`

describe('Заявки на проверку по объектам: файлы', () => {
  const body = (file) => {
    const text = fs.readFileSync(file, 'utf8')
    const start = text.indexOf('CREATE OR REPLACE FUNCTION public.doc_check_scope()')
    return text.slice(text.indexOf('AS $$', start), text.indexOf('$$;', start))
  }

  it('объекты вошедшего в обеих базах считаются одинаково; миграция — в списке кандидатов проверки прав', () => {
    assert.ok(body(MIGRATION).includes('object_ids'))
    assert.equal(body(YANDEX), body(MIGRATION))
    assert.match(fs.readFileSync(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt'), 'utf8'), new RegExp(`^${NAME}\\.sql$`, 'm'))
  })

  it('в обеих базах те же 8 правил, у каждого — ограничение по объектам; права ролей — просмотр без правки', () => {
    for (const file of [MIGRATION, YANDEX]) {
      const text = fs.readFileSync(file, 'utf8')
      const policies = [...text.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)[\s\S]*?;\n/g)]
      assert.equal(policies.length, 8, file)
      for (const [all, name] of policies) assert.match(all, /doc_check_scope\(\)/, `${file}: ${name}`)
      assert.match(text, /ON CONFLICT \(role, section\) DO UPDATE SET can_view = true, can_edit = false/)
      assert.match(text, /'construction_manager', 'economist_object'/)
    }
    assert.doesNotMatch(fs.readFileSync(YANDEX, 'utf8'), /\bTO authenticated\b|^\s*(BEGIN|COMMIT);/m, 'база Яндекса: без ролей Supabase и транзакции')
  })
})

describe('Заявки на проверку по объектам: база', { skip: skipReason(), timeout: 600000 }, () => {
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
    // Поля и таблицы заявок — более поздних миграций, чем слепок.
    for (const m of ['20261113_doc_check_board.sql', '20261124_doc_check_card.sql']) {
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    sql(SEED)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
  })
  after(() => db?.stop())

  it('до миграции сотрудник с привязкой видит заявки всех объектов', () => {
    // Заявки и история — всем сотрудникам; обсуждение и шаги — по праву просмотра, а оно у него до миграции снято.
    assert.equal(as(U.manager, `select ${SEEN}`), [ALL, ALL, '', ''].join('|'))
  })

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
  })

  it('руководитель строительства и экономист объекта: просмотр без правки', () => {
    assert.equal(sql(PERMS), 'construction_manager:true:false,economist_object:true:false')
  })

  it('с привязкой — заявки, история, обсуждение и шаги только своих объектов; заявки без объекта не видно', () => {
    assert.equal(as(U.manager, `select ${SEEN}`), seen(R.a))
    assert.equal(as(U.economist, `select ${SEEN}`), seen(R.b))
    assert.equal(as(U.both, `select ${SEEN}`), seen([R.a, R.b].join(',')), 'два объекта — заявки обоих')
  })

  it('без привязки и администратору — как раньше, все заявки', () => {
    assert.equal(as(U.engineer, `select ${SEEN}`), seen(ALL))
    assert.equal(as(U.office, `select ${SEEN}`), seen(ALL))
    assert.equal(as(U.admin, `select ${SEEN}`), seen(ALL))
  })

  it('чужую заявку не тронуть: ни сообщение, ни правка, ни перенос своей на чужой объект', () => {
    assert.equal(as(U.manager, COMMENT_ON(R.a)), 'Вопрос по заявке', 'по своему объекту обсуждение пишет, как любой, кто видит раздел')
    assert.throws(() => as(U.manager, COMMENT_ON(R.b)), /row-level security/)
    assert.equal(as(U.manager, NOTE_ON_B), '', 'чужая заявка для правки не видна')
    assert.throws(() => as(U.manager, MOVE_A_TO_B), /row-level security/)
    assert.equal(sql(`select object_id from public.doc_check_requests where id = '${R.a}'`), O.a)
    assert.equal(as(U.engineer, COMMENT_ON(R.b)), 'Вопрос по заявке', 'без привязки — по любой заявке')
  })

  it('откат: снова все заявки, функции нет; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from pg_proc where proname = 'doc_check_scope'`), '0')
    assert.equal(as(U.manager, `select ${SEEN}`), seen(ALL))
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
  })
})

describe('Заявки на проверку по объектам — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-scope-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    // Права ролей миграция уже выставила: сид их не трогает, иначе проверка ниже проверяла бы сид.
    internal(SEED.replace(/insert into public\.role_permissions[\s\S]*?delete from public\.role_permissions[^;]*;/, ''))
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 8, out)
  })

  it('руководитель строительства и экономист объекта: просмотр без правки', () => {
    assert.equal(internal(PERMS), 'construction_manager:true:false,economist_object:true:false')
  })

  it('с привязкой — только свои объекты; без привязки и администратору — все', () => {
    assert.equal(as(U.manager, `select ${SEEN}`), seen(R.a))
    assert.equal(as(U.economist, `select ${SEEN}`), seen(R.b))
    assert.equal(as(U.both, `select ${SEEN}`), seen([R.a, R.b].join(',')), 'два объекта — заявки обоих')
    assert.equal(as(U.office, `select ${SEEN}`), seen(ALL))
    assert.equal(as(U.admin, `select ${SEEN}`), seen(ALL))
  })

  it('чужую заявку не тронуть', () => {
    assert.equal(as(U.manager, COMMENT_ON(R.a)), 'Вопрос по заявке')
    assert.throws(() => as(U.manager, COMMENT_ON(R.b)), /row-level security/)
    assert.equal(as(U.manager, NOTE_ON_B), '')
    // Здесь накатаны все миграции Яндекса: с 20270102 правку без права правки раздела раньше правила объектов отклоняет триггер.
    assert.throws(() => as(U.manager, MOVE_A_TO_B), /row-level security|только сотрудник с правом правки/)
  })
})
