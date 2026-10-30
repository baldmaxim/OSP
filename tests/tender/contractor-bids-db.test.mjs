// Кабинет подрядчика: расценка ВОР на сайте, заявки на участие, анкета (миграция 20261102_contractor_bids) — на
// слепке схемы прода: подрядчик видит открытые тендеры и расценивает после заявки, файлы ВОР открываются только
// после заявки и только своей организации, инженер делает участником или отклоняет, закрытый тендер — только
// чтение, цены и анкету читают администратор и сама организация, запись — только функциями, гостю — ничего;
// проверка для прода (до миграции — FAIL, а не ошибка) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20261102_contractor_bids'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261102.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const skip = skipReason()

const U = {
  admin: '00000000-0000-4000-8000-0000000b1a01',
  engineer: '00000000-0000-4000-8000-0000000b1a02',
  viewer: '00000000-0000-4000-8000-0000000b1a03',
  a: '00000000-0000-4000-8000-0000000b1a04',
  b: '00000000-0000-4000-8000-0000000b1a05',
  c: '00000000-0000-4000-8000-0000000b1a06',
  noorg: '00000000-0000-4000-8000-0000000b1a07',
}
const CP = {
  a: '00000000-0000-4000-8000-0000000b2a01',
  b: '00000000-0000-4000-8000-0000000b2a02',
  c: '00000000-0000-4000-8000-0000000b2a03',
}
const OBJ = '00000000-0000-4000-8000-0000000b3a01'
const T_OPEN = '00000000-0000-4000-8000-0000000b4a01'
const T_DONE = '00000000-0000-4000-8000-0000000b4a02'
const T_MAT = '00000000-0000-4000-8000-0000000b4a03'
const T_OPEN2 = '00000000-0000-4000-8000-0000000b4a04'
const DOC_VOR = '00000000-0000-4000-8000-0000000b5a01'
const DOC_GEN = '00000000-0000-4000-8000-0000000b5a02'

const rows = (list) => `'${JSON.stringify(list).replace(/'/g, "''")}'::jsonb`
const CONCRETE = { kind: 'material', key: 'бетонb25', unit_key: 'м3', name: 'Бетон В25', unit: 'м3', volume: 120.5, price: 7800.456 }
const SLAB = { kind: 'work', key: 'плита', unit_key: 'м3', name: 'Устройство плиты', unit: 'м3', volume: 120.5, price: 2500, note: 'с опалубкой' }

