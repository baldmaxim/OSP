// Свой ВОР подрядчика с расценками (миграция 20270113, только база Яндекса; решение пользователя 11.11.2026) — копия прода под одной
// учёткой, настоящий migrate.sh с проверкой прав. Функции службы (маршрут /api/fn/bid-file) под входом вошедшего:
//   • куда можно приложить файл: Excel-файл ВОР этого тендера, тендер открыт, организация — участник или заявка не отклонена;
//   • запись: ключ — только в каталоге своей организации и тендера, новый файл к той же ведомости заменяет прежний (служба получает
//     прежний ключ, чтобы убрать объект), сводка — только объект JSON;
//   • убрать — своё и пока идёт приём; скачать — своя организация и администратор;
//   • таблицу читают своя организация и администратор, записи через правила нет; сводка администратора — и с организациями,
//     которые только загрузили файлы; откат — функций нет, данные на месте.
// Страница — contractor-cabinet.test.mjs (стенд bidFiles=1), маршрут — tests/osp-api/db-gateway.test.mjs. Нужны Docker, psql и
// проверенная копия прода (migration/dumps).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSingleOwner, latestVerifiedCopy } from '../db/lib/stand.mjs'

const NAME = '20270113_bid_vor_files'
const CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const id = (n) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, '0')}`
const U = { admin: id(1), alpha: id(2), beta: id(3), engineer: id(4) } // engineer — сотрудник (юрист)
const CP = { alpha: id(11), beta: id(12) }
const OBJ = id(21)
const T = { open: id(31), done: id(32), other: id(33) }
const DOC = { vor1: id(41), vor2: id(42), rd: id(43), vorOther: id(44), vorDone: id(45) }

const SEED = `
  insert into auth.users (id, aud, role, email) select u, 'authenticated', 'authenticated', u || '@example.invalid'
    from unnest(array['${U.admin}', '${U.alpha}', '${U.beta}', '${U.engineer}']::uuid[]) u;
  insert into public.counterparties (id, name, inn) values ('${CP.alpha}', 'ООО Альфа ВОР', '7707083893'), ('${CP.beta}', 'ООО Бета ВОР', '7736050003');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.admin}', 'admin', true, false, 'Админов', 'admin@example.invalid', null),
    ('${U.alpha}', 'contractor', true, false, 'Альфин А. А.', 'alpha@example.invalid', '${CP.alpha}'),
    ('${U.beta}', 'contractor', true, false, 'Бетин Б. Б.', 'beta@example.invalid', '${CP.beta}'),
    ('${U.engineer}', 'lawyer', true, false, 'Юристов', 'eng@example.invalid', null);
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Корпуса', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number) values
    ('${T.open}', 'Открытый, два корпуса', '${OBJ}', 'Идет тендерная процедура', 99131),
    ('${T.done}', 'Завершённый', '${OBJ}', 'Завершен', 99132),
    ('${T.other}', 'Открытый, без доступа', '${OBJ}', 'Идет тендерная процедура', 99133);
  insert into public.tender_counterparties (tender_id, counterparty_id, status) values
    ('${T.open}', '${CP.alpha}', 'request_sent'), ('${T.done}', '${CP.alpha}', 'proposal_provided');
  insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category) values
    ('${DOC.vor1}', 'tender', '${T.open}', 'tenders/bvf/k1.xlsx', 'ВОР корпус 1.xlsx', 'vor_statement'),
    ('${DOC.vor2}', 'tender', '${T.open}', 'tenders/bvf/k2.xlsx', 'ВОР корпус 2.xlsx', 'vor'),
    ('${DOC.rd}', 'tender', '${T.open}', 'tenders/bvf/rd.pdf', 'РД КЖ.pdf', 'rd'),
    ('${DOC.vorOther}', 'tender', '${T.other}', 'tenders/bvf/other.xlsx', 'ВОР.xlsx', 'vor_statement'),
    ('${DOC.vorDone}', 'tender', '${T.done}', 'tenders/bvf/done.xlsx', 'ВОР.xlsx', 'vor_statement');`

const SUMMARY = JSON.stringify({ v: 1, materials: 100, works: 50, total: 150, items: { material: 2, work: 2 }, priced: { material: 2, work: 1 } })
const key = (tender, cp, op) => `bids/${tender}/${cp}/${op}-vor.xlsx`

describe('Свой ВОР подрядчика с расценками: база Яндекса (копия прода под одной учёткой)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const claims = (o) => JSON.stringify(o).replace(/'/g, "''")
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (uid, text) => db.sql(`begin;
      set local "request.jwt.claims" = '${claims({ sub: uid, role: db.owner, osp_role: 'authenticated', email: 't@example.invalid' })}';
      ${text};
      commit;`, { appName: 'osp-test' })
  const save = (uid, tender, vor, s3Key, summary = SUMMARY) => as(uid, `select coalesce(public.bid_file_save('${tender}', '${vor}', '${s3Key}',
    'ВОР Альфа.xlsx', 'application/vnd.ms-excel', 1234, '${summary}'::jsonb), '<null>')`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-bid-files-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 25 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, (res.stdout + res.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'))
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
  })

  it('куда можно приложить файл: Excel-файл ВОР открытого тендера с доступом; РД, чужой тендер, сотрудник — отказ', () => {
    assert.equal(as(U.alpha, `select counterparty_id || '|' || vor_name from public.bid_file_target('${T.open}', '${DOC.vor1}')`), `${CP.alpha}|ВОР корпус 1`)
    assert.equal(as(U.alpha, `select vor_name from public.bid_file_target('${T.open}', '${DOC.vor2}')`), 'ВОР корпус 2', 'и категория «ВОР и РД»')
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.open}', '${DOC.rd}')`), /Такой ведомости в тендере нет/)
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.open}', '${DOC.vorOther}')`), /Такой ведомости в тендере нет/, 'ВОР другого тендера')
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.other}', '${DOC.vorOther}')`), /приём предложений.*закрыт или заявка не подана/i)
    assert.throws(() => as(U.alpha, `select * from public.bid_file_target('${T.done}', '${DOC.vorDone}')`), /закрыт/, 'тендер завершён')
    assert.throws(() => as(U.beta, `select * from public.bid_file_target('${T.open}', '${DOC.vor1}')`), /закрыт или заявка не подана/, 'без заявки')
    assert.throws(() => as(U.engineer, `select * from public.bid_file_target('${T.open}', '${DOC.vor1}')`), /загружает подрядчик/)
  })

  it('запись: ключ только в своём каталоге, новый файл ведомости заменяет прежний; сводка — объект', () => {
    const k1 = key(T.open, CP.alpha, 'op1')
    const k2 = key(T.open, CP.alpha, 'op2')
    assert.equal(save(U.alpha, T.open, DOC.vor1, k1), '<null>', 'первый файл — прежнего нет')
    assert.equal(save(U.alpha, T.open, DOC.vor1, k1), '<null>', 'повтор с тем же ключом — тот же файл')
    assert.equal(save(U.alpha, T.open, DOC.vor1, k2), k1, 'прежний ключ — службе на удаление')
    assert.equal(internal(`select count(*) || '|' || max(s3_key) || '|' || max(vor_name) || '|' || max(uploaded_by_name) || '|' || max((summary->>'total'))
      from public.tender_bid_files where tender_id = '${T.open}' and counterparty_id = '${CP.alpha}' and vor_file_id = '${DOC.vor1}'`),
    `1|${k2}|ВОР корпус 1|Альфин А. А.|150`)
    assert.throws(() => save(U.alpha, T.open, DOC.vor1, key(T.open, CP.beta, 'op3')), /Неверный ключ файла/, 'каталог чужой организации')
    assert.throws(() => save(U.alpha, T.open, DOC.vor1, key(T.other, CP.alpha, 'op3')), /Неверный ключ файла/, 'каталог другого тендера')
    assert.throws(() => save(U.alpha, T.open, DOC.vor1, `bids/${T.open}/${CP.alpha}/../x`), /Неверный ключ файла/)
    assert.throws(() => save(U.alpha, T.open, DOC.vor1, key(T.open, CP.alpha, 'op4'), '[1,2]'), /Неверная сводка/)
    assert.throws(() => save(U.beta, T.open, DOC.vor1, key(T.open, CP.beta, 'op5')), /закрыт или заявка не подана/)
    save(U.alpha, T.open, DOC.vor2, key(T.open, CP.alpha, 'op6'))
  })

  it('чтение: своя организация и администратор; сотрудник и чужая организация — ни строки; записи через правила нет', () => {
    assert.equal(as(U.alpha, `select count(*) from public.tender_bid_files`), '2')
    assert.equal(as(U.admin, `select count(*) from public.tender_bid_files where tender_id = '${T.open}'`), '2')
    assert.equal(as(U.beta, `select count(*) from public.tender_bid_files`), '0')
    assert.equal(as(U.engineer, `select count(*) from public.tender_bid_files`), '0')
    assert.throws(() => as(U.alpha, `insert into public.tender_bid_files (tender_id, counterparty_id, vor_file_id, vor_name, s3_key, file_name, size_bytes)
      values ('${T.open}', '${CP.alpha}', '${DOC.rd}', 'x', 'bids/x/y/z', 'x.xlsx', 1)`), /row-level security|permission denied/)
    assert.equal(as(U.alpha, `update public.tender_bid_files set summary = '{"total": 1}'::jsonb returning 1`), '', 'правка не задела строк')
    assert.equal(as(U.alpha, `delete from public.tender_bid_files returning 1`), '', 'удаление не задело строк')
    assert.equal(internal(`select count(*) from public.tender_bid_files where (summary->>'total')::numeric = 150`), '2')
  })

  it('скачать — своя организация и администратор; убрать — своё и пока идёт приём', () => {
    const fileId = internal(`select id from public.tender_bid_files where vor_file_id = '${DOC.vor2}'`)
    assert.equal(as(U.alpha, `select s3_key from public.bid_file_get('${fileId}')`), key(T.open, CP.alpha, 'op6'))
    assert.equal(as(U.admin, `select file_name from public.bid_file_get('${fileId}')`), 'ВОР Альфа.xlsx')
    assert.equal(as(U.beta, `select count(*) from public.bid_file_get('${fileId}')`), '0')
    assert.equal(as(U.engineer, `select count(*) from public.bid_file_get('${fileId}')`), '0')
    assert.equal(as(U.beta, `select coalesce(public.bid_file_remove('${fileId}'), '<null>')`), '<null>', 'чужой — как будто нет')
    assert.equal(as(U.alpha, `select public.bid_file_remove('${fileId}')`), key(T.open, CP.alpha, 'op6'))
    assert.equal(internal(`select count(*) from public.tender_bid_files where id = '${fileId}'`), '0')
    // Приём закрыт — убрать нельзя, скачать можно.
    internal(`insert into public.tender_bid_files (id, tender_id, counterparty_id, vor_file_id, vor_name, s3_key, file_name, size_bytes)
      values ('${id(91)}', '${T.done}', '${CP.alpha}', '${DOC.vorDone}', 'ВОР', '${key(T.done, CP.alpha, 'old')}', 'ВОР.xlsx', 10)`)
    assert.throws(() => as(U.alpha, `select public.bid_file_remove('${id(91)}')`), /закрыт/)
    assert.equal(as(U.alpha, `select file_name from public.bid_file_get('${id(91)}')`), 'ВОР.xlsx')
  })

  it('сводка администратора: организация только с файлами — в списке; подрядчику — отказ', () => {
    const row = as(U.admin, `select counterparty_name || '|' || coalesce(invite_status, '-') from public.bid_admin_overview()
      where tender_id = '${T.open}' and counterparty_id = '${CP.alpha}'`)
    assert.equal(row, 'ООО Альфа ВОР|request_sent')
    assert.throws(() => as(U.alpha, `select count(*) from public.bid_admin_overview()`), /только администратору/)
  })

  it('откат: функций и чтения нет, файлы на месте, сводка администратора работает; повтор безопасен', () => {
    const before = internal(`select count(*) from public.tender_bid_files`)
    for (let i = 0; i < 2; i++) db.sql(null, { file: ROLLBACK })
    assert.equal(internal(`select count(*) from pg_proc where proname like 'bid\\_file\\_%'`), '0')
    assert.equal(internal(`select count(*) from public.tender_bid_files`), before)
    assert.equal(as(U.alpha, `select count(*) from public.tender_bid_files`), '0')
    assert.match(as(U.admin, `select count(*) from public.bid_admin_overview()`), /^\d+$/)
  })
})
