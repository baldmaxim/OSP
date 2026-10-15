import { LARIX_DEFAULT_URL, LARIX_DEFAULTS, larixBaseUrl } from './lib/larixClient.js'
import { LARIX_TARGETS } from './lib/larixSync.js'

// Настройки osp-api — только из окружения (на VPS — файл EnvironmentFile службы, права 600).
// Значения секретов никуда не выводятся: /api/health отдаёт лишь «задано / не задано».

// Зависимости, которые проверяет /api/ready. Обязательные (OSP_API_REQUIRE) должны ответить «ok»,
// «не настроено» у обязательной — тоже отказ. По умолчанию — все три: без них не работают маршруты
// браузера. Сузить можно только явно (например, supabase,s3 — если Anthropic недоступен с сервера;
// тогда ospApiAi не включать). Опечатка или список без supabase — служба не запускается.
export const READY_PARTS = ['supabase', 's3', 'anthropic']
// Проверяются, только если настроены: своё подключение к базе (db) и секрет подписи токенов (token).
// Настроенная и не ответившая — отказ готовности и без OSP_API_REQUIRE; в списке обязательных —
// «не настроено» тоже отказ.
export const READY_OPTIONAL = ['db', 'token', 'gateway']

export function parseRequired(raw) {
  const names = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!names.length) return [...READY_PARTS]
  const known = [...READY_PARTS, ...READY_OPTIONAL]
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length) {
    throw new Error(`OSP_API_REQUIRE: неизвестные зависимости ${unknown.join(', ')} (допустимы ${known.join(', ')})`)
  }
  if (!names.includes('supabase')) throw new Error('OSP_API_REQUIRE: supabase обязателен — без него не работает ни один маршрут')
  return known.filter((n) => names.includes(n))
}

// Загрузка договорных расценок из Larix.CPM (src/lib/larixSync.js). Выключена, пока не задано LARIX_SYNC=1:
// на прежнем сервере тот же код, и вторая загрузка в ту же базу не нужна. Включена, но настроена с
// ошибкой — служба не запускается (выкладка откатится), а не молчит без загрузки.
export function parseLarix(env, { dbUrl, supabaseUrl, supabaseServiceKey }) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  const larix = {
    sync: env.LARIX_SYNC === '1',
    baseUrl: env.LARIX_BASE_URL || LARIX_DEFAULT_URL,
    username: env.LARIX_USERNAME || '',
    password: env.LARIX_PASSWORD || '',
    appCode: env.LARIX_APP_CODE || 'cpm',
    targets: list(env.LARIX_SYNC_TARGETS || 'db'),
    maxBytes: Number(env.LARIX_MAX_BYTES) || LARIX_DEFAULTS.maxBytes,
  }
  if (!larix.sync) return larix
  if (!larix.username || !larix.password) throw new Error('LARIX_SYNC=1: нужны LARIX_USERNAME и LARIX_PASSWORD')
  larixBaseUrl(larix.baseUrl)
  const unknown = larix.targets.filter((t) => !LARIX_TARGETS.includes(t))
  if (!larix.targets.length || unknown.length) {
    throw new Error(`LARIX_SYNC_TARGETS: допустимы ${LARIX_TARGETS.join(', ')} через запятую${unknown.length ? ` (неизвестно: ${unknown.join(', ')})` : ''}`)
  }
  if (larix.targets.includes('db') && !dbUrl) throw new Error('LARIX_SYNC_TARGETS=db: нужен OSP_DB_URL')
  if (larix.targets.includes('supabase') && !(supabaseUrl && supabaseServiceKey)) {
    throw new Error('LARIX_SYNC_TARGETS=supabase: нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY')
  }
  return larix
}

export function loadConfig(env = process.env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 8787,
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    // Секрет подписи токенов Supabase Auth. Задан — вход проверяется на сервере (src/lib/token.js),
    // без запроса к Supabase на каждое обращение; пусто — как раньше, запросом к Supabase.
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '',
    s3: {
      endpoint: env.S3_ENDPOINT || '',
      region: env.S3_REGION || 'ru-central-1',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    ratesApiKeys: list(env.RATES_API_KEYS),
    // Своё подключение к базе (src/lib/db.js). Пока маршруты данных не включены, может быть пустым.
    db: {
      url: env.OSP_DB_URL || '',
      caFile: env.OSP_DB_CA_FILE || '',
      poolMax: Number(env.OSP_DB_POOL_MAX) || 5,
      // Пока база в Supabase — authenticated (правила по строкам вторым замком); в базе Яндекса — пусто.
      secondLockRole: env.OSP_DB_SECOND_LOCK_ROLE || '',
    },
    // Шлюз данных /api/db → PostgREST на этом сервере (src/routes/dbGateway.js). Пусто — шлюза нет,
    // маршруты файлов, ИИ и расценок читают данные из Supabase, как раньше.
    dbGateway: {
      upstream: env.OSP_PGRST_URL || '',
      secret: env.OSP_PGRST_JWT_SECRET || '',
      dbRole: env.OSP_PGRST_DB_ROLE || '',
      // Файл-переключатель барьера записи: есть файл — шлюз только читает.
      readOnlyFile: env.OSP_DB_READONLY_FILE || '',
    },
    // Файлы, загруженные до переноса, хранилище cloud.ru общее с прежним порталом (osp.root.sx, Supabase):
    // удаление документа в новом портале убирает строку, а файл оставляет — на него ссылается прежний.
    // '0' — когда прежний портал выключен и его ссылки больше не нужны.
    keepPreTransferFiles: env.OSP_KEEP_PRE_TRANSFER_FILES !== '0',
    // Пересчёт реестра расценок раз в 10 минут (в Supabase это делало расписание pg_cron).
    registryRefresh: env.OSP_REGISTRY_REFRESH === '1',
    larix: parseLarix(env, { dbUrl: env.OSP_DB_URL || '', supabaseUrl: env.SUPABASE_URL || '', supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '' }),
    required: parseRequired(env.OSP_API_REQUIRE),
  }
}

export function configuredParts(config) {
  const s3 = config.s3
  return {
    supabase: Boolean(config.supabaseUrl && config.supabaseAnonKey),
    supabaseService: Boolean(config.supabaseUrl && config.supabaseServiceKey),
    s3: Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey),
    anthropic: Boolean(config.anthropicApiKey),
    rates: config.ratesApiKeys.length > 0,
    db: Boolean(config.db?.url),
    token: Boolean(config.supabaseJwtSecret),
    gateway: Boolean(config.dbGateway?.upstream && config.dbGateway?.secret && config.dbGateway?.dbRole),
    larix: Boolean(config.larix?.sync && config.larix.username && config.larix.password),
  }
}
