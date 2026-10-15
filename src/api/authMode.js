// Режим входа портала. На tender.su10.ru (в config.json — authServer: true) его отдаёт сервер:
// GET /api/auth/config → { mode: 'supabase' | 'both' | 'own', ownLogin }. Без authServer (osp.root.sx, стенды
// тестов) сервер не спрашивается — вход прежний, через Supabase, и падение osp-api вход там не ломает.
// С authServer ответ сервера обязателен: около 15 с повторов, затем — ошибка (main.jsx покажет «сервер
// недоступен»); на Supabase фронт сам не откатывается.
//   own  — свой вход для всех;
//   both — пилот: свой вход только в браузере с флагом ownLogin (?features=ownLogin), остальные — Supabase.
// Модуль чистый (без window при импорте) — проверяется в tests/osp-api/client-auth.test.mjs.
export const AUTH_MODES = ['supabase', 'both', 'own']
const OWN_LOGIN_FLAG = 'ownLogin'
// Своему входу нужны и остальные пути через свой сервер: токена Supabase у браузера нет.
export const OWN_AUTH_FEATURES = ['ospDb', 'ospApiFilesV2', 'ospApiAi']

const state = { mode: 'supabase', ownLogin: false }
let flagCheck = () => false

// Ответ сервера → { mode, ownLogin } или null (ответ не про режим входа: 404, HTML, чужой JSON).
export function parseAuthConfig(status, contentType, body) {
  if (status !== 200 || !/json/i.test(contentType || '')) return null
  if (!body || typeof body !== 'object' || !AUTH_MODES.includes(body.mode)) return null
  return { mode: body.mode, ownLogin: body.ownLogin === true }
}

export async function loadAuthMode({ fetchImpl, attempts = 6, delayMs = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(delayMs)
    try {
      const res = await fetchImpl('/api/auth/config', { cache: 'no-store', credentials: 'same-origin' })
      if (res.status >= 500 || res.status === 429) { last = new Error(`сервер ответил ${res.status}`); continue }
      let body = null
      try { body = await res.json() } catch { /* не JSON */ }
      const parsed = parseAuthConfig(res.status, res.headers.get('content-type'), body)
      if (!parsed) throw Object.assign(new Error('сервер не сообщил режим входа'), { final: true })
      return parsed
    } catch (err) {
      if (err?.final) throw err
      last = err
    }
  }
  throw last || new Error('сервер не отвечает')
}

export function setAuthMode({ mode, ownLogin }, isFeatureEnabled) {
  state.mode = AUTH_MODES.includes(mode) ? mode : 'supabase'
  state.ownLogin = ownLogin === true
  if (typeof isFeatureEnabled === 'function') flagCheck = isFeatureEnabled
}

export const getAuthMode = () => ({ ...state })

// Этот браузер входит своим входом.
export function isOwnAuth() {
  if (state.mode === 'own') return true
  return state.mode === 'both' && flagCheck(OWN_LOGIN_FLAG) === true
}
