// 20270219_doc_check_dp_conclusion: «Заявки на заключение ДП» переезжают на доску «Заявки на проверку ДП/ДС» (решение пользователя
// 19.11.2026). На слепке схемы прода: заявки на ДП подаются как раньше (под пользователем: черновик, файлы, подача, уведомления),
// затем миграция — копии на доске с тем же id (тип «Заключение ДП», «Новые» сверху, автор и объект прежние, удалённая — в
// удалённых, черновик — нет), файлы и уведомления — у копий, прежний раздел заявок не принимает, новое «Заключение ДП» на доске
// заводит уведомление; повтор безопасен; откат отказывает, если с копией работали, иначе возвращает всё как было.
// Второй блок — копия прода как база Яндекса: миграции до этой, заявка на ДП под пользователем, затем настоящий migrate.sh (проверка
// прав и .check.sql). Нужны Docker и psql (второй блок — и проверенная копия прода). Шлюз файлов (прежний каталог dp-requests/<id>/
// у заявки доски) — tests/osp-api/server.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270219_doc_check_dp_conclusion'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('supabase', 'migrations', `${NAME}.sql`)
const YANDEX = file('migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270219.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

const O = { a: '00000000-0000-4000-8000-0000000dc301', b: '00000000-0000-4000-8000-0000000dc302' }
const U = {
  author: '00000000-0000-4000-8000-0000000dc101',    // рукстрой: подаёт заявки на ДП, создаёт заявки на доске; объект A
  lawyer: '00000000-0000-4000-8000-0000000dc102',    // отдел: правка обоих разделов
  recipient: '00000000-0000-4000-8000-0000000dc103', // получатель окна, без разделов
  other: '00000000-0000-4000-8000-0000000dc104',     // создаёт заявки на доске, объект A, не автор
}
const ROLES = `
  insert into public.roles (key, label, is_system) values
    ('dpc_author', 'Тест: подаёт заявки', false), ('dpc_lawyer', 'Тест: отдел', false), ('dpc_none', 'Тест: без разделов', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dpc_author', 'dp_requests', true, false), ('dpc_author', 'dp_requests_create', true, true),
    ('dpc_author', 'doc_check_requests', true, false), ('dpc_author', 'doc_check_requests_create', true, true),
    ('dpc_lawyer', 'dp_requests', true, true), ('dpc_lawyer', 'doc_check_requests', true, true)
    on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;`
const PEOPLE = `
  insert into public.objects (id, name, address, status) values
    ('${O.a}', 'Тест: ЖК Альфа ДП', 'Москва', 'main_construction'), ('${O.b}', 'Тест: ЖК Бета ДП', 'Москва', 'main_construction');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.author}', 'dpc_author', true, false, 'Авторов А. А.', 'dpc-a@example.invalid', null, array['${O.a}']::uuid[]),
    ('${U.lawyer}', 'dpc_lawyer', true, false, 'Юристова Ю. Ю.', 'dpc-l@example.invalid', null, '{}'),
    ('${U.recipient}', 'dpc_none', true, false, 'Получатель П. П.', 'dpc-r@example.invalid', null, '{}'),
    ('${U.other}', 'dpc_author', true, false, 'Другов Д. Д.', 'dpc-o@example.invalid', null, array['${O.a}']::uuid[]);
  insert into public.dp_request_alert_recipients (user_id) values ('${U.recipient}') on conflict do nothing;`
const BOARD_ROW = '00000000-0000-4000-8000-0000000dc401'
const SEED_BOARD = `insert into public.doc_check_requests (id, object_id, doc_type, status, sort_order, created_by_name)
  values ('${BOARD_ROW}', '${O.a}', 'ds', 'new', 50, 'Тест')`

const draftSql = (reason = 'Причина') => `insert into public.dp_requests (object_id, reason) values ('${O.a}', ${reason ? `'${reason}'` : 'null'}) returning id`
const fileSql = (req, category, name) => `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category)
  values ('dp_request', '${req}', 'dp-requests/${req}/' || gen_random_uuid() || '-${name}', '${name}', '${category}') returning id`
const boardInsert = (type, object = O.a) => `insert into public.doc_check_requests (object_id, doc_type, status, notes)
  values ('${object}', '${type}', 'new', 'Новая заявка') returning id`

// Заявки на ДП, как их подают в прежнем разделе: A — с документом и полями отдела, B — только понятийка, C — удалена отделом,
// D — черновик (не подан). Уведомление о B получатель уже закрыл.
function seedDp(as) {
  const filed = (reason, withDoc) => {
    const id = as(U.author, draftSql(reason))
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    if (withDoc) as(U.author, fileSql(id, 'dp_contract_doc', 'Договор.docx'))
    as(U.author, `update public.dp_requests set status = 'new' where id = '${id}' returning id`)
    return id
  }
  const a = filed('Причина А', true)
  as(U.lawyer, `update public.dp_requests set contract_title = 'Договор 7', amount = 1500.5, responsible_name = 'Экономов Э. Э.',
    responsible_role = 'economist' where id = '${a}' returning id`)
  const b = filed(null, false)
  const c = filed('Удалим', false)
  as(U.lawyer, `update public.dp_requests set deleted_at = now() where id = '${c}' returning id`)
  const d = as(U.author, draftSql('Черновик'))
  as(U.author, fileSql(d, 'dp_concept_agreement', 'Черновик.pdf'))
  as(U.recipient, `select public.dp_request_alerts_ack(array['${b}']::uuid[])`)
  return { a, b, c, d }
}

describe('Заключение ДП на доске ДП/ДС: файлы миграции', () => {
  const body = (text) => text.slice(text.indexOf('-- ── 1.'), text.indexOf('-- ── Права'))

  it('тело одно в обеих базах; различаются только права резерва; в базе Яндекса транзакцию задаёт migrate.sh', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.ok(body(a).length > 1000)
    assert.equal(body(b), body(a))
    assert.doesNotMatch(b, /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(b, /\b(anon|authenticated|service_role)\b/, 'база Яндекса: одна учётка')
    assert.equal((b.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 3)
    for (const t of ['dp_moved_requests_20270219', 'dp_moved_files_20270219', 'dp_moved_alerts_20270219']) {
      assert.match(a, new RegExp(`REVOKE ALL ON osp_private\\.${t} FROM PUBLIC, anon, authenticated`))
      assert.doesNotMatch(a + b, new RegExp(`public\\.${t}`), 'резерв — не в public: его видел бы PostgREST')
    }
    assert.match(body(a), /SECURITY DEFINER\n {2}SET search_path = public, pg_temp\n {2}SET application_name = 'osp:internal'/)
  })

  it('миграция — в списке кандидатов; новых таблиц и функций для шлюза нет', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    assert.doesNotMatch(read(YANDEX), /osp:allow/)
    const allow = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'allow.json')))
    for (const fn of ['doc_check_dp_conclusion_alert', 'dp_requests_moved_guard']) assert.equal((allow.functions ?? allow.rpc)?.[fn], undefined, fn)
  })
})

