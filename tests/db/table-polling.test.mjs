// Опрос таблиц на настоящем PostgREST и слепке схемы прода (src/api/tablePolling.js, миграция 20261220): клиент портала
// сверяет таблицу по отметке времени — видно правку, новую строку и удаление, а целиком таблица читается один раз.
// Отметку ставит триггер, значение от клиента не принимается. До миграции (и после отката) всё работает чтением целиком.
// Второй блок — миграция на копии прода под одной учёткой, как база Яндекса. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from './lib/stand.mjs'
import { createOwnDb } from '../../src/api/ownDb.js'
import { createTablePoller, createTableReader } from '../../src/api/tablePolling.js'

const NAME = '20261220_tender_counterparties_updated_at'
const MIGRATION = path.join(ROOT, 'migration', 'yandex', `${NAME}.sql`)
const CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const PGRST_VERSION = /^VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'install.sh'), 'utf8'))[1]
const PGRST_IMAGE = `postgrest/postgrest:v${PGRST_VERSION}`
const hasPostgrest = () => spawnSync('docker', ['image', 'inspect', PGRST_IMAGE], { stdio: 'ignore' }).status === 0

const OBJ = '00000000-0000-4000-8000-0000000fa001'
const TENDER = '00000000-0000-4000-8000-0000000fa002'
const CP = ['00000000-0000-4000-8000-0000000fa003', '00000000-0000-4000-8000-0000000fa004', '00000000-0000-4000-8000-0000000fa005']
const PART = ['00000000-0000-4000-8000-0000000fa013', '00000000-0000-4000-8000-0000000fa014', '00000000-0000-4000-8000-0000000fa015']

