// osp-api — свой API портала ОСП (этап 3, migration/PLAN.md). Сейчас — маршруты вместо Edge
// Functions Supabase: /api/fn/s3-presign, /api/fn/ai-assist, /api/rates/*. Данные пока берутся из
// Supabase (под токеном пользователя, RLS действует как в браузере); на этапе переноса базы меняется
// только источник, маршруты остаются.
//
// Журнал: метод, ШАБЛОН маршрута, код, время. Ни адреса с параметрами (в ?key= ключ rates-api), ни
// заголовков, ни тел запросов (в них текст договоров) в журнал не попадает. Ответы не кешируются.
import Fastify, { LogController } from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import Anthropic from '@anthropic-ai/sdk'
import { configuredParts, READY_PARTS } from './config.js'
import { bearerToken } from './lib/keys.js'
import { createRateLimit, createConcurrency, DEFAULT_LIMITS } from './lib/limits.js'
import { registerS3Presign } from './routes/s3Presign.js'
import { registerAiAssist } from './routes/aiAssist.js'
import { registerRates } from './routes/rates.js'

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

  // Пользователь по его токену Supabase; клиент — от его имени, чтобы действовал RLS.
  const authenticate = async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader) { reply.code(401).send({ error: 'Unauthorized' }); return null }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      reply.code(500).send({ error: 'Supabase env not configured' }); return null
    }
    const token = bearerToken(authHeader)
    if (!token) { reply.code(401).send({ error: 'Unauthorized' }); return null }
    const supabase = deps.createSupabase(config.supabaseUrl, config.supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: SERVER_AUTH,
    })
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) { reply.code(401).send({ error: 'Unauthorized' }); return null }
    // Тело — объект JSON (как ждали Edge Functions); иначе — «Invalid JSON».
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400).send({ error: 'Invalid JSON' }); return null
    }
    return { supabase, user: data.user }
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

  let serviceClient = null
  const getServiceClient = () =>
    (serviceClient ??= deps.createSupabase(config.supabaseUrl, config.supabaseServiceKey, { auth: SERVER_AUTH }))

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

  app.get('/api/health', async () => ({ ok: true, service: 'osp-api', configured: configuredParts(config) }))

  // Готовность: зависимости действительно отвечают с текущими ключами. 200 — только если каждая
  // обязательная (config.required, OSP_API_REQUIRE) ответила «ok»; необязательные проверяются и
  // показываются, но не решают. Только изнутри сервера (api-deploy.sh, ручная проверка): через nginx
  // (есть X-Forwarded-For) — 404.
  app.get('/api/ready', async (request, reply) => {
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
    ])
    const required = config.required || READY_PARTS
    const ok = required.every((name) => checks[name] === 'ok')
    return reply.code(ok ? 200 : 503).send({ ok, checks, required })
  })

  const ctx = { config, authenticate, getS3, getAnthropic, getServiceClient, limiters }
  registerS3Presign(app, ctx)
  registerAiAssist(app, ctx)
  registerRates(app, ctx)
  return app
}
