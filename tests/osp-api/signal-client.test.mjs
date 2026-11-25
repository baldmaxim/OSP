// Клиент и адаптер SIGNAL (server/osp-api/src/lib/signalClient.js, signalApi.js) против поддельного SIGNAL на этой
// машине (tests/osp-api/lib/fake-signal.mjs). Живого SIGNAL, базы и сети не нужно. Проверяем обещанное в
// спецификации (разделы 0 и 6): точные хосты и только https, отказ при перенаправлении, секрет и токен не попадают
// в ошибки и журнал, 429 ждёт Retry-After (не короче retryAfterMinMs, С-61), 401 — один повтор с новым токеном, 5xx/550 — ограниченные повторы,
// 403/450 — без повтора, предел времени и размера, типы полей, пагинация Skip/Take без «следующего» адреса и
// отсутствие в коде путей и методов записи и скачивания. Чтение списков целиком (ПР-5): конец списка (С-58), повтор id и
// нестабильные страницы (С-60), удалённые элементы (В-10, С-4), «ядовитые» названия (В2-1).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSignalClient, SignalError, signalBaseUrl, redact, parseRetryAfter, SIGNAL_CLIENT_DEFAULTS, SIGNAL_TOKEN_PATH,
} from '../../server/osp-api/src/lib/signalClient.js'
import {
  createSignalApi, normalizeTree, normalizeItem, normalizeItems, normalizeProjects, SIGNAL_OPERATIONS, SIGNAL_PAGE_MAX,
} from '../../server/osp-api/src/lib/signalApi.js'
import * as signalApi from '../../server/osp-api/src/lib/signalApi.js'
import { startFakeSignal, CLIENT_ID, CLIENT_SECRET, fakeId } from './lib/fake-signal.mjs'

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'osp-api', 'src', 'lib')

describe('signalBaseUrl: точные хосты, https, без учётки, порта и пути', () => {
  it('принимает https и хост из списка (регистр не важен), по умолчанию — хост самого адреса', () => {
    assert.equal(signalBaseUrl('https://api.sgnl.pro').origin, 'https://api.sgnl.pro')
    assert.equal(signalBaseUrl('https://API.SGNL.PRO/', { hosts: ['api.sgnl.pro'] }).origin, 'https://api.sgnl.pro')
    assert.equal(signalBaseUrl('https://api.sgnl.pro:443').origin, 'https://api.sgnl.pro')
  })
  it('отказывает: http, чужой хост, похожий хост, учётка, чужой порт, путь, параметры', () => {
    const bad = [
      ['http://api.sgnl.pro', {}, /https/],
      ['https://evil.example', { hosts: ['api.sgnl.pro'] }, /SIGNAL_HOSTS/],
      ['https://api.sgnl.pro.evil.example', { hosts: ['api.sgnl.pro'] }, /SIGNAL_HOSTS/],
      ['https://sub.api.sgnl.pro', { hosts: ['api.sgnl.pro'] }, /SIGNAL_HOSTS/],
      ['https://user:pw@api.sgnl.pro', {}, /учётка/],
      ['https://user@api.sgnl.pro', {}, /учётка/],
      ['https://api.sgnl.pro:8443', {}, /порт/],
      ['https://api.sgnl.pro/public/v1', {}, /без пути/],
      ['https://api.sgnl.pro/?a=1', {}, /без пути/],
      ['https://api.sgnl.pro/#x', {}, /без пути/],
      ['', {}, /не разобран/],
      ['не адрес', {}, /не разобран/],
    ]
    for (const [url, opts, re] of bad) assert.throws(() => signalBaseUrl(url, opts), re, url)
  })
  it('http и любой порт — только к этой же машине и только при allowLoopback', () => {
    assert.throws(() => signalBaseUrl('http://127.0.0.1:8080'), /https/)
    assert.equal(signalBaseUrl('http://127.0.0.1:8080', { allowLoopback: true }).origin, 'http://127.0.0.1:8080')
    assert.throws(() => signalBaseUrl('http://example.com', { allowLoopback: true }), /https/)
    assert.throws(() => signalBaseUrl('http://example.com:8080', { allowLoopback: true, hosts: ['example.com'] }), /https/)
  })
})

describe('redact и Retry-After', () => {
  it('redact убирает секреты длиной от трёх знаков и не трогает короткие', () => {
    assert.equal(redact('a SECRET b TOKEN', ['SECRET', 'TOKEN']), 'a *** b ***')
    assert.equal(redact('ab ab', ['ab']), 'ab ab')
    assert.equal(redact(null, ['abc']), '')
  })
  it('Retry-After: секунды, дата, пусто, больше предела', () => {
    const o = { now: Date.parse('2026-11-23T10:00:00Z'), maxMs: 120_000, defaultMs: 2000 }
    assert.equal(parseRetryAfter('7', o), 7000)
    assert.equal(parseRetryAfter('0', o), 0)
    assert.equal(parseRetryAfter('9999', o), 120_000)
    assert.equal(parseRetryAfter('Mon, 23 Nov 2026 10:00:30 GMT', o), 30_000)
    assert.equal(parseRetryAfter('Mon, 23 Nov 2026 09:00:00 GMT', o), 0)
    assert.equal(parseRetryAfter('', o), 2000)
    assert.equal(parseRetryAfter(null, o), 2000)
    assert.equal(parseRetryAfter('скоро', o), 2000)
    assert.equal(parseRetryAfter('-5', o), 2000)
  })
  it('Retry-After: нижняя граница minMs (С-61) — «0», прошедшая дата и пустое значение не короче границы; верхняя граница сильнее', () => {
    const o = { now: Date.parse('2026-11-23T10:00:00Z'), minMs: 1000, maxMs: 120_000, defaultMs: 2000 }
    assert.equal(parseRetryAfter('0', o), 1000)
    assert.equal(parseRetryAfter('Mon, 23 Nov 2026 09:00:00 GMT', o), 1000)
    assert.equal(parseRetryAfter('7', o), 7000)
    assert.equal(parseRetryAfter('', o), 2000)
    assert.equal(parseRetryAfter('9999', o), 120_000)
    assert.equal(parseRetryAfter('0', { ...o, minMs: 500_000 }), 120_000, 'нижняя граница не выше верхней')
    assert.equal(SIGNAL_CLIENT_DEFAULTS.retryAfterMinMs, 1000)
    assert.equal(SIGNAL_CLIENT_DEFAULTS.maxRetryAfterMs, 120_000)
  })
})

