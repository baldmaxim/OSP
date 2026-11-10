// Сеть на сервере corp (выпуск 0 входа через Keycloak): osp-api подключён и к общей сети сервера, поэтому
//   • замок сайта (OSP_WEB_GATE=1): без верного жетона X-OSP-Web — 403, в том числе с подложенным X-Forwarded-For; изнутри
//     контейнера (loopback, без X-Forwarded-For) — пропуск: проверка живости, deploy.sh auth-config, ready;
//   • PostgREST — по unix-сокету в общем томе (OSP_PGRST_URL=unix:/…): шлюз и внутренний клиент данных идут одним путём,
//     имени в сети, которое мог бы занять сосед, у PostgREST нет. Ответ — потоком, тело запроса — байт в байт.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRET, projectKey } from './lib/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const skip = ['fastify', 'jose', '@supabase/postgrest-js'].every((m) => fs.existsSync(path.join(SERVER, 'node_modules', m))) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'
const TOKEN = 'WebGateToken0123456789abcdefghijKLMNOP'
const GATEWAY_SECRET = 'web-gate-gateway-secret-0123456789-abcdefgh'

describe('замок сайта и PostgREST по сокету', { skip }, () => {
  let buildApp
  let defaultDeps
  let parseWebGate
  let unixSocketFetch
  let parseUpstream
  let tmp
  let sock
  let server
  const seen = []
  let app

  const config = (over = {}) => ({
    host: '127.0.0.1', port: 0, supabaseUrl: 'https://testproject.supabase.co', supabaseAnonKey: projectKey('anon'), supabaseServiceKey: '',
    supabaseJwtSecret: SECRET, anthropicApiKey: '', ratesApiKeys: [], required: ['supabase'],
    s3: { endpoint: '', region: 'x', bucket: '', accessKeyId: '', secretAccessKey: '' },
    dbGateway: { upstream: `unix:${sock}`, secret: GATEWAY_SECRET, dbRole: 'portal_owner', readOnlyFile: '' },
    webGate: { enabled: true, token: TOKEN },
    ...over,
  })
  async function makeApp(over = {}) {
    await app?.close()
    app = buildApp({
      config: config(over), logger: false,
      deps: { ...defaultDeps, allow: { tables: { public_open_tenders: { anon: ['select'] } }, rpc: {} }, createLoadStatus: () => ({ current: async () => ({ status: 'final' }) }),
        checkSupabase: async () => {} },
    })
    await app.ready()
  }

  before(async () => {
    ;({ buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js')))
    ;({ parseWebGate } = await import(path.join(SERVER, 'src', 'config.js')))
    ;({ unixSocketFetch, parseUpstream } = await import(path.join(SERVER, 'src', 'lib', 'upstreamFetch.js')))
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-gate-'))
    sock = path.join(tmp, 'pgrst.sock')
    server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization || '', body: Buffer.concat(chunks).toString('utf8') })
        if (req.url.startsWith('/empty')) { res.writeHead(204); return res.end() }
        res.writeHead(200, { 'content-type': 'application/json', 'content-range': '0-1/2', 'x-many': ['a', 'b'] })
        // Тело — частями: ответ потоком, а не одним куском.
        res.write('[{"id":1},')
        setTimeout(() => res.end('{"id":2}]'), 20)
      })
    })
    await new Promise((r) => server.listen(sock, r))
  })
  after(async () => {
    await app?.close()
    server?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('настройка: замок без жетона или с негодным — служба не стартует; адрес сокета — только абсолютный путь', () => {
    assert.throws(() => parseWebGate({ OSP_WEB_GATE: '1' }), /OSP_WEB_TOKEN/)
    assert.throws(() => parseWebGate({ OSP_WEB_GATE: '1', OSP_WEB_TOKEN: 'short' }), /OSP_WEB_TOKEN/)
    assert.throws(() => parseWebGate({ OSP_WEB_GATE: 'yes', OSP_WEB_TOKEN: TOKEN }), /OSP_WEB_GATE/)
    assert.deepEqual(parseWebGate({ OSP_WEB_GATE: '1', OSP_WEB_TOKEN: TOKEN }), { enabled: true, token: TOKEN })
    assert.deepEqual(parseWebGate({}), { enabled: false, token: '' })
    assert.deepEqual(parseUpstream('unix:/run/osp-pgrst/pgrst.sock'), { base: 'http://osp-postgrest.sock', socketPath: '/run/osp-pgrst/pgrst.sock' })
    assert.deepEqual(parseUpstream('http://osp-postgrest:3001/'), { base: 'http://osp-postgrest:3001', socketPath: null })
    for (const bad of ['unix:relative.sock', 'unix:/a/../b', 'ftp://x', 'не адрес']) assert.throws(() => parseUpstream(bad), /OSP_PGRST_URL/, bad)
  })

  it('замок: без жетона и с чужим — 403 (и с подложенным X-Forwarded-For); с жетоном и изнутри контейнера — пропуск', async () => {
    await makeApp()
    const health = (headers) => app.inject({ method: 'GET', url: '/api/health', headers, remoteAddress: '172.18.0.9' })
    assert.equal((await health({})).statusCode, 403)
    assert.equal((await health({})).json().code, 'OSP_WEB_GATE')
    assert.equal((await health({ 'x-osp-web': 'wrong' })).statusCode, 403)
    assert.equal((await health({ 'x-osp-web': TOKEN.slice(0, -1) + 'x' })).statusCode, 403)
    assert.equal((await health({ 'x-osp-web': TOKEN, 'x-forwarded-for': '203.0.113.5' })).statusCode, 200)
    // Шлюз данных тоже за замком — до PostgREST запрос без жетона не доходит.
    seen.length = 0
    const db = await app.inject({ method: 'GET', url: '/api/db/public_open_tenders?select=id', remoteAddress: '172.18.0.9' })
    assert.equal(db.statusCode, 403)
    assert.equal(seen.length, 0)
    // Изнутри контейнера: loopback без X-Forwarded-For — пропуск; с X-Forwarded-For (пришло через прокси) — нет.
    assert.equal((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.5' } })).statusCode, 403)
    // Замок выключен — как раньше.
    await makeApp({ webGate: { enabled: false, token: '' } })
    assert.equal((await health({})).statusCode, 200)
  })

  it('PostgREST по сокету: шлюз (поток, заголовки, тело запроса) и внутренний клиент (/api/ready)', async () => {
    await makeApp()
    seen.length = 0
    const res = await app.inject({ method: 'GET', url: '/api/db/public_open_tenders?select=id', headers: { 'x-osp-web': TOKEN } })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), [{ id: 1 }, { id: 2 }])
    assert.equal(res.headers['content-range'], '0-1/2')
    assert.equal(seen[0].url, '/public_open_tenders?select=id')
    assert.match(seen[0].auth, /^Bearer ey/)
    const ready = await app.inject({ method: 'GET', url: '/api/ready', remoteAddress: '127.0.0.1' })
    assert.equal(ready.json().checks.gateway, 'ok', ready.body)
    assert.equal(seen.at(-1).url, '/app_settings?select=key&limit=1')

    const f = unixSocketFetch(sock)
    const post = await f('http://osp-postgrest.sock/rpc/x?a=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"p":"тело"}') })
    assert.equal(post.status, 200)
    assert.equal(seen.at(-1).body, '{"p":"тело"}')
    assert.equal(seen.at(-1).host, 'osp-postgrest')
    assert.equal(post.headers.get('x-many'), 'a, b')
    await post.text()
    const empty = await f('http://osp-postgrest.sock/empty', { method: 'DELETE' })
    assert.equal(empty.status, 204)
    assert.equal(empty.body, null)
    const head = await f('http://osp-postgrest.sock/x', { method: 'HEAD' })
    assert.equal(head.body, null)
    await assert.rejects(() => f('http://osp-postgrest.sock/x', { signal: AbortSignal.abort() }))
    await assert.rejects(() => unixSocketFetch(path.join(tmp, 'нет.sock'))('http://osp-postgrest.sock/x'))
  })
})
