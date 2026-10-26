// osp-api — свой API портала ОСП (этап 3, migration/PLAN.md). Сейчас — маршруты вместо Edge
// Functions Supabase: /api/fn/s3-presign, /api/fn/ai-assist, /api/rates/*. Данные пока берутся из
// Supabase (под токеном пользователя, RLS действует как в браузере); на этапе переноса базы меняется
// только источник, маршруты остаются.
//
// Данные. Задан OSP_PGRST_URL — работает шлюз /api/db (src/routes/dbGateway.js): портал читает и пишет
// базу Яндекса через PostgREST на этом сервере, маршруты файлов, ИИ и расценок берут данные там же.
// Не задан — шлюза нет, данные в Supabase.
//
// Кто вошёл. Задан SUPABASE_JWT_SECRET — токен проверяется здесь (src/lib/token.js); задан OSP_DB_URL —
// статус учётки читается из базы с коротким кэшем (src/lib/userStatus.js). Не заданы — как раньше:
// оба шага запросами к Supabase. Вернуть прежний путь — убрать ключ из окружения и перезапустить.
//
// Свой вход (AUTH_MODE): supabase — как раньше; both — пилот своего входа (OSP_AUTH_PILOT_IDS); own — только
// свой вход: учётки и пароли в базе Яндекса, сессия в httpOnly-cookie, Supabase не нужен (src/lib/auth/,
// src/lib/principal.js, src/routes/auth.js). Переключение и откат — одной строкой окружения и перезапуском.
//
// Журнал: метод, ШАБЛОН маршрута, код, время. Ни адреса с параметрами (в ?key= ключ rates-api), ни
// заголовков, ни тел запросов (в них текст договоров) в журнал не попадает. Ответы не кешируются.
import fs from 'node:fs'
import Fastify, { LogController } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { PostgrestClient } from '@supabase/postgrest-js'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import Anthropic from '@anthropic-ai/sdk'
import { configuredParts, checkOwnAuthConfig, READY_PARTS, READY_OPTIONAL } from './config.js'
import { bearerToken } from './lib/keys.js'
import { createDb, dbUnavailable, DB_UNAVAILABLE, DB_UNAVAILABLE_TEXT } from './lib/db.js'
import { createTokenVerifier } from './lib/token.js'
import { createUserStatus, STATUS_DEFAULTS } from './lib/userStatus.js'
import { createRateLimit, createConcurrency, DEFAULT_LIMITS } from './lib/limits.js'
import { access, installAccess } from './lib/access.js'
import { OPEN_ROUTES } from './open-routes.js'
import { registerS3Presign } from './routes/s3Presign.js'
import { registerAiAssist } from './routes/aiAssist.js'
import { registerRates } from './routes/rates.js'
import { registerCovers } from './routes/covers.js'
import { registerDbGateway, createInternalTokens, createRemoteVerifier } from './routes/dbGateway.js'
import { createAuthAdmin, createAuthUsersMirror } from './lib/authUsers.js'
import { createWriteBarrier } from './lib/writeBarrier.js'
import { createLoadStatus, isFinalLoad } from './lib/loadStatus.js'
import { createLarixClient } from './lib/larixClient.js'
import { createLarixSync, dbTarget, supabaseTarget } from './lib/larixSync.js'
import { createSupplyImport } from './lib/supplyImport.js'
import { createSecretBox } from './lib/auth/secretBox.js'
import { createPasswordVerifier } from './lib/auth/passwords.js'
import { loadBlocklist } from './lib/auth/policy.js'
import { createSessions, SESSION_DEFAULTS } from './lib/auth/sessions.js'
import { createAuthService } from './lib/auth/service.js'
import { createPrincipalResolver, csrfProblem, clearSessionCookies } from './lib/principal.js'
import { registerAuth } from './routes/auth.js'

