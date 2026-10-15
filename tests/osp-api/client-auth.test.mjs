// Свой вход — чистые модули фронта (src/api/authMode.js, session.js, ownAuth.js):
//   • режим входа: без authServer сервер не спрашивается; 404 / HTML — не режим; сбой — повтор, затем ошибка
//     (на Supabase фронт сам не откатывается); пилот — только с флагом ownLogin;
//   • запросы к своему серверу: отметка защиты CSRF — только на меняющих запросах к своему адресу; запросы к
//     хранилищу по подписанной ссылке не трогаются; события сессии по кодам ответа;
//   • свой вход отдаёт ответы и ошибки как supabase.auth: форма входа их понимает.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const api = (name) => import(path.join(ROOT, 'src', 'api', name))
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } })

describe('фронт: режим входа (authMode.js)', () => {
  it('ответ сервера: только JSON с известным режимом; 404 и HTML — не режим', async () => {
    const { parseAuthConfig } = await api('authMode.js')
    assert.deepEqual(parseAuthConfig(200, 'application/json', { mode: 'own', ownLogin: true }), { mode: 'own', ownLogin: true })
    assert.deepEqual(parseAuthConfig(200, 'application/json; charset=utf-8', { mode: 'both' }), { mode: 'both', ownLogin: false })
    assert.equal(parseAuthConfig(404, 'application/json', { error: 'Not found' }), null)
    assert.equal(parseAuthConfig(200, 'text/html', '<!doctype html>'), null)
    assert.equal(parseAuthConfig(200, 'application/json', { mode: 'keycloak' }), null)
  })

  it('сбой сети и 5xx — повтор; затем ошибка, а не тихий откат на прежний вход', async () => {
    const { loadAuthMode } = await api('authMode.js')
    let n = 0
    const flaky = async () => { n++; if (n < 3) throw new TypeError('Failed to fetch'); return json(200, { mode: 'own', ownLogin: true }) }
    assert.deepEqual(await loadAuthMode({ fetchImpl: flaky, sleep: async () => {} }), { mode: 'own', ownLogin: true })
    assert.equal(n, 3)
    let calls = 0
    await assert.rejects(loadAuthMode({ fetchImpl: async () => { calls++; return json(502, {}) }, attempts: 4, sleep: async () => {} }))
    assert.equal(calls, 4)
    await assert.rejects(loadAuthMode({ fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), sleep: async () => {} }),
      /не сообщил режим входа/, 'HTML вместо режима — сразу ошибка')
  })

  it('свой вход в браузере: own — всегда; both — только с флагом ownLogin; supabase — никогда', async () => {
    const { setAuthMode, isOwnAuth } = await api('authMode.js')
    setAuthMode({ mode: 'own' }, () => false)
    assert.equal(isOwnAuth(), true)
    setAuthMode({ mode: 'both' }, (name) => name === 'ownLogin')
    assert.equal(isOwnAuth(), true)
    setAuthMode({ mode: 'both' }, () => false)
    assert.equal(isOwnAuth(), false)
    setAuthMode({ mode: 'supabase' }, () => true)
    assert.equal(isOwnAuth(), false)
  })
})

