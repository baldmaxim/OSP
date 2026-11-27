// Синхронизация SIGNAL (server/osp-api/src/lib/signalSync.js, signal-cli.js) на настоящем PostgreSQL с настоящей
// миграцией 20270228_signal_integration.sql (tests/osp-api/lib/signal-db.mjs) и поддельным SIGNAL
// (tests/osp-api/lib/fake-signal.mjs). Живого SIGNAL и боевой базы не нужно; без PostgreSQL/Docker весь набор
// ПРОПУСКАЕТСЯ (это «пропущено», а не «прошло»).
//
// Проверяем раздел 4 спецификации: повтор прогона ничего не дублирует; held при сокращении более чем на 30 % и при
// пустом ответе, а сбой посреди обхода не меняют снимок; владелец прогона; барьер записи; исчезновение узла только
// после двух ночных обходов подряд; режим known; расписание по Москве независимо от TZ процесса; accept-held;
// отсутствие открытой транзакции во время HTTP и ожидания 429; остановка без публикации.
// ПР-5 (В-5): сбой одного корня не останавливает остальные (статус ok | partial | held | failed решает база), нечитаемая
// подпапка — проблема папки, а не прогона; эти сценарии, страницы списков и удалённые файлы — в signal-sync-roots.test.mjs
// и signal-sync-pages.test.mjs.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET, fakeId } from './lib/fake-signal.mjs'
import { createSignalClient, sleepAbortable } from '../../server/osp-api/src/lib/signalClient.js'
import { createSignalApi } from '../../server/osp-api/src/lib/signalApi.js'
import { createSignalSync, SIGNAL_SYNC_FUNCTIONS } from '../../server/osp-api/src/lib/signalSync.js'
import { prepareNode } from '../../server/osp-api/src/lib/signalMatch.js'

