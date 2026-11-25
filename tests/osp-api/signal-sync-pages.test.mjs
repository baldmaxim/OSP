// Чтение списков элементов при обходе SIGNAL (server/osp-api/src/lib/signalSync.js + signalApi.js) на настоящем PostgreSQL
// с настоящей миграцией и поддельным SIGNAL: конец списка (С-58), повтор id и нестабильные страницы (С-60), адресный запрос
// удалённых файлов со ссылкой (В-10, С-4), объектные коды для сопоставителя. Без PostgreSQL/Docker набор ПРОПУСКАЕТСЯ.
//
// Доказательные тесты ревизии перевёрнуты: A5-4 (короткая страница = «конец» — потеря элементов без следа), A5-7 (смещение
// Skip/Take на живом списке теряло элемент или роняло прогон), W5-4 (удалённый файл со ссылкой невидим).
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET, fakeId } from './lib/fake-signal.mjs'
import { createSignalClient, sleepAbortable } from '../../server/osp-api/src/lib/signalClient.js'
import { createSignalApi } from '../../server/osp-api/src/lib/signalApi.js'
import { createSignalSync } from '../../server/osp-api/src/lib/signalSync.js'

const msk = (text) => Date.parse(`${text.replace(' ', 'T')}:00+03:00`)
const ITEMS = '/public/v1/items'

