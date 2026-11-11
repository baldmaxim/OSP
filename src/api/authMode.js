// Режим входа портала. На tender.su10.ru (в config.json — authServer: true) его отдаёт сервер:
// GET /api/auth/config → { mode: 'supabase' | 'both' | 'own' | 'keycloak', ownLogin, sso? }. Без authServer (osp.root.sx, стенды
// тестов) сервер не спрашивается — вход прежний, через Supabase, и падение osp-api вход там не ломает.
// С authServer ответ сервера обязателен: около 15 с повторов, затем — ошибка (main.jsx покажет «сервер
// недоступен»); на Supabase фронт сам не откатывается.
//   own      — свой вход для всех: пароль ОСП (вход «через Яндекс»);
//   keycloak — единый вход СУ-10 (auth.su10.ru): та же своя сессия в cookie, но пароли и вход — в Keycloak;
//   both     — пилот: свой вход только в браузере с флагом ownLogin (?features=ownLogin), остальные — Supabase.
// Признаки для страниц: isSessionAuth — своя сессия (cookie, без токена Supabase); isPasswordAuth — есть пароль ОСП
// (форма входа, смена пароля, «Добавить пользователя»); isSsoAuth — вход через СУ-10.
// Модуль чистый (без window при импорте) — проверяется в tests/osp-api/client-auth.test.mjs.
export const AUTH_MODES = ['supabase', 'both', 'own', 'keycloak']
const OWN_LOGIN_FLAG = 'ownLogin'
// Своему входу нужны и остальные пути через свой сервер: токена Supabase у браузера нет.
export const OWN_AUTH_FEATURES = ['ospDb', 'ospApiFilesV2', 'ospApiAi']

const state = { mode: 'supabase', ownLogin: false, signup: false, signupMode: null, sso: null }
// Ссылки СУ-10 — только https://.
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) ? v : null)
let flagCheck = () => false

// Ответ сервера → { mode, ownLogin } или null (ответ не про режим входа: 404, HTML, чужой JSON).
export function parseAuthConfig(status, contentType, body) {
  if (status !== 200 || !/json/i.test(contentType || '')) return null
  if (!body || typeof body !== 'object' || !AUTH_MODES.includes(body.mode)) return null
  // signup — открыта ли регистрация подрядчиков (только когда сервер прямо это говорит); signupMode — как: manual — заявку решает
  // администратор, email — самостоятельно, по письму.
  const sso = body.mode === 'keycloak' && body.sso && typeof body.sso === 'object'
    ? { accountUrl: httpsUrl(body.sso.accountUrl), manageUrl: httpsUrl(body.sso.manageUrl) }
    : null
  return {
    mode: body.mode, ownLogin: body.ownLogin === true,
    ...(sso ? { sso } : {}),
    ...(body.signup === true ? { signup: true, signupMode: body.signupMode === 'manual' ? 'manual' : 'email' } : {}),
  }
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

export function setAuthMode({ mode, ownLogin, signup, signupMode = null, sso = null }, isFeatureEnabled) {
  state.mode = AUTH_MODES.includes(mode) ? mode : 'supabase'
  state.ownLogin = ownLogin === true
  state.signup = signup === true && state.mode !== 'keycloak'
  state.signupMode = state.signup ? signupMode : null
  state.sso = state.mode === 'keycloak' && sso ? { accountUrl: sso.accountUrl || null, manageUrl: sso.manageUrl || null } : null
  if (typeof isFeatureEnabled === 'function') flagCheck = isFeatureEnabled
}

export const getAuthMode = () => ({ ...state })

// Этот браузер входит своим паролем ОСП (форма входа, смена пароля, временные пароли администратора).
export function isPasswordAuth() {
  if (state.mode === 'own') return true
  return state.mode === 'both' && flagCheck(OWN_LOGIN_FLAG) === true
}

// Вход через СУ-10 (Keycloak).
export const isSsoAuth = () => state.mode === 'keycloak'

// Своя сессия в cookie (пароль ОСП или СУ-10): токена Supabase у браузера нет, всё — через свой сервер.
export const isSessionAuth = () => isPasswordAuth() || isSsoAuth()

// Прежнее имя: «свой вход» = своя сессия.
export const isOwnAuth = isSessionAuth

// Выход через СУ-10 начат (эта вкладка уходит на выход из СУ-10 или на страницу входа после выхода в другой вкладке): страница
// входа не переходит на вход СУ-10 сама — иначе живой ещё вход СУ-10 вернул бы человека обратно.
let leaving = false
export const markLeaving = () => { leaving = true }
export const unmarkLeaving = () => { leaving = false }
export const isLeaving = () => leaving

// Ссылки СУ-10: профиль (смена пароля) и управление доступом.
export const ssoLinks = () => state.sso || { accountUrl: null, manageUrl: null }
