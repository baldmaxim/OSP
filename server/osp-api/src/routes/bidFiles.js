// Файл ВОР подрядчику для расценки (миграция 20261226, решение пользователя 05.11.2026: подрядчик скачивает сам файл ВОР, а не шаблон).
//
//   POST /api/fn/bid-vor-file { file_id } → { presigned_url, expires_in, file_name }
//
// Отдельный маршрут, а не s3-presign: учётке с регистрации строки s3_documents закрыты, ключа файла у неё нет, а /api/fn/s3-presign
// для неё закрыт требованием approved. Здесь она называет id файла из списка bid_positions; можно ли ей этот файл, решает функция
// базы bid_vor_file под её же входом: только Excel-файл ВОР идущего тендера, только при доступе организации к тендеру (участник или
// заявка не отклонена). Другого файла тендера (пакет, РД) и файла чужого тендера этот маршрут не отдаёт. Функции нет в списке
// шлюза: браузер вызвать её не может, ключ файла наружу не выходит.
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { access } from '../lib/access.js'
import { attachmentDisposition, DOWNLOAD_TTL_SEC } from './s3Presign.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_FOUND = 'Файл недоступен: приём предложений закрыт или заявка не подана'

export function registerBidFiles(app, { config, getS3 }) {
  app.route({ method: 'POST', url: '/api/fn/bid-vor-file', config: {
    access: access.user({
      require: 'contractor',
      deny: 'Файл ВОР — только для подрядчика',
      rate: { limiter: 'presignRate', deny: 'Слишком много запросов к файлам — подождите минуту' },
    }),
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
}
