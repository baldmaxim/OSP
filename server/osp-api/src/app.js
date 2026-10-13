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
// Журнал: метод, ШАБЛОН маршрута, код, время. Ни адреса с параметрами (в ?key= ключ rates-api), ни
// заголовков, ни тел запросов (в них текст договоров) в журнал не попадает. Ответы не кешируются.
import fs from 'node:fs'
import Fastify, { LogController } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { PostgrestClient } from '@supabase/postgrest-js'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import Anthropic from '@anthropic-ai/sdk'
import { configuredParts, READY_PARTS, READY_OPTIONAL } from './config.js'
import { bearerToken } from './lib/keys.js'
import { createDb } from './lib/db.js'
import { createTokenVerifier } from './lib/token.js'
import { createUserStatus, STATUS_DEFAULTS } from './lib/userStatus.js'
import { createRateLimit, createConcurrency, DEFAULT_LIMITS } from './lib/limits.js'
import { access, installAccess } from './lib/access.js'
import { OPEN_ROUTES } from './open-routes.js'
import { registerS3Presign } from './routes/s3Presign.js'
import { registerAiAssist } from './routes/aiAssist.js'
import { registerRates } from './routes/rates.js'
import { registerDbGateway, createInternalTokens, createRemoteVerifier } from './routes/dbGateway.js'
import { createAuthAdmin, createAuthUsersMirror } from './lib/authUsers.js'
import { createWriteBarrier } from './lib/writeBarrier.js'
import { createLoadStatus, isFinalLoad } from './lib/loadStatus.js'

// Список разрешённого шлюзу данных — выдача прав прода как есть (scripts/build-db-allow.mjs).
const ALLOW = JSON.parse(fs.readFileSync(new URL('./data/allow.json', import.meta.url), 'utf8'))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Функции портала, которые меняют учётку во входе Supabase Auth, а не только строки базы.
const AUTH_ADMIN_RPC = { admin_delete_user: 'deleteUser', admin_confirm_user_email: 'confirmEmail' }
const REGISTRY_REFRESH_MS = 10 * 60_000

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
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function buildApp({ config, deps = defaultDeps, logger = { level: 'info' }, limits = DEFAULT_LIMITS } = {}) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
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

  // Пользователь по его токену Supabase; клиент — от его имени, чтобы действовал RLS.
  const authenticate = async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader) { reply.code(401).send({ error: 'Unauthorized' }); return null }
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
    // Тело — объект JSON (как ждали Edge Functions); иначе — «Invalid JSON».
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400).send({ error: 'Invalid JSON' }); return null
    }
    return { supabase, user, who: { userId: user.id, email: user.email || '' } }
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

  const limiters = {
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
  installAccess(app, { authenticate, limiters, openRoutes: OPEN_ROUTES, userStatus })
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
    return reply.code(ok ? 200 : 503).send({ ok, checks, required, ...data })
  } })

  const ctx = { config, getS3, getAnthropic, getServiceClient, limiters, db, refreshRegistry,
    verifyUserToken, allow: deps.allow || ALLOW, mint, beforeGateway, gatewayOn, isReadOnly, loadStatus }
  registerDbGateway(app, ctx)
  registerS3Presign(app, ctx)
  registerAiAssist(app, ctx)
  registerRates(app, ctx)
  return app
}
