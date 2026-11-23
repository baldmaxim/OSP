// 20270226_registry_osp_lawyers (решение пользователя 23.11.2026): в «Реестре по договорам» юрист — только действующий юрист ОСП
// (учётка, как исполнители доски ДП/ДС); исполнитель «Заключения ДП» переходит в договор; договор появляется сразу при подаче заявки,
// заявкам, которые уже на доске, — тоже. На слепке схемы прода: проверка для прода до миграции — FAIL, а не ошибка; перенос прежних
// юристов (полное ФИО и начало, неоднозначный и не юрист — снят со следом в «Истории», прежнее поле не тронуто); проверка в базе
// (только смена значения, служебные — без проверки); подача → «Новая заявка», взяли в работу → «В работе»; юрист следует за
// исполнителями, пока его не поменяли в реестре; удаление заявки в «Новых» уносит договор в «Удалённые» и обратно; повтор и откат.
// Нужны Docker и psql. Люди и объекты вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270226_registry_osp_lawyers'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('supabase', 'migrations', `${NAME}.sql`)
const YANDEX = file('migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270226.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

const O = { a: '00000000-0000-4000-8000-0000000ee601', b: '00000000-0000-4000-8000-0000000ee602' }
const CP = { a: '00000000-0000-4000-8000-0000000ee701' }
const U = {
  author: '00000000-0000-4000-8000-0000000ee111', // подаёт заявки доски
  lawyer: '00000000-0000-4000-8000-0000000ee112', // юрист ОСП: правит доску и реестр
  lawyer2: '00000000-0000-4000-8000-0000000ee113', // юрист ОСП
  lawyer3: '00000000-0000-4000-8000-0000000ee114', // юрист ОСП — однофамилец второго
  blocked: '00000000-0000-4000-8000-0000000ee115', // юрист, учётка заблокирована
  admin: '00000000-0000-4000-8000-0000000ee116', // экономист с ролью администратора — не юрист ОСП
}
// «Сотрудники» — прежний «Ответственный юрист» реестра.
const C = {
  full: '00000000-0000-4000-8000-0000000ee201', short: '00000000-0000-4000-8000-0000000ee202', blocked: '00000000-0000-4000-8000-0000000ee203',
  admin: '00000000-0000-4000-8000-0000000ee204', ambiguous: '00000000-0000-4000-8000-0000000ee205',
}
const K = {
  full: '00000000-0000-4000-8000-0000000ee301', short: '00000000-0000-4000-8000-0000000ee302', blocked: '00000000-0000-4000-8000-0000000ee303',
  admin: '00000000-0000-4000-8000-0000000ee304', ambiguous: '00000000-0000-4000-8000-0000000ee305', none: '00000000-0000-4000-8000-0000000ee306',
  manual: '00000000-0000-4000-8000-0000000ee307',
}
// Заявки «Заключение ДП» до миграции.
const R = {
  fresh: '00000000-0000-4000-8000-0000000ee401', // «Новые», исполнитель — второй юрист
  accounting: '00000000-0000-4000-8000-0000000ee402', // дальше по доске, исполнители: подающий, юрист
  manual: '00000000-0000-4000-8000-0000000ee403', // «Новые», похожий договор уже внесён вручную
  deleted: '00000000-0000-4000-8000-0000000ee404', // удалена в «Новых»
  working: '00000000-0000-4000-8000-0000000ee405', // «В работе» — договор создан ещё 20270225, без юриста
}
const SETUP = `
  insert into public.roles (key, label, is_system) values ('lawyer', 'Юрист', false), ('rol_author', 'Тест: подаёт заявки', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('rol_author', 'doc_check_requests', true, false), ('rol_author', 'doc_check_requests_create', true, true),
    ('lawyer', 'doc_check_requests', true, true), ('lawyer', 'contracts', true, true)
    on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.objects (id, name, address, status) values
    ('${O.a}', 'Тест: ЖК Зета', 'Москва', 'main_construction'), ('${O.b}', 'Тест: ЖК Эта', 'Москва', 'main_construction');
  insert into public.counterparties (id, name) values ('${CP.a}', 'ООО Тест Фасад');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.author}', 'rol_author', true, false, 'Подающий Пётр Петрович', 'rol-a@example.invalid', null, '{}'),
    ('${U.lawyer}', 'lawyer', true, false, 'Юристова Юлия Юрьевна', 'rol-l@example.invalid', null, '{}'),
    ('${U.lawyer2}', 'lawyer', true, false, 'Правова Анна Сергеевна', 'rol-l2@example.invalid', null, '{}'),
    ('${U.lawyer3}', 'lawyer', true, false, 'Правова Мария Ивановна', 'rol-l3@example.invalid', null, '{}'),
    ('${U.blocked}', 'lawyer', false, true, 'Уволенов Борис Борисович', 'rol-b@example.invalid', null, '{}'),
    ('${U.admin}', 'admin', true, false, 'Экономистова Эльвира Эдуардовна', 'rol-e@example.invalid', null, '{}');
  insert into public.contacts (id, full_name, position) values
    ('${C.full}', 'Юристова  Юлия Юрьевна', 'Юрист'), ('${C.short}', 'юристова юлия', 'Юрист ОСП'),
    ('${C.blocked}', 'Уволенов Борис Борисович', 'Юрист'), ('${C.admin}', 'Экономистова Эльвира', 'Экономист ОСП'),
    ('${C.ambiguous}', 'Правова', 'Юрист');
  insert into public.contracts (id, object_id, record_type, status, contract_number, responsible_contact_id) values
    ('${K.full}', '${O.a}', 'dp', 'in_work', 'Тест-ЮР-1', '${C.full}'), ('${K.short}', '${O.a}', 'dp', 'in_work', 'Тест-ЮР-2', '${C.short}'),
    ('${K.blocked}', '${O.a}', 'dp', 'in_work', 'Тест-ЮР-3', '${C.blocked}'), ('${K.admin}', '${O.a}', 'dp', 'completed', 'Тест-ЮР-4', '${C.admin}'),
    ('${K.ambiguous}', '${O.a}', 'dp', 'in_work', 'Тест-ЮР-5', '${C.ambiguous}'), ('${K.none}', '${O.a}', 'dp', 'in_work', 'Тест-ЮР-6', null);
  -- Поданы до 20270225 (на проде так — заявка в «Бухгалтерии» без договора): триггер договора выключен на время вставки.
  alter table public.doc_check_requests disable trigger doc_check_dp_conclusion_contract;
  insert into public.doc_check_requests (id, object_id, counterparty_id, doc_type, status, sort_order, assignee_ids, deleted_at, created_at) values
    ('${R.fresh}', '${O.b}', null, 'dp_conclusion', 'new', 1, array['${U.lawyer2}']::uuid[], null, now() - interval '2 days'),
    ('${R.accounting}', '${O.b}', null, 'dp_conclusion', 'accounting', 2, array['${U.author}', '${U.lawyer}']::uuid[], null, now() - interval '2 days'),
    ('${R.manual}', '${O.a}', '${CP.a}', 'dp_conclusion', 'new', 3, '{}', null, now() - interval '2 days'),
    ('${R.deleted}', '${O.b}', null, 'dp_conclusion', 'new', 4, '{}', now() - interval '1 day', now() - interval '2 days');
  alter table public.doc_check_requests enable trigger doc_check_dp_conclusion_contract;
  -- Взята в работу уже при 20270225 — договор без юриста.
  insert into public.doc_check_requests (id, object_id, counterparty_id, doc_type, status, sort_order, assignee_ids, created_at) values
    ('${R.working}', '${O.b}', null, 'dp_conclusion', 'in_progress', 5, array['${U.lawyer2}']::uuid[], now() - interval '2 days');
  insert into public.contracts (id, object_id, counterparty_id, record_type, status, contract_number)
    values ('${K.manual}', '${O.a}', '${CP.a}', 'dp', 'new_request', 'Тест-РУЧН-2');`
const createSql = (o = {}) => `insert into public.doc_check_requests (object_id, counterparty_id, doc_type, status, sort_order, notes)
  values (${o.object === null ? 'null' : `'${o.object || O.b}'`}, null, '${o.type || 'dp_conclusion'}', '${o.status || 'new'}', 1, 'Тест: подача') returning id`
const contractOf = (id, cols) => `select ${cols} from public.contracts where doc_check_request_id = '${id}'`

describe('Юристы реестра и договоры из «Заключения ДП» сразу при подаче: файлы миграции', () => {
  const body = (text) => text.slice(text.indexOf('\nDO $$'), text.indexOf('-- ── Права'))

  it('тело одно в обеих базах; в базе Яндекса транзакцию задаёт migrate.sh, ролей Supabase в теле нет; функции служебные', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.ok(body(b).length > 10000)
    assert.equal(body(a), body(b))
    assert.doesNotMatch(b, /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(body(b), /\b(anon|authenticated|service_role)\b/, 'база Яндекса: одна учётка')
    assert.equal((b.match(/SECURITY DEFINER\n {2}SET search_path = public, pg_temp\n {2}SET application_name = 'osp:internal'/g) || []).length, 7)
    assert.ok(fs.existsSync(YANDEX_CHECK))
  })

  it('миграция — в списке кандидатов; шлюз открывает только список юристов — праву «Договоры» или «Отчёты»; отчёт читает юриста', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'allow.json')))
    for (const fn of ['osp_is_active_lawyer', 'osp_first_lawyer', 'osp_user_display_name', 'contracts_lawyer_guard', 'dp_conclusion_contract_create']) {
      assert.equal(allow.rpc[fn], undefined, fn)
    }
    assert.deepEqual(allow.rpc.list_osp_lawyers, ['authenticated'])
    assert.match(read(YANDEX), /^-- osp:allow rpc list_osp_lawyers authenticated$/m)
    const sections = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'db-sections.json')))
    assert.deepEqual(sections.rpc.list_osp_lawyers.call, [{ any: [['contracts', 'view'], ['reports', 'view']] }])
    const reports = sections.tables.contracts.select.find((r) => JSON.stringify(r.any) === JSON.stringify([['reports', 'view']]))
    assert.ok(reports.columns.includes('responsible_user_id'), 'отчёт «Договоры по юристам» читает новое поле')
  })
})

