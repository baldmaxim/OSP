// Вход. Два пути с одинаковыми методами и ответами (как у supabase.auth):
//   • Supabase Auth — как раньше (osp.root.sx; tender.su10.ru до переключения);
//   • свой вход портала (tender.su10.ru: учётки и пароли в базе Яндекса, сессия в httpOnly-cookie) — ownAuth.js.
// Путь выбирает режим сервера (authMode.js); страницы разницы не видят. Пользуются RoleContext и сервисы,
// которым нужен текущий пользователь. Токен для своего сервера — getAccessToken(): при своём входе его нет
// (сессия в cookie), и старый токен Supabase из хранилища браузера не уходит.
import { supabase } from './supabaseClient'
import { isOwnAuth } from './authMode'
import { ownAuth } from './sessionClient'

const current = () => (isOwnAuth() ? ownAuth : supabase.auth)

export const auth = {
  get isOwn() { return isOwnAuth() },
  getSession: (...args) => current().getSession(...args),
  getUser: (...args) => current().getUser(...args),
  onAuthStateChange: (fn) => current().onAuthStateChange(fn),
  signInWithPassword: (credentials) => current().signInWithPassword(credentials),
  signOut: (options) => current().signOut(options),
  refreshSession: () => current().refreshSession(),
  signUp: (args) => current().signUp(args),
  resend: (args) => current().resend(args),
  async getAccessToken() {
    if (isOwnAuth()) return null
    return (await supabase.auth.getSession()).data?.session?.access_token ?? null
  },
  // Только свой вход.
  changePassword: (args) => ownAuth.changePassword(args),
  logoutAll: () => ownAuth.signOut({ all: true }),
  adminCreateUser: (input) => ownAuth.adminCreateUser(input),
  adminResetPassword: (userId) => ownAuth.adminResetPassword(userId),
}