describe('Кабинет подрядчика: заявки, цены, анкета — база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const asAnon = (text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ role: 'anon' })}';
    set local role anon;
    ${text};
    commit;`)
  const fieldId = () => sql('select id from public.bid_form_fields order by sort_order limit 1')

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      // 20261103 и 20261122 (реестр КП) зависят от этой миграции — здесь не нужны.
      if (m.startsWith(NAME) || m.startsWith('20261103_') || m.startsWith('20261122_')) continue
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('cb_engineer', 'Тест: тендерный отдел', false), ('cb_viewer', 'Тест: просмотр тендеров', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('cb_engineer', 'tenders', true, true), ('cb_viewer', 'tenders', true, false);
      insert into public.counterparties (id, name, inn) values
        ('${CP.a}', 'ООО Альфа', '7700000001'), ('${CP.b}', 'ООО Бета', '7700000002'), ('${CP.c}', 'ООО Гамма', '7700000003');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.admin}', 'admin', true, false, 'Админов А. А.', null),
        ('${U.engineer}', 'cb_engineer', true, false, 'Инженеров И. И.', null),
        ('${U.viewer}', 'cb_viewer', true, false, 'Смотров С. С.', null),
        ('${U.a}', 'contractor', true, false, 'Альфин А. А.', '${CP.a}'),
        ('${U.b}', 'contractor', true, false, 'Бетин Б. Б.', '${CP.b}'),
        ('${U.c}', 'contractor', true, false, 'Гаммин Г. Г.', '${CP.c}'),
        ('${U.noorg}', 'contractor', true, false, 'Безорг Б. Б.', null);
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Кабинет', 'Москва', 'main_construction');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number, tender_start_date, tender_end_date) values
        ('${T_OPEN}', 'Монолит паркинга', '${OBJ}', 'Идет тендерная процедура', 9901, '2026-10-20', '2026-11-05'),
        ('${T_DONE}', 'Кровля', '${OBJ}', 'Завершен', 9902, null, null),
        ('${T_OPEN2}', 'Фасад', '${OBJ}', 'Идет тендерная процедура', 9904, null, null);
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${T_MAT}', 'Монолит паркинга', '${OBJ}', 'В работе', 'materials', '${T_OPEN}');
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
        ('${DOC_VOR}', 'tender', '${T_OPEN}', 'tenders/x/vor.xlsx', 'ВОР паркинга.xlsx', 'vor_statement'),
        ('${DOC_GEN}', 'tender', '${T_OPEN}', 'tenders/x/kp.xlsx', 'КП участника.xlsx', 'general');`)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 7)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    assert.equal(sql('select count(*) from public.bid_form_fields'), '14', 'анкета по умолчанию — один раз')
    assert.equal(sql(`select kind || ' ' || (options ->> 0) || ' ' || jsonb_array_length(options) from public.bid_form_fields where code = 'vat'`), 'select 22 % 4')
  })

  it('кабинет: открытые основные тендеры без доступа, закрытые и на материалы — нет; сотруднику и подрядчику без организации — отказ', () => {
    const list = JSON.parse(as(U.a, 'select json_agg(t) from public.bid_contractor_tenders() t') || '[]')
    const mine = list.filter((t) => [T_OPEN, T_OPEN2, T_DONE, T_MAT].includes(t.id))
    assert.deepEqual(mine.map((t) => t.id).sort(), [T_OPEN, T_OPEN2].sort())
    const open = mine.find((t) => t.id === T_OPEN)
    assert.equal(open.access, null)
    assert.equal(open.is_open, true)
    assert.equal(open.object_name, 'ЖК Кабинет')
    assert.equal(open.public_tender_number, 9901)
    for (const u of [U.engineer, U.noorg]) assert.throws(() => as(u, 'select count(*) from public.bid_contractor_tenders()'), /только для подрядчика/)
    assert.throws(() => asAnon('select count(*) from public.bid_contractor_tenders()'), /permission denied/)
  })

  it('файлы ВОР открытого тендера — только после заявки и только своей организации; прочие файлы тендера — нет', () => {
    const files = `select count(*) from public.s3_documents where owner_id = '${T_OPEN}'`
    assert.equal(as(U.a, files), '0')
    assert.throws(() => as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([CONCRETE])})`), /закрыта/, 'без заявки цены не пишутся')
    assert.equal(as(U.a, `select public.bid_request('${T_OPEN}')`), 'pending')
    assert.equal(as(U.a, `select public.bid_request('${T_OPEN}')`), 'pending', 'повтор — та же заявка')
    assert.equal(as(U.a, files), '1')
    assert.equal(as(U.a, `select doc_category from public.s3_documents where owner_id = '${T_OPEN}'`), 'vor_statement')
    assert.equal(as(U.b, files), '0')
    assert.equal(sql(`select requested_by_name from public.tender_bid_requests where tender_id = '${T_OPEN}' and counterparty_id = '${CP.a}'`), 'Альфин А. А.')
    assert.throws(() => as(U.a, `select public.bid_request('${T_DONE}')`), /закрыт/)
    assert.equal(as(U.engineer, files), '2', 'сотрудник видит файлы как раньше')
  })

  it('цены: округление до копеек, итог = цена × объём, пустая цена без примечания — удаляет; видят администратор и своя организация', () => {
    assert.equal(as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([CONCRETE, SLAB])})`), '2')
    const r = JSON.parse(sql(`select row_to_json(b) from public.tender_bid_rates b where tender_id = '${T_OPEN}' and kind = 'material'`))
    assert.equal(Number(r.price), 7800.46)
    assert.equal(Number(r.total), 939955.43)
    assert.equal(r.updated_by, U.a)
    assert.equal(r.source, 'manual')
    const count = `select count(*) from public.tender_bid_rates where tender_id = '${T_OPEN}'`
    assert.equal(as(U.a, count), '2')
    assert.equal(as(U.admin, count), '2')
    for (const u of [U.b, U.engineer, U.viewer, U.noorg]) assert.equal(as(u, count), '0', u)
    as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([{ ...CONCRETE, price: null }])})`)
    assert.equal(as(U.a, count), '1')
    as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([{ ...CONCRETE, source: 'import' }])})`)
    assert.equal(sql(`select source from public.tender_bid_rates where tender_id = '${T_OPEN}' and kind = 'material'`), 'import')
    assert.throws(() => as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([{ ...CONCRETE, kind: 'x' }])})`), /вида/)
    assert.throws(() => as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([{ ...CONCRETE, price: -1 }])})`), /check constraint|нарушает ограничение|violates/)
    assert.throws(() => as(U.a, `select public.bid_rates_save('${T_OPEN}', '{}'::jsonb)`), /Неверный список/)
  })

  it('прямой записи в заявки, цены и анкету нет ни у кого из вошедших', () => {
    for (const u of [U.a, U.admin]) {
      assert.throws(() => as(u, `insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, name, price)
        values ('${T_OPEN}', '${CP.a}', 'material', 'x', 'x', 1)`), /permission denied/)
      assert.throws(() => as(u, `update public.tender_bid_requests set status = 'accepted'`), /permission denied/)
      assert.throws(() => as(u, `insert into public.tender_bid_forms (tender_id, counterparty_id) values ('${T_OPEN}', '${CP.a}')`), /permission denied/)
    }
  })

  it('анкета: подпись поля — слепком, чужие ключи — мимо, пустое — убирает; читает администратор и своя организация', () => {
    const f = fieldId()
    const doc = JSON.parse(as(U.a, `select public.bid_form_save('${T_OPEN}', jsonb_build_object('${f}', '  ООО Альфа  ', 'чужой-ключ', 'x'))`))
    assert.deepEqual(doc, { [f]: { label: 'Наименование контрагента', value: 'ООО Альфа' } })
    const read = `select count(*) from public.tender_bid_forms where tender_id = '${T_OPEN}'`
    assert.equal(as(U.a, read), '1')
    assert.equal(as(U.admin, read), '1')
    for (const u of [U.b, U.engineer]) assert.equal(as(u, read), '0')
    sql(`update public.bid_form_fields set label = 'Наименование (новое)' where id = '${f}'`)
    assert.equal(as(U.a, `select answers -> '${f}' ->> 'label' from public.tender_bid_forms where tender_id = '${T_OPEN}'`), 'Наименование контрагента')
    as(U.a, `select public.bid_form_save('${T_OPEN}', jsonb_build_object('${f}', ''))`)
    assert.equal(as(U.a, `select answers::text from public.tender_bid_forms where tender_id = '${T_OPEN}'`), '{}')
    assert.throws(() => as(U.b, `select public.bid_form_save('${T_OPEN}', '{}'::jsonb)`), /закрыта/, 'без заявки — нельзя')
  })

  it('ставка НДС — только из списка; ответ виден в сводке администратора', () => {
    const vat = sql(`select id from public.bid_form_fields where code = 'vat'`)
    assert.equal(sql(`select options::text from public.bid_form_fields where code = 'vat'`), '["22 %", "7 %", "5 %", "0 %"]')
    for (const gone of ['18 %', '20 %', '10 %', 'Без НДС']) {
      assert.throws(() => as(U.a, `select public.bid_form_save('${T_OPEN}', jsonb_build_object('${vat}', '${gone}'))`), /не из списка/, gone)
    }
    as(U.a, `select public.bid_form_save('${T_OPEN}', jsonb_build_object('${vat}', '5 %'))`)
    assert.equal(as(U.a, `select answers -> '${vat}' ->> 'value' from public.tender_bid_forms where tender_id = '${T_OPEN}'`), '5 %')
    as(U.a, `select public.bid_form_save('${T_OPEN}', jsonb_build_object('${vat}', '22 %'))`)
    assert.throws(() => sql(`insert into public.bid_form_fields (label, code) values ('Второй НДС', 'vat')`), /duplicate key|повторяющееся/)
    assert.throws(() => sql(`insert into public.bid_form_fields (label, kind) values ('Список без вариантов', 'select')`), /check constraint|нарушает ограничение|violates/)
  })

  it('поля анкеты: читают сотрудник и подрядчик с организацией, правит только администратор', () => {
    const n = sql('select count(*) from public.bid_form_fields')
    for (const u of [U.a, U.engineer, U.viewer]) assert.equal(as(u, 'select count(*) from public.bid_form_fields'), n)
    assert.equal(as(U.noorg, 'select count(*) from public.bid_form_fields'), '0')
    assert.throws(() => as(U.a, `insert into public.bid_form_fields (label) values ('Взлом')`), /row-level security/)
    assert.equal(as(U.engineer, `with x as (update public.bid_form_fields set label = 'x' returning 1) select count(*) from x`), '0')
    as(U.admin, `insert into public.bid_form_fields (label, hint, sort_order) values ('Опыт аналогичных работ', 'перечень объектов', 1000)`)
    assert.equal(sql('select count(*) from public.bid_form_fields'), String(Number(n) + 1))
  })

  it('решение инженера: просмотр «Тендеров» — отказ; принять — участник («КП предоставлено», если цены есть); отклонить — только чтение', () => {
    const reqA = sql(`select id from public.tender_bid_requests where tender_id = '${T_OPEN}' and counterparty_id = '${CP.a}'`)
    assert.throws(() => as(U.viewer, `select public.bid_decide('${reqA}', true)`), /Нет права/)
    assert.throws(() => as(U.a, `select public.bid_decide('${reqA}', true)`), /Нет права/)
    assert.equal(as(U.viewer, `select status from public.tender_bid_requests where id = '${reqA}'`), 'pending', 'заявки видит сотрудник')
    assert.equal(as(U.a, 'select count(*) from public.tender_bid_requests'), '1', 'подрядчик — только свои')
    assert.equal(as(U.engineer, `select public.bid_decide('${reqA}', true)`), 'accepted')
    assert.equal(sql(`select status from public.tender_counterparties where tender_id = '${T_OPEN}' and counterparty_id = '${CP.a}'`), 'proposal_provided')
    assert.equal(as(U.a, `select public.bid_access('${T_OPEN}')`), 'invited')
    assert.equal(as(U.engineer, `select public.bid_decide('${reqA}', false)`), 'accepted', 'принятую не отклонить')

    as(U.b, `select public.bid_request('${T_OPEN}')`)
    const reqB = sql(`select id from public.tender_bid_requests where tender_id = '${T_OPEN}' and counterparty_id = '${CP.b}'`)
    as(U.b, `select public.bid_rates_save('${T_OPEN}', ${rows([SLAB])})`)
    assert.equal(as(U.engineer, `select public.bid_decide('${reqB}', false)`), 'rejected')
    assert.equal(sql(`select decided_by_name from public.tender_bid_requests where id = '${reqB}'`), 'Инженеров И. И.')
    assert.equal(sql(`select count(*) from public.tender_counterparties where tender_id = '${T_OPEN}' and counterparty_id = '${CP.b}'`), '0')
    assert.throws(() => as(U.b, `select public.bid_rates_save('${T_OPEN}', ${rows([SLAB])})`), /закрыта/)
    assert.equal(as(U.b, `select count(*) from public.s3_documents where owner_id = '${T_OPEN}'`), '0', 'отклонённому файлы закрыты')
    assert.equal(as(U.b, `select count(*) from public.tender_bid_rates where tender_id = '${T_OPEN}'`), '1', 'свои цены видны')
    assert.equal(as(U.b, `select public.bid_request('${T_OPEN}')`), 'rejected', 'повторная заявка ничего не меняет')
    assert.equal(as(U.engineer, `select public.bid_decide('${reqB}', true)`), 'accepted', 'отклонённую можно принять позже')
    assert.equal(sql(`select status from public.tender_counterparties where tender_id = '${T_OPEN}' and counterparty_id = '${CP.b}'`), 'proposal_provided')
  })

  it('сводка администратора: организация, участие, суммы по видам, анкета; остальным — отказ', () => {
    const list = JSON.parse(as(U.admin, `select json_agg(o) from public.bid_admin_overview() o where tender_id = '${T_OPEN}'`))
    const a = list.find((r) => r.counterparty_id === CP.a)
    assert.equal(a.counterparty_name, 'ООО Альфа')
    assert.equal(a.invite_status, 'proposal_provided')
    assert.equal(a.request_status, 'accepted')
    assert.equal(a.materials_priced, 1)
    assert.equal(a.works_priced, 1)
    assert.equal(a.total, 1241205.43)
    assert.equal(a.vat, '22 %')
    assert.equal(list.find((r) => r.counterparty_id === CP.b).vat, null)
    assert.equal(list.length, 2)
    for (const u of [U.engineer, U.a]) assert.throws(() => as(u, 'select count(*) from public.bid_admin_overview()'), /только администратору/)
  })

  it('тендер закрыт — цены и анкета только для чтения; в кабинете остаётся «мой», но не открытый', () => {
    sql(`update public.tenders set status = 'Подведение итогов' where id = '${T_OPEN}'`)
    assert.throws(() => as(U.a, `select public.bid_rates_save('${T_OPEN}', ${rows([CONCRETE])})`), /закрыта/)
    assert.throws(() => as(U.a, `select public.bid_form_save('${T_OPEN}', '{}'::jsonb)`), /закрыта/)
    const t = JSON.parse(as(U.a, `select row_to_json(t) from public.bid_contractor_tenders() t where id = '${T_OPEN}'`))
    assert.equal(t.is_open, false)
    assert.equal(t.access, 'invited')
    assert.equal(t.priced_count, 2)
    sql(`update public.tenders set status = 'Идет тендерная процедура' where id = '${T_OPEN}'`)
  })

  it('гостю — ничего: ни таблиц, ни функций', () => {
    for (const t of ['tender_bid_requests', 'tender_bid_rates', 'tender_bid_forms', 'bid_form_fields']) {
      assert.throws(() => asAnon(`select count(*) from public.${t}`), /permission denied/, t)
    }
    assert.throws(() => asAnon(`select public.bid_request('${T_OPEN2}')`), /permission denied/)
    assert.throws(() => asAnon(`select public.bid_rates_save('${T_OPEN2}', '[]'::jsonb)`), /permission denied/)
  })

  it('удаление тендера удаляет его заявки, цены и анкеты', () => {
    as(U.c, `select public.bid_request('${T_OPEN2}')`)
    as(U.c, `select public.bid_rates_save('${T_OPEN2}', ${rows([CONCRETE])})`)
    as(U.c, `select public.bid_form_save('${T_OPEN2}', jsonb_build_object('${fieldId()}', 'ООО Гамма'))`)
    sql(`delete from public.tenders where id = '${T_OPEN2}'`)
    for (const t of ['tender_bid_requests', 'tender_bid_rates', 'tender_bid_forms']) {
      assert.equal(sql(`select count(*) from public.${t} where tender_id = '${T_OPEN2}'`), '0', t)
    }
  })

  it('аварийный откат применяется и повторяется: данные остаются, файлы — только своих тендеров; миграция ложится снова', () => {
    sql(`insert into public.tenders (id, work_description, object_id, status) values ('${T_OPEN2}', 'Фасад', '${OBJ}', 'Идет тендерная процедура');
      insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category) values ('tender', '${T_OPEN2}', 'tenders/y/vor.xlsx', 'ВОР фасада.xlsx', 'vor_statement')`)
    as(U.c, `select public.bid_request('${T_OPEN2}')`)
    assert.equal(as(U.c, `select count(*) from public.s3_documents where owner_id = '${T_OPEN2}'`), '1')
    const n = sql('select count(*) from public.tender_bid_rates')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_bid_rates'), n)
    assert.equal(as(U.c, `select count(*) from public.s3_documents where owner_id = '${T_OPEN2}'`), '0')
    assert.equal(as(U.a, `select count(*) from public.s3_documents where owner_id = '${T_OPEN}'`), '1', 'свой тендер — как до миграции')
    assert.throws(() => as(U.a, 'select count(*) from public.tender_bid_rates'), /permission denied/)
    assert.throws(() => as(U.a, 'select count(*) from public.bid_contractor_tenders()'), /permission denied/)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(as(U.c, `select count(*) from public.s3_documents where owner_id = '${T_OPEN2}'`), '1')
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
