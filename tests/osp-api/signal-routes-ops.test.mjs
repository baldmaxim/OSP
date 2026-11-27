// Работа службы вокруг сверки с Signal (server/osp-api/src/app.js, config.js, lib/signalJobs.js) на настоящей базе:
//   • В-8: неверные настройки SIGNAL_* при SIGNAL_SYNC=1 не роняют запуск — сверка выключена с причиной config_invalid, портал отвечает,
//     в журнале службы — имена переменных (значений нет), /api/health показывает config_invalid, администратор видит причину и имена;
//     С-49: шаблон адреса, не разбираемый SIGNAL_URL_FORMATS, — тоже config_invalid;
//   • С-25: сверку выключает только «нет схемы» (42P01, 42883, 3F000); блокировка, таймаут, лимит соединений и обрыв связи при периодической
//     проверке — повтор, состояние прежнее: идущий обход не отменяется, маршруты не мигают;
//   • С-37: расчёт очереди уступает циклу событий — разбор очереди из 2000 договоров не задерживает остальные запросы дольше 100 мс.
// Данные — синтетика. Нужны PostgreSQL и зависимости сервера.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { startSignalApp, FOLDER_FORMAT, ITEM_FORMAT } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { startFakeSignal } from './lib/fake-signal.mjs'

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('В-8, С-49: неверные настройки SIGNAL_* не роняют запуск', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let s
  let loadConfig
  const apps = []
  const SECRET_VALUE = 'неверное-значение-не-для-журнала'
  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    ;({ loadConfig } = await import(path.join(SERVER, 'src', 'config.js')))
  })
  after(async () => {
    for (const h of apps) await h.close()
    await db?.stop()
  })
  const start = async (env, extra = {}) => {
    const logs = []
    const signal = loadConfig({ SIGNAL_SYNC: '1', ...env }).signal
    const h = await startSignalApp(db, { signal: { ...signal, timers: false }, logs, ...extra })
    apps.push(h)
    return { h, logs, signal }
  }
  const noValues = (text) => assert.ok(!String(text).includes(SECRET_VALUE), 'значение переменной не выводится')

  it('опечатка в SIGNAL_DAY_MODE: служба запускается, сверка выключена (config_invalid), в журнале — имя переменной без значения, остальное работает', async () => {
    const { h, logs, signal } = await start({ SIGNAL_DAY_MODE: SECRET_VALUE })
    assert.deepEqual(signal.configErrors, ['SIGNAL_DAY_MODE'])
    assert.equal(h.app.signal.capability.active(), false)
    assert.equal(h.app.signal.timers(), false, 'очередь и обход не стартуют')
    // Портал отвечает: здоровье, права, обычные маршруты других разделов.
    const health = await h.get(null, '/api/health')
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().configured.signal, 'config_invalid')
    assert.equal(health.json().ok, true)
    noValues(health.body)
    assert.ok(!/SIGNAL_DAY_MODE/.test(health.body), 'открытый /api/health имён переменных не раскрывает')
    // Журнал службы: ошибка с именами переменных, значения нет.
    const errors = logs.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((l) => l && l.level >= 50)
    const logged = errors.find((l) => /config_invalid/.test(l.msg || ''))
    assert.ok(logged, `в журнале нет ошибки config_invalid: ${logs.join('').slice(0, 300)}`)
    assert.deepEqual(logged.vars, ['SIGNAL_DAY_MODE'])
    noValues(logs.join('\n'))
    // Вкладка «Signal»: администратору — причина и имена, остальным — только {enabled:false}; маршруты — 503.
    const admin = (await h.get(s.users.admin, '/api/signal/status')).json()
    assert.deepEqual(admin, { enabled: false, disabledReason: 'config_invalid', configErrors: ['SIGNAL_DAY_MODE'] })
    noValues(JSON.stringify(admin))
    assert.deepEqual((await h.get(s.users.editor, '/api/signal/status')).json(), { enabled: false })
    for (const url of ['/api/signal/marks', `/api/signal/contracts/${s.contracts.c1}`, '/api/signal/runs', `/api/signal/tree?sourceId=${s.srcA.id}`]) {
      const res = await h.get(s.users.admin, url)
      assert.deepEqual([res.statusCode, res.json().code], [503, 'signal_disabled'], url)
    }
    assert.equal((await h.post(s.users.admin, '/api/signal/sync', {})).statusCode, 503)
    assert.equal((await h.get(s.users.contractor, '/api/signal/status')).statusCode, 403, 'подрядчику по-прежнему отказ')
  })

  it('несколько ошибок и шаблон адреса вне SIGNAL_URL_FORMATS (С-49): названы все переменные; исправление — сверка включается', async () => {
    const bad = {
      SIGNAL_URL_FORMATS: FOLDER_FORMAT, SIGNAL_UI_FOLDER_URL: FOLDER_FORMAT, SIGNAL_UI_FILE_URL: ITEM_FORMAT, SIGNAL_TICK_MS: '5',
    }
    const { h, logs } = await start(bad)
    const admin = (await h.get(s.users.admin, '/api/signal/status')).json()
    assert.deepEqual([admin.enabled, admin.disabledReason], [false, 'config_invalid'])
    assert.deepEqual([...admin.configErrors].sort(), ['SIGNAL_TICK_MS', 'SIGNAL_UI_FILE_URL'], 'шаблон файла не входит в SIGNAL_URL_FORMATS')
    assert.ok(logs.join('\n').includes('SIGNAL_UI_FILE_URL'))
    // Исправили настройки — та же база, сверка включена.
    const fixed = await start({ SIGNAL_URL_FORMATS: `${FOLDER_FORMAT}; ${ITEM_FORMAT}`, SIGNAL_UI_FOLDER_URL: FOLDER_FORMAT, SIGNAL_UI_FILE_URL: ITEM_FORMAT })
    assert.equal(fixed.signal.configErrors.length, 0)
    assert.equal(fixed.h.app.signal.capability.active(), true)
    assert.equal((await fixed.h.get(null, '/api/health')).json().configured.signal, false, 'ключ Signal не задан — «не настроена», но не config_invalid')
    assert.equal((await fixed.h.get(s.users.editor, '/api/signal/status')).json().enabled, true)
  })

  it('ошибка в секретных настройках: имя переменной в журнале, значение секрета — нет', async () => {
    const secret = 'sig-секрет-для-проверки-журнала'
    const { h, logs } = await start({ SIGNAL_CLIENT_ID: secret })
    const admin = (await h.get(s.users.admin, '/api/signal/status')).json()
    assert.deepEqual(admin.configErrors, ['SIGNAL_CLIENT_ID'])
    assert.ok(!logs.join('\n').includes(secret) && !JSON.stringify(admin).includes(secret))
  })
})

