// Подрядчик, зарегистрировавшийся на сайте: что он может в самой базе (миграции 20261203, 20261204). Копия прода под одной учёткой,
// настоящие правила и функции: второй замок на случай ошибки в списке шлюза. Здесь — полный обход всех таблиц и представлений:
// появится новая таблица, правило которой отдаёт строки любому вошедшему, — тест упадёт.
//   • учётка, привязанная к компании из реестра: договоры, смета, файлы, КП и согласование этой компании ей не видны;
//   • bid_positions: только при доступе к тендеру; bid_rates_save: только позиции ВОР, значения — из разбора;
//   • реестр расценок: цены компании с регистрации — только участника тендера;
//   • ЧС блокирует учётку; служба разбора ВОР: настоящий разбор в отдельном процессе, файл не разбирается заново.
// Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = skipReason({ needCopy: true }) || (fs.existsSync(path.join(SERVER, 'node_modules', 'pg')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api')
const id = (n) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`
const U = { admin: id(1), self: id(2), bound: id(3), managed: id(4), foreign: id(5) }
const CP = { self: id(11), old: id(12), foreign: id(13) }
const OBJ = id(21)
const T = { open: id(31), foreign: id(32), done: id(33), doneMember: id(34), rejected: id(35) }
const C = { old: id(41) }
const ITEM = { old: id(51) }
const DOC = { vor: id(61), vorBad: id(62), contract: id(63), pack: id(64) }
const KEY = { concrete: 'material|бетон в25|м3' }
const POSITIONS = [
  { kind: 'material', key: KEY.concrete, itemKey: 'бетон в25', unitKey: 'м3', name: 'Бетон В25', unit: 'м3', volume: 100.5, rows: 1 },
  { kind: 'work', key: 'work|устройство плиты|м3', itemKey: 'устройство плиты', unitKey: 'м3', name: 'Устройство плиты', unit: 'м3', volume: 100.5, rows: 1 },
]
// Что учётке с регистрации разрешено видеть. Остальное — ни строки.
const SELF_ROWS = new Set(['user_roles', 'bid_form_fields', 'tender_bid_requests', 'tender_bid_rates', 'tender_bid_forms'])
// Правило базы отдаёт любому вошедшему, но это не данные портала: справочник ролей и публичная витрина. Для учётки с регистрации
// их закрывает ещё и список шлюза (кроме витрины — она открыта и без входа).
const OPEN_TO_EVERYONE = new Set(['roles', 'role_permissions', 'public_open_tenders'])

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.self}', '${U.bound}', '${U.managed}', '${U.foreign}']::uuid[]) u;
  insert into public.counterparties (id, name, inn, notes, registered_via) values
    ('${CP.self}', 'ООО С сайта', '7707083893', null, 'self'),
    ('${CP.old}', 'ООО Старый', '7736050003', 'служебное примечание отдела', null),
    ('${CP.foreign}', 'ООО Чужой', '7702070139', null, null);
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, work_phone, email, counterparty_id, self_registered) values
    ('${U.admin}', 'admin', true, false, 'Админов', null, 'admin@example.invalid', null, false),
    ('${U.self}', 'contractor', true, false, 'Сайтов', '+79160000001', 'self@example.invalid', '${CP.self}', true),
    ('${U.bound}', 'contractor', true, false, 'Привязанный', '+79160000002', 'bound@example.invalid', '${CP.old}', true),
    ('${U.managed}', 'contractor', true, false, 'От администратора', null, 'managed@example.invalid', '${CP.old}', false),
    ('${U.foreign}', 'contractor', true, false, 'Чужой', null, 'foreign@example.invalid', '${CP.foreign}', false);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Изоляция', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number, cost_plan_link, notes) values
    ('${T.open}', 'Открытый', '${OBJ}', 'Идет тендерная процедура', 9921, 'https://example.invalid/plan', 'служебное'),
    ('${T.foreign}', 'Открытый, чужая заявка', '${OBJ}', 'Идет тендерная процедура', 9922, null, null),
    ('${T.done}', 'Завершённый', '${OBJ}', 'Завершен', 9923, null, null),
    ('${T.doneMember}', 'Завершённый, участник', '${OBJ}', 'Завершен', 9924, null, null),
    ('${T.rejected}', 'Заявку отклонили', '${OBJ}', 'Идет тендерная процедура', 9925, null, null);
  insert into public.tender_counterparties (tender_id, counterparty_id, status, notes) values
    ('${T.open}', '${CP.old}', 'request_sent', 'служебное примечание'),
    ('${T.doneMember}', '${CP.self}', 'proposal_provided', null);
  insert into public.tender_bid_requests (tender_id, counterparty_id, status, decided_by_name) values
    ('${T.rejected}', '${CP.self}', 'rejected', 'Инженеров И. И.');
  insert into public.tender_estimate_items (id, tender_id, row_number, cost_name, unit) values ('${ITEM.old}', '${T.open}', 1, 'Смета', 'м3');
  insert into public.tender_counterparty_proposals (tender_id, counterparty_id, estimate_item_id, unit_price_materials) values ('${T.open}', '${CP.old}', '${ITEM.old}', 50);
  insert into public.contracts (id, contract_number, contract_date, object_id, counterparty_id, contract_amount, notes) values
    ('${C.old}', 'ДП-77', '2026-09-01', '${OBJ}', '${CP.old}', 1000, 'служебное');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
    ('${DOC.vor}', 'tender', '${T.open}', 'tenders/open/vor.xlsx', 'ВОР паркинга.xlsx', 'vor_statement'),
    ('${DOC.pack}', 'tender', '${T.open}', 'tenders/open/pack.zip', 'Пакет.zip', 'tender_package'),
    ('${DOC.contract}', 'contract', '${C.old}', 'contracts/old/dp.pdf', 'ДП.pdf', 'general');
  insert into osp_private.bid_vor_files (s3_document_id, tender_id, source_version, status, positions, structure, conditions) values
    ('${DOC.vor}', '${T.open}', 'bid:1', 'ok', '${JSON.stringify(POSITIONS)}'::jsonb, '[{"type":"section","name":"Плита"}]'::jsonb, '["ГУ 5 %"]'::jsonb);`

