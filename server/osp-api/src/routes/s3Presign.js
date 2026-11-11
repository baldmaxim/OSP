// POST /api/fn/s3-presign — файлы документов через osp-api (заход Б, Р5-ядро). Его вызывают сборки с
// флагом ospApiFilesV2 и любой браузер с данными в базе Яндекса (ospDb, src/api/serverPath.js). Иначе
// файлы идут через Edge Function Supabase `s3-presign` — её протокол здесь не повторяется.
//
//   upload   { operation_id, owner_type, owner_id, file_name, mime_type, size_bytes, sha256? }
//            → { s3_key, presigned_url, expires_in } — ссылка на PUT; ключ объекта задан operation_id
//            → { already: true, document }          — документ этой операции уже есть
//   confirm  { те же поля, category?, notes? }      → { document } — объект в бакете есть и того же
//            размера → строка s3_documents с id = operation_id; повтор — { already: true, document }
//   download { s3_key, file_name?, download? }      → { presigned_url, expires_in }
//   delete   { s3_key }                             → { ok: true } — сначала строка, затем объект;
//            строки уже нет (повтор) — { ok: true, already: true }
//   rename   { s3_key, file_name }                  → { document } — новое имя в строке s3_documents (право — как у
//            удаления), расширение прежнее (shared/fileRename.js); объект в хранилище и его ключ не меняются
//   describe { s3_key, notes }                      → { document } — описание файла заявки на ДС (право — как у удаления);
//            пустое снимает описание. У других файлов notes — служебные данные (строки счёта, паспорт ДГП): 400
//   supply-notes { document_id, notes, only_if? }   → { ok, changed } — распознанные строки счёта или КП поставщика при файле
//            расценки снабжения (категория supply_doc тендера; право — правка «Тендеров» или «Тендеров на материалы»).
//            only_if: null — только если строк при файле ещё нет; строка — только если при файле ещё она (фоновое чтение
//            не затирает выбор человека). Прямая правка строк s3_documents через шлюз закрыта (src/data/db-sections.json).
//
// Перенос данных (шлюз включён, src/app.js):
//   • барьер записи — upload, confirm, delete, rename и describe отвечают 503 OSP_READONLY, скачивание работает;
//   • репетиция (копия за шлюзом не рабочая, src/lib/loadStatus.js) — хранилище у неё общее с рабочим
//     порталом: delete убирает строку, а объект — только если документ создан уже в репетиции. Объект,
//     который был до загрузки копии, принадлежит рабочим данным и остаётся: { ok, object_deleted: false };
//   • и после окончательной загрузки хранилище общее с прежним порталом (osp.root.sx на Supabase работает
//     дальше): объект документа, созданного до загрузки, остаётся — на него ссылается прежний портал
//     ({ ok, object_deleted: false, shared: true }). Выключается OSP_KEEP_PRE_TRANSFER_FILES=0, когда
//     прежнего портала нет.
//
// Ключ операции один на выбранный файл: повтор любого шага не создаёт второй документ и второй объект.
// Тот же operation_id с другим файлом (владелец, имя, тип, размер, sha256) — 409 OSP_KEY_REUSE.
//
// Права (11.11.2026): загрузка — WRITE_RULES (как было); изменение и удаление — CHANGE_RULES по таблице владельца и категории
// (правка раздела, а не просмотр); скачивание — строка видна, ключ в каталоге своего владельца, владелец виден и есть
// право чтения его раздела (READ_RULES). Предел размера — по категории; ссылка на загрузку подписывает тип и длину;
// выданные, но не подтверждённые загрузки учитываются (osp_private.s3_upload_intents) и убираются (cleanupUploadIntents).
//
// Доступ: токен пользователя Supabase; строки читаются и пишутся ПОД ЕГО токеном — действует RLS.
// Одобренный и не заблокированный; подрядчику — только скачивание: файлы своих договоров (is_my_contract) и
// пакет, ВОР и РД тендера, которые ему показывает правило s3_documents. Загрузка и удаление — если владелец существует и виден пользователю и есть право
// раздела (osp_can из Р2a, WRITE_RULES). Функции osp_can нет — 503: без проверки прав не пишем.
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { sanitizeFileName } from '../lib/files.js'
import { fileNameProblem } from '../shared/fileRename.js'
import { z } from 'zod'
import { access } from '../lib/access.js'
import { isFinalLoad, createdAfterLoad } from '../lib/loadStatus.js'
import { READONLY_CODE, READONLY_TEXT } from '../lib/writeBarrier.js'
import { cleanupUploadIntents, createUploadIntents } from '../lib/uploadIntents.js'

