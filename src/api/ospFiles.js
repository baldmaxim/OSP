// Файлы документов через свой API (osp-api, флаг ospApiFilesV2) — с ключом операции. Ключ (UUIDv7)
// один на выбранный файл: повтор любого шага возвращает тот же документ, второй строки s3_documents и
// второго объекта в бакете не бывает (server/osp-api/src/routes/s3Presign.js).
//   загрузка — upload → PUT в хранилище (до 3 попыток, каждая с новой ссылкой на тот же ключ) →
//              confirm (до 3 попыток) → строка s3_documents;
//   удаление — delete: сервер удаляет сначала строку, затем объект; повтор безопасен (до 3 попыток).
// Модуль чистый: вызов сервера, fetch, хэш, ключ и паузы передаются извне (tests/osp-api/client.test.mjs).

const PUT_ATTEMPTS = 3
const CONFIRM_ATTEMPTS = 3
const DELETE_ATTEMPTS = 3
// Крупнее — без sha256: SubtleCrypto читает файл в память целиком. Повтор узнаётся и без него — по
// владельцу, имени, типу и размеру.
export const HASH_MAX_BYTES = 256 * 1024 * 1024

export async function sha256Hex(file) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Ошибка ответа сервера: текст из тела, код OSP_* и статус — по ним решаем, повторять ли.
async function failure(error) {
  const err = new Error(error?.message || 'Ошибка запроса к серверу')
  const ctx = error?.context
  if (ctx && typeof ctx.clone === 'function') {
    err.status = ctx.status
    const body = await ctx.clone().json().catch(() => null)
    if (body?.error) err.message = body.error
    if (body?.code) err.code = body.code
  } else {
    err.network = true
  }
  return err
}

// Повторяем сбой сети, перегрузку и ошибку сервера. Отказ по правам, 404, 409 — нет: повтор их не исправит.
const retryable = (err) => Boolean(err.network) || err.status === 429 || err.status >= 500

export function createOspFiles({ call, fetchImpl, digest, newId, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const invoke = async (body) => {
    const { data, error } = await call(body)
    if (error) throw await failure(error)
    if (data?.error) throw new Error(data.error)
    return data
  }

  const withRetries = async (attempts, step, canRetry) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step()
      } catch (err) {
        if (attempt >= attempts || !canRetry(err)) throw err
        await sleep(1000 * attempt)
      }
    }
  }

  async function upload({ file, ownerType, ownerId, notes = null, category = null }) {
    const fileFields = {
      operation_id: newId(),
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      sha256: file.size <= HASH_MAX_BYTES ? await digest(file).catch(() => null) : null,
    }

    const already = await withRetries(PUT_ATTEMPTS, async () => {
      const up = await invoke({ action: 'upload', ...fileFields })
      if (up.already) return up.document
      let res
      try {
        res = await fetchImpl(up.presigned_url, { method: 'PUT', headers: { 'Content-Type': fileFields.mime_type }, body: file })
      } catch (e) {
        throw Object.assign(new Error(`Хранилище недоступно: ${e?.message || e}`), { network: true })
      }
      if (!res.ok) {
        // 403 — ссылка истекла: следующая попытка берёт новую на тот же ключ.
        throw Object.assign(new Error(`S3 PUT не удался (${res.status} ${res.statusText})`), { status: res.status, put: true })
      }
      return null
    }, (err) => retryable(err) || Boolean(err.put))
    if (already) return already

    const confirmed = await withRetries(CONFIRM_ATTEMPTS,
      () => invoke({ action: 'confirm', ...fileFields, category, notes }),
      (err) => retryable(err) || err.code === 'OSP_NOT_UPLOADED')
    return confirmed.document
  }

  function downloadUrl(s3Key, { fileName = null, download = false } = {}) {
    return invoke({
      action: 'download',
      s3_key: s3Key,
      ...(download ? { download: true } : {}),
      ...(fileName ? { file_name: fileName } : {}),
    })
  }

  function remove(s3Key) {
    return withRetries(DELETE_ATTEMPTS, () => invoke({ action: 'delete', s3_key: s3Key }), retryable)
  }

  return { upload, downloadUrl, remove }
}
