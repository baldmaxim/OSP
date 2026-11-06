// «Заявка на ДП» (миграции 20261227_dp_requests и 20261231_dp_requests_short_form) на слепке схемы прода: заявка не подаётся только без понятийного
// соглашения; объект, договор, сумму и ответственного заполняет работающий с заявками, автор их не перепишет; номер и отметки ставит база; создают только
// с правом создания, объект — только свой; автор правит примечание и файлы своей, пока её не взяли в работу, статус ведёт право работы; последнее
// соглашение не убрать; уведомления получателям — только функциями; откаты заявки не теряют. Нужны Docker и psql.
// Второй блок — то же на копии прода, загруженной как база Яндекса (одна учётка, migration/yandex через migrate.sh); нужна проверенная
// копия прода. Страница — dp-requests.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20261227_dp_requests'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261227.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const SHORT_NAME = '20261231_dp_requests_short_form'
const SHORT = path.join(MIGRATIONS, `${SHORT_NAME}.sql`)
const SHORT_YANDEX = path.join(ROOT, 'migration', 'yandex', `${SHORT_NAME}.sql`)
const SHORT_CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261231.sql')
const SHORT_ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${SHORT_NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  worker: '00000000-0000-4000-8000-0000000d9101',     // работает с заявками
  author: '00000000-0000-4000-8000-0000000d9102',     // создаёт, привязан к объекту A
  author2: '00000000-0000-4000-8000-0000000d9103',    // создаёт, привязан к объекту A
  otherObj: '00000000-0000-4000-8000-0000000d9104',   // создаёт, привязан к объекту B
  viewer: '00000000-0000-4000-8000-0000000d9105',     // только просмотр, все объекты
  none: '00000000-0000-4000-8000-0000000d9106',       // сотрудник без раздела
  contractor: '00000000-0000-4000-8000-0000000d9107',
  admin: '00000000-0000-4000-8000-0000000d9108',
  recipient: '00000000-0000-4000-8000-0000000d9109',  // получатель без права на раздел
  workerA: '00000000-0000-4000-8000-0000000d910a',    // работает с заявками, привязан к объекту A
}
const CP = '00000000-0000-4000-8000-0000000d9201'
const OBJ_A = '00000000-0000-4000-8000-0000000d9301'
const OBJ_B = '00000000-0000-4000-8000-0000000d9302'
const CONTACT = '00000000-0000-4000-8000-0000000d9401'

const FIXTURE = `
  insert into public.roles (key, label, is_system) values
    ('dp_worker', 'Тест: работа с заявками', false), ('dp_author', 'Тест: создание заявок', false),
    ('dp_viewer', 'Тест: просмотр заявок', false), ('dp_none', 'Тест: без раздела', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dp_worker', 'dp_requests', true, true),
    ('dp_author', 'dp_requests', true, false), ('dp_author', 'dp_requests_create', true, true),
    ('dp_viewer', 'dp_requests', true, false)
    on conflict do nothing;
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Заявка ДП');
  insert into public.objects (id, name, address, status) values
    ('${OBJ_A}', 'ЖК Альфа ДП', 'Москва', 'main_construction'), ('${OBJ_B}', 'ЖК Бета ДП', 'Москва', 'main_construction');
  insert into public.contacts (id, full_name, position) values ('${CONTACT}', 'Экономов Э. Э.', 'Экономист');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.worker}', 'dp_worker', true, false, 'Работнов Р. Р.', 'w@example.invalid', null, '{}'),
    ('${U.author}', 'dp_author', true, false, ' Авторов А. А. ', 'a@example.invalid', null, array['${OBJ_A}']::uuid[]),
    ('${U.author2}', 'dp_author', true, false, 'Вторая В. В.', 'b@example.invalid', null, array['${OBJ_A}']::uuid[]),
    ('${U.otherObj}', 'dp_author', true, false, 'Бетов Б. Б.', 'o@example.invalid', null, array['${OBJ_B}']::uuid[]),
    ('${U.viewer}', 'dp_viewer', true, false, 'Смотров С. С.', 'v@example.invalid', null, '{}'),
    ('${U.none}', 'dp_none', true, false, 'Безразделов Б. Б.', 'n@example.invalid', null, '{}'),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}', '{}'),
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'ad@example.invalid', null, '{}'),
    ('${U.recipient}', 'dp_none', true, false, 'Получатель П. П.', 'r@example.invalid', null, '{}'),
    ('${U.workerA}', 'dp_worker', true, false, 'Работнова А. А.', 'wa@example.invalid', null, array['${OBJ_A}']::uuid[]);
  insert into public.dp_request_alert_recipients (user_id) values ('${U.recipient}'), ('${U.admin}');`

const draftSql = (o = {}) => {
  const f = { object_id: `'${OBJ_A}'`, contract_title: `'Договор'`, amount: 100, reason: `'Причина'`, responsible_name: `'Иванов И. И.'`, responsible_role: `'economist'`, ...o }
  return `insert into public.dp_requests (${Object.keys(f).join(', ')}) values (${Object.values(f).join(', ')}) returning id`
}
// Заявка, как её создаёт новая форма: ни объекта, ни договора, ни суммы, ни ответственного.
const SHORT_DRAFT = `insert into public.dp_requests (reason) values ('Примечание автора') returning id`
const fileSql = (req, category, name) => `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category)
  values ('dp_request', '${req}', 'dp-requests/${req}/' || gen_random_uuid() || '-${name}', '${name}', '${category}') returning id`

