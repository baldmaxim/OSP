// Единственный путь osp-api к базе: каждая операция — одна транзакция через эту обёртку.
//
//   const db = createDb({ connectionString, max, … })
//   await db.read(who, async (tx) => (await tx.query('select … where id = $1', [id])).rows)
//   await db.write(who, async (tx) => { await tx.query('insert …', […]) })
//
// Что гарантирует обёртка (tests/osp-api/db.test.mjs):
//   • read — транзакция READ ONLY: читающая операция не может изменить данные, даже по ошибке в коде;
//   • «кто вошёл» и таймауты действуют только до конца транзакции и не переходят к следующему запросу
//     на том же подключении пула;
//   • любая ошибка — ROLLBACK; не удался ROLLBACK — подключение уничтожается, в пул не возвращается;
//   • запрос — одна параметризованная команда: несколько команд в одной строке сервер не примет;
//   • подключений не больше max: учётка базы общая с другими системами, у неё общий лимит.
//
// who — { userId, email } из проверенного сервером входа либо null (служебная операция без пользователя).
// В базу уходит минимальный контекст, собранный здесь, а не содержимое исходного токена: функции базы
// читают его как auth.uid() / auth.role() / auth.email().
//
// secondLockRole (пока база в Supabase — authenticated): транзакция пользователя выполняется под этой
// ролью, и правила по строкам действуют вторым замком. В базе Яндекса роли приложения нет — пусто.
import pg from 'pg'

const IDENT = /^[a-z_][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DB_DEFAULTS = {
  max: 5,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 10_000,
  connectionTimeoutMs: 5_000,
  idlePoolTimeoutMs: 30_000,
}

export function createDb(options) {
  const o = { ...DB_DEFAULTS, ...options }
  if (!o.connectionString) throw new Error('osp-api: не задана строка подключения к базе')
  if (o.secondLockRole && !IDENT.test(o.secondLockRole)) throw new Error('osp-api: недопустимое имя роли второго замка')
  const log = o.logger || { warn() {}, error() {} }

  const pool = new pg.Pool({
    connectionString: o.connectionString,
    ssl: o.ssl,
    max: o.max,
    connectionTimeoutMillis: o.connectionTimeoutMs,
    idleTimeoutMillis: o.idlePoolTimeoutMs,
    application_name: 'osp-api',
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

  async function transaction(mode, who, fn) {
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
          set_config('request.jwt.claim.email', '', true)`,
        [String(o.statementTimeoutMs), String(o.lockTimeoutMs), String(o.idleInTransactionTimeoutMs), claims])
      // Второй замок — только у операций пользователя: служебные идут под учёткой подключения.
      if (who && o.secondLockRole) await run(client, "select set_config('role', $1, true)", [o.secondLockRole])

      const result = await fn({ query: (text, values) => run(client, text, values) })
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
    read: (who, fn) => transaction('read', who, fn),
    write: (who, fn) => transaction('write', who, fn),
    stats: () => ({ max: o.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  }
}
