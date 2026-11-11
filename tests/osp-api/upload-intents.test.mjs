// Незавершённые загрузки файлов (server/osp-api/src/lib/uploadIntents.js, таблица из миграции 20270120) на настоящем
// PostgreSQL под одной учёткой (правила по строкам на владельце, пропуск служебных операций):
//   • выданная ссылка записывается; у пользователя за час — не больше 20 незавершённых и 2 ГБ заявленного, иначе отказ;
//     повтор того же ключа не считается вторым;
//   • подтверждение снимает запись;
//   • уборка: старше часа и без строки файла — объект удаляется; ставший файлом — только запись; свежие и чужие ключи бакета
//     не трогаются;
//   • нет таблицы (база раньше миграции) — без учёта, как раньше.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const depsOk = ['pg', '@aws-sdk/client-s3'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m)))
const skip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)'

const DB_PASSWORD = 'upload-intents-test-db-password'
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

// Таблица учёта — как в миграции 20270120 (тот же текст), s3_documents — только нужные колонки.
const migration = fs.readFileSync(path.join(ROOT, 'migration', 'yandex', '20270120_object_scope_files.sql'), 'utf8')
const intentsSql = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS osp_private.s3_upload_intents'),
  migration.indexOf('-- ── 5. Настройки разделов'))
const SETUP_SQL = `
create role intents_login login password '${DB_PASSWORD}';
grant create, connect on database psdc_test to intents_login;
grant create on schema public to intents_login;
set role intents_login;
${fs.readFileSync(path.join(ROOT, 'migration', 'target', 'compat', 'auth.sql'), 'utf8')}
create schema osp_private;
create function osp_private.bypass() returns boolean language sql stable
  as $$ select coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' or coalesce(auth.role(), '') = 'service_role' $$;
create table public.s3_documents (id uuid primary key default gen_random_uuid(), s3_key text unique not null);
alter table public.s3_documents enable row level security; alter table public.s3_documents force row level security;
create policy osp_internal on public.s3_documents for all to public using ((select osp_private.bypass())) with check ((select osp_private.bypass()));
${intentsSql}
`

describe('незавершённые загрузки на настоящей базе', { skip, timeout: 300000 }, () => {
  let pgdb
  let db
  let lib
  const s3 = { deleted: [], fail: false, send: async (cmd) => { if (s3.fail) throw new Error('s3 down'); s3.deleted.push(cmd.input.Key) } }
  const sql = (text) => pgdb.exec(`set role intents_login;\nset application_name = 'osp:internal';\n${text}`).trim().split('\n').filter(Boolean).at(-1) ?? ''

  before(async () => {
    pgdb = new TestDatabase()
    pgdb.start()
    pgdb.exec(SETUP_SQL)
    const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
    db = createDb({ url: `postgres://intents_login:${DB_PASSWORD}@127.0.0.1:${pgdb.port}/psdc_test`, poolMax: 2 })
    lib = await import(path.join(SERVER, 'src', 'lib', 'uploadIntents.js'))
  })
  after(async () => {
    await db?.close()
    pgdb?.stop()
  })

  it('предел на пользователя: 20 незавершённых; повтор ключа — не второй; чужие не считаются; подтверждение снимает запись', async () => {
    const intents = lib.createUploadIntents({ db })
    for (let i = 0; i < lib.INTENT_MAX_OPEN; i++) assert.equal(await intents.note(`tenders/t/${i}.pdf`, USER, 10), null, `ключ ${i}`)
    assert.equal(await intents.note('tenders/t/0.pdf', USER, 10), null, 'повтор того же ключа — та же запись')
    assert.match(await intents.note('tenders/t/21.pdf', USER, 10), /незавершённых загрузок/)
    assert.equal(await intents.note('tenders/t/other.pdf', OTHER, 10), null, 'у другого пользователя — свой счёт')
    await intents.drop('tenders/t/0.pdf')
    assert.equal(await intents.note('tenders/t/21.pdf', USER, 10), null, 'после подтверждения место освободилось')
    assert.match(await intents.note('tenders/t/big.pdf', OTHER, lib.INTENT_MAX_BYTES), /объём/, 'предел по размеру')
  })

  it('уборка: просроченный без строки — объект и запись; ставший файлом — только запись; свежий — не трогается', async () => {
    sql(`delete from osp_private.s3_upload_intents;
      insert into osp_private.s3_upload_intents (s3_key, user_id, size_bytes, created_at) values
        ('tenders/t/old-orphan.pdf', '${USER}', 1, now() - interval '2 hours'),
        ('tenders/t/old-confirmed.pdf', '${USER}', 1, now() - interval '2 hours'),
        ('tenders/t/fresh.pdf', '${USER}', 1, now());
      insert into public.s3_documents (s3_key) values ('tenders/t/old-confirmed.pdf');`)
    s3.deleted.length = 0
    const res = await lib.cleanupUploadIntents({ db, s3, bucket: 'osp' })
    assert.deepEqual(res, { checked: 2, removed: 1 })
    assert.deepEqual(s3.deleted, ['tenders/t/old-orphan.pdf'], 'удалён только объект без строки файла')
    assert.equal(sql(`select string_agg(s3_key, ',' order by s3_key) from osp_private.s3_upload_intents`), 'tenders/t/fresh.pdf')
  })

  it('сбой хранилища — запись остаётся до следующей уборки', async () => {
    sql(`insert into osp_private.s3_upload_intents (s3_key, user_id, size_bytes, created_at)
      values ('tenders/t/retry.pdf', '${USER}', 1, now() - interval '2 hours')`)
    s3.fail = true
    await lib.cleanupUploadIntents({ db, s3, bucket: 'osp' })
    s3.fail = false
    assert.equal(sql(`select count(*) from osp_private.s3_upload_intents where s3_key = 'tenders/t/retry.pdf'`), '1')
  })

  it('нет таблицы (база раньше миграции) — без учёта, как раньше', async () => {
    sql('alter table osp_private.s3_upload_intents rename to s3_upload_intents_away')
    try {
      const intents = lib.createUploadIntents({ db })
      assert.equal(await intents.note('tenders/t/x.pdf', USER, 10), null)
      await intents.drop('tenders/t/x.pdf')
      assert.deepEqual(await lib.cleanupUploadIntents({ db, s3, bucket: 'osp' }), { skipped: true })
    } finally {
      sql('alter table osp_private.s3_upload_intents_away rename to s3_upload_intents')
    }
  })
})
