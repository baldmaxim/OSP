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
//   • любая ошибка — ROLLBACK; не удался ROLLBACK — подключение уничтожается, в пул не возвращается;
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
    application_name: APP_NAME,
  })
  // Обрыв простаивающего подключения — не повод ронять службу: пул откроет новое.
  pool.on('error', (err) => log.warn({ msg: err?.message }, 'db pool'))

  // Одна команда, только с параметрами. queryMode 'extended' — расширенный протокол и при пустом
  // списке параметров: строку из нескольких команд сервер отклоняет. Имени у запроса нет — именованных
  // подготовленных запросов не остаётся (пулер в режиме транзакций их не переносит).
  const run = (client, text, values = []) => {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('osp-api: текст запроса — непустая строка')
    if (!Array.isArray(values)) throw new TypeError('osp-api: параметры запроса — массив')
    return client.query({ text, values, queryMode: 'extended' })
  }

  async function transaction(mode, who, fn, opts = {}) {
    if (who != null && !UUID.test(String(who.userId || ''))) throw new TypeError('osp-api: у вошедшего нет идентификатора')
    const client = await pool.connect()
    let broken = null
    // Сервер оборвал подключение посреди операции: без обработчика событие «error» у занятого
    // подключения стало бы необработанной ошибкой и остановило службу. Такое подключение в пул не вернётся.
    const onConnectionError = (err) => { broken = broken || err }
    client.on('error', onConnectionError)
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
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        // Состояние подключения неизвестно: в пул оно не вернётся.
        broken = rollbackError
        log.warn({ msg: rollbackError?.message }, 'db rollback failed, connection dropped')
      }
      throw err
    } finally {
      client.removeListener('error', onConnectionError)
      client.release(broken || undefined)
    }
  }

  return {
    read: (who, fn, opts) => transaction('read', who, fn, opts),
    write: (who, fn, opts) => transaction('write', who, fn, opts),
    stats: () => ({ max: o.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  }
}
