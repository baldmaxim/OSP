// Права разделов в шлюзе данных (server/osp-api/src/lib/dbSections.js, sectionRights.js, routes/dbGateway.js):
//   • без входа приватного не прочитать; просмотр раздела не даёт создавать, менять и удалять; отказ — до PostgREST;
//   • связанная таблица в select проверяется так же, как верхняя; колонки — где правило ограничивает колонками;
//   • запись колонками (план затрат тендера по просмотру «Тендеров») и по роли; функции — своим правилом;
//   • роли и права (user_roles, role_permissions) пишет только администратор; «none» не проходит никто;
//   • подрядчик — только по своему явному списку; права не прочитались — 503;
//   • пробный режим справочного чтения — пропуск и строка журнала, чувствительное чтение он не открывает;
//   • полнота: у каждой таблицы и функции allow.json есть правило, разделы — из списка интерфейса.
// PostgREST — подделка, которая запоминает, что до неё дошло.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET, userToken, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'jose')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const lib = (name) => import(path.join(SERVER, 'src', 'lib', name))

const GATEWAY_SECRET = 'internal-gateway-secret-0123456789-abcdefghij'
const SUPABASE_URL = 'https://testproject.supabase.co'
const U = {
  admin: '11111111-1111-4111-8111-111111111111',
  viewer: '22222222-2222-4222-8222-222222222222',   // просмотр договоров и тендеров
  editor: '33333333-3333-4333-8333-333333333333',   // правка договоров
  tasks: '44444444-4444-4444-8444-444444444444',    // только задачи
  economist: '55555555-5555-4555-8555-555555555555', // роль economist, без раздела
  guest: '66666666-6666-4666-8666-666666666666',    // одобрен, прав нет
  contractor: '77777777-7777-4777-8777-777777777777',
  unapproved: '88888888-8888-4888-8888-888888888888',
}
const ROWS = {
  [U.admin]: { role: 'admin', is_approved: true, perms: {} },
  [U.viewer]: { role: 'viewer', is_approved: true, perms: { contracts: [true, false], tenders: [true, false], dc_requests: [true, false] } },
  [U.editor]: { role: 'lawyer', is_approved: true, perms: { contracts: [true, true], dc_requests: [true, false] } },
  [U.tasks]: { role: 'engineer', is_approved: true, perms: { tasks: [true, true] } },
  [U.economist]: { role: 'economist', is_approved: true, perms: { tenders: [true, false] } },
  [U.guest]: { role: 'guest', is_approved: true, perms: {} },
  [U.contractor]: { role: 'contractor', counterparty_id: 'c0000000-0000-4000-8000-000000000001', is_approved: true, perms: {} },
  [U.unapproved]: { role: 'engineer', is_approved: false, perms: { contracts: [true, true] } },
}

