// Файл документа к позиции и новая похожесть (миграция 20261025_supply_docs_similarity) — на слепке схемы прода после
// 20261020, 20261022 и 20261023: документ позиции — адрес или файл (одно из двух; записали одно — другое снимается,
// так пишут и прежние вкладки), права как у ссылок, удалённый файл пропадает у позиций (каскад — и у завершённого
// тендера), похожие цены — тот же материал в другой записи, а не другой размер той же серии (меню — самые похожие
// первыми, с размером и файлом документа), счётчики похожих, откуда скопирована цена (с файлом), проверка для прода
// (до миграции — FAIL, а не ошибка) и аварийный откат. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, '20261025_supply_docs_similarity.sql')
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261025.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20261025_supply_docs_similarity_rollback.sql')
const skip = skipReason()

const U = {
  supply: '00000000-0000-4000-8000-00000000c3b1',     // «Тендеры на материалы»: правка
  viewer: '00000000-0000-4000-8000-00000000c3b3',     // «Тендеры на материалы»: только просмотр
  contractor: '00000000-0000-4000-8000-00000000c3b5', // подрядчик
}
const OBJ = '00000000-0000-4000-8000-00000000d301'
const TS = '00000000-0000-4000-8000-00000000e301'   // источник цен (другой тендер)
const T1 = '00000000-0000-4000-8000-00000000e302'   // расценка
const M1 = '00000000-0000-4000-8000-00000000e312'
const TL = '00000000-0000-4000-8000-00000000e303'   // закрытый: тендер на материалы «Завершён»
const ML = '00000000-0000-4000-8000-00000000e313'
const DOC = {
  ts: '00000000-0000-4000-8000-00000000f301',       // счёт к цене источника
  t1: '00000000-0000-4000-8000-00000000f302',       // счёт к позиции расценки
  tl: '00000000-0000-4000-8000-00000000f303',       // счёт закрытого тендера
}
const SIGMA = 'Клапан Сигмавент-90-НО-400x300-SVF(220)-к'

