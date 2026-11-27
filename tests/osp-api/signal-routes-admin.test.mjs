// Маршруты /api/signal/* волны исправлений (server/osp-api/src/routes/signal.js, spec §5) на настоящей базе:
//   • status: «данные на …» — наименьшая дата данных включённых готовых корней, «Данные устарели» по порогам рабочего и нерабочего
//     времени (пн–пт 08:00–20:00 по Москве), оповещения администратору (корень сбоит, прогон не отвечает, отложенный прогон ждёт
//     принятия, данные устарели), идущий прогон и принимаемый отложенный — с номером прогона и поколением (С-48, С-50);
//   • tree, bindings, bindings/preview и «Снять» (В-6, К-7): только администратор, в базе — настоящая разметка поддеревьев;
//   • aliases: сотруднику с правкой — только свои названия в его охвате, администратору — все (conflict, mine) (С-2);
//   • confirm: подтверждение текущей папки (принята без номера, мягкие предупреждения) не меняет ссылку и без «Заменить»,
//     warning в ответе, ревизия очереди из окна (С-18), узел по номерам; reject и unlink несут «вид» папки (С-53).
// Данные — синтетика (вымышленные названия, адреса signal.example.test). Нужны PostgreSQL и зависимости сервера.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { startSignalApp, nodeTree } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { startFakeSignal } from './lib/fake-signal.mjs'

const key = () => crypto.randomUUID()
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const WIDE = { max: 100000, windowMs: 60_000 }
const LIMITS = { signalSyncPerUser: WIDE, signalWritePerUser: WIDE, signalMatchPerUser: WIDE }

describe('Чистые правила свежести данных (В-7)', () => {
  let isWorkTime
  let staleStatus
  before(async () => { ({ isWorkTime, staleStatus } = await import(path.join(SERVER, 'src', 'routes', 'signal.js'))) })

  // Москва — UTC+3 без перехода: 08:00 МСК = 05:00 UTC.
  it('рабочее время — пн–пт 08:00–20:00 по Москве; границы, выходные, ночь', () => {
    const at = (iso) => isWorkTime(new Date(iso))
    assert.equal(at('2026-11-24T04:59:00Z'), false, 'вт 07:59 МСК')
    assert.equal(at('2026-11-24T05:00:00Z'), true, 'вт 08:00 МСК')
    assert.equal(at('2026-11-24T16:59:00Z'), true, 'вт 19:59 МСК')
    assert.equal(at('2026-11-24T17:00:00Z'), false, 'вт 20:00 МСК')
    assert.equal(at('2026-11-23T05:00:00Z'), true, 'пн 08:00 МСК')
    assert.equal(at('2026-11-27T16:59:00Z'), true, 'пт 19:59 МСК')
    assert.equal(at('2026-11-28T09:00:00Z'), false, 'сб 12:00 МСК')
    assert.equal(at('2026-11-29T09:00:00Z'), false, 'вс 12:00 МСК')
    // Сутки по Москве, а не по UTC: вс 23:30 UTC — уже пн 02:30 МСК (ночь), пн 21:30 UTC — вт 00:30 МСК (ночь).
    assert.equal(at('2026-11-29T23:30:00Z'), false)
    assert.equal(at('2026-11-23T21:30:00Z'), false)
  })

  it('порог: 3 часа в рабочее время, 36 — вне его (настраиваются); нет даты данных — не устарели', () => {
    const work = new Date('2026-11-24T12:30:00Z') // вт 15:30 МСК
    const off = new Date('2026-11-28T10:00:00Z') // сб 13:00 МСК
    assert.deepEqual(staleStatus('2026-11-24T05:00:00Z', work), { stale: true, staleHours: 3 })
    assert.deepEqual(staleStatus('2026-11-24T10:00:00Z', work), { stale: false, staleHours: 3 })
    assert.deepEqual(staleStatus('2026-11-24T09:30:00Z', work), { stale: false, staleHours: 3 }, 'ровно 3 часа — ещё не устарели')
    assert.deepEqual(staleStatus('2026-11-27T10:00:00Z', off), { stale: false, staleHours: 36 }, 'сутки назад в выходной')
    assert.deepEqual(staleStatus('2026-11-26T10:00:00Z', off), { stale: true, staleHours: 36 })
    assert.deepEqual(staleStatus('2026-11-24T10:00:00Z', work, { workHours: 1, offHours: 2 }), { stale: true, staleHours: 1 })
    assert.deepEqual(staleStatus(null, work), { stale: false, staleHours: 3 })
    assert.deepEqual(staleStatus('не дата', work), { stale: false, staleHours: 3 })
  })
})

