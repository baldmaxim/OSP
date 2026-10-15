// Шлюз данных: /api/db/<таблица> и /api/db/rpc/<функция> → PostgREST на этом же сервере → база Яндекса.
//
// Портал шлёт сюда те же запросы, что слал в Supabase (тот же построитель запросов, src/api/db.js);
// язык запросов разбирает PostgREST — тот же компонент, что работает в Supabase. PostgREST слушает
// только 127.0.0.1 и принимает запросы только с внутренним токеном шлюза.
//
// Что делает шлюз до того, как запрос попадёт в базу:
//   1. Кто это: токен входа проверяется (как у остальных маршрутов); без токена — аноним. В режимах своего
//      входа (AUTH_MODE both | own) — единая проверка src/lib/principal.js: своя сессия из cookie (жива,
//      учётка одобрена; меняющий запрос — с CSRF и с самого портала; временный пароль — сначала сменить).
//   2. Что можно: список allow.json — выдача прав прода как есть (scripts/build-db-allow.mjs). Таблица,
//      действие, функция и каждая связанная таблица в select должны быть разрешены этому виду
//      пользователя. В базе одна учётка, и эту часть прав там выразить нечем.
//   3. В PostgREST уходит свой короткоживущий токен с минимумом данных (кто, роль, почта). Токен
//      браузера дальше шлюза не идёт.
//   4. Режим «только чтение» (файл-переключатель) — барьер записи на время переноса данных.
// Строки делит база: правила по строкам действуют и на владельца (migration/target/sql/load-single-owner.sql).
//
// Отказы шлюза имеют тот же вид и коды, что отказы PostgREST: портал уже умеет их показывать.
import { createHash } from 'node:crypto'
import { SignJWT } from 'jose'
import { access } from '../lib/access.js'
import { bearerToken } from '../lib/keys.js'
import { csrfProblem, clearSessionCookies } from '../lib/principal.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'

export const GATEWAY_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']
export const GATEWAY_URL = '/api/db/*'
export const GATEWAY_REASON = 'шлюз данных: вход и права проверяет сам, аноним — только чтение по списку allow.json'
// Тело запроса: массовые вставки (импорт ведомостей и КП) бывают большими.
export const GATEWAY_BODY_LIMIT = 50 * 1024 * 1024
const INTERNAL_TOKEN_TTL_S = 60
const UPSTREAM_TIMEOUT_MS = 125_000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const ACTION = { GET: 'select', HEAD: 'select', POST: 'insert', PATCH: 'update', DELETE: 'delete' }
const REQUEST_HEADERS = ['accept', 'content-type', 'prefer', 'range', 'range-unit']
const RESPONSE_HEADERS = ['content-type', 'content-range', 'content-location', 'preference-applied', 'location', 'range-unit']

const pgError = (code, message) => ({ code, details: null, hint: null, message })

// Имена связанных таблиц в параметре select: «*, objects(name), winner:counterparties!fk(id, name)».
// Связь — имя перед открывающей скобкой (без псевдонима «alias:», подсказок «!…» и «...» разворота).
// Всё, что не разбирается однозначно, — отказ: лучше не пропустить запрос, чем пропустить не тот.
export function embeddedRelations(select) {
  const names = new Set()
  const text = String(select ?? '')
  let token = ''
  for (const ch of text) {
    if (ch === '"') throw new Error('имена в кавычках в select не поддерживаются')
    if (ch === '(') {
      let name = token.trim()
      if (name.startsWith('...')) name = name.slice(3)
      // Псевдоним отделяется одним двоеточием; «::» — приведение типа, перед скобкой его не бывает.
      if (name.includes('::')) throw new Error('приведение типа перед скобкой в select')
      const colon = name.indexOf(':')
      if (colon !== -1) name = name.slice(colon + 1)
      name = name.split('!')[0].trim()
      if (!IDENT.test(name)) throw new Error('непонятное имя связи в select')
      names.add(name)
      token = ''
    } else if (ch === ',' || ch === ')') {
      token = ''
    } else {
      token += ch
    }
  }
  return [...names]
}

