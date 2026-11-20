// 20270221_doc_check_tender_link: у «Заключения ДП» на доске «Заявки на проверку ДП/ДС» — необязательная привязка к тендеру
// (решение пользователя 19.11.2026). На слепке схемы прода: проверка для прода до миграции — FAIL, а не ошибка; подающий (право только
// создавать) указывает тендер при создании, менять потом не может; отдел меняет и снимает — каждая смена в истории заявки; удалили
// тендер — ссылка пустеет; повтор безопасен; откат убирает всё. Второй блок — копия прода как база Яндекса: настоящий migrate.sh
// (проверка прав под одну учётку и .check.sql) и то же под учёткой-владельцем. Нужны Docker и psql (второй блок — и проверенная копия
// прода). Шлюз (колонка в вставке подающего) — ниже, в первом блоке; страница — tests/tender/dp-requests.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270221_doc_check_tender_link'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('supabase', 'migrations', `${NAME}.sql`)
const YANDEX = file('migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270221.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

const O = { a: '00000000-0000-4000-8000-0000000dd301' }
const T = {
  a: '00000000-0000-4000-8000-0000000dd501', b: '00000000-0000-4000-8000-0000000dd502', gone: '00000000-0000-4000-8000-0000000dd503',
  byAdmin: '00000000-0000-4000-8000-0000000dd504',
}
const U = {
  author: '00000000-0000-4000-8000-0000000dd101', // руководитель строительства: только создаёт заявки доски; объект A
  lawyer: '00000000-0000-4000-8000-0000000dd102', // отдел: правка доски
  admin: '00000000-0000-4000-8000-0000000dd103', // администратор: удаляет тендер безвозвратно («Корзина»)
}
const ROLES = `
  insert into public.roles (key, label, is_system) values
    ('dct_author', 'Тест: подаёт заявки', false), ('dct_lawyer', 'Тест: отдел', false)
    on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('dct_author', 'doc_check_requests', true, false), ('dct_author', 'doc_check_requests_create', true, true),
    ('dct_lawyer', 'doc_check_requests', true, true)
    on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;`
const PEOPLE = `
  insert into public.objects (id, name, address, status) values ('${O.a}', 'Тест: ЖК Гамма', 'Москва', 'main_construction');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids) values
    ('${U.author}', 'dct_author', true, false, 'Авторов А. А.', 'dct-a@example.invalid', null, array['${O.a}']::uuid[]),
    ('${U.lawyer}', 'dct_lawyer', true, false, 'Юристова Ю. Ю.', 'dct-l@example.invalid', null, '{}'),
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'dct-adm@example.invalid', null, '{}');
  insert into public.tenders (id, object_id, work_description, public_tender_number) values
    ('${T.a}', '${O.a}', 'Тест: монолит', 9701), ('${T.b}', '${O.a}', 'Тест: кровля', 9702), ('${T.gone}', '${O.a}', 'Тест: удалим', 9703),
    ('${T.byAdmin}', '${O.a}', 'Тест: удалит администратор', 9704);`
const createSql = (tender) => `insert into public.doc_check_requests (object_id, doc_type, status, sort_order, notes, tender_id)
  values ('${O.a}', 'dp_conclusion', 'new', 1, 'Новый подрядчик', ${tender ? `'${tender}'` : 'null'}) returning id`
const HISTORY = (id) => `select coalesce(string_agg(right(coalesce(old_value #>> '{}', '-'), 4) || '>' || right(coalesce(new_value #>> '{}', '-'), 4),
  ' ' order by changed_at, id), '') from public.doc_check_request_audit_log where request_id = '${id}' and field_name = 'tender_id'`

describe('Тендер «Заключения ДП»: файлы миграции и шлюз', () => {
  const body = (text) => text.slice(text.indexOf('DO $$'), text.indexOf('FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_tender_history();'))

  it('тело одно в обеих базах (права функции — у Supabase); в базе Яндекса транзакцию задаёт migrate.sh, ролей Supabase нет', () => {
    const a = read(MIGRATION)
    const b = read(YANDEX)
    assert.ok(body(b).length > 500)
    assert.equal(body(a).replace(' FROM PUBLIC, anon, authenticated;', ' FROM PUBLIC;'), body(b))
    assert.doesNotMatch(b, /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(b, /\b(anon|authenticated|service_role)\b/, 'база Яндекса: одна учётка')
    assert.doesNotMatch(b, /osp:allow/, 'новых функций для шлюза нет')
    assert.match(b, /SECURITY DEFINER\n {2}SET search_path = public, pg_temp\n {2}SET application_name = 'osp:internal'/)
  })

  it('миграция — в списке кандидатов; подающий передаёт тендер при создании, меняет его только отдел', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
    const sections = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'db-sections.json')))
    const t = sections.tables.doc_check_requests
    const creator = t.insert.find((r) => r.any?.some(([s, a]) => s === 'doc_check_requests_create' && a === 'edit'))
    assert.ok(creator.columns.includes('tender_id'))
    assert.deepEqual(t.update, [{ any: [['doc_check_requests', 'edit']] }], 'правка — только с правом правки доски')
  })
})

