// Кабинет подрядчика, просьба пользователя 24.11.2026 — копия прода под одной учёткой, настоящий migrate.sh с проверкой прав
// (миграция 20270301_bid_site_pricing):
//   • цены снабжения: подрядчик просит, инженер с правом правки «Тендеров» разрешает; цены отдаются только с разрешением, пока идёт
//     приём, без ВОР и документов, и только если цена одна во всех ВОР; без доступа к тендеру, без разрешения, после запрета — ничего;
//   • «взять цену снабжения» — цену берёт база, отметка «supply»; сохранение цен её не ставит; своя цена заменяется только по просьбе;
//   • позиции сверяются с разбором ВОР и у подрядчика от администратора (наименование и объём — из ВОР, а не из запроса);
//   • что изменилось в ВОР: прежняя версия по отметке снабжения, удалённый файл — из архива, тот же файл заново — по имени;
//   • граница: файлы по заявке — пока идёт приём; заблокированная учётка — без организации;
//   • реестр КП: без цен снабжения и без отклонённых заявок;
//   • откат: функций нет, таблицы и строки на месте; повтор безопасен.
// Страница — contractor-cabinet.test.mjs (стенд supply=1, vorChanges=1). Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const MIG = '20270301_bid_site_pricing'
const file = (dir, name) => path.join(ROOT, 'migration', dir, name)
const id = (n) => `00000000-0000-4000-8000-0000002${String(n).padStart(5, '0')}`
const U = { admin: id(1), alpha: id(2), beta: id(3), lawyer: id(4), self: id(5) }
const CP = { alpha: id(11), beta: id(12), self: id(13) }
const OBJ = id(21)
const T = { open: id(31), other: id(32), done: id(33) }
const DOC = { v1: id(41), v2: id(42), vk: id(43), other: id(44), done: id(45) }

// Позиция разбора службы (как bidVor.js): ключ — вид | normName | normUnit (в базе — supply_norm_name / kp_norm_unit).
const pos = (kind, name, unit, volume) => `jsonb_build_object('kind', '${kind}', 'key', '${kind}|' || public.supply_norm_name('${name}') || '|' || public.kp_norm_unit('${unit}'),
  'itemKey', public.supply_norm_name('${name}'), 'unitKey', public.kp_norm_unit('${unit}'), 'name', '${name}', 'unit', '${unit}', 'volume', ${volume}, 'rows', 1)`
