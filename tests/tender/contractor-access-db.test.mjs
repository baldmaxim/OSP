// Кабинет подрядчика: сведения — функциями с перечнем полей (миграция 20261201_contractor_access).
//   • слепок схемы прода (вариант Supabase): чтение и запись подрядчика, функции кабинета, КП только пока идёт приём,
//     сотрудник работает как раньше, проверка для прода (до миграции — FAIL, а не ошибка), откат;
//   • копия прода под одной учёткой (вариант Яндекса, migrate.sh): то же главное.
// Нужны Docker, psql; для второй части — проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, startSingleOwner, latestVerifiedCopy, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20261201_contractor_access'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261201.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const id = (n) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`
const U = { admin: id(1), a: id(3), b: id(4), noorg: id(5) }
const CP = { a: id(11), b: id(12) }
const OBJ = id(21)
const T = { open: id(31), done: id(32), foreign: id(33), accepted: id(34) }
const C = { mine: id(41), party: id(42), foreign: id(43), deleted: id(44) }
const ITEM = { open: id(51), done: id(52), foreign: id(53) }
const CLOSED_TABLES = ['tenders', 'objects', 'contracts', 'contract_counterparties', 'counterparties', 'tender_counterparties']

const SEED = `
  insert into public.counterparties (id, name, inn, notes) values
    ('${CP.a}', 'ООО Альфа', '7700000011', 'служебное примечание'), ('${CP.b}', 'ООО Бета', '7700000012', null);
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
    ('${U.a}', 'contractor', true, false, 'Альфин А. А.', '${CP.a}'),
    ('${U.b}', 'contractor', true, false, 'Бетин Б. Б.', '${CP.b}'),
    ('${U.noorg}', 'contractor', true, false, 'Безорг Б. Б.', null);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Доступ', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number, cost_plan_link, notes) values
    ('${T.open}', 'Открытый', '${OBJ}', 'Идет тендерная процедура', 9911, 'https://example.invalid/plan', 'служебное'),
    ('${T.done}', 'Завершённый', '${OBJ}', 'Завершен', 9912, null, null),
    ('${T.foreign}', 'Чужой', '${OBJ}', 'Идет тендерная процедура', 9913, 'https://example.invalid/plan2', 'служебное'),
    ('${T.accepted}', 'Подтверждённый', '${OBJ}', 'Идет тендерная процедура', 9914, null, null);
  insert into public.tender_counterparties (tender_id, counterparty_id, status, notes) values
    ('${T.open}', '${CP.a}', 'request_sent', 'служебное примечание'),
    ('${T.done}', '${CP.a}', 'proposal_provided', null),
    ('${T.accepted}', '${CP.a}', 'accepted_for_work', null),
    ('${T.foreign}', '${CP.b}', 'request_sent', null);
  insert into public.tender_estimate_items (id, tender_id, row_number, cost_name, unit) values
    ('${ITEM.open}', '${T.open}', 1, 'Бетон', 'м3'), ('${ITEM.done}', '${T.done}', 1, 'Кровля', 'м2'),
    ('${ITEM.foreign}', '${T.foreign}', 1, 'Фасад', 'м2');
  insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials) values
    ('${T.done}', '${CP.a}', '${ITEM.done}', 100);
  insert into public.contracts (id, contract_number, contract_date, object_id, counterparty_id, contract_amount, notes, deleted_at) values
    ('${C.mine}', 'ДП-1', '2026-09-01', '${OBJ}', '${CP.a}', 1000, 'служебное', null),
    ('${C.party}', 'ДП-2', '2026-09-02', '${OBJ}', '${CP.b}', 2000, null, null),
    ('${C.foreign}', 'ДП-3', '2026-09-03', '${OBJ}', '${CP.b}', 3000, null, null),
    ('${C.deleted}', 'ДП-4', '2026-09-04', '${OBJ}', '${CP.a}', 4000, null, now());
  insert into public.contract_counterparties (contract_id, counterparty_id) values ('${C.party}', '${CP.a}');`

