// Кабинет подрядчика, просьба пользователя 25.11.2026 — копия прода под одной учёткой, настоящий migrate.sh с проверкой прав
// (миграция 20270302_bid_supply_docs):
//   • счета снабжения подрядчику — только с разрешением отдела, пока идёт приём, и только к цене, взятой у снабжения и не изменённой
//     (своя цена, другая цена снабжения, запрет, закрытый приём — счетов нет); только файлы, адресных ссылок нет; несколько ВОР — все файлы;
//   • файл счёта службе (bid_supply_doc_file) — только файл из списка организации; сотруднику — отказ; строки s3_documents подрядчику
//     по-прежнему закрыты;
//   • прошлые цены одним запросом — последняя своя цена по присланным позициям, без цен снабжения и без этого тендера, чужих нет;
//   • откат: функций нет, повтор безопасен.
// Страница — contractor-cabinet.test.mjs (стенд supply=granted, historyFn=0). Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const MIG = '20270302_bid_supply_docs'
const file = (dir, name) => path.join(ROOT, 'migration', dir, name)
const id = (n) => `00000000-0000-4000-8000-0000003${String(n).padStart(5, '0')}`
const U = { admin: id(1), alpha: id(2), beta: id(3), self: id(5) }
const CP = { alpha: id(11), beta: id(12), self: id(13) }
const OBJ = id(21)
const T = { open: id(31), other: id(32) }
const DOC = { ov: id(41), vk: id(42), inv1: id(51), inv2: id(52), invKran: id(53), invOther: id(54) }

const pos = (kind, name, unit, volume) => `jsonb_build_object('kind', '${kind}', 'key', '${kind}|' || public.supply_norm_name('${name}') || '|' || public.kp_norm_unit('${unit}'),
  'itemKey', public.supply_norm_name('${name}'), 'unitKey', public.kp_norm_unit('${unit}'), 'name', '${name}', 'unit', '${unit}', 'volume', ${volume}, 'rows', 1)`
