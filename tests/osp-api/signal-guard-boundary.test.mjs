// Тесты-сторожа границы «договор + узел» сверки с SIGNAL (пакет ПР-9, находка К-3; инвариант 3 из плана волны исправлений).
// Доступ к метаданным SIGNAL требует проверки и договора (право раздела «Договоры» и охват osp_object_scope()), и узла (включённый
// готовый корень; объект узла по разметке равен объекту договора). Чужие имена, пути, id и счётчики не выдаются; подрядчик не получает ничего.
//
// Сторожа утверждают ИНВАРИАНТЫ: «не сверено», «узла нет», «в теле ответа нет ни одного чужого имени, пути или id» (поиск подстрок
// синтетических маркеров чужого объекта по всему телу), «счётчик не учитывает чужое», «ответ на чужой договор неотличим от ответа на
// несуществующий». Точные причины состояний и форма пути здесь не проверяются — их меняет волна исправлений.
//
//   Б1–Б4  окно между правкой договора (объект сменился) и пересчётом очереди: окно сверки, значок, предложения и их счётчик не несут
//          папку прежнего объекта; после пересчёта — то же и состояние не «сверено»          (мутанты SM02, SM03, SM04, SM05)
//   Б8     подтверждение чужой и не виденной в последнем обходе папки отклоняет база, а не только маршрут  (мутант SM08)
//   Поиск «Другая папка…» отдаёт папки только объекта договора                                              (мутант SM07)
//   Матрица «аккаунты × фактические маршруты /api/signal/*»: подрядчик — ничего; без права — отказ или {enabled:false};
//          маршруты администратора — только администратору; чужой договор — без данных и неотличим от несуществующего
//   Ссылка договора на папку чужого объекта, неразмеченную папку и папку другой разметки общего корня — не «сверено», узла нет
//
// Данные — синтетика (вымышленные названия, коды объектов, адреса signal.example.test). Нужны PostgreSQL и зависимости сервера.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'
import { startSignalApp, nodeTree } from './lib/signal-app.mjs'
import { startFakeSignal } from './lib/fake-signal.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const key = () => crypto.randomUUID()
const NOT_VERIFIED = (state) => !['verified', 'accepted'].includes(state)
const WIDE = { max: 100000, windowMs: 60_000 }
const parse = (text) => { try { return JSON.parse(text) } catch { return text } }
// Ссылка договора — его собственные данные (не чужие): её не сканируем на маркеры.
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'signalLink').map(([k, x]) => [k, strip(x)])) : v)

