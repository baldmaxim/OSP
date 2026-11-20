// Отправка файла в хранилище по подписанной ссылке (PUT) — с ходом отправки и сторожем (19.11.2026: пользователь сообщил, что
// загрузка в «Должную осмотрительность» «зависла на первом документе»). fetch не сообщает, сколько отправлено, и не
// заканчивается, если соединение встало; здесь — XMLHttpRequest:
//   • onProgress(loaded, total) — по мере отправки (на кнопке «Файл 1 из 3 · 45 %»);
//   • нет движения stallMs (по умолчанию 60 с) — запрос обрывается ошибкой с network: true: загрузка повторяет её с новой
//     ссылкой, а после попыток — пишет «Хранилище не отвечает», а не висит. Файл отправлен целиком, а ответа нет (прокси
//     бывает, что сначала принимает весь файл, а в хранилище передаёт потом) — ждём дольше: не меньше stallMs и по
//     секунде на каждые 256 КБ файла (100 МБ — около 7 минут), чтобы медленная, но идущая загрузка не обрывалась;
//   • ответ — как у fetch, в нужном загрузке объёме: { ok, status, statusText }.
// Модуль чистый: XMLHttpRequest и таймеры передаются (tests/osp-api/client.test.mjs — без браузера).

export const STALL_MS = 60 * 1000
const SENT_BYTES_PER_SEC = 256 * 1024

// Сколько ждать ответа после того, как файл отправлен целиком.
export const afterSentMs = (size, stallMs = STALL_MS) => Math.max(stallMs, Math.ceil((Number(size) || 0) / SENT_BYTES_PER_SEC) * 1000)

export class StorageStalledError extends Error {
  constructor(seconds) {
    super(`Хранилище не отвечает: отправка стоит больше ${seconds} с`)
    this.name = 'StorageStalledError'
    this.network = true
  }
}

export function createStoragePut({
  XHR = globalThis.XMLHttpRequest,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  return function putToStorage(url, { body, contentType, onProgress = null, stallMs = STALL_MS } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XHR()
      let timer = null
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer != null) clearTimer(timer)
        fn(value)
      }
      const size = Number(body?.size) || 0
      const watch = (sent = false) => {
        if (timer != null) clearTimer(timer)
        const ms = sent ? afterSentMs(size, stallMs) : stallMs
        timer = setTimer(() => {
          finish(reject, new StorageStalledError(Math.round(ms / 1000)))
          try { xhr.abort() } catch { /* уже закрыт */ }
        }, ms)
      }

      xhr.open('PUT', url)
      if (contentType) xhr.setRequestHeader('Content-Type', contentType)
      xhr.upload.onprogress = (e) => {
        const total = e.lengthComputable ? e.total : size
        watch(total > 0 && e.loaded >= total)
        onProgress?.(e.loaded, total)
      }
      xhr.onload = () => finish(resolve, { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText })
      xhr.onerror = () => finish(reject, Object.assign(new Error('Хранилище недоступно: сбой сети'), { network: true }))
      xhr.onabort = () => finish(reject, Object.assign(new Error('Отправка прервана'), { network: true }))
      watch()
      onProgress?.(0, size)
      xhr.send(body)
    })
  }
}

export const putToStorage = createStoragePut()