// Проверки одни на оба варианта базы: as(пользователь, запрос) — под ним, sql(запрос) — служебно.
function sharedChecks(ctx) {
  const count = (uid, table) => ctx.as(uid, `select count(*) from public.${table}`)

  it('подрядчик не читает таблицы напрямую; смета и свои КП — как раньше', () => {
    for (const table of CLOSED_TABLES) assert.equal(count(U.a, table), '0', table)
    assert.equal(ctx.as(U.a, `select count(*) from public.tender_estimate_items where tender_id = '${T.open}'`), '1', 'смета своего тендера')
    assert.equal(ctx.as(U.a, `select count(*) from public.tender_estimate_items where tender_id = '${T.foreign}'`), '0', 'смета чужого')
    assert.equal(ctx.as(U.a, `select count(*) from public.tender_counterparty_proposals where tender_id = '${T.done}'`), '1', 'свои КП')
  })

  it('строка участия: прямой записи нет, данные на месте', () => {
    const before = ctx.sql(`select tender_id || ' ' || status || ' ' || coalesce(notes, '') from public.tender_counterparties where tender_id = '${T.open}' and counterparty_id = '${CP.a}'`)
    for (const patch of [`tender_id = '${T.foreign}'`, `status = 'declined'`, `notes = 'моё'`, 'sort_order = 0']) {
      const out = ctx.as(U.a, `update public.tender_counterparties set ${patch} where counterparty_id = '${CP.a}' returning id`)
      assert.equal(out, '', patch)
    }
    assert.throws(() => ctx.as(U.a, `insert into public.tender_counterparties (tender_id, counterparty_id) values ('${T.foreign}', '${CP.a}')`), /row-level security/)
    assert.equal(ctx.sql(`select tender_id || ' ' || status || ' ' || coalesce(notes, '') from public.tender_counterparties where tender_id = '${T.open}' and counterparty_id = '${CP.a}'`), before)
    assert.equal(ctx.as(U.a, `select public.is_my_tender('${T.foreign}')`), 'f', 'чужой тендер своим не стал')
  })

  it('договоры и организация — функциями: только своё и только перечисленные поля', () => {
    assert.equal(ctx.as(U.a, 'select public.contractor_org_name()'), 'ООО Альфа')
    assert.equal(ctx.as(U.noorg, 'select public.contractor_org_name()'), '')
    const rows = JSON.parse(ctx.as(U.a, 'select json_agg(c) from public.contractor_contracts() c'))
    assert.deepEqual(rows.map((r) => r.contract_number).filter((n) => /^ДП-[1-4]$/.test(n)).sort(), ['ДП-1', 'ДП-2'], 'сторона и многосторонний; без чужого и удалённого')
    assert.deepEqual(Object.keys(rows[0]).sort(), ['contract_amount', 'contract_date', 'contract_number', 'currency', 'display_id', 'id', 'object_name', 'status', 'work_name'])
    assert.equal(rows.find((r) => r.contract_number === 'ДП-1').object_name, 'ЖК Доступ')
    assert.throws(() => ctx.as(U.noorg, 'select * from public.contractor_contracts()'), /только для подрядчика/)
    // Кабинет: тендеры — по-прежнему функцией, чужой открытый — без доступа.
    const list = JSON.parse(ctx.as(U.a, 'select json_agg(t) from public.bid_contractor_tenders() t'))
    assert.equal(list.find((t) => t.id === T.open).access, 'invited')
    assert.equal(list.find((t) => t.id === T.foreign).access, null)
    assert.ok(!('cost_plan_link' in list[0]) && !('notes' in list[0]), 'внутренних полей в кабинете нет')
  })

  it('отметка участия: свой тендер, пока идёт приём; подтверждённое участие подрядчик не меняет', () => {
    const set = (uid, tender, status) => ctx.as(uid, `select public.contractor_set_participation('${tender}', '${status}')`)
    assert.throws(() => set(U.a, T.open, 'accepted_for_work'), /Недопустимая отметка/)
    assert.throws(() => set(U.a, T.foreign, 'declined'), /не участвует/)
    assert.throws(() => set(U.a, T.done, 'declined'), /закрыт/)
    assert.throws(() => set(U.a, T.accepted, 'declined'), /подтверждено/)
    assert.throws(() => set(U.noorg, T.open, 'declined'), /ставит подрядчик/)
    set(U.a, T.open, 'declined')
    assert.equal(ctx.sql(`select status from public.tender_counterparties where tender_id = '${T.open}' and counterparty_id = '${CP.a}'`), 'declined')
    set(U.a, T.open, 'proposal_provided')
    assert.equal(ctx.sql(`select status from public.tender_counterparties where tender_id = '${T.open}' and counterparty_id = '${CP.a}'`), 'proposal_provided')
    assert.equal(ctx.sql(`select coalesce(notes, '') from public.tender_counterparties where tender_id = '${T.open}' and counterparty_id = '${CP.a}'`), 'служебное примечание', 'примечание сотрудника цело')
  })

  it('свои КП: пока идёт приём и только на позиции этого тендера; после приёма — нельзя', () => {
    const insert = (tender, item) => `insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials)
      values ('${tender}', '${CP.a}', '${item}', 50) returning id`
    assert.ok(ctx.as(U.a, insert(T.open, ITEM.open)), 'приём идёт')
    assert.throws(() => ctx.as(U.a, insert(T.done, ITEM.done)), /row-level security/, 'приём закрыт')
    assert.throws(() => ctx.as(U.a, insert(T.open, ITEM.foreign)), /row-level security/, 'чужая позиция')
    assert.throws(() => ctx.as(U.a, insert(T.foreign, ITEM.foreign)), /row-level security/, 'чужой тендер')
    assert.equal(ctx.as(U.a, `delete from public.tender_counterparty_proposals where tender_id = '${T.done}' returning id`), '', 'из завершённого не удалить')
    assert.equal(ctx.sql(`select count(*) from public.tender_counterparty_proposals where tender_id = '${T.done}' and counterparty_id = '${CP.a}'`), '1')
    assert.ok(ctx.as(U.a, `delete from public.tender_counterparty_proposals where tender_id = '${T.open}' returning id`), 'пока приём идёт — заменить можно')
  })

  it('гость: функции кабинета закрыты, таблицы пусты; сотрудник работает как раньше', () => {
    for (const table of CLOSED_TABLES) assert.notEqual(count(U.admin, table), '0', `администратор: ${table}`)
    assert.ok(ctx.as(U.admin, `update public.tender_counterparties set notes = 'правка' where tender_id = '${T.foreign}' returning id`), 'сотрудник правит строку участия')
    assert.ok(ctx.as(U.admin, `delete from public.tender_counterparty_proposals where tender_id = '${T.done}' returning id`), 'сотрудник правит КП после приёма')
    // Supabase отказывает по выдаче прав, под одной учёткой — сама функция (до неё гостя не пускает и список шлюза).
    assert.throws(() => ctx.anon('select * from public.contractor_contracts()'), /permission denied|только для подрядчика/, 'гость: договоры')
    assert.throws(() => ctx.anon(`select public.contractor_set_participation('${T.open}', 'declined')`), /permission denied|ставит подрядчик/, 'гость: отметка')
  })
}

