// «Сравнение КП»: все КП тендера одним запросом — функция tender_compare_proposals (миграция 20261123), на слепке
// схемы прода: проверка до миграции — FAIL, а не ошибка; ответ совпадает с выборкой из таблицы (те же строки и
// значения, порядок полей — как ROW_FIELDS вкладки); правила по строкам те же (сотрудник — все КП тендера, подрядчик
// — свои, гостю функция закрыта); колонки «учтено» (20260606) появляются в ответе, только если они есть; откат;
// тело функции в базе Яндекса то же. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'

const NAME = '20261123_tender_compare_proposals'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261123.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const COVERAGE = path.join(ROOT, 'supabase', 'migrations', '20260606_proposal_covered_elsewhere.sql')
const skip = skipReason()

const U = {
  employee: '00000000-0000-4000-8000-0000000d1a01',
  contractor: '00000000-0000-4000-8000-0000000d1a02',
}
const CP = ['00000000-0000-4000-8000-0000000d2a01', '00000000-0000-4000-8000-0000000d2a02']
const OBJ = '00000000-0000-4000-8000-0000000d3a01'
const T = '00000000-0000-4000-8000-0000000d4a01'
const T2 = '00000000-0000-4000-8000-0000000d4a02'
// Порядок полей строки ответа — как ROW_FIELDS в src/components/TenderProposalsCompare.jsx.
const FIELDS = ['id', 'counterparty_id', 'estimate_item_id', 'unit_price_materials', 'unit_price_works',
  'total_materials', 'total_works', 'total_cost', 'proposal_date', 'created_at']

