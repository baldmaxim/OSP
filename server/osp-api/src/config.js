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
export const READY_OPTIONAL = ['db', 'token', 'gateway', 'auth']
// Свой вход (AUTH_MODE both | own | keycloak): без пароля-канарейки, базы и шлюза данных он не работает — эти проверки
// обязательны всегда. В режимах own и keycloak Supabase не нужен вовсе: из обязательных он убирается.
//   own      — учётки и пароли в базе Яндекса (вход «через Яндекс»);
//   keycloak — единый вход СУ-10 (auth.su10.ru, OIDC): пароли ведёт Keycloak, учётки и права — по-прежнему здесь.
// Переключение own ⇄ keycloak — строкой окружения и перезапуском (scripts/deploy-server.sh auth-mode).
export const AUTH_MODES = ['supabase', 'both', 'own', 'keycloak']
const OWN_AUTH_REQUIRED = ['auth', 'db', 'gateway']
// Режимы, где кто вошёл — только своя сессия (cookie), без Supabase.
export const isSessionMode = (mode) => mode === 'own' || mode === 'keycloak'

export function parseRequired(raw, authMode = 'supabase') {
  const names = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const known = [...READY_PARTS, ...READY_OPTIONAL]
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length) {
    throw new Error(`OSP_API_REQUIRE: неизвестные зависимости ${unknown.join(', ')} (допустимы ${known.join(', ')})`)
  }
  let chosen = names.length ? names : [...READY_PARTS]
  if (isSessionMode(authMode)) chosen = [...chosen.filter((n) => n !== 'supabase'), ...OWN_AUTH_REQUIRED]
  else if (!chosen.includes('supabase')) throw new Error('OSP_API_REQUIRE: supabase обязателен — без него не работает ни один маршрут')
  if (authMode === 'both') chosen = [...chosen, ...OWN_AUTH_REQUIRED]
  return known.filter((n) => chosen.includes(n))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Адрес портала для проверки источника запроса (Origin): https://…, для разработки — http://localhost:порт.
export function parseOrigin(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  let u
  try { u = new URL(v) } catch { throw new Error('OSP_PUBLIC_ORIGIN: не адрес') }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)
  if ((u.protocol !== 'https:' && !local) || u.pathname !== '/' || u.search || u.hash || u.username) {
    throw new Error('OSP_PUBLIC_ORIGIN: только адрес портала вида https://tender.su10.ru, без пути')
  }
  return u.origin
}

function parseAuthMode(raw) {
  const v = String(raw || 'supabase').trim()
  if (!AUTH_MODES.includes(v)) throw new Error(`AUTH_MODE: ${v} — допустимы ${AUTH_MODES.join(', ')}`)
  return v
}

function parsePilot(raw) {
  const ids = String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const bad = ids.filter((id) => !UUID.test(id))
  if (bad.length) throw new Error('OSP_AUTH_PILOT_IDS: только идентификаторы пользователей (uuid) через запятую')
  return ids
}

function parseDays(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 365) throw new Error(`${name}: число дней от 1 до 365`)
  return n
}

// Доверие к X-Forwarded-For: только 'peer' — непосредственному соседу (своему прокси). Верно лишь там, где до
// osp-api не достаёт никто, кроме него: на corp — внутренняя сеть проекта (osp-web), на VPS — 127.0.0.1. Прокси
// обязан перезаписывать X-Forwarded-For одним адресом клиента. Число хопов Fastify 5 не принимает.
function parseTrustProxy(raw) {
  const v = String(raw || '').trim()
  if (v === '' || v === 'peer') return v
  throw new Error('OSP_TRUST_PROXY: допустимо только peer (или пусто)')
}

// Замок между сайтом и API (сервер corp): osp-api в общей сети сервера, и без замка до него достал бы любой соседний
// контейнер. OSP_WEB_GATE=1 — без верного жетона X-OSP-Web (его ставит osp-web) ответ 403; изнутри контейнера (loopback,
// без X-Forwarded-For) — пропуск: проверка живости, deploy.sh auth-config, ready. Жетон — секрет (OSP_WEB_TOKEN).
export const WEB_TOKEN_RE = /^[A-Za-z0-9]{32,128}$/
export function parseWebGate(env) {
  const enabled = env.OSP_WEB_GATE === '1'
  const token = String(env.OSP_WEB_TOKEN || '')
  if (env.OSP_WEB_GATE && !['0', '1'].includes(env.OSP_WEB_GATE)) throw new Error('OSP_WEB_GATE: 1 или 0')
  if (enabled && !WEB_TOKEN_RE.test(token)) {
    throw new Error('OSP_WEB_GATE=1: OSP_WEB_TOKEN не задан или негоден (латиница и цифры, 32–128 знаков; scripts/deploy-server.sh web-token-init)')
  }
  return { enabled, token: enabled ? token : '' }
}