describe('Кабинет подрядчика: доступ — слепок схемы (Supabase)', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const ctx = {
    sql: (text) => psqlAt(db.port, text),
    as: (uid, text) => psqlAt(db.port, `begin;
      set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
      set local role authenticated;
      ${text};
      commit;`),
    anon: (text) => psqlAt(db.port, `begin;
      set local "request.jwt.claims" = '${JSON.stringify({ role: 'anon' })}';
      set local role anon;
      ${text};
      commit;`),
  }
  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    ctx.sql(SEED)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 6)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
  })

  sharedChecks(ctx)

  it('откат возвращает прежние правила; данные не меняются', () => {
    const before = ctx.sql('select count(*) from public.tender_counterparty_proposals')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(ctx.as(U.a, `select count(*) from public.tenders where id = '${T.done}'`), '1')
    assert.equal(ctx.sql('select count(*) from public.tender_counterparty_proposals'), before)
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

const singleSkip = skipReason({ needCopy: true })
describe('Кабинет подрядчика: доступ — копия прода под одной учёткой (Яндекс)', { skip: singleSkip, timeout: 1500000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const ctx = {
    sql: (text) => db.sql(text, { appName: 'osp:internal' }),
    as: (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`),
    anon: (text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ role: db.owner, osp_role: 'anon' })}';
      ${text};
      commit;`),
  }
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-contractor-access-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    ctx.sql(`insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
      from unnest(array['${U.admin}', '${U.a}', '${U.b}', '${U.noorg}']::uuid[]) u;`)
    ctx.sql(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  sharedChecks(ctx)
})