const parsed = (doc, tender, list) => `insert into osp_private.bid_vor_files (s3_document_id, tender_id, source_version, status, positions)
  values ('${doc}', '${tender}', 'bid:1', 'ok', jsonb_build_array(${list.join(', ')}));`

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.alpha}', '${U.beta}', '${U.lawyer}', '${U.self}']::uuid[]) u;
  insert into public.counterparties (id, name, inn) values ('${CP.alpha}', 'ООО Альфа Цены', '7707083893'),
    ('${CP.beta}', 'ООО Бета Цены', '7736050003'), ('${CP.self}', 'ООО Сайт Цены', '7710140679');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, self_registered) values
    ('${U.admin}', 'admin', true, false, 'Админов', 'admin@example.invalid', null, false),
    ('${U.alpha}', 'contractor', true, false, 'Альфин А. А.', 'alpha@example.invalid', '${CP.alpha}', false),
    ('${U.beta}', 'contractor', true, false, 'Бетин Б. Б.', 'beta@example.invalid', '${CP.beta}', false),
    ('${U.lawyer}', 'lawyer', true, false, 'Юристов', 'lawyer@example.invalid', null, false),
    ('${U.self}', 'contractor', true, false, 'Сайтов С. С.', 'self@example.invalid', '${CP.self}', true);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Цены', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
    ('${T.open}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура', 99901),
    ('${T.other}', 'Открытый, по заявке', '${OBJ}', 'Идет тендерная процедура', 99902),
    ('${T.done}', 'Завершённый', '${OBJ}', 'Идет тендерная процедура', 99903);
  insert into public.tender_counterparties (tender_id, counterparty_id, status) values
    ('${T.open}', '${CP.alpha}', 'request_sent'), ('${T.done}', '${CP.alpha}', 'proposal_provided');
  insert into public.tender_bid_requests (tender_id, counterparty_id, status) values ('${T.open}', '${CP.self}', 'pending');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at) values
    ('${DOC.v1}', 'tender', '${T.open}', 'tenders/p/ov1.xlsx', 'ВОР ОВ.xlsx', 'vor_statement', now() - interval '20 days'),
    ('${DOC.v2}', 'tender', '${T.open}', 'tenders/p/ov2.xlsx', 'ВОР ОВ изм.1.xlsx', 'vor_statement', now() - interval '5 days'),
    ('${DOC.vk}', 'tender', '${T.open}', 'tenders/p/vk.xlsx', 'ВОР ВК.xlsx', 'vor', now() - interval '10 days'),
    ('${DOC.other}', 'tender', '${T.other}', 'tenders/p/other.xlsx', 'ВОР.xlsx', 'vor_statement', now() - interval '10 days'),
    ('${DOC.done}', 'tender', '${T.done}', 'tenders/p/done.xlsx', 'ВОР.xlsx', 'vor_statement', now() - interval '30 days');
  ${parsed(DOC.v1, T.open, [pos('material', 'Труба стальная 20', 'м', 100), pos('material', 'Кран шаровый 20', 'шт', 10), pos('work', 'Монтаж трубы', 'м', 100), pos('work', 'Убранная работа', 'шт', 3)])}
  ${parsed(DOC.v2, T.open, [pos('material', 'Труба стальная 20', 'м', 120), pos('material', 'Кран шаровый 20', 'шт', 10), pos('work', 'Монтаж трубы', 'м', 120), pos('work', 'Новая работа', 'шт', 2)])}
  ${parsed(DOC.vk, T.open, [pos('material', 'Труба стальная 20', 'м', 30), pos('material', 'Кран шаровый 20', 'шт', 4), pos('material', 'Без цены', 'шт', 1)])}
  ${parsed(DOC.other, T.other, [pos('work', 'Работа', 'шт', 1)])}
  ${parsed(DOC.done, T.done, [pos('material', 'Труба стальная 20', 'м', 5)])}
  -- Снабжение: ВОР ОВ был из первого файла, его заменили «изм.1» — первый ушёл в prior_document_ids (триггер 20261029).
  insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, positions)
    values ('${T.open}', 'ВОР ОВ', 'vor_file', '${DOC.v1}', 'ВОР ОВ.xlsx', '[{"name": "Труба стальная 20", "unit": "м", "volume": 100}]'::jsonb),
           ('${T.open}', 'ВОР ВК', 'vor_file', '${DOC.vk}', 'ВОР ВК.xlsx', '[{"name": "Труба стальная 20", "unit": "м", "volume": 30}]'::jsonb);
  update public.tender_supply_sources set s3_document_id = '${DOC.v2}', file_name = 'ВОР ОВ изм.1.xlsx'
    where tender_id = '${T.open}' and estimate_name = 'ВОР ОВ';
  -- Цены снабжения: труба — одна во всех ВОР (берётся), кран — разная (не берётся); цена ВОР без списка позиций не участвует.
  insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price) values
    ('${T.open}', 'ВОР ОВ', 'Труба стальная 20', 'м', 512.40), ('${T.open}', 'ВОР ВК', 'Труба стальная 20', 'м.', 512.40),
    ('${T.open}', 'ВОР ОВ', 'Кран шаровый 20', 'шт', 900), ('${T.open}', 'ВОР ВК', 'Кран шаровый 20', 'шт', 950),
    ('${T.open}', 'ВОР старый', 'Без цены', 'шт', 1);`

describe('Кабинет подрядчика: цены снабжения, изменения ВОР, граница — база Яндекса (копия прода)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`, { appName: 'osp-test' })
  const rate = (cp, name) => internal(`select coalesce(price::text, '-') || '|' || source || '|' || name || '|' || coalesce(volume::text, '-')
    from public.tender_bid_rates where tender_id = '${T.open}' and counterparty_id = '${cp}' and item_key = public.supply_norm_name('${name}')`)
  const take = (uid, names, replace = false) => as(uid, `select public.bid_supply_take('${T.open}', (select jsonb_agg(jsonb_build_object(
      'key', public.supply_norm_name(n), 'unit_key', public.kp_norm_unit(u), 'name', 'подмена ' || n, 'unit', u, 'volume', 1))
      from (values ${names.map(([n, u]) => `('${n}', '${u}')`).join(', ')}) v(n, u)), ${replace})`)
  const save = (uid, rows) => as(uid, `select public.bid_rates_save('${T.open}', (select jsonb_agg(jsonb_build_object(
      'kind', k, 'key', public.supply_norm_name(n), 'unit_key', public.kp_norm_unit(u), 'name', nm, 'unit', u, 'volume', 1, 'price', p, 'source', s))
      from (values ${rows.map(([k, n, u, nm, p, s]) => `('${k}', '${n}', '${u}', '${nm}', ${p}::numeric, '${s}')`).join(', ')}) v(k, n, u, nm, p, s)))`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-bid-site-'))
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
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 9, out)
  })

  it('цены снабжения: без разрешения — ничего; просьба → разрешение инженера → только цена, одна во всех ВОР; запрет — снова ничего', () => {
    const prices = (uid, extra = '') => as(uid, `select coalesce(string_agg(item_key || '|' || unit_key || '=' || price, ';' order by item_key), '')
      from public.bid_supply_prices('${T.open}'${extra})`)
    assert.equal(prices(U.alpha), '', 'разрешения нет')
    assert.throws(() => as(U.alpha, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', true)`), /решает инженер ОСП/)
    assert.equal(as(U.alpha, `select public.bid_supply_request('${T.open}')`), 'requested')
    assert.equal(as(U.alpha, `select public.bid_supply_request('${T.open}')`), 'requested', 'повтор — та же просьба')
    assert.throws(() => as(U.beta, `select public.bid_supply_request('${T.open}')`), /закрыт или заявка не подана/, 'без доступа к тендеру')
    assert.throws(() => as(U.lawyer, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', true)`), /решает инженер ОСП/)
    assert.throws(() => as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.beta}', '[]'::jsonb, true)`), /не участвует/)
    assert.equal(as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.alpha}', '[]'::jsonb, true) > 0`), 't')

    const got = prices(U.alpha)
    assert.equal(got.split(';').length, 1, got)
    assert.match(got, /=512\.40$/, 'труба 512,40 (ед. «м» и «м.» — одна); кран с разными ценами и цена ВОР без списка — нет')
    assert.equal(prices(U.beta), '', 'чужая организация — ничего')
    assert.equal(prices(U.admin, `, '${CP.alpha}'`), got, 'просмотр от имени подрядчика — то же')
    assert.equal(prices(U.admin, `, '${CP.beta}'`), '')
    assert.equal(as(U.alpha, `select count(*) from public.tender_vor_supply_rates`), '0', 'сами цены снабжения подрядчику не видны')
  })

  it('по позициям (20270303): открыта только отмеченная позиция; пустой набор — запрет; тендер целиком не разрешить; решает инженер', () => {
    const prices = () => as(U.alpha, `select count(*) from public.bid_supply_prices('${T.open}')`)
    const pipe = `jsonb_build_array(jsonb_build_object('key', public.supply_norm_name('Труба стальная 20'), 'unit_key', public.kp_norm_unit('м')))`
    assert.throws(() => as(U.admin, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', true)`), /по позициям/)
    assert.throws(() => as(U.lawyer, `select count(*) from public.bid_supply_items('${T.open}', '${CP.alpha}')`), /решает инженер ОСП/)
    assert.throws(() => as(U.alpha, `select public.bid_supply_grant('${T.open}', '${CP.alpha}', '[]'::jsonb, true)`), /решает инженер ОСП/)
    assert.equal(as(U.admin, `select string_agg(name || ':' || granted::text, ';') from public.bid_supply_items('${T.open}', '${CP.alpha}')`),
      'Труба стальная 20:true', 'одна позиция с единой ценой снабжения — открыта «все сразу»')
    assert.equal(as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.alpha}', '[{"key": "нет такой", "unit_key": "шт"}]'::jsonb)`), '0',
      'ключ без цены снабжения ничего не открывает')
    assert.equal(prices(), '0', 'набор пуст — цен нет')
    assert.equal(internal(`select status from public.tender_bid_supply_access where tender_id = '${T.open}' and counterparty_id = '${CP.alpha}'`), 'denied')
    assert.equal(as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.alpha}', ${pipe})`), '1')
    assert.equal(prices(), '1')
    assert.equal(as(U.alpha, `select count(*) from public.tender_bid_supply_items`), '0', 'отметки позиций подрядчику напрямую не видны')
    const check = internal(fs.readFileSync(file('yandex', '20270303_bid_supply_items.check.sql'), 'utf8'))
    assert.doesNotMatch(check, /^FAIL/m, check)
  })

  it('взять цену снабжения: цену берёт база, наименование и объём — из ВОР; своя цена — только по просьбе; сохранение отметку не ставит', () => {
    assert.equal(take(U.alpha, [['Труба стальная 20', 'м'], ['Кран шаровый 20', 'шт']]), '1', 'у крана цены нет')
    assert.equal(rate(CP.alpha, 'Труба стальная 20'), '512.40|supply|Труба стальная 20|150.0000', 'объём — ОВ изм.1 + ВК, без прежней версии ОВ')

    // Примечание к той же цене — отметка остаётся; другая цена с отметкой «supply» — своя цена.
    save(U.alpha, [['material', 'Труба стальная 20', 'м', 'Труба стальная 20', 512.40, 'supply']])
    assert.match(rate(CP.alpha, 'Труба стальная 20'), /^512\.40\|supply\|/)
    save(U.alpha, [['material', 'Труба стальная 20', 'м', 'подмена', 480, 'supply']])
    assert.equal(rate(CP.alpha, 'Труба стальная 20'), '480.00|manual|Труба стальная 20|150.0000', 'наименование — из ВОР, не из запроса')
    assert.equal(take(U.alpha, [['Труба стальная 20', 'м']]), '0', 'своя цена без просьбы не заменяется')
    assert.equal(take(U.alpha, [['Труба стальная 20', 'м']], true), '1')
    assert.match(rate(CP.alpha, 'Труба стальная 20'), /^512\.40\|supply\|/)

    assert.throws(() => save(U.alpha, [['work', 'Выдуманная работа', 'шт', 'Выдуманная работа', 1, 'manual']]), /Позиции нет в ВОР/,
      'ведомости разобраны — позицию не выдумать и подрядчику от администратора')
    assert.throws(() => take(U.self, [['Труба стальная 20', 'м']]), /не разрешил/, 'другая организация без разрешения')

    assert.equal(as(U.admin, `select public.bid_supply_decide('${T.open}', '${CP.alpha}', false)`), 'denied')
    assert.throws(() => take(U.alpha, [['Труба стальная 20', 'м']]), /не разрешил/)
    assert.throws(() => as(U.alpha, `select public.bid_supply_request('${T.open}')`), /меньше суток/)
    assert.match(rate(CP.alpha, 'Труба стальная 20'), /^512\.40\|supply\|/, 'взятое раньше остаётся')
  })

  it('инженеру — подрядчики тендера на сайте и их разрешение (без цен); подрядчику — отказ', () => {
    const rows = as(U.admin, `select counterparty_name || ':' || access || ':' || coalesce(status, '-') || ':' || priced || ':' || from_supply
      from public.bid_supply_list(array['${T.open}']::uuid[]) order by counterparty_name`).split('\n')
    assert.deepEqual(rows, ['ООО Альфа Цены:invited:denied:1:1', 'ООО Сайт Цены:pending:-:0:0'])
    assert.throws(() => as(U.alpha, `select * from public.bid_supply_list(array['${T.open}']::uuid[])`), /решает инженер ОСП/)
    assert.equal(as(U.alpha, `select count(*) from public.tender_bid_supply_access`), '1', 'своя строка')
    assert.equal(as(U.self, `select count(*) from public.tender_bid_supply_access`), '0', 'чужую не видно')
    assert.equal(as(U.alpha, `update public.tender_bid_supply_access set status = 'granted' returning 1`), '', 'правка не задела строк')
    assert.equal(internal(`select status from public.tender_bid_supply_access where counterparty_id = '${CP.alpha}'`), 'denied', 'правкой не разрешить')
  })

  it('что изменилось в ВОР: прежняя версия — по отметке снабжения; удалённый файл — из архива; тот же файл заново — по имени', () => {
    const changes = (uid) => as(uid, `select file_id || ':' || tracked || ':' || separate || ':' || valuable || ':' || coalesce(prior_id::text, '-')
      || ':' || coalesce(prior_title, '-') || ':' || coalesce(jsonb_array_length(positions), 0) from public.bid_vor_changes('${T.open}') order by file_id`)
    assert.deepEqual(changes(U.alpha).split('\n'), [`${DOC.v2}:true:false:true:${DOC.v1}:ВОР ОВ:4`, `${DOC.vk}:true:false:true:-:-:0`])
    assert.equal(as(U.beta, `select count(*) from public.bid_vor_changes('${T.open}')`), '0', 'без доступа — ничего')
    assert.equal(changes(U.admin), changes(U.alpha), 'просмотр от имени подрядчика')
    const keys = as(U.alpha, `select string_agg(p ->> 'name', ',' order by p ->> 'name') from public.bid_vor_changes('${T.open}') c,
      jsonb_array_elements(c.positions) p where c.file_id = '${DOC.v2}'`)
    assert.equal(keys, 'Кран шаровый 20,Монтаж трубы,Труба стальная 20,Убранная работа')
    assert.equal(as(U.alpha, `select count(*) from public.bid_vor_changes('${T.open}') c, jsonb_array_elements(c.positions) p
      where p ? 'price' or p ? 'rows'`), '0', 'только то, что нужно для сравнения')

    // Отдел удалил прежний файл — разбор ушёл в архив, прежняя версия на месте.
    internal(`delete from public.s3_documents where id = '${DOC.v1}'`)
    assert.equal(internal(`select title from osp_private.bid_vor_archive where s3_document_id = '${DOC.v1}'`), 'ВОР ОВ')
    assert.match(changes(U.alpha), new RegExp(`${DOC.v2}:true:false:true:${DOC.v1}:ВОР ОВ:4`))

    // ВК удалили и загрузили тот же файл заново — прежняя версия по имени.
    const vk2 = id(46)
    internal(`delete from public.s3_documents where id = '${DOC.vk}';
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values ('${vk2}', 'tender', '${T.open}', 'tenders/p/vk2.xlsx', 'ВОР ВК.xlsx', 'vor');
      ${parsed(vk2, T.open, [pos('material', 'Труба стальная 20', 'м', 35)])}`)
    assert.match(changes(U.alpha), new RegExp(`${vk2}:false:false:false:${DOC.vk}:ВОР ВК:3`))
  })

  it('граница: файлы по заявке — пока идёт приём; заблокированная учётка — без организации', () => {
    as(U.beta, `select public.bid_request('${T.other}')`)
    assert.equal(as(U.beta, `select count(*) from public.s3_documents where owner_id = '${T.other}'`), '1')
    internal(`update public.tenders set status = 'Завершен' where id = '${T.other}'`)
    assert.equal(as(U.beta, `select count(*) from public.s3_documents where owner_id = '${T.other}'`), '0', 'приём закрыт — файлов по заявке нет')
    assert.equal(as(U.alpha, `select count(*) from public.s3_documents where owner_id = '${T.open}'`), '2', 'участнику — ВОР своего тендера')
    assert.equal(as(U.alpha, `select count(*) from public.s3_documents where owner_type = 'contract'`), '0', 'файлов договоров нет')

    // Заблокированная учётка в базе всегда не одобрена (user_roles_blocked_not_approved) — организации у неё нет.
    internal(`update public.user_roles set is_blocked = true, is_approved = false where user_id = '${U.beta}'`)
    assert.equal(as(U.beta, `select coalesce(public.current_counterparty_id()::text, '-')`), '-')
    internal(`update public.user_roles set is_blocked = false, is_approved = true where user_id = '${U.beta}'`)
    assert.equal(as(U.beta, `select public.current_counterparty_id()`), CP.beta)
  })

  it('реестр КП после завершения тендера: без цен снабжения и отклонённых заявок', () => {
    internal(`insert into public.tender_bid_requests (tender_id, counterparty_id, status) values ('${T.done}', '${CP.beta}', 'rejected');
      insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, source) values
        ('${T.done}', '${CP.alpha}', 'material', public.supply_norm_name('Труба стальная 20'), public.kp_norm_unit('м'), 'Труба стальная 20', 'м', 5, 512.40, 2562, 'supply'),
        ('${T.done}', '${CP.alpha}', 'work', public.supply_norm_name('Монтаж трубы'), public.kp_norm_unit('м'), 'Монтаж трубы', 'м', 5, 300, 1500, 'manual'),
        ('${T.done}', '${CP.beta}', 'work', public.supply_norm_name('Монтаж трубы'), public.kp_norm_unit('м'), 'Монтаж трубы', 'м', 5, 1, 5, 'manual');
      update public.tenders set status = 'Завершен' where id = '${T.done}';
      refresh materialized view osp_private.kp_rates_registry_mv;`)
    const rows = internal(`select counterparty_id || ':' || item_name || ':' || price from osp_private.kp_rates_registry_mv
      where tender_id = '${T.done}' and source_kind = 'site'`)
    assert.equal(rows, `${CP.alpha}:Монтаж трубы:300.00`)
  })

  it('закрытый приём и отклонённая заявка: цен снабжения нет, взять нельзя, разрешить нельзя', () => {
    const got = () => as(U.self, `select count(*) from public.bid_supply_prices('${T.open}')`)
    assert.equal(as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.self}', '[]'::jsonb, true) > 0`), 't')
    assert.equal(got(), '1', 'учётка с регистрации по заявке — с разрешением видит цену')
    internal(`update public.tenders set status = 'Завершен' where id = '${T.open}'`)
    assert.equal(got(), '0', 'приём закрыт')
    assert.throws(() => take(U.self, [['Труба стальная 20', 'м']]), /закрыта/)
    internal(`update public.tenders set status = 'Идет тендерная процедура' where id = '${T.open}'`)
    assert.equal(got(), '1')
    internal(`update public.tender_bid_requests set status = 'rejected' where tender_id = '${T.open}' and counterparty_id = '${CP.self}'`)
    assert.equal(got(), '0', 'заявка отклонена')
    assert.throws(() => take(U.self, [['Труба стальная 20', 'м']]), /закрыта/)
    assert.throws(() => as(U.admin, `select public.bid_supply_grant('${T.open}', '${CP.self}', '[]'::jsonb, true)`), /не участвует/)
  })

  it('откат: функций и триггера нет, разрешения, архив и цены на месте; повтор безопасен', () => {
    const before = internal(`select (select count(*) from public.tender_bid_supply_access) || '/' || (select count(*) from osp_private.bid_vor_archive)
      || '/' || (select count(*) from public.tender_bid_rates)`)
    for (let i = 0; i < 2; i++) db.sql(null, { file: file('rollback', `${MIG}_rollback.sql`) })
    assert.equal(internal(`select count(*) from pg_proc where proname in ('bid_supply_prices', 'bid_supply_take', 'bid_vor_changes', 'bid_supply_list',
      'bid_supply_request', 'bid_supply_decide', 'bid_known_positions', 'bid_vor_archive_keep')`), '0')
    assert.equal(internal(`select count(*) from pg_trigger where tgname = 's3_documents_bid_vor_archive'`), '0')
    assert.equal(internal(`select (select count(*) from public.tender_bid_supply_access) || '/' || (select count(*) from osp_private.bid_vor_archive)
      || '/' || (select count(*) from public.tender_bid_rates)`), before)
    assert.match(as(U.alpha, `select count(*) from public.bid_positions('${T.open}')`), /^\d+$/)
    // После отката — прежнее сохранение: позиции подрядчика от администратора не сверяются, отметки «supply» оно не ставит.
    save(U.alpha, [['material', 'Кран шаровый 20', 'шт', 'Кран шаровый 20', 777, 'supply']])
    assert.match(internal(`select source from public.tender_bid_rates where counterparty_id = '${CP.alpha}' and price = 777`), /^manual$/)
    assert.equal(internal(`select count(*) from osp_private.kp_rates_registry_mv where tender_id = '${T.done}' and source_kind = 'site'`), '3',
      'определение реестра 20261204: снова с ценой снабжения и отклонённой заявкой')
  })
})
