// Обложки объектов в cloud.ru: каталог covers/ бакета портала. Раньше они лежали в общедоступном бакете
// object-photos хранилища Supabase. Переносит их copyCovers (src/covers-copy.js), показ и загрузка новых —
// src/routes/covers.js, адрес на сайте — /api/covers/<имя>.
import crypto from 'node:crypto'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

// Имя — как его даёт страница объектов: UUID и расширение исходного файла. Тот же шаблон — у загрузки в
// базу Яндекса (migration/target/lib/extras.mjs); совпадение проверяет тест.
export const COVER_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,10}$/
export const COVER_PREFIX = 'covers/'
export const COVER_URL_PREFIX = '/api/covers/'
export const coverKey = (name) => COVER_PREFIX + name
// Общедоступный адрес файла бакета object-photos — так его записывала страница объектов.
export const sourceBaseOf = (supabaseUrl) => `${String(supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/object-photos/`

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const notFound = (e) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
const LIST_HEADER = 'name,size,mimetype,created_at,updated_at'

// Список обложек копии прода (migration/backup/extras.sql): имя, размер, тип.
export function parseCoverList(text) {
  const lines = String(text).split('\n').filter(Boolean)
  if (lines[0] !== LIST_HEADER) throw new Error(`список обложек: первая строка не «${LIST_HEADER}»`)
  return lines.slice(1).map((line) => {
    const [name, size, mimetype] = line.split(',')
    return { name, size: size === '' || size === undefined ? null : Number(size), mimetype: mimetype || null }
  })
}

class Failure extends Error {}

async function bytesOf(body) {
  return Buffer.from(await body.transformToByteArray())
}

// Каждую обложку списка: скачать по общедоступному адресу Supabase → сверить размер со списком →
// положить в cloud.ru, если её там нет → скачать обратно и сверить SHA-256. Лежащий в cloud.ru файл с
// тем же содержимым — сверен без загрузки (повторный запуск); с другим — не перезаписывается, отказ.
// Supabase только читается. Итог — журнал для migration/target/load.sh --covers.
export async function copyCovers({ listBytes, sourceBase, s3, bucket, fetchImpl = fetch, timeoutMs = 60_000, now = () => new Date() }) {
  const files = []
  for (const item of parseCoverList(listBytes.toString('utf8'))) {
    const entry = { name: item.name }
    try {
      if (!COVER_NAME_RE.test(item.name || '')) throw new Failure('имя не по шаблону «UUID.расширение»')
      const res = await fetchImpl(sourceBase + encodeURIComponent(item.name), { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Failure(`хранилище Supabase ответило ${res.status}`)
      const source = Buffer.from(await res.arrayBuffer())
      if (item.size !== null && source.length !== item.size) throw new Failure(`скачано ${source.length} байт, в списке ${item.size}`)
      const hash = sha256(source)
      const contentType = item.mimetype || res.headers.get('content-type') || 'application/octet-stream'
      const key = coverKey(item.name)
      let stored = null
      try {
        stored = await bytesOf((await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body)
      } catch (e) {
        if (!notFound(e)) throw e
      }
      let uploaded = false
      if (stored) {
        if (sha256(stored) !== hash) throw new Failure('в cloud.ru уже лежит другой файл с этим именем — не перезаписывается')
      } else {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: source, ContentType: contentType, Metadata: { sha256: hash } }))
        uploaded = true
        const back = await bytesOf((await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body)
        if (sha256(back) !== hash) throw new Failure('скачанный обратно из cloud.ru файл отличается от исходного')
      }
      Object.assign(entry, { status: 'verified', size: source.length, sha256: hash, content_type: contentType, uploaded })
    } catch (e) {
      const reason = e instanceof Failure ? e.message : `сбой: ${String(e?.name || 'Error')} ${String(e?.message || '').slice(0, 120)}`.trim()
      Object.assign(entry, { status: 'failed', reason })
    }
    files.push(entry)
  }
  return {
    tool: 'covers-copy', version: 1, list_sha256: sha256(listBytes), source_base: sourceBase,
    target_prefix: COVER_PREFIX, finished_at: now().toISOString(), files,
  }
}
