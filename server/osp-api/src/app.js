// osp-api — свой API портала ОСП (этап 3, migration/PLAN.md). Сейчас — маршруты вместо Edge
// Functions Supabase: /api/fn/s3-presign, /api/fn/ai-assist, /api/rates/*. Данные пока берутся из
// Supabase (под токеном пользователя, RLS действует как в браузере); на этапе переноса базы меняется
// только источник, маршруты остаются.
//
// Журнал: метод, ШАБЛОН маршрута, код, время. Ни адреса с параметрами (в ?key= ключ rates-api), ни
// заголовков, ни тел запросов (в них текст договоров) в журнал не попадает.
import Fastify from 'fastify'
import { createClient } from '@supabase/supabase-js'
import { S3Client } from '@aws-sdk/client-s3'
import Anthropic from '@anthropic-ai/sdk'
import { configuredParts } from './config.js'
import { bearerToken } from './lib/keys.js'
import { registerS3Presign } from './routes/s3Presign.js'
import { registerAiAssist } from './routes/aiAssist.js'
import { registerRates } from './routes/rates.js'

// Ответ ИИ ждём меньше, чем nginx ждёт нас (proxy_read_timeout 180 с, docs/DEPLOYMENT.md).
export const AI_TIMEOUT_MS = 170_000

export const defaultDeps = {
  createSupabase: (url, key, options) => createClient(url, key, options),
  createS3: (s3) => new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    forcePathStyle: true, // cloud.ru — path-style адреса
  }),
  createAnthropic: (apiKey) => new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS }),
}

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

export function buildApp({ config, deps = defaultDeps, logger = { level: 'info' } } = {}) {
  const app = Fastify({ logger, disableRequestLogging: true, bodyLimit: 1024 * 1024 })

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

  app.setErrorHandler((err, request, reply) => {
    if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) {
      return reply.code(400).send({ error: 'Invalid JSON' })
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    request.log.error({ route: request.routeOptions?.url, msg: err.message }, 'unhandled')
    return reply.code(500).send({ error: 'Internal error' })
  })

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found' }))

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      method: request.method,
      route: request.routeOptions?.url || 'not-found',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    }, 'request')
  })

  app.get('/api/health', async () => ({ ok: true, service: 'osp-api', configured: configuredParts(config) }))

  const ctx = { config, authenticate, getS3, getAnthropic, getServiceClient }
  registerS3Presign(app, ctx)
  registerAiAssist(app, ctx)
  registerRates(app, ctx)
  return app
}