describe('Подсказки значка (tip): «данные на …», путь от границы объекта, тексты новых причин без чужих имён', () => {
  let tipFor
  let shownState
  before(async () => { ({ tipFor, shownState } = await import(path.join(SERVER, 'src', 'routes', 'signal.js'))) })
  const DATA = '2026-11-24T05:30:00Z' // 08:30 МСК
  const P = 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-001 ООО Ромашка'

  it('сверено и принято: «Signal: … · данные на ДД.ММ.ГГГГ · <путь>» (дата данных по Москве)', () => {
    assert.equal(tipFor({ state: 'verified', reason: 'existing_url', path: P, dataAt: DATA }), `Signal: сверено · данные на 24.11.2026 · ${P}`)
    assert.equal(tipFor({ state: 'verified', reason: 'confirmed', path: P, dataAt: DATA }), `Signal: сверено · данные на 24.11.2026 · ${P}`)
    assert.equal(tipFor({ state: 'accepted', reason: 'number_not_found', path: P, dataAt: DATA }), `Signal: ссылка принята, номер в папке не найден · данные на 24.11.2026 · ${P}`)
    assert.equal(tipFor({ state: 'verified', reason: 'existing_url', dataAt: '2026-11-23T22:30:00Z' }), 'Signal: сверено · данные на 24.11.2026', 'сутки — по Москве (01:30 МСК), без пути')
    assert.equal(tipFor({ state: 'verified', reason: 'existing_url', path: P }), `Signal: сверено · ${P}`)
  })

  it('«ожидает» и прочие неподтверждённые: «не сверялась»; причины — без имён и путей', () => {
    assert.equal(tipFor({ state: 'unverified', reason: 'pending', pending: true, dataAt: DATA }), 'Signal: ссылка не сверялась')
    const texts = Object.fromEntries(['unsupported_url', 'unavailable', 'no_snapshot', 'not_observed', 'no_object'].map((r) => [r, tipFor({ state: 'unverified', reason: r, path: P, dataAt: DATA })]))
    assert.equal(texts.unavailable, 'Signal: папка недоступна для сверки')
    assert.equal(texts.no_object, 'Signal: у договора не указан объект')
    for (const [reason, text] of Object.entries(texts)) {
      assert.match(text, /^Signal: /, reason)
      assert.ok(!text.includes('Корпус') && !text.includes('Ромашка'), `${reason}: путь в подсказку не попадает`)
    }
  })

  it('внимание, пропажа и противоречия (в том числе новые: ДС, сторона, корпус, допсоглашение, файл)', () => {
    const t = (state, reason) => tipFor({ state, reason, path: P, dataAt: DATA })
    assert.equal(t('attention', 'not_visible'), 'Signal: папка не видна в Signal')
    assert.equal(t('attention', 'file_not_visible'), 'Signal: файл не виден в Signal')
    assert.equal(t('attention', 'building_mismatch'), 'Signal: корпус, очередь или секция не совпали — проверьте')
    assert.equal(t('attention', 'kind_mismatch'), 'Signal: папка относится к допсоглашению — проверьте')
    assert.equal(t('missing', 'deleted'), 'Signal: файл удалён в Signal')
    assert.equal(t('conflict', 'number_mismatch'), 'Signal: противоречие — номер в названии папки не совпал с номером договора')
    assert.equal(t('conflict', 'ds_mismatch'), 'Signal: противоречие — номер ДС не совпал с номером в названии папки')
    assert.equal(t('conflict', 'foreign_party'), 'Signal: противоречие — в названии папки ИНН другой организации')
    assert.equal(t('conflict', 'foreign_dp'), 'Signal: противоречие — ДС относится к другому договору')
    assert.equal(t('conflict', 'ambiguous'), 'Signal: противоречие — в названии папки несколько номеров договоров')
    assert.equal(t('none', 'none'), 'Signal: ссылки нет')
    assert.equal(t('none', 'no_object'), 'Signal: у договора не указан объект')
    assert.equal(tipFor({ state: 'suggested', reason: 'candidates', candidatePath: P }), `Signal: предложена папка ${P}`)
    assert.equal(tipFor({ state: 'suggested', reason: 'candidates' }), 'Signal: предложена папка')
    assert.deepEqual(shownState({ state: 'verified', reason: 'confirmed', pending: false, hasLink: true }), { state: 'verified', reason: 'confirmed', pending: false })
  })
})

