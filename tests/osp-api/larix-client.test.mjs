// Клиент Larix.CPM (server/osp-api/src/lib/larixClient.js) против поддельного Larix на этой машине.
// Проверяем обещанное: тело входа ровно { username, password, app_code }, данные — с Bearer; только https
// и хост из списка; перенаправления не выполняются; предел размера ответа и времени; не-JSON и не-массив
// — отказ; логин, пароль и токен не попадают в тексты ошибок. Зависимостей и сети не нужно.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLarixClient, larixBaseUrl, LarixError, redact } from '../../server/osp-api/src/lib/larixClient.js'
import { parseLarix } from '../../server/osp-api/src/config.js'

const USER = 'larix-robot'
const PASS = 'Pa$$-w0rd-larix-secret'
const TOKEN = 'tok-eyJhbGciOi-secret-token-value'

function startFakeLarix(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(req, res, body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)),
  })))
}

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const BOQ = [{ project_id: 2, project_name: 'Дом 56', work_title: 'Газобетон', measure_title: 'м2', price_material: 807.45, price_work: 2185.5, contract_id: 93 }]

describe('Клиент Larix.CPM: вход, данные, защита логина и токена', () => {
  let larix
  let mode = 'ok'
  before(async () => {
    larix = await startFakeLarix((req, res, body) => {
      if (req.url === '/api-acs/users/login') {
        if (mode === 'deny') return json(res, 401, { message: `bad credentials for ${USER} / ${PASS}` })
        if (mode === 'login-redirect') { res.writeHead(307, { location: 'http://127.0.0.2:9/steal' }); return res.end() }
        if (mode === 'no-token') return json(res, 200, { ok: true })
        return json(res, 200, { access_token: TOKEN, refresh_token: 'r' })
      }
      if (req.url === '/api/contract/data/project_contract_boq') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: 'no token' })
        if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>oops</html>') }
        if (mode === 'object') return json(res, 200, { rows: BOQ })
        if (mode === 'big') {
          const text = JSON.stringify(Array.from({ length: 2000 }, () => BOQ[0]))
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
          return res.end(text)
        }
        if (mode === 'big-stream') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.write('[')
          for (let i = 0; i < 2000; i++) res.write(`${i ? ',' : ''}${JSON.stringify(BOQ[0])}`)
          return res.end(']')
        }
        if (mode === 'hang') return setTimeout(() => json(res, 200, BOQ), 2000)
        if (mode === 'error') return json(res, 500, { message: `internal: token ${TOKEN}` })
        return json(res, 200, BOQ)
      }
      json(res, 404, {})
    })
  })
  after(() => larix?.close())
  const client = (over = {}) => createLarixClient({ baseUrl: larix.url, username: USER, password: PASS, appCode: 'cpm', ...over })
  const rejects = async (fn, code, re) => {
    await assert.rejects(fn, (err) => {
      assert.ok(err instanceof LarixError, String(err))
      assert.equal(err.code, code, err.message)
      if (re) assert.match(err.message, re)
      for (const s of [USER, PASS, TOKEN]) assert.ok(!err.message.includes(s), `в тексте ошибки: ${s}`)
      return true
    })
  }

  it('вход ровно { username, password, app_code }, данные — с Bearer; ответ — массив позиций', async () => {
    mode = 'ok'
    larix.requests.length = 0
    const { rows, bytes } = await client().fetchBoq()
    assert.deepEqual(rows, BOQ)
    assert.ok(bytes > 0)
    const [login, data] = larix.requests
    assert.equal(login.method, 'POST')
    assert.deepEqual(JSON.parse(login.body), { username: USER, password: PASS, app_code: 'cpm' })
    assert.match(login.headers['content-type'], /application\/json/)
    assert.equal(data.method, 'GET')
    assert.equal(data.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(data.body, '')
  })

  it('неверный логин — login; в тексте ни логина, ни пароля, даже если Larix их вернул', async () => {
    mode = 'deny'
    await rejects(() => client().fetchBoq(), 'login', /неверный логин или пароль/)
  })

  it('перенаправление на входе не выполняется — пароль не уходит по чужому адресу', async () => {
    mode = 'login-redirect'
    await rejects(() => client().fetchBoq(), 'http')
  })

  it('нет токена в ответе на вход, не-JSON и не-массив вместо ВОР — invalid', async () => {
    mode = 'no-token'
    await rejects(() => client().fetchBoq(), 'invalid', /нет токена/)
    mode = 'html'
    await rejects(() => client().fetchBoq(), 'invalid', /не JSON/)
    mode = 'object'
    await rejects(() => client().fetchBoq(), 'invalid', /не массив/)
  })

  it('ответ больше предела — too_large: и по Content-Length, и по мере чтения потока', async () => {
    mode = 'big'
    await rejects(() => client({ maxBytes: 10_000 }).fetchBoq(), 'too_large')
    mode = 'big-stream'
    await rejects(() => client({ maxBytes: 10_000 }).fetchBoq(), 'too_large')
    const { rows } = await client({ maxBytes: 10_000_000 }).fetchBoq()
    assert.equal(rows.length, 2000)
  })

  it('Larix не ответил вовремя — timeout; ошибка сервера — http без токена в тексте', async () => {
    mode = 'hang'
    await rejects(() => client({ dataTimeoutMs: 300 }).fetchBoq(), 'timeout')
    mode = 'error'
    await rejects(() => client().fetchBoq(), 'http', /HTTP 500/)
  })

  it('Larix недоступен — http без адреса и учётки', async () => {
    const dead = createLarixClient({ baseUrl: 'http://127.0.0.1:9', username: USER, password: PASS })
    await rejects(() => dead.fetchBoq(), 'http', /недоступен/)
  })
})