const ALLOW = {
  tables: {
    contracts: { authenticated: ['delete', 'insert', 'select', 'update'] },
    dc_requests: { authenticated: ['delete', 'insert', 'select', 'update'] },
    tasks: { authenticated: ['delete', 'insert', 'select', 'update'] },
    tenders: { anon: ['select'], authenticated: ['delete', 'insert', 'select', 'update'] },
    objects: { authenticated: ['delete', 'insert', 'select', 'update'] },
    user_roles: { authenticated: ['delete', 'insert', 'select', 'update'] },
    role_permissions: { authenticated: ['delete', 'insert', 'select', 'update'] },
    s3_documents: { authenticated: ['delete', 'insert', 'select', 'update'] },
    contract_audit_log: { authenticated: ['delete', 'insert', 'select', 'update'] },
    tender_bid_rates: { authenticated: ['select'] },
  },
  rpc: { psdc_apply: ['authenticated'], osp_can: ['authenticated'], bid_rates_save: ['authenticated'] },
}
const C_VIEW = [['contracts', 'view']]
const MAP = {
  tables: {
    contracts: { read: 'sensitive', select: [{ any: C_VIEW }, { any: [['dc_requests', 'view']] }, { any: [['tasks', 'view']], columns: ['id', 'contract_number', 'object_id'] }],
      insert: [{ any: [['contracts', 'edit']] }], update: [{ any: [['contracts', 'edit']] }], delete: [{ any: [['contracts', 'edit']] }] },
    dc_requests: { read: 'sensitive', select: [{ any: [['dc_requests', 'view']] }], insert: [{ any: [['dc_requests', 'edit']] }], update: [{ any: [['dc_requests', 'edit']] }], delete: [{ any: [['dc_requests', 'edit']] }] },
    tasks: { read: 'reference', select: 'employee', insert: 'employee', update: 'employee', delete: 'employee' },
    tenders: { read: 'reference', select: [{ any: [['tenders', 'view']] }],
      insert: [{ any: [['tenders', 'edit']] }],
      update: [{ any: [['tenders', 'edit']] }, { any: [['tenders', 'view']], columns: ['cost_plan_link', 'cost_plan_status'] }, { role: ['economist', 'engineer'], columns: ['tg_published'] }],
      delete: 'admin' },
    objects: { read: 'reference', select: 'employee', insert: [{ any: [['objects', 'edit']] }], update: [{ any: [['objects', 'edit']] }], delete: 'admin' },
    user_roles: { read: 'sensitive', select: 'employee', insert: 'admin', update: 'admin', delete: 'admin' },
    role_permissions: { read: 'sensitive', select: 'employee', insert: 'admin', update: 'admin', delete: 'admin' },
    s3_documents: { read: 'sensitive', select: 'employee', insert: 'none', update: 'none', delete: 'none' },
    contract_audit_log: { read: 'sensitive', select: [{ any: C_VIEW }], insert: [{ any: [['contracts', 'edit']] }], update: 'none', delete: 'none' },
    tender_bid_rates: { read: 'sensitive', select: 'admin' },
  },
  rpc: {
    psdc_apply: { kind: 'write', read: 'sensitive', call: [{ any: [['contracts', 'edit']] }] },
    osp_can: { kind: 'read', read: 'reference', call: 'employee' },
    bid_rates_save: { kind: 'write', read: 'sensitive', call: 'admin' },
  },
}
const CONTRACTOR_ALLOW = { tables: { tender_bid_rates: { authenticated: ['select'] } }, rpc: { bid_rates_save: ['authenticated'] } }

