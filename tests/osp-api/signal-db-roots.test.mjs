// Публикация по корням в базе сверки с SIGNAL (миграция 20270228_signal_integration): изоляция сбоя корня (В-5), проблемные подпапки,
// нагрузка (С-38), свежесть данных (В-7), перекрытие корней (С-5).
//   • signal_sync_finish: корень со status = 'failed' не публикуется и не мешает прочим (его узлы не пропадают, absent_nights не растут,
//     договоры остаются на прежних данных), в корне — last_error и failed_since; порог сокращения — по корню (отложенный корень ждёт
//     принятия, прочие публикуются); статус прогона ok | partial | held | failed; поколение растёт, если опубликован хоть один корень;
//   • папка, элементы которой не прочитаны (problem), приходит с itemsListed = false: её файлы переносятся, не считаются пропавшими
//     и не дают сокращения; problem виден в дереве и состоянии администратора;
//   • signal_accept_held принимает отложенные корни последнего held / partial прогона на том же поколении;
//   • С-38: публикация без изменений в SIGNAL никого не ставит в очередь; изменение, пропажа, возвращение, смена объекта и пути — ставят;
//   • В-7: dataAt значков и окна — дата данных корня узла (last_ok_at), а не публикации чужого корня; состояние администратора —
//     failedSince, lastError, последний held/partial прогон, идущий прогон с пульсом (stuck);
//   • С-5: корень не должен лежать внутри другого корня и над ним.
// Нужны зависимости сервера и PostgreSQL (бинарники или Docker). Данные вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip, uuid } from './lib/signal-db.mjs'