describe('Заявка на ДП: файлы миграции', () => {
  const read = (p) => fs.readFileSync(p, 'utf8')
  const fn = (text, name) => {
    const m = text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))
    assert.ok(m, name)
    return m[0]
  }

  it('таблицы и запреты в обеих базах совпадают; служебные функции отличаются только отметкой пропуска', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    const tables = (text) => text.slice(text.indexOf('CREATE SEQUENCE'), text.indexOf('-- ── Запрет и отметки'))
    assert.equal(tables(b), tables(a))
    for (const name of ['dp_requests_guard', 's3_documents_dp_request_guard']) assert.equal(fn(b, name), fn(a, name))
    const plain = (text) => text.replace("  SET application_name = 'osp:internal'\n", '')
    for (const name of ['dp_requests_alert', 'dp_request_scope', 'dp_request_my_alerts']) assert.equal(plain(fn(b, name)), fn(a, name))
    assert.ok(b.includes("SET application_name = 'osp:internal'"))
    const seed = (text) => text.slice(text.indexOf('-- ── Начальные данные'), text.indexOf('-- ── Права'))
    assert.equal(seed(b), seed(a))
  })

  it('короткая форма: запреты в обеих базах совпадают; условия правил те же, различается только обёртка', () => {
    const a = read(SHORT)
    const b = read(SHORT_YANDEX)
    for (const name of ['dp_requests_guard', 's3_documents_dp_request_guard']) assert.equal(fn(b, name), fn(a, name))
    const body = (text) => text.slice(text.indexOf('ALTER TABLE public.dp_requests'), text.indexOf('CREATE OR REPLACE FUNCTION'))
    assert.equal(body(b), body(a))
    assert.equal((a.match(/CREATE POLICY/g) || []).length, 3)
    assert.equal((b.match(/CREATE POLICY/g) || []).length, 3)
    assert.doesNotMatch(b, /TO authenticated/, 'база Яндекса: одна учётка')
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${SHORT_NAME}\\.sql$`, 'm'))
  })

  it('миграция — в списке кандидатов; список шлюза: уведомления только функциями', () => {
    assert.match(read(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')))
    assert.deepEqual(allow.tables.dp_requests, { authenticated: ['delete', 'insert', 'select', 'update'] })
    assert.deepEqual(allow.tables.dp_request_alert_recipients, { authenticated: ['delete', 'insert', 'select'] })
    assert.equal(allow.tables.dp_request_alerts, undefined)
    for (const rpc of ['dp_request_my_alerts', 'dp_request_alerts_ack']) {
      assert.deepEqual(allow.functions?.[rpc] ?? allow.rpc?.[rpc], ['authenticated'], rpc)
    }
  })

  it('ФИО получателей в миграции нет — только id', () => {
    for (const text of [read(MIGRATION), read(YANDEX)]) assert.doesNotMatch(text, /Садовников|Митин/i)
  })
})

describe('Заявка на ДП: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  let shortCheckBefore = ''
  const applyBoth = () => {
    psqlAt(db.port, null, { file: MIGRATION })
    psqlAt(db.port, null, { file: SHORT })
  }
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const anon = (text) => psqlAt(db.port, `begin; set local "request.jwt.claims" = '{"role":"anon"}'; set local role anon; ${text}; commit;`)
  const submit = (uid, id) => as(uid, `update public.dp_requests set status = 'new' where id = '${id}' returning request_number`)
  const attachBoth = (uid, id) => {
    as(uid, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    as(uid, fileSql(id, 'dp_contract_doc', 'Договор.docx'))
  }
  // Заявка автора: черновик, оба обязательных файла, подача. → id
  const filed = (uid = U.author, o = {}) => {
    const id = as(uid, draftSql(o))
    attachBoth(uid, id)
    submit(uid, id)
    return id
  }

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME) || m.startsWith(SHORT_NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    shortCheckBefore = psqlAt(db.port, null, { file: SHORT_CHECK })
    psqlAt(db.port, null, { file: SHORT })
    sql(FIXTURE)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграции повторяются, по порядку', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 7)
    assert.match(shortCheckBefore, /^FAIL /m, 'короткая форма ещё не применена')
    assert.equal(shortCheckBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 6)
    applyBoth()
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    const short = psqlAt(db.port, null, { file: SHORT_CHECK })
    assert.doesNotMatch(short, /^FAIL/m, short)
    assert.equal(short.split('\n').filter((l) => l.startsWith('OK ')).length, 6, short)
  })

  it('короткая заявка: подаётся с одним понятийным соглашением, документы, объект, договор, сумма и ответственный не нужны', () => {
    const id = as(U.author, SHORT_DRAFT)
    assert.throws(() => submit(U.author, id), /без понятийного соглашения/)
    const doc = as(U.author, fileSql(id, 'dp_contract_doc', 'Договор.docx'))
    assert.throws(() => submit(U.author, id), /без понятийного соглашения/, 'документ соглашение не заменяет')
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${doc}' returning id`), doc)
    assert.equal(sql(`select status || '|' || coalesce(request_number::text, 'нет') from public.dp_requests where id = '${id}'`), 'draft|нет')
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    assert.match(submit(U.author, id), /^\d+$/)
    const row = JSON.parse(sql(`select row_to_json(r) from public.dp_requests r where id = '${id}'`))
    assert.equal(row.status, 'new')
    assert.ok(row.request_number > 0)
    assert.equal(row.status_changed_by_name, 'Авторов А. А.')
    assert.ok(row.status_changed_at)
    for (const f of ['object_id', 'contract_title', 'amount', 'responsible_name']) assert.equal(row[f], null, f)
    assert.equal(row.reason, 'Примечание автора')
    const noNote = as(U.author, `insert into public.dp_requests (reason) values ('   ') returning id`)
    assert.equal(sql(`select coalesce(reason, 'пусто') from public.dp_requests where id = '${noNote}'`), 'пусто', 'примечание необязательно, пробелы — не примечание')
  })

  it('поля отдела заполняет работающий с заявками, частями; автор не перепишет ни их, ни своей правкой, ни старой вкладкой', () => {
    const id = as(U.author, SHORT_DRAFT)
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    submit(U.author, id)
    const author = (set) => as(U.author, `update public.dp_requests set ${set} where id = '${id}' returning id`)
    for (const set of [`object_id = '${OBJ_A}'`, `contract_title = 'Договор автора'`, 'amount = 100', `responsible_contact_id = '${CONTACT}'`,
      `responsible_name = 'Подделка'`, `responsible_role = 'economist'`]) {
      assert.throws(() => author(set), /заполняет сотрудник, работающий с заявками/, set)
    }
    assert.equal(author(`reason = 'Новое примечание'`), id, 'примечание — автору можно')

    assert.equal(as(U.worker, `update public.dp_requests set contract_title = ' Договор 7 ' where id = '${id}' returning id`), id, 'частями')
    assert.equal(as(U.worker, `update public.dp_requests set object_id = '${OBJ_A}', amount = 0, responsible_contact_id = '${CONTACT}', responsible_role = 'economist' where id = '${id}' returning id`), id)
    const row = JSON.parse(sql(`select row_to_json(r) from public.dp_requests r where id = '${id}'`))
    assert.equal(row.contract_title, 'Договор 7')
    assert.equal(Number(row.amount), 0)
    assert.equal(row.responsible_name, 'Экономов Э. Э.', 'ФИО контакта ставит база')
    assert.equal(row.reason, 'Новое примечание')

    assert.throws(() => author(`amount = 999`), /заполняет сотрудник, работающий с заявками/, 'поверх заполненного отделом')
    assert.equal(author(`object_id = '${OBJ_A}', contract_title = 'Договор 7', amount = 0`), id, 'старая вкладка шлёт те же значения: не правка')
    assert.equal(author(`reason = 'Ещё примечание'`), id)

    // Удаление контакта делает сотрудник без права на раздел: заявка не должна этому мешать, ФИО остаётся.
    assert.equal(as(U.author, `update public.dp_requests set responsible_contact_id = null where id = '${id}' returning id`), id)
    assert.equal(sql(`select responsible_name from public.dp_requests where id = '${id}'`), 'Экономов Э. Э.')
  })

  it('старая вкладка с полной формой создаёт заявку как раньше', () => {
    const id = as(U.author, draftSql())
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    assert.match(submit(U.author, id), /^\d+$/)
    assert.equal(sql(`select contract_title || '|' || amount from public.dp_requests where id = '${id}'`), 'Договор|100.00')
  })

  it('заявка без объекта: привязка к объектам не мешает автору подать, а работающему — увидеть и заполнить', () => {
    const id = as(U.otherObj, SHORT_DRAFT)
    as(U.otherObj, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    submit(U.otherObj, id)
    const sees = (uid) => as(uid, `select count(*) from public.dp_requests where id = '${id}'`)
    assert.equal(sees(U.otherObj), '1', 'автор')
    assert.equal(sees(U.workerA), '1', 'работающий с другого объекта: заявка должна дойти до того, кто её заполнит')
    assert.equal(sees(U.worker), '1')
    assert.equal(sees(U.viewer), '1', 'просмотр без привязки к объектам')
    assert.equal(sees(U.author), '0', 'просмотр с привязкой: заявка ещё ничья')
    assert.equal(sees(U.none), '0')
    assert.equal(sees(U.contractor), '0')

    assert.throws(() => as(U.workerA, `update public.dp_requests set object_id = '${OBJ_B}' where id = '${id}'`), /row-level security/, 'чужой объект работающий не поставит')
    assert.equal(as(U.workerA, `update public.dp_requests set object_id = '${OBJ_A}' where id = '${id}' returning id`), id)
    assert.equal(sees(U.author), '1', 'теперь это заявка объекта A')
    assert.equal(sees(U.otherObj), '1', 'автор видит свою, хотя объект не его')
    assert.equal(as(U.otherObj, `update public.dp_requests set reason = 'Примечание автора' where id = '${id}' returning id`), id, 'и правит примечание')
    assert.throws(() => as(U.otherObj, `update public.dp_requests set object_id = null where id = '${id}'`), /заполняет сотрудник, работающий с заявками/)
  })

  it('заявка рождается черновиком: сразу поданной её не вставить, автора и номер не подделать', () => {
    assert.throws(() => as(U.author, draftSql({ status: `'new'` })), /создаётся черновиком/)
    const id = as(U.author, draftSql({ created_by: `'${U.worker}'`, created_by_name: `'Подделка'`, request_number: 7777, created_at: `'2000-01-01'` }))
    const row = JSON.parse(sql(`select row_to_json(r) from public.dp_requests r where id = '${id}'`))
    assert.equal(row.created_by, U.author)
    assert.equal(row.created_by_name, 'Авторов А. А.')
    assert.equal(row.request_number, null)
    assert.ok(new Date(row.created_at).getFullYear() > 2020)
    attachBoth(U.author, id)
    const number = submit(U.author, id)
    as(U.worker, `update public.dp_requests set request_number = 7777, created_by = '${U.none}', created_by_name = 'Подмена' where id = '${id}'`)
    const kept = JSON.parse(sql(`select row_to_json(r) from public.dp_requests r where id = '${id}'`))
    assert.equal(String(kept.request_number), number, 'номер не меняется')
    assert.equal(kept.created_by, U.author)
    assert.equal(kept.created_by_name, 'Авторов А. А.')
  })

  it('ответственный: у контакта ФИО ставит база, подделать нельзя; без контакта — ФИО из формы', () => {
    const id = as(U.author, draftSql({ responsible_name: 'null', responsible_role: 'null' }))
    attachBoth(U.author, id)
    assert.match(submit(U.author, id), /^\d+$/, 'без ответственного подать можно')
    as(U.worker, `update public.dp_requests set responsible_contact_id = '${CONTACT}', responsible_name = 'Подделка', responsible_role = 'economist' where id = '${id}'`)
    assert.equal(sql(`select responsible_name from public.dp_requests where id = '${id}'`), 'Экономов Э. Э.')
    const self = as(U.author, draftSql({ responsible_name: `' Новиков П. И. '`, responsible_role: `'construction_manager'` }))
    assert.equal(sql(`select responsible_name from public.dp_requests where id = '${self}'`), 'Новиков П. И.')
    assert.throws(() => as(U.author, draftSql({ responsible_role: `'economist_osp'` })), /dp_requests_responsible_role_check/)
  })

  it('удаление контакта ФИО в заявке не стирает', () => {
    const contact = sql(`insert into public.contacts (full_name, position) values ('Уходящий У. У.', 'Экономист') returning id`)
    const id = filed(U.author, { responsible_contact_id: `'${contact}'` })
    sql(`delete from public.contacts where id = '${contact}'`)
    assert.equal(sql(`select coalesce(responsible_contact_id::text, 'нет') || '|' || responsible_name from public.dp_requests where id = '${id}'`), 'нет|Уходящий У. У.')
  })

  it('неверные поля база не принимает; пустые — это «не заполнено»; пробелы по краям убраны', () => {
    assert.throws(() => as(U.author, draftSql({ amount: -1 })), /dp_requests_amount_check/)
    const blank = as(U.author, draftSql({ contract_title: `'   '`, reason: `'   '` }))
    assert.equal(sql(`select coalesce(contract_title, 'пусто') || '|' || coalesce(reason, 'пусто') from public.dp_requests where id = '${blank}'`), 'пусто|пусто')
    const id = as(U.author, draftSql({ contract_title: `'  Договор 5  '`, reason: `'  Нужен  '`, amount: 0 }))
    assert.equal(sql(`select contract_title || '|' || reason || '|' || amount from public.dp_requests where id = '${id}'`), 'Договор 5|Нужен|0.00')
  })

  it('создание: только с правом создания, объект — только свой; черновик видит только автор', () => {
    assert.throws(() => as(U.viewer, SHORT_DRAFT), /row-level security/, 'без объекта право создания всё равно нужно')
    assert.throws(() => as(U.none, SHORT_DRAFT), /row-level security/)
    assert.throws(() => as(U.contractor, SHORT_DRAFT), /row-level security/)
    assert.throws(() => anon(SHORT_DRAFT), /permission denied/)
    assert.throws(() => as(U.viewer, draftSql()), /row-level security/)
    assert.throws(() => as(U.worker, draftSql()), /row-level security/, 'работа с заявками не даёт создавать')
    assert.throws(() => as(U.none, draftSql()), /row-level security/)
    assert.throws(() => as(U.contractor, draftSql()), /row-level security/)
    assert.throws(() => as(U.author, draftSql({ object_id: `'${OBJ_B}'` })), /row-level security/, 'чужой объект')
    assert.match(as(U.otherObj, draftSql({ object_id: `'${OBJ_B}'` })), /^[0-9a-f-]{36}$/)
    assert.match(as(U.admin, draftSql({ object_id: `'${OBJ_B}'` })), /^[0-9a-f-]{36}$/, 'администратор всегда')

    const id = as(U.author, draftSql())
    assert.equal(as(U.author, `select count(*) from public.dp_requests where id = '${id}'`), '1')
    for (const uid of [U.author2, U.worker, U.viewer, U.admin]) {
      assert.equal(as(uid, `select count(*) from public.dp_requests where id = '${id}'`), '0', uid)
    }
    as(U.author, `delete from public.dp_requests where id = '${id}'`)
  })

  it('чтение: право просмотра и свои объекты; подрядчику, сотруднику без раздела и гостю — ничего', () => {
    const a = filed()
    const b = filed(U.otherObj, { object_id: `'${OBJ_B}'` })
    const sees = (uid, id) => as(uid, `select count(*) from public.dp_requests where id = '${id}'`)
    assert.equal(sees(U.viewer, a), '1')
    assert.equal(sees(U.worker, b), '1')
    assert.equal(sees(U.author2, a), '1', 'коллега по объекту')
    assert.equal(sees(U.author2, b), '0', 'другой объект')
    assert.equal(sees(U.otherObj, a), '0', 'другой объект')
    assert.equal(sees(U.none, a), '0')
    assert.equal(sees(U.contractor, a), '0')
    assert.throws(() => anon('select count(*) from public.dp_requests'), /permission denied/)
  })

  it('автор правит примечание своей, пока её не взяли в работу; статус ведёт право работы; чужую нельзя', () => {
    const id = filed()
    const note = (uid, text) => as(uid, `update public.dp_requests set reason = '${text}' where id = '${id}' returning id`)
    assert.equal(note(U.author, 'Правка автора'), id)
    assert.equal(note(U.author2, 'Чужая правка'), '')
    assert.equal(note(U.viewer, 'Правка зрителя'), '')
    assert.throws(() => as(U.author, `update public.dp_requests set status = 'in_work' where id = '${id}'`), /меняет сотрудник с правом правки/)

    assert.equal(as(U.worker, `update public.dp_requests set status = 'in_work' where id = '${id}' returning status_changed_by_name`), 'Работнов Р. Р.')
    assert.equal(note(U.author, 'Поздняя правка'), '', 'уже в работе')
    assert.equal(sql(`select reason from public.dp_requests where id = '${id}'`), 'Правка автора')
    assert.equal(as(U.worker, `update public.dp_requests set contract_title = 'Правка работника' where id = '${id}' returning id`), id)
    assert.throws(() => as(U.worker, `update public.dp_requests set status = 'draft' where id = '${id}'`), /Недопустимая смена статуса/)
    assert.throws(() => as(U.worker, `update public.dp_requests set status = 'неизвестный' where id = '${id}'`), /dp_requests_status_check/)
  })

  it('удаление: в корзину с отметкой кто; насовсем — только свой черновик', () => {
    const id = filed()
    assert.equal(as(U.author, `delete from public.dp_requests where id = '${id}' returning id`), '', 'поданную насовсем нельзя')
    assert.equal(as(U.worker, `delete from public.dp_requests where id = '${id}' returning id`), '')
    assert.equal(as(U.admin, `delete from public.dp_requests where id = '${id}' returning id`), '')
    as(U.worker, `update public.dp_requests set deleted_at = '2000-01-01' where id = '${id}'`)
    const del = JSON.parse(sql(`select row_to_json(r) from public.dp_requests r where id = '${id}'`))
    assert.equal(del.deleted_by_name, 'Работнов Р. Р.')
    assert.ok(new Date(del.deleted_at).getFullYear() > 2020, 'время ставит база')
    as(U.worker, `update public.dp_requests set deleted_at = null where id = '${id}'`)
    assert.equal(sql(`select coalesce(deleted_by_name, 'нет') from public.dp_requests where id = '${id}'`), 'нет')

    const draft = as(U.author, draftSql())
    assert.equal(as(U.author2, `delete from public.dp_requests where id = '${draft}' returning id`), '')
    assert.equal(as(U.author, `delete from public.dp_requests where id = '${draft}' returning id`), draft)
  })

  it('файлы: граница как у заявки; последнее соглашение не убрать, замена — новым файлом; документы убираются свободно', () => {
    const id = filed()
    const concept = sql(`select id from public.s3_documents where owner_id = '${id}' and doc_category = 'dp_concept_agreement'`)
    assert.throws(() => as(U.author2, fileSql(id, 'dp_contract_doc', 'Чужой.pdf')), /Нет права менять файлы/)
    assert.throws(() => as(U.viewer, fileSql(id, 'dp_contract_doc', 'Зритель.pdf')), /Нет права менять файлы/)
    const firstDoc = sql(`select id from public.s3_documents where owner_id = '${id}' and doc_category = 'dp_contract_doc'`)
    assert.throws(() => as(U.author2, `delete from public.s3_documents where id = '${firstDoc}'`), /Нет права менять файлы/)
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${firstDoc}' returning id`), firstDoc, 'последний документ убирается')
    assert.equal(sql(`select count(*) from public.s3_documents where owner_id = '${id}' and doc_category = 'dp_contract_doc'`), '0')

    assert.throws(() => as(U.author, `delete from public.s3_documents where id = '${concept}'`), /Понятийное соглашение обязательно/)
    assert.throws(() => as(U.worker, `delete from public.s3_documents where id = '${concept}'`), /Понятийное соглашение обязательно/, 'и работающему с заявками')
    assert.throws(() => as(U.author, `update public.s3_documents set doc_category = 'dp_contract_doc' where id = '${concept}'`), /Понятийное соглашение обязательно/, 'сменой категории — тоже')
    const fresh = as(U.author, fileSql(id, 'dp_concept_agreement', 'Новая.pdf'))
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${concept}' returning id`), concept)
    assert.throws(() => as(U.author, `delete from public.s3_documents where id = '${fresh}'`), /Понятийное соглашение обязательно/)

    as(U.worker, `update public.dp_requests set status = 'in_work' where id = '${id}'`)
    assert.throws(() => as(U.author, fileSql(id, 'dp_contract_doc', 'Поздний.pdf')), /Нет права менять файлы/, 'уже в работе')
    assert.match(as(U.worker, fileSql(id, 'dp_contract_doc', 'Работник.pdf')), /^[0-9a-f-]{36}$/)

    // Служебная операция и файлы других разделов запретом не задеты.
    assert.equal(sql(`delete from public.s3_documents where id = '${fresh}' returning id`), fresh)
    const other = sql(`insert into public.s3_documents (owner_type, owner_id, s3_key, file_name) values ('dc_request', gen_random_uuid(), gen_random_uuid()::text, 'x') returning id`)
    assert.equal(sql(`delete from public.s3_documents where id = '${other}' returning id`), other)
  })

  it('черновик: файлы убираются свободно; файл к чужому черновику и к несуществующей заявке — нет', () => {
    const id = as(U.author, draftSql())
    const f = as(U.author, fileSql(id, 'dp_concept_agreement', 'П.pdf'))
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${f}' returning id`), f, 'откат неудачной подачи')
    assert.throws(() => as(U.worker, fileSql(id, 'dp_concept_agreement', 'П.pdf')), /не найдена/)
    assert.throws(() => as(U.author, fileSql('00000000-0000-4000-8000-0000000d9999', 'dp_concept_agreement', 'П.pdf')), /не найдена/)
  })

  it('уведомления: при подаче, один раз, получателям; читает и гасит только сам получатель, даже без права на раздел', () => {
    const before = sql('select count(*) from public.dp_request_alerts')
    const id = as(U.author, draftSql({ contract_title: `'Договор для окна'`, amount: 1234.5, reason: `'Нужен срочно'`, responsible_name: `'Экономов'` }))
    assert.equal(sql('select count(*) from public.dp_request_alerts'), before, 'черновик не уведомляет')
    attachBoth(U.author, id)
    submit(U.author, id)
    assert.equal(sql(`select count(*) from public.dp_request_alerts where request_id = '${id}'`), '2')
    as(U.worker, `update public.dp_requests set status = 'in_work' where id = '${id}'`)
    as(U.worker, `update public.dp_requests set status = 'new' where id = '${id}'`)
    assert.equal(sql(`select count(*) from public.dp_request_alerts where request_id = '${id}'`), '2', 'смена статуса не уведомляет заново')

    const mine = (uid) => JSON.parse(as(uid, `select coalesce(json_agg(a), '[]') from public.dp_request_my_alerts() a where a.request_id = '${id}'`))
    const [row] = mine(U.recipient)
    assert.equal(row.contract_title, 'Договор для окна')
    assert.equal(Number(row.amount), 1234.5)
    assert.equal(row.reason, 'Нужен срочно')
    assert.equal(row.responsible_name, 'Экономов')
    assert.equal(row.object_name, 'ЖК Альфа ДП')
    assert.equal(row.created_by_name, 'Авторов А. А.')
    assert.ok(row.request_number > 0)
    assert.equal(as(U.recipient, `select count(*) from public.dp_requests where id = '${id}'`), '0', 'сама заявка получателю без права закрыта')
    assert.deepEqual(mine(U.worker), [], 'не получатель')
    assert.deepEqual(mine(U.contractor), [])

    assert.equal(as(U.worker, `select public.dp_request_alerts_ack(array['${id}']::uuid[])`), '0', 'чужое не погасить')
    assert.equal(mine(U.recipient).length, 1)
    assert.equal(as(U.recipient, `select public.dp_request_alerts_ack(array['${id}']::uuid[])`), '1')
    assert.deepEqual(mine(U.recipient), [])
    assert.equal(as(U.recipient, `select public.dp_request_alerts_ack(array['${id}']::uuid[])`), '0', 'повтор безопасен')
    assert.equal(mine(U.admin).length, 1, 'у другого получателя — ещё нет')

    as(U.worker, `update public.dp_requests set deleted_at = now() where id = '${id}'`)
    assert.deepEqual(mine(U.admin), [], 'удалённая заявка окно не показывает')
  })

  it('таблица уведомлений вошедшим закрыта; функции гостю не выданы', () => {
    for (const uid of [U.recipient, U.admin]) {
      assert.throws(() => as(uid, 'select count(*) from public.dp_request_alerts'), /permission denied/)
      assert.throws(() => as(uid, `insert into public.dp_request_alerts (request_id, user_id) values (gen_random_uuid(), '${uid}')`), /permission denied/)
    }
    assert.throws(() => anon('select * from public.dp_request_my_alerts()'), /permission denied/)
    assert.throws(() => anon(`select public.dp_request_alerts_ack(array[]::uuid[])`), /permission denied/)
  })

  it('получатели: ведёт администратор; сотрудник видит только себя и список не меняет', () => {
    assert.equal(as(U.recipient, 'select count(*) from public.dp_request_alert_recipients'), '1')
    assert.equal(as(U.worker, 'select count(*) from public.dp_request_alert_recipients'), '0')
    assert.throws(() => as(U.worker, `insert into public.dp_request_alert_recipients (user_id) values ('${U.worker}')`), /row-level security/)
    assert.equal(as(U.worker, `delete from public.dp_request_alert_recipients where user_id = '${U.recipient}' returning user_id`), '')
    assert.equal(as(U.admin, `insert into public.dp_request_alert_recipients (user_id) values ('${U.viewer}') returning added_by`), U.admin)
    assert.equal(as(U.admin, `delete from public.dp_request_alert_recipients where user_id = '${U.viewer}' returning user_id`), U.viewer)
    assert.throws(() => anon('select count(*) from public.dp_request_alert_recipients'), /permission denied/)
  })

  it('права по умолчанию: создают экономист объекта и руководитель строительства, работает с заявками superuser', () => {
    sql(`insert into public.roles (key, label, is_system) values ('economist_object', 'Экономист', false), ('construction_manager', 'Руководитель строительства', false), ('superuser', 'Супер пользователь', false) on conflict (key) do nothing`)
    applyBoth()
    const grants = sql(`select string_agg(role || ':' || section || ':' || can_view || ':' || can_edit, ',' order by role, section) from public.role_permissions
      where section like 'dp_requests%' and role in ('economist_object', 'construction_manager', 'superuser')`)
    assert.equal(grants, [
      'construction_manager:dp_requests:true:false', 'construction_manager:dp_requests_create:true:true',
      'economist_object:dp_requests:true:false', 'economist_object:dp_requests_create:true:true',
      'superuser:dp_requests:true:true',
    ].join(','))
  })

  it('откат короткой формы: снова полная подача; заявки целы; обязательность колонок — только если нет пустых; повторное применение', () => {
    const shortId = as(U.author, SHORT_DRAFT)
    as(U.author, fileSql(shortId, 'dp_concept_agreement', 'Понятийка.pdf'))
    submit(U.author, shortId)
    const before = sql('select count(*) from public.dp_requests')
    psqlAt(db.port, null, { file: SHORT_ROLLBACK })
    psqlAt(db.port, null, { file: SHORT_ROLLBACK })
    assert.equal(sql('select count(*) from public.dp_requests'), before)
    assert.equal(sql(`select coalesce(contract_title, 'пусто') from public.dp_requests where id = '${shortId}'`), 'пусто', 'пустые заявки не тронуты')
    assert.equal(sql(`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'dp_requests' and column_name = 'amount'`), 'YES', 'есть пустые — колонки необязательны')
    assert.match(psqlAt(db.port, null, { file: SHORT_CHECK }), /^FAIL /m)
    const draft = as(U.author, draftSql())
    as(U.author, fileSql(draft, 'dp_concept_agreement', 'Понятийка.pdf'))
    assert.throws(() => submit(U.author, draft), /без документа договора/, 'запреты 20261227 снова действуют')
    assert.throws(() => as(U.author, draftSql({ object_id: 'null' })), /row-level security/, 'и правила')
    assert.equal(as(U.author, `update public.dp_requests set contract_title = 'Правка автора' where id = '${draft}' returning id`), draft)

    // Пустых заявок нет — откат возвращает обязательность.
    sql(`delete from public.dp_requests where object_id is null or contract_title is null or amount is null or reason is null`)
    psqlAt(db.port, null, { file: SHORT_ROLLBACK })
    assert.equal(sql(`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'dp_requests' and column_name = 'amount'`), 'NO')

    psqlAt(db.port, null, { file: SHORT })
    assert.doesNotMatch(psqlAt(db.port, null, { file: SHORT_CHECK }), /^FAIL/m)
    assert.match(as(U.author, SHORT_DRAFT), /^[0-9a-f-]{36}$/)
  })

  it('откат: заявки и получатели целы, доступа нет; повторное применение их видит', () => {
    const id = filed()
    const before = sql('select (select count(*) from public.dp_requests), (select count(*) from public.dp_request_alert_recipients), (select count(*) from public.dp_request_alerts)')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select (select count(*) from public.dp_requests), (select count(*) from public.dp_request_alert_recipients), (select count(*) from public.dp_request_alerts)'), before)
    assert.throws(() => as(U.worker, 'select count(*) from public.dp_requests'), /permission denied/)
    assert.equal(sql("select count(*) from public.role_permissions where section in ('dp_requests', 'dp_requests_create')"), '0')
    // Запрет на файлы снят: файлы других разделов и заявок работают без функций миграции.
    assert.equal(sql(`select count(*) from pg_trigger where tgname like 's3_documents_dp_request%'`), '0')
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    applyBoth()
    sql(`insert into public.role_permissions (role, section, can_view, can_edit) values ('dp_viewer', 'dp_requests', true, false) on conflict do nothing`)
    assert.equal(as(U.viewer, `select count(*) from public.dp_requests where id = '${id}'`), '1')
  })
})