// Список разрешённого шлюзу данных — выдача прав прода как есть (scripts/build-db-allow.mjs).
const ALLOW = JSON.parse(fs.readFileSync(new URL('./data/allow.json', import.meta.url), 'utf8'))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Функции портала, которые меняют учётку во входе Supabase Auth, а не только строки базы.
const AUTH_ADMIN_RPC = { admin_delete_user: 'deleteUser', admin_confirm_user_email: 'confirmEmail' }
const REGISTRY_REFRESH_MS = 10 * 60_000
const AUTH_CLEANUP_MS = 10 * 60_000
const SUPERADMIN_TTL_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

// Ответ ИИ ждём меньше, чем nginx ждёт нас (proxy_read_timeout 180 с, deploy/nginx/osp.root.sx.conf).
export const AI_TIMEOUT_MS = 170_000
// Тело запроса — как client_max_body_size в nginx.
export const BODY_LIMIT = 2 * 1024 * 1024
const READY_TIMEOUT_MS = 5_000
// Служебный объект проверки готовности S3: пишется и сразу удаляется (нужны ровно те права, что у
// загрузки и удаления файлов; HeadBucket требует ListBucket, которого у ключа может не быть).
export const READY_S3_KEY = 'osp-api/ready-check'

export const defaultDeps = {
  createSupabase: (url, key, options) => createClient(url, key, options),
  createS3: (s3) => new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    forcePathStyle: true, // cloud.ru — path-style адреса
  }),
  createAnthropic: (apiKey) => new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS }),
  createDb: (options) => createDb(options),
  // Проверки готовности — каждая бросает при отказе.
  checkSupabase: async (config, signal) => {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/health`, { headers: { apikey: config.supabaseAnonKey }, signal })
    if (!res.ok) throw new Error(`auth health ${res.status}`)
  },
  checkS3: async (s3, bucket) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: READY_S3_KEY, Body: 'ok', ContentType: 'text/plain' }))
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: READY_S3_KEY }))
  },
  checkAnthropic: async (client) => {
    await client.models.list({ limit: 1 }) // без токенов, бесплатно
  },
}

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
// Вызов функции загрузки Larix в Supabase ждём не дольше минуты: у клиента supabase-js своего предела нет.
const LARIX_SUPABASE_TIMEOUT_MS = 60_000

// Базы, в которые пишет загрузка Larix (LARIX_SYNC_TARGETS), — для службы и для src/larix-cli.js.
export function buildLarixTargets(config, { db, deps = defaultDeps }) {
  const targets = []
  if (config.larix.targets.includes('db')) {
    if (!db) throw new Error('LARIX_SYNC_TARGETS=db: нет подключения к своей базе (OSP_DB_URL)')
    targets.push(dbTarget(db))
  }
  if (config.larix.targets.includes('supabase')) {
    const client = deps.createSupabase(config.supabaseUrl, config.supabaseServiceKey, {
      auth: SERVER_AUTH,
      global: {
        fetch: (input, init = {}) => {
          const timeout = AbortSignal.timeout(LARIX_SUPABASE_TIMEOUT_MS)
          return fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
        },
      },
    })
    targets.push(supabaseTarget(client))
  }
  return targets
}

export const larixSecrets = (config) => [config.larix.password, config.larix.username, config.supabaseServiceKey]
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

// Тело — объект JSON (как ждали Edge Functions); у запросов без тела (GET /api/auth/me) не проверяется.
function bodyIsObject(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true
  const body = request.body
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body)
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function buildApp({ config, deps = defaultDeps, logger = { level: 'info' }, limits = DEFAULT_LIMITS } = {}) {
  // Свой вход с неполными настройками не запускается (ключи, адрес портала, база, шлюз).
  checkOwnAuthConfig(config)
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    // Адрес клиента (лимиты входа) — из X-Forwarded-For только от непосредственного соседа: до osp-api не
    // достаёт никто, кроме своего прокси, а он перезаписывает заголовок одним адресом клиента (config.js).
    trustProxy: config.trustProxy === 'peer' ? (address, hop) => hop === 0 : false,
  })

  // Своё подключение к базе — если задано. Неверная настройка (нет сертификата, не та строка)
  // останавливает запуск; доступность базы проверяет /api/ready.
  const db = config.db?.url
    ? deps.createDb({ url: config.db.url, caFile: config.db.caFile, max: config.db.poolMax, secondLockRole: config.db.secondLockRole || '', logger: app.log })
    : null
  if (db) app.addHook('onClose', async () => { await db.close() })
  const userStatus = db ? createUserStatus({ db, ttlMs: config.userStatusTtlMs ?? STATUS_DEFAULTS.ttlMs }) : null
  const verifier = config.supabaseJwtSecret
    ? createTokenVerifier({ secret: config.supabaseJwtSecret, supabaseUrl: config.supabaseUrl })
    : null

  // Чей это токен входа → { id, email } либо null. Проверка на сервере, если задан секрет подписи;
  // иначе — запросом к Supabase с памятью на минуту (шлюз данных зовёт это на каждый запрос).
  const remoteVerify = createRemoteVerifier({ getUser: async (token) => {
    const client = deps.createSupabase(config.supabaseUrl, config.supabaseAnonKey, { auth: SERVER_AUTH })
    const { data, error } = await client.auth.getUser(token)
    return error ? null : data?.user || null
  } })
  const verifyUserToken = async (token) => {
    if (verifier) { try { return await verifier.verify(token) } catch { return null } }
    if (!config.supabaseUrl || !config.supabaseAnonKey) return null
    return remoteVerify(token)
  }

  // Шлюз данных: PostgREST на этом сервере. Клиент данных для маршрутов — тот же построитель запросов,
  // что у supabase-js, но к своему PostgREST и с внутренним токеном (кто, роль), выпускаемым на запрос.
  const gatewayOn = Boolean(config.dbGateway?.upstream)
  const mint = gatewayOn ? createInternalTokens({ secret: config.dbGateway.secret, dbRole: config.dbGateway.dbRole }) : null
  // Барьер записи на время переноса — один на шлюз и на маршрут файлов.
  const isReadOnly = createWriteBarrier({ file: config.dbGateway?.readOnlyFile, enabled: gatewayOn })
  // Какая копия данных за шлюзом: репетиция переноса или рабочая. У репетиции хранилище файлов и вход
  // общие с рабочим порталом — пока копия не рабочая, сервер их не меняет (src/lib/loadStatus.js).
  const loadStatus = deps.createLoadStatus ? deps.createLoadStatus({ db }) : createLoadStatus({ db, logger: app.log })
  const dataClient = (who) => new PostgrestClient(config.dbGateway.upstream.replace(/\/+$/, ''), {
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${await mint(who)}`)
      return fetch(input, { ...init, headers })
    },
  })

  // Свой вход: сессии, пароли, единая проверка «кто это» для маршрутов, шлюза и /api/auth.
  const authMode = config.authMode || 'supabase'
  const ownAuth = authMode !== 'supabase'
  const sessions = ownAuth ? createSessions({
    db, logger: app.log,
    idleMs: (config.auth.idleDays ?? 14) * DAY_MS, absoluteMs: (config.auth.absoluteDays ?? 30) * DAY_MS,
    cacheMs: config.auth.sessionCacheMs ?? SESSION_DEFAULTS.cacheMs,
  }) : null
  const authService = ownAuth ? createAuthService({
    db, sessions, box: createSecretBox(config.auth.keys),
    verifier: deps.createPasswordVerifier ? deps.createPasswordVerifier() : createPasswordVerifier(),
    blocklist: deps.blocklist || loadBlocklist(), mode: authMode, pilotIds: config.auth.pilotIds || [], logger: app.log,
  }) : null
  // Суперадминистратор (таблица superadmins) — с памятью на полминуты: спрашивается на каждом запросе своей сессии
  // только у тех, кто не одобрен, и у маршрутов администратора.
  const superadminCache = new Map()
  const isSuperadmin = authService ? async (userId) => {
    const hit = superadminCache.get(userId)
    if (hit && Date.now() - hit.at < SUPERADMIN_TTL_MS) return hit.value
    const value = await authService.isSuperadmin(userId)
    superadminCache.set(userId, { value, at: Date.now() })
    if (superadminCache.size > 2000) superadminCache.delete(superadminCache.keys().next().value)
    return value
  } : null
  const principal = ownAuth ? createPrincipalResolver({
    mode: authMode, verifyBearer: verifyUserToken, sessions, userStatus, isSuperadmin, pilotIds: config.auth.pilotIds || [],
  }) : null
  const refuse = (reply, p) => {
    if (p.clear) clearSessionCookies(reply)
    reply.code(p.status).send({ error: p.message, code: p.code })
    return null
  }

  // Кто вошёл: своя сессия (cookie) или токен Supabase (заголовок); клиент данных — от его имени, чтобы
  // действовали правила по строкам.
  const authenticate = async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader && ownAuth) {
      const p = await principal.resolve(request)
      if (p.kind === 'error') return refuse(reply, p)
      if (p.kind === 'anon') { reply.code(401).send({ error: 'Unauthorized' }); return null }
      const bad = csrfProblem(request, p, config.auth.publicOrigin)
      if (bad) { reply.code(403).send({ error: bad, code: 'OSP_CSRF' }); return null }
      if (!bodyIsObject(request)) { reply.code(400).send({ error: 'Invalid JSON' }); return null }
      return { supabase: dataClient({ role: 'authenticated', user: p.user }), user: p.user, session: p.session,
        who: { userId: p.user.id, email: p.user.email || '' } }
    }
    if (!authHeader) { reply.code(401).send({ error: 'Unauthorized' }); return null }
    if (authMode === 'own') return refuse(reply, { status: 401, code: 'OSP_AUTH_MODE', message: 'Вход изменился — обновите страницу' })
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      reply.code(500).send({ error: 'Supabase env not configured' }); return null
    }
    const token = bearerToken(authHeader)
    if (!token) { reply.code(401).send({ error: 'Unauthorized' }); return null }
    let user
    let supabase
    if (gatewayOn) {
      // Данные — в базе Яндекса: клиент маршрута ходит в свой PostgREST от имени этого пользователя.
      user = await verifyUserToken(token)
      if (!user) { reply.code(401).send({ error: 'Unauthorized' }); return null }
      supabase = dataClient({ role: 'authenticated', user })
    } else {
      supabase = deps.createSupabase(config.supabaseUrl, config.supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: SERVER_AUTH,
      })
      if (verifier) {
        try {
          user = await verifier.verify(token)
        } catch {
          reply.code(401).send({ error: 'Unauthorized' }); return null
        }
      } else {
        const { data, error } = await supabase.auth.getUser(token)
        if (error || !data?.user) { reply.code(401).send({ error: 'Unauthorized' }); return null }
        user = data.user
      }
    }
    if (!bodyIsObject(request)) { reply.code(400).send({ error: 'Invalid JSON' }); return null }
    return { supabase, user, session: null, who: { userId: user.id, email: user.email || '' } }
  }

  let s3Client = null
  const getS3 = () => {
    const s3 = config.s3
    if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error('S3 secrets are not configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY).')
    }
    s3Client ??= deps.createS3(s3)
    return s3Client
  }

  let anthropicClient = null
  const getAnthropic = () => (anthropicClient ??= deps.createAnthropic(config.anthropicApiKey))

  // Клиент Supabase со служебным ключом: данные (пока они там) и действия с учётками входа.
  let serviceClient = null
  const getSupabaseService = () =>
    (serviceClient ??= deps.createSupabase(config.supabaseUrl, config.supabaseServiceKey, { auth: SERVER_AUTH }))
  // Служебное чтение данных: при шлюзе — свой PostgREST с ролью service_role во внутреннем токене.
  const getServiceClient = () => (gatewayOn ? dataClient({ role: 'service_role' }) : getSupabaseService())

  const authAdmin = deps.createAuthAdmin ? deps.createAuthAdmin(config) : createAuthAdmin(getSupabaseService)
  const usersMirror = db ? createAuthUsersMirror({ db, authAdmin }) : null
  // Перед запросом шлюза: действия, которым мало базы.
  const beforeGateway = async ({ kind, name, who, request }) => {
    if (kind !== 'rpc' || who.role !== 'authenticated') return null
    if (ownAuth) {
      // Вход Supabase теперь принадлежит прежнему порталу (osp.root.sx): его учётки отсюда не меняются.
      // get_auth_users и admin_confirm_user_email — функции базы как есть. Удаление — надгробие и функция базы
      // одной транзакцией (повторный перенос учёток удалённую не воссоздаст); в PostgREST запрос не идёт.
      if (name !== 'admin_delete_user') return null
      let args = null
      try { args = JSON.parse(Buffer.from(request.body || '').toString('utf8')) } catch { /* ниже — отказ */ }
      const result = await authService.adminDeleteUser({
        who: { userId: who.user.id, email: who.user.email || '' }, targetUserId: args?.target_user_id,
      })
      if (result.ok) return { status: 204, body: null }
      return { status: result.status, body: { code: result.code, details: null, hint: null, message: result.message } }
    }
    if (name === 'get_auth_users') {
      // Список пользователей читает копию учёток в базе — освежаем её (сбой — покажем прежнюю).
      if (usersMirror && config.supabaseServiceKey) {
        await usersMirror.sync().catch((err) => request.log.warn({ msg: String(err?.message || err).slice(0, 120) }, 'auth users sync'))
      }
      return null
    }
    const action = AUTH_ADMIN_RPC[name]
    if (!action) return null
    // Репетиция переноса: вход у неё общий с рабочим порталом. Ни учётку входа, ни её строки в
    // проверочной копии не трогаем — отказ до обращения ко входу и к базе, кому бы то ни было.
    if (!isFinalLoad(await loadStatus.current())) {
      return { status: 409, body: { code: 'OSP_REHEARSAL', details: null, hint: null,
        message: 'Проверочная копия данных: учётки входа не изменяются. Действие станет доступно после переноса.' } }
    }
    // Вправе ли — тот же вопрос базе, что задаёт сама функция. Нет — пусть откажет она.
    const { data: isAdmin, error } = await dataClient(who).rpc('is_admin')
    if (error || isAdmin !== true) return null
    let args = null
    try { args = JSON.parse(Buffer.from(request.body || '').toString('utf8')) } catch { /* ниже — отказ */ }
    const id = args && typeof args.target_user_id === 'string' && UUID.test(args.target_user_id) ? args.target_user_id : null
    // Учётку не удалось назвать (не JSON, нет идентификатора): функцию базы не зовём — иначе строки
    // портала изменились бы, а учётка входа осталась прежней.
    if (!id) {
      return { status: 400, body: { code: 'OSP_AUTH_TARGET', details: null, hint: null,
        message: 'Не указана учётка: нужен target_user_id в теле запроса (JSON).' } }
    }
    try {
      await authAdmin[action](id)
    } catch (err) {
      request.log.error({ route: '/api/db/*', msg: String(err?.message || err).slice(0, 120) }, 'auth admin')
      return { status: 502, body: { code: 'OSP_AUTH', details: null, hint: null,
        message: 'Не удалось изменить учётку во входе. Данные портала не изменены — повторите действие.' } }
    }
    return null
  }

  // Пересчёт реестра расценок по расписанию. Защита от двойного запуска — блокировка в базе:
  // вторая копия службы (или параллельный запуск) пересчёт пропустит.
  const refreshRegistry = () => db.write(null, async (tx) => {
    const { rows } = await tx.query('select pg_try_advisory_xact_lock(hashtext($1)) as ok', ['osp:registry-refresh'])
    if (rows[0].ok) await tx.query('select public.refresh_rates_registry()')
    return rows[0].ok
  }, { statementTimeoutMs: 180_000 })
  if (db && config.registryRefresh) {
    const timer = setInterval(() => {
      refreshRegistry().catch((err) => app.log.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'registry refresh'))
    }, REGISTRY_REFRESH_MS)
    timer.unref()
    app.addHook('onClose', async () => clearInterval(timer))
  }

  // Позиции ВОР для расценки снабжением — заранее, раз в 10 минут (src/lib/supplyImport.js): разбор файлов в
  // отдельном процессе, запись — служебная, при барьере записи такт пропускается.
  if (db && config.supplyImport) {
    const supplyImport = createSupplyImport({ db, s3: getS3(), bucket: config.s3.bucket, log: app.log, ...deps.supplyImport })
    const stopSupplyImport = supplyImport.start({ isReadOnly })
    app.addHook('onClose', async () => stopSupplyImport())
    app.decorate('supplyImport', supplyImport)
  }

  // Договорные расценки из Larix.CPM: раз в день в выбранные базы (src/lib/larixSync.js). Когда пора —
  // решает база; такт раз в 5 минут лишь спрашивает. Сбой Larix на готовность службы не влияет.
  if (config.larix?.sync) {
    const larixSync = createLarixSync({
      client: (deps.createLarixClient || createLarixClient)(config.larix),
      targets: buildLarixTargets(config, { db, deps }),
      log: app.log,
      secrets: larixSecrets(config),
      options: deps.larixOptions,
    })
    const stopLarix = larixSync.start({ isReadOnly })
    app.addHook('onClose', async () => stopLarix())
    app.decorate('larixSync', larixSync)
  }

  const limiters = {
    loginIp: createRateLimit(limits.loginPerIp || DEFAULT_LIMITS.loginPerIp),
    authAdmin: createRateLimit(limits.authAdminPerUser || DEFAULT_LIMITS.authAdminPerUser),
    aiRate: createRateLimit(limits.aiPerUser),
    aiUser: createConcurrency(limits.aiConcurrentPerUser),
    aiTotal: createConcurrency(limits.aiConcurrentTotal),
    presignRate: createRateLimit(limits.presignPerUser),
    ratesRate: createRateLimit(limits.ratesPerKey),
    ratesKey: createConcurrency(limits.ratesConcurrentPerKey),
  }

  app.setErrorHandler((err, request, reply) => {
    if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) {
      return reply.code(400).send({ error: 'Invalid JSON' })
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      return reply.code(413).send({ error: 'Слишком большой запрос' })
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    if (dbUnavailable(err) || dbUnavailable(err?.cause)) {
      request.log.error({ route: request.routeOptions?.url, code: String(err?.code || err?.cause?.code || 'CONNECT') }, 'db unavailable')
      return reply.code(503).send({ error: DB_UNAVAILABLE_TEXT, code: DB_UNAVAILABLE })
    }
    request.log.error({ route: request.routeOptions?.url, msg: err.message }, 'unhandled')
    return reply.code(500).send({ error: 'Internal error' })
  })

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found' }))

  // В ответах — подписанные ссылки и данные реестра: ни браузер, ни прокси их не кешируют.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      method: request.method,
      route: request.routeOptions?.url || 'not-found',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    }, 'request')
  })

  // Права — на маршруте: без config.access маршрут не регистрируется (закрыто по умолчанию),
  // открытые адреса — только из утверждённого списка. Ставится до первого маршрута.
  installAccess(app, { authenticate, limiters, openRoutes: OPEN_ROUTES, userStatus, isSuperadmin })
  const openReason = (method, url) => OPEN_ROUTES.find((r) => r.method === method && r.url === url).reason

  app.route({
    method: 'GET',
    url: '/api/health',
    config: { access: access.open(openReason('GET', '/api/health')) },
    handler: async () => ({ ok: true, service: 'osp-api', configured: configuredParts(config) }),
  })

  // Готовность: зависимости действительно отвечают с текущими ключами. 200 — только если каждая
  // обязательная (config.required, OSP_API_REQUIRE) ответила «ok»; необязательные проверяются и
  // показываются, но не решают. Только изнутри сервера (api-deploy.sh, ручная проверка): через nginx
  // (есть X-Forwarded-For) — 404.
  app.route({ method: 'GET', url: '/api/ready', config: { access: access.open(openReason('GET', '/api/ready')) }, handler: async (request, reply) => {
    if (request.headers['x-forwarded-for'] || !LOOPBACK.has(request.socket.remoteAddress)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const parts = configuredParts(config)
    const checks = {}
    const run = async (name, configured, fn) => {
      if (!configured) { checks[name] = 'not_configured'; return }
      const controller = new AbortController()
      try {
        await withTimeout(fn(controller.signal), READY_TIMEOUT_MS)
        checks[name] = 'ok'
      } catch (e) {
        controller.abort()
        checks[name] = 'fail'
        request.log.warn({ check: name, msg: String(e?.name || '') + ': ' + String(e?.message || e).slice(0, 200) }, 'ready')
      }
    }
    await Promise.all([
      run('supabase', parts.supabase, (signal) => deps.checkSupabase(config, signal)),
      run('s3', parts.s3, () => deps.checkS3(getS3(), config.s3.bucket)),
      run('anthropic', parts.anthropic, () => deps.checkAnthropic(getAnthropic())),
      run('db', Boolean(db), () => db.read(null, (tx) => tx.query('select 1'))),
      // Свой вход: канарейка ключа расшифровывается, у каждой строки паролей ключ есть в окружении.
      run('auth', ownAuth, () => authService.readyCheck()),
      // Шлюз: PostgREST отвечает, его секрет и учётка совпадают с нашими, база за ним читается.
      run('gateway', gatewayOn, async () => {
        const { error } = await dataClient({ role: 'service_role' }).from('app_settings').select('key').limit(1)
        if (error) throw new Error(`gateway ${error.code || error.message}`)
      }),
    ])
    // Секрет подписи сверяется с публичным ключом сайта: чужой секрет дал бы 401 на каждый вход.
    if (!verifier) checks.token = 'not_configured'
    else {
      const match = await verifier.matchesProjectKey(config.supabaseAnonKey)
      checks.token = match === null ? 'unchecked' : match ? 'ok' : 'fail'
    }
    const required = config.required || READY_PARTS
    const ok = required.every((name) => checks[name] === 'ok') && READY_OPTIONAL.every((name) => checks[name] !== 'fail')
    // С какой копией данных работает сервер за шлюзом: rehearsal — репетиция (файлы и учётки входа
    // рабочего портала защищены), final — рабочая, unknown — отметка не читается (защита включена).
    const data = gatewayOn ? { data: (await loadStatus.current())?.status || 'unknown' } : {}
    const recovery = db ? { inRecovery: db.recovery() } : {}
    return reply.code(ok ? 200 : 503).send({ ok, checks, required, ...data, ...recovery })
  } })

  // Очистка своего входа: просроченные сессии, давние неудачи, старый журнал (src/lib/auth/service.js).
  if (ownAuth && db && config.authCleanup !== false) {
    const timer = setInterval(() => {
      authService.cleanup()
        .then((n) => { if (n && (n.sessions || n.failures || n.events)) app.log.info({ ...n }, 'auth cleanup') })
        .catch((err) => app.log.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 'auth cleanup'))
    }, AUTH_CLEANUP_MS)
    timer.unref()
    app.addHook('onClose', async () => clearInterval(timer))
  }

  const ctx = { config, getS3, getAnthropic, getServiceClient, limiters, db, refreshRegistry,
    verifyUserToken, allow: deps.allow || ALLOW, mint, beforeGateway, gatewayOn, isReadOnly, loadStatus,
    principal, authService, sessions, isSuperadmin }
  registerAuth(app, ctx)
  registerDbGateway(app, ctx)
  registerS3Presign(app, ctx)
  registerAiAssist(app, ctx)
  registerRates(app, ctx)
  registerCovers(app, ctx)
  return app
}
