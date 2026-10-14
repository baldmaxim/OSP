// Обложки объектов в cloud.ru (server/osp-api: src/routes/covers.js, src/lib/covers.js). Проверяем:
//   • показ: открытый адрес /api/covers/<имя> отдаёт подписанную ссылку только на covers/<UUID.расширение>
//     — ни на документ, ни на «путь» в бакете;
//   • загрузка новой обложки: только сотрудник с правом правки объектов, только изображение разумного
//     размера, занятое имя не перезаписывается;
//   • копирование из хранилища Supabase: каждый файл сверен обратным скачиванием, повтор ничего не
//     загружает, лежащий в cloud.ru другой файл не перезаписывается, сбои попадают в журнал; журнал
//     принимает загрузка в базу Яндекса (migration/target/lib/extras.mjs).
// Нужны зависимости сервера: npm ci --prefix server/osp-api — без них набор пропускается.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeSupabase, startFakeS3 } from './lib/fakes.mjs'
import { coverMovesSql, COVER_NAME_RE as LOAD_NAME_RE, COVER_URL_PREFIX as LOAD_URL_PREFIX } from '../../migration/target/lib/extras.mjs'
import { COVER_URL_PREFIX as SITE_URL_PREFIX } from '../../src/api/serverPath.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = fs.existsSync(path.join(SERVER, 'node_modules', 'fastify')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

