// «Заявки на проверку ДП/ДС» (миграция 20270216_doc_check_chat_history) на слепке схемы прода. Люди и заявки вымышленные.
//   • файлы в обсуждении: сообщение хранит снимок файла, собранный базой (подделать имя, ключ, размер нельзя); приложить можно
//     только свой файл этой заявки, загруженный для обсуждения и ещё не отправленный; отправленный файл не меняется и не
//     удаляется никем — ни правом правки, ни автором; свой черновик (не отправлен) автор убрать может;
//   • строка любого файла заявки — только имя и описание: перенаправить её на другой объект хранилища нельзя;
//   • история заявки — от базы: создание, статус, поля, удаление, архив, файлы (кто прикрепил, открепил, переименовал,
//     перенёс), файлы обсуждения — при отправке; запись страницы в историю от вошедшего отбрасывается;
//   • согласование ПСДЦ: ответственный — только действующий экономист ОСП, назначает право правки (юрист ОСП), при подаче
//     правом «только создавать» не ставится;
//   • «прочитано» — у каждого своё и в базе: граница и отметки по заявкам, только свои, только растут, не позже «сейчас»,
//     только видимые заявки; таблицу напрямую не прочесть.
// Проверка для прода до миграции — FAIL, а не ошибка; откат возвращает прежнее, данные остаются. Нужны Docker и psql.
// Второй блок — то же главное на копии прода, загруженной как база Яндекса (migrate.sh). Страница — doc-check-chat.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270216_doc_check_chat_history'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270216.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  editor: '00000000-0000-4000-8000-0000000dd101',     // раздел: правка
  viewer: '00000000-0000-4000-8000-0000000dd102',     // раздел: просмотр
  viewer2: '00000000-0000-4000-8000-0000000dd103',    // раздел: просмотр
  lawyer: '00000000-0000-4000-8000-0000000dd104',     // юрист ОСП (правка раздела)
  economist: '00000000-0000-4000-8000-0000000dd105',  // экономист ОСП
  blocked: '00000000-0000-4000-8000-0000000dd106',    // экономист ОСП, заблокирован
  creator: '00000000-0000-4000-8000-0000000dd107',    // только создавать заявки, своих объектов
  scoped: '00000000-0000-4000-8000-0000000dd108',     // раздел: просмотр, только объект OBJ
  none: '00000000-0000-4000-8000-0000000dd109',       // сотрудник без раздела
}
const OBJ = '00000000-0000-4000-8000-0000000dd201'
const OBJ2 = '00000000-0000-4000-8000-0000000dd202'
const R1 = '00000000-0000-4000-8000-0000000dd301'
const R2 = '00000000-0000-4000-8000-0000000dd302'
const R3 = '00000000-0000-4000-8000-0000000dd303'   // объект OBJ2 — не виден сотруднику объекта OBJ

const FIXTURE = `
  -- Архив заявки — колонка доски 20261113 (на слепке Supabase её нет; функция истории читает её через jsonb).
  alter table public.doc_check_requests add column if not exists archived_at timestamptz;
  insert into public.roles (key, label, is_system) values ('dd_editor', 'Тест: заявки, правка', false), ('dd_viewer', 'Тест: заявки, просмотр', false),
    ('dd_creator', 'Тест: заявки, создание', false), ('dd_none', 'Тест: без раздела', false), ('lawyer', 'Юрист ОСП', false),
    ('economist', 'Экономист ОСП', false) on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dd_editor', 'doc_check_requests', true, true), ('dd_viewer', 'doc_check_requests', true, false),
    ('dd_creator', 'doc_check_requests', true, false), ('dd_creator', 'doc_check_requests_create', true, true),
    ('lawyer', 'doc_check_requests', true, true) on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.objects (id, name, address) values ('${OBJ}', 'Объект один', 'А'), ('${OBJ2}', 'Объект два', 'Б');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, object_ids) values
    ('${U.editor}', 'dd_editor', true, false, 'Правкин П. П.', 'e@example.invalid', '{}'),
    ('${U.viewer}', 'dd_viewer', true, false, 'Смотров С. С.', 'v@example.invalid', '{}'),
    ('${U.viewer2}', 'dd_viewer', true, false, 'Второй В. В.', 'v2@example.invalid', '{}'),
    ('${U.lawyer}', 'lawyer', true, false, 'Юристова Ю. Ю.', 'l@example.invalid', '{}'),
    ('${U.economist}', 'economist', true, false, 'Экономова Э. Э.', 'ec@example.invalid', '{}'),
    ('${U.blocked}', 'economist', false, true, 'Ушедшая У. У.', 'b@example.invalid', '{}'),
    ('${U.creator}', 'dd_creator', true, false, 'Объектов О. О.', 'c@example.invalid', array['${OBJ}']::uuid[]),
    ('${U.scoped}', 'dd_viewer', true, false, 'Охватов О. О.', 's@example.invalid', array['${OBJ}']::uuid[]),
    ('${U.none}', 'dd_none', true, false, 'Безразделов Б. Б.', 'n@example.invalid', '{}');
  insert into public.doc_check_requests (id, doc_type, object_id, status) values
    ('${R1}', 'dp', '${OBJ}', 'in_progress'), ('${R2}', 'ds', '${OBJ}', 'new'), ('${R3}', 'ds', '${OBJ2}', 'new');`

