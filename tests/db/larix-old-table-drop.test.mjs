// Прежняя таблица договорных расценок Larix убрана (миграция 20261221, только база Яндекса). На копии прода под одной
// учёткой, настоящий migrate.sh с проверкой прав: таблицы и записи о её правилах нет; загрузка Larix и вкладка без неё
// работают; в списке шлюза её нет; предохранитель не даёт удалить, пока новая таблица пуста, а в старой есть строки.
// Нужны Docker, psql, pg_dump, pg_restore и проверенная копия прода (migration/dumps, вне git).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, latestVerifiedCopy, startSingleOwner } from './lib/stand.mjs'

const NAME = '20261221_drop_larix_contract_rates'
const MIGRATION = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const ALLOW = path.join(ROOT, 'server', 'osp-api', 'src', 'data', 'allow.json')
const ADMIN = '00000000-0000-4000-8000-0000000f1a01'
const ROW = { work_title: 'Кабель ВВГнг 3х2,5', measure_title: 'м', price_material: 12.3, price_work: 40, contract_id: 7, contract_number: 'N-7' }

describe('Прежняя таблица Larix убрана — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-larix-drop-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(`insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email)
      values ('${ADMIN}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid')`)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('таблицы и записи о её правилах нет, проверка миграции — все OK', () => {
    assert.equal(internal(`select to_regclass('public.larix_contract_rates') is null`), 't')
    assert.equal(internal(`select count(*) from osp_meta.policy_roles where table_name = 'larix_contract_rates'`), '0')
    const out = internal(fs.readFileSync(CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  it('загрузка Larix без неё работает, вкладка видит новые строки', () => {
    const run = internal(`select public.larix_sync_begin('cli')`)
    assert.match(run, /^\d+$/, 'загрузка началась')
    internal(`select public.larix_sync_add_rows(${run}, 0, '${JSON.stringify([ROW])}'::jsonb)`)
    const finished = JSON.parse(internal(`select public.larix_sync_finish(${run}, 1, 0, null, false)`))
    assert.equal(finished.status, 'ok', JSON.stringify(finished))
    assert.equal(internal(`select item_name || '|' || price_material || '|' || price_work from osp_private.larix_rates`), 'Кабель ВВГнг 3х2,5|12.3|40')
    assert.equal(as(ADMIN, 'select count(*) from public.larix_rates_registry'), '1')
  })

  it('в списке шлюза её нет, вкладка и журнал загрузок остались', () => {
    const { tables } = JSON.parse(fs.readFileSync(ALLOW, 'utf8'))
    assert.equal(tables.larix_contract_rates, undefined)
    assert.ok(tables.larix_rates_registry, 'представление вкладки')
    assert.ok(tables.larix_sync_runs, 'журнал загрузок')
  })

  it('предохранитель: новая таблица пуста, в старой есть строки — отказ, таблица на месте; повтор без таблицы безопасен', () => {
    const text = fs.readFileSync(MIGRATION, 'utf8')
    internal(`delete from osp_private.larix_rates where true;
      create table public.larix_contract_rates (id bigint);
      insert into public.larix_contract_rates values (1);`)
    assert.throws(() => internal(text), /таблица не удаляется/)
    assert.equal(internal(`select count(*) from public.larix_contract_rates`), '1', 'строки на месте')
    internal(`drop table public.larix_contract_rates`)
    internal(text)
    assert.equal(internal(`select to_regclass('public.larix_contract_rates') is null`), 't')
  })
})
