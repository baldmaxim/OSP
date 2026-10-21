// Версии ВОР в расценке снабжением (миграция 20261029_supply_vor_versions) — на слепке схемы прода после 20261020–20261025:
// сметный отдел обновил ВОР — цены той же позиции остаются (та же строка), версия записывает, что изменилось, и снимок
// прежних цен; удаление файла, новый ВОР в расценённом тендере; перечитывание тем же разбором — не версия; новая
// версия под другим именем (supply_vor_adopt); перенос цены убранной позиции (supply_rate_carry) с прежним днём
// расценки; «просмотрено»; права и закрытие; проверка для прода (до миграции — FAIL) и аварийный откат.
// Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const NAME = '20261029_supply_vor_versions'
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261029.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const SUPPLY = ['20261020_supply_pricing.sql', '20261022_supply_links.sql', '20261023_supply_rate_reuse.sql',
  '20261024_supply_import_state.sql', '20261025_supply_docs_similarity.sql']
const skip = skipReason()

const U = {
  supply: '00000000-0000-4000-8000-00000000c3b1',     // «Тендеры на материалы»: правка
  tender: '00000000-0000-4000-8000-00000000c3b2',     // «Тендеры»: правка
  viewer: '00000000-0000-4000-8000-00000000c3b3',     // «Тендеры на материалы»: только просмотр
  contractor: '00000000-0000-4000-8000-00000000c3b5', // подрядчик
}
const OBJ = '00000000-0000-4000-8000-00000000d301'
const T = '00000000-0000-4000-8000-00000000e301'    // основной тендер: расценивают
const M = '00000000-0000-4000-8000-00000000e311'    // его тендер на материалы
const TE = '00000000-0000-4000-8000-00000000e302'   // тендер без цен
const TL = '00000000-0000-4000-8000-00000000e303'   // закрытый: тендер на материалы «Завершён»
const ML = '00000000-0000-4000-8000-00000000e313'
const D = (n) => `00000000-0000-4000-8000-0000000f30${String(n).padStart(2, '0')}`

