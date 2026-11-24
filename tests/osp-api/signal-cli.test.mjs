// Ручные команды SIGNAL (server/osp-api/src/signal-cli.js) probe / sync / accept-held против поддельного SIGNAL
// (tests/osp-api/lib/fake-signal.mjs) и настоящего PostgreSQL с настоящей миграцией (tests/osp-api/lib/signal-db.mjs).
// Логика CLI вызывается как runSignalCli(argv, { env, deps }): deps.signalClient (allowLoopback и адрес поддельного SIGNAL),
// deps.db и приёмники вывода передаются только отсюда — из окружения они не читаются, и проверка хостов в окружении та же
// (отдельный тест: http-адрес из SIGNAL_BASE_URL отвергается, запросов к поддельному SIGNAL нет). Разбор аргументов и запуск
// как скрипта (процесс, код выхода) проверяет signal-sync.test.mjs. Барьер записи на время переноса (OSP_DB_READONLY_FILE) CLI
// соблюдает как служба: sync и accept-held при закрытом барьере ничего не пишут (код 4), probe работает. Без PostgreSQL/Docker
// набор ПРОПУСКАЕТСЯ.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET } from './lib/fake-signal.mjs'
import { runSignalCli } from '../../server/osp-api/src/signal-cli.js'

// Названия, которых в выводе быть не должно: ни проектов, ни папок, ни файлов SIGNAL.
const PROJECT_NAME = 'Секретный проект Бета'
const ROOT_NAME = 'Секретный корень Альфа'
const FOLDER_PREFIX = 'Закрытая папка'
const ITEM_PREFIX = 'Закрытый файл'
const HIDDEN = [PROJECT_NAME, ROOT_NAME, FOLDER_PREFIX, ITEM_PREFIX, 'Документы']

