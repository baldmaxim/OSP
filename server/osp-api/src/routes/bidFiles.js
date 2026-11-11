// Файлы кабинета подрядчика.
//
// 1. Файл ВОР подрядчику для расценки (миграция 20261226, решение пользователя 05.11.2026: подрядчик скачивает сам файл ВОР, а не шаблон).
//
//   POST /api/fn/bid-vor-file { file_id } → { presigned_url, expires_in, file_name }
//
// Отдельный маршрут, а не s3-presign: учётке с регистрации строки s3_documents закрыты, ключа файла у неё нет, а /api/fn/s3-presign
// для неё закрыт требованием approved. Здесь она называет id файла из списка bid_positions; можно ли ей этот файл, решает функция
// базы bid_vor_file под её же входом: только Excel-файл ВОР идущего тендера, только при доступе организации к тендеру (участник или
// заявка не отклонена). Другого файла тендера (пакет, РД) и файла чужого тендера этот маршрут не отдаёт. Функции нет в списке
// шлюза: браузер вызвать её не может, ключ файла наружу не выходит.
//
// 2. Свой ВОР подрядчика с расценками (миграция 20270113, решение пользователя 11.11.2026: расценка на сайте временно скрыта,
//    подрядчик загружает заполненный ВОР рядом с каждой ведомостью тендера).
//
//   POST /api/fn/bid-file
//     upload   { tender_id, vor_file_id, operation_id, file_name, mime_type, size_bytes } → { presigned_url, expires_in }
//     confirm  { те же поля, summary } → { ok, vor_name } — объект в хранилище есть и того же размера → строка tender_bid_files;
//              прежний файл этой ведомости удаляется из хранилища. Повтор с тем же ключом операции — та же строка
//     download { file_id } → { presigned_url, expires_in, file_name }
//     delete   { file_id } → { ok } — сначала строка, затем объект; строки уже нет — { ok, already }
//   POST /api/admin/bid-file { file_id } → { presigned_url, expires_in, file_name } — администратору (сводка расценок подрядчиков)
//
// Подрядчику общий /api/fn/s3-presign разрешает только скачивание, а учётке с регистрации закрыт совсем, поэтому — свой маршрут.
// Всё решают функции базы под входом вошедшего (bid_file_target / save / remove / get): тендер открыт, организация — участник или
// её заявка не отклонена, ведомость — Excel-файл ВОР этого тендера, чужие файлы не видны. Ключ объекта задаёт служба —
// bids/<тендер>/<организация из базы>/<ключ операции>-<имя>, база принимает ключ только в каталоге своей организации; браузер ключа
// не получает и не задаёт. Сводку сумм считает страница (разбор файла — в браузере, как «Цены из файла»), служба оставляет в ней
// только известные поля с числами в своих пределах.
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { access } from '../lib/access.js'
import { sanitizeFileName } from '../lib/files.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'
import { attachmentDisposition, DOWNLOAD_TTL_SEC, UPLOAD_TTL_SEC } from './s3Presign.js'
import { createUploadIntents } from '../lib/uploadIntents.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Ключ операции — UUIDv7, как у s3-presign (src/utils/uuid.js портала).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NOT_FOUND = 'Файл недоступен: приём предложений закрыт или заявка не подана'
export const BID_FILE_MAX_BYTES = 25 * 1024 * 1024
const RATE = { limiter: 'presignRate', deny: 'Слишком много запросов к файлам — подождите минуту' }

// ── Сводка файла: только известные поля ─────────────────────────────────────────────────────────────
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? Math.round(v * 100) / 100 : null)
const count = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e6 ? v : null)
const byKind = (v) => {
  if (!v || typeof v !== 'object') return null
  const material = count(v.material)
  const work = count(v.work)
  return material == null && work == null ? null : { material: material ?? 0, work: work ?? 0 }
}
const SUMMARY_VAT = new Set(['gross', 'net', 'exempt'])
export function cleanSummary(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { v: 1 }
  for (const k of ['materials', 'works', 'total']) { const m = money(s[k]); if (m != null) out[k] = m }
  for (const k of ['items', 'priced']) { const b = byKind(s[k]); if (b) out[k] = b }
  for (const k of ['rows', 'unmatched']) { const c = count(s[k]); if (c != null) out[k] = c }
  if (SUMMARY_VAT.has(s.vat)) out.vat = s.vat
  if (typeof s.rate === 'number' && Number.isFinite(s.rate) && s.rate >= 0 && s.rate <= 50) out.rate = s.rate
  if (typeof s.error === 'string' && /^[a-z_]{1,40}$/.test(s.error)) out.error = s.error
  if (typeof s.sheet === 'string' && s.sheet.length <= 200) out.sheet = s.sheet
  return out
}

