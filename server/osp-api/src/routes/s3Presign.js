// POST /api/fn/s3-presign — файлы документов через osp-api (заход Б, Р5-ядро). Его вызывают только
// сборки с флагом ospApiFilesV2 (src/api/ospFiles.js). Без флага и в сборках до захода Б файлы идут
// через Edge Function Supabase `s3-presign` — её протокол здесь не повторяется.
//
//   upload   { operation_id, owner_type, owner_id, file_name, mime_type, size_bytes, sha256? }
//            → { s3_key, presigned_url, expires_in } — ссылка на PUT; ключ объекта задан operation_id
//            → { already: true, document }          — документ этой операции уже есть
//   confirm  { те же поля, category?, notes? }      → { document } — объект в бакете есть и того же
//            размера → строка s3_documents с id = operation_id; повтор — { already: true, document }
//   download { s3_key, file_name?, download? }      → { presigned_url, expires_in }
//   delete   { s3_key }                             → { ok: true } — сначала строка, затем объект;
//            строки уже нет (повтор) — { ok: true, already: true }
//
// Ключ операции один на выбранный файл: повтор любого шага не создаёт второй документ и второй объект.
// Тот же operation_id с другим файлом (владелец, имя, тип, размер, sha256) — 409 OSP_KEY_REUSE.
//
// Доступ: токен пользователя Supabase; строки читаются и пишутся ПОД ЕГО токеном — действует RLS.
// Одобренный и не заблокированный; подрядчику — только скачивание файлов своих договоров
// (is_my_contract). Загрузка и удаление — если владелец существует и виден пользователю и есть право
// раздела (osp_can из Р2a, WRITE_RULES). Функции osp_can нет — 503: без проверки прав не пишем.
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { sanitizeFileName } from '../lib/files.js'

// owner_type → каталог в бакете. Расширять вместе с OWNER_TABLES и WRITE_RULES.
export const FOLDER_BY_OWNER = {
  tender: 'tenders',
  contract: 'contracts',
  object: 'objects',
  counterparty: 'counterparties',
  dc_request: 'dc-requests',
  doc_check_request: 'doc-check-requests',
  general: 'general',
  general_document: 'general-documents',
  task: 'tasks',
}

// Где искать владельца файла (uuid-сущность). 'tender' — и сам тендер, и документ вкладки «Документы»
// тендера (tender_docs: TenderDocumentsTab, TenderFinalDocBlock). 'general' — ПСДЦ или заявка на ВОР.
// 'customer' из функции Supabase нигде не используется — не поддерживается.
export const OWNER_TABLES = {
  tender: ['tenders', 'tender_docs'],
  contract: ['contracts'],
  object: ['objects'],
  counterparty: ['counterparties'],
  dc_request: ['dc_requests'],
  doc_check_request: ['doc_check_requests'],
  general: ['psdc', 'vor_requests'],
  general_document: ['general_documents'],
  task: ['tasks'],
}

// Право раздела на загрузку и удаление — по таблице владельца, достаточно любого правила
// ([раздел, 'view' | 'edit'] → osp_can). Сервер разрешает ровно то, что разрешает интерфейс
// (migration/rights-map.md, «s3_documents по owner_type»):
//   • тендер — с любой страницы тендеров: пакет тендера (VorDocsModal) открыт каждому, кто видит
//     «Тендеры», «Тендеры на материалы» или «ВОРы и РД»;
//   • договор — каждому, кто видит договоры (список файлов в карточке без гейта);
//   • ПСДЦ — правка договоров (как у psdc_create); заявка на ВОР — правка тендеров или ВОР;
//   • задача — тому, кому она видна (RLS задач), без права раздела.
const TENDER_PAGES = [['tenders', 'view'], ['tenders_materials', 'view'], ['vors', 'view']]
export const WRITE_RULES = {
  tenders: TENDER_PAGES,
  tender_docs: TENDER_PAGES,
  contracts: [['contracts', 'view']],
  objects: [['objects', 'edit']],
  counterparties: [['counterparties', 'edit']],
  dc_requests: [['dc_requests', 'edit']],
  doc_check_requests: [['doc_check_requests', 'edit']],
  general_documents: [['general_documents', 'edit']],
  tasks: [],
  psdc: [['contracts', 'edit']],
  vor_requests: [['tenders', 'edit'], ['vors', 'edit']],
}
// Строки с владельцем вне списка (старые типы) удаляет только администратор.
const UNKNOWN_OWNER_RULES = [['admin', 'edit']]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const CATEGORY_RE = /^[a-z0-9_]{1,64}$/
// Что должно совпасть у повтора с тем же operation_id.
const FINGERPRINT = ['owner_type', 'owner_id', 'file_name', 'mime_type', 'size_bytes', 'sha256']
// Ошибки PostgREST «функции нет»: osp_can появляется с миграцией Р2a.
const MISSING_FUNCTION = new Set(['PGRST202', '42883'])

