// Изоляция сбоев при обходе SIGNAL (В-5, С-59, С-51, С-23, В2-1; server/osp-api/src/lib/signalSync.js) на настоящем PostgreSQL
// с настоящей миграцией и поддельным SIGNAL. Сценарий приёмки: «один проект сбойный (403 на подпапке / закрытый проект /
// «ядовитое» название) — другие публикуются, сбойный отмечен». Без PostgreSQL/Docker набор ПРОПУСКАЕТСЯ (это «пропущено»).
//
// Что проверяем:
//   • сбой корня (дерево проекта 403/404, корня нет в дереве, предел, повтор страницы, бюджет корня, 5xx/timeout) — корень failed
//     в stats.roots, last_error и failed_since у корня, остальные корни обходятся и публикуются (статус прогона partial);
//   • сбой всего прогона (авторизация) — по-прежнему failed без публикации;
//   • нечитаемая подпапка (403/404 на элементах) — проблема папки (problem, items_listed = false), корень публикуется,
//     файлы папки считаются прежними; следующий успешный обход проблему снимает;
//   • «ядовитые» названия (непарный суррогат, длиннее 500 знаков, путь длиннее 8000) не останавливают публикацию;
//   • список проблемных папок в статистике ограничен problemsMax, число — в problemsTotal;
//   • в журнале нет названий и путей.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET, fakeId } from './lib/fake-signal.mjs'
import { createSignalClient, sleepAbortable } from '../../server/osp-api/src/lib/signalClient.js'
import { createSignalApi } from '../../server/osp-api/src/lib/signalApi.js'
import { createSignalSync } from '../../server/osp-api/src/lib/signalSync.js'

const msk = (text) => Date.parse(`${text.replace(' ', 'T')}:00+03:00`)
const ITEMS = '/public/v1/items'