describe('Заключение ДП на доске ДП/ДС: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  let dp = null
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const row = (id) => JSON.parse(sql(`select row_to_json(r) from public.doc_check_requests r where id = '${id}'`) || 'null')
  const dpNumber = (id) => sql(`select request_number from public.dp_requests where id = '${id}'`)
  const files = (id) => sql(`select string_agg(owner_type || ':' || doc_category || ':' || (s3_key like 'dp-requests/${id}/%')::text, ' '
    order by doc_category) from public.s3_documents where owner_id = '${id}'`)
  const alertsOf = (uid) => as(uid, `select string_agg(right(request_id::text, 4) || '#' || request_number, ' ' order by alerted_at, request_id)
    from public.dp_request_my_alerts()`)
  const counts = () => sql(`select (select count(*) from public.doc_check_requests where doc_type = 'dp_conclusion') || '|'
    || (select count(*) from public.doc_check_request_audit_log l join osp_private.dp_moved_requests_20270219 b on b.request_id = l.request_id) || '|'
    || (select count(*) from osp_private.dp_moved_requests_20270219) || '|' || (select count(*) from osp_private.dp_moved_files_20270219) || '|'
    || (select count(*) from public.dp_request_alerts)`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: file('supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    sql(ROLES)
    sql(PEOPLE)
    sql(SEED_BOARD)
    dp = seedDp(as)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода: до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.ok(checkBefore.split('\n').every((l) => /^(OK|FAIL) /.test(l)), checkBefore)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 8, out)
    assert.match(out, /перенесено: 3\)/)
  })

  it('поданные заявки — на доске с тем же id: «Заключение ДП», «Новые» сверху, автор и объект прежние; черновика нет', () => {
    const a = row(dp.a)
    assert.deepEqual([a.doc_type, a.status, a.object_id, a.created_by, a.created_by_name, a.deleted_at],
      ['dp_conclusion', 'new', O.a, U.author, 'Авторов А. А.', null])
    assert.equal(a.notes, `Причина А\nДоговор: Договор 7\nСумма: 1500,50 ₽\nОтветственный: Экономов Э. Э. (экономист)\n`
      + `Перенесена из «Заявки на заключение ДП» № ${dpNumber(dp.a)}`)
    assert.ok(a.request_number > 0, 'номер доски — свой')
    assert.equal(sql(`select created_at = (select created_at from public.dp_requests where id = '${dp.a}') from public.doc_check_requests where id = '${dp.a}'`), 't')
    const b = row(dp.b)
    assert.equal(b.notes, `Перенесена из «Заявки на заключение ДП» № ${dpNumber(dp.b)}`, 'без примечания — только прежний №')
    assert.ok(b.sort_order > a.sort_order && a.sort_order > 50, 'наверху «Новых», новее выше')
    assert.notEqual(row(dp.c).deleted_at, null, 'удалённая — в «Удалённых» доски')
    assert.equal(row(dp.d), null, 'черновик не переносится')
    assert.equal(sql(`select string_agg(right(id::text, 4) || '=' || (deleted_at is not null)::text, ' ' order by created_at)
      from public.dp_requests where id in ('${dp.a}', '${dp.b}', '${dp.c}', '${dp.d}')`),
    [dp.a, dp.b, dp.c, dp.d].map((id, i) => `${id.slice(-4)}=${i < 3}`).join(' '), 'в прежнем разделе живых нет, черновик не тронут')
    assert.equal(sql(`select string_agg(event_type || ':' || changed_by_name, ' ' order by changed_at) from public.doc_check_request_audit_log
      where request_id = '${dp.c}'`), 'created:Авторов А. А. soft_deleted:Юристова Ю. Ю.')
    assert.match(sql(`select description from public.doc_check_request_audit_log where request_id = '${dp.a}' and event_type = 'created'`),
      /^Заявка на заключение ДП № \d+ перенесена/)
  })

  it('файлы: у заявки доски, понятийное соглашение — своей частью, ключ хранилища прежний; автор меняет их, пока заявка в «Новых»', () => {
    assert.equal(files(dp.a), 'doc_check_request:doc_check_concept_agreement:true doc_check_request:general:true')
    assert.equal(files(dp.d), 'dp_request:dp_concept_agreement:true', 'файл черновика не тронут')
    const general = sql(`select id from public.s3_documents where owner_id = '${dp.a}' and doc_category = 'general'`)
    assert.throws(() => as(U.other, `delete from public.s3_documents where id = '${general}'`), /Файлы этой заявки/)
    // Автор (по created_by) добавляет и убирает файл своей перенесённой заявки, пока она в «Новых»; другой — нет.
    const boardFile = (req) => `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name)
      values ('doc_check_request', '${req}', 'doc-check-requests/${req}/' || gen_random_uuid() || '-ДП.pdf', 'ДП.pdf') returning id`
    assert.throws(() => as(U.other, boardFile(dp.b)), /Файлы этой заявки/)
    const added = as(U.author, boardFile(dp.b))
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${added}' returning id`), added)
  })

  it('уведомления: прежние — у копий (закрытое и удалённой заявки не показываются); новое «Заключение ДП» заводит окно, ДП/ДС — нет', () => {
    assert.equal(sql(`select confrelid::regclass::text from pg_constraint where conname = 'dp_request_alerts_request_id_fkey'`), 'doc_check_requests')
    assert.equal(alertsOf(U.recipient), `${dp.a.slice(-4)}#${row(dp.a).request_number}`)
    assert.equal(as(U.recipient, `select reason || '|' || coalesce(contract_title, '-') || '|' || object_name from public.dp_request_my_alerts()`),
      `${row(dp.a).notes}|-|Тест: ЖК Альфа ДП`)
    const fresh = as(U.author, boardInsert('dp_conclusion'))
    const ds = as(U.author, boardInsert('ds'))
    const byLawyer = as(U.lawyer, boardInsert('dp_conclusion', O.b))
    assert.deepEqual([row(fresh).created_by, row(fresh).status], [U.author, 'new'])
    const mine = (id) => sql(`select count(*) from public.dp_request_alerts where request_id = '${id}' and user_id = '${U.recipient}'`)
    assert.deepEqual([mine(fresh), mine(ds), mine(byLawyer)], ['1', '0', '1'])
    assert.equal(as(U.recipient, `select public.dp_request_alerts_ack(array['${fresh}', '${byLawyer}']::uuid[])`), '2')
    assert.throws(() => as(U.author, `insert into public.doc_check_requests (object_id, doc_type, status) values ('${O.a}', 'dp_conclusion_x', 'new')`),
      /doc_check_requests_doc_type_check/)
  })

  it('прежний раздел заявок не принимает: вошедшему — «обновите страницу»; служебной операции — можно', () => {
    assert.throws(() => as(U.author, draftSql()), /подаются в «Заявках на проверку ДП\/ДС»: обновите страницу/)
    assert.throws(() => as(U.lawyer, draftSql()), /обновите страницу/)
  })

  it('повтор миграции безопасен: ничего не переносится второй раз', () => {
    const before = counts()
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(counts(), before)
    assert.equal(sql(`select tgenabled from pg_trigger where tgname = 'doc_check_requests_write_guard'`), 'O')
  })

  it('откат: с копией работали — отказ, ничего не меняется; иначе — всё как было, новые «Заключения ДП» остаются «ДП»; повтор безопасен', () => {
    as(U.lawyer, `update public.doc_check_requests set status = 'in_progress' where id = '${dp.b}' returning id`)
    const before = counts()
    assert.throws(() => psqlAt(db.port, null, { file: ROLLBACK }), /Откат остановлен: .*колонка, тип или архив: 1/)
    assert.equal(counts(), before)
    as(U.lawyer, `update public.doc_check_requests set status = 'new' where id = '${dp.b}' returning id`)
    const later = sql(`select string_agg(id::text, ',') from public.doc_check_requests where doc_type = 'dp_conclusion'
      and id not in (select request_id from osp_private.dp_moved_requests_20270219)`).split(',')
    assert.equal(later.length, 2)

    psqlAt(db.port, null, { file: ROLLBACK })
    for (const id of [dp.a, dp.b, dp.c]) assert.equal(row(id), null, 'копии удалены')
    assert.deepEqual(later.map((id) => row(id).doc_type), ['dp', 'dp'], 'созданные после миграции — на доске как «ДП»')
    assert.equal(files(dp.a), 'dp_request:dp_concept_agreement:true dp_request:dp_contract_doc:true', 'файлы — прежним владельцам и категориям')
    assert.equal(sql(`select string_agg((deleted_at is not null)::text, ' ' order by created_at) from public.dp_requests
      where id in ('${dp.a}', '${dp.b}', '${dp.c}')`), 'false false true')
    assert.equal(sql(`select confrelid::regclass::text from pg_constraint where conname = 'dp_request_alerts_request_id_fkey'`), 'dp_requests')
    assert.equal(as(U.recipient, `select string_agg(right(request_id::text, 4) || ':' || contract_title, ' ') from public.dp_request_my_alerts()`),
      `${dp.a.slice(-4)}:Договор 7`, 'окно — прежнее')
    assert.equal(sql(`select count(*) from pg_trigger where tgname in ('doc_check_dp_conclusion_alert', 'dp_requests_moved')`), '0')
    assert.throws(() => sql(`insert into public.doc_check_requests (doc_type, status) values ('dp_conclusion', 'new')`), /doc_type_check/)
    assert.match(as(U.author, draftSql()), /^[0-9a-f-]{36}$/, 'прежний раздел снова принимает')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)

    // После отката миграцию можно применить снова: те же заявки переезжают ещё раз.
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(row(dp.a).doc_type, 'dp_conclusion')
    assert.equal(row(dp.a).created_by, U.author)
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

describe('Заключение ДП на доске ДП/ДС — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  let dp = null
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const migrate = (dir) => spawnSync('bash', [file('migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
    encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
    env: { ...process.env, ...(dir ? { OSP_MIGRATIONS_DIR: dir } : {}),
      PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dp-conclusion-'))
    // Сначала — все миграции до этой: заявки на ДП подаются в прежнем разделе, как на проде до выкладки.
    const earlier = path.join(tmp, 'yandex')
    fs.mkdirSync(earlier)
    for (const f of fs.readdirSync(file('migration', 'yandex'))) {
      if (/^\d{8}_/.test(f) && f < NAME) fs.copyFileSync(file('migration', 'yandex', f), path.join(earlier, f))
    }
    db = startSingleOwner(latestVerifiedCopy())
    const first = migrate(earlier)
    assert.equal(first.status, 0, first.stdout + first.stderr)
    internal(ROLES)
    internal(PEOPLE)
    dp = seedDp(as)
    const res = migrate(null)
    assert.equal(res.status, 0, res.stdout + res.stderr)
    applied = res.stdout
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('миграция применена с проверкой прав; её проверка на копии — все OK', () => {
    assert.match(applied, new RegExp(`OK ${NAME}: применена`))
    const out = internal(read(YANDEX_CHECK))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 11, out)
    const backup = internal(read(CHECK))
    assert.doesNotMatch(backup, /^FAIL/m, backup)
  })

  it('перенос под учёткой-владельцем: копия с тем же id, автор по created_by, файлы у копии, окно получателю — из доски', () => {
    const a = JSON.parse(internal(`select row_to_json(r) from public.doc_check_requests r where id = '${dp.a}'`))
    assert.deepEqual([a.doc_type, a.status, a.created_by, a.created_by_name, a.object_id], ['dp_conclusion', 'new', U.author, 'Авторов А. А.', O.a])
    assert.equal(internal(`select count(*) from public.doc_check_requests where id = '${dp.d}'`), '0')
    assert.equal(internal(`select string_agg(owner_type || ':' || doc_category, ' ' order by doc_category) from public.s3_documents where owner_id = '${dp.a}'`),
      'doc_check_request:doc_check_concept_agreement doc_check_request:general')
    assert.equal(as(U.recipient, `select string_agg(right(request_id::text, 4), ' ') from public.dp_request_my_alerts()`), dp.a.slice(-4))
    const general = internal(`select id from public.s3_documents where owner_id = '${dp.a}' and doc_category = 'general'`)
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${general}' returning id`), general, 'автор меняет файлы своей заявки в «Новых»')
  })

  it('новое «Заключение ДП» от автора — в «Новые», окно получателю; прежний раздел не принимает', () => {
    const id = as(U.author, boardInsert('dp_conclusion'))
    assert.equal(internal(`select count(*) from public.dp_request_alerts where request_id = '${id}' and user_id = '${U.recipient}'`), '1')
    assert.equal(as(U.author, `select count(*) from public.doc_check_requests where id = '${id}'`), '1')
    assert.throws(() => as(U.author, draftSql()), /обновите страницу/)
  })
})