const NO_RIGHT = 'Нет права на файлы этого раздела'
const KEY_REUSE = { error: 'Этот ключ операции уже использован для другого файла', code: 'OSP_KEY_REUSE' }

export const UPLOAD_TTL_SEC = 15 * 60
export const DOWNLOAD_TTL_SEC = 60 * 60

class RightsUnavailable extends Error {}

const optional = (v) => (v == null || v === '' ? null : String(v))

// Поля файла из запроса upload / confirm. Ошибка — текст ответа 400.
function readFile(body) {
  const ownerType = String(body.owner_type || '')
  if (!Object.hasOwn(FOLDER_BY_OWNER, ownerType)) return { error: `Unsupported owner_type: ${ownerType}` }
  const ownerId = String(body.owner_id || '').toLowerCase()
  if (!ownerId) return { error: 'Missing owner_id' }
  const fileName = String(body.file_name || '')
  if (!fileName) return { error: 'Missing file_name' }
  // owner_id — только uuid: ни составных значений, ни «путей» в ключе бакета.
  if (!UUID_RE.test(ownerId)) return { error: 'Invalid owner_id' }
  const operationId = String(body.operation_id || '').toLowerCase()
  if (!UUID_RE.test(operationId)) return { error: 'Нет ключа операции (operation_id) — обновите страницу' }
  if (!Number.isSafeInteger(body.size_bytes) || body.size_bytes < 0) return { error: 'Invalid size_bytes' }
  const sha256 = optional(body.sha256)?.toLowerCase() ?? null
  if (sha256 !== null && !SHA256_RE.test(sha256)) return { error: 'Invalid sha256' }
  const category = optional(body.category)
  if (category !== null && !CATEGORY_RE.test(category)) return { error: 'Invalid category' }
  return {
    file: {
      operation_id: operationId,
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: fileName,
      mime_type: String(body.mime_type || 'application/octet-stream'),
      size_bytes: body.size_bytes,
      sha256,
    },
    category,
    notes: optional(body.notes),
  }
}

const sameFile = (row, file) => FINGERPRINT.every((k) => String(row[k] ?? '') === String(file[k] ?? ''))

// Ключ объекта задан ключом операции: повтор пишет в тот же объект, а не плодит новые.
const keyFor = (file) =>
  `${FOLDER_BY_OWNER[file.owner_type]}/${file.owner_id}/${file.operation_id}-${sanitizeFileName(file.file_name)}`