describe('Версии ВОР в расценке снабжением: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const json = (text) => JSON.parse(sql(text) || 'null')
  const pos = (list) => q(JSON.stringify(list.map(([name, unit, volume]) => ({ name, unit, volume }))))
  const file = (n, tender, name, at) => sql(`insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, uploaded_by_name, created_at)
    values ('${D(n)}', 'tender', '${tender}', 'tenders/${tender}/${n}-${name}', ${q(name)}, 'vor_statement', 'Сметов С. С.', ${q(at)})`)
  // Список позиций ВОР — как его пишет страница или служба (k проставит триггер).
  const insertList = (uid, tender, doc, { docId = null, fileName = null, source = docId ? 'vor_file' : 'vor_tab', version = null, positions }) =>
    as(uid, `insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, source_version, positions)
      values ('${tender}', ${q(doc)}, '${source}', ${docId ? `'${docId}'` : 'null'}, ${fileName ? q(fileName) : 'null'}, ${version ? q(version) : 'null'}, ${pos(positions)}::jsonb)`)
  const updateList = (uid, tender, doc, set) => as(uid, `update public.tender_supply_sources set ${set} where tender_id = '${tender}' and estimate_name = ${q(doc)}`)
  const price = (tender, doc, name, unit, value, volume = 10) => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${tender}', ${q(doc)}, ${q(name)}, ${q(unit)}, 'unit', ${value}, ${volume})`)
    return sql(`select id from public.tender_vor_supply_rates where tender_id = '${tender}' and estimate_name = ${q(doc)} and material_name = ${q(name)}`)
  }
  const rate = (where) => json(`select row_to_json(r) from public.tender_vor_supply_rates r where ${where}`)
  const revisions = (tender, doc = null) => json(`select coalesce(json_agg(r order by r.id), '[]') from public.tender_supply_revisions r
    where r.tender_id = '${tender}'${doc ? ` and r.estimate_name = ${q(doc)}` : ''}`)
  const source = (tender, doc) => json(`select row_to_json(s) from public.tender_supply_sources s where tender_id = '${tender}' and estimate_name = ${q(doc)}`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    // Кандидаты до расценки (её миграции — по порядку ниже); более поздние чужие кандидаты этому тесту не нужны.
    for (const m of candidateMigrations()) if (m < '20261020') psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of SUPPLY) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('r_supply', 'Тест: снабжение', false), ('r_tender', 'Тест: тендерный отдел', false), ('r_viewer', 'Тест: просмотр', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('r_supply', 'tenders_materials', true, true), ('r_tender', 'tenders', true, true), ('r_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a301', 'ООО Тест версий');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.supply}', 'r_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 'r_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 'r_viewer', true, false, 'Смотров В. В.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a301');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Версии', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ('${T}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура'), ('${TE}', 'ЭОМ', '${OBJ}', 'Идет тендерная процедура'),
        ('${TL}', 'Закрыт', '${OBJ}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${M}', 'ОВ и ВК', '${OBJ}', 'В работе', 'materials', '${T}'), ('${ML}', 'Закрыт', '${OBJ}', 'В работе', 'materials', '${TL}');`)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 6, checkBefore)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
  })

  it('первый ВОР тендера без цен — без версии; файл заменён тем же именем — версия: что изменилось и прежние цены, цены на месте', () => {
    file(1, T, 'ВОР ОВ.xlsx', '2026-10-10 09:00:00+00')
    insertList(U.supply, T, 'ВОР ОВ', { docId: D(1), fileName: 'ВОР ОВ.xlsx', version: 'file:1', positions: [
      ['Труба медная Ø12,7', 'м', 1500], ['Кран шаровой Ду15', 'шт', 48], ['Изоляция K-Flex 13×15', 'м', 1100],
      ['Хомут монтажный', 'шт', 200], ['Кабель ВВГнг 3×2,5', 'т', 2], ['Заглушка Ду50', 'шт', 4]] })
    assert.deepEqual(revisions(T), [], 'расценивать ещё нечего — сообщать не о чем')
    const ids = {
      pipe: price(T, 'ВОР ОВ', 'Труба медная Ø12,7', 'м', 980, 1500),
      valve: price(T, 'ВОР ОВ', 'Кран шаровой Ду15', 'шт', 512.5, 48),
      clamp: price(T, 'ВОР ОВ', 'Хомут монтажный', 'шт', 35, 200),
      cable: price(T, 'ВОР ОВ', 'Кабель ВВГнг 3×2,5', 'т', 99000, 2),
    }
    const before = rate(`id = '${ids.pipe}'`)
    // Новая версия: тот же ВОР (то же имя файла — автозагрузка пишет в прежний список), позиции другие.
    file(2, T, 'ВОР ОВ.xlsx', '2026-10-21 09:00:00+00')
    updateList(U.supply, T, 'ВОР ОВ', `s3_document_id = '${D(2)}', source_version = 'file:2', positions = ${pos([
      ['ТРУБА медная  Ø12.7', 'м', 1500],     // то же наименование по ключу, тот же объём — не изменение
      ['Кран шаровой Ду15', 'шт', 60],        // объём
      ['Изоляция K-Flex 13×15', 'м', 1100],
      ['Кабель ВВГнг 3×2,5', 'м', 2000],      // ед. изм.
      ['Заглушка Ду50', 'штук', 4],           // «штук» = «шт» — не изменение
      ['Хомут монтажный Ø57', 'шт', 200],     // переименован: старый убран, новый добавлен
      ['Опора скользящая', 'шт', 12],         // новая
    ])}::jsonb`)
    const [rev] = revisions(T, 'ВОР ОВ')
    assert.equal(rev.kind, 'update')
    assert.deepEqual([rev.added, rev.removed, rev.volume_changed, rev.unit_changed, rev.priced_removed], [2, 1, 1, 1, 1])
    assert.equal(rev.reviewed_at, null, 'ждёт снабжение')
    assert.equal(rev.old_document_id, D(1))
    assert.equal(rev.new_document_id, D(2))
    assert.equal(rev.uploaded_by_name, 'Сметов С. С.')
    assert.equal(rev.created_by, U.supply)
    const by = Object.fromEntries(rev.changes.map((c) => [`${c.op}:${c.name}`, c]))
    assert.deepEqual(Object.keys(by).sort(), ['added:Опора скользящая', 'added:Хомут монтажный Ø57', 'removed:Хомут монтажный',
      'unit:Кабель ВВГнг 3×2,5', 'volume:Кран шаровой Ду15'])
    assert.equal(by['volume:Кран шаровой Ду15'].old_volume, 48)
    assert.equal(by['volume:Кран шаровой Ду15'].volume, 60)
    assert.equal(by['volume:Кран шаровой Ду15'].price, 512.5)
    assert.equal(by['unit:Кабель ВВГнг 3×2,5'].old_unit, 'т')
    assert.equal(by['unit:Кабель ВВГнг 3×2,5'].unit, 'м')
    assert.equal(by['removed:Хомут монтажный'].rate_id, ids.clamp)
    assert.equal(by['removed:Хомут монтажный'].price, 35)
    assert.equal(by['added:Опора скользящая'].price, undefined)
    // Снимок цен прежней версии — все четыре, с прежними объёмами.
    const snap = Object.fromEntries(rev.prices.map((p) => [p.name, p]))
    assert.deepEqual(Object.keys(snap).sort(), ['Кабель ВВГнг 3×2,5', 'Кран шаровой Ду15', 'Труба медная Ø12,7', 'Хомут монтажный'])
    assert.equal(snap['Кран шаровой Ду15'].volume, 48)
    assert.equal(snap['Кабель ВВГнг 3×2,5'].unit, 'т')
    assert.equal(snap['Труба медная Ø12,7'].date, before.price_date)
    // Цены не тронуты: те же строки, та же версия строки.
    const after = rate(`id = '${ids.pipe}'`)
    assert.equal(after.row_version, before.row_version)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T}'`), '4')
    assert.deepEqual(source(T, 'ВОР ОВ').prior_document_ids, [D(1)], 'прежний файл запомнен')
  })

  it('не версия: перечитали тот же файл другим листом, перенесли ВОР; список прежних файлов прямой правкой не очистить', () => {
    const n = revisions(T).length
    updateList(U.supply, T, 'ВОР ОВ', `sheet_name = 'Материалы 2', column_map = '{"mode":"code"}', positions = ${pos([
      ['Труба медная Ø12,7', 'м', 1400], ['Кран шаровой Ду15', 'шт', 60]])}::jsonb`)
    assert.equal(revisions(T).length, n, 'тот же файл — не новая версия ВОР')
    updateList(U.supply, T, 'ВОР ОВ', 'prior_document_ids = \'{}\'')
    assert.deepEqual(source(T, 'ВОР ОВ').prior_document_ids, [D(1)])
    as(U.tender, `select public.supply_estimate_rename('${T}', 'ВОР ОВ', 'ОВ')`)
    assert.equal(revisions(T).length, n)
    assert.equal(revisions(T, 'ОВ').length, n, 'версии перешли вместе с ВОР')
    assert.equal(revisions(T, 'ВОР ОВ').length, 0)
  })

  it('вкладка «ВОР»: перезагрузка — версия, смена признака разбора (vor → vor2) — нет', () => {
    insertList(U.supply, T, 'Корпус 1', { version: 'vor:3:2026-10-01T10:00:00+00:00', positions: [['Щит ЩРН-12', 'шт', 3]] })
    const added = revisions(T, 'Корпус 1')
    assert.equal(added.length, 1)
    assert.equal(added[0].kind, 'added', 'в расценённом тендере появился ещё ВОР')
    assert.equal(added[0].reviewed_at, null)
    updateList(U.supply, T, 'Корпус 1', `source_version = 'vor2:3:2026-10-01T10:00:00+00:00', positions = ${pos([['Щит ЩРН-12', 'шт', 3]])}::jsonb`)
    assert.equal(revisions(T, 'Корпус 1').length, 1)
    updateList(U.supply, T, 'Корпус 1', `source_version = 'vor2:4:2026-10-21T10:00:00+00:00', positions = ${pos([['Щит ЩРН-12', 'шт', 3]])}::jsonb`)
    const [, upd] = revisions(T, 'Корпус 1')
    assert.equal(upd.kind, 'update')
    assert.equal(upd.added + upd.removed + upd.volume_changed + upd.unit_changed, 0)
    assert.ok(upd.reviewed_at, 'материалы те же — смотреть нечего')
  })

  it('файл ВОР удалён из «ВОРов и РД» — версия «удалён», позиции и цены остались; ВОР в тендере без цен — без уведомления', () => {
    sql(`delete from public.s3_documents where id = '${D(2)}'`)
    const rev = revisions(T, 'ОВ').at(-1)
    assert.equal(rev.kind, 'removed')
    assert.equal(rev.reviewed_at, null)
    assert.equal(rev.old_document_id, D(2))
    assert.equal(source(T, 'ОВ').s3_document_id, null)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T}' and estimate_name = 'ОВ'`), '4')
    file(9, TE, 'ВОР ЭОМ.xlsx', '2026-10-10 09:00:00+00')
    insertList(U.supply, TE, 'ВОР ЭОМ', { docId: D(9), fileName: 'ВОР ЭОМ.xlsx', positions: [['Кабель', 'м', 10]] })
    sql(`delete from public.s3_documents where id = '${D(9)}'`)
    const [quiet] = revisions(TE)
    assert.equal(quiet.kind, 'removed')
    assert.ok(quiet.reviewed_at, 'цен нет — сообщать не о чем')
  })

  it('новая версия под другим именем: цены и документы переходят, своя цена новой версии заменяет прежнюю, подставленная — уступает', () => {
    // Прежний ВОР «ОВ» (файл удалён, цены есть), рядом новый файл с другим именем — отдельный список.
    as(U.supply, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, url)
      values ('${T}', 'ОВ', 'Кран шаровой Ду15', 'https://disk.example.ru/schet-1'), ('${T}', 'ОВ', 'Изоляция K-Flex 13×15', 'https://disk.example.ru/schet-old')`)
    file(3, T, 'ВОР ОВ изм.1.xlsx', '2026-10-22 09:00:00+00')
    insertList(U.supply, T, 'ВОР ОВ изм.1', { docId: D(3), fileName: 'ВОР ОВ изм.1.xlsx', version: 'file:3', positions: [
      ['Труба медная Ø12,7', 'м', 1600], ['Кран шаровой Ду15', 'шт', 60], ['Изоляция K-Flex 13×15', 'м', 1100], ['Отвод 90° Ду15', 'шт', 30]] })
    assert.equal(revisions(T, 'ВОР ОВ изм.1')[0].kind, 'added')
    // В новом ВОР успели: подставленная из другого тендера цена трубы, своя цена изоляции и отвода, ссылка на изоляцию.
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price, price_input, input_value,
        volume_at_input, source_rate_id, source_tender_id, source_kind, price_date, row_version)
      values ('${T}', 'ВОР ОВ изм.1', 'Труба медная Ø12,7', 'м', 1111, 'unit', 1111, 1600, gen_random_uuid(), '${TE}', 'auto', current_date, 1);
      alter table public.tender_vor_supply_rates enable trigger user;`)
    const insulation = price(T, 'ВОР ОВ изм.1', 'Изоляция K-Flex 13×15', 'м', 101, 1100)
    price(T, 'ВОР ОВ изм.1', 'Отвод 90° Ду15', 'шт', 220, 30)
    price(T, 'ОВ', 'Изоляция K-Flex 13×15', 'м', 96, 1100)
    as(U.supply, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, url)
      values ('${T}', 'ВОР ОВ изм.1', 'Изоляция K-Flex 13×15', 'https://disk.example.ru/schet-new')`)
    const oldPipe = rate(`tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Труба медная Ø12,7'`)

    assert.throws(() => as(U.viewer, `select public.supply_vor_adopt('${T}', 'ВОР ОВ изм.1', 'ОВ')`), /Нет права/)
    const res = JSON.parse(as(U.supply, `select public.supply_vor_adopt('${T}', 'ВОР ОВ изм.1', 'ОВ')`))
    assert.deepEqual(res, { moved: 2, replaced: 1, dropped: 1, links: 1 })
    assert.equal(source(T, 'ВОР ОВ изм.1'), null, 'список нового ВОР убран')
    const s = source(T, 'ОВ')
    assert.equal(s.s3_document_id, D(3))
    assert.equal(s.file_name, 'ВОР ОВ изм.1.xlsx')
    assert.deepEqual(s.prior_document_ids, [D(1)], 'удалённый файл (его строки уже нет) в прежние не попадает')
    // Своя цена трубы прежнего ВОР осталась (подставленная — убрана), изоляция — новая, отвод перешёл.
    assert.equal(rate(`id = '${oldPipe.id}'`).estimate_name, 'ОВ')
    assert.equal(rate(`id = '${insulation}'`).estimate_name, 'ОВ')
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T}' and estimate_name = 'ВОР ОВ изм.1'`), '0')
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Изоляция K-Flex 13×15'`), '1')
    assert.equal(sql(`select url from public.tender_supply_links where tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Изоляция K-Flex 13×15'`),
      'https://disk.example.ru/schet-new')
    assert.equal(sql(`select url from public.tender_supply_links where tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Кран шаровой Ду15'`),
      'https://disk.example.ru/schet-1')
    // Версия прежнего ВОР: снимок цен — до переноса (прежняя цена изоляции 96 там есть), версия нового — просмотрена.
    const rev = revisions(T, 'ОВ').at(-1)
    assert.equal(rev.kind, 'update')
    assert.equal(rev.new_file_name, 'ВОР ОВ изм.1.xlsx')
    assert.equal(rev.prices.find((p) => p.name === 'Изоляция K-Flex 13×15').price, 96)
    assert.ok(revisions(T, 'ВОР ОВ изм.1').every((r) => r.reviewed_at), 'изменения убранного списка смотреть не к чему')
    assert.match(sql(`select string_agg(op || ':' || coalesce(old_estimate_name, ''), ',' order by id) from public.tender_supply_rate_log
      where tender_id = '${T}' and material_name = 'Отвод 90° Ду15'`), /update:ВОР ОВ изм\.1/, 'перенос — в журнале')
  })

  it('перенос цены убранной позиции на новую: та же строка, прежний день расценки, документ — следом; своя цена — отказ', () => {
    // «Хомут монтажный» убран (переименован в «Хомут монтажный Ø57» в первой версии; во второй его нет), цена осталась.
    updateList(U.supply, T, 'ОВ', `positions = positions || ${pos([['Хомут монтажный Ø57', 'шт', 200], ['Опора скользящая', 'шт', 12]])}::jsonb`)
    const clamp = rate(`tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Хомут монтажный'`)
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set price_date = current_date - 20 where id = '${clamp.id}';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    as(U.supply, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, url)
      values ('${T}', 'ОВ', 'Хомут монтажный', 'https://disk.example.ru/schet-homut')`)
    const fresh = rate(`id = '${clamp.id}'`)
    assert.throws(() => as(U.viewer, `select public.supply_rate_carry('${clamp.id}', ${fresh.row_version}, 'ОВ', 'Хомут монтажный Ø57', 'шт')`), /Нет права/)
    assert.throws(() => as(U.supply, `select public.supply_rate_carry('${clamp.id}', ${fresh.row_version - 1}, 'ОВ', 'Хомут монтажный Ø57', 'шт')`), /уже изменили/)
    price(T, 'ОВ', 'Опора скользящая', 'шт', 640, 12)
    assert.throws(() => as(U.supply, `select public.supply_rate_carry('${clamp.id}', ${fresh.row_version}, 'ОВ', 'Опора скользящая', 'шт')`), /уже есть своя цена/)
    // У цели подставленная из другого тендера цена — уступает.
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price, price_input, input_value,
        volume_at_input, source_rate_id, source_tender_id, source_kind, price_date, row_version)
      values ('${T}', 'ОВ', 'Хомут монтажный Ø57', 'шт', 41, 'unit', 41, 200, gen_random_uuid(), '${TE}', 'auto', current_date, 1);
      alter table public.tender_vor_supply_rates enable trigger user;`)
    const res = JSON.parse(as(U.supply, `select public.supply_rate_carry('${clamp.id}', ${fresh.row_version}, 'ОВ', 'Хомут монтажный Ø57', 'шт')`))
    assert.equal(res.rate.id, clamp.id, 'та же строка цены')
    assert.equal(res.rate.material_name, 'Хомут монтажный Ø57')
    assert.equal(res.dropped.length, 1)
    assert.equal(res.links, 1)
    const moved = rate(`id = '${clamp.id}'`)
    assert.equal(moved.price_date, fresh.price_date, 'день расценки прежний — цена не «помолодела»')
    assert.equal(moved.price_by, fresh.price_by)
    assert.equal(Number(moved.supply_price), 35)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${T}' and estimate_name = 'ОВ' and material_key = public.supply_norm_name('Хомут монтажный Ø57')`), '1')
    assert.equal(sql(`select url from public.tender_supply_links where tender_id = '${T}' and estimate_name = 'ОВ' and material_name = 'Хомут монтажный Ø57'`),
      'https://disk.example.ru/schet-homut')
  })

  it('«просмотрено» — право правки расценки, только названные версии; читает сотрудник, подрядчику и записи напрямую — нет', () => {
    const open = revisions(T).filter((r) => !r.reviewed_at)
    assert.ok(open.length >= 2)
    assert.throws(() => as(U.viewer, `select public.supply_revisions_review('${T}', array[${open[0].id}]::bigint[])`), /Нет права/)
    assert.equal(as(U.supply, `select public.supply_revisions_review('${T}', array[${open[0].id}]::bigint[])`), '1')
    const r0 = revisions(T).find((r) => r.id === open[0].id)
    assert.equal(r0.reviewed_by, U.supply)
    assert.ok(r0.reviewed_at)
    assert.equal(revisions(T).filter((r) => !r.reviewed_at).length, open.length - 1)
    assert.equal(as(U.supply, `select public.supply_revisions_review('${TE}', array[${open[1].id}]::bigint[])`), '0', 'чужой тендер — мимо')
    assert.notEqual(as(U.viewer, `select count(*) from public.tender_supply_revisions where tender_id = '${T}'`), '0')
    assert.equal(as(U.contractor, `select count(*) from public.tender_supply_revisions`), '0')
    assert.throws(() => as(U.supply, `update public.tender_supply_revisions set reviewed_at = now() where tender_id = '${T}'`), /permission denied/)
    assert.throws(() => as(U.supply, `insert into public.tender_supply_revisions (tender_id, estimate_name, kind) values ('${T}', 'x', 'update')`), /permission denied/)
    assert.throws(() => as(U.supply, `select public.supply_positions_by_key('[]'::jsonb)`), /permission denied/)
  })

  it('«отдельный ВОР»: время и автор ответа — от базы; закрытая расценка — правки не пускает, удаление файла проходит без уведомления', () => {
    file(4, T, 'ВОР ВК.xlsx', '2026-10-22 10:00:00+00')
    insertList(U.supply, T, 'ВОР ВК', { docId: D(4), fileName: 'ВОР ВК.xlsx', positions: [['Труба медная Ø12,7', 'м', 100]] })
    updateList(U.supply, T, 'ВОР ВК', `separate_at = '2001-01-01', separate_by = '${U.viewer}'`)
    const s = source(T, 'ВОР ВК')
    assert.equal(s.separate_by, U.supply)
    assert.ok(s.separate_at > '2026-01-01')
    // Закрытый тендер.
    file(5, TL, 'ВОР Закрыт.xlsx', '2026-10-10 09:00:00+00')
    insertList(U.supply, TL, 'ВОР Закрыт', { docId: D(5), fileName: 'ВОР Закрыт.xlsx', positions: [['Кабель', 'м', 10]] })
    price(TL, 'ВОР Закрыт', 'Кабель', 'м', 70)
    sql(`update public.tenders set status = 'Завершён' where id = '${ML}'`)
    file(6, TL, 'ВОР Закрыт.xlsx', '2026-10-21 09:00:00+00')
    assert.throws(() => updateList(U.supply, TL, 'ВОР Закрыт', `s3_document_id = '${D(6)}'`), /только для чтения/)
    sql(`delete from public.s3_documents where id = '${D(5)}'`)
    const [rev] = revisions(TL)
    assert.equal(rev.kind, 'removed')
    assert.ok(rev.reviewed_at, 'расценка закрыта — сообщать не о чем')
    assert.throws(() => as(U.supply, `select public.supply_vor_adopt('${TL}', 'ВОР Закрыт', 'ВОР Закрыт')`), /Не заданы/)
  })

  it('большой ВОР (5 000 позиций, 1 500 цен): новая версия пишется быстро', () => {
    // Позиции собирает сама база: 5 000 строк в командной строке psql не помещаются.
    const big = (shift) => `(select jsonb_agg(jsonb_build_object('name', 'Материал ' || (i + ${shift}) || ' — труба стальная Ø' || (57 + (i + ${shift}) % 40) || '×3,5',
      'unit', case when i % 7 = 0 then 'шт' else 'м' end, 'volume', 10 + i % 97) order by i) from generate_series(0, 4999) i)`
    as(U.supply, `insert into public.tender_supply_sources (tender_id, estimate_name, source, source_version, positions)
      values ('${T}', 'Большой', 'vor_tab', 'vor2:5000:2026-10-01', ${big(0)})`)
    sql(`insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, supply_price)
      select '${T}', 'Большой', e->>'name', e->>'unit', 100 from public.tender_supply_sources s, jsonb_array_elements(s.positions) e
      where s.tender_id = '${T}' and s.estimate_name = 'Большой' limit 1500`)
    const t0 = Date.now()
    updateList(U.supply, T, 'Большой', `source_version = 'vor2:5000:2026-10-21', positions = ${big(300)}`)
    const ms = Date.now() - t0
    const rev = revisions(T, 'Большой').at(-1)
    assert.deepEqual([rev.added, rev.removed, rev.priced_removed], [300, 300, 300])
    assert.equal(rev.prices.length, 1500)
    assert.ok(ms < 5000, `запись версии ${ms} мс`)
  })

  it('аварийный откат применяется и повторяется; цены, ссылки и списки остаются; миграция ложится снова', () => {
    const rates = sql('select count(*) from public.tender_vor_supply_rates')
    const links = sql('select count(*) from public.tender_supply_links')
    const lists = sql('select count(*) from public.tender_supply_sources')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_vor_supply_rates'), rates)
    assert.equal(sql('select count(*) from public.tender_supply_links'), links)
    assert.equal(sql('select count(*) from public.tender_supply_sources'), lists)
    assert.equal(sql(`select to_regclass('public.tender_supply_revisions') is null`), 't')
    updateList(U.supply, T, 'ОВ', `positions = ${pos([['Труба медная Ø12,7', 'м', 1700]])}::jsonb`)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.deepEqual(source(T, 'ОВ').prior_document_ids, [])
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`),
    path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)]) assert.ok(fs.existsSync(f), f)
})