const read = (p) => fs.readFileSync(p, 'utf8')
// Тело функции из файла миграции — без отметки пропуска (её у базы Яндекса добавляет правило служебных функций).
const fnBody = (text, name) => {
  const m = text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`))
  assert.ok(m, name)
  return m[0].replace(/\n {2}SET application_name = 'osp:internal'/g, '')
}
const FUNCTIONS = ['doc_check_requests_psdc_guard', 'doc_check_history_write', 'doc_check_audit_log_server_only', 'doc_check_requests_history',
  's3_documents_doc_check_history', 'doc_check_request_comments_stamp', 'doc_check_request_comments_history', 's3_documents_doc_check_guard',
  'doc_check_talk_clean', 'doc_check_talk_state', 'doc_check_talk_mark']

describe('Обсуждение, история и ПСДЦ заявок на проверку: файлы миграции', () => {
  it('функции, триггеры и колонки в обеих базах совпадают; у служебных функций базы Яндекса — отметка пропуска', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    for (const name of FUNCTIONS) assert.equal(fnBody(b, name), fnBody(a, name), name)
    const definers = (text) => [...text.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g)]
      .filter((m) => /SECURITY DEFINER/.test(m[0])).map((m) => [m[1], /application_name = 'osp:internal'/.test(m[0])])
    assert.deepEqual(definers(b).filter(([, marked]) => !marked), [], 'служебные функции базы Яндекса — с отметкой')
    assert.equal(definers(b).length, 8)
    assert.doesNotMatch(b, /\bBEGIN;|\bCOMMIT;|TO authenticated|TO anon|service_role/, 'без транзакции и ролей Supabase')
    const parts = (text) => text.slice(text.indexOf('-- ── 1.'), text.indexOf('-- ── Права'))
      .replace(/\n {2}SET application_name = 'osp:internal'/g, '')
    assert.equal(parts(b), parts(a), 'всё до прав — одно и то же')
  })

  it('миграция — в списке кандидатов проверки прав; список шлюза: «прочитано» — двумя функциями, таблицы напрямую нет', () => {
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')))
    assert.deepEqual(allow.rpc.doc_check_talk_state, ['authenticated'])
    assert.deepEqual(allow.rpc.doc_check_talk_mark, ['authenticated'])
    for (const name of ['doc_check_history_write', 'doc_check_talk_clean']) assert.equal(allow.rpc[name], undefined, name)
    assert.equal(allow.tables.doc_check_talk_reads, undefined)
    const sections = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'db-sections.json')))
    for (const name of ['doc_check_talk_state', 'doc_check_talk_mark']) {
      assert.deepEqual(sections.rpc[name].call, [{ any: [['doc_check_requests', 'view'], ['doc_check_requests', 'edit']] }], name)
    }
  })
})

describe('Обсуждение, история и ПСДЦ заявок на проверку: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const history = (request, extra = '') => JSON.parse(sql(`select coalesce(json_agg(json_build_object('event', event_type, 'field', field_name,
    'old', old_value, 'new', new_value, 'text', description, 'who', changed_by_name) order by changed_at, id), '[]')
    from public.doc_check_request_audit_log where request_id = '${request}' ${extra}`))
  let fileN = 0
  const addFile = (uid, request, { category = 'doc_check_chat', name = 'Скан.pdf', uploadedBy = uid } = {}) => {
    fileN += 1
    return as(uid, `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, mime_type, size_bytes, doc_category, uploaded_by, sha256)
      values ('doc_check_request', '${request}', 'doc-check-requests/${request}/f${fileN}-x.pdf', '${name}', 'application/pdf', ${1000 + fileN},
              '${category}', '${uploadedBy}', '${String(fileN).padStart(64, 'a')}') returning id`)
  }
  const post = (uid, request, body, attachments) => as(uid, `insert into public.doc_check_request_comments (request_id, body, attachments)
    values ('${request}', '${body}', '${JSON.stringify(attachments)}'::jsonb) returning attachments`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    const candidates = candidateMigrations()
    for (const m of candidates.slice(0, candidates.findIndex((c) => c.startsWith(NAME)))) {
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

  it('история от базы: создание, статус, поля, архив, удаление и восстановление — с автором; запись страницы отбрасывается', () => {
    const r = as(U.editor, `insert into public.doc_check_requests (doc_type, object_id, status) values ('dp', '${OBJ}', 'new') returning id`)
    as(U.editor, `update public.doc_check_requests set status = 'in_progress', sort_order = 5 where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set doc_number = '7' where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set assignee_ids = array['${U.lawyer}']::uuid[] where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set sort_order = 9 where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set archived_at = now() where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set archived_at = null where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set deleted_at = now() where id = '${r}'`)
    as(U.editor, `update public.doc_check_requests set deleted_at = null where id = '${r}'`)
    // Прежняя вкладка пишет историю сама — от вошедшего база её отбрасывает: ни дублей, ни выдуманного.
    assert.equal(as(U.editor, `insert into public.doc_check_request_audit_log (request_id, event_type, description, changed_by_name)
      values ('${r}', 'soft_deleted', 'Подделка', 'Кто-то другой') returning id`), '')
    const log = history(r)
    assert.deepEqual(log.map((e) => [e.event, e.field]), [
      ['created', null], ['status_changed', 'status'], ['field_updated', 'doc_number'], ['field_updated', 'assignee_ids'],
      ['archived', null], ['unarchived', null], ['soft_deleted', null], ['restored', null],
    ], 'порядок колонок и номер — не события')
    assert.deepEqual([log[1].old, log[1].new], ['new', 'in_progress'])
    assert.deepEqual(log.find((e) => e.field === 'assignee_ids').new, [U.lawyer])
    assert.ok(log.every((e) => e.who === 'Правкин П. П.'), 'автор — от базы')
    assert.equal(log.filter((e) => e.text === 'Подделка').length, 0)
    // Служебная операция (без вошедшего) пишет как раньше.
    sql(`insert into public.doc_check_request_audit_log (request_id, event_type, description) values ('${r}', 'soft_deleted', 'Служебная')`)
    assert.equal(history(r, "and description = 'Служебная'").length, 1)
  })

  it('файлы заявки в истории: прикрепили, переименовали, перенесли в другую часть, открепили — кто и что', () => {
    const doc = addFile(U.editor, R1, { category: 'general', name: 'ДП.pdf' })
    as(U.editor, `update public.s3_documents set file_name = 'ДП подписанный.pdf' where id = '${doc}'`)
    as(U.editor, `update public.s3_documents set doc_category = 'doc_check_concept_agreement' where id = '${doc}'`)
    as(U.editor, `delete from public.s3_documents where id = '${doc}'`)
    const log = history(R1, "and field_name = 'file'")
    assert.deepEqual(log.map((e) => [e.event, e.text]), [
      ['file_attached', 'Загружаемые документы: ДП.pdf'],
      ['file_renamed', 'ДП.pdf → ДП подписанный.pdf'],
      ['file_moved', 'ДП подписанный.pdf: Загружаемые документы → Понятийное соглашение'],
      ['file_removed', 'Понятийное соглашение: ДП подписанный.pdf'],
    ])
    assert.equal(log[0].new.id, doc)
    assert.ok(log.every((e) => e.who === 'Правкин П. П.'))
  })

  it('строку файла заявки не перенаправить на другой объект хранилища — и с правом правки', () => {
    const doc = addFile(U.editor, R1, { category: 'general', name: 'Договор.pdf' })
    for (const set of ["s3_key = 'doc-check-requests/other/podmena.pdf'", 'size_bytes = 1', "sha256 = null", `uploaded_by = '${U.viewer}'`]) {
      assert.throws(() => as(U.editor, `update public.s3_documents set ${set} where id = '${doc}'`), /можно изменить только имя и описание/, set)
    }
    assert.equal(sql(`select s3_key from public.s3_documents where id = '${doc}'`), `doc-check-requests/${R1}/f${fileN}-x.pdf`)
  })

  it('файл в обсуждении: снимок собирает база, подделка полей не проходит; в истории — при отправке', () => {
    const before = history(R1, "and description like 'Обсуждение:%'").length
    // Загружает тот, кто видит заявку (просмотр); автор — тот, кто загрузил, а не указанный в запросе.
    const f = addFile(U.viewer, R1, { name: 'Замечания.pdf', uploadedBy: U.editor })
    assert.equal(sql(`select uploaded_by from public.s3_documents where id = '${f}'`), U.viewer)
    assert.equal(history(R1, "and description like 'Обсуждение:%'").length, before, 'черновик вложения историю не засоряет')
    const saved = JSON.parse(post(U.viewer, R1, 'Посмотрите', [{ id: f, file_name: 'Подделка.pdf', s3_key: 'doc-check-requests/x/чужой.pdf', size_bytes: 1 }]))
    assert.deepEqual(saved, [{ id: f, file_name: 'Замечания.pdf', mime_type: 'application/pdf', size_bytes: 1000 + fileN,
      sha256: String(fileN).padStart(64, 'a'), s3_key: `doc-check-requests/${R1}/f${fileN}-x.pdf` }])
    // Сообщение из одних файлов — можно; пустое — нет.
    const g = addFile(U.viewer, R1, { name: 'Только файл.pdf' })
    assert.equal(JSON.parse(post(U.viewer, R1, '   ', [g])).length, 1)
    assert.throws(() => post(U.viewer, R1, '  ', []), /doc_check_request_comments_body_check/)
    const log = history(R1, "and description like 'Обсуждение:%'")
    assert.deepEqual(log.slice(before).map((e) => [e.event, e.text, e.who]),
      [['file_attached', 'Обсуждение: Замечания.pdf', 'Смотров С. С.'], ['file_attached', 'Обсуждение: Только файл.pdf', 'Смотров С. С.']])
    assert.equal(log.at(-1).new.category, 'doc_check_chat')
  })

  it('к сообщению — только свой файл обсуждения этой заявки, один раз; чужой, другой заявки, не из обсуждения, несуществующий — нет', () => {
    const own = addFile(U.viewer, R1)
    post(U.viewer, R1, 'Первый раз', [own])
    assert.throws(() => post(U.viewer, R1, 'Второй раз', [own]), /уже отправлен/)
    const other = addFile(U.viewer2, R1)
    assert.throws(() => post(U.viewer, R1, 'Чужой', [other]), /только свой файл этой заявки/)
    const elsewhere = addFile(U.viewer, R2)
    assert.throws(() => post(U.viewer, R1, 'Другой заявки', [elsewhere]), /только свой файл этой заявки/)
    const doc = addFile(U.editor, R1, { category: 'general' })
    assert.throws(() => post(U.editor, R1, 'Документ заявки', [doc]), /только свой файл этой заявки/)
    assert.throws(() => post(U.viewer, R1, 'Нет файла', ['00000000-0000-4000-8000-000000000000']), /не найден/)
    assert.throws(() => post(U.viewer, R1, 'Не id', ['../../etc']), /не найден/)
    assert.throws(() => post(U.viewer, R1, 'Много', Array.from({ length: 21 }, () => addFile(U.viewer, R1))), /attachments_check|не найден|уже/)
  })

  it('отправленный файл обсуждения не меняется и не удаляется никем; черновик автор убирает, чужой — нет', () => {
    const f = addFile(U.viewer, R1, { name: 'Протокол.pdf' })
    post(U.viewer, R1, 'Протокол', [f])
    for (const uid of [U.viewer, U.editor, U.lawyer]) {
      assert.throws(() => as(uid, `delete from public.s3_documents where id = '${f}'`), /удалить нельзя/, uid)
      assert.throws(() => as(uid, `update public.s3_documents set file_name = 'Другой.pdf' where id = '${f}'`), /изменить нельзя/, uid)
      assert.throws(() => as(uid, `update public.s3_documents set s3_key = 'doc-check-requests/x/y.pdf' where id = '${f}'`), /изменить нельзя/, uid)
      assert.throws(() => as(uid, `update public.s3_documents set owner_id = '${R2}' where id = '${f}'`), /изменить нельзя/, uid)
    }
    assert.equal(sql(`select file_name || '|' || owner_id from public.s3_documents where id = '${f}'`), `Протокол.pdf|${R1}`)
    // Файл заявки нельзя «переложить» в обсуждение.
    const doc = addFile(U.editor, R1, { category: 'general' })
    assert.throws(() => as(U.editor, `update public.s3_documents set doc_category = 'doc_check_chat' where id = '${doc}'`), /перенести в обсуждение/)

    const draft = addFile(U.viewer, R1)
    assert.throws(() => as(U.viewer2, `delete from public.s3_documents where id = '${draft}'`), /удалить нельзя/)
    assert.throws(() => as(U.editor, `delete from public.s3_documents where id = '${draft}'`), /удалить нельзя/)
    assert.equal(as(U.viewer, `delete from public.s3_documents where id = '${draft}' returning id`), draft)
  })

  it('обсуждение удалённой заявки и без раздела: ни файла, ни сообщения', () => {
    const r = as(U.editor, `insert into public.doc_check_requests (doc_type, object_id, status) values ('ds', '${OBJ}', 'new') returning id`)
    const f = addFile(U.viewer, r)
    as(U.editor, `update public.doc_check_requests set deleted_at = now() where id = '${r}'`)
    assert.throws(() => addFile(U.viewer, r), /прикладывает сотрудник, который видит заявку/)
    assert.throws(() => post(U.viewer, r, 'Поздно', [f]), /обсуждение только для чтения/)
    assert.throws(() => post(U.viewer, r, 'Поздно', []), /обсуждение только для чтения/)
    assert.throws(() => addFile(U.none, R1), /видит заявку|row-level security/)
  })

  it('согласование ПСДЦ: ответственный — только действующий экономист ОСП; назначает юрист; в истории — кто кого', () => {
    as(U.lawyer, `update public.doc_check_requests set psdc_responsible_id = '${U.economist}' where id = '${R1}'`)
    assert.equal(sql(`select psdc_responsible_id from public.doc_check_requests where id = '${R1}'`), U.economist)
    for (const wrong of [U.lawyer, U.blocked, U.viewer, '00000000-0000-4000-8000-000000000000']) {
      assert.throws(() => as(U.lawyer, `update public.doc_check_requests set psdc_responsible_id = '${wrong}' where id = '${R1}'`),
        /только действующий экономист ОСП/, wrong)
    }
    // Просмотр не назначает (правка раздела — doc_check_requests_write_guard).
    assert.throws(() => as(U.viewer, `update public.doc_check_requests set psdc_responsible_id = null where id = '${R1}'`), /правом правки раздела|row-level/)
    as(U.editor, `update public.doc_check_requests set psdc_responsible_id = null where id = '${R1}'`)
    const log = history(R1, "and field_name = 'psdc_responsible_id'")
    assert.deepEqual(log.map((e) => [e.old, e.new, e.who]), [[null, U.economist, 'Юристова Ю. Ю.'], [U.economist, null, 'Правкин П. П.']])
    // Прежний ответственный, ушедший из экономистов, не мешает править остальное.
    sql(`update public.doc_check_requests set psdc_responsible_id = '${U.blocked}' where id = '${R2}'`)
    as(U.editor, `update public.doc_check_requests set doc_number = '12' where id = '${R2}'`)
    assert.equal(sql(`select doc_number from public.doc_check_requests where id = '${R2}'`), '12')
  })

  it('подача правом «только создавать»: ответственного за ПСДЦ не поставить', () => {
    const r = as(U.creator, `insert into public.doc_check_requests (doc_type, object_id, status, psdc_responsible_id)
      values ('ds', '${OBJ}', 'new', '${U.economist}') returning id`)
    assert.equal(sql(`select coalesce(psdc_responsible_id::text, 'нет') from public.doc_check_requests where id = '${r}'`), 'нет')
  })

  it('«прочитано»: у каждого своё; граница и прежние отметки — один раз; отметки только растут и не позже «сейчас»', () => {
    const now = Date.now()
    const state = (uid, since = 'null', seen = 'null') => JSON.parse(as(uid, `select public.doc_check_talk_state(${since}, ${seen})`))
    const first = state(U.viewer, 1000, `'${JSON.stringify({ [R1]: 5000, [R2]: now + 10 ** 9, 'не-заявка': 1, [R3]: 'x' })}'::jsonb`)
    assert.equal(first.since, 1000)
    assert.deepEqual(Object.keys(first.seen).sort(), [R1, R2].sort())
    assert.equal(first.seen[R1], 5000)
    assert.ok(first.seen[R2] <= Date.now() + 1000, 'не позже «сейчас»')
    assert.deepEqual(state(U.viewer, 1, `'{"${R1}": 1}'::jsonb`), first, 'второй вызов ничего не меняет')
    // У другого — своё: первый вход — граница «сейчас».
    const other = state(U.viewer2)
    assert.ok(other.since >= now - 60000 && other.since <= Date.now() + 1000)
    assert.deepEqual(other.seen, {})

    const mark = (uid, request, at) => as(uid, `select public.doc_check_talk_mark('${request}', ${at})`)
    assert.equal(mark(U.viewer, R1, 7000), '7000')
    assert.equal(mark(U.viewer, R1, 6000), '7000', 'назад не идёт')
    assert.ok(Number(mark(U.viewer, R1, Date.now() + 10 ** 9)) <= Date.now() + 1000)
    assert.equal(state(U.viewer2).seen[R1], undefined, 'чужая отметка не видна')
    // Заявка вне охвата — не отмечается; без раздела и гостю — отказ; таблицу напрямую не прочесть.
    assert.equal(mark(U.scoped, R3, 1000), '')
    assert.equal(mark(U.scoped, R1, 1000), '1000')
    assert.throws(() => as(U.none, `select public.doc_check_talk_state(null, null)`), /Нет доступа/)
    assert.throws(() => as(U.none, `select public.doc_check_talk_mark('${R1}', 1)`), /Нет доступа/)
    assert.throws(() => anon(`select public.doc_check_talk_state(null, null)`), /permission denied/)
    assert.throws(() => as(U.viewer, 'select count(*) from public.doc_check_talk_reads'), /permission denied/)
    assert.throws(() => as(U.viewer, `select public.doc_check_history_write('${R1}', 'created', null, null, null, 'Подделка')`), /permission denied/)
  })

  it('историю не исправить и не удалить; заявку вошедший удаляет только мягко — переписка и история остаются', () => {
    const id = sql(`select id from public.doc_check_request_audit_log where request_id = '${R1}' limit 1`)
    for (const uid of [U.editor, U.lawyer]) {
      assert.throws(() => as(uid, `update public.doc_check_request_audit_log set description = 'Подправил' where id = '${id}'`), /изменить нельзя/, uid)
      assert.throws(() => as(uid, `delete from public.doc_check_request_audit_log where id = '${id}'`), /удалить нельзя/, uid)
      assert.throws(() => as(uid, `delete from public.doc_check_requests where id = '${R1}'`), /удаляют в «Удалённые»/, uid)
    }
    assert.equal(sql(`select count(*) from public.doc_check_requests where id = '${R1}'`), '1')
    assert.notEqual(sql(`select description from public.doc_check_request_audit_log where id = '${id}'`), 'Подправил')
  })

  it('удаление заявки уносит её сообщения с файлами и историю', () => {
    const r = sql(`insert into public.doc_check_requests (doc_type, object_id) values ('ds', '${OBJ}') returning id`)
    const f = addFile(U.viewer, r)
    post(U.viewer, r, 'Файл', [f])
    sql(`delete from public.doc_check_requests where id = '${r}'`)
    assert.equal(sql(`select count(*) from public.doc_check_request_comments where request_id = '${r}'`), '0')
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where request_id = '${r}'`), '0')
  })

  it('откат: триггеры и функции убраны, сообщения с файлами и отметки целы; повторное применение работает', () => {
    const before = sql('select (select count(*) from public.doc_check_request_comments), (select count(*) from public.doc_check_talk_reads)')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select (select count(*) from public.doc_check_request_comments), (select count(*) from public.doc_check_talk_reads)'), before)
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    // Прежняя страница снова пишет историю сама.
    assert.notEqual(as(U.editor, `insert into public.doc_check_request_audit_log (request_id, event_type, description) values ('${R1}', 'created', 'Страница') returning id`), '')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    const f = addFile(U.viewer, R1)
    post(U.viewer, R1, 'После отката', [f])
    assert.throws(() => as(U.editor, `delete from public.s3_documents where id = '${f}'`), /удалить нельзя/)
  })
})

