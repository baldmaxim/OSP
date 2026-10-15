// Свой вход портала (сервер — server/osp-api/src/routes/auth.js) с теми же методами и ответами, что у
// supabase.auth: форма входа и RoleContext работают с ним так же. Отличия:
//   • сессия — в httpOnly-cookie, токена у браузера нет (getAccessToken → null);
//   • регистрации и повторного письма нет — учётки заводит администратор;
//   • при входе может потребоваться смена временного пароля (mustChange);
//   • события: SIGNED_IN, SIGNED_OUT, SESSION_EXPIRED (сессия закончилась — окно повторного входа),
//     PASSWORD_CHANGE_REQUIRED. Другие вкладки узнают о входе и выходе через BroadcastChannel('osp-auth').
// Модуль чистый (fetch и канал передаются) — tests/osp-api/client-auth.test.mjs.
const CODES_AS_MESSAGE = new Set(['PENDING_APPROVAL', 'ACCOUNT_BLOCKED'])

function errorFrom(status, body) {
  const code = body?.code || `http_${status}`
  // Эти два кода форма входа разбирает по тексту ошибки — как раньше разбирала ошибки RoleContext.
  const message = CODES_AS_MESSAGE.has(code) ? code : (body?.error || 'Не удалось выполнить действие')
  return Object.assign(new Error(message), { code, status, retryAfterSec: body?.retryAfterSec ?? null })
}

export function createOwnAuth({ fetchImpl, channel = null }) {
  const listeners = new Set()
  let me = null // { user, mustChange } | null — пока не изменится вход
  let mePromise = null

  const emit = (event, session = null) => { for (const fn of [...listeners]) { try { fn(event, session) } catch { /* слушатель */ } } }
  const broadcast = (event) => { try { channel?.postMessage({ event }) } catch { /* канал закрыт */ } }
  if (channel) {
    channel.onmessage = (msg) => {
      const event = msg?.data?.event
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') { me = null; mePromise = null; emit(event === 'SIGNED_IN' ? 'SIGNED_IN_ELSEWHERE' : 'SIGNED_OUT') }
    }
  }

  async function call(path, { method = 'POST', body } = {}) {
    const res = await fetchImpl(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data = null
    if (res.status !== 204) { try { data = await res.json() } catch { /* пусто */ } }
    if (!res.ok) throw errorFrom(res.status, data)
    return data
  }

  const sessionOf = (m) => (m ? { user: m.user, access_token: null, mustChange: m.mustChange } : null)

  async function loadMe() {
    try {
      const data = await call('/api/auth/me', { method: 'GET' })
      return { user: { ...data.user, isSuperadmin: data.isSuperadmin === true }, mustChange: data.mustChange === true }
    } catch (err) {
      if (err.status === 401 || err.status === 403) return null
      throw err
    }
  }

  async function getSession() {
    if (me) return { data: { session: sessionOf(me) }, error: null }
    mePromise ??= loadMe().finally(() => { mePromise = null })
    try {
      me = await mePromise
      return { data: { session: sessionOf(me) }, error: null }
    } catch (error) {
      return { data: { session: null }, error }
    }
  }

  async function signInWithPassword({ email, password }) {
    try {
      const data = await call('/api/auth/login', { body: { email, password } })
      me = { user: { ...data.user, isSuperadmin: false }, mustChange: data.mustChange === true }
      // Суперадминистратор и прочее — из /me (одним запросом после входа).
      me = (await loadMe()) || me
      emit('SIGNED_IN', sessionOf(me))
      broadcast('SIGNED_IN')
      return { data: { user: me.user, session: sessionOf(me), mustChange: me.mustChange }, error: null }
    } catch (error) {
      return { data: { user: null, session: null }, error }
    }
  }

  async function signOut({ all = false } = {}) {
    try {
      await call('/api/auth/logout', { body: all ? { all: true } : {} })
    } catch { /* сессии уже нет — выход всё равно состоялся */ }
    me = null
    emit('SIGNED_OUT', null)
    broadcast('SIGNED_OUT')
    return { error: null }
  }

  async function changePassword({ currentPassword, newPassword }) {
    await call('/api/auth/password', { body: { currentPassword, newPassword } })
    me = (await loadMe()) || me
    return me
  }

  return {
    getSession,
    getUser: async () => {
      const { data, error } = await getSession()
      return { data: { user: data.session?.user ?? null }, error }
    },
    onAuthStateChange(fn) {
      listeners.add(fn)
      return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } }
    },
    signInWithPassword,
    signOut,
    refreshSession: async () => ({ data: { session: sessionOf(me) }, error: null }),
    signUp: async () => ({ data: { user: null, session: null }, error: new Error('Учётные записи заводит администратор ОСП') }),
    resend: async () => ({ error: new Error('Письма портал не отправляет — обратитесь к администратору ОСП') }),
    changePassword,
    adminCreateUser: (input) => call('/api/auth/admin/users', { body: input }),
    adminResetPassword: (userId) => call('/api/auth/admin/reset-password', { body: { userId } }),
    // Событие сессии от любого запроса к своему серверу (session.js).
    sessionEvent(code) {
      if (code === 'OSP_SESSION_REVOKED') { me = null; emit('SESSION_EXPIRED', null) }
      if (code === 'OSP_PASSWORD_CHANGE_REQUIRED') emit('PASSWORD_CHANGE_REQUIRED', null)
    },
  }
}
