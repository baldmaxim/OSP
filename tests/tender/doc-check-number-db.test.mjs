// Заявки на проверку ДП/ДС: постоянный номер заявки — «ID» (миграция 20270123). Первый блок — файлы: тела миграций обеих баз
// совпадают, миграция — в кандидатах проверки прав. Второй — слепок схемы прода (Supabase): прежним заявкам номера по порядку
// создания (не удалённые — первыми), updated_at при нумерации не меняется (по нему уведомления считают заявку свежей),
// триггер updated_at снова работает, новая заявка — следующий номер, задать номер нельзя, повтор безопасен, откат. Третий —
// копия прода как база Яндекса (одна учётка, настоящий migrate.sh с проверкой прав и .check.sql). Нужны Docker и psql.
// Страница — doc-check-board.test.mjs («номер заявки (ID)»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20270123_doc_check_request_number'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20270123.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

// Заявки вперемешку: порядок вставки не совпадает с порядком создания, одна удалена, у двух одно время (тогда — по id).
const R = {
  a: '00000000-0000-4000-8000-0000000dd001',
  b: '00000000-0000-4000-8000-0000000dd002',
  c: '00000000-0000-4000-8000-0000000dd003',
  d: '00000000-0000-4000-8000-0000000dd004',
  gone: '00000000-0000-4000-8000-0000000dd005',
}
const SEED = `
  insert into public.doc_check_requests (id, doc_type, created_by_name, created_at, updated_at, deleted_at) values
    ('${R.c}', 'ds', 'Импорт', '2026-04-07T09:00:00Z', '2026-05-01T10:00:00Z', null),
    ('${R.gone}', 'ds', 'Импорт', '2026-03-01T09:00:00Z', '2026-05-02T10:00:00Z', '2026-05-03T10:00:00Z'),
    ('${R.a}', 'dp', 'Импорт', '2026-03-03T05:59:54Z', '2026-05-04T10:00:00Z', null),
    ('${R.d}', 'ds', 'Импорт', '2026-04-07T09:00:00Z', '2026-05-05T10:00:00Z', null),
    ('${R.b}', 'ds', 'Импорт', '2026-03-10T09:00:00Z', '2026-05-06T10:00:00Z', null);`
const NUMBERS = `select string_agg(right(id::text, 4) || '=' || request_number, ' ' order by request_number)
  from public.doc_check_requests where id in (${Object.values(R).map((id) => `'${id}'`).join(',')})`
const STAMPS = `select string_agg(right(id::text, 4) || '=' || to_char(updated_at at time zone 'UTC', 'MM-DD HH24'), ' ' order by id)
  from public.doc_check_requests where id in (${Object.values(R).map((id) => `'${id}'`).join(',')})`
const EXPECTED = 'd001=1 d002=2 d003=3 d004=4 d005=5'

describe('Номер заявки на проверку: файлы', () => {
  it('тело миграции в обеих базах одно; миграция — в списке кандидатов проверки прав', () => {
    const body = (file) => {
      const text = fs.readFileSync(file, 'utf8').replace(/\nCOMMIT;\s*$/, '').trimEnd()
      return text.slice(text.indexOf('ALTER TABLE public.doc_check_requests ADD COLUMN'))
    }
    assert.equal(body(YANDEX), body(MIGRATION))
    assert.doesNotMatch(fs.readFileSync(YANDEX, 'utf8'), /^\s*(BEGIN|COMMIT)\s*;/m, 'транзакцию задаёт migrate.sh')
    assert.match(fs.readFileSync(path.join(ROOT, 'tests', 'db', 'baseline', 'candidate-migrations.txt'), 'utf8'), new RegExp(`^${NAME}\\.sql$`, 'm'))
  })
})

describe('Номер заявки на проверку: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    for (const m of ['20261113_doc_check_board.sql', '20261124_doc_check_card.sql']) {
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    }
    sql(SEED)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 6, out)
  })

  it('прежним — по порядку создания, удалённые — после; updated_at не сдвинулся', () => {
    assert.equal(sql(NUMBERS), EXPECTED)
    assert.equal(sql(STAMPS), 'd001=05-04 10 d002=05-06 10 d003=05-01 10 d004=05-05 10 d005=05-02 10')
  })

  it('триггер updated_at снова работает; новая заявка — следующий номер; задать или сменить номер нельзя', () => {
    assert.equal(sql(`update public.doc_check_requests set notes = 'x' where id = '${R.a}' returning updated_at > '2026-06-01'`), 't')
    assert.equal(sql(`insert into public.doc_check_requests (doc_type, created_by_name) values ('ds', 'Новая') returning request_number`), '6')
    assert.throws(() => sql(`insert into public.doc_check_requests (doc_type, created_by_name, request_number) values ('ds', 'x', 99)`),
      /GENERATED ALWAYS|cannot insert a non-DEFAULT value/)
    assert.throws(() => sql(`update public.doc_check_requests set request_number = 77 where id = '${R.b}'`), /can only be updated to DEFAULT/)
  })

  it('повтор безопасен: номера и счётчик на месте', () => {
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(sql(NUMBERS), EXPECTED)
    assert.equal(sql(`insert into public.doc_check_requests (doc_type, created_by_name) values ('ds', 'Ещё') returning request_number`), '7')
  })

  it('откат: колонки нет, заявки на месте; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'doc_check_requests' and column_name = 'request_number'`), '0')
    assert.equal(sql(`select count(*) from public.doc_check_requests where id in (${Object.values(R).map((id) => `'${id}'`).join(',')})`), '5')
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Номер заявки на проверку — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-dc-number-'))
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

  it('проверка миграции на копии: все OK; у каждой заявки копии — номер, без повторов', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 7, out)
    assert.equal(internal(`select count(*) = count(distinct request_number) and count(*) filter (where request_number is null) = 0
      from public.doc_check_requests`), 't')
  })
})