describe('Обсуждение, история и ПСДЦ заявок на проверку: база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-doc-check-chat-'))
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

  const addFile = (uid, request, category = 'doc_check_chat') => as(uid, `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, mime_type, size_bytes, doc_category)
    values ('doc_check_request', '${request}', 'doc-check-requests/${request}/' || gen_random_uuid() || '-f.pdf', 'Файл.pdf', 'application/pdf', 10, '${category}') returning id`)

  it('файл обсуждения: просмотр загружает и прикладывает, снимок — от базы; отправленный не удалить и не переименовать', () => {
    const f = addFile(U.viewer, R1)
    const saved = as(U.viewer, `insert into public.doc_check_request_comments (request_id, body, attachments)
      values ('${R1}', 'Файл', '[{"id": "${f}", "file_name": "Подделка.pdf"}]') returning attachments -> 0 ->> 'file_name'`)
    assert.equal(saved, 'Файл.pdf')
    assert.throws(() => as(U.editor, `delete from public.s3_documents where id = '${f}'`), /удалить нельзя/)
    assert.throws(() => as(U.editor, `update public.s3_documents set file_name = 'Другой.pdf' where id = '${f}'`), /изменить нельзя/)
    assert.equal(internal(`select description || '|' || changed_by_name from public.doc_check_request_audit_log
      where request_id = '${R1}' and event_type = 'file_attached' order by changed_at desc limit 1`), 'Обсуждение: Файл.pdf|Смотров С. С.')
  })

  it('история — от базы, запись страницы от вошедшего отбрасывается; ПСДЦ — только экономист ОСП', () => {
    as(U.lawyer, `update public.doc_check_requests set status = 'edo', psdc_responsible_id = '${U.economist}' where id = '${R1}'`)
    assert.throws(() => as(U.lawyer, `update public.doc_check_requests set psdc_responsible_id = '${U.viewer}' where id = '${R1}'`), /экономист ОСП/)
    const count = () => internal(`select count(*) from public.doc_check_request_audit_log where request_id = '${R1}'`)
    const n = count()
    as(U.editor, `insert into public.doc_check_request_audit_log (request_id, event_type, description) values ('${R1}', 'created', 'Подделка')`)
    assert.equal(count(), n)
    assert.equal(internal(`select string_agg(event_type || ':' || coalesce(field_name, ''), ',' order by event_type)
      from public.doc_check_request_audit_log where request_id = '${R1}' and changed_by_name = 'Юристова Ю. Ю.'`),
    'field_updated:psdc_responsible_id,status_changed:status')
  })

  it('заявку не удалить целиком, запись истории не исправить', () => {
    assert.throws(() => as(U.editor, `delete from public.doc_check_requests where id = '${R2}'`), /удаляют в «Удалённые»/)
    const id = internal(`select id from public.doc_check_request_audit_log where request_id = '${R1}' limit 1`)
    assert.throws(() => as(U.editor, `update public.doc_check_request_audit_log set description = 'x' where id = '${id}'`), /изменить нельзя/)
  })

  it('«прочитано»: свои отметки через функции, таблица закрыта', () => {
    assert.equal(as(U.viewer, `select public.doc_check_talk_state(1000, '{"${R1}": 5000}') -> 'seen' ->> '${R1}'`), '5000')
    assert.equal(as(U.viewer, `select public.doc_check_talk_mark('${R1}', 6000)`), '6000')
    assert.equal(as(U.viewer, 'select count(*) from public.doc_check_talk_reads'), '0', 'напрямую строк не видно')
    assert.throws(() => as(U.none, `select public.doc_check_talk_state(null, null)`), /Нет доступа/)
  })
})