describe('Сторожа границы «договор + узел» SIGNAL (К-3)', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let h
  let fake
  let U
  let C
  let F
  let M // маркеры объектов: { A: [...], B: [...] } — имена, id узлов и идентификатор проекта

  const q = (text) => db.sqlJson(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (${text}) t`)
  const stateRow = (id) => q(`select state, reason, node_id, state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)[0] || null
  const call = async (uid, method, url, body) => { const r = await h.call(uid, method, url, body); return { status: r.statusCode, body: parse(r.body), raw: r.body } }
  const get = (uid, url) => call(uid, 'GET', url)
  const card = (uid, id, qs = '') => get(uid, `/api/signal/contracts/${id}${qs}`)
  const marksSql = (uid) => Object.fromEntries(db.asJson(uid, 'select osp_private.signal_marks(null, 1000)').items.map((m) => [m.id, m]))
  const viewSql = (uid, id) => db.asJson(uid, `select osp_private.signal_contract_view(${lit(id)})`)
  const foldersSql = (uid, id, text = '') => db.asJson(uid, `select osp_private.signal_folders_search(${lit(id)}, ${lit(text)}, null, 100)`)
  const leaks = (body, markers) => { const text = JSON.stringify(strip(body)); return markers.filter((m) => text.includes(m)) }
  const assertClean = (body, markers, label) => assert.deepEqual(leaks(body, markers), [], `${label}: в ответе чужие имена, пути или идентификаторы`)
  const markersOf = (objectId, projectIds = []) => {
    const rows = q(`select node_id, name from osp_private.signal_nodes where object_id = ${lit(objectId)}`)
    return [...new Set([...rows.map((r) => r.name), ...rows.map((r) => r.node_id), ...projectIds])]
  }
  const moveContracts = (ids, objectId) => db.sql(`update public.contracts set object_id = ${lit(objectId)} where id in (${ids.map(lit).join(', ')})`)

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    C = s.contracts
    F = s.folders
    fake = await startFakeSignal()
    // Предел частоты — на пользователя в минуту: матрице нужны сотни запросов.
    h = await startSignalApp(db, { fake, limits: { signalSyncPerUser: WIDE, signalWritePerUser: WIDE, signalMatchPerUser: WIDE } })
    await h.tick()
    M = { A: markersOf(s.A, [s.projectA]), B: markersOf(s.B, [s.projectB]) }
    assertBaseline()
  })
  after(async () => { await h?.close(); await fake?.close(); await db?.stop() })

  // Исходное состояние сцены; проверяется и до, и после «окон» — чтобы сторожа не были пустыми.
  function assertBaseline() {
    assert.equal(stateRow(C.c2).state, 'verified', 'c2 сверен')
    assert.equal(stateRow(C.c2).node_id, F.f2)
    const v2 = viewSql(U.editor, C.c2)
    assert.equal(v2.node?.nodeId, F.f2, 'окно c2 показывает свою папку')
    assert.ok(v2.files.length > 0, 'и её содержимое')
    assert.equal(marksSql(U.editor)[C.c2].path !== undefined, true, 'значок c2 несёт путь своей папки')
    const v1 = viewSql(U.editor, C.c1)
    assert.ok(v1.candidates.length > 0, 'у c1 есть предложение своего объекта')
    const m1 = marksSql(U.editor)[C.c1]
    assert.ok(m1.candidates > 0 && m1.candidatePath !== undefined, 'значок c1 считает предложения и несёт путь предложенной папки')
    assert.ok(foldersSql(U.editor, C.c1).items.length > 0, 'поиск папок для c1 не пуст')
  }

  // ── Б1–Б4. Договор перенесён на другой объект, пересчёта очереди ещё не было ─────────────────────────────────────────
  describe('окно между правкой объекта договора и пересчётом очереди', () => {
    for (const who of ['editor', 'editorB']) {
      it(`${who}: окно, значок, предложения и их счётчик не несут папку прежнего объекта — до и после пересчёта`, async () => {
        const uid = U[who]
        moveContracts([C.c1, C.c2], s.B) // c2 был «сверен» с f2 (объект А), у c1 открыто предложение f1 (объект А)
        try {
          // Б1: окно договора — узла и файлов нет
          const v2 = viewSql(uid, C.c2)
          assert.equal(v2.node, null, 'Б1: узел чужого объекта не выдаётся')
          assert.deepEqual(v2.files, [], 'Б1: файлов чужой папки нет')
          const r2 = await card(uid, C.c2)
          assert.equal(r2.status, 200)
          assert.equal(r2.body.node, null)
          assert.deepEqual(r2.body.files, [])
          assertClean(r2.body, M.A, 'Б1: карточка c2')
          // Б2: значок — без пути
          assert.equal(marksSql(uid)[C.c2].path, undefined, 'Б2: значок не несёт путь папки прежнего объекта')
          // Б3: окно c1 — предложений прежнего объекта нет
          assert.deepEqual(viewSql(uid, C.c1).candidates, [], 'Б3: предложение папки прежнего объекта не попадает в окно')
          const r1 = await card(uid, C.c1)
          assert.deepEqual(r1.body.candidates, [])
          assertClean(r1.body, M.A, 'Б3: карточка c1')
          // Б4: значок c1 — ни числа предложений, ни пути предложенной папки
          const m1 = marksSql(uid)[C.c1]
          assert.deepEqual([m1.candidates, m1.candidatePath], [0, undefined], 'Б4: счётчик и путь предложения не учитывают чужое')
          const routeMarks = (await get(uid, '/api/signal/marks?limit=1000')).body.items
          const routeC1 = routeMarks.find((m) => m.id === C.c1)
          assert.equal(routeC1.hasCandidate, false, 'Б4: значок в реестре без «есть предложение»')
          assertClean([routeC1, routeMarks.find((m) => m.id === C.c2)], M.A, 'Б2/Б4: значки в реестре')

          // после пересчёта очереди
          await h.tick()
          const st2 = stateRow(C.c2)
          assert.ok(NOT_VERIFIED(st2.state), `после пересчёта c2 не «сверен» (${st2.state}:${st2.reason})`)
          assert.equal(st2.node_id, null, 'узел чужого объекта в состоянии не хранится')
          assert.equal(viewSql(uid, C.c2).node, null)
          assert.ok(NOT_VERIFIED(stateRow(C.c1).state))
          assertClean((await card(uid, C.c2)).body, M.A, 'после пересчёта: карточка c2')
          assertClean((await card(uid, C.c1)).body, M.A, 'после пересчёта: карточка c1')
          assertClean(marksSql(uid)[C.c1], M.A, 'после пересчёта: значок c1')
          assert.equal(marksSql(uid)[C.c2].path, undefined)
          assertClean(foldersSql(uid, C.c1), M.A, 'после пересчёта: поиск папок для c1')
        } finally {
          moveContracts([C.c1, C.c2], s.A)
          await h.tick()
        }
        assertBaseline()
      })
    }
  })

  // ── Б8 и подтверждение чужого узла ───────────────────────────────────────────────────────────────────────────────────
  describe('подтверждение: база отказывает по чужому и по не виденному в последнем обходе узлу', () => {
    const confirmSql = (uid, contractId, nodeId, version) => db.asError(uid, `select osp_private.signal_confirm(${lit(contractId)}, ${lit(nodeId)}, ${lit(s.urlOf(nodeId))}, false, null, null, 'fp', null, ${version}, ${lit(key())})`)

    it('Б8: папка не видна в последнем обходе — SQL отклоняет подтверждение (SG422, узел недоступен), договор и ссылка не меняются', () => {
      db.sql(`update osp_private.signal_nodes set seen_gen = seen_gen - 1 where node_id = ${lit(F.f1)}`)
      try {
        const before = stateRow(C.c1)
        const e = confirmSql(U.editor, C.c1, F.f1, viewSql(U.editor, C.c1).stateVersion)
        assert.ok(e && e.code === 'SG422' && ['node_unavailable', 'object_unassigned'].includes(e.message), `подтверждение отклонено как недоступный узел: ${JSON.stringify(e)}`)
        assert.deepEqual(stateRow(C.c1), before, 'состояние не изменено')
        assert.equal(one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(C.c1)}`), '', 'ссылка не записана')
      } finally { db.sql(`update osp_private.signal_nodes set seen_gen = seen_gen + 1 where node_id = ${lit(F.f1)}`) }
    })

    it('папка другого объекта: SQL и маршрут отказывают, ссылка и событие «Истории» не появляются, в ответе нет чужого', async () => {
      const before = stateRow(C.c1)
      const sqlErr = confirmSql(U.editor, C.c1, F.fb1, before.state_version)
      assert.ok(sqlErr && ['node_unavailable', 'object_unassigned'].includes(sqlErr.message), JSON.stringify(sqlErr))
      const events = Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`))
      const r = await call(U.editor, 'POST', `/api/signal/contracts/${C.c1}/confirm`, {
        nodeId: F.fb1, replace: false, expectedSignalLink: null, expectedStateVersion: before.state_version, idempotencyKey: key(),
      })
      assert.ok(r.status >= 400 && r.status < 500, `маршрут отказал: ${r.status} ${r.raw}`)
      assertClean(r.body, M.B, 'confirm чужой папки')
      assert.deepEqual(stateRow(C.c1), before)
      assert.equal(one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(C.c1)}`), '')
      assert.equal(Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`)), events)
    })
  })

  // ── Поиск «Другая папка…» ────────────────────────────────────────────────────────────────────────────────────────────
  describe('поиск папок для ручной привязки', () => {
    it('отдаёт только папки объекта договора (не чужого объекта и не неразмеченные), по любому запросу', async () => {
      const own = (objectId) => new Set(q(`select n.node_id from osp_private.signal_nodes n join osp_private.signal_meta m on true
        where n.object_id = ${lit(objectId)} and n.kind = 'folder' and n.seen_gen = m.generation`).map((r) => r.node_id))
      const ownA = own(s.A)
      const ownB = own(s.B)
      assert.ok(ownA.size > 0 && ownB.size > 0)
      for (const text of ['', 'АЛФ', 'Лютик', 'БЕТ-ДП', 'Документы']) {
        const a = foldersSql(U.editor, C.c1, text)
        assert.ok(a.items.every((i) => ownA.has(i.nodeId)), `запрос «${text}»: для договора объекта А только папки объекта А`)
        assertClean(a, M.B, `запрос «${text}»: поиск для А`)
        const b = foldersSql(U.editorB, C.cb, text)
        assert.ok(b.items.every((i) => ownB.has(i.nodeId)), `запрос «${text}»: для договора объекта Б только папки объекта Б`)
        assertClean(b, M.A, `запрос «${text}»: поиск для Б`)
      }
      const allA = new Set(foldersSql(U.editor, C.c1).items.map((i) => i.nodeId))
      for (const id of [F.k1, F.f1, F.f2, F.f4]) assert.ok(allA.has(id), 'без запроса — папки объекта А предлагаются')
      assert.deepEqual(foldersSql(U.editor, C.c1, 'Лютик').items, [], 'имя папки объекта Б не находится')
      // то же через маршрут
      const r = await get(U.editor, `/api/signal/folders?contractId=${C.c1}&q=${encodeURIComponent('Лютик')}`)
      assert.deepEqual([r.status, r.body.items], [200, []])
    })

    it('раскрытие подпапки в карточке: только потомок связанной папки; чужая, соседняя и случайная — отказ без данных', async () => {
      const ok = await card(U.editor, C.c2, `?nodeId=${F.fds1}`)
      assert.equal(ok.status, 200, ok.raw)
      for (const [label, nodeId] of [['соседняя папка того же объекта', F.f1], ['папка другого объекта', F.fb1], ['корень другого объекта', F.rootB], ['случайный uuid', key()]]) {
        const r = await card(U.editor, C.c2, `?nodeId=${nodeId}`)
        assert.ok(r.status >= 400 && r.status < 500, `${label}: ${r.status} ${r.raw}`)
        assertClean(r.body, [...M.A, ...M.B], `${label}: раскрытие`)
      }
    })
  })

  // ── Матрица «аккаунты × фактические маршруты» ───────────────────────────────────────────────────────────────────────
  describe('матрица аккаунтов и маршрутов /api/signal/*', () => {
    const PINNED_ADMIN = [
      'POST /api/signal/sources', 'PATCH /api/signal/sources/:id', 'POST /api/signal/sync', 'GET /api/signal/runs',
      'GET /api/signal/unassigned', 'POST /api/signal/bindings',
    ]
    const EDIT_ONLY = [
      'GET /api/signal/folders', 'POST /api/signal/match', 'POST /api/signal/contracts/:id/confirm', 'POST /api/signal/contracts/:id/reject',
      'POST /api/signal/contracts/:id/unlink', 'POST /api/signal/aliases', 'DELETE /api/signal/aliases/:id',
    ]
    const OPEN_TO_VIEW = ['GET /api/signal/status', 'GET /api/signal/marks', 'GET /api/signal/contracts/:id']
    const routeKey = (r) => `${r.method} ${r.url}`
    let routes
    let W // аккаунты

    // Запрос по описанию маршрута из таблицы прав приложения; неизвестный маршрут получает безвредный запрос (права проверяются до тела).
    const requestFor = (r, ctx) => {
      const id = r.url.includes('/contracts/') ? ctx.contractId : r.url.includes('/sources/') ? String(ctx.sourceId) : '999999'
      const url = r.url.replace(':id', id)
      const query = {
        'GET /api/signal/folders': `?contractId=${ctx.contractId}`,
        'GET /api/signal/unassigned': `?sourceId=${ctx.sourceId}`,
        'GET /api/signal/tree': `?sourceId=${ctx.sourceId}`,
        'GET /api/signal/bindings': `?sourceId=${ctx.sourceId}`,
        'GET /api/signal/aliases': '',
      }[routeKey(r)] ?? ''
      const bodies = {
        'POST /api/signal/contracts/:id/confirm': { nodeId: ctx.nodeId, replace: false, expectedSignalLink: null, expectedStateVersion: 0, idempotencyKey: key() },
        'POST /api/signal/contracts/:id/reject': { nodeId: ctx.nodeId, expectedStateVersion: 0, idempotencyKey: key() },
        'POST /api/signal/contracts/:id/unlink': { expectedSignalLink: 'x', expectedStateVersion: 0, idempotencyKey: key() },
        'POST /api/signal/match': { contractIds: [ctx.contractId] },
        'POST /api/signal/aliases': { objectId: s.A, text: `Синоним матрицы ${key()}` },
        'POST /api/signal/sources': { url: s.urlOf(key()), objectIds: [] },
        'PATCH /api/signal/sources/:id': { enabled: true },
        'POST /api/signal/bindings': { sourceId: ctx.sourceId, nodeId: ctx.nodeId, objectId: null },
        'POST /api/signal/bindings/preview': { sourceId: ctx.sourceId, nodeId: ctx.nodeId, objectId: s.A },
        'POST /api/signal/sync': {},
      }
      const body = r.method === 'GET' ? undefined : bodies[routeKey(r)] ?? {}
      return { method: r.method, url: `${url}${query}`, body }
    }

    before(() => {
      routes = h.app.accessTable.filter((r) => r.url.startsWith('/api/signal/'))
      const { seed } = db
      W = {
        none: null,
        blocked: seed.user({ contracts: 'edit', blocked: true }),
        unapproved: seed.user({ contracts: 'edit', approved: false }),
        contractor: U.contractor,
        selfContractor: seed.user({ role: 'contractor', contracts: 'edit', counterparty: null }),
        orgEmployee: seed.user({ contracts: 'edit', counterparty: seed.counterparty({ name: 'ООО Подряд' }) }),
        outsider: db.id('usr'), // токен есть, строки ролей нет
        noRight: U.noRight,
        viewer: U.viewer,
        viewerB: U.viewerB,
        editor: U.editor,
        editorB: U.editorB,
        emptyScope: seed.user({ contracts: 'edit', objectScoped: true, objectIds: [] }),
        emptyScopeView: seed.user({ contracts: 'view', objectScoped: true, objectIds: [] }),
      }
    })

    const ctxFor = (contractId) => ({ contractId, nodeId: F.f2, sourceId: s.srcA.id })
    const all = async (uid, ctx) => {
      const out = []
      for (const r of routes) {
        const req = requestFor(r, ctx)
        const res = await call(uid, req.method, req.url, req.body)
        out.push({ route: routeKey(r), ...res })
      }
      return out
    }

    it('список маршрутов взят у приложения: прежние 17 на месте, админские закреплены, права на маршруте объявлены', () => {
      assert.ok(routes.length >= 17, `маршрутов сверки ${routes.length}`)
      const keys = new Set(routes.map(routeKey))
      for (const k of [...PINNED_ADMIN, ...EDIT_ONLY, ...OPEN_TO_VIEW]) assert.ok(keys.has(k), `маршрут ${k} исчез`)
      for (const k of PINNED_ADMIN) assert.equal(routes.find((r) => routeKey(r) === k).require, 'admin', `${k} — только администратор`)
      for (const r of routes) assert.equal(r.kind, 'user', `${routeKey(r)} не открыт без входа`)
      // новые маршруты разметки (если есть) — только администратору
      for (const k of ['GET /api/signal/tree', 'GET /api/signal/bindings', 'POST /api/signal/bindings/preview']) {
        const r = routes.find((x) => routeKey(x) === k)
        if (r) assert.equal(r.require, 'admin', `${k} — только администратор`)
      }
    })

    it('подрядчик, без входа, заблокированный, неодобренный, без строки ролей: на каждом маршруте отказ, в ответе ничего', async () => {
      const ctx = ctxFor(C.c2)
      for (const name of ['none', 'blocked', 'unapproved', 'contractor', 'selfContractor', 'orgEmployee', 'outsider']) {
        for (const r of await all(W[name], ctx)) {
          assert.ok([401, 403].includes(r.status), `${name} → ${r.route}: ${r.status} ${r.raw}`)
          assertClean(r.body, [...M.A, ...M.B], `${name} → ${r.route}`)
        }
      }
    })

    it('сотрудник без права «Договоры»: отказ на каждом маршруте, статус — {enabled:false} без данных', async () => {
      const ctx = ctxFor(C.c2)
      for (const r of await all(W.noRight, ctx)) {
        if (r.route === 'GET /api/signal/status') {
          assert.equal(r.status, 200)
          assert.equal(r.body.enabled, false)
          for (const k of ['sources', 'dataAt', 'generation', 'lastRuns', 'canEdit', 'isAdmin']) assert.ok(!(k in r.body), `статус без права не несёт ${k}`)
        } else assert.ok([401, 403].includes(r.status), `noRight → ${r.route}: ${r.status} ${r.raw}`)
        assertClean(r.body, [...M.A, ...M.B], `noRight → ${r.route}`)
      }
    })

    it('маршруты администратора закрыты и просмотру, и правке; решения и поиск папок — просмотру; чужой охват и пустой охват — без данных', async () => {
      const adminRoutes = new Set(routes.filter((r) => r.require === 'admin').map(routeKey))
      for (const k of PINNED_ADMIN) assert.ok(adminRoutes.has(k))
      for (const name of ['viewer', 'viewerB', 'editor', 'editorB', 'emptyScope', 'emptyScopeView']) {
        const ctx = name === 'viewerB' || name === 'editorB' ? ctxFor(C.cb) : ctxFor(C.c2)
        for (const r of await all(W[name], ctx)) {
          if (adminRoutes.has(r.route)) assert.ok(r.status >= 400 && r.status < 500, `${name} → ${r.route} (администратор): ${r.status} ${r.raw}`)
          if (['viewer', 'viewerB', 'emptyScopeView'].includes(name) && EDIT_ONLY.includes(r.route)) {
            assert.ok(r.status >= 400 && r.status < 500, `${name} → ${r.route} (правка): ${r.status} ${r.raw}`)
          }
          if (name === 'editorB' || name === 'viewerB') assertClean(r.body, M.A, `${name} → ${r.route}`)
          if (name.startsWith('emptyScope')) assertClean(r.body, [...M.A, ...M.B], `${name} → ${r.route}`)
        }
      }
      // контроль: те же запросы у тех, кому положено, проходят (запросы матрицы составлены верно, а отказы выше — не от кривого запроса)
      const okEditor = Object.fromEntries((await all(W.editor, ctxFor(C.c2))).map((r) => [r.route, r]))
      assert.deepEqual([okEditor['GET /api/signal/status'].status, okEditor['GET /api/signal/status'].body.enabled], [200, true])
      for (const k of ['GET /api/signal/marks', 'GET /api/signal/contracts/:id', 'GET /api/signal/folders']) assert.equal(okEditor[k].status, 200, `${k}: у сотрудника с правкой запрос проходит`)
      assert.equal((await get(W.viewer, `/api/signal/contracts/${C.c2}`)).status, 200, 'просмотр: карточка проходит')
      assert.equal((await call(U.admin, 'GET', '/api/signal/runs')).status, 200, 'администратор: журнал проходит')
      const marks = (uid) => get(uid, '/api/signal/marks?limit=1000')
      assert.deepEqual((await marks(W.emptyScope)).body.items, [], 'пустой охват — значков нет')
      const idsB = new Set(q(`select id from public.contracts where object_id = ${lit(s.B)}`).map((r) => r.id))
      const forB = (await marks(U.editorB)).body.items
      assert.ok(forB.length > 0 && forB.every((m) => idsB.has(m.id)), 'охват объекта Б — только договоры объекта Б')
      assertClean(forB, M.A, 'значки сотрудника объекта Б')
    })

    it('просмотр без правки: предложений, их числа и пути предложенной папки нет ни в значках, ни в окне; папка связанного договора видна', async () => {
      const candidateName = one(db, `select name from osp_private.signal_nodes where node_id = ${lit(F.f1)}`)
      const sqlMarks = marksSql(W.viewer)
      for (const id of Object.values(C)) {
        if (sqlMarks[id]) assert.deepEqual(['candidates', 'candidatePath'].filter((k) => k in sqlMarks[id]), [], `значок ${id}: поля предложений только при праве правки`)
      }
      const v1 = viewSql(W.viewer, C.c1)
      assert.ok(!('candidates' in v1) && v1.canEdit === false, 'окно c1: предложений нет, правка недоступна')
      const route = await get(W.viewer, '/api/signal/marks?limit=1000')
      assert.ok(route.body.items.every((m) => m.hasCandidate === false), 'в реестре нет «есть предложение»')
      assertClean(await get(W.viewer, `/api/signal/contracts/${C.c1}`).then((r) => r.body), [candidateName], 'карточка c1 для просмотра')
      assert.ok(!JSON.stringify(route.body).includes(candidateName), 'реестр для просмотра не несёт имя предложенной папки')
      // своя связанная папка просмотру видна
      assert.equal(viewSql(W.viewer, C.c2).node?.nodeId, F.f2)
    })

    it('чужой договор неотличим от несуществующего и не даёт данных: карточка, поиск, подтверждение, отказ, отвязка, /match', async () => {
      const missing = key()
      for (const [uid, foreign, markers, label] of [[U.editorB, C.c2, M.A, 'сотрудник объекта Б → договор А'], [W.viewerB, C.c2, M.A, 'просмотр объекта Б → договор А']]) {
        for (const r of routes.filter((x) => x.url.includes('/contracts/') || ['GET /api/signal/folders', 'POST /api/signal/match'].includes(routeKey(x)))) {
          const a = requestFor(r, ctxFor(foreign))
          const b = requestFor(r, ctxFor(missing))
          const ra = await call(uid, a.method, a.url, a.body)
          const rb = await call(uid, b.method, b.url, b.body)
          assert.ok(ra.status >= 400 && ra.status < 500, `${label} → ${routeKey(r)}: ${ra.status} ${ra.raw}`)
          assert.equal(ra.status, rb.status, `${label} → ${routeKey(r)}: чужой и несуществующий — один код`)
          assert.deepEqual(ra.body, rb.body, `${label} → ${routeKey(r)}: чужой и несуществующий — один ответ`)
          assertClean(ra.body, markers, `${label} → ${routeKey(r)}`)
        }
      }
      // договор объекта Б глазами сотрудника, чей охват — только объект А
      const scopedA = db.seed.user({ contracts: 'edit', objectScoped: true, objectIds: [s.A] })
      const r = await get(scopedA, `/api/signal/contracts/${C.cb}`)
      assert.ok(r.status >= 400 && r.status < 500)
      assertClean(r.body, M.B, 'сотрудник объекта А → договор Б')
    })
  })

  // ── Ссылка договора на чужую, неразмеченную папку и папку соседней разметки общего корня ──────────────────────────────
  describe('ссылка договора на папку, которая договору не видна', () => {
    it('чужой объект, неразмеченная папка и папка другого объекта в общем корне: не «сверено», узла нет, чужих имён и файлов нет; своё — сверено', async () => {
      const { seed } = db
      const cp = s.cpR
      const srcX = seed.source({ objectIds: [s.A, s.B], name: 'Тест: проект Общий', rootPath: 'Тест: проект Общий / Документы Общие' })
      const XA = db.id('nod')
      const XB = db.id('nod')
      seed.bind(srcX.id, XA, s.A)
      seed.bind(srcX.id, XB, s.B)
      const tree = await nodeTree({
        name: 'Документы Общие',
        children: [
          { id: XA, name: 'Раздел Альфа', children: [{ name: 'ДП АЛФ-ДП-26-401 ООО Ромашка', items: [{ name: 'ДоговорАльфа401.pdf' }] }] },
          { id: XB, name: 'Раздел Бета', children: [{ name: 'ДП БЕТ-ДП-26-402 ООО Лютик', items: [{ name: 'СекретБета402.pdf' }] }] },
          { name: 'Прочее общее', children: [{ name: 'Подпапка без объекта' }] },
        ],
      })
      const snap = seed.snapshot(srcX.id, tree, { generation: 1 })
      const dpA = snap.ids['Документы Общие / Раздел Альфа / ДП АЛФ-ДП-26-401 ООО Ромашка']
      const dpB = snap.ids['Документы Общие / Раздел Бета / ДП БЕТ-ДП-26-402 ООО Лютик']
      const loose = snap.ids['Документы Общие / Прочее общее / Подпапка без объекта']
      assert.equal(one(db, `select coalesce(object_id::text, '-') from osp_private.signal_nodes where node_id = ${lit(loose)}`), '-', 'папка вне разметки — без объекта')
      const mk = (number, objectId, nodeId, project = srcX.projectId) => seed.contract({ number, objectId, counterparties: [cp], signalLink: nodeId ? s.urlOf(nodeId, project) : null })
      const own = mk('АЛФ-ДП-26-401', s.A, dpA)
      const ownB = mk('БЕТ-ДП-26-402', s.B, dpB)
      const toOtherMarkup = mk('АЛФ-ДП-26-403', s.A, dpB) // тот же корень, но разметка — объект Б
      const toLoose = mk('АЛФ-ДП-26-404', s.A, loose) // папка без объекта
      const toOtherRoot = mk('АЛФ-ДП-26-405', s.A, F.fb1, s.projectB) // корень объекта Б
      await h.tick()
      const markersB = markersOf(s.B, [s.projectB])
      assert.ok(markersB.includes('Раздел Бета') && markersB.includes('СекретБета402.pdf'), 'маркеры объекта Б собраны, включая общий корень')

      assert.equal(stateRow(own).state, 'verified', 'контроль: своя папка в общем корне — сверено')
      assert.equal(stateRow(ownB).state, 'verified', 'контроль: папка объекта Б у договора Б — сверено')
      assert.equal(stateRow(own).node_id, dpA)
      assert.equal((await card(U.editor, own)).body.node?.nodeId, dpA)

      for (const [label, id] of [['папка другой разметки общего корня', toOtherMarkup], ['папка без объекта', toLoose], ['корень другого объекта', toOtherRoot]]) {
        const st = stateRow(id)
        assert.ok(NOT_VERIFIED(st.state), `${label}: не «сверено» (${st.state}:${st.reason})`)
        assert.equal(st.node_id, null, `${label}: узел не хранится`)
        const view = await card(U.editor, id)
        assert.equal(view.body.node, null, `${label}: узла в карточке нет`)
        assert.deepEqual(view.body.files, [], `${label}: файлов нет`)
        assertClean(view.body, markersB, `${label}: карточка`)
        assertClean(foldersSql(U.editor, id), markersB, `${label}: поиск папок`)
        const m = (await get(U.editor, '/api/signal/marks?limit=1000')).body.items.find((x) => x.id === id)
        assertClean(m, markersB, `${label}: значок`)
        const match = await call(U.editor, 'POST', '/api/signal/match', { contractIds: [id] })
        assert.equal(match.status, 200, match.raw)
        assert.ok(NOT_VERIFIED(match.body.items[0].state), `${label}: /match — не «сверено»`)
        assert.ok(!match.body.items[0].nodeId, `${label}: /match — узла нет`)
        assertClean(match.body, markersB, `${label}: /match`)
      }
      // поиск папок договора объекта А в общем корне: только размеченное под А (в том числе корень и папки без объекта не выдаются)
      const own2 = new Set(q(`select node_id from osp_private.signal_nodes where object_id = ${lit(s.A)} and kind = 'folder'`).map((r) => r.node_id))
      const found = foldersSql(U.editor, own)
      assert.ok(found.items.length > 0 && found.items.every((i) => own2.has(i.nodeId)), 'поиск: только папки объекта А')
      assert.ok(!found.items.some((i) => [XB, dpB, loose].includes(i.nodeId)), 'поиск: ни папки соседней разметки, ни неразмеченной')
    })
  })
})