describe('Команды SIGNAL (signal-cli): probe, sync, accept-held с внедрёнными зависимостями', { skip: signalDbSkip }, () => {
  let db
  let sdb
  let fake
  let outputs

  const q = (sql) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${sql}) t`)
  const meta = () => q('select generation, published_run_id from osp_private.signal_meta')[0]
  const nodes = () => q('select node_id, kind, name, path, depth, object_id, first_gen, seen_gen, absent_nights from osp_private.signal_nodes order by path, node_id')
  const runs = () => q('select id, kind, mode, status, reason, initiator, generation, accepted_by, accept_reason from osp_private.signal_runs order by id')
  const sources = () => q('select id, ready, last_error, folders_count, items_count from osp_private.signal_sources order by id')
  const stageCount = () => Number(db.sql('select count(*) from osp_private.signal_stage_nodes').split('\n')[0])
  const snapshot = () => ({ nodes: nodes(), meta: meta() })

  const env = (over = {}) => ({ SIGNAL_CLIENT_ID: CLIENT_ID, SIGNAL_CLIENT_SECRET: CLIENT_SECRET, ...over })
  // Зависимости только из теста: адрес и allowLoopback поддельного SIGNAL, короткие паузы повторов, настоящая обёртка базы.
  const testDeps = (over = {}) => ({
    db: sdb,
    signalClient: { baseUrl: fake.url, allowLoopback: true, backoffMs: [5, 5, 5], ...over },
  })

  // Запуск команды; весь вывод собирается, секрет, id клиента и токен в нём недопустимы.
  async function cli(argv, { env: e = env(), deps = testDeps() } = {}) {
    const stdout = []
    const stderr = []
    const code = await runSignalCli(argv, { env: e, deps: { ...deps, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) } })
    const res = { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), all: [...stdout, ...stderr].join('\n') }
    outputs.push(res.all)
    for (const secret of [CLIENT_SECRET, CLIENT_ID, fake.lastToken, 'eyJfake', e.SIGNAL_CLIENT_SECRET].filter(Boolean)) {
      assert.ok(!res.all.includes(secret), `в выводе «${argv[0]}» секрет или токен: ${secret.slice(0, 8)}…`)
    }
    return res
  }
  const noNames = (text) => { for (const name of HIDDEN) assert.ok(!text.includes(name), `в выводе название SIGNAL «${name}»:\n${text}`) }
  const noIds = (text) => assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), `в выводе идентификатор:\n${text}`)

  // Корень с папками и файлами; корень назначен одному объекту. Названия — из HIDDEN.
  function scene({ folders = 3, items = 2, rootItems = 1 } = {}) {
    const project = fake.addProject({ name: PROJECT_NAME })
    const { ids } = fake.build(project, {
      name: ROOT_NAME, items: rootItems, children: Array.from({ length: folders }, (_, i) => ({ name: `${FOLDER_PREFIX} ${i + 1}`, items })),
    })
    for (const folderId of Object.values(ids)) {
      // файлы получают общее скрытое название вместо «Файл N.pdf»
      const list = fake.state.items.get(folderId) || []
      list.forEach((it, i) => { it.name = `${ITEM_PREFIX} ${i + 1}.pdf` })
    }
    const obj = db.seed.object({ name: 'Тест: объект А', code: 'АЛИЯ' })
    const src = db.seed.source({ projectId: project, folderId: ids[ROOT_NAME], objectIds: [obj], name: PROJECT_NAME, rootPath: `${PROJECT_NAME} / ${ROOT_NAME}` })
    return { project, ids, obj, src, root: ids[ROOT_NAME] }
  }

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4 })
  })
  after(async () => { await db?.stop() })
  beforeEach(async () => {
    fake = await startFakeSignal()
    outputs = []
  })
  afterEach(async () => {
    assert.deepEqual(fake.violations, [], 'к SIGNAL — только чтение и токен')
    await fake.close()
    db.sql(`TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_candidates,
      osp_private.signal_contracts, osp_private.signal_queue, osp_private.signal_bindings, osp_private.signal_sources RESTART IDENTITY;
      UPDATE osp_private.signal_meta SET generation = 0, published_at = NULL, published_run_id = NULL WHERE id = 1`)
  })

  describe('probe', () => {
    it('печатает только счётчики (токен, проекты, корень, папки) и код 0; ни названий, ни идентификаторов; база не меняется', async () => {
      const s = scene({ folders: 3, items: 2 })
      fake.addProject({ name: `${PROJECT_NAME} 2` })
      const before = snapshot()
      const res = await cli(['probe'])
      assert.equal(res.code, 0, res.all)
      const lines = res.stdout.split('\n')
      assert.match(lines[0], /^SIGNAL: токен получен, срок 3\s600 с$/)
      assert.equal(lines[1], 'Проектов доступно: 2')
      // поддерево корня: сам корень и три папки; в проекте — ещё системная папка проекта
      assert.match(lines[2], new RegExp(`^Корень #${s.src.id}: найден, папок в поддереве 4; папок в проекте 5$`))
      assert.match(lines[3], /^Готово за \d+\.\d с$/)
      assert.equal(lines.length, 4, res.stdout)
      noNames(res.all)
      noIds(res.all)
      assert.deepEqual(res.stderr, '', 'без журнала шума')
      assert.deepEqual(snapshot(), before)
      assert.deepEqual(runs(), [], 'probe не создаёт прогонов')
      assert.equal(stageCount(), 0)
      assert.deepEqual(fake.paths().filter((p) => !p.startsWith('GET /public/v1/projects') && !p.startsWith('POST /public/v1/auth/token')), [], 'без запросов элементов')
    })

    it('корень не найден в дереве проекта → строка «НЕ НАЙДЕН», код 0; корней нет → «Включённых корней нет»', async () => {
      const none = await cli(['probe'])
      assert.equal(none.code, 0, none.all)
      assert.match(none.stdout, /Включённых корней нет/)

      const s = scene({ folders: 1, items: 0 })
      fake.removeFolder(s.project, s.root)
      const res = await cli(['probe'])
      assert.equal(res.code, 0, res.all)
      assert.match(res.stdout, new RegExp(`Корень #${s.src.id}: НЕ НАЙДЕН в дереве проекта; папок в проекте 1`))
      noNames(res.all)
      noIds(res.all)
    })

    it('без базы (нет deps.db и OSP_DB_URL) — только токен и проекты, код 0', async () => {
      scene()
      const res = await cli(['probe'], { deps: { signalClient: testDeps().signalClient } })
      assert.equal(res.code, 0, res.all)
      assert.match(res.stdout, /Проектов доступно: 1/)
      assert.match(res.stdout, /Корни не проверены: нет OSP_DB_URL/)
      noNames(res.all)
    })

    it('SIGNAL отвечает 500 на проекты до исчерпания повторов → код 4, «FAIL» без секрета', async () => {
      scene()
      fake.fail('/public/v1/projects?', { status: 500, body: { message: 'boom' }, times: 100 })
      const res = await cli(['probe'])
      assert.equal(res.code, 4, res.all)
      assert.match(res.stderr, /^FAIL SIGNAL недоступен \(HTTP 500\)$/m)
      assert.equal(fake.count('/public/v1/projects?'), 4, 'первая попытка и три повтора')
    })

    it('неверный секрет клиента → код 4, ни верного, ни присланного секрета в выводе нет', async () => {
      const wrong = 'sig-Wrong-Secret-Value-XYZ-9'
      const res = await cli(['probe'], { env: env({ SIGNAL_CLIENT_SECRET: wrong }) })
      assert.equal(res.code, 4, res.all)
      assert.match(res.stderr, /FAIL /)
      assert.ok(!res.all.includes(wrong))
    })
  })

  describe('sync', () => {
    it('публикует снимок (поколение +1), печатает прогон и счётчики корней, код 0; повтор — ещё +1 без дублей', async () => {
      const s = scene({ folders: 3, items: 2, rootItems: 1 })
      assert.equal(meta().generation, 0)
      const first = await cli(['sync'])
      assert.equal(first.code, 0, first.all)
      // корень + 3 папки; элементов: 1 в корне + 3 * 2
      assert.match(first.stdout, new RegExp(`^Прогон \\d+: ok, поколение 1 — #${s.src.id}: папок 4, элементов 7$`))
      noNames(first.all)
      noIds(first.all)
      assert.equal(meta().generation, 1)
      const published = nodes()
      assert.equal(published.length, 4 + 7)
      assert.deepEqual(runs().map((r) => [r.kind, r.status, r.initiator, r.generation]), [['manual', 'ok', 'cli', 1]])
      assert.deepEqual(sources().map((r) => [r.ready, r.last_error, r.folders_count, r.items_count]), [[true, null, 4, 7]])
      assert.equal(stageCount(), 0)

      const again = await cli(['sync'])
      assert.equal(again.code, 0, again.all)
      assert.match(again.stdout, /^Прогон \d+: ok, поколение 2 — /)
      assert.equal(meta().generation, 2)
      assert.equal(nodes().length, published.length, 'повтор ничего не дублирует')
      assert.deepEqual(nodes().map((n) => n.node_id), published.map((n) => n.node_id))
      assert.equal(runs().length, 2)
    })

    it('нет включённых корней → «Обход не начат», код 4, снимок не меняется', async () => {
      const res = await cli(['sync'])
      assert.equal(res.code, 4, res.all)
      assert.match(res.stdout, /Обход не начат: нет включённых корней/)
      assert.equal(meta().generation, 0)
      assert.deepEqual(runs(), [])
    })

    it('сокращение дерева более чем на 30 % → held, код 3, снимок прежний; accept-held с верным поколением принимает прогон', async () => {
      const s = scene({ folders: 30, items: 1 })
      const ok = await cli(['sync'])
      assert.equal(ok.code, 0, ok.all)
      const before = snapshot()
      assert.equal(before.meta.generation, 1)

      const folderIds = Object.entries(s.ids).filter(([p]) => p !== ROOT_NAME).slice(0, 15).map(([, id]) => id)
      for (const id of folderIds) fake.removeFolder(s.project, id)
      const held = await cli(['sync'])
      assert.equal(held.code, 3, held.all)
      const m = /^Прогон (\d+): held \(shrink\), поколение (\d+) — /m.exec(held.stdout)
      assert.ok(m, held.stdout)
      assert.equal(Number(m[2]), before.meta.generation, 'в выводе — поколение действующего снимка: его и нужно передать в --expected-generation')
      assert.match(held.stdout, /Прогон отложен защитой\. Принять: accept-held --run <id> --expected-generation <n> --reason <текст>/)
      noNames(held.all)
      noIds(held.all)
      assert.deepEqual(snapshot(), before, 'отложенный прогон снимок не меняет')
      assert.equal(runs().at(-1).status, 'held')
      assert.ok(stageCount() > 0, 'порции отложенного прогона ждут решения')

      // поколение чужое → отказ, снимок прежний
      const stale = await cli(['accept-held', '--run', m[1], '--expected-generation', '9', '--reason', 'проверено вручную'])
      assert.equal(stale.code, 4, stale.all)
      assert.match(stale.stderr, /FAIL stale_state/)
      assert.deepEqual(snapshot(), before)

      const accepted = await cli(['accept-held', '--run', m[1], '--expected-generation', String(before.meta.generation), '--reason', 'проверено вручную'])
      assert.equal(accepted.code, 0, accepted.all)
      assert.match(accepted.stdout, new RegExp(`^Прогон ${m[1]}: принят, поколение 2$`))
      assert.equal(meta().generation, 2)
      assert.deepEqual([runs().at(-1).status, runs().at(-1).accepted_by, runs().at(-1).accept_reason], ['ok', 'cli', 'проверено вручную'])
      const seen = nodes().filter((n) => n.seen_gen === 2)
      assert.equal(seen.length, 1 + 15 + 1 + 15, 'в принятом поколении — корень, 15 оставшихся папок и их файлы')
      const gone = nodes().filter((n) => n.seen_gen === 1)
      assert.equal(gone.length, 15 + 15, 'исчезнувшие узлы остаются в снимке: ночь отсутствия считает только ночной обход, не ручной')
      assert.ok(gone.every((n) => n.absent_nights === 0))
    })

    it('сбой SIGNAL (500 на элементах до исчерпания повторов) → прогон failed, код 4, снимок, поколение и staging прежние, last_error корня', async () => {
      const s = scene({ folders: 4, items: 3 })
      assert.equal((await cli(['sync'])).code, 0)
      const before = snapshot()
      fake.fail('/public/v1/items', { status: 500, body: { message: 'boom' }, times: 100 })
      fake.resetRequests()
      const res = await cli(['sync'])
      assert.equal(res.code, 4, res.all)
      assert.match(res.stdout, new RegExp(`^Прогон \\d+: failed \\(http\\) — `))
      noNames(res.all)
      noIds(res.all)
      assert.ok(fake.count('/public/v1/items') >= 4, 'повторы были: первая попытка и три повтора')
      assert.deepEqual(snapshot(), before)
      assert.equal(stageCount(), 0)
      assert.deepEqual([runs().at(-1).status, runs().at(-1).reason], ['failed', 'http'])
      assert.equal(sources()[0].last_error, 'http')
      assert.equal(sources()[0].ready, true, 'прежний снимок остаётся готовым')
      assert.ok(s.src.id)
    })

    it('SIGNAL не выдаёт токен (500 до исчерпания повторов) → код 4, снимок не меняется, секрета нет', async () => {
      scene()
      assert.equal((await cli(['sync'])).code, 0)
      const before = snapshot()
      fake.fail('/public/v1/auth/token', { status: 500, body: { message: 'boom' }, times: 100 })
      fake.revokeTokens()
      const res = await cli(['sync'])
      assert.equal(res.code, 4, res.all)
      assert.deepEqual(snapshot(), before)
      assert.equal(stageCount(), 0)
      noNames(res.all)
    })

    it('SIGNAL не настроен (нет SIGNAL_CLIENT_ID) → код 4 без обращения к SIGNAL; нет базы → код 4', async () => {
      scene()
      const noClient = await cli(['sync'], { env: { SIGNAL_CLIENT_ID: '', SIGNAL_CLIENT_SECRET: '' } })
      assert.equal(noClient.code, 4, noClient.all)
      assert.match(noClient.stderr, /FAIL SIGNAL не настроен/)
      const noDb = await cli(['sync'], { deps: { signalClient: testDeps().signalClient } })
      assert.equal(noDb.code, 4, noDb.all)
      assert.match(noDb.stderr, /FAIL нужен OSP_DB_URL/)
      assert.equal(fake.requests.length, 0)
    })
  })

  // Барьер записи на время переноса: файл-переключатель OSP_DB_READONLY_FILE при настроенном шлюзе (OSP_PGRST_URL) — как у службы.
  describe('барьер записи переноса', () => {
    let dir
    let barrier
    const gateway = (file = barrier) => env({ OSP_PGRST_URL: 'http://127.0.0.1:9', OSP_DB_READONLY_FILE: file })
    const close = () => fs.writeFileSync(barrier, '1')
    const open = () => fs.rmSync(barrier, { force: true })
    const BARRIER_RE = /^FAIL запись закрыта барьером переноса/m

    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cli-ro-'))
      barrier = path.join(dir, 'db-readonly')
    })
    after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
    afterEach(open)

    it('sync при закрытом барьере: код 4, понятное сообщение, поколение и прогоны прежние, к SIGNAL и в базу запросов нет; после снятия — работает', async () => {
      scene({ folders: 3, items: 2 })
      assert.equal((await cli(['sync'], { env: gateway() })).code, 0, 'барьера нет — обход идёт')
      const before = snapshot()
      const runsBefore = runs()
      assert.equal(before.meta.generation, 1)
      fake.resetRequests()

      close()
      const res = await cli(['sync'], { env: gateway() })
      assert.equal(res.code, 4, res.all)
      assert.match(res.stderr, BARRIER_RE)
      assert.equal(res.stdout, '')
      assert.deepEqual(snapshot(), before, 'поколение и снимок не изменились')
      assert.deepEqual(runs(), runsBefore, 'новый прогон не создан')
      assert.equal(stageCount(), 0)
      assert.equal(fake.requests.length, 0, 'к SIGNAL после проверки барьера обращений нет')

      open()
      const again = await cli(['sync'], { env: gateway() })
      assert.equal(again.code, 0, again.all)
      assert.equal(meta().generation, 2)
    })

    it('accept-held при закрытом барьере: код 4, отложенный прогон не принят, поколение прежнее; после снятия — принимается', async () => {
      const s = scene({ folders: 30, items: 1 })
      assert.equal((await cli(['sync'], { env: gateway() })).code, 0)
      for (const [, id] of Object.entries(s.ids).filter(([p]) => p !== ROOT_NAME).slice(0, 15)) fake.removeFolder(s.project, id)
      const held = await cli(['sync'], { env: gateway() })
      assert.equal(held.code, 3, held.all)
      const runId = /^Прогон (\d+): held/m.exec(held.stdout)[1]
      const before = snapshot()
      const stage = stageCount()
      assert.ok(stage > 0)
      const argv = ['accept-held', '--run', runId, '--expected-generation', String(before.meta.generation), '--reason', 'проверено вручную']

      close()
      const res = await cli(argv, { env: gateway() })
      assert.equal(res.code, 4, res.all)
      assert.match(res.stderr, BARRIER_RE)
      assert.equal(res.stdout, '')
      assert.deepEqual(snapshot(), before)
      assert.equal(runs().at(-1).status, 'held', 'прогон остался отложенным')
      assert.equal(stageCount(), stage, 'порции ждут решения')

      open()
      const accepted = await cli(argv, { env: gateway() })
      assert.equal(accepted.code, 0, accepted.all)
      assert.equal(meta().generation, before.meta.generation + 1)
    })

    it('probe при закрытом барьере работает (только чтение): код 0, база не меняется', async () => {
      const s = scene({ folders: 2, items: 1 })
      close()
      const before = snapshot()
      const res = await cli(['probe'], { env: gateway() })
      assert.equal(res.code, 0, res.all)
      assert.match(res.stdout, new RegExp(`^Корень #${s.src.id}: найден`, 'm'))
      assert.deepEqual(snapshot(), before)
      assert.deepEqual(runs(), [])
    })

    it('барьер закрылся посреди обхода: прогон остановлен без публикации, код 4, снимок прежний', async () => {
      scene({ folders: 3, items: 2 })
      assert.equal((await cli(['sync'], { env: gateway() })).code, 0)
      const before = snapshot()
      fake.resetRequests()
      // Служба проверяет барьер перед каждой порцией и публикацией: он закрывается, когда обход дошёл до элементов.
      const isReadOnly = () => fake.paths().some((p) => p.startsWith('GET /public/v1/items'))
      const res = await cli(['sync'], { env: gateway(), deps: { ...testDeps(), isReadOnly } })
      assert.equal(res.code, 4, res.all)
      assert.match(res.stdout, /^Прогон \d+: cancelled \(read_only\)/)
      assert.match(res.stderr, /^FAIL запись закрыта барьером переноса: прогон остановлен без публикации$/m)
      assert.deepEqual(snapshot(), before, 'публикации не было')
    })

    it('каталог файла-переключателя недоступен: sync и accept-held — код 4 с причиной, probe работает', async () => {
      scene({ folders: 1, items: 0 })
      const bad = gateway(path.join(dir, 'нет-такого-каталога', 'db-readonly'))
      for (const argv of [['sync'], ['accept-held', '--run', '1', '--expected-generation', '0', '--reason', 'проверка']]) {
        const res = await cli(argv, { env: bad })
        assert.equal(res.code, 4, res.all)
        assert.match(res.stderr, /FAIL .*OSP_DB_READONLY_FILE/)
      }
      assert.equal((await cli(['probe'], { env: bad })).code, 0)
      assert.equal(meta().generation, 0)
      assert.deepEqual(runs(), [])
    })

    it('шлюз данных не настроен (нет OSP_PGRST_URL) — барьера нет, как у службы', async () => {
      scene({ folders: 1, items: 0 })
      close()
      const res = await cli(['sync'], { env: env({ OSP_DB_READONLY_FILE: barrier }) })
      assert.equal(res.code, 0, res.all)
      assert.equal(meta().generation, 1)
    })
  })

  describe('границы внедрения зависимостей', () => {
    it('http-адрес из окружения отвергается (deps без allowLoopback не подставляются из env): запросов к SIGNAL нет', async () => {
      scene()
      for (const over of [{ SIGNAL_BASE_URL: fake.url }, { SIGNAL_BASE_URL: fake.url, SIGNAL_HOSTS: '127.0.0.1', SIGNAL_ALLOW_LOOPBACK: '1' }]) {
        for (const cmd of ['probe', 'sync']) {
          const res = await cli([cmd], { env: env(over), deps: { db: sdb } })
          assert.equal(res.code, 4, res.all)
          assert.match(res.stderr, /FAIL SIGNAL_BASE_URL: только https/)
        }
      }
      assert.equal(fake.requests.length, 0)
      assert.equal(meta().generation, 0)
    })

    it('deps.db не закрывается командой; разбор аргументов и вывод использования — через приёмники, код 1', async () => {
      const usage = await cli(['nope'])
      assert.equal(usage.code, 1)
      assert.match(usage.stderr, /Использование: node src\/signal-cli\.js probe \| sync \| accept-held/)
      assert.equal((await cli(['probe', 'x'])).code, 1)
      assert.equal((await cli(['accept-held', '--run', '1'])).code, 1)
      // база после команд всё ещё рабочая
      assert.equal(await sdb.read(null, async (tx) => (await tx.query('select 1 as one')).rows[0].one), 1)
      scene()
      assert.equal((await cli(['sync'])).code, 0)
      assert.equal(await sdb.read(null, async (tx) => (await tx.query('select 1 as one')).rows[0].one), 1)
    })
  })
})
