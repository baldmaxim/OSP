// Доставка позиции в расценке снабжением (миграция 20261120_supply_rate_delivery) — на слепке схемы прода после
// 20261020 … 20261029: цена за единицу = цена + доставка (за единицу или суммой на объём), итог и точная цена, прежние
// цены не пересчитываются, прямая запись цены (импорт Excel) снимает доставку, журнал пишет доставку, отказы базы,
// права и закрытие — как у цен, проверка для прода (до миграции — FAIL) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, '20261120_supply_rate_delivery.sql')
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261120.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20261120_supply_rate_delivery_rollback.sql')
// Миграции расценки — по порядку, остальные кандидаты — до них (как в других тестах расценки).
const SUPPLY = ['20261020_supply_pricing.sql', '20261022_supply_links.sql', '20261023_supply_rate_reuse.sql',
  '20261025_supply_docs_similarity.sql', '20261029_supply_vor_versions.sql']
const skip = skipReason()

const U = {
  supply: '00000000-0000-4000-8000-00000000c3b1',
  viewer: '00000000-0000-4000-8000-00000000c3b3',
}
const OBJ = '00000000-0000-4000-8000-00000000d301'
const T1 = '00000000-0000-4000-8000-00000000e301'
const M1 = '00000000-0000-4000-8000-00000000e311'
const T2 = '00000000-0000-4000-8000-00000000e302'
const M2 = '00000000-0000-4000-8000-00000000e312'