describe('Клиент SIGNAL против поддельного SIGNAL', () => {
  let fake
  let waits
  let logs
  const log = { warn: (obj, msg) => logs.push({ level: 'warn', msg, obj }), info: (obj, msg) => logs.push({ level: 'info', msg, obj }) }
  const sleep = async (ms) => { waits.push(ms) }
  const mk = (over = {}) => createSignalClient({
    baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, sleep, log, ...over,
  })
  const get = (client, p = '/public/v1/projects', query = { Skip: 0, Take: 100 }, opts) => client.request({ method: 'GET', path: p, query }, opts)
  const dataRequests = () => fake.requests.filter((r) => r.path !== SIGNAL_TOKEN_PATH)
  const noSecrets = (text, extra = []) => {
    for (const s of [CLIENT_SECRET, CLIENT_ID, fake.lastToken, ...extra].filter(Boolean)) assert.ok(!String(text).includes(s), `в тексте есть секрет: ${s}`)
  }
  const rejects = async (fn, code, { status, re } = {}) => {
    await assert.rejects(fn, (err) => {
      assert.ok(err instanceof SignalError, String(err))
      assert.equal(err.code, code, err.message)
      if (status !== undefined) assert.equal(err.status, status)
      if (re) assert.match(err.message, re)
      noSecrets(err.message)
      return true
    })
  }

  before(async () => { fake = await startFakeSignal() })
  after(async () => { await fake.close() })
  beforeEach(() => {
    fake.clearFaults()
    fake.resetRequests()
    fake.revokeTokens()
    fake.leakNext = false
    fake.treeShape = 'object'
    fake.delayMs = 0
    fake.expiresIn = 3600
    fake.state.projects.length = 0
    waits = []
    logs = []
  })

  it('без идентификатора или секрета — not_configured, в сеть не ходит', async () => {
    for (const over of [{ clientId: '' }, { clientSecret: '' }, { clientId: '', clientSecret: '' }]) {
      const client = mk(over)
      assert.equal(client.configured, false)
      await rejects(() => get(client), 'not_configured')
      await rejects(() => client.ensureToken(), 'not_configured')
    }
    assert.equal(fake.requests.length, 0)
  })

  it('токен: тело ровно { clientId, clientSecret, scopes }, данные — с Bearer; токен используется повторно', async () => {
    fake.addProject({ name: 'Проект А' })
    const client = mk()
    const first = await get(client)
    assert.equal(first.length, 1)
    await get(client)
    const tokenCalls = fake.requests.filter((r) => r.path === SIGNAL_TOKEN_PATH)
    assert.equal(tokenCalls.length, 1, 'токен запрошен один раз')
    assert.deepEqual(Object.keys(tokenCalls[0].body).sort(), ['clientId', 'clientSecret', 'scopes'])
    assert.deepEqual(tokenCalls[0].body.scopes, ['project:list', 'docs:folder:read', 'docs:item:list'])
    assert.equal(tokenCalls[0].method, 'POST')
    assert.equal(tokenCalls[0].headers.authorization, undefined, 'при получении токена Authorization не передаётся')
    for (const r of dataRequests()) {
      assert.equal(r.method, 'GET')
      assert.equal(r.headers.authorization, `Bearer ${fake.lastToken}`)
    }
  })

  it('токен обновляется за минуту до срока; параллельные запросы получают один токен', async () => {
    fake.addProject({ name: 'Проект А' })
    let at = 1_000_000
    fake.expiresIn = 300
    const client = mk({ now: () => at })
    await Promise.all([get(client), get(client), get(client)])
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 1, 'один обмен на три параллельных запроса')
    at += 238_000 // осталось 62 с — ещё действует
    await get(client)
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 1)
    at += 3_000 // осталось 59 с — пора обновить
    await get(client)
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 2)
    const info = await client.ensureToken()
    assert.ok(info.expiresInSec > 200 && info.expiresInSec <= 300)
    assert.ok(!('token' in info), 'сам токен наружу не отдаётся')
  })

  it('неверный секрет — auth, неизвестное право — scope, битый ответ о токене — invalid', async () => {
    await rejects(() => get(mk({ clientSecret: 'wrong-secret-value' })), 'auth', { status: 422 })
    await rejects(() => get(mk({ scopes: ['project:list', 'docs:write:everything'] })), 'scope', { status: 422 })
    fake.fail(SIGNAL_TOKEN_PATH, { status: 200, body: { token: 'x', expiresIn: 3600 } })
    await rejects(() => get(mk()), 'invalid')
    fake.fail(SIGNAL_TOKEN_PATH, { status: 200, body: { token: 'tok-valid-looking-value', expiresIn: 'долго' } })
    await rejects(() => get(mk()), 'invalid')
    fake.fail(SIGNAL_TOKEN_PATH, { status: 401, body: { message: `no ${CLIENT_SECRET}` } })
    await rejects(() => get(mk()), 'auth', { status: 401 })
    assert.equal(dataRequests().length, 0, 'без токена данные не запрашиваются')
  })

  it('метод и путь вне разрешённых отвергаются до обращения к сети', async () => {
    const client = mk()
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'put', '']) {
      await rejects(() => client.request({ method, path: '/public/v1/projects' }), 'invalid')
    }
    for (const p of [
      '//evil.example/public/v1/projects', 'https://evil.example/public/v1/projects', '/public/v1/projects@evil.example',
      '/public/v1/../admin', '/public/v1/projects?x=1', '/public/v1/projects#x', '/public/v1/', '/api/other', '', null, '/public/v1/a b',
      '/public/v1/projects/%2e%2e/x', '\\\\evil.example\\x',
    ]) {
      await rejects(() => client.request({ method: 'GET', path: p }), 'invalid')
    }
    // POST разрешён только токену и поиску элементов (он читает)
    await rejects(() => client.request({ method: 'POST', path: '/public/v1/projects', body: {} }), 'invalid')
    await rejects(() => client.request({ method: 'POST', path: '/public/v1/items', body: {} }), 'invalid')
    await rejects(() => client.request({ method: 'POST', path: '/public/v1/folders', body: {} }), 'invalid')
    await rejects(() => client.request({ method: 'POST', path: '/public/v1/items/search/extra', body: {} }), 'invalid')
    assert.equal(fake.requests.length, 0)
    assert.deepEqual(fake.violations, [])
  })

  it('хост каждого адреса сверяется со списком: клиент не создаётся для чужого хоста', () => {
    assert.throws(() => mk({ hosts: ['api.sgnl.pro'] }), /SIGNAL_HOSTS/)
    assert.throws(() => createSignalClient({ baseUrl: 'https://evil.example', hosts: ['api.sgnl.pro'], clientId: 'a', clientSecret: 'bbb' }), /SIGNAL_HOSTS/)
    assert.throws(() => createSignalClient({ baseUrl: 'http://api.sgnl.pro', clientId: 'a', clientSecret: 'bbb' }), /https/)
    assert.throws(() => createSignalClient({ baseUrl: 'https://api.sgnl.pro:8443', clientId: 'a', clientSecret: 'bbb' }), /порт/)
    assert.throws(() => createSignalClient({ baseUrl: 'https://u:p@api.sgnl.pro', clientId: 'a', clientSecret: 'bbb' }), /учётка/)
    // без allowLoopback даже локальный http не принимается
    assert.throws(() => createSignalClient({ baseUrl: fake.url, clientId: 'a', clientSecret: 'bbb' }), /https/)
  })

  it('перенаправление не выполняется: ни на данных, ни при получении токена; повтора нет', async () => {
    fake.fail('/projects', { status: 307, headers: { location: 'http://127.0.0.2:9/steal' }, times: 5 })
    await rejects(() => get(mk()), 'http', { re: /перенаправление/ })
    assert.equal(dataRequests().length, 1, 'одна попытка, без повторов')
    assert.deepEqual(waits, [])

    fake.clearFaults()
    fake.resetRequests()
    fake.fail(SIGNAL_TOKEN_PATH, { status: 302, headers: { location: 'https://evil.example.invalid/token' }, times: 5 })
    await rejects(() => get(mk()), 'http', { re: /перенаправление/ })
    assert.equal(fake.requests.length, 1)
  })

  it('«следующий» адрес из ответа (заголовок Link, поле next) не используется', async () => {
    fake.leakNext = true
    const project = fake.addProject({ name: 'Проект А' })
    fake.build(project, { name: 'Объект 1', items: 3 })
    const api = createSignalApi({ client: mk() })
    await api.listProjects()
    await api.getFolderTree(project)
    const folder = [...fake.state.folders.get(project).values()].find((f) => f.name === 'Объект 1').id
    await api.listItems(folder)
    assert.ok(fake.requests.length >= 4)
    for (const r of fake.requests) assert.ok(!JSON.stringify(r).includes('evil'), 'запрос ушёл по чужому адресу')
    assert.deepEqual(fake.violations, [])
  })

  it('секрет и токен не попадают в тексты ошибок и в журнал', async () => {
    // ответы сервера с секретом и токеном в теле
    fake.fail('/projects', { status: 500, times: 10, body: (_req, f) => `internal: token ${f.lastToken} secret ${CLIENT_SECRET} id ${CLIENT_ID}` })
    await rejects(() => get(mk()), 'http', { status: 500 })
    fake.clearFaults()
    fake.fail('/projects', { status: 403, body: (_req, f) => `forbidden ${f.lastToken} ${CLIENT_SECRET}` })
    await rejects(() => get(mk()), 'scope', { status: 403 })
    fake.fail('/projects', { status: 404, body: `not found ${CLIENT_SECRET}` })
    await rejects(() => get(mk()), 'http', { status: 404 })
    fake.fail(SIGNAL_TOKEN_PATH, { status: 422, body: `"${CLIENT_SECRET}"` })
    await rejects(() => get(mk()), 'http', { status: 422 })
    // сбой сети, где драйвер вставил секрет в свой текст
    const leaking = mk({ fetch: async () => { throw Object.assign(new Error(`socket ${CLIENT_SECRET} ${CLIENT_ID} closed`), { cause: { code: 'ECONNRESET' } }) }, retries: 0 })
    await assert.rejects(() => get(leaking), (err) => { noSecrets(err.message); assert.equal(err.code, 'http'); return true })
    const text = JSON.stringify(logs)
    noSecrets(text)
    assert.ok(logs.length > 0, 'повторы записаны в журнал')
  })

  it('токен из ответа не попадает в ошибку, даже если фальшивый fetch вставил его в текст', async () => {
    let issued = ''
    const fetch = async (url, init) => {
      if (String(url).endsWith(SIGNAL_TOKEN_PATH)) {
        issued = 'tok-issued-by-stub-1234567890'
        return new Response(JSON.stringify({ token: issued, expiresIn: 3600 }), { status: 200 })
      }
      throw new Error(`broken pipe while sending ${init.headers.authorization}`)
    }
    const client = mk({ fetch, retries: 0 })
    await assert.rejects(() => get(client), (err) => {
      assert.ok(!err.message.includes(issued), err.message)
      assert.ok(!err.message.includes(CLIENT_SECRET))
      return true
    })
  })

  it('429: ждёт Retry-After (не больше двух минут) и повторяет запрос', async () => {
    fake.addProject({ name: 'Проект А' })
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '7' } })
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '9999' } })
    fake.fail('/projects', { status: 429 })
    fake.fail('/projects', { status: 429, headers: { 'retry-after': 'Mon, 01 Jan 2001 00:00:00 GMT' } })
    const result = await get(mk())
    assert.equal(result.length, 1)
    assert.deepEqual(waits, [7000, 120_000, SIGNAL_CLIENT_DEFAULTS.defaultRetryAfterMs, SIGNAL_CLIENT_DEFAULTS.retryAfterMinMs], 'прошедшая дата — не 0, а нижняя граница')
    assert.equal(fake.count('/projects', 'GET'), 5)
  })

  it('С-61: «Retry-After: 0» не даёт десять повторов подряд — каждое ожидание не короче нижней границы (1 с по умолчанию)', async () => {
    fake.rateLimit({ match: '/projects', times: 1000, retryAfter: 0 })
    await rejects(() => get(mk()), 'rate_limited', { status: 429 })
    assert.equal(waits.length, SIGNAL_CLIENT_DEFAULTS.maxRateRetries)
    assert.ok(waits.every((w) => w >= 1000), `ожидания: ${waits.join(', ')}`)
    assert.ok(waits.reduce((a, b) => a + b, 0) >= 10_000, 'десять повторов занимают не меньше десяти секунд, а не 64 мс')
    assert.equal(fake.count('/projects', 'GET'), 11)
  })

  it('С-61: retryAfterMinMs настраивается (в том числе 0 — старое поведение); значение сервера выше границы не меняется', async () => {
    fake.rateLimit({ match: '/projects', times: 2, retryAfter: 0 })
    fake.addProject({ name: 'Проект А' })
    assert.equal((await get(mk({ retryAfterMinMs: 0 }))).length, 1)
    assert.deepEqual(waits, [0, 0])
    waits.length = 0
    fake.rateLimit({ match: '/projects', times: 2, retryAfter: 0 })
    assert.equal((await get(mk({ retryAfterMinMs: 3000 }))).length, 1)
    assert.deepEqual(waits, [3000, 3000])
    waits.length = 0
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '5' } })
    assert.equal((await get(mk({ retryAfterMinMs: 3000 }))).length, 1)
    assert.deepEqual(waits, [5000])
    waits.length = 0
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '500' } })
    assert.equal((await get(mk({ retryAfterMaxMs: 20_000 }))).length, 1)
    assert.deepEqual(waits, [20_000], 'верхняя граница настраивается (retryAfterMaxMs)')
    waits.length = 0
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '500' } })
    assert.equal((await get(mk({ maxRetryAfterMs: 15_000 }))).length, 1)
    assert.deepEqual(waits, [15_000], 'прежнее имя maxRetryAfterMs действует, если новое не задано')
    waits.length = 0
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '500' } })
    assert.equal((await get(mk({ retryAfterMaxMs: 8000, maxRetryAfterMs: 15_000 }))).length, 1)
    assert.deepEqual(waits, [8000], 'retryAfterMaxMs сильнее')
    waits.length = 0
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '0' } })
    assert.equal((await get(mk({ retryAfterMinMs: 'не число' }))).length, 1)
    assert.deepEqual(waits, [1000], 'неверное значение — по умолчанию')
  })

  it('429 без конца — после предела повторов rate_limited', async () => {
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '1' }, times: 1000 })
    await rejects(() => get(mk({ maxRateRetries: 3 })), 'rate_limited', { status: 429 })
    assert.deepEqual(waits, [1000, 1000, 1000])
    assert.equal(fake.count('/projects', 'GET'), 4)
  })

  it('ожидание 429 прерывается отменой запуска', async () => {
    fake.fail('/projects', { status: 429, headers: { 'retry-after': '100' }, times: 1000 })
    const controller = new AbortController()
    const client = mk({ sleep: undefined }) // настоящее ожидание
    const started = Date.now()
    const pending = get(client, undefined, undefined, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('stop')), 150)
    await rejects(() => pending, 'aborted')
    assert.ok(Date.now() - started < 3000, 'ожидание не досиживается')
    assert.equal(fake.count('/projects', 'GET'), 1)
  })

  it('401: один повтор с новым токеном и успех; постоянный 401 — auth после одного повтора', async () => {
    fake.addProject({ name: 'Проект А' })
    const client = mk()
    await get(client)
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 1)
    fake.revokeTokens() // токен отозван на стороне SIGNAL
    const again = await get(client)
    assert.equal(again.length, 1)
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 2, 'новый токен')
    assert.equal(dataRequests().length, 3, 'запрос, 401 и повтор')

    fake.resetRequests()
    fake.fail('/projects', { status: 401, times: 10 })
    await rejects(() => get(mk()), 'auth', { status: 401 })
    assert.equal(dataRequests().length, 2, 'ровно один повтор')
    assert.equal(fake.count(SIGNAL_TOKEN_PATH), 2, 'токен перезапрошен один раз')
  })

  it('5xx и 550: повторы с задержкой, не больше трёх; затем http со статусом', async () => {
    fake.addProject({ name: 'Проект А' })
    fake.fail('/projects', { status: 503, times: 2 })
    assert.equal((await get(mk())).length, 1)
    assert.deepEqual(waits, SIGNAL_CLIENT_DEFAULTS.backoffMs.slice(0, 2))
    assert.equal(fake.count('/projects', 'GET'), 3)

    for (const status of [500, 502, 550]) {
      fake.clearFaults()
      fake.resetRequests()
      waits.length = 0
      fake.fail('/projects', { status, times: 100 })
      await rejects(() => get(mk()), 'http', { status })
      assert.equal(fake.count('/projects', 'GET'), 4, `${status}: попытка и три повтора`)
      assert.deepEqual(waits, SIGNAL_CLIENT_DEFAULTS.backoffMs)
    }
  })

  it('обрыв связи повторяется в тех же пределах; недоступный порт — http без секретов', async () => {
    const client = createSignalClient({
      baseUrl: 'http://127.0.0.1:9', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, sleep, log, timeoutMs: 2000,
    })
    await rejects(() => get(client), 'http')
    assert.deepEqual(waits, SIGNAL_CLIENT_DEFAULTS.backoffMs)
  })

  it('403 и 450 — без повтора; 404 и 400 — без повтора, со статусом', async () => {
    const cases = [[403, 'scope'], [450, 'rate_limited'], [404, 'http'], [400, 'http'], [409, 'http']]
    for (const [status, code] of cases) {
      fake.clearFaults()
      fake.resetRequests()
      waits.length = 0
      fake.fail('/projects', { status, times: 100 })
      await rejects(() => get(mk()), code, { status })
      assert.equal(fake.count('/projects', 'GET'), 1, `HTTP ${status}: ровно одна попытка`)
      assert.deepEqual(waits, [])
    }
  })

  it('предел времени: зависший ответ — timeout без повторов', async () => {
    fake.fail('/projects', { hang: true, times: 5 })
    const started = Date.now()
    await rejects(() => get(mk({ timeoutMs: 250 })), 'timeout')
    assert.ok(Date.now() - started < 3000)
    assert.equal(fake.count('/projects', 'GET'), 1)
    assert.deepEqual(waits, [])
  })

  it('предел размера: объявленный и фактический (по мере чтения) → too_large', async () => {
    fake.fail('/projects', { bigDeclared: 50_000_000 })
    await rejects(() => get(mk({ maxBytes: 100_000 })), 'too_large')
    fake.fail('/projects', { bigBody: 2_000_000 })
    await rejects(() => get(mk({ maxBytes: 100_000 })), 'too_large')
    assert.equal(fake.count('/projects', 'GET'), 2, 'без повторов')
  })

  it('ответ не JSON или пустой → invalid', async () => {
    fake.fail('/projects', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>oops</html>' })
    await rejects(() => get(mk()), 'invalid')
    fake.fail('/projects', { status: 200, body: '' })
    await rejects(() => get(mk()), 'invalid')
  })

  it('все запросы — только разрешённые методы и пути (чтение и токен)', async () => {
    const project = fake.addProject({ name: 'Проект А' })
    const { ids } = fake.build(project, { name: 'Объект 1', items: 2 })
    const api = createSignalApi({ client: mk() })
    await api.getToken()
    await api.listProjects()
    await api.getFolderTree(project)
    await api.listItems(ids['Объект 1'])
    await api.searchItems(ids['Объект 1'], { modifiedFrom: '2026-01-01T00:00:00Z' })
    assert.deepEqual(fake.violations, [])
    assert.deepEqual([...new Set(fake.paths())].sort(), [
      'GET /public/v1/items', 'GET /public/v1/projects', `GET /public/v1/projects/${project}/folders/tree`,
      'POST /public/v1/auth/token', 'POST /public/v1/items/search',
    ].sort())
  })
})