describe('Обход SIGNAL: сбой одного корня не останавливает остальные', { skip: signalDbSkip }, () => {
  let db
  let sdb
  let fake
  let logs
  let syncs

  const q = (sql) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${sql}) t`)
  const nodes = () => q('select node_id, kind, parent_id, name, path, depth from osp_private.signal_nodes order by path, node_id')
  const node = (id) => q(`select node_id, kind, name, path, deleted, problem, seen_gen, absent_nights from osp_private.signal_nodes where node_id = '${id}'`)[0]
  const meta = () => q('select generation from osp_private.signal_meta')[0]
  const runs = () => q('select id, kind, status, reason, generation, stats from osp_private.signal_runs order by id')
  const sources = () => q('select id, ready, last_error, (failed_since is not null) as failed, folders_count, items_count from osp_private.signal_sources order by id')
  const stageCount = () => Number(db.sql('select count(*) from osp_private.signal_stage_nodes').split('\n')[0])
  const has = (name) => nodes().some((n) => n.name === name)

  const mkApi = (over = {}) => createSignalApi({
    client: createSignalClient({
      baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, backoffMs: [5, 5, 5],
      sleep: (ms, signal) => sleepAbortable(Math.min(ms, 50), signal), ...over,
    }),
  })
  const mkSync = ({ api = mkApi(), config = {}, now = () => msk('2030-03-03 12:00') } = {}) => {
    const sync = createSignalSync({
      db: sdb, api, isReadOnly: () => false, now, config: { heartbeatMs: 10_000, ...config },
      log: { info: (obj, msg) => logs.push({ msg, obj }), warn: (obj, msg) => logs.push({ msg, obj }) },
    })
    syncs.push(sync)
    return sync
  }
  const manual = async (sync) => {
    const started = await sync.runNow({ initiator: 'cli' })
    assert.ok(started.started, JSON.stringify(started))
    return started.done
  }

  // Два корня в двух проектах: здоровый и «проблемный».
  function twoProjects() {
    const p1 = fake.addProject({ name: 'Тест: здоровый проект' })
    const b1 = fake.build(p1, { name: 'Корень1', children: [{ name: 'Корпус 1', items: 2 }] })
    const p2 = fake.addProject({ name: 'Тест: проблемный проект' })
    const b2 = fake.build(p2, { name: 'Корень2', children: [{ name: 'Папка А', items: 2 }, { name: 'Папка Б', items: 1 }] })
    const o1 = db.seed.object({ name: 'Тест: объект 1' })
    const o2 = db.seed.object({ name: 'Тест: объект 2' })
    const s1 = db.seed.source({ projectId: p1, folderId: b1.ids['Корень1'], objectIds: [o1] })
    const s2 = db.seed.source({ projectId: p2, folderId: b2.ids['Корень2'], objectIds: [o2] })
    return { p1, b1, p2, b2, s1, s2 }
  }

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4 })
  })
  after(async () => { await db?.stop() })
  beforeEach(async () => { fake = await startFakeSignal(); logs = []; syncs = [] })
  afterEach(async () => {
    for (const s of syncs) await s.stop()
    await fake.close()
    db.sql(`TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_candidates,
      osp_private.signal_contracts, osp_private.signal_queue, osp_private.signal_bindings, osp_private.signal_sources RESTART IDENTITY;
      UPDATE osp_private.signal_meta SET generation = 0, published_at = NULL, published_run_id = NULL WHERE id = 1`)
  })

  describe('сбой корня', () => {
    it('закрытый проект (403 на дерево) → корень failed (scope), корень другого проекта опубликован: partial; следующий обход без сбоя снимает отметку', async () => {
      const t = twoProjects()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      fake.addFolder(t.p1, { name: 'Корпус 2 (новый)', parentId: t.b1.ids['Корень1'] })
      fake.denyProject(t.p2)
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason, r.generation], ['partial', 'root_failed', 2], JSON.stringify(r))
      assert.deepEqual(r.stats.roots, [{ id: t.s1.id, status: 'ok', folders: 3, items: 2, listed: 3 }, { id: t.s2.id, status: 'failed', reason: 'scope' }])
      assert.ok(has('Корпус 2 (новый)'), 'новая папка здорового проекта опубликована')
      assert.deepEqual(sources().map((s) => [s.id, s.last_error, s.failed, s.ready]), [[t.s1.id, null, false, true], [t.s2.id, 'scope', true, true]])
      // повторный сбой — отметка остаётся; снятие доступа — следующий обход чистый
      assert.equal((await manual(sync)).status, 'partial')
      assert.equal(sources()[1].failed, true)
      fake.allowProject(t.p2)
      const ok = await manual(sync)
      assert.equal(ok.status, 'ok')
      assert.deepEqual(sources().map((s) => [s.last_error, s.failed]), [[null, false], [null, false]])
      assert.equal(stageCount(), 0)
    })

    it('проект исчез (404 на дерево) и ответ 500 на дерево → корень failed (root_unavailable / http), остальные опубликованы', async () => {
      const t = twoProjects()
      const p3 = fake.addProject({ name: 'Тест: третий проект' })
      const b3 = fake.build(p3, { name: 'Корень3', children: [{ name: 'Папка В', items: 1 }] })
      const s3 = db.seed.source({ projectId: p3, folderId: b3.ids['Корень3'], objectIds: [db.seed.object({ name: 'Тест: объект 3' })] })
      const sync = mkSync({ api: mkApi({ retries: 0 }) })
      assert.equal((await manual(sync)).status, 'ok')
      fake.removeProject(t.p2)
      fake.fail((r) => r.path.includes(p3) && r.path.endsWith('/folders/tree'), { status: 500, body: {}, times: 10 })
      fake.addFolder(t.p1, { name: 'Корпус 2 (новый)', parentId: t.b1.ids['Корень1'] })
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['partial', 'root_failed'])
      assert.deepEqual(r.stats.roots.map((x) => [x.id, x.status, x.reason ?? null]), [[t.s1.id, 'ok', null], [t.s2.id, 'failed', 'root_unavailable'], [s3.id, 'failed', 'http']])
      assert.deepEqual(sources().map((s) => s.last_error), [null, 'root_unavailable', 'http'])
      assert.ok(has('Корпус 2 (новый)'))
    })

    it('корня нет в дереве проекта → корень failed (root_missing); второй корень того же проекта опубликован', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, [{ name: 'Корень 1', children: [{ name: 'Корпус 1', items: 1 }] }, { name: 'Корень 2', children: [{ name: 'Корпус 1', items: 1 }] }])
      const o = db.seed.object({ name: 'Тест: объект 1' })
      const s1 = db.seed.source({ projectId: project, folderId: ids['Корень 1'], objectIds: [o] })
      const s2 = db.seed.source({ projectId: project, folderId: ids['Корень 2'], objectIds: [db.seed.object({ name: 'Тест: объект 2' })] })
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      fake.removeFolder(project, ids['Корень 1'])
      fake.addFolder(project, { name: 'Корпус 2', parentId: ids['Корень 2'] })
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['partial', 'root_failed'])
      assert.deepEqual(r.stats.roots.map((x) => [x.id, x.status, x.reason ?? null]), [[s1.id, 'failed', 'root_missing'], [s2.id, 'ok', null]])
      assert.equal(fake.count('/folders/tree'), 2, 'дерево — один запрос на проект за прогон')
    })

    it('бюджет корня: медленный корень failed (budget), быстрый опубликован; бюджет прогона по-прежнему останавливает весь прогон', async () => {
      const t = twoProjects()
      const slowFolders = new Set(Object.values(t.b1.ids))
      fake.fail((r) => r.path === ITEMS && slowFolders.has(r.query.folderId), { delayMs: 200, times: 1_000_000 })
      const r = await manual(mkSync({ config: { rootBudgetMs: 300 }, now: Date.now }))
      assert.equal(r.status, 'partial', JSON.stringify(r))
      assert.deepEqual(r.stats.roots.map((x) => [x.id, x.status, x.reason ?? null]), [[t.s1.id, 'failed', 'budget'], [t.s2.id, 'ok', null]])
      assert.deepEqual(sources().map((s) => [s.last_error, s.folders_count]), [['budget', null], [null, 3]])
      assert.ok(has('Папка А'))
      assert.ok(!has('Корень1'), 'сбойный корень не опубликован (первый обход)')
    })

    it('предел вложенности превышен в одном корне → корень failed (limit), другой корень опубликован', async () => {
      const t = twoProjects()
      const a = fake.addFolder(t.p1, { name: 'А', parentId: t.b1.ids['Корень1'] })
      const b = fake.addFolder(t.p1, { name: 'Б', parentId: a })
      fake.addFolder(t.p1, { name: 'В', parentId: b })
      const r = await manual(mkSync({ config: { maxDepth: 2 } }))
      assert.equal(r.status, 'partial', JSON.stringify(r))
      assert.deepEqual(r.stats.roots.map((x) => [x.id, x.status, x.reason ?? null]), [[t.s1.id, 'failed', 'limit'], [t.s2.id, 'ok', null]])
      assert.deepEqual(sources().map((s) => s.last_error), ['limit', null])
      assert.ok(has('Папка А') && !has('Корень1'))
    })

    it('повтор страницы (смещение не работает) в одном корне → корень failed (invalid), другой корень опубликован', async () => {
      const t = twoProjects()
      const folder = t.b2.ids['Корень2 / Папка А']
      fake.addItems(folder, 400)
      const first = fake.state.items.get(folder).slice(0, 200)
      const body = first.map((it) => ({ id: it.id, folderId: it.folderId, name: it.name, type: it.type, modified: it.modified, deleted: false }))
      fake.fail((req) => req.path === ITEMS && req.query.folderId === folder && req.query.Skip === '200', { status: 200, body, times: 1000 })
      const r = await manual(mkSync())
      assert.equal(r.status, 'partial', JSON.stringify(r))
      assert.deepEqual(r.stats.roots.map((x) => [x.id, x.status, x.reason ?? null]), [[t.s1.id, 'ok', null], [t.s2.id, 'failed', 'invalid']])
      assert.deepEqual(sources().map((s) => s.last_error), [null, 'invalid'])
    })

    it('сбой всего прогона (авторизация) — не сбой корня: failed без публикации, корень в работе отмечен', async () => {
      const t = twoProjects()
      const r = await manual(mkSync({ api: mkApi({ clientSecret: 'неверный-секрет-для-проверки-0001' }) }))
      assert.deepEqual([r.status, r.reason], ['failed', 'auth'])
      assert.equal(meta().generation, 0)
      assert.equal(nodes().length, 0)
      assert.equal(stageCount(), 0)
      assert.deepEqual(runs().at(-1).status, 'failed')
      assert.ok(t.s1.id)
    })

    it('журнал и результаты — без названий, путей и идентификаторов узлов', async () => {
      const t = twoProjects()
      fake.denyProject(t.p2)
      fake.denyItems(t.b1.ids['Корень1 / Корпус 1'], 403)
      const r = await manual(mkSync())
      assert.equal(r.status, 'partial')
      const text = JSON.stringify(logs)
      assert.ok(!/Корень|Корпус|Папка|Файл|Тест:/.test(text), `в журнале названия: ${text}`)
      assert.ok(!text.includes(t.b1.ids['Корень1 / Корпус 1']), 'в журнале нет идентификатора узла')
    })
  })

  describe('нечитаемая подпапка', () => {
    it('403 на элементах подпапки (первый обход, прежнего снимка нет) → problem=forbidden, items_listed=false, остальное опубликовано; доступ вернулся → проблема снята', async () => {
      const t = twoProjects()
      const closed = t.b2.ids['Корень2 / Папка А']
      fake.denyItems(closed, 403)
      const sync = mkSync()
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['ok', null], JSON.stringify(r))
      assert.deepEqual(r.stats.roots[1], { id: t.s2.id, status: 'ok', folders: 3, items: 1, listed: 2, problems: [{ nodeId: closed, code: 'forbidden' }], problemsTotal: 1 })
      assert.equal(node(closed).problem, 'forbidden')
      assert.equal(node(t.b2.ids['Корень2 / Папка Б']).problem, null)
      assert.ok(has('Корпус 1'), 'здоровый проект опубликован')
      assert.deepEqual(sources().map((s) => [s.last_error, s.failed]), [[null, false], [null, false]], 'у корня сбоя нет: подпапка — не сбой корня')
      assert.equal(sources()[1].items_count, 1, 'элементы закрытой папки не считаются')
      // доступ вернулся
      fake.allowItems(closed)
      const again = await manual(sync)
      assert.equal(again.status, 'ok')
      assert.equal(node(closed).problem, null)
      assert.equal(sources()[1].items_count, 3)
      assert.equal(nodes().filter((n) => n.kind === 'item' && n.parent_id === closed).length, 2)
    })

    it('папка удалена между чтением дерева и чтением её элементов (404) → problem=not_found, прогон ok (доказательный тест A5-6 перевёрнут)', async () => {
      const t = twoProjects()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const gone = t.b2.ids['Корень2 / Папка Б']
      const oldItems = nodes().filter((n) => n.parent_id === gone).map((n) => n.node_id)
      assert.equal(oldItems.length, 1)
      // пока читается корень, пользователь SIGNAL удаляет «Папка Б»: дерево уже выдано, элементы папки — 404
      fake.onItems(t.b2.ids['Корень2'], () => { fake.onItems(t.b2.ids['Корень2']); fake.removeFolder(t.p2, gone) })
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['ok', null], JSON.stringify(r))
      assert.deepEqual(r.stats.roots[1].problems, [{ nodeId: gone, code: 'not_found' }])
      assert.equal(node(gone).problem, 'not_found')
      assert.equal(node(oldItems[0]).absent_nights, 0)
    })

    it('несколько проблемных папок: в статистике — не больше problemsMax, число — в problemsTotal; сбойные корни в статистике не теряются', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: Array.from({ length: 12 }, (_, i) => ({ name: `Папка ${i + 1}`, items: 1 })) })
      const src = db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [db.seed.object({ name: 'Тест: объект' })] })
      const p2 = fake.addProject({ name: 'Тест: закрытый' })
      const b2 = fake.build(p2, { name: 'Корень2', items: 1 })
      const src2 = db.seed.source({ projectId: p2, folderId: b2.ids['Корень2'], objectIds: [db.seed.object({ name: 'Тест: объект 2' })] })
      fake.denyProject(p2)
      for (const [path, id] of Object.entries(ids)) if (path !== 'Корень') fake.denyItems(id, path.endsWith('1') || path.endsWith('5') ? 404 : 403)
      const r = await manual(mkSync({ config: { problemsMax: 5 } }))
      assert.deepEqual([r.status, r.reason], ['partial', 'root_failed'])
      const root = r.stats.roots[0]
      assert.equal(root.problems.length, 5)
      assert.equal(root.problemsTotal, 12)
      assert.deepEqual(r.stats.roots[1], { id: src2.id, status: 'failed', reason: 'scope' })
      const saved = runs().at(-1).stats
      assert.equal(saved.roots.length, 2, 'база сохранила статистику целиком, а не отбросила её')
      assert.equal(saved.roots[0].problems.length, 5)
      assert.deepEqual(sources().map((s) => [s.id, s.last_error]), [[src.id, null], [src2.id, 'scope']])
    })
  })

  describe('«ядовитые» названия не останавливают публикацию (В2-1, доказательный тест W2-P1 перевёрнут)', () => {
    for (const [title, poison, expectName] of [
      ['непарный суррогат (обрезанное эмодзи)', 'Папка А \ud83d', 'Папка А �'],
      ['название длиннее 500 знаков', 'Д'.repeat(501), 'Д'.repeat(500)],
    ]) {
      it(`${title}: оба корня опубликованы, новая папка здорового корня появилась, название очищено`, async () => {
        const t = twoProjects()
        const sync = mkSync()
        assert.equal((await manual(sync)).status, 'ok')
        assert.equal(meta().generation, 1)
        fake.addFolder(t.p1, { name: 'Корпус 2 (новая папка здорового проекта)', parentId: t.b1.ids['Корень1'] })
        fake.renameFolder(t.p2, t.b2.ids['Корень2 / Папка А'], poison)
        for (let i = 0; i < 2; i++) {
          const r = await manual(sync)
          assert.deepEqual([r.status, r.reason], ['ok', null], JSON.stringify(r))
        }
        assert.equal(meta().generation, 3)
        assert.ok(has('Корпус 2 (новая папка здорового проекта)'))
        assert.ok(has(expectName), 'ядовитая папка опубликована с очищенным названием')
        assert.deepEqual(sources().map((s) => [s.last_error, s.failed]), [[null, false], [null, false]])
      })
    }

    it('ядовитые названия файлов, длинный путь (> 8000 знаков) и длинный тип файла — публикация идёт, значения усечены до пределов базы', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const root = fake.build(project, { name: 'Корень' }).ids['Корень']
      let parent = root
      let deepest = null
      for (let i = 0; i < 18; i++) {
        deepest = fake.addFolder(project, { name: `${String(i).padStart(2, '0')}${'ж'.repeat(470)}`, parentId: parent })
        parent = deepest
      }
      fake.setItems(deepest, [
        { id: fakeId('item', 1), name: `Файл ${'я'.repeat(700)}`, type: 'File', modified: '2026-01-01T00:00:00Z', deleted: false, topVersionNumber: 1 },
        { id: fakeId('item', 2), name: 'Файл \ud83d', type: 'Т'.repeat(300), modified: '2026-01-01T00:00:00Z', deleted: false, topVersionNumber: 1 },
      ])
      db.seed.source({ projectId: project, folderId: root, objectIds: [db.seed.object({ name: 'Тест: объект' })] })
      const r = await manual(mkSync({ config: { maxDepth: 30 } }))
      assert.equal(r.status, 'ok', JSON.stringify(r))
      const deep = node(deepest)
      assert.equal(deep.path.length, 8000, 'путь усечён до предела базы')
      const items = q(`select name, path, item_type from osp_private.signal_nodes where parent_id = '${deepest}' order by node_id`)
      assert.deepEqual(items.map((i) => i.name.length), [500, 6])
      assert.equal(items[1].name, 'Файл �')
      assert.equal(items[1].item_type.length, 100)
      assert.ok(items.every((i) => i.path.length <= 8000))
    })
  })
})
