// Admin API Keycloak su10 — только чтение, служебным клиентом osp-access-sync (client_credentials, у сервис-аккаунта только
// view-users; поиск групп — query-groups, если realm его требует). Нужен:
//   • сверке группы доступа (KC_ACCESS_GROUP, osp-access; src/lib/auth/accessSync.js): заявка появляется у администратора ОСП
//     сразу после выдачи доступа на auth.su10.ru/manage;
//   • реестру организаций СУ-10 (подгруппы /org, src/lib/auth/orgs.js): какой контрагент у подрядчика.
// Адреса: GET /groups?search, /groups/{id}/members, /groups/{id}/children, /users/{sub}/groups. Права проверяет
// identity orgs-sync --check (probe) до переключения на вход через СУ-10.
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

  // ── Реестр организаций СУ-10 (подгруппы /org, temp/osp-org-mapping.md) ─────────────────────────────────────────────
  // Только прямые подгруппы /org: у каждой — атрибуты su10_org_id (постоянный id, не id группы), su10_org_kind (own |
  // contractor), org_name, inn. Вложенные группы глубже одного уровня организацией не считаются (их число — в итоге).
  // Подгруппа без su10_org_id (служебная «(организация не определена)») пропускается. Негодные атрибуты при годном id —
  // организация с ошибкой (invalid/attributes); один su10_org_id у двух групп — обе с ошибкой (invalid/duplicate_id).
  // Читается целиком или никак: любой сбой страницы — исключение, вызывающий не меняет кэш.
  async function orgRootId() {
    const list = await get('/groups?search=org&exact=true&briefRepresentation=true')
    if (!Array.isArray(list)) throw new KcAdminError('org_shape')
    const root = list.find((g) => g && g.name === 'org' && g.path === '/org' && typeof g.id === 'string')
    if (!root) throw new KcAdminError('org_registry_not_found', 404)
    return root.id
  }

  // → { orgs: [{ id, kind, name, inn, state, invalidReason }], skipped: { noId, nested } }
  async function orgRegistry() {
    const rootId = await orgRootId()
    const groups = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await get(`/groups/${encodeURIComponent(rootId)}/children?briefRepresentation=false&first=${page * KC_PAGE}&max=${KC_PAGE}`)
      if (!Array.isArray(rows)) throw new KcAdminError('org_children_shape')
      groups.push(...rows)
      if (rows.length < KC_PAGE) return parseOrgGroups(groups)
    }
    throw new KcAdminError('too_many_orgs')
  }

  // Организации учётки: подгруппы пути «/org/<имя>» с su10_org_id (вложенные глубже — нет). → [su10_org_id…]
  async function userOrgs(subject) {
    if (!UUID.test(String(subject))) throw new KcAdminError('subject_shape')
    const rows = await get(`/users/${encodeURIComponent(subject)}/groups?briefRepresentation=false&max=${KC_PAGE}`)
    if (!Array.isArray(rows)) throw new KcAdminError('user_groups_shape')
    const ids = new Set()
    for (const g of rows) {
      if (!g || typeof g.path !== 'string' || !/^\/org\/[^/]+$/.test(g.path)) continue
      const id = attr(g, 'su10_org_id')
      if (UUID.test(id)) ids.add(id.toLowerCase())
    }
    return [...ids]
  }

  // Проверка прав служебного клиента перед переключением (identity orgs-sync --check): каждый нужный адрес отвечает.
  // → { ok, steps: [{ step, ok, code? }] }
  async function probe(name = admin.group) {
    const steps = []
    const step = async (label, fn) => {
      try { await fn(); steps.push({ step: label, ok: true }) } catch (err) { steps.push({ step: label, ok: false, code: err?.code || 'error', status: err?.status ?? null }) }
    }
    let rootId = null
    let memberId = null
    await step('token', () => accessToken(true))
    await step('groups_search', async () => { rootId = await orgRootId() })
    if (rootId) await step('org_children', () => get(`/groups/${encodeURIComponent(rootId)}/children?briefRepresentation=false&first=0&max=1`))
    await step('access_group_members', async () => {
      const id = await groupId(name)
      const rows = await get(`/groups/${encodeURIComponent(id)}/members?briefRepresentation=true&first=0&max=1`)
      memberId = Array.isArray(rows) && typeof rows[0]?.id === 'string' ? rows[0].id : null
    })
    if (memberId) await step('user_groups', () => userOrgs(memberId))
    return { ok: steps.every((s) => s.ok), steps }
  }

  return { groupMembers, orgRegistry, userOrgs, probe, adminBase: base }
}

const attr = (group, key) => {
  const v = group?.attributes?.[key]
  const s = Array.isArray(v) ? (v.length === 1 ? v[0] : null) : null
  return typeof s === 'string' ? s.trim() : ''
}

// Подгруппы /org → организации. Чистая функция (тесты): строгие атрибуты, повтор id, вложенные.
export function parseOrgGroups(groups) {
  const skipped = { noId: 0, nested: 0 }
  const byId = new Map()
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    // Вложенные подгруппы организацией не считаются — только счёт (subGroupCount у краткого и полного вида ответа).
    const nested = Array.isArray(g.subGroups) ? g.subGroups.length : Number(g.subGroupCount) || 0
    skipped.nested += nested
    const rawId = attr(g, 'su10_org_id')
    if (!rawId) { skipped.noId++; continue }
    if (!UUID.test(rawId)) { skipped.noId++; continue }
    const id = rawId.toLowerCase()
    const kind = attr(g, 'su10_org_kind')
    const groupName = typeof g.name === 'string' ? g.name.replace(/^орг:\s*/u, '').replace(/∕/g, '/').trim() : ''
    // eslint-disable-next-line no-control-regex
    const name = (attr(g, 'org_name') || groupName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300)
    const rawInn = attr(g, 'inn').replace(/\s+/g, '')
    const innOk = !rawInn || /^(\d{10}|\d{12})$/.test(rawInn)
    const valid = (kind === 'own' || kind === 'contractor') && name && innOk
    const org = {
      id, kind: kind === 'own' || kind === 'contractor' ? kind : null, name: name || id, inn: innOk && rawInn ? rawInn : null,
      state: valid ? 'active' : 'invalid', invalidReason: valid ? null : 'attributes',
    }
    if (byId.has(id)) {
      const prev = byId.get(id)
      byId.set(id, { ...prev, state: 'invalid', invalidReason: 'duplicate_id' })
      continue
    }
    byId.set(id, org)
  }
  return { orgs: [...byId.values()], skipped }
}
