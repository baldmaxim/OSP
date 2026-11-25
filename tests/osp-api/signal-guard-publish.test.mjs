// Тесты-сторожа публикации снимка SIGNAL (пакет ПР-9, находки К-2 и К-4): обход → снимок → очередь → состояние СКВОЗНЫМ путём
// на настоящей базе (миграция 20270228_signal_integration), настоящем обходе и поддельном SIGNAL (tests/osp-api/lib/fake-signal.mjs).
// Сторожа утверждают ИНВАРИАНТЫ, а не точные строки: причины состояний, которые меняет волна исправлений, здесь не проверяются.
//
//   К-2  перенос и переименование папки при публикации: источник, родитель, путь, ключи номера, граница объекта обновлены у папки
//        и потомков; «сверено» следует за папкой, а вне объекта договора — не выдаётся ни состояние «сверено», ни имена, ни файлы.
//        Ловит мутации публикации, которые перестают обновлять source_id, parent_id, name/path/path_ids, number_keys/name_norm.
//   К-4  стык absent_nights → signal_node_json → сопоставитель: папка пропала в первом ночном полном обходе — «не сверялась»
//        (unverified:not_observed), во втором ПОДРЯД — «требует внимания» (attention:not_visible); дневной обход, сбойная ночь и
//        возврат папки счёт не продвигают / сбрасывают его. Значение absentNights НЕ подставляется вручную, как в signal-match.test.mjs.
//
// Имена папок несут номер договора (совпадает с договором): состояние «сверено» верно и до, и после правил номеров старого вида.
// Данные — синтетика (вымышленные названия, коды объектов, адреса signal.example.test).
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET } from './lib/fake-signal.mjs'
import { startSignalApp, folderUrl } from './lib/signal-app.mjs'
import { one } from './lib/signal-scenario.mjs'
import { createSignalClient } from '../../server/osp-api/src/lib/signalClient.js'
import { createSignalApi } from '../../server/osp-api/src/lib/signalApi.js'
import { createSignalSync } from '../../server/osp-api/src/lib/signalSync.js'
import { prepareNode } from '../../server/osp-api/src/lib/signalMatch.js'

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
// Москва — UTC+3 круглый год: «2030-03-05 05:10» по Москве.
const msk = (text) => Date.parse(`${text.replace(' ', 'T')}:00+03:00`)

const DP_A = 'ДП ПАА-ДП-26-001 ООО Ромашка'
const DP_A_RENAMED = 'ДП ПАА-ДП-26-001 ООО Ромашка (новая редакция)'
const DP_A_OTHER_NUMBER = 'ДП ПАА-ДП-26-005 ООО Ромашка'
const DP_B = 'ДП ПББ-ДП-26-001 ООО Лютик'
const NOT_VERIFIED = (state) => !['verified', 'accepted'].includes(state)

