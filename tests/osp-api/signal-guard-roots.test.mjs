// Тесты-сторожа выключенного и неготового корня SIGNAL (пакет ПР-9, находка К-5). Выключение корня — аварийный выключатель
// администратора: пока корень выключен или не готов, ни одна выдача портала не несёт его имён, путей, файлов, предложений и поиска.
//
// Важно «окно»: сразу после выключения, ДО такта очереди пересчёта, договоры ещё хранят старое состояние («сверено», открытое
// предложение) — выдачи обязаны скрыть корень сами. Отдельно проверяется и состояние ПОСЛЕ такта очереди.
//
//   значки реестра (signal_marks): путь связанной папки, число предложений, путь предложенной папки       (мутанты SM33, SM04)
//   окно сверки договора (signal_contract_view / маршрут карточки): узел, файлы, предложения             (мутант SM34, SM32)
//   поиск «Другая папка…» (signal_folders_search / /api/signal/folders)                                  (мутант SM35)
//   подтверждение папки выключенного корня отклоняется и маршрутом, и базой
//   корень включён заново, но ещё не готов (ready = false до публикации) — тоже скрыт; готов и включён — всё возвращается
// Сторожа утверждают инварианты (нет данных, нет чужих имён, состояние не «сверено»), а не точные причины состояний.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startSignalApp } from './lib/signal-app.mjs'
import { startFakeSignal } from './lib/fake-signal.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const key = () => crypto.randomUUID()
const NOT_VERIFIED = (state) => !['verified', 'accepted'].includes(state)
const parse = (text) => { try { return JSON.parse(text) } catch { return text } }
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'signalLink').map(([k, x]) => [k, strip(x)])) : v)