describe('С-25: проверка схемы выключает сверку только при «нет схемы»', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let sdb
  let s
  let fake
  let createSignalCapability
  const err = (code, message = 'сбой') => Object.assign(new Error(message), { code })
  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb()
    s = await seedScenario(db)
    fake = await startFakeSignal()
    ;({ createSignalCapability } = await import(path.join(SERVER, 'src', 'lib', 'signalJobs.js')))
  })
  after(async () => {
    await fake?.close()
    await db?.stop()
  })

  const flaky = () => {
    const mode = { fail: null }
    return { mode, db: { read: (who, fn, opts) => (mode.fail ? Promise.reject(mode.fail) : sdb.read(who, fn, opts)) } }
  }

  it('любая ошибка проверки, кроме «нет схемы», — повтор: состояние прежнее (включено остаётся включённым), причина db_error только до первой удачной проверки', async () => {
    const { mode, db: wrapped } = flaky()
    const changes = []
    const cap = createSignalCapability({ db: wrapped, onChange: (v) => changes.push(v) })
    // Ни одной удачной проверки: выключено, причина — «не удалось проверить».
    mode.fail = err('55P03', 'canceling statement due to lock timeout')
    assert.equal(await cap.refresh(), null)
    assert.deepEqual([cap.active(), cap.reason()], [false, 'db_error'])
    mode.fail = null
    assert.equal(await cap.refresh(), true)
    assert.deepEqual([cap.active(), cap.reason()], [true, null])
    for (const code of ['55P03', '57014', '53300', '40001', '40P01', '08006', 'ECONNREFUSED', '57P01', 'XX000']) {
      mode.fail = err(code)
      assert.equal(await cap.refresh(), null, code)
      assert.equal(cap.active(), true, `${code}: состояние прежнее`)
    }
    mode.fail = Object.assign(new Error('Connection terminated unexpectedly'))
    assert.equal(await cap.refresh(), null)
    assert.equal(cap.active(), true)
    mode.fail = { name: 'DbError', message: 'обёртка', cause: err('55P03') }
    assert.equal(await cap.refresh(), null)
    assert.deepEqual(changes, [true], 'ни одной смены состояния из-за ошибок проверки')
  })

  it('«нет схемы» — 42P01 (нет таблицы), 42883 (нет функции), 3F000 (нет схемы), в том числе из причины ошибки обёртки: сверка выключается, причина no_schema; схема вернулась — включается', async () => {
    for (const code of ['42P01', '42883', '3F000']) {
      const { mode, db: wrapped } = flaky()
      const changes = []
      const cap = createSignalCapability({ db: wrapped, onChange: (v) => changes.push(v) })
      assert.equal(await cap.refresh(), true)
      mode.fail = err(code)
      assert.equal(await cap.refresh(), false, code)
      assert.deepEqual([cap.active(), cap.reason()], [false, 'no_schema'], code)
      mode.fail = null
      assert.equal(await cap.refresh(), true)
      assert.deepEqual(changes, [true, false, true], code)
    }
    const { mode, db: wrapped } = flaky()
    const cap = createSignalCapability({ db: wrapped })
    await cap.refresh()
    mode.fail = { name: 'DbError', message: 'обёртка', cause: err('42P01') }
    assert.equal(await cap.refresh(), false)
    assert.equal(cap.reason(), 'no_schema')
  })

  it('периодическая проверка при ошибке повторяется через retryMs, при успехе — через intervalMs', async () => {
    const { mode, db: wrapped } = flaky()
    let calls = 0
    const counting = { read: (who, fn, o) => { calls += 1; return wrapped.read(who, fn, o) } }
    const timed = createSignalCapability({ db: counting, options: { intervalMs: 60_000, retryMs: 20 } })
    assert.equal(await timed.refresh(), true)
    mode.fail = err('55P03')
    assert.equal(await timed.refresh(), null)
    const before = calls
    timed.start()
    await sleep(200)
    timed.stop()
    assert.ok(calls - before >= 3, `после ошибки проверка повторяется по retryMs, а не по intervalMs: ${calls - before}`)
    assert.equal(timed.active(), true)
  })

  it('сквозной: сбой проверки схемы во время обхода (55P03) не отменяет обход, маршруты не мигают; «нет схемы» — отменяет, как раньше', async () => {
    // Корни сцены «Альфа» и «Бета» поддельному Signal не известны: обходим только свой.
    db.sql(`update osp_private.signal_sources set enabled = false where id in (${s.srcA.id}, ${s.srcB.id})`)
    const project = fake.addProject({ name: 'Тест: проект Сбой' })
    const { ids } = fake.build(project, { name: 'Корень', children: Array.from({ length: 12 }, (_, i) => ({ name: `Корпус ${i + 1}`, items: 1 })) })
    const obj = db.seed.object({ name: 'Тест: объект сбой', code: 'СБО' })
    db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
    fake.itemsDelayMs = 150 // обход ≈ 2 с
    const f = flaky()
    const h = await startSignalApp(db, { fake, deps: { signalCapability: { db: f.db } } })
    try {
      const cap = h.app.signal.capability
      assert.equal(cap.active(), true)
      const started = await h.app.signal.sync.runNow({ initiator: 'admin' })
      assert.ok(started.started, JSON.stringify(started))
      await sleep(400)
      assert.equal(one(db, 'select status from osp_private.signal_runs order by id desc limit 1'), 'running')
      f.mode.fail = err('55P03', 'canceling statement due to lock timeout')
      assert.equal(await cap.refresh(), null)
      f.mode.fail = null // блокировка длилась лишь на время проверки
      assert.equal(cap.active(), true, 'возможность не выключена')
      assert.equal((await h.get(s.users.viewer, '/api/signal/status')).json().enabled, true, 'маршруты отвечают')
      assert.equal((await h.get(s.users.viewer, '/api/signal/marks')).statusCode, 200)
      const done = await started.done
      assert.equal(done.status, 'ok', `обход не отменён: ${done.status}:${done.reason}`)
      // «Нет схемы» — настоящая причина выключить: обход прекращается, маршруты «выключено».
      f.mode.fail = err('42P01', 'relation does not exist')
      assert.equal(await cap.refresh(), false)
      f.mode.fail = null
      assert.deepEqual((await h.get(s.users.viewer, '/api/signal/status')).json(), { enabled: false })
      assert.deepEqual((await h.get(s.users.admin, '/api/signal/status')).json(), { enabled: false, disabledReason: 'no_schema', configErrors: [] })
    } finally {
      fake.itemsDelayMs = 0
      await h.close()
    }
  })

  it('первая проверка при запуске не получила ответа базы: возможность выключена (db_error), администратор видит причину; следующая удачная — включает', async () => {
    const f = flaky()
    f.mode.fail = err('ECONNREFUSED', 'connect ECONNREFUSED')
    const h = await startSignalApp(db, { signal: { timers: undefined }, deps: { signalCapability: { db: f.db } } })
    try {
      const cap = h.app.signal.capability
      assert.deepEqual([cap.active(), cap.reason()], [false, 'db_error'])
      assert.deepEqual((await h.get(s.users.admin, '/api/signal/status')).json(), { enabled: false, disabledReason: 'db_error', configErrors: [] })
      assert.equal(h.app.signal.timers(), false)
      f.mode.fail = null
      assert.equal(await cap.refresh(), true)
      assert.equal(h.app.signal.timers(), true, 'такты стартовали, когда схема подтвердилась')
      assert.equal((await h.get(s.users.viewer, '/api/signal/status')).json().enabled, true)
    } finally {
      await h.close()
    }
  })
})