describe('Тендер «Заключения ДП»: база', { skip: skipReason(), timeout: 600000 }, () => {
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
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: file('supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    sql(ROLES)
    sql(PEOPLE)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода: до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.ok(checkBefore.split('\n').every((l) => /^(OK|FAIL) /.test(l)), checkBefore)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 5, out)
  })

  it('подающий указывает тендер при создании (или нет — необязательно); сменить его потом не может', () => {
    const id = as(U.author, createSql(T.a)).split('\n')[0]
    assert.equal(sql(`select tender_id from public.doc_check_requests where id = '${id}'`), T.a)
    const bare = as(U.author, createSql(null)).split('\n')[0]
    assert.equal(sql(`select coalesce(tender_id::text, 'нет') from public.doc_check_requests where id = '${bare}'`), 'нет')
    assert.throws(() => as(U.author, `update public.doc_check_requests set tender_id = '${T.b}' where id = '${id}'`),
      /doc_check_edit_required|может только сотрудник с правом правки/)
    assert.equal(sql(HISTORY(id)), '', 'создание — без записи о тендере (есть «Заявка создана»)')
  })

  it('отдел меняет и снимает тендер — каждая смена в истории заявки; правка других полей тендер в историю не пишет', () => {
    const id = as(U.author, createSql(T.a)).split('\n')[0]
    as(U.lawyer, `update public.doc_check_requests set tender_id = '${T.b}' where id = '${id}'`)
    as(U.lawyer, `update public.doc_check_requests set notes = 'Уточнили' where id = '${id}'`)
    as(U.lawyer, `update public.doc_check_requests set tender_id = null where id = '${id}'`)
    assert.equal(sql(HISTORY(id)), `${T.a.slice(-4)}>${T.b.slice(-4)} ${T.b.slice(-4)}>-`)
    assert.equal(sql(`select string_agg(distinct changed_by_name, ',') from public.doc_check_request_audit_log
      where request_id = '${id}' and field_name = 'tender_id'`), 'Юристова Ю. Ю.')
    assert.throws(() => as(U.lawyer, `update public.doc_check_requests set tender_id = gen_random_uuid() where id = '${id}'`),
      /doc_check_requests_tender_id_fkey/)
  })

  it('тендер удалили безвозвратно — ссылка пустеет, заявка остаётся (и когда удаляет вошедший администратор)', () => {
    const id = as(U.author, createSql(T.gone)).split('\n')[0]
    sql(`delete from public.tenders where id = '${T.gone}'`)
    assert.equal(sql(`select coalesce(tender_id::text, 'нет') || ' ' || doc_type from public.doc_check_requests where id = '${id}'`), 'нет dp_conclusion')
    // Под вошедшим: обнуление ссылки проходит через запрет записи заявок и пишет историю — не должно сорвать удаление тендера.
    const byAdmin = as(U.author, createSql(T.byAdmin)).split('\n')[0]
    assert.equal(as(U.admin, `delete from public.tenders where id = '${T.byAdmin}' returning id`).split('\n')[0], T.byAdmin)
    assert.equal(sql(`select coalesce(tender_id::text, 'нет') from public.doc_check_requests where id = '${byAdmin}'`), 'нет')
    assert.equal(sql(HISTORY(byAdmin)), `${T.byAdmin.slice(-4)}>-`, 'снятие ссылки — в истории заявки')
  })

  it('повтор миграции безопасен; откат убирает колонку, триггер и функцию; после отката миграция встаёт снова', () => {
    psqlAt(db.port, null, { file: MIGRATION })
    assert.ok(Number(sql(`select count(*) from public.doc_check_requests where tender_id is not null`)) > 0, 'привязки на месте')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'doc_check_requests' and column_name = 'tender_id'`), '0')
    assert.equal(sql(`select to_regprocedure('public.doc_check_requests_tender_history()') is null`), 't')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
  })
})

describe('Тендер «Заключения ДП» — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-tender-'))
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
    const out = internal(read(YANDEX_CHECK))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 8, out)
    const backup = internal(read(CHECK))
    assert.doesNotMatch(backup, /^FAIL/m, backup)
  })

  it('под учёткой-владельцем (FORCE RLS): подающий создаёт с тендером, отдел меняет — смена в истории', () => {
    const id = as(U.author, createSql(T.a)).split('\n')[0]
    assert.match(id, /^[0-9a-f-]{36}$/, id)
    assert.equal(internal(`select tender_id from public.doc_check_requests where id = '${id}'`), T.a)
    as(U.lawyer, `update public.doc_check_requests set tender_id = '${T.b}' where id = '${id}'`)
    assert.equal(internal(HISTORY(id)), `${T.a.slice(-4)}>${T.b.slice(-4)}`)
  })
})
