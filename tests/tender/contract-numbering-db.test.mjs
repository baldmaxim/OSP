// Нумерация договоров по объектам (миграция 20270110), на слепке схемы прода: проверка до миграции — FAIL, а не ошибка;
// ключи базы совпадают с правилами страницы (src/utils/contractNumbering.js) на одном наборе строк; счётчик растёт от
// номера по схеме, в том числе введённого вручную, и не опускается при удалении и переименовании; номер по схеме не
// повторяется, прочие номера — как раньше; код объекта меняет только администратор; откат. Второй блок — то же на копии
// прода как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав). Страница — contract-numbering.test.mjs.
// Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { codeKey, numberKey } from '../../src/utils/contractNumbering.js'

const NAME = '20270110_contract_number_scheme'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270110.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  admin: '00000000-0000-4000-8000-00000c0a0a01',
  lawyer: '00000000-0000-4000-8000-00000c0a0a02',
  contractor: '00000000-0000-4000-8000-00000c0a0a03',
}
const CP = '00000000-0000-4000-8000-00000c0a0b01'
// Объект файла (ЖК Алия, код АЛИЯ ставит миграция) и объект без кода.
const ALIA = 'cb878fd0-9069-4f6b-99bf-ce5179b82656'
const OTHER = '00000000-0000-4000-8000-00000c0a0c02'

const SEED = `
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Нумерация');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid', null),
    ('${U.lawyer}', 'lawyer', true, false, 'Юристов Ю. Ю.', 'l@example.invalid', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}')
  on conflict (user_id) do nothing;
  insert into public.objects (id, name, address, status) values
    ('${ALIA}', 'ЖК Алия', 'Москва', 'main_construction'),
    ('${OTHER}', 'ЖК Без кода', 'Москва', 'warranty_service')
  on conflict (id) do nothing;`

// Строки для сверки ключей базы и страницы: схема, регистр, латиница-двойник, нули, пробелы, чужое.
const SAMPLES = [
  'АЛИЯ-ДП-26-001', 'алия-дп-26-1', ' АЛИЯ-ДП-26-0001 ', 'CБ2-ДП-26-007', 'СБ2-ДП-26-7', 'ЗИЛ18-19-27-ДП-27-012',
  'СОБ6.1-ДП-26-003', 'ДОМ56Рен-ДП-26-010', 'ДОМ56РЕН-ДП-26-10', 'А-ДП-26-001-ДП-26-002', 'АЛИЯ-ДП-26-000', 'АЛИЯ-ДП-2026-001',
  'АЛИЯ-DP-26-001', 'АЛИЯ ДП 26 001', '№ АЛИЯ-ДП-26-001', 'СУ10-ВЭЙВ-СП-Э1-25', '5', '', '-АЛИЯ-ДП-26-001',
  'АЛИЯ.-ДП-26-001', 'ОЧЕНЬДЛИННЫЙКОДОБЪЕКТА1-ДП-26-001', 'ЁЛКА-ДП-26-001', 'ёлка-дп-26-001', 'АЛИЯ-ДП-26-1234567',
  'АЛИЯ-ДП-26-001\u00a0', 'Ü-ДП-26-001',
]
const CODES = ['АЛИЯ', 'алия', 'ДОМ56Рен', 'ЗИЛ18-19-27', 'СОБ6.1', 'CБ2', ' ЗИЛ33 ', 'ЗИЛ 33', '-А', 'А.', 'А', '',
  'КОДДЛИННЕЕДВАДЦАТИЗНК', 'КОДРОВНОДВАДЦАТЬЗНАК', 'Ё1', 'ß']

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

