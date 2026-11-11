// Keycloak su10 в памяти для тестов osp-api (подставной fetch): discovery, JWKS RS256, token endpoint (код + PKCE, refresh,
// client_credentials), Admin API — группа доступа, реестр организаций (/org) и организации учётки (/users/{sub}/groups).
// Копия из tests/osp-api/keycloak.test.mjs (там свой экземпляр) с организациями СУ-10:
//   • claim su10_org_id в access token: kc.orgOf.get(sub) (перевод на /manage) иначе user.org; undefined — claim нет;
//   • kc.orgGroups — подгруппы /org (orgGroup()), kc.userGroups — Map(sub → группы учётки);
//   • kc.forbid — Set('children' | 'user_groups' | 'members') → 403; kc.failChildrenPage — номер страницы с 500.
import crypto from 'node:crypto'

export const KC_IDS = {
  GROUP_ID: '99999999-9999-4999-8999-999999999999',
  ORG_ROOT_ID: '98989898-9898-4898-8898-989898989898',
}

// Подгруппа /org с атрибутами реестра. attrs — переопределить атрибуты (негодные значения для тестов).
export function orgGroup({ id, kind = 'contractor', name, inn = null, nested = 0, attrs = null }) {
  const groupName = `орг: ${name}`
  return {
    id: crypto.randomUUID(), name: groupName, path: `/org/${groupName}`, subGroupCount: nested,
    attributes: attrs || { su10_org_id: [id], su10_org_kind: [kind], org_name: [name], ...(inn ? { inn: [inn] } : {}) },
  }
}
// Группы учётки в ответе /users/{sub}/groups: организация + посторонняя группа (не /org).
export const userGroupsOf = (...orgs) => [
  { id: crypto.randomUUID(), name: 'osp-access', path: '/osp-access' },
  ...orgs.map((g) => ({ id: g.id, name: g.name, path: g.path, attributes: g.attributes })),
]