const CLI = path.join(SERVER, 'src', 'signal-cli.js')
// Москва — UTC+3 круглый год: «2030-03-04 05:10» по Москве.
const msk = (text) => Date.parse(`${text.replace(' ', 'T')}:00+03:00`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SUNDAY_NOON = msk('2030-03-03 12:00') // воскресенье: по расписанию ничего не положено

describe('Синхронизация SIGNAL: база и поддельный SIGNAL', { skip: signalDbSkip }, () => {
  let db
  let sdb
  let fake
  let clock
  let events
  let hooks
  let logs
  let syncs
  let monitors

  // Настоящая обёртка db с записью вызовов служебных функций; hooks.after(name, rows) — после ответа базы.
  const spy = {
    read: (who, fn, opts) => sdb.read(who, (tx) => fn(wrapTx('read', tx)), opts),
    write: (who, fn, opts) => sdb.write(who, (tx) => fn(wrapTx('write', tx)), opts),
  }
  function wrapTx(mode, tx) {
    return {
      ...tx,
      query: async (text, values) => {
        const name = /osp_private\.(signal_\w+)/.exec(text)?.[1] || 'other'
        const rows = name === 'signal_stage_put' ? JSON.parse(values[2]).length : undefined
        events.push({ mode, name, rows })
        const res = await tx.query(text, values)
        hooks.after?.(name, rows)
        return res
      },
    }
  }

  const q = (sql) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${sql}) t`)
  const nodes = () => q('select node_id, kind, parent_id, name, path, path_ids, depth, object_id, first_gen, seen_gen, absent_nights from osp_private.signal_nodes order by path, node_id')
  const meta = () => q('select generation, published_run_id from osp_private.signal_meta')[0]
  const runs = () => q('select id, kind, mode, status, reason, initiator, generation, accepted_by, accept_reason, slot from osp_private.signal_runs order by id')
  const sources = () => q('select id, ready, last_error, folders_count, items_count, last_run_id from osp_private.signal_sources order by id')
  const stageCount = () => Number(db.sql('select count(*) from osp_private.signal_stage_nodes').split('\n')[0])
  const snapshot = () => ({ nodes: nodes(), meta: meta() })
  const byPath = (list) => Object.fromEntries(list.map((n) => [n.path, n]))

  const mkApi = (over = {}) => createSignalApi({
    client: createSignalClient({
      baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, backoffMs: [5, 5, 5],
      sleep: (ms, signal) => sleepAbortable(Math.min(ms, 1100), signal), ...over,
    }),
  })
  const mkSync = ({ api = mkApi(), isReadOnly = () => false, config = {}, db: target = spy } = {}) => {
    const sync = createSignalSync({
      db: target, api, isReadOnly, now: () => clock, config: { heartbeatMs: 10_000, ...config },
      log: { info: (obj, msg) => logs.push({ msg, obj }), warn: (obj, msg) => logs.push({ msg, obj }) },
    })
    syncs.push(sync)
    return sync
  }
  // Ручной прогон: ответ после begin, результат — в done.
  const manual = async (sync) => {
    const started = await sync.runNow({ initiator: 'cli' })
    assert.ok(started.started, JSON.stringify(started))
    return started.done
  }
  // Прогон по расписанию на заданный момент по Москве.
  const at = async (sync, text) => { clock = msk(text); return sync.tick() }

  // Корень «Корень» с папками «Корпус N» и файлами; корень назначен одному объекту.
  function scene({ folders = 3, items = 2, rootItems = 1 } = {}) {
    const project = fake.addProject({ name: 'Тест: проект' })
    const { ids } = fake.build(project, {
      name: 'Корень', items: rootItems, children: Array.from({ length: folders }, (_, i) => ({ name: `Корпус ${i + 1}`, items })),
    })
    const obj = db.seed.object({ name: 'Тест: объект А', code: 'АЛИЯ' })
    const src = db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
    return { project, ids, obj, src, root: ids['Корень'] }
  }

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4 })
  })
  after(async () => { await db?.stop() })
  beforeEach(async () => {
    fake = await startFakeSignal()
    clock = SUNDAY_NOON
    events = []
    hooks = {}
    logs = []
    syncs = []
    monitors = []
  })
  afterEach(async () => {
    for (const s of syncs) await s.stop()
    for (const m of monitors) { try { await m.end() } catch { /* закрыт */ } }
    await fake.close()
    db.sql(`TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_candidates,
      osp_private.signal_contracts, osp_private.signal_queue, osp_private.signal_bindings, osp_private.signal_sources RESTART IDENTITY;
      UPDATE osp_private.signal_meta SET generation = 0, published_at = NULL, published_run_id = NULL WHERE id = 1`)
  })

  it('полный прогон публикует снимок от корня: путь, предки, глубина, объект узла, признаки из prepareNode', async () => {
    const project = fake.addProject({ name: 'Тест: проект' })
    const { ids } = fake.build(project, {
      name: 'Корень', items: 1, children: [{ name: 'АЛИЯ-ДП-26-001 Тестстрой', items: 2 }, { name: 'Корпус 14', items: 1, children: [{ name: 'Акты', items: 1 }] }],
    })
    const obj = db.seed.object({ name: 'Тест: объект А', code: 'АЛИЯ' })
    const src = db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
    const result = await manual(mkSync())
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.generation, 1)
    assert.deepEqual(result.stats.roots, [{ id: src.id, status: 'ok', folders: 4, items: 5, listed: 4 }])
    const all = nodes()
    assert.equal(all.length, 9)
    const p = byPath(all)
    assert.equal(p['Корень'].parent_id, null)
    assert.deepEqual(p['Корень'].path_ids, [])
    assert.equal(p['Корень'].depth, 0)
    assert.equal(p['Корень'].kind, 'folder')
    const acts = p['Корень / Корпус 14 / Акты']
    assert.deepEqual(acts.path_ids, [ids['Корень'], ids['Корень / Корпус 14']])
    assert.equal(acts.depth, 2)
    assert.equal(acts.parent_id, ids['Корень / Корпус 14'])
    const item = p['Корень / Корпус 14 / Акты / Файл 1.pdf']
    assert.equal(item.kind, 'item')
    assert.deepEqual(item.path_ids, [ids['Корень'], ids['Корень / Корпус 14'], ids['Корень / Корпус 14 / Акты']])
    assert.equal(item.depth, 3)
    for (const n of all) {
      assert.equal(n.object_id, obj, 'единственный объект корня — объект каждого узла (граница Ф1)')
      assert.equal(n.first_gen, 1)
      assert.equal(n.seen_gen, 1)
      assert.equal(n.absent_nights, 0)
    }
    // вычисленные признаки — те же, что даёт prepareNode (пакет сопоставления)
    const row = db.sqlJson(`select to_json(t) from (select number_keys, name_norm, features from osp_private.signal_nodes where node_id = '${ids['Корень / АЛИЯ-ДП-26-001 Тестстрой']}') t`)
    const expected = prepareNode({ name: 'АЛИЯ-ДП-26-001 Тестстрой', path: 'Корень / АЛИЯ-ДП-26-001 Тестстрой', kind: 'folder' })
    assert.deepEqual(row.number_keys, expected.numberKeys)
    assert.equal(row.name_norm, expected.nameNorm)
    assert.ok(row.number_keys.length > 0, 'номер договора в названии папки распознан')
    const building = db.sqlJson(`select to_json(t) from (select features from osp_private.signal_nodes where node_id = '${ids['Корень / Корпус 14']}') t`)
    assert.deepEqual(building.features, prepareNode({ name: 'Корпус 14', path: 'Корень / Корпус 14' }).features)
    assert.ok(Object.keys(building.features).length > 0, 'корпус 14 — признак')
    assert.deepEqual(sources(), [{ id: src.id, ready: true, last_error: null, folders_count: 4, items_count: 5, last_run_id: result.runId }])
    assert.equal(stageCount(), 0, 'staging убран после публикации')
    // журнал — только идентификаторы, коды и счётчики
    assert.ok(!JSON.stringify(logs).match(/Корпус|Акты|Файл|АЛИЯ/), 'в журнале нет названий')
  })

  it('повтор прогона ничего не дублирует: те же узлы, first_gen прежний, seen_gen новый', async () => {
    const s = scene({ folders: 3, items: 2 })
    const sync = mkSync()
    const first = await manual(sync)
    const before1 = nodes()
    const second = await manual(sync)
    assert.equal(first.generation, 1)
    assert.equal(second.generation, 2)
    const after2 = nodes()
    assert.equal(after2.length, before1.length)
    assert.deepEqual(after2.map((n) => n.node_id), before1.map((n) => n.node_id))
    for (const n of after2) { assert.equal(n.first_gen, 1); assert.equal(n.seen_gen, 2); assert.equal(n.absent_nights, 0) }
    assert.deepEqual(sources(), [{ id: s.src.id, ready: true, last_error: null, folders_count: 4, items_count: 7, last_run_id: second.runId }])
    assert.equal(stageCount(), 0)
    assert.equal(meta().generation, 2)
    assert.deepEqual(runs().map((r) => [r.status, r.generation]), [['ok', 1], ['ok', 2]])
    // публикация без изменений договоры в очередь не ставит (С-38); с изменением — ставит
    const contract = db.seed.contract({ number: 'АЛИЯ-ДП-26-001', objectId: s.obj })
    const queued = () => Number(db.sql(`select count(*) from osp_private.signal_queue where contract_id = '${contract}'`).split('\n')[0])
    db.sql(`DELETE FROM osp_private.signal_queue WHERE contract_id = '${contract}'`)
    await manual(sync)
    assert.equal(queued(), 0, 'ничего не изменилось — очередь не нагружается')
    fake.addFolder(s.project, { name: 'Корпус 99', parentId: s.root })
    await manual(sync)
    assert.equal(queued(), 1, 'новая папка — договор поставлен в очередь')
  })

  it('порции staging не больше stageChunk, страницы элементов — по pageSize (Skip/Take, без «следующего» адреса)', async () => {
    scene({ folders: 3, items: 7, rootItems: 0 })
    fake.leakNext = true
    const result = await manual(mkSync({ config: { stageChunk: 6, pageSize: 3 } }))
    assert.equal(result.status, 'ok')
    const puts = events.filter((e) => e.name === 'signal_stage_put')
    assert.ok(puts.every((e) => e.rows <= 6), 'порция не больше 6 строк')
    assert.equal(puts.reduce((n, e) => n + e.rows, 0), 4 + 21)
    const pages = fake.requests.filter((r) => r.path === '/public/v1/items')
    assert.ok(pages.every((r) => r.query.Take === '3'))
    const sizes = new Map()
    for (const r of pages) sizes.set(r.query.folderId, [...(sizes.get(r.query.folderId) || []), r.query.Skip])
    // 7 элементов по 3: 0, 3, 6, пустая страница (7) — конец списка, затем сверка первой страницы (0)
    assert.deepEqual([...sizes.values()].filter((v) => v.length === 5).map((v) => v.join()), ['0,3,6,7,0', '0,3,6,7,0', '0,3,6,7,0'])
    assert.equal(nodes().length, 25)
    for (const r of fake.requests) assert.ok(!JSON.stringify(r).includes('evil'))
    assert.deepEqual(fake.violations, [])
  })

  it('служебные функции — только osp_private.signal_* из набора синхронизации, чтение — db.read', async () => {
    scene()
    await manual(mkSync())
    const names = new Set(events.map((e) => e.name))
    for (const name of names) assert.ok(SIGNAL_SYNC_FUNCTIONS.includes(name), `лишний вызов: ${name}`)
    for (const e of events) {
      if (['signal_sync_due', 'signal_sources_for_sync'].includes(e.name)) assert.equal(e.mode, 'read')
      else assert.equal(e.mode, 'write')
    }
    assert.ok(['signal_sources_for_sync', 'signal_sync_begin', 'signal_stage_put', 'signal_sync_finish'].every((n) => names.has(n)))
  })

  it('два корня одного проекта — одно дерево на проект; сбой одного корня (В-5): он отмечен и не обновлён, другой опубликован — partial', async () => {
    const project = fake.addProject({ name: 'Тест: проект' })
    const { ids } = fake.build(project, [
      { name: 'Корень 1', children: [{ name: 'Корпус 1', items: 2 }] },
      { name: 'Корень 2', children: [{ name: 'Корпус 1', items: 2 }] },
    ])
    const o1 = db.seed.object({ name: 'Тест: объект 1' })
    const o2 = db.seed.object({ name: 'Тест: объект 2' })
    const s1 = db.seed.source({ projectId: project, folderId: ids['Корень 1'], objectIds: [o1] })
    const s2 = db.seed.source({ projectId: project, folderId: ids['Корень 2'], objectIds: [o2] })
    const sync = mkSync()
    const ok = await manual(sync)
    assert.equal(ok.status, 'ok')
    assert.equal(fake.count('/folders/tree'), 1, 'дерево проекта запрошено один раз на два корня')
    const p = byPath(nodes())
    assert.equal(p['Корень 1 / Корпус 1'].object_id, o1)
    assert.equal(p['Корень 2 / Корпус 1'].object_id, o2)
    assert.deepEqual(sources().map((s) => [s.id, s.ready, s.folders_count, s.items_count]), [[s1.id, true, 2, 2], [s2.id, true, 2, 2]])

    const before = nodes().filter((n) => n.path.startsWith('Корень 2'))
    fake.removeFolder(project, ids['Корень 2'])
    fake.addFolder(project, { name: 'Корпус 2', parentId: ids['Корень 1'] })
    const bad = await manual(sync)
    assert.equal(bad.status, 'partial', JSON.stringify(bad))
    assert.equal(bad.reason, 'root_failed')
    assert.equal(bad.generation, 2, 'исправный корень опубликован — поколение растёт')
    assert.deepEqual(bad.stats.roots, [{ id: s1.id, status: 'ok', folders: 3, items: 2, listed: 3 }, { id: s2.id, status: 'failed', reason: 'root_missing' }])
    const after = byPath(nodes())
    assert.ok(after['Корень 1 / Корпус 2'], 'новая папка исправного корня опубликована')
    assert.deepEqual(nodes().filter((n) => n.path.startsWith('Корень 2')).map((n) => [n.node_id, n.absent_nights]), before.map((n) => [n.node_id, 0]),
      'узлы сбойного корня не тронуты: ни пропаж, ни счёта ночей')
    assert.deepEqual(sources().map((s) => [s.id, s.last_error, s.ready]), [[s1.id, null, true], [s2.id, 'root_missing', true]])
    assert.equal(stageCount(), 0)
    assert.deepEqual(runs().at(-1).status, 'partial')
  })

  // ── held ────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('защита от сокращения (held)', () => {
    it('папок стало меньше 70 % при ≥ 20 прежних → held; снимок и поколение не меняются, staging остаётся', async () => {
      const s = scene({ folders: 30, items: 1 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const before = snapshot()
      for (const [, id] of Object.entries(s.ids).filter(([p]) => p !== 'Корень').slice(0, 15)) fake.removeFolder(s.project, id)
      const held = await manual(sync)
      assert.equal(held.status, 'held')
      assert.equal(held.reason, 'shrink')
      assert.equal(held.generation, 1)
      assert.deepEqual(snapshot(), before)
      assert.ok(stageCount() > 0, 'staging held-прогона сохранён для accept-held')
      assert.equal(runs().at(-1).status, 'held')
      assert.equal(sources()[0].last_error, null)
    })

    it('пустой ответ по элементам при непустом прошлом → held (empty); в режиме known элементы не проверяются', async () => {
      const s = scene({ folders: 4, items: 6 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const before = snapshot()
      for (const id of Object.values(s.ids)) fake.setItems(id, [])
      const held = await manual(sync)
      assert.equal(held.status, 'held')
      assert.equal(held.reason, 'empty')
      assert.deepEqual(snapshot(), before)
      // дневной known: перечисляются только известные и новые папки, поэтому «пустота» элементов не проверяется и снимок публикуется
      const known = mkSync({ config: { dayMode: 'known' } })
      const result = await at(known, '2030-03-04 12:00')
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.equal(runs().at(-1).mode, 'known')
    })

    it('сокращение до 30 % допустимо; малые снимки (< 20 папок) не задерживаются', async () => {
      const s = scene({ folders: 30, items: 0, rootItems: 0 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const ids = Object.entries(s.ids).filter(([p]) => p !== 'Корень').map(([, id]) => id)
      for (const id of ids.slice(0, 9)) fake.removeFolder(s.project, id) // 31 → 22 папки (71 %)
      const result = await manual(sync)
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.equal(meta().generation, 2)
    })

    it('малый снимок (меньше 20 папок) не задерживается даже при сильном сокращении', async () => {
      const s = scene({ folders: 5, items: 0, rootItems: 0 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      for (const [, id] of Object.entries(s.ids).filter(([p]) => p !== 'Корень').slice(0, 4)) fake.removeFolder(s.project, id)
      const result = await manual(sync)
      assert.equal(result.status, 'ok', JSON.stringify(result))
    })

    it('accept-held: публикует только последний held и только при совпадении поколения', async () => {
      const s = scene({ folders: 30, items: 1 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const all = Object.entries(s.ids).filter(([p]) => p !== 'Корень').map(([, id]) => id)
      for (const id of all.slice(0, 15)) fake.removeFolder(s.project, id)
      const heldA = await manual(sync)
      assert.equal(heldA.status, 'held')
      for (const id of all.slice(15, 20)) fake.removeFolder(s.project, id)
      const heldB = await manual(sync)
      assert.equal(heldB.status, 'held')
      assert.notEqual(heldA.runId, heldB.runId)
      const reject = async (args, code, message) => assert.rejects(() => sync.acceptHeld({ actor: 'cli', reason: 'проверено', ...args }),
        (err) => { assert.equal(err.code, code); assert.equal(err.message, message); return true })
      await reject({ runId: heldA.runId, expectedGeneration: 1 }, 'SG409', 'stale_state') // не последний held
      await reject({ runId: heldB.runId, expectedGeneration: 5 }, 'SG409', 'stale_state') // поколение другое
      await reject({ runId: 987654, expectedGeneration: 1 }, 'SG404', 'not_found')
      await reject({ runId: heldB.runId, expectedGeneration: 1, reason: '  ' }, 'SG422', 'invalid')
      assert.equal(meta().generation, 1, 'отказы ничего не публикуют')
      const out = await sync.acceptHeld({ runId: heldB.runId, expectedGeneration: 1, actor: 'cli', reason: 'сокращение ожидаемо' })
      assert.equal(out.status, 'ok')
      assert.equal(out.generation, 2)
      const row = runs().find((r) => r.id === heldB.runId)
      assert.deepEqual([row.status, row.accepted_by, row.accept_reason], ['ok', 'cli', 'сокращение ожидаемо'])
      assert.equal(Number(db.sql(`select count(*) from osp_private.signal_stage_nodes where run_id = ${heldB.runId}`).split('\n')[0]), 0, 'staging принятого прогона убран')
      await reject({ runId: heldB.runId, expectedGeneration: 2 }, 'SG409', 'stale_state') // уже принят
    })

    it('accept-held после новой публикации (поколение сменилось) отказывает: расхождение не затирает свежий снимок', async () => {
      const s = scene({ folders: 30, items: 1 })
      const sync = mkSync()
      await manual(sync)
      for (const [, id] of Object.entries(s.ids).filter(([p]) => p !== 'Корень').slice(0, 15)) fake.removeFolder(s.project, id)
      const held = await manual(sync)
      assert.equal(held.status, 'held')
      fake.addFolder(s.project, { name: 'Корпус 99', parentId: s.root })
      const fresh = await manual(sync) // 16 папок против 31 — снова held; принимаем его вручную, чтобы сменить поколение
      assert.equal(fresh.status, 'held')
      const ok = await sync.acceptHeld({ runId: fresh.runId, expectedGeneration: 1, actor: 'cli', reason: 'проверено' })
      assert.equal(ok.generation, 2)
      await assert.rejects(() => sync.acceptHeld({ runId: held.runId, expectedGeneration: 1, actor: 'cli', reason: 'проверено' }), (e) => e.code === 'SG409')
    })
  })

  // ── сбои ────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('сбой корня не меняет его снимок и не останавливает остальные (В-5)', () => {
    // Сбои связи на элементах — сбой корня: прогон failed (все корни сбойные), снимок, поколение и staging чисты, last_error корня.
    const cases = [
      ['500 на элементах', 'http', () => ({ status: 500, body: {} }), {}],
      ['зависший ответ', 'timeout', () => ({ hang: true }), { timeoutMs: 250 }],
    ]
    for (const [title, reason, spec, clientOver] of cases) {
      it(`${title} после записанных порций → корень failed (${reason}), прогон failed (root_failed); снимок, поколение и staging чисты`, async () => {
        const s = scene({ folders: 4, items: 3 })
        assert.equal((await manual(mkSync())).status, 'ok')
        const before = snapshot()
        let seen = 0
        let staged = -1
        // третий запрос элементов (после двух записанных порций) получает сбой; в этот момент считаем строки staging
        fake.fail((r) => {
          if (r.path !== '/public/v1/items' || ++seen < 3) return false
          if (staged < 0) staged = stageCount()
          return true
        }, { ...spec(), times: 100 })
        const result = await manual(mkSync({ api: mkApi({ retries: 0, ...clientOver }) }))
        assert.equal(result.status, 'failed')
        assert.equal(result.reason, 'root_failed')
        assert.ok(staged > 0, `порции были записаны до сбоя (${staged})`)
        assert.deepEqual(snapshot(), before)
        assert.equal(stageCount(), 0)
        const last = runs().at(-1)
        assert.deepEqual([last.status, last.reason], ['failed', 'root_failed'])
        assert.equal(sources()[0].last_error, reason)
        assert.equal(sources()[0].ready, true, 'прежний снимок остаётся готовым')
        assert.deepEqual(result.stats.roots, [{ id: s.src.id, status: 'failed', reason }])
      })
    }

    // Ошибка чтения одной подпапки (403, разбор, слишком большой ответ) — проблема папки: обход идёт, корень публикуется.
    const folderCases = [
      ['403 на элементах', 'forbidden', () => ({ status: 403, body: {} }), {}],
      ['неверный тип поля', 'invalid', () => ({ status: 200, body: [{ id: 'не-uuid', name: 'x' }] }), {}],
      ['слишком большой ответ', 'invalid', () => ({ bigBody: 3_000_000 }), { maxBytes: 100_000 }],
    ]
    for (const [title, code, spec, clientOver] of folderCases) {
      it(`${title} в подпапке → проблема папки (${code}), корень опубликован, элементы папки перенесены из прежнего снимка`, async () => {
        const s = scene({ folders: 4, items: 3 })
        assert.equal((await manual(mkSync())).status, 'ok')
        const bad = s.ids['Корень / Корпус 2']
        const oldItems = nodes().filter((n) => n.parent_id === bad).map((n) => n.node_id)
        assert.equal(oldItems.length, 3)
        fake.fail((r) => r.path === '/public/v1/items' && r.query.folderId === bad, { ...spec(), times: 100 })
        const result = await manual(mkSync({ api: mkApi({ retries: 0, ...clientOver }) }))
        assert.equal(result.status, 'ok', JSON.stringify(result))
        assert.equal(result.generation, 2)
        assert.deepEqual(result.stats.roots, [{
          id: s.src.id, status: 'ok', folders: 5, items: 10, listed: 4, problems: [{ nodeId: bad, code }], problemsTotal: 1,
        }])
        assert.equal(stageCount(), 0)
        assert.deepEqual(sources().map((r) => [r.last_error, r.ready]), [[null, true]])
        const after = nodes()
        assert.deepEqual(after.filter((n) => n.parent_id === bad).map((n) => [n.node_id, n.seen_gen, n.absent_nights]), oldItems.sort().map((id) => [id, 2, 0]),
          'файлы нечитаемой папки не считаются пропавшими')
        assert.equal(db.sqlJson(`select to_json(t) from (select problem from osp_private.signal_nodes where node_id = '${bad}') t`).problem, code)
        assert.equal(db.sqlJson(`select to_json(t) from (select problem from osp_private.signal_nodes where node_id = '${s.ids['Корень / Корпус 1']}') t`).problem, null)
      })
    }

    it('корень не найден в дереве, проект исчез (404), нет доступа (403) → корень failed (root_missing / root_unavailable / scope), снимок прежний', async () => {
      const s = scene({ folders: 3, items: 2 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const before = snapshot()

      fake.denyProject(s.project)
      let r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.deepEqual(r.stats.roots, [{ id: s.src.id, status: 'failed', reason: 'scope' }])
      assert.equal(sources()[0].last_error, 'scope')
      fake.allowProject(s.project)

      const removed = fake.state.folders.get(s.project).get(s.root)
      fake.removeFolder(s.project, s.root)
      r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.equal(sources()[0].last_error, 'root_missing')
      fake.state.folders.get(s.project).set(s.root, removed)

      fake.removeProject(s.project)
      r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.equal(sources()[0].last_error, 'root_unavailable')
      assert.deepEqual(snapshot(), before)
      assert.equal(stageCount(), 0)
      assert.deepEqual(fake.violations, [])
    })

    it('пределы: глубина и число узлов → корень failed (limit); повтор страницы (курсор не сдвинулся) → корень failed (invalid)', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: 'А', children: [{ name: 'Б', children: [{ name: 'В', items: 250 }] }] }] })
      const obj = db.seed.object({ name: 'Тест: объект А' })
      db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
      let r = await manual(mkSync({ config: { maxDepth: 2 } }))
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.equal(sources()[0].last_error, 'limit')
      r = await manual(mkSync({ config: { maxNodes: 100 } }))
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.equal(sources()[0].last_error, 'limit', 'элементы тоже считаются в узлах корня')
      const page = fake.state.items.get(ids['Корень / А / Б / В']).slice(0, 200).map((it) => ({ ...it, folderId: it.folderId }))
      fake.fail((req) => req.path === '/public/v1/items' && req.query.Skip === '200', { status: 200, body: page, times: 5 })
      r = await manual(mkSync())
      assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'])
      assert.equal(sources()[0].last_error, 'invalid')
      assert.equal(meta().generation, 0)
      assert.equal(nodes().length, 0)
      assert.equal(stageCount(), 0)
    })

    it('бюджет прогона: превышение прерывает HTTP → failed (budget), корень не винится', async () => {
      scene({ folders: 2, items: 2 })
      fake.itemsDelayMs = 1500
      const r = await manual(mkSync({ config: { runBudgetMs: 300 } }))
      assert.deepEqual([r.status, r.reason], ['failed', 'budget'])
      assert.equal(sources()[0].last_error, null)
      assert.equal(runs().at(-1).reason, 'budget')
      assert.equal(meta().generation, 0)
    })
  })

  // ── владелец ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('владелец прогона', () => {
    const call = (name, args) => sdb.write(null, async (tx) => (await tx.query(`select osp_private.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r)

    it('второй begin при живом прогоне → занято; heartbeat, порция и публикация чужим токеном → отказ', async () => {
      scene({ folders: 3, items: 3 })
      fake.itemsDelayMs = 300
      const a = mkSync()
      const b = mkSync() // другой экземпляр (как другой процесс): о занятости узнаёт только от базы
      const started = await a.runNow({ initiator: 'cli' })
      assert.ok(started.started)
      assert.deepEqual(await b.runNow({ initiator: 'admin' }), { busy: true })
      assert.deepEqual(await a.runNow({ initiator: 'admin' }), { busy: true }, 'в этом же процессе — без обращения к базе')
      assert.equal(events.filter((e) => e.name === 'signal_sync_begin').length, 2, 'вторая попытка дошла до базы и получила null')
      const [{ id, owner_token: owner }] = q("select id, owner_token from osp_private.signal_runs where status = 'running'")
      const stranger = fakeId('misc', 777)
      assert.equal(await call('signal_sync_heartbeat', [id, stranger]), false)
      assert.equal(await call('signal_sync_heartbeat', [id, owner]), true)
      await assert.rejects(() => call('signal_stage_put', [id, stranger, '[]']), (e) => e.code === 'SG409' && e.message === 'busy')
      await assert.rejects(() => call('signal_sync_finish', [id, stranger, '{"roots":[]}', false]), (e) => e.code === 'SG409' && e.message === 'busy')
      await call('signal_sync_fail', [id, stranger, 'failed', 'x', '{}'])
      assert.equal(runs().at(-1).status, 'running', 'чужой fail ничего не завершает')
      const result = await started.done
      assert.equal(result.status, 'ok')
      assert.equal(await call('signal_sync_heartbeat', [id, owner]), false, 'после завершения heartbeat владельца не принимается')
    })

    it('потеря владения (прогон закрыт снаружи) → cancelled (lost_owner), снимок не меняется', async () => {
      scene({ folders: 3, items: 3 })
      fake.itemsDelayMs = 400
      const sync = mkSync({ config: { heartbeatMs: 60 } })
      const started = await sync.runNow({ initiator: 'cli' })
      for (let i = 0; i < 100 && fake.count('/public/v1/items') < 1; i++) await wait(20) // обход идёт: первый запрос элементов принят
      db.sql("UPDATE osp_private.signal_runs SET status = 'failed', reason = 'stale', finished_at = now() WHERE status = 'running'")
      const result = await started.done
      assert.deepEqual([result.status, result.reason], ['cancelled', 'lost_owner'], JSON.stringify(result))
      assert.equal(meta().generation, 0)
      assert.equal(nodes().length, 0)
      assert.deepEqual([runs().at(-1).status, runs().at(-1).reason], ['failed', 'stale'], 'чужую отметку не перезаписывают')
      assert.ok(stageCount() > 0, 'порции потерявшего владение прогона не трогаем: их уберёт следующий begin')
      fake.itemsDelayMs = 0
      const next = await manual(sync)
      assert.equal(next.status, 'ok', JSON.stringify(next))
      assert.equal(stageCount(), 0)
    })

    it('зависший прогон (heartbeat старше срока) снимается следующим begin как stale', async () => {
      scene()
      db.sql(`INSERT INTO osp_private.signal_runs (kind, mode, initiator, owner_token, heartbeat_at) VALUES ('manual', 'full', 'cli', '${fakeId('misc', 5)}', now() - interval '20 minutes')`)
      const result = await manual(mkSync())
      assert.equal(result.status, 'ok')
      assert.deepEqual(runs().slice(0, 1).map((r) => [r.status, r.reason]), [['failed', 'stale']])
    })
  })

  // ── барьер записи ───────────────────────────────────────────────────────────────────────────────────────────────
  describe('барьер записи isReadOnly()', () => {
    it('между порциями → cancelled, после барьера запросов в базу нет; отметка — когда барьер снят', async () => {
      scene({ folders: 3, items: 2 })
      const sync0 = mkSync()
      assert.equal((await manual(sync0)).status, 'ok')
      const before = snapshot()
      events.length = 0
      const barrier = { on: false }
      let puts = 0
      let trip = -1
      hooks.after = (name) => {
        if (name === 'signal_stage_put' && ++puts === 2 && !barrier.on) { barrier.on = true; trip = events.length }
      }
      fake.itemsDelayMs = 80
      const sync = mkSync({ isReadOnly: () => barrier.on, config: { heartbeatMs: 30 } })
      const result = await manual(sync)
      assert.deepEqual([result.status, result.reason], ['cancelled', 'read_only'])
      assert.ok(trip > 0)
      assert.deepEqual(events.slice(trip), [], 'ни одного обращения к базе после включения барьера (ни порций, ни heartbeat)')
      const written = events.slice(0, trip).filter((e) => e.name === 'signal_stage_put').reduce((n, e) => n + e.rows, 0)
      assert.equal(stageCount(), written, 'в staging ровно то, что записано до барьера')
      assert.equal(runs().at(-1).status, 'running', 'под барьером отметку не пишем')
      assert.deepEqual(snapshot(), before)
      // барьер снят — следующий такт сначала закрывает прогон отметкой, затем смотрит расписание
      barrier.on = false
      hooks.after = null
      clock = SUNDAY_NOON
      assert.deepEqual(await sync.tick(), { skipped: 'not_due' })
      assert.deepEqual([runs().at(-1).status, runs().at(-1).reason], ['cancelled', 'read_only'])
      assert.equal(stageCount(), 0)
      assert.equal((await manual(sync)).status, 'ok')
    })

    it('перед публикацией → cancelled, публикации нет', async () => {
      scene({ folders: 1, items: 2, rootItems: 1 })
      const sync0 = mkSync()
      await manual(sync0)
      const before = snapshot()
      const barrier = { on: false }
      let puts = 0
      let trip = -1
      hooks.after = (name) => {
        // порции прогона: папки, элементы корня, элементы папки — после последней барьер включается
        if (name === 'signal_stage_put' && ++puts === 3) { barrier.on = true; trip = events.length }
      }
      const result = await manual(mkSync({ isReadOnly: () => barrier.on }))
      assert.deepEqual([result.status, result.reason], ['cancelled', 'read_only'])
      assert.deepEqual(events.slice(trip), [], 'signal_sync_finish не вызывался')
      assert.deepEqual(snapshot(), before)
      assert.equal(meta().generation, 1)
    })

    it('барьер включён до такта: такт и ручной запуск ничего не пишут', async () => {
      scene()
      const sync = mkSync({ isReadOnly: () => true })
      assert.deepEqual(await sync.tick(), { skipped: 'read_only' })
      assert.deepEqual(await sync.runNow({ initiator: 'admin' }), { readOnly: true })
      assert.deepEqual(events, [])
      assert.equal(runs().length, 0)
    })
  })

  // ── исчезновение узла ───────────────────────────────────────────────────────────────────────────────────────────
  describe('узел исчез из SIGNAL (Ф2)', () => {
    it('после дневного обхода — ещё не наблюдается, после одной ночи — absent_nights 1, после двух подряд — 2; появление сбрасывает счётчик', async () => {
      const s = scene({ folders: 4, items: 2 })
      const sync = mkSync()
      const idB = s.ids['Корень / Корпус 2']
      const idC = s.ids['Корень / Корпус 3']
      const info = (id) => nodes().find((n) => n.node_id === id)
      const childOf = (id) => nodes().filter((n) => n.parent_id === id)

      assert.equal((await at(sync, '2030-03-04 05:10')).status, 'ok') // ночь 1: всё на месте
      assert.deepEqual(runs().at(-1).kind, 'night')
      const removedC = fake.state.folders.get(s.project).get(idC)
      fake.removeFolder(s.project, idB)
      fake.removeFolder(s.project, idC)

      assert.equal((await at(sync, '2030-03-04 12:00')).status, 'ok') // день: полный обход
      assert.equal(runs().at(-1).kind, 'day')
      for (const id of [idB, idC]) {
        assert.equal(info(id).seen_gen, 1, 'в последнем обходе не виден')
        assert.equal(info(id).absent_nights, 0, 'дневной обход ночь не считает')
        assert.ok(childOf(id).length > 0 && childOf(id).every((n) => n.absent_nights === 0))
      }
      assert.equal(info(s.ids['Корень / Корпус 1']).seen_gen, 2)

      assert.equal((await at(sync, '2030-03-05 05:10')).status, 'ok') // ночь 2
      for (const id of [idB, idC]) assert.equal(info(id).absent_nights, 1, 'после одной ночи — ещё не две')
      assert.ok(childOf(idB).every((n) => n.absent_nights === 1))

      // C снова виден днём между ночами (та же папка, новые файлы) — счётчик сбрасывается
      fake.state.folders.get(s.project).set(idC, removedC)
      fake.addItems(idC, 1)
      assert.equal((await at(sync, '2030-03-05 12:00')).status, 'ok')
      assert.deepEqual([info(idC).absent_nights, info(idC).seen_gen], [0, 4])
      assert.equal(info(idB).absent_nights, 1, 'B дневной обход не меняет')
      fake.removeFolder(s.project, idC)

      assert.equal((await at(sync, '2030-03-06 05:10')).status, 'ok') // ночь 3
      assert.equal(info(idB).absent_nights, 2, 'две ночи подряд → not_visible')
      assert.ok(childOf(idB).every((n) => n.absent_nights === 2))
      assert.equal(info(idC).absent_nights, 1, 'после появления счёт начался заново')
      assert.equal(info(s.ids['Корень / Корпус 1']).absent_nights, 0)
      assert.deepEqual(runs().map((r) => r.kind), ['night', 'day', 'night', 'day', 'night'])
      assert.equal(meta().generation, 5)
    })
  })

  // ── режим known ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe('дневной режим known', () => {
    it('перечисляет элементы только папок со связью или кандидатом и новых папок; остальные элементы переносятся', async () => {
      const s = scene({ folders: 3, items: 2, rootItems: 1 })
      const [f1, f2, f3] = [1, 2, 3].map((i) => s.ids[`Корень / Корпус ${i}`])
      const sync = mkSync({ config: { dayMode: 'known' } })
      assert.equal((await manual(sync)).status, 'ok') // полный: исходный снимок (ручной — всегда full)
      assert.equal(runs().at(-1).mode, 'full')

      const linked = db.seed.contract({ number: 'АЛИЯ-ДП-26-001', objectId: s.obj })
      const candidate = db.seed.contract({ number: 'АЛИЯ-ДП-26-002', objectId: s.obj })
      const refused = db.seed.contract({ number: 'АЛИЯ-ДП-26-003', objectId: s.obj })
      db.sql(`INSERT INTO osp_private.signal_contracts (contract_id, state, node_id) VALUES ('${linked}', 'verified', '${f1}');
        INSERT INTO osp_private.signal_candidates (contract_id, node_id, status) VALUES ('${candidate}', '${f2}', 'open'), ('${refused}', '${f3}', 'rejected')`)
      const known = await sdb.read(null, async (tx) => (await tx.query("select osp_private.signal_sources_for_sync('known') as r")).rows[0].r)
      assert.deepEqual([...known.sources[0].knownFolderIds].sort(), [f1, f2].sort(), 'отклонённый кандидат папку «известной» не делает')
      assert.equal(known.sources[0].folderIds.length, 4)

      const oldF3 = nodes().filter((n) => n.parent_id === f3).map((n) => n.node_id)
      fake.addItems(f1, 1)
      fake.addItems(f2, 1)
      fake.addItems(f3, 1) // новый файл в неизвестной папке — в known не виден
      fake.setItems(f3, fake.state.items.get(f3).slice(1)) // и один старый удалён — тоже незамечен
      const f4 = fake.addFolder(s.project, { name: 'Корпус 4', parentId: s.root })
      fake.addItems(f4, 2)
      fake.resetRequests()

      const result = await at(sync, '2030-03-04 12:00')
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.deepEqual([runs().at(-1).kind, runs().at(-1).mode], ['day', 'known'])
      const listed = new Set(fake.requests.filter((r) => r.path === '/public/v1/items').map((r) => r.query.folderId))
      assert.deepEqual([...listed].sort(), [f1, f2, f4].sort(), 'запрошены элементы известных и новых папок, но не корня и не F3')
      assert.deepEqual(result.stats.roots, [{ id: s.src.id, status: 'ok', folders: 5, items: 8, listed: 3 }])

      const all = nodes()
      const under = (id) => all.filter((n) => n.parent_id === id)
      assert.equal(under(f1).length, 3, 'новый файл в известной папке')
      assert.equal(under(f2).length, 3)
      assert.equal(under(f4).length, 2, 'новая папка перечислена')
      assert.ok(all.some((n) => n.node_id === f4 && n.kind === 'folder'), 'папки обходятся всегда полностью')
      const kept = under(f3)
      assert.deepEqual(kept.map((n) => n.node_id).sort(), oldF3.sort(), 'элементы неперечисленной папки перенесены как были')
      assert.ok(kept.every((n) => n.seen_gen === 2 && n.absent_nights === 0), 'и считаются видимыми в новом поколении')
      assert.equal(under(s.root).filter((n) => n.kind === 'item').every((n) => n.seen_gen === 2), true)

      // ночной полный обход догоняет: удалённый файл F3 становится «не виден», новый появляется
      assert.equal((await at(sync, '2030-03-05 05:10')).status, 'ok')
      const after = nodes()
      assert.equal(after.filter((n) => n.parent_id === f3 && n.absent_nights === 1).length, 1)
      assert.equal(after.filter((n) => n.parent_id === f3 && n.seen_gen === 3).length, 2)
    })
  })

  // ── расписание ──────────────────────────────────────────────────────────────────────────────────────────────────
  describe('расписание signal_sync_due (Europe/Moscow)', () => {
    const due = (iso) => sdb.read(null, async (tx) => (await tx.query('select osp_private.signal_sync_due($1::timestamptz) as r', [iso])).rows[0].r)
    const slot = (r) => r.slot && new Date(r.slot).toISOString()

    it('ночь 05:00–08:00, будни 08:00–20:59 каждый час, выходные — только ночь', async () => {
      const cases = [
        ['2030-03-04T01:59:00Z', { due: false }], // пн 04:59
        ['2030-03-04T02:00:00Z', { due: true, kind: 'night', slot: '2030-03-04T02:00:00.000Z' }], // пн 05:00
        ['2030-03-04T04:59:00Z', { due: true, kind: 'night', slot: '2030-03-04T02:00:00.000Z' }], // пн 07:59
        ['2030-03-04T05:00:00Z', { due: true, kind: 'day', slot: '2030-03-04T05:00:00.000Z' }], // пн 08:00
        ['2030-03-04T17:30:00Z', { due: true, kind: 'day', slot: '2030-03-04T17:00:00.000Z' }], // пн 20:30
        ['2030-03-04T18:00:00Z', { due: false }], // пн 21:00
        ['2030-03-08T09:15:00Z', { due: true, kind: 'day', slot: '2030-03-08T09:00:00.000Z' }], // пт 12:15
        ['2030-03-09T02:30:00Z', { due: true, kind: 'night', slot: '2030-03-09T02:00:00.000Z' }], // сб 05:30
        ['2030-03-09T09:00:00Z', { due: false }], // сб 12:00
        ['2030-03-10T09:00:00Z', { due: false }], // вс 12:00
        ['2030-03-10T02:00:00Z', { due: true, kind: 'night', slot: '2030-03-10T02:00:00.000Z' }], // вс 05:00
        // граница суток по Москве, не по UTC / не по поясу процесса
        ['2030-03-04T05:30:00Z', { due: true, kind: 'day', slot: '2030-03-04T05:00:00.000Z' }], // пн 08:30 МСК, в Лос-Анджелесе — воскресенье вечер
        ['2030-03-08T17:30:00Z', { due: true, kind: 'day', slot: '2030-03-08T17:00:00.000Z' }], // пт 20:30 МСК, в Токио — суббота 02:30
        ['2030-03-09T05:30:00Z', { due: false }], // сб 08:30 МСК, в Лос-Анджелесе — пятница вечер
        ['2030-03-03T21:30:00Z', { due: false }], // пн 00:30 МСК
      ]
      for (const [iso, expected] of cases) {
        const got = await due(iso)
        assert.deepEqual({ ...got, ...(got.slot ? { slot: slot(got) } : {}) }, expected, iso)
      }
    })

    it('такт берёт расписание у базы и не зависит от пояса процесса', async () => {
      const original = process.env.TZ
      try {
        const slots = []
        for (const [tz, day] of [['Asia/Tokyo', '2030-03-04'], ['America/Los_Angeles', '2030-03-05'], ['UTC', '2030-03-06'], ['Pacific/Kiritimati', '2030-03-07']]) {
          process.env.TZ = tz
          if (tz === 'Asia/Tokyo') assert.equal(new Date('2030-03-04T05:30:00Z').getHours(), 14, 'пояс процесса действительно сменился')
          scene({ folders: 1, items: 1 })
          const sync = mkSync()
          const result = await at(sync, `${day} 08:30`)
          assert.equal(result.status, 'ok', `${tz}: ${JSON.stringify(result)}`)
          slots.push(new Date(runs().at(-1).slot).toISOString())
          assert.deepEqual(await at(sync, `${day} 08:50`), { skipped: 'not_due' }, 'одна попытка на дневной слот')
          assert.equal((await at(sync, `${day} 09:05`)).status, 'ok', 'следующий час — новый слот')
          db.sql('TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_bindings, osp_private.signal_sources RESTART IDENTITY')
        }
        assert.deepEqual(slots, ['2030-03-04T05:00:00.000Z', '2030-03-05T05:00:00.000Z', '2030-03-06T05:00:00.000Z', '2030-03-07T05:00:00.000Z'])
      } finally {
        if (original === undefined) delete process.env.TZ
        else process.env.TZ = original
      }
    })

    it('ночной слот: успех закрывает ночь; сбой повторяется, не более трёх попыток', async () => {
      const s = scene({ folders: 1, items: 1 })
      const sync = mkSync()
      assert.equal((await at(sync, '2030-03-04 05:10')).status, 'ok')
      assert.deepEqual(await at(sync, '2030-03-04 06:30'), { skipped: 'not_due' })
      fake.denyProject(s.project)
      for (let i = 0; i < 3; i++) {
        const r = await at(sync, `2030-03-05 0${5 + i}:10`)
        assert.deepEqual([r.status, r.reason], ['failed', 'root_failed'], `попытка ${i + 1}`)
        assert.equal(sources()[0].last_error, 'scope')
      }
      assert.deepEqual(await at(sync, '2030-03-05 07:50'), { skipped: 'not_due' }, 'четвёртой попытки нет')
      assert.equal(runs().filter((r) => r.kind === 'night').length, 4)
    })

    it('нет корней, SIGNAL не настроен — прогон не начинается и в базе ничего не появляется', async () => {
      const sync = mkSync()
      assert.deepEqual(await at(sync, '2030-03-04 05:10'), { skipped: 'no_sources' })
      assert.deepEqual(await sync.runNow({ initiator: 'admin' }), { noSources: true })
      assert.equal(runs().length, 0)
      scene()
      const bare = mkSync({ api: mkApi({ clientId: '', clientSecret: '' }) })
      assert.deepEqual(await at(bare, '2030-03-04 05:10'), { skipped: 'not_configured' })
      assert.deepEqual(await bare.runNow({ initiator: 'admin' }), { notConfigured: true })
      assert.equal(runs().length, 0)
      assert.equal(fake.requests.length, 0, 'без настройки в SIGNAL не ходим')
    })

    it('start(): такт сам запускает обход и останавливается', async () => {
      scene({ folders: 2, items: 1 })
      clock = msk('2030-03-04 05:10')
      const sync = mkSync({ config: { tickMs: 40, firstDelayMs: 10 } })
      sync.start()
      sync.start() // повторный запуск ничего не удваивает
      for (let i = 0; i < 100 && meta().generation < 1; i++) await wait(100)
      assert.equal(meta().generation, 1)
      await wait(200) // слот закрыт, следующие такты ничего не начинают
      assert.equal(runs().length, 1)
      await sync.stop()
      assert.deepEqual(await sync.tick(), { skipped: 'stopped' })
    })
  })

  // ── соединения и остановка ──────────────────────────────────────────────────────────────────────────────────────
  describe('нет открытой транзакции во время HTTP; остановка', () => {
    it('во время запроса к SIGNAL и ожидания Retry-After соединения базы не заняты, heartbeat идёт', async () => {
      scene({ folders: 2, items: 2 })
      const monitor = await db.connect()
      monitors.push(monitor)
      const sample = async () => (await monitor.query(`select state, left(query, 80) as query from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
          and state is distinct from 'idle' and query not like '%signal_sync_heartbeat%'`)).rows
      const samples = []
      const beats = []
      let arrivals = 0
      fake.itemsDelayMs = 600
      // первая — «боковая» проверка: при каждом запросе элементов снимаем состояние соединений через 250 мс (посреди ответа)
      fake.fail((r) => {
        if (r.path === '/public/v1/items') {
          arrivals += 1
          if (arrivals <= 2) setTimeout(() => { sample().then((rows) => samples.push(rows), () => {}) }, 250)
          if (arrivals === 1) beats.push(events.filter((e) => e.name === 'signal_sync_heartbeat').length)
          if (arrivals === 2) beats.push(events.filter((e) => e.name === 'signal_sync_heartbeat').length)
        }
        return false
      }, { times: 1_000_000 })
      fake.fail('/public/v1/items', { status: 429, headers: { 'retry-after': '1' }, times: 1 })
      const sync = mkSync({ config: { heartbeatMs: 100 } })
      const result = await manual(sync)
      assert.equal(result.status, 'ok', JSON.stringify(result))
      assert.equal(samples.length, 2, 'оба замера сделаны')
      for (const rows of samples) assert.deepEqual(rows, [], 'во время HTTP у прогона нет ни открытой транзакции, ни активного запроса')
      assert.ok(beats[1] - beats[0] >= 3, `heartbeat шёл во время ожидания 429 (${beats.join(' → ')})`)
    })

    it('stop(): обход прерывается без публикации, прогон отмечен cancelled (stopped), новые запросы не идут', async () => {
      scene({ folders: 3, items: 20 })
      fake.itemsDelayMs = 300
      const sync = mkSync()
      const started = await sync.runNow({ initiator: 'admin' })
      await wait(450)
      const t0 = Date.now()
      await sync.stop()
      assert.ok(Date.now() - t0 < 5000, 'stop не ждёт конца обхода')
      const result = await started.done
      assert.deepEqual([result.status, result.reason], ['cancelled', 'stopped'])
      assert.deepEqual([runs().at(-1).status, runs().at(-1).reason], ['cancelled', 'stopped'])
      assert.equal(meta().generation, 0)
      assert.equal(nodes().length, 0)
      assert.equal(stageCount(), 0)
      const seen = fake.requests.length
      await wait(500)
      assert.equal(fake.requests.length, seen, 'после остановки запросов к SIGNAL нет')
      assert.deepEqual(await sync.runNow({ initiator: 'admin' }), { stopped: true })
    })

    it('stop() без прогона возвращается сразу', async () => {
      const sync = mkSync()
      sync.start()
      await sync.stop()
    })
  })

  // ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('signal-cli', () => {
    const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000,
    })

    it('разбор команд: неизвестная команда, лишние и неполные аргументы → код 1 без обращения к базе', () => {
      for (const args of [[], ['nope'], ['probe', 'x'], ['sync', '--force'], ['accept-held'], ['accept-held', '--run', '5'],
        ['accept-held', '--run', 'abc', '--expected-generation', '1', '--reason', 'проверено'],
        ['accept-held', '--run', '5', '--expected-generation', '-1', '--reason', 'проверено'],
        ['accept-held', '--run', '5', '--expected-generation', '1', '--reason', 'я'],
        ['accept-held', '--run', '5', '--run', '6', '--expected-generation', '1', '--reason', 'проверено'],
        ['accept-held', '--run', '5', '--expected-generation', '1', '--reason']]) {
        const out = cli(args)
        assert.equal(out.status, 1, `${args.join(' ')}: ${out.stderr}`)
        assert.match(out.stderr, /Использование/)
      }
    })

    it('probe и sync без настройки SIGNAL → код 4, секрета в выводе нет', () => {
      for (const cmd of ['probe', 'sync']) {
        const out = cli([cmd], { OSP_DB_URL: db.url })
        assert.equal(out.status, 4, out.stderr)
        assert.match(out.stderr, /FAIL .*SIGNAL/)
      }
    })

    it('accept-held: отказ при чужом поколении (код 4), принятие последнего held (код 0)', async () => {
      const s = scene({ folders: 30, items: 1 })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      for (const [, id] of Object.entries(s.ids).filter(([p]) => p !== 'Корень').slice(0, 15)) fake.removeFolder(s.project, id)
      const held = await manual(sync)
      assert.equal(held.status, 'held')
      const env = { OSP_DB_URL: db.url }
      let out = cli(['accept-held', '--run', String(held.runId), '--expected-generation', '9', '--reason', 'проверено вручную'], env)
      assert.equal(out.status, 4)
      assert.match(out.stderr, /FAIL stale_state/)
      assert.equal(meta().generation, 1)
      out = cli(['accept-held', '--run', String(held.runId), '--expected-generation', '1', '--reason', 'проверено вручную'], env)
      assert.equal(out.status, 0, out.stderr)
      assert.match(out.stdout, /принят/)
      assert.equal(meta().generation, 2)
      assert.deepEqual([runs().at(-1).status, runs().at(-1).accepted_by, runs().at(-1).accept_reason], ['ok', 'cli', 'проверено вручную'])
    })
  })
})