const parsed = (doc, tender, list) => `insert into osp_private.bid_vor_files (s3_document_id, tender_id, source_version, status, positions)
  values ('${doc}', '${tender}', 'bid:1', 'ok', jsonb_build_array(${list.join(', ')}));`

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.alpha}', '${U.beta}', '${U.self}']::uuid[]) u;
  insert into public.counterparties (id, name, inn) values ('${CP.alpha}', 'ООО Альфа Счета', '7707083893'),
    ('${CP.beta}', 'ООО Бета Счета', '7736050003'), ('${CP.self}', 'ООО Сайт Счета', '7710140679');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, self_registered) values
    ('${U.admin}', 'admin', true, false, 'Админов', 'admin@example.invalid', null, false),
    ('${U.alpha}', 'contractor', true, false, 'Альфин А. А.', 'alpha@example.invalid', '${CP.alpha}', false),
    ('${U.beta}', 'contractor', true, false, 'Бетин Б. Б.', 'beta@example.invalid', '${CP.beta}', false),
    ('${U.self}', 'contractor', true, false, 'Сайтов С. С.', 'self@example.invalid', '${CP.self}', true);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Счета', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
    ('${T.open}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура', 99911),
    ('${T.other}', 'Прошлый тендер', '${OBJ}', 'Идет тендерная процедура', 99912);
  insert into public.tender_counterparties (tender_id, counterparty_id, status) values ('${T.open}', '${CP.alpha}', 'request_sent');
  insert into public.tender_bid_requests (tender_id, counterparty_id, status) values ('${T.open}', '${CP.self}', 'pending');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at) values
    ('${DOC.ov}', 'tender', '${T.open}', 'tenders/s/ov.xlsx', 'ВОР ОВ.xlsx', 'vor_statement', now() - interval '20 days'),
    ('${DOC.vk}', 'tender', '${T.open}', 'tenders/s/vk.xlsx', 'ВОР ВК.xlsx', 'vor', now() - interval '20 days'),
    ('${DOC.inv1}', 'tender', '${T.open}', 'tenders/s/inv1.pdf', 'Счёт ПСК № 072813.pdf', 'supply_doc', now() - interval '3 days'),
    ('${DOC.inv2}', 'tender', '${T.open}', 'tenders/s/inv2.pdf', 'КП Стандартпарк № 10067.pdf', 'supply_doc', now() - interval '2 days'),
    ('${DOC.invKran}', 'tender', '${T.open}', 'tenders/s/kran.pdf', 'Счёт на краны.pdf', 'supply_doc', now() - interval '2 days'),
    ('${DOC.invOther}', 'tender', '${T.other}', 'tenders/s/other.pdf', 'Счёт другого тендера.pdf', 'supply_doc', now() - interval '9 days');
  ${parsed(DOC.ov, T.open, [pos('material', 'Труба стальная 20', 'м', 100), pos('material', 'Кран шаровый 20', 'шт', 10), pos('material', 'Отвод 20', 'шт', 8), pos('work', 'Монтаж трубы', 'м', 100)])}
  ${parsed(DOC.vk, T.open, [pos('material', 'Труба стальная 20', 'м', 30), pos('material', 'Кран шаровый 20', 'шт', 4)])}
  insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, positions)
    values ('${T.open}', 'ВОР ОВ', 'vor_file', '${DOC.ov}', 'ВОР ОВ.xlsx', '[{"name": "Труба стальная 20", "unit": "м", "volume": 100}]'::jsonb),
           ('${T.open}', 'ВОР ВК', 'vor_file', '${DOC.vk}', 'ВОР ВК.xlsx', '[{"name": "Труба стальная 20", "unit": "м", "volume": 30}]'::jsonb);
  -- Труба — одна цена в обоих ВОР, у каждого ВОР свой файл; кран — разные цены (цены снабжения нет, счёта тоже);
  -- отвод — цена есть, документ — адресная ссылка (подрядчику не отдаётся).
  insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price) values
    ('${T.open}', 'ВОР ОВ', 'Труба стальная 20', 'м', 512.40), ('${T.open}', 'ВОР ВК', 'Труба стальная 20', 'м.', 512.40),
    ('${T.open}', 'ВОР ОВ', 'Кран шаровый 20', 'шт', 900), ('${T.open}', 'ВОР ВК', 'Кран шаровый 20', 'шт', 950),
    ('${T.open}', 'ВОР ОВ', 'Отвод 20', 'шт', 75);
  insert into public.tender_supply_links (tender_id, estimate_name, material_name, s3_document_id) values
    ('${T.open}', 'ВОР ОВ', 'Труба стальная 20', '${DOC.inv1}'), ('${T.open}', 'ВОР ВК', 'Труба стальная 20', '${DOC.inv2}'),
    ('${T.open}', 'ВОР ОВ', 'Кран шаровый 20', '${DOC.invKran}');
  insert into public.tender_supply_links (tender_id, estimate_name, material_name, url) values
    ('${T.open}', 'ВОР ОВ', 'Отвод 20', '\\\\server\\snab\\otvod.pdf');
  -- Прошлые цены «Альфы» в другом тендере: две своих цены трубы (новая — 700) и цена отвода, взятая у снабжения.
  insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, source, updated_at) values
    ('${T.other}', '${CP.alpha}', 'material', public.supply_norm_name('Труба стальная 20'), public.kp_norm_unit('м'), 'Труба стальная 20', 'м', 1, 600, 600, 'manual', now() - interval '60 days'),
    ('${T.other}', '${CP.beta}', 'material', public.supply_norm_name('Труба стальная 20'), public.kp_norm_unit('м'), 'Труба стальная 20', 'м', 1, 999, 999, 'manual', now() - interval '1 day'),
    ('${T.other}', '${CP.alpha}', 'material', public.supply_norm_name('Отвод 20'), public.kp_norm_unit('шт'), 'Отвод 20', 'шт', 1, 75, 75, 'supply', now() - interval '5 days');
  update public.tender_bid_rates set price = 700, total = 700, updated_at = now() - interval '10 days'
    where tender_id = '${T.other}' and counterparty_id = '${CP.alpha}' and item_key = public.supply_norm_name('Труба стальная 20');`

describe('Кабинет подрядчика: счета снабжения к взятым ценам, прошлые цены — база Яндекса (копия прода)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`, { appName: 'osp-test' })
  const docs = (uid, extra = '') => as(uid, `select coalesce(string_agg(file_name, ';' order by file_name), '') from public.bid_supply_docs('${T.open}'${extra})`)
  const fileOf = (uid, doc) => as(uid, `select coalesce(string_agg(s3_key, ';'), '') from public.bid_supply_doc_file('${T.open}', '${doc}')`)
  const take = (uid, names, replace = false) => as(uid, `select public.bid_supply_take('${T.open}', (select jsonb_agg(jsonb_build_object(
      'key', public.supply_norm_name(n), 'unit_key', public.kp_norm_unit(u), 'name', n, 'unit', u, 'volume', 1))
      from (values ${names.map(([n, u]) => `('${n}', '${u}')`).join(', ')}) v(n, u)), ${replace})`)
  const ownPrice = (uid, name, unit, price) => as(uid, `select public.bid_rates_save('${T.open}', jsonb_build_array(jsonb_build_object(
      'kind', 'material', 'key', public.supply_norm_name('${name}'), 'unit_key', public.kp_norm_unit('${unit}'), 'name', '${name}', 'unit', '${unit}',
      'volume', 1, 'price', ${price}, 'source', 'manual')))`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-bid-docs-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 30 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, new RegExp(`OK ${MIG}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(file('yandex', `${MIG}.check.sql`), 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
  })

  it('счета: без разрешения и до «взять» — нет; взята цена снабжения — файлы всех ВОР позиции; адресных ссылок и чужого — нет', () => {
    assert.equal(docs(U.alpha), '', 'разрешения нет')
    assert.equal(as(U.admin, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', true)`), 'granted')
    assert.equal(docs(U.alpha), '', 'цену ещё не брали')
    assert.equal(take(U.alpha, [['Труба стальная 20', 'м'], ['Кран шаровый 20', 'шт'], ['Отвод 20', 'шт']]), '2', 'у крана цены снабжения нет')
    assert.equal(docs(U.alpha), 'КП Стандартпарк № 10067.pdf;Счёт ПСК № 072813.pdf', 'труба — файлы обоих ВОР; отвод — ссылка, кран — без цены')
    assert.equal(docs(U.beta), '', 'без доступа к тендеру — ничего')
    assert.equal(docs(U.admin, `, '${CP.alpha}'`), docs(U.alpha), 'просмотр от имени подрядчика — то же')
    assert.equal(docs(U.admin), '', 'сотруднику без организации — ничего')
    assert.equal(as(U.alpha, `select count(*) from public.s3_documents where doc_category = 'supply_doc'`), '0', 'строки файлов счетов подрядчику закрыты')
  })

  it('файл счёта службе: только файл из списка организации; сотруднику — отказ', () => {
    assert.equal(fileOf(U.alpha, DOC.inv1), 'tenders/s/inv1.pdf')
    assert.equal(fileOf(U.alpha, DOC.inv2), 'tenders/s/inv2.pdf')
    assert.equal(fileOf(U.alpha, DOC.invKran), '', 'счёт крана — цены снабжения у крана нет')
    assert.equal(fileOf(U.alpha, DOC.invOther), '', 'файл другого тендера не к этой позиции')
    assert.equal(fileOf(U.alpha, DOC.ov), '', 'файл ВОР — не счёт')
    assert.equal(fileOf(U.beta, DOC.inv1), '', 'другая организация')
    assert.throws(() => fileOf(U.admin, DOC.inv1), /только для подрядчика/)
  })

  it('своя цена или другая цена снабжения — счёта нет; снова цена снабжения — счёт снова; запрет и закрытый приём — нет', () => {
    ownPrice(U.alpha, 'Труба стальная 20', 'м', 480)
    assert.equal(docs(U.alpha), '', 'своя цена')
    assert.equal(fileOf(U.alpha, DOC.inv1), '')
    assert.equal(take(U.alpha, [['Труба стальная 20', 'м']], true), '1')
    assert.equal(docs(U.alpha), 'КП Стандартпарк № 10067.pdf;Счёт ПСК № 072813.pdf')

    internal(`update public.tender_vor_supply_rates set supply_price = 520 where tender_id = '${T.open}' and material_key = public.supply_norm_name('Труба стальная 20')`)
    assert.equal(docs(U.alpha), '', 'снабжение сменило цену — у взятой прежней счёта нет')
    internal(`update public.tender_vor_supply_rates set supply_price = 512.40 where tender_id = '${T.open}' and material_key = public.supply_norm_name('Труба стальная 20')`)
    assert.match(docs(U.alpha), /Счёт ПСК/)

    internal(`update public.tenders set status = 'Завершен' where id = '${T.open}'`)
    assert.equal(docs(U.alpha), '', 'приём закрыт')
    assert.equal(fileOf(U.alpha, DOC.inv1), '')
    internal(`update public.tenders set status = 'Идет тендерная процедура' where id = '${T.open}'`)

    assert.equal(as(U.admin, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', false)`), 'denied')
    assert.equal(docs(U.alpha), '', 'запрет отдела')
    assert.equal(fileOf(U.alpha, DOC.inv1), '')
  })

  it('учётка с регистрации по заявке: с разрешением — счета к взятой цене, как у остальных', () => {
    assert.equal(as(U.admin, `select public.bid_supply_decide('${T.open}', '${CP.self}', true)`), 'granted')
    assert.equal(take(U.self, [['Труба стальная 20', 'м']]), '1')
    assert.equal(docs(U.self), 'КП Стандартпарк № 10067.pdf;Счёт ПСК № 072813.pdf')
    assert.equal(fileOf(U.self, DOC.inv1), 'tenders/s/inv1.pdf')
  })

  it('прошлые цены: последняя своя по присланным позициям, без цен снабжения, этого тендера и чужих', () => {
    const keys = `array['material|' || public.supply_norm_name('Труба стальная 20') || '|' || public.kp_norm_unit('м'),
      'material|' || public.supply_norm_name('Отвод 20') || '|' || public.kp_norm_unit('шт'), 'мусор']`
    const hist = (uid) => as(uid, `select coalesce(string_agg(item_key || '=' || price, ';'), '') from public.bid_rate_history('${T.open}', ${keys})`)
    assert.match(hist(U.alpha), /=700\.00$/, 'труба — последняя своя (700), отвод — взятый у снабжения не идёт, свой тендер — тоже')
    assert.equal(hist(U.alpha).split(';').length, 1)
    assert.match(hist(U.beta), /=999\.00$/, 'у другой организации — её цена')
    assert.equal(hist(U.admin), '', 'сотруднику — пусто')
  })

  it('откат: функций нет; повтор безопасен', () => {
    for (let i = 0; i < 2; i++) db.sql(null, { file: file('rollback', `${MIG}_rollback.sql`) })
    assert.equal(internal(`select count(*) from pg_proc where proname in ('bid_supply_docs', 'bid_supply_doc_file', 'bid_rate_history',
      'bid_supply_doc_rows', 'bid_supply_docs_cp')`), '0')
    assert.match(as(U.alpha, `select count(*) from public.bid_supply_prices('${T.open}')`), /^\d+$/, 'цены снабжения (20270301) на месте')
  })
})
