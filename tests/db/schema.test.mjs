// Слепок схемы прода (migration/schema/prod-schema.sql) грузится в чистый PostgreSQL 17 целиком,
// поверх ложатся миграции, применённые после слепка, и получается то, что на проде: RLS у всех
// таблиц, auth.uid() из JWT, ограничения последних миграций. Данных в слепке нет.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from './lib/stand.mjs'

const SNAPSHOT = path.join(ROOT, 'migration', 'schema', 'prod-schema.sql')
const skip = skipReason() || (!fs.existsSync(SNAPSHOT) && 'нет слепка migration/schema/prod-schema.sql')

describe('Слепок схемы прода', { skip, timeout: 600000 }, () => {
  let db
  before(() => { db = startSnapshot() })
  after(() => db?.stop())

  it('загружен целиком: таблиц, политик и функций столько же, сколько в файле', () => {
    const text = fs.readFileSync(SNAPSHOT, 'utf8')
    const inFile = {
      tables: (text.match(/^CREATE TABLE public\./gm) || []).length,
      policies: (text.match(/^CREATE POLICY /gm) || []).length,
      functions: (text.match(/^CREATE FUNCTION public\./gm) || []).length,
    }
    const inDb = {
      tables: Number(psqlAt(db.port, `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition`)),
      policies: Number(psqlAt(db.port, `select count(*) from pg_policies where schemaname = 'public'`)),
      functions: Number(psqlAt(db.port, `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and not exists (select 1 from pg_depend d
          where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e')`)),
    }
    assert.ok(inFile.tables > 50 && inFile.policies > 50, JSON.stringify(inFile))
    assert.deepEqual(inDb, inFile)
  })

  it('миграции после слепка ложатся и проходят свои проверки', () => {
    for (const m of appliedAfter()) {
      psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
      const check = path.join(ROOT, 'migration', 'backup', 'checks', `${m.split('_')[0]}.sql`)
      if (!fs.existsSync(check)) continue
      const out = psqlAt(db.port, null, { file: check })
      assert.doesNotMatch(out, /^FAIL/m, `${m}: ${out}`)
      assert.match(out, /^OK /m, m)
    }
  })

  it('RLS включён у всех таблиц public', () => {
    const off = psqlAt(db.port, `select coalesce(string_agg(c.relname, ', '), '') from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity`)
    assert.equal(off, '', `без RLS: ${off}`)
  })

  it('auth.uid() берёт пользователя из JWT, как при запросе через PostgREST', () => {
    const uid = '00000000-0000-4000-8000-000000000001'
    const out = psqlAt(db.port, `begin;
      select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
      set local role authenticated;
      select auth.uid();
      rollback;`)
    assert.match(out, new RegExp(`^${uid}$`, 'm'))
    assert.equal(psqlAt(db.port, `begin; set local role anon; select coalesce(auth.uid()::text, 'null'); rollback;`), 'null')
  })
})
