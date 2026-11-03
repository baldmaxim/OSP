// Задача на вычисление перед регистрацией и восстановлением пароля: самый дорогой шаг этих маршрутов — расчёт отпечатка
// пароля (scrypt), а у службы 0,45 процессора и он общий со входом сотрудников. Бот без JavaScript не пройдёт вовсе, а
// с ним каждая попытка стоит ему вычислений. Это не капча и от целевого перебора не спасает: число попыток держат лимиты
// (src/lib/limits.js, счётчики заявок в базе), а настоящую проверку человека — письмо на его адрес.
//
// Задача подписана ключом процесса: перезапуск службы отменяет выданные, страница просто возьмёт новую. Ни сторонних
// скриптов, ни отправки данных посетителя за пределы портала. Решённая задача действует один раз.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const POW_DEFAULTS = { bits: 18, ttlMs: 10 * 60_000, maxRemembered: 50_000 }
const CHALLENGE = /^[A-Za-z0-9_-]{16}\.\d{10,16}\.\d{1,2}\.[A-Za-z0-9_-]{43}$/
const ANSWER = /^\d{1,12}$/

export function leadingZeroBits(buffer) {
  let bits = 0
  for (const byte of buffer) {
    if (byte === 0) { bits += 8; continue }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

export function createProofOfWork({ secret = randomBytes(32), bits = POW_DEFAULTS.bits, ttlMs = POW_DEFAULTS.ttlMs,
  maxRemembered = POW_DEFAULTS.maxRemembered, now = Date.now } = {}) {
  const used = new Map() // решённые задачи → срок; порядок — по времени решения
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url')

  function prune(t) {
    for (const [k, exp] of used) {
      if (exp > t && used.size <= maxRemembered) break
      used.delete(k)
    }
  }

  return {
    issue() {
      const payload = `${randomBytes(12).toString('base64url')}.${now() + ttlMs}.${bits}`
      return { challenge: `${payload}.${sign(payload)}`, bits }
    },
    // Подпись, срок, сложность, решение, первый раз — иначе false.
    verify(challenge, answer) {
      const c = String(challenge ?? '')
      const a = String(answer ?? '')
      if (!CHALLENGE.test(c) || !ANSWER.test(a)) return false
      const at = c.lastIndexOf('.')
      const payload = c.slice(0, at)
      const given = Buffer.from(c.slice(at + 1))
      const right = Buffer.from(sign(payload))
      if (given.length !== right.length || !timingSafeEqual(given, right)) return false
      const [, exp, need] = payload.split('.')
      const t = now()
      if (Number(exp) <= t || used.has(c)) return false
      if (leadingZeroBits(createHash('sha256').update(`${c}:${a}`).digest()) < Number(need)) return false
      used.set(c, Number(exp))
      prune(t)
      return true
    },
  }
}