// Решение по списку: null — можно; иначе { status, body } отказа в виде PostgREST.
export function decide(allow, role, method, kind, name, { select = '', prefer = '' } = {}) {
  const deny = (what) => ({ status: role === 'anon' ? 401 : 403, body: pgError('42501', `permission denied for ${what}`) })
  if (kind === 'rpc') {
    if (!Object.hasOwn(allow.rpc, name)) {
      return { status: 404, body: pgError('PGRST202', `Could not find the function public.${name} in the schema cache`) }
    }
    if (!allow.rpc[name].includes(role)) return deny(`function ${name}`)
  } else {
    if (!Object.hasOwn(allow.tables, name)) {
      return { status: 404, body: pgError('PGRST205', `Could not find the table 'public.${name}' in the schema cache`) }
    }
    const actions = allow.tables[name][role] || []
    const need = new Set([ACTION[method]])
    // Вставка «с заменой при совпадении» меняет существующие строки; ответ со строками требует чтения.
    if (method === 'POST' && /resolution=merge-duplicates/.test(prefer)) need.add('update')
    if (method !== 'GET' && method !== 'HEAD' && (/return=representation/.test(prefer) || select)) need.add('select')
    for (const action of need) if (!actions.includes(action)) return deny(`table ${name}`)
  }
  let related
  try {
    related = embeddedRelations(select)
  } catch (err) {
    return { status: 400, body: pgError('PGRST100', `select: ${err.message}`) }
  }
  for (const rel of related) {
    if (!(allow.tables[rel]?.[role] || []).includes('select')) return deny(`table ${rel}`)
  }
  return null
}

// Проверка токена входа через Supabase с памятью на минуту: без неё каждый запрос к данным
// превращался бы ещё и в запрос к Supabase. Нужна, только если секрет подписи на сервере не задан.
export function createRemoteVerifier({ getUser, ttlMs = 60_000, maxEntries = 2000, now = Date.now }) {
  const cache = new Map()
  return async function verify(token) {
    const key = createHash('sha256').update(token).digest('hex')
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.user
    const user = await getUser(token)
    if (!user) return null
    cache.delete(key)
    cache.set(key, { user: { id: user.id, email: user.email || '' }, at: now() })
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    return cache.get(key).user
  }
}

