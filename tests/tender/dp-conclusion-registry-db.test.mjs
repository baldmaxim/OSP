// 20270225_dp_conclusion_registry_contract (решение пользователя 23.11.2026): «Заключение ДП», взятое в работу на доске «Заявки на
// проверку ДП/ДС», само встаёт договором «В работе» в «Реестре по договорам»; исполнителю, которого назначили на такую заявку, —
// большое окно; заявкам, уже стоящим «В работе», — договор, если похожего ещё нет. На слепке схемы прода: проверка для прода до
// миграции — FAIL, а не ошибка; один договор на заявку при любом движении карточки; ДП/ДС договоров не создают; окно — только
// назначенному другим, только «Заключению ДП», снятому до прочтения — нет; повтор безопасен; откат оставляет договоры. Второй
// блок — копия прода как база Яндекса: настоящий migrate.sh (проверка прав под одну учётку и .check.sql) и то же под
// учёткой-владельцем (FORCE RLS). Нужны Docker и psql (второй блок — и проверенная копия прода). Окно в браузере —
// tests/tender/dp-requests.test.mjs. Люди и объекты вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270225_dp_conclusion_registry_contract'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('supabase', 'migrations', `${NAME}.sql`)
const YANDEX = file('migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270225.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

const O = { a: '00000000-0000-4000-8000-0000000dd601', b: '00000000-0000-4000-8000-0000000dd602' }
const CP = { a: '00000000-0000-4000-8000-0000000dd701', b: '00000000-0000-4000-8000-0000000dd702' }
const T = { a: '00000000-0000-4000-8000-0000000dd801' }
const U = {
  author: '00000000-0000-4000-8000-0000000dd111', // руководитель строительства: только создаёт заявки доски
  lawyer: '00000000-0000-4000-8000-0000000dd112', // отдел: правка доски
  lawyer2: '00000000-0000-4000-8000-0000000dd113', // второй юрист отдела
}
// Заявки «В работе» до миграции (дописка договоров): без похожего договора, с похожим (внесён вручную), ДС — не «Заключение ДП».
const OLD = {
  bare: '00000000-0000-4000-8000-0000000dd901', manual: '00000000-0000-4000-8000-0000000dd902', ds: '00000000-0000-4000-8000-0000000dd903',
  fresh: '00000000-0000-4000-8000-0000000dd904',
}
const ROLES = `
  insert into public.roles (key, label, is_system) values
    ('dcr_author', 'Тест: подаёт заявки', false), ('dcr_lawyer', 'Тест: отдел', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dcr_author', 'doc_check_requests', true, false), ('dcr_author', 'doc_check_requests_create', true, true),
    ('dcr_lawyer', 'doc_check_requests', true, true), ('dcr_lawyer', 'contracts', true, true)
    on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;`
const PEOPLE = `
  insert into public.objects (id, name, address, status) values
    ('${O.a}', 'Тест: ЖК Дельта', 'Москва', 'main_construction'), ('${O.b}', 'Тест: ЖК Эпсилон', 'Москва', 'main_construction');
  insert into public.counterparties (id, name) values ('${CP.a}', 'ООО Тест Монолит'), ('${CP.b}', 'ООО Тест Кровля');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.author}', 'dcr_author', true, false, 'Авторов А. А.', 'dcr-a@example.invalid', null, '{}'),
    ('${U.lawyer}', 'dcr_lawyer', true, false, 'Юристова Ю. Ю.', 'dcr-l@example.invalid', null, '{}'),
    ('${U.lawyer2}', 'dcr_lawyer', true, false, 'Правова П. П.', 'dcr-l2@example.invalid', null, '{}');
  insert into public.tenders (id, object_id, work_description, public_tender_number) values ('${T.a}', '${O.a}', 'Тест: монолит', 9801);`
// До миграции: заявки «В работе» и договор, внесённый вручную по одной из них.
const BEFORE = `
  insert into public.doc_check_requests (id, object_id, counterparty_id, doc_type, status, sort_order, notes, created_at) values
    ('${OLD.bare}', '${O.b}', '${CP.b}', 'dp_conclusion', 'in_progress', 1, 'Кровля, срочно', now() - interval '3 days'),
    ('${OLD.manual}', '${O.a}', '${CP.a}', 'dp_conclusion', 'in_progress', 2, null, now() - interval '3 days'),
    ('${OLD.ds}', '${O.a}', '${CP.a}', 'ds', 'in_progress', 3, null, now() - interval '3 days'),
    ('${OLD.fresh}', '${O.a}', '${CP.b}', 'dp_conclusion', 'new', 4, null, now() - interval '3 days');
  insert into public.contracts (object_id, counterparty_id, record_type, status, contract_number)
    values ('${O.a}', '${CP.a}', 'dp', 'new_request', 'Тест-РУЧН-1');`
const createSql = (o = {}) => `insert into public.doc_check_requests (object_id, counterparty_id, doc_type, status, sort_order, notes${o.tender ? ', tender_id' : ''})
  values ('${o.object || O.a}', ${o.cp === null ? 'null' : `'${o.cp || CP.a}'`}, '${o.type || 'dp_conclusion'}', '${o.status || 'new'}', 1,
  'Новый подрядчик'${o.tender ? `, '${o.tender}'` : ''}) returning id`
const contractsOf = (id) => `select count(*) from public.contracts where doc_check_request_id = '${id}'`
const alertOf = (id, uid) => `select coalesce((select case when read_at is null then 'непрочитано' else 'прочитано' end
  from public.doc_check_assign_alerts where request_id = '${id}' and user_id = '${uid}'), 'нет')`

describe('Договор из «Заключения ДП» и окно исполнителю: файлы миграции и шлюз', () => {
  const body = (text) => text.slice(text.indexOf('\nDO $$'), text.indexOf('-- ── Права'))

  it('тело одно в обеих базах (различаются права); в базе Яндекса транзакцию задаёт migrate.sh, ролей Supabase в теле нет', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.ok(body(b).length > 5000)
    assert.equal(body(a), body(b))
    assert.doesNotMatch(b, /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(body(b), /\b(anon|authenticated|service_role)\b/, 'база Яндекса: одна учётка')
    assert.match(b, /^-- osp:allow rpc doc_check_assign_my_alerts authenticated$/m)
    assert.match(b, /^-- osp:allow rpc doc_check_assign_alerts_ack authenticated$/m)
    assert.match(b, /^-- osp:allow table doc_check_assign_alerts none$/m)
    assert.equal((b.match(/SECURITY DEFINER\n {2}SET search_path = public, pg_temp\n {2}SET application_name = 'osp:internal'/g) || []).length, 5)
  })

  it('миграция — в списке кандидатов; шлюз пускает к функциям окна любого сотрудника, к таблице уведомлений — никого', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const allow = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'allow.json')))
    assert.deepEqual(allow.rpc.doc_check_assign_my_alerts, ['authenticated'])
    assert.deepEqual(allow.rpc.doc_check_assign_alerts_ack, ['authenticated'])
    assert.equal(allow.tables.doc_check_assign_alerts, undefined)
    assert.equal(allow.rpc.dp_conclusion_contract_create, undefined, 'создание договора — только из базы')
    const sections = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'db-sections.json')))
    assert.equal(sections.rpc.doc_check_assign_my_alerts.call, 'employee')
    assert.equal(sections.rpc.doc_check_assign_alerts_ack.call, 'employee')
  })
})