describe('права разделов: правила и разбор запроса', { skip }, () => {
  it('select разбирается в дерево: колонки, псевдонимы, связи; непонятное — отказ', async () => {
    const { parseSelect, embedsOf, queryColumnsFor } = await lib('dbSections.js')
    const tree = parseSelect('id, num:contract_number, objects(name), winner:counterparties!fk(id, contacts(full_name)), amount::text')
    assert.deepEqual(tree.cols.map((c) => [c.name, c.complex]), [['id', false], ['contract_number', false], ['amount', true]])
    assert.deepEqual(embedsOf(tree).map((e) => [e.path.join('.'), e.rel]), [['objects', 'objects'], ['winner', 'counterparties'], ['winner.contacts', 'contacts']])
    assert.equal(parseSelect('').star, true, 'без select — все колонки')
    assert.throws(() => parseSelect('a(b'), /скобка/)
    assert.throws(() => parseSelect('x::int(id)'), /приведение/)
    const q = queryColumnsFor(new URLSearchParams('select=id&contract_amount=gt.0&order=contract_date.desc,id&winner.name=eq.x&or=(a.eq.1)'), [])
    assert.deepEqual([...q.cols].sort(), ['contract_amount', 'contract_date', 'id'])
    assert.equal(q.logic, true)
    assert.deepEqual([...queryColumnsFor(new URLSearchParams('winner.name=eq.x&winner.order=id'), ['winner']).cols].sort(), ['id', 'name'])
  })

  it('расчёт прав повторяет osp_can: администратор — всё; заблокированный, не одобренный и подрядчик — ничего', async () => {
    const { rightsFromRow } = await lib('sectionRights.js')
    const perms = { contracts: [true, false] }
    assert.equal(rightsFromRow({ role: 'lawyer', is_approved: true, perms }).can('contracts', 'view'), true)
    assert.equal(rightsFromRow({ role: 'lawyer', is_approved: true, perms }).can('contracts', 'edit'), false)
    assert.equal(rightsFromRow({ role: 'lawyer', is_approved: true, is_blocked: true, perms }).can('contracts', 'view'), false)
    assert.equal(rightsFromRow({ role: 'lawyer', is_approved: false, perms }).employee, false)
    assert.equal(rightsFromRow({ role: 'lawyer', is_approved: true, counterparty_id: 'x', perms }).can('contracts', 'view'), false)
    assert.equal(rightsFromRow({ role: 'contractor', is_approved: true, perms }).contractor, true)
    const admin = rightsFromRow({ role: 'admin', is_approved: true, perms: {} })
    assert.equal(admin.admin && admin.can('anything', 'edit'), true)
    assert.equal(rightsFromRow({ role: 'admin', is_approved: false, perms: {} }).admin, false, 'неодобренный admin — не администратор')
    assert.equal(rightsFromRow(null, true).admin, true, 'суперадминистратор')
    assert.equal(rightsFromRow(null, false), null, 'нет учётки — прав нет')
  })

  it('карта проверяется при загрузке: неизвестный раздел, правило и колонки у функции — ошибка', async () => {
    const { validateSectionMap } = await lib('dbSections.js')
    const bad = (t) => ({ tables: { x: { read: 'sensitive', select: t } }, rpc: {} })
    assert.throws(() => validateSectionMap(bad([{ any: [['nope', 'view']] }])), /неизвестный раздел/)
    assert.throws(() => validateSectionMap(bad('everyone')), /правило/)
    assert.throws(() => validateSectionMap({ tables: {}, rpc: { f: { kind: 'read', read: 'sensitive', call: [{ any: C_VIEW, columns: ['a'] }] } } }), /колонки/)
    assert.doesNotThrow(() => validateSectionMap(MAP))
  })
})