export function createInternalTokens({ secret, dbRole }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('osp-api: внутренний секрет шлюза (OSP_PGRST_JWT_SECRET) короче 32 символов')
  if (!IDENT.test(dbRole || '')) throw new Error('osp-api: не задана учётка базы для PostgREST (OSP_PGRST_DB_ROLE)')
  const key = new TextEncoder().encode(secret)
  // role — учётка базы, под которой PostgREST выполняет запрос (она одна); кто пользователь на самом
  // деле — в osp_role: по нему база применяет правила (auth.role(), migration/target/compat/auth.sql).
  return (who) => new SignJWT({
    role: dbRole,
    osp_role: who.role,
    ...(who.user ? { sub: who.user.id, email: who.user.email || '' } : {}),
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt().setExpirationTime(`${INTERNAL_TOKEN_TTL_S}s`).sign(key)
}

export function registerDbGateway(app, ctx) {
  const { config, verifyUserToken, allow, mint } = ctx
  const upstream = String(config.dbGateway?.upstream || '').replace(/\/+$/, '')
  const fetchImpl = ctx.fetch || fetch

  // Барьер записи — общий с маршрутом файлов (src/lib/writeBarrier.js).
  const isReadOnly = ctx.isReadOnly || (() => false)

  const handler = async (request, reply) => {
    const send = (status, body) => reply.code(status).type('application/json; charset=utf-8').send(body)
    // Шлюз не настроен (данные ещё в Supabase): маршрут есть, но закрыт.
    if (!ctx.gatewayOn) return send(503, pgError('OSP_GATEWAY_OFF', 'Шлюз данных не настроен'))
    const [rawPath, rawQuery = ''] = request.raw.url.split('?', 2)
    const parts = rawPath.slice('/api/db/'.length).split('/')
    const kind = parts.length === 2 && parts[0] === 'rpc' ? 'rpc' : parts.length === 1 ? 'table' : null
    const name = kind === 'rpc' ? parts[1] : parts[0]
    if (!kind || !IDENT.test(name || '')) return send(404, pgError('PGRST125', 'Invalid path specified in request URL'))
    const method = request.method
    if (kind === 'rpc' && method !== 'POST' && method !== 'GET' && method !== 'HEAD') {
      return send(405, pgError('PGRST101', 'Only GET and POST verbs are allowed for rpc'))
    }

    // 1. Кто это.
    let who = { role: 'anon' }
    if (ctx.principal) {
      const p = await ctx.principal.resolve(request)
      if (p.kind === 'error') {
        if (p.clear) clearSessionCookies(reply)
        return send(p.status, pgError(p.code, p.message))
      }
      if (p.kind === 'user') {
        if (p.source === 'own') {
          if (p.session.mustChange) return send(403, pgError('OSP_PASSWORD_CHANGE_REQUIRED', 'Смените временный пароль'))
          const bad = csrfProblem(request, p, ctx.config.auth?.publicOrigin)
          if (bad) return send(403, pgError('OSP_CSRF', bad))
        }
        who = { role: 'authenticated', user: p.user }
      }
    } else if (request.headers.authorization) {
      const token = bearerToken(request.headers.authorization)
      const user = token ? await verifyUserToken(token) : null
      if (!user) return send(401, pgError('PGRST301', 'JWT expired or invalid'))
      who = { role: 'authenticated', user }
    }

    // 2. Что можно.
    const params = new URLSearchParams(rawQuery)
    const prefer = String(request.headers.prefer || '')
    const denied = decide(allow, who.role, method, kind, name, { select: params.get('select') || '', prefer })
    if (denied) return send(denied.status, denied.body)

    // 4. Барьер записи: читать можно, менять — нет (вызов функции — тоже возможное изменение).
    if (isReadOnly() && (kind === 'rpc' ? method === 'POST' : method !== 'GET' && method !== 'HEAD')) {
      return send(503, pgError(READONLY_CODE, READONLY_TEXT))
    }

    // Действия, которым нужно что-то сверх базы (учётки во входе Supabase) — до запроса.
    if (ctx.beforeGateway) {
      const stop = await ctx.beforeGateway({ kind, name, who, request })
      if (stop) return send(stop.status, stop.body)
    }

    // 3. Запрос в PostgREST — со своим токеном.
    const headers = { authorization: `Bearer ${await mint(who)}` }
    for (const h of REQUEST_HEADERS) if (request.headers[h]) headers[h] = request.headers[h]
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body && request.body.length > 0
    let res
    try {
      res = await fetchImpl(`${upstream}/${kind === 'rpc' ? 'rpc/' : ''}${name}${rawQuery ? `?${rawQuery}` : ''}`, {
        method, headers, body: hasBody ? request.body : undefined, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (err) {
      request.log.error({ route: GATEWAY_URL, msg: String(err?.cause?.code || err?.name || err).slice(0, 80) }, 'db gateway upstream')
      return send(503, pgError('PGRST000', 'Сервис данных временно недоступен, повторите запрос'))
    }
    reply.code(res.status)
    for (const h of RESPONSE_HEADERS) {
      const value = res.headers.get(h)
      if (value) reply.header(h, value)
    }
    return reply.send(method === 'HEAD' ? '' : Buffer.from(await res.arrayBuffer()))
  }

  // Свой разбор тела: запрос передаётся в PostgREST как есть, байт в байт.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: GATEWAY_BODY_LIMIT }, (req, body, done) => done(null, body))
    scope.route({
      method: GATEWAY_METHODS,
      url: GATEWAY_URL,
      bodyLimit: GATEWAY_BODY_LIMIT,
      config: { access: access.open(GATEWAY_REASON) },
      handler,
    })
  })
}