describe('Доставка позиции в расценке снабжением: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  let legacy = []
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`)
  const rate = (where) => JSON.parse(sql(`select row_to_json(r) from public.tender_vor_supply_rates r where ${where}`) || 'null')
  const num = (v) => (v == null ? null : Number(v))
  // Запись страницы: цена (как ввели) и доставка (как ввели) одним запросом.
  const put = (uid, tender, name, { mode = 'unit', value, volume = null, dMode = null, dValue = null }) => {
    const id = sql(`select id from public.tender_vor_supply_rates where tender_id = '${tender}' and estimate_name = 'ВОР' and material_name = ${q(name)}`)
    const set = `price_input = ${q(mode)}, input_value = ${value}, volume_at_input = ${volume ?? 'null'}, delivery_input = ${q(dMode)}, delivery_value = ${dValue ?? 'null'}`
    if (id) return as(uid, `update public.tender_vor_supply_rates set ${set} where id = '${id}'`)
    return as(uid, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input, delivery_input, delivery_value)
      values ('${tender}', 'ВОР', ${q(name)}, 'шт', ${q(mode)}, ${value}, ${volume ?? 'null'}, ${q(dMode)}, ${dValue ?? 'null'})`)
  }
  const priced = (name) => {
    const r = rate(`material_name = ${q(name)}`)
    return [num(r.supply_price), num(r.supply_price_exact), num(r.supply_total), r.delivery_input, num(r.delivery_value)]
  }

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (/^2026(102[02359]|1120)_/.test(m)) continue
      psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    }
    for (const m of SUPPLY) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    sql(`
      insert into public.roles (key, label, is_system) values ('d_supply', 'Тест: снабжение', false), ('d_viewer', 'Тест: просмотр', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('d_supply', 'tenders_materials', true, true), ('d_viewer', 'tenders_materials', true, false);
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name) values
        ('${U.supply}', 'd_supply', true, false, 'Снабженцев С. С.'), ('${U.viewer}', 'd_viewer', true, false, 'Смотров В. В.');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Доставка', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ('${T1}', 'Бетонные полы', '${OBJ}', 'Идет тендерная процедура'), ('${T2}', 'Закрыт', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${M1}', 'Бетонные полы', '${OBJ}', 'В работе', 'materials', '${T1}'), ('${M2}', 'Закрыт', '${OBJ}', 'В работе', 'materials', '${T2}');`)
    // Цены до миграции: за единицу, суммой, из Excel — после миграции должны остаться теми же.
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input) values
      ('${T1}', 'ВОР', 'Праймер битумный', 'кг', 'unit', 139.46, 497.1392),
      ('${T1}', 'ВОР', 'Техноэласт Барьер БО', 'м2', 'total', 709517.84, 2489.711)`)
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price) values
      ('${T1}', 'ВОР', 'Раствор М-150', 'м3', 5.76)`)
    legacy = JSON.parse(sql(`select json_agg(r order by material_name) from (select material_name, supply_price, supply_price_exact, supply_total,
      price_input, input_value, row_version, price_date from public.tender_vor_supply_rates where tender_id = '${T1}') r`))
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4, checkBefore)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('прежние цены не пересчитаны и не изменены: цена, итог, версия строки, день расценки; доставки у них нет', () => {
    const now = JSON.parse(sql(`select json_agg(r order by material_name) from (select material_name, supply_price, supply_price_exact, supply_total,
      price_input, input_value, row_version, price_date from public.tender_vor_supply_rates where tender_id = '${T1}') r`))
    assert.deepEqual(now, legacy)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where delivery_input is not null or delivery_value is not null`), '0')
  })

  it('без доставки — как раньше: цена за единицу и суммой', () => {
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59 })
    assert.deepEqual(priced('Лоток CompoMax'), [1163.12, null, 68624.08, null, null])
    put(U.supply, T1, 'Решетка РВ-10.14.50', { mode: 'total', value: 76846.32, volume: 118 })
    assert.deepEqual(priced('Решетка РВ-10.14.50'), [651.24, 651.24, 76846.32, null, null])
  })

  it('доставка за единицу — к цене за единицу; итог — цена с доставкой × объём', () => {
    put(U.supply, T1, 'Шов ДШКА-75-УГЛ/050', { value: 3733.79, volume: 229.586, dMode: 'unit', dValue: 120.456 })
    // Доставка за единицу — до копейки, как цена: 3733,79 + 120,46.
    assert.deepEqual(priced('Шов ДШКА-75-УГЛ/050'), [3854.25, null, Math.round(3854.25 * 229.586 * 100) / 100, 'unit', 120.456])
  })

  it('доставка суммой — на объём позиции: итог = цена × объём + доставка, цена — итог ÷ объём (точная — отдельно)', () => {
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59, dMode: 'total', dValue: 1000 })
    const [p, exact, total, mode, value] = priced('Лоток CompoMax')
    assert.equal(total, 69624.08)
    assert.ok(Math.abs(exact - 69624.08 / 59) < 1e-9, String(exact))
    assert.equal(p, 1180.07)
    assert.deepEqual([mode, value], ['total', 1000])
    // Сумма цены и доставка за единицу.
    put(U.supply, T1, 'Решетка РВ-10.14.50', { mode: 'total', value: 76846.32, volume: 118, dMode: 'unit', dValue: 10 })
    assert.deepEqual(priced('Решетка РВ-10.14.50').slice(0, 3), [661.24, 661.24, 78026.32])
  })

  it('правка одной доставки — пересчёт, новая версия строки, запись в журнале с доставкой; очистка — цена без доставки', () => {
    const before = rate(`material_name = 'Лоток CompoMax'`)
    const logBefore = Number(sql(`select count(*) from public.tender_supply_rate_log where rate_id = '${before.id}'`))
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59, dMode: 'total', dValue: 2000 })
    const after1 = rate(`id = '${before.id}'`)
    assert.equal(after1.row_version, before.row_version + 1)
    assert.equal(num(after1.supply_total), 70624.08)
    const log = JSON.parse(sql(`select row_to_json(l) from public.tender_supply_rate_log l where rate_id = '${before.id}' order by id desc limit 1`))
    assert.equal(Number(sql(`select count(*) from public.tender_supply_rate_log where rate_id = '${before.id}'`)), logBefore + 1)
    assert.deepEqual([log.delivery_input, num(log.delivery_value), num(log.old_total), num(log.new_total)], ['total', 2000, 69624.08, 70624.08])
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59 })
    assert.deepEqual(priced('Лоток CompoMax'), [1163.12, null, 68624.08, null, null])
  })

  it('отказы: доставка без значения, ноль, сумма доставки без объёма; не та запись доставки — ограничение', () => {
    assert.throws(() => put(U.supply, T1, 'Шов ДШКА-75/050', { value: 4225.44, volume: 689.61, dMode: 'unit', dValue: 0 }), /Доставка должна быть больше нуля/)
    assert.throws(() => put(U.supply, T1, 'Шов ДШКА-75/050', { value: 4225.44, volume: 689.61, dMode: 'unit' }), /Доставка должна быть больше нуля/)
    assert.throws(() => put(U.supply, T1, 'Шов ДШКА-75/050', { value: 4225.44, dMode: 'total', dValue: 500 }), /только у позиции с объёмом/)
    assert.throws(() => put(U.supply, T1, 'Шов ДШКА-75/050', { value: 4225.44, volume: 10, dMode: 'перевозка', dValue: 5 }), /check constraint|нарушает ограничение|violates/)
    assert.equal(rate(`material_name = 'Шов ДШКА-75/050'`), null)
  })

  it('цена, записанная напрямую (импорт Excel), — вся цена позиции: доставка снимается', () => {
    put(U.supply, T1, 'Шов ДШКА-75/050', { value: 4225.44, volume: 689.61, dMode: 'unit', dValue: 50 })
    as(U.supply, `update public.tender_vor_supply_rates set supply_price = 4300 where material_name = 'Шов ДШКА-75/050'`)
    const r = rate(`material_name = 'Шов ДШКА-75/050'`)
    assert.deepEqual([num(r.supply_price), r.price_input, r.delivery_input, r.delivery_value], [4300, 'import', null, null])
    // У цены из Excel доставку напрямую не поставить — она к цене не приложится, поэтому не пишется.
    as(U.supply, `update public.tender_vor_supply_rates set delivery_input = 'unit', delivery_value = 10 where material_name = 'Раствор М-150'`)
    assert.deepEqual(priced('Раствор М-150'), [5.76, null, null, null, null])
  })

  it('права и закрытие — как у цен: без права правки и у «Завершён» доставку не поставить', () => {
    const id = rate(`material_name = 'Лоток CompoMax'`).id
    assert.equal(as(U.viewer, `with x as (update public.tender_vor_supply_rates set delivery_input = 'unit', delivery_value = 5
      where id = '${id}' returning 1) select count(*) from x`), '0')
    put(U.supply, T2, 'Кабель', { value: 100, volume: 10 })
    sql(`update public.tenders set status = 'Завершён' where id = '${M2}'`)
    assert.throws(() => put(U.supply, T2, 'Кабель', { value: 100, volume: 10, dMode: 'unit', dValue: 5 }), /только для чтения/)
  })

  it('аварийный откат: расчёт без доставки, колонки и данные на месте; миграция применяется снова', () => {
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59, dMode: 'unit', dValue: 10 })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.deepEqual(priced('Лоток CompoMax'), [1173.12, null, Math.round(1173.12 * 59 * 100) / 100, 'unit', 10], 'посчитанная цена осталась')
    put(U.supply, T1, 'Лоток CompoMax', { value: 1200, volume: 59, dMode: 'unit', dValue: 20 })
    assert.equal(priced('Лоток CompoMax')[0], 1200, 'после отката доставка к цене не прикладывается')
    psqlAt(db.port, null, { file: MIGRATION })
    put(U.supply, T1, 'Лоток CompoMax', { value: 1163.12, volume: 59, dMode: 'unit', dValue: 30 })
    assert.equal(priced('Лоток CompoMax')[0], 1193.12)
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})