describe('Адаптер SIGNAL (signalApi.js)', () => {
  let fake
  let project
  let ids
  const mkApi = (over = {}) => createSignalApi({
    client: createSignalClient({
      baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, sleep: async () => {}, ...over,
    }),
  })
  const rejectsInvalid = async (fn) => assert.rejects(fn, (err) => err instanceof SignalError && err.code === 'invalid')

  before(async () => {
    fake = await startFakeSignal()
    project = fake.addProject({ name: 'Проект А', code: 'PA' })
    ;({ ids } = fake.build(project, [
      { name: 'Объект 1', items: 450, children: [{ name: 'Договоры', items: 2 }, { name: 'Корпус 14', children: [{ name: 'Акты' }] }] },
      { name: 'Объект 2' },
    ]))
  })
  after(async () => { await fake.close() })
  beforeEach(() => { fake.clearFaults(); fake.resetRequests(); fake.treeShape = 'object' })

  it('набор операций — ровно токен и четыре чтения', () => {
    assert.deepEqual([...SIGNAL_OPERATIONS].sort(), ['getFolderTree', 'getToken', 'listItems', 'listProjects', 'searchItems'])
    const api = mkApi()
    assert.deepEqual(Object.keys(api).filter((k) => typeof api[k] === 'function').sort(), [...SIGNAL_OPERATIONS].sort())
  })

  it('listProjects: Skip/Take, названия без лишних полей', async () => {
    fake.addProject({ name: 'Проект Б' })
    const api = mkApi()
    const page = await api.listProjects({ skip: 0, take: 1 })
    assert.deepEqual(page, [{ id: project, name: 'Проект А', code: 'PA' }])
    const rest = await api.listProjects({ skip: 1, take: 1 })
    assert.equal(rest.length, 1)
    assert.equal(rest[0].code, null)
    const req = fake.requests.find((r) => r.path === '/public/v1/projects')
    assert.deepEqual(req.query, { Skip: '0', Take: '1' })
    await rejectsInvalid(() => api.listProjects({ take: 201 }))
    await rejectsInvalid(() => api.listProjects({ take: 0 }))
    await rejectsInvalid(() => api.listProjects({ skip: -1 }))
    await rejectsInvalid(() => api.listProjects({ skip: 1.5 }))
  })

  it('getFolderTree: плоский список в порядке обхода — путь, предки, глубина; корень или массив корней', async () => {
    const api = mkApi()
    const nodes = await api.getFolderTree(project)
    assert.deepEqual(nodes.map((n) => n.path), [
      'Документы', 'Документы / Объект 1', 'Документы / Объект 1 / Договоры', 'Документы / Объект 1 / Корпус 14',
      'Документы / Объект 1 / Корпус 14 / Акты', 'Документы / Объект 2',
    ])
    const acts = nodes.find((n) => n.name === 'Акты')
    assert.deepEqual(acts.pathIds, [fake.rootOf(project), ids['Объект 1'], ids['Объект 1 / Корпус 14']])
    assert.equal(acts.parentId, ids['Объект 1 / Корпус 14'])
    assert.equal(acts.depth, 3)
    assert.equal(acts.kind, 'folder')
    assert.equal(nodes[0].parentId, null)
    assert.match(nodes[0].modifiedAt, /^2026-01-01T/)
    fake.treeShape = 'array'
    assert.deepEqual((await api.getFolderTree(project)).map((n) => n.nodeId), nodes.map((n) => n.nodeId))
    assert.equal(fake.count('/folders/tree'), 2, 'одно обращение на дерево')
  })

  it('listItems: пагинация Skip/Take без «next» (450 элементов → 200 + 200 + 50), ссылки и лишние поля отброшены', async () => {
    fake.leakNext = true
    const api = mkApi()
    const folder = ids['Объект 1']
    const seen = []
    for (let skip = 0; ; skip += SIGNAL_PAGE_MAX) {
      const page = await api.listItems(folder, { skip, take: SIGNAL_PAGE_MAX })
      seen.push(page)
      if (page.length < SIGNAL_PAGE_MAX) break
    }
    fake.leakNext = false
    assert.deepEqual(seen.map((p) => p.length), [200, 200, 50])
    assert.equal(new Set(seen.flat().map((i) => i.nodeId)).size, 450)
    const item = seen[0][0]
    assert.deepEqual(Object.keys(item).sort(), ['deleted', 'itemType', 'kind', 'modifiedAt', 'name', 'nodeId', 'parentId', 'versionNumber'])
    assert.equal(item.parentId, folder)
    assert.equal(item.kind, 'item')
    assert.equal(item.itemType, 'File')
    assert.equal(item.versionNumber, 1)
    assert.equal(item.deleted, false)
    const queries = fake.requests.filter((r) => r.path === '/public/v1/items').map((r) => r.query)
    assert.deepEqual(queries.map((q) => [q.Skip, q.Take, q.deleted, q.folderId]), [
      ['0', '200', 'false', folder], ['200', '200', 'false', folder], ['400', '200', 'false', folder],
    ])
    for (const r of fake.requests) assert.ok(!JSON.stringify(r).includes('evil'))
  })

  it('listItems: удалённые не запрашиваются; папка, которой нет, — http 404', async () => {
    const api = mkApi()
    const folder = ids['Объект 2']
    fake.setItems(folder, [
      { id: fakeId('item', 9001), name: 'Живой.pdf', type: 'File', modified: '2026-02-01T00:00:00Z', added: '2026-02-01T00:00:00Z', deleted: false, topVersionNumber: 2 },
      { id: fakeId('item', 9002), name: 'Удалённый.pdf', type: 'File', modified: '2026-02-01T00:00:00Z', added: '2026-02-01T00:00:00Z', deleted: true, topVersionNumber: 1 },
    ])
    assert.deepEqual((await api.listItems(folder)).map((i) => i.name), ['Живой.pdf'])
    await assert.rejects(() => api.listItems(fakeId('folder', 424242)), (e) => e.code === 'http' && e.status === 404)
  })

  it('searchItems: POST — чтение; тело { folderId, modifiedFrom }, элементы вложенных папок', async () => {
    const api = mkApi()
    const found = await api.searchItems(ids['Объект 1'], { modifiedFrom: '2026-01-01T00:00:00Z', take: 200 })
    assert.equal(found.length, 200)
    const tail = await api.searchItems(ids['Объект 1'], { skip: 400, take: 200 })
    assert.equal(tail.length, 52, '450 элементов папки и 2 во вложенной «Договоры»')
    assert.ok(tail.some((i) => i.parentId !== ids['Объект 1']), 'поиск идёт и по вложенным папкам')
    const req = fake.requests.find((r) => r.path === '/public/v1/items/search')
    assert.equal(req.method, 'POST')
    assert.deepEqual(req.body, { folderId: ids['Объект 1'], modifiedFrom: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(req.query, { Skip: '0', Take: '200' })
    const none = await api.searchItems(ids['Объект 1'], { modifiedFrom: new Date('2031-01-01T00:00:00Z') })
    assert.deepEqual(none, [])
    await rejectsInvalid(() => api.searchItems(ids['Объект 1'], { modifiedFrom: 'вчера' }))
  })

  it('идентификаторы в параметрах проверяются до запроса', async () => {
    const api = mkApi()
    for (const bad of ['', 'abc', '../x', fakeId('folder', 1) + '/x', null, 5]) {
      await rejectsInvalid(() => api.getFolderTree(bad))
      await rejectsInvalid(() => api.listItems(bad))
      await rejectsInvalid(() => api.searchItems(bad))
    }
    assert.equal(fake.requests.length, 0)
  })

  it('ответ с неверным типом поля → invalid (fail без частичного результата)', async () => {
    const api = mkApi()
    const bad = [
      ['/projects', [{ id: 'не-uuid', name: 'x' }]],
      ['/projects', [{ id: fakeId('project', 1), name: 5 }]],
      ['/projects', { items: [] }],
      ['/folders/tree', { id: fakeId('folder', 1), name: 'a', children: {} }],
      ['/folders/tree', { id: 'нет', name: 'a', children: [] }],
      ['/folders/tree', { id: fakeId('folder', 1), name: null, children: [] }],
      ['/folders/tree', { id: fakeId('folder', 1), name: 'a', modified: 'не дата', children: [] }],
      ['/folders/tree', { id: fakeId('folder', 1), name: 'a', modified: 12, children: [] }],
      ['/folders/tree', [{ id: fakeId('folder', 1), name: 'a', children: [{ id: fakeId('folder', 1), name: 'b' }] }]],
      ['/folders/tree', []],
      ['/folders/tree', 'строка'],
      ['/items', { id: fakeId('item', 1) }],
      ['/items', [{ id: 'x', name: 'a', folderId: fakeId('folder', 1) }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: fakeId('folder', 777) }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: ids['Объект 2'], deleted: 'false' }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: ids['Объект 2'], topVersionNumber: '3' }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: ids['Объект 2'], topVersionNumber: 1.5 }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: ids['Объект 2'], type: { x: 1 } }]],
      ['/items', [{ id: fakeId('item', 1), name: 'a', folderId: ids['Объект 2'], modified: true }]],
      ['/items', Array.from({ length: 201 }, (_, i) => ({ id: fakeId('item', i + 1), name: 'a', folderId: ids['Объект 2'] }))],
    ]
    for (const [match, body] of bad) {
      fake.clearFaults()
      fake.fail(match, { status: 200, body })
      const call = match === '/projects' ? () => api.listProjects()
        : match === '/folders/tree' ? () => api.getFolderTree(project) : () => api.listItems(ids['Объект 2'])
      await rejectsInvalid(call)
    }
  })

  it('нормализаторы: управляющие знаки в названиях, ошибки без частичного результата, предел глубины и числа папок', () => {
    const node = (id, name, children) => ({ id: fakeId('folder', id), name, children })
    const flat = normalizeTree(node(1, 'Кор\u0000ень\n', [node(2, ' а\tб ', [])]))
    assert.deepEqual(flat.map((n) => n.name), ['Кор ень', 'а б'])
    assert.equal(flat[1].path, 'Кор ень / а б')
    assert.throws(() => normalizeTree(node(1, 'a', [node(2, 'b', [node(3, 'c', [])])]), { maxDepth: 1 }), (e) => e.code === 'invalid')
    assert.throws(() => normalizeTree(node(1, 'a', [node(2, 'b', []), node(3, 'c', [])]), { maxNodes: 2 }), (e) => e.code === 'invalid')
    // глубокое вложение не роняет службу рекурсией
    let deep = { id: fakeId('folder', 100000), name: 'x', children: [] }
    for (let i = 1; i < 150; i++) deep = { id: fakeId('folder', 100000 + i), name: 'x', children: [deep] }
    assert.equal(normalizeTree(deep).length, 150)
    assert.equal(normalizeProjects([{ id: fakeId('project', 1), name: 'П' }])[0].code, null)
    assert.equal(normalizeItem({ id: fakeId('item', 1), name: 'a', folderId: fakeId('folder', 1), type: 'Link', modified: null }).modifiedAt, null)
    assert.deepEqual(normalizeItems([], { take: 200 }), [])
  })
})

