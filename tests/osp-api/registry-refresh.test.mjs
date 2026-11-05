// Пересчёт реестра расценок по расписанию (server/osp-api/src/lib/registryRefresh.js): пересчитываем, только если
// источники менялись, а всё непонятное — пересчёт, как раньше. Логика — на подделке базы; запрос подписи — на настоящем
// PostgreSQL: источники берутся из зависимостей представлений, запись в таблицу сдвигает подпись, чтение — нет.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY_ACTIVITY_SQL, createRegistryRefresh } from '../../server/osp-api/src/lib/registryRefresh.js'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'

const HOUR = 60 * 60_000

function fakeDb({ signature = 's1', tables = 3, opaque = false, signatureFails = false, lock = true, refreshed = true, refreshFails = false } = {}) {
  const state = { signature, tables, opaque, signatureFails, lock, refreshed, refreshFails, refreshes: 0, marks: 0 }
  const query = async (text) => {
    if (text === REGISTRY_ACTIVITY_SQL) {
      if (state.signatureFails) throw Object.assign(new Error('нет доступа'), { code: '42501' })
      return { rows: [{ tables: state.tables, opaque: state.opaque, signature: state.signature }] }
    }
    if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ ok: state.lock }] }
    if (text.includes('refresh_rates_registry')) {
      if (state.refreshFails) throw new Error('сбой пересчёта')
      if (state.refreshed) state.refreshes += 1
      return { rows: [{ refreshed: state.refreshed }] }
    }
    if (text.includes('update public.app_settings')) { state.marks += 1; return { rows: [] } }
    throw new Error(`неожиданный запрос: ${text}`)
  }
  return { state, read: (who, fn) => fn({ query }), write: (who, fn) => fn({ query }) }
}

function setup(dbOptions, options = {}) {
  let clock = Date.parse('2026-11-03T10:00:00Z')
  const db = fakeDb(dbOptions)
  const job = createRegistryRefresh({ db, log: { warn() {} }, now: () => clock, options })
  return { job, state: db.state, advance: (ms) => { clock += ms } }
}

describe('Пересчёт реестра расценок: только когда источники менялись', () => {
  it('первый такт после запуска пересчитывает; без изменений — нет, но подпись «Данные на …» свежая', async () => {
    const { job, state } = setup()
    assert.equal(await job.run(), 'refreshed')
    assert.equal(state.refreshes, 1)
    assert.equal(await job.run(), 'unchanged')
    assert.equal(await job.run(), 'unchanged')
    assert.equal(state.refreshes, 1)
    assert.equal(state.marks, 2)
  })

  it('источник изменился — пересчёт на этом же такте', async () => {
    const { job, state } = setup()
    await job.run()
    state.signature = 's2'
    assert.equal(await job.run(), 'refreshed')
    assert.equal(state.refreshes, 2)
    assert.equal(await job.run(), 'unchanged')
  })

  it('страховка: раз в 6 часов пересчёт в любом случае', async () => {
    const { job, state, advance } = setup()
    await job.run()
    advance(6 * HOUR - 1)
    assert.equal(await job.run(), 'unchanged')
    advance(1)
    assert.equal(await job.run(), 'refreshed')
    assert.equal(state.refreshes, 2)
  })

  it('непонятное — пересчёт, как раньше: подпись не прочиталась, нет источников, среди них представление', async () => {
    for (const trouble of [{ signatureFails: true }, { tables: 0, signature: '' }, { opaque: true }]) {
      const { job, state } = setup(trouble)
      await job.run()
      await job.run()
      assert.equal(state.refreshes, 2, JSON.stringify(trouble))
      assert.equal(state.marks, 0)
    }
  })

  it('пересчёта не случилось (блокировка, минута после кнопки «Обновить») — следующий такт попробует снова', async () => {
    const { job, state } = setup({ lock: false })
    assert.equal(await job.run(), 'busy')
    state.lock = true
    state.refreshed = false
    assert.equal(await job.run(), 'recent')
    assert.equal(state.marks, 0, 'реестр не пересчитан: отметку свежести не ставим')
    state.refreshed = true
    assert.equal(await job.run(), 'refreshed')
    assert.equal(await job.run(), 'unchanged')
  })

  it('сбой пересчёта — исключение; следующий такт повторит и подпись не считается учтённой', async () => {
    const { job, state } = setup()
    await job.run()
    state.signature = 's2'
    state.refreshFails = true
    await assert.rejects(job.run(), /сбой пересчёта/)
    state.refreshFails = false
    assert.equal(await job.run(), 'refreshed')
  })
})

describe('Подпись источников реестра — настоящий PostgreSQL', { skip: pgAvailable() ? false : 'нет PostgreSQL (бинарники или Docker)' }, () => {
  let pg
  // Счётчики доходят до общей статистики при завершении сеанса psql: читаем уже новым сеансом.
  const signature = () => pg.exec(`select tables || '|' || opaque || '|' || signature from (${REGISTRY_ACTIVITY_SQL}) x`).trim()
  before(() => {
    pg = new TestDatabase()
    pg.start()
    pg.exec(`
      create schema osp_private;
      create table public.src_a (id int primary key, v text);
      create table public.src_b (id int primary key, a_id int);
      create table public.unrelated (id int primary key);
      create materialized view osp_private.kp_rates_registry_mv as
        select a.id, a.v, b.id as b_id from public.src_a a left join public.src_b b on b.a_id = a.id with data;
      create materialized view osp_private.supply_rates_registry_mv as select id from public.src_b with data;
      insert into public.src_a values (1, 'x');`)
  })
  after(() => pg?.stop?.())

  const settle = async (want) => {
    // Статистика приходит с небольшой задержкой — ждём, но не дольше нескольких секунд.
    for (let i = 0; i < 40; i++) {
      const now = signature()
      if (want(now)) return now
      await new Promise((r) => setTimeout(r, 250))
    }
    return signature()
  }

  it('источники — из зависимостей представлений: запись сдвигает подпись, чужая таблица и чтение — нет', async () => {
    const first = await settle((s) => s.includes(':1:0:0'))
    assert.match(first, /^2\|false\|/, 'две таблицы-источника, представлений среди них нет')
    pg.exec('select * from public.src_a')
    pg.exec('insert into public.unrelated values (1)')
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(signature(), first, 'чтение и чужая таблица подпись не меняют')
    pg.exec(`update public.src_a set v = 'y' where id = 1`)
    const second = await settle((s) => s !== first)
    assert.notEqual(second, first, 'правка источника')
    pg.exec('insert into public.src_b values (1, 1)')
    const third = await settle((s) => s !== second)
    assert.notEqual(third, second, 'вставка в другой источник')
    pg.exec('delete from public.src_b where id = 1')
    const fourth = await settle((s) => s !== third)
    assert.notEqual(fourth, third, 'удаление')
  })

  it('источник — представление: сверке нельзя верить', () => {
    pg.exec(`
      create view public.v_a as select * from public.src_a;
      drop materialized view osp_private.supply_rates_registry_mv;
      create materialized view osp_private.supply_rates_registry_mv as select id from public.v_a with data;`)
    assert.match(signature(), /^\d+\|true\|/)
  })
})
