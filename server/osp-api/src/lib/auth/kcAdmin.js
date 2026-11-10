// Admin API Keycloak su10 — только чтение участников группы доступа к порталу (KC_ACCESS_GROUP, osp-access), служебным
// клиентом osp-access-sync (client_credentials, у сервис-аккаунта только view-users). Нужен сверке группы
// (src/lib/auth/accessSync.js): заявка появляется у администратора ОСП сразу после выдачи доступа на auth.su10.ru/manage.
//
// view-users видит все учётки realm, поэтому: читаем только свою группу; из ответа берём только id, логин, почту, имя,
// фамилию и признак «включена»; ответы Admin API и токен никуда не пишутся (в журнал — только коды ошибок).
import * as oidcClient from 'openid-client'
import { timedFetch, errorCode } from './oidc.js'

export const KC_ADMIN_TIMEOUT_MS = 10_000
export const KC_PAGE = 100
const MAX_PAGES = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export class KcAdminError extends Error {
  constructor(code, status = null) {
    super(`kc admin: ${code}`)
    this.code = code
    this.status = status
  }
}

// https://auth.su10.ru/realms/su10 → https://auth.su10.ru/admin/realms/su10
export function adminBase(issuer) {
  const u = new URL(issuer)
  const m = /^\/realms\/([A-Za-z0-9._-]{1,100})$/.exec(u.pathname)
  if (!m) throw new Error('OIDC_ISSUER: путь не вида /realms/<realm> — адрес Admin API не вывести')
  return `${u.origin}/admin/realms/${m[1]}`
}

export function createKcAdmin({ issuer, admin, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const http = timedFetch(fetchImpl, KC_ADMIN_TIMEOUT_MS)
  const base = adminBase(issuer)
  let configuration = null
  let token = null // { value, until }

  async function config() {
    if (configuration) return configuration
    try {
      configuration = await oidcClient.discovery(new URL(issuer), admin.clientId, undefined,
        oidcClient.ClientSecretBasic(admin.clientSecret), { [oidcClient.customFetch]: http, timeout: KC_ADMIN_TIMEOUT_MS / 1000 })
    } catch (err) {
      throw new KcAdminError(`discovery:${errorCode(err)}`)
    }
    return configuration
  }

  async function accessToken(fresh = false) {
    if (!fresh && token && now() < token.until) return token.value
    let r
    try {
      r = await oidcClient.clientCredentialsGrant(await config())
    } catch (err) {
      if (err instanceof KcAdminError) throw err
      throw new KcAdminError(`token:${errorCode(err)}`)
    }
    const life = Number(r.expires_in) > 0 ? Number(r.expires_in) * 1000 : 60_000
    token = { value: r.access_token, until: now() + Math.max(0, life - 30_000) }
    return token.value
  }

  // GET Admin API → JSON. 401 — один повтор с новым токеном.
  async function get(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const bearer = await accessToken(attempt > 0)
      let res
      try {
        res = await http(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } })
      } catch (err) {
        throw new KcAdminError(`network:${errorCode(err)}`)
      }
      if (res.status === 401 && attempt === 0) { await res.body?.cancel(); continue }
      if (!res.ok) { await res.body?.cancel(); throw new KcAdminError('http', res.status) }
      try {
        return await res.json()
      } catch {
        throw new KcAdminError('json', res.status)
      }
    }
    throw new KcAdminError('unauthorized', 401)
  }

  async function groupId(name) {
    const list = await get(`/groups?search=${encodeURIComponent(name)}&exact=true&briefRepresentation=true`)
    if (!Array.isArray(list)) throw new KcAdminError('group_shape')
    const stack = [...list]
    while (stack.length) {
      const g = stack.shift()
      if (g && g.name === name && typeof g.id === 'string') return g.id
      if (Array.isArray(g?.subGroups)) stack.push(...g.subGroups)
    }
    throw new KcAdminError('group_not_found', 404)
  }

  // Участники группы → [{ id, username, email, firstName, lastName, enabled }] — только эти поля.
  async function groupMembers(name = admin.group) {
    const id = await groupId(name)
    const out = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await get(`/groups/${encodeURIComponent(id)}/members?briefRepresentation=true&first=${page * KC_PAGE}&max=${KC_PAGE}`)
      if (!Array.isArray(rows)) throw new KcAdminError('members_shape')
      for (const u of rows) {
        if (!u || typeof u.id !== 'string' || !UUID.test(u.id)) continue
        out.push({
          id: u.id.toLowerCase(), username: str(u.username, 200), email: str(u.email, 254).toLowerCase() || null,
          firstName: str(u.firstName, 100), lastName: str(u.lastName, 100), enabled: u.enabled === true,
        })
      }
      if (rows.length < KC_PAGE) return out
    }
    throw new KcAdminError('too_many_members')
  }

  return { groupMembers, adminBase: base }
}
