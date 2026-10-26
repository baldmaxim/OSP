// Единственный путь osp-api к базе: каждая операция — одна транзакция через эту обёртку.
//
//   const db = createDb({ url, caFile, max, … })
//   await db.read(who, async (tx) => (await tx.query('select … where id = $1', [id])).rows)
//   await db.write(who, async (tx) => { await tx.query('insert …', […]) })
//
// Что гарантирует обёртка (tests/osp-api/db.test.mjs):
//   • read — транзакция READ ONLY: читающая операция не может изменить данные, даже по ошибке в коде;
//   • «кто вошёл», таймауты и часовой пояс (UTC) действуют только до конца транзакции и не переходят
//     к следующему запросу на том же подключении пула; пояс задаётся заново каждый раз, потому что
//     пулер может выдать подключение с настройками прежнего сеанса;
//   • любая ошибка — ROLLBACK; ошибка «не мастер», обрыв связи или неудавшийся ROLLBACK —
//     подключение уничтожается и в пул не возвращается;
//   • первая ошибка «не мастер» или реплика на новом подключении выводит из работы все соединения,
//     открытые раньше: их закрывают при выдаче и при возврате, запросы уже в работе не обрываются;
//   • база не ответила дольше срока команды — сокет закрывается и слот пула освобождается
//     (серверный statement_timeout до мёртвого сокета не доходит); проверка нового соединения
//     ограничена тем же способом, сроком подключения, и в работу не берётся, пока висит;
//   • обрыв связи без кода SQLSTATE (текст драйвера) — тот же ответ «недоступна», что и код 08;
//   • соединение живёт не дольше maxLifetimeSeconds, даже если простой так и не наступил.
//   • запрос — одна параметризованная команда: несколько команд в одной строке сервер не примет;
//   • подключений не больше max: учётка базы общая с другими системами, у неё общий лимит;
//   • сертификат и имя сервера базы проверяются всегда, кроме базы на этой же машине: строка
//     подключения проверку не ослабляет (dbConnection, tests/osp-api/db-tls.test.mjs).
//
// who — { userId, email } из проверенного сервером входа либо null (служебная операция без пользователя).
// В базу уходит минимальный контекст, собранный здесь, а не содержимое исходного токена: функции базы
// читают его как auth.uid() / auth.role() / auth.email().
//
// secondLockRole (пока база в Supabase — authenticated): транзакция пользователя выполняется под этой
// ролью, и правила по строкам действуют вторым замком. В базе Яндекса роли приложения нет — пусто.
import fs from 'node:fs'
import pg from 'pg'

const IDENT = /^[a-z_][a-z0-9_]*$/
const APP_NAME = 'osp-api'
// Отметка служебной операции. В базе с правами под одну учётку (migration/target/sql/load-single-owner.sql)
// правила по строкам действуют и на владельца; служебная операция сервера (без пользователя) проходит
// по этой отметке — как раньше проходила просто потому, что учётка владела таблицами. У операции
// пользователя отметка всегда снята явно: имя подключения ставится заново в каждой транзакции.
const INTERNAL_MARK = 'osp:internal'
const MARKS = { internal: INTERNAL_MARK, auth: 'osp:auth', user: APP_NAME }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DB_DEFAULTS = {
  max: 5,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 10_000,
  connectionTimeoutMs: 5_000,
  idlePoolTimeoutMs: 30_000,
  // Запас после statement_timeout: живой сервер успевает прислать отмену, мёртвый сокет — нет.
  queryWatchdogSlackMs: 5_000,
  // Верхняя граница жизни соединения: опрос сессии не даёт наступлению простоя, а после смены
  // мастера старый сокет иначе так и остаётся на реплике.
  maxLifetimeSeconds: 300,
}

export const DB_UNAVAILABLE = 'OSP_UNAVAILABLE'
export const DB_UNAVAILABLE_TEXT = 'Сервис временно недоступен, повторите через минуту'
const WATCHDOG_CODE = 'OSP_DB_WATCHDOG'
const CONNECT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
])
// node-postgres 8.23 / pg-pool 3.14 бросают эти тексты без SQLSTATE. «Connection terminated»
// короче двух соседних, поэтому сравнивается целиком, остальные — с него и начинаются.
const CONNECT_MESSAGES = [
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
]