const BID_FILE_BODY = z.object({
  action: z.enum(['upload', 'confirm', 'download', 'delete']),
  tender_id: z.string().regex(UUID).optional(),
  vor_file_id: z.string().regex(UUID).optional(),
  operation_id: z.string().regex(UUID_V7).optional(),
  file_name: z.string().min(1).max(255).optional(),
  mime_type: z.string().max(200).optional(),
  size_bytes: z.number().int().min(0).optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  file_id: z.string().regex(UUID).optional(),
})

// Отказ функции базы → [код, текст]: права — 403, ведомости нет — 404, неверные поля — 400, остальное — 500.
function refusal(error) {
  const code = String(error?.code || '')
  const msg = String(error?.message || '').slice(0, 300)
  if (code === '42501') return [403, msg || NOT_FOUND]
  if (code === 'P0002') return [404, msg || 'Такой ведомости в тендере нет']
  if (code === '22023' || code === '23514') return [400, msg || 'Неверный запрос']
  return null
}

export function registerBidFiles(app, { config, getS3, isReadOnly = () => false, db = null }) {
  // Незавершённые загрузки — с пределом на пользователя и уборкой (src/lib/uploadIntents.js).
  const intents = createUploadIntents({ db })
  app.route({ method: 'POST', url: '/api/fn/bid-vor-file', config: {
    access: access.user({ require: 'contractor', deny: 'Файл ВОР — только для подрядчика', rate: RATE }),
    body: z.object({ file_id: z.string().regex(UUID) }),
  }, handler: async (request, reply) => {
    const { data, error } = await request.auth.supabase.rpc('bid_vor_file', { p_file: request.body.file_id })
    if (error) {
      if (error.code === '42501') return reply.code(403).send({ error: 'Файл ВОР — только для подрядчика' })
      request.log.error({ code: error.code, msg: String(error.message || '').slice(0, 200) }, 'bid_vor_file')
      return reply.code(500).send({ error: 'Не удалось получить файл ВОР' })
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.s3_key) return reply.code(404).send({ error: NOT_FOUND })
    const url = await getSignedUrl(getS3(), new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: row.s3_key,
      ResponseContentDisposition: attachmentDisposition(row.file_name),
    }), { expiresIn: DOWNLOAD_TTL_SEC })
    return { presigned_url: url, expires_in: DOWNLOAD_TTL_SEC, file_name: row.file_name }
  } })

  // Ссылка на скачивание своего файла (или любого — администратору): решает bid_file_get под входом вошедшего.
  const downloadUrl = async (request, reply, fileId) => {
    const { data, error } = await request.auth.supabase.rpc('bid_file_get', { p_file: fileId })
    if (error) {
      const known = refusal(error)
      if (known) return reply.code(known[0]).send({ error: known[1] })
      request.log.error({ code: error.code, msg: String(error.message || '').slice(0, 200) }, 'bid_file_get')
      return reply.code(500).send({ error: 'Не удалось получить файл' })
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.s3_key) return reply.code(404).send({ error: 'Файл не найден' })
    const url = await getSignedUrl(getS3(), new GetObjectCommand({
      Bucket: config.s3.bucket, Key: row.s3_key, ResponseContentDisposition: attachmentDisposition(row.file_name),
    }), { expiresIn: DOWNLOAD_TTL_SEC })
    return { presigned_url: url, expires_in: DOWNLOAD_TTL_SEC, file_name: row.file_name }
  }

  // Объект из хранилища — без отказа запросу: строки уже нет, лишний объект виден в журнале.
  const dropObject = async (request, key) => {
    if (!key) return
    try {
      await getS3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }))
    } catch (e) {
      request.log.warn({ key, msg: String(e?.message || e).slice(0, 200) }, 'bid-file: объект не удалился')
    }
  }

  app.route({ method: 'POST', url: '/api/fn/bid-file', config: {
    access: access.user({ require: 'contractor', deny: 'Файл с расценкой — только для подрядчика', rate: RATE }),
    body: BID_FILE_BODY,
  }, handler: async (request, reply) => {
    const body = request.body
    const { supabase } = request.auth
    if (body.action !== 'download' && isReadOnly()) return reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })

    if (body.action === 'download') {
      if (!body.file_id) return reply.code(400).send({ error: 'Нет id файла' })
      return downloadUrl(request, reply, body.file_id)
    }

    if (body.action === 'delete') {
      if (!body.file_id) return reply.code(400).send({ error: 'Нет id файла' })
      const { data, error } = await supabase.rpc('bid_file_remove', { p_file: body.file_id })
      if (error) {
        const known = refusal(error)
        if (known) return reply.code(known[0]).send({ error: known[1] })
        request.log.error({ code: error.code, msg: String(error.message || '').slice(0, 200) }, 'bid_file_remove')
        return reply.code(500).send({ error: 'Не удалось убрать файл' })
      }
      const key = typeof data === 'string' ? data : null
      if (!key) return { ok: true, already: true }
      await dropObject(request, key)
      return { ok: true }
    }

    // upload / confirm
    const { tender_id: tenderId, vor_file_id: vorFileId, operation_id: operationId, file_name: fileName } = body
    if (!tenderId || !vorFileId || !operationId || !fileName || body.size_bytes == null) {
      return reply.code(400).send({ error: 'Не хватает полей файла' })
    }
    if (body.size_bytes > BID_FILE_MAX_BYTES) return reply.code(400).send({ error: 'Файл больше 25 МБ' })
    const { data: target, error: targetError } = await supabase.rpc('bid_file_target', { p_tender: tenderId, p_vor_file: vorFileId })
    if (targetError) {
      const known = refusal(targetError)
      if (known) return reply.code(known[0]).send({ error: known[1] })
      request.log.error({ code: targetError.code, msg: String(targetError.message || '').slice(0, 200) }, 'bid_file_target')
      return reply.code(500).send({ error: 'Не удалось проверить тендер' })
    }
    const row = Array.isArray(target) ? target[0] : target
    if (!row?.counterparty_id) return reply.code(403).send({ error: NOT_FOUND })
    const key = `bids/${tenderId.toLowerCase()}/${String(row.counterparty_id).toLowerCase()}/${operationId.toLowerCase()}-${sanitizeFileName(fileName)}`
    const mime = body.mime_type || 'application/octet-stream'
    const s3 = getS3()

    if (body.action === 'upload') {
      const busy = await intents.note(key, request.auth.user.id, body.size_bytes)
      if (busy) return reply.header('retry-after', '300').code(429).send({ error: busy, code: 'OSP_UPLOADS_PENDING' })
      // Тип и длина — в подписи: по ссылке загружается только заявленный файл (размер — точно, не больше предела).
      const put = new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, ContentType: mime, ContentLength: body.size_bytes })
      const url = await getSignedUrl(s3, put, { expiresIn: UPLOAD_TTL_SEC, signableHeaders: new Set(['content-type', 'content-length']) })
      return { presigned_url: url, expires_in: UPLOAD_TTL_SEC }
    }

    let stored
    try {
      stored = await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }))
    } catch (e) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
        return reply.code(409).send({ error: 'Файла ещё нет в хранилище — загрузка не завершилась', code: 'OSP_NOT_UPLOADED' })
      }
      throw e
    }
    if (Number(stored.ContentLength) !== body.size_bytes) {
      return reply.code(409).send({ error: 'Размер файла в хранилище не совпадает с выбранным', code: 'OSP_SIZE_MISMATCH' })
    }
    const { data: prev, error: saveError } = await supabase.rpc('bid_file_save', {
      p_tender: tenderId, p_vor_file: vorFileId, p_s3_key: key, p_file_name: fileName, p_mime: mime,
      p_size: body.size_bytes, p_summary: cleanSummary(body.summary),
    })
    if (saveError) {
      // Строку не записали (приём закрылся, пока шла загрузка) — объекту в хранилище незачем оставаться.
      await dropObject(request, key)
      const known = refusal(saveError)
      if (known) return reply.code(known[0]).send({ error: known[1] })
      request.log.error({ code: saveError.code, msg: String(saveError.message || '').slice(0, 200) }, 'bid_file_save')
      return reply.code(500).send({ error: 'Не удалось сохранить файл' })
    }
    await intents.drop(key)
    if (typeof prev === 'string' && prev && prev !== key) await dropObject(request, prev)
    return { ok: true, vor_name: row.vor_name }
  } })

  app.route({ method: 'POST', url: '/api/admin/bid-file', config: {
    access: access.user({ require: 'admin', deny: 'Файлы подрядчиков — только администратору', rate: RATE }),
    body: z.object({ file_id: z.string().regex(UUID) }),
  }, handler: async (request, reply) => downloadUrl(request, reply, request.body.file_id) })
}