export async function createFakeKeycloak(jose, { issuer, clientSecret, adminSecret }) {
  const { GROUP_ID, ORG_ROOT_ID } = KC_IDS
  const host = new URL(issuer).host
  const realmPath = new URL(issuer).pathname // /realms/su10
  const adminPath = realmPath.replace('/realms/', '/admin/realms/')
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const kc = {
    codes: new Map(), refresh: new Map(), members: [], down: false, refreshMode: 'ok',
    orgGroups: [], userGroups: new Map(), orgOf: new Map(), forbid: new Set(), failChildrenPage: null, orgRootMissing: false,
    calls: { refresh: 0, code: 0, admin: 0, children: 0, userGroups: 0, members: 0 },
  }
  const now = () => Math.floor(Date.now() / 1000)
  const sign = (claims) => new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).sign(privateKey)

  async function accessToken(user, { roles = ['access'] } = {}) {
    const org = kc.orgOf.has(user.sub) ? kc.orgOf.get(user.sub) : user.org
    return sign({
      iss: issuer, sub: user.sub, aud: ['osp', 'account'], azp: 'osp', typ: 'Bearer', exp: now() + 300, iat: now(),
      email: user.email, preferred_username: user.email, sid: user.sid || 'sid-1',
      resource_access: { osp: { roles }, account: { roles: ['view-profile'] } },
      ...(org !== undefined ? { su10_org_id: org } : {}),
    })
  }
  const idToken = (user, nonce) => sign({
    iss: issuer, sub: user.sub, aud: 'osp', azp: 'osp', exp: now() + 300, iat: now(), ...(nonce ? { nonce } : {}),
    email: user.email, given_name: user.given, family_name: user.family, name: `${user.given} ${user.family}`, sid: user.sid || 'sid-1',
  })
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const basicOk = (headers, id, secret) => {
    const h = new Headers(headers).get('authorization') || ''
    const [u, p] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map(decodeURIComponent)
    return u === id && p === secret
  }
  const page = (list, url) => {
    const first = Number(url.searchParams.get('first') || 0)
    const max = Number(url.searchParams.get('max') || 100)
    return list.slice(first, first + max)
  }

  kc.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.host !== host) throw new TypeError('fetch failed: unknown host')
    if (kc.down) throw new TypeError('fetch failed')
    const method = (init.method || 'GET').toUpperCase()
    if (url.pathname === `${realmPath}/.well-known/openid-configuration`) {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/protocol/openid-connect/auth`, token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`, end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'],
        authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      })
    }
    if (url.pathname === `${realmPath}/protocol/openid-connect/certs`) return json(200, { keys: [jwk] })
    if (url.pathname === `${realmPath}/protocol/openid-connect/token` && method === 'POST') {
      const body = new URLSearchParams(String(init.body))
      const grant = body.get('grant_type')
      if (grant === 'client_credentials') {
        if (!basicOk(init.headers, 'osp-access-sync', adminSecret)) return json(401, { error: 'invalid_client' })
        return json(200, { access_token: `admin-${crypto.randomUUID()}`, token_type: 'Bearer', expires_in: 300 })
      }
      if (!basicOk(init.headers, 'osp', clientSecret)) return json(401, { error: 'invalid_client' })
      if (grant === 'authorization_code') {
        kc.calls.code++
        const c = kc.codes.get(body.get('code'))
        kc.codes.delete(body.get('code'))
        if (!c) return json(400, { error: 'invalid_grant' })
        const challenge = crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url')
        if (challenge !== c.challenge || body.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' })
        const rt = `rt-${crypto.randomUUID()}`
        kc.refresh.set(rt, { user: c.user })
        return json(200, { access_token: await accessToken(c.user), id_token: await idToken(c.user, c.nonce), refresh_token: rt, token_type: 'Bearer', expires_in: 300 })
      }
      if (grant === 'refresh_token') {
        kc.calls.refresh++
        const r = kc.refresh.get(body.get('refresh_token'))
        if (!r || kc.refreshMode === 'invalid_grant') return json(400, { error: 'invalid_grant' })
        const rt = `rt-${crypto.randomUUID()}`
        kc.refresh.set(rt, { user: r.user })
        return json(200, { access_token: await accessToken(r.user), id_token: await idToken(r.user), refresh_token: rt, token_type: 'Bearer', expires_in: 300 })
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname.startsWith(`${adminPath}/`)) {
      kc.calls.admin++
      if (!/^Bearer admin-/.test(new Headers(init.headers).get('authorization') || '')) return json(401, { error: 'unauthorized' })
      const p = url.pathname.slice(adminPath.length)
      if (p === '/groups') {
        if (url.searchParams.get('exact') !== 'true') return json(400, {})
        const search = url.searchParams.get('search')
        if (search === 'org') return json(200, kc.orgRootMissing ? [] : [{ id: ORG_ROOT_ID, name: 'org', path: '/org', subGroups: [] }])
        return json(200, [{ id: GROUP_ID, name: 'osp-access', path: '/osp-access', subGroups: [] }])
      }
      if (p === `/groups/${GROUP_ID}/members`) {
        if (kc.forbid.has('members')) return json(403, { error: 'forbidden' })
        kc.calls.members++
        return json(200, page(kc.members, url))
      }
      if (p === `/groups/${ORG_ROOT_ID}/children`) {
        if (kc.forbid.has('children')) return json(403, { error: 'forbidden' })
        kc.calls.children++
        const n = Math.floor(Number(url.searchParams.get('first') || 0) / 100)
        if (kc.failChildrenPage === n) return json(500, { error: 'boom' })
        return json(200, page(kc.orgGroups, url))
      }
      const m = /^\/users\/([0-9a-f-]{36})\/groups$/.exec(p)
      if (m) {
        if (kc.forbid.has('user_groups')) return json(403, { error: 'forbidden' })
        kc.calls.userGroups++
        return json(200, kc.userGroups.get(m[1]) || [])
      }
      return json(404, {})
    }
    return json(404, { error: 'not_found' })
  }
  return kc
}
