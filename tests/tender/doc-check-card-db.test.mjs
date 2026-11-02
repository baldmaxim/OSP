// Карточка заявки на проверку ДП/ДС (миграция 20261124_doc_check_card) на слепке схемы прода: сообщения — автор и время
// ставит база, подделать нельзя, правки и удаления нет; шаги — право правки раздела, исполнитель только отмечает; ссылка
// на письмо — только http(s); подрядчику, сотруднику без раздела и гостю — ничего. Проверка для прода до миграции — FAIL,
// а не ошибка; откат сообщения и шаги не теряет. Нужны Docker и psql.
// Второй блок — то же на копии прода, загруженной как база Яндекса (одна учётка, migration/yandex через migrate.sh); нужна
// проверенная копия прода. Страница — doc-check-card.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20261124_doc_check_card'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261124.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  editor: '00000000-0000-4000-8000-0000000dc101',    // раздел: правка
  viewer: '00000000-0000-4000-8000-0000000dc102',    // раздел: просмотр
  assignee: '00000000-0000-4000-8000-0000000dc103',  // раздел: просмотр, исполнитель заявки R1
  mailOnly: '00000000-0000-4000-8000-0000000dc104',  // раздел: просмотр, ФИО не заполнено
  none: '00000000-0000-4000-8000-0000000dc105',      // сотрудник без раздела
  contractor: '00000000-0000-4000-8000-0000000dc106',
}
const CP = '00000000-0000-4000-8000-0000000dc201'
const R1 = '00000000-0000-4000-8000-0000000dc301'
const R2 = '00000000-0000-4000-8000-0000000dc302'
const STEP_R1 = '00000000-0000-4000-8000-0000000dc401'
const STEP_R2 = '00000000-0000-4000-8000-0000000dc402'

const FIXTURE = `
  insert into public.roles (key, label, is_system) values ('dc_editor', 'Тест: заявки, правка', false), ('dc_viewer', 'Тест: заявки, просмотр', false), ('dc_none', 'Тест: без раздела', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dc_editor', 'doc_check_requests', true, true), ('dc_viewer', 'doc_check_requests', true, false) on conflict do nothing;
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Заявка');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.editor}', 'dc_editor', true, false, 'Правкин П. П.', 'e@example.invalid', null),
    ('${U.viewer}', 'dc_viewer', true, false, ' Смотров С. С. ', 'v@example.invalid', null),
    ('${U.assignee}', 'dc_viewer', true, false, 'Исполнов И. И.', 'a@example.invalid', null),
    ('${U.mailOnly}', 'dc_viewer', true, false, '', 'mail-only@example.invalid', null),
    ('${U.none}', 'dc_none', true, false, 'Безразделов Б. Б.', 'n@example.invalid', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}');
  insert into public.doc_check_requests (id, doc_type, assignee_ids) values
    ('${R1}', 'dp', array['${U.assignee}']::uuid[]), ('${R2}', 'ds', '{}');
  insert into public.doc_check_request_steps (id, request_id, title, sort_order) values
    ('${STEP_R1}', '${R1}', 'Шаг первой заявки', 0), ('${STEP_R2}', '${R2}', 'Шаг второй заявки', 0);`

