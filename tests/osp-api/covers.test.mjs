// Обложки объектов в cloud.ru (server/osp-api: src/routes/covers.js, src/lib/covers.js). Проверяем:
//   • показ: открытый адрес /api/covers/<имя> отдаёт подписанную ссылку только на covers/<UUID.расширение>
//     — ни на документ, ни на «путь» в бакете;
//   • загрузка новой обложки: только сотрудник с правом правки объектов, только изображение разумного
//     размера, занятое имя не перезаписывается;
//   • копирование из хранилища Supabase: каждый файл сверен обратным скачиванием, повтор ничего не
//     загружает, лежащий в cloud.ru другой файл не перезаписывается, сбои попадают в журнал; журнал
//     принимает загрузка в базу Яндекса (migration/target/lib/extras.mjs);
//   • миниатюры: настоящая картинка — WebP не больше рамки, постоянный адрес с кэшем на год; делается один раз;
//     всё, что не вышло, — оригинал, без кэша.
// Нужны зависимости сервера: npm ci --prefix server/osp-api — без них набор пропускается.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
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

describe('Миниатюры обложек: GET /api/covers/<имя>/thumb', { skip }, () => {
  const YEAR_CACHE = 'public, max-age=31536000, immutable'
  const originalKey = `/osp/covers/${NAME}`
  const thumbKey = `/osp/covers/thumbs/800/${NAME}.webp`
  let buildApp
  let defaultDeps
  let createCoverThumbs
  let renderInChild
  let sharp
  let supa
  let s3
  let apps = []

  const s3Config = () => ({ endpoint: s3.url, region: 'ru-central-1', bucket: 'osp', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' })
  async function start(deps = {}) {
    const app = buildApp({
      config: { host: '127.0.0.1', port: 0, supabaseUrl: supa.url, supabaseAnonKey: 'anon-test-key', supabaseServiceKey: 'service-test-key', s3: s3Config() },
      deps: { ...defaultDeps, ...deps },
      logger: false,
    })
    apps.push(app)
    await app.ready()
    return app
  }
  const view = (app, name = NAME) => app.inject({ method: 'GET', url: `/api/covers/${name}/thumb` })
  const putOriginal = (bytes, key = originalKey) => { s3.objects.set(key, bytes.length); s3.bodies.set(key, bytes) }
  const gets = (key) => s3.requests.filter((r) => r.method === 'GET' && r.path === key).length
  const noisy = (width, height) => sharp({ create: { width, height, channels: 3, background: '#7a8', noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
  const photo = (width, height) => noisy(width, height).jpeg({ quality: 85 }).toBuffer()

  // Хранилище в памяти и разбор-подделка: для правил очереди настоящая картинка не нужна.
  function memoryS3(files = {}, { failGet = () => false } = {}) {
    const fake = {
      files: new Map(Object.entries(files)),
      calls: [],
      async send(cmd) {
        const { Key, Body } = cmd.input
        fake.calls.push(`${cmd.constructor.name} ${Key}`)
        if (cmd.constructor.name === 'PutObjectCommand') { fake.files.set(Key, Body); return {} }
        if (failGet(Key)) throw new Error('хранилище недоступно')
        const bytes = fake.files.get(Key)
        if (!bytes) throw Object.assign(new Error('нет'), { name: 'NoSuchKey' })
        return { ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } }
      },
    }
    return fake
  }
  const cover = (i) => `aaaaaaaa-0000-4000-8000-00000000000${i}.jpg`
  const renderOk = async () => ({ bytes: Buffer.from('thumb') })

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ createCoverThumbs, renderInChild } = await import(path.join(SERVER, 'src', 'lib', 'coverThumbs.js')))
    sharp = createRequire(path.join(SERVER, 'package.json'))('sharp')
    supa = await startFakeSupabase(supabaseState())
    s3 = await startFakeS3()
  })
  after(async () => {
    await supa?.close()
    await s3?.close()
  })
  beforeEach(async () => {
    await Promise.all(apps.map((a) => a.close()))
    apps = []
    s3.requests.length = 0
    s3.objects.clear()
    s3.bodies.clear()
  })

  it('фото: WebP не больше рамки, сильно легче оригинала, кэш браузера на год; лежит в covers/thumbs/', async () => {
    const original = await photo(3000, 2000)
    putOriginal(original)
    const res = await view(await start())
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['content-type'], 'image/webp')
    assert.equal(res.headers['cache-control'], YEAR_CACHE)
    const meta = await sharp(res.rawPayload).metadata()
    assert.equal(meta.format, 'webp')
    assert.deepEqual([meta.width, meta.height], [800, 533])
    assert.ok(res.rawPayload.length < original.length / 5, `${res.rawPayload.length} из ${original.length}`)
    assert.ok(s3.bodies.get(thumbKey)?.equals(res.rawPayload), 'миниатюра лежит в хранилище')
    assert.ok(s3.bodies.get(originalKey).equals(original), 'оригинал не тронут')
    assert.equal(s3.requests.find((r) => r.method === 'PUT').contentType, 'image/webp')
  })

  it('делается один раз: повтор — из памяти, после перезапуска — из хранилища, без оригинала', async () => {
    putOriginal(await photo(1600, 900))
    const app = await start()
    const first = await view(app)
    assert.equal(first.statusCode, 200)
    const requests = s3.requests.length
    const again = await view(app)
    assert.ok(again.rawPayload.equals(first.rawPayload))
    assert.equal(s3.requests.length, requests, 'повтор не ходит в хранилище')

    s3.objects.delete(originalKey)
    s3.bodies.delete(originalKey)
    s3.requests.length = 0
    const restarted = await view(await start())
    assert.equal(restarted.statusCode, 200)
    assert.equal(restarted.headers['cache-control'], YEAR_CACHE)
    assert.ok(restarted.rawPayload.equals(first.rawPayload))
    assert.equal(gets(originalKey), 0, 'оригинал не нужен')
    assert.equal(s3.requests.filter((r) => r.method === 'PUT').length, 0, 'заново не записывается')
  })

  it('снимок с отметкой поворота не ложится набок', async () => {
    const original = await noisy(1600, 800).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    assert.equal((await sharp(original).metadata()).orientation, 6, 'в файле есть отметка поворота')
    putOriginal(original)
    const meta = await sharp((await view(await start())).rawPayload).metadata()
    assert.ok(meta.height > meta.width, `${meta.width}×${meta.height}`)
    assert.equal(meta.exif, undefined, 'метаданные снимка в миниатюру не попадают')
  })

  it('панорама закрывает рамку карточки по высоте; маленькая картинка не растягивается; PNG с прозрачностью её сохраняет', async () => {
    putOriginal(await photo(4000, 500))
    let meta = await sharp((await view(await start())).rawPayload).metadata()
    assert.equal(meta.height, 450)
    assert.equal(meta.width, 3600)

    const small = 'aaaaaaaa-0000-4000-8000-00000000000a.jpg'
    putOriginal(await photo(300, 200), `/osp/covers/${small}`)
    meta = await sharp((await view(await start(), small)).rawPayload).metadata()
    assert.deepEqual([meta.width, meta.height], [300, 200])

    const png = 'aaaaaaaa-0000-4000-8000-00000000000b.png'
    putOriginal(await sharp({ create: { width: 1000, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer(), `/osp/covers/${png}`)
    assert.equal((await sharp((await view(await start(), png)).rawPayload).metadata()).hasAlpha, true)
  })

  it('имя не по шаблону — 404 без обращения к хранилищу; нет такой обложки — 404 без кэша', async () => {
    const app = await start()
    for (const bad of ['x.jpg', '..%2Fcontracts%2Fx.docx', `${NAME}%00.png`, `${NAME}%2F..%2Fx.jpg`]) {
      assert.equal((await view(app, bad)).statusCode, 404, bad)
    }
    assert.equal(s3.requests.length, 0)
    const missing = await view(app)
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.headers['cache-control'], 'no-store')
    assert.equal(s3.requests.filter((r) => r.method === 'PUT').length, 0)
  })

  it('не картинка — ссылка на оригинал без кэша; повторно не разбирается и ничего не записывает', async () => {
    putOriginal(Buffer.from('это не картинка'))
    const app = await start()
    const res = await view(app)
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers['cache-control'], 'no-store', 'подпись запоминать нельзя')
    const location = new URL(res.headers.location)
    assert.equal(location.origin + location.pathname, `${s3.url}/osp/covers/${NAME}`)
    assert.ok(location.searchParams.get('X-Amz-Signature'))
    const reads = gets(originalKey)
    assert.equal((await view(app)).statusCode, 302)
    assert.equal(gets(originalKey), reads, 'второй раз файл не скачивается')
    assert.equal(s3.requests.filter((r) => r.method === 'PUT').length, 0)
  })

  it('прежний адрес оригинала и остальные ответы по-прежнему без кэша', async () => {
    const app = await start()
    const original = await app.inject({ method: 'GET', url: `/api/covers/${NAME}` })
    assert.equal(original.statusCode, 302)
    assert.equal(original.headers['cache-control'], 'no-store')
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).headers['cache-control'], 'no-store')
  })

  it('не успели за срок ожидания — оригинал, а миниатюра доделывается в фоне и следующий показ её получает', async () => {
    const original = await photo(1000, 600)
    putOriginal(original)
    let release
    const gate = new Promise((r) => { release = r })
    const made = sharp(original).webp().toBuffer()
    const getS3 = () => defaultDeps.createS3(s3Config())
    const coverThumbs = createCoverThumbs({ getS3, bucket: 'osp', render: async () => { await gate; return { bytes: await made } } })
    const app = await start({ coverThumbs, coverThumbWaitMs: 30 })
    assert.equal((await view(app)).statusCode, 302)
    release()
    for (let i = 0; i < 100 && !s3.bodies.has(thumbKey); i++) await sleep(20)
    const next = await view(app)
    assert.equal(next.statusCode, 200)
    assert.equal(next.headers['cache-control'], YEAR_CACHE)
  })

  it('одновременные показы одной обложки — один разбор; разных — строго по одному', async () => {
    const storage = memoryS3({ [`covers/${cover(1)}`]: Buffer.from('a'), [`covers/${cover(2)}`]: Buffer.from('b'), [`covers/${cover(3)}`]: Buffer.from('c') })
    let active = 0
    let peak = 0
    let renders = 0
    const render = async () => {
      renders++
      active++
      peak = Math.max(peak, active)
      await sleep(5)
      active--
      return { bytes: Buffer.from('thumb') }
    }
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', render })
    const same = await Promise.all(Array.from({ length: 5 }, () => thumbs.get(cover(1))))
    assert.ok(same.every((r) => r.status === 'ok'))
    assert.equal(renders, 1)
    await Promise.all([thumbs.get(cover(2)), thumbs.get(cover(3))])
    assert.equal(renders, 3)
    assert.equal(peak, 1, 'оригинал и процесс разбора в памяти службы — один')
  })

  it('поток запросов на адрес без обложки: сверх предела — сразу оригинал, без обращения к хранилищу', async () => {
    const storage = memoryS3()
    const send = storage.send
    let open = () => {}
    const gate = new Promise((r) => { open = r })
    storage.send = async (cmd) => { await gate; return send(cmd) }
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', render: renderOk, maxPending: 2 })
    const pending = [thumbs.get(cover(1)), thumbs.get(cover(2))]
    assert.deepEqual(await thumbs.get(cover(3)), { status: 'original', reason: 'busy' })
    open()
    assert.deepEqual((await Promise.all(pending)).map((r) => r.status), ['missing', 'missing'])
    assert.ok(!storage.calls.some((c) => c.includes(cover(3))))
    assert.equal((await thumbs.get(cover(3))).status, 'missing', 'очередь разошлась — снова обычный путь')
  })

  it('барьер записи: миниатюра показывается, в хранилище не кладётся', async () => {
    const storage = memoryS3({ [`covers/${cover(1)}`]: Buffer.from('a') })
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', isReadOnly: () => true, render: renderOk })
    assert.equal((await thumbs.get(cover(1))).status, 'ok')
    assert.ok(!storage.calls.some((c) => c.startsWith('PutObjectCommand')))
  })

  it('запись миниатюры не удалась — показ не страдает', async () => {
    const storage = memoryS3({ [`covers/${cover(1)}`]: Buffer.from('a') })
    const send = storage.send
    storage.send = async (cmd) => { if (cmd.constructor.name === 'PutObjectCommand') throw new Error('нет места'); return send(cmd) }
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', render: renderOk })
    assert.equal((await thumbs.get(cover(1))).status, 'ok')
  })

  it('сбой связи с хранилищем не запоминается; файл, который не разобрался, — запоминается, но не навсегда', async () => {
    let down = true
    const storage = memoryS3({ [`covers/${cover(1)}`]: Buffer.from('a') }, { failGet: () => down })
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', render: renderOk })
    assert.deepEqual(await thumbs.get(cover(1)), { status: 'original', reason: 'storage' })
    down = false
    assert.equal((await thumbs.get(cover(1))).status, 'ok')

    let renders = 0
    const broken = createCoverThumbs({
      getS3: () => memoryS3({ [`covers/${cover(2)}`]: Buffer.from('b') }), bucket: 'osp', failureTtlMs: 20,
      render: async () => { renders++; return { error: 'broken', message: 'не картинка' } },
    })
    assert.equal((await broken.get(cover(2))).reason, 'broken')
    assert.equal((await broken.get(cover(2))).reason, 'failed_before')
    assert.equal(renders, 1)
    await sleep(30)
    assert.equal((await broken.get(cover(2))).reason, 'broken', 'срок прошёл — снова попытка')
    assert.equal(renders, 2)
  })

  it('оригинал больше предела не скачивается в память и не разбирается', async () => {
    let renders = 0
    let destroyed = false
    const storage = { send: async (cmd) => {
      if (cmd.input.Key.includes('thumbs/')) throw Object.assign(new Error('нет'), { name: 'NoSuchKey' })
      return { ContentLength: 99, Body: { destroy: () => { destroyed = true }, transformToByteArray: async () => assert.fail('тело читать нельзя') } }
    } }
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', maxInputBytes: 10, render: async () => { renders++; return {} } })
    assert.deepEqual(await thumbs.get(cover(1)), { status: 'original', reason: 'too_large' })
    assert.equal(renders, 0)
    assert.ok(destroyed)
  })

  it('прогрев: обложки читаются в память до первого показа; показ после него не ходит в хранилище; сбой одной не мешает', async () => {
    const stored = { [`covers/thumbs/800/${cover(1)}.webp`]: Buffer.from('thumb-1'), [`covers/thumbs/800/${cover(2)}.webp`]: Buffer.from('thumb-2') }
    const fake = memoryS3({ ...stored, [`covers/${cover(3)}`]: Buffer.from('original-3') }, { failGet: (key) => key.includes(cover(4)) })
    let rendered = 0
    const thumbs = createCoverThumbs({ getS3: () => fake, bucket: 'osp', render: async () => { rendered += 1; return { bytes: Buffer.from('thumb-3') } } })
    const out = await thumbs.warm([cover(1), cover(2), cover(3), cover(4), cover(1), 'covers/../secret', ''])
    assert.deepEqual(out, { total: 4, ok: 3, other: 1 }, 'повтор и имя не по шаблону не считаются')
    assert.equal(rendered, 1, 'разбор — только у обложки без миниатюры')
    fake.calls.length = 0
    assert.equal((await thumbs.get(cover(1))).status, 'ok')
    assert.equal((await thumbs.get(cover(3))).status, 'ok')
    assert.deepEqual(fake.calls, [], 'показ после прогрева — из памяти')
  })

  it('прогрев после запуска: имена — из objects.cover_image_url; без своей базы и без настройки его нет; сбой не роняет службу', async () => {
    const { warmCoverThumbs, COVER_WARM_DELAY_MS } = await import(path.join(SERVER, 'src', 'routes', 'covers.js'))
    assert.ok(COVER_WARM_DELAY_MS > 0)
    const queries = []
    const db = { read: async (_who, fn) => fn({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ name: cover(1) }, { name: cover(2) }] } } }) }
    const warmed = []
    const out = await warmCoverThumbs({ db, thumbs: { warm: async (names) => { warmed.push(...names); return { total: names.length, ok: names.length, other: 0 } } } })
    assert.deepEqual(warmed, [cover(1), cover(2)])
    assert.equal(out.ok, 2)
    assert.match(queries[0].sql, /public\.objects/)
    assert.deepEqual(queries[0].params, ['/api/covers/'.length + 1, '/api/covers/'])

    // Без подключения к базе прогрева нет: запуск ничего не читает.
    {
      let asked = 0
      const app = await start({ coverThumbs: { get: async () => { asked += 1; return { status: 'missing' } }, warm: async () => { asked += 1; return {} } } })
      await sleep(10)
      assert.equal(asked, 0, 'прогрев не запускался')
      await app.close()
    }
  })

  it('память ограничена: давно не показанная миниатюра вытесняется и читается снова из хранилища', async () => {
    const storage = memoryS3({ [`covers/thumbs/800/${cover(1)}.webp`]: Buffer.alloc(6), [`covers/thumbs/800/${cover(2)}.webp`]: Buffer.alloc(6) })
    const thumbs = createCoverThumbs({ getS3: () => storage, bucket: 'osp', render: renderOk, memoryBytes: 10 })
    await thumbs.get(cover(1))
    await thumbs.get(cover(2))
    const reads = storage.calls.length
    await thumbs.get(cover(2))
    assert.equal(storage.calls.length, reads, 'свежая — из памяти')
    await thumbs.get(cover(1))
    assert.equal(storage.calls.length, reads + 1, 'вытесненная — из хранилища')
  })

  it('отдельный процесс: мусор и нехватка времени — причина, а не падение', async () => {
    assert.equal((await renderInChild(Buffer.from('мусор'))).error, 'broken')
    assert.equal((await renderInChild(await photo(1000, 600), { timeoutMs: 1 })).error, 'timeout')
    const out = await renderInChild(await photo(1000, 600))
    assert.equal((await sharp(out.bytes).metadata()).format, 'webp')
  })
})
