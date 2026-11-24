// POST /api/signal/match — сверка договоров по опубликованному снимку (раздел 7, маршрут 5; инвариант 7) на настоящей базе:
//   • 1–200 уникальных идентификаторов; 0, 201, повтор и не-uuid — 400;
//   • право правки и охват проверяются на каждый договор: любой чужой — 403 на весь запрос, ничего не считается и не пишется;
//   • в Signal запросов нет вообще (поддельный SIGNAL считает каждое обращение), ссылка договора (contracts.signal_link),
//     «Историю» и журнал базы маршрут не трогает;
//   • результат тот же, что у очереди: состояния, узлы и предложения после /match равны состояниям после прохода очереди по
//     тому же снимку, и не зависят от того, как договоры разбиты на порции;
//   • сверка сразу видна: правка договора не ждёт такта очереди, строка очереди подтверждена (значок не «ожидает»).
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startSignalApp } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { startFakeSignal } from './lib/fake-signal.mjs'

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`

describe('POST /api/signal/match: снимок, без Signal, без записи ссылки, как очередь', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let h
  let fake
  let U
  let C
  let F
  const match = (uid, ids) => h.post(uid, '/api/signal/match', { contractIds: ids })
  const stateRows = (ids) => db.sql(`select c.id || '|' || sc.state || '|' || coalesce(sc.reason, '') || '|' || coalesce(sc.node_id::text, '') || '|' || sc.fingerprint || '|' ||
      coalesce((select string_agg(k.node_id::text || ':' || k.status || ':' || k.score || ':' || array_to_string(k.reasons, ',') || ':' || array_to_string(k.flags, ','), ';' order by k.node_id)
        from osp_private.signal_candidates k where k.contract_id = c.id), '')
    from osp_private.signal_contracts sc join public.contracts c on c.id = sc.contract_id
    where c.id in (${ids.map(lit).join(', ')}) order by c.id`).split('\n').filter(Boolean)
  const contractsDump = () => db.sql(`select md5(string_agg(id::text || coalesce(signal_link, '') || coalesce(updated_at::text, ''), ',' order by id)) from public.contracts`)
  const auditCounts = () => db.sql(`select (select count(*) from public.contract_audit_log) || '|' || (select count(*) from osp_private.data_audit_log where table_name = 'contracts')`)

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    C = s.contracts
    F = s.folders
    fake = await startFakeSignal()
    h = await startSignalApp(db, { fake, limits: { signalMatchPerUser: { max: 1000, windowMs: 60_000 } } })
    await h.tick()
    fake.resetRequests()
  })
  after(async () => {
    await h?.close()
    await fake?.close()
    await db?.stop()
  })

  it('тело: 1–200 уникальных uuid; пусто, 201, повтор, не uuid, не массив — 400', async () => {
    const bad = [[], Array.from({ length: 201 }, () => crypto.randomUUID()), [C.c1, C.c1], ['не-uuid'], [null]]
    for (const ids of bad) assert.equal((await match(U.editor, ids)).statusCode, 400, JSON.stringify(ids).slice(0, 60))
    assert.equal((await h.post(U.editor, '/api/signal/match', { contractIds: C.c1 })).statusCode, 400)
    assert.equal((await h.post(U.editor, '/api/signal/match', {})).statusCode, 400)
    assert.equal((await h.post(U.editor, '/api/signal/match', { contractIds: [C.c1], лишнее: 1 })).statusCode, 200, 'лишние поля отбрасываются')
  })

  it('ровно 200 договоров — один запрос; 201 — отказ (порции по 200 — забота клиента)', async () => {
    // 199 новых договоров объекта A (номера без папок) и c1.
    db.sql(`insert into public.contracts (contract_number, object_id, status)
      select 'АЛФ-ДП-26-' || lpad((100 + i)::text, 3, '0'), ${lit(s.A)}, 'in_work' from generate_series(1, 199) i`)
    const ids = db.sql(`select id from public.contracts where object_id = ${lit(s.A)} and contract_number >= 'АЛФ-ДП-26-101' and contract_number <= 'АЛФ-ДП-26-299' order by contract_number`).split('\n').filter(Boolean)
    assert.equal(ids.length, 199)
    const res = await match(U.editor, [C.c1, ...ids])
    assert.equal(res.statusCode, 200, res.body.slice(0, 300))
    const body = res.json()
    assert.equal(body.items.length, 200)
    assert.deepEqual(new Set(body.items.map((x) => x.id)), new Set([C.c1, ...ids]))
    assert.equal((await match(U.editor, [C.c2, ...ids, crypto.randomUUID()])).statusCode, 400)
    await h.tick()
  })

  it('чужой договор — 403 на весь запрос: ничего не считается и не пишется, ответ без деталей', async () => {
    const before = { rows: stateRows([C.cb, C.c3]), audit: auditCounts() }
    const at = db.sql(`select max(updated_at) from osp_private.signal_contracts`)
    const mixed = await match(U.editorB, [C.cb, C.c1])
    assert.equal(mixed.statusCode, 403)
    assert.deepEqual(mixed.json(), { error: 'Недостаточно прав', code: 'forbidden' })
    assert.ok(!/Альфа|Ромашка|АЛФ/.test(mixed.body))
    const missing = await match(U.editor, [C.c1, crypto.randomUUID()])
    assert.equal(missing.statusCode, 403, 'несуществующий — тоже 403: существование чужого не раскрывается')
    db.sql(`update public.contracts set deleted_at = now() where id = ${lit(C.c3)}`)
    assert.equal((await match(U.editor, [C.c1, C.c3])).statusCode, 403, 'удалённый договор')
    db.sql(`update public.contracts set deleted_at = null where id = ${lit(C.c3)}`)
    assert.equal(db.sql(`select max(updated_at) from osp_private.signal_contracts`), at, 'запись состояний не началась')
    assert.deepEqual(stateRows([C.cb, C.c3]), before.rows)
    assert.equal(fake.requests.length, 0)
  })

  it('права: просмотр без правки, подрядчик и сотрудник без права на «Договоры» — 403', async () => {
    for (const uid of [U.viewer, U.viewerB, U.contractor, U.noRight]) assert.equal((await match(uid, [C.c1])).statusCode, 403)
    assert.equal((await match(U.editorB, [C.cb])).statusCode, 200, 'свой объект редактору с охватом по объектам — можно')
    assert.equal((await h.post(null, '/api/signal/match', { contractIds: [C.c1] })).statusCode, 401)
  })

  it('ответ: состояние, причина, узел и путь — только видимого узла; предложение — первая по баллам; без Signal и без записи ссылки', async () => {
    const linksBefore = contractsDump()
    const auditBefore = auditCounts()
    const res = await match(U.editor, [C.c1, C.c2, C.c3, C.c4, C.ds1])
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['cache-control'], 'private, no-store')
    const body = res.json()
    assert.match(body.dataAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    const by = Object.fromEntries(body.items.map((x) => [x.id, x]))
    assert.deepEqual(by[C.c1], { id: C.c1, state: 'suggested', reason: 'candidates', nodeId: F.f1, path: 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-001 ООО Ромашка', hasCandidate: true })
    assert.deepEqual(by[C.c2], { id: C.c2, state: 'verified', reason: 'existing_url', nodeId: F.f2, path: 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-002 ООО Ромашка', hasCandidate: false })
    assert.deepEqual(by[C.c3], { id: C.c3, state: 'none', reason: 'none', hasCandidate: false })
    assert.equal(by[C.c4].state, 'conflict')
    assert.equal(by[C.c4].reason, 'number_mismatch')
    assert.deepEqual([by[C.ds1].state, by[C.ds1].nodeId], ['suggested', F.fds1])
    // Чужой объект: ни путей, ни идентификаторов в ответе объекта A.
    assert.ok(!res.body.includes(F.fb1) && !res.body.includes('Бета'))
    assert.equal(contractsDump(), linksBefore, 'договоры (ссылки, даты правки) не тронуты')
    assert.equal(auditCounts(), auditBefore, 'ни «Истории», ни журнала базы по договорам')
    assert.equal(fake.requests.length, 0, 'в Signal ни одного запроса')
    assert.equal(fake.violations.length, 0)
  })

  it('результат равен проходу очереди по тому же снимку — состояния, узлы, предложения и отпечатки; порции и порядок не меняют ответ', async () => {
    const ids = [C.c1, C.c2, C.c3, C.c4, C.cb, C.ds1]
    const res = await match(U.editor, ids)
    assert.equal(res.statusCode, 200, res.body)
    const viaMatch = stateRows(ids)
    assert.equal(viaMatch.length, ids.length)
    // Состояния сброшены, договоры поставлены в очередь — тот же снимок, проход очереди.
    const list = ids.map(lit).join(', ')
    db.sql(`delete from osp_private.signal_candidates where contract_id in (${list})`)
    db.sql(`delete from osp_private.signal_contracts where contract_id in (${list})`)
    for (const id of ids) db.seed.enqueue(id)
    await h.tick()
    assert.deepEqual(stateRows(ids), viaMatch, 'очередь и /match записывают одно и то же')
    // Ответ /match совпадает с записанным состоянием.
    const marks = Object.fromEntries((await h.get(U.editor, '/api/signal/marks')).json().items.map((m) => [m.id, m]))
    for (const it of res.json().items) assert.deepEqual([it.state, it.reason], [marks[it.id].state, marks[it.id].reason], it.id)
    // Разбиение на порции и порядок договоров — те же результаты.
    const jobs = h.app.signal.jobs
    const norm = (r) => JSON.stringify(r.results.map(({ id, state, reason, nodeId, path, candidates, fingerprint, ctxKey }) => ({ id, state, reason, nodeId, path, candidates, fingerprint, ctxKey })).sort((a, b) => (a.id < b.id ? -1 : 1)))
    const all = norm(await jobs.processContracts(ids))
    const reversed = norm(await jobs.processContracts([...ids].reverse()))
    const single = norm({ results: (await Promise.all(ids.map((id) => jobs.processContracts([id])))).flatMap((r) => r.results) })
    assert.equal(reversed, all)
    assert.equal(single, all)
  })

  it('сверка сразу видна: правка договора не ждёт такта — /match считает по новым данным, строка очереди подтверждена, значок не «ожидает»', async () => {
    // Номер договора 009 заменён на номер папки f4 — пока такт не прошёл, значок «ожидает».
    db.sql(`update public.contracts set contract_number = 'АЛФ-ДП-26-004' where id = ${lit(C.c3)}`)
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(C.c3)}`), '1')
    const pending = (await h.get(U.editor, '/api/signal/marks')).json().items.find((m) => m.id === C.c3)
    assert.deepEqual([pending.state, pending.pending], ['none', true])
    const res = await match(U.editor, [C.c3])
    assert.deepEqual(res.json().items[0], { id: C.c3, state: 'suggested', reason: 'candidates', nodeId: F.f4, path: 'Документы Альфа / Корпус 2 / ДП АЛФ-ДП-26-004 ООО Ромашка', hasCandidate: true })
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(C.c3)}`), '0', 'ревизия очереди подтверждена')
    const now = (await h.get(U.editor, '/api/signal/marks')).json().items.find((m) => m.id === C.c3)
    assert.deepEqual([now.state, now.pending, now.hasCandidate], ['suggested', false, true])
    assert.equal(fake.requests.length, 0)
  })

  it('устаревший снимок не записывается: договор правили между загрузкой и записью — результат отброшен базой, очередь остаётся', async () => {
    // Договор в очереди (ревизия R), загрузка видит R; пока считалось, договор правили (R+1): запись с R пропускается.
    const jobs = h.app.signal.jobs
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-004', objectId: s.A, counterparties: [s.cpR] })
    const store = jobs.store
    const loaded = await store.load([id])
    const revision = loaded.contracts[0].revision
    assert.ok(revision)
    db.sql(`update public.contracts set contract_number = 'АЛФ-ДП-26-005' where id = ${lit(id)}`)
    const written = await store.write(null, [{
      contractId: id, revision, generation: loaded.generation, state: 'none', reason: 'none', nodeId: null, fingerprint: 'x', ctxKey: 'x', candidates: [],
    }])
    assert.deepEqual(written, { written: 0, acked: 0, stale: 1 })
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`), '1')
    assert.equal(one(db, `select count(*) from osp_private.signal_contracts where contract_id = ${lit(id)}`), '0')
    // Снимок сменился — тоже.
    const stale = await store.write(null, [{
      contractId: id, revision: null, generation: Number(loaded.generation) + 7, state: 'none', reason: 'none', nodeId: null, fingerprint: 'x', ctxKey: 'x', candidates: [],
    }])
    assert.equal(stale.stale, 1)
    await h.tick()
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`), '0')
  })
})
