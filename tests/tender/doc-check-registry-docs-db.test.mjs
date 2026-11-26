// 20270228_doc_check_registry_docs (решение пользователя 24.11.2026): «Заявки на проверку ДП/ДС» попадают в «Реестр по договорам»
// сразу при подаче, как «Заключение ДП». «Проверка ДП» — договор с номером и датой из заявки, дубль (тот же объект, контрагент и
// номер, невидимые знаки не мешают) — не вносится; «Проверка ДС» — «ДС на доп. работы» к договору, чей номер стоит в номере ДС,
// или к единственному договору подрядчика на объекте; нет или несколько — не вносится, причина — в «Истории». Пара ДП + ДС с тем
// же номером — верна та, что с файлами, другой — пометка в примечании. Отказ реестра не роняет заявку. На слепке схемы прода;
// нужны Docker и psql. Люди, объекты и подрядчики вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270228_doc_check_registry_docs'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('supabase', 'migrations', `${NAME}.sql`)
const YANDEX = file('migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270228.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const ZW = '‌' // невидимый знак перед номером — так номер приходит из почты

const O = {
  a: '00000000-0000-4000-8000-0000000ef601', b: '00000000-0000-4000-8000-0000000ef602', c: '00000000-0000-4000-8000-0000000ef603',
  d: '00000000-0000-4000-8000-0000000ef604',
}
const CP = { a: '00000000-0000-4000-8000-0000000ef701', b: '00000000-0000-4000-8000-0000000ef702', c: '00000000-0000-4000-8000-0000000ef703' }
const U = {
  author: '00000000-0000-4000-8000-0000000ef111', // подаёт заявки доски
  lawyer: '00000000-0000-4000-8000-0000000ef112', // юрист ОСП
  lawyer2: '00000000-0000-4000-8000-0000000ef113',
}
const K = {
  main: '00000000-0000-4000-8000-0000000ef301', // О.a / П.a, номер стоит в номерах ДС
  mainDs: '00000000-0000-4000-8000-0000000ef302', // ДС №2 к нему
  other: '00000000-0000-4000-8000-0000000ef303', // О.a / П.b — дубль для «Проверки ДП»
  two1: '00000000-0000-4000-8000-0000000ef304', // О.b / П.c — два договора: ДС не к чему однозначно
  two2: '00000000-0000-4000-8000-0000000ef305',
}
// Заявки до миграции — все в «Новых», кроме оговорённых.
const R = {
  dpNew: '00000000-0000-4000-8000-0000000ef401', // ДП, договора нет — создать
  dpDup: '00000000-0000-4000-8000-0000000ef402', // ДП, номер как у K.other (с невидимым знаком и строчными) — дубль
  dsByNum: '00000000-0000-4000-8000-0000000ef403', // ДС №1 к K.main по номеру
  dsDupNum: '00000000-0000-4000-8000-0000000ef404', // ДС №2 к K.main — уже есть
  dsAmbig: '00000000-0000-4000-8000-0000000ef405', // два договора подрядчика, «Т-12» — не номер «Т-1»: не вносится
  dsBoundary: '00000000-0000-4000-8000-0000000ef411', // «ДС №6 к Т-2» — к договору «Т-2»
  movedToday: '00000000-0000-4000-8000-0000000ef412', // ушла из «Новых» после просьбы (24.11, 15:50 МСК) — дописка вносит, «В работе»
  movedOld: '00000000-0000-4000-8000-0000000ef413', // ушла из «Новых» 24.11 утром, до просьбы — не трогаем
  dsNone: '00000000-0000-4000-8000-0000000ef406', // договоров нет — не вносится
  pairDp: '00000000-0000-4000-8000-0000000ef407', // пара: ДП с файлом — верна
  pairDs: '00000000-0000-4000-8000-0000000ef408', // пара: ДС без файлов — пометка
  done: '00000000-0000-4000-8000-0000000ef409', // ДП в «Завершено» — дописка не трогает
  deleted: '00000000-0000-4000-8000-0000000ef410', // удалена — не трогаем
}
const SETUP = `
  insert into public.roles (key, label, is_system) values ('lawyer', 'Юрист', false), ('dcr_author', 'Тест: подаёт заявки', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dcr_author', 'doc_check_requests', true, false), ('dcr_author', 'doc_check_requests_create', true, true),
    ('lawyer', 'doc_check_requests', true, true), ('lawyer', 'contracts', true, true)
    on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.objects (id, name, address, status) values
    ('${O.a}', 'Тест: ЖК Альфа', 'Москва', 'main_construction'), ('${O.b}', 'Тест: ЖК Бета', 'Москва', 'main_construction'),
    ('${O.c}', 'Тест: ЖК Гамма', 'Москва', 'main_construction'), ('${O.d}', 'Тест: ЖК Дельта', 'Москва', 'main_construction');
  insert into public.counterparties (id, name) values ('${CP.a}', 'ООО Тест Альфа'), ('${CP.b}', 'ООО Тест Бета'), ('${CP.c}', 'ООО Тест Гамма');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.author}', 'dcr_author', true, false, 'Подающий Пётр Петрович', 'dcr-a@example.invalid', null, '{}'),
    ('${U.lawyer}', 'lawyer', true, false, 'Юристова Юлия Юрьевна', 'dcr-l@example.invalid', null, '{}'),
    ('${U.lawyer2}', 'lawyer', true, false, 'Правова Анна Сергеевна', 'dcr-l2@example.invalid', null, '{}');
  insert into public.contracts (id, object_id, counterparty_id, record_type, status, contract_number, created_at) values
    ('${K.main}', '${O.a}', '${CP.a}', 'dp', 'completed', 'СУ2-ТЕСТ-Э029-45', now() - interval '30 days'),
    ('${K.other}', '${O.a}', '${CP.b}', 'dp', 'completed', 'СУ2-ТЕСТ-Б-1', now() - interval '30 days'),
    ('${K.two1}', '${O.b}', '${CP.c}', 'dp', 'in_work', 'Т-1', now() - interval '30 days'),
    ('${K.two2}', '${O.b}', '${CP.c}', 'dp', 'in_work', 'Т-2', now() - interval '30 days');
  insert into public.contracts (id, object_id, counterparty_id, record_type, parent_contract_id, status, contract_number, created_at) values
    ('${K.mainDs}', '${O.a}', '${CP.a}', 'ds_extra', '${K.main}', 'completed', '2', now() - interval '20 days');
  insert into public.doc_check_requests (id, object_id, counterparty_id, doc_type, doc_number, doc_date, status, sort_order, deleted_at, created_at, notes) values
    ('${R.dpNew}', '${O.b}', '${CP.a}', 'dp', 'ТЕСТ-НОВ-7', '2026-11-20', 'new', 1, null, now() - interval '2 days', 'Тест: договор на фасад'),
    ('${R.dpDup}', '${O.a}', '${CP.b}', 'dp', '${ZW}су2-тест-б-1 ', '2026-11-20', 'new', 2, null, now() - interval '2 days', null),
    ('${R.dsByNum}', '${O.a}', '${CP.a}', 'ds', 'ДС №1 СУ2-ТЕСТ-Э029-45', '2026-11-19', 'new', 3, null, now() - interval '2 days', null),
    ('${R.dsDupNum}', '${O.a}', '${CP.a}', 'ds', 'ДС №2 к договору СУ2-ТЕСТ-Э029-45', null, 'new', 4, null, now() - interval '2 days', null),
    ('${R.dsAmbig}', '${O.b}', '${CP.c}', 'ds', 'ДС 5 к Т-12', null, 'new', 5, null, now() - interval '2 days', null),
    ('${R.dsBoundary}', '${O.b}', '${CP.c}', 'ds', 'ДС №6 к Т-2', null, 'new', 11, null, now() - interval '2 days', null),
    ('${R.movedToday}', '${O.d}', '${CP.a}', 'dp', 'ТЕСТ-ВЗЯТА-1', null, 'in_progress', 12, null, now() - interval '3 days', null),
    ('${R.movedOld}', '${O.d}', '${CP.c}', 'dp', 'ТЕСТ-ВЗЯТА-2', null, 'in_progress', 13, null, now() - interval '60 days', null),
    ('${R.dsNone}', '${O.b}', '${CP.b}', 'ds', '1', null, 'new', 6, null, now() - interval '2 days', null),
    ('${R.pairDs}', '${O.c}', '${CP.c}', 'ds', '${ZW}ГМ-ТЕСТ-31', '2026-11-23', 'new', 7, null, now() - interval '30 minutes', null),
    ('${R.pairDp}', '${O.c}', '${CP.c}', 'dp', '${ZW}ГМ-ТЕСТ-31', '2026-11-23', 'new', 8, null, now() - interval '10 minutes', null),
    ('${R.done}', '${O.b}', '${CP.a}', 'dp', 'ТЕСТ-СТАР-1', null, 'done', 9, null, now() - interval '60 days', null),
    ('${R.deleted}', '${O.b}', '${CP.a}', 'dp', 'ТЕСТ-УДАЛ-1', null, 'new', 10, now() - interval '1 day', now() - interval '2 days', null);
  insert into public.doc_check_request_audit_log (request_id, event_type, field_name, old_value, new_value, changed_at, changed_by_name) values
    ('${R.movedToday}', 'status_changed', 'status', to_jsonb('new'::text), to_jsonb('in_progress'::text), greatest(now(), timestamptz '2026-11-24 18:00+03'), 'Юристова Юлия Юрьевна'),
    ('${R.movedOld}', 'status_changed', 'status', to_jsonb('new'::text), to_jsonb('in_progress'::text), timestamptz '2026-11-24 09:00+03', 'Юристова Юлия Юрьевна');
  insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category) values
    ('doc_check_request', '${R.pairDp}', 'test/dcr/pair-dp.pdf', 'Понятийное.pdf', 'doc_check_concept_agreement');`
const docOf = (id, cols) => `select ${cols} from public.contracts where doc_check_request_id = '${id}'`
const skipped = (id) => `select coalesce(string_agg(description, ' | ' order by changed_at, id), 'нет') from public.doc_check_request_audit_log
  where request_id = '${id}' and event_type = 'registry_skipped'`
const createSql = (o) => `insert into public.doc_check_requests (object_id, counterparty_id, doc_type, doc_number, status, sort_order, notes)
  values ('${o.object}', ${o.cp ? `'${o.cp}'` : 'null'}, '${o.type}', ${o.number ? `'${o.number}'` : 'null'}, '${o.status || 'new'}', 1, 'Тест: подача')
  returning id`

describe('«Проверки ДП/ДС» в реестр: файлы миграции', () => {
  const body = (text) => text.slice(text.indexOf('\nDO $$'), text.indexOf('-- ── Права'))

  it('тело одно в обеих базах; в базе Яндекса транзакцию задаёт migrate.sh, ролей Supabase в теле нет; служебные — с отметкой', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.ok(body(b).length > 10000)
    assert.equal(body(a), body(b))
    assert.doesNotMatch(b, /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(body(b), /\b(anon|authenticated|service_role)\b/, 'база Яндекса: одна учётка')
    assert.equal((b.match(/SECURITY DEFINER\n {2}SET search_path = public, pg_temp\n {2}SET application_name = 'osp:internal'/g) || []).length, 3)
    assert.equal((b.match(/SET application_name/g) || []).length, 3, 'чистые функции — без отметки пропуска')
    assert.ok(fs.existsSync(YANDEX_CHECK))
  })

  it('миграция — в списке кандидатов; шлюз не меняется: окно читает договор правом «Договоры»', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    assert.doesNotMatch(read(YANDEX), /osp:allow/)
    const allow = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'allow.json')))
    for (const fn of ['doc_check_registry_doc_create', 'doc_check_registry_note', 'doc_check_number_key']) assert.equal(allow.rpc[fn], undefined, fn)
  })
})

