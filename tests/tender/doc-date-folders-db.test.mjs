// Миграция 20270220_s3_documents_folder_date (19.11.2026): папка с датой, куда файл положили явно (S3DocumentList с dateFolders,
// «Должная осмотрительность»). Слепок схемы прода (Supabase): проверка для прода до миграции — FAIL, а не ошибка, после — OK;
// день папки пишется и читается, раньше 2000 года — нельзя; повтор и откат безопасны. Копия прода как база Яндекса — настоящий
// migrate.sh с проверкой прав и .check.sql, запись дня папки под учёткой-владельцем. Нужны Docker и psql. Страница —
// doc-date-folders.test.mjs, сервер — tests/osp-api/server.test.mjs («папка с датой»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20270220_s3_documents_folder_date'
const file = (...p) => path.join(ROOT, ...p)
const SB = (name) => file('supabase', 'migrations', `${name}.sql`)
const YA = file('migration', 'yandex', `${NAME}.sql`)
const YA_CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const CHECK = file('migration', 'backup', 'checks', '20270220.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

const CP = '00000000-0000-4000-8000-00000000f001'
const DOC = '00000000-0000-4000-8000-00000000f101'
const SEED = `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category, created_at)
  values ('${DOC}', 'counterparty', '${CP}', 'counterparties/${CP}/f101-a.pdf', 'Выписка.pdf', 'other', '2026-11-19T07:00:00Z')`

describe('20270220 (папка с датой): файлы', () => {
  const body = (text) => text
    .split('\n').filter((l) => !/^\s*--/.test(l) && !/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout|NOTIFY pgrst)\b/.test(l)).join('\n').trim()

  it('тело одно в обеих базах; в базе Яндекса транзакцию задаёт migrate.sh; данные не меняются', () => {
    assert.equal(body(read(YA)), body(read(SB(NAME))))
    assert.doesNotMatch(read(YA), /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(read(YA), /\b(UPDATE|INSERT|DELETE)\b/i, 'колонка у всех пустая — прежние файлы в своих папках')
  })

  it('в списке кандидатов проверки прав', () => {
    assert.match(read(file('tests', 'db', 'baseline', 'candidate-migrations.txt')), new RegExp(`^${NAME}\\.sql$`, 'm'))
  })
})

describe('20270220 (папка с датой): база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: SB(m.replace(/\.sql$/, '')) })
    sql(SEED)
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    psqlAt(db.port, null, { file: SB(NAME) })
  })
  after(() => db?.stop())

  it('проверка для прода: до миграции — FAIL, а не ошибка; после — все OK', () => {
    assert.match(checkBefore, /^FAIL /m)
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 3, out)
  })

  it('прежний файл — без дня папки; день пишется, раньше 2000 года — нельзя', () => {
    assert.equal(sql(`select coalesce(folder_date::text, '-') from public.s3_documents where id = '${DOC}'`), '-')
    assert.equal(sql(`update public.s3_documents set folder_date = '2025-03-14' where id = '${DOC}' returning folder_date`), '2025-03-14')
    assert.throws(() => sql(`update public.s3_documents set folder_date = '1999-12-31' where id = '${DOC}'`), /s3_documents_folder_date_sane/)
  })

  it('повтор безопасен; откат убирает колонку, файл остаётся; после отката проверка — FAIL', () => {
    psqlAt(db.port, null, { file: SB(NAME) })
    assert.equal(sql(`select folder_date from public.s3_documents where id = '${DOC}'`), '2025-03-14', 'повтор не стирает дни')
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 's3_documents' and column_name = 'folder_date'`), '0')
    assert.equal(sql(`select file_name from public.s3_documents where id = '${DOC}'`), 'Выписка.pdf')
    assert.match(psqlAt(db.port, null, { file: CHECK }), /^FAIL /m)
  })
})

describe('20270220 (папка с датой) — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-folder-date-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [file('migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    applied = res.stdout
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('применена с проверкой прав; её проверка на копии — все OK; дни папок пусты у всех', () => {
    assert.match(applied, new RegExp(`OK ${NAME}: применена`))
    const out = internal(read(YA_CHECK))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 4, out)
  })

  it('день папки пишется под учёткой-владельцем (FORCE RLS, триггеры базы Яндекса)', () => {
    internal(SEED)
    assert.equal(internal(`update public.s3_documents set folder_date = '2025-03-14' where id = '${DOC}' returning folder_date`), '2025-03-14')
  })
})
