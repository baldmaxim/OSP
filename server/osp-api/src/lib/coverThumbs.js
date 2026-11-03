// Миниатюры обложек объектов: GET /api/covers/<имя>/thumb (src/routes/covers.js).
//
// Карточка объекта шириной 300–600 px показывала оригинал (бывало 3 МБ), а каждая обложка шла переадресацией на
// новую подпись cloud.ru: браузеру нечего было запомнить, и каждое открытие «Объектов» скачивало всё заново.
// Теперь адрес постоянный, ответ кэшируется браузером: имя обложки — UUID, перезаписать её нельзя (409 при загрузке).
//
//   const thumbs = createCoverThumbs({ getS3, bucket, isReadOnly, log })
//   await thumbs.get(name)  // { status: 'ok', bytes } | { status: 'missing' } | { status: 'original', reason }
//
// Откуда берётся: память процесса → covers/thumbs/… в хранилище → делается из оригинала и кладётся туда (один раз
// на обложку). Не отказывает никогда: 'original' значит «покажите оригинал, как раньше», и маршрут отвечает
// подписанной ссылкой — запросов к хранилищу она не делает.
//
// Бережно к серверу: разбор — по одному и в отдельном процессе (coverThumbChild.js), оригинал в памяти один.
// Адрес открытый, поэтому ожидающих — не больше maxPending: сверх этого сразу 'original', без обращения к хранилищу.
// Файл, который не разобрался, не разбирается снова весь failureTtlMs — иначе каждое открытие страницы запускало бы
// процесс заново. Барьер записи (перенос) — миниатюра отдаётся, но в хранилище не кладётся.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { bytesOf, coverKey, coverThumbKey, isNotFound, COVER_THUMB_TYPE } from './covers.js'

export const COVER_THUMB_DEFAULTS = {
  // Загрузка принимает до 20 МБ (COVER_MAX_BYTES), прежние обложки — до 5 МБ.
  maxInputBytes: 25 * 1024 * 1024,
  renderTimeoutMs: 30_000,
  renderHeapMb: 128,
  storageTimeoutMs: 20_000,
  maxPending: 64,
  // Миниатюра — 30–90 КБ: в памяти помещаются все обложки портала, с запасом.
  memoryBytes: 16 * 1024 * 1024,
  failureTtlMs: 60 * 60_000,
}

const CHILD = fileURLToPath(new URL('./coverThumbChild.js', import.meta.url))
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)

// Срок на всю операцию, а не на заголовки: зависшее чтение тела иначе навсегда заняло бы очередь разбора.
function deadline(promise, ms, what) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: дольше ${ms} мс`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

// Один файл — один процесс. Ответ — { bytes } или { error, message }.
export function renderInChild(bytes, { timeoutMs = COVER_THUMB_DEFAULTS.renderTimeoutMs, heapMb = COVER_THUMB_DEFAULTS.renderHeapMb } = {}) {
  return new Promise((resolve) => {
    const child = fork(CHILD, [], {
      execArgv: [`--max-old-space-size=${heapMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let done = false
    let stderr = ''
    const finish = (out) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(out)
    }
    const timer = setTimeout(() => finish({ error: 'timeout', message: `дольше ${Math.round(timeoutMs / 1000)} с` }), timeoutMs)
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d })
    child.once('message', (out) => finish(out?.bytes ? { bytes: asBuffer(out.bytes) } : { error: out?.error || 'broken', message: out?.message || 'пустой ответ' }))
    child.once('error', (e) => finish({ error: 'process', message: String(e?.message || e).slice(0, 200) }))
    // Завершился, не ответив: SIGKILL не от нас — система сняла по памяти контейнера.
    child.once('exit', (code, signal) => finish(signal === 'SIGKILL' || /heap|out of memory/i.test(stderr)
      ? { error: 'memory', message: 'не хватило памяти' }
      : { error: 'process', message: `процесс завершился (${code ?? signal})` }))
    try {
      child.send({ bytes })
    } catch (e) {
      finish({ error: 'process', message: String(e?.message || e).slice(0, 200) })
    }
  })
}

