// Обложки объектов через свой API (данные в базе Яндекса, src/api/serverPath.js): ссылка на загрузку
// (cover-upload) → PUT в cloud.ru. Ответ — { data, error }, как у storage.upload supabase-js: страница
// объектов не меняется. Сбой сети и ответы 429 / 5xx при PUT повторяются (до 3 попыток, каждая — с новой
// ссылкой на то же имя); отказ по правам и «имя занято» — нет.
// Модуль чистый: вызов сервера и fetch передаются извне (tests/osp-api/client.test.mjs).
const PUT_ATTEMPTS = 3

async function serverError(error) {
  const ctx = error?.context
  if (ctx && typeof ctx.clone === 'function') {
    const body = await ctx.clone().json().catch(() => null)
    const err = new Error(body?.error || error.message)
    err.status = ctx.status
    if (body?.code) err.code = body.code
    return err
  }
  const err = new Error(error?.message || 'Сервер недоступен')
  err.network = true
  return err
}

export function createOspCovers({ call, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return {
    async upload(name, file) {
      let lastError = null
      for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt++) {
        const { data, error } = await call({ name, mime_type: file.type || 'application/octet-stream', size_bytes: file.size })
        if (error) {
          const err = await serverError(error)
          // Имя уже занято предыдущей попыткой этой же загрузки — файл на месте.
          if (attempt > 1 && err.code === 'OSP_COVER_EXISTS') return { data: { path: name }, error: null }
          if (!(err.network || err.status === 429 || err.status >= 500) || attempt === PUT_ATTEMPTS) return { data: null, error: err }
          lastError = err
        } else {
          let res = null
          try {
            res = await fetchImpl(data.presigned_url, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
          } catch (e) {
            lastError = new Error(`Хранилище недоступно: ${e?.message || e}`)
          }
          if (res?.ok) return { data: { path: name }, error: null }
          if (res && !(res.status === 429 || res.status >= 500)) return { data: null, error: new Error(`Хранилище отклонило файл (${res.status})`) }
          if (res) lastError = new Error(`Хранилище ответило ${res.status}`)
        }
        if (attempt < PUT_ATTEMPTS) await sleep(500 * attempt)
      }
      return { data: null, error: lastError }
    },
  }
}
