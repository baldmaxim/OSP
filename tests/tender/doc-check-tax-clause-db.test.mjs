// Заявки на проверку ДП/ДС: «Проверки документов (исключение налоговой оговорки)» нет и в базе (миграция 20270202). На проде
// 12.11.2026 в статусе tax_clause было 106 заявок — массовая копия заявок из «Завершено»: копия с оригиналом уходит в
// «Удалённые» (статус «Завершено», запись о дубле), без оригинала — в «Завершено» вниз колонки, удалённая — только статус;
// затем статус исключается из списка. Первый блок — файлы: тела миграций обеих баз совпадают. Второй — слепок схемы прода
// (Supabase): что с какой заявкой, updated_at не сдвинут, другие колонки не тронуты, проверка для прода, повтор, откат.
// Третий — копия прода как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав и .check.sql). Нужны Docker и psql.
// Страница — doc-check-board.test.mjs (колонки «Проверка документов» нет).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'
import { candidateMigrations } from '../db/lib/rights.mjs'

const NAME = '20270202_doc_check_tax_clause_remove'
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations')
const MIGRATION = path.join(MIGRATIONS, `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270202.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)
const BOARD = path.join(MIGRATIONS, '20261113_doc_check_board.sql')
const WHO = 'Исправление данных 12.11.2026 (миграция 20270202)'

const id = (n) => `00000000-0000-4000-8000-0000000df${String(n).padStart(3, '0')}`
const R = {
  orig1: id(1), copy1: id(2),       // копия слово в слово
  orig2: id(3), copy2: id(4),       // у копии другие исполнители — текст до «Исполнители» тот же
  near: id(5), lone: id(6),         // «почти оригинал» с другим номером: у копии оригинала нет — в «Завершено»
  gone: id(7), copyGone: id(8),     // оригинал удалён — копия не дубль, в «Завершено»
  deleted: id(9),                   // уже удалённая заявка в статусе — только статус
  work: id(10), done: id(11),       // другие колонки — не трогаются
}
const SEED = `
  insert into public.doc_check_requests (id, doc_type, doc_number, status, notes, sort_order, created_at, updated_at, deleted_at, created_by_name) values
    ('${R.orig1}', 'ds', '3', 'done', 'ТС ИНЖИНИРИНГ / ДС№3 Исполнители: юрист', 7, '2026-03-03T06:02:00Z', '2026-05-01T10:00:00Z', null, 'Импорт'),
    ('${R.copy1}', 'ds', '3', 'tax_clause', 'ТС ИНЖИНИРИНГ / ДС№3 Исполнители: юрист', 30, '2026-04-07T07:16:00Z', '2026-05-02T10:00:00Z', null, 'Импорт'),
    ('${R.orig2}', 'dp', 'СУ2-007', 'done', 'ООО «Пример»/ ДП № СУ2-007 Исполнители: первый', 5, '2026-03-04T06:02:00Z', '2026-05-03T10:00:00Z', null, 'Импорт'),
    ('${R.copy2}', 'dp', 'СУ2-007', 'tax_clause', 'ООО «Пример»/ ДП № СУ2-007 Исполнители: первый, второй', 29, '2026-04-07T07:16:00Z', '2026-05-04T10:00:00Z', null, 'Импорт'),
    ('${R.near}', 'ds', '4', 'done', 'ИП Иванов / ДС № 4', 3, '2026-03-05T06:02:00Z', '2026-05-05T10:00:00Z', null, 'Импорт'),
    ('${R.lone}', 'ds', '5', 'tax_clause', 'ИП Иванов / ДС № 4', 28, '2026-04-07T07:16:00Z', '2026-05-06T10:00:00Z', null, 'Импорт'),
    ('${R.gone}', 'ds', '1', 'done', 'ООО Альфа / ДС1', 2, '2026-03-06T06:02:00Z', '2026-05-07T10:00:00Z', '2026-06-01T10:00:00Z', 'Импорт'),
    ('${R.copyGone}', 'ds', '1', 'tax_clause', 'ООО Альфа / ДС1', 27, '2026-04-07T07:16:00Z', '2026-05-08T10:00:00Z', null, 'Импорт'),
    ('${R.deleted}', 'ds', '9', 'tax_clause', 'ООО Бета / ДС9', 26, '2026-04-07T07:16:00Z', '2026-05-09T10:00:00Z', '2026-06-02T10:00:00Z', 'Импорт'),
    ('${R.work}', 'ds', '3', 'in_progress', 'ТС ИНЖИНИРИНГ / ДС№3 Исполнители: юрист', 1, '2026-05-01T06:02:00Z', '2026-05-10T10:00:00Z', null, 'Импорт'),
    ('${R.done}', 'dp', '77', 'done', 'ООО Гамма / ДП 77', 4, '2026-03-07T06:02:00Z', '2026-05-11T10:00:00Z', null, 'Импорт');`
const ALL = Object.values(R).map((x) => `'${x}'`).join(',')
const STATE = `select string_agg(right(id::text, 3) || '=' || status || case when deleted_at is null then '' else '/del' end
  || ':' || sort_order, ' ' order by id) from public.doc_check_requests where id in (${ALL})`
const STAMPS = `select string_agg(to_char(updated_at at time zone 'UTC', 'MM-DD HH24'), ' ' order by id)
  from public.doc_check_requests where id in (${ALL})`
const BEFORE_STAMPS = '05-01 10 05-02 10 05-03 10 05-04 10 05-05 10 05-06 10 05-07 10 05-08 10 05-09 10 05-10 10 05-11 10'

describe('«Проверка документов» убрана из базы: файлы', () => {
  it('тело миграции в обеих базах одно; в файле базы Яндекса нет BEGIN/COMMIT', () => {
    const body = (file) => {
      const text = fs.readFileSync(file, 'utf8').replace(/\nCOMMIT;\s*$/, '').trimEnd()
      return text.slice(text.indexOf('DO $$'))
    }
    assert.equal(body(YANDEX), body(MIGRATION))
    assert.doesNotMatch(fs.readFileSync(YANDEX, 'utf8'), /^\s*(BEGIN|COMMIT)\s*;/m, 'транзакцию задаёт migrate.sh')
  })
})

describe('«Проверка документов» убрана из базы: слепок', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(MIGRATIONS, m) })
    for (const m of candidateMigrations()) {
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    psqlAt(db.port, null, { file: BOARD })   // статус tax_clause и колонки доски, как на проде
    sql(SEED)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL заявок со статусом/m)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
    assert.match(out, /^OK дубли — в «Удалённых» со статусом «Завершено»: 2$/m)
  })

  it('копии с оригиналом — в «Удалённых»; без оригинала — в «Завершено» вниз колонки; удалённая — только статус; другие не тронуты', () => {
    // Низ «Завершено» до миграции — 3 (near); в «Завершено» встали lone (2) и copyGone (1) в прежнем порядке (28 выше 27).
    assert.equal(sql(STATE), [
      '001=done:7', '002=done/del:30', '003=done:5', '004=done/del:29', '005=done:3', '006=done:2',
      '007=done/del:2', '008=done:1', '009=done/del:26', '010=in_progress:1', '011=done:4',
    ].join(' '))
    assert.equal(sql(STAMPS), BEFORE_STAMPS, 'updated_at не сдвинут')
    assert.equal(sql(`select count(*) from public.doc_check_requests where status = 'tax_clause'`), '0')
  })

  it('история: у дубля — «Удалена как дубль», у перенесённой и удалённой — смена статуса', () => {
    const log = (rid) => sql(`select string_agg(event_type || '|' || coalesce(old_value #>> '{}', '') || '|' || coalesce(new_value #>> '{}', '')
      || '|' || coalesce(description, ''), ' ;; ' order by changed_at, id)
      from public.doc_check_request_audit_log where request_id = '${rid}' and changed_by_name = '${WHO}'`)
    assert.match(log(R.copy1), /^soft_deleted\|\|\|Удалена как дубль заявки (ID \d+|от 03\.03\.2026) \(она в колонке «Завершено»\): копия стояла в колонке «Проверка документов/)
    assert.match(log(R.copy2), /^soft_deleted\|\|\|Удалена как дубль/)
    assert.match(log(R.lone), /^status_changed\|tax_clause\|done\|Колонка «Проверка документов \(исключение налоговой оговорки\)» убрана с доски — заявка перенесена в «Завершено»$/)
    assert.match(log(R.copyGone), /^status_changed\|tax_clause\|done\|/)
    assert.match(log(R.deleted), /^status_changed\|tax_clause\|done\|Колонка .* убрана с доски$/)
    assert.equal(log(R.work), '')
    assert.equal(log(R.orig1), '')
  })

  it('статус tax_clause больше не записать; повтор миграции ничего не меняет', () => {
    assert.throws(() => sql(`update public.doc_check_requests set status = 'tax_clause' where id = '${R.done}'`), /doc_check_requests_status_check/)
    const state = sql(STATE)
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql(STATE), state)
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where changed_by_name = '${WHO}'`), '5')
  })

  it('триггер updated_at после миграции работает', () => {
    assert.equal(sql(`update public.doc_check_requests set notes = 'x' where id = '${R.done}' returning updated_at > '2026-06-01'`), 't')
  })

  it('откат: заявки снова в статусе, дубли — на доске; повтор отката безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select string_agg(right(id::text, 3) || '=' || status || case when deleted_at is null then '' else '/del' end, ' ' order by id)
      from public.doc_check_requests where id in ('${R.copy1}', '${R.copy2}', '${R.lone}', '${R.copyGone}', '${R.deleted}', '${R.work}')`),
    '002=tax_clause 004=tax_clause 006=tax_clause 008=tax_clause 009=tax_clause/del 010=in_progress')
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where changed_by_name = 'Откат миграции 20270202'`), '5')
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
  })
})

describe('«Проверка документов» убрана — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-tax-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK; статус tax_clause не записать', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    assert.throws(() => internal(`insert into public.doc_check_requests (doc_type, status, created_by_name) values ('ds', 'tax_clause', 'Тест')`),
      /doc_check_requests_status_check/)
  })
})