describe('Нумерация договоров — база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const insertDoc = (number, extra = {}) => {
    const cols = { record_type: 'dp', object_id: ALIA, counterparty_id: CP, status: 'in_work', ...extra, contract_number: number }
    return sql(`insert into public.contracts (${Object.keys(cols).join(', ')})
      values (${Object.values(cols).map((v) => (v === null ? 'null' : lit(v))).join(', ')}) returning id`)
  }
  const counter = (key, year) => sql(`select coalesce((select last_number from public.contract_number_counters
    where code_key = ${lit(key)} and year = ${year}), 0)`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(SEED)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор миграции безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 8)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 8, out)
  })

  it('ключи базы = правила страницы (номер и код)', () => {
    for (const s of SAMPLES) {
      const got = sql(`select coalesce(public.contract_number_key(${lit(s)}), '<null>')`)
      assert.equal(got, numberKey(s) ?? '<null>', `номер «${s}»`)
    }
    for (const s of CODES) {
      const got = sql(`select coalesce(public.contract_code_key(${lit(s)}), '<null>')`)
      assert.equal(got, codeKey(s) ?? '<null>', `код «${s}»`)
    }
  })

  it('коды объектов файла: по id, «ЖК Алия» — АЛИЯ; объект не из файла — без кода', () => {
    assert.equal(sql(`select contract_code from public.objects where id = '${ALIA}'`), 'АЛИЯ')
    assert.equal(sql(`select coalesce(contract_code, '<null>') from public.objects where id = '${OTHER}'`), '<null>')
  })

  it('номер по схеме поднимает счётчик; ручной номер не по порядку — тоже; счётчик не опускается', () => {
    insertDoc('АЛИЯ-ДП-26-001')
    assert.equal(counter('АЛИЯ', 2026), '1')
    insertDoc('алия-дп-26-2')
    assert.equal(counter('АЛИЯ', 2026), '2')
    const far = insertDoc('АЛИЯ-ДП-26-010')
    assert.equal(counter('АЛИЯ', 2026), '10')
    // Переименовали, удалили, стёрли — номер 010 снова не выдаётся.
    sql(`update public.contracts set contract_number = 'АЛИЯ-ДП-26-003' where id = '${far}'`)
    assert.equal(counter('АЛИЯ', 2026), '10')
    sql(`delete from public.contracts where id = '${far}'`)
    assert.equal(counter('АЛИЯ', 2026), '10')
    // Другой год — свой счётчик; номер не по схеме и ДС счётчик не трогают.
    insertDoc('АЛИЯ-ДП-27-001')
    assert.equal(counter('АЛИЯ', 2027), '1')
    insertDoc('СУ10-АЛ-Э1-25')
    assert.equal(sql(`select count(*) from public.contract_number_counters`), '2')
  })

  it('номер по схеме не повторяется (в любой записи, среди удалённых тоже); прочие номера — как раньше', () => {
    assert.throws(() => insertDoc('АЛИЯ-ДП-26-1'), /contracts_scheme_number_uniq/)
    assert.throws(() => insertDoc(' алия-дп-26-0001'), /contracts_scheme_number_uniq/)
    const deleted = insertDoc('АЛИЯ-ДП-26-011', { deleted_at: '2026-11-10T10:00:00Z' })
    assert.ok(deleted)
    assert.throws(() => insertDoc('АЛИЯ-ДП-26-011'), /contracts_scheme_number_uniq/)
    // Старый вид номера — повтор разрешён, как было.
    insertDoc('5')
    insertDoc('5')
    // ДС с номером по схеме — не договор: ни уникальности, ни счётчика.
    const root = sql(`select id from public.contracts where contract_number = 'АЛИЯ-ДП-26-001'`)
    insertDoc('АЛИЯ-ДП-26-001', { record_type: 'ds_vor', parent_contract_id: root })
    assert.equal(counter('АЛИЯ', 2026), '11')
  })

  it('договор пишет сотрудник с номером по схеме — счётчик растёт, хотя сам счётчик ему только для чтения', () => {
    assert.equal(as(U.lawyer, `select count(*) from public.contract_number_counters`), '2')
    as(U.lawyer, `insert into public.contracts (record_type, object_id, counterparty_id, status, contract_number)
      values ('dp', '${ALIA}', '${CP}', 'new_request', 'АЛИЯ-ДП-26-012')`)
    assert.equal(counter('АЛИЯ', 2026), '12')
    assert.throws(() => as(U.lawyer, `insert into public.contract_number_counters (code_key, year, last_number) values ('АЛИЯ', 2030, 1)`),
      /permission denied|row-level security/)
    assert.throws(() => as(U.lawyer, `update public.contract_number_counters set last_number = 1`), /permission denied/)
    assert.equal(as(U.contractor, `select count(*) from public.contract_number_counters`), '0')
    assert.throws(() => psqlAt(db.port, `begin; set local role anon; select count(*) from public.contract_number_counters; commit;`),
      /permission denied/)
  })

  it('код объекта: меняет только администратор; недопустимый и повторный не принимаются; правка объекта без кода — как раньше', () => {
    assert.throws(() => as(U.lawyer, `update public.objects set contract_code = 'НОВЫЙ' where id = '${OTHER}'`), /задаёт администратор/)
    // Правка других полей объекта и того же кода — без отказа.
    as(U.lawyer, `update public.objects set description = 'правка' where id = '${ALIA}'`)
    as(U.lawyer, `update public.objects set contract_code = 'АЛИЯ' where id = '${ALIA}'`)
    assert.equal(as(U.admin, `update public.objects set contract_code = ' ГАР1 ' where id = '${OTHER}' returning contract_code`), 'ГАР1')
    assert.throws(() => as(U.admin, `update public.objects set contract_code = 'ГАР 1' where id = '${OTHER}'`), /objects_contract_code_check/)
    assert.throws(() => as(U.admin, `update public.objects set contract_code = 'алия' where id = '${OTHER}'`), /objects_contract_code_uniq/)
    assert.equal(as(U.admin, `update public.objects set contract_code = '' where id = '${OTHER}' returning coalesce(contract_code, '<null>')`), '<null>')
  })

  it('откат: колонки, счётчика и индексов нет, договоры и номера на месте; повтор безопасен', () => {
    const before = sql(`select count(*) from public.contracts`)
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'objects' and column_name = 'contract_code'`), '0')
    assert.equal(sql(`select coalesce(to_regclass('public.contract_number_counters')::text, '<null>')`), '<null>')
    assert.equal(sql(`select count(*) from pg_proc where proname like 'contract_%key' or proname = 'contract_code_norm'`), '0')
    assert.equal(sql(`select count(*) from public.contracts`), before)
    insertDoc('АЛИЯ-ДП-26-001')
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Нумерация договоров — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-numbering-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('тела функций и триггеров совпадают с Supabase-вариантом', () => {
    const body = (file, name) => {
      const text = fs.readFileSync(file, 'utf8')
      const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
      const end = text.indexOf('$$;', start)
      return text.slice(start, end).replace(/\n\s*SET application_name = 'osp:internal'/, '')
    }
    for (const name of ['contract_code_norm', 'contract_code_key', 'contract_number_key', 'objects_contract_code_guard', 'contracts_number_counter']) {
      assert.equal(body(YANDEX, name), body(MIGRATION, name), name)
    }
  })

  it('проверка миграции на копии: все OK; коды у 17 объектов файла', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    assert.match(out, /задано у 17 из 17/)
  })

  it('сотрудник пишет договор с номером по схеме — счётчик растёт; счётчик сотруднику только для чтения, подрядчику не виден', () => {
    as(U.admin, `insert into public.contracts (record_type, object_id, counterparty_id, status, contract_number)
      values ('dp', '${ALIA}', '${CP}', 'new_request', 'АЛИЯ-ДП-26-005')`)
    assert.equal(internal(`select last_number from public.contract_number_counters where code_key = 'АЛИЯ' and year = 2026`), '5')
    assert.equal(as(U.admin, `select last_number from public.contract_number_counters where code_key = 'АЛИЯ' and year = 2026`), '5')
    assert.equal(as(U.contractor, `select count(*) from public.contract_number_counters`), '0')
    assert.throws(() => as(U.admin, `insert into public.contracts (record_type, object_id, counterparty_id, status, contract_number)
      values ('dp', '${ALIA}', '${CP}', 'new_request', 'алия-дп-26-5')`), /contracts_scheme_number_uniq/)
    assert.equal(as(U.admin, `update public.contract_number_counters set last_number = 1 returning 1`), '', 'запись не задела строку')
    assert.equal(internal(`select last_number from public.contract_number_counters where code_key = 'АЛИЯ' and year = 2026`), '5')
  })

  it('код объекта меняет только администратор', () => {
    assert.throws(() => as(U.lawyer, `update public.objects set contract_code = 'НОВЫЙ' where id = '${OTHER}'`), /задаёт администратор/)
    assert.equal(as(U.admin, `update public.objects set contract_code = 'ГАР1' where id = '${OTHER}' returning contract_code`), 'ГАР1')
  })
})
