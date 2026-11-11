// Кабинет подрядчика, просьба пользователя 11.11.2026 — копия прода под одной учёткой, настоящий migrate.sh с проверкой прав:
//   • 20270114_bid_vor_current: подрядчику — только актуальная версия ведомости (тендер № 847: «ЗИЛ лот 33 ВОР ЭН» и «… версия 2»).
//     Прежняя версия — по отметке снабжения (tender_supply_sources.prior_document_ids); новую удалили — прежняя снова видна;
//     позиции с сервера её не отдают, приложить к ней расценку нельзя;
//   • 20270115_bid_form_company: анкета и «Моя компания» — одни сведения. Поля по умолчанию получили связь с карточкой и вид «о компании»;
//     ответы о компании пишет только bid_company_save, они же — в анкеты идущих тендеров организации, закрытые не трогаются;
//     читают своя организация и администратор;
//   • откаты — функций нет, данные на месте.
// Страница — contractor-cabinet.test.mjs (стенд vorVersions=1, formLinks=1). Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const VOR = '20270114_bid_vor_current'
const FORM = '20270115_bid_form_company'
const file = (dir, name) => path.join(ROOT, 'migration', dir, name)
const id = (n) => `00000000-0000-4000-8000-0000001${String(n).padStart(5, '0')}`
const U = { admin: id(1), alpha: id(2), beta: id(3), engineer: id(4) }
const CP = { alpha: id(11), beta: id(12) }
const OBJ = id(21)
const T = { open: id(31), done: id(32), other: id(33) }
const DOC = { old: id(41), cur: id(42), k2: id(43), done: id(44) }

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.alpha}', '${U.beta}', '${U.engineer}']::uuid[]) u;
  insert into public.counterparties (id, name, inn) values ('${CP.alpha}', 'ООО Альфа Версии', '7707083893'), ('${CP.beta}', 'ООО Бета Версии', '7736050003');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов', 'admin@example.invalid', null),
    ('${U.alpha}', 'contractor', true, false, 'Альфин А. А.', 'alpha@example.invalid', '${CP.alpha}'),
    ('${U.beta}', 'contractor', true, false, 'Бетин Б. Б.', 'beta@example.invalid', '${CP.beta}'),
    ('${U.engineer}', 'lawyer', true, false, 'Юристов', 'eng@example.invalid', null);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Версии', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
    ('${T.open}', 'Наружное освещение', '${OBJ}', 'Идет тендерная процедура', 99847),
    ('${T.done}', 'Завершённый', '${OBJ}', 'Завершен', 99848),
    ('${T.other}', 'Открытый, без доступа', '${OBJ}', 'Идет тендерная процедура', 99849);
  insert into public.tender_counterparties (tender_id, counterparty_id, status) values
    ('${T.open}', '${CP.alpha}', 'request_sent'), ('${T.done}', '${CP.alpha}', 'proposal_provided');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at) values
    ('${DOC.old}', 'tender', '${T.open}', 'tenders/v/old.xlsx', 'ЗИЛ лот 33 ВОР ЭН.xlsx', 'vor_statement', now() - interval '20 days'),
    ('${DOC.cur}', 'tender', '${T.open}', 'tenders/v/v2.xlsx', 'ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2.xlsx', 'vor_statement', now() - interval '8 days'),
    ('${DOC.k2}', 'tender', '${T.open}', 'tenders/v/k2.xlsx', 'ВОР корпус 2.xlsx', 'vor', now() - interval '8 days'),
    ('${DOC.done}', 'tender', '${T.done}', 'tenders/v/done.xlsx', 'ВОР.xlsx', 'vor_statement', now() - interval '30 days');
  -- Снабжение: список ВОР был из прежнего файла, его заменили новым — прежний ушёл в prior_document_ids (триггер 20261029).
  insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, positions)
    values ('${T.open}', 'ЗИЛ лот 33 ВОР ЭН', 'vor_file', '${DOC.old}', 'ЗИЛ лот 33 ВОР ЭН.xlsx', '[{"name": "Кабель ВВГнг 3х2,5", "unit": "м"}]'::jsonb);
  update public.tender_supply_sources set s3_document_id = '${DOC.cur}', file_name = 'ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2.xlsx'
    where tender_id = '${T.open}';
  insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, positions)
    values ('${T.open}', 'ВОР корпус 2', 'vor_file', '${DOC.k2}', 'ВОР корпус 2.xlsx', '[{"name": "Светильник", "unit": "шт"}]'::jsonb);`

describe('Кабинет подрядчика: актуальная версия ведомости, анкета и «Моя компания» — база Яндекса (копия прода)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`, { appName: 'osp-test' })
  const field = (where) => internal(`select id from public.bid_form_fields where ${where} order by sort_order limit 1`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-bid-links-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 30 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, new RegExp(`OK ${VOR}: применена`))
    assert.match(res.stdout, new RegExp(`OK ${FORM}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверки миграций на копии: все OK', () => {
    for (const [name, n] of [[VOR, 4], [FORM, 6]]) {
      const out = internal(fs.readFileSync(file('yandex', `${name}.check.sql`), 'utf8'))
      assert.doesNotMatch(out, /^FAIL/m, out)
      assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, n, out)
    }
  })

  it('прежняя версия: подрядчику с доступом и сотруднику — пара «прежняя → новая»; без доступа — ничего', () => {
    assert.equal(as(U.alpha, `select file_id || '>' || current_file_id from public.bid_vor_superseded('${T.open}')`), `${DOC.old}>${DOC.cur}`)
    assert.equal(as(U.engineer, `select count(*) from public.bid_vor_superseded('${T.open}')`), '1')
    assert.equal(as(U.beta, `select count(*) from public.bid_vor_superseded('${T.open}')`), '0', 'без заявки и участия')
  })

  it('позиции с сервера — без прежней версии; приложить к ней расценку нельзя, к новой — можно', () => {
    const files = as(U.alpha, `select string_agg(file_id::text, ',' order by file_id) from public.bid_positions('${T.open}')`)
    assert.deepEqual(files.split(',').sort(), [DOC.cur, DOC.k2].sort())
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.open}', '${DOC.old}')`), /заменил эту ведомость новой версией/)
    assert.equal(as(U.alpha, `select vor_name from public.bid_file_target('${T.open}', '${DOC.cur}')`), 'ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2')
  })

  it('новую версию удалили — прежняя снова видна: без ведомости подрядчик не остаётся', () => {
    internal(`delete from public.s3_documents where id = '${DOC.cur}'`)
    assert.equal(as(U.alpha, `select count(*) from public.bid_vor_superseded('${T.open}')`), '0')
    assert.match(as(U.alpha, `select string_agg(file_id::text, ',') from public.bid_positions('${T.open}')`), new RegExp(DOC.old))
    assert.equal(as(U.alpha, `select vor_name from public.bid_file_target('${T.open}', '${DOC.old}')`), 'ЗИЛ лот 33 ВОР ЭН')
  })

  it('поля анкеты по умолчанию: связи с карточкой и вид «о компании» проставлены по подписи', () => {
    const linked = internal(`select string_agg(source, ',' order by sort_order) from public.bid_form_fields where source is not null`)
    assert.deepEqual(linked.split(','), ['name', 'inn', 'address', 'vat', 'website', 'director', 'contact'])
    const company = internal(`select string_agg(label, '|' order by sort_order) from public.bid_form_fields where scope = 'company' and source is null`)
    assert.match(company, /Наличие СРО/)
    assert.match(company, /Дата регистрации/)
    assert.match(company, /Оборот/)
    assert.equal(internal(`select count(*) from public.bid_form_fields where scope = 'tender'`), '4', 'авансирование, посещение, численность, примечание к ТКП')
    assert.throws(() => internal(`update public.bid_form_fields set source = 'inn' where source = 'name'`), /bid_form_fields_source_key|duplicate key/,
      'одно сведение — одному полю')
    assert.throws(() => internal(`update public.bid_form_fields set scope = 'tender' where source = 'name'`), /bid_form_fields_source_check/,
      'связанное поле — только «о компании»')
  })

  it('ответы о компании: только поля о компании, вариант из списка; те же ответы — в анкеты идущих тендеров, закрытый не трогается', () => {
    const sro = field(`label ilike 'Наличие СРО%'`)
    const vat = field(`code = 'vat'`)
    const visit = field(`label ilike 'Информация о посещении%'`)
    // Анкеты уже есть: идущий тендер (доступ — участник) и завершённый.
    as(U.alpha, `select public.bid_form_save('${T.open}', '{"${visit}": "были"}'::jsonb)`)
    internal(`insert into public.tender_bid_forms (tender_id, counterparty_id, answers) values ('${T.done}', '${CP.alpha}', '{"${sro}": {"label": "Наличие СРО", "value": "нет"}}'::jsonb)`)

    const saved = as(U.alpha, `select public.bid_company_save('{"${sro}": "да, 500 000 ₽", "${vat}": "22 %", "${visit}": "не о компании"}'::jsonb)::text`)
    const answers = JSON.parse(saved)
    assert.equal(answers[sro].value, 'да, 500 000 ₽')
    assert.equal(answers[vat].value, '22 %')
    assert.equal(answers[visit], undefined, 'поле по тендеру в ответы о компании не попадает')
    const open = JSON.parse(internal(`select answers::text from public.tender_bid_forms where tender_id = '${T.open}' and counterparty_id = '${CP.alpha}'`))
    assert.deepEqual([open[sro]?.value, open[vat]?.value, open[visit]?.value], ['да, 500 000 ₽', '22 %', 'были'])
    const done = JSON.parse(internal(`select answers::text from public.tender_bid_forms where tender_id = '${T.done}' and counterparty_id = '${CP.alpha}'`))
    assert.equal(done[sro].value, 'нет', 'анкета закрытого тендера — как была подана')

    // Пусто — ответ убирается и в идущих тендерах; вариант не из списка — отказ.
    as(U.alpha, `select public.bid_company_save('{"${sro}": ""}'::jsonb)`)
    assert.equal(internal(`select answers ? '${sro}' from public.tender_bid_forms where tender_id = '${T.open}' and counterparty_id = '${CP.alpha}'`), 'f')
    assert.throws(() => as(U.alpha, `select public.bid_company_save('{"${vat}": "18 %"}'::jsonb)`), /не из списка/)
    assert.throws(() => as(U.engineer, `select public.bid_company_save('{"${sro}": "да"}'::jsonb)`), /заполняет подрядчик/)
  })

  it('чтение: своя организация и администратор; чужая и сотрудник — ни строки; записи через правила нет', () => {
    assert.equal(as(U.alpha, `select count(*) from public.bid_company_answers`), '1')
    assert.equal(as(U.admin, `select count(*) from public.bid_company_answers where counterparty_id = '${CP.alpha}'`), '1')
    assert.equal(as(U.beta, `select count(*) from public.bid_company_answers`), '0')
    assert.equal(as(U.engineer, `select count(*) from public.bid_company_answers`), '0')
    assert.throws(() => as(U.beta, `insert into public.bid_company_answers (counterparty_id, answers) values ('${CP.beta}', '{}'::jsonb)`), /row-level security|permission denied/)
    assert.equal(as(U.alpha, `update public.bid_company_answers set answers = '{}'::jsonb returning 1`), '', 'правка не задела строк')
  })

  it('откаты: функций и колонок нет, анкеты и ответы на месте; повтор безопасен', () => {
    const forms = internal(`select count(*) from public.tender_bid_forms`)
    for (let i = 0; i < 2; i++) db.sql(null, { file: file('rollback', `${FORM}_rollback.sql`) })
    for (let i = 0; i < 2; i++) db.sql(null, { file: file('rollback', `${VOR}_rollback.sql`) })
    assert.equal(internal(`select count(*) from pg_proc where proname in ('bid_company_save', 'bid_vor_superseded')`), '0')
    assert.equal(internal(`select count(*) from information_schema.columns where table_name = 'bid_form_fields' and column_name in ('scope', 'source')`), '0')
    assert.equal(internal(`select count(*) from public.tender_bid_forms`), forms)
    assert.equal(internal(`select count(*) from public.bid_company_answers`), '1')
    assert.match(as(U.alpha, `select count(*) from public.bid_positions('${T.open}')`), /^\d+$/)
  })
})
