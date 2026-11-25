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
// 2. Свой ВОР подрядчика с расценками (миграция 20270113, решение пользователя 11.11.2026). С 24.11.2026 расценка — на сайте, страница
//    этот путь не вызывает; 25.11.2026 загрузка закрыта (upload и confirm — 410): принятый файл не сверялся с тем, что лежит в
//    хранилище. Ранее загруженные файлы по-прежнему скачиваются и убираются.
//
//   POST /api/fn/bid-file
//     upload, confirm → 410 OSP_BID_FILE_UPLOAD_CLOSED
//     download { file_id } → { presigned_url, expires_in, file_name }
//     delete   { file_id } → { ok } — сначала строка, затем объект; строки уже нет — { ok, already }
//   POST /api/admin/bid-file { file_id } → { presigned_url, expires_in, file_name } — администратору (сводка расценок подрядчиков)
//
// Подрядчику общий /api/fn/s3-presign разрешает только скачивание, а учётке с регистрации закрыт совсем, поэтому — свой маршрут.
// Всё решают функции базы под входом вошедшего (bid_file_get / bid_file_remove): только файлы своей организации (администратору — все),
// убрать — пока идёт приём. Ключ объекта браузер не получает и не задаёт.
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { access } from '../lib/access.js'
import { sanitizeFileName } from '../lib/files.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'
import { attachmentDisposition, DOWNLOAD_TTL_SEC } from './s3Presign.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_FOUND = 'Файл недоступен: приём предложений закрыт или заявка не подана'
const UPLOAD_CLOSED = { error: 'Загрузка своего ВОР закрыта: расценка — на сайте', code: 'OSP_BID_FILE_UPLOAD_CLOSED' }
const RATE = { limiter: 'presignRate', deny: 'Слишком много запросов к файлам — подождите минуту' }

// Счёт снабжения в окне просмотра (просьба пользователя 25.11.2026 «посмотреть счёт»): ссылка «показать» — только PDF и картинки, тип
// задаёт служба по имени файла (не хранилище и не браузер); остальное — по-прежнему вложением.
const VIEW_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
export const supplyDocViewType = (name) => VIEW_TYPES[String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]] || null
const inlineDisposition = (name) => `inline; filename="${sanitizeFileName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`

// upload и confirm остаются в перечне, чтобы прежняя страница получила понятный отказ (410), а не «неверный запрос».
const BID_FILE_BODY = z.object({
  action: z.enum(['upload', 'confirm', 'download', 'delete']),
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

export function registerBidFiles(app, { config, getS3, isReadOnly = () => false }) {
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

  // Счёт снабжения к цене, которую организация взяла у снабжения (миграция 20270302): решает bid_supply_doc_file под входом подрядчика —
  // разрешение отдела, приём идёт, цена позиции взята и не изменена, файл — документ этой позиции. Строки s3_documents подрядчику
  // закрыты (в notes счёта — все его строки), поэтому — свой маршрут, как файл ВОР.
  app.route({ method: 'POST', url: '/api/fn/bid-supply-doc', config: {
    access: access.user({ require: 'contractor', deny: 'Счёт снабжения — только для подрядчика', rate: RATE }),
    body: z.object({ tender_id: z.string().regex(UUID), document_id: z.string().regex(UUID), view: z.boolean().optional() }),
  }, handler: async (request, reply) => {
    const { data, error } = await request.auth.supabase.rpc('bid_supply_doc_file', {
      p_tender: request.body.tender_id, p_doc: request.body.document_id,
    })
    if (error) {
      if (error.code === '42501') return reply.code(403).send({ error: 'Счёт снабжения — только для подрядчика' })
      if (error.code === '42883' || error.code === 'PGRST202') return reply.code(404).send({ error: 'Счета снабжения появятся после обновления базы' })
      request.log.error({ code: error.code, msg: String(error.message || '').slice(0, 200) }, 'bid_supply_doc_file')
      return reply.code(500).send({ error: 'Не удалось получить счёт' })
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.s3_key) return reply.code(404).send({ error: 'Счёт недоступен: отдел не разрешил цены снабжения, приём закрыт или цена позиции уже не снабжения' })
    // view — ссылка для окна просмотра: доступ решила та же функция, меняется только то, как браузер покажет файл. inline: true —
    // только когда ссылка подписана «показать» (страница без отметки — прежняя служба или не PDF/картинка — предлагает «Скачать»).
    const viewType = request.body.view === true ? supplyDocViewType(row.file_name) : null
    const url = await getSignedUrl(getS3(), new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: row.s3_key,
      ...(viewType
        ? { ResponseContentDisposition: inlineDisposition(row.file_name), ResponseContentType: viewType }
        : { ResponseContentDisposition: attachmentDisposition(row.file_name) }),
    }), { expiresIn: DOWNLOAD_TTL_SEC })
    return { presigned_url: url, expires_in: DOWNLOAD_TTL_SEC, file_name: row.file_name, ...(viewType ? { inline: true } : {}) }
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
    if (body.action === 'upload' || body.action === 'confirm') return reply.code(410).send(UPLOAD_CLOSED)
    if (body.action !== 'download' && isReadOnly()) return reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })
    if (!body.file_id) return reply.code(400).send({ error: 'Нет id файла' })

    if (body.action === 'download') return downloadUrl(request, reply, body.file_id)

    // delete
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
  } })

  app.route({ method: 'POST', url: '/api/admin/bid-file', config: {
    access: access.user({ require: 'admin', deny: 'Файлы подрядчиков — только администратору', rate: RATE }),
    body: z.object({ file_id: z.string().regex(UUID) }),
  }, handler: async (request, reply) => downloadUrl(request, reply, request.body.file_id) })
}