describe('Названия: «ядовитые» не останавливают ответ (В2-1)', () => {
  const node = (id, name, children = []) => ({ id: fakeId('folder', id), name, children })
  it('непарный суррогат заменяется, управляющие знаки — пробелом, длиннее 500 знаков — усечение без разрыва пары', () => {
    const flat = normalizeTree(node(1, 'Корень', [node(2, 'Папка А \ud83d'), node(3, 'Д'.repeat(499) + '😀хвост'), node(4, 'Е'.repeat(900))]))
    assert.equal(flat[1].name, 'Папка А �')
    assert.ok(flat[1].name.isWellFormed())
    assert.equal(flat[2].name.length, 499, 'пара не разорвана: лишняя половина отброшена')
    assert.ok(flat[2].name.isWellFormed())
    assert.equal(flat[3].name.length, 500)
    assert.ok(flat.every((n) => n.name.isWellFormed() && n.path.isWellFormed()))
    assert.ok(JSON.stringify(flat).length > 0)
    const item = normalizeItem({ id: fakeId('item', 1), name: `Ж${'я'.repeat(600)}`, folderId: fakeId('folder', 1), type: 'File' })
    assert.equal(item.name.length, 500)
    assert.equal(normalizeItem({ id: fakeId('item', 2), name: 'x\ud800y', folderId: fakeId('folder', 1) }).name, 'x�y')
  })
  it('тип поля по-прежнему проверяется: не строка — invalid', () => {
    assert.throws(() => normalizeTree(node(1, null)), (e) => e.code === 'invalid')
    assert.throws(() => normalizeItem({ id: fakeId('item', 1), name: 5, folderId: fakeId('folder', 1) }), (e) => e.code === 'invalid')
  })
})