// owner_type → каталог в бакете. Расширять вместе с OWNER_TABLES и WRITE_RULES.
export const FOLDER_BY_OWNER = {
  tender: 'tenders',
  contract: 'contracts',
  object: 'objects',
  counterparty: 'counterparties',
  dc_request: 'dc-requests',
  dp_request: 'dp-requests',
  doc_check_request: 'doc-check-requests',
  general: 'general',
  general_document: 'general-documents',
  task: 'tasks',
}

// Где искать владельца файла (uuid-сущность). 'tender' — и сам тендер, и документ вкладки «Документы»
// тендера (tender_docs: TenderDocumentsTab, TenderFinalDocBlock). 'general' — ПСДЦ, заявка на ВОР, шаблон
// раздела (section_templates: «Понятийное соглашение» тендеров, «Шаблон Было-Стало» заявок на ДС) или расценка
// реестра КП, добавленная вручную (kp_manual_rates, 20261122: документ, откуда взята расценка).
// 'customer' из функции Supabase нигде не используется — не поддерживается.
export const OWNER_TABLES = {
  tender: ['tenders', 'tender_docs'],
  contract: ['contracts'],
  object: ['objects'],
  counterparty: ['counterparties'],
  dc_request: ['dc_requests'],
  dp_request: ['dp_requests'],
  doc_check_request: ['doc_check_requests'],
  general: ['psdc', 'vor_requests', 'section_templates', 'kp_manual_rates'],
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
//   • шаблон раздела — только администратор (osp_can('admin', …) = is_admin()): файл скачивают все разделы;
//   • документ ручной расценки реестра КП — правка «Реестра расценок» (как сама строка);
//   • задача — тому, кому она видна (RLS задач), без права раздела.
const TENDER_PAGES = [['tenders', 'view'], ['tenders_materials', 'view'], ['vors', 'view']]
export const WRITE_RULES = {
  tenders: TENDER_PAGES,
  tender_docs: TENDER_PAGES,
  contracts: [['contracts', 'view']],
  objects: [['objects', 'edit']],
  counterparties: [['counterparties', 'edit']],
  dc_requests: [['dc_requests', 'edit']],
  // Заявка на заключение ДП (20261227): автор — право создания, остальные — работа с заявками. Какую заявку можно менять, решает
  // триггер базы s3_documents_dp_request_guard: здесь нет разницы между своей заявкой и чужой.
  dp_requests: [['dp_requests', 'edit'], ['dp_requests_create', 'edit']],
  // Заявки на проверку ДП/ДС: право правки раздела; право создания (20270102) — автору, к своей заявке, пока она в «Новых»:
  // какую заявку можно, решает триггер базы s3_documents_doc_check_guard, как у заявки на ДП.
  doc_check_requests: [['doc_check_requests', 'edit'], ['doc_check_requests_create', 'edit']],
  general_documents: [['general_documents', 'edit']],
  tasks: [],
  psdc: [['contracts', 'edit']],
  vor_requests: [['tenders', 'edit'], ['vors', 'edit']],
  section_templates: [['admin', 'edit']],
  // Документ расценки, добавленной в реестр вручную (20261122): как сама строка — право правки «Реестра расценок».
  kp_manual_rates: [['rates_registry', 'edit']],
}
// Изменение и удаление существующего файла (delete, rename, describe) — правка раздела, а не просмотр. По таблице владельца и
// категории; чего нет здесь — как WRITE_RULES (там уже правка). Файлы тендера: ВОР и РД — ещё и правка «ВОРов и РД»
// (сметно-технический отдел); КП, пакет, документы участников, счета снабжения — правка «Тендеров» или «Тендеров на
// материалы»; «ВОРы и РД» прочие файлы тендера не меняют. Файл задачи — см. mayChangeDoc (загрузивший, автор задачи).
const TENDER_CHANGE = [['tenders', 'edit'], ['tenders_materials', 'edit']]
const VOR_CHANGE = [['tenders', 'edit'], ['tenders_materials', 'edit'], ['vors', 'edit']]
export const CHANGE_RULES = {
  tenders: { default: TENDER_CHANGE, vor: VOR_CHANGE, vor_statement: VOR_CHANGE, rd: VOR_CHANGE },
  tender_docs: { default: TENDER_CHANGE },
  contracts: { default: [['contracts', 'edit']] },
  vor_requests: { default: [['tenders', 'edit'], ['vors', 'edit']] },
}
// Скачивание: право чтения раздела владельца (вторым замком к правилу базы по строкам s3_documents, 20270120). Пустой
// список — достаточно видеть владельца (задача, заявки: их строки режут свои правила; объект — справочник).
export const READ_RULES = {
  tenders: TENDER_PAGES,
  tender_docs: TENDER_PAGES,
  contracts: [['contracts', 'view']],
  objects: [],
  counterparties: [['counterparties', 'view']],
  dc_requests: [['dc_requests', 'view']],
  dp_requests: [],
  doc_check_requests: [],
  general_documents: [['general_documents', 'view']],
  tasks: [],
  psdc: [['contracts', 'view']],
  vor_requests: [['tenders', 'view'], ['vors', 'view']],
  section_templates: [],
  kp_manual_rates: [['rates_registry', 'view']],
}
// Предел размера (решение 11.11.2026): РД, ВОР и тендерный пакет — больше (PDF чертежей), остальное — общий.
export const LARGE_CATEGORIES = new Set(['vor', 'vor_statement', 'rd', 'tender_package', 'vor_request_rd', 'vor_request_vor'])
// Строки распознанного документа поставщика: тело маршрута ограничено 2 МБ.
const SUPPLY_NOTES_MAX = 1_900_000
const SUPPLY_DOC = 'supply_doc'
const SUPPLY_NOTES_RULES = [['tenders', 'edit'], ['tenders_materials', 'edit']]

// Строки с владельцем вне списка (старые типы) удаляет только администратор.
const UNKNOWN_OWNER_RULES = [['admin', 'edit']]
// Категории со своим правом вместо права раздела владельца (таблица владельца → doc_category → правила): документы
// «Расчёта ПЗ» объекта («Прямые затраты», «КП до перекидок» — «Планы затрат» → «Документы» → «Расчёт ПЗ») загружает и
// удаляет обладатель права cost_plan_docs (20261130: администратор и экономист ОСП). Правка «Объектов» для них не
// нужна и не даёт ничего, а это право не открывает прочие файлы объекта. Категорию присылает клиент (upload, confirm),
// при удалении она берётся из строки. Кто и когда — журнал cost_plan_calc_file_log, его пишет триггер базы.
export const CATEGORY_RULES = {
  objects: {
    cost_plan_direct_costs: [['cost_plan_docs', 'edit']],
    cost_plan_kp_before_transfers: [['cost_plan_docs', 'edit']],
  },
}
const rulesFor = (table, category) => {
  const own = CATEGORY_RULES[table]
  return own && Object.hasOwn(own, category || '') ? own[category] : WRITE_RULES[table]
}
const changeRulesFor = (table, category) => {
  const own = CATEGORY_RULES[table]
  if (own && Object.hasOwn(own, category || '')) return own[category]
  const change = CHANGE_RULES[table]
  if (change) return Object.hasOwn(change, category || '') ? change[category] : change.default
  return WRITE_RULES[table]
}
const maxBytesFor = (category, limits) => (LARGE_CATEGORIES.has(category || '') ? limits.uploadMaxBytesRd : limits.uploadMaxBytes)
const keyInOwnerFolder = (doc) =>
  Object.hasOwn(FOLDER_BY_OWNER, doc.owner_type)
  && String(doc.s3_key || '').startsWith(`${FOLDER_BY_OWNER[doc.owner_type]}/${String(doc.owner_id || '').toLowerCase()}/`)

// Уборка незавершённых загрузок — src/lib/uploadIntents.js (cleanupUploadIntents), запускает служба по такту.
export { cleanupUploadIntents }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Ключ операции — только UUIDv7 (его выдаёт портал, src/utils/uuid.js): ключи файлов прежнего портала содержат UUIDv4,
// и с v4 в operation_id можно было собрать ключ чужого файла и получить ссылку на перезапись его содержимого.
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const CATEGORY_RE = /^[a-z0-9_]{1,64}$/
// Что должно совпасть у повтора с тем же operation_id.
const FINGERPRINT = ['owner_type', 'owner_id', 'file_name', 'mime_type', 'size_bytes', 'sha256']
// Ошибки PostgREST «функции нет»: osp_can появляется с миграцией Р2a.
const MISSING_FUNCTION = new Set(['PGRST202', '42883'])

// Файлы тендера, которые подрядчику открывает правило s3_documents (портал: свой тендер или заявка не отклонена).
const CONTRACTOR_TENDER_CATEGORIES = new Set(['tender_package', 'vor', 'rd', 'vor_statement'])

const NO_RIGHT = 'Нет права на файлы этого раздела'
const KEY_REUSE = { error: 'Этот ключ операции уже использован для другого файла', code: 'OSP_KEY_REUSE' }

export const UPLOAD_TTL_SEC = 15 * 60
export const DOWNLOAD_TTL_SEC = 60 * 60
// Скачивание (не превью) — под исходным именем: filename= — ASCII, filename*= — UTF-8.
export const attachmentDisposition = (name) => `attachment; filename="${sanitizeFileName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`

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
  if (!UUID_V7_RE.test(operationId)) return { error: 'Нет ключа операции (operation_id) — обновите страницу' }
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

// Поля запроса — явным перечнем: остальное отбрасывается до обработчика. Значения проверяет обработчик
// (readFile и ветки действий; тексты отказов — как у прежней функции).
const any = z.unknown().optional()
export const PRESIGN_BODY = z.object({
  action: any,
  owner_type: any,
  owner_id: any,
  file_name: any,
  operation_id: any,
  size_bytes: any,
  sha256: any,
  category: any,
  mime_type: any,
  notes: any,
  s3_key: any,
  download: any,
  document_id: any,
  only_if: any,
})

const WRITE_ACTIONS = new Set(['upload', 'confirm', 'delete', 'rename', 'describe', 'supply-notes'])
const DOC_NOTE_MAX = 500

export function registerS3Presign(app, { config, getS3, gatewayOn = false, isReadOnly = () => false, loadStatus = null, db = null, getServiceClient = null, security = null }) {
  const limits = {
    uploadMaxBytes: security?.uploadMaxBytes ?? 100 * 1024 * 1024,
    uploadMaxBytesRd: security?.uploadMaxBytesRd ?? 300 * 1024 * 1024,
  }
  // Учёт выданной ссылки на загрузку (src/lib/uploadIntents.js): незавершённых загрузок на пользователя — с пределом.
  const intents = createUploadIntents({ db })

  // Есть ли владелец вообще — без правил по строкам: «не виден пользователю» и «удалён» — разные случаи. Своя база —
  // служебной операцией, иначе — служебным клиентом. Проверить не удалось — считаем, что есть: отказ лучше, чем открыть.
  const ownerExists = async (ownerType, ownerId, log) => {
    const tables = OWNER_TABLES[ownerType] || []
    try {
      if (db) {
        return await db.read(null, async (tx) => {
          await tx.mark('internal')
          for (const t of tables) {
            if ((await tx.query(`select 1 from public.${t} where id = $1`, [ownerId])).rows.length) return true
          }
          return false
        })
      }
      const service = getServiceClient ? getServiceClient() : null
      if (service) {
        for (const t of tables) {
          const { data, error } = await service.from(t).select('id').eq('id', ownerId).maybeSingle()
          if (error) throw error
          if (data) return true
        }
        return false
      }
    } catch (err) {
      log?.warn({ code: err?.code, msg: String(err?.message || err).slice(0, 120) }, 's3-presign owner check')
    }
    return true
  }

  app.route({ method: 'POST', url: '/api/fn/s3-presign', config: {
    // Вошедший, одобренный и не заблокированный: сотрудник или подрядчик. Что именно ему можно с
    // конкретным файлом (чужой договор, право раздела) — ниже, по данным записи.
    access: access.user({
      require: 'approved',
      deny: 'Forbidden',
      rate: { limiter: 'presignRate', deny: 'Слишком много запросов к файлам — подождите минуту' },
    }),
    body: PRESIGN_BODY,
  }, handler: async (request, reply) => {
    const { supabase, user, roleRow } = request.auth
    // Подрядчик — по организации или по роли: учётка с ролью подрядчика без организации не получает
    // действий сотрудника (раньше её останавливала только проверка права раздела в базе).
    const isContractor = !!roleRow.counterparty_id || roleRow.role === 'contractor'

    const body = request.body
    if (isContractor && body.action !== 'download') {
      return reply.code(403).send({ error: 'Действие доступно только сотрудникам' })
    }
    if (WRITE_ACTIONS.has(body.action) && isReadOnly()) {
      return reply.code(503).send({ error: READONLY_TEXT, code: READONLY_CODE })
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
    // Право на существующий файл (удаление, переименование, описание): по таблице владельца и категории.
    //   • ключ объекта не в каталоге своего владельца — строку переставили на другого владельца (строки s3_documents
    //     меняет любой сотрудник через шлюз): только администратор;
    //   • владелец есть, но не виден пользователю — отказ (раньше считался удалённым, и у задачи правил не было вовсе);
    //   • владельца правда нет — право любой его таблицы, а если правил нет (задача) — администратор.
    const DENY = null
    const rulesForDoc = async (doc) => {
      if (!Object.hasOwn(OWNER_TABLES, doc.owner_type)) return UNKNOWN_OWNER_RULES
      if (!keyInOwnerFolder(doc)) return UNKNOWN_OWNER_RULES
      const table = await ownerTable(doc.owner_type, doc.owner_id)
      if (table) return { table, rules: changeRulesFor(table, doc.doc_category) }
      if (await ownerExists(doc.owner_type, doc.owner_id, request.log)) return DENY
      const union = OWNER_TABLES[doc.owner_type].flatMap((t) => changeRulesFor(t, doc.doc_category))
      return union.length ? union : UNKNOWN_OWNER_RULES
    }
    // Файл задачи меняет загрузивший (uploaded_by ставит сервер, менять его нельзя — триггер базы), автор задачи или
    // администратор; просто видеть задачу мало.
    const mayChangeTaskDoc = async (doc) => {
      if (doc.uploaded_by && doc.uploaded_by === user.id) return true
      const { data, error } = await supabase.from('tasks').select('created_by_user_id').eq('id', doc.owner_id).maybeSingle()
      if (error) throw error
      if (data?.created_by_user_id === user.id) return true
      return allowed(UNKNOWN_OWNER_RULES)
    }
    const mayChangeDoc = async (doc) => {
      const found = await rulesForDoc(doc)
      if (found === DENY) return false
      if (Array.isArray(found)) return allowed(found)
      if (found.table === 'tasks') return mayChangeTaskDoc(doc)
      return allowed(found.rules)
    }
    // Загрузка и подтверждение: владелец виден и есть право его раздела (или категории). Иначе — [код, ответ].
    const uploadDenied = async (file, category) => {
      const table = await ownerTable(file.owner_type, file.owner_id)
      if (!table) return [404, { error: 'Владелец файла не найден' }]
      if (!await allowed(rulesFor(table, category))) return [403, { error: NO_RIGHT }]
      return null
    }
    const findDocument = async (id) => {
      const { data, error } = await supabase.from('s3_documents').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      return data
    }
    // Ссылку по «угаданному» ключу не выдаём: строка s3_documents должна быть видна пользователю, ключ — лежать в каталоге
    // своего владельца (иначе строку переставили на другого владельца — только администратор). Сотруднику ещё нужно видеть
    // владельца и иметь право чтения его раздела (READ_RULES).
    const assertKeyAllowed = async (s3Key) => {
      const { data, error } = await supabase
        .from('s3_documents')
        .select('id, owner_type, owner_id, doc_category, s3_key')
        .eq('s3_key', s3Key)
        .maybeSingle()
      if (error) throw error
      if (!data) return false
      if (!keyInOwnerFolder(data) || !Object.hasOwn(OWNER_TABLES, data.owner_type)) return !isContractor && allowed(UNKNOWN_OWNER_RULES)
      if (!isContractor) {
        const table = await ownerTable(data.owner_type, data.owner_id)
        if (!table) return false
        return allowed(READ_RULES[table] || UNKNOWN_OWNER_RULES)
      }
      // Подрядчик: строку файла тендера правила базы уже показали только ему; категории — вторым замком.
      if (data.owner_type === 'tender') return CONTRACTOR_TENDER_CATEGORIES.has(data.doc_category)
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
          const { file, category } = req
          const max = maxBytesFor(category, limits)
          if (file.size_bytes > max) {
            return reply.code(413).send({ error: `Файл больше ${Math.round(max / 1024 / 1024)} МБ — такой загрузить нельзя`, code: 'OSP_FILE_TOO_LARGE' })
          }
          const denied = await uploadDenied(file, category)
          if (denied) return reply.code(denied[0]).send(denied[1])
          const existing = await findDocument(file.operation_id)
          if (existing) return sameFile(existing, file) ? { already: true, document: existing } : reply.code(409).send(KEY_REUSE)
          const s3Key = keyFor(file)
          const busy = await intents.note(s3Key, user.id, file.size_bytes)
          if (busy) return reply.header('retry-after', '300').code(429).send({ error: busy, code: 'OSP_UPLOADS_PENDING' })
          // Тип и длина входят в подпись: загрузить по ссылке можно только заявленный файл (тип — как заявлен, размер — точно).
          const cmd = new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: file.mime_type, ContentLength: file.size_bytes })
          const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_TTL_SEC, signableHeaders: new Set(['content-type', 'content-length']) })
          return { s3_key: s3Key, presigned_url: presignedUrl, expires_in: UPLOAD_TTL_SEC }
        }

        case 'confirm': {
          const req = readFile(body)
          if (req.error) return reply.code(400).send({ error: req.error })
          const { file, category, notes } = req
          if (file.size_bytes > maxBytesFor(category, limits)) return reply.code(413).send({ error: 'Файл слишком большой', code: 'OSP_FILE_TOO_LARGE' })
          const denied = await uploadDenied(file, category)
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
          await intents.drop(s3Key)
          return { document: data }
        }

        case 'download': {
          const s3Key = String(body.s3_key || '')
          if (!s3Key) return reply.code(400).send({ error: 'Missing s3_key' })
          if (!await assertKeyAllowed(s3Key)) return reply.code(404).send({ error: 'Файл не найден' })
          const rawName = String(body.file_name || '')
          const wantDownload = body.download === true || body.download === 'true'
          const params = { Bucket: bucket, Key: s3Key }
          if (wantDownload && rawName) params.ResponseContentDisposition = attachmentDisposition(rawName)
          const presignedUrl = await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: DOWNLOAD_TTL_SEC })
          return { presigned_url: presignedUrl, expires_in: DOWNLOAD_TTL_SEC }
        }

        case 'delete': {
          const s3Key = String(body.s3_key || '')
          if (!s3Key) return reply.code(400).send({ error: 'Missing s3_key' })
          const { data: doc, error } = await supabase
            .from('s3_documents')
            .select('id, owner_type, owner_id, doc_category, created_at, s3_key, uploaded_by')
            .eq('s3_key', s3Key)
            .maybeSingle()
          if (error) throw error
          // Строки нет (или не видна): повтор удаления — уже сделано; объект без строки не трогаем.
          if (!doc) return { ok: true, already: true }
          if (!await mayChangeDoc(doc)) return reply.code(403).send({ error: NO_RIGHT })

          // Перенос данных: решаем до удаления строки, остаётся ли объект в хранилище. Документ пришёл с
          // данными прежнего портала — объект его, пока тот работает (в репетиции — всегда).
          let keepObject = false
          let final = false
          if (gatewayOn) {
            const load = loadStatus ? await loadStatus.current() : null
            final = isFinalLoad(load)
            keepObject = !createdAfterLoad(doc.created_at, load?.loadedAt) && (!final || config.keepPreTransferFiles !== false)
          }

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
          if (keepObject && !final) {
            request.log.info({ document: doc.id }, 'rehearsal: s3 object kept')
            return { ok: true, object_deleted: false, rehearsal: true }
          }
          if (keepObject) {
            request.log.info({ document: doc.id }, 'shared with the previous portal: s3 object kept')
            return { ok: true, object_deleted: false, shared: true }
          }
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }))
          } catch (e) {
            request.log.warn({ document: doc.id, msg: e?.message }, 's3 object left without row')
            return { ok: true, object_deleted: false }
          }
          return { ok: true }
        }

        case 'rename':
        case 'describe': {
          const s3Key = String(body.s3_key || '')
          if (!s3Key) return reply.code(400).send({ error: 'Missing s3_key' })
          const { data: doc, error } = await supabase
            .from('s3_documents')
            .select('id, owner_type, owner_id, doc_category, file_name, s3_key, uploaded_by')
            .eq('s3_key', s3Key)
            .maybeSingle()
          if (error) throw error
          if (!doc) return reply.code(404).send({ error: 'Файл не найден' })
          if (!await mayChangeDoc(doc)) return reply.code(403).send({ error: NO_RIGHT })
          let patch
          if (body.action === 'rename') {
            const fileName = String(body.file_name ?? '')
            const problem = fileNameProblem(fileName, doc.file_name)
            if (problem) return reply.code(400).send({ error: problem })
            patch = { file_name: fileName }
          } else {
            if (doc.owner_type !== 'dc_request') return reply.code(400).send({ error: 'У этого файла нет описания' })
            const notes = String(body.notes ?? '').trim()
            if (notes.length > DOC_NOTE_MAX) return reply.code(400).send({ error: `Описание длиннее ${DOC_NOTE_MAX} знаков` })
            patch = { notes: notes || null }
          }
          const { data: saved, error: updateError } = await supabase
            .from('s3_documents')
            .update(patch)
            .eq('id', doc.id)
            .select('*')
          if (updateError) {
            if (updateError.code === '42501') return reply.code(403).send({ error: NO_RIGHT })
            throw updateError
          }
          // Правка, не задевшая строку (правило базы, файл только что удалили), — ошибка, а не молчание.
          if (!saved?.length) return reply.code(404).send({ error: 'Файл не найден' })
          return { document: saved[0] }
        }

        case 'supply-notes': {
          const id = String(body.document_id || '').toLowerCase()
          if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'Missing document_id' })
          const notes = body.notes == null ? null : String(body.notes)
          if (notes !== null && notes.length > SUPPLY_NOTES_MAX) return reply.code(413).send({ error: 'Слишком много строк документа' })
          const onlyIf = body.only_if === undefined ? undefined : body.only_if === null ? null : String(body.only_if)
          const { data: doc, error } = await supabase
            .from('s3_documents')
            .select('id, owner_type, owner_id, doc_category, s3_key')
            .eq('id', id)
            .maybeSingle()
          if (error) throw error
          if (!doc) return reply.code(404).send({ error: 'Файл не найден' })
          // Только файл расценки снабжения тендера, в каталоге своего тендера, тендер виден, есть право правки расценки.
          if (doc.owner_type !== 'tender' || doc.doc_category !== SUPPLY_DOC || !keyInOwnerFolder(doc)) {
            return reply.code(403).send({ error: 'Это не документ поставщика расценки снабжения' })
          }
          if (await ownerTable(doc.owner_type, doc.owner_id) !== 'tenders') return reply.code(404).send({ error: 'Тендер не найден' })
          if (!await allowed(SUPPLY_NOTES_RULES)) return reply.code(403).send({ error: NO_RIGHT })
          // Права и видимость проверены под токеном пользователя выше. Своя база — одной служебной правкой с условием
          // параметром (строки счёта бывают в сотни КБ — в адрес запроса к PostgREST условие не помещается).
          if (db) {
            const changed = await db.write(null, async (tx) => {
              await tx.mark('internal')
              const r = await tx.query(
                `update public.s3_documents set notes = $1 where id = $2 and ($3::boolean is false or notes is not distinct from $4)`,
                [notes, doc.id, onlyIf !== undefined, onlyIf ?? null])
              return r.rowCount
            })
            return { ok: true, changed }
          }
          let q = supabase.from('s3_documents').update({ notes }).eq('id', doc.id)
          if (onlyIf === null) q = q.is('notes', null)
          else if (onlyIf !== undefined) q = q.eq('notes', onlyIf)
          const { data: saved, error: updateError } = await q.select('id')
          if (updateError) {
            if (updateError.code === '42501') return reply.code(403).send({ error: NO_RIGHT })
            throw updateError
          }
          return { ok: true, changed: saved?.length || 0 }
        }

        default:
          return reply.code(400).send({ error: `Unknown action: ${body.action}` })
      }
    } catch (e) {
      if (e instanceof RightsUnavailable) {
        return reply.code(503).send({ error: 'Проверка прав недоступна: нет функции osp_can (миграция Р2a)', code: 'OSP_RIGHTS_UNAVAILABLE' })
      }
      request.log.error({ msg: e?.message }, 's3-presign')
      // Текст исключения (адрес хранилища, ошибка базы) клиенту не уходит — только в журнал службы.
      return reply.code(500).send({ error: 'Не удалось выполнить действие с файлом — повторите позже' })
    }
  } })
}