function messageIsConnect(err) {
  const message = String(err?.message || '')
  if (message === 'Connection terminated') return true
  return CONNECT_MESSAGES.some((text) => message === text || message.startsWith(`${text} `) || message.startsWith(`${text}:`))
}

// База недоступна или это не мастер: такое соединение в пул не возвращается.
// 25006 — запись на реплике; 57P01–57P03 — сервер закрывается; 08* и коды сокета — обрыв сеанса.
// Обычная ошибка запроса (23505, 57014) сюда не входит: у неё есть свой код, текста связи нет.
export function dbUnavailable(err) {
  if (!err || typeof err !== 'object') return false
  const code = String(err.code || '')
  if (code === DB_UNAVAILABLE || code === WATCHDOG_CODE) return true
  if (code === '25006' || code === '57P01' || code === '57P02' || code === '57P03') return true
  if (code.startsWith('08')) return true
  if (CONNECT_CODES.has(code)) return true
  if (!code && messageIsConnect(err)) return true
  return false
}

function failureCode(err) {
  const code = String(err?.code || err?.cause?.code || '')
  if (code) return code
  if (messageIsConnect(err) || messageIsConnect(err?.cause)) return 'CONNECT'
  return ''
}

function dbNotMaster(err) {
  return err?.code === '25006'
}

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

// Параметры подключения из строки (OSP_DB_URL) и файла корневого сертификата (OSP_DB_CA_FILE).
// Правило одно: к базе не на этой машине — только с проверкой сертификата и имени сервера (verify-full).
// Параметры строки подключения, кроме sslmode=verify-full, не принимаются: драйвер молча отдаёт им
// приоритет над настройками кода, и «sslmode=require» в адресе выключил бы проверку.
// В текстах ошибок нет ни адреса, ни учётки, ни пароля.
export function dbConnection({ url, caFile = '' }, readFile = fs.readFileSync) {
  let u
  try { u = new URL(String(url)) } catch { throw new Error('osp-api: строка подключения к базе не разобрана') }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('osp-api: строка подключения к базе — postgres://…')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  let user, password, database
  try {
    user = decodeURIComponent(u.username)
    password = decodeURIComponent(u.password)
    database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  } catch { throw new Error('osp-api: строка подключения к базе не разобрана') }
  if (!host || !user || !database || database.includes('/')) throw new Error('osp-api: в строке подключения нужны адрес, учётка и имя базы')
  // Имя параметра в ошибку не идёт: при неэкранированном «?» в пароле параметром стал бы его остаток.
  for (const name of u.searchParams.keys()) {
    if (name !== 'sslmode') throw new Error('osp-api: в строке подключения к базе допустим только параметр sslmode=verify-full')
  }
  const mode = u.searchParams.get('sslmode')
  if (mode !== null && mode !== 'verify-full') throw new Error('osp-api: sslmode в строке подключения — только verify-full')

  let ssl = false
  if (caFile) ssl = { ca: readFile(caFile, 'utf8'), rejectUnauthorized: true }
  else if (mode === 'verify-full' || !LOCAL_HOSTS.has(host)) {
    throw new Error('osp-api: подключение к базе без проверки сертификата запрещено — задайте OSP_DB_CA_FILE')
  }
  return { host, port: Number(u.port) || 5432, user, password, database, ssl }
}

