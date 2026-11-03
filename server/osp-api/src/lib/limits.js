// Ограничения частоты и параллельности — в памяти процесса: служба одна (deploy/osp-api.service).
// Окно фиксированное, по ключу (пользователь, ключ API или «all»).
export function createRateLimit({ max, windowMs, now = Date.now }) {
  const hits = new Map()
  const prune = (t) => {
    if (hits.size < 10000) return
    for (const [k, e] of hits) if (t - e.start >= windowMs) hits.delete(k)
  }
  return {
    take(key) {
      const t = now()
      const e = hits.get(key)
      if (!e || t - e.start >= windowMs) {
        hits.set(key, { start: t, n: 1 })
        prune(t)
        return true
      }
      if (e.n >= max) return false
      e.n += 1
      return true
    },
  }
}

// acquire(key) → функция освобождения или null, если по ключу уже max одновременных запросов.
export function createConcurrency(max) {
  const active = new Map()
  return {
    acquire(key) {
      const n = active.get(key) || 0
      if (n >= max) return null
      active.set(key, n + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const m = (active.get(key) || 1) - 1
        if (m <= 0) active.delete(key)
        else active.set(key, m)
      }
    },
  }
}

export const DEFAULT_LIMITS = {
  // Свой вход: попытки входа с одного адреса клиента (в офисе за одним адресом много людей — лимит мягкий;
  // перебор одной учётки останавливает счётчик по почте в базе); действия администратора с учётками.
  loginPerIp: { max: 60, windowMs: 10 * 60_000 },
  authAdminPerUser: { max: 30, windowMs: 60_000 },
  authPasswordPerUser: { max: 10, windowMs: 10 * 60_000 },
  // Регистрация подрядчика (src/routes/signup.js). С одного адреса — мало: заявку подают разово. Общий предел — до расчёта
  // отпечатка пароля: поток заявок не занимает процессор, на котором работает вход сотрудников.
  signupPerIp: { max: 10, windowMs: 60 * 60_000 },
  signupTotal: { max: 60, windowMs: 10 * 60_000 },
  signupChallengePerIp: { max: 30, windowMs: 10 * 60_000 },
  signupTokenPerIp: { max: 30, windowMs: 10 * 60_000 },
  // Шлюз для учётки с регистрации: кабинету хватает с запасом, сохранение цен — порциями раз в 0,6 с.
  dbSelfRegisteredPerUser: { max: 600, windowMs: 60_000 },
  // Одновременно у шлюза: без входа — по адресу, учётке с регистрации — по пользователю; и всего у тех и других. Ответ держится в
  // памяти целиком, а запрос занимает подключение к базе: сотрудникам должно хватать, что бы ни делали остальные.
  dbRestrictedConcurrentPerKey: 8,
  dbRestrictedConcurrentTotal: 30,
  // Шлюз данных без входа: публичной странице хватает пары запросов на просмотр.
  dbAnonPerIp: { max: 300, windowMs: 60_000 },
  aiPerUser: { max: 6, windowMs: 60_000 }, // платный ИИ: 6 запросов в минуту на пользователя
  aiConcurrentPerUser: 1,
  aiConcurrentTotal: 4,
  presignPerUser: { max: 300, windowMs: 60_000 },
  ratesPerKey: { max: 60, windowMs: 60_000 }, // тяжёлый реестр
  ratesConcurrentPerKey: 2,
}