describe('Чтение списка элементов целиком (signalApi.readFolderItems, findDeletedItems)', () => {
  let fake
  let folder
  const mkApi = (over = {}) => createSignalApi({
    client: createSignalClient({ baseUrl: fake.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowLoopback: true, sleep: async () => {}, ...over }),
  })
  const itemQueries = () => fake.requests.filter((r) => r.path === '/public/v1/items').map((r) => `${r.query.Skip}/${r.query.Take}${r.query.deleted === 'true' ? 'd' : ''}`)

  before(async () => { fake = await startFakeSignal() })
  after(async () => { await fake.close() })
  beforeEach(() => {
    fake.clearFaults()
    fake.resetRequests()
    fake.pageCap = 0
    fake.deletedMode = 'only'
    fake.revokeTokens()
    fake.state.projects.length = 0
    for (const m of [fake.state.folders, fake.state.items, fake.state.itemStatus, fake.state.itemHooks, fake.state.itemCalls]) m.clear()
    fake.state.scrambled.clear()
    const project = fake.addProject({ name: 'Проект А' })
    folder = fake.build(project, { name: 'Папка' }).ids['Папка']
  })

  it('С-58: конец списка — пустая страница (по умолчанию): 450 элементов → 200 + 200 + 50 + пустая, один запрос сверки первой страницы', async () => {
    fake.addItems(folder, 450)
    const r = await signalApi.readFolderItems(mkApi(), folder)
    assert.equal(r.items.length, 450)
    assert.equal(r.unstable, false)
    assert.deepEqual(itemQueries(), ['0/200', '200/200', '400/200', '450/200', '0/200'])
  })

  it('С-58: короткая нефинальная страница не принимается за конец; режим short (после проверки пробой) — принимает', async () => {
    fake.addItems(folder, 450)
    fake.pageCap = 100
    const empty = await signalApi.readFolderItems(mkApi(), folder, { pageEnd: 'empty' })
    assert.equal(empty.items.length, 450, 'страницы по 100 при Take=200: Skip растёт на число полученных')
    assert.deepEqual(itemQueries().slice(0, 6), ['0/200', '100/200', '200/200', '300/200', '400/200', '450/200'])
    fake.resetRequests()
    const short = await signalApi.readFolderItems(mkApi(), folder, { pageEnd: 'short' })
    assert.equal(short.items.length, 100, 'short принимает первую короткую страницу за последнюю — потеря 350 элементов')
    assert.deepEqual(itemQueries(), ['0/200'])
    // неизвестное значение настройки — защитный режим
    fake.resetRequests()
    assert.equal((await signalApi.readFolderItems(mkApi(), folder, { pageEnd: 'что-то' })).items.length, 450)
  })

  it('мелкие случаи: пустая папка — один запрос; одна страница — сверки первой страницы нет', async () => {
    assert.deepEqual((await signalApi.readFolderItems(mkApi(), folder)).items, [])
    assert.deepEqual(itemQueries(), ['0/200'])
    fake.resetRequests()
    fake.addItems(folder, 5)
    assert.equal((await signalApi.readFolderItems(mkApi(), folder)).items.length, 5)
    assert.deepEqual(itemQueries(), ['0/200', '5/200'])
  })

  it('С-60: повтор id между страницами — дубль пропущен, не сбой; одна перепроверка целиком даёт полный список', async () => {
    fake.addItems(folder, 450)
    // пока читается первая страница, вверху списка появляется новый элемент: вторая страница начнётся с повтора
    fake.onItems(folder, (n, f) => {
      if (n === 2) f.state.items.get(folder).unshift({ ...f.state.items.get(folder)[0], id: fakeId('item', 900001), name: 'Новый.pdf' })
    })
    const r = await signalApi.readFolderItems(mkApi(), folder)
    assert.equal(r.unstable, false)
    assert.equal(r.rechecked, true, 'расхождение — одна перепроверка')
    assert.equal(r.items.length, 451)
    assert.equal(new Set(r.items.map((i) => i.nodeId)).size, 451, 'без повторов')
    assert.ok(r.items.some((i) => i.name === 'Новый.pdf'))
  })

  it('С-60: мягкое удаление в первой странице между запросами не теряет соседа (сверка первой страницы ловит сдвиг)', async () => {
    fake.addItems(folder, 450)
    const list = fake.state.items.get(folder)
    const victim = list[4]
    const neighbor = list[200]
    fake.onItems(folder, (n, f) => { if (n === 2) f.softDelete(folder, victim.id) })
    const r = await signalApi.readFolderItems(mkApi(), folder)
    assert.equal(r.unstable, false)
    assert.equal(r.rechecked, true)
    assert.equal(r.items.length, 449)
    assert.ok(r.items.some((i) => i.nodeId === neighbor.id), 'сосед удалённого на месте')
    assert.ok(!r.items.some((i) => i.nodeId === victim.id), 'удалённый — не в списке живых')
  })

  it('С-60: список не успокаивается (порядок меняется от запроса к запросу) → unstable без элементов после одной перепроверки', async () => {
    fake.addItems(folder, 450)
    fake.scramble(folder)
    const r = await signalApi.readFolderItems(mkApi(), folder)
    assert.equal(r.unstable, true)
    assert.equal(r.rechecked, true)
    assert.deepEqual(r.items, [])
    const calls = fake.itemCalls(folder)
    assert.ok(calls <= 2 * (4 + 1) + 2, `запросов не больше двух проходов: ${calls}`)
  })

  it('страница целиком из уже виденных id (смещение не работает) → invalid с признаком repeat; предел maxItems → limit', async () => {
    fake.addItems(folder, 450)
    const first = fake.state.items.get(folder).slice(0, 200)
    fake.fail((req) => req.path === '/public/v1/items' && req.query.Skip === '200', {
      status: 200, times: 10, body: first.map((it) => ({ id: it.id, folderId: it.folderId, name: it.name, type: it.type, modified: it.modified, deleted: false })),
    })
    await assert.rejects(() => signalApi.readFolderItems(mkApi(), folder), (e) => e.code === 'invalid' && e.repeat === true)
    fake.clearFaults()
    await assert.rejects(() => signalApi.readFolderItems(mkApi(), folder, { maxItems: 300 }), (e) => e.code === 'limit')
    assert.equal((await signalApi.readFolderItems(mkApi(), folder, { maxItems: 450 })).items.length, 450)
  })

  it('onPage вызывается между страницами; ошибка из него останавливает чтение', async () => {
    fake.addItems(folder, 450)
    const seen = []
    await signalApi.readFolderItems(mkApi(), folder, { onPage: (n) => seen.push(n) })
    assert.deepEqual(seen, [200, 400, 450])
    fake.resetRequests()
    await assert.rejects(() => signalApi.readFolderItems(mkApi(), folder, { onPage: () => { throw new Error('стоп') } }), /стоп/)
    assert.equal(fake.count('/public/v1/items'), 1)
  })

  it('403 и 404 на элементах папки доходят до вызывающего как есть (scope / http 404)', async () => {
    fake.addItems(folder, 3)
    fake.denyItems(folder, 403)
    await assert.rejects(() => signalApi.readFolderItems(mkApi(), folder), (e) => e.code === 'scope' && e.status === 403)
    fake.denyItems(folder, 404)
    await assert.rejects(() => signalApi.readFolderItems(mkApi(), folder), (e) => e.code === 'http' && e.status === 404)
  })

  it('В-10: listItems(deleted: true) → deleted=true в запросе; findDeletedItems находит нужные удалённые и останавливается', async () => {
    const live = fake.addItems(folder, 3)
    const gone = fake.addItems(folder, 3, { prefix: 'Удалён', deleted: true })
    const api = mkApi()
    assert.equal((await api.listItems(folder, { skip: 0, take: 200, deleted: true })).length, 3)
    assert.equal(fake.requests.at(-1).query.deleted, 'true')
    fake.resetRequests()
    const r = await signalApi.findDeletedItems(api, folder, new Set([gone[1], live[0], fakeId('item', 424242)]), { maxRequests: 5 })
    assert.deepEqual(r.found.map((i) => i.nodeId), [gone[1]], 'живой элемент и чужой id не возвращаются')
    assert.equal(r.found[0].deleted, true)
    assert.equal(r.complete, true, 'список кончился')
    assert.deepEqual(itemQueries(), ['0/200d', '3/200d'])
    fake.resetRequests()
    const early = await signalApi.findDeletedItems(api, folder, new Set([gone[0]]), { maxRequests: 5 })
    assert.equal(early.found.length, 1)
    assert.deepEqual(itemQueries(), ['0/200d'], 'нашли всё нужное — дальше не читаем')
  })

  it('В-10: deleted=true отдаёт все элементы (G1: смысл не проверен) — отбор по полю deleted; предел запросов не превышается', async () => {
    const live = fake.addItems(folder, 3)
    const gone = fake.addItems(folder, 2, { prefix: 'Удалён', deleted: true })
    fake.deletedMode = 'all'
    const api = mkApi()
    const r = await signalApi.findDeletedItems(api, folder, new Set([live[0], gone[0]]), { maxRequests: 5 })
    assert.deepEqual(r.found.map((i) => i.nodeId), [gone[0]], 'живой элемент из ответа deleted=true отброшен')
    fake.resetRequests()
    fake.pageCap = 1
    const limited = await signalApi.findDeletedItems(api, folder, new Set([fakeId('item', 424242)]), { maxRequests: 2 })
    assert.equal(limited.complete, false)
    assert.equal(limited.requests, 2)
    assert.equal(fake.count('/public/v1/items'), 2)
  })
})

