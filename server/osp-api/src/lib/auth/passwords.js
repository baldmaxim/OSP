// Отпечатки паролей.
//
// Свои — scrypt из node:crypto (без нативных зависимостей): N=2^15, r=8, p=3 — профиль OWASP Password Storage;
// соль 16 случайных байт, ключ 32 байта. Строка отпечатка самодостаточна:
//   $scrypt$ln=15,r=8,p=3$<соль base64>$<ключ base64>
// Параметры читаются из строки, поэтому ужесточение потом не ломает прежние отпечатки (они пересчитываются при
// входе). maxmem задаётся явно: со значением по умолчанию (32 МиБ) Node отказывает на этих параметрах.
// Прежние — bcrypt из Supabase ($2a$10$…), проверяются bcryptjs (чистый JS, асинхронно).
//
// Пароль своего отпечатка нормализуется в NFC (NIST SP 800-63B-4). Прежний bcrypt проверяется по паролю как
// введён: так его считал Supabase.
//
// Время ответа не выдаёт, что за учётка: каждая проверка считает и bcrypt, и scrypt — настоящий для своего
// отпечатка и холостой для другого; для несуществующей учётки — оба холостые.
//
// Расчёт дорогой (около 0,2 с и 32 МиБ на scrypt), поэтому их одновременно не больше 4, в очереди — не больше 32,
// ожидание — не дольше 5 с; сверх этого — отказ «повторите вход» (OSP_AUTH_BUSY), а не рост памяти.
import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'

export const SCRYPT_PARAMS = { ln: 15, r: 8, p: 3 }
const SALT_BYTES = 16
const KEY_BYTES = 32
const BCRYPT_COST = 10 // как у Supabase: холостой bcrypt должен считаться столько же, сколько настоящий
const SCRYPT_RE = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/
const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/

export const GATE_DEFAULTS = { concurrency: 4, maxQueue: 32, waitMs: 5000 }

// Память на один расчёт: 128·N·r байт; запас вдвое.
const maxmemFor = (ln, r) => 256 * (2 ** ln) * r

function scryptAsync(password, salt, keylen, { ln, r, p }) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N: 2 ** ln, r, p, maxmem: maxmemFor(ln, r) }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export const normalizePassword = (password) => String(password).normalize('NFC')

export function algoOf(stored) {
  const s = String(stored || '')
  if (SCRYPT_RE.test(s)) return 'scrypt'
  if (BCRYPT_RE.test(s)) return 'bcrypt'
  return null
}

export function parseScrypt(stored) {
  const m = SCRYPT_RE.exec(String(stored || ''))
  if (!m) return null
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const salt = Buffer.from(m[4], 'base64')
  const key = Buffer.from(m[5], 'base64')
  // Границы — чтобы строка из базы не заставила считать неделю или занять гигабайты.
  if (ln < 14 || ln > 17 || r < 8 || r > 16 || p < 1 || p > 8 || salt.length < 16 || key.length < 32) return null
  return { ln, r, p, salt, key }
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES)
  const key = await scryptAsync(normalizePassword(password), salt, KEY_BYTES, SCRYPT_PARAMS)
  const { ln, r, p } = SCRYPT_PARAMS
  return `$scrypt$ln=${ln},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

// Отпечаток слабее текущего (bcrypt или scrypt с меньшими параметрами) — пересчитать после успешного входа.
export function needsRehash(stored) {
  if (algoOf(stored) !== 'scrypt') return true
  const s = parseScrypt(stored)
  return !s || s.ln < SCRYPT_PARAMS.ln || s.r < SCRYPT_PARAMS.r || s.p < SCRYPT_PARAMS.p
}

async function scryptMatches(password, parsed) {
  const key = await scryptAsync(normalizePassword(password), parsed.salt, parsed.key.length, parsed)
  return timingSafeEqual(key, parsed.key)
}

// Очередь расчётов: run(fn) выполняет fn, когда освободится место; иначе — отказ OSP_AUTH_BUSY.
export function createHashGate({ concurrency = GATE_DEFAULTS.concurrency, maxQueue = GATE_DEFAULTS.maxQueue, waitMs = GATE_DEFAULTS.waitMs } = {}) {
  let active = 0
  const queue = []
  const busy = () => Object.assign(new Error('Сервер входа занят, повторите вход через несколько секунд'), { code: 'OSP_AUTH_BUSY' })
  const next = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift()
      clearTimeout(job.timer)
      active++
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; next() })
    }
  }
  return {
    run(fn) {
      if (queue.length >= maxQueue) return Promise.reject(busy())
      return new Promise((resolve, reject) => {
        const job = { fn, resolve, reject, timer: null }
        job.timer = setTimeout(() => {
          const i = queue.indexOf(job)
          if (i !== -1) { queue.splice(i, 1); reject(busy()) }
        }, waitMs)
        queue.push(job)
        next()
      })
    },
    stats: () => ({ active, queued: queue.length }),
  }
}

// Проверка пароля с одинаковым временем для любой учётки. stored — строка отпечатка или null (учётки нет,
// пароля нет, строка не расшифровалась). → { ok, algo }
export function createPasswordVerifier({ gate = createHashGate() } = {}) {
  let dummy = null
  const dummies = async () => {
    dummy ??= (async () => ({
      scrypt: parseScrypt(await hashPassword(randomBytes(24).toString('base64'))),
      bcrypt: await bcrypt.hash(randomBytes(24).toString('base64'), BCRYPT_COST),
    }))()
    return dummy
  }

  async function verify(password, stored) {
    const d = await dummies()
    const algo = algoOf(stored)
    const scryptTarget = algo === 'scrypt' ? parseScrypt(stored) : null
    const bcryptTarget = algo === 'bcrypt' ? String(stored) : null
    const input = String(password ?? '')
    return gate.run(async () => {
      const [s, b] = await Promise.all([
        scryptMatches(input, scryptTarget || d.scrypt),
        bcrypt.compare(input, bcryptTarget || d.bcrypt),
      ])
      if (scryptTarget) return { ok: s, algo }
      if (bcryptTarget) return { ok: b, algo }
      return { ok: false, algo: null }
    })
  }

  // Новый отпечаток — через ту же очередь: пересчёт при первом входе, смена и временный пароль не обходят
  // предел одновременных расчётов (в вечер переключения многие входят впервые одновременно).
  const hash = (password) => gate.run(() => hashPassword(password))

  return { verify, hash, warmUp: dummies }
}
