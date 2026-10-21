// Цены снабжения из других тендеров (миграция 20261023_supply_rate_reuse) — на слепке схемы прода после 20261020 и
// 20261022: день расценки по Москве, копии (сами — одинаковые позиции, на выбор — похожие) с датой исходной цены,
// 3 месяца по дням, та же ед. изм., убранная цена не возвращается, права и закрытие, две сессии разом, похожесть
// наименований, реестр СУ-10 без копий, проверка для прода (до миграции — FAIL) и аварийный откат.
// Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, '20261023_supply_rate_reuse.sql')
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261023.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20261023_supply_rate_reuse_rollback.sql')
const skip = skipReason()

const U = {
  supply: '00000000-0000-4000-8000-00000000c2b1',     // «Тендеры на материалы»: правка
  tender: '00000000-0000-4000-8000-00000000c2b2',     // «Тендеры»: правка
  viewer: '00000000-0000-4000-8000-00000000c2b3',     // «Тендеры на материалы»: только просмотр
  contractor: '00000000-0000-4000-8000-00000000c2b5', // подрядчик
}
const OBJ_A = '00000000-0000-4000-8000-00000000d201'
const OBJ_C = '00000000-0000-4000-8000-00000000d202'
const TA = '00000000-0000-4000-8000-00000000e201'   // источник: свежие цены
const TB = '00000000-0000-4000-8000-00000000e202'   // источник: цены постарше
const TX = '00000000-0000-4000-8000-00000000e203'   // удалённый тендер
const TC = '00000000-0000-4000-8000-00000000e204'   // куда подставляем
const MC = '00000000-0000-4000-8000-00000000e214'   // тендер на материалы TC
const TD = '00000000-0000-4000-8000-00000000e205'   // второй получатель: копии источником не служат
const TL = '00000000-0000-4000-8000-00000000e206'   // закрытый: тендер на материалы «Завершён»
const ML = '00000000-0000-4000-8000-00000000e216'

const today = 'public.supply_today_test()'