describe('Юристы реестра и договоры из «Заключения ДП» сразу при подаче: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const move = (uid, id, status) => as(uid, `update public.doc_check_requests set status = '${status}' where id = '${id}'`)
  const assign = (uid, id, ids) => as(uid, `update public.doc_check_requests set assignee_ids = array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]
    where id = '${id}'`)
  const lawyerOf = (contract) => sql(`select coalesce(responsible_user_id::text, 'нет') from public.contracts where id = '${contract}'`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: file('supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (path.basename(m) >= `${NAME}.sql`) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    sql(SETUP)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода: до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.ok(checkBefore.split('\n').every((l) => /^(OK|FAIL) /.test(l)), checkBefore)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 9, out)
    const own = sql(read(YANDEX_CHECK))
    assert.doesNotMatch(own, /^FAIL/m, own)
  })

  it('перенос юристов: полное ФИО и начало — на учётку; заблокированный, не юрист, неоднозначный — сняты со следом; прежнее поле не тронуто', () => {
    assert.equal(lawyerOf(K.full), U.lawyer, 'ФИО совпало (без регистра и лишних пробелов)')
    assert.equal(lawyerOf(K.short), U.lawyer, '«Фамилия Имя» ↔ «Фамилия Имя Отчество»')
    for (const k of [K.blocked, K.admin, K.ambiguous, K.none]) assert.equal(lawyerOf(k), 'нет', k)
    assert.equal(sql(`select string_agg(responsible_contact_id::text, ',' order by contract_number) from public.contracts
      where id in ('${K.full}', '${K.short}', '${K.blocked}', '${K.admin}', '${K.ambiguous}')`),
    [C.full, C.short, C.blocked, C.admin, C.ambiguous].join(','))
    assert.equal(sql(`select description from public.contract_audit_log where contract_id = '${K.blocked}' and field_name = 'responsible_user_id'`),
      'Ответственный юрист «Уволенов Борис Борисович» снят: в реестре остаются только действующие юристы ОСП (учётка заблокирована, другая роль или не найдена)')
    for (const k of [K.admin, K.ambiguous]) {
      assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${k}' and field_name = 'responsible_user_id'`), '1', k)
    }
    for (const k of [K.full, K.none]) {
      assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${k}'`), '0', k)
    }
  })

  it('заявки на доске: договор в любой колонке, «Новые» — «Новая заявка» без даты; юрист — из исполнителей; похожий и удалённые — без договора', () => {
    assert.equal(sql(contractOf(R.fresh, `concat_ws(' ', status, coalesce(accepted_date::text, 'без даты'), responsible_user_id)`)),
      `new_request без даты ${U.lawyer2}`)
    assert.equal(sql(contractOf(R.accounting, `concat_ws(' ', status, accepted_date = (now() at time zone 'Europe/Moscow')::date, responsible_user_id)`)),
      `in_work t ${U.lawyer}`, 'первый юрист ОСП среди исполнителей, подающий — не юрист')
    assert.match(sql(`select l.description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${R.accounting}' and l.event_type = 'created'`),
    /^Создан договор \(без номера\) при выкладке: заявка «Заключение ДП» ID .* уже была на доске; ответственный юрист — Юристова Юлия Юрьевна \(исполнитель заявки\)$/)
    assert.equal(sql(contractOf(R.manual, 'count(*)')), '0', 'похожий договор уже внесён вручную')
    assert.equal(sql(contractOf(R.deleted, 'count(*)')), '0')
    assert.equal(sql(contractOf(R.working, 'responsible_user_id')), U.lawyer2, 'договор из 20270225 получил исполнителя заявки')
    // Пропущенная заявка договора не получает и дальше по доске.
    move(U.lawyer, R.manual, 'in_progress')
    assert.equal(sql(contractOf(R.manual, 'count(*)')), '0')
  })

  it('назначить можно только действующего юриста ОСП; прежнего снятого не требуется убирать для правки договора', () => {
    as(U.lawyer, `update public.contracts set responsible_user_id = '${U.lawyer2}' where id = '${K.none}'`)
    assert.equal(lawyerOf(K.none), U.lawyer2)
    for (const uid of [U.blocked, U.admin, U.author]) {
      assert.throws(() => as(U.lawyer, `update public.contracts set responsible_user_id = '${uid}' where id = '${K.none}'`),
        /только действующего юриста ОСП/, uid)
      assert.throws(() => as(U.lawyer, `insert into public.contracts (object_id, record_type, status, responsible_user_id)
        values ('${O.a}', 'dp', 'new_request', '${uid}')`), /только действующего юриста ОСП/, uid)
    }
    assert.equal(lawyerOf(K.none), U.lawyer2)
    // Юриста заблокировали после назначения: договор правится, юрист в базе остаётся (страница его не показывает).
    sql(`update public.contracts set responsible_user_id = '${U.blocked}' where id = '${K.blocked}'`)
    as(U.lawyer, `update public.contracts set notes = 'Тест: правка', responsible_user_id = '${U.blocked}' where id = '${K.blocked}'`)
    assert.equal(lawyerOf(K.blocked), U.blocked)
    as(U.lawyer, `update public.contracts set responsible_user_id = null where id = '${K.blocked}'`)
    assert.equal(lawyerOf(K.blocked), 'нет')
  })

  it('подача — договор «Новая заявка»; исполнитель → юрист договора; в работу — «В работе» с датой; вручную поставленного юриста не трогаем', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    assert.match(id, /^[0-9a-f-]{36}$/, id)
    assert.equal(sql(contractOf(id, `concat_ws(' ', record_type, status, coalesce(accepted_date::text, 'без даты'), coalesce(responsible_user_id::text, 'без юриста'))`)),
      'dp new_request без даты без юриста')
    assert.equal(sql(`select l.changed_by_name || ' | ' || l.description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${id}' and l.event_type = 'created'`),
    `Подающий Пётр Петрович | Создан договор (без номера) автоматически: подана заявка «Заключение ДП» ID ${sql(`select request_number from public.doc_check_requests where id = '${id}'`)}`)
    const contract = sql(contractOf(id, 'id'))

    assign(U.lawyer, id, [U.author, U.lawyer2])
    assert.equal(lawyerOf(contract), U.lawyer2)
    assert.match(sql(`select changed_by_name || ' | ' || description from public.contract_audit_log
      where contract_id = '${contract}' and field_name = 'responsible_user_id'`),
    /^Юристова Юлия Юрьевна \| Ответственный юрист: — → Правова Анна Сергеевна \(исполнители заявки «Заключение ДП» ID \d+\)$/)

    move(U.lawyer, id, 'in_progress')
    assert.equal(sql(`select concat_ws(' ', status, accepted_date = (now() at time zone 'Europe/Moscow')::date) from public.contracts where id = '${contract}'`),
      'in_work t')
    assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${contract}' and event_type = 'status_changed'`), '1')
    move(U.lawyer, id, 'new')
    move(U.lawyer, id, 'edo')
    assert.equal(sql(`select status from public.contracts where id = '${contract}'`), 'in_work', 'возврат в «Новые» договор не трогает')
    assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${contract}' and event_type = 'status_changed'`), '1')

    // Сменили исполнителя на доске — юрист договора следует.
    assign(U.lawyer, id, [U.lawyer3])
    assert.equal(lawyerOf(contract), U.lawyer3)
    // В реестре поставили другого — смена исполнителей его не трогает.
    as(U.lawyer, `update public.contracts set responsible_user_id = '${U.lawyer}' where id = '${contract}'`)
    assign(U.lawyer, id, [U.lawyer2])
    assert.equal(lawyerOf(contract), U.lawyer)
    // Исполнителей сняли совсем, а юрист договора был из них, — юриста нет.
    as(U.lawyer, `update public.contracts set responsible_user_id = '${U.lawyer2}' where id = '${contract}'`)
    assign(U.lawyer, id, [])
    assert.equal(lawyerOf(contract), 'нет')
    assert.equal(sql(contractOf(id, 'count(*)')), '1', 'один договор на заявку')
  })

  it('список юристов: любой сотрудник видит только действующих юристов ОСП — id и ФИО', () => {
    const rows = as(U.author, `select string_agg(user_id || ' ' || display_name || ' ' || role, '|' order by display_name)
      from public.list_osp_lawyers() where user_id in ('${U.lawyer}', '${U.lawyer2}', '${U.lawyer3}', '${U.blocked}', '${U.admin}', '${U.author}')`)
    assert.equal(rows, [`${U.lawyer2} Правова Анна Сергеевна lawyer`, `${U.lawyer3} Правова Мария Ивановна lawyer`,
      `${U.lawyer} Юристова Юлия Юрьевна lawyer`].join('|'))
  })

  it('подача без объекта и контрагента не падает: договор без объекта', () => {
    const id = as(U.lawyer, createSql({ object: null })).split('\n')[0]
    assert.match(id, /^[0-9a-f-]{36}$/, id)
    assert.equal(sql(contractOf(id, `concat_ws(' ', status, coalesce(object_id::text, 'без объекта'), coalesce(counterparty_id::text, 'без контрагента'))`)),
      'new_request без объекта без контрагента')
  })

  it('ДП и ДС договоров не создают; создана сразу в работе — «В работе»', () => {
    for (const type of ['dp', 'ds']) {
      const other = as(U.lawyer, createSql({ type })).split('\n')[0]
      move(U.lawyer, other, 'in_progress')
      assert.equal(sql(contractOf(other, 'count(*)')), '0', type)
    }
    const direct = as(U.lawyer, createSql({ status: 'in_progress' })).split('\n')[0]
    assert.equal(sql(contractOf(direct, 'status')), 'in_work')
  })

  it('удалили заявку в «Новых» — договор в «Удалённые», восстановили — обратно; удаление взятой в работу договор не трогает', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${id}'`)
    assert.equal(sql(contractOf(id, `deleted_at is not null`)), 't')
    assert.match(sql(`select description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${id}' and l.event_type = 'soft_deleted'`), /удалена на доске$/)
    as(U.lawyer, `update public.doc_check_requests set deleted_at = null where id = '${id}'`)
    assert.equal(sql(contractOf(id, `deleted_at is null`)), 't')
    assert.equal(sql(contractOf(id, 'count(*)')), '1')

    // Договор унесли в «Удалённые» вручную — восстановление заявки его не возвращает.
    const manual = as(U.author, createSql()).split('\n')[0]
    const k = sql(contractOf(manual, 'id'))
    as(U.lawyer, `update public.contracts set deleted_at = now() where id = '${k}';
      insert into public.contract_audit_log (contract_id, event_type, description) values ('${k}', 'soft_deleted', 'вручную')`)
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${manual}'`)
    as(U.lawyer, `update public.doc_check_requests set deleted_at = null where id = '${manual}'`)
    assert.equal(sql(contractOf(manual, `deleted_at is not null`)), 't')

    const worked = as(U.author, createSql()).split('\n')[0]
    move(U.lawyer, worked, 'in_progress')
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${worked}'`)
    assert.equal(sql(contractOf(worked, `deleted_at is null`)), 't')
  })

  it('повтор безопасен (перенос юристов и дописка — один раз); откат: прежнее поведение, договоры остаются; миграция встаёт снова', () => {
    const before = sql(`select count(*) from public.contracts`)
    as(U.lawyer, `update public.contracts set responsible_user_id = null where id = '${K.full}'`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql(`select count(*) from public.contracts`), before, 'второго договора нет')
    assert.equal(lawyerOf(K.full), 'нет', 'снятого в реестре юриста повтор не возвращает')

    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from public.contracts`), before, 'договоры остались')
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'contracts' and column_name = 'responsible_user_id'`), '0')
    assert.equal(sql(`select to_regprocedure('public.osp_first_lawyer(uuid[])') is null and to_regprocedure('public.contracts_lawyer_guard()') is null`), 't')
    const id = as(U.author, createSql()).split('\n')[0]
    assert.equal(sql(contractOf(id, 'count(*)')), '0', 'после отката — как в 20270225: в «Новых» договора нет')
    move(U.lawyer, id, 'in_progress')
    assert.equal(sql(contractOf(id, 'status')), 'in_work')

    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
  })
})