describe('Заявка на ДП: база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(sub ? { osp_role: 'authenticated', sub } : { osp_role: 'anon' })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const submit = (uid, id) => as(uid, `update public.dp_requests set status = 'new' where id = '${id}' returning request_number`)
  const filed = (uid = U.author, o = {}) => {
    const id = as(uid, draftSql(o))
    as(uid, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    as(uid, fileSql(id, 'dp_contract_doc', 'Договор.docx'))
    submit(uid, id)
    return id
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dp-requests-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    assert.match(res.stdout, new RegExp(`OK ${SHORT_NAME}: применена`))
    internal(FIXTURE)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('начальные получатели занесены — только те, кто есть в этой базе; права ролей выданы', () => {
    const seeded = internal(`select count(*) from public.dp_request_alert_recipients where user_id in ('c12b7fec-2ff6-4804-ae8b-604ffcb4c2e8', 'c6e89e48-fa2e-44ce-aae7-54f5d7289e46')`)
    const present = internal(`select count(*) from public.user_roles where user_id in ('c12b7fec-2ff6-4804-ae8b-604ffcb4c2e8', 'c6e89e48-fa2e-44ce-aae7-54f5d7289e46')`)
    assert.equal(seeded, present)
    assert.equal(internal(`select count(*) from public.role_permissions where section = 'dp_requests_create' and can_edit and role in ('economist_object', 'construction_manager')`),
      internal(`select count(*) from public.roles where key in ('economist_object', 'construction_manager')`))
  })

  it('без понятийного соглашения не подаётся; с ним — номер и уведомления получателям, остальное можно не заполнять', () => {
    const id = as(U.author, SHORT_DRAFT)
    assert.throws(() => submit(U.author, id), /без понятийного соглашения/)
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    assert.match(submit(U.author, id), /^\d+$/)
    assert.equal(internal(`select count(*) from public.dp_request_alerts where request_id = '${id}' and user_id in ('${U.recipient}', '${U.admin}')`), '2')
    assert.equal(internal(`select created_by || '|' || created_by_name from public.dp_requests where id = '${id}'`), `${U.author}|Авторов А. А.`)
    assert.equal(internal(`select coalesce(object_id::text, 'пусто') || '|' || coalesce(amount::text, 'пусто') from public.dp_requests where id = '${id}'`), 'пусто|пусто')
  })

  it('заявка без объекта: работающий с другого объекта видит и заполняет, чужой объект не ставит; автор поля отдела не пишет', () => {
    const id = as(U.otherObj, SHORT_DRAFT)
    as(U.otherObj, fileSql(id, 'dp_concept_agreement', 'Понятийка.pdf'))
    submit(U.otherObj, id)
    const sees = (uid) => as(uid, `select count(*) from public.dp_requests where id = '${id}'`)
    assert.equal(sees(U.otherObj), '1')
    assert.equal(sees(U.workerA), '1')
    assert.equal(sees(U.author), '0', 'просмотр с привязкой: заявка ещё ничья')
    assert.throws(() => as(U.otherObj, `update public.dp_requests set amount = 5 where id = '${id}'`), /заполняет сотрудник, работающий с заявками/)
    assert.throws(() => as(U.workerA, `update public.dp_requests set object_id = '${OBJ_B}' where id = '${id}'`), /row-level security/)
    assert.equal(as(U.workerA, `update public.dp_requests set object_id = '${OBJ_A}' where id = '${id}' returning id`), id)
    assert.equal(sees(U.author), '1')
    assert.equal(as(U.otherObj, `update public.dp_requests set reason = 'Примечание' where id = '${id}' returning id`), id)
  })

  it('создание и чтение: право и свои объекты; черновик — только автору; подрядчику, сотруднику без раздела и гостю — ничего', () => {
    assert.throws(() => as(U.viewer, draftSql()), /row-level security/)
    assert.throws(() => as(U.worker, draftSql()), /row-level security/)
    assert.throws(() => as(U.author, draftSql({ object_id: `'${OBJ_B}'` })), /row-level security/)
    const draft = as(U.author, draftSql())
    assert.equal(as(U.worker, `select count(*) from public.dp_requests where id = '${draft}'`), '0')
    const a = filed()
    const sees = (uid) => as(uid, `select count(*) from public.dp_requests where id = '${a}'`)
    assert.equal(sees(U.viewer), '1')
    assert.equal(sees(U.otherObj), '0', 'другой объект')
    for (const uid of [U.none, U.contractor, null]) assert.equal(sees(uid), '0', String(uid))
    assert.equal(as(U.author, `delete from public.dp_requests where id = '${draft}' returning id`), draft)
  })

  it('статус и правка: автор — примечание и пока не в работе, статус и поля отдела — право работы', () => {
    const id = filed()
    assert.throws(() => as(U.author, `update public.dp_requests set status = 'in_work' where id = '${id}'`), /меняет сотрудник с правом правки/)
    assert.equal(as(U.author, `update public.dp_requests set reason = 'Правка' where id = '${id}' returning id`), id)
    assert.throws(() => as(U.author, `update public.dp_requests set contract_title = 'Правка' where id = '${id}'`), /заполняет сотрудник, работающий с заявками/)
    assert.equal(as(U.author2, `update public.dp_requests set reason = 'Чужая' where id = '${id}' returning id`), '')
    assert.equal(as(U.worker, `update public.dp_requests set status = 'in_work', contract_title = 'Правка' where id = '${id}' returning id`), id)
    assert.equal(as(U.author, `update public.dp_requests set reason = 'Поздняя' where id = '${id}' returning id`), '')
  })

  it('файлы: граница как у заявки, последнее соглашение не убрать, документы убираются', () => {
    const id = filed()
    const concept = internal(`select id from public.s3_documents where owner_id = '${id}' and doc_category = 'dp_concept_agreement'`)
    const contractDoc = internal(`select id from public.s3_documents where owner_id = '${id}' and doc_category = 'dp_contract_doc'`)
    assert.throws(() => as(U.author2, fileSql(id, 'dp_contract_doc', 'Чужой.pdf')), /Нет права менять файлы/)
    assert.throws(() => as(U.author, `delete from public.s3_documents where id = '${concept}'`), /Понятийное соглашение обязательно/)
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${contractDoc}' returning id`), contractDoc)
    as(U.author, fileSql(id, 'dp_concept_agreement', 'Новая.pdf'))
    assert.equal(as(U.author, `delete from public.s3_documents where id = '${concept}' returning id`), concept)
  })

  it('уведомления: читает и гасит только получатель; таблица вошедшим не видна, запись закрыта', () => {
    const id = filed()
    const mine = (uid) => as(uid, `select count(*) from public.dp_request_my_alerts() a where a.request_id = '${id}'`)
    assert.equal(mine(U.recipient), '1')
    assert.equal(mine(U.worker), '0')
    assert.equal(as(U.recipient, `select contract_title from public.dp_request_my_alerts() a where a.request_id = '${id}'`), 'Договор')
    assert.equal(as(U.recipient, `select count(*) from public.dp_requests where id = '${id}'`), '0', 'без права на раздел сама заявка закрыта')
    assert.equal(as(U.recipient, 'select count(*) from public.dp_request_alerts'), '0')
    assert.throws(() => as(U.recipient, `insert into public.dp_request_alerts (request_id, user_id) values ('${id}', '${U.worker}')`), /row-level security/)
    assert.equal(as(U.worker, `select public.dp_request_alerts_ack(array['${id}']::uuid[])`), '0')
    assert.equal(mine(U.recipient), '1')
    assert.equal(as(U.recipient, `select public.dp_request_alerts_ack(array['${id}']::uuid[])`), '1')
    assert.equal(mine(U.recipient), '0')
  })

  it('получатели: ведёт администратор; сотрудник видит только себя', () => {
    assert.equal(as(U.recipient, `select count(*) from public.dp_request_alert_recipients where user_id = '${U.recipient}'`), '1')
    assert.equal(as(U.worker, `select count(*) from public.dp_request_alert_recipients where user_id = '${U.recipient}'`), '0')
    assert.throws(() => as(U.worker, `insert into public.dp_request_alert_recipients (user_id) values ('${U.worker}')`), /row-level security/)
    assert.equal(as(U.admin, `insert into public.dp_request_alert_recipients (user_id) values ('${U.viewer}') returning user_id`), U.viewer)
    assert.equal(as(U.admin, `delete from public.dp_request_alert_recipients where user_id = '${U.viewer}' returning user_id`), U.viewer)
  })
})
