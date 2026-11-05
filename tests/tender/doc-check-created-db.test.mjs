// Заявки на проверку ДП/ДС: запрет в базе (миграция 20261228) и разовая правка данных
// (migration/data/20261228_doc_check_labels_assignees.sql). Первый блок — миграция на слепке схемы прода: дату создания и
// автора заявки меняет только администратор, проверка для прода до миграции — FAIL, а не ошибка; откат. Второй — копия прода
// как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав): тот же запрет и сама правка данных: пробный прогон
// ничего не меняет, применённый снимает метку YouGile и переносит вписанных юристов в исполнители. Нужны Docker и psql.
// Страница — doc-check-assignees.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20261228_doc_check_created_guard'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261228.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const DATA_FIX = path.join(ROOT, 'migration', 'data', '20261228_doc_check_labels_assignees.sql')

const U = {
  admin: '00000000-0000-4000-8000-0000000dc501',
  editor: '00000000-0000-4000-8000-0000000dc502',
  lawyerFull: '00000000-0000-4000-8000-0000000dc503',    // в учётке ФИО целиком
  lawyerShort: '00000000-0000-4000-8000-0000000dc504',   // в учётке без отчества
  lawyerBlocked: '00000000-0000-4000-8000-0000000dc505',
  engineer: '00000000-0000-4000-8000-0000000dc506',
  namesake1: '00000000-0000-4000-8000-0000000dc507',     // двое юристов подходят к одному имени
  namesake2: '00000000-0000-4000-8000-0000000dc508',
}
const R = {
  label: '00000000-0000-4000-8000-0000000dc601',
  mix: '00000000-0000-4000-8000-0000000dc602',
  both: '00000000-0000-4000-8000-0000000dc603',
  deleted: '00000000-0000-4000-8000-0000000dc604',
  clean: '00000000-0000-4000-8000-0000000dc605',
  namesake: '00000000-0000-4000-8000-0000000dc606',
}

// Имена вымышленные. Заявки — только свои: копия прода старше этих данных.
const SEED = `
  insert into public.roles (key, label, is_system) values ('dc_guard_editor', 'Тест: заявки, правка', false) on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values ('dc_guard_editor', 'doc_check_requests', true, true) on conflict do nothing;
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid', null),
    ('${U.editor}', 'dc_guard_editor', true, false, 'Правкин П. П.', 'e@example.invalid', null),
    ('${U.lawyerFull}', 'lawyer', true, false, 'Полнова Анна Викторовна', 'polnova@example.invalid', null),
    ('${U.lawyerShort}', 'lawyer', true, false, 'Кратова Ольга', 'kratova@example.invalid', null),
    ('${U.lawyerBlocked}', 'lawyer', false, true, 'Закрытов Григорий', 'zakryt@example.invalid', null),
    ('${U.engineer}', 'engineer', true, false, 'Инженерова Алина', 'ing@example.invalid', null),
    ('${U.namesake1}', 'lawyer', true, false, 'Тёзкин Пётр', 't1@example.invalid', null),
    ('${U.namesake2}', 'lawyer', true, false, 'Тёзкин Пётр Иванович', 't2@example.invalid', null);
  insert into public.doc_check_requests (id, doc_type, created_by_name, labels, assignee_ids, manual_assignees, deleted_at) values
    ('${R.label}', 'dp', 'Импорт', array['YouGile'], '{}', '{}', null),
    ('${R.mix}', 'ds', 'Импорт', array['Важно', 'yougile', 'СБИС'], array['${U.engineer}']::uuid[],
      array['Кратова Ольга Юрьевна', 'polnova@example.invalid', 'zakryt@example.invalid', 'Инженерова Алина', 'Посторонний Иван'], null),
    ('${R.both}', 'ds', 'Импорт', '{}', array['${U.lawyerFull}']::uuid[], array['  Полнова  Анна   Викторовна '], null),
    ('${R.deleted}', 'ds', 'Импорт', array['YouGile'], '{}', array['Кратова Ольга Юрьевна'], now()),
    ('${R.clean}', 'ds', 'Человек', array['СБИС'], array['${U.lawyerFull}']::uuid[], '{}', null),
    ('${R.namesake}', 'ds', 'Импорт', '{}', '{}', array['Тёзкин Пётр Иванович'], null);`

const EDIT_DATE = `update public.doc_check_requests set created_at = '2026-09-15T09:30:00Z' where id = '${R.clean}' returning created_by_name`
const EDIT_AUTHOR = `update public.doc_check_requests set created_by_name = 'Новый автор' where id = '${R.clean}' returning created_by_name`
const EDIT_NOTE = `update public.doc_check_requests set notes = 'можно' where id = '${R.clean}' returning notes`
const REPEAT_SAME = `update public.doc_check_requests set created_by_name = created_by_name, created_at = created_at where id = '${R.clean}' returning notes`

