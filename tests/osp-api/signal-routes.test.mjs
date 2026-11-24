// Маршруты /api/signal/* (server/osp-api/src/routes/signal.js, раздел 7 спецификации интеграции OSP ↔ SIGNAL) на настоящем PostgreSQL:
// миграция 20270228_signal_integration, настоящий buildApp со входом по токену, поддельный SIGNAL (tests/osp-api/lib/fake-signal.mjs).
// Проверяем обещанное механизмом, а не чтением кода:
//   • права: подрядчик — отказ везде; просмотр без правки — значки и окно без предложений, решения и поиск папок — 403; охват объектов —
//     чужой договор 404 без деталей; администраторские маршруты — только администратор; суперадминистратор — как is_admin() в базе;
//   • утечки: в ответах нет имён, путей и идентификаторов узлов чужого объекта; синоним не открывает папку чужого объекта;
//   • решения (confirm / reject / unlink): CAS по ссылке и версии без частичных записей, ключ повтора — тот же ответ и одно событие
//     «Истории», две параллельные сессии — одна выигрывает, непустая ссылка без «Заменить» — отказ, жёсткое противоречие и
//     «подтверждение недоступно» — без обращения к SQL;
//   • администратор: корень по ссылке (проверка по дереву Signal, перекрытие), включение, границы объектов, ручной обход и журнал;
//   • выключено (нет настройки, нет схемы), барьер записи, /api/health, секреты не попадают в журнал службы.
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { startSignalApp, folderUrl, HOST, FOLDER_FORMAT, ITEM_FORMAT } from './lib/signal-app.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { startFakeSignal, CLIENT_SECRET, CLIENT_ID } from './lib/fake-signal.mjs'

const key = () => crypto.randomUUID()
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('настройки SIGNAL_*: разбор и ошибки', () => {
  let loadConfig
  before(async () => { ({ loadConfig } = await import(path.join(SERVER, 'src', 'config.js'))) })
  const F = 'https://signal.example.test/projects/{projectId}/folders/{folderId}'
  const I = 'https://signal.example.test/projects/{projectId}/files/{itemId}'

  it('выключено — значения по умолчанию, ничего не проверяется', () => {
    const c = loadConfig({ SIGNAL_URL_FORMATS: 'мусор', SIGNAL_TICK_MS: 'x' }).signal
    assert.equal(c.sync, false)
    assert.equal(c.baseUrl, 'https://api.sgnl.pro')
    assert.deepEqual(c.urlFormats, [])
    assert.equal(c.tickMs, undefined)
  })

  it('включено: шаблоны, режим дня, числа и пары ключей разбираются; подключение необязательно', () => {
    const c = loadConfig({
      SIGNAL_SYNC: '1', SIGNAL_URL_FORMATS: `${F}; ${I}`, SIGNAL_UI_FOLDER_URL: F, SIGNAL_UI_FILE_URL: I, SIGNAL_DAY_MODE: 'known',
      SIGNAL_TICK_MS: '60000', SIGNAL_JOBS_TICK_MS: '5000', SIGNAL_CLIENT_ID: 'id-1', SIGNAL_CLIENT_SECRET: 'secret-1', SIGNAL_SCOPES: 'project:list docs:folder:read',
    }).signal
    assert.deepEqual(c.urlFormats, [F, I])
    assert.equal(c.uiFolderUrl, F)
    assert.equal(c.uiFileUrl, I)
    assert.equal(c.dayMode, 'known')
    assert.equal(c.tickMs, 60000)
    assert.equal(c.jobsTickMs, 5000)
    assert.deepEqual(c.scopes, ['project:list', 'docs:folder:read'])
    assert.equal(loadConfig({ SIGNAL_SYNC: '1' }).signal.clientId, '', 'без ключа служба запускается: очередь работает по готовому снимку')
  })

  it('включено с ошибкой — служба не запускается, причина названа', () => {
    const bad = (env, re) => assert.throws(() => loadConfig({ SIGNAL_SYNC: '1', ...env }), re)
    bad({ SIGNAL_CLIENT_ID: 'only-id' }, /SIGNAL_CLIENT_ID и SIGNAL_CLIENT_SECRET/)
    bad({ SIGNAL_URL_FORMATS: 'https://signal.example.test/projects/{projectId}' }, /SIGNAL_URL_FORMATS/)
    bad({ SIGNAL_UI_FOLDER_URL: I }, /SIGNAL_UI_FOLDER_URL/)
    bad({ SIGNAL_UI_FILE_URL: F }, /SIGNAL_UI_FILE_URL/)
    bad({ SIGNAL_DAY_MODE: 'всегда' }, /SIGNAL_DAY_MODE/)
    bad({ SIGNAL_TICK_MS: '5' }, /SIGNAL_TICK_MS/)
    bad({ SIGNAL_BASE_URL: 'http://api.sgnl.pro' }, /SIGNAL_BASE_URL/)
    bad({ SIGNAL_BASE_URL: 'https://api.sgnl.pro', SIGNAL_HOSTS: 'other.example.test' }, /SIGNAL_BASE_URL/)
  })

  it('configuredParts.signal: только включено и с подключением (ключом и секретом)', async () => {
    const { configuredParts } = await import(path.join(SERVER, 'src', 'config.js'))
    const base = { s3: {}, ratesApiKeys: [] }
    assert.equal(configuredParts({ ...base, signal: { sync: true, clientId: 'a', clientSecret: 'b' } }).signal, true)
    assert.equal(configuredParts({ ...base, signal: { sync: true, clientId: 'a', clientSecret: '' } }).signal, false)
    assert.equal(configuredParts({ ...base, signal: { sync: false, clientId: 'a', clientSecret: 'b' } }).signal, false)
    assert.equal(configuredParts(base).signal, false)
  })
})