describe('Сторожа выключенного и неготового корня SIGNAL (К-5)', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let h
  let fake
  let U
  let C
  let F
  let MA // имена и id узлов объекта А, идентификатор проекта А
  let A_CONTRACTS

  const q = (text) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${text}) t`)
  const stateRow = (id) => q(`select state, reason, node_id, state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)[0] || null
  const call = async (uid, method, url, body) => { const r = await h.call(uid, method, url, body); return { status: r.statusCode, body: parse(r.body), raw: r.body } }
  const get = (uid, url) => call(uid, 'GET', url)
  const marksSql = (uid) => Object.fromEntries(db.asJson(uid, 'select osp_private.signal_marks(null, 1000)').items.map((m) => [m.id, m]))
  const viewSql = (uid, id) => db.asJson(uid, `select osp_private.signal_contract_view(${lit(id)})`)
  const foldersSql = (uid, id, text = '') => db.asJson(uid, `select osp_private.signal_folders_search(${lit(id)}, ${lit(text)}, null, 100)`)
  const leaks = (body) => { const text = JSON.stringify(strip(body)); return MA.filter((m) => text.includes(m)) }
  const assertClean = (body, label) => assert.deepEqual(leaks(body), [], `${label}: в ответе имена, пути или идентификаторы скрытого корня`)
  const rootRow = () => q(`select enabled, ready from osp_private.signal_sources where id = ${s.srcA.id}`)[0]
  const setRoot = (enabled, ready) => db.sql(`update osp_private.signal_sources set enabled = ${enabled}, ready = ${ready} where id = ${s.srcA.id}`)
  // Корень готов и включён, все договоры пересчитаны (как после публикации: она ставит в очередь всех).
  const restore = async () => { setRoot(true, true); for (const id of Object.values(C)) db.seed.enqueue(id); await h.tick() }

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    C = s.contracts
    F = s.folders
    fake = await startFakeSignal()
    h = await startSignalApp(db, { fake })
    await h.tick()
    const rows = q(`select node_id, name from osp_private.signal_nodes where object_id = ${lit(s.A)}`)
    MA = [...new Set([...rows.map((r) => r.name), ...rows.map((r) => r.node_id), s.projectA])]
    A_CONTRACTS = [C.c1, C.c2, C.c3, C.c4, C.ds1]
    assertVisible('исходно')
  })
  after(async () => { await h?.close(); await fake?.close(); await db?.stop() })

  // Корень включён и готов: данные есть (контроль, чтобы проверки «скрыто» не были пустыми).
  function assertVisible(label) {
    assert.deepEqual(rootRow(), { enabled: true, ready: true }, `${label}: корень включён и готов`)
    assert.equal(stateRow(C.c2).state, 'verified', `${label}: c2 сверен`)
    const v2 = viewSql(U.editor, C.c2)
    assert.equal(v2.node?.nodeId, F.f2, `${label}: окно c2 показывает папку`)
    assert.ok(v2.files.length > 0, `${label}: и её содержимое`)
    assert.notEqual(marksSql(U.editor)[C.c2].path, undefined, `${label}: значок c2 несёт путь`)
    const m1 = marksSql(U.editor)[C.c1]
    assert.ok(m1.candidates > 0 && m1.candidatePath !== undefined, `${label}: значок c1 считает предложения`)
    assert.ok(viewSql(U.editor, C.c1).candidates.length > 0, `${label}: окно c1 показывает предложение`)
    assert.ok(foldersSql(U.editor, C.c1).items.length > 0, `${label}: поиск папок не пуст`)
  }

  // Корень А скрыт: ни одна выдача его не несёт. Корень объекта Б продолжает работать.
  async function assertHidden(label) {
    // SQL: значки реестра
    const marks = marksSql(U.editor)
    for (const id of A_CONTRACTS) {
      assert.equal(marks[id].path, undefined, `${label}: значок ${id} без пути папки`)
      assert.equal(marks[id].candidates, 0, `${label}: значок ${id} не считает предложения скрытого корня`)
      assert.equal(marks[id].candidatePath, undefined, `${label}: значок ${id} без пути предложенной папки`)
    }
    // маршруты: реестр, карточка
    const reg = await get(U.editor, '/api/signal/marks?limit=1000')
    assert.equal(reg.status, 200)
    assertClean(reg.body, `${label}: реестр`)
    for (const item of reg.body.items.filter((m) => A_CONTRACTS.includes(m.id))) assert.equal(item.hasCandidate, false, `${label}: реестр — предложений нет`)
    for (const id of [C.c1, C.c2, C.ds1]) {
      const v = viewSql(U.editor, id)
      assert.equal(v.node, null, `${label}: окно ${id} без узла`)
      assert.deepEqual(v.files, [], `${label}: окно ${id} без файлов`)
      assert.deepEqual(v.candidates, [], `${label}: окно ${id} без предложений`)
      const r = await get(U.editor, `/api/signal/contracts/${id}`)
      assert.equal(r.status, 200)
      assert.equal(r.body.node, null)
      assert.deepEqual(r.body.files, [])
      assert.deepEqual(r.body.candidates, [])
      assertClean(r.body, `${label}: карточка ${id}`)
    }
    // поиск «Другая папка…»
    for (const text of ['', 'АЛФ', 'Ромашка', 'Документы']) {
      assert.deepEqual(foldersSql(U.editor, C.c1, text).items, [], `${label}: поиск «${text}» пуст`)
      const r = await get(U.editor, `/api/signal/folders?contractId=${C.c1}&q=${encodeURIComponent(text)}`)
      assert.deepEqual([r.status, r.body.items], [200, []], `${label}: маршрут поиска «${text}»`)
    }
    // подтверждение папки скрытого корня: маршрут и база отказывают, ссылка и «История» не меняются
    const before = stateRow(C.c1)
    const events = Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`))
    const conf = await call(U.editor, 'POST', `/api/signal/contracts/${C.c1}/confirm`, {
      nodeId: F.f1, replace: false, expectedSignalLink: null, expectedStateVersion: before.state_version, idempotencyKey: key(),
    })
    assert.ok(conf.status >= 400 && conf.status < 500, `${label}: подтверждение отклонено: ${conf.status} ${conf.raw}`)
    assertClean(conf.body, `${label}: ответ подтверждения`)
    const sqlErr = db.asError(U.editor, `select osp_private.signal_confirm(${lit(C.c1)}, ${lit(F.f1)}, ${lit(s.urlOf(F.f1))}, false, null, null, 'fp', null, ${before.state_version}, ${lit(key())})`)
    assert.ok(sqlErr && sqlErr.code?.startsWith('SG4'), `${label}: база отклоняет подтверждение: ${JSON.stringify(sqlErr)}`)
    assert.equal(one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(C.c1)}`), '', `${label}: ссылка не записана`)
    assert.equal(Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`)), events, `${label}: события «Истории» нет`)
    // корень объекта Б работает: предложение для договора Б видно
    const mb = marksSql(U.editor)[C.cb]
    assert.ok(mb.candidates > 0 && mb.candidatePath !== undefined, `${label}: корень объекта Б не затронут`)
    assert.ok(foldersSql(U.editor, C.cb).items.length > 0, `${label}: поиск папок объекта Б работает`)
  }

  // Состояние ПОСЛЕ такта очереди: «сверено» нет, узла нет, предложений нет.
  function assertRecomputed(label) {
    for (const id of A_CONTRACTS) {
      const st = stateRow(id)
      assert.ok(st, `${label}: у ${id} есть состояние`)
      assert.ok(NOT_VERIFIED(st.state), `${label}: ${id} не «сверен» (${st.state}:${st.reason})`)
      assert.notEqual(st.state, 'suggested', `${label}: ${id} без предложения скрытого корня`)
      assert.equal(st.node_id, null, `${label}: у ${id} узел скрытого корня не хранится`)
    }
    assert.equal(stateRow(C.cb).state, 'suggested', `${label}: договор объекта Б по-прежнему с предложением`)
  }

  it('администратор выключает корень: сразу (до такта очереди) и после пересчёта выдачи его не несут; включён, но не готов — тоже скрыт', async () => {
    // выключение штатным маршрутом администратора
    const off = await call(U.admin, 'PATCH', `/api/signal/sources/${s.srcA.id}`, { enabled: false })
    assert.equal(off.status, 200, off.raw)
    assert.equal(rootRow().enabled, false)
    await assertHidden('выключен, очередь не считала')
    await h.tick()
    assertRecomputed('выключен, после такта очереди')
    await assertHidden('выключен, после такта очереди')

    // включён обратно: корень «не готов» до следующей публикации
    const on = await call(U.admin, 'PATCH', `/api/signal/sources/${s.srcA.id}`, { enabled: true })
    assert.equal(on.status, 200, on.raw)
    assert.deepEqual(rootRow(), { enabled: true, ready: false }, 'включён, но не готов')
    await assertHidden('включён, не готов, очередь не считала')
    await h.tick()
    assertRecomputed('включён, не готов, после такта очереди')
    await assertHidden('включён, не готов, после такта очереди')
  })

  it('каждое из условий — «включён» и «готов» — скрывает корень само по себе, до пересчёта очереди', async () => {
    try {
      await restore()
      assertVisible('перед комбинациями')
      for (const [enabled, ready] of [[false, true], [true, false], [false, false]]) {
        setRoot(enabled, ready)
        await assertHidden(`enabled=${enabled}, ready=${ready}`)
        setRoot(true, true)
        assertVisible(`enabled=${enabled}, ready=${ready} → возвращён`)
      }
    } finally { await restore() }
  })

  it('корень включён и готов — всё возвращается: сверено, путь, файлы, предложения и поиск', async () => {
    await restore()
    assertVisible('после возврата')
    assert.equal(stateRow(C.c2).node_id, F.f2)
    assert.equal(stateRow(C.c1).state, 'suggested')
    const r = await get(U.editor, `/api/signal/contracts/${C.c2}`)
    assert.equal(r.body.node?.nodeId, F.f2)
    assert.ok(r.body.files.length > 0)
  })
})
