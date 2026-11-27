// Клиент /api/signal/* × вход (В-13, Н-1): токен передаётся как у «Ключей API» (getToken → Authorization: Bearer), отметка защиты
// X-OSP-CSRF — от fetch сессии (src/api/session.js); сверка работает при любом режиме входа — своём (cookie) и Supabase (токен).
// fetch подставной, модуль чистый (tests/contracts/signal-review.test.mjs — остальной клиент).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNAL_DISABLED, createSignalClient } from '../../src/api/signalClient.js'
import { CSRF_COOKIE, CSRF_HEADER, createSessionFetch } from '../../src/api/session.js'

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('клиент /api/signal/*: вход (В-13)', () => {
  const OK = reply(200, { enabled: true, canView: true, canEdit: true })
  const origin = 'https://portal.example.invalid'
  const run = async ({ getToken, cookies }) => {
    const seen = []
    const base = async (input, init = {}) => { seen.push({ path: String(input), method: init.method || 'GET', headers: new Headers(init.headers || {}) }); return new Response(JSON.stringify({ ok: true, enabled: true }), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const fetchImpl = createSessionFetch({ fetchImpl: base, origin, getCookies: () => cookies })
    // fetch сессии работает с адресами своего источника: относительный путь клиента разворачивается от него.
    const client = createSignalClient({ fetchImpl: (path, init) => fetchImpl(`${origin}${path}`, init), getToken })
    await client.status()
    await client.confirm('c-1', { nodeId: 'n' })
    await client.admin.sync()
    return seen
  }

  it('свой вход (cookie): токена нет — заголовка Authorization нет, отметка защиты — на каждом меняющем запросе', async () => {
    const seen = await run({ getToken: async () => null, cookies: `${CSRF_COOKIE}=csrf-1; other=1` })
    assert.equal(seen.length, 3)
    for (const r of seen) assert.equal(r.headers.get('authorization'), null, `${r.method} ${r.path}`)
    assert.deepEqual(seen.map((r) => r.headers.get(CSRF_HEADER)), [null, 'csrf-1', 'csrf-1'], 'GET без отметки, POST — с ней')
  })

  it('вход Supabase (токен): Authorization: Bearer на каждом запросе, отметки защиты нет (cookie нет)', async () => {
    const seen = await run({ getToken: async () => 'tok-1', cookies: '' })
    for (const r of seen) assert.equal(r.headers.get('authorization'), 'Bearer tok-1', `${r.method} ${r.path}`)
    for (const r of seen) assert.equal(r.headers.get(CSRF_HEADER), null)
  })

  it('токен берётся на каждый запрос заново (сессию продлевает клиент входа); сбой getToken — запрос без токена, а не исключение', async () => {
    let n = 0
    const seen = []
    const client = createSignalClient({
      fetchImpl: async (path, init) => { seen.push(init.headers.authorization ?? null); return OK },
      getToken: async () => { n++; if (n === 3) throw new Error('сессия недоступна'); return `tok-${n}` },
    })
    await client.contract('c-1')
    await client.contract('c-1')
    await client.contract('c-1')
    assert.deepEqual(seen, ['Bearer tok-1', 'Bearer tok-2', null])
  })

  it('без getToken (прежний вызов) — заголовков не прибавляется; status() при отказе токена-сервера — по-прежнему { enabled: false }', async () => {
    const heads = []
    const client = createSignalClient({ fetchImpl: async (path, init) => { heads.push(init.headers); return reply(401, { error: 'Unauthorized' }) } })
    assert.deepEqual(await client.status(), SIGNAL_DISABLED)
    assert.deepEqual(heads, [{}])
  })

  it('зависший getToken не держит запрос дольше предела (timeoutMs)', async () => {
    const client = createSignalClient({ fetchImpl: async () => OK, getToken: () => new Promise(() => {}) })
    const t0 = Date.now()
    const res = await client.match(['a'], { timeoutMs: 40 })
    assert.ok(Date.now() - t0 < 1000)
    assert.deepEqual(res.failed, ['a'])
    assert.equal(res.error.code, 'timeout')
  })
})