// Вход через Keycloak su10 (AUTH_MODE=keycloak). Значения проверяются всегда, когда заданы (переключение в own их не
// стирает — и обратно в keycloak они должны остаться годными); обязательны — только в режиме keycloak (checkOwnAuthConfig).
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback'
const SECONDS = (raw, fallback, min, max, name) => {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: целое число секунд от ${min} до ${max}`)
  return n
}
function httpsUrl(raw, name) {
  let u
  try { u = new URL(raw) } catch { throw new Error(`${name}: не адрес`) }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
    throw new Error(`${name}: только https://…, без логина, строки запроса и фрагмента`)
  }
  return u
}
export function parseOidc(env) {
  const str = (v) => String(v ?? '').trim()
  const oidc = {
    issuer: str(env.OIDC_ISSUER).replace(/\/+$/, ''),
    clientId: str(env.OIDC_CLIENT_ID),
    clientSecret: String(env.OIDC_CLIENT_SECRET || ''),
    redirectUri: str(env.OIDC_REDIRECT_URI),
    postLogoutRedirectUri: str(env.OIDC_POST_LOGOUT_REDIRECT_URI),
    scopes: str(env.OIDC_SCOPES) || 'openid email profile',
    linkByEmail: false,
    recheckSec: SECONDS(env.OIDC_RECHECK_SEC, 300, 60, 3600, 'OIDC_RECHECK_SEC'),
    activityWindowSec: SECONDS(env.OIDC_ACTIVITY_WINDOW_SEC, 1800, 300, 86400, 'OIDC_ACTIVITY_WINDOW_SEC'),
    maxOfflineSec: SECONDS(env.OIDC_MAX_OFFLINE_SEC, 3600, 0, 86400, 'OIDC_MAX_OFFLINE_SEC'),
    admin: null,
  }
  const link = str(env.OIDC_LINK_BY_EMAIL)
  if (!['', 'true', 'false'].includes(link)) throw new Error('OIDC_LINK_BY_EMAIL: true или false')
  oidc.linkByEmail = link === 'true'
  if (oidc.issuer) httpsUrl(oidc.issuer, 'OIDC_ISSUER')
  if (oidc.clientId && !/^[A-Za-z0-9._-]{1,100}$/.test(oidc.clientId)) throw new Error('OIDC_CLIENT_ID: латиница, цифры, «.», «_», «-»')
  if (!/^[A-Za-z0-9 _.:-]{6,200}$/.test(oidc.scopes) || !oidc.scopes.split(' ').includes('openid')) {
    throw new Error('OIDC_SCOPES: через пробел, с openid')
  }
  // Сверка группы — всё или ничего: половина настроек — ошибка, а не тихо выключенная сверка.
  const adminId = str(env.KC_ADMIN_CLIENT_ID)
  const adminSecret = String(env.KC_ADMIN_CLIENT_SECRET || '')
  if (Boolean(adminId) !== Boolean(adminSecret)) throw new Error('KC_ADMIN_CLIENT_ID и KC_ADMIN_CLIENT_SECRET: задайте оба или ни одного')
  if (adminId) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(adminId)) throw new Error('KC_ADMIN_CLIENT_ID: латиница, цифры, «.», «_», «-»')
    const group = str(env.KC_ACCESS_GROUP) || 'osp-access'
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(group)) throw new Error('KC_ACCESS_GROUP: латиница, цифры, «.», «_», «-»')
    oidc.admin = {
      clientId: adminId, clientSecret: adminSecret, group,
      syncIntervalSec: SECONDS(env.KC_ACCESS_SYNC_INTERVAL_SEC, 300, 60, 3600, 'KC_ACCESS_SYNC_INTERVAL_SEC'),
    }
  }
  return oidc
}

// Проверка настроек своего входа — до запуска: служба с неполными настройками не стартует.
export function checkOwnAuthConfig(config) {
  if (config.authMode === 'supabase' || !config.authMode) return
  const missing = []
  if (!config.auth?.keys) missing.push('OSP_AUTH_KEYS')
  if (!config.auth?.publicOrigin) missing.push('OSP_PUBLIC_ORIGIN')
  if (!config.db?.url) missing.push('OSP_DB_URL')
  if (!config.dbGateway?.upstream || !config.dbGateway?.secret || !config.dbGateway?.dbRole) missing.push('шлюз данных (OSP_PGRST_*)')
  if (config.authMode === 'keycloak') {
    const o = config.oidc || {}
    for (const [key, name] of [['issuer', 'OIDC_ISSUER'], ['clientId', 'OIDC_CLIENT_ID'], ['clientSecret', 'OIDC_CLIENT_SECRET'],
      ['redirectUri', 'OIDC_REDIRECT_URI'], ['postLogoutRedirectUri', 'OIDC_POST_LOGOUT_REDIRECT_URI']]) {
      if (!o[key]) missing.push(name)
    }
  }
  if (missing.length) throw new Error(`AUTH_MODE=${config.authMode}: не заданы ${missing.join(', ')}`)
  if (config.authMode === 'keycloak') checkOidcAddresses(config)
  if (config.authMode === 'both' && !(config.auth.pilotIds || []).length) {
    throw new Error('AUTH_MODE=both: свой вход — только пилоту, задайте OSP_AUTH_PILOT_IDS')
  }
}