describe('С-37: расчёт очереди уступает циклу событий', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let sdb
  let createSignalJobs
  const CONTRACTS = 2000
  const FOLDERS = 700
  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4 })
    ;({ createSignalJobs } = await import(path.join(SERVER, 'src', 'lib', 'signalJobs.js')))
  })
  after(async () => { await db?.stop() })

  it(`очередь из ${CONTRACTS} договоров одного крупного подрядчика (${FOLDERS} папок с его названием): наибольшая пауза цикла событий < 100 мс, очередь разобрана`, async () => {
    const { seed } = db
    const A = seed.object({ name: 'Тест: объект нагрузки', code: 'ЛОК' })
    const cp = seed.counterparty({ name: 'ООО Ромашка-Строй', inn: '7700000001' })
    const src = seed.source({ objectIds: [A] })
    db.sql(`insert into osp_private.signal_nodes (node_id, project_id, source_id, kind, parent_id, name, path, path_ids, depth, object_id, number_keys, name_norm, features, first_gen, seen_gen)
      select ('00000007-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, ${lit(src.projectId)}, ${src.id}, 'folder', ${lit(src.folderId)}::uuid,
             'ДП ЛОК-ДП-26-' || lpad(g::text, 4, '0') || ' ООО Ромашка-Строй, корпус ' || (g % 20),
             'Корень / Корпус ' || (g % 20) || ' / ДП ЛОК-ДП-26-' || lpad(g::text, 4, '0') || ' ООО Ромашка-Строй, корпус ' || (g % 20),
             array[${lit(src.folderId)}::uuid], 1, ${lit(A)}::uuid, array['ЛОК|2026|' || g],
             lower('ДП ЛОК-ДП-26-' || lpad(g::text, 4, '0') || ' ООО Ромашка-Строй, корпус ' || (g % 20)), '{}'::jsonb, 1, 1
        from generate_series(1, ${FOLDERS}) g;
      insert into osp_private.signal_nodes (node_id, project_id, source_id, kind, parent_id, name, path, path_ids, depth, object_id, name_norm, first_gen, seen_gen)
        values (${lit(src.folderId)}, ${lit(src.projectId)}, ${src.id}, 'folder', null, 'Корень', 'Корень', '{}', 0, ${lit(A)}, 'корень', 1, 1);
      update osp_private.signal_meta set generation = 1, published_at = now() where id = 1;
      insert into public.contracts (object_id, record_type, contract_number, counterparty_id, status)
        select ${lit(A)}, 'dp', 'ЛОК-ДП-26-' || lpad((5000 + g)::text, 4, '0'), ${lit(cp)}, 'in_work' from generate_series(1, ${CONTRACTS}) g;
      insert into public.contract_counterparties (contract_id, counterparty_id) select id, ${lit(cp)} from public.contracts;`)
    db.sql('select osp_private.signal_enqueue_all()')
    assert.equal(one(db, 'select count(*) from osp_private.signal_queue'), String(CONTRACTS))
    const jobs = createSignalJobs({ db: sdb, log: { info() {}, warn() {} }, config: { urlFormats: [FOLDER_FORMAT, ITEM_FORMAT], maxPortions: 3 } })

    // Пауза цикла событий: таймер в 5 мс опаздывает на столько, сколько цикл был занят.
    let last = performance.now()
    let maxGap = 0
    const gaps = []
    const timer = setInterval(() => {
      const now = performance.now()
      const gap = now - last - 5
      last = now
      if (gap > maxGap) maxGap = gap
      if (gap > 100) gaps.push(Math.round(gap))
    }, 5)
    const t0 = performance.now()
    let guard = 0
    try {
      while (Number(one(db, 'select count(*) from osp_private.signal_queue')) > 0 && guard++ < 30) await jobs.tick()
    } finally {
      clearInterval(timer)
    }
    const wall = Math.round(performance.now() - t0)
    console.log(`  С-37: ${CONTRACTS} договоров, ${wall} мс, наибольшая пауза ${Math.round(maxGap)} мс, пауз > 100 мс: ${gaps.length}`)
    assert.equal(one(db, 'select count(*) from osp_private.signal_queue'), '0', 'очередь разобрана')
    assert.equal(one(db, 'select count(*) from osp_private.signal_contracts'), String(CONTRACTS))
    assert.ok(maxGap < 100, `цикл событий стоял ${Math.round(maxGap)} мс (паузы > 100 мс: ${gaps.join(', ')})`)
  })
})
