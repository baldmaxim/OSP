// «Заявки на проверку ДП/ДС»: руководитель строительства и экономист объекта создают заявки — только в «Новые заявки» (миграция
// 20270102, решение пользователя 06.11.2026). Первый блок — файлы: тела функций в обеих базах те же. Второй — миграция на слепке
// схемы прода: до неё запись заявок без проверки права (любой сотрудник своих объектов), после — менять и удалять только с
// правом правки раздела, с правом создания — только новая заявка в «Новых заявках» по своему объекту, работа отдела (исполнители,
// срок, приоритет, цвет, метки) автором не ставится, «Кто создал» — по учётке, номер — наверх колонки по всем объектам; файлы
// заявки автор добавляет и убирает, пока она в «Новых»; без колонок доски (20261113) — тоже работает; откат. Третий — копия
// прода как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав). Нужны Docker и psql. Страница —
// doc-check-create.test.mjs. Люди вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270102_doc_check_create'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270102.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const BOARD = path.join(MIGRATIONS, '20261113_doc_check_board.sql')

const O = { a: '00000000-0000-4000-8000-0000000de101', b: '00000000-0000-4000-8000-0000000de102' }
const U = {
  manager: '00000000-0000-4000-8000-0000000de201',  // руководитель строительства, объект A: просмотр + создание
  both: '00000000-0000-4000-8000-0000000de202',     // экономист объекта, объекты A и B: просмотр + создание
  viewer: '00000000-0000-4000-8000-0000000de203',   // только просмотр раздела, без привязки
  engineer: '00000000-0000-4000-8000-0000000de204', // юрист отдела: правка раздела
}
const R = { b: '00000000-0000-4000-8000-0000000de301', a: '00000000-0000-4000-8000-0000000de302' }

// Права ролей «просмотр» и «правка»; право создания у руководителя строительства и экономиста объекта ставит миграция.
const ROLES = `
  insert into public.roles (key, label, is_system) values
    ('construction_manager', 'Руководитель строительства', true), ('economist_object', 'Экономист', false),
    ('engineer', 'Инженер ОСП', true), ('dc_viewer', 'Только просмотр', false)
  on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('construction_manager', 'doc_check_requests', true, false), ('economist_object', 'doc_check_requests', true, false),
    ('dc_viewer', 'doc_check_requests', true, false), ('engineer', 'doc_check_requests', true, true)
  on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;`
// Заявка объекта B с большим номером в колонке — её автор с объекта A не видит, но новая встаёт выше неё.
const SEED = `
  insert into public.objects (id, name, address) values ('${O.a}', 'Тест: объект А', 'Адрес А'), ('${O.b}', 'Тест: объект Б', 'Адрес Б');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, object_ids) values
    ('${U.manager}', 'construction_manager', true, false, 'Стройкин С. С.', 'dk-m@example.invalid', array['${O.a}']::uuid[]),
    ('${U.both}', 'economist_object', true, false, 'Двоеобъектова Д. Д.', 'dk-b@example.invalid', array['${O.b}', '${O.a}']::uuid[]),
    ('${U.viewer}', 'dc_viewer', true, false, 'Смотрин С. С.', 'dk-v@example.invalid', '{}'),
    ('${U.engineer}', 'engineer', true, false, 'Юристова Ю. Ю.', 'dk-e@example.invalid', '{}');
  insert into public.doc_check_requests (id, object_id, doc_type, status, sort_order, created_by_name) values
    ('${R.b}', '${O.b}', 'ds', 'new', 50, 'Тест'), ('${R.a}', '${O.a}', 'dp', 'new', 3, 'Тест');`

const INSERT = (o = {}) => {
  const f = { object_id: `'${O.a}'`, doc_type: "'ds'", notes: "'Проверить ДС'", created_by_name: "'Подделка'", ...o }
  return `insert into public.doc_check_requests (${Object.keys(f).join(', ')}) values (${Object.values(f).join(', ')}) returning id`
}
// Категория — по умолчанию столбца, как у загрузки со страницы (uploadFile без category).
const fileSql = (req, name = 'ДС.pdf') => `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name)
  values ('doc_check_request', '${req}', 'doc-check-requests/${req}/' || gen_random_uuid() || '-${name}', '${name}') returning id`