describe('«Проверки ДП/ДС» в реестр: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const created = (uid, o) => as(uid, createSql(o)).split('\n')[0]

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
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    const own = sql(read(YANDEX_CHECK))
    assert.doesNotMatch(own, /^FAIL/m, own)
  })

  it('дописка «Проверки ДП»: договор с номером (без невидимого знака) и датой; дубль по номеру — не вносится; «Завершено» и удалённые не трогаются', () => {
    assert.equal(sql(docOf(R.dpNew, `concat_ws(' | ', record_type, status, contract_number, contract_date, coalesce(accepted_date::text, 'без даты'),
      object_id = '${O.b}', counterparty_id = '${CP.a}', notes)`)),
    'dp | new_request | ТЕСТ-НОВ-7 | 2026-11-20 | без даты | t | t | Из заявки «Проверка ДП» ID ' + sql(`select request_number from public.doc_check_requests where id = '${R.dpNew}'`)
      + '\nТест: договор на фасад')
    assert.equal(sql(`select count(*) from public.contract_counterparties cc join public.contracts c on c.id = cc.contract_id
      where c.doc_check_request_id = '${R.dpNew}' and cc.counterparty_id = '${CP.a}'`), '1')
    assert.equal(sql(docOf(R.dpDup, 'count(*)')), '0')
    assert.match(sql(skipped(R.dpDup)), /^В «Реестр по договорам» не внесена: там уже есть договор ID \d+ с тем же номером, объектом и контрагентом$/)
    assert.equal(sql(docOf(R.done, 'count(*)')), '0')
    // Ушла из «Новых» после просьбы (до выкладки взяли в работу) — внесена «В работе»; утром до просьбы — не трогаем.
    assert.equal(sql(docOf(R.movedToday, `concat_ws(' ', record_type, status, contract_number)`)), 'dp in_work ТЕСТ-ВЗЯТА-1')
    assert.equal(sql(docOf(R.movedOld, 'count(*)')), '0')
    assert.equal(sql(docOf(R.deleted, 'count(*)')), '0')
    assert.equal(sql(`select changed_by_name || ' | ' || description from public.doc_check_request_audit_log
      where request_id = '${R.dpNew}' and event_type = 'contract_created'`),
    `Автоматически | Договор создан в «Реестре по договорам»: ID ${sql(docOf(R.dpNew, 'display_id'))}`)
  })

  it('дописка «Проверки ДС»: ДС на доп. работы к договору по номеру, № — голое число; № уже есть, несколько договоров, ни одного — не вносится', () => {
    const mainId = sql(`select display_id from public.contracts where id = '${K.main}'`)
    assert.equal(sql(docOf(R.dsByNum, `concat_ws(' | ', record_type, parent_contract_id = '${K.main}', root_contract_id = '${K.main}', status,
      contract_number, contract_date, object_id = '${O.a}', counterparty_id = '${CP.a}')`)),
    'ds_extra | t | t | new_request | 1 | 2026-11-19 | t | t')
    assert.match(sql(docOf(R.dsByNum, 'notes')), /^Из заявки «Проверка ДС» ID \d+ \(№ в заявке: ДС №1 СУ2-ТЕСТ-Э029-45\)$/)
    assert.match(sql(`select description from public.doc_check_request_audit_log where request_id = '${R.dsByNum}' and event_type = 'contract_created'`),
      new RegExp(`^ДС создано в «Реестре по договорам»: ID \\d+ \\(к договору ID ${mainId}\\)$`))
    assert.equal(sql(docOf(R.dsDupNum, 'count(*)')), '0')
    assert.equal(sql(skipped(R.dsDupNum)), `В «Реестр по договорам» не внесена: у договора ID ${mainId} уже есть ДС ID ${sql(`select display_id from public.contracts where id = '${K.mainDs}'`)} № 2`)
    assert.equal(sql(docOf(R.dsAmbig, 'count(*)')), '0')
    assert.match(sql(skipped(R.dsAmbig)), /^В «Реестр по договорам» не внесена: у контрагента на объекте несколько договоров \(ID \d+, \d+\), номер договора в заявке не найден — ДС внесёт юрист$/,
      '«Т-12» — не номер «Т-1»: договор по части номера не выбирается')
    assert.equal(sql(docOf(R.dsBoundary, `concat_ws(' ', record_type, parent_contract_id = '${K.two2}', contract_number)`)), 'ds_extra t 6')
    assert.equal(sql(docOf(R.dsNone, 'count(*)')), '0')
    assert.equal(sql(skipped(R.dsNone)), 'В «Реестр по договорам» не внесена: договора с этим контрагентом на объекте в реестре нет — ДС внесёт юрист')
  })

  it('пара ДП + ДС с одним номером: верна заявка с файлами — договор; другой — пометка в примечании и запись в «Истории», в реестр не внесена', () => {
    assert.equal(sql(docOf(R.pairDp, `concat_ws(' | ', record_type, contract_number)`)), 'dp | ГМ-ТЕСТ-31')
    assert.equal(sql(docOf(R.pairDs, 'count(*)')), '0')
    const dpNum = sql(`select request_number from public.doc_check_requests where id = '${R.pairDp}'`)
    const note = `Вероятно, ошибочное создание: та же заявка подана как «Проверка ДП» ID ${dpNum} (с файлами). В «Реестр по договорам» эта не внесена.`
    assert.equal(sql(`select notes from public.doc_check_requests where id = '${R.pairDs}'`), note)
    assert.equal(sql(`select changed_by_name || ' | ' || (new_value #>> '{}') from public.doc_check_request_audit_log
      where request_id = '${R.pairDs}' and event_type = 'field_updated' and field_name = 'notes'`), `Автоматически | ${note}`)
  })

  it('подача «Проверки ДП» и «ДС» — документ сразу; исполнитель — юрист; в работу — «В работе»; ДС находит договор, созданный из заявки', () => {
    const dp = created(U.author, { object: O.c, cp: CP.a, type: 'dp', number: 'ТЕСТ-ПОД-1' })
    assert.match(dp, /^[0-9a-f-]{36}$/, dp)
    assert.equal(sql(docOf(dp, `concat_ws(' ', record_type, status, contract_number)`)), 'dp new_request ТЕСТ-ПОД-1')
    assert.match(sql(`select l.changed_by_name || ' | ' || l.description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${dp}' and l.event_type = 'created'`),
    /^Подающий Пётр Петрович \| Создан договор автоматически: подана заявка «Проверка ДП» ID \d+$/)

    const ds = created(U.author, { object: O.c, cp: CP.a, type: 'ds', number: 'ДС-3' })
    assert.equal(sql(`select concat_ws(' ', d.record_type, d.contract_number, d.parent_contract_id = k.id) from public.contracts d
      join public.contracts k on k.doc_check_request_id = '${dp}' where d.doc_check_request_id = '${ds}'`), 'ds_extra 3 t')

    as(U.lawyer, `update public.doc_check_requests set assignee_ids = array['${U.lawyer2}']::uuid[] where id = '${ds}'`)
    assert.equal(sql(docOf(ds, 'responsible_user_id')), U.lawyer2)
    as(U.lawyer, `update public.doc_check_requests set status = 'in_progress' where id = '${ds}'`)
    assert.equal(sql(docOf(ds, `concat_ws(' ', status, accepted_date = (now() at time zone 'Europe/Moscow')::date)`)), 'in_work t')
    assert.match(sql(`select l.description from public.contract_audit_log l join public.contracts c on c.id = l.contract_id
      where c.doc_check_request_id = '${ds}' and l.event_type = 'status_changed'`), /заявка «Проверка ДС» ID \d+ взята в работу$/)
  })

  it('«Проверка ДП» без номера: договор того же объекта и контрагента, внесённый вручную сегодня, — дубль', () => {
    sql(`insert into public.contracts (object_id, counterparty_id, record_type, status, contract_number) values ('${O.d}', '${CP.b}', 'dp', 'new_request', 'РУЧН-1')`)
    const dp = created(U.author, { object: O.d, cp: CP.b, type: 'dp' })
    assert.match(dp, /^[0-9a-f-]{36}$/, dp)
    assert.equal(sql(docOf(dp, 'count(*)')), '0')
    assert.match(sql(skipped(dp)), /там уже есть договор ID \d+ того же объекта и контрагента, внесённый после подачи заявки$/)
  })

  it('ДС без договора: заявка сохраняется, причина — в «Истории»; поправили контрагента в «Новых» — ДС появляется', () => {
    const ds = created(U.author, { object: O.c, cp: CP.b, type: 'ds', number: '1' })
    assert.match(ds, /^[0-9a-f-]{36}$/, ds)
    assert.equal(sql(docOf(ds, 'count(*)')), '0')
    assert.match(sql(skipped(ds)), /договора с этим контрагентом на объекте в реестре нет/)
    // Контрагент Гамма на объекте Гамма — договор из пары (единственный).
    as(U.lawyer, `update public.doc_check_requests set counterparty_id = '${CP.c}' where id = '${ds}'`)
    assert.equal(sql(`select concat_ws(' ', d.record_type, d.contract_number) from public.contracts d
      join public.contracts k on k.id = d.parent_contract_id and k.doc_check_request_id = '${R.pairDp}'
      where d.doc_check_request_id = '${ds}'`), 'ds_extra 1')
  })

  it('отказ реестра заявку не роняет: удалили заявку ДП, у договора которой живое ДС, — заявка удалена, договор остался, причина в «Истории»', () => {
    const dp = created(U.author, { object: O.a, cp: CP.c, type: 'dp', number: 'ТЕСТ-ОТК-1' })
    const ds = created(U.author, { object: O.a, cp: CP.c, type: 'ds', number: '1' })
    assert.equal(sql(docOf(ds, 'count(*)')), '1')
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${dp}'`)
    assert.equal(sql(`select deleted_at is not null from public.doc_check_requests where id = '${dp}'`), 't')
    assert.equal(sql(docOf(dp, 'deleted_at is null')), 't')
    assert.match(sql(skipped(dp)), /^Заявка удалена, а документ реестра ID \d+ остался: Сначала удалите зависимые документы: ID \d+$/)
    // Удалили ДС — его документ «Новая заявка» в «Удалённые»; восстановили — обратно.
    as(U.lawyer, `update public.doc_check_requests set deleted_at = now() where id = '${ds}'`)
    assert.equal(sql(docOf(ds, 'deleted_at is not null')), 't')
    as(U.lawyer, `update public.doc_check_requests set deleted_at = null where id = '${ds}'`)
    assert.equal(sql(docOf(ds, 'deleted_at is null')), 't')
  })

  it('вид заявки сменили ДС → ДП, пока документ «Новая заявка»: ДС — в «Удалённые» и отвязано, вместо него — договор', () => {
    const req = created(U.author, { object: O.a, cp: CP.a, type: 'ds', number: 'ДС №4 СУ2-ТЕСТ-Э029-45' })
    const dsId = sql(docOf(req, 'id'))
    assert.equal(sql(`select concat_ws(' ', record_type, contract_number) from public.contracts where id = '${dsId}'`), 'ds_extra 4')
    as(U.lawyer, `update public.doc_check_requests set doc_type = 'dp', doc_number = 'ТЕСТ-ВИД-1' where id = '${req}'`)
    assert.equal(sql(`select concat_ws(' ', deleted_at is not null, doc_check_request_id is null) from public.contracts where id = '${dsId}'`), 't t')
    assert.equal(sql(docOf(req, `concat_ws(' ', record_type, contract_number, deleted_at is null)`)), 'dp ТЕСТ-ВИД-1 t')
  })

  it('«Заключение ДП» — как в 20270226: договор при подаче без номера', () => {
    const req = created(U.author, { object: O.b, cp: CP.a, type: 'dp_conclusion', number: 'не переносится' })
    assert.equal(sql(docOf(req, `concat_ws(' ', record_type, status, coalesce(contract_number, 'без номера'))`)), 'dp new_request без номера')
  })

  it('повтор безопасен; откат: «Проверки» снова не попадают в реестр, документы остаются; миграция встаёт снова', () => {
    const before = sql('select count(*) from public.contracts')
    const notes = sql(`select count(*) from public.doc_check_request_audit_log where event_type = 'registry_skipped'`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql('select count(*) from public.contracts'), before, 'второго документа нет')
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where event_type = 'registry_skipped'`), notes, 'причины не дублируются')
    assert.equal(sql(`select count(*) from public.doc_check_requests where id = '${R.pairDs}' and notes like '%Вероятно%Вероятно%'`), '0')

    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.contracts'), before, 'документы остались')
    assert.equal(sql(`select to_regprocedure('public.doc_check_registry_doc_create(uuid, text)') is null`), 't')
    const dp = created(U.author, { object: O.b, cp: CP.b, type: 'dp', number: 'ТЕСТ-ОТКАТ-1' })
    assert.equal(sql(docOf(dp, 'count(*)')), '0', 'после отката «Проверка ДП» договора не создаёт')
    const dpc = created(U.author, { object: O.b, cp: CP.b, type: 'dp_conclusion' })
    assert.equal(sql(docOf(dpc, 'status')), 'new_request', '«Заключение ДП» — как в 20270226')

    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(sql(docOf(dp, 'contract_number')), 'ТЕСТ-ОТКАТ-1', 'дописка после отката внесла поданную без реестра')
  })
})

describe('«Проверки ДП/ДС» в реестр — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  // Только люди, права, объекты и подрядчики теста: прежние договоры и заявки копии не трогаем.
  const PEOPLE = SETUP.slice(0, SETUP.indexOf('  insert into public.contracts'))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-doc-check-registry-'))
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

  it('под учёткой-владельцем (FORCE RLS): подача «Проверки ДП» — договор; «Проверки ДС» к нему — ДС', () => {
    const dp = as(U.author, createSql({ object: O.a, cp: CP.a, type: 'dp', number: 'ЯН-ТЕСТ-1' })).split('\n')[0]
    assert.match(dp, /^[0-9a-f-]{36}$/, dp)
    assert.equal(internal(docOf(dp, `concat_ws(' ', record_type, status, contract_number)`)), 'dp new_request ЯН-ТЕСТ-1')
    const ds = as(U.author, createSql({ object: O.a, cp: CP.a, type: 'ds', number: 'ДС №1 ЯН-ТЕСТ-1' })).split('\n')[0]
    assert.equal(internal(docOf(ds, `concat_ws(' ', record_type, contract_number)`)), 'ds_extra 1')
  })
})
