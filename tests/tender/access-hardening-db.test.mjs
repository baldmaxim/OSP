// Миграции 20270120_object_scope_files и 20270121_audit_trail на копии прода под одной учёткой (настоящий migrate.sh
// с проверкой прав, все миграции Яндекса по порядку). Пользователи — через request.jwt.claims, как от PostgREST.
//   • договоры и всё, что к ним привязано, — только своих объектов; роль «по объектам» без объектов — ни одного;
//     офисная роль без привязки — все; ДС к договору чужого объекта и перенос строки в чужой объект — отказ;
//   • строки файлов: видны тому, кто видит владельца (раздел, охват, задача); менять — только имя и описание;
//     автора загрузки ставит сервер;
//   • журналы для экрана: автор, роль и время — от сервера, исправить и удалить нельзя, каскад с родителем — проходит;
//     журнал базы пишет правку сам, с автором из токена, и хранит удаление строки;
//   • свой профиль — функцией: три поля своей строки, роль не трогается; настройки разделов — по праву раздела.
// Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const SCOPE = '20270120_object_scope_files'
const AUDIT = '20270121_audit_trail'
const check = (name) => fs.readFileSync(path.join(ROOT, 'migration', 'yandex', `${name}.check.sql`), 'utf8')

const O = { a: '00000000-0000-4000-8000-0000000ee101', b: '00000000-0000-4000-8000-0000000ee102' }
const U = {
  admin: '00000000-0000-4000-8000-0000000ee201',
  site: '00000000-0000-4000-8000-0000000ee202',      // руководитель строительства, объект A
  siteNone: '00000000-0000-4000-8000-0000000ee203',  // руководитель строительства без объектов — ни одного
  office: '00000000-0000-4000-8000-0000000ee204',    // офис: договоры просмотр и правка, тендеры просмотр
  none: '00000000-0000-4000-8000-0000000ee205',      // одобрен, прав нет
}
const C = { a: '00000000-0000-4000-8000-0000000ee301', b: '00000000-0000-4000-8000-0000000ee302' }
const TASK = '00000000-0000-4000-8000-0000000ee401'
const KEY = { a: `contracts/${C.a}/a.pdf`, b: `contracts/${C.b}/b.pdf`, task: `tasks/${TASK}/t.pdf` }

// Имена вымышленные.
const SEED = `
  insert into public.roles (key, label, is_system) values ('osp_t_office', 'Тест: офис', false), ('osp_t_none', 'Тест: без прав', false)
  on conflict (key) do nothing;
  insert into public.role_permissions (role, section, can_view, can_edit) values
    ('osp_t_office', 'contracts', true, true), ('osp_t_office', 'tenders', true, false),
    ('construction_manager', 'contracts', true, false)
  on conflict (role, section) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.objects (id, name, address) values ('${O.a}', 'Тест: объект А', 'А'), ('${O.b}', 'Тест: объект Б', 'Б');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, object_ids) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'ee-a@example.invalid', '{}'),
    ('${U.site}', 'construction_manager', true, false, 'Стройкин С. С.', 'ee-s@example.invalid', array['${O.a}']::uuid[]),
    ('${U.siteNone}', 'construction_manager', true, false, 'Безобъектов Б. Б.', 'ee-n@example.invalid', '{}'),
    ('${U.office}', 'osp_t_office', true, false, 'Офисов О. О.', 'ee-o@example.invalid', '{}'),
    ('${U.none}', 'osp_t_none', true, false, 'Гостев Г. Г.', 'ee-g@example.invalid', '{}');
  insert into public.contracts (id, object_id, record_type, contract_number) values
    ('${C.a}', '${O.a}', 'dp', 'ТЕСТ-ДП-А'), ('${C.b}', '${O.b}', 'dp', 'ТЕСТ-ДП-Б');
  insert into public.contract_appendices (contract_id) values ('${C.a}'), ('${C.b}');
  insert into public.contract_audit_log (contract_id, event_type, description) values ('${C.a}', 'created', 'А'), ('${C.b}', 'created', 'Б');
  insert into public.tasks (id, title, created_by_user_id) values ('${TASK}', 'Тест: задача', '${U.admin}');
  insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, uploaded_by) values
    ('contract', '${C.a}', '${KEY.a}', 'a.pdf', '${U.admin}'), ('contract', '${C.b}', '${KEY.b}', 'b.pdf', '${U.admin}'),
    ('task', '${TASK}', '${KEY.task}', 't.pdf', '${U.admin}');`

