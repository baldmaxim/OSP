// Версии файлов (решение пользователя 26.11.2026, «ВОРы и РД») — копия прода под одной учёткой, настоящий migrate.sh с проверкой прав:
//   • 20270307_s3_document_versions: s3_documents.version_group_id; в одной группе — только файлы одного списка (триггер);
//   • кабинет подрядчика: прежние версии ведомости скрыты (bid_vor_superseded → bid_positions, bid_file_target), удалили новую —
//     прежняя снова видна; связь версий главнее отметки снабжения prior_document_ids (файл, который сделали самостоятельным,
//     виден), файлы без групп — как прежде (20270114); bid_vor_changes находит прежнюю версию среди версий группы;
//   • запись под токеном сотрудника (как osp-api): страж строки файла 20270120 пропускает группу версий, прочее — нет;
//   • откат — колонки нет, функции прежние и работают.
// Окно — doc-versions-ui.test.mjs, правила групп — doc-versions.test.mjs. Нужны Docker, psql и проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const NAME = '20270307_s3_document_versions'
const file = (dir, name) => path.join(ROOT, 'migration', dir, name)
const id = (n) => `00000000-0000-4000-8000-0000002${String(n).padStart(5, '0')}`
const U = { admin: id(1), alpha: id(2), engineer: id(4) }
const CP = { alpha: id(11) }
const OBJ = id(21)
const T = { open: id(31), other: id(32) }
const G = { vor: id(51), lone: id(52) }
// v1, v2 — версии одной ведомости; k2 — отдельная; legacy/legacyNew — пара по отметке снабжения без групп; split — файл, который
// сделали самостоятельным (своя группа), хотя отметка снабжения держит его прежней версией legacyNew.
const DOC = { v1: id(41), v2: id(42), k2: id(43), legacy: id(44), legacyNew: id(45), split: id(46), other: id(47) }

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.alpha}', '${U.engineer}']::uuid[]) u;
  insert into public.counterparties (id, name, inn) values ('${CP.alpha}', 'ООО Альфа Версии файлов', '7707083893');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов', 'admin@example.invalid', null),
    ('${U.alpha}', 'contractor', true, false, 'Альфин А. А.', 'alpha@example.invalid', '${CP.alpha}'),
    ('${U.engineer}', 'lawyer', true, false, 'Юристов', 'eng@example.invalid', null);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Версии файлов', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
    ('${T.open}', 'Фасад', '${OBJ}', 'Идет тендерная процедура', 99947),
    ('${T.other}', 'Кровля', '${OBJ}', 'Идет тендерная процедура', 99948);
  insert into public.tender_counterparties (tender_id, counterparty_id, status) values ('${T.open}', '${CP.alpha}', 'request_sent');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at) values
    ('${DOC.v1}', 'tender', '${T.open}', 'tenders/dv/v1.xlsx', 'ВОР фасад 2026-10-09.xlsx', 'vor_statement', now() - interval '20 days'),
    ('${DOC.v2}', 'tender', '${T.open}', 'tenders/dv/v2.xlsx', 'ВОР фасад 2026-11-20.xlsx', 'vor_statement', now() - interval '2 days'),
    ('${DOC.k2}', 'tender', '${T.open}', 'tenders/dv/k2.xlsx', 'ВОР кровля.xlsx', 'vor_statement', now() - interval '10 days'),
    ('${DOC.legacy}', 'tender', '${T.open}', 'tenders/dv/l1.xlsx', 'ВОР ОВ.xlsx', 'vor_statement', now() - interval '30 days'),
    ('${DOC.legacyNew}', 'tender', '${T.open}', 'tenders/dv/l2.xlsx', 'ВОР ОВ изм.1.xlsx', 'vor_statement', now() - interval '9 days'),
    ('${DOC.split}', 'tender', '${T.open}', 'tenders/dv/s.xlsx', 'ВОР ОВ кладовые.xlsx', 'vor_statement', now() - interval '25 days'),
    ('${DOC.other}', 'tender', '${T.other}', 'tenders/dv/o.xlsx', 'ВОР кровля.xlsx', 'vor_statement', now() - interval '5 days');
  -- Снабжение: список ВОР ОВ переведён с прежнего файла на новый — прежние ушли в prior_document_ids (триггер 20261029).
  insert into public.tender_supply_sources (tender_id, estimate_name, source, s3_document_id, file_name, positions)
    values ('${T.open}', 'ВОР ОВ', 'vor_file', '${DOC.legacy}', 'ВОР ОВ.xlsx', '[{"name": "Труба", "unit": "м"}]'::jsonb);
  update public.tender_supply_sources set s3_document_id = '${DOC.split}' where tender_id = '${T.open}';
  update public.tender_supply_sources set s3_document_id = '${DOC.legacyNew}' where tender_id = '${T.open}';
  -- Разбор службы — для «прежней версии» в изменениях ведомости.
  insert into osp_private.bid_vor_files (s3_document_id, tender_id, source_version, status, positions) values
    ('${DOC.v1}', '${T.open}', 'v1', 'ok', '[{"k": "plita", "name": "Плита", "unit": "м2", "volume": 10}]'::jsonb),
    ('${DOC.v2}', '${T.open}', 'v2', 'ok', '[{"k": "plita", "name": "Плита", "unit": "м2", "volume": 12}]'::jsonb);`

describe('Версии файлов — база Яндекса (копия прода)', { skip: skipReason({ needCopy: true }), timeout: 40 * 60 * 1000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`, { appName: 'osp-test' })
  const superseded = (uid) => as(uid, `select coalesce(string_agg(file_id || '>' || current_file_id, ',' order by file_id), '') from public.bid_vor_superseded('${T.open}')`)
  const positions = (uid) => as(uid, `select coalesce(string_agg(file_id::text, ',' order by file_id), '') from public.bid_positions('${T.open}')`).split(',').filter(Boolean)
  const setGroup = (doc, group) => internal(`update public.s3_documents set version_group_id = ${group ? `'${group}'` : 'null'} where id = '${doc}'`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-doc-versions-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 30 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK (групп ещё нет)', () => {
    const out = internal(fs.readFileSync(file('yandex', `${NAME}.check.sql`), 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 9, out)
  })

  it('без групп — как до миграции: прежние файлы по отметке снабжения скрыты', () => {
    assert.equal(superseded(U.alpha), [`${DOC.legacy}>${DOC.legacyNew}`, `${DOC.split}>${DOC.legacyNew}`].sort().join(','))
  })

  it('в одной группе — только файлы одного списка: другой тендер или раздел — отказ базы', () => {
    setGroup(DOC.v1, G.vor)
    assert.throws(() => setGroup(DOC.other, G.vor), /только у файлов одного списка/)
    assert.throws(() => internal(`insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category, version_group_id)
      values ('tender', '${T.open}', 'tenders/dv/rd.pdf', 'РД.pdf', 'rd', '${G.vor}')`), /только у файлов одного списка/)
    assert.equal(internal(`select version_group_id from public.s3_documents where id = '${DOC.other}'`), '')
  })

  it('версии ведомости: подрядчику — только текущая; к прежней расценку не приложить; сотруднику — та же пара', () => {
    setGroup(DOC.v2, G.vor)
    assert.match(superseded(U.alpha), new RegExp(`${DOC.v1}>${DOC.v2}`))
    assert.match(superseded(U.engineer), new RegExp(`${DOC.v1}>${DOC.v2}`))
    assert.deepEqual(positions(U.alpha).sort(), [DOC.v2, DOC.k2, DOC.legacyNew].sort())
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.open}', '${DOC.v1}')`), /заменил эту ведомость новой версией/)
    assert.equal(as(U.alpha, `select vor_name from public.bid_file_target('${T.open}', '${DOC.v2}')`), 'ВОР фасад 2026-11-20')
  })

  it('изменения ведомости: прежняя версия — из группы (снабжение о ней не знает)', () => {
    const row = as(U.alpha, `select prior_id || '|' || (positions->0->>'volume') from public.bid_vor_changes('${T.open}') where file_id = '${DOC.v2}'`)
    assert.equal(row, `${DOC.v1}|10`)
  })

  it('связь версий главнее отметки снабжения: файл, который сделали самостоятельным, подрядчику виден; без группы — скрыт, как прежде', () => {
    setGroup(DOC.split, G.lone)
    const sup = superseded(U.alpha)
    assert.doesNotMatch(sup, new RegExp(`${DOC.split}>`))
    assert.match(sup, new RegExp(`${DOC.legacy}>${DOC.legacyNew}`))
    assert.ok(positions(U.alpha).includes(DOC.split))
  })

  it('удалили текущую версию — прежняя снова видна: без ведомости подрядчик не остаётся', () => {
    internal(`delete from public.s3_documents where id = '${DOC.v2}'`)
    assert.doesNotMatch(superseded(U.alpha), new RegExp(`${DOC.v1}>`))
    assert.ok(positions(U.alpha).includes(DOC.v1))
    assert.equal(as(U.alpha, `select vor_name from public.bid_file_target('${T.open}', '${DOC.v1}')`), 'ВОР фасад 2026-10-09')
  })

  it('запись под токеном (как osp-api): группа у файла без группы и вставка версии проходят правила строк и проверку; подрядчику — нет', () => {
    const fresh = id(48)
    const g = id(53)
    internal(`insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at)
      values ('${fresh}', 'tender', '${T.open}', 'tenders/dv/f1.xlsx', 'ВОР лифты.xlsx', 'vor_statement', now() - interval '1 day')`)
    // Подрядчик строку файла видит, но менять не может (правила строк): группа не меняется.
    try { as(U.alpha, `update public.s3_documents set version_group_id = '${g}' where id = '${fresh}'`) } catch { /* отказ — тоже годится */ }
    assert.equal(internal(`select coalesce(version_group_id::text, '') from public.s3_documents where id = '${fresh}'`), '')
    // Сотрудник: как ensureVersionGroup — только пока группы нет; затем вставка новой версии с группой (confirm).
    as(U.admin, `update public.s3_documents set version_group_id = '${g}' where id = '${fresh}' and version_group_id is null`)
    as(U.admin, `update public.s3_documents set version_group_id = '${id(54)}' where id = '${fresh}' and version_group_id is null`)
    assert.equal(internal(`select version_group_id from public.s3_documents where id = '${fresh}'`), g, 'вторая — без изменений')
    as(U.admin, `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, version_group_id)
      values ('${id(49)}', 'tender', '${T.open}', 'tenders/dv/f2.xlsx', 'ВОР лифты изм.1.xlsx', 'vor_statement', '${g}')`)
    assert.match(superseded(U.alpha), new RegExp(`${fresh}>${id(49)}`))
    // Страж строки файла (20270120) пропускает группу версий, но не прочее: владельца и раздел под токеном не сменить.
    assert.throws(() => as(U.admin, `update public.s3_documents set doc_category = 'rd' where id = '${fresh}'`), /можно изменить только имя и описание/)
    assert.throws(() => as(U.admin, `insert into public.s3_documents (owner_type, owner_id, s3_key, file_name, doc_category, version_group_id)
      values ('tender', '${T.other}', 'tenders/dv/f3.xlsx', 'Чужой.xlsx', 'vor_statement', '${g}')`), /только у файлов одного списка/,
    'другой тендер — отказ и под токеном')
  })

  it('откат: колонки нет, функции прежние — отметка снабжения работает', () => {
    // Повтор безопасен — дважды.
    for (let i = 0; i < 2; i++) db.sql(null, { file: file('rollback', `${NAME}_rollback.sql`) })
    assert.equal(internal(`select count(*) from information_schema.columns where table_name = 's3_documents' and column_name = 'version_group_id'`), '0')
    assert.equal(superseded(U.alpha), [`${DOC.legacy}>${DOC.legacyNew}`, `${DOC.split}>${DOC.legacyNew}`].sort().join(','))
    assert.equal(as(U.alpha, `select count(*) from public.bid_vor_changes('${T.open}')`) > '0', true)
  })
})