describe('Договор из «Заключения ДП» и окно исполнителю: база', { skip: skipReason(), timeout: 600000 }, () => {
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

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: file('supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    sql(ROLES)
    sql(PEOPLE)
    sql(BEFORE)
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
  })

  it('заявки «В работе» до миграции: договор — если похожего нет; с договором, внесённым вручную, и ДС — нет; «Новые» — нет', () => {
    assert.equal(sql(contractsOf(OLD.bare)), '1')
    assert.equal(sql(`select status || ' ' || record_type || ' ' || object_id || ' ' || counterparty_id from public.contracts
      where doc_check_request_id = '${OLD.bare}'`), `in_work dp ${O.b} ${CP.b}`)
    assert.match(sql(`select description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${OLD.bare}' and l.event_type = 'created'`), /при выкладке: заявка «Заключение ДП» ID .* уже была в работе/)
    assert.equal(sql(contractsOf(OLD.manual)), '0', 'похожий договор (тот же объект и контрагент) уже внесён вручную')
    assert.equal(sql(contractsOf(OLD.ds)), '0')
    assert.equal(sql(contractsOf(OLD.fresh)), '0')
    // Пропущенная заявка дальше по колонкам договора не получает (иначе — дубль ручного).
    move(U.lawyer, OLD.manual, 'edo')
    assert.equal(sql(contractsOf(OLD.manual)), '0')
  })

  it('взяли в работу — договор «В работе»: объект, контрагент, тендер, «Принят в работу» — сегодня, ID заявки в примечании; обе истории', () => {
    const id = as(U.author, createSql({ tender: T.a })).split('\n')[0]
    assert.equal(sql(contractsOf(id)), '0', 'в «Новых» договора нет')
    move(U.lawyer, id, 'in_progress')
    assert.equal(sql(contractsOf(id)), '1')
    const num = sql(`select request_number from public.doc_check_requests where id = '${id}'`)
    assert.equal(sql(`select concat_ws(' ', record_type, status, object_id, counterparty_id, tender_id,
        accepted_date = (now() at time zone 'Europe/Moscow')::date, coalesce(contract_number, 'без номера'), parent_contract_id is null)
      from public.contracts where doc_check_request_id = '${id}'`), `dp in_work ${O.a} ${CP.a} ${T.a} t без номера t`)
    assert.equal(sql(`select notes from public.contracts where doc_check_request_id = '${id}'`),
      `Из заявки «Заключение ДП» ID ${num}\nНовый подрядчик`)
    assert.equal(sql(`select string_agg(cc.counterparty_id::text, ',') from public.contract_counterparties cc
      join public.contracts c on c.id = cc.contract_id where c.doc_check_request_id = '${id}'`), CP.a)
    assert.equal(sql(`select l.changed_by_name || ' | ' || l.description from public.contract_audit_log l
      join public.contracts c on c.id = l.contract_id where c.doc_check_request_id = '${id}' and l.event_type = 'created'`),
    `Юристова Ю. Ю. | Создан договор (без номера) автоматически: заявка «Заключение ДП» ID ${num} взята в работу`)
    const display = sql(`select display_id from public.contracts where doc_check_request_id = '${id}'`)
    assert.equal(sql(`select changed_by_name || ' | ' || description from public.doc_check_request_audit_log
      where request_id = '${id}' and event_type = 'contract_created'`), `Юристова Ю. Ю. | Договор создан в «Реестре по договорам»: ID ${display}`)
  })

  it('один договор на заявку: обратно в «Новые», снова в работу, дальше по колонкам, удаление заявки — договор тот же', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    move(U.lawyer, id, 'in_progress')
    move(U.lawyer, id, 'new')
    move(U.lawyer, id, 'in_progress')
    move(U.lawyer, id, 'edo')
    move(U.lawyer, id, 'done')
    assert.equal(sql(contractsOf(id)), '1')
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${id}'`)
    assert.equal(sql(`select count(*) from public.contracts where doc_check_request_id = '${id}' and deleted_at is null`), '1',
      'удаление заявки договор не трогает')
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where request_id = '${id}' and event_type = 'contract_created'`), '1')
  })

  it('из «Новых» сразу дальше — договор; создана сразу «В работе» — договор; ДП и ДС в работе — без договора; без контрагента — можно', () => {
    const skip = as(U.author, createSql({ cp: null })).split('\n')[0]
    move(U.lawyer, skip, 'signal')
    assert.equal(sql(contractsOf(skip)), '1')
    assert.equal(sql(`select coalesce(counterparty_id::text, 'нет') from public.contracts where doc_check_request_id = '${skip}'`), 'нет')
    assert.equal(sql(`select count(*) from public.contract_counterparties cc join public.contracts c on c.id = cc.contract_id
      where c.doc_check_request_id = '${skip}'`), '0')
    const direct = as(U.lawyer, createSql({ status: 'in_progress' })).split('\n')[0]
    assert.equal(sql(contractsOf(direct)), '1')
    for (const type of ['dp', 'ds']) {
      const other = as(U.lawyer, createSql({ type, status: 'in_progress' })).split('\n')[0]
      move(U.lawyer, other, 'edo')
      assert.equal(sql(contractsOf(other)), '0', type)
    }
  })

  it('подающий не переводит заявку в работу (правка — только отдела), договора нет; договор заявке вручную не привязать дважды', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    assert.throws(() => move(U.author, id, 'in_progress'), /doc_check_edit_required|может только сотрудник с правом правки|42501/)
    assert.equal(sql(contractsOf(id)), '0')
    move(U.lawyer, id, 'in_progress')
    assert.throws(() => sql(`insert into public.contracts (record_type, status, doc_check_request_id) values ('dp', 'new_request', '${id}')`),
      /contracts_doc_check_request_uniq/)
  })

  it('окно исполнителю: назначили другие — уведомление; сам себя — нет; ДП/ДС — нет; читает только своё, пока он исполнитель', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    assign(U.lawyer, id, [U.lawyer, U.lawyer2])
    assert.equal(sql(alertOf(id, U.lawyer2)), 'непрочитано')
    assert.equal(sql(alertOf(id, U.lawyer)), 'нет', 'себя назначил сам — окна нет')
    assert.equal(sql(`select assigned_by_name from public.doc_check_assign_alerts where request_id = '${id}'`), 'Юристова Ю. Ю.')
    const mine = as(U.lawyer2, `select request_id || '|' || status || '|' || coalesce(contract_display_id::text, 'нет') || '|' || object_name
      from public.doc_check_assign_my_alerts()`)
    assert.equal(mine, `${id}|new|нет|Тест: ЖК Дельта`)
    assert.equal(as(U.lawyer, `select count(*) from public.doc_check_assign_my_alerts()`), '0', 'чужое не видно')
    move(U.lawyer, id, 'in_progress')
    const display = sql(`select display_id from public.contracts where doc_check_request_id = '${id}'`)
    assert.equal(as(U.lawyer2, `select contract_display_id from public.doc_check_assign_my_alerts()`), display, 'договор — в окне')
    // Таблица уведомлений вошедшему закрыта: только функции.
    assert.throws(() => as(U.lawyer2, `select count(*) from public.doc_check_assign_alerts`), /permission denied/)
    assert.equal(as(U.lawyer2, `select public.doc_check_assign_alerts_ack(array['${id}']::uuid[])`), '1')
    assert.equal(as(U.lawyer, `select public.doc_check_assign_alerts_ack(array['${id}']::uuid[])`), '0', 'чужое не гасит')
    assert.equal(sql(alertOf(id, U.lawyer2)), 'прочитано')
    // Сняли и назначили снова — окно снова.
    assign(U.lawyer, id, [U.lawyer])
    assign(U.lawyer, id, [U.lawyer, U.lawyer2])
    assert.equal(sql(alertOf(id, U.lawyer2)), 'непрочитано')
    // Сняли до прочтения — окна нет.
    assign(U.lawyer, id, [U.lawyer])
    assert.equal(sql(alertOf(id, U.lawyer2)), 'нет')
    for (const type of ['dp', 'ds']) {
      const other = as(U.lawyer, createSql({ type })).split('\n')[0]
      assign(U.lawyer, other, [U.lawyer2])
      assert.equal(sql(alertOf(other, U.lawyer2)), 'нет', type)
    }
    // Заявку удалили — окно не показывается.
    assign(U.lawyer, id, [U.lawyer, U.lawyer2])
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${id}'`)
    assert.equal(as(U.lawyer2, `select count(*) from public.doc_check_assign_my_alerts() where request_id = '${id}'`), '0')
  })

  it('повтор миграции безопасен; откат убирает связь, триггеры и окно, договоры остаются; после отката миграция встаёт снова', () => {
    const before = sql(`select count(*) from public.contracts`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql(`select count(*) from public.contracts`), before, 'второго договора нет')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from public.contracts`), before, 'договоры остались')
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'contracts' and column_name = 'doc_check_request_id'`), '0')
    assert.equal(sql(`select to_regclass('public.doc_check_assign_alerts') is null and to_regprocedure('public.doc_check_assign_alert()') is null`), 't')
    const id = as(U.author, createSql()).split('\n')[0]
    move(U.lawyer, id, 'in_progress')
    assert.equal(sql(`select count(*) from public.contracts`), before, 'после отката договор не создаётся')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
  })
})