const IDS = (rows) => rows.split('\n').filter(Boolean).sort().join(',')

describe('Охват договоров, файлы, журналы — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub, email: `${sub.slice(-4)}@example.invalid` })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')
  const seen = (sub, table, col = 'id', where = '') => IDS(as(sub, `select ${col} from public.${table} where ${col} in ('${C.a}', '${C.b}') ${where}`))

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-access-hardening-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 30 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${SCOPE}: применена`))
    assert.match(res.stdout, new RegExp(`OK ${AUDIT}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверки обеих миграций на копии: все OK', () => {
    for (const name of [SCOPE, AUDIT]) {
      const out = internal(check(name))
      assert.doesNotMatch(out, /^FAIL/m, out)
      assert.ok(out.split('\n').filter((l) => l.startsWith('OK ')).length >= 6, out)
    }
  })

  it('договоры: свои объекты; роль «по объектам» без объектов — ни одного; офис и администратор — все', () => {
    assert.equal(seen(U.site, 'contracts'), C.a)
    assert.equal(seen(U.siteNone, 'contracts'), '')
    assert.equal(seen(U.office, 'contracts'), [C.a, C.b].sort().join(','))
    assert.equal(seen(U.admin, 'contracts'), [C.a, C.b].sort().join(','))
    // Привязанное к договору — так же, и прямым запросом, мимо реестра.
    assert.equal(seen(U.site, 'contract_appendices', 'contract_id'), C.a)
    assert.equal(seen(U.site, 'contract_audit_log', 'contract_id'), C.a)
    assert.equal(seen(U.office, 'contract_appendices', 'contract_id'), [C.a, C.b].sort().join(','))
  })

  it('чужой объект не тронуть: приложение, правка, перенос, ДС к чужому договору', () => {
    assert.throws(() => as(U.site, `insert into public.contract_appendices (contract_id) values ('${C.b}')`), /row-level security/)
    assert.equal(as(U.site, `update public.contract_appendices set updated_at = now() where contract_id = '${C.b}' returning id`), '')
    assert.equal(as(U.site, `delete from public.contract_audit_log where contract_id = '${C.b}' returning id`), '')
    assert.throws(() => as(U.site, `update public.contracts set object_id = '${O.b}' where id = '${C.a}'`), /row-level security/)
    assert.throws(() => as(U.site, `insert into public.contracts (object_id, record_type, parent_contract_id, contract_number)
      values ('${O.a}', 'ds_extra', '${C.b}', 'ДС-1')`), /row-level security|не найден/)
  })

  it('строки файлов: договор — правом раздела и охватом; задача — её видимостью', () => {
    const keys = (sub) => IDS(as(sub, `select s3_key from public.s3_documents where s3_key in ('${KEY.a}', '${KEY.b}', '${KEY.task}')`))
    assert.equal(keys(U.office), [KEY.a, KEY.b].sort().join(','), 'офис: договоры да, чужая задача — нет')
    assert.equal(keys(U.site), KEY.a, 'рукстрой: только свой объект')
    assert.equal(keys(U.none), '', 'без прав — ни одного')
    assert.equal(keys(U.admin), [KEY.a, KEY.b, KEY.task].sort().join(','))
  })

  it('строки файлов: менять можно только имя и описание; автора загрузки ставит сервер', () => {
    assert.throws(() => as(U.office, `update public.s3_documents set s3_key = 'contracts/x/y.pdf' where s3_key = '${KEY.a}'`), /только имя и описание/)
    assert.throws(() => as(U.office, `update public.s3_documents set owner_id = '${C.b}' where s3_key = '${KEY.a}'`), /только имя и описание/)
    assert.throws(() => as(U.office, `update public.s3_documents set uploaded_by = '${U.office}' where s3_key = '${KEY.a}'`), /только имя и описание/)
    assert.equal(as(U.office, `update public.s3_documents set notes = 'описание', file_name = 'А.pdf' where s3_key = '${KEY.a}' returning file_name`), 'А.pdf')
    const key = `contracts/${C.a}/new.pdf`
    assert.equal(as(U.office, `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, uploaded_by, uploaded_by_name)
      values ('contract', '${C.a}', '${key}', 'n.pdf', '${U.admin}', 'Подделка') returning uploaded_by || '|' || uploaded_by_name`), `${U.office}|Офисов О. О.`)
  })

  it('журнал для экрана: автор, роль и время — от сервера; исправить и удалить нельзя', () => {
    const row = as(U.office, `insert into public.contract_audit_log (contract_id, event_type, description, changed_by_name, changed_by_role, changed_at)
      values ('${C.a}', 'note', 'проверка', 'Подделка', 'admin', '2000-01-01') returning changed_by || '|' || changed_by_name || '|' || changed_by_role || '|' || (changed_at > now() - interval '1 hour')`)
    assert.equal(row, `${U.office}|Офисов О. О.|osp_t_office|true`)
    assert.throws(() => as(U.office, `update public.contract_audit_log set description = 'правка' where contract_id = '${C.a}'`), /изменить нельзя/)
    assert.throws(() => as(U.office, `delete from public.contract_audit_log where contract_id = '${C.a}'`), /удалить нельзя/)
  })

  it('журнал базы: правка пишется сама, с автором из токена; удаление строки — тоже, и журнал экрана уходит каскадом', () => {
    as(U.office, `update public.contracts set notes = 'проверка журнала' where id = '${C.a}'`)
    const upd = internal(`select actor || '|' || actor_name || '|' || (changes ? 'notes') from osp_private.data_audit_log
      where table_name = 'contracts' and row_id = '${C.a}' and op = 'UPDATE' order by id desc limit 1`)
    assert.equal(upd, `${U.office}|Офисов О. О.|true`)
    // Окончательное удаление договора администратором: журнал экрана уходит вместе с ним (родителя уже нет), журнал базы хранит строку.
    as(U.admin, `delete from public.contracts where id = '${C.b}'`)
    assert.equal(internal(`select count(*) from public.contract_audit_log where contract_id = '${C.b}'`), '0')
    assert.equal(internal(`select count(*) from osp_private.data_audit_log where table_name = 'contracts' and row_id = '${C.b}' and op = 'DELETE'`), '1')
    // Через «вошедшего» журнал базы не читается.
    assert.equal(db.sql(`select count(*) from osp_private.data_audit_log`, { appName: 'osp-test' }), '0')
  })

  it('настройки разделов: ключ пишет правка его раздела; незнакомый — администратор', () => {
    const put = (sub, key) => as(sub, `insert into public.app_settings (key, value) values ('${key}', 'x')
      on conflict (key) do update set value = excluded.value returning key`)
    assert.equal(put(U.office, 'contracts_root_folder_path'), 'contracts_root_folder_path', 'правка договоров')
    assert.throws(() => put(U.none, 'contracts_root_folder_path'), /правом правки её раздела/)
    assert.throws(() => put(U.office, 'concept_agreement_template_link'), /правом правки её раздела/, 'шаблон — администратору')
    assert.throws(() => put(U.office, 'osp_t_unknown_key'), /правом правки её раздела/)
    assert.equal(put(U.admin, 'osp_t_unknown_key'), 'osp_t_unknown_key')
    assert.throws(() => as(U.office, `delete from public.app_settings where key = 'osp_t_unknown_key'`), /правом правки её раздела/)
  })

  it('свой профиль: три поля своей строки, роль не меняется', () => {
    as(U.none, `select public.profile_update_own('Гостев Г. Г. (новое)', '+79160000000', null)`)
    assert.equal(internal(`select full_name || '|' || work_phone || '|' || role from public.user_roles where user_id = '${U.none}'`),
      'Гостев Г. Г. (новое)|+79160000000|osp_t_none')
  })

  it('откат обеих миграций: прежние правила и поведение, данные на месте; повтор безопасен', () => {
    for (const name of [AUDIT, SCOPE, AUDIT, SCOPE]) {
      db.sql(null, { file: path.join(ROOT, 'migration', 'rollback', `${name}_rollback.sql`) })
    }
    // Охват — прежнее правило: без объектов у роли — все договоры; правка журнала снова возможна.
    assert.equal(seen(U.siteNone, 'contracts'), C.a)
    assert.match(as(U.office, `update public.contract_audit_log set description = 'правка' where contract_id = '${C.a}' returning 1`), /1/)
    assert.equal(internal(`select count(*) > 0 from osp_private.data_audit_log`), 't', 'журнал базы не стёрт')
    assert.equal(internal(`select count(*) from osp_private.policy_backup_20270120`), '0')
    assert.equal(internal(`select count(*) from pg_proc where proname in ('osp_object_scope', 'osp_contract_in_scope', 'profile_update_own', 'audit_log_guard')`), '0')
  })
})