describe('Сторожа публикации SIGNAL: перенос, переименование, две ночи (К-2, К-4)', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let sdb
  let fake
  let h
  let clock
  let sync
  let U

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb({ max: 4, lockTimeoutMs: 5000 })
    fake = await startFakeSignal()
    h = await startSignalApp(db, { fake })
    U = { editor: db.seed.user({ contracts: 'edit' }) }
  })
  after(async () => { await sync?.stop(); await h?.close(); await fake?.close(); await db?.stop() })

  const reset = () => db.sql(`DELETE FROM public.contract_audit_log; DELETE FROM public.contract_counterparties; DELETE FROM public.contracts;
    TRUNCATE osp_private.signal_stage_nodes, osp_private.signal_runs, osp_private.signal_nodes, osp_private.signal_candidates,
      osp_private.signal_contracts, osp_private.signal_queue, osp_private.signal_bindings, osp_private.signal_sources, osp_private.signal_aliases RESTART IDENTITY;
    UPDATE osp_private.signal_meta SET generation = 0, published_at = NULL, published_run_id = NULL WHERE id = 1;`)

  const mkSync = () => createSignalSync({
    db: sdb, isReadOnly: () => false, now: () => clock, config: { heartbeatMs: 10_000 }, log: { info() {}, warn() {} },
    api: createSignalApi({ client: createSignalClient({ baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, backoffMs: [5, 5, 5] }) }),
  })
  beforeEach(() => { clock = msk('2030-03-04 12:00'); sync = mkSync() })
  afterEach(async () => { await sync.stop(); fake.clearFaults() })

  // Ручной полный обход (kind=manual: ночь не считает).
  const manual = async () => { const s = await sync.runNow({ initiator: 'cli' }); assert.ok(s.started, JSON.stringify(s)); return s.done }
  // Обход по расписанию на момент по Москве: 05:00–08:00 — ночной полный, пн–пт 08:00–20:00 — дневной.
  const sched = async (text) => { clock = msk(text); return sync.tick() }
  const q = (text) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${text}) t`)
  const stateOf = (id) => q(`select state, reason, node_id, confirmed_by from osp_private.signal_contracts where contract_id = ${lit(id)}`)[0] || null
  const nodeRows = (ids) => Object.fromEntries(q(`select node_id, source_id, parent_id, name, path, path_ids, depth, object_id, number_keys, name_norm, seen_gen, absent_nights, modified_at
    from osp_private.signal_nodes where node_id in (${ids.map(lit).join(', ')})`).map((r) => [r.node_id, r]))
  const linkOf = (id) => one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`)
  const card = async (uid, id) => (await h.get(uid, `/api/signal/contracts/${id}`)).json()
  const marksOf = async (uid) => Object.fromEntries((await h.get(uid, '/api/signal/marks?limit=1000')).json().items.map((m) => [m.id, m]))
  const hasObjectPath = () => Number(one(db, `select count(*) from information_schema.columns where table_schema = 'osp_private' and table_name = 'signal_nodes' and column_name = 'object_path'`)) > 0

  // Цепочка папок от корня источника до узла по ПОДДЕЛЬНОМУ SIGNAL (истина о дереве, не по базе приложения).
  const chainOf = (project, rootId, id) => {
    const map = fake.state.folders.get(project)
    const out = []
    for (let f = map.get(id); f; f = map.get(f.parentId)) {
      out.unshift(f)
      if (f.id === rootId) return out
    }
    return null
  }
  const expectNode = (rows, project, rootId, id, label, { source, object }) => {
    const chain = chainOf(project, rootId, id)
    assert.ok(chain, `${label}: узел в корне источника в поддельном SIGNAL`)
    const row = rows[id]
    assert.ok(row, `${label}: узел есть в снимке`)
    const node = chain.at(-1)
    assert.equal(row.name, node.name, `${label}: имя`)
    assert.equal(row.path, chain.map((f) => f.name).join(' / '), `${label}: путь`)
    assert.equal(row.parent_id, node.parentId, `${label}: родитель`)
    assert.equal(row.source_id, source, `${label}: источник`)
    assert.equal(row.object_id, object, `${label}: объект (граница)`)
    const ancestors = chain.slice(0, -1).map((f) => f.id)
    for (const a of ancestors) assert.ok(row.path_ids.includes(a), `${label}: path_ids содержит предка ${a}`)
    assert.ok(!row.path_ids.some((x) => !ancestors.includes(x) && x !== id), `${label}: path_ids без чужих предков`)
    // ключи номера и нормализованное имя — по текущему имени, как считает обход (prepareNode)
    const prepared = prepareNode({ name: node.name, path: row.path, kind: 'folder' })
    assert.deepEqual([...row.number_keys].sort(), [...prepared.numberKeys].sort(), `${label}: number_keys по текущему имени`)
    assert.equal(row.name_norm, prepared.nameNorm, `${label}: name_norm по текущему имени`)
    assert.equal(row.depth, chain.length - 1, `${label}: глубина — число предков`)
    assert.equal(Date.parse(row.modified_at), Date.parse(node.modified), `${label}: время изменения — как в SIGNAL`)
    assert.equal(row.seen_gen, Number(one(db, 'select generation from osp_private.signal_meta')), `${label}: узел виден в последнем поколении`)
    assert.equal(row.absent_nights, 0, `${label}: счёт ночей сброшен`)
    return row
  }
  // Новая граница объекта (object_path, К-1/С-21): если колонка есть — это суффикс пути, оканчивающийся текущим именем (не старый путь).
  const expectObjectPath = (id, label) => {
    if (!hasObjectPath()) return
    const row = q(`select name, path, object_path from osp_private.signal_nodes where node_id = ${lit(id)}`)[0]
    assert.ok(row.object_path, `${label}: object_path вычислен`)
    assert.ok(row.path.endsWith(row.object_path), `${label}: object_path — суффикс пути (${row.object_path} / ${row.path})`)
    assert.ok(row.object_path.endsWith(row.name), `${label}: object_path оканчивается текущим именем`)
  }
  // Ни одного имени, пути и id «чужой» папки в ответе (ссылка договора — его собственные данные, её не сканируем).
  const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'signalLink').map(([k, x]) => [k, strip(x)])) : v)
  const assertNoLeak = (body, markers, label) => {
    const text = JSON.stringify(strip(body))
    const found = markers.filter((m) => text.includes(m))
    assert.deepEqual(found, [], `${label}: в ответе чужие имена или идентификаторы`)
  }

  // ── К-2. Перенос и переименование папок ─────────────────────────────────────────────────────────────────────────────
  describe('К-2: перенос и переименование папки при публикации', () => {
    async function sceneMoves() {
      reset()
      const project = fake.addProject({ name: 'Тест: проект переносов' })
      const { ids } = fake.build(project, [
        { name: 'Корень 1', children: [
          { name: 'Папка Один', children: [{ name: DP_A, items: 2, children: [{ name: 'Акты', items: 1 }] }] },
          { name: 'Папка Два', items: 1 },
          { name: 'Прочее', items: 1 },
        ] },
        { name: 'Корень 2', children: [{ name: DP_B, items: 1 }, { name: 'Прочее Б', items: 1 }] },
      ])
      const oa = db.seed.object({ name: 'Тест: объект ПАА', code: 'ПАА' })
      const ob = db.seed.object({ name: 'Тест: объект ПББ', code: 'ПББ' })
      const cpR = db.seed.counterparty({ name: 'ООО Ромашка' })
      const cpL = db.seed.counterparty({ name: 'ООО Лютик' })
      const s1 = db.seed.source({ projectId: project, folderId: ids['Корень 1'], objectIds: [oa] })
      const s2 = db.seed.source({ projectId: project, folderId: ids['Корень 2'], objectIds: [ob] })
      const F = {
        root1: ids['Корень 1'], root2: ids['Корень 2'], one: ids['Корень 1 / Папка Один'], two: ids['Корень 1 / Папка Два'],
        a: ids[`Корень 1 / Папка Один / ${DP_A}`], acts: ids[`Корень 1 / Папка Один / ${DP_A} / Акты`], b: ids[`Корень 2 / ${DP_B}`],
      }
      const link = folderUrl(project, F.a)
      const cA = db.seed.contract({ number: 'ПАА-ДП-26-001', objectId: oa, counterparties: [cpR], signalLink: link })
      const cB = db.seed.contract({ number: 'ПББ-ДП-26-001', objectId: ob, counterparties: [cpL], signalLink: folderUrl(project, F.b) })
      const first = await manual()
      assert.equal(first.status, 'ok', JSON.stringify(first))
      await h.tick()
      return { project, oa, ob, s1, s2, F, cA, cB, link }
    }
    // Договор не менялся людьми: ссылка прежняя, решений и событий «Истории» нет (инвариант 2).
    const assertLinkUntouched = (s, label) => {
      assert.equal(linkOf(s.cA), s.link, `${label}: ссылка договора не тронута обходом и очередью`)
      assert.equal(stateOf(s.cA).confirmed_by, null, `${label}: решения человека не появились`)
      assert.equal(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(s.cA)} and event_type = 'signal_link'`), '0', `${label}: события «Истории» нет`)
    }

    it('переименование на месте: имя, путь папки и потомка, ключи номера обновлены; «сверено» сохраняется; смена номера в имени — противоречие', async () => {
      const s = await sceneMoves()
      const { project, F } = s
      assert.equal(stateOf(s.cA).state, 'verified', 'исходно сверено')
      assert.equal(stateOf(s.cB).state, 'verified', 'контрольный договор другого объекта сверен')
      const before = nodeRows([F.a, F.acts])
      assert.deepEqual([before[F.a].source_id, before[F.a].object_id], [s.s1.id, s.oa])

      // 1. то же имя + приписка: номер в имени прежний
      fake.renameFolder(project, F.a, DP_A_RENAMED)
      assert.equal((await manual()).status, 'ok')
      let rows = nodeRows([F.a, F.acts])
      expectNode(rows, project, F.root1, F.a, 'переименование: папка', { source: s.s1.id, object: s.oa })
      expectNode(rows, project, F.root1, F.acts, 'переименование: потомок', { source: s.s1.id, object: s.oa })
      assert.equal(rows[F.a].name, DP_A_RENAMED)
      expectObjectPath(F.a, 'переименование: папка')
      expectObjectPath(F.acts, 'переименование: потомок')
      await h.tick()
      assert.equal(stateOf(s.cA).state, 'verified', 'номер в имени тот же — сверено')
      assertLinkUntouched(s, 'после переименования')

      // 2. другой номер договора в имени: ключи номера пересчитаны, договор не «сверен»
      fake.renameFolder(project, F.a, DP_A_OTHER_NUMBER)
      assert.equal((await manual()).status, 'ok')
      rows = nodeRows([F.a, F.acts])
      expectNode(rows, project, F.root1, F.a, 'другой номер: папка', { source: s.s1.id, object: s.oa })
      expectNode(rows, project, F.root1, F.acts, 'другой номер: потомок', { source: s.s1.id, object: s.oa })
      assert.notDeepEqual([...rows[F.a].number_keys], [...before[F.a].number_keys], 'ключ номера сменился вместе с именем')
      await h.tick()
      const st = stateOf(s.cA)
      assert.equal(st.state, 'conflict', `другой номер в названии папки — противоречие, получено ${st.state}:${st.reason}`)
      assertLinkUntouched(s, 'после смены номера')

      // 3. имя возвращено: «сверено» возвращается, решение (ссылка) цело
      fake.renameFolder(project, F.a, DP_A)
      assert.equal((await manual()).status, 'ok')
      rows = nodeRows([F.a, F.acts])
      expectNode(rows, project, F.root1, F.a, 'имя возвращено: папка', { source: s.s1.id, object: s.oa })
      assert.deepEqual([...rows[F.a].number_keys], [...before[F.a].number_keys])
      await h.tick()
      assert.equal(stateOf(s.cA).state, 'verified')
      assertLinkUntouched(s, 'после возврата имени')
    })

    it('перенос внутри корня (другой родитель): родитель, путь, path_ids папки и потомка обновлены, объект тот же, «сверено» сохраняется', async () => {
      const s = await sceneMoves()
      const { project, F } = s
      fake.moveFolder(project, F.a, F.two)
      assert.equal((await manual()).status, 'ok')
      const rows = nodeRows([F.a, F.acts])
      expectNode(rows, project, F.root1, F.a, 'перенос внутри корня: папка', { source: s.s1.id, object: s.oa })
      expectNode(rows, project, F.root1, F.acts, 'перенос внутри корня: потомок', { source: s.s1.id, object: s.oa })
      assert.equal(rows[F.a].parent_id, F.two)
      assert.ok(!rows[F.a].path_ids.includes(F.one), 'прежнего родителя в path_ids нет')
      assert.ok(!rows[F.acts].path_ids.includes(F.one), 'у потомка тоже')
      expectObjectPath(F.a, 'перенос внутри корня: папка')
      await h.tick()
      assert.equal(stateOf(s.cA).state, 'verified')
      assertLinkUntouched(s, 'после переноса внутри корня')
    })

    it('перенос и переименование в корень другого объекта, затем обратно: источник и граница объекта у папки и потомков; чужому договору — ни «сверено», ни имён, ни файлов', async () => {
      const s = await sceneMoves()
      const { project, F } = s
      const aMarkers = [F.a, F.acts, 'Акты', 'Корень 2', DP_A_RENAMED]
      // контроль: до переноса папка договору видна (иначе проверки «не выдаётся» ниже были бы пустыми)
      const pre = await card(U.editor, s.cA)
      assert.equal(pre.node?.nodeId, F.a)
      assert.ok(pre.files.some((f) => f.name === 'Акты'), 'до переноса папка «Акты» в списке содержимого')
      // имя и корень сменены одной публикацией
      fake.renameFolder(project, F.a, DP_A_RENAMED)
      fake.moveFolder(project, F.a, F.root2)
      assert.equal((await manual()).status, 'ok')
      const moved = nodeRows([F.a, F.acts])
      expectNode(moved, project, F.root2, F.a, 'в корень 2: папка', { source: s.s2.id, object: s.ob })
      expectNode(moved, project, F.root2, F.acts, 'в корень 2: потомок', { source: s.s2.id, object: s.ob })
      assert.equal(moved[F.a].parent_id, F.root2)
      assert.ok(!moved[F.a].path_ids.includes(F.root1) && !moved[F.acts].path_ids.includes(F.root1), 'корня 1 в path_ids нет')
      expectObjectPath(F.a, 'в корень 2: папка')
      expectObjectPath(F.acts, 'в корень 2: потомок')

      // ОКНО между публикацией и тактом очереди: договор объекта ПАА ссылается на папку, ушедшую в объект ПББ
      const win = await card(U.editor, s.cA)
      assert.equal(win.node, null, 'окно: узел чужого объекта не выдаётся')
      assert.deepEqual(win.files, [], 'окно: файлов чужой папки нет')
      assertNoLeak(win, aMarkers, 'окно: карточка')
      const mark = db.asJson(U.editor, 'select osp_private.signal_marks(null, 1000)').items.find((m) => m.id === s.cA)
      assert.equal(mark.path, undefined, 'окно: значок без пути чужой папки')
      assertNoLeak((await marksOf(U.editor))[s.cA], aMarkers, 'окно: значок')

      // ПОСЛЕ такта очереди
      await h.tick()
      const st = stateOf(s.cA)
      assert.ok(NOT_VERIFIED(st.state), `после переноса в чужой объект договор не «сверен»: ${st.state}:${st.reason}`)
      assert.equal(st.node_id, null, 'узел чужого объекта в состоянии не хранится')
      const after = await card(U.editor, s.cA)
      assert.equal(after.node, null)
      assert.deepEqual(after.files, [])
      assertNoLeak(after, aMarkers, 'после очереди: карточка')
      assertNoLeak((await marksOf(U.editor))[s.cA], aMarkers, 'после очереди: значок')
      assertLinkUntouched(s, 'после переноса в корень другого объекта')
      assert.equal(stateOf(s.cB).state, 'verified', 'договор объекта-получателя не пострадал')

      // обратно в корень 1 и прежнее имя
      fake.renameFolder(project, F.a, DP_A)
      fake.moveFolder(project, F.a, F.one)
      assert.equal((await manual()).status, 'ok')
      const back = nodeRows([F.a, F.acts])
      expectNode(back, project, F.root1, F.a, 'обратно: папка', { source: s.s1.id, object: s.oa })
      expectNode(back, project, F.root1, F.acts, 'обратно: потомок', { source: s.s1.id, object: s.oa })
      expectObjectPath(F.a, 'обратно: папка')
      await h.tick()
      assert.equal(stateOf(s.cA).state, 'verified', 'папка вернулась — сверено вернулось')
      const view = await card(U.editor, s.cA)
      assert.equal(view.node?.nodeId, F.a)
      assert.ok(view.files.length > 0, 'файлы папки снова видны')
      assertLinkUntouched(s, 'после возврата')
    })
  })

  // ── К-4. «Две ночи» сквозным путём ──────────────────────────────────────────────────────────────────────────────────
  describe('К-4: absent_nights → signal_node_json → сопоставитель (Ф2: папка не видна после двух ночей подряд)', () => {
    async function sceneNights() {
      reset()
      const project = fake.addProject({ name: 'Тест: проект ночей' })
      const { ids } = fake.build(project, { name: 'Корень', children: [
        { name: DP_A, items: 2 }, { name: 'Папка Два', items: 1 }, { name: 'Папка Три', items: 1 }, { name: 'Папка Четыре', items: 1 },
      ] })
      const oa = db.seed.object({ name: 'Тест: объект ПАА', code: 'ПАА' })
      db.seed.source({ projectId: project, folderId: ids['Корень'], objectIds: [oa] })
      const a = ids[`Корень / ${DP_A}`]
      const cA = db.seed.contract({ number: 'ПАА-ДП-26-001', objectId: oa, counterparties: [db.seed.counterparty({ name: 'ООО Ромашка' })], signalLink: folderUrl(project, a) })
      assert.equal((await manual()).status, 'ok')
      await h.tick()
      assert.equal(stateOf(cA).state, 'verified', 'исходно сверено')
      return { project, root: ids['Корень'], a, cA }
    }
    const absent = (id) => Number(one(db, `select absent_nights from osp_private.signal_nodes where node_id = ${lit(id)}`))
    // Значение, которое получает сопоставитель: то, что отдаёт signal_node_json по узлу (а не подставленное вручную).
    const seenByMatcher = (id) => JSON.parse(one(db, `select jsonb_build_object('absentNights', osp_private.signal_node_json(${lit(id)}) ->> 'absentNights',
      'observed', osp_private.signal_node_json(${lit(id)}) ->> 'observed')::text`))
    const readSt = (id) => { const r = stateOf(id); return `${r.state}:${r.reason}` }

    it('первая ночь без папки — «не сверялась», вторая подряд — «требует внимания»; дневной обход и сбойная ночь счёт не двигают; возврат папки сбрасывает', async () => {
      const s = await sceneNights()
      fake.removeFolder(s.project, s.a)

      const n1 = await sched('2030-03-05 05:10')
      assert.equal(n1.status, 'ok', JSON.stringify(n1))
      assert.equal(absent(s.a), 1, 'ночь 1: счёт ночей без папки = 1')
      assert.deepEqual(seenByMatcher(s.a), { absentNights: '1', observed: 'false' }, 'ночь 1: сопоставитель получает absentNights = 1')
      await h.tick()
      assert.equal(readSt(s.cA), 'unverified:not_observed', 'ночь 1: одна ночь — не сверялась')
      assert.equal((await marksOf(U.editor))[s.cA].state, 'unverified')

      const day = await sched('2030-03-05 09:05')
      assert.equal(day.status, 'ok', JSON.stringify(day))
      assert.equal(absent(s.a), 1, 'дневной обход ночь не считает')
      await h.tick()
      assert.equal(readSt(s.cA), 'unverified:not_observed', 'день между ночами: по-прежнему не сверялась')

      fake.fail('/folders/tree', { status: 500, times: 10 })
      const bad = await sched('2030-03-06 05:10')
      assert.notEqual(bad.status, 'ok', 'ночь со сбоем дерева не опубликована')
      fake.clearFaults()
      assert.equal(absent(s.a), 1, 'сбойная ночь счёт не двигает')
      await h.tick()
      assert.equal(readSt(s.cA), 'unverified:not_observed', 'после сбойной ночи состояние прежнее')

      const n2 = await sched('2030-03-06 05:45') // повтор ночного слота
      assert.equal(n2.status, 'ok', JSON.stringify(n2))
      assert.equal(absent(s.a), 2, 'ночь 2 подряд: счёт = 2')
      assert.deepEqual(seenByMatcher(s.a), { absentNights: '2', observed: 'false' }, 'ночь 2: сопоставитель получает absentNights = 2')
      await h.tick()
      assert.equal(readSt(s.cA), 'attention:not_visible', 'две ночи подряд — требует внимания')
      assert.equal((await marksOf(U.editor))[s.cA].state, 'attention')
      assert.equal((await card(U.editor, s.cA)).state, 'attention')
      assert.equal(linkOf(s.cA), folderUrl(s.project, s.a), 'ссылку договора обход не меняет')

      // папка вернулась (тот же id) — на дневном обходе: счёт сброшен, состояние «сверено»
      fake.addFolder(s.project, { id: s.a, name: DP_A, parentId: s.root })
      const back = await sched('2030-03-06 10:05')
      assert.equal(back.status, 'ok', JSON.stringify(back))
      assert.equal(absent(s.a), 0, 'папка вернулась — счёт сброшен')
      await h.tick()
      assert.equal(readSt(s.cA).split(':')[0], 'verified', 'папка вернулась — сверено')
    })

    it('не «подряд»: пропажа в одну ночь, возврат днём, пропажа в следующую ночь — снова только «не сверялась»', async () => {
      const s = await sceneNights()
      fake.removeFolder(s.project, s.a)
      assert.equal((await sched('2030-03-05 05:10')).status, 'ok')
      assert.equal(absent(s.a), 1)

      fake.addFolder(s.project, { id: s.a, name: DP_A, parentId: s.root })
      assert.equal((await sched('2030-03-05 09:05')).status, 'ok')
      assert.equal(absent(s.a), 0, 'днём папка вернулась: счёт сброшен')
      await h.tick()
      assert.equal(readSt(s.cA).split(':')[0], 'verified')

      fake.removeFolder(s.project, s.a)
      assert.equal((await sched('2030-03-06 05:10')).status, 'ok')
      assert.equal(absent(s.a), 1, 'вторая пропажа — снова первая ночь')
      await h.tick()
      assert.equal(readSt(s.cA), 'unverified:not_observed', 'две ночи НЕ подряд — не «требует внимания»')
    })
  })
})