async function startPostgrest(dbPort) {
  const port = 31000 + Math.floor(Math.random() * 1000)
  const name = `osp-test-pgrst-poll-${process.pid}-${port}`
  const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
    '-e', `PGRST_DB_URI=postgres://postgres@127.0.0.1:${dbPort}/postgres`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=postgres', '-e', `PGRST_SERVER_PORT=${port}`, '-e', 'PGRST_DB_MAX_ROWS=1000', PGRST_IMAGE], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120000
  for (;;) {
    const status = await fetch(`${url}/objects?select=id&limit=1`).then((r) => r.status, () => 0)
    if (status === 200) break
    if (Date.now() > deadline) throw new Error(`PostgREST не поднялся (последний ответ ${status})`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return { url, stop: () => spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' }) }
}

describe('Опрос таблиц по отметке времени — настоящий PostgREST', { skip: skipReason() || (!hasPostgrest() && `нет образа ${PGRST_IMAGE}`), timeout: 600000 }, () => {
  let db
  let pgrst
  const requests = []
  const sql = (text) => psqlAt(db.port, text)
  const client = () => createOwnDb({
    baseUrl: pgrst.url,
    getToken: async () => null,
    fetchImpl: (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input.url)
      requests.push({ method: init?.method || 'GET', select: u.searchParams.get('select') })
      return fetch(input, init)
    },
  })

  before(async () => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    sql(`
      insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Опрос', 'Москва', 'main_construction');
      insert into public.tenders (id, object_id, work_description, tender_type, status) values ('${TENDER}', '${OBJ}', 'Работы', 'main', 'Идет тендерная процедура');
      insert into public.counterparties (id, name) values ('${CP[0]}', 'ООО Первое'), ('${CP[1]}', 'ООО Второе'), ('${CP[2]}', 'ООО Третье');
      insert into public.tender_counterparties (id, tender_id, counterparty_id, status) values
        ('${PART[0]}', '${TENDER}', '${CP[0]}', 'request_sent'), ('${PART[1]}', '${TENDER}', '${CP[1]}', 'request_sent');`)
    pgrst = await startPostgrest(db.port)
  })
  after(() => {
    pgrst?.stop()
    db?.stop()
  })

  it('до миграции: проверка — FAIL, а не ошибка; узкий список колонок читается без отметки', async () => {
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.match(out, /^FAIL /m)
    const reader = createTableReader(client, { table: 'tender_counterparties', columns: 'id,tender_id,status' })
    const rows = await reader.all()
    assert.equal(rows.length, 2)
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'status', 'tender_id'])
  })

  it('после миграции: отметку ставит триггер, значение от клиента не принимается; повтор безопасен', () => {
    psqlAt(db.port, null, { file: MIGRATION })
    psqlAt(db.port, null, { file: MIGRATION })
    // На этом слепке правила не действуют на владельца (это режим базы Яндекса): вся проверка — во втором блоке.
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.deepEqual(out.split('\n').filter((l) => l.startsWith('FAIL ')), ['FAIL tender_counterparties: RLS включён и действует на владельца'])
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 3, out)
    const before = sql(`select updated_at from public.tender_counterparties where id = '${PART[0]}'`)
    sql(`update public.tender_counterparties set notes = 'правка', updated_at = '2001-01-01' where id = '${PART[0]}'`)
    const after = sql(`select updated_at from public.tender_counterparties where id = '${PART[0]}'`)
    assert.ok(!after.startsWith('2001'), 'старая отметка от клиента не проходит')
    assert.notEqual(after, before)
  })

  it('сверка: правка, новая строка и удаление приходят событиями, таблица читается целиком один раз', async () => {
    let clock = Date.now()
    const events = []
    const reader = createTableReader(client, { table: 'tender_counterparties', columns: 'id,tender_id,status' })
    const poller = createTablePoller({
      fetchRows: reader.all,
      delta: reader.delta,
      onChange: (e) => events.push(e),
      active: () => true,
      now: () => clock,
      countEvery: 1,
      intervalMs: 3_600_000,
    })
    try {
      const until = Date.now() + 10000
      while (Date.now() < until && !requests.some((r) => r.select === 'id,tender_id,status,updated_at')) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 300))
      requests.length = 0

      await poller.tick()
      assert.deepEqual(events, [], 'изменений не было — событий нет')
      assert.ok(!requests.some((r) => r.select === 'id,tender_id,status,updated_at'), 'строки не читались')

      sql(`update public.tender_counterparties set status = 'proposal_provided' where id = '${PART[1]}'`)
      await poller.tick()
      assert.equal(events.length, 1)
      assert.equal(events[0].eventType, 'UPDATE')
      assert.equal(events[0].new.status, 'proposal_provided')
      assert.equal(events[0].old.status, 'request_sent', 'прежняя строка — из снимка, как при чтении целиком')

      sql(`update public.tender_counterparties set notes = 'только примечание' where id = '${PART[0]}'`)
      await poller.tick()
      assert.equal(events.length, 2, 'другая колонка: отметка сдвинулась — событие есть, статус тот же')
      assert.equal(events[1].new.status, events[1].old.status)

      sql(`insert into public.tender_counterparties (id, tender_id, counterparty_id, status) values ('${PART[2]}', '${TENDER}', '${CP[2]}', 'request_sent')`)
      await poller.tick()
      assert.equal(events.at(-1).eventType, 'INSERT')
      assert.equal(events.at(-1).new.id, PART[2])

      sql(`delete from public.tender_counterparties where id = '${PART[0]}'`)
      await poller.tick()
      assert.equal(events.at(-1).eventType, 'DELETE')
      assert.equal(events.at(-1).old.id, PART[0])

      // Окно перекрытия прошло: сверка идёт от самой отметки, и уже виденные строки не становятся событиями.
      const seen = events.length
      clock += 6 * 60_000
      await poller.tick()
      assert.equal(events.length, seen)

      // И после этого новая правка по-прежнему видна (позднюю транзакцию проверяет tests/osp-api/client-db.test.mjs).
      sql(`update public.tender_counterparties set notes = 'ещё' where id = '${PART[1]}'`)
      await poller.tick()
      assert.equal(events.length, seen + 1)
    } finally {
      poller.stop()
    }
  })

  it('откат: колонки нет, строки на месте, чтение снова целиком', async () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'tender_counterparties' and column_name = 'updated_at'`), '0')
    const reader = createTableReader(client, { table: 'tender_counterparties', columns: 'id,tender_id,status' })
    assert.equal((await reader.all()).length, 2)
    assert.equal(sql(`select count(*) from public.tender_counterparties where tender_id = '${TENDER}'`), '2')
  })
})

describe('Отметка времени участников — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  before(() => { db = startSingleOwner(latestVerifiedCopy()) })
  after(() => db?.stop())

  it('миграция проходит, проверка — все OK, строк столько же, у всех отметка', () => {
    const internal = (text) => db.sql(text, { appName: 'osp:internal' })
    const rows = internal('select count(*) from public.tender_counterparties')
    internal(fs.readFileSync(MIGRATION, 'utf8'))
    const out = internal(fs.readFileSync(CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
    assert.equal(internal('select count(*) from public.tender_counterparties'), rows)
    assert.equal(internal('select count(*) from public.tender_counterparties where updated_at is null'), '0')
  })
})