export function createCoverThumbs({ getS3, bucket, isReadOnly = () => false, log = null, render = renderInChild, ...options }) {
  const o = { ...COVER_THUMB_DEFAULTS, ...options }
  const inflight = new Map()
  const failed = new Map()

  // Память: Map хранит порядок вставки, поэтому первая запись — давно не показанная.
  const memory = new Map()
  let memoryUsed = 0
  const recall = (name) => {
    const bytes = memory.get(name)
    if (bytes) { memory.delete(name); memory.set(name, bytes) }
    return bytes
  }
  const remember = (name, bytes) => {
    if (bytes.length > o.memoryBytes) return
    memory.set(name, bytes)
    memoryUsed += bytes.length
    for (const [key, value] of memory) {
      if (memoryUsed <= o.memoryBytes) break
      memory.delete(key)
      memoryUsed -= value.length
    }
  }

  // Разбор — строго по одному: оригинал и процесс разбора в памяти службы всегда один.
  let tail = Promise.resolve()
  const enqueue = (job) => {
    const run = tail.then(job)
    tail = run.then(() => {}, () => {})
    return run
  }

  const readObject = (key) => deadline((async () => {
    const res = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (res.ContentLength > o.maxInputBytes) {
      res.Body?.destroy?.()
      return { tooLarge: true }
    }
    return { bytes: await bytesOf(res.Body) }
  })(), o.storageTimeoutMs, 'чтение из хранилища')

  const readStored = async (name) => {
    try {
      return (await readObject(coverThumbKey(name))).bytes || null
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }

  const store = async (name, bytes) => {
    if (isReadOnly()) return
    try {
      await deadline(getS3().send(new PutObjectCommand({ Bucket: bucket, Key: coverThumbKey(name), Body: bytes, ContentType: COVER_THUMB_TYPE })),
        o.storageTimeoutMs, 'запись в хранилище')
    } catch (e) {
      log?.warn({ msg: e?.message }, 'cover thumb store')
    }
  }

  const refuse = (name, reason, message) => {
    failed.set(name, Date.now() + o.failureTtlMs)
    log?.warn({ name, reason, msg: message }, 'cover thumb')
    return { status: 'original', reason }
  }

  const make = async (name) => {
    let original
    try {
      original = await readObject(coverKey(name))
    } catch (e) {
      if (isNotFound(e)) return { status: 'missing' }
      throw e
    }
    if (original.tooLarge) return refuse(name, 'too_large')
    const out = await render(original.bytes, { timeoutMs: o.renderTimeoutMs, heapMb: o.renderHeapMb })
    if (!out.bytes) return refuse(name, out.error, out.message)
    await store(name, out.bytes)
    remember(name, out.bytes)
    return { status: 'ok', bytes: out.bytes }
  }

  const load = async (name) => {
    const stored = await readStored(name)
    if (stored) {
      remember(name, stored)
      return { status: 'ok', bytes: stored }
    }
    return enqueue(() => make(name))
  }

  return {
    get(name) {
      const bytes = recall(name)
      if (bytes) return Promise.resolve({ status: 'ok', bytes })
      if (failed.get(name) > Date.now()) return Promise.resolve({ status: 'original', reason: 'failed_before' })
      failed.delete(name)
      if (inflight.has(name)) return inflight.get(name)
      if (inflight.size >= o.maxPending) return Promise.resolve({ status: 'original', reason: 'busy' })
      // Сбой связи с хранилищем запоминать незачем: следующий показ попробует снова.
      const job = load(name)
        .catch((e) => {
          log?.warn({ name, msg: e?.message }, 'cover thumb storage')
          return { status: 'original', reason: 'storage' }
        })
        .finally(() => inflight.delete(name))
      inflight.set(name, job)
      return job
    },
  }
}