describe('Маршруты /api/signal/* на настоящей базе', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let s
  let h
  let fake
  let logs
  let U
  let C
  let F

  const card = async (uid, id, query = '') => {
    const res = await h.get(uid, `/api/signal/contracts/${id}${query}`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  const confirmBody = (c, nodeId, over = {}) => ({ nodeId, replace: false, expectedSignalLink: c.signalLink, expectedStateVersion: c.stateVersion, idempotencyKey: key(), ...over })
  const confirm = (uid, id, body) => h.post(uid, `/api/signal/contracts/${id}/confirm`, body)
  const linkOf = (id) => one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`)
  const auditCount = (id) => Number(one(db, `select count(*) from public.contract_audit_log where contract_id = ${lit(id)} and event_type = 'signal_link'`))
  const stateOf = (id) => one(db, `select state || ':' || coalesce(reason, '') || ':' || state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)
  // Новый договор объекта A и его пересчёт очередью.
  const fresh = async (number, over = {}) => {
    const id = db.seed.contract({ number, objectId: s.A, counterparties: [s.cpR], ...over })
    await h.tick()
    return id
  }
  const noLeak = (text, ...needles) => { for (const n of needles) assert.ok(!String(text).includes(n), `в ответе есть «${n}»`) }

  before(async () => {
    db = await startSignalDb()
    s = await seedScenario(db)
    U = s.users
    C = s.contracts
    F = s.folders
    // «Шлюз» тестовой базы: правка договора от имени пользователя (в заготовке схемы у contracts только служебная политика).
    db.sql(`create policy signal_test_user on public.contracts for all to public
      using (current_setting('application_name', true) = 'osp-api') with check (current_setting('application_name', true) = 'osp-api')`)
    fake = await startFakeSignal()
    logs = []
    h = await startSignalApp(db, { fake, logs, limits: { signalSyncPerUser: { max: 100, windowMs: 60_000 }, signalWritePerUser: { max: 1000, windowMs: 60_000 } } })
    await h.tick()
  })
  after(async () => {
    await h?.close()
    await fake?.close()
    await db?.stop()
  })

  it('начальный проход очереди: состояния по снимку, очередь пуста, в Signal ни одного запроса', async () => {
    assert.equal(one(db, 'select count(*) from osp_private.signal_queue'), '0')
    const states = db.sql(`select c.contract_number || '=' || sc.state || ':' || sc.reason from osp_private.signal_contracts sc join public.contracts c on c.id = sc.contract_id order by 1`).split('\n')
    assert.deepEqual(states, [
      'АЛФ-ДП-26-001=suggested:candidates', 'АЛФ-ДП-26-002=verified:existing_url', 'АЛФ-ДП-26-003=conflict:number_mismatch',
      'АЛФ-ДП-26-009=none:none', 'БЕТ-ДП-26-001=suggested:candidates', 'ДС-1=suggested:candidates',
    ])
    assert.equal(fake.requests.length, 0, 'очередь читает только снимок в базе')
  })

  describe('права и охват', () => {
    it('подрядчик: 403 на каждом из 17 маршрутов; сотрудник без права на «Договоры»: status — «выключено», остальное — 403 от базы', async () => {
      const id = C.c1
      const node = F.f1
      const calls = [
        ['GET', '/api/signal/status'], ['GET', '/api/signal/marks'], ['GET', `/api/signal/contracts/${id}`], ['GET', `/api/signal/folders?contractId=${id}`],
        ['POST', '/api/signal/match', { contractIds: [id] }],
        ['POST', `/api/signal/contracts/${id}/confirm`, { nodeId: node, replace: false, expectedSignalLink: null, expectedStateVersion: 1, idempotencyKey: key() }],
        ['POST', `/api/signal/contracts/${id}/reject`, { nodeId: node, expectedStateVersion: 1, idempotencyKey: key() }],
        ['POST', `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: 'https://signal.example.test/x', expectedStateVersion: 1, idempotencyKey: key() }],
        ['GET', '/api/signal/aliases'], ['POST', '/api/signal/aliases', { objectId: s.A, text: 'Тест Альфа' }], ['DELETE', '/api/signal/aliases/1', {}],
        ['POST', '/api/signal/sources', { url: 'https://signal.example.test/projects/x', objectIds: [] }], ['PATCH', '/api/signal/sources/1', { enabled: false }],
        ['POST', '/api/signal/sync', {}], ['GET', '/api/signal/runs'], ['GET', '/api/signal/unassigned?sourceId=1'],
        ['POST', '/api/signal/bindings', { sourceId: 1, nodeId: node, objectId: null }],
      ]
      assert.equal(calls.length, 17)
      for (const [method, url, body] of calls) {
        const res = await h.call(U.contractor, method, url, body)
        assert.equal(res.statusCode, 403, `подрядчик ${method} ${url}`)
        noLeak(res.body, 'Альфа', 'Корпус')
      }
      // Сотрудник без права на «Договоры»: access.js его пропускает (он сотрудник), решает база.
      assert.deepEqual((await h.get(U.noRight, '/api/signal/status')).json(), { enabled: false })
      for (const [method, url, body] of calls.slice(1, 8)) {
        const res = await h.call(U.noRight, method, url, body)
        assert.equal(res.statusCode, 403, `без права ${method} ${url}`)
      }
    })

    it('просмотр без правки: значки и окно есть, предложений и путей папок нет; решения, поиск папок и сверка — 403', async () => {
      const marks = (await h.get(U.viewer, '/api/signal/marks')).json()
      const m1 = marks.items.find((m) => m.id === C.c1)
      assert.deepEqual([m1.state, m1.hasCandidate, m1.tip], ['suggested', false, 'Signal: предложена папка'])
      noLeak(JSON.stringify(marks), 'ДП АЛФ-ДП-26-001', F.f1, F.fb1)
      const c1 = await card(U.viewer, C.c1)
      assert.equal(c1.canEdit, false)
      assert.ok(!('candidates' in c1), 'у просмотра нет предложений')
      assert.equal(c1.node, null)
      const c2 = await card(U.viewer, C.c2)
      assert.equal(c2.node.path, 'Документы Альфа / Корпус 1 / ДП АЛФ-ДП-26-002 ООО Ромашка', 'связанная папка виднее: она в границе объекта договора')
      assert.equal((await h.get(U.viewer, `/api/signal/folders?contractId=${C.c1}`)).statusCode, 403)
      assert.equal((await confirm(U.viewer, C.c1, confirmBody(c1, F.f1))).statusCode, 403)
      assert.equal((await h.post(U.viewer, `/api/signal/contracts/${C.c1}/reject`, { nodeId: F.f1, expectedStateVersion: c1.stateVersion, idempotencyKey: key() })).statusCode, 403)
      assert.equal((await h.post(U.viewer, '/api/signal/match', { contractIds: [C.c1] })).statusCode, 403)
      assert.equal((await h.post(U.viewer, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Парк' })).statusCode, 403)
      assert.equal(linkOf(C.c1), '')
    })

    it('охват объектов: чужой договор — 404 без деталей (карточка, поиск папок, решения), метки — только свои', async () => {
      const own = await h.get(U.editorB, `/api/signal/contracts/${C.cb}`)
      assert.equal(own.statusCode, 200)
      const foreign = await h.get(U.editorB, `/api/signal/contracts/${C.c1}`)
      assert.equal(foreign.statusCode, 404)
      assert.deepEqual(foreign.json(), { error: 'Не найдено', code: 'not_found' })
      const missing = await h.get(U.editorB, `/api/signal/contracts/${key()}`)
      assert.equal(missing.statusCode, 404)
      assert.equal(missing.body, foreign.body, 'несуществующий и чужой договор неразличимы')
      assert.equal((await h.get(U.editorB, `/api/signal/folders?contractId=${C.c1}`)).statusCode, 404)
      for (const act of ['confirm', 'reject', 'unlink']) {
        const body = act === 'confirm' ? { nodeId: F.f1, replace: false, expectedSignalLink: null, expectedStateVersion: 1, idempotencyKey: key() }
          : act === 'reject' ? { nodeId: F.f1, expectedStateVersion: 1, idempotencyKey: key() }
            : { expectedSignalLink: 'https://signal.example.test/x', expectedStateVersion: 1, idempotencyKey: key() }
        const res = await h.post(U.editorB, `/api/signal/contracts/${C.c1}/${act}`, body)
        assert.equal(res.statusCode, 404, act)
        assert.equal(res.body, foreign.body, act)
      }
      // Метки: только договоры своего охвата; ни имён, ни путей, ни идентификаторов узлов объекта A.
      const marks = await h.get(U.editorB, '/api/signal/marks')
      const body = marks.json()
      assert.deepEqual(body.items.map((m) => m.id), [C.cb])
      noLeak(marks.body, 'Альфа', 'Корпус', 'Ромашка', F.f1, F.f2, F.k1, s.projectA)
      assert.match(body.items[0].tip, /Бета/, 'свой путь виден редактору своего объекта')
      const cardB = await card(U.editorB, C.cb)
      noLeak(JSON.stringify(cardB), 'Альфа', 'Ромашка', F.f1, s.projectA)
    })

    it('карточка: узел вне договора, потомок связанной папки и «чужой» узел', async () => {
      // c2 связан с f2; fds1 — подпапка f2: раскрытие разрешено. f4 и fb1 — не потомки: общий 403 без путей.
      const sub = await h.get(U.viewer, `/api/signal/contracts/${C.c2}?nodeId=${F.fds1}`)
      assert.equal(sub.statusCode, 200)
      assert.equal(sub.json().node.nodeId, F.fds1)
      for (const bad of [F.f4, F.fb1, F.f1, F.rootA, key()]) {
        const res = await h.get(U.viewer, `/api/signal/contracts/${C.c2}?nodeId=${bad}`)
        assert.equal(res.statusCode, 403, bad)
        assert.deepEqual(res.json(), { error: 'Недостаточно прав', code: 'forbidden' })
      }
      assert.equal((await h.get(U.viewer, `/api/signal/contracts/${C.c2}?nodeId=не-uuid`)).statusCode, 400)
    })

    it('файлы окна: ссылки на файл строятся из шаблона SIGNAL_UI_FILE_URL; у папок и удалённых файлов ссылки нет', async () => {
      const c2 = await card(U.editor, C.c2)
      const file = c2.files.find((f) => f.nodeId === s.files.f2pdf)
      assert.deepEqual(Object.keys(file).sort(), ['deleted', 'kind', 'modifiedAt', 'name', 'nodeId', 'url', 'version'])
      assert.equal(file.url, `https://signal.example.test/projects/${s.projectA}/files/${s.files.f2pdf}`)
      assert.equal(c2.files.find((f) => f.kind === 'folder').url, null)
      assert.equal(c2.confirmAvailable, true)
      assert.equal((await h.get(U.editor, '/api/signal/status')).json().fileLinks, true)
    })

    it('маршруты администратора — только администратор (сотрудник и просмотр — 403), а база повторяет проверку', async () => {
      const admin = [['GET', '/api/signal/aliases'], ['POST', '/api/signal/sources', { url: 'https://signal.example.test/projects/x', objectIds: [] }],
        ['PATCH', '/api/signal/sources/1', { enabled: true }], ['POST', '/api/signal/sync', {}], ['GET', '/api/signal/runs'],
        ['GET', '/api/signal/unassigned?sourceId=1'], ['POST', '/api/signal/bindings', { sourceId: 1, nodeId: F.k1, objectId: null }]]
      for (const uid of [U.viewer, U.editor, U.editorB, U.noRight]) {
        for (const [method, url, body] of admin) assert.equal((await h.call(uid, method, url, body)).statusCode, 403, `${method} ${url}`)
      }
      // Администратор в базе — «одобренный admin или суперадминистратор» (public.is_admin()); сервер — тот же вопрос.
      assert.equal((await h.get(U.admin, '/api/signal/runs')).statusCode, 200)
      const sdb = await db.serverDb()
      await assert.rejects(sdb.read({ userId: U.editor, email: '' }, (tx) => tx.query('select osp_private.signal_runs(5)')), (err) => err.code === 'SG403')
    })

    it('суперадминистратор: «одобренный admin или запись в superadmins» одинаково в базе (is_admin) и на сервере (REQUIREMENTS.admin)', async () => {
      const { REQUIREMENTS } = await import(path.join(SERVER, 'src', 'lib', 'access.js'))
      const mk = (role, { approved = true, blocked = false, row = true, superadmin = false } = {}) => {
        const id = db.id('sup')
        db.sql(`INSERT INTO public.roles (key, label) VALUES (${lit(role)}, ${lit(role)}) ON CONFLICT DO NOTHING`)
        if (row) db.sql(`INSERT INTO public.user_roles (user_id, role, is_approved, is_blocked, email) VALUES (${lit(id)}, ${lit(role)}, ${approved && !blocked}, ${blocked}, ${lit(`${id}@example.invalid`)})`)
        if (superadmin) db.sql(`INSERT INTO public.superadmins (user_id) VALUES (${lit(id)})`)
        return id
      }
      const cases = {
        'admin одобрен': mk('admin'),
        'admin не одобрен': mk('admin', { approved: false }),
        'admin заблокирован': mk('admin', { blocked: true }),
        'инженер': mk('engineer'),
        'суперадмин с ролью инженера': mk('engineer', { superadmin: true }),
        'суперадмин без строки ролей': mk('engineer', { row: false, superadmin: true }),
      }
      const isSuper = async (id) => one(db, `select exists (select 1 from public.superadmins where user_id = ${lit(id)})`) === 't'
      const out = {}
      for (const [name, id] of Object.entries(cases)) {
        // is_admin() читает user_roles под правилами по строкам: из сессии пользователя — через функцию с отметкой службы (как её зовёт сама сверка).
        const dbSays = db.asJson(id, "select osp_private.signal_user_flags() -> 'isAdmin'") === true
        const roleRow = db.sql(`select to_jsonb(r) from (select role, is_approved, is_blocked from public.user_roles where user_id = ${lit(id)}) r`).split('\n').filter(Boolean).at(-1)
        const row = roleRow ? JSON.parse(roleRow) : null
        const serverSays = Boolean(await REQUIREMENTS.admin(row, { auth: { user: { id } }, isSuperadmin: isSuper }))
        assert.equal(serverSays, dbSays, name)
        out[name] = dbSays
      }
      assert.deepEqual(out, {
        'admin одобрен': true, 'admin не одобрен': false, 'admin заблокирован': false, 'инженер': false, 'суперадмин с ролью инженера': true, 'суперадмин без строки ролей': true,
      })
      // База пускает суперадминистратора к функциям администратора.
      const sdb = await db.serverDb()
      const who = { userId: cases['суперадмин с ролью инженера'], email: '' }
      assert.ok(await sdb.read(who, async (tx) => (await tx.query('select osp_private.signal_runs(1) as r')).rows[0].r))
    })

    it('маршрутов Signal нет в списке открытых; каждый объявлен как «user»', async () => {
      const { OPEN_ROUTES } = await import(path.join(SERVER, 'src', 'open-routes.js'))
      assert.equal(OPEN_ROUTES.filter((r) => r.url.includes('/signal')).length, 0)
      const own = h.app.accessTable.filter((r) => r.url.startsWith('/api/signal/'))
      assert.equal(own.length, 17)
      assert.ok(own.every((r) => r.kind === 'user' && (r.require === 'employeeOrSuperadmin' || r.require === 'admin')))
    })
  })

  describe('status, marks, folders', () => {
    it('status: просмотр, правка, администратор; ключей и идентификаторов Signal в ответе нет', async () => {
      const viewer = (await h.get(U.viewer, '/api/signal/status')).json()
      assert.deepEqual(Object.keys(viewer).sort(), ['canEdit', 'canView', 'confirmAvailable', 'dataAt', 'enabled', 'fileLinks', 'generation', 'isAdmin'])
      assert.deepEqual([viewer.enabled, viewer.canView, viewer.canEdit, viewer.isAdmin, viewer.generation], [true, true, false, false, 1])
      assert.match(viewer.dataAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
      const admin = await h.get(U.admin, '/api/signal/status')
      const body = admin.json()
      assert.equal(body.isAdmin, true)
      assert.equal(body.connection, 'configured')
      assert.equal(body.dayMode, 'full')
      assert.deepEqual(body.sources.map((x) => x.projectName), ['Тест: проект Альфа', 'Тест: проект Бета'])
      assert.deepEqual(Object.keys(body.sources[0]).sort(), ['enabled', 'folders', 'id', 'items', 'lastError', 'lastNightOkAt', 'lastOkAt', 'objects', 'projectName', 'ready', 'rootPath'])
      assert.equal(typeof body.sources[0].id, 'number')
      noLeak(admin.body, CLIENT_SECRET, CLIENT_ID, s.projectA, s.srcA.folderId)
      assert.equal(admin.headers['cache-control'], 'private, no-store')
    })

    it('marks: страницы по курсору, предел и неверные параметры', async () => {
      const first = (await h.get(U.editor, '/api/signal/marks?limit=2')).json()
      assert.equal(first.items.length, 2)
      assert.ok(first.next)
      const rest = []
      let after = first.next
      while (after) {
        const page = (await h.get(U.editor, `/api/signal/marks?limit=2&after=${after}`)).json()
        rest.push(...page.items)
        after = page.next
      }
      const all = (await h.get(U.editor, '/api/signal/marks')).json().items
      assert.deepEqual([...first.items, ...rest].map((m) => m.id), all.map((m) => m.id))
      for (const q of ['limit=0', 'limit=1001', 'limit=x', 'after=не-uuid']) assert.equal((await h.get(U.editor, `/api/signal/marks?${q}`)).statusCode, 400, q)
      // Подсказки по состояниям (раздел 8): без чужих путей, дата — по Москве.
      const byId = Object.fromEntries(all.map((m) => [m.id, m]))
      assert.match(byId[C.c1].tip, /^Signal: предложена папка Документы Альфа \/ Корпус 1 \/ ДП АЛФ-ДП-26-001/)
      assert.match(byId[C.c2].tip, /^Signal: сверено \d{2}\.\d{2}\.\d{4} · Документы Альфа/)
      assert.equal(byId[C.c3].tip, 'Signal: ссылки нет')
      assert.equal(byId[C.c4].tip, 'Signal: противоречие — номер в названии папки не совпал с номером договора')
    })

    it('договор в очереди — «ожидает»: ссылка есть — не сверялась, ссылки нет — «нет»; после такта очереди — пересчёт', async () => {
      const withLink = db.seed.contract({ number: 'АЛФ-ДП-26-010', objectId: s.A, signalLink: s.urlOf(F.f2) })
      const noLink = db.seed.contract({ number: 'АЛФ-ДП-26-011', objectId: s.A })
      const m = (await h.get(U.editor, '/api/signal/marks')).json().items
      const a = m.find((x) => x.id === withLink)
      const b = m.find((x) => x.id === noLink)
      assert.deepEqual([a.state, a.reason, a.pending, a.tip], ['unverified', 'pending', true, 'Signal: ссылка не сверялась'])
      assert.deepEqual([b.state, b.reason, b.pending, b.tip], ['none', 'none', true, 'Signal: ссылки нет'])
      const cardPending = await card(U.editor, withLink)
      assert.deepEqual([cardPending.state, cardPending.reason, cardPending.pending], ['unverified', 'pending', true])
      await h.tick()
      const after = (await h.get(U.editor, '/api/signal/marks')).json().items.find((x) => x.id === withLink)
      assert.equal(after.pending, false)
      assert.match(after.state, /^(conflict|verified)$/, 'ссылка на папку другого договора пересчитана')
    })

    it('folders: поиск папок объекта договора — только при правке, только объекта договора, страницами', async () => {
      const res = await h.get(U.editor, `/api/signal/folders?contractId=${C.c1}&q=${encodeURIComponent('корпус 2')}`)
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.ok(body.items.length >= 1)
      assert.ok(body.items.every((f) => f.path.includes('Корпус 2')))
      noLeak(res.body, 'Бета', F.fb1, s.projectB)
      const all = (await h.get(U.editor, `/api/signal/folders?contractId=${C.c1}&limit=3`)).json()
      assert.equal(all.items.length, 3)
      assert.ok(all.next)
      const next = (await h.get(U.editor, `/api/signal/folders?contractId=${C.c1}&limit=3&after=${encodeURIComponent(all.next)}`)).json()
      assert.ok(next.items.every((f) => !all.items.some((x) => x.nodeId === f.nodeId)))
      // Бета-папок у договора объекта A нет ни под каким запросом.
      const beta = (await h.get(U.editor, `/api/signal/folders?contractId=${C.c1}&q=${encodeURIComponent('Бета')}`)).json()
      assert.deepEqual(beta.items, [])
      for (const q of ['q=' + 'x'.repeat(101), 'limit=101', 'limit=0']) assert.equal((await h.get(U.editor, `/api/signal/folders?contractId=${C.c1}&${q}`)).statusCode, 400, q)
      assert.equal((await h.get(U.editor, '/api/signal/folders')).statusCode, 400)
    })
  })

  describe('решения человека: confirm, reject, unlink', () => {
    it('confirm: ссылка, состояние, кандидаты и событие «Истории» — одной записью; повтор с тем же ключом — тот же ответ без второго события', async () => {
      // Договор 001 → предложенная папка f1 (по номеру).
      const c = await card(U.editor, C.c1)
      assert.equal(c.candidates[0].nodeId, F.f1)
      const body = confirmBody(c, F.f1)
      const first = await confirm(U.editor, C.c1, body)
      assert.equal(first.statusCode, 200, first.body)
      const out = first.json()
      assert.deepEqual([out.state, out.reason, out.stateVersion], ['verified', 'confirmed', c.stateVersion + 1])
      assert.equal(out.signalLink, s.urlOf(F.f1))
      assert.equal(linkOf(C.c1), s.urlOf(F.f1))
      assert.equal(auditCount(C.c1), 1)
      assert.equal(one(db, `select description from public.contract_audit_log where contract_id = ${lit(C.c1)} and event_type = 'signal_link'`), 'Signal: связь подтверждена')
      assert.equal(one(db, `select count(*) from osp_private.signal_candidates where contract_id = ${lit(C.c1)} and status = 'open'`), '0')
      assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(C.c1)}`), '0', 'очередь договора считается обработанной')
      // Тот же ключ: тот же ответ, второго события нет, версия прежняя.
      const again = await confirm(U.editor, C.c1, body)
      assert.equal(again.statusCode, 200)
      assert.deepEqual(again.json(), out)
      assert.equal(auditCount(C.c1), 1)
      assert.equal(stateOf(C.c1), `verified:confirmed:${out.stateVersion}`)
      // Окно теперь показывает связанную папку и файлы со ссылками.
      const after = await card(U.editor, C.c1)
      assert.deepEqual([after.state, after.reason, after.signalLink], ['verified', 'confirmed', s.urlOf(F.f1)])
      assert.equal(after.node.nodeId, F.f1)
      assert.ok(after.files.some((f) => f.name === 'Договор.pdf' && f.url === `https://signal.example.test/projects/${s.projectA}/files/${s.files.contractPdf}` && f.version === 2))
      assert.deepEqual(after.candidates, [])
      // Пересчёт очередью (публикация, правка соседнего) подтверждение не сбрасывает: тот же узел и тот же шаблон.
      db.sql(`select osp_private.signal_enqueue_all()`)
      await h.tick()
      assert.match(stateOf(C.c1), /^verified:confirmed:/)
    })

    it('confirm: устаревшая версия или ссылка — 409 без частичных записей (ссылка, синоним, «История» не тронуты)', async () => {
      const id = await fresh('АЛФ-ДП-26-021')
      const c = await card(U.editor, id)
      const before = stateOf(id)
      const stale = await confirm(U.editor, id, confirmBody(c, F.k1, { expectedStateVersion: c.stateVersion + 5, rememberAlias: 'Альфа Поселок' }))
      assert.equal(stale.statusCode, 409)
      assert.deepEqual(stale.json(), { error: 'Данные изменились — откройте сверку заново', code: 'stale_state' })
      const staleLink = await confirm(U.editor, id, confirmBody(c, F.k1, { expectedSignalLink: 'https://signal.example.test/projects/p/folders/f', rememberAlias: 'Альфа Поселок' }))
      assert.equal(staleLink.statusCode, 409)
      assert.equal(linkOf(id), '')
      assert.equal(auditCount(id), 0)
      assert.equal(stateOf(id), before)
      assert.equal(one(db, `select count(*) from osp_private.signal_aliases where alias_key = 'альфа поселок'`), '0')
    })

    it('confirm: другая непустая ссылка без «Заменить» — 409 replace_required; с «Заменить» — ссылка заменена, событие «ссылка заменена»', async () => {
      // Договор 004 со ссылкой на «чужую» папку f1: папка f4 с его номером подтверждается только заменой.
      const id = await fresh('АЛФ-ДП-26-004', { signalLink: s.urlOf(F.f1) })
      const c = await card(U.editor, id)
      assert.equal(c.state, 'conflict')
      const no = await confirm(U.editor, id, confirmBody(c, F.f4))
      assert.equal(no.statusCode, 409)
      assert.deepEqual(no.json(), { error: 'У договора уже есть другая ссылка — нажмите «Заменить»', code: 'replace_required' })
      assert.equal(linkOf(id), s.urlOf(F.f1))
      assert.equal(auditCount(id), 0)
      const yes = await confirm(U.editor, id, confirmBody(c, F.f4, { replace: true }))
      assert.equal(yes.statusCode, 200, yes.body)
      assert.equal(linkOf(id), s.urlOf(F.f4))
      assert.equal(one(db, `select description from public.contract_audit_log where contract_id = ${lit(id)} and event_type = 'signal_link'`), 'Signal: ссылка заменена')
    })

    it('confirm: ссылка договора на тот же узел в другом виде (регистр uuid, query и fragment, второй шаблон) — не замена: 200 без «Заменить», ссылка и её строка не меняются, событие «Истории» есть', async () => {
      // База сравнивает ссылки строками: ссылку в другом допустимом виде она сочла бы заменой (replace_required) — маршрут передаёт текущую.
      const ALT = `${HOST}/p/{projectId}/f/{folderId}`
      const h2 = await startSignalApp(db, { fake, signal: { urlFormats: [FOLDER_FORMAT, ITEM_FORMAT, ALT] }, limits: { signalWritePerUser: { max: 1000, windowMs: 60_000 } } })
      try {
        const P = s.projectA
        const variants = [
          ['регистр uuid', `${HOST}/projects/${P.toUpperCase()}/folders/${F.f4.toUpperCase()}`],
          ['query и fragment', `${s.urlOf(F.f4)}?tab=x#files`],
          ['второй шаблон', `${HOST}/p/${P}/f/${F.f4}`],
        ]
        for (const [label, link] of variants) {
          assert.notEqual(link, s.urlOf(F.f4), label)
          const id = db.seed.contract({ number: 'АЛФ-ДП-26-004', objectId: s.A, counterparties: [s.cpR], signalLink: link })
          await h2.tick()
          const c = (await h2.get(U.editor, `/api/signal/contracts/${id}`)).json()
          assert.equal(c.signalLink, link, label)
          // Клиент, не видевший эту ссылку, получает stale_state: подмена текущей ссылки только при совпадении expectedSignalLink.
          const stale = await h2.post(U.editor, `/api/signal/contracts/${id}/confirm`, confirmBody(c, F.f4, { expectedSignalLink: null }))
          assert.deepEqual([stale.statusCode, stale.json().code], [409, 'stale_state'], label)
          assert.equal(auditCount(id), 0, label)

          const res = await h2.post(U.editor, `/api/signal/contracts/${id}/confirm`, confirmBody(c, F.f4))
          assert.equal(res.statusCode, 200, `${label}: ${res.body}`)
          const out = res.json()
          assert.deepEqual([out.state, out.reason, out.stateVersion, out.signalLink], ['verified', 'confirmed', c.stateVersion + 1, link], label)
          assert.equal(linkOf(id), link, `${label}: строка ссылки договора не изменилась`)
          assert.equal(auditCount(id), 1, label)
          assert.equal(one(db, `select description from public.contract_audit_log where contract_id = ${lit(id)} and event_type = 'signal_link'`), 'Signal: связь подтверждена', label)
          assert.equal(stateOf(id), `verified:confirmed:${out.stateVersion}`, label)
        }
      } finally {
        await h2.close()
      }
    })

    it('confirm: жёсткое противоречие — 409 hard_conflict без обращения к SQL; неподтверждаемое — confirm_unavailable', async () => {
      // Договор 009 и папка f2 с номером 002.
      const c = await card(U.editor, C.c3)
      const watch = db.sql(`select count(*) from public.contract_audit_log`)
      const res = await confirm(U.editor, C.c3, confirmBody(c, F.f2))
      assert.equal(res.statusCode, 409)
      assert.deepEqual(res.json(), { error: 'Папка противоречит данным договора — подтвердить нельзя', code: 'hard_conflict' })
      assert.equal(linkOf(C.c3), '')
      assert.equal(db.sql(`select count(*) from public.contract_audit_log`), watch)
      // ДС, чья папка договора неизвестна, — «семья не определена»: подтверждать нельзя.
      const orphan = await fresh('ДС-9', { recordType: 'ds_vor', parent: null })
      const oc = await card(U.editor, orphan)
      const na = await confirm(U.editor, orphan, confirmBody(oc, F.k1))
      assert.equal(na.statusCode, 409)
      assert.equal(na.json().code, 'confirm_unavailable')
      assert.equal(linkOf(orphan), '')
    })

    it('confirm: папка другого объекта или несуществующая — 422 node_unavailable без имён; файл вместо папки — тоже', async () => {
      const id = await fresh('АЛФ-ДП-26-022')
      const c = await card(U.editor, id)
      for (const node of [F.fb1, key(), s.files.f2pdf]) {
        const res = await confirm(U.editor, id, confirmBody(c, node))
        assert.equal(res.statusCode, 422, node)
        assert.deepEqual(res.json(), { error: 'Папка вне доступного объекта', code: 'node_unavailable' })
      }
      assert.equal(linkOf(id), '')
    })

    it('confirm: синоним — запоминается; совпадение с названием чужого объекта — 409 до записи; занятый другим объектом — 409 и откат всего', async () => {
      const id = await fresh('АЛФ-ДП-26-023')
      const c = await card(U.editor, id)
      const mine = await confirm(U.editor, id, confirmBody(c, F.k1, { rememberAlias: '  «Альфа  Парк» ' }))
      assert.equal(mine.statusCode, 200, mine.body)
      assert.equal(one(db, `select alias_text || '|' || alias_key from osp_private.signal_aliases where object_id = ${lit(s.A)}`), '«Альфа  Парк»|альфа парк')
      // Название чужого объекта и его код.
      for (const [i, text] of ['тест: жк бета', 'БЕТ'].entries()) {
        const id2 = await fresh(`АЛФ-ДП-26-03${i}`)
        const c2 = await card(U.editor, id2)
        const res = await confirm(U.editor, id2, confirmBody(c2, F.k1, { rememberAlias: text }))
        assert.equal(res.statusCode, 409, text)
        assert.deepEqual(res.json(), { error: 'Название уже используется', code: 'alias_taken' })
        assert.equal(linkOf(id2), '', 'ссылка не записана')
        assert.equal(auditCount(id2), 0)
      }
      // Синоним объекта B (создан его редактором) занят: у объекта A тот же ключ — база откатывает ссылку, синоним и «Историю».
      assert.equal((await h.post(U.editorB, '/api/signal/aliases', { objectId: s.B, text: 'Общий Двор' })).statusCode, 200)
      const id3 = await fresh('АЛФ-ДП-26-024')
      const c3 = await card(U.editor, id3)
      const clash = await confirm(U.editor, id3, confirmBody(c3, F.k1, { rememberAlias: 'общий двор' }))
      assert.equal(clash.statusCode, 409)
      assert.equal(clash.json().code, 'alias_taken')
      assert.equal(linkOf(id3), '')
      assert.equal(auditCount(id3), 0)
      assert.equal(stateOf(id3), `none:none:${c3.stateVersion}`)
    })

    it('синоним объекта не открывает папку чужого объекта: договор объекта A не получает в предложения папку объекта B', async () => {
      // У объекта A появился синоним «Лютик» — так называется папка объекта B; граница объекта остаётся границей.
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Лютик' })).statusCode, 200)
      const id = await fresh('АЛФ-ДП-26-025')
      const c = await card(U.editor, id)
      noLeak(JSON.stringify(c), 'Бета', 'Лютик', F.fb1, s.projectB)
      const found = await h.get(U.editor, `/api/signal/folders?contractId=${id}&q=${encodeURIComponent('Лютик')}`)
      assert.deepEqual(found.json().items, [])
      const res = await confirm(U.editor, id, confirmBody(c, F.fb1))
      assert.equal(res.statusCode, 422)
      assert.equal(linkOf(id), '')
    })

    it('параллельные сессии: confirm и unlink с одной версией — одна 200, другая 409; replace и replace — тоже', async () => {
      // Договор со связью, подтверждённой человеком.
      const id = await fresh('АЛФ-ДП-26-026', { signalLink: s.urlOf(F.k1) })
      const c0 = await card(U.editor, id)
      const [a, b] = await Promise.all([
        confirm(U.editor, id, confirmBody(c0, F.k2, { replace: true })),
        h.post(U.editor, `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: c0.signalLink, expectedStateVersion: c0.stateVersion, idempotencyKey: key() }),
      ])
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} | ${b.body}`)
      const loser = a.statusCode === 409 ? a : b
      assert.equal(loser.json().code, 'stale_state')
      assert.equal(auditCount(id), 1, 'событие записал только победитель')
      // replace / replace с двух вкладок.
      const id2 = await fresh('АЛФ-ДП-26-027', { signalLink: s.urlOf(F.k1) })
      const c1 = await card(U.editor, id2)
      const [x, y] = await Promise.all([
        confirm(U.editor, id2, confirmBody(c1, F.k2, { replace: true })),
        confirm(U.editor, id2, confirmBody(c1, F.rootA, { replace: true })),
      ])
      assert.deepEqual([x.statusCode, y.statusCode].sort(), [200, 409], `${x.body} | ${y.body}`)
      assert.equal(auditCount(id2), 1)
      assert.ok([s.urlOf(F.k2), s.urlOf(F.rootA)].includes(linkOf(id2)))
    })

    it('reject: пара отклонена, договор — «нет ссылки»; следующий пересчёт её не предлагает; устаревшая версия и чужая пара — 409; событие без пути', async () => {
      const id = await fresh('АЛФ-ДП-26-004', { objectId: s.A })
      const c = await card(U.editor, id)
      assert.deepEqual(c.candidates.map((x) => x.nodeId), [F.f4])
      const stale = await h.post(U.editor, `/api/signal/contracts/${id}/reject`, { nodeId: F.f4, expectedStateVersion: c.stateVersion + 3, idempotencyKey: key() })
      assert.equal(stale.statusCode, 409)
      const notOpen = await h.post(U.editor, `/api/signal/contracts/${id}/reject`, { nodeId: F.f1, expectedStateVersion: c.stateVersion, idempotencyKey: key() })
      assert.equal(notOpen.statusCode, 409, 'отклонять можно только предложенную пару')
      const body = { nodeId: F.f4, note: 'не та очередь', expectedStateVersion: c.stateVersion, idempotencyKey: key() }
      const res = await h.post(U.editor, `/api/signal/contracts/${id}/reject`, body)
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual([res.json().state, res.json().reason, res.json().stateVersion], ['none', 'none', c.stateVersion + 1])
      assert.deepEqual(await h.post(U.editor, `/api/signal/contracts/${id}/reject`, body).then((r) => r.json()), res.json(), 'повтор ключа — тот же ответ')
      assert.equal(auditCount(id), 1)
      const event = db.sql(`select description from public.contract_audit_log where contract_id = ${lit(id)} and event_type = 'signal_link'`)
      noLeak(event, 'Корпус', 'Альфа')
      db.sql(`select osp_private.signal_enqueue_all()`)
      await h.tick()
      assert.match(stateOf(id), /^none:none:/)
      assert.deepEqual((await card(U.editor, id)).candidates, [])
    })

    it('unlink: ссылка снята, «нет ссылки (связь снята)», пара не предлагается; чужая версия — 409; повтор ключа — без второго события', async () => {
      const id = await fresh('АЛФ-ДП-26-004', { signalLink: s.urlOf(F.f4) })
      const c = await card(U.editor, id)
      assert.equal(c.state, 'verified')
      const stale = await h.post(U.editor, `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: s.urlOf(F.f1), expectedStateVersion: c.stateVersion, idempotencyKey: key() })
      assert.equal(stale.statusCode, 409)
      const body = { expectedSignalLink: c.signalLink, expectedStateVersion: c.stateVersion, idempotencyKey: key() }
      const res = await h.post(U.editor, `/api/signal/contracts/${id}/unlink`, body)
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual([res.json().state, res.json().reason], ['none', 'unlinked'])
      assert.equal(linkOf(id), '')
      assert.deepEqual(await h.post(U.editor, `/api/signal/contracts/${id}/unlink`, body).then((r) => r.json()), res.json())
      assert.equal(auditCount(id), 1)
      db.sql(`select osp_private.signal_enqueue_all()`)
      await h.tick()
      assert.match(stateOf(id), /^none:unlinked:/, 'отвязанная пара не предлагается, пока контекст договора тот же')
      assert.deepEqual((await card(U.editor, id)).candidates, [])
      // Пустая ссылка в теле — не запрос.
      assert.equal((await h.post(U.editor, `/api/signal/contracts/${id}/unlink`, { expectedSignalLink: '', expectedStateVersion: 1, idempotencyKey: key() })).statusCode, 400)
    })

    it('Ф6: правка ссылки «как через шлюз» — значок «ожидает», после такта очереди состояние пересчитано по новой ссылке; смена номера и объекта сбрасывает «сверено»', async () => {
      const id = await fresh('АЛФ-ДП-26-002', { signalLink: s.urlOf(F.f2) })
      assert.match(stateOf(id), /^verified:existing_url/)
      // Правка ссылки: UPDATE от имени пользователя, как делает шлюз для окна путей.
      db.as(U.editor, `update public.contracts set signal_link = ${lit(s.urlOf(F.f4))} where id = ${lit(id)}`)
      const pending = (await h.get(U.editor, '/api/signal/marks')).json().items.find((m) => m.id === id)
      assert.deepEqual([pending.state, pending.reason, pending.pending], ['unverified', 'pending', true])
      await h.tick()
      assert.match(stateOf(id), /^conflict:number_mismatch/, 'папка f4 — с номером 004')
      // Номер вернули на подходящий — ссылка снова сверена.
      db.as(U.editor, `update public.contracts set contract_number = 'АЛФ-ДП-26-004' where id = ${lit(id)}`)
      await h.tick()
      assert.match(stateOf(id), /^verified:existing_url/)
      // Объект сменили — вне границы корня объекта.
      db.as(U.editor, `update public.contracts set object_id = ${lit(s.B)} where id = ${lit(id)}`)
      await h.tick()
      assert.match(stateOf(id), /^unverified:outside_roots/)
    })

    it('D4: смена стороны договора (добавить, заменить, удалить в contract_counterparties) у «сверено» — значок «ожидает», после такта очереди состояние пересчитано', async () => {
      const id = await fresh('АЛФ-ДП-26-002', { signalLink: s.urlOf(F.f2) })
      assert.match(stateOf(id), /^verified:existing_url/)
      // Правка сторон — от имени пользователя, как делает шлюз для таблицы связей (в заготовке схемы у неё только служебная политика).
      db.sql(`drop policy if exists signal_test_user on public.contract_counterparties;
        create policy signal_test_user on public.contract_counterparties for all to public
        using (current_setting('application_name', true) = 'osp-api') with check (current_setting('application_name', true) = 'osp-api')`)
      const fingerprintOf = () => one(db, `select coalesce(fingerprint, '') from osp_private.signal_contracts where contract_id = ${lit(id)}`)
      const markOf = async () => (await h.get(U.editor, '/api/signal/marks')).json().items.find((m) => m.id === id)
      const settled = await markOf()
      assert.deepEqual([settled.state, settled.pending], ['verified', false])
      assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`), '0')

      const cpExtra = db.seed.counterparty({ name: 'ООО Одуванчик' })
      const cpNext = db.seed.counterparty({ name: 'ООО Василёк' })
      const steps = [
        ['добавлена сторона', `insert into public.contract_counterparties (contract_id, counterparty_id, sort_order) values (${lit(id)}, ${lit(cpExtra)}, 1)`],
        ['сторона заменена', `update public.contract_counterparties set counterparty_id = ${lit(cpNext)} where contract_id = ${lit(id)} and counterparty_id = ${lit(cpExtra)}`],
        ['сторона удалена', `delete from public.contract_counterparties where contract_id = ${lit(id)} and counterparty_id = ${lit(cpNext)}`],
      ]
      for (const [what, sql] of steps) {
        const fingerprint = fingerprintOf()
        const version = stateOf(id).split(':').at(-1)
        db.as(U.editor, sql)
        assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`), '1', `${what}: договор в очереди`)
        const pending = await markOf()
        assert.deepEqual([pending.state, pending.reason, pending.pending], ['unverified', 'pending', true], `${what}: значок «ожидает»`)
        assert.equal(pending.tip, 'Signal: ссылка не сверялась')
        const cardPending = await card(U.editor, id)
        assert.deepEqual([cardPending.state, cardPending.pending], ['unverified', true], `${what}: окно сверки`)
        await h.tick()
        assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(id)}`), '0', `${what}: очередь опустела`)
        const settledAgain = await markOf()
        assert.equal(settledAgain.pending, false, `${what}: пересчитано`)
        assert.match(settledAgain.state, /^(verified|suggested|conflict)$/, `${what}: состояние по новым сторонам`)
        assert.notEqual(fingerprintOf(), fingerprint, `${what}: отпечаток (контекст договора) пересчитан по новому составу сторон`)
        assert.ok(Number(stateOf(id).split(':').at(-1)) >= Number(version), `${what}: версия состояния не откатилась`)
      }
      assert.match(stateOf(id), /^verified:existing_url/, 'исходный состав сторон вернулся — «сверено» по ссылке')
    })

    it('смена ДП пересчитывает ДС: пока номер ДП совпадает с папкой — «сверено», после смены номера — «папка договора не определена»', async () => {
      const dp = await fresh('АЛФ-ДП-26-002', { signalLink: s.urlOf(F.f2) })
      const ds = await fresh('ДС-1', { recordType: 'ds_vor', parent: dp, signalLink: s.urlOf(F.fds1) })
      assert.match(stateOf(ds), /^verified:existing_url/)
      db.as(U.editor, `update public.contracts set contract_number = 'АЛФ-ДП-26-005' where id = ${lit(dp)}`)
      assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id in (${lit(dp)}, ${lit(ds)})`), '2', 'в очереди и ДП, и его ДС')
      await h.tick()
      assert.match(stateOf(ds), /^unverified:family_unknown/)
    })
  })

  describe('синонимы', () => {
    it('создать: право правки и охват объекта; название слишком короткое и совпадение с названием другого объекта — отказ', async () => {
      const ok = await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Резиденс' })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal(typeof ok.json().id, 'number')
      const dup = await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: ' альфа  резиденс ' })
      assert.equal(dup.statusCode, 409)
      assert.deepEqual(dup.json(), { error: 'Название уже используется', code: 'alias_taken' })
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Тест: ЖК Бета' })).statusCode, 409)
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'бет' })).statusCode, 409, 'код другого объекта')
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: '«»' })).statusCode, 422)
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'a' })).statusCode, 400)
      // Охват: редактор объекта B не создаёт синоним объекту A и не узнаёт, чьё это название.
      const foreign = await h.post(U.editorB, '/api/signal/aliases', { objectId: s.A, text: 'Тест: ЖК Альфа 2' })
      assert.equal(foreign.statusCode, 403)
      const probe = await h.post(U.editorB, '/api/signal/aliases', { objectId: s.A, text: 'Тест: ЖК Бета' })
      assert.equal(probe.statusCode, 403, 'до проверки охвата названия чужих объектов не раскрываются')
      assert.equal((await h.post(U.editor, '/api/signal/aliases', { objectId: key(), text: 'Нет Такого' })).statusCode, 404)
    })

    it('список — только администратору (автор по ФИО); удалить: автор с правом правки, администратор; чужой сотрудник — 403', async () => {
      const mine = (await h.post(U.editor, '/api/signal/aliases', { objectId: s.A, text: 'Альфа Лофт' })).json().id
      const list = await h.get(U.admin, '/api/signal/aliases')
      assert.equal(list.statusCode, 200)
      const item = list.json().items.find((x) => x.id === mine)
      assert.deepEqual([item.text, item.objectId, item.objectName], ['Альфа Лофт', s.A, 'Тест: ЖК Альфа'])
      assert.ok(item.author)
      const other = db.seed.user({ contracts: 'edit' })
      assert.equal((await h.call(other, 'DELETE', `/api/signal/aliases/${mine}`, {})).statusCode, 403)
      assert.equal((await h.call(U.viewer, 'DELETE', `/api/signal/aliases/${mine}`, {})).statusCode, 403)
      assert.equal((await h.call(U.editor, 'DELETE', `/api/signal/aliases/${mine}`, {})).statusCode, 200)
      assert.equal((await h.call(U.editor, 'DELETE', `/api/signal/aliases/${mine}`, {})).statusCode, 404)
      const admins = (await h.post(U.editorB, '/api/signal/aliases', { objectId: s.B, text: 'Бета Лофт' })).json().id
      assert.equal((await h.call(U.admin, 'DELETE', `/api/signal/aliases/${admins}`, {})).statusCode, 200)
      assert.equal((await h.call(U.admin, 'DELETE', '/api/signal/aliases/не-число', {})).statusCode, 400)
    })
  })

  describe('администратор: корни, границы, обход', () => {
    let G
    let projectG
    let ids
    const runs = async (uid = U.admin) => (await h.get(uid, '/api/signal/runs')).json().items
    const waitRun = async (runId, ms = 30000) => {
      const t = Date.now()
      for (;;) {
        const r = (await runs()).find((x) => x.id === runId)
        if (r && r.status !== 'running') return r
        if (Date.now() - t > ms) throw new Error('обход не завершился')
        await sleep(100)
      }
    }
    const root = (projectId, folderId) => ({ url: folderUrl(projectId, folderId) })

    before(() => {
      G = db.seed.object({ name: 'Тест: ЖК Гамма', code: 'ГАМ' })
      projectG = fake.addProject({ name: 'Тест: проект Гамма' })
      ;({ ids } = fake.build(projectG, {
        name: 'Объект Гамма', items: 2,
        children: [{ name: 'Договоры', children: [{ name: 'ДП ГАМ-ДП-26-001 ООО Тест', items: 3 }] }],
      }))
    })

    it('корень выключают и включают: выключенный корень — договоры «корень выключен», папки пропадают из окна; повтор такта очереди пересчитал', async () => {
      const off = await h.call(U.admin, 'PATCH', `/api/signal/sources/${s.srcA.id}`, { enabled: false })
      assert.deepEqual(off.json(), { ok: true })
      await h.tick()
      assert.match(stateOf(C.c2), /^unverified:root_disabled/)
      const cardOff = await card(U.viewer, C.c2)
      assert.equal(cardOff.node, null, 'папка выключенного корня договору не видна')
      const shown = (await h.get(U.admin, '/api/signal/status')).json().sources.find((x) => x.id === s.srcA.id)
      assert.deepEqual([shown.enabled, shown.ready, shown.objects, shown.projectName], [false, false, [{ id: s.A, name: 'Тест: ЖК Альфа' }], 'Тест: проект Альфа'])
      assert.equal((await h.call(U.admin, 'PATCH', `/api/signal/sources/${s.srcB.id}`, { enabled: false })).statusCode, 200)
      assert.equal((await h.call(U.admin, 'PATCH', `/api/signal/sources/${s.srcA.id}`, {})).statusCode, 400, 'пустая правка — не запрос')
      assert.equal((await h.call(U.admin, 'PATCH', '/api/signal/sources/99999', { enabled: true })).statusCode, 404)
      assert.equal((await h.call(U.admin, 'PATCH', `/api/signal/sources/${s.srcA.id}`, { objectIds: [key()] })).statusCode, 422)
    })

    it('обход без включённых корней — 409 no_sources', async () => {
      const res = await h.post(U.admin, '/api/signal/sync', {})
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().code, 'no_sources')
    })

    it('добавить корень: ссылка разбирается и сверяется с деревом проекта; перекрытие, повтор, чужой формат и нет папки — отказ', async () => {
      assert.equal((await h.post(U.admin, '/api/signal/sources', { url: 'https://evil.example.invalid/projects/x/folders/y', objectIds: [] })).statusCode, 422)
      assert.equal((await h.post(U.admin, '/api/signal/sources', { url: 'не ссылка', objectIds: [] })).statusCode, 422)
      assert.equal((await h.post(U.admin, '/api/signal/sources', { url: folderUrl(projectG, key()), objectIds: [] })).statusCode, 422, 'папки нет в дереве проекта')
      assert.equal((await h.post(U.admin, '/api/signal/sources', { url: `https://signal.example.test/projects/${projectG}/files/${ids['Объект Гамма']}`, objectIds: [] })).statusCode, 422, 'ссылка на файл — не корень')
      assert.equal((await h.post(U.admin, '/api/signal/sources', { ...root(projectG, ids['Объект Гамма']), objectIds: [key()] })).statusCode, 422, 'объекта нет')
      assert.equal(fake.violations.length, 0, 'в Signal только чтение')
      const ok = await h.post(U.admin, '/api/signal/sources', { ...root(projectG, ids['Объект Гамма']), objectIds: [G] })
      assert.equal(ok.statusCode, 200, ok.body)
      const added = ok.json()
      assert.equal(added.projectName, 'Тест: проект Гамма')
      assert.equal(added.rootPath, 'Документы / Объект Гамма', 'путь корня — из дерева Signal, от верхней папки проекта')
      assert.equal(typeof added.id, 'number')
      const dup = await h.post(U.admin, '/api/signal/sources', { ...root(projectG, ids['Объект Гамма']), objectIds: [G] })
      assert.equal(dup.statusCode, 409)
      assert.equal(dup.json().code, 'busy')
      const inner = await h.post(U.admin, '/api/signal/sources', { ...root(projectG, ids['Объект Гамма / Договоры']), objectIds: [G] })
      assert.equal(inner.statusCode, 409)
      assert.equal(inner.json().code, 'overlap')
      const outer = await h.post(U.admin, '/api/signal/sources', { ...root(projectG, fake.rootOf(projectG)), objectIds: [G] })
      assert.equal(outer.statusCode, 409)
      assert.equal(outer.json().code, 'overlap')
      assert.equal(one(db, `select ready from osp_private.signal_sources where id = ${added.id}`), 'f', 'до первого обхода корень не готов')
    })

    it('ручной обход: 202 с номером прогона, второй запуск при идущем — 409 busy, прогон публикует снимок, очередь сверяет договор по нему', async () => {
      const contract = db.seed.contract({ number: 'ГАМ-ДП-26-001', objectId: G, counterparties: [db.seed.counterparty({ name: 'ООО Тест' })] })
      fake.delayMs = 300
      const first = await h.post(U.admin, '/api/signal/sync', {})
      assert.equal(first.statusCode, 202, first.body)
      const { runId } = first.json()
      assert.equal(typeof runId, 'number')
      const second = await h.post(db.seed.admin(), '/api/signal/sync', {})
      assert.equal(second.statusCode, 409)
      assert.equal(second.json().code, 'busy')
      const done = await waitRun(runId)
      fake.delayMs = 0
      assert.equal(done.status, 'ok', JSON.stringify(done))
      assert.equal(done.initiator, 'admin')
      assert.equal(done.kind, 'manual')
      assert.equal(done.stats.roots.length, 1)
      assert.equal(done.stats.roots[0].status, 'ok')
      assert.equal(typeof done.stats.roots[0].id, 'number')
      noLeak(JSON.stringify(done), 'Гамма', 'Договоры', projectG)
      assert.equal(one(db, 'select ready from osp_private.signal_sources where project_id = ' + lit(projectG)), 't')
      await h.tick()
      assert.match(stateOf(contract), /^suggested:candidates/)
      const m = (await h.get(U.editor, '/api/signal/marks')).json().items.find((x) => x.id === contract)
      assert.equal(m.tip, 'Signal: предложена папка Объект Гамма / Договоры / ДП ГАМ-ДП-26-001 ООО Тест', 'путь — от корня обхода')
      assert.equal(fake.violations.length, 0)
      assert.equal(fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/public/v1/auth/token').length, 0)
    })

    it('журнал прогонов: последние, без имён; страница status показывает те же', async () => {
      const list = await runs()
      assert.ok(list.length >= 1)
      assert.deepEqual(Object.keys(list[0]).sort(), ['finishedAt', 'id', 'initiator', 'kind', 'mode', 'reason', 'startedAt', 'stats', 'status'])
      assert.equal((await h.get(U.admin, '/api/signal/runs?limit=1')).json().items.length, 1)
      assert.equal((await h.get(U.admin, '/api/signal/runs?limit=21')).statusCode, 400)
      const st = (await h.get(U.admin, '/api/signal/status')).json()
      assert.equal(st.lastRuns[0].id, list[0].id)
    })

    it('корень с несколькими объектами: неразмеченные папки и привязка поддерева к объекту корня', async () => {
      const D = db.seed.object({ name: 'Тест: ЖК Дельта', code: 'ДЕЛ' })
      const projectD = fake.addProject({ name: 'Тест: проект Дельта' })
      const built = fake.build(projectD, { name: 'Площадка', children: [{ name: 'Корпус Г' }, { name: 'Корпус Д' }] }).ids
      const added = await h.post(U.admin, '/api/signal/sources', { ...root(projectD, built['Площадка']), objectIds: [G, D] })
      assert.equal(added.statusCode, 200, added.body)
      const sid = added.json().id
      const sync = await h.post(U.admin, '/api/signal/sync', {})
      assert.equal(sync.statusCode, 202, sync.body)
      assert.equal((await waitRun(sync.json().runId)).status, 'ok')
      const open = (await h.get(U.admin, `/api/signal/unassigned?sourceId=${sid}`)).json()
      assert.deepEqual(open.items.map((x) => x.path), ['Площадка / Корпус Г', 'Площадка / Корпус Д'])
      assert.equal(open.next, null)
      assert.equal(typeof open.items[0].items, 'number')
      // sourceId — число или строка из цифр.
      assert.equal((await h.post(U.admin, '/api/signal/bindings', { sourceId: String(sid), nodeId: built['Площадка / Корпус Г'], objectId: G })).statusCode, 200)
      const rest = (await h.get(U.admin, `/api/signal/unassigned?sourceId=${sid}`)).json()
      assert.deepEqual(rest.items.map((x) => x.path), ['Площадка / Корпус Д'])
      const outsider = await h.post(U.admin, '/api/signal/bindings', { sourceId: sid, nodeId: built['Площадка / Корпус Д'], objectId: s.A })
      assert.equal(outsider.statusCode, 422, 'объект привязки — из объектов корня')
      assert.equal((await h.post(U.admin, '/api/signal/bindings', { sourceId: sid, nodeId: built['Площадка / Корпус Г'], objectId: null })).statusCode, 200, 'привязку можно снять')
      assert.equal((await h.get(U.admin, '/api/signal/unassigned?sourceId=999999')).statusCode, 404)
      assert.equal((await h.get(U.admin, '/api/signal/unassigned')).statusCode, 400)
    })

    it('во время обращения к Signal открытых транзакций базы нет: ни при проверке корня, ни во время обхода', async () => {
      const idle = () => Number(one(db, `select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`))
      const E = db.seed.object({ name: 'Тест: ЖК Эпсилон', code: 'ЭПС' })
      const projectE = fake.addProject({ name: 'Тест: проект Эпсилон' })
      const built = fake.build(projectE, { name: 'Объект Эпсилон', items: 2, children: [{ name: 'Договоры', items: 1 }] }).ids
      fake.delayMs = 700
      try {
        const pending = h.post(U.admin, '/api/signal/sources', { ...root(projectE, built['Объект Эпсилон']), objectIds: [E] })
        await sleep(250)
        assert.equal(idle(), 0, 'пока идёт запрос к Signal при добавлении корня')
        assert.equal((await pending).statusCode, 200)
        const run = await h.post(U.admin, '/api/signal/sync', {})
        assert.equal(run.statusCode, 202, run.body)
        const seen = []
        for (let i = 0; i < 8; i++) { await sleep(250); seen.push(idle()) }
        assert.deepEqual(seen.filter(Boolean), [], 'пока идёт обход (ожидание ответов Signal)')
        assert.equal((await waitRun(run.json().runId, 60000)).status, 'ok')
      } finally {
        fake.delayMs = 0
      }
    })

    it('ключ и токен Signal не попадают ни в ответы, ни в журнал службы', async () => {
      const text = logs.join('\n')
      noLeak(text, CLIENT_SECRET, fake.lastToken, CLIENT_ID)
    })
  })
})

describe('Возможность выключена: нет настройки, нет схемы, барьер записи; /api/health', { skip: signalDbSkip, timeout: 600000 }, () => {
  let dbOff
  let dbOn
  let sOn
  const apps = []
  const start = async (db, options) => { const h = await startSignalApp(db, options); apps.push(h); return h }

  before(async () => {
    dbOff = await startSignalDb({ migrate: false })
    dbOn = await startSignalDb()
    sOn = await seedScenario(dbOn)
  })
  after(async () => {
    for (const h of apps) await h.close()
    await dbOn?.stop()
    await dbOff?.stop()
  })

  const ROUTES = (s) => [
    ['GET', '/api/signal/marks'], ['GET', `/api/signal/contracts/${s.contracts.c1}`], ['GET', `/api/signal/folders?contractId=${s.contracts.c1}`],
    ['POST', '/api/signal/match', { contractIds: [s.contracts.c1] }],
    ['POST', `/api/signal/contracts/${s.contracts.c1}/confirm`, { nodeId: s.folders.f1, replace: false, expectedSignalLink: null, expectedStateVersion: 1, idempotencyKey: key() }],
    ['POST', `/api/signal/contracts/${s.contracts.c1}/reject`, { nodeId: s.folders.f1, expectedStateVersion: 1, idempotencyKey: key() }],
    ['POST', `/api/signal/contracts/${s.contracts.c1}/unlink`, { expectedSignalLink: 'https://signal.example.test/x', expectedStateVersion: 1, idempotencyKey: key() }],
    ['GET', '/api/signal/aliases'], ['POST', '/api/signal/aliases', { objectId: s.A, text: 'Тест Альфа' }], ['DELETE', '/api/signal/aliases/1', {}],
    ['POST', '/api/signal/sources', { url: 'https://signal.example.test/projects/x', objectIds: [] }], ['PATCH', '/api/signal/sources/1', { enabled: false }],
    ['POST', '/api/signal/sync', {}], ['GET', '/api/signal/runs'], ['GET', '/api/signal/unassigned?sourceId=1'],
    ['POST', '/api/signal/bindings', { sourceId: 1, nodeId: s.folders.f1, objectId: null }],
  ]
  const allDisabled = async (h, s, who) => {
    assert.deepEqual((await h.get(who, '/api/signal/status')).json(), { enabled: false })
    for (const [method, url, body] of ROUTES(s)) {
      const res = await h.call(who, method, url, body)
      assert.equal(res.statusCode, 503, `${method} ${url}: ${res.body}`)
      assert.deepEqual(res.json(), { error: 'Сверка Signal не включена', code: 'signal_disabled' })
    }
  }

  it('SIGNAL_SYNC не включён: status — «выключено», остальные 503 signal_disabled, служба запускается, таймеров и сверки нет, health — signal: false', async () => {
    const s = { A: key(), contracts: { c1: key() }, folders: { f1: key() } }
    const admin = dbOn.seed.admin()
    const h = await start(dbOn, { withSignal: false })
    await allDisabled(h, s, admin)
    assert.equal(h.app.signal, undefined)
    assert.equal((await h.get(null, '/api/health')).json().configured.signal, false)
  })

  it('схемы в базе нет: приложение запускается, маршруты выключены, таймеры не стартуют; миграцию применили — проверка включает возможность', async () => {
    const s = { A: key(), contracts: { c1: key() }, folders: { f1: key() } }
    const admin = dbOff.seed.admin()
    const fake = await startFakeSignal()
    try {
      const h = await start(dbOff, { fake, signal: { timers: undefined } })
      assert.equal(h.app.signal.capability.active(), false)
      assert.equal(h.app.signal.timers(), false, 'очередь и обход не стартуют без схемы')
      await allDisabled(h, s, admin)
      assert.equal((await h.get(null, '/api/health')).json().configured.signal, false, 'ключ задан, но схемы нет — «не настроена»')
      assert.equal(fake.requests.length, 0)
      dbOff.applyMigration()
      assert.equal(await h.app.signal.capability.refresh(), true)
      assert.equal(h.app.signal.timers(), true, 'схема появилась — запущены очередь и обход (ключ задан)')
      assert.deepEqual((await h.get(admin, '/api/signal/status')).json().enabled, true)
      assert.equal((await h.get(null, '/api/health')).json().configured.signal, true)
    } finally {
      await fake.close()
    }
  })

  it('схема чужой версии — как нет схемы; база не отвечает при проверке — запуск не падает, состояние прежнее', async () => {
    const { createSignalCapability } = await import(path.join(SERVER, 'src', 'lib', 'signalJobs.js'))
    const changes = []
    const row = { schema_version: 2, generation: '3', published_at: null }
    let fail = null
    const fakeDb = { read: async () => { if (fail) throw fail; return { rows: [row] } } }
    const wrapped = { read: (who, fn) => fakeDb.read().then(() => fn({ query: async () => ({ rows: [row] }) })) }
    const cap = createSignalCapability({ db: wrapped, onChange: (v) => changes.push(v) })
    assert.equal(await cap.refresh(), false)
    row.schema_version = 1
    assert.equal(await cap.refresh(), true)
    fail = Object.assign(new Error('connection'), { code: 'ECONNREFUSED' })
    assert.equal(await cap.refresh(), null, 'нет ответа базы — не «нет схемы»')
    assert.equal(cap.active(), true, 'состояние прежнее')
    fail = Object.assign(new Error('нет таблицы'), { code: '42P01' })
    assert.equal(await cap.refresh(), false)
    assert.deepEqual(changes, [true, false])
  })

  it('барьер записи: решения, синонимы, корни, привязки, сверка и обход — 503 OSP_READONLY, чтение работает, очередь пропускает такт', async () => {
    const h = await start(dbOn, { readOnly: true })
    const U = sOn.users
    const c = sOn.contracts
    await h.tick()
    const body = (await h.get(U.editor, `/api/signal/contracts/${c.c1}`)).json()
    h.setReadOnly(true)
    await sleep(1200) // барьер читается раз в секунду
    const writes = [
      [U.editor, 'POST', `/api/signal/contracts/${c.c1}/confirm`, { nodeId: sOn.folders.f1, replace: false, expectedSignalLink: null, expectedStateVersion: body.stateVersion, idempotencyKey: key() }],
      [U.editor, 'POST', `/api/signal/contracts/${c.c1}/reject`, { nodeId: sOn.folders.f1, expectedStateVersion: body.stateVersion, idempotencyKey: key() }],
      [U.editor, 'POST', `/api/signal/contracts/${c.c2}/unlink`, { expectedSignalLink: 'https://signal.example.test/x', expectedStateVersion: 1, idempotencyKey: key() }],
      [U.editor, 'POST', '/api/signal/aliases', { objectId: sOn.A, text: 'Альфа Тихая' }], [U.editor, 'DELETE', '/api/signal/aliases/1', {}],
      [U.editor, 'POST', '/api/signal/match', { contractIds: [c.c1] }],
      [U.admin, 'POST', '/api/signal/sources', { url: 'https://signal.example.test/projects/x/folders/y', objectIds: [] }],
      [U.admin, 'PATCH', '/api/signal/sources/1', { enabled: false }], [U.admin, 'POST', '/api/signal/sync', {}],
      [U.admin, 'POST', '/api/signal/bindings', { sourceId: 1, nodeId: sOn.folders.k1, objectId: null }],
    ]
    for (const [uid, method, url, payload] of writes) {
      const res = await h.call(uid, method, url, payload)
      assert.equal(res.statusCode, 503, `${method} ${url}`)
      assert.equal(res.json().code, 'OSP_READONLY')
    }
    assert.equal(linkIn(dbOn, c.c1), '', 'ссылка не тронута')
    for (const url of ['/api/signal/status', '/api/signal/marks', `/api/signal/contracts/${c.c1}`]) assert.equal((await h.get(U.editor, url)).statusCode, 200, url)
    // Очередь: правка договора в базе идёт, такт пропущен — строка остаётся.
    dbOn.sql(`update public.contracts set notes = 'правка' where id = ${lit(c.c1)}`)
    dbOn.sql(`select osp_private.signal_enqueue_all()`)
    assert.deepEqual(await h.app.signal.jobs.tick(), { skipped: 'read_only' })
    assert.notEqual(one(dbOn, 'select count(*) from osp_private.signal_queue'), '0')
    h.setReadOnly(false)
    await sleep(1200)
    assert.ok((await h.app.signal.jobs.tick()).contracts > 0)
    assert.equal(one(dbOn, 'select count(*) from osp_private.signal_queue'), '0')
  })

  it('/api/health: configured.signal — true, только если подключение задано и сверка включена; без ключа — false', async () => {
    const fake = await startFakeSignal()
    try {
      const withKey = await start(dbOn, { fake })
      assert.equal((await withKey.get(null, '/api/health')).json().configured.signal, true)
      const noKey = await start(dbOn, {})
      assert.equal((await noKey.get(null, '/api/health')).json().configured.signal, false)
      assert.equal((await noKey.get(sOn.users.admin, '/api/signal/status')).json().connection, 'not_configured')
      // Без подключения к Signal обход и добавление корня — not_configured, а очередь работает.
      const sync = await noKey.post(sOn.users.admin, '/api/signal/sync', {})
      assert.deepEqual([sync.statusCode, sync.json().code], [409, 'not_configured'])
      const add = await noKey.post(sOn.users.admin, '/api/signal/sources', { url: `https://signal.example.test/projects/${key()}/folders/${key()}`, objectIds: [] })
      assert.deepEqual([add.statusCode, add.json().code], [409, 'not_configured'])
    } finally {
      await fake.close()
    }
  })

  it('без шаблона SIGNAL_UI_FOLDER_URL подтверждение недоступно: 409 confirm_unavailable, ссылка не меняется; status и окно это говорят', async () => {
    const h = await start(dbOn, { signal: { uiFolderUrl: '', uiFileUrl: '' } })
    const U = sOn.users
    const body = (await h.get(U.editor, `/api/signal/contracts/${sOn.contracts.c1}`)).json()
    assert.equal(body.confirmAvailable, false)
    const linked = (await h.get(U.editor, `/api/signal/contracts/${sOn.contracts.c2}`)).json()
    assert.ok(linked.files.length > 0)
    for (const f of linked.files) assert.equal(f.url, null)
    assert.equal((await h.get(U.editor, '/api/signal/status')).json().confirmAvailable, false)
    const res = await h.post(U.editor, `/api/signal/contracts/${sOn.contracts.c1}/confirm`, {
      nodeId: sOn.folders.f1, replace: false, expectedSignalLink: body.signalLink, expectedStateVersion: body.stateVersion, idempotencyKey: key(),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().code, 'confirm_unavailable')
    assert.equal(linkIn(dbOn, sOn.contracts.c1), '')
  })

  it('лимиты: сверка — 60 в минуту на пользователя, ручной обход — раз в минуту, решения — 30', async () => {
    const h = await start(dbOn, {})
    const U = sOn.users
    const first = await h.post(U.admin, '/api/signal/sync', {})
    assert.notEqual(first.statusCode, 429)
    assert.equal((await h.post(U.admin, '/api/signal/sync', {})).statusCode, 429)
    const codes = []
    for (let i = 0; i < 31; i++) codes.push((await h.post(U.editor, '/api/signal/aliases', { objectId: sOn.A, text: 'a' })).statusCode)
    assert.equal(codes.filter((c) => c === 429).length, 1, 'тридцать первое решение за минуту — 429')
    const matches = []
    for (let i = 0; i < 61; i++) matches.push((await h.post(U.editor, '/api/signal/match', { contractIds: [sOn.contracts.c3] })).statusCode)
    assert.equal(matches.filter((c) => c === 429).length, 1, 'шестьдесят первая сверка за минуту — 429')
  })
})

function linkIn(db, id) { return one(db, `select coalesce(signal_link, '') from public.contracts where id = ${lit(id)}`) }