describe('Юристы реестра — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  // Только люди и права теста: прежние договоры и заявки копии не трогаем.
  const PEOPLE = SETUP.slice(0, SETUP.indexOf('  insert into public.contacts'))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-registry-lawyers-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [file('migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    applied = res.stdout + res.stderr
    assert.equal(res.status, 0, applied)
    internal(PEOPLE)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('миграция применена с проверкой прав под одну учётку; проверка для прода на копии — все OK', () => {
    assert.match(applied, new RegExp(`OK ${NAME}: применена`))
    const backup = internal(read(CHECK))
    assert.doesNotMatch(backup, /^FAIL/m, backup)
  })

  it('под учёткой-владельцем (FORCE RLS): подача — договор; исполнитель — юрист договора; не юриста база не назначит', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    assert.match(id, /^[0-9a-f-]{36}$/, id)
    assert.equal(internal(contractOf(id, 'status')), 'new_request')
    as(U.lawyer, `update public.doc_check_requests set assignee_ids = array['${U.lawyer2}']::uuid[] where id = '${id}'`)
    assert.equal(internal(contractOf(id, 'responsible_user_id')), U.lawyer2)
    const contract = internal(contractOf(id, 'id'))
    for (const uid of [U.blocked, U.admin]) {
      assert.throws(() => as(U.lawyer, `update public.contracts set responsible_user_id = '${uid}' where id = '${contract}'`),
        /только действующего юриста ОСП/, uid)
    }
    as(U.lawyer, `update public.contracts set responsible_user_id = '${U.lawyer}' where id = '${contract}'`)
    assert.equal(internal(contractOf(id, 'responsible_user_id')), U.lawyer)
    // Список юристов под учёткой-владельцем: читает user_roles через пропуск служебной функции.
    const listed = as(U.author, `select string_agg(user_id::text, ',' order by user_id) from public.list_osp_lawyers()
      where user_id in ('${U.lawyer}', '${U.lawyer2}', '${U.blocked}', '${U.admin}')`)
    assert.equal(listed, [U.lawyer, U.lawyer2].sort().join(','))
  })
})