describe('фронт: запросы к своему серверу (session.js)', () => {
  const ORIGIN = 'https://tender.test'
  const setup = (respond = () => json(200, [])) => {
    const seen = []
    const events = []
    const f = async (input, init) => { seen.push({ url: String(input), init }); return respond(String(input), init) }
    return { seen, events, mod: api('session.js'), f }
  }

  it('CSRF — только на меняющих запросах к своему /api/*; S3 по подписанной ссылке не трогается', async () => {
    const { createSessionFetch } = await api('session.js')
    const { seen, f } = setup()
    const sf = createSessionFetch({ fetchImpl: f, origin: ORIGIN, getCookies: () => 'a=1; __Host-osp_csrf=tok-123; b=2' })
    await sf(`${ORIGIN}/api/db/tenders?select=id`)
    await sf(`${ORIGIN}/api/db/tenders?id=eq.1`, { method: 'PATCH', body: '{}' })
    await sf('/api/fn/s3-presign', { method: 'POST', body: '{}' })
    await sf('https://s3.cloud.ru/osp/x?X-Amz-Signature=abc', { method: 'PUT', body: 'x' })
    await sf('https://evil.test/api/db/x', { method: 'POST' })
    const csrf = seen.map((r) => new Headers(r.init?.headers).get('x-osp-csrf'))
    assert.deepEqual(csrf, [null, 'tok-123', 'tok-123', null, null])
    assert.equal(seen[3].init.credentials, undefined, 'к хранилищу — как было, без cookie')
  })

  it('события сессии по кодам ответа: отзыв, смена режима, временный пароль; прочие отказы — нет', async () => {
    const { createSessionFetch } = await api('session.js')
    const events = []
    const codes = { a: 'OSP_SESSION_REVOKED', b: 'OSP_AUTH_MODE', c: 'OSP_PASSWORD_CHANGE_REQUIRED', d: '42501' }
    const sf = createSessionFetch({
      fetchImpl: async (url) => json(url.endsWith('c') || url.endsWith('d') ? 403 : 401, { code: codes[url.at(-1)] }),
      origin: ORIGIN, getCookies: () => '', onEvent: (code) => events.push(code),
    })
    for (const k of ['a', 'b', 'c', 'd']) {
      const res = await sf(`/api/db/${k}`)
      assert.equal((await res.json()).code, codes[k], 'ответ доходит до вызывающего целым')
    }
    assert.deepEqual(events, ['OSP_SESSION_REVOKED', 'OSP_AUTH_MODE', 'OSP_PASSWORD_CHANGE_REQUIRED'])
  })
})

describe('фронт: свой вход (ownAuth.js) — ответы как у supabase.auth', () => {
  it('вход: данные пользователя; неверный пароль — тот текст, что понимает форма; заявка — код в тексте', async () => {
    const { createOwnAuth } = await api('ownAuth.js')
    const replies = {
      'POST /api/auth/login': (body) => (body.password === 'right'
        ? json(200, { user: { id: 'u1', email: 'a@b.ru' }, mustChange: false })
        : body.password === 'pending' ? json(403, { error: 'ждёт', code: 'PENDING_APPROVAL' })
          : json(400, { error: 'Invalid login credentials', code: 'invalid_credentials' })),
      'GET /api/auth/me': () => json(200, { user: { id: 'u1', email: 'a@b.ru' }, isSuperadmin: true, mustChange: false }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    }
    const fetchImpl = async (url, init) => replies[`${init.method} ${url}`](init.body ? JSON.parse(init.body) : {})
    const posted = []
    const auth = createOwnAuth({ fetchImpl, channel: { postMessage: (m) => posted.push(m.event) } })
    const events = []
    auth.onAuthStateChange((e) => events.push(e))

    const ok = await auth.signInWithPassword({ email: 'a@b.ru', password: 'right' })
    assert.equal(ok.error, null)
    assert.deepEqual(ok.data.user, { id: 'u1', email: 'a@b.ru', isSuperadmin: true })
    assert.equal(ok.data.session.access_token, null, 'токена у браузера нет')
    assert.equal((await auth.signInWithPassword({ email: 'a@b.ru', password: 'wrong' })).error.message, 'Invalid login credentials')
    assert.equal((await auth.signInWithPassword({ email: 'a@b.ru', password: 'pending' })).error.message, 'PENDING_APPROVAL')
    assert.equal((await auth.getSession()).data.session.user.id, 'u1')
    await auth.signOut()
    assert.deepEqual(events, ['SIGNED_IN', 'SIGNED_OUT'])
    assert.deepEqual(posted, ['SIGNED_IN', 'SIGNED_OUT'], 'другие вкладки узнают о входе и выходе')
    assert.match((await auth.signUp({})).error.message, /администратор/)
  })

  it('сессия закончилась — событие SESSION_EXPIRED (окно повторного входа), а не выход', async () => {
    const { createOwnAuth } = await api('ownAuth.js')
    const auth = createOwnAuth({ fetchImpl: async () => json(401, { code: 'OSP_SESSION_REVOKED' }) })
    const events = []
    auth.onAuthStateChange((e) => events.push(e))
    auth.sessionEvent('OSP_SESSION_REVOKED')
    auth.sessionEvent('OSP_PASSWORD_CHANGE_REQUIRED')
    assert.deepEqual(events, ['SESSION_EXPIRED', 'PASSWORD_CHANGE_REQUIRED'])
    assert.equal((await auth.getSession()).data.session, null)
  })
})