describe('Заявки на проверку: создание — файлы миграции', () => {
  const read = (p) => fs.readFileSync(p, 'utf8')
  const fn = (text, name) => {
    const m = text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))
    assert.ok(m, name)
    return m[0]
  }

  it('тела функций в обеих базах те же; служебная отличается только отметкой пропуска; база Яндекса — без ролей Supabase', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.equal(fn(b, 's3_documents_doc_check_guard'), fn(a, 's3_documents_doc_check_guard'))
    assert.equal(fn(b, 'doc_check_requests_write_guard').replace("  SET application_name = 'osp:internal'\n", ''), fn(a, 'doc_check_requests_write_guard'))
    const tail = (text) => text.slice(text.indexOf('DROP TRIGGER IF EXISTS doc_check_requests_write_guard'), text.indexOf('COMMIT;') > 0 ? text.indexOf('COMMIT;') : undefined).trim()
    assert.equal(tail(b), tail(a))
    assert.doesNotMatch(b, /\b(anon|authenticated)\b|^\s*(BEGIN|COMMIT);/m)
  })

  it('миграция — в списке кандидатов проверки прав; закрытие записи без права — в утверждённых исправлениях', () => {
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const fixes = JSON.parse(read(path.join(ROOT, 'tests', 'db', 'baseline', 'approved-fixes.json')))
      .filter((f) => f.table === 'doc_check_requests' && f.candidate === `${NAME}.sql`)
    assert.ok(fixes.length > 0)
  })
})