export function createDb(options) {
  const o = { ...DB_DEFAULTS, ...options }
  if (!o.url) throw new Error('osp-api: не задана строка подключения к базе')
  const connection = dbConnection({ url: o.url, caFile: o.caFile }, o.readFile)
  if (o.secondLockRole && !IDENT.test(o.secondLockRole)) throw new Error('osp-api: недопустимое имя роли второго замка')
  const log = o.logger || { warn() {}, error() {} }

  const pool = new pg.Pool({
    ...connection,
    max: o.max,
    connectionTimeoutMillis: o.connectionTimeoutMs,
    idleTimeoutMillis: o.idlePoolTimeoutMs,
    maxLifetimeSeconds: o.maxLifetimeSeconds,
    application_name: APP_NAME,
  })
  // Обрыв простаивающего подключения — не повод ронять службу: пул откроет новое.
  pool.on('error', (err) => log.warn({ code: String(err?.code || '') }, 'db pool'))

  // Поколение пула. После «не мастер» или реплики на проверке старые соединения закрываются
  // при выдаче и при возврате. Пул целиком не пересоздаётся: запрос, который уже идёт, дорабатывает.
  let generation = 0
  let lastRecovery = null
  const retire = () => { generation += 1 }
  const stale = (client) => Number.isInteger(client._ospGen) && client._ospGen !== generation
  const drop = (client, err) => {
    try { client.release(err) } catch { /* уже отдано */ }
  }

  // Одна команда, только с параметрами. queryMode 'extended' — расширенный протокол и при пустом
  // списке параметров: строку из нескольких команд сервер отклоняет. Имени у запроса нет — именованных
  // подготовленных запросов не остаётся (пулер в режиме транзакций их не переносит).
  const run = (client, text, values = []) => {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('osp-api: текст запроса — непустая строка')
    if (!Array.isArray(values)) throw new TypeError('osp-api: параметры запроса — массив')
    return client.query({ text, values, queryMode: 'extended' })
  }

  function watchdogBudget(opts) {
    const explicit = Number(opts.queryWatchdogMs ?? o.queryWatchdogMs)
    if (Number.isFinite(explicit) && explicit > 0) return explicit
    const statement = Number(opts.statementTimeoutMs ?? o.statementTimeoutMs)
    return statement + o.queryWatchdogSlackMs
  }

  // Драйвер по своему таймауту чтения отклоняет запрос, но уже отправленную команду с сокета не снимает:
  // следующий ROLLBACK ждёт ответ, которого не будет, и слот пула не возвращается. Закрытие сокета
  // снимает ожидание и помечает подключение сломанным.
  function abandon(client, err) {
    const stream = client.connection?.stream
    if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
    return err
  }

  async function inRecovery(client) {
    if (typeof o.recoveryProbe === 'function') return Boolean(await o.recoveryProbe(client))
    const res = await client.query('select pg_is_in_recovery() as r')
    return res.rows[0]?.r === true
  }

  // Пулер принимает сокет сразу и может не ответить на проверку. Срок — тот же, что у подключения:
  // сокет закрывается, слот освобождается, попытка считается неудачной.
  function probeRecovery(client) {
    const budget = Number(o.connectionTimeoutMs) > 0 ? Number(o.connectionTimeoutMs) : DB_DEFAULTS.connectionTimeoutMs
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('osp-api: база не ответила, подключение закрыто')
        err.code = WATCHDOG_CODE
        abandon(client, err)
        reject(err)
      }, budget)
      timer.unref?.()
    })
    const work = inRecovery(client)
    work.catch(() => {})
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  function unavailable() {
    const err = new Error(DB_UNAVAILABLE_TEXT)
    err.code = DB_UNAVAILABLE
    err.statusCode = 503
    return err
  }

  // Новое соединение один раз проверяется: реплика в работу не берётся (две попытки, затем 503).
  // Соединение прошлого поколения закрывается и не считается попыткой.
  async function acquire() {
    let probes = 0
    for (let n = 0; n < o.max + 3; n++) {
      let client
      try {
        client = await pool.connect()
      } catch (err) {
        log.warn({ code: failureCode(err) }, 'db acquire failed')
        if (dbUnavailable(err) || dbUnavailable(err?.cause)) throw unavailable()
        throw err
      }
      if (stale(client)) {
        drop(client, Object.assign(new Error('osp-api: соединение прошлого поколения'), { code: 'OSP_DB_STALE' }))
        continue
      }
      if (client._ospRecoveryChecked) return client
      probes += 1
      let recovering = false
      try {
        recovering = await probeRecovery(client)
      } catch (err) {
        drop(client, err)
        if (dbNotMaster(err)) retire()
        log.warn({ code: failureCode(err) }, 'db acquire failed')
        if (!dbUnavailable(err) && !dbUnavailable(err?.cause)) throw err
        if (probes >= 2) throw unavailable()
        continue
      }
      lastRecovery = recovering
      if (recovering) {
        retire()
        drop(client, Object.assign(new Error('osp-api: база в восстановлении'), { code: '25006' }))
        if (probes >= 2) throw unavailable()
        continue
      }
      client._ospRecoveryChecked = true
      client._ospGen = generation
      return client
    }
    throw unavailable()
  }

  async function transaction(mode, who, fn, opts = {}) {
    if (who != null && !UUID.test(String(who.userId || ''))) throw new TypeError('osp-api: у вошедшего нет идентификатора')
    const client = await acquire()
    let broken = null
    let finished = false
    let watchdogHit = null
    // Сервер оборвал подключение посреди операции: без обработчика событие «error» у занятого
    // подключения стало бы необработанной ошибкой и остановило службу. Такое подключение в пул не вернётся.
    const onConnectionError = (err) => { broken = broken || err }
    client.on('error', onConnectionError)
    const budget = watchdogBudget(opts)
    const watchdog = setTimeout(() => {
      if (finished) return
      const err = new Error('osp-api: база не ответила, подключение закрыто')
      err.code = WATCHDOG_CODE
      watchdogHit = err
      broken = abandon(client, err)
      log.warn({ code: WATCHDOG_CODE }, 'db query watchdog')
    }, budget)
    watchdog.unref?.()
    try {
      await client.query(mode === 'read' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
      // Всё — только на эту транзакцию (третий аргумент set_config = true).
      const claims = who ? JSON.stringify({ sub: who.userId, role: 'authenticated', email: who.email || '' }) : ''
      await run(client, `select
          set_config('statement_timeout', $1, true),
          set_config('lock_timeout', $2, true),
          set_config('idle_in_transaction_session_timeout', $3, true),
          set_config('request.jwt.claims', $4, true),
          set_config('request.jwt.claim.sub', '', true),
          set_config('request.jwt.claim.role', '', true),
          set_config('request.jwt.claim.email', '', true),
          set_config('TimeZone', 'UTC', true),
          set_config('application_name', $5, true)`,
        [String(opts.statementTimeoutMs ?? o.statementTimeoutMs), String(o.lockTimeoutMs), String(o.idleInTransactionTimeoutMs), claims,
          who ? APP_NAME : INTERNAL_MARK])
      // Второй замок — только у операций пользователя: служебные идут под учёткой подключения.
      if (who && o.secondLockRole) await run(client, "select set_config('role', $1, true)", [o.secondLockRole])

      // Отметка для следующей группы команд той же транзакции (до конца транзакции или до следующей отметки):
      //   'internal' — пропуск служебных функций (auth.users, user_roles, osp_session);
      //   'auth'     — пароли своего входа (osp_auth): пропуск служебных функций их НЕ открывает, а эта отметка
      //                не открывает ничего, кроме osp_auth. Ставит только модуль входа — проверяет тест;
      //   'user'     — снова от имени вошедшего (функции базы сами проверяют его права).
      const mark = (kind) => {
        const name = MARKS[kind]
        if (!name) throw new TypeError(`osp-api: неизвестная отметка транзакции: ${kind}`)
        if (kind === 'user' && !who) throw new TypeError('osp-api: отметка «от имени вошедшего» без вошедшего')
        return run(client, "select set_config('application_name', $1, true)", [name])
      }
      const result = await fn({ query: (text, values) => run(client, text, values), mark })
      await client.query('COMMIT')
      return result
    } catch (err) {
      const failure = watchdogHit || err
      if (dbNotMaster(err) || dbNotMaster(failure)) retire()
      if (dbUnavailable(failure) || dbUnavailable(err)) broken = broken || failure
      if (!watchdogHit) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          // Состояние подключения неизвестно: в пул оно не вернётся.
          broken = rollbackError
          if (dbNotMaster(rollbackError)) retire()
          log.warn({ code: String(rollbackError?.code || '') }, 'db rollback failed, connection dropped')
        }
      }
      if (dbUnavailable(failure) || dbUnavailable(err)) broken = broken || failure
      throw failure
    } finally {
      finished = true
      clearTimeout(watchdog)
      client.removeListener('error', onConnectionError)
      if (stale(client)) broken = broken || Object.assign(new Error('osp-api: соединение прошлого поколения'), { code: 'OSP_DB_STALE' })
      client.release(broken || undefined)
    }
  }

  return {
    read: (who, fn, opts) => transaction('read', who, fn, opts),
    write: (who, fn, opts) => transaction('write', who, fn, opts),
    recovery: () => lastRecovery,
    stats: () => ({ max: o.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  }
}