describe('Цены снабжения из других тендеров: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  let legacyId = ''
  const sql = (text) => psqlAt(db.port, text)
  const wrap = (uid, text) => `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`
  const as = (uid, text) => psqlAt(db.port, wrap(uid, text))
  // То же, но не дожидаясь конца — для двух сессий разом.
  const asAsync = (uid, text) => new Promise((resolve, reject) => {
    const p = spawn('psql', ['-h', '127.0.0.1', '-p', String(db.port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At',
      '-v', 'ON_ERROR_STOP=1', '-c', wrap(uid, text)], { env: { ...process.env, PGPASSWORD: '', PGSSLMODE: 'disable' } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.split('\n').find((l) => /ERROR/.test(l)) || `psql ${code}`))))
  })
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const rate = (where) => JSON.parse(sql(`select row_to_json(r) from public.tender_vor_supply_rates r where ${where}`) || 'null')
  // Цена со страницы (за единицу), затем — нужный день расценки (как будто её ввели тогда).
  const price = (tender, doc, name, unit, value, daysAgo = 0) => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${tender}', ${q(doc)}, ${q(name)}, ${q(unit)}, 'unit', ${value}, 10)`)
    const id = sql(`select id from public.tender_vor_supply_rates where tender_id = '${tender}' and estimate_name = ${q(doc)} and material_name = ${q(name)}`)
    if (daysAgo) {
      sql(`alter table public.tender_vor_supply_rates disable trigger user;
        update public.tender_vor_supply_rates set price_date = ${today} - ${daysAgo} where id = '${id}';
        alter table public.tender_vor_supply_rates enable trigger user;`)
    }
    return id
  }
  // Список позиций ВОР, как его пишет страница: k — ключ наименования (normName = supply_norm_name).
  const positions = (tender, doc, list) => as(U.supply, `insert into public.tender_supply_sources (tender_id, estimate_name, source, positions)
    select '${tender}', ${q(doc)}, 'vor_tab', jsonb_agg(jsonb_build_object('name', x.name, 'unit', x.unit, 'volume', x.volume, 'k', public.supply_norm_name(x.name)) order by x.o)
    from jsonb_to_recordset(${q(JSON.stringify(list.map((p, o) => ({ ...p, o }))))}::jsonb) as x(name text, unit text, volume numeric, o int)`)
  const autofill = (uid, tender) => Number(as(uid, `select public.supply_autofill('${tender}')`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (/^2026102[02359]_/.test(m)) continue
      psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    }
    psqlAt(db.port, null, { file: path.join(MIGRATIONS, '20261020_supply_pricing.sql') })
    psqlAt(db.port, null, { file: path.join(MIGRATIONS, '20261022_supply_links.sql') })
    sql(`
      insert into public.roles (key, label, is_system) values
        ('r_supply', 'Тест: снабжение', false), ('r_tender', 'Тест: тендерный отдел', false), ('r_viewer', 'Тест: просмотр', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('r_supply', 'tenders_materials', true, true), ('r_tender', 'tenders', true, true), ('r_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a201', 'ООО Тест подбора');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.supply}', 'r_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.tender}', 'r_tender', true, false, 'Тендеров Т. Т.', null),
        ('${U.viewer}', 'r_viewer', true, false, 'Смотров В. В.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a201');
      insert into public.objects (id, name, address) values ('${OBJ_A}', 'ЖК Источник', 'Москва'), ('${OBJ_C}', 'ЖК Цель', 'Москва');
      insert into public.tenders (id, work_description, object_id, status) values
        ('${TA}', 'ОВ', '${OBJ_A}', 'Идет тендерная процедура'), ('${TB}', 'ВК', '${OBJ_A}', 'Идет тендерная процедура'),
        ('${TX}', 'Удалён', '${OBJ_A}', 'Идет тендерная процедура'), ('${TC}', 'ОВ и ВК', '${OBJ_C}', 'Идет тендерная процедура'),
        ('${TD}', 'ОВ', '${OBJ_C}', 'Идет тендерная процедура'), ('${TL}', 'Закрыт', '${OBJ_C}', 'Идет тендерная процедура');
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${MC}', 'ОВ и ВК', '${OBJ_C}', 'В работе', 'materials', '${TC}'), ('${ML}', 'Закрыт', '${OBJ_C}', 'В работе', 'materials', '${TL}');`)
    // Прежняя цена (до миграции): изменена в 22:30 по UTC — по Москве это уже следующий день.
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${TA}', 'Старое', 'Заглушка Ду50', 'шт', 'unit', 150, 4)`)
    legacyId = sql(`select id from public.tender_vor_supply_rates where material_name = 'Заглушка Ду50'`)
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set updated_at = '2026-10-18 22:30:00+00' where id = '${legacyId}';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    // «Сегодня по Москве» — как считает миграция.
    sql(`create or replace function public.supply_today_test() returns date language sql stable as $$ select (now() at time zone 'Europe/Moscow')::date $$`)
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; миграция повторяется', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 5, checkBefore)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('прежние цены: день расценки — по Москве от времени изменения (22:30 UTC 18.10 → 19.10); кто поставил — из журнала', () => {
    const r = rate(`id = '${legacyId}'`)
    assert.equal(r.price_date, '2026-10-19')
    assert.equal(r.price_by, U.supply)
  })

  it('день расценки ставит ввод цены; ед. изм., перенос ВОР и прямая правка колонок его не меняют', () => {
    const id = price(TA, 'ОВ', 'Кран шаровой Ду15', 'шт', 420)
    assert.equal(rate(`id = '${id}'`).price_date, sql(`select ${today}`))
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set price_date = ${today} - 5 where id = '${id}';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    const before = rate(`id = '${id}'`).price_date
    assert.equal(rate(`id = '${id}'`).price_by, U.supply, 'кто поставил цену')
    as(U.supply, `update public.tender_vor_supply_rates set unit = 'штук' where id = '${id}'`)
    as(U.tender, `select public.supply_estimate_rename('${TA}', 'ОВ', 'ОВ-1')`)
    as(U.supply, `update public.tender_vor_supply_rates set price_date = ${today}, source_kind = 'auto', source_tender_id = '${TB}',
      price_by = '${U.viewer}' where id = '${id}'`)
    const r = rate(`id = '${id}'`)
    assert.equal(r.price_date, before, 'дата не «помолодела»')
    assert.equal(r.price_by, U.supply, 'автор цены — тот, кто её ставил, а не кто переносил ВОР или правил колонку')
    assert.equal(r.updated_by, U.supply)
    assert.equal(r.estimate_name, 'ОВ-1')
    assert.equal(r.source_kind, null)
    assert.equal(r.source_tender_id, null)
    as(U.tender, `update public.tender_vor_supply_rates set input_value = 430 where id = '${id}'`)
    assert.equal(rate(`id = '${id}'`).price_date, sql(`select ${today}`), 'новая цена — сегодня')
    assert.equal(rate(`id = '${id}'`).price_by, U.tender, 'новая цена — новый автор')
    // Импорт Excel (только supply_price) — тоже новая цена.
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set price_date = ${today} - 5 where id = '${id}';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    as(U.supply, `update public.tender_vor_supply_rates set supply_price = 440 where id = '${id}'`)
    const x = rate(`id = '${id}'`)
    assert.equal(x.price_input, 'import')
    assert.equal(x.price_date, sql(`select ${today}`))
  })

  it('одинаковые позиции подставляются сами: самая свежая своя цена, та же ед. изм., не старше 3 месяцев (граница включительно)', () => {
    price(TA, 'ОВ-1', 'Труба стальная Ø57×3,5', 'м', 1200, 10)
    price(TB, 'ВК', 'ТРУБА стальная  Ø57×3,5', 'м', 1100, 40)        // тот же ключ, постарше
    price(TB, 'ВК', 'Отвод 90° 57х3,5', 'шт', 310, 2)                 // «шт» = «штук»
    price(TB, 'ВК', 'Кабель ВВГнг 3×2,5', 'т', 99, 1)                  // другая ед. изм.
    price(TB, 'ВК', 'Задвижка 30с41нж Ду100', 'шт', 25000, 0)
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set price_date = (${today} - interval '3 months')::date where material_name = 'Задвижка 30с41нж Ду100';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    price(TB, 'ВК', 'Фильтр сетчатый Ду50', 'шт', 5000, 0)
    sql(`alter table public.tender_vor_supply_rates disable trigger user;
      update public.tender_vor_supply_rates set price_date = (${today} - interval '3 months')::date - 1 where material_name = 'Фильтр сетчатый Ду50';
      alter table public.tender_vor_supply_rates enable trigger user;`)
    price(TX, 'ОВ', 'Манометр 0-10 бар', 'шт', 900, 1)
    sql(`update public.tenders set deleted_at = now() where id = '${TX}'`)
    price(TC, 'ОВ', 'Кран шаровой Ду15', 'шт', 777, 0)                // своя цена — не трогается
    positions(TC, 'ОВ', [
      { name: 'Труба стальная Ø57×3,5', unit: 'м', volume: 120 },
      { name: 'Отвод 90° 57х3,5', unit: 'штук', volume: 8 },
      { name: 'Кабель ВВГнг 3×2,5', unit: 'м', volume: 300 },
      { name: 'Задвижка 30с41нж Ду100', unit: 'шт', volume: 2 },
      { name: 'Фильтр сетчатый Ду50', unit: 'шт', volume: 1 },
      { name: 'Манометр 0-10 бар', unit: 'шт', volume: 3 },
      { name: 'Кран шаровой Ду15', unit: 'шт', volume: 50 },
    ])
    assert.equal(autofill(U.supply, TC), 3)
    const pipe = rate(`tender_id = '${TC}' and material_name = 'Труба стальная Ø57×3,5'`)
    const src = rate(`tender_id = '${TA}' and material_name = 'Труба стальная Ø57×3,5'`)
    assert.equal(Number(pipe.supply_price), 1200, 'самая свежая — из TA')
    assert.equal(Number(pipe.supply_total), 144000, 'сумма — по объёму своего ВОР')
    assert.equal(pipe.source_kind, 'auto')
    assert.equal(pipe.source_rate_id, src.id)
    assert.equal(pipe.source_tender_id, TA)
    assert.equal(pipe.price_date, src.price_date, 'дата — исходной цены')
    assert.equal(pipe.updated_by, U.supply)
    assert.equal(pipe.price_by, null, 'подставлена сама — автора в этом тендере нет')
    assert.ok(rate(`tender_id = '${TC}' and material_name = 'Отвод 90° 57х3,5'`), '«шт» = «штук»')
    assert.ok(rate(`tender_id = '${TC}' and material_name = 'Задвижка 30с41нж Ду100'`), 'ровно 3 месяца — ещё свежая')
    for (const name of ['Кабель ВВГнг 3×2,5', 'Фильтр сетчатый Ду50', 'Манометр 0-10 бар']) {
      assert.equal(rate(`tender_id = '${TC}' and material_name = ${q(name)}`), null, name)
    }
    assert.equal(Number(rate(`tender_id = '${TC}' and material_name = 'Кран шаровой Ду15'`).supply_price), 777)
    assert.equal(autofill(U.supply, TC), 0, 'повтор ничего не добавляет')
  })

  it('копия источником не служит; убранная вручную цена сама не возвращается', () => {
    positions(TD, 'ОВ', [{ name: 'Отвод 90° 57х3,5', unit: 'шт', volume: 5 }, { name: 'Труба стальная Ø57×3,5', unit: 'м', volume: 10 }])
    // Исходную цену отвода удалили — у TC осталась только копия, она источником не служит.
    as(U.supply, `delete from public.tender_vor_supply_rates where tender_id = '${TB}' and material_name = 'Отвод 90° 57х3,5'`)
    assert.equal(autofill(U.tender, TD), 1)
    assert.equal(rate(`tender_id = '${TD}' and material_name = 'Отвод 90° 57х3,5'`), null)
    const pipe = rate(`tender_id = '${TD}' and material_name = 'Труба стальная Ø57×3,5'`)
    assert.equal(pipe.source_tender_id, TA, 'источник — сама цена TA, а не копия в TC')
    as(U.supply, `delete from public.tender_vor_supply_rates where id = '${pipe.id}'`)
    assert.equal(autofill(U.supply, TD), 0)
    assert.equal(rate(`tender_id = '${TD}' and material_name = 'Труба стальная Ø57×3,5'`), null)
  })

  it('без права правки, подрядчику и в закрытом тендере — ничего не подставляется', () => {
    positions(TL, 'ОВ', [{ name: 'Труба стальная Ø57×3,5', unit: 'м', volume: 1 }])
    sql(`update public.tenders set status = 'Завершён' where id = '${ML}'`)
    // Журнал TD очищен: иначе подстановку остановила бы убранная выше цена, а не права.
    sql(`delete from public.tender_supply_rate_log where tender_id = '${TD}'`)
    for (const u of [U.viewer, U.contractor]) assert.equal(autofill(u, TD), 0)
    assert.equal(autofill(U.supply, TL), 0)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id in ('${TL}', '${TD}') and material_name like 'Труба%'`), '0')
  })

  it('две сессии разом — без дублей и без ошибок', async () => {
    const [a, b] = await Promise.all([
      asAsync(U.supply, `select public.supply_autofill('${TD}'); select pg_sleep(1)`),
      new Promise((r) => setTimeout(r, 300)).then(() => asAsync(U.tender, `select public.supply_autofill('${TD}')`)),
    ])
    assert.equal(Number(a.split('\n')[0]) + Number(b), 1)
    assert.equal(sql(`select count(*) from public.tender_vor_supply_rates where tender_id = '${TD}' and material_name like 'Труба%'`), '1')
  })

  it('копия: правка цены — уже своя цена с сегодняшним днём; смена ед. изм. отметку не снимает', () => {
    const id = rate(`tender_id = '${TC}' and material_name = 'Задвижка 30с41нж Ду100'`).id
    as(U.supply, `update public.tender_vor_supply_rates set unit = 'штук' where id = '${id}'`)
    assert.equal(rate(`id = '${id}'`).source_kind, 'auto')
    as(U.supply, `update public.tender_vor_supply_rates set price_input = 'unit', input_value = 26000 where id = '${id}'`)
    const r = rate(`id = '${id}'`)
    assert.equal(r.source_kind, null)
    assert.equal(r.source_rate_id, null)
    assert.equal(r.price_date, sql(`select ${today}`))
  })

  it('похожие: доля общих слов и чисел, без общего слова — 0', () => {
    const sim = (a, b) => Number(sql(`select public.supply_name_similarity(public.supply_name_tokens(${q(a)}), public.supply_name_tokens(${q(b)}))`))
    assert.equal(sim('Кабель ВВГнг 3×2,5', 'кабель ввгнг-LS 3x2.5'), 1, 'регистр, «×» и «x», запятая, короткие слова')
    assert.equal(sim('Кран шаровой латунный Ду15', 'Латунный шаровой кран ДУ 15'), 1, 'порядок слов')
    assert.ok(sim('Труба стальная Ø57×3,5', 'Труба стальная 57x3.5 ГОСТ 10704') >= 0.8, 'Ø и ГОСТ')
    assert.equal(sim('Труба ПП 57', 'Кран шаровой 57'), 0, 'одни общие числа — не похожи')
    assert.ok(sim('Арматура А500С ф12', 'Арматура А500С ф16') >= 0.5)
    assert.ok(sim('Бетон В25', 'Песок строительный') === 0)
    // Латиница вместо кириллицы (гомоглифы) — то же слово.
    assert.equal(sim('Кран шаровой', 'Kpaн шapoвoй'), 1)
  })

  it('меню похожих: от новых к старым, та же ед. изм., не старше 3 месяцев, без копий и без самой позиции; ссылка на документ', () => {
    sql(`insert into public.tender_supply_links (tender_id, estimate_name, material_name, url)
      values ('${TA}', 'ОВ-1', 'Труба стальная Ø57×3,5', 'https://disk.example.ru/chek-57')`)
    price(TB, 'ВК', 'Труба стальная Ø57×4', 'м', 1300, 3)
    price(TB, 'ВК', 'Труба стальная Ø57×5', 'т', 80000, 1)             // другая ед. изм.
    price(TB, 'ВК', 'Труба стальная Ø57×6', 'м', 1500, 120)            // старше 3 месяцев
    const list = JSON.parse(as(U.viewer, `select coalesce(json_agg(s), '[]') from public.supply_rate_suggestions('${TC}', 'ОВ', 'Труба стальная Ø57×3,5', 'м') s`))
    const names = list.map((s) => `${s.material_name}|${s.tender_id === TA ? 'A' : s.tender_id === TB ? 'B' : '?'}`)
    assert.deepEqual(names, ['Труба стальная Ø57×4|B', 'Труба стальная Ø57×3,5|A', 'ТРУБА стальная  Ø57×3,5|B'], 'новые выше; копия TC и чужие ед. изм. — нет')
    const a = list[1]
    assert.equal(a.url, 'https://disk.example.ru/chek-57')
    assert.equal(a.object_name, 'ЖК Источник')
    assert.equal(a.same_name, true)
    assert.equal(Number(a.unit_price), 1200)
    assert.ok(Number.isInteger(a.tender_number) || a.tender_number === null)
    assert.equal(list[0].same_name, false)
    // Сколько похожих — порцией позиций; у позиции без кандидатов строки нет.
    const counts = JSON.parse(as(U.viewer, `select coalesce(json_agg(c), '[]') from public.supply_suggestion_counts('${TC}', ${q(JSON.stringify([
      { doc: 'ОВ', k: sql(`select public.supply_norm_name('Труба стальная Ø57×3,5')`), name: 'Труба стальная Ø57×3,5', unit: 'м' },
      { doc: 'ОВ', k: 'nichego', name: 'Ничего похожего нет', unit: 'шт' },
    ]))}::jsonb) c`))
    assert.deepEqual(counts.map((c) => [c.estimate_name, c.n]), [['ОВ', 3]])
    assert.equal(as(U.contractor, `select count(*) from public.supply_rate_suggestions('${TC}', 'ОВ', 'Труба стальная Ø57×3,5', 'м')`), '0', 'подрядчику цен не видно')
  })

  it('выбор похожей: дата и тендер — исходной цены, отметка pick; копию выбрать нельзя', () => {
    const src = rate(`tender_id = '${TB}' and material_name = 'Труба стальная Ø57×4'`)
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input, source_rate_id, source_kind)
      values ('${TC}', 'ОВ', 'Кабель ВВГнг 3×2,5', 'м', 'unit', 1300, 300, '${src.id}', 'pick')`)
    const r = rate(`tender_id = '${TC}' and material_name = 'Кабель ВВГнг 3×2,5'`)
    assert.equal(r.source_kind, 'pick')
    assert.equal(r.source_tender_id, TB)
    assert.equal(r.price_by, U.supply, 'взял из похожих — он и поставил')
    assert.equal(r.price_date, src.price_date)
    const copy = rate(`tender_id = '${TC}' and material_name = 'Труба стальная Ø57×3,5'`)
    assert.throws(() => as(U.supply, `update public.tender_vor_supply_rates set source_rate_id = '${copy.id}', source_kind = 'pick' where id = '${r.id}'`),
      /скопирована из другого тендера/)
    assert.throws(() => as(U.supply, `update public.tender_vor_supply_rates set source_rate_id = gen_random_uuid(), source_kind = 'pick' where id = '${r.id}'`),
      /не найдена/)
    const origins = JSON.parse(as(U.viewer, `select json_agg(o order by o.estimate_name, o.source_kind) from public.supply_rate_origins('${TC}') o`))
    const pipe = origins.find((o) => o.rate_id === copy.id)
    assert.equal(pipe.source_kind, 'auto')
    assert.equal(pipe.object_name, 'ЖК Источник')
    assert.equal(pipe.estimate_name, 'ОВ-1')
    assert.equal(pipe.material_name, 'Труба стальная Ø57×3,5')
    assert.equal(pipe.url, 'https://disk.example.ru/chek-57')
    assert.equal(pipe.source_price_by, U.supply, 'автор исходной цены')
    assert.ok(origins.some((o) => o.rate_id === r.id && o.source_kind === 'pick' && o.material_name === 'Труба стальная Ø57×4'))
  })

  it('реестр СУ-10: без копий, дата — день расценки (полночь по Москве)', () => {
    sql('refresh materialized view public.supply_rates_registry_mv')
    assert.equal(sql(`select count(*) from public.supply_rates_registry_mv where tender_id = '${TC}' and item_name like 'Труба%'`), '0')
    assert.equal(sql(`select count(*) from public.supply_rates_registry_mv where tender_id = '${TC}' and item_name = 'Кран шаровой Ду15'`), '1')
    assert.equal(sql(`select (rate_date at time zone 'Europe/Moscow')::text from public.supply_rates_registry_mv
      where tender_id = '${TA}' and item_name = 'Заглушка Ду50'`), '2026-10-19 00:00:00')
    assert.match(sql(`select has_table_privilege('authenticated', 'public.supply_rates_registry_mv', 'select')`), /^f/)
  })

  it('аварийный откат применяется и повторяется; цены и копии остаются; миграция ложится снова', () => {
    const n = sql('select count(*) from public.tender_vor_supply_rates')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_vor_supply_rates'), n)
    assert.throws(() => as(U.supply, `select public.supply_autofill('${TC}')`), /does not exist|не существует/)
    sql('refresh materialized view public.supply_rates_registry_mv')
    assert.equal(sql(`select count(*) from public.supply_rates_registry_mv where tender_id = '${TC}' and item_name like 'Труба%'`), '1', 'копии снова в реестре')
    price(TC, 'ОВ', 'Хомут 57', 'шт', 50)
    assert.equal(rate(`tender_id = '${TC}' and material_name = 'Хомут 57'`).price_date, null, 'прежний расчёт дату не ставит')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.equal(rate(`tender_id = '${TC}' and material_name = 'Хомут 57'`).price_date, sql(`select ${today}`))
    assert.equal(autofill(U.supply, TC), 0)
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', '20261023_supply_rate_reuse.sql'),
    path.join(ROOT, 'migration', 'yandex', '20261023_supply_rate_reuse.check.sql')]) assert.ok(fs.existsSync(f), f)
})