describe('Заявки на проверку: создание — база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const row = (id) => JSON.parse(sql(`select row_to_json(r) from public.doc_check_requests r where id = '${id}'`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    // Как на прежнем портале: колонок доски (20261113) нет, остальные кандидаты — по порядку.
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    sql(ROLES)
    sql(SEED)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
  })
  after(() => db?.stop())

  it('до миграции сотрудник с правом просмотра меняет заявку своего объекта прямым запросом', () => {
    assert.equal(as(U.manager, `update public.doc_check_requests set notes = 'до миграции' where id = '${R.a}' returning id`), R.a)
    assert.equal(as(U.viewer, `update public.doc_check_requests set notes = 'до миграции' where id = '${R.b}' returning id`), R.b)
  })

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 5)
    psqlAt(db.port, null, { file: MIGRATION })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('без колонок доски: автор создаёт заявку в «Новых» по своему объекту; кто создал — по учётке; номер — наверх всей колонки', () => {
    const id = as(U.manager, INSERT())
    const r = row(id)
    assert.equal(r.status, 'new')
    assert.equal(r.created_by, U.manager)
    assert.equal(r.created_by_name, 'Стройкин С. С.', 'не со слов страницы')
    assert.ok(r.sort_order > 50, `выше заявки объекта Б, которую автор не видит: ${r.sort_order}`)
    assert.equal(as(U.manager, `select count(*) from public.doc_check_requests where id = '${R.b}'`), '0')
    assert.equal(as(U.both, `select count(*) from public.doc_check_requests where id = '${id}'`), '1', 'второй объект — тоже свой')
  })

  it('не в «Новые» и не по своему объекту — отказ', () => {
    assert.throws(() => as(U.manager, INSERT({ status: "'in_progress'" })), /только в «Новые заявки»/)
    assert.throws(() => as(U.manager, INSERT({ status: "'done'" })), /только в «Новые заявки»/)
    assert.throws(() => as(U.manager, INSERT({ deleted_at: 'now()' })), /только в «Новые заявки»/)
    assert.throws(() => as(U.manager, INSERT({ object_id: `'${O.b}'` })), /row-level security/)
    assert.throws(() => as(U.manager, INSERT({ object_id: 'null' })), /row-level security/)
    assert.match(as(U.both, INSERT({ object_id: `'${O.b}'` })), /^[0-9a-f-]{36}$/, 'у кого объект Б в «Ролях» — можно')
  })

  it('созданную заявку автор не меняет и не удаляет; без права создания — не создать; служебная операция — без проверки', () => {
    const id = as(U.manager, INSERT())
    assert.throws(() => as(U.manager, `update public.doc_check_requests set status = 'done' where id = '${id}'`), /только сотрудник с правом правки/)
    assert.throws(() => as(U.manager, `update public.doc_check_requests set notes = 'исправил' where id = '${id}'`), /только сотрудник с правом правки/)
    assert.throws(() => as(U.manager, `update public.doc_check_requests set deleted_at = now() where id = '${id}'`), /только сотрудник с правом правки/)
    assert.throws(() => as(U.manager, `delete from public.doc_check_requests where id = '${id}'`), /только сотрудник с правом правки/)
    assert.throws(() => as(U.viewer, INSERT({ object_id: `'${O.b}'` })), /только сотрудник с правом правки/)
    assert.throws(() => as(U.viewer, `update public.doc_check_requests set notes = 'x' where id = '${R.b}'`), /только сотрудник с правом правки/)
    assert.equal(sql(`update public.doc_check_requests set notes = 'служебно' where id = '${id}' returning notes`), 'служебно')
  })

  it('юрист с правом правки — как раньше: создаёт в любую колонку, переносит, удаляет; автора заявки не подменить', () => {
    const own = as(U.engineer, INSERT({ status: "'done'", object_id: `'${O.b}'` }))
    assert.equal(row(own).status, 'done')
    assert.equal(row(own).created_by_name, 'Подделка', 'юристу — как раньше: имя пишет страница')
    const id = as(U.manager, INSERT())
    assert.equal(as(U.engineer, `update public.doc_check_requests set status = 'in_progress', created_by = '${U.engineer}' where id = '${id}' returning status`), 'in_progress')
    assert.equal(row(id).created_by, U.manager)
    assert.equal(as(U.engineer, `delete from public.doc_check_requests where id = '${own}' returning id`), own)
  })

  it('файлы: автор — у своей заявки, пока она в «Новых»; у чужой и после переноса — нет; юрист — всегда', () => {
    const id = as(U.manager, INSERT())
    const doc = as(U.manager, fileSql(id))
    assert.match(doc, /^[0-9a-f-]{36}$/)
    assert.equal(as(U.manager, `update public.s3_documents set file_name = 'ДС № 5.pdf' where id = '${doc}' returning file_name`), 'ДС № 5.pdf')
    assert.equal(as(U.manager, `delete from public.s3_documents where id = '${doc}' returning id`), doc)
    assert.throws(() => as(U.manager, fileSql(R.a)), /Файлы этой заявки/, 'заявка своего объекта, но не своя')
    assert.throws(() => as(U.viewer, fileSql(id)), /Файлы этой заявки/)
    const kept = as(U.manager, fileSql(id))
    as(U.engineer, `update public.doc_check_requests set status = 'in_progress' where id = '${id}'`)
    assert.throws(() => as(U.manager, fileSql(id)), /Файлы этой заявки/)
    assert.throws(() => as(U.manager, `delete from public.s3_documents where id = '${kept}'`), /Файлы этой заявки/)
    assert.throws(() => as(U.manager, `update public.s3_documents set owner_id = '${R.a}' where id = '${kept}'`), /Файлы этой заявки/)
    assert.match(as(U.engineer, fileSql(id)), /^[0-9a-f-]{36}$/)
    assert.equal(as(U.engineer, `delete from public.s3_documents where id = '${kept}' returning id`), kept)
  })

  it('файл заявки, которую вызывающий не видит (чужой объект), не убрать и не перенести: «не нашёл заявку» — отказ, а не «заявки нет»', () => {
    const foreign = as(U.engineer, fileSql(R.b, 'ДС объекта Б.pdf'))
    assert.equal(as(U.manager, `select count(*) from public.doc_check_requests where id = '${R.b}'`), '0', 'заявку объекта Б он не видит')
    const attempt = (text) => {
      try {
        assert.equal(as(U.manager, text), '', 'строка файла ему не видна — ничего не задето')
      } catch (err) {
        assert.match(String(err.message), /Файлы этой заявки/)
      }
    }
    attempt(`delete from public.s3_documents where id = '${foreign}' returning id`)
    attempt(`update public.s3_documents set owner_id = '${R.a}' where id = '${foreign}' returning id`)
    assert.equal(sql(`select owner_id from public.s3_documents where id = '${foreign}'`), R.b, 'файл на месте')
  })

  it('с колонками доски: исполнителей, срок, приоритет, цвет и метки автор не ставит; из архива не создать', () => {
    psqlAt(db.port, null, { file: BOARD })
    const id = as(U.manager, INSERT({
      assignee_ids: `array['${U.engineer}']::uuid[]`, due_date: "'2030-01-01'", priority: "'high'", color: "'red'", labels: "array['Срочно']",
    }))
    const r = row(id)
    assert.deepEqual([r.assignee_ids, r.due_date, r.priority, r.color, r.labels], [[], null, null, null, []])
    assert.throws(() => as(U.manager, INSERT({ archived_at: 'now()' })), /только в «Новые заявки»/)
    const lawyer = as(U.engineer, INSERT({ priority: "'high'", labels: "array['Срочно']" }))
    assert.deepEqual([row(lawyer).priority, row(lawyer).labels], ['high', ['Срочно']], 'юристу — как раньше')
  })

  it('откат: запись снова без проверки права, проверка — FAIL; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(as(U.manager, `update public.doc_check_requests set notes = 'после отката' where id = '${R.a}' returning id`), R.a)
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    assert.equal(sql(`select count(*) from pg_trigger where tgname in ('doc_check_requests_write_guard', 's3_documents_doc_check_attach', 's3_documents_doc_check_detach')`), '0')
  })
})

