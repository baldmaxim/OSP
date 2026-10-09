// POST /api/fn/s3-presign — перенос Edge Function `s3-presign` (supabase/functions/s3-presign)
// без изменения поведения: тот же запрос, ответ, коды и проверка доступа.
//
//   action=upload   { owner_type, owner_id, file_name, mime_type } → { s3_key, presigned_url, expires_in }
//   action=download { s3_key, file_name?, download? }              → { presigned_url, expires_in }
//   action=delete   { s3_key }                                     → { ok: true }
//
// Доступ: токен пользователя Supabase. Строку user_roles и запись s3_documents читаем ПОД ЕГО ЖЕ
// токеном — действуют те же политики RLS, что и в браузере; ссылку по «угаданному» ключу не выдаём.
// Подрядчику — только скачивание файлов своих договоров (is_my_contract).
import { randomUUID } from 'node:crypto'
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { sanitizeFileName } from '../lib/files.js'

// owner_type → каталог в бакете. Расширять вместе с s3_documents.owner_type.
export const FOLDER_BY_OWNER = {
  tender: 'tenders',
  contract: 'contracts',
  object: 'objects',
  customer: 'customers',
  counterparty: 'counterparties',
  dc_request: 'dc-requests',
  doc_check_request: 'doc-check-requests',
  general: 'general',
  general_document: 'general-documents',
  task: 'tasks',
}

export const UPLOAD_TTL_SEC = 15 * 60
export const DOWNLOAD_TTL_SEC = 60 * 60

export function registerS3Presign(app, { config, authenticate, getS3 }) {
  app.post('/api/fn/s3-presign', async (request, reply) => {
    const auth = await authenticate(request, reply)
    if (!auth) return reply
    const { supabase, user } = auth

    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('counterparty_id, is_approved')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!roleRow || roleRow.is_approved === false) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const isContractor = !!roleRow.counterparty_id

    const assertKeyAllowed = async (s3Key) => {
      const { data, error } = await supabase
        .from('s3_documents')
        .select('id, owner_type, owner_id')
        .eq('s3_key', s3Key)
        .maybeSingle()
      if (error) throw error
      if (!data) return false
      if (!isContractor) return true
      if (data.owner_type !== 'contract') return false
      const { data: mine, error: rpcError } = await supabase
        .rpc('is_my_contract', { contract_uuid: data.owner_id })
      if (rpcError) throw rpcError
      return mine === true
    }

    const body = request.body
    if (isContractor && body.action !== 'download') {
      return reply.code(403).send({ error: 'Действие доступно только сотрудникам' })
    }

    let s3
    try {
      s3 = getS3()
    } catch (e) {
      request.log.error({ msg: e.message }, 's3 config')
      return reply.code(500).send({ error: e.message })
    }
    const bucket = config.s3.bucket

    try {
      switch (body.action) {
        case 'upload': {
          const ownerType = String(body.owner_type || '')
          const ownerId = String(body.owner_id || '')
          const fileName = String(body.file_name || '')
          const mimeType = String(body.mime_type || 'application/octet-stream')
          const folder = Object.hasOwn(FOLDER_BY_OWNER, ownerType) ? FOLDER_BY_OWNER[ownerType] : null
          if (!folder) return reply.code(400).send({ error: `Unsupported owner_type: ${ownerType}` })
          if (!ownerId) return reply.code(400).send({ error: 'Missing owner_id' })
          if (!fileName) return reply.code(400).send({ error: 'Missing file_name' })
          // uuid-префикс — против совпадения имён у одного владельца.
          const s3Key = `${folder}/${ownerId}/${randomUUID()}-${sanitizeFileName(fileName)}`
          const cmd = new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: mimeType })
          const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_TTL_SEC })
          return { s3_key: s3Key, presigned_url: presignedUrl, expires_in: UPLOAD_TTL_SEC }
        }

        case 'download': {
          const s3Key = String(body.s3_key || '')
          if (!s3Key) return reply.code(400).send({ error: 'Missing s3_key' })
          if (!await assertKeyAllowed(s3Key)) return reply.code(404).send({ error: 'Файл не найден' })
          // Скачивание (не превью) — под исходным именем: filename= — ASCII, filename*= — UTF-8.
          const rawName = String(body.file_name || '')
          const wantDownload = body.download === true || body.download === 'true'
          const params = { Bucket: bucket, Key: s3Key }
          if (wantDownload && rawName) {
            const ascii = sanitizeFileName(rawName)
            const encoded = encodeURIComponent(rawName)
            params.ResponseContentDisposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
          }
          const presignedUrl = await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: DOWNLOAD_TTL_SEC })
          return { presigned_url: presignedUrl, expires_in: DOWNLOAD_TTL_SEC }
        }

        case 'delete': {
          const s3Key = String(body.s3_key || '')
          if (!s3Key) return reply.code(400).send({ error: 'Missing s3_key' })
          if (!await assertKeyAllowed(s3Key)) return reply.code(404).send({ error: 'Файл не найден' })
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }))
          return { ok: true }
        }

        default:
          return reply.code(400).send({ error: `Unknown action: ${body.action}` })
      }
    } catch (e) {
      request.log.error({ msg: e?.message }, 's3-presign')
      return reply.code(500).send({ error: e?.message || 'Internal error' })
    }
  })
}