describe('База сверки с SIGNAL: публикация по корням, проблемные папки, нагрузка и свежесть', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const j = (text) => db.sqlJson(text)
  const gen = () => Math.max(1, Number(q('select generation from osp_private.signal_meta')))
  const node = (src, p) => q(`select seen_gen || '|' || absent_nights || '|' || coalesce(problem, '-') from osp_private.signal_nodes where source_id = ${src.id} and path = '${p}'`).split('|')
  const source = (src) => q(`select ready || '|' || coalesce(last_error, '-') || '|' || (failed_since is not null) || '|' || (last_ok_at is not null) from osp_private.signal_sources where id = ${src.id}`).split('|')
  const run = (id) => q(`select status || '|' || coalesce(reason, '-') || '|' || coalesce(generation::text, '-') from osp_private.signal_runs where id = ${id}`).split('|')
  const stageCount = (id) => Number(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${id}`))
  const queued = () => Number(q('select count(*) from osp_private.signal_queue'))
  const drain = () => q('delete from osp_private.signal_queue')
  const mk = (tree, { objectIds, code } = {}) => {
    const o = objectIds ? objectIds[0] : seed.object({ code })
    const src = seed.source({ objectIds: objectIds || [o] })
    const snap = seed.snapshot(src.id, tree, { generation: gen() })
    q(`update osp_private.signal_sources set last_ok_at = '2026-11-20T09:00:00Z' where id = ${src.id}`)
    return { o, src, snap }
  }

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('В-5: сбойный корень не публикуется и не мешает прочим — прежние данные остаются «виденными», failed_since ведётся; корни и прогоны: ok / partial / failed; успех снимает сбой', () => {
    const a = mk({ name: 'RA', children: [{ name: 'A1', items: [{ name: 'a1.pdf' }] }, { name: 'A2' }] }, { code: 'РТА' })
    const b = mk({ name: 'RB', children: [{ name: 'B1', items: [{ name: 'b1.pdf' }] }, { name: 'B2' }] }, { code: 'РТБ' })
    const ed = seed.user({ contracts: 'edit', objectIds: [a.o, b.o], objectScoped: true })
    const admin = seed.admin()
    const cB = seed.contract({ number: 'Старый-1', objectId: b.o })
    const folderB = b.snap.ids['RB / B1']
    q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id, checked_gen) values ('${cB}', 'verified', 'existing_url', '${folderB}', 1)`)
    drain()
    const okAt = (src) => q(`select last_ok_at::text from osp_private.signal_sources where id = ${src.id}`)
    const bOkAt = okAt(b.src)
    const g0 = gen()
    const treeA2 = { name: 'RA', children: [{ name: 'A1', items: [{ name: 'a1.pdf' }] }, { name: 'A2' }, { name: 'A3' }] }
    const failedB = (reason = 'forbidden') => ({ roots: [{ id: a.src.id, status: 'ok' }, { id: b.src.id, status: 'failed', reason }] })

    // Ночной прогон: А обошли, Б не удалось (403).
    const r1 = seed.sync({ kind: 'night', roots: [{ src: a.src, tree: treeA2, ids: a.snap.ids }, { src: b.src, tree: { name: 'RB', children: [{ name: 'B1' }] }, ids: b.snap.ids }], stats: failedB() })
    assert.deepEqual([r1.result.status, r1.result.reason, r1.result.generation], ['partial', 'root_failed', g0 + 1])
    assert.deepEqual(r1.result.roots, { published: [a.src.id], held: [], failed: [b.src.id] })
    assert.deepEqual(run(r1.run.runId), ['partial', 'root_failed', String(g0 + 1)])
    assert.equal(stageCount(r1.run.runId), 0, 'staging сбойного корня удалён, опубликованного — тоже')
    assert.ok(node(a.src, 'RA / A3'), 'новая папка здорового корня опубликована')
    assert.deepEqual(node(b.src, 'RB / B1'), [String(g0 + 1), '0', '-'], 'сбойный корень: узлы не пропали, absent_nights не растут, прежние данные «видны»')
    assert.deepEqual(node(b.src, 'RB / B1 / b1.pdf'), [String(g0 + 1), '0', '-'])
    assert.deepEqual(source(b.src), ['true', 'forbidden', 'true', 'true'], 'ready прежний, last_error и failed_since выставлены')
    assert.equal(okAt(b.src), bOkAt, 'дата данных сбойного корня прежняя')
    assert.deepEqual(source(a.src), ['true', '-', 'false', 'true'])
    // Договор корня Б остаётся «сверено» на прежних данных; дата данных — прежняя (В-7), у корня А — свежая.
    const mark = db.asJson(ed, 'select osp_private.signal_marks(null, 100)').items.find((i) => i.id === cB)
    assert.deepEqual([mark.state, mark.reason, mark.pending], ['verified', 'existing_url', false])
    assert.equal(new Date(mark.dataAt).getTime(), new Date(bOkAt).getTime(), 'dataAt — last_ok_at корня Б, а не публикации корня А')
    assert.equal(new Date(db.asJson(ed, `select osp_private.signal_contract_view('${cB}')`).dataAt).getTime(), new Date(bOkAt).getTime())
    // Состояние администратора: корень сбоит, последний «held или partial» — этот прогон.
    let st = db.asJson(admin, 'select osp_private.signal_admin_state()')
    const sb = st.sources.find((s) => s.id === b.src.id)
    assert.deepEqual([sb.status, sb.lastError, sb.failedSince !== null], ['failed', 'forbidden', true])
    assert.equal(st.sources.find((s) => s.id === a.src.id).status, 'ok')
    assert.deepEqual([st.lastHeld.id, st.lastHeld.status, st.lastHeld.generation, st.lastHeld.acceptable], [r1.run.runId, 'partial', g0 + 1, false], 'ставить нечего: нет отложенных корней')
    assert.equal(st.running, null)
    // Вторая ночь подряд: failed_since — первая ошибка подряд, не сдвигается; absent_nights по-прежнему 0.
    const since = q(`select failed_since::text from osp_private.signal_sources where id = ${b.src.id}`)
    const r2 = seed.sync({ kind: 'night', roots: [{ src: a.src, tree: treeA2, ids: a.snap.ids }], stats: failedB('timeout') })
    assert.equal(r2.result.status, 'partial')
    assert.equal(q(`select failed_since::text from osp_private.signal_sources where id = ${b.src.id}`), since)
    assert.equal(source(b.src)[1], 'timeout', 'причина последняя')
    assert.deepEqual(node(b.src, 'RB / B2'), [String(g0 + 2), '0', '-'])
    // Все корни сбойные: прогон failed, поколение прежнее, снимок не тронут.
    const g2 = gen()
    const r3 = seed.sync({ kind: 'manual', roots: [], stats: { roots: [{ id: a.src.id, status: 'failed', reason: 'http' }, { id: b.src.id, status: 'failed', reason: 'http' }] } })
    assert.deepEqual([r3.result.status, r3.result.reason, r3.result.generation], ['failed', 'root_failed', g2])
    assert.equal(gen(), g2)
    assert.deepEqual(source(a.src), ['true', 'http', 'true', 'true'])
    // Корень Б снова обошли: сбой снят, дата данных новая.
    const r4 = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: treeA2, ids: a.snap.ids }, { src: b.src, tree: { name: 'RB', children: [{ name: 'B1', items: [{ name: 'b1.pdf' }] }, { name: 'B2' }] }, ids: b.snap.ids }],
      stats: { roots: [{ id: a.src.id, status: 'ok' }, { id: b.src.id, status: 'ok' }] } })
    assert.equal(r4.result.status, 'ok')
    assert.deepEqual(r4.result.roots.published.sort(), [a.src.id, b.src.id].sort())
    assert.deepEqual(source(b.src), ['true', '-', 'false', 'true'])
    assert.notEqual(okAt(b.src), bOkAt)
    st = db.asJson(admin, 'select osp_private.signal_admin_state()')
    assert.deepEqual(st.sources.filter((s) => [a.src.id, b.src.id].includes(s.id)).map((s) => s.status), ['ok', 'ok'])
    // Корень не обходили вовсе (нет в статистике, нет staging): его узлы остаются «виденными», он не помечен сбоем.
    const g4 = gen()
    const r5 = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: treeA2, ids: a.snap.ids }], stats: { roots: [{ id: a.src.id, status: 'ok' }] } })
    assert.deepEqual([r5.result.status, r5.result.generation], ['ok', g4 + 1])
    assert.deepEqual(node(b.src, 'RB / B1'), [String(g4 + 1), '0', '-'])
    assert.deepEqual(source(b.src), ['true', '-', 'false', 'true'])
  })

  it('В-5: порог сокращения — по корню: отложенный корень ждёт принятия (staging цел), исправные публикуются; accept_held публикует отложенные корни последнего held / partial прогона на том же поколении', () => {
    const folders = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }))
    const a = mk({ name: 'HA', children: folders('А', 29) }, { code: 'РТВ' })
    const b = mk({ name: 'HB', children: folders('Б', 29) }, { code: 'РТГ' })
    const admin = seed.admin()
    const g0 = gen()
    // Б вернулся с 5 папками из 30 — ниже 70 %; А пришёл целиком, плюс одна новая.
    const treeA = { name: 'HA', children: [...folders('А', 29), { name: 'А-новая' }] }
    const treeBshort = { name: 'HB', children: folders('Б', 5) }
    const r1 = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: treeA, ids: a.snap.ids }, { src: b.src, tree: treeBshort, ids: b.snap.ids }] })
    assert.deepEqual([r1.result.status, r1.result.reason, r1.result.generation], ['partial', 'shrink', g0 + 1])
    assert.deepEqual(r1.result.roots, { published: [a.src.id], held: [b.src.id], failed: [] })
    assert.ok(node(a.src, 'HA / А-новая'), 'исправный корень опубликован')
    assert.equal(node(b.src, 'HB / Б20')[1], '0', 'отложенный корень: прежний снимок цел')
    assert.equal(node(b.src, 'HB / Б20')[0], String(g0 + 1), 'и «виден»')
    assert.equal(stageCount(r1.run.runId), 6, 'staging отложенного корня сохранён, опубликованного — удалён')
    assert.deepEqual([source(b.src)[1], source(b.src)[2]], ['-', 'false'], 'отложен — не сбой: last_error и failed_since нет (причина — в прогоне и в состоянии администратора)')
    assert.deepEqual(j(`select stats -> 'held' from osp_private.signal_runs where id = ${r1.run.runId}`), [{ id: b.src.id, kind: 'folders', was: 30, now: 6 }])
    let st = db.asJson(admin, 'select osp_private.signal_admin_state()')
    assert.deepEqual(st.sources.filter((s) => [a.src.id, b.src.id].includes(s.id)).map((s) => [s.status, s.heldRunId]), [['ok', null], ['held', r1.run.runId]])
    assert.deepEqual([st.lastHeld.id, st.lastHeld.status, st.lastHeld.reason, st.lastHeld.acceptable], [r1.run.runId, 'partial', 'shrink', true])
    // Принять: не то поколение — отказ; то — публикуется только отложенный корень, поколение +1.
    const accept = (run, g) => `select osp_private.signal_accept_held(${run}, ${g}, 'cli:admin', 'проверено')`
    assert.equal(db.sqlError(accept(r1.run.runId, g0)).message, 'stale_state')
    const done = j(accept(r1.run.runId, gen()))
    assert.deepEqual([done.status, done.generation], ['ok', g0 + 2])
    assert.deepEqual(run(r1.run.runId), ['ok', '-', String(g0 + 2)])
    assert.equal(node(b.src, 'HB / Б20')[0], String(g0 + 1), 'принятый корень: узел Б20 пропал в принятом снимке (в нём 5 папок)')
    assert.equal(node(b.src, 'HB / Б1')[0], String(g0 + 2))
    assert.deepEqual(source(b.src), ['true', '-', 'false', 'true'])
    assert.equal(stageCount(r1.run.runId), 0)
    assert.equal(db.sqlError(accept(r1.run.runId, g0 + 2)).message, 'stale_state', 'второй раз — нельзя')
    // Оба корня отложены: прогон held, поколение прежнее.
    const c1 = mk({ name: 'HC1', children: folders('В', 29) }, { code: 'РТК' })
    const c2 = mk({ name: 'HC2', children: folders('Г', 29) }, { code: 'РТЛ' })
    const g1 = gen()
    const r2 = seed.sync({ kind: 'manual', roots: [{ src: c1.src, tree: { name: 'HC1', children: folders('В', 5) }, ids: c1.snap.ids }, { src: c2.src, tree: { name: 'HC2', children: [] }, ids: c2.snap.ids }] })
    assert.deepEqual([r2.result.status, r2.result.reason, r2.result.generation], ['held', 'shrink', g1])
    assert.deepEqual(r2.result.roots, { published: [], held: [c1.src.id, c2.src.id], failed: [] })
    assert.equal(gen(), g1)
    assert.equal(stageCount(r2.run.runId) > 0, true)
    // С force отложенное публикуется как есть, но сбойный корень остаётся сбойным.
    const forced = seed.sync({ kind: 'manual', force: true, roots: [{ src: a.src, tree: { name: 'HA', children: folders('А', 5) }, ids: a.snap.ids }, { src: c1.src, tree: { name: 'HC1', children: folders('В', 5) }, ids: c1.snap.ids }],
      stats: { roots: [{ id: a.src.id, status: 'ok' }, { id: c1.src.id, status: 'ok' }, { id: b.src.id, status: 'failed', reason: 'http' }] } })
    assert.deepEqual([forced.result.status, forced.result.reason], ['partial', 'root_failed'])
    assert.equal(run(r2.run.runId)[1], 'superseded', 'публикация вытесняет прежний отложенный прогон')
    assert.deepEqual(forced.result.roots.published.sort(), [a.src.id, c1.src.id].sort(), 'force пропускает порог (А: 30 → 6, В: 30 → 6), но сбойный корень остаётся сбойным')
    assert.equal(stageCount(r2.run.runId), 0)
    st = db.asJson(admin, 'select osp_private.signal_admin_state()')
    assert.equal(st.lastHeld.id, forced.run.runId)
    assert.equal(st.lastHeld.acceptable, false, 'отложенных корней в нём нет')
    // Прогон partial можно принять, только пока на нём не опубликовано ничего нового.
    const c = mk({ name: 'HC', children: folders('В', 29) }, { code: 'РТД' })
    const rr = seed.sync({ kind: 'manual', roots: [{ src: c.src, tree: { name: 'HC', children: folders('В', 3) }, ids: c.snap.ids }, { src: a.src, tree: { name: 'HA', children: folders('А', 5) }, ids: a.snap.ids }] })
    assert.equal(rr.result.status, 'partial')
    assert.equal(seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'HA', children: folders('А', 5) }, ids: a.snap.ids }], stats: { roots: [{ id: a.src.id, status: 'ok' }] } }).result.status, 'ok')
    assert.equal(db.sqlError(accept(rr.run.runId, gen())).message, 'stale_state', 'после более новой публикации принять нельзя')
  })

  it('Проблемная подпапка: элементы не прочитаны (problem, itemsListed = false) — файлы переносятся, не пропадают и не дают «сокращения»; problem виден в дереве и состоянии; следующий успех снимает', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ name: `дог${i}.pdf` }))
    const a = mk({ name: 'PA', children: [{ name: 'Большая', items }, { name: 'Малая', items: [{ name: 'м.pdf' }] }] }, { code: 'РТЕ' })
    const admin = seed.admin()
    const g0 = gen()
    // Полный прогон: из «Большой» прочитать ничего не удалось (403), «Малая» — как раньше.
    const tree = { name: 'PA', children: [{ name: 'Большая', problem: 'forbidden' }, { name: 'Малая', items: [{ name: 'м.pdf' }] }] }
    const r = seed.sync({ kind: 'manual', mode: 'full', roots: [{ src: a.src, tree, ids: a.snap.ids }],
      stats: { roots: [{ id: a.src.id, status: 'ok', problems: [{ nodeId: a.snap.ids['PA / Большая'], code: 'forbidden' }] }] } })
    assert.equal(r.result.status, 'ok', 'файлы большой папки не считаются потерянными: порог не срабатывает')
    assert.equal(r.result.generation, g0 + 1)
    assert.deepEqual(node(a.src, 'PA / Большая'), [String(g0 + 1), '0', 'forbidden'])
    assert.deepEqual(node(a.src, 'PA / Большая / дог7.pdf'), [String(g0 + 1), '0', '-'], 'файл перенесён, не пропал')
    assert.equal(q(`select items_count from osp_private.signal_sources where id = ${a.src.id}`), '26')
    assert.deepEqual(j(`select stats -> 'roots' from osp_private.signal_runs where id = ${r.run.runId}`)[0].problems, [{ nodeId: a.snap.ids['PA / Большая'], code: 'forbidden' }])
    // Ночной прогон: пропавшие ночей не копят — файлы под проблемной папкой «не пропали».
    const rn = seed.sync({ kind: 'night', roots: [{ src: a.src, tree, ids: a.snap.ids }] })
    assert.equal(rn.result.status, 'ok')
    assert.deepEqual(node(a.src, 'PA / Большая / дог7.pdf'), [String(g0 + 2), '0', '-'])
    // Для сравнения: та же папка без пометки — 25 файлов пропали (порог по элементам → отложен).
    const bad = seed.sync({ kind: 'manual', mode: 'full', roots: [{ src: a.src, tree: { name: 'PA', children: [{ name: 'Большая' }, { name: 'Малая', items: [{ name: 'м.pdf' }] }] }, ids: a.snap.ids }] })
    assert.deepEqual([bad.result.status, bad.result.reason], ['held', 'shrink'])
    // Администратор видит папку с проблемой в дереве и число таких папок у корня.
    const st = db.asJson(admin, 'select osp_private.signal_admin_state()')
    assert.equal(st.sources.find((s) => s.id === a.src.id).problems, 1)
    assert.equal(db.asJson(admin, `select osp_private.signal_tree(${a.src.id})`).items.find((i) => i.name === 'Большая').problem, 'forbidden')
    assert.equal(db.sqlError(`select osp_private.signal_stage_put(${bad.run.runId}, '${bad.run.ownerToken}', '[]'::jsonb)`).message, 'busy')
    // Следующий прогон читает папку — problem снят.
    const ok = seed.sync({ kind: 'manual', mode: 'full', roots: [{ src: a.src, tree: { name: 'PA', children: [{ name: 'Большая', items }, { name: 'Малая', items: [{ name: 'м.pdf' }] }] }, ids: a.snap.ids }] })
    assert.equal(ok.result.status, 'ok')
    assert.equal(node(a.src, 'PA / Большая')[2], '-')
    // Неверный код проблемы — невалидная порция.
    const run2 = JSON.parse(q("select osp_private.signal_sync_begin('manual', 'full', 'cli', null)"))
    const staged = seed.stageRows(a.src.id, { name: 'PA', children: [{ name: 'Большая', problem: 'Плохо!' }] }, { ids: a.snap.ids })
    assert.equal(db.sqlError(`select osp_private.signal_stage_put(${run2.runId}, '${run2.ownerToken}', '${JSON.stringify(staged.rows).replace(/'/g, "''")}'::jsonb)`).message, 'invalid')
    q(`select osp_private.signal_sync_fail(${run2.runId}, '${run2.ownerToken}', 'cancelled', 'readonly', '{}'::jsonb)`)
  })

  it('С-38: публикация без изменений никого не ставит в очередь; новая, изменённая, пропавшая, вернувшаяся папка, смена объекта и готовность корня — ставят; поколение растёт всегда', () => {
    const a = mk({ name: 'QA', children: [{ name: 'Q1', items: [{ name: 'q1.pdf' }] }, { name: 'Q2' }] }, { code: 'РТЖ' })
    const admin = seed.admin()
    for (let i = 0; i < 5; i += 1) seed.contract({ number: `Старый-9${i}`, objectId: a.o })
    const total = Number(q('select count(*) from public.contracts where deleted_at is null'))
    const Q = { q1: a.snap.ids['QA / Q1'], q2: a.snap.ids['QA / Q2'], file: a.snap.ids['QA / Q1 / q1.pdf'], q3: uuid('q3', 1) }
    const tree = (over = {}) => ({ name: 'QA', children: [{ id: Q.q1, name: 'Q1', items: [{ id: Q.file, name: 'q1.pdf', ...(over.file || {}) }] },
      ...(over.noQ2 ? [] : [{ id: Q.q2, name: over.q2 || 'Q2' }]), ...(over.extra ? [{ id: Q.q3, name: 'Q3' }] : [])] })
    const publish = (t, kind = 'manual') => seed.sync({ kind, roots: [{ src: a.src, tree: t }], stats: { roots: [{ id: a.src.id, status: 'ok' }] } })
    drain()
    const g = gen()
    // Повтор того же снимка: узлы те же, поколение +1, очередь пуста.
    assert.equal(publish(tree()).result.generation, g + 1)
    assert.equal(queued(), 0, 'ничего не менялось — никого в очередь')
    assert.equal(publish(tree(), 'night').result.generation, g + 2)
    assert.equal(queued(), 0, 'и ночной прогон без пропаж')
    // Новая папка.
    publish(tree({ extra: true }))
    assert.equal(queued(), total, 'новая папка — все договоры')
    drain()
    publish(tree({ extra: true }))
    assert.equal(queued(), 0)
    // Переименование (изменились имя и путь) и путь потомков.
    publish(tree({ extra: true, q2: 'Q2 новое' }))
    assert.equal(queued(), total, 'имя папки изменилось')
    drain()
    // Пропажа папки (виденная в прошлом поколении, теперь нет).
    publish(tree({ extra: true, q2: 'Q2 новое', noQ2: true }))
    assert.equal(queued(), total, 'папка пропала')
    drain()
    publish(tree({ extra: true, noQ2: true }), 'manual')
    // Возвращение: папка, которой не было, снова пришла.
    drain()
    publish(tree({ extra: true }))
    assert.equal(queued(), total, 'вернулась')
    drain()
    // Новая версия файла.
    publish(tree({ extra: true, file: { version: 2 } }))
    assert.equal(queued(), total, 'версия файла изменилась')
    drain()
    // Корень стал готов (включили заново, узлы те же).
    db.asJson(admin, `select osp_private.signal_source_update(${a.src.id}, false, null)`)
    db.asJson(admin, `select osp_private.signal_source_update(${a.src.id}, true, null)`)
    drain()
    publish(tree({ extra: true, file: { version: 2 } }))
    assert.equal(q(`select ready from osp_private.signal_sources where id = ${a.src.id}`), 't')
    assert.equal(queued(), total, 'корень стал готов — видимость узлов изменилась')
    drain()
    // Смена объекта у узла (привязка) ставит и сама, и публикация потом ничего не добавляет.
    publish(tree({ extra: true, file: { version: 2 } }))
    assert.equal(queued(), 0)
    // Известный режим (known): то, что не перечисляли, не «пропало».
    const known = seed.sync({ kind: 'day', mode: 'known', roots: [{ src: a.src, tree: { name: 'QA', children: [{ id: Q.q1, name: 'Q1', itemsListed: false }, { id: Q.q2, name: 'Q2' }, { id: Q.q3, name: 'Q3' }] } }] })
    assert.equal(known.result.status, 'ok')
    assert.equal(queued(), 0, 'known без изменений: перенесённые файлы не «изменения»')
    assert.equal(node(a.src, 'QA / Q1 / q1.pdf')[0], String(gen()), 'файл неперечисленной папки перенесён')
  })

  it('С-38 / К-4: первая и вторая ночь без папки ставят договоры в очередь (состояние по ссылке меняется), третья и дневные — нет; sources_for_sync отдаёт коды объектов', () => {
    const a = mk({ name: 'NA', children: [{ name: 'N1' }, { name: 'N2' }] }, { code: 'РТМ' })
    const total = Number(q('select count(*) from public.contracts where deleted_at is null'))
    assert.ok(total >= 1 || seed.contract({ number: 'Старый-300', objectId: a.o }))
    const want = Number(q('select count(*) from public.contracts where deleted_at is null'))
    const ids = { n1: a.snap.ids['NA / N1'], n2: a.snap.ids['NA / N2'] }
    const without = { name: 'NA', children: [{ id: ids.n1, name: 'N1' }] }
    const withBoth = { name: 'NA', children: [{ id: ids.n1, name: 'N1' }, { id: ids.n2, name: 'N2' }] }
    const absent = () => Number(q(`select absent_nights from osp_private.signal_nodes where node_id = '${ids.n2}'`))
    const night = (t) => seed.sync({ kind: 'night', roots: [{ src: a.src, tree: t }], stats: { roots: [{ id: a.src.id, status: 'ok' }] } })
    drain()
    night(without)
    assert.deepEqual([absent(), queued()], [1, want], 'папка пропала в поколении этой ночи: очередь по самому факту пропажи')
    drain()
    night(without)
    assert.deepEqual([absent(), queued()], [2, want], 'вторая ночь подряд: absent_nights вырос до 2 — порог Ф2, договоры пересчитываются')
    drain()
    night(without)
    assert.deepEqual([absent(), queued()], [3, 0], 'третья и дальше: состояние не меняется — очередь не нагружаем')
    seed.sync({ kind: 'day', mode: 'full', roots: [{ src: a.src, tree: without }], stats: { roots: [{ id: a.src.id, status: 'ok' }] } })
    assert.deepEqual([absent(), queued()], [3, 0], 'дневной обход счёт не двигает')
    night(withBoth)
    assert.equal(absent(), 0)
    assert.equal(queued(), want, 'возврат папки — изменение')
    // sources_for_sync: коды объектов (непустые, по возрастанию, без повторов) — для разбора номера сопоставителем.
    seed.object({ name: 'Тест: без кода' })
    seed.object({ name: 'Тест: пустой код', code: null })
    q(`update public.objects set contract_code = null where name = 'Тест: пустой код'`)
    const codes = j('select osp_private.signal_sources_for_sync()').codes
    const dbCodes = JSON.parse(q(`select coalesce(jsonb_agg(c order by c), '[]') from (select distinct contract_code c from public.objects where btrim(coalesce(contract_code, '')) <> '') x`))
    assert.deepEqual(codes, dbCodes, 'непустые, без повторов, по возрастанию')
    assert.ok(codes.includes('РТМ') && codes.every((c) => typeof c === 'string' && c.trim() !== ''))
    // linkedItems: файлы корня, на которые ссылается состояние договора, — с папкой (для адресного чтения удалённых, В-10).
    const withFile = mk({ name: 'LA', children: [{ name: 'Папка', items: [{ name: 'договор.pdf' }, { name: 'удалён.pdf', deleted: true }, { name: 'без ссылки.pdf' }] }] }, { code: 'РТН' })
    const fileNode = withFile.snap.ids['LA / Папка / договор.pdf']
    const cl = seed.contract({ number: 'Старый-301', objectId: withFile.o })
    q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id) values ('${cl}', 'verified', 'existing_url', '${fileNode}'),
      ('${seed.contract({ number: 'Старый-302', objectId: withFile.o })}', 'verified', 'existing_url', '${withFile.snap.ids['LA / Папка / удалён.pdf']}'),
      ('${seed.contract({ number: 'Старый-303', objectId: withFile.o })}', 'verified', 'existing_url', '${withFile.snap.ids['LA / Папка']}')`)
    for (const mode of ['full', 'known']) {
      const src = j(`select osp_private.signal_sources_for_sync('${mode}')`).sources.find((x) => x.id === withFile.src.id)
      assert.deepEqual(src.linkedItems, [{ nodeId: fileNode, folderId: withFile.snap.ids['LA / Папка'] }], `${mode}: только неудалённые файлы со ссылкой`)
    }
    assert.deepEqual(j('select osp_private.signal_sources_for_sync()').sources.find((x) => x.id === a.src.id).linkedItems, [])
    assert.equal(j("select osp_private.signal_sources_for_sync('known')").mode, 'known')
    assert.ok(Array.isArray(j("select osp_private.signal_sources_for_sync('known')").codes))
  })

  it('С-5: корень не должен лежать внутри другого корня и над ним — SG409 busy; соседний и новый корень добавляются', () => {
    const admin = seed.admin()
    const o = seed.object({ code: 'РТЗ' })
    const project = '00000000-0000-4000-8000-0000000000a1'
    const add = (folder, path, p = project) => db.asError(admin, `select osp_private.signal_source_add('${p}', '${folder}', 'Проект', '${path}', array['${o}']::uuid[])`)
    const src = seed.source({ projectId: project, objectIds: [o], rootPath: 'Проект / Договоры' })
    const snap = seed.snapshot(src.id, { name: 'Договоры', children: [{ name: 'Подпапка', children: [{ name: 'Глубже' }] }] }, { generation: gen() })
    // Папка — узел снимка другого корня (в том числе предок других узлов).
    assert.equal(add(snap.ids['Договоры / Подпапка'], 'Проект / Договоры / Подпапка')?.message, 'busy')
    assert.equal(add(snap.ids['Договоры / Подпапка / Глубже'], 'Проект / Договоры / Подпапка / Глубже')?.message, 'busy')
    assert.equal(add(snap.rootId, 'Проект / Договоры')?.message, 'busy', 'тот же корень')
    // Корень над существующим и под ним — по пути корня того же проекта (снимка у нового пока нет).
    assert.equal(add('00000000-0000-4000-8000-0000000000b1', 'Проект')?.message, 'busy', 'над существующим корнем')
    assert.equal(add('00000000-0000-4000-8000-0000000000b2', 'Проект / Договоры / Ещё одна')?.message, 'busy', 'под существующим корнем')
    // Соседний корень и корень другого проекта с тем же путём — можно.
    assert.equal(add('00000000-0000-4000-8000-0000000000b3', 'Проект / Соглашения'), null)
    assert.equal(add('00000000-0000-4000-8000-0000000000b4', 'Проект / Договоры', '00000000-0000-4000-8000-0000000000a2'), null)
    assert.equal(q('select count(*) from osp_private.signal_sources where project_id in (\'00000000-0000-4000-8000-0000000000a1\', \'00000000-0000-4000-8000-0000000000a2\')'), '3')
  })

  it('В-7: состояние администратора — идущий прогон с пульсом и признаком «не отвечает»; dataAt значка без видимого узла — дата публикации', () => {
    const admin = seed.admin()
    const o = seed.object({ code: 'РТИ' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const c = seed.contract({ number: 'Старый-99', objectId: o })
    q('delete from osp_private.signal_runs')
    assert.equal(db.asJson(admin, 'select osp_private.signal_admin_state()').running, null)
    const run1 = JSON.parse(q("select osp_private.signal_sync_begin('manual', 'full', 'admin', null)"))
    let running = db.asJson(admin, 'select osp_private.signal_admin_state()').running
    assert.deepEqual([running.runId, running.kind, running.mode, running.stuck], [run1.runId, 'manual', 'full', false])
    assert.ok(running.heartbeatAt && running.startedAt)
    q(`update osp_private.signal_runs set heartbeat_at = now() - interval '11 minutes' where id = ${run1.runId}`)
    running = db.asJson(admin, 'select osp_private.signal_admin_state()').running
    assert.equal(running.stuck, true, 'пульс старше 10 минут — «прогон не отвечает»')
    assert.equal(db.asJson(admin, 'select osp_private.signal_admin_state()').lastRuns[0].heartbeatAt !== undefined, true)
    q(`select osp_private.signal_sync_fail(${run1.runId}, '${run1.ownerToken}', 'cancelled', 'readonly', '{}'::jsonb)`)
    // Договор без узла: dataAt — дата последней публикации (signal_meta.published_at).
    q(`update osp_private.signal_meta set published_at = '2026-11-20T10:00:00Z'`)
    q(`update osp_private.signal_queue set dirty_revision = dirty_revision where contract_id = '${c}'`)
    const m = db.asJson(ed, 'select osp_private.signal_marks(null, 100)')
    assert.equal(new Date(m.dataAt).toISOString(), '2026-11-20T10:00:00.000Z')
    assert.equal(new Date(m.items.find((i) => i.id === c).dataAt).toISOString(), '2026-11-20T10:00:00.000Z')
    assert.equal(new Date(db.asJson(ed, `select osp_private.signal_contract_view('${c}')`).dataAt).toISOString(), '2026-11-20T10:00:00.000Z')
  })
})
