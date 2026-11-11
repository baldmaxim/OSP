// Вход. Два пути с одинаковыми методами и ответами (как у supabase.auth):
//   • Supabase Auth — как раньше (osp.root.sx; tender.su10.ru до переключения);
//   • свой вход портала (tender.su10.ru: сессия в httpOnly-cookie) — ownAuth.js: паролем ОСП (own) или через СУ-10 (keycloak).
// Путь выбирает режим сервера (authMode.js); страницы разницы не видят. Пользуются RoleContext и сервисы,
// которым нужен текущий пользователь. Токен для своего сервера — getAccessToken(): при своём входе его нет
// (сессия в cookie), и старый токен Supabase из хранилища браузера не уходит.
import { supabase } from './supabaseClient'
import { isSessionAuth, isPasswordAuth, isSsoAuth, ssoLinks, markLeaving, unmarkLeaving, isLeaving } from './authMode'
import { ownAuth } from './sessionClient'

const current = () => (isSessionAuth() ? ownAuth : supabase.auth)

export const auth = {
  // Своя сессия (пароль ОСП или СУ-10); пароль ОСП; вход через СУ-10.
  get isOwn() { return isSessionAuth() },
  get isPassword() { return isPasswordAuth() },
  get isSso() { return isSsoAuth() },
  get ssoLinks() { return ssoLinks() },
  // Выход через СУ-10 начат — без автоперехода на вход (authMode.js).
  get isLeaving() { return isLeaving() },
  markLeaving: () => markLeaving(),
  unmarkLeaving: () => unmarkLeaving(),
  getSession: (...args) => current().getSession(...args),
  getUser: (...args) => current().getUser(...args),
  onAuthStateChange: (fn) => current().onAuthStateChange(fn),
  signInWithPassword: (credentials) => current().signInWithPassword(credentials),
  signOut: (options) => current().signOut(options),
  refreshSession: () => current().refreshSession(),
  signUp: (args) => current().signUp(args),
  resend: (args) => current().resend(args),
  async getAccessToken() {
    if (isSessionAuth()) return null
    return (await supabase.auth.getSession()).data?.session?.access_token ?? null
  },
  // Только свой вход.
  changePassword: (args) => ownAuth.changePassword(args),
  logoutAll: () => ownAuth.signOut({ all: true }),
  adminCreateUser: (input) => ownAuth.adminCreateUser(input),
  adminResetPassword: (userId) => ownAuth.adminResetPassword(userId),
}