describe('Тест-сторож: в клиенте и адаптере нет путей и методов записи и скачивания', () => {
  const read = (name) => fs.readFileSync(path.join(LIB, name), 'utf8')
  const files = { 'signalClient.js': read('signalClient.js'), 'signalApi.js': read('signalApi.js') }

  it('нет методов PUT, PATCH, DELETE и им подобных, нет слов о скачивании и объектах/версиях', () => {
    for (const [name, text] of Object.entries(files)) {
      assert.ok(!/\b(PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\b/.test(text), `${name}: метод записи`)
      assert.ok(!/['"`](put|patch|delete|head|options)['"`]/i.test(text), `${name}: метод записи в строке`)
      assert.ok(!/download|скач/i.test(text), `${name}: скачивание`)
      assert.ok(!/\/(objects|versions|upload|files|folders\/(?!tree))/i.test(text), `${name}: путь вне разрешённых`)
      assert.ok(!/\.next\b|nextUrl|next_page|nextPage|rel=.?next|\bnext:/i.test(text), `${name}: «следующий» адрес из ответа`)
    }
  })

  it('методы запросов — только GET и POST; POST — токен и поиск элементов', () => {
    for (const [name, text] of Object.entries(files)) {
      const methods = new Set([...text.matchAll(/method\s*[:=]\s*['"`]([A-Za-z]+)['"`]/g)].map((m) => m[1]))
      for (const m of methods) assert.ok(m === 'GET' || m === 'POST', `${name}: метод ${m}`)
    }
    const api = files['signalApi.js']
    const posts = [...api.matchAll(/method:\s*'POST',\s*path:\s*`([^`]+)`/g)].map((m) => m[1])
    assert.deepEqual(posts, ['${V1}/items/search'])
    assert.ok(files['signalClient.js'].includes("method: 'POST', path: SIGNAL_TOKEN_PATH"))
    assert.equal([...files['signalClient.js'].matchAll(/method:\s*'POST'/g)].length, 1)
  })

  it('все пути — ровно из выжимки API: токен, проекты, дерево, элементы, поиск', () => {
    const fromApi = [...files['signalApi.js'].matchAll(/\$\{V1\}(\/[^`'"\s]*)/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, '{id}'))
    assert.deepEqual([...new Set(fromApi)].sort(), ['/items', '/items/search', '/projects', '/projects/{id}/folders/tree'])
    const literal = [...files['signalClient.js'].matchAll(/['"`](\/public\/[^'"`]*)['"`]/g)].map((m) => m[1])
    assert.deepEqual([...new Set(literal)].sort(), ['/public/v1/auth/token', '/public/v1/items/search'])
    // любые другие упоминания /public/ — только в этих литералах
    for (const [name, text] of Object.entries(files)) {
      const all = [...text.matchAll(/\/public\/v1[^\s'"`]*/g)].map((m) => m[0])
      for (const p of all) assert.ok(['/public/v1/auth/token', '/public/v1/items/search', '/public/v1'].includes(p) || /^\/public\/v1\/\[/.test(p) || name === 'signalClient.js', `${name}: ${p}`)
    }
  })

  it('единственное место выхода в сеть — один вызов fetch в клиенте; в адаптере и синхронизации сети нет', () => {
    assert.equal([...files['signalClient.js'].matchAll(/await fetchImpl\(/g)].length, 1)
    assert.ok(!/\bfetch\s*\(|node:https?|XMLHttpRequest|undici/.test(files['signalApi.js']))
    const sync = path.join(LIB, 'signalSync.js')
    if (fs.existsSync(sync)) assert.ok(!/\bfetch\s*\(|node:https?|XMLHttpRequest|undici|createSignalClient/.test(fs.readFileSync(sync, 'utf8')), 'signalSync.js ходит в SIGNAL только через адаптер')
  })

  it('клиент не принимает пользовательских адресов: адрес запроса собирается из базового URL и известного пути', () => {
    const text = files['signalClient.js']
    assert.ok(/new URL\(path, origin\)/.test(text))
    assert.ok(!/new URL\(\s*(req|request|body|input|url)\b/.test(text.replace(/new URL\(String\(raw/g, '')))
    assert.ok(/redirect: 'error'/.test(text))
  })
})