const U = {
  emp: { token: 'tok-emp', id: '11111111-1111-4111-8111-111111111111' },
  viewer: { token: 'tok-viewer', id: '77777777-7777-4777-8777-777777777777' },
  contractor: { token: 'tok-contractor', id: '44444444-4444-4444-8444-444444444444' },
}
const NAME = '0f0e0d0c-0b0a-4908-8706-050403020100.jpg'
const FILES = {
  'aaaaaaaa-0000-4000-8000-000000000001.jpg': { body: Buffer.from('jpeg-1 обложка'), type: 'image/jpeg' },
  'aaaaaaaa-0000-4000-8000-000000000002.PNG': { body: Buffer.from('png-2 обложка'), type: 'image/png' },
  'aaaaaaaa-0000-4000-8000-000000000003.webp': { body: Buffer.from('webp-3'), type: 'image/webp' },
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const listOf = (entries) => Buffer.from(['name,size,mimetype,created_at,updated_at',
  ...entries.map(([name, size, type]) => `${name},${size},${type},2026-09-01 10:00:00+00,2026-09-01 10:00:00+00`)].join('\n') + '\n')
const fullList = () => listOf(Object.entries(FILES).map(([n, f]) => [n, f.body.length, f.type]))

function supabaseState() {
  return {
    users: Object.fromEntries(Object.values(U).map((u) => [u.token, { id: u.id }])),
    roles: {
      [U.emp.id]: { role: 'engineer', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Инженер' },
      [U.viewer.id]: { role: 'viewer', counterparty_id: null, is_approved: true, is_blocked: false, full_name: 'Зритель' },
      [U.contractor.id]: { role: 'contractor', counterparty_id: 'cp-1', is_approved: true },
    },
    docs: {},
    can: { [U.emp.id]: ['objects:edit'], [U.viewer.id]: ['objects:view'] },
    owners: {},
    views: {},
  }
}

// Общедоступный бакет object-photos «как Supabase»: GET /storage/v1/object/public/object-photos/<имя>.
async function startPublicStorage(files) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' })
    const name = decodeURIComponent(url.pathname.replace('/storage/v1/object/public/object-photos/', ''))
    const file = files[name]
    if (!url.pathname.startsWith('/storage/v1/object/public/object-photos/') || !file) { res.writeHead(404); return res.end('{}') }
    res.writeHead(200, { 'content-type': file.type })
    res.end(file.body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, files, close: () => new Promise((r) => server.close(r)) }
}

describe('Обложки объектов: показ, загрузка, копирование из Supabase', { skip }, () => {
  let buildApp
  let defaultDeps
  let copyCovers
  let sourceBaseOf
  let COVER_NAME_RE
  let supa
  let s3
  let storage
  let state
  let app

  const s3Config = () => ({ endpoint: s3.url, region: 'ru-central-1', bucket: 'osp', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' })
  const upload = (who, body) => app.inject({
    method: 'POST', url: '/api/fn/cover-upload',
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) },
    payload: JSON.stringify(body),
  })
  const good = (over = {}) => ({ name: NAME, mime_type: 'image/jpeg', size_bytes: 2048, ...over })
  const copy = (listBytes) => copyCovers({ listBytes, sourceBase: sourceBaseOf(storage.url), s3: defaultDeps.createS3(s3Config()), bucket: 'osp' })

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ copyCovers, sourceBaseOf, COVER_NAME_RE } = await import(path.join(SERVER, 'src', 'lib', 'covers.js')))
    state = supabaseState()
    supa = await startFakeSupabase(state)
    s3 = await startFakeS3()
    storage = await startPublicStorage(FILES)
  })
  after(async () => {
    await app?.close()
    await supa?.close()
    await s3?.close()
    await storage?.close()
  })
  beforeEach(async () => {
    supa.reset()
    s3.requests.length = 0
    s3.objects.clear()
    s3.bodies.clear()
    Object.assign(state, supabaseState())
    delete state.noOspCan
    await app?.close()
    app = buildApp({
      config: { host: '127.0.0.1', port: 0, supabaseUrl: supa.url, supabaseAnonKey: 'anon-test-key', supabaseServiceKey: 'service-test-key', s3: s3Config() },
      logger: false,
    })
    await app.ready()
  })

  it('один шаблон имени и один адрес — у сервера, у загрузки в базу Яндекса и у сайта', () => {
    assert.equal(String(COVER_NAME_RE), String(LOAD_NAME_RE))
    assert.equal(LOAD_URL_PREFIX, '/api/covers/')
    assert.equal(SITE_URL_PREFIX, '/api/covers/')
  })

  it('показ без входа: подписанная ссылка на covers/<имя> на 10 минут', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/covers/${NAME}` })
    assert.equal(res.statusCode, 302)
    const location = new URL(res.headers.location)
    assert.equal(location.origin + location.pathname, `${s3.url}/osp/covers/${NAME}`)
    assert.equal(location.searchParams.get('X-Amz-Expires'), '600')
    assert.ok(location.searchParams.get('X-Amz-Signature'))
  })

  it('показ: только имя «UUID.расширение» — ни документ, ни путь в бакете', async () => {
    for (const bad of ['x.jpg', `${NAME.slice(0, -4)}`, `${NAME}.exe.bat`, '..%2Fcontracts%2Fx.docx', 'tenders%2Ft1%2Fa-plan.pdf',
      `${NAME.toUpperCase()}`, `${NAME}%00.png`, `${NAME.slice(0, -4)}.verylongextension`]) {
      const res = await app.inject({ method: 'GET', url: `/api/covers/${bad}` })
      assert.equal(res.statusCode, 404, bad)
    }
    assert.equal(s3.requests.length, 0)
  })

  it('загрузка: без входа — 401, подрядчик и сотрудник без права правки объектов — 403', async () => {
    assert.equal((await upload(null, good())).statusCode, 401)
    assert.equal((await upload(U.contractor, good())).statusCode, 403)
    const viewer = await upload(U.viewer, good())
    assert.equal(viewer.statusCode, 403)
    assert.equal(viewer.json().error, 'Нет права на правку объектов')
  })

  it('загрузка: сотрудник с правом — ссылка на PUT в covers/<имя> с типом файла и адрес для страницы', async () => {
    const res = await upload(U.emp, good())
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.url, `/api/covers/${NAME}`)
    assert.equal(body.expires_in, 900)
    const put = new URL(body.presigned_url)
    assert.equal(put.origin + put.pathname, `${s3.url}/osp/covers/${NAME}`)
    assert.match(put.searchParams.get('X-Amz-SignedHeaders'), /content-type/)
    const rpc = supa.requests.find((r) => r.path === '/rest/v1/rpc/osp_can')
    assert.deepEqual(JSON.parse(rpc.body), { p_section: 'objects', p_kind: 'edit' })
  })

  it('загрузка: имя не по шаблону, не изображение, пустой или слишком большой файл — 400; занятое имя — 409', async () => {
    for (const body of [good({ name: '../x.jpg' }), good({ name: 'x.jpg' }), good({ mime_type: 'application/pdf' }),
      good({ mime_type: 'text/html' }), good({ size_bytes: 0 }), good({ size_bytes: 21 * 1024 * 1024 }), good({ size_bytes: '5' })]) {
      assert.equal((await upload(U.emp, body)).statusCode, 400, JSON.stringify(body))
    }
    s3.objects.set(`/osp/covers/${NAME}`, 5)
    const taken = await upload(U.emp, good())
    assert.equal(taken.statusCode, 409)
    assert.equal(taken.json().code, 'OSP_COVER_EXISTS')
  })

  it('загрузка: нет функции osp_can — 503, без проверки прав ссылки нет', async () => {
    state.noOspCan = true
    const res = await upload(U.emp, good())
    assert.equal(res.statusCode, 503)
    assert.equal(res.json().code, 'OSP_RIGHTS_UNAVAILABLE')
  })

  it('копирование: каждый файл — в covers/ с типом и сверкой; повтор ничего не загружает; журнал принимает загрузка в базу', async () => {
    const list = fullList()
    const first = await copy(list)
    assert.deepEqual(first.files.map((f) => [f.status, f.uploaded]), [['verified', true], ['verified', true], ['verified', true]])
    for (const [name, f] of Object.entries(FILES)) {
      assert.ok(s3.bodies.get(`/osp/covers/${name}`).equals(f.body), name)
      assert.equal(first.files.find((x) => x.name === name).sha256, sha(f.body))
    }
    assert.deepEqual(s3.requests.filter((r) => r.method === 'PUT').map((r) => r.contentType), ['image/jpeg', 'image/png', 'image/webp'])
    assert.equal(first.list_sha256, sha(list))
    assert.equal(first.source_base, `${storage.url}/storage/v1/object/public/object-photos/`)
    assert.ok(storage.requests.every((r) => r.method === 'GET' && r.auth === ''), 'Supabase только читается, без ключей')

    s3.requests.length = 0
    const again = await copy(list)
    assert.deepEqual(again.files.map((f) => [f.status, f.uploaded]), [['verified', false], ['verified', false], ['verified', false]])
    assert.equal(s3.requests.filter((r) => r.method === 'PUT').length, 0)

    const { sql, summary } = coverMovesSql(JSON.stringify(again), list.toString('utf8'))
    assert.deepEqual(summary, { listed: 3, verified: 3, failed: 0 })
    for (const name of Object.keys(FILES)) assert.ok(sql.includes(`'/api/covers/${name}'`), name)
  })

  it('копирование: другой файл в cloud.ru не перезаписывается; нет в Supabase, другой размер, имя не по шаблону — в журнал', async () => {
    const [n1, n2] = Object.keys(FILES)
    s3.objects.set(`/osp/covers/${n1}`, 5)
    s3.bodies.set(`/osp/covers/${n1}`, Buffer.from('чужое'))
    const list = listOf([
      [n1, FILES[n1].body.length, 'image/jpeg'],
      [n2, 999, 'image/png'],
      ['aaaaaaaa-0000-4000-8000-00000000dead.jpg', 10, 'image/jpeg'],
      ['обложка без имени.jpg', 10, 'image/jpeg'],
    ])
    const res = await copy(list)
    assert.deepEqual(res.files.map((f) => f.status), ['failed', 'failed', 'failed', 'failed'])
    assert.match(res.files[0].reason, /уже лежит другой файл с этим именем — не перезаписывается/)
    assert.match(res.files[1].reason, /скачано \d+ байт, в списке 999/)
    assert.match(res.files[2].reason, /хранилище Supabase ответило 404/)
    assert.match(res.files[3].reason, /имя не по шаблону/)
    assert.equal(s3.bodies.get(`/osp/covers/${n1}`).toString(), 'чужое')
    assert.equal(s3.requests.filter((r) => r.method === 'PUT').length, 0)
    const { summary } = coverMovesSql(JSON.stringify(res), list.toString('utf8'))
    assert.deepEqual(summary, { listed: 4, verified: 0, failed: 4 })
  })
})
