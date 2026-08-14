// Edge Function `s3-presign` (task 277).
//
// Назначение: единая точка подписи URL-ов для S3-совместимого хранилища
// (cloud.ru). Браузер никогда не получает access_key / secret_key — только
// presigned URL c коротким TTL.
//
// Операции (POST { action, ... }):
//   action=upload   { owner_type, owner_id, file_name, mime_type }
//                     → { s3_key, presigned_url, expires_in }  (PUT, TTL 15 мин)
//   action=download { s3_key }
//                     → { presigned_url, expires_in }          (GET, TTL 60 мин)
//   action=delete   { s3_key }
//                     → { ok: true }                           (DeleteObject в S3)
//
// Авторизация: требует Authorization: Bearer <supabase_jwt>. Edge Function
// сама проверяет токен через supabase.auth.getUser().
//
// Секреты задаются в окружении функции (см. supabase/functions/.env.local.example):
//   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from 'npm:@aws-sdk/client-s3@3.658.0'
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.658.0'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Маппинг owner_type → префикс каталога в бакете. Расширяй, если появятся новые разделы.
const FOLDER_BY_OWNER: Record<string, string> = {
  tender: 'tenders',
  contract: 'contracts',
  object: 'objects',
  customer: 'customers',
  counterparty: 'counterparties',
  dc_request: 'dc-requests',
  general: 'general',
  general_document: 'general-documents',
}

const UPLOAD_TTL_SEC = 15 * 60     // 15 минут — окно для PUT
const DOWNLOAD_TTL_SEC = 60 * 60   // 60 минут — окно для GET/preview

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey, x-supabase-api-version',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function getS3(): { client: S3Client; bucket: string } {
  const endpoint = Deno.env.get('S3_ENDPOINT')
  const region = Deno.env.get('S3_REGION') || 'ru-central-1'
  const bucket = Deno.env.get('S3_BUCKET')
  const accessKeyId = Deno.env.get('S3_ACCESS_KEY_ID')
  const secretAccessKey = Deno.env.get('S3_SECRET_ACCESS_KEY')
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 secrets are not configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY).')
  }
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,  // cloud.ru S3 использует path-style URL-ы
  })
  return { client, bucket }
}

// Транслитерация кириллицы → латиница. S3-ключ должен быть ASCII-safe: кириллица в
// ключе попадает в presigned URL и может ломать подпись/загрузку у некоторых прокси.
// Оригинальное имя файла для отображения хранится отдельно в s3_documents.file_name.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
function transliterate(s: string): string {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    const mapped = TRANSLIT[lower]
    if (mapped === undefined) { out += ch; continue }
    out += ch === lower ? mapped : (mapped ? mapped.charAt(0).toUpperCase() + mapped.slice(1) : '')
  }
  return out
}

// Sanitize имя файла для S3-ключа: транслитерация кириллицы, затем только ASCII
// [a-zA-Z0-9._-]; остальное → '_'. Без ведущей точки и пустого имени. Длина ≤ 200.
function sanitizeFileName(name: string): string {
  const cleaned = transliterate(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200)
  const noLeadingDot = cleaned.replace(/^\.+/, '')
  return noLeadingDot || 'file'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  // 1) Проверка авторизации Supabase JWT.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Supabase env not configured' }, 500)
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401)

  // 2) Парсинг тела.
  let body: { action?: string; [key: string]: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  // 3) S3-клиент.
  let s3, bucket: string
  try {
    const cfg = getS3()
    s3 = cfg.client
    bucket = cfg.bucket
  } catch (e) {
    console.error('S3 config error:', e)
    return jsonResponse({ error: (e as Error).message }, 500)
  }

  try {
    switch (body.action) {
      case 'upload': {
        const owner_type = String(body.owner_type || '')
        const owner_id = String(body.owner_id || '')
        const file_name = String(body.file_name || '')
        const mime_type = String(body.mime_type || 'application/octet-stream')
        const folder = FOLDER_BY_OWNER[owner_type]
        if (!folder) return jsonResponse({ error: `Unsupported owner_type: ${owner_type}` }, 400)
        if (!owner_id) return jsonResponse({ error: 'Missing owner_id' }, 400)
        if (!file_name) return jsonResponse({ error: 'Missing file_name' }, 400)
        // UUID-префикс защищает от коллизий имён в рамках одного владельца.
        const uniqueId = crypto.randomUUID()
        const safe = sanitizeFileName(file_name)
        const s3_key = `${folder}/${owner_id}/${uniqueId}-${safe}`
        const cmd = new PutObjectCommand({ Bucket: bucket, Key: s3_key, ContentType: mime_type })
        const presigned_url = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_TTL_SEC })
        return jsonResponse({ s3_key, presigned_url, expires_in: UPLOAD_TTL_SEC })
      }

      case 'download': {
        const s3_key = String(body.s3_key || '')
        if (!s3_key) return jsonResponse({ error: 'Missing s3_key' }, 400)
        // При скачивании (не превью) отдаём файл под ОРИГИНАЛЬНЫМ именем через
        // Content-Disposition: браузер сохраняет его как file_name, а не как S3-ключ
        // с uuid-префиксом. filename= — ASCII-fallback, filename*= — UTF-8 (кириллица).
        // Для превью (download не передан) заголовок не ставим — файл открывается inline.
        const rawName = String(body.file_name || '')
        const wantDownload = body.download === true || body.download === 'true'
        const params: { Bucket: string; Key: string; ResponseContentDisposition?: string } = {
          Bucket: bucket, Key: s3_key,
        }
        if (wantDownload && rawName) {
          const ascii = sanitizeFileName(rawName)
          const encoded = encodeURIComponent(rawName)
          params.ResponseContentDisposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
        }
        const cmd = new GetObjectCommand(params)
        const presigned_url = await getSignedUrl(s3, cmd, { expiresIn: DOWNLOAD_TTL_SEC })
        return jsonResponse({ presigned_url, expires_in: DOWNLOAD_TTL_SEC })
      }

      case 'delete': {
        const s3_key = String(body.s3_key || '')
        if (!s3_key) return jsonResponse({ error: 'Missing s3_key' }, 400)
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3_key }))
        return jsonResponse({ ok: true })
      }

      default:
        return jsonResponse({ error: `Unknown action: ${body.action}` }, 400)
    }
  } catch (e) {
    console.error('s3-presign error:', e)
    return jsonResponse({ error: (e as Error)?.message || 'Internal error' }, 500)
  }
})