describe('Учётка с регистрации на сайте: база (копия прода под одной учёткой)', { skip, timeout: 1800000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const sql = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`)
  const relations = () => sql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') and not c.relispartition order by 1`).split('\n').filter(Boolean)
  const count = (uid, rel) => {
    try {
      return Number(as(uid, `select count(*) from public."${rel}"`))
    } catch {
      return 0 // отказ — тоже «не видно»
    }
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-self-access-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 25 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, /OK 20261203_contractor_signup: применена/)
    assert.match(res.stdout, /OK 20261204_contractor_self_access: применена/)
    assert.match(res.stdout, /OK 20261226_contractor_org_card_vor_file: применена/)
    assert.match(res.stdout, /OK 20261229_signup_phone_ext: применена/)
    sql(SEED)
    as(U.self, `select public.bid_request('${T.open}')`)
    sql(`insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total) values
      ('${T.done}', '${CP.self}', 'material', 'цена не участника', 'м3', 'Цена не участника', 'м3', 1, 111, 111),
      ('${T.doneMember}', '${CP.self}', 'material', 'цена участника', 'м3', 'Цена участника', 'м3', 1, 222, 222),
      ('${T.done}', '${CP.old}', 'material', 'цена компании из реестра', 'м3', 'Цена компании из реестра', 'м3', 1, 333, 333);`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('полный обход: ни одна таблица и представление портала не отдают учётке с регистрации лишнего', () => {
    const rels = relations()
    assert.ok(rels.length > 100, `таблиц: ${rels.length}`)
    const seen = (uid) => rels.filter((r) => count(uid, r) > 0)
    for (const [who, uid] of [['новая компания', U.self], ['компания из реестра', U.bound]]) {
      const extra = seen(uid).filter((r) => !SELF_ROWS.has(r) && !OPEN_TO_EVERYONE.has(r))
      assert.deepEqual(extra, [], `${who}: видны лишние строки`)
    }
    // Проверка рабочая: подрядчик от администратора той же компании видит своё.
    const managed = seen(U.managed)
    for (const r of ['tender_estimate_items', 'tender_counterparty_proposals', 's3_documents']) assert.ok(managed.includes(r), `подрядчик от администратора: ${r}`)
  })

  it('своё — только своё: чужие цены, заявки, анкеты и строка ролей не видны', () => {
    sql(`insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, unit_key, name, volume, price, total) values
      ('${T.open}', '${CP.foreign}', 'material', 'чужая', 'м3', 'Чужая цена', 1, 1, 1);
      insert into public.tender_bid_forms (tender_id, counterparty_id, answers) values ('${T.open}', '${CP.foreign}', '{"x":{"label":"a","value":"чужая анкета"}}');`)
    assert.equal(as(U.self, `select count(*) from public.tender_bid_rates where counterparty_id = '${CP.foreign}'`), '0')
    assert.equal(as(U.self, `select count(*) from public.tender_bid_forms where counterparty_id = '${CP.foreign}'`), '0')
    assert.equal(as(U.self, `select count(*) from public.tender_bid_requests where counterparty_id <> '${CP.self}'`), '0')
    assert.equal(as(U.self, 'select count(*) from public.user_roles'), '1', 'только своя строка ролей')
    assert.equal(as(U.self, 'select count(*) from public.employee_directory'), '0', 'сотрудников нет')
  })

  it('запись напрямую закрыта: роль, организация, цены, контрагент', () => {
    const before = sql(`select role || ':' || counterparty_id || ':' || self_registered from public.user_roles where user_id = '${U.self}'`)
    for (const patch of [`role = 'admin'`, `self_registered = false`, `counterparty_id = '${CP.old}'`]) {
      assert.equal(as(U.self, `update public.user_roles set ${patch} where user_id = '${U.self}' returning id`), '', patch)
    }
    assert.equal(sql(`select role || ':' || counterparty_id || ':' || self_registered from public.user_roles where user_id = '${U.self}'`), before)
    assert.throws(() => as(U.self, `insert into public.tender_bid_rates (tender_id, counterparty_id, kind, item_key, name, price) values ('${T.open}', '${CP.self}', 'work', 'x', 'x', 1)`), /row-level security/)
    assert.equal(as(U.self, `update public.counterparties set status = 'active', notes = 'x' where id = '${CP.self}' returning id`), '')
    assert.throws(() => sql(`update public.user_roles set role = 'engineer' where user_id = '${U.self}'`), /user_roles_self_registered_contractor/)
  })

  it('договоры, отметка участия, идентификатор старых правил: учётка с регистрации, даже привязанная к компании, — нет', () => {
    assert.throws(() => as(U.bound, 'select * from public.contractor_contracts()'), /только для подрядчика/)
    assert.throws(() => as(U.bound, `select public.contractor_set_participation('${T.open}', 'declined')`), /ставит подрядчик/)
    assert.equal(as(U.bound, 'select public.current_counterparty_id()'), '')
    assert.equal(as(U.bound, `select public.is_my_tender('${T.open}')`), 'f')
    assert.equal(as(U.bound, `select public.is_my_contract('${C.old}')`), 'f')
    assert.equal(as(U.bound, 'select count(*) from public.contract_clauses'), '0')
    // Подрядчик от администратора той же компании — как раньше.
    assert.match(as(U.managed, 'select count(*) from public.contractor_contracts()'), /^[1-9]/)
    assert.equal(as(U.managed, `select public.is_my_contract('${C.old}')`), 't')
    assert.equal(as(U.managed, 'select public.current_counterparty_id()'), CP.old)
    assert.equal(as(U.admin, 'select public.osp_self_registered()'), 'f')
  })

  it('список тендеров и карточка компании: только перечисленные поля, без внутренних', () => {
    const list = JSON.parse(as(U.self, 'select json_agg(t) from public.bid_contractor_tenders() t'))
    const open = list.find((t) => t.id === T.open)
    assert.equal(open.access, 'pending')
    assert.ok(!('cost_plan_link' in open) && !('notes' in open))
    assert.equal(list.find((t) => t.id === T.foreign).access, null)
    // Только идущие: завершённый тендер, где компания была участником, не виден ни в списке, ни в позициях.
    assert.ok(!list.some((t) => t.id === T.doneMember || t.id === T.done), 'завершённых нет')
    assert.equal(as(U.self, `select count(*) from public.bid_positions('${T.doneMember}')`), '0')
    assert.ok(JSON.parse(as(U.managed, 'select json_agg(t) from public.bid_contractor_tenders() t')).length > 0)

    const card = JSON.parse(as(U.bound, 'select row_to_json(c) from public.contractor_org_card() c'))
    assert.deepEqual(Object.keys(card).sort(), ['actual_address', 'contact_email', 'contact_name', 'contact_phone', 'contacts', 'counterparty_number', 'inn', 'kpp', 'legal_address', 'name', 'vat_exempt', 'vat_rate', 'website', 'work_type'])
    assert.ok(Number.isInteger(card.counterparty_number) && card.counterparty_number > 0, 'номер контрагента на сайте')
    assert.ok(Array.isArray(card.contacts))
    assert.equal(card.name, 'ООО Старый')
    assert.equal(card.contact_phone, '+79160000002')
    assert.ok(!JSON.stringify(card).includes('служебное'), 'примечание отдела не приходит')
  })

  it('файл ВОР: только Excel идущего тендера при доступе организации; остальное — пусто; без организации — отказ', () => {
    const file = (user, id) => as(user, `select coalesce(json_agg(f), '[]') from public.bid_vor_file('${id}') f`)
    const FILE = { vor: '018f2a10-0000-7000-8000-00000000f001', pdf: '018f2a10-0000-7000-8000-00000000f002', pack: '018f2a10-0000-7000-8000-00000000f003',
      foreign: '018f2a10-0000-7000-8000-00000000f004', rejected: '018f2a10-0000-7000-8000-00000000f005', done: '018f2a10-0000-7000-8000-00000000f006' }
    sql(`insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
      ('${FILE.vor}', 'tender', '${T.open}', 'tenders/open/vor-a.xlsx', 'ВОР А.xlsx', 'vor_statement'),
      ('${FILE.pdf}', 'tender', '${T.open}', 'tenders/open/rd.pdf', 'РД.pdf', 'vor'),
      ('${FILE.pack}', 'tender', '${T.open}', 'tenders/open/pack.xlsx', 'Пакет.xlsx', 'tender_package'),
      ('${FILE.foreign}', 'tender', '${T.foreign}', 'tenders/foreign/vor.xlsx', 'Чужой.xlsx', 'vor_statement'),
      ('${FILE.rejected}', 'tender', '${T.rejected}', 'tenders/rejected/vor.xlsx', 'Отклонён.xlsx', 'vor_statement'),
      ('${FILE.done}', 'tender', '${T.doneMember}', 'tenders/done/vor.xlsx', 'Завершён.xlsx', 'vor_statement')`)
    try {
      assert.deepEqual(JSON.parse(file(U.self, FILE.vor)), [{ s3_key: 'tenders/open/vor-a.xlsx', file_name: 'ВОР А.xlsx' }])
      for (const [what, id] of [['не Excel', FILE.pdf], ['пакет, не ВОР', FILE.pack], ['нет заявки', FILE.foreign], ['заявка отклонена', FILE.rejected], ['тендер завершён', FILE.done]]) {
        assert.deepEqual(JSON.parse(file(U.self, id)), [], what)
      }
      assert.throws(() => file(U.admin, FILE.vor), /только для подрядчика/, 'у администратора организации нет')
    } finally {
      sql(`delete from public.s3_documents where id in (${Object.values(FILE).map((id) => `'${id}'`).join(', ')})`)
    }
  })

  it('позиции ВОР: только при доступе к тендеру; файл не отдаётся; отклонённому — ничего', () => {
    const rows = JSON.parse(as(U.self, `select json_agg(p) from public.bid_positions('${T.open}') p`))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'ВОР паркинга')
    assert.equal(rows[0].status, 'ok')
    assert.equal(rows[0].positions.length, 2)
    assert.deepEqual(rows[0].conditions, ['ГУ 5 %'])
    assert.ok(!JSON.stringify(rows[0]).includes('s3_key') && !JSON.stringify(rows[0]).includes('tenders/open'), 'пути к файлу нет')
    assert.throws(() => as(U.self, `select * from public.bid_positions('${T.foreign}')`), /подайте заявку/)
    assert.equal(as(U.self, `select count(*) from public.bid_positions('${T.rejected}')`), '0')
    assert.throws(() => as(U.admin, `select * from public.bid_positions('${T.open}')`), /только для подрядчика/)
    // Новый файл, который служба ещё не разобрала, виден как «готовится», файлы других категорий — нет.
    sql(`insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values ('${DOC.vorBad}', 'tender', '${T.open}', 'tenders/open/new.xlsx', 'Новый ВОР.xlsx', 'vor')`)
    const titles = JSON.parse(as(U.self, `select json_agg(json_build_object('t', p.title, 's', p.status)) from public.bid_positions('${T.open}') p`))
    assert.deepEqual(titles.map((x) => `${x.t}:${x.s}`).sort(), ['ВОР паркинга:ok', 'Новый ВОР:pending'])
    sql(`delete from public.s3_documents where id = '${DOC.vorBad}'`)
  })

  it('цены учётки с регистрации: только позиции ВОР, значения из разбора; итог не подделать', () => {
    const save = (rows) => as(U.self, `select public.bid_rates_save('${T.open}', '${JSON.stringify(rows).replace(/'/g, "''")}'::jsonb)`)
    assert.throws(() => save([{ kind: 'material', key: 'выдуманная позиция', unit_key: 'м3', name: 'Выдуманная', unit: 'м3', volume: 1, price: 1 }]), /Позиции нет в ВОР/)
    assert.equal(save([{ kind: 'material', key: 'бетон в25', unit_key: 'м3', name: 'Кирпич из запроса', unit: 'кг', volume: 999999, price: 10 }]), '1')
    const row = JSON.parse(as(U.self, `select row_to_json(r) from public.tender_bid_rates r where tender_id = '${T.open}' and item_key = 'бетон в25'`))
    assert.equal(row.name, 'Бетон В25', 'наименование — из разбора')
    assert.equal(row.unit, 'м3')
    assert.equal(Number(row.volume), 100.5, 'объём — из разбора')
    assert.equal(Number(row.total), 1005, 'итог считает база по объёму из разбора')
    assert.equal(row.counterparty_id, CP.self, 'организацию из запроса не выбрать')
    assert.equal(save([{ kind: 'material', key: 'бетон в25', unit_key: 'м3', name: 'x', price: null, note: null }]), '1')
    assert.equal(as(U.self, `select count(*) from public.tender_bid_rates where tender_id = '${T.open}' and item_key = 'бетон в25'`), '0', 'свою цену убрать можно')
    // Подрядчик от администратора — прежний путь, с позициями из браузера.
    assert.equal(as(U.managed, `select public.bid_rates_save('${T.open}', '[{"kind":"work","key":"своя","unit_key":"","name":"Своя","price":5,"volume":2}]'::jsonb)`), '1')
    // Закрытый тендер.
    assert.throws(() => as(U.self, `select public.bid_rates_save('${T.done}', '[]'::jsonb)`), /закрыта/)
  })

  it('реестр расценок: цены компании с регистрации — только участника тендера', () => {
    sql('select public.refresh_rates_registry()')
    const names = sql(`select item_name from osp_private.kp_rates_registry_mv where source_kind = 'site' and tender_id in ('${T.done}', '${T.doneMember}') order by 1`).split('\n')
    assert.deepEqual(names, ['Цена компании из реестра', 'Цена участника'])
  })

  it('чёрный список: все учётки организации заблокированы сразу', () => {
    sql(`update public.counterparties set status = 'blacklist' where id = '${CP.old}'`)
    for (const u of [U.bound, U.managed]) {
      assert.equal(sql(`select is_blocked::text || ':' || is_approved::text from public.user_roles where user_id = '${u}'`), 'true:false', u)
    }
    assert.equal(sql(`select is_blocked from public.user_roles where user_id = '${U.self}'`), 'f', 'чужая организация не задета')
    assert.throws(() => as(U.bound, `select * from public.bid_positions('${T.open}')`), /только для подрядчика/)
    sql(`update public.counterparties set status = 'active' where id = '${CP.old}'`)
  })

  it('служба разбора ВОР: настоящий разбор в отдельном процессе; лишнее не хранится; файл не разбирается заново', async () => {
    const { createBidPositions, BID_PARSER_VERSION } = await import(path.join(SERVER, 'src', 'lib', 'bidPositions.js'))
    const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
    const pool = createDb({ url: db.url, max: 2, logger: { warn() {}, error() {}, info() {} } })
    try {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Особые условия, которые'], ['ГУ 5 %']]), 'Главный лист')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['№ п/п', 'Наименование', 'Ед. изм.', 'Объём'], [1, 'Кирпич', 'шт', 10]]), 'Материалы')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['№ п/п', 'Наименование', 'Ед. изм.', 'Объём'], [1, 'Кладка', 'м3', 5]]), 'Работы')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['секретная себестоимость'], [123456]]), 'Служебный')
      const good = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const files = {
        'tenders/job/good.xlsx': good,
        'tenders/job/bad.xlsx': Buffer.from('это не книга Excel'),
      }
      const gets = []
      const s3 = { send: async (cmd) => {
        const key = cmd.input.Key
        if (!files[key]) throw Object.assign(new Error('no'), { name: 'NoSuchKey' })
        if (cmd.constructor.name === 'HeadObjectCommand') return { ContentLength: files[key].length }
        gets.push(key)
        return { Body: { transformToByteArray: async () => new Uint8Array(files[key]) } }
      } }
      const a = id(71)
      const b = id(72)
      const c = id(73)
      sql(`insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
        ('${a}', 'tender', '${T.foreign}', 'tenders/job/good.xlsx', 'Хороший.xlsx', 'vor_statement'),
        ('${b}', 'tender', '${T.foreign}', 'tenders/job/bad.xlsx', 'Плохой.xlsx', 'vor'),
        ('${c}', 'tender', '${T.foreign}', 'tenders/job/gone.xlsx', 'Пропавший.xls', 'vor');`)
      // На копии прода есть и настоящие файлы идущих тендеров (их в этом хранилище нет): проход не ограничиваем, чтобы дойти до своих.
      const job = createBidPositions({ db: pool, s3, bucket: 'osp', log: { info() {}, warn() {} }, options: { maxFilesPerRun: 100_000 } })
      const first = await job.runOnce()
      assert.ok(first.ok >= 1 && first.failed >= 2, JSON.stringify(first))
      const stored = JSON.parse(sql(`select row_to_json(f) from osp_private.bid_vor_files f where s3_document_id = '${a}'`))
      assert.equal(stored.status, 'ok')
      assert.equal(stored.source_version, BID_PARSER_VERSION)
      assert.deepEqual(stored.positions.map((p) => `${p.kind}:${p.name}:${p.volume}`).sort(), ['material:Кирпич:10', 'work:Кладка:5'])
      assert.deepEqual(stored.conditions, ['ГУ 5 %'])
      assert.ok(!JSON.stringify(stored).includes('себестоимость') && !JSON.stringify(stored).includes('123456'), 'скрытый лист в базу не попал')
      assert.equal(sql(`select status || ':' || error from osp_private.bid_vor_files where s3_document_id = '${c}'`), 'error:missing')
      assert.match(sql(`select status from osp_private.bid_vor_files where s3_document_id = '${b}'`), /error/)
      gets.length = 0
      await job.runOnce()
      assert.equal(gets.length, 0, 'разобранный и неразборный файлы заново не скачиваются')
      // Удалили файл — разбор уходит вместе с ним.
      sql(`delete from public.s3_documents where id in ('${a}', '${b}', '${c}')`)
      assert.equal(sql(`select count(*) from osp_private.bid_vor_files where s3_document_id in ('${a}', '${b}', '${c}')`), '0')
    } finally {
      await pool.close()
    }
  })
})