describe('«Сравнение КП»: все КП тендера одним запросом — база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const call = (uid, tender = T) => JSON.parse(as(uid, `select public.tender_compare_proposals('${tender}')`))
  // Та же выборка из таблицы, что читала вкладка страницами (правила по строкам — того же пользователя).
  const direct = (uid, cols = FIELDS) => JSON.parse(as(uid, `select coalesce(json_agg(json_build_array(${cols.map((c) => `p.${c}`).join(', ')})
    order by p.id), '[]') from public.tender_counterparty_proposals p where p.tender_id = '${T}'`))
  const sorted = (rows) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    // Тендер с 1 200 позициями (больше страницы PostgREST) × 2 подрядчика, у второго — не все позиции; второй тендер — чужой.
    sql(`
      insert into public.roles (key, label, is_system) values ('tc_employee', 'Тест: тендеры', false) on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values ('tc_employee', 'tenders', true, false);
      insert into public.counterparties (id, name) values ('${CP[0]}', 'ООО Первый'), ('${CP[1]}', 'ООО Второй');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.employee}', 'tc_employee', true, false, 'Сравнев С. С.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '${CP[1]}');
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Сравнение', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
        ('${T}', 'Фасад', '${OBJ}', 'Идет тендерная процедура', 9960),
        ('${T2}', 'Кровля', '${OBJ}', 'Идет тендерная процедура', 9961);
      insert into public.tender_estimate_items (tender_id, estimate_name, row_number, code, cost_name, unit, work_volume, material_consumption)
        select t, 'ВОР ' || (n % 3), n, case when n % 2 = 0 then 'Р' else 'мат.' end, 'Позиция ' || n, 'шт',
               case when n % 2 = 0 then n else 0 end, case when n % 2 = 1 then n * 1.5 else 0 end
        from (values ('${T}'::uuid), ('${T2}'::uuid)) v(t), generate_series(1, 1200) n;
      insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials,
          unit_price_works, total_materials, total_works, total_cost, proposal_date)
        select i.tender_id, c.id, i.id, 10.5 + i.row_number % 7, 3.25, (10.5 + i.row_number % 7) * i.material_consumption,
               3.25 * i.work_volume, (10.5 + i.row_number % 7) * i.material_consumption + 3.25 * i.work_volume,
               date '2026-10-01' + (i.row_number % 5)
        from public.tender_estimate_items i
        join public.counterparties c on c.id in ('${CP[0]}', '${CP[1]}')
        where i.tender_id in ('${T}', '${T2}') and not (c.id = '${CP[1]}' and i.row_number % 4 = 0);`)
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

  it('сотрудник: все КП тендера одним ответом — те же строки и значения, что выборка из таблицы', () => {
    const res = call(U.employee)
    assert.equal(res.coverage, false, 'колонок «учтено» в базе нет')
    assert.equal(res.rows.length, 1200 + 900, 'больше 1000 строк — одним ответом, без страниц')
    assert.ok(res.rows.every((r) => r.length === FIELDS.length))
    assert.deepEqual(sorted(res.rows), direct(U.employee))
    assert.ok(res.rows.every((r) => r[2] && r[8] && r[9]), 'позиция, дата КП и время загрузки на месте')
    assert.deepEqual(call(U.employee, '00000000-0000-4000-8000-0000000d4aff'), { coverage: false, rows: [] })
  })

  it('подрядчик — только свои КП, гостю функция закрыта', () => {
    const res = call(U.contractor)
    assert.equal(res.rows.length, 900)
    assert.ok(res.rows.every((r) => r[1] === CP[1]))
    assert.deepEqual(sorted(res.rows), direct(U.contractor))
    assert.throws(() => psqlAt(db.port, `begin; set local role anon; select public.tender_compare_proposals('${T}'); commit;`),
      /permission denied/)
  })

  it('колонки «учтено» (20260606) есть — в ответе, нет — ответ без них', () => {
    psqlAt(db.port, null, { file: COVERAGE })
    sql(`update public.tender_counterparty_proposals set covered_elsewhere = true, coverage_note = 'в п. 7'
         where tender_id = '${T}' and counterparty_id = '${CP[0]}' and estimate_item_id in
           (select id from public.tender_estimate_items where tender_id = '${T}' and row_number <= 3)`)
    const res = call(U.employee)
    assert.equal(res.coverage, true)
    assert.ok(res.rows.every((r) => r.length === FIELDS.length + 2))
    assert.deepEqual(sorted(res.rows), direct(U.employee, [...FIELDS, 'covered_elsewhere', 'coverage_note']))
    assert.equal(res.rows.filter((r) => r[10] === true && r[11] === 'в п. 7').length, 3)
    sql('alter table public.tender_counterparty_proposals drop column covered_elsewhere, drop column coverage_note')
    assert.equal(call(U.employee).coverage, false)
  })

  it('аварийный откат: функции нет (вкладка читает страницами); миграция ложится снова', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select to_regprocedure('public.tender_compare_proposals(uuid)') is null`), 't')
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
  })
})

it('база Яндекса: то же тело функции, без прав Supabase, в списке шлюза', () => {
  // Без комментариев и с одинаковыми пробелами — сравниваются только сами команды.
  const plain = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim()
  const fn = (file) => plain(fs.readFileSync(file, 'utf8')).match(/CREATE OR REPLACE FUNCTION public\.tender_compare_proposals[\s\S]*?\$\$;/)?.[0]
  assert.ok(fn(MIGRATION))
  assert.equal(fn(YANDEX), fn(MIGRATION))
  const yandex = fs.readFileSync(YANDEX, 'utf8')
  assert.doesNotMatch(plain(yandex), /GRANT|REVOKE|BEGIN;|COMMIT;|SECURITY DEFINER|authenticated;/)
  assert.match(yandex, /^-- osp:allow rpc tender_compare_proposals authenticated$/m)
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json'), 'utf8'))
  assert.deepEqual(allow.rpc.tender_compare_proposals, ['authenticated'])
  for (const f of [CHECK, ROLLBACK, YANDEX.replace(/\.sql$/, '.check.sql')]) assert.ok(fs.existsSync(f), f)
  assert.match(fs.readFileSync(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt'), 'utf8'), new RegExp(`^${NAME}\\.sql$`, 'm'))
})