export function registerS3Presign(app, { config, authenticate, getS3, limiters }) {
  app.post('/api/fn/s3-presign', async (request, reply) => {
    const auth = await authenticate(request, reply)
    if (!auth) return reply
    const { supabase, user } = auth
    if (!limiters.presignRate.take(user.id)) {
      return reply.code(429).send({ error: 'Слишком много запросов к файлам — подождите минуту' })
    }

    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('counterparty_id, is_approved, is_blocked, full_name')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!roleRow || roleRow.is_approved === false || roleRow.is_blocked === true) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const isContractor = !!roleRow.counterparty_id

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

    // Таблица владельца или null: нет такой строки или она не видна пользователю (RLS).
    const ownerTable = async (ownerType, ownerId) => {
      for (const table of OWNER_TABLES[ownerType]) {
        const { data, error } = await supabase.from(table).select('id').eq('id', ownerId).maybeSingle()
        if (error) throw error
        if (data) return table
      }
      return null
    }
    // Право раздела: достаточно любого правила; пустой список — права раздела не нужно.
    const allowed = async (rules) => {
      if (!rules.length) return true
      const results = await Promise.all(rules.map(([section, kind]) =>
        supabase.rpc('osp_can', { p_section: section, p_kind: kind })))
      for (const { error } of results) {
        if (error) throw MISSING_FUNCTION.has(error.code) ? new RightsUnavailable() : error
      }
      return results.some(({ data }) => data === true)
    }
    // Загрузка и подтверждение: владелец виден и есть право его раздела. Иначе — [код, ответ].
    const uploadDenied = async (file) => {
      const table = await ownerTable(file.owner_type, file.owner_id)
      if (!table) return [404, { error: 'Владелец файла не найден' }]
      if (!await allowed(WRITE_RULES[table])) return [403, { error: NO_RIGHT }]
      return null
    }
    const findDocument = async (id) => {
      const { data, error } = await supabase.from('s3_documents').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      return data
    }
    // Ссылку по «угаданному» ключу не выдаём: строка s3_documents должна быть видна пользователю.
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

    try {
      switch (body.action) {
        case 'upload': {
          const req = readFile(body)
          if (req.error) return reply.code(400).send({ error: req.error })
          const { file } = req
          const denied = await uploadDenied(file)
          if (denied) return reply.code(denied[0]).send(denied[1])
          const existing = await findDocument(file.operation_id)
          if (existing) return sameFile(existing, file) ? { already: true, document: existing } : reply.code(409).send(KEY_REUSE)
          const s3Key = keyFor(file)
          const cmd = new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: file.mime_type })
          const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_TTL_SEC })
          return { s3_key: s3Key, presigned_url: presignedUrl, expires_in: UPLOAD_TTL_SEC }
        }

        case 'confirm': {
          const req = readFile(body)
          if (req.error) return reply.code(400).send({ error: req.error })
          const { file, category, notes } = req
          const denied = await uploadDenied(file)
          if (denied) return reply.code(denied[0]).send(denied[1])
          const existing = await findDocument(file.operation_id)
          if (existing) return sameFile(existing, file) ? { already: true, document: existing } : reply.code(409).send(KEY_REUSE)

          const s3Key = keyFor(file)
          let stored
          try {
            stored = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }))
          } catch (e) {
            if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
              return reply.code(409).send({ error: 'Файла ещё нет в хранилище — загрузка не завершилась', code: 'OSP_NOT_UPLOADED' })
            }
            throw e
          }
          if (Number(stored.ContentLength) !== file.size_bytes) {
            return reply.code(409).send({ error: 'Размер файла в хранилище не совпадает с выбранным', code: 'OSP_SIZE_MISMATCH' })
          }

          const row = {
            id: file.operation_id,
            owner_type: file.owner_type,
            owner_id: file.owner_id,
            s3_key: s3Key,
            file_name: file.file_name,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
            sha256: file.sha256,
            notes,
            uploaded_by: user.id,
            uploaded_by_name: roleRow.full_name || null,
            ...(category ? { doc_category: category } : {}),
          }
          const { data, error } = await supabase.from('s3_documents').insert(row).select('*').single()
          if (error) {
            // Параллельный повтор успел первым — та же строка; другой файл с этим ключом — отказ.
            if (error.code === '23505') {
              const again = await findDocument(file.operation_id)
              if (again && sameFile(again, file)) return { already: true, document: again }
              return reply.code(409).send(KEY_REUSE)
            }
            if (error.code === '42501') return reply.code(403).send({ error: NO_RIGHT })
            throw error
          }
          return { document: data }
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
          const { data: doc, error } = await supabase
            .from('s3_documents')
            .select('id, owner_type, owner_id')
            .eq('s3_key', s3Key)
            .maybeSingle()
          if (error) throw error
          // Строки нет (или не видна): повтор удаления — уже сделано; объект без строки не трогаем.
          if (!doc) return { ok: true, already: true }
          let rules = UNKNOWN_OWNER_RULES
          if (Object.hasOwn(OWNER_TABLES, doc.owner_type)) {
            const table = await ownerTable(doc.owner_type, doc.owner_id)
            // Владельца уже нет — достаточно права любой его таблицы.
            rules = table ? WRITE_RULES[table] : OWNER_TABLES[doc.owner_type].flatMap((t) => WRITE_RULES[t])
          }
          if (!await allowed(rules)) return reply.code(403).send({ error: NO_RIGHT })

          // Сначала строка: документа, указывающего на удалённый файл, не бывает. Сбой хранилища
          // оставляет только объект без строки.
          const { data: gone, error: deleteError } = await supabase
            .from('s3_documents')
            .delete()
            .eq('id', doc.id)
            .select('id')
          if (deleteError) {
            if (deleteError.code === '42501') return reply.code(403).send({ error: NO_RIGHT })
            throw deleteError
          }
          if (!gone?.length) return { ok: true, already: true } // параллельный запрос удалил раньше
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }))
          } catch (e) {
            request.log.warn({ document: doc.id, msg: e?.message }, 's3 object left without row')
            return { ok: true, object_deleted: false }
          }
          return { ok: true }
        }

        default:
          return reply.code(400).send({ error: `Unknown action: ${body.action}` })
      }
    } catch (e) {
      if (e instanceof RightsUnavailable) {
        return reply.code(503).send({ error: 'Проверка прав недоступна: нет функции osp_can (миграция Р2a)', code: 'OSP_RIGHTS_UNAVAILABLE' })
      }
      request.log.error({ msg: e?.message }, 's3-presign')
      return reply.code(500).send({ error: e?.message || 'Internal error' })
    }
  })
}