describe('Договор из «Заключения ДП» — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dpc-registry-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [file('migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    applied = res.stdout
    internal(ROLES)
    internal(PEOPLE)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('миграция применена с проверкой прав; её проверки на копии — все OK', () => {
    assert.match(applied, new RegExp(`OK ${NAME}: применена`))
    const backup = internal(read(CHECK))
    assert.doesNotMatch(backup, /^FAIL/m, backup)
  })

  it('под учёткой-владельцем (FORCE RLS): отдел берёт в работу — договор в реестре; назначенному — окно, читает и гасит своё', () => {
    const id = as(U.author, createSql()).split('\n')[0]
    assert.match(id, /^[0-9a-f-]{36}$/, id)
    as(U.lawyer, `update public.doc_check_requests set status = 'in_progress', assignee_ids = array['${U.lawyer2}']::uuid[] where id = '${id}'`)
    assert.equal(internal(contractsOf(id)), '1')
    assert.equal(internal(`select status from public.contracts where doc_check_request_id = '${id}'`), 'in_work')
    assert.equal(internal(`select changed_by_name from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${id}' and l.event_type = 'created'`), 'Юристова Ю. Ю.')
    const display = internal(`select display_id from public.contracts where doc_check_request_id = '${id}'`)
    assert.equal(as(U.lawyer2, `select contract_display_id from public.doc_check_assign_my_alerts()`), display)
    assert.equal(as(U.lawyer2, `select public.doc_check_assign_alerts_ack(array['${id}']::uuid[])`), '1')
    assert.equal(as(U.lawyer2, `select count(*) from public.doc_check_assign_alerts`), '0', 'таблица вошедшему не видна (только служебные операции)')
  })
})