describe('права разделов: шлюз', { skip }, () => {
  let buildApp
  let upstream
  let seen
  let app
  let logs
  let rightsFail
  let modes

  const call = (method, url, { who, body, headers = {} } = {}) => app.inject({
    method, url, payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(who ? { authorization: `Bearer ${userToken(SUPABASE_URL, who)}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  })
  const reached = () => seen.length

  async function makeApp() {
    await app?.close()
    logs = []
    const { rightsFromRow } = await lib('sectionRights.js')
    app = buildApp({
      logger: { level: 'info', stream: { write: (l) => logs.push(String(l)) } },
      config: {
        host: '127.0.0.1', port: 0, supabaseUrl: SUPABASE_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: projectKey('service_role'),
        supabaseJwtSecret: SECRET, anthropicApiKey: '', ratesApiKeys: [], required: ['supabase'], s3: {},
        dbGateway: { upstream: upstream.url, secret: GATEWAY_SECRET, dbRole: 'portal_owner' },
        security: { dbSectionsWrite: modes.write, dbSectionsReadReference: modes.readReference, apiKeysSource: 'env', uploadMaxBytes: 104857600, uploadMaxBytesRd: 314572800 },
      },
      deps: {
        allow: ALLOW, sectionMap: MAP, contractorAllow: CONTRACTOR_ALLOW,
        sectionRights: { get: async (id) => { if (rightsFail) throw Object.assign(new Error('down'), { code: '57P01' }); return rightsFromRow(ROWS[id] || null) } },
      },
    })
    await app.ready()
  }

  before(async () => {
    ;({ buildApp } = await import(path.join(SERVER, 'src', 'app.js')))
    seen = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('[]')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    upstream = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
  })
  after(async () => {
    await app?.close()
    await upstream?.close()
  })
  beforeEach(async () => {
    seen.length = 0
    rightsFail = false
    modes = { write: 'enforce', readReference: 'enforce' }
    await makeApp()
  })

  it('без входа приватное не читается: 401 до PostgREST', async () => {
    for (const url of ['/api/db/contracts', '/api/db/user_roles', '/api/db/s3_documents', '/api/db/contract_audit_log']) {
      assert.equal((await call('GET', url)).statusCode, 401, url)
    }
    assert.equal((await call('POST', '/api/db/rpc/psdc_apply', { body: {} })).statusCode, 401)
    assert.equal(reached(), 0)
  })

  it('просмотр договоров: читать можно; создать, изменить, удалить, upsert — 403 до PostgREST', async () => {
    assert.equal((await call('GET', '/api/db/contracts?select=*', { who: U.viewer })).statusCode, 200)
    assert.equal(reached(), 1)
    seen.length = 0
    for (const [method, url, body, headers] of [
      ['POST', '/api/db/contracts', { contract_number: '1' }],
      ['PATCH', '/api/db/contracts?id=eq.x', { contract_number: '2' }],
      ['DELETE', '/api/db/contracts?id=eq.x'],
      ['POST', '/api/db/contracts', { id: 'x' }, { prefer: 'resolution=merge-duplicates' }],
    ]) {
      const res = await call(method, url, { who: U.viewer, body, headers })
      assert.equal(res.statusCode, 403, `${method} ${url}`)
      assert.equal(res.json().code, '42501')
    }
    assert.equal(reached(), 0, 'ни один запрос записи до PostgREST не дошёл')
    assert.equal((await call('PATCH', '/api/db/contracts?id=eq.x', { who: U.editor, body: { contract_number: '2' } })).statusCode, 200)
  })

  it('связанная таблица в select — по своему правилу; без права — 403 всего запроса', async () => {
    assert.equal((await call('GET', '/api/db/dc_requests?select=*,contracts(*)', { who: U.viewer })).statusCode, 200)
    const res = await call('GET', '/api/db/tasks?select=*,contracts(*)', { who: U.guest })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /contracts/)
  })

  it('чтение колонками: задачам — id и номер договора; «*», другая колонка, условие по ней, or — 403', async () => {
    assert.equal((await call('GET', '/api/db/contracts?select=id,contract_number', { who: U.tasks })).statusCode, 200)
    assert.equal((await call('GET', '/api/db/tasks?select=id,contracts(id,contract_number)', { who: U.tasks })).statusCode, 200)
    seen.length = 0
    for (const url of [
      '/api/db/contracts?select=*',
      '/api/db/contracts',
      '/api/db/contracts?select=id,contract_amount',
      '/api/db/contracts?select=id&contract_amount=gt.1000000',
      '/api/db/contracts?select=id&or=(contract_amount.gt.0,id.eq.1)',
      '/api/db/contracts?select=id&order=contract_amount.desc',
      '/api/db/tasks?select=id,contracts(*)',
      '/api/db/tasks?select=id,contracts(id)&contracts.contract_amount=gt.0',
    ]) {
      assert.equal((await call('GET', url, { who: U.tasks })).statusCode, 403, url)
    }
    assert.equal(reached(), 0)
  })

  it('запись колонками: просмотр «Тендеров» — только план затрат; роль — только своё; ключи тела проверяются', async () => {
    assert.equal((await call('PATCH', '/api/db/tenders?id=eq.t', { who: U.viewer, body: { cost_plan_link: 'https://x' } })).statusCode, 200)
    seen.length = 0
    assert.equal((await call('PATCH', '/api/db/tenders?id=eq.t', { who: U.viewer, body: { status: 'Завершен' } })).statusCode, 403)
    assert.equal((await call('PATCH', '/api/db/tenders?id=eq.t', { who: U.viewer, body: { cost_plan_link: 'x', status: 'y' } })).statusCode, 403)
    assert.equal((await call('POST', '/api/db/tenders', { who: U.viewer, body: [{ cost_plan_link: 'x' }] })).statusCode, 403, 'вставка — нужна правка')
    assert.equal(reached(), 0)
    // Роль economist: tg_published, а план затрат — по просмотру «Тендеров», который у неё есть.
    assert.equal((await call('PATCH', '/api/db/tenders?id=eq.t', { who: U.economist, body: { tg_published: true } })).statusCode, 200)
    assert.equal((await call('PATCH', '/api/db/tenders?id=eq.t', { who: U.guest, body: { tg_published: true } })).statusCode, 403)
  })

  it('функции: без права — 403; служебная — любому сотруднику', async () => {
    assert.equal((await call('POST', '/api/db/rpc/psdc_apply', { who: U.viewer, body: {} })).statusCode, 403)
    assert.equal((await call('POST', '/api/db/rpc/psdc_apply', { who: U.editor, body: {} })).statusCode, 200)
    assert.equal((await call('POST', '/api/db/rpc/osp_can', { who: U.guest, body: {} })).statusCode, 200)
  })

  it('роли и права пишет только администратор; «none» не проходит никто', async () => {
    for (const who of [U.viewer, U.editor, U.guest]) {
      assert.equal((await call('PATCH', `/api/db/user_roles?user_id=eq.${who}`, { who, body: { role: 'admin' } })).statusCode, 403)
      assert.equal((await call('POST', '/api/db/role_permissions', { who, body: { role: 'guest', section: 'contracts', can_view: true } })).statusCode, 403)
    }
    assert.equal(reached(), 0)
    assert.equal((await call('PATCH', `/api/db/user_roles?user_id=eq.${U.guest}`, { who: U.admin, body: { role: 'viewer' } })).statusCode, 200)
    for (const who of [U.admin, U.editor]) {
      assert.equal((await call('PATCH', '/api/db/s3_documents?id=eq.x', { who, body: { s3_key: 'other' } })).statusCode, 403)
      assert.equal((await call('DELETE', '/api/db/contract_audit_log?id=eq.x', { who })).statusCode, 403)
      assert.equal((await call('PATCH', '/api/db/contract_audit_log?id=eq.x', { who, body: { description: 'правка' } })).statusCode, 403)
    }
  })

  it('не одобренный — 403; права не прочитались — 503', async () => {
    assert.equal((await call('GET', '/api/db/contracts', { who: U.unapproved })).statusCode, 403)
    rightsFail = true
    const res = await call('GET', '/api/db/objects', { who: U.viewer })
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().code, 'OSP_RIGHTS_UNAVAILABLE')
    assert.equal(reached(), 0)
  })

  it('подрядчик — только по своему списку: всё остальное из allow.json — 403', async () => {
    assert.equal((await call('GET', '/api/db/tender_bid_rates?select=id', { who: U.contractor })).statusCode, 200)
    assert.equal((await call('POST', '/api/db/rpc/bid_rates_save', { who: U.contractor, body: {} })).statusCode, 200, 'функция подрядчика (в карте — admin)')
    seen.length = 0
    // Вне списка — как у учётки с регистрации: «такой таблицы / функции нет» (404) или 403; до PostgREST — ничего.
    for (const table of Object.keys(ALLOW.tables).filter((t) => !CONTRACTOR_ALLOW.tables[t])) {
      assert.ok([403, 404].includes((await call('GET', `/api/db/${table}?select=id`, { who: U.contractor })).statusCode), table)
    }
    for (const fn of Object.keys(ALLOW.rpc).filter((f) => !CONTRACTOR_ALLOW.rpc[f])) {
      assert.ok([403, 404].includes((await call('POST', `/api/db/rpc/${fn}`, { who: U.contractor, body: {} })).statusCode), fn)
    }
    assert.equal(reached(), 0)
  })

  it('пробный режим справочников: пропуск и строка журнала; чувствительное чтение — отказ и в нём', async () => {
    modes = { write: 'enforce', readReference: 'log' }
    await makeApp()
    assert.equal((await call('GET', '/api/db/tenders?select=id', { who: U.guest })).statusCode, 200, 'справочник — пропуск')
    assert.match(logs.join(''), /db section would deny/)
    assert.doesNotMatch(logs.join(''), /@/, 'без почты в журнале')
    assert.equal((await call('GET', '/api/db/contracts?select=id', { who: U.guest })).statusCode, 403, 'договоры — чувствительное')
    assert.equal((await call('PATCH', '/api/db/objects?id=eq.x', { who: U.guest, body: { name: 'x' } })).statusCode, 403, 'запись — по своему режиму')
  })

  it('аварийный режим записи (log): запись проходит, отказ — в журнал', async () => {
    modes = { write: 'log', readReference: 'enforce' }
    await makeApp()
    assert.equal((await call('PATCH', '/api/db/objects?id=eq.x', { who: U.guest, body: { name: 'x' } })).statusCode, 200)
    assert.match(logs.join(''), /db section would deny/)
  })
})

describe('права разделов: настоящая карта и списки', { skip }, () => {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(SERVER, 'src', 'data', p), 'utf8'))

  it('у каждой таблицы и функции allow.json есть правило, и наоборот; разделы — из списка интерфейса', async () => {
    const { validateSectionMap, SECTION_KEYS } = await lib('dbSections.js')
    const allow = read('allow.json')
    const map = validateSectionMap(read('db-sections.json'))
    assert.deepEqual(Object.keys(map.tables).sort(), Object.keys(allow.tables).sort(), 'таблицы')
    assert.deepEqual(Object.keys(map.rpc).sort(), Object.keys(allow.rpc).sort(), 'функции')
    const ui = fs.readFileSync(path.join(ROOT, 'src', 'contexts', 'roleConstants.js'), 'utf8')
    const uiSections = new Set([...ui.slice(ui.indexOf('export const SECTIONS')).matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]))
    assert.deepEqual([...SECTION_KEYS].sort(), [...uiSections].sort(), 'список разделов = SECTIONS интерфейса')
  })

  it('решения, принятые явно: роли и права — администратор; журналы и строки файлов через шлюз не меняются', () => {
    const map = read('db-sections.json')
    for (const t of ['user_roles', 'roles', 'role_permissions']) {
      for (const a of ['insert', 'update', 'delete']) if (map.tables[t]?.[a] !== undefined) assert.equal(map.tables[t][a], 'admin', `${t}.${a}`)
    }
    for (const t of Object.keys(map.tables).filter((x) => x.endsWith('_audit_log'))) {
      assert.equal(map.tables[t].update ?? 'none', 'none', `${t}.update`)
      assert.equal(map.tables[t].delete ?? 'none', 'none', `${t}.delete`)
    }
    for (const a of ['insert', 'update', 'delete']) assert.equal(map.tables.s3_documents[a] ?? 'none', 'none', `s3_documents.${a}`)
    assert.equal(map.tables.contracts.read, 'sensitive')
  })

  it('список подрядчика — часть allow.json; учётка с регистрации — часть списка подрядчика', () => {
    const allow = read('allow.json')
    const contractor = read('allow-contractor.json')
    const self = read('allow-self-contractor.json')
    for (const [t, roles] of Object.entries(contractor.tables)) {
      for (const a of roles.authenticated || []) assert.ok(allow.tables[t]?.authenticated?.includes(a), `${t}.${a} нет в allow.json`)
    }
    for (const f of Object.keys(contractor.rpc)) assert.ok(allow.rpc[f], `${f} нет в allow.json`)
    for (const [t, roles] of Object.entries(self.tables)) {
      for (const a of roles.authenticated || []) assert.ok(contractor.tables[t]?.authenticated?.includes(a), `учётка с регистрации: ${t}.${a} нет в списке подрядчика`)
    }
    for (const f of Object.keys(self.rpc)) assert.ok(contractor.rpc[f], `учётка с регистрации: ${f} нет в списке подрядчика`)
  })
})