describe('Адрес и настройки Larix', () => {
  it('только https и хост из списка; http — лишь к этой машине; без учётки, пути и параметров', () => {
    assert.equal(larixBaseUrl('https://cpm.su10.larix.ru'), 'https://cpm.su10.larix.ru')
    assert.equal(larixBaseUrl('https://CPM.su10.larix.ru/'), 'https://cpm.su10.larix.ru')
    assert.equal(larixBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
    for (const bad of ['http://cpm.su10.larix.ru', 'https://evil.example', 'https://cpm.su10.larix.ru.evil.example',
      'https://u:p@cpm.su10.larix.ru', 'https://cpm.su10.larix.ru/api', 'https://cpm.su10.larix.ru/?x=1', 'ftp://127.0.0.1', 'не адрес']) {
      assert.throws(() => larixBaseUrl(bad), /LARIX_BASE_URL/, bad)
    }
  })

  it('redact убирает значения секретов', () => {
    assert.equal(redact(`login ${USER} pass ${PASS}`, [PASS, USER]), 'login *** pass ***')
    assert.equal(redact('нет секретов', ['', null]), 'нет секретов')
  })

  it('LARIX_SYNC: выключено по умолчанию; включено с ошибкой — служба не запускается', () => {
    const base = { dbUrl: 'postgres://x@127.0.0.1/db', supabaseUrl: 'https://s.example', supabaseServiceKey: 'k' }
    assert.equal(parseLarix({}, base).sync, false)
    assert.deepEqual(parseLarix({ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS }, base).targets, ['db'])
    assert.deepEqual(parseLarix({ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS, LARIX_SYNC_TARGETS: 'db, supabase' }, base).targets, ['db', 'supabase'])
    const fails = [
      [{ LARIX_SYNC: '1' }, base, /LARIX_USERNAME/],
      [{ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS, LARIX_BASE_URL: 'http://cpm.su10.larix.ru' }, base, /https/],
      [{ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS, LARIX_SYNC_TARGETS: 'db,yandex' }, base, /неизвестно: yandex/],
      [{ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS }, { ...base, dbUrl: '' }, /OSP_DB_URL/],
      [{ LARIX_SYNC: '1', LARIX_USERNAME: USER, LARIX_PASSWORD: PASS, LARIX_SYNC_TARGETS: 'supabase' }, { ...base, supabaseServiceKey: '' }, /SUPABASE_SERVICE_ROLE_KEY/],
    ]
    for (const [env, b, re] of fails) {
      assert.throws(() => parseLarix(env, b), (err) => re.test(err.message) && !err.message.includes(PASS) && !err.message.includes(USER), JSON.stringify(env))
    }
  })
})