// Адреса возврата из Keycloak — только сам портал: тот же источник, ровно свой путь, без строки запроса и фрагмента.
// Сравнение разобранных адресов, а не начала строки: «https://tender.su10.ru.evil/…» с началом совпало бы.
function checkOidcAddresses(config) {
  const origin = config.auth.publicOrigin
  if (!origin.startsWith('https://')) throw new Error('AUTH_MODE=keycloak: OSP_PUBLIC_ORIGIN — только https://')
  const redirect = httpsUrl(config.oidc.redirectUri, 'OIDC_REDIRECT_URI')
  if (redirect.origin !== origin || redirect.pathname !== OIDC_CALLBACK_PATH) {
    throw new Error(`OIDC_REDIRECT_URI: ровно ${origin}${OIDC_CALLBACK_PATH}`)
  }
  const after = httpsUrl(config.oidc.postLogoutRedirectUri, 'OIDC_POST_LOGOUT_REDIRECT_URI')
  if (after.origin !== origin) throw new Error(`OIDC_POST_LOGOUT_REDIRECT_URI: адрес портала ${origin}`)
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

// Включена, но без базы или хранилища — служба не запускается (выкладка откатится), а не молчит без загрузки.
export function parseSupplyImport(env) {
  if (env.OSP_SUPPLY_IMPORT !== '1') return false
  if (!env.OSP_DB_URL) throw new Error('OSP_SUPPLY_IMPORT=1: нужен OSP_DB_URL')
  if (!(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) {
    throw new Error('OSP_SUPPLY_IMPORT=1: нужно хранилище (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)')
  }
  return true
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
    // Миниатюры обложек — в память сразу после запуска службы (src/routes/covers.js): первый, кто откроет «Объекты» после
    // выкладки, не ждёт хранилища. '0' — выключить. Нужна своя база (OSP_DB_URL) и хранилище.
    coverWarm: env.OSP_COVER_WARM !== '0',
    // Позиции ВОР для расценки снабжением — заранее, на сервере, раз в 10 минут (src/lib/supplyImport.js): статус
    // «Расценка: N из M» в реестре тендеров на материалы — у всех тендеров, без открытия расценки.
    supplyImport: parseSupplyImport(env),
    larix: parseLarix(env, { dbUrl: env.OSP_DB_URL || '', supabaseUrl: env.SUPABASE_URL || '', supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '' }),
    // Вход: supabase — как раньше; both — пилот своего входа; own — только свой вход (src/lib/auth/); keycloak — единый вход СУ-10.
    authMode: parseAuthMode(env.AUTH_MODE),
    oidc: parseOidc(env),
    webGate: parseWebGate(env),
    auth: {
      // Ключи шифрования паролей «id:base64,…», первый — текущий (src/lib/auth/secretBox.js). Секрет.
      keys: env.OSP_AUTH_KEYS || '',
      pilotIds: parsePilot(env.OSP_AUTH_PILOT_IDS),
      publicOrigin: parseOrigin(env.OSP_PUBLIC_ORIGIN),
      idleDays: parseDays(env.OSP_SESSION_IDLE_DAYS, 14, 'OSP_SESSION_IDLE_DAYS'),
      absoluteDays: parseDays(env.OSP_SESSION_MAX_DAYS, 30, 'OSP_SESSION_MAX_DAYS'),
    },
    // Регистрация подрядчика на сайте (src/lib/auth/signup.js): откроется, только если AUTH_MODE=own и задан OSP_CONTRACTOR_SIGNUP=1.
    // OSP_CONTRACTOR_SIGNUP_MODE: manual (по умолчанию) — заявки решает администратор, почта не нужна; email — самостоятельно, по
    // письму: нужна почта. OSP_SMTP_URL — секрет: smtps://логин:пароль@сервер:465 (или smtp://…:587, STARTTLS обязателен).
    signup: {
      enabled: env.OSP_CONTRACTOR_SIGNUP === '1',
      mode: env.OSP_CONTRACTOR_SIGNUP_MODE === 'email' ? 'email' : 'manual',
      smtpUrl: env.OSP_SMTP_URL || '',
      mailFrom: env.OSP_MAIL_FROM || '',
      replyTo: env.OSP_MAIL_REPLY_TO || 'tender.osp@su10.ru',
      notifyEmail: env.OSP_SIGNUP_NOTIFY_EMAIL || '',
      dailyTotal: Number(env.OSP_SIGNUP_DAILY_CAP) || undefined,
    },
    trustProxy: parseTrustProxy(env.OSP_TRUST_PROXY),
    required: parseRequired(env.OSP_API_REQUIRE, parseAuthMode(env.AUTH_MODE)),
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
    auth: Boolean(config.auth?.keys && config.authMode && config.authMode !== 'supabase'),
    oidc: config.authMode === 'keycloak' && Boolean(config.oidc?.issuer),
    accessSync: config.authMode === 'keycloak' && Boolean(config.oidc?.admin),
    webGate: Boolean(config.webGate?.enabled),
  }
}