describe('Заявки на проверку: создание — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const row = (id) => JSON.parse(internal(`select row_to_json(r) from public.doc_check_requests r where id = '${id}'`))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-create-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    // Права ролей прода не трогаем, кроме тестовых: «просмотр» и «правка» для своих ролей стенда.
    internal(`insert into public.roles (key, label, is_system) values ('dc_viewer', 'Только просмотр', false), ('dc_lawyer', 'Юрист стенда', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('dc_viewer', 'doc_check_requests', true, false), ('dc_lawyer', 'doc_check_requests', true, true)
      on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;`)
    internal(SEED.replace(`('${U.engineer}', 'engineer'`, `('${U.engineer}', 'dc_lawyer'`))
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK; права ролей выданы', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('автор: только «Новые», свой объект, работа отдела снята, кто создал — по учётке; изменить и удалить — нет', () => {
    const id = as(U.manager, INSERT({ priority: "'high'", labels: "array['Срочно']" }))
    const r = row(id)
    assert.deepEqual([r.status, r.created_by, r.created_by_name, r.priority, r.labels], ['new', U.manager, 'Стройкин С. С.', null, []])
    assert.throws(() => as(U.manager, INSERT({ status: "'in_progress'" })), /только в «Новые заявки»/)
    assert.throws(() => as(U.manager, INSERT({ object_id: `'${O.b}'` })), /row-level security/)
    assert.throws(() => as(U.manager, `update public.doc_check_requests set notes = 'x' where id = '${id}'`), /только сотрудник с правом правки/)
    assert.throws(() => as(U.viewer, `update public.doc_check_requests set notes = 'x' where id = '${R.b}'`), /только сотрудник с правом правки/)
    assert.equal(as(U.engineer, `update public.doc_check_requests set status = 'in_progress' where id = '${id}' returning status`), 'in_progress')
  })

  it('файлы: автор — у своей заявки в «Новых»; у чужой — нет', () => {
    const id = as(U.manager, INSERT())
    assert.match(as(U.manager, fileSql(id)), /^[0-9a-f-]{36}$/)
    assert.throws(() => as(U.manager, fileSql(R.a)), /Файлы этой заявки/)
    as(U.engineer, `update public.doc_check_requests set status = 'in_progress' where id = '${id}'`)
    assert.throws(() => as(U.manager, fileSql(id)), /Файлы этой заявки/)
  })
})
