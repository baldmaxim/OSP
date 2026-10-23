// Реестр расценок → «Расценки от подрядчиков (КП)»: цены подрядчиков из кабинета (tender_bid_rates, 20261102) —
// только после завершения тендера (миграция 20261103_kp_registry_site_bids), на слепке схемы прода: пока тендер
// идёт — в реестре КП их нет; «Завершен» и пересчёт — есть (вид, цена, подрядчик, день правки по Москве); у той же
// позиции КП из файла и цена с сайта — одна строка, более свежая; подрядчику реестр закрыт; пересчёт на месте
// работает; проверка до миграции — FAIL, а не ошибка; откат убирает цены с сайта. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const BIDS = path.join(ROOT, 'supabase', 'migrations', '20261102_contractor_bids.sql')
const NAME = '20261103_kp_registry_site_bids'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261103.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  employee: '00000000-0000-4000-8000-0000000c1a01',
  contractor: '00000000-0000-4000-8000-0000000c1a02',
}
const CP = '00000000-0000-4000-8000-0000000c2a01'
const OBJ = '00000000-0000-4000-8000-0000000c3a01'
const T = '00000000-0000-4000-8000-0000000c4a01'
const ITEM = '00000000-0000-4000-8000-0000000c5a01'
const ITEM2 = '00000000-0000-4000-8000-0000000c5a02'

const rows = (list) => `'${JSON.stringify(list).replace(/'/g, "''")}'::jsonb`

describe('Реестр КП: цены с сайта после завершения тендера — база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const refresh = () => sql('refresh materialized view public.kp_rates_registry_mv')
  const registry = (where = 'true') => JSON.parse(as(U.employee,
    `select coalesce(json_agg(r order by r.item_type, r.item_name), '[]') from public.kp_rates_registry r where tender_id = '${T}' and ${where}`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      if (m.startsWith('20261102_') || m.startsWith(NAME)) continue
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    psqlAt(db.port, null, { file: BIDS })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values ('kr_employee', 'Тест: реестр', false) on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values ('kr_employee', 'rates_registry', true, false);
      insert into public.counterparties (id, name) values ('${CP}', 'ООО Реестр');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.employee}', 'kr_employee', true, false, 'Реестров Р. Р.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Реестр', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
        ('${T}', 'Полы паркинга', '${OBJ}', 'Идет тендерная процедура', 9950);
      -- КП из файла (прежний путь): бетон — старше, песок — только в файле.
      insert into public.tender_estimate_items (id, tender_id, row_number, code, cost_name, unit, work_volume, material_consumption) values
        ('${ITEM}', '${T}', 1, 'мат.', 'Бетон В25', 'м3', 0, 100),
        ('${ITEM2}', '${T}', 2, 'мат.', 'Песок', 'м3', 0, 50);
      insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials, proposal_date) values
        ('${T}', '${CP}', '${ITEM}', 7000, '2026-10-01'),
        ('${T}', '${CP}', '${ITEM2}', 900, '2026-10-01');`)
    as(U.contractor, `select public.bid_request('${T}')`)
    as(U.contractor, `select public.bid_rates_save('${T}', ${rows([
      { kind: 'material', key: 'бетонb25', unit_key: 'м3', name: 'Бетон В25', unit: 'м3', volume: 100, price: 7800 },
      { kind: 'work', key: 'устройствопола', unit_key: 'м2', name: 'Устройство пола', unit: 'м2', volume: 1000, price: 950 },
    ])})`)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('тендер идёт — цен с сайта в реестре КП нет, КП из файла — как раньше', () => {
    refresh()
    assert.deepEqual(registry().map((r) => [r.item_type, r.item_name, Number(r.price)]), [
      ['material', 'Бетон В25', 7000], ['material', 'Песок', 900],
    ])
  })

  it('тендер завершён — цены с сайта в реестре: более свежая цена позиции, работа, подрядчик, день правки', () => {
    sql(`update public.tenders set status = 'Завершен' where id = '${T}'`)
    sql('refresh materialized view concurrently public.kp_rates_registry_mv')
    const list = registry()
    assert.deepEqual(list.map((r) => [r.item_type, r.item_name, Number(r.price)]), [
      ['material', 'Бетон В25', 7800], ['material', 'Песок', 900], ['work', 'Устройство пола', 950],
    ])
    const work = list.find((r) => r.item_type === 'work')
    assert.equal(work.counterparty_name, 'ООО Реестр')
    assert.equal(work.object_name, 'ЖК Реестр')
    assert.equal(work.tender_desc, 'Полы паркинга')
    assert.equal(work.unit, 'м2')
    assert.equal(work.proposal_date, sql(`select (now() at time zone 'Europe/Moscow')::date`))
    assert.equal(as(U.employee, `select count(*) from public.kp_rates_registry_filter_counterparties where counterparty_id = '${CP}'`), '1')
    assert.equal(as(U.contractor, `select count(*) from public.kp_rates_registry where tender_id = '${T}'`), '0', 'подрядчику реестр закрыт')
    assert.throws(() => as(U.employee, 'select count(*) from public.kp_rates_registry_mv'), /permission denied/)
  })

  it('цену убрали или она пустая — из реестра уходит при пересчёте', () => {
    sql(`update public.tender_bid_rates set price = null, note = 'нет в наличии' where tender_id = '${T}' and kind = 'work'`)
    refresh()
    assert.deepEqual(registry(`item_type = 'work'`), [])
  })

  it('аварийный откат: реестр КП снова только из файлов; миграция ложится снова', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.deepEqual(registry().map((r) => [r.item_name, Number(r.price)]), [['Бетон В25', 7000], ['Песок', 900]])
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(registry().find((r) => r.item_name === 'Бетон В25').price, 7800)
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
