// Свой вход — чистые модули фронта (src/api/authMode.js, session.js, ownAuth.js):
//   • режим входа: без authServer сервер не спрашивается; 404 / HTML — не режим; сбой — повтор, затем ошибка
//     (на Supabase фронт сам не откатывается); пилот — только с флагом ownLogin;
//   • запросы к своему серверу: отметка защиты CSRF — только на меняющих запросах к своему адресу; запросы к
//     хранилищу по подписанной ссылке не трогаются; события сессии по кодам ответа;
//   • свой вход отдаёт ответы и ошибки как supabase.auth: форма входа их понимает;
//   • вход через СУ-10 (keycloak): режим понятен фронту, признаки «своя сессия» / «пароль ОСП» / «СУ-10» разведены; действие
//     пользователя — заголовок X-OSP-Activity (только CSRF сессии, только к своему адресу, 10 с); простой (OSP_IDLE) — фоновые
//     запросы на паузе без сети до первого действия; выход возвращает адрес выхода СУ-10.
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
    assert.equal(parseAuthConfig(200, 'application/json', { mode: 'other' }), null)
    // Вход через СУ-10: режим известен; ссылки — только https.
    assert.deepEqual(parseAuthConfig(200, 'application/json', { mode: 'keycloak', ownLogin: false, sso: { accountUrl: 'https://auth.test/realms/su10/account', manageUrl: 'javascript:alert(1)' } }),
      { mode: 'keycloak', ownLogin: false, sso: { accountUrl: 'https://auth.test/realms/su10/account', manageUrl: null } })
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

  it('признаки: keycloak — своя сессия без пароля ОСП; own — своя сессия с паролем; регистрации в keycloak нет', async () => {
    const { setAuthMode, isSessionAuth, isPasswordAuth, isSsoAuth, getAuthMode, ssoLinks } = await api('authMode.js')
    setAuthMode({ mode: 'keycloak', signup: true, signupMode: 'manual', sso: { accountUrl: 'https://a/account', manageUrl: 'https://a/manage' } }, () => false)
    assert.deepEqual([isSessionAuth(), isPasswordAuth(), isSsoAuth()], [true, false, true])
    assert.equal(getAuthMode().signup, false, 'регистрации в контуре нет')
    assert.deepEqual(ssoLinks(), { accountUrl: 'https://a/account', manageUrl: 'https://a/manage' })
    setAuthMode({ mode: 'own' }, () => false)
    assert.deepEqual([isSessionAuth(), isPasswordAuth(), isSsoAuth()], [true, true, false])
    assert.deepEqual(ssoLinks(), { accountUrl: null, manageUrl: null })
    setAuthMode({ mode: 'supabase' }, () => true)
    assert.deepEqual([isSessionAuth(), isPasswordAuth(), isSsoAuth()], [false, false, false])
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

  it('действие пользователя: X-OSP-Activity = CSRF сессии, 10 с после действия, только к своему адресу', async () => {
    const { createSessionFetch } = await api('session.js')
    const seen = []
    let t = 1_000_000
    const sf = createSessionFetch({
      fetchImpl: async (input, init) => { seen.push({ url: String(input), init }); return json(200, []) },
      origin: ORIGIN, getCookies: () => '__Host-osp_csrf=tok-9', now: () => t,
    })
    const activity = () => new Headers(seen.at(-1).init?.headers).get('x-osp-activity')
    await sf('/api/db/x')
    assert.equal(activity(), null, 'без действия — фоновый')
    sf.markActivity()
    await sf('/api/db/x')
    assert.equal(activity(), 'tok-9')
    await sf('https://evil.test/api/db/x')
    assert.equal(activity(), null, 'чужому адресу — нет')
    t += 10_001
    await sf('/api/db/x')
    assert.equal(activity(), null, 'через 10 с — снова фоновый')
  })

  it('простой: после OSP_IDLE фоновые запросы не идут в сеть; первое действие — снова в сеть, пауза снимается', async () => {
    const { createSessionFetch } = await api('session.js')
    let t = 0
    let calls = 0
    let idleReply = true
    const events = []
    const sf = createSessionFetch({
      fetchImpl: async (input, init) => {
        calls++
        if (idleReply && !new Headers(init?.headers).get('x-osp-activity')) return json(401, { code: 'OSP_IDLE' })
        return json(200, [])
      },
      origin: ORIGIN, getCookies: () => '__Host-osp_csrf=tok', now: () => t, onEvent: (c) => events.push(c),
    })
    assert.equal((await sf('/api/db/poll')).status, 401)
    assert.deepEqual(events, ['OSP_IDLE'])
    const before = calls
    const paused = await sf('/api/db/poll')
    assert.equal(paused.status, 401)
    assert.equal((await paused.json()).code, 'OSP_IDLE')
    assert.equal(calls, before, 'в сеть не ходили')
    // Вход и «кто я» на паузу не встают: после входа в соседнем окне вкладка должна увидеть новую сессию.
    const callsBeforeMe = calls
    await sf('/api/auth/me')
    assert.equal(calls, callsBeforeMe + 1, '/api/auth/* идёт в сеть и на паузе')
    assert.equal(sf.markActivity(), true, 'действие сообщает: вкладка простаивала')
    assert.equal((await sf('/api/auth/me')).status, 200)
    assert.equal(sf.isIdle(), false)
    idleReply = false
    t += 20_000
    assert.equal((await sf('/api/db/poll')).status, 200, 'опрос продолжается')
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
    assert.deepEqual(ok.data.user, { id: 'u1', email: 'a@b.ru', isSuperadmin: true, authSource: 'password' })
    assert.equal(ok.data.session.access_token, null, 'токена у браузера нет')
    assert.equal((await auth.signInWithPassword({ email: 'a@b.ru', password: 'wrong' })).error.message, 'Invalid login credentials')
    assert.equal((await auth.signInWithPassword({ email: 'a@b.ru', password: 'pending' })).error.message, 'PENDING_APPROVAL')
    assert.equal((await auth.getSession()).data.session.user.id, 'u1')
    await auth.signOut()
    assert.deepEqual(events, ['SIGNED_IN', 'SIGNED_OUT'])
    assert.deepEqual(posted, ['SIGNED_IN', 'SIGNED_OUT'], 'другие вкладки узнают о входе и выходе')
    // Сообщения из других вкладок — свои события: вход и выход «где-то ещё» (вход СУ-10 после выхода — без автоперехода).
    const channel = {}
    const other = createOwnAuth({ fetchImpl, channel })
    const seen = []
    other.onAuthStateChange((e) => seen.push(e))
    channel.onmessage({ data: { event: 'SIGNED_IN' } })
    channel.onmessage({ data: { event: 'SIGNED_OUT' } })
    assert.deepEqual(seen, ['SIGNED_IN_ELSEWHERE', 'SIGNED_OUT_ELSEWHERE'])
    assert.match((await auth.signUp({})).error.message, /администратор/)
  })

  it('сессия закончилась — событие SESSION_EXPIRED (окно повторного входа), а не выход', async () => {
    const { createOwnAuth } = await api('ownAuth.js')
    const auth = createOwnAuth({ fetchImpl: async () => json(401, { code: 'OSP_SESSION_REVOKED' }) })
    const events = []
    auth.onAuthStateChange((e) => events.push(e))
    auth.sessionEvent('OSP_SESSION_REVOKED')
    auth.sessionEvent('OSP_PASSWORD_CHANGE_REQUIRED')
    auth.sessionEvent('OSP_SSO_REQUIRED')
    assert.deepEqual(events, ['SESSION_EXPIRED', 'PASSWORD_CHANGE_REQUIRED', 'SESSION_EXPIRED'], 'вход СУ-10 истёк — то же окно повторного входа')
    assert.equal((await auth.getSession()).data.session, null)
  })

  it('выход через СУ-10: адрес выхода из ответа (только https); без него — null', async () => {
    const { createOwnAuth } = await api('ownAuth.js')
    let reply = { endSessionUrl: 'https://auth.test/realms/su10/protocol/openid-connect/logout?client_id=osp' }
    const auth = createOwnAuth({ fetchImpl: async () => json(200, reply) })
    assert.equal((await auth.signOut()).endSessionUrl, reply.endSessionUrl)
    reply = { endSessionUrl: 'javascript:alert(1)' }
    assert.equal((await auth.signOut()).endSessionUrl, null)
    reply = { endSessionUrl: null }
    assert.equal((await auth.signOut({ all: true })).endSessionUrl, null)
  })
})