describe('Файл документа к позиции и похожесть: база', { skip, timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)
  const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`)
  // Как upsert страницы (PostgREST on_conflict по ключу позиции): только переданные колонки.
  const upsert = (uid, tender, doc, name, cols) => {
    const names = Object.keys(cols)
    as(uid, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, ${names.join(', ')})
      values ('${tender}', ${q(doc)}, ${q(name)}, ${names.map((k) => q(cols[k])).join(', ')})
      on conflict (tender_id, estimate_name, material_key) do update set material_name = excluded.material_name, ${names.map((k) => `${k} = excluded.${k}`).join(', ')}`)
  }
  const link = (where) => JSON.parse(sql(`select row_to_json(l) from public.tender_supply_links l where ${where}`) || 'null')
  const price = (tender, doc, name, unit, value) => {
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input)
      values ('${tender}', ${q(doc)}, ${q(name)}, ${q(unit)}, 'unit', ${value}, 4)`)
    return sql(`select id from public.tender_vor_supply_rates where tender_id = '${tender}' and estimate_name = ${q(doc)} and material_name = ${q(name)}`)
  }
  const suggestions = (name, unit = 'шт') => JSON.parse(as(U.supply, `select coalesce(json_agg(s), '[]') from public.supply_rate_suggestions('${T1}', 'ОВ', ${q(name)}, ${q(unit)}) s`))

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      if (/^2026102[0235]_/.test(m)) continue
      psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    }
    for (const m of ['20261020_supply_pricing', '20261022_supply_links', '20261023_supply_rate_reuse']) {
      psqlAt(db.port, null, { file: path.join(MIGRATIONS, `${m}.sql`) })
    }
    sql(`
      insert into public.roles (key, label, is_system) values ('d_supply', 'Тест: снабжение', false), ('d_viewer', 'Тест: просмотр', false)
      on conflict (key) do nothing;
      insert into public.role_permissions (role, section, can_view, can_edit) values
        ('d_supply', 'tenders_materials', true, true), ('d_viewer', 'tenders_materials', true, false);
      insert into public.counterparties (id, name) values ('00000000-0000-4000-8000-00000000a301', 'ООО Тест документов');
      insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, counterparty_id) values
        ('${U.supply}', 'd_supply', true, false, 'Снабженцев С. С.', null),
        ('${U.viewer}', 'd_viewer', true, false, 'Смотров В. В.', null),
        ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', '00000000-0000-4000-8000-00000000a301');
      insert into public.objects (id, name, address) values ('${OBJ}', 'ЖК Документы', 'Москва');
      insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
        ('${TS}', 'ОВ', '${OBJ}', 'Идет тендерная процедура', 501), ('${T1}', 'ОВ и ВК', '${OBJ}', 'Идет тендерная процедура', 502),
        ('${TL}', 'Закрыт', '${OBJ}', 'Идет тендерная процедура', 503);
      insert into public.tenders (id, work_description, object_id, status, tender_type, parent_tender_id) values
        ('${M1}', 'ОВ и ВК', '${OBJ}', 'В работе', 'materials', '${T1}'), ('${ML}', 'Закрыт', '${OBJ}', 'В работе', 'materials', '${TL}');
      insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
        ('${DOC.ts}', 'tender', '${TS}', 'tenders/${TS}/x-Счёт 501.pdf', 'Счёт 501.pdf', 'supply_doc'),
        ('${DOC.t1}', 'tender', '${T1}', 'tenders/${T1}/x-Счёт 502.xlsx', 'Счёт 502.xlsx', 'supply_doc'),
        ('${DOC.tl}', 'tender', '${TL}', 'tenders/${TL}/x-Счёт 503.pdf', 'Счёт 503.pdf', 'supply_doc');`)
    // Цены другого тендера — до миграции: колонки похожести посчитает она сама.
    price(TS, 'ОВ-2', SIGMA, 'шт', 18450)
    price(TS, 'ОВ-2', 'Сигмавент-90-НО-300x400 SVF 220 к', 'шт', 18100)
    price(TS, 'ОВ-2', 'Клапан Сигмавент-90-НО-450x350-SVF(220)-к', 'шт', 21900)
    price(TS, 'ОВ-2', 'Клапан Сигмавент-60-НО-400x300-SVF(220)-к', 'шт', 16200)
    price(TS, 'ОВ-2', 'Решетка вентиляционная АМН 400х300', 'шт', 900)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
    // Файл документа у цены источника (ссылка — уже по новой колонке).
    upsert(U.supply, TS, 'ОВ-2', SIGMA, { s3_document_id: DOC.ts })
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

  it('прежние цены получили основы слов, числа и ключи поиска похожих', () => {
    const r = JSON.parse(sql(`select row_to_json(r) from (select name_stems, name_nums, name_heads from public.tender_vor_supply_rates
      where tender_id = '${TS}' and material_name = ${q(SIGMA)}) r`))
    assert.deepEqual(r.name_nums, ['220', '300×400', '90'])
    assert.ok(r.name_stems.includes('svf') && r.name_heads.length > 0, JSON.stringify(r))
  })

  it('документ — файл: адрес пуст; адрес поверх файла и файл поверх адреса — прежнее снимается; оба или ничего — отказ', () => {
    upsert(U.supply, T1, 'ОВ', 'Кран шаровой Ду15', { s3_document_id: DOC.t1 })
    let l = link(`tender_id = '${T1}' and estimate_name = 'ОВ'`)
    assert.deepEqual([l.s3_document_id, l.url, l.updated_by], [DOC.t1, null, U.supply])
    // Прежняя вкладка пишет только адрес — файл снимается.
    upsert(U.supply, T1, 'ОВ', 'КРАН шаровой Ду15', { url: 'https://disk.example.ru/d/chek-1' })
    l = link(`tender_id = '${T1}' and estimate_name = 'ОВ'`)
    assert.deepEqual([l.s3_document_id, l.url], [null, 'https://disk.example.ru/d/chek-1'])
    upsert(U.supply, T1, 'ОВ', 'Кран шаровой Ду15', { s3_document_id: DOC.t1 })
    l = link(`tender_id = '${T1}' and estimate_name = 'ОВ'`)
    assert.deepEqual([l.s3_document_id, l.url], [DOC.t1, null])
    assert.throws(() => as(U.supply, `insert into public.tender_supply_links (tender_id, estimate_name, material_name, url, s3_document_id)
      values ('${T1}', 'ВК', 'Труба', 'https://example.ru/x', '${DOC.t1}')`), /check constraint|нарушает ограничение|violates/)
    assert.throws(() => upsert(U.supply, T1, 'ВК', 'Труба', { url: '   ' }), /check constraint|нарушает ограничение|violates/)
    assert.throws(() => upsert(U.supply, T1, 'ВК', 'Труба', { url: 'javascript:alert(1)' }), /check constraint|нарушает ограничение|violates/)
    assert.throws(() => upsert(U.supply, T1, 'ВК', 'Труба', { s3_document_id: '00000000-0000-4000-8000-0000000fffff' }), /foreign key|внешнего ключа/)
  })

  it('права — как у ссылок: просмотр и подрядчик файл не прикрепят; подрядчик документ поставщика не видит', () => {
    for (const u of [U.viewer, U.contractor]) {
      assert.throws(() => upsert(u, T1, 'ВК', `Чужое ${u}`, { s3_document_id: DOC.t1 }), /row-level security/)
    }
    assert.equal(as(U.contractor, `select count(*) from public.s3_documents where id = '${DOC.t1}'`), '0')
    assert.equal(as(U.viewer, `select count(*) from public.tender_supply_links where s3_document_id = '${DOC.t1}'`), '1')
  })

  it('удалили файл — у позиций его больше нет; у завершённого тендера файл позиции не удалить, как и документ не изменить', () => {
    upsert(U.supply, TL, 'ЭОМ', 'Щит ЩРН-12', { s3_document_id: DOC.tl })
    sql(`update public.tenders set status = 'Завершён' where id = '${ML}'`)
    assert.throws(() => upsert(U.supply, TL, 'ЭОМ', 'Щит ЩРН-12', { url: 'https://example.ru/x' }), /только для чтения/)
    assert.throws(() => as(U.supply, `delete from public.s3_documents where id = '${DOC.tl}'`), /только для чтения/)
    assert.equal(sql(`select count(*) from public.s3_documents where id = '${DOC.tl}'`), '1', 'файл на месте')
    sql(`update public.tenders set status = 'В работе' where id = '${ML}'`)
    as(U.supply, `delete from public.s3_documents where id = '${DOC.tl}'`)
    assert.equal(sql(`select count(*) from public.tender_supply_links where tender_id = '${TL}'`), '0')
  })

  it('похожие: тот же клапан в другой записи — да, другой размер и другая серия — нет; самые похожие первыми, с размером и файлом', () => {
    const rows = suggestions('Клапан противопожарный Сигмавент-90-НО-300х400 SVF 220 к')
    const names = rows.map((r) => r.material_name)
    assert.deepEqual([...names].sort(), [SIGMA, 'Сигмавент-90-НО-300x400 SVF 220 к'].sort(), 'без 450x350, серии 60 и решётки')
    assert.ok(rows.every((r) => r.same_size === true && Number(r.similarity) >= 0.75))
    assert.ok(Number(rows[0].similarity) >= Number(rows[1].similarity))
    const withDoc = rows.find((r) => r.material_name === SIGMA)
    assert.deepEqual([withDoc.doc_id, withDoc.doc_name, withDoc.url], [DOC.ts, 'Счёт 501.pdf', null])
    assert.equal(withDoc.tender_number, 501)
    // То же наименование — первым.
    assert.equal(suggestions(SIGMA)[0].same_name, true)
  })

  it('счётчики похожих — по новому расчёту; порция — не больше 200', () => {
    const items = [
      { doc: 'ОВ', k: 'a', name: 'Сигмавент-90-НО-400 х 300 SVF 220 к', unit: 'шт.' },
      { doc: 'ОВ', k: 'b', name: 'Клапан Сигмавент-90-НО-1000x1000-SVF(220)-к', unit: 'шт' },
      { doc: 'ОВ', k: 'c', name: 'Решетка вентиляционная АМН 400x300', unit: 'шт' },
      { doc: 'ОВ', k: 'd', name: 'Решетка вентиляционная АМН 400x300', unit: 'м' },
    ]
    const out = JSON.parse(as(U.supply, `select coalesce(json_agg(json_build_array(k, n) order by k), '[]')
      from public.supply_suggestion_counts('${T1}', ${q(JSON.stringify(items))}::jsonb)`))
    assert.deepEqual(out, [['a', 2], ['c', 1]])
  })

  it('«Взять» похожую с файлом: откуда цена — с файлом документа исходной позиции', () => {
    const src = sql(`select id from public.tender_vor_supply_rates where tender_id = '${TS}' and material_name = ${q(SIGMA)}`)
    as(U.supply, `insert into public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value, volume_at_input, source_rate_id, source_kind)
      values ('${T1}', 'ОВ', 'Клапан противопожарный Сигмавент-90-НО-300х400', 'шт', 'unit', 18450, 2, '${src}', 'pick')`)
    const origins = JSON.parse(as(U.supply, `select coalesce(json_agg(o), '[]') from public.supply_rate_origins('${T1}') o`))
    assert.equal(origins.length, 1)
    assert.deepEqual([origins[0].doc_id, origins[0].doc_name, origins[0].tender_number], [DOC.ts, 'Счёт 501.pdf', 501])
  })

  it('аварийный откат применяется и повторяется: подбор — прежний (без размера), данные целы; миграция ложится снова', () => {
    const links = sql('select count(*) from public.tender_supply_links')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql('select count(*) from public.tender_supply_links'), links)
    const old = suggestions('Клапан противопожарный Сигмавент-90-НО-300х400 SVF 220 к')
    assert.ok(old.length > 0 && !('same_size' in old[0]), 'прежние колонки ответа')
    psqlAt(db.port, null, { file: MIGRATION })
    assert.doesNotMatch(psqlAt(db.port, null, { file: CHECK }), /^FAIL/m)
    assert.ok('same_size' in suggestions(SIGMA)[0])
  })
})

it('файлы миграций, проверок и отката есть', () => {
  for (const f of [MIGRATION, CHECK, ROLLBACK, path.join(ROOT, 'migration', 'yandex', '20261025_supply_docs_similarity.sql'),
    path.join(ROOT, 'migration', 'yandex', '20261025_supply_docs_similarity.check.sql')]) assert.ok(fs.existsSync(f), f)
})