describe('Карточка заявки на проверку ДП/ДС: файлы миграции', () => {
  const read = (p) => fs.readFileSync(p, 'utf8')
  const fn = (text, name) => {
    const m = text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`))
    assert.ok(m, name)
    return m[0]
  }

  it('триггеры, колонки и таблицы в обеих базах совпадают', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    for (const name of ['doc_check_request_comments_stamp', 'doc_check_request_steps_guard']) assert.equal(fn(b, name), fn(a, name))
    const before = (text) => text.slice(text.indexOf('ALTER TABLE public.doc_check_requests'), text.indexOf('-- ── Права'))
    assert.equal(before(b), before(a))
  })

  it('миграция — в списке кандидатов проверки прав; список шлюза: сообщения только читают и добавляют', () => {
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')))
    assert.deepEqual(allow.tables.doc_check_request_comments, { authenticated: ['insert', 'select'] })
    assert.deepEqual(allow.tables.doc_check_request_steps, { authenticated: ['delete', 'insert', 'select', 'update'] })
  })
})

describe('Карточка заявки на проверку ДП/ДС: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const comment = (uid, body, extra = '') => as(uid, `insert into public.doc_check_request_comments (request_id, body${extra ? ', author_user_id, author_name, created_at' : ''})
    values ('${R1}', '${body}'${extra}) returning id`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(FIXTURE)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 7)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
  })

  it('сообщение: автора и время ставит база, подделать нельзя; имя — иначе почта; пробелы по краям убраны', () => {
    const id = comment(U.viewer, '  Вопрос  ', `, '${U.editor}', 'Подделка', '2000-01-01'`)
    const row = JSON.parse(as(U.editor, `select row_to_json(c) from public.doc_check_request_comments c where id = '${id}'`))
    assert.equal(row.author_user_id, U.viewer)
    assert.equal(row.author_name, 'Смотров С. С.')
    assert.equal(row.body, 'Вопрос')
    assert.ok(new Date(row.created_at).getFullYear() > 2020)
    const mail = comment(U.mailOnly, 'Без ФИО')
    assert.equal(as(U.viewer, `select author_name from public.doc_check_request_comments where id = '${mail}'`), 'mail-only@example.invalid')
  })

  it('сообщение: пустое и слишком длинное база не принимает', () => {
    assert.throws(() => comment(U.viewer, '   '), /doc_check_request_comments_body_check/)
    assert.throws(() => comment(U.viewer, 'я'.repeat(4001)), /doc_check_request_comments_body_check/)
    assert.match(comment(U.viewer, 'я'.repeat(4000)), /^[0-9a-f-]{36}$/)
  })

  it('сообщения нельзя изменить и удалить — и с правом правки раздела, и администратору нет прав на уровне таблицы', () => {
    const id = comment(U.editor, 'Как было')
    assert.throws(() => as(U.editor, `update public.doc_check_request_comments set body = 'Переписал' where id = '${id}'`), /permission denied/)
    assert.throws(() => as(U.editor, `delete from public.doc_check_request_comments where id = '${id}'`), /permission denied/)
    assert.equal(sql(`select body from public.doc_check_request_comments where id = '${id}'`), 'Как было')
  })

  it('сотрудник без раздела, подрядчик и гость не видят и не пишут', () => {
    comment(U.editor, 'Для видимости')
    for (const uid of [U.none, U.contractor]) {
      assert.equal(as(uid, 'select count(*) from public.doc_check_request_comments'), '0', uid)
      assert.equal(as(uid, 'select count(*) from public.doc_check_request_steps'), '0', uid)
      assert.throws(() => comment(uid, 'Чужой'), /row-level security/, uid)
      assert.throws(() => as(uid, `insert into public.doc_check_request_steps (request_id, title) values ('${R1}', 'Чужой')`), /row-level security/, uid)
    }
    assert.throws(() => anon('select count(*) from public.doc_check_request_comments'), /permission denied/)
    assert.throws(() => anon('select count(*) from public.doc_check_request_steps'), /permission denied/)
  })

  it('шаги: право правки — всё; просмотр — только читает', () => {
    const id = as(U.editor, `insert into public.doc_check_request_steps (request_id, title, sort_order) values ('${R1}', '  Новый шаг ', 10) returning id`)
    assert.equal(as(U.viewer, `select title from public.doc_check_request_steps where id = '${id}'`), 'Новый шаг')
    as(U.editor, `update public.doc_check_request_steps set title = 'Другой', sort_order = 20, is_done = true where id = '${id}'`)
    assert.equal(sql(`select title || '|' || sort_order || '|' || is_done from public.doc_check_request_steps where id = '${id}'`), 'Другой|20|true')

    assert.throws(() => as(U.viewer, `insert into public.doc_check_request_steps (request_id, title) values ('${R1}', 'Нет')`), /row-level security/)
    // Правила по строкам: 0 строк без ошибки — поэтому страница проверяет, что строку задело.
    assert.equal(as(U.viewer, `update public.doc_check_request_steps set is_done = false where id = '${id}' returning id`), '')
    assert.equal(as(U.viewer, `delete from public.doc_check_request_steps where id = '${id}' returning id`), '')
    assert.equal(sql(`select is_done from public.doc_check_request_steps where id = '${id}'`), 't')

    assert.equal(as(U.editor, `delete from public.doc_check_request_steps where id = '${id}' returning id`), id)
  })

  it('исполнитель заявки без права правки: отмечает только шаги своей заявки, остальное ему закрыто', () => {
    assert.equal(as(U.assignee, `update public.doc_check_request_steps set is_done = true where id = '${STEP_R1}' returning id`), STEP_R1)
    assert.equal(sql(`select is_done from public.doc_check_request_steps where id = '${STEP_R1}'`), 't')
    assert.throws(() => as(U.assignee, `update public.doc_check_request_steps set title = 'Переписал' where id = '${STEP_R1}'`), /исполнитель только отмечает/)
    assert.throws(() => as(U.assignee, `update public.doc_check_request_steps set sort_order = 50 where id = '${STEP_R1}'`), /исполнитель только отмечает/)
    assert.equal(as(U.assignee, `delete from public.doc_check_request_steps where id = '${STEP_R1}' returning id`), '')
    assert.equal(as(U.assignee, `update public.doc_check_request_steps set is_done = true where id = '${STEP_R2}' returning id`), '', 'чужая заявка')
    assert.throws(() => as(U.assignee, `insert into public.doc_check_request_steps (request_id, title) values ('${R1}', 'Нет')`), /row-level security/)
    assert.equal(sql(`select title from public.doc_check_request_steps where id = '${STEP_R1}'`), 'Шаг первой заявки')
  })

  it('шаг: пустой текст не принимается, в другую заявку не переезжает', () => {
    assert.throws(() => as(U.editor, `insert into public.doc_check_request_steps (request_id, title) values ('${R1}', '   ')`), /doc_check_request_steps_title_check/)
    as(U.editor, `update public.doc_check_request_steps set request_id = '${R2}' where id = '${STEP_R1}'`)
    assert.equal(sql(`select request_id from public.doc_check_request_steps where id = '${STEP_R1}'`), R1)
  })

  it('ссылка на письмо — только http(s); имена — не больше 20; прежние заявки не задеты', () => {
    const set = (v) => sql(`update public.doc_check_requests set email_link = ${v} where id = '${R2}' returning email_link`)
    assert.equal(set("'https://mail.example.invalid/letter/1'"), 'https://mail.example.invalid/letter/1')
    assert.equal(set("'HTTP://mail.example.invalid/2'"), 'HTTP://mail.example.invalid/2')
    assert.equal(set('null'), '')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'mail.example.invalid/1', 'https://a b', 'https://']) {
      assert.throws(() => set(`'${bad}'`), /doc_check_requests_email_link_check/, bad)
    }
    assert.throws(() => set(`'https://x/${'я'.repeat(2000)}'`), /doc_check_requests_email_link_check/)
    const names = (n) => `array[${Array.from({ length: n }, (_, i) => `'Имя ${i}'`).join(',')}]::text[]`
    assert.equal(sql(`update public.doc_check_requests set manual_assignees = ${names(20)} where id = '${R2}' returning cardinality(manual_assignees)`), '20')
    assert.throws(() => sql(`update public.doc_check_requests set manual_assignees = ${names(21)} where id = '${R2}'`), /doc_check_requests_manual_assignees_check/)
    assert.equal(sql(`select cardinality(manual_assignees) from public.doc_check_requests where id = '${R1}'`), '0')
  })

  it('сотрудник с правом правки пишет ссылку и имена через обычную строку заявки', () => {
    assert.equal(as(U.editor, `update public.doc_check_requests set email_link = 'https://mail.example.invalid/9', manual_assignees = array['Сидорова']
      where id = '${R1}' returning email_link`), 'https://mail.example.invalid/9')
  })

  it('удаление заявки уносит её шаги и сообщения', () => {
    const r = sql(`insert into public.doc_check_requests (doc_type) values ('ds') returning id`)
    as(U.editor, `insert into public.doc_check_request_steps (request_id, title) values ('${r}', 'Шаг')`)
    as(U.editor, `insert into public.doc_check_request_comments (request_id, body) values ('${r}', 'Сообщение')`)
    sql(`delete from public.doc_check_requests where id = '${r}'`)
    assert.equal(sql(`select (select count(*) from public.doc_check_request_steps where request_id = '${r}') + (select count(*) from public.doc_check_request_comments where request_id = '${r}')`), '0')
  })

  it('откат: страница возвращается к прежнему виду, сообщения и шаги целы; повторное применение их видит', () => {
    const before = sql('select (select count(*) from public.doc_check_request_comments), (select count(*) from public.doc_check_request_steps)')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'doc_check_requests' and column_name in ('email_link', 'manual_assignees')"), '0')
    assert.equal(sql('select (select count(*) from public.doc_check_request_comments), (select count(*) from public.doc_check_request_steps)'), before)
    assert.throws(() => as(U.editor, 'select count(*) from public.doc_check_request_comments'), /permission denied/)
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.notEqual(as(U.editor, 'select count(*) from public.doc_check_request_comments'), '0')
  })
})

describe('Карточка заявки на проверку ДП/ДС: база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-doc-check-card-'))
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

  it('сообщение: автора и время ставит база, с правом просмотра; правка и удаление не проходят', () => {
    const id = as(U.viewer, `insert into public.doc_check_request_comments (request_id, body, author_name, created_at)
      values ('${R1}', 'Вопрос', 'Подделка', '2000-01-01') returning id`)
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(internal(`select author_user_id || '|' || author_name || '|' || (created_at > '2020-01-01') from public.doc_check_request_comments where id = '${id}'`),
      `${U.viewer}|Смотров С. С.|true`)
    assert.equal(as(U.editor, `update public.doc_check_request_comments set body = 'Переписал' where id = '${id}' returning id`), '')
    assert.equal(as(U.editor, `delete from public.doc_check_request_comments where id = '${id}' returning id`), '')
    assert.equal(internal(`select body from public.doc_check_request_comments where id = '${id}'`), 'Вопрос')
  })

  it('сотрудник без раздела, подрядчик и гость не видят и не пишут', () => {
    for (const uid of [U.none, U.contractor, null]) {
      assert.equal(as(uid, 'select count(*) from public.doc_check_request_comments'), '0', String(uid))
      assert.equal(as(uid, 'select count(*) from public.doc_check_request_steps'), '0', String(uid))
      assert.throws(() => as(uid, `insert into public.doc_check_request_comments (request_id, body) values ('${R1}', 'Чужой')`), /row-level security/, String(uid))
    }
  })

  it('шаги: право правки — всё, просмотр — только читает, исполнитель отмечает только шаг своей заявки', () => {
    const id = as(U.editor, `insert into public.doc_check_request_steps (request_id, title, sort_order) values ('${R1}', ' Новый шаг ', 10) returning id`)
    assert.equal(as(U.viewer, `select title from public.doc_check_request_steps where id = '${id}'`), 'Новый шаг')
    assert.equal(as(U.viewer, `update public.doc_check_request_steps set is_done = true where id = '${id}' returning id`), '')
    assert.throws(() => as(U.viewer, `insert into public.doc_check_request_steps (request_id, title) values ('${R1}', 'Нет')`), /row-level security/)
    assert.equal(as(U.assignee, `update public.doc_check_request_steps set is_done = true where id = '${id}' returning id`), id)
    assert.throws(() => as(U.assignee, `update public.doc_check_request_steps set title = 'Переписал' where id = '${id}'`), /исполнитель только отмечает/)
    assert.equal(as(U.assignee, `update public.doc_check_request_steps set is_done = true where id = '${STEP_R2}' returning id`), '', 'чужая заявка')
    assert.equal(as(U.assignee, `delete from public.doc_check_request_steps where id = '${id}' returning id`), '')
    assert.equal(as(U.editor, `delete from public.doc_check_request_steps where id = '${id}' returning id`), id)
  })

  it('ссылка на письмо — только http(s)', () => {
    assert.throws(() => as(U.editor, `update public.doc_check_requests set email_link = 'javascript:alert(1)' where id = '${R1}'`), /doc_check_requests_email_link_check/)
    assert.equal(as(U.editor, `update public.doc_check_requests set email_link = 'https://mail.example.invalid/1' where id = '${R1}' returning email_link`), 'https://mail.example.invalid/1')
  })
})