describe('Обход SIGNAL: страницы элементов, нестабильность, удалённые файлы', { skip: signalDbSkip }, () => {
  let db
  let sdb
  let fake
  let clock
  let syncs

  const q = (sql) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${sql}) t`)
  const items = () => q("select node_id, parent_id, name, deleted, seen_gen, absent_nights from osp_private.signal_nodes where kind = 'item' order by node_id")
  const node = (id) => q(`select node_id, kind, name, deleted, problem, seen_gen, absent_nights, number_keys from osp_private.signal_nodes where node_id = '${id}'`)[0]
  const runs = () => q('select id, kind, mode, status, reason, generation from osp_private.signal_runs order by id')
  const sources = () => q('select id, last_error, items_count from osp_private.signal_sources order by id')
  const stageCount = () => Number(db.sql('select count(*) from osp_private.signal_stage_nodes').split('\n')[0])
  const deletedRequests = () => fake.requests.filter((r) => r.path === ITEMS && r.query.deleted === 'true').map((r) => r.query.folderId)

  const mkApi = (over = {}) => createSignalApi({
    client: createSignalClient({
      baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, backoffMs: [5, 5, 5],
      sleep: (ms, signal) => sleepAbortable(Math.min(ms, 50), signal), ...over,
    }),
  })
  const mkSync = ({ config = {}, api = mkApi() } = {}) => {
    const sync = createSignalSync({
      db: sdb, api, isReadOnly: () => false, now: () => clock, config: { heartbeatMs: 10_000, ...config }, log: { info() {}, warn() {} },
    })
    syncs.push(sync)
    return sync
  }
  const manual = async (sync) => {
    const started = await sync.runNow({ initiator: 'cli' })
    assert.ok(started.started, JSON.stringify(started))
    return started.done
  }
  const at = async (sync, text) => { clock = msk(text); return sync.tick() }

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4 })
  })
  after(async () => { await db?.stop() })
  beforeEach(async () => { fake = await startFakeSignal(); clock = msk('2030-03-03 12:00'); syncs = [] })
  afterEach(async () => {
    for (const s of syncs) await s.stop()
    await fake.close()
    db.sql(`TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_candidates,
      osp_private.signal_contracts, osp_private.signal_queue, osp_private.signal_bindings, osp_private.signal_sources RESTART IDENTITY;
      UPDATE osp_private.signal_meta SET generation = 0, published_at = NULL, published_run_id = NULL WHERE id = 1`)
  })

  describe('С-58: конец списка', () => {
    it('сервер отдаёт страницы короче Take, хотя элементы есть (A5-4 перевёрнут): три ночи подряд все элементы на месте, absent_nights = 0', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: 'Архив', items: 450 }, ...Array.from({ length: 3 }, (_, i) => ({ name: `Папка ${i + 1}`, items: 100 }))] })
      db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [db.seed.object({ name: 'Тест: объект' })] })
      const sync = mkSync()
      assert.equal((await at(sync, '2030-03-04 05:10')).status, 'ok')
      assert.equal(items().length, 750)
      fake.pageCap = 100 // дальше сервер отдаёт не больше 100 элементов на запрос, не отклоняя Take=200
      for (const day of ['2030-03-05', '2030-03-06']) {
        const r = await at(sync, `${day} 05:10`)
        assert.equal(r.status, 'ok', JSON.stringify(r))
      }
      assert.equal(items().length, 750)
      assert.ok(items().every((i) => i.absent_nights === 0 && i.seen_gen === 3), 'ни один элемент не потерян')
      assert.equal(sources()[0].items_count, 750)
      assert.deepEqual(runs().map((r) => r.status), ['ok', 'ok', 'ok'])
    })

    it('pageEnd = short: короткая страница — последняя (так работал прежний код; включается только после проверки пробой, G1)', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: 'Архив', items: 450 }] })
      db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [db.seed.object({ name: 'Тест: объект' })] })
      fake.pageCap = 100
      const r = await manual(mkSync({ config: { pageEnd: 'short' } }))
      assert.equal(r.status, 'ok')
      assert.equal(items().length, 100, 'short принимает первую короткую страницу за конец')
      assert.equal(fake.count(ITEMS), 2, 'корень и «Архив» по одному запросу, без пустой страницы')
      // значение по умолчанию и неверное значение — защитный режим
      for (const config of [{}, { pageEnd: 'что-то' }]) {
        const run = await manual(mkSync({ config }))
        assert.equal(run.status, 'ok')
        assert.equal(items().length, 450, JSON.stringify(config))
      }
    })
  })

  describe('С-60: повтор id и нестабильные страницы', () => {
    function bigScene() {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: 'Большая', items: 450 }, { name: 'Малая', items: 2 }] })
      const src = db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [db.seed.object({ name: 'Тест: объект' })] })
      return { project, ids, src, big: ids['Корень / Большая'], small: ids['Корень / Малая'] }
    }

    it('новый элемент вставлен в начало между страницами (A5-7б перевёрнут): повтор на границе пропущен, прогон ok, список полный', async () => {
      const s = bigScene()
      fake.onItems(s.big, (n, f) => {
        if (n === 2) f.state.items.get(s.big).unshift({ ...f.state.items.get(s.big)[0], id: fakeId('item', 900001), name: 'Новый.pdf' })
      })
      const r = await manual(mkSync())
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.equal(items().filter((i) => i.parent_id === s.big).length, 451)
      assert.ok(items().some((i) => i.name === 'Новый.pdf'))
      assert.deepEqual(r.stats.roots[0].problems, undefined, 'проблемной папки нет: одна перепроверка помогла')
    })

    it('мягкое удаление между страницами (A5-7а перевёрнут): сосед удалённого не теряется', async () => {
      const s = bigScene()
      const list = fake.state.items.get(s.big)
      const victim = list[4]
      const neighbor = list[200]
      fake.onItems(s.big, (n, f) => { if (n === 2) f.softDelete(s.big, victim.id) })
      const r = await manual(mkSync())
      assert.equal(r.status, 'ok')
      const got = new Set(items().map((i) => i.node_id))
      assert.ok(got.has(neighbor.id), 'существующий элемент не потерян')
      assert.ok(!got.has(victim.id), 'удалённый не остался в снимке как живой')
    })

    it('порядок меняется от запроса к запросу → problem=unstable, items_listed=false: файлы папки из прежнего снимка, остальные папки обновлены, прогон ok', async () => {
      const s = bigScene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const before = items().filter((i) => i.parent_id === s.big).map((i) => [i.node_id, i.absent_nights])
      assert.equal(before.length, 450)
      fake.scramble(s.big)
      fake.addItems(s.small, 1)
      const calls0 = fake.itemCalls(s.big)
      const r = await manual(sync)
      assert.deepEqual([r.status, r.reason], ['ok', null], JSON.stringify(r))
      assert.deepEqual(r.stats.roots[0].problems, [{ nodeId: s.big, code: 'unstable' }])
      assert.equal(node(s.big).problem, 'unstable')
      assert.deepEqual(items().filter((i) => i.parent_id === s.big).map((i) => [i.node_id, i.absent_nights]), before, 'файлы нестабильной папки считаются прежними')
      assert.ok(items().filter((i) => i.parent_id === s.big).every((i) => i.seen_gen === 2))
      assert.equal(items().filter((i) => i.parent_id === s.small).length, 3, 'малая папка обновлена')
      assert.ok(sources()[0].last_error === null)
      assert.ok(fake.itemCalls(s.big) - calls0 <= 2 * 5, 'не больше двух проходов (по 4 страницы и сверка первой)')
      // порядок успокоился — проблема снята
      fake.unscramble(s.big)
      assert.equal((await manual(sync)).status, 'ok')
      assert.equal(node(s.big).problem, null)
    })
  })

  describe('В-10, С-4: файлы со ссылкой, которых обход не встретил', () => {
    function scene() {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: 'Папка 1', items: 3 }, { name: 'Папка 2', items: 2 }, { name: 'Папка 3', items: 2 }] })
      const obj = db.seed.object({ name: 'Тест: объект А', code: 'АЛИЯ' })
      const src = db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
      const f = { 1: ids['Корень / Папка 1'], 2: ids['Корень / Папка 2'], 3: ids['Корень / Папка 3'] }
      return { project, ids, obj, src, f, itemIn: (folder, k = 0) => fake.state.items.get(folder)[k].id }
    }
    const link = (s, number, nodeId) => {
      const id = db.seed.contract({ number, objectId: s.obj })
      db.sql(`INSERT INTO osp_private.signal_contracts (contract_id, state, node_id) VALUES ('${id}', 'verified', '${nodeId}')`)
      return id
    }

    it('удалённый файл найден адресным запросом deleted=true только по своей папке: в снимке deleted=true, прочие файлы и папки не затронуты', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      const y = s.itemIn(s.f[2], 0)
      link(s, 'АЛИЯ-ДП-26-001', x)
      link(s, 'АЛИЯ-ДП-26-002', y)
      fake.softDelete(s.f[1], x) // X удалён в SIGNAL; Y остался живым и встретится в обходе
      fake.resetRequests()
      const r = await manual(sync)
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.deepEqual(deletedRequests(), [s.f[1]], 'адресный запрос — только папка файла, не встреченного в обходе (Y встретили)')
      assert.equal(node(x).deleted, true)
      assert.equal(node(x).seen_gen, 2, 'удалённый файл виден в этом поколении как удалённый')
      assert.equal(node(y).deleted, false)
      assert.equal(r.stats.roots[0].deletedFound, 1)
      assert.equal(r.stats.roots[0].deletedSkipped, undefined)
      assert.equal(sources()[0].items_count, 6, 'удалённый в число файлов не входит')
      assert.equal(stageCount(), 0)
    })

    it('файл пропал совсем (не удалён, перенесён или закрыт): запрос удалённых не находит его — узел остаётся как был (дальше правило двух ночей, file_not_visible)', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      link(s, 'АЛИЯ-ДП-26-001', x)
      fake.setItems(s.f[1], fake.state.items.get(s.f[1]).filter((it) => it.id !== x)) // исчез без признака удаления
      fake.resetRequests()
      const r = await manual(sync)
      assert.equal(r.status, 'ok')
      assert.deepEqual(deletedRequests(), [s.f[1]])
      assert.equal(r.stats.roots[0].deletedFound, undefined)
      assert.deepEqual([node(x).deleted, node(x).seen_gen, node(x).absent_nights], [false, 1, 0], 'ручной обход ночь не считает')
      // ночной обход считает ночь без узла
      const night = await at(sync, '2030-03-05 05:10')
      assert.equal(night.status, 'ok')
      assert.deepEqual([node(x).deleted, node(x).absent_nights], [false, 1])
    })

    it('уже удалённый файл повторно не ищется; вернулся из удалённых — снова живой', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      link(s, 'АЛИЯ-ДП-26-001', x)
      fake.softDelete(s.f[1], x)
      assert.equal((await manual(sync)).status, 'ok')
      assert.equal(node(x).deleted, true)
      fake.resetRequests()
      assert.equal((await manual(sync)).status, 'ok')
      assert.deepEqual(deletedRequests(), [], 'SQL не отдаёт удалённый файл как «со ссылкой»: повторных запросов нет')
      assert.equal(node(x).deleted, true, 'остаётся удалённым')
      fake.restoreItem(s.f[1], x)
      assert.equal((await manual(sync)).status, 'ok')
      assert.equal(node(x).deleted, false, 'вернулся в обход как живой')
      assert.equal(node(x).seen_gen, 4)
    })

    it('предел запросов на прогон (deletedLookupLimit): сверх предела папки не запрашиваются, в статистике — число пропущенных; 0 — адресный запрос выключен', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const xs = [s.f[1], s.f[2], s.f[3]].map((folder) => s.itemIn(folder, 0))
      xs.forEach((x, i) => link(s, `АЛИЯ-ДП-26-00${i + 1}`, x))
      xs.forEach((x, i) => fake.softDelete([s.f[1], s.f[2], s.f[3]][i], x))
      fake.resetRequests()
      const limited = await manual(mkSync({ config: { deletedLookupLimit: 2 } }))
      assert.equal(limited.status, 'ok')
      assert.equal(deletedRequests().length, 2, 'ровно два запроса на прогон')
      assert.equal(limited.stats.roots[0].deletedFound, 2)
      assert.equal(limited.stats.roots[0].deletedSkipped, 1)
      assert.equal(xs.filter((x) => node(x).deleted).length, 2)
      // следующий прогон добирает оставшийся (остальные уже удалены и в список «со ссылкой» не входят)
      fake.resetRequests()
      assert.equal((await manual(mkSync({ config: { deletedLookupLimit: 2 } }))).stats.roots[0].deletedFound, 1)
      assert.equal(xs.every((x) => node(x).deleted), true)
      // выключено: удалённый файл не замечается (как прежде) — запросов deleted=true нет
      const s2x = s.itemIn(s.f[1], 0)
      fake.restoreItem(s.f[1], s2x)
      await manual(sync)
      fake.softDelete(s.f[1], s2x)
      fake.resetRequests()
      const off = await manual(mkSync({ config: { deletedLookupLimit: 0 } }))
      assert.equal(off.status, 'ok')
      assert.deepEqual(deletedRequests(), [])
      assert.equal(node(s2x).deleted, false)
    })

    it('папка файла нечитаема (403): запроса удалённых по ней нет, прогон не падает', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      link(s, 'АЛИЯ-ДП-26-001', x)
      fake.softDelete(s.f[1], x)
      fake.denyItems(s.f[1], 403)
      fake.resetRequests()
      const r = await manual(sync)
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.deepEqual(deletedRequests(), [])
      assert.equal(node(x).deleted, false)
      assert.equal(node(s.f[1]).problem, 'forbidden')
    })

    it('403 на запросе удалённых (читается только список живых) — не сбой прогона', async () => {
      const s = scene()
      const sync = mkSync()
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      link(s, 'АЛИЯ-ДП-26-001', x)
      fake.softDelete(s.f[1], x)
      fake.fail((r) => r.path === ITEMS && r.query.deleted === 'true', { status: 403, body: {}, times: 100 })
      const r = await manual(sync)
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.equal(r.stats.roots[0].deletedSkipped, 1)
      assert.equal(node(x).deleted, false)
    })

    it('дневной режим known: папка файла со ссылкой читается, хотя она не «известная»; удалённый файл замечен', async () => {
      const s = scene()
      const sync = mkSync({ config: { dayMode: 'known' } })
      assert.equal((await manual(sync)).status, 'ok')
      const x = s.itemIn(s.f[1], 1)
      link(s, 'АЛИЯ-ДП-26-001', x)
      fake.softDelete(s.f[1], x)
      fake.resetRequests()
      const r = await at(sync, '2030-03-04 12:00')
      assert.equal(r.status, 'ok', JSON.stringify(r))
      assert.equal(runs().at(-1).mode, 'known')
      const listed = new Set(fake.requests.filter((q2) => q2.path === ITEMS && q2.query.deleted !== 'true').map((q2) => q2.query.folderId))
      assert.deepEqual([...listed], [s.f[1]], 'читается только папка файла со ссылкой')
      assert.equal(node(x).deleted, true)
    })
  })

  describe('объектные коды для сопоставителя', () => {
    it('коды объектов из базы доходят до prepareNode: «9.ПРИМ-ДП-26-001» разбирается по известному коду', async () => {
      const project = fake.addProject({ name: 'Тест: проект' })
      const { ids } = fake.build(project, { name: 'Корень', children: [{ name: '9.ПРИМ-ДП-26-001 ООО Альфа', items: 1 }] })
      const obj = db.seed.object({ name: 'Тест: объект', code: '9.ПРИМ' })
      db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [obj] })
      const folder = ids['Корень / 9.ПРИМ-ДП-26-001 ООО Альфа']
      assert.equal((await manual(mkSync())).status, 'ok')
      assert.deepEqual(node(folder).number_keys, ['9.ПРИМ|2026|1'])
      // код объекта другой — разбор без приставки
      db.sql("UPDATE public.objects SET contract_code = 'ПРИМ'")
      assert.equal((await manual(mkSync())).status, 'ok')
      assert.deepEqual(node(folder).number_keys, ['ПРИМ|2026|1'])
    })
  })
})
