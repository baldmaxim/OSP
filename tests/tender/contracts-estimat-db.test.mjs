// Отметка «Загружено в Estimat» (миграция 20261211), на слепке схемы прода: проверка до миграции — FAIL, а не ошибка; у всех
// документов «не загружено»; лишнего значения база не принимает; правит сотрудник, подрядчику строка недоступна; завершённый
// документ менять отметку не мешает (это не условие договора); откат. Второй блок — то же на копии прода как база Яндекса
// (одна учётка, настоящий migrate.sh с проверкой прав). Страница — contracts-estimat.test.mjs. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20261211_contracts_estimat_status'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261211.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  admin: '00000000-0000-4000-8000-0000000e1a01',
  contractor: '00000000-0000-4000-8000-0000000e1a02',
}
const CP = '00000000-0000-4000-8000-0000000e2a01'
const OBJ = '00000000-0000-4000-8000-0000000e3a01'
const DOC = '00000000-0000-4000-8000-0000000e4a01'

const SEED = `
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Отметка');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}');
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Отметка', 'Москва', 'main_construction');
  insert into public.contracts (id, contract_number, object_id, counterparty_id, status)
    values ('${DOC}', 'EST-1', '${OBJ}', '${CP}', 'in_work');`
const MARK = (state) => `update public.contracts set estimat_status = '${state}', estimat_status_at = now(), estimat_status_by = 'Тест'
  where id = '${DOC}' returning estimat_status`
const STATE = `select estimat_status from public.contracts where id = '${DOC}'`

describe('Отметка Estimat — база', { skip: skipReason(), timeout: 600000 }, () => {
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
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(SEED)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор миграции безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('уже существующие документы — «не загружено», кто и когда — пусто', () => {
    assert.equal(sql(STATE), 'none')
    assert.equal(sql(`select count(*) from public.contracts
      where estimat_status <> 'none' or estimat_status_at is not null or estimat_status_by is not null`), '0')
  })

  it('только три значения', () => {
    assert.throws(() => sql(MARK('другое')), /contracts_estimat_status_check/)
    assert.equal(sql(STATE), 'none')
  })

  it('отмечает сотрудник; подрядчику строка недоступна', () => {
    assert.equal(as(U.contractor, MARK('uploaded')), '', 'запись не задела строку')
    assert.equal(sql(STATE), 'none')
    assert.equal(as(U.admin, MARK('uploaded')), 'uploaded')
    assert.equal(sql(STATE), 'uploaded')
  })

  it('завершённый документ: отметка меняется, условия договора по-прежнему закрыты', () => {
    sql(`update public.contracts set status = 'completed' where id = '${DOC}'`)
    assert.equal(as(U.admin, MARK('skip')), 'skip')
    assert.throws(() => as(U.admin, `update public.contracts set contract_amount = 1 where id = '${DOC}'`), /завершён/)
  })

  it('откат: колонок нет, документ на месте; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'contracts' and column_name like 'estimat%'`), '0')
    assert.equal(sql(`select count(*) from public.contracts where id = '${DOC}'`), '1')
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Отметка Estimat — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-estimat-'))
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

  it('проверка миграции на копии: все OK', () => {
    // Проверка рассчитана на момент применения: своя строка-образец ещё «не загружено».
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('отмечает сотрудник, подрядчику строка недоступна; функция кабинета отметку не отдаёт', () => {
    assert.equal(as(U.contractor, MARK('uploaded')), '', 'запись не задела строку')
    assert.equal(internal(STATE), 'none')
    assert.equal(as(U.admin, MARK('uploaded')), 'uploaded')
    assert.equal(internal(STATE), 'uploaded')
    assert.equal(internal(`select count(*) from pg_attribute a join pg_proc p on p.oid = 'public.contractor_contracts'::regproc
      where a.attrelid = p.prorettype and a.attname like 'estimat%'`), '0')
    assert.doesNotMatch(internal(`select pg_get_function_result('public.contractor_contracts'::regproc)`), /estimat/)
  })
})