describe('status, разметка, синонимы и решения: маршруты волны исправлений на настоящей базе', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let h
  let fake
  let U
  let F
  const clock = { at: new Date('2026-11-24T12:30:00Z') } // вт 15:30 МСК — рабочее время
  const card = async (uid, id, query = '') => {
    const res = await h.get(uid, `/api/signal/contracts/${id}${query}`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const status = async (uid = U.admin) => (await h.get(uid, '/api/signal/status')).json()
  const stateOf = (id) => one(db, `select state || ':' || coalesce(reason, '') || ':' || state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)
  const linkOf = (id) => one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`)
  const confirmBody = (c, nodeId, over = {}) => ({ nodeId, replace: false, expectedSignalLink: c.signalLink, expectedStateVersion: c.stateVersion, idempotencyKey: key(), ...over })
  const confirm = (uid, id, body) => h.post(uid, `/api/signal/contracts/${id}/confirm`, body)
  const setOk = (srcId, iso) => db.sql(`update osp_private.signal_sources set last_ok_at = ${lit(iso)} where id = ${srcId}`)

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    F = s.folders
    db.sql(`create policy signal_test_user on public.contracts for all to public
      using (current_setting('application_name', true) = 'osp-api') with check (current_setting('application_name', true) = 'osp-api')`)
    fake = await startFakeSignal()
    h = await startSignalApp(db, { fake, limits: LIMITS, signal: { now: () => clock.at } })
    await h.tick()
  })
  after(async () => {
    await h?.close()
    await fake?.close()
    await db?.stop()
  })

  describe('status: данные на …, «устарели», оповещения', () => {
    it('dataAt — наименьшая дата данных включённых готовых корней; выключенный и не готовый корень не в счёт; нет дат — дата публикации', async () => {
      const fallback = await status(U.viewer)
      assert.equal(fallback.dataAt, one(db, `select to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from osp_private.signal_meta`), 'у корней дат нет — дата публикации')
      setOk(s.srcA.id, '2026-11-24T11:00:00Z')
      setOk(s.srcB.id, '2026-11-24T09:15:00Z')
      assert.equal((await status(U.viewer)).dataAt, '2026-11-24T09:15:00.000Z', 'наименьшая из двух')
      db.sql(`update osp_private.signal_sources set enabled = false where id = ${s.srcB.id}`)
      assert.equal((await status(U.viewer)).dataAt, '2026-11-24T11:00:00.000Z', 'выключенный корень не в счёт')
      db.sql(`update osp_private.signal_sources set enabled = true, ready = false where id = ${s.srcB.id}`)
      assert.equal((await status(U.viewer)).dataAt, '2026-11-24T11:00:00.000Z', 'не готовый корень не в счёт')
      db.sql(`update osp_private.signal_sources set ready = true where id = ${s.srcB.id}`)
    })

    it('stale: рабочее время — порог 3 часа, нерабочее — 36 часов; видят все с правом просмотра; у администратора — оповещение data_stale', async () => {
      setOk(s.srcA.id, '2026-11-24T11:00:00Z')
      setOk(s.srcB.id, '2026-11-24T11:30:00Z')
      clock.at = new Date('2026-11-24T12:30:00Z') // вт 15:30 МСК: данным 1,5 часа
      let st = await status(U.viewer)
      assert.deepEqual([st.stale, st.staleHours], [false, 3])
      clock.at = new Date('2026-11-24T14:30:00Z') // 17:30 МСК: данным 3,5 часа
      for (const uid of [U.viewer, U.editor, U.admin]) {
        st = await status(uid)
        assert.deepEqual([st.stale, st.staleHours], [true, 3], 'порог рабочего времени')
      }
      const alerts = (await status()).alerts
      assert.deepEqual(alerts.map((a) => a.kind), ['data_stale'])
      assert.equal(alerts[0].since, '2026-11-24T11:00:00.000Z')
      assert.deepEqual((await status(U.editor)).alerts, undefined, 'оповещения — только администратору')
      // Те же данные ночью и в выходной: порог 36 часов.
      clock.at = new Date('2026-11-25T01:00:00Z') // ср 04:00 МСК, данным ~14 часов
      st = await status(U.viewer)
      assert.deepEqual([st.stale, st.staleHours], [false, 36])
      clock.at = new Date('2026-11-28T10:00:00Z') // сб, данным ~4 суток
      st = await status(U.viewer)
      assert.deepEqual([st.stale, st.staleHours], [true, 36])
      assert.deepEqual((await status()).alerts.map((a) => a.kind), ['data_stale'])
      clock.at = new Date('2026-11-24T12:30:00Z')
      setOk(s.srcA.id, '2026-11-24T12:00:00Z')
      setOk(s.srcB.id, '2026-11-24T12:00:00Z')
      assert.deepEqual((await status()).alerts, [])
    })

    it('корень сбоит: status корня, failedSince, lastError и оповещение root_failed; администратору — число проблемных папок', async () => {
      db.sql(`update osp_private.signal_sources set failed_since = '2026-11-24T08:00:00Z', last_error = 'forbidden' where id = ${s.srcB.id}`)
      try {
        const st = await status()
        const b = st.sources.find((x) => x.id === s.srcB.id)
        assert.deepEqual([b.status, b.failedSince, b.lastError], ['failed', '2026-11-24T08:00:00.000Z', 'forbidden'])
        assert.deepEqual(st.alerts, [{ kind: 'root_failed', sourceId: s.srcB.id, since: '2026-11-24T08:00:00.000Z' }])
        assert.equal(st.sources.find((x) => x.id === s.srcA.id).status, 'ok')
        assert.ok(!JSON.stringify(await status(U.viewer)).includes('forbidden'), 'просмотру причина сбоя не видна')
      } finally {
        db.sql(`update osp_private.signal_sources set failed_since = null, last_error = null where id = ${s.srcB.id}`)
      }
      db.sql(`update osp_private.signal_nodes set problem = 'forbidden' where node_id = ${lit(F.k2)}`)
      try {
        assert.equal((await status()).sources.find((x) => x.id === s.srcA.id).problems, 1)
      } finally {
        db.sql(`update osp_private.signal_nodes set problem = null where node_id = ${lit(F.k2)}`)
      }
    })

    it('идущий прогон: runId, startedAt, heartbeatAt; пульс старше 10 минут — stuck и оповещение run_stuck (С-48)', async () => {
      const run = db.sqlJson(`select osp_private.signal_sync_begin('manual', 'full', 'cli', null)`)
      try {
        let st = await status()
        assert.deepEqual(Object.keys(st.running).sort(), ['heartbeatAt', 'runId', 'startedAt', 'stuck'])
        assert.deepEqual([st.running.runId, st.running.stuck], [run.runId, false])
        assert.deepEqual(st.alerts, [])
        db.sql(`update osp_private.signal_runs set heartbeat_at = now() - interval '11 minutes' where id = ${run.runId}`)
        st = await status()
        assert.equal(st.running.stuck, true)
        assert.deepEqual(st.alerts.map((a) => [a.kind, a.runId]), [['run_stuck', run.runId]])
        assert.equal(st.alerts[0].since, st.running.heartbeatAt)
        assert.equal((await status(U.viewer)).running, undefined)
      } finally {
        db.sql(`select osp_private.signal_sync_fail(${run.runId}, ${lit(run.ownerToken)}, 'cancelled', 'stopped', '{}'::jsonb)`)
      }
      assert.equal((await status()).running, null)
    })
  })

  describe('Отложенный прогон: held с номером прогона и поколением для accept-held (С-50), оповещение run_held', () => {
    let dbH
    let hh
    before(async () => {
      dbH = await startSignalDb()
      hh = await startSignalApp(dbH, { limits: LIMITS })
    })
    after(async () => {
      await hh?.close()
      await dbH?.stop()
    })

    it('частичный прогон с отложенным корнем: held = {runId, generation}; после принятия — null', async () => {
      const { seed } = dbH
      const folders = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }))
      const mk = (tree, code) => {
        const o = seed.object({ code })
        const src = seed.source({ objectIds: [o] })
        const snap = seed.snapshot(src.id, tree, { generation: Math.max(1, Number(one(dbH, 'select generation from osp_private.signal_meta'))) })
        dbH.sql(`update osp_private.signal_sources set last_ok_at = '2026-11-20T09:00:00Z' where id = ${src.id}`)
        return { src, snap }
      }
      const admin = seed.admin()
      const a = mk({ name: 'HA', children: folders('А', 29) }, 'РТВ')
      const b = mk({ name: 'HB', children: folders('Б', 29) }, 'РТГ')
      const g0 = Number(one(dbH, 'select generation from osp_private.signal_meta'))
      const r = seed.sync({
        kind: 'manual',
        roots: [{ src: a.src, tree: { name: 'HA', children: [...folders('А', 29), { name: 'А-новая' }] }, ids: a.snap.ids }, { src: b.src, tree: { name: 'HB', children: folders('Б', 5) }, ids: b.snap.ids }],
      })
      assert.deepEqual([r.result.status, r.result.reason], ['partial', 'shrink'])
      const st = (await hh.get(admin, '/api/signal/status')).json()
      assert.deepEqual(st.held, { runId: r.run.runId, generation: g0 + 1 })
      assert.deepEqual(st.sources.filter((x) => [a.src.id, b.src.id].includes(x.id)).map((x) => x.status), ['ok', 'held'])
      assert.deepEqual(st.alerts.filter((x) => x.kind === 'run_held').map((x) => [x.runId, typeof x.since]), [[r.run.runId, 'string']])
      assert.equal(st.lastRuns[0].status, 'partial', 'в журнале — partial с причиной')
      const runs = (await hh.get(admin, '/api/signal/runs')).json().items
      assert.deepEqual([runs[0].id, runs[0].status, runs[0].reason], [r.run.runId, 'partial', 'shrink'])
      assert.ok(runs[0].stats.roots.length >= 0)
      // accept-held: поколение то же — отложенный корень публикуется, оповещения нет.
      dbH.sql(`select osp_private.signal_accept_held(${r.run.runId}, ${st.held.generation}, 'cli:admin', 'проверено')`)
      const after2 = (await hh.get(admin, '/api/signal/status')).json()
      assert.equal(after2.held, null)
      assert.deepEqual(after2.alerts.filter((x) => x.kind === 'run_held'), [])
    })
  })

  describe('разметка поддеревьев: tree, bindings, bindings/preview, «Снять»', () => {
    let X
    let src
    let ids
    let admin
    before(async () => {
      admin = U.admin
      X = db.seed.object({ name: 'Тест: ЖК Омега', code: 'ОМГ' })
      src = db.seed.source({ objectIds: [X, s.B], name: 'Тест: проект Омега', rootPath: 'Тест: проект Омега / Площадка' })
      const tree = await nodeTree({
        name: 'Площадка',
        children: [
          { name: 'Корпус Г', items: [{ name: 'Опись.pdf' }], children: [{ name: 'ДП БЕТ-ДП-26-007 ООО Тест', items: [{ name: 'Договор.pdf' }, { name: 'Приложение.pdf' }] }, { name: 'Прочее' }] },
          { name: 'Корпус Д', children: [{ name: 'ДП ОМГ-ДП-26-001 ООО Тест' }] },
        ],
      })
      ;({ ids } = db.seed.snapshot(src.id, tree, { generation: 1 }))
    })
    const tree = (query) => h.get(admin, `/api/signal/tree?sourceId=${src.id}${query}`)
    const bindings = async () => (await h.get(admin, `/api/signal/bindings?sourceId=${src.id}`)).json()
    const bind = (nodeId, objectId) => h.post(admin, '/api/signal/bindings', { sourceId: src.id, nodeId, objectId })
    const preview = (nodeId, objectId) => h.post(admin, '/api/signal/bindings/preview', { sourceId: src.id, nodeId, objectId })

    it('tree: дети корня и папки (ленивая подгрузка), поиск по корню, курсор; администратору — полные имена и пути', async () => {
      const top = await tree('')
      assert.equal(top.statusCode, 200, top.body)
      assert.equal(top.headers['cache-control'], 'private, no-store')
      const { items, next } = top.json()
      assert.equal(next, null)
      assert.deepEqual(items.map((x) => x.name), ['Корпус Г', 'Корпус Д'])
      assert.deepEqual(Object.keys(items[0]).sort(), ['bound', 'boundObjectId', 'depth', 'hasChildren', 'items', 'name', 'nodeId', 'objectId', 'objectName', 'path', 'problem'])
      assert.deepEqual([items[0].nodeId, items[0].path, items[0].hasChildren, items[0].items, items[0].bound, items[0].problem], [ids['Площадка / Корпус Г'], 'Площадка / Корпус Г', true, 1, false, null])
      assert.equal(items[1].items, 0)
      const kids = (await tree(`&parentId=${ids['Площадка / Корпус Г']}`)).json().items
      assert.deepEqual(kids.map((x) => x.name), ['ДП БЕТ-ДП-26-007 ООО Тест', 'Прочее'])
      assert.deepEqual(kids.map((x) => [x.hasChildren, x.items]), [[false, 2], [false, 0]])
      const found = (await tree(`&q=${encodeURIComponent('бет-дп')}`)).json().items
      assert.deepEqual(found.map((x) => x.path), ['Площадка / Корпус Г / ДП БЕТ-ДП-26-007 ООО Тест'])
      const page = (await tree('&limit=1')).json()
      assert.equal(page.items.length, 1)
      assert.ok(page.next)
      const second = (await tree(`&limit=1&after=${encodeURIComponent(page.next)}`)).json().items
      assert.deepEqual([page.items[0].name, second[0].name], ['Корпус Г', 'Корпус Д'])
    })

    it('tree: неверные параметры — 400, папка чужого корня и неизвестный корень — 404 без деталей', async () => {
      for (const q of ['', '&parentId=не-uuid', `&q=${'x'.repeat(101)}`, '&limit=0', '&limit=101']) {
        const res = await h.get(admin, `/api/signal/tree${q === '' ? '' : `?sourceId=${src.id}${q}`}`)
        assert.equal(res.statusCode, 400, `«${q}» ${res.body}`)
      }
      const foreign = await tree(`&parentId=${F.k1}`) // папка корня «Альфа», не этого корня
      assert.equal(foreign.statusCode, 404, foreign.body)
      assert.deepEqual(foreign.json(), { error: 'Не найдено', code: 'not_found' })
      assert.equal((await h.get(admin, '/api/signal/tree?sourceId=999999')).statusCode, 404)
    })

    it('bindings: до разметки — объекты корня и пустой список', async () => {
      const b = await bindings()
      assert.deepEqual(b.rootObjects.map((o) => o.objectName).sort(), ['Тест: ЖК Бета', 'Тест: ЖК Омега'])
      assert.deepEqual(Object.keys(b.rootObjects[0]).sort(), ['objectId', 'objectName'])
      assert.deepEqual(b.items, [])
    })

    it('preview: предупреждение «внутри номера договоров другого объекта» с числом папок и затронутые папки и файлы; ничего не меняет', async () => {
      const before = one(db, 'select count(*) from osp_private.signal_bindings')
      const res = await preview(ids['Площадка / Корпус Г'], X)
      assert.equal(res.statusCode, 200, res.body)
      const body = res.json()
      assert.deepEqual(body.warnings, [{ objectId: s.B, objectName: 'Тест: ЖК Бета', folders: 1 }], 'внутри папка с номером БЕТ-…, а привязка — к объекту ОМГ')
      assert.deepEqual(body.affected, { folders: 3, items: 3 })
      const ok = (await preview(ids['Площадка / Корпус Г'], s.B)).json()
      assert.deepEqual(ok.warnings, [], 'привязка к объекту с тем же кодом — без предупреждений')
      assert.deepEqual((await preview(ids['Площадка / Корпус Д'], X)).json().warnings, [])
      assert.equal(one(db, 'select count(*) from osp_private.signal_bindings'), before, 'preview не пишет')
      // «Снять» (objectId: null) — предупреждений нет.
      assert.deepEqual((await preview(ids['Площадка / Корпус Г'], null)).json().warnings, [])
    })

    it('preview: объект не из корня, не папка корня, неверное тело — 422 / 400', async () => {
      const other = await preview(ids['Площадка / Корпус Г'], s.A)
      assert.equal(other.statusCode, 422, other.body)
      assert.equal(other.json().code, 'invalid')
      assert.equal((await preview(F.k1, X)).statusCode, 422, 'папка другого корня')
      assert.equal((await h.post(admin, '/api/signal/bindings/preview', { sourceId: src.id, nodeId: 'x', objectId: X })).statusCode, 400)
      assert.equal((await h.post(admin, '/api/signal/bindings/preview', { sourceId: src.id })).statusCode, 400)
    })

    it('привязка поддерева → список привязок, дерево показывает привязку; «Снять» — привязка убрана, папка снова «без объекта»', async () => {
      const g = ids['Площадка / Корпус Г']
      assert.deepEqual((await h.get(admin, `/api/signal/unassigned?sourceId=${src.id}`)).json().items.map((x) => x.path), ['Площадка / Корпус Г', 'Площадка / Корпус Д'])
      assert.equal((await bind(g, X)).statusCode, 200)
      const list = (await bindings()).items
      assert.deepEqual(list.map((x) => [x.nodeId, x.path, x.objectId, x.objectName, x.observed]), [[g, 'Площадка / Корпус Г', X, 'Тест: ЖК Омега', true]])
      assert.match(list[0].createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
      const node = (await tree('')).json().items.find((x) => x.nodeId === g)
      assert.deepEqual([node.bound, node.boundObjectId, node.objectId, node.objectName], [true, X, X, 'Тест: ЖК Омега'])
      assert.deepEqual((await h.get(admin, `/api/signal/unassigned?sourceId=${src.id}`)).json().items.map((x) => x.path), ['Площадка / Корпус Д'])
      // «Снять»
      const off = await bind(g, null)
      assert.deepEqual([off.statusCode, off.json()], [200, { ok: true }])
      assert.deepEqual((await bindings()).items, [])
      const again = (await tree('')).json().items.find((x) => x.nodeId === g)
      assert.deepEqual([again.bound, again.boundObjectId, again.objectId], [false, null, null])
      assert.deepEqual((await h.get(admin, `/api/signal/unassigned?sourceId=${src.id}`)).json().items.map((x) => x.path), ['Площадка / Корпус Г', 'Площадка / Корпус Д'], 'папка снова без объекта')
    })

    it('глубокая привязка: папка любой глубины, объект — из объектов корня; чужой объект, не папка корня и не корень — 422', async () => {
      const deep = ids['Площадка / Корпус Г / ДП БЕТ-ДП-26-007 ООО Тест']
      assert.equal((await bind(deep, s.B)).statusCode, 200)
      assert.deepEqual((await bindings()).items.map((x) => x.path), ['Площадка / Корпус Г / ДП БЕТ-ДП-26-007 ООО Тест'])
      assert.equal((await bind(deep, null)).statusCode, 200)
      assert.equal((await bind(deep, s.A)).statusCode, 422, 'объект не из объектов корня')
      assert.equal((await bind(F.k1, X)).statusCode, 422, 'папка другого корня')
      assert.equal((await bind(ids['Площадка / Корпус Д / ДП ОМГ-ДП-26-001 ООО Тест'], X)).statusCode, 200)
      assert.equal((await bind(ids['Площадка / Корпус Д / ДП ОМГ-ДП-26-001 ООО Тест'], null)).statusCode, 200)
    })

    it('права: подрядчик, просмотр, правка, сотрудник без права и без входа — отказ на новых маршрутах', async () => {
      const g = ids['Площадка / Корпус Г']
      const calls = [['GET', `/api/signal/tree?sourceId=${src.id}`], ['GET', `/api/signal/bindings?sourceId=${src.id}`],
        ['POST', '/api/signal/bindings/preview', { sourceId: src.id, nodeId: g, objectId: X }], ['POST', '/api/signal/bindings', { sourceId: src.id, nodeId: g, objectId: null }]]
      for (const uid of [null, U.contractor, U.noRight, U.viewer, U.viewerB, U.editor, U.editorB]) {
        for (const [method, url, body] of calls) {
          const res = await h.call(uid, method, url, body)
          assert.ok([401, 403].includes(res.statusCode), `${uid ? 'пользователь' : 'без входа'} ${method} ${url}: ${res.statusCode}`)
          assert.ok(!/Омега|Корпус Г|ООО Тест/.test(res.body))
        }
      }
      assert.deepEqual((await bindings()).items, [])
    })
  })

  describe('синонимы: сотруднику с правкой — свои (С-2), администратору — все', () => {
    it('сотрудник видит только свои названия в своём охвате; администратор — все; mine, author, conflict', async () => {
      const mineA = (await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Список' })).json().id
      const mineB = (await h.post(U.editorB, '/api/signal/aliases', { objectId: s.B, text: 'Бета Список' })).json().id
      const other = db.seed.user({ contracts: 'edit' })
      const otherA = (await h.post(other, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Чужой' })).json().id

      const editor = (await h.get(U.editor, '/api/signal/aliases')).json().items
      assert.deepEqual(editor.map((x) => x.id), [mineA], 'редактору — только своё (названия другого сотрудника и другого объекта не видны)')
      assert.deepEqual(Object.keys(editor[0]).sort(), ['author', 'conflict', 'createdAt', 'id', 'mine', 'objectId', 'objectName', 'text'])
      assert.deepEqual([editor[0].text, editor[0].objectName, editor[0].mine, editor[0].conflict], ['Альфа Список', 'Тест: ЖК Альфа', true, false])
      const editorB = (await h.get(U.editorB, '/api/signal/aliases')).json().items
      assert.deepEqual(editorB.map((x) => x.id), [mineB], 'охват — только объект Б')
      assert.ok(!JSON.stringify(editorB).includes('Альфа'))

      const all = (await h.get(U.admin, '/api/signal/aliases')).json().items
      for (const id of [mineA, mineB, otherA]) assert.ok(all.some((x) => x.id === id), `администратор видит ${id}`)
      assert.ok(all.every((x) => x.mine === false), 'администратор не автор этих названий')
      assert.ok(all.find((x) => x.id === mineA).author, 'автор указан')
    })

    it('просмотр без правки, сотрудник без права и подрядчик — 403; конфликтное название помечено conflict и не мешает переименованию объекта', async () => {
      for (const uid of [U.viewer, U.noRight, U.contractor]) assert.equal((await h.get(uid, '/api/signal/aliases')).statusCode, 403)
      assert.equal((await h.get(null, '/api/signal/aliases')).statusCode, 401)
      const id = (await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Название Двойник' })).json().id
      // Объект Б получил то же название — переименование не отказывает (триггеры не блокируют бизнес-запись).
      db.sql(`update public.objects set name = 'Название Двойник' where id = ${lit(s.B)}`)
      try {
        const flagged = (await h.get(U.admin, '/api/signal/aliases')).json().items.find((x) => x.id === id)
        assert.equal(flagged.conflict, true)
        assert.equal((await h.get(U.editor, '/api/signal/aliases')).json().items.find((x) => x.id === id).conflict, true)
      } finally {
        db.sql(`update public.objects set name = 'Тест: ЖК Бета' where id = ${lit(s.B)}`)
      }
      assert.equal((await h.get(U.admin, '/api/signal/aliases')).json().items.find((x) => x.id === id).conflict, false)
    })
  })

  describe('confirm: текущая папка, предупреждения, ревизия очереди', () => {
    let O
    let tr
    let dpWarn
    before(async () => {
      O = db.seed.object({ name: 'Тест: ЖК Омега, корпус 14', code: 'ОМГ' })
      const src = db.seed.source({ objectIds: [O], name: 'Тест: проект Омега 2', rootPath: 'Тест: проект Омега 2 / Док' })
      const tree = await nodeTree({
        name: 'Док',
        children: [
          { name: '15к', children: [{ name: 'ДП ОМГ-ДП-26-001 ООО Ромашка' }] },
          { name: 'Прочие', children: [{ name: 'Без номера' }] },
          { name: 'ДС-1 к ДП ОМГ-ДП-26-002' },
          { name: 'ДП ОМГ-ДП-26-003 ООО Ромашка' },
        ],
      })
      tr = db.seed.snapshot(src.id, tree, { generation: 1 })
      tr.src = src
      dpWarn = null
    })
    const url = (name, base = 'Док') => s.urlOf(tr.ids[`${base} / ${name}`], tr.src.projectId)
    const mk = async (number, link, over = {}) => {
      const id = db.seed.contract({ number, objectId: O, counterparties: [s.cpR], signalLink: link, ...over })
      await h.tick()
      return id
    }

    it('мягкое предупреждение «корпус не совпал»: confirm → 200, warning = building_mismatch, решение человека сохраняется при пересчёте', async () => {
      const id = await mk('ОМГ-ДП-26-001', url('15к / ДП ОМГ-ДП-26-001 ООО Ромашка'))
      dpWarn = id
      assert.match(stateOf(id), /^attention:building_mismatch/)
      const c = await card(U.editor, id)
      const res = await confirm(U.editor, id, confirmBody(c, tr.ids['Док / 15к / ДП ОМГ-ДП-26-001 ООО Ромашка']))
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual(res.json(), { state: 'verified', reason: 'confirmed', stateVersion: c.stateVersion + 1, signalLink: c.signalLink, warning: 'building_mismatch' })
      assert.equal(linkOf(id), c.signalLink, 'ссылка договора не изменилась (та же папка — не замена)')
      db.sql('select osp_private.signal_enqueue_all()')
      await h.tick()
      assert.match(stateOf(id), /^verified:confirmed/, 'пересчёт не сбрасывает решение человека (нет жёсткого противоречия)')
    })

    it('мягкое предупреждение «папка допсоглашения»: confirm → 200, warning = kind_mismatch', async () => {
      const id = await mk('ОМГ-ДП-26-002', url('ДС-1 к ДП ОМГ-ДП-26-002'))
      assert.match(stateOf(id), /^attention:kind_mismatch/)
      const c = await card(U.editor, id)
      const res = await confirm(U.editor, id, confirmBody(c, tr.ids['Док / ДС-1 к ДП ОМГ-ДП-26-002']))
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual([res.json().state, res.json().reason, res.json().warning], ['verified', 'confirmed', 'kind_mismatch'])
    })

    it('«ссылка принята, номер не найден»: подтверждение текущей папки — без «Заменить», ссылка как есть (в том числе в другом виде); другая папка — replace_required', async () => {
      const own = tr.ids['Док / Прочие / Без номера']
      for (const [label, link] of [['как есть', url('Прочие / Без номера')], ['query и fragment', `${url('Прочие / Без номера')}?tab=x#files`],
        ['uuid в верхнем регистре', url('Прочие / Без номера').replace(own, own.toUpperCase())]]) {
        const id = await mk('ОМГ-ДП-26-004', link)
        assert.match(stateOf(id), /^accepted:number_not_found/, label)
        const tip = (await h.get(U.editor, '/api/signal/marks?limit=1000')).json().items.find((m) => m.id === id)
        assert.match(tip.tip, /^Signal: ссылка принята, номер в папке не найден · данные на \d{2}\.\d{2}\.\d{4} · Док \/ Прочие \/ Без номера$/, label)
        assert.equal(tip.state, 'accepted')
        const c = await card(U.editor, id)
        assert.equal(c.state, 'accepted')
        const res = await confirm(U.editor, id, confirmBody(c, own))
        assert.equal(res.statusCode, 200, `${label}: ${res.body}`)
        assert.deepEqual([res.json().state, res.json().reason, res.json().signalLink, res.json().warning], ['verified', 'confirmed', link, null], label)
        assert.equal(linkOf(id), link, `${label}: строка ссылки договора не изменилась`)
      }
      // Другая папка (того же объекта) — замена: без «Заменить» отказ, с «Заменить» — ссылка по шаблону SIGNAL_UI_FOLDER_URL.
      const id = await mk('ОМГ-ДП-26-003', url('Прочие / Без номера'))
      const c = await card(U.editor, id)
      const target = tr.ids['Док / ДП ОМГ-ДП-26-003 ООО Ромашка']
      const no = await confirm(U.editor, id, confirmBody(c, target))
      assert.deepEqual([no.statusCode, no.json().code], [409, 'replace_required'])
      assert.equal(linkOf(id), url('Прочие / Без номера'))
      const yes = await confirm(U.editor, id, confirmBody(c, target, { replace: true }))
      assert.equal(yes.statusCode, 200, yes.body)
      assert.equal(yes.json().signalLink, url('ДП ОМГ-ДП-26-003 ООО Ромашка'), 'ссылка собрана по шаблону')
      assert.equal(linkOf(id), url('ДП ОМГ-ДП-26-003 ООО Ромашка'))
    })

    it('клиент, не видевший текущую ссылку, получает stale_state: «как есть» не обходит проверку ожидаемой ссылки', async () => {
      const own = tr.ids['Док / Прочие / Без номера']
      const id = await mk('ОМГ-ДП-26-006', url('Прочие / Без номера'))
      const c = await card(U.editor, id)
      const stale = await confirm(U.editor, id, confirmBody(c, own, { expectedSignalLink: null }))
      assert.deepEqual([stale.statusCode, stale.json().code], [409, 'stale_state'])
      assert.match(stateOf(id), /^accepted:/)
    })

    it('ревизия очереди из окна (С-18): окно видело ревизию — строка снята; правка после открытия окна — договор остаётся в очереди; без expectedRevision — «окно строки не видело»', async () => {
      const queued = (id) => one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`)
      const own = tr.ids['Док / ДП ОМГ-ДП-26-003 ООО Ромашка']
      // Окно открыто до пересчёта: в очереди ревизия R — окно возвращает её, строка снимается.
      const a = db.seed.contract({ number: 'ОМГ-ДП-26-003', objectId: O, counterparties: [s.cpR] })
      const ca = await card(U.editor, a)
      assert.equal(typeof ca.revision, 'number', 'карточка отдаёт ревизию очереди')
      const okA = await confirm(U.editor, a, confirmBody(ca, own, { expectedRevision: ca.revision }))
      assert.equal(okA.statusCode, 200, okA.body)
      assert.equal(queued(a), '0', 'ревизия та же — строка очереди снята')
      // Реквизиты правили после открытия окна: ревизия новее — строка остаётся, договор будет пересчитан по новым данным.
      const b = db.seed.contract({ number: 'ОМГ-ДП-26-003', objectId: O, counterparties: [s.cpR] })
      const cb = await card(U.editor, b)
      db.seed.enqueue(b) // правка реквизитов после открытия окна: в очереди ревизия новее той, что видело окно
      const okB = await confirm(U.editor, b, confirmBody(cb, own, { expectedRevision: cb.revision }))
      assert.equal(okB.statusCode, 200, okB.body)
      assert.equal(queued(b), '1', 'правка, которую окно не видело, остаётся в очереди')
      // Ревизии нет в теле — как «окно строки не видело» (0): строка очереди остаётся.
      const d = db.seed.contract({ number: 'ОМГ-ДП-26-003', objectId: O, counterparties: [s.cpR] })
      const cd = await card(U.editor, d)
      assert.equal((await confirm(U.editor, d, confirmBody(cd, own))).statusCode, 200)
      assert.equal(queued(d), '1')
      // Неверная ревизия в теле — 400.
      assert.equal((await confirm(U.editor, d, confirmBody(cd, own, { expectedRevision: -1 }))).statusCode, 400)
    })

    it('карточка: revision — число или null; кандидаты несут прежнее решение (prevStatus, prevDecidedAt); узел — вид папки', async () => {
      const id = await mk('ОМГ-ДП-26-007', null)
      const c = await card(U.editor, id)
      assert.equal(c.revision, null, 'очередь пуста — ревизии нет')
      const withLink = await card(U.editor, dpWarn)
      assert.equal(withLink.node.kind, 'folder')
      assert.equal(withLink.node.path, 'Док / 15к / ДП ОМГ-ДП-26-001 ООО Ромашка', 'путь — от границы объекта (весь корень размечен одним объектом)')
      for (const cand of c.candidates || []) assert.deepEqual(Object.keys(cand).sort(), ['flags', 'nodeId', 'path', 'prevDecidedAt', 'prevStatus', 'reasons', 'score', 'status'])
    })
  })

  describe('reject и unlink несут «вид» папки (С-53)', () => {
    let nodeKeyOf
    before(async () => { ({ nodeKeyOf } = await import(path.join(SERVER, 'src', 'lib', 'signalMatch.js'))) })
    const keyFromBase = async (nodeId) => nodeKeyOf((await h.app.signal.jobs.store.nodes({ nodeIds: [nodeId] }, 10)).nodes[0])

    it('reject: в базе хранится nodeKey папки; смена вида папки (имя, номера) возвращает предложение с прежним решением (prevStatus)', async () => {
      const id = db.seed.contract({ number: 'АЛФ-ДП-26-002', objectId: s.A, counterparties: [s.cpR] })
      await h.tick()
      const c = await card(U.editor, id)
      const cand = c.candidates.find((x) => x.nodeId === F.f2)
      assert.ok(cand, 'папка с номером договора предложена')
      const res = await h.post(U.editor, `/api/signal/contracts/${id}/reject`, { nodeId: F.f2, expectedStateVersion: c.stateVersion, idempotencyKey: key() })
      assert.equal(res.statusCode, 200, res.body)
      const stored = one(db, `select node_key from osp_private.signal_candidates where contract_id = ${lit(id)} and node_id = ${lit(F.f2)}`)
      assert.equal(stored, await keyFromBase(F.f2), 'вид папки сохранён вместе с отказом')
      assert.match(stored, /^[0-9a-f]{8,}$/)
      // Тот же вид: пара не предлагается снова.
      db.sql('select osp_private.signal_enqueue_all()')
      await h.tick()
      assert.ok(!(await card(U.editor, id)).candidates.some((x) => x.nodeId === F.f2 && x.status === 'open'))
      // Папка стала другой по смыслу (переименована): пара открыта заново, прежнее решение — в prevStatus, а не потеряно.
      db.sql(`update osp_private.signal_nodes set name = name || ' (новая редакция)', name_norm = name_norm || ' новая редакция' where node_id = ${lit(F.f2)}`)
      try {
        db.sql('select osp_private.signal_enqueue_all()')
        await h.tick()
        const again = (await card(U.editor, id)).candidates.find((x) => x.nodeId === F.f2)
        assert.deepEqual([again.status, again.prevStatus], ['open', 'rejected'])
        assert.match(again.prevDecidedAt, /^\d{4}-\d{2}-\d{2}T/)
      } finally {
        db.sql(`update osp_private.signal_nodes set name = replace(name, ' (новая редакция)', ''), name_norm = replace(name_norm, ' новая редакция', '') where node_id = ${lit(F.f2)}`)
      }
    })

    it('unlink: отвязанная пара хранится с видом папки (nodeKey связанного узла)', async () => {
      const id = db.seed.contract({ number: 'АЛФ-ДП-26-004', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f4) })
      await h.tick()
      const c = await card(U.editor, id)
      assert.equal(c.state, 'verified')
      const res = await h.post(U.editor, `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: c.signalLink, expectedStateVersion: c.stateVersion, expectedRevision: c.revision ?? 0, idempotencyKey: key() })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(one(db, `select node_key from osp_private.signal_candidates where contract_id = ${lit(id)} and node_id = ${lit(F.f4)} and status = 'unlinked'`), await keyFromBase(F.f4))
      // Правка после открытия окна не теряется: ревизия окна устарела — договор остаётся в очереди.
      const other = db.seed.contract({ number: 'АЛФ-ДП-26-004', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f4) })
      await h.tick()
      const co = await card(U.editor, other)
      db.seed.enqueue(other)
      const un = await h.post(U.editor, `/api/signal/contracts/${other}/unlink`, { expectedSignalLink: co.signalLink, expectedStateVersion: co.stateVersion, expectedRevision: co.revision ?? 0, idempotencyKey: key() })
      assert.equal(un.statusCode, 200, un.body)
      assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(other)}`), '1')
    })
  })
})