describe('Дата создания и автор заявки: файлы', () => {
  it('триггер в обеих базах один и тот же; миграция — в списке кандидатов проверки прав', () => {
    const body = (file) => {
      const text = fs.readFileSync(file, 'utf8')
      return text.slice(text.indexOf('CREATE OR REPLACE FUNCTION'))
    }
    assert.equal(body(YANDEX), body(MIGRATION))
    assert.match(fs.readFileSync(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt'), 'utf8'), new RegExp(`^${NAME}\\.sql$`, 'm'))
  })

  it('в правке данных нет имён и почт: репозиторий открытый', () => {
    assert.doesNotMatch(fs.readFileSync(DATA_FIX, 'utf8'), /@su10\.ru|Егоров|Митина|Снисаренко|Садовников|Тупова|Россолов/)
  })
})

describe('Дата создания и автор заявки: база', { skip: skipReason(), timeout: 600000 }, () => {
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
    // Поля заявок — более поздних миграций, чем слепок.
    for (const m of ['20261113_doc_check_board.sql', '20261124_doc_check_card.sql']) {
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(SEED)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 3, out)
  })

  it('сотрудник с правом правки: заявку правит, дату создания и автора — нет', () => {
    assert.equal(as(U.editor, EDIT_NOTE), 'можно')
    assert.throws(() => as(U.editor, EDIT_DATE), /только администратор/)
    assert.throws(() => as(U.editor, EDIT_AUTHOR), /только администратор/)
    assert.equal(as(U.editor, REPEAT_SAME), 'можно', 'те же значения — не правка')
    assert.equal(sql(`select created_by_name from public.doc_check_requests where id = '${R.clean}'`), 'Человек')
  })

  it('администратор меняет; служебная операция — без проверки', () => {
    assert.equal(as(U.admin, EDIT_AUTHOR), 'Новый автор')
    assert.equal(as(U.admin, EDIT_DATE), 'Новый автор')
    assert.equal(sql(`select created_at = '2026-09-15T09:30:00Z' from public.doc_check_requests where id = '${R.clean}'`), 't')
    assert.equal(sql(`update public.doc_check_requests set created_by_name = 'Служба' where id = '${R.clean}' returning created_by_name`), 'Служба')
  })

  it('новую заявку создаёт сотрудник с автором, как и раньше', () => {
    assert.equal(as(U.editor, `insert into public.doc_check_requests (doc_type, created_by_name) values ('ds', 'Правкин П. П.') returning created_by_name`), 'Правкин П. П.')
  })

  it('откат: запрета нет, данные на месте; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from pg_trigger where tgname = 'doc_check_requests_created_guard'`), '0')
    assert.equal(as(U.editor, `update public.doc_check_requests set created_by_name = 'Правкин' where id = '${R.clean}' returning created_by_name`), 'Правкин')
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Заявки на проверку — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const state = () => JSON.parse(internal(`select json_object_agg(id, json_build_object('labels', labels, 'ids', assignee_ids, 'manual', manual_assignees))
    from public.doc_check_requests where id in (${Object.values(R).map((id) => `'${id}'`).join(',')})`))
  const runFix = (apply) => {
    const wrapper = path.join(tmp, apply ? 'apply.sql' : 'dry.sql')
    fs.writeFileSync(wrapper, `${apply ? '\\set apply 1\n' : ''}\\i ${DATA_FIX}\n`)
    const res = spawnSync('psql', ['-h', '127.0.0.1', '-p', String(db.port), '-U', db.owner, '-d', 'osp_target', '-X', '-q', '-f', wrapper], {
      encoding: 'utf8', env: { ...process.env, PGPASSWORD: db.ownerPass, PGSSLMODE: 'disable', PGAPPNAME: 'osp-test' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    return res.stdout + res.stderr
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-created-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 3, out)
  })

  it('дату создания и автора меняет только администратор', () => {
    assert.equal(as(U.editor, EDIT_NOTE), 'можно')
    assert.throws(() => as(U.editor, EDIT_AUTHOR), /только администратор/)
    assert.throws(() => as(U.editor, EDIT_DATE), /только администратор/)
    assert.equal(as(U.admin, EDIT_AUTHOR), 'Новый автор')
  })

  it('правка данных: пробный прогон ничего не меняет и пишет только числа', () => {
    const before = state()
    const out = runFix(false)
    assert.match(out, /Пробный прогон/)
    assert.match(out, /OK: проверка «после» сошлась/)
    assert.deepEqual(state(), before)
    for (const name of ['Полнова', 'Кратова', 'Закрытов', 'Инженерова', 'polnova', 'Тёзкин']) assert.ok(!out.includes(name), name)
  })

  it('правка данных: метки YouGile нет, вписанные юристы — настоящие исполнители, остальное на месте', () => {
    assert.match(runFix(true), /Применено/)
    const s = state()
    assert.deepEqual(s[R.label].labels, [], 'единственная метка')
    assert.deepEqual(s[R.mix].labels, ['Важно', 'СБИС'], 'другие метки и их порядок — как были, другой регистр — тоже снят')
    assert.deepEqual(s[R.deleted].labels, [], 'удалённая заявка — тоже')
    assert.deepEqual(s[R.clean].labels, ['СБИС'])

    assert.deepEqual(s[R.mix].ids, [U.engineer, U.lawyerShort, U.lawyerFull], 'прежний — на месте; учётка без отчества и почта — перенесены')
    assert.deepEqual(s[R.mix].manual, ['zakryt@example.invalid', 'Инженерова Алина', 'Посторонний Иван'], 'заблокированный и не юристы — в базе, не исполнители')
    assert.deepEqual(s[R.both].ids, [U.lawyerFull], 'уже исполнитель — без повтора; пробелы в имени не мешают')
    assert.deepEqual(s[R.both].manual, [])
    assert.deepEqual(s[R.deleted].ids, [U.lawyerShort])
    assert.deepEqual(s[R.namesake].ids, [], 'к имени подошли двое — не гадаем')
    assert.deepEqual(s[R.namesake].manual, ['Тёзкин Пётр Иванович'])
  })

  it('правка данных: повтор ничего не меняет', () => {
    const before = state()
    assert.match(runFix(true), /Применено/)
    assert.deepEqual(state(), before)
  })
})
