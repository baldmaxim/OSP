// Обложки объектов в cloud.ru (covers/<имя>, src/lib/covers.js). Их адрес на сайте — /api/covers/<имя>;
// так он записан в objects.cover_image_url после переноса (migration/target/sql/load-covers.sql) и у
// новых обложек.
//
//   GET  /api/covers/<имя>     — открытый адрес, как был у общедоступного бакета Supabase: картинку
//                                показывает <img>, а он токен не передаёт. Имя — только по шаблону
//                                «UUID.расширение» и только в каталоге covers/; ответ — переадресация на
//                                подписанную ссылку на 10 минут. Знать адрес — значит знать имя файла,
//                                как и раньше.
//   POST /api/fn/cover-upload  { name, mime_type, size_bytes } → { presigned_url, expires_in, url } —
//                                ссылка на загрузку новой обложки: сотруднику с правом правки объектов
//                                (osp_can('objects', 'edit') — то же правило, что у документов объекта).
//                                Имя даёт страница (UUID); занятое имя — 409: обложка не перезаписывается.
//                                Тип файла подписан: положить по ссылке не изображение нельзя.
//                                Барьер записи на время переноса — 503 OSP_READONLY.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { access } from '../lib/access.js'
import { COVER_NAME_RE, COVER_URL_PREFIX, coverKey } from '../lib/covers.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'

export const COVER_VIEW_TTL_SEC = 10 * 60
export const COVER_UPLOAD_TTL_SEC = 15 * 60
export const COVER_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]{1,64}$/
const MISSING_FUNCTION = new Set(['PGRST202', '42883'])
export const COVERS_OPEN_REASON = 'Обложки объектов: картинку показывает <img> без токена, как раньше из общедоступного бакета Supabase; только имя «UUID.расширение» в каталоге covers/, ответ — подписанная ссылка на 10 минут'

const any = z.unknown().optional()
export const COVER_UPLOAD_BODY = z.object({ name: any, mime_type: any, size_bytes: any })

export function registerCovers(app, { config, getS3, isReadOnly = () => false }) {
  app.route({
    method: 'GET',
    url: '/api/covers/:name',
    config: { access: access.open(COVERS_OPEN_REASON) },
    handler: async (request, reply) => {
      const name = String(request.params.name || '')
      if (!COVER_NAME_RE.test(name)) return reply.code(404).send({ error: 'Not found' })
      let s3
      try {
        s3 = getS3()
      } catch (e) {
        request.log.error({ msg: e.message }, 's3 config')
        return reply.code(503).send({ error: 'Хранилище файлов не настроено' })
      }
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: coverKey(name) }), { expiresIn: COVER_VIEW_TTL_SEC })
      return reply.redirect(url, 302)
    },
  })

  app.route({
    method: 'POST',
    url: '/api/fn/cover-upload',
    config: {
      access: access.user({
        require: 'employee',
        deny: 'Обложку объекта загружает сотрудник',
        rate: { limiter: 'presignRate', deny: 'Слишком много запросов к файлам — подождите минуту' },
      }),
      body: COVER_UPLOAD_BODY,
    },
    handler: async (request, reply) => {
      if (isReadOnly()) return reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })
      const { supabase } = request.auth
      const name = String(request.body.name || '')
      const mime = String(request.body.mime_type || '')
      const size = request.body.size_bytes
      if (!COVER_NAME_RE.test(name)) return reply.code(400).send({ error: 'Имя обложки — UUID и расширение файла' })
      if (!IMAGE_MIME_RE.test(mime)) return reply.code(400).send({ error: 'Обложка — только изображение' })
      if (!Number.isSafeInteger(size) || size <= 0 || size > COVER_MAX_BYTES) {
        return reply.code(400).send({ error: `Обложка — не больше ${COVER_MAX_BYTES / 1024 / 1024} МБ` })
      }
      const { data: can, error } = await supabase.rpc('osp_can', { p_section: 'objects', p_kind: 'edit' })
      if (error) {
        if (MISSING_FUNCTION.has(error.code)) {
          return reply.code(503).send({ error: 'Проверка прав недоступна: нет функции osp_can (миграция Р2a)', code: 'OSP_RIGHTS_UNAVAILABLE' })
        }
        request.log.error({ code: error.code }, 'cover-upload rights')
        return reply.code(500).send({ error: 'Internal error' })
      }
      if (can !== true) return reply.code(403).send({ error: 'Нет права на правку объектов' })
      let s3
      try {
        s3 = getS3()
      } catch (e) {
        request.log.error({ msg: e.message }, 's3 config')
        return reply.code(500).send({ error: e.message })
      }
      const bucket = config.s3.bucket
      const key = coverKey(name)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return reply.code(409).send({ error: 'Обложка с таким именем уже есть — выберите файл заново', code: 'OSP_COVER_EXISTS' })
      } catch (e) {
        if (!(e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404)) {
          request.log.error({ msg: e?.message }, 'cover-upload head')
          return reply.code(500).send({ error: 'Хранилище файлов не ответило' })
        }
      }
      // Тип файла входит в подпись: хранилище примет только заявленное изображение.
      const presignedUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mime }),
        { expiresIn: COVER_UPLOAD_TTL_SEC, signableHeaders: new Set(['content-type']) })
      return { presigned_url: presignedUrl, expires_in: COVER_UPLOAD_TTL_SEC, url: COVER_URL_PREFIX + name }
    },
  })
}
