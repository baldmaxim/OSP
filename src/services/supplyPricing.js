// Расценка материалов ВОР снабжением на сайте (миграция 20261020, страница /tenders/materials/:id/pricing).
//
// Расценки живут в прежней таблице tender_vor_supply_rates основного тендера: по ней уже строятся вкладка
// «Расценки снабжения» карточки, «Сравнение КП», выгрузка ВОР и реестр «Расценки от снабжения СУ-10».
// Позиции для расценки — tender_supply_sources (разобранный лист «Материалы» файла ВОР или вкладка «ВОР»).
//
// Расчёт цены и суммы, права, версия строки и закрытие после завершения тендера на материалы — в базе
// (триггеры и правила по строкам), поэтому одинаково и для этой страницы, и для импорта в карточке.
// Отсюда — только чтение и запись с проверкой версии: правка со старой версией не проходит, и чужая цена
// не перетирается молча.
import { db } from '../api'
import { fetchAllRows, fetchAllRowsParallel } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { isAuthError, SESSION_EXPIRED_MESSAGE } from '../utils/supabaseError'
import { deleteDocument, fetchFileBytes, uploadFile } from './s3'
import { VOR_STATEMENT_CATEGORY, LEGACY_VOR_CATEGORY, isNetworkError } from './tenderVorRd'
import { isWorkbookFileName } from '../utils/vorFiles'
// Библиотека Excel (vorMaterialsSheet → xlsx, 430 КБ) — только по требованию: сервис импортирует и реестр
// тендеров (прогресс расценки), которому она не нужна.

// Статусы тендера на материалы, после которых расценки только для чтения (как supply_rates_locked в базе).
export const MATERIALS_LOCK_STATUSES = ['Завершён', 'Завершен']

export const RATE_COLUMNS = 'id, tender_id, estimate_name, material_name, unit, supply_price, supply_price_exact, supply_total, '
  + 'price_input, input_value, volume_at_input, row_version, updated_by, updated_at, created_at, material_key'
// Цены из других тендеров (миграция 20261023): день расценки и откуда скопирована цена. Колонок ещё нет — цены
// читаются без них (таблица работает как раньше); проверяется один раз за сеанс.
const REUSE_COLUMNS = ', price_date, price_by, source_rate_id, source_tender_id, source_kind'
let reuseColumns = true
const rateColumns = () => (reuseColumns ? RATE_COLUMNS + REUSE_COLUMNS : RATE_COLUMNS)
const isMissingColumn = (e) => ['42703', 'PGRST204'].includes(String(e?.code || ''))
// Запрос цен (ответ { data, error }): новых колонок нет — тот же запрос без них.
async function withRateColumns(run) {
  const res = await run(rateColumns())
  if (res?.error && reuseColumns && isMissingColumn(res.error)) {
    reuseColumns = false
    return run(rateColumns())
  }
  return res
}
export const SOURCE_COLUMNS = 'id, tender_id, estimate_name, source, s3_document_id, file_name, sheet_name, column_map, '
  + 'source_version, positions, positions_count, row_version, parsed_by, parsed_at, created_at'
// Версии ВОР (миграция 20261029): прежние файлы ВОР и ответ «отдельный ВОР». Колонок ещё нет — списки читаются без них
// (как до миграции); проверяется один раз за сеанс.
const VERSION_SOURCE_COLUMNS = ', prior_document_ids, separate_at, separate_by'
let versionColumns = true
const sourceColumns = () => (versionColumns ? SOURCE_COLUMNS + VERSION_SOURCE_COLUMNS : SOURCE_COLUMNS)
async function withSourceColumns(run) {
  const res = await run(sourceColumns())
  if (res?.error && versionColumns && isMissingColumn(res.error)) {
    versionColumns = false
    return run(sourceColumns())
  }
  return res
}
const TENDER_COLUMNS = 'id, tender_type, parent_tender_id, public_tender_number, work_description, status, deleted_at, object_id, '
  + 'materials_proposal_start_date, materials_proposal_deadline, materials_resp_user_id, materials_resp_name, materials_priority, '
  + 'objects(name, status)'

// ── Ошибки ──────────────────────────────────────────────────────────────────────────────────────────
// kind: missing — раздел ещё не включён (миграция не применена); locked — тендер завершён; forbidden — нет
// права; conflict — строку уже изменили; invalid — база отвергла значение (текст — от неё); retry — сеть,
// перенос данных или перегрузка (повторить); auth — сессия истекла; error — прочее.
export function classifyError(err) {
  if (!err) return null
  const code = String(err.code || '')
  const msg = String(err.message || '')
  if (['42P01', 'PGRST205', '42703', 'PGRST204', '42883', 'PGRST202'].includes(code)) {
    return { kind: 'missing', message: 'Расценка на сайте ещё не включена: на сервере не применено обновление базы. Сообщите администратору.' }
  }
  if (err.hint === 'supply_locked' || /только для чтения/.test(msg)) {
    return { kind: 'locked', message: 'Тендер на материалы завершён — расценки только для чтения. Чтобы изменить, верните тендеру прежний статус.' }
  }
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return { kind: 'forbidden', message: 'Нет права менять расценки снабжения (нужно «Тендеры на материалы» или «Тендеры» с правкой).' }
  }
  if (code === '23505') return { kind: 'conflict', message: 'Эту позицию уже расценили — обновите значение.' }
  if (code === '23514' || code === '22023') return { kind: 'invalid', message: msg || 'Значение не принято' }
  if (isAuthError(err)) return { kind: 'auth', message: SESSION_EXPIRED_MESSAGE }
  if (code === 'OSP_READONLY') return { kind: 'retry', message: 'Идёт перенос данных — сохраним, как только запись снова будет доступна.' }
  if (isNetworkError(err) || ['57014', 'PGRST003', '503', '504'].includes(code) || err.status >= 500) {
    return { kind: 'retry', message: 'Нет связи с сервером — сохраним при повторе.' }
  }
  return { kind: 'error', message: msg || 'Не удалось сохранить' }
}

const fail = (error) => { throw Object.assign(new Error(classifyError(error)?.message || error?.message), { cause: error, kind: classifyError(error)?.kind }) }

// ── Тендер ──────────────────────────────────────────────────────────────────────────────────────────
// id — тендер на материалы (обычный вход) или основной тендер (вход из карточки, если тендера на материалы
// нет). Расценки привязаны к основному: mainId. Закрыто, если у основного есть неудалённые тендеры на
// материалы и все «Завершён».
async function loadTender(id) {
  const { data, error } = await db.from('tenders').select(TENDER_COLUMNS).eq('id', id).maybeSingle()
  if (error) fail(error)
  return data || null
}

async function loadMaterialsTenders(mainId) {
  const { data, error } = await db.from('tenders')
    .select(TENDER_COLUMNS)
    .eq('tender_type', 'materials')
    .is('deleted_at', null)
    .or(`parent_tender_id.eq.${mainId},id.eq.${mainId}`)
  if (error) fail(error)
  return data || []
}

const mainIdOf = (opened) => (opened.tender_type === 'materials' ? (opened.parent_tender_id || opened.id) : opened.id)

function buildContext(opened, main, materialsTenders) {
  const materials = opened.tender_type === 'materials' ? opened : (materialsTenders[0] || null)
  const locked = materialsTenders.length > 0 && materialsTenders.every((t) => MATERIALS_LOCK_STATUSES.includes(t.status))
  return {
    opened, main, mainId: mainIdOf(opened), materials, materialsTenders, locked,
    orphan: opened.tender_type === 'materials' && !opened.parent_tender_id,
  }
}

// Основной тендер и тендеры на материалы — одновременно, после открытого тендера.
async function contextOf(opened) {
  const mainId = mainIdOf(opened)
  const [main, kids] = await Promise.all([mainId === opened.id ? opened : loadTender(mainId), loadMaterialsTenders(mainId)])
  return buildContext(opened, main, kids)
}

export async function loadPricingContext(id) {
  const opened = await loadTender(id)
  return opened ? contextOf(opened) : null
}

// Всё для таблицы расценки по основному тендеру — одновременно: файлы ВОР, списки позиций, цены, последний
// номер журнала, непросмотренные версии ВОР и (если карточка их не дала) строки вкладки «ВОР».
export async function loadPricingData(mainId, { withItems = false } = {}) {
  const [files, sources, rates, logId, links, importState, revisions, items] = await Promise.all([
    loadVorFiles(mainId), loadSources(mainId), loadRates(mainId), loadLogMarker(mainId), loadLinks(mainId), loadImportState(mainId),
    loadRevisions(mainId), withItems ? loadEstimateItems(mainId) : null,
  ])
  return { files, sources, rates, logId, links, importState, revisions, items }
}

// Открытие таблицы за два шага к серверу вместо цепочки: тендер, затем всё остальное разом. ctx уже есть
// (страница загрузила шапку) — сразу данные. Ошибка данных (например, «таблиц ещё нет») не теряет тендер:
// { ctx, error }.
export async function loadPricingBundle(id, { ctx = null, withItems = false } = {}) {
  const opened = ctx ? ctx.opened : await loadTender(id)
  if (!opened) return { ctx: null }
  const mainId = ctx ? ctx.mainId : mainIdOf(opened)
  const [c, data] = await Promise.all([
    ctx || contextOf(opened),
    loadPricingData(mainId, { withItems }).catch((error) => ({ error })),
  ])
  return { ctx: c, ...data }
}

// ── Источники позиций ───────────────────────────────────────────────────────────────────────────────
// Файлы ВОР из «ВОРов и РД» основного тендера — только книги Excel (в старой категории vor бывают PDF).
export async function loadVorFiles(mainId) {
  const { data, error } = await db.from('s3_documents')
    .select('id, file_name, s3_key, doc_category, created_at, uploaded_by_name')
    .eq('owner_type', 'tender')
    .eq('owner_id', mainId)
    .in('doc_category', [VOR_STATEMENT_CATEGORY, LEGACY_VOR_CATEGORY])
    .order('created_at', { ascending: false })
  if (error) fail(error)
  return (data || []).filter((d) => isWorkbookFileName(d.file_name))
}

// Вся книга — для окна «Указать лист и колонки» (выбор листа).
export async function fetchVorWorkbook(doc) {
  const [{ readWorkbookBytes }, bytes] = await Promise.all([import('../utils/vorMaterialsSheet'), fetchFileBytes(doc.s3_key)])
  return readWorkbookBytes(bytes)
}

// Автозагрузка: скачивание и разбор — по отдельности. Не скачалось — сеть или хранилище (повторить можно);
// не разобралось — сам файл (повторять незачем, причина запоминается).
export async function downloadVorFile(doc) {
  return fetchFileBytes(doc.s3_key)
}

// Признак версии источника: файл — id и время загрузки; вкладка «ВОР» — число строк и время загрузки.
export { fileVersion, estimateVersion } from '../utils/supplyAutoImport.js'

// Строки вкладки «ВОР» карточки (только нужные поля) — для позиций из ВОР и признаков его версии.
// Страницы — параллельно (у больших ВОР десятки тысяч строк).
export async function loadEstimateItems(mainId) {
  return fetchAllRowsParallel((from, to, withCount) => db.from('tender_estimate_items')
    .select('id, estimate_name, code, cost_name, unit, material_consumption, is_section, created_at', withCount ? { count: 'exact' } : undefined)
    .eq('tender_id', mainId)
    .order('id', { ascending: true })
    .range(from, to))
}

export function estimateSignatures(items) {
  const out = new Map()
  for (const it of items) {
    const doc = it.estimate_name || 'Основная смета'
    const s = out.get(doc) || { count: 0, latest: '' }
    s.count += 1
    if (it.created_at && it.created_at > s.latest) s.latest = it.created_at
    out.set(doc, s)
  }
  return out
}

export async function loadSources(mainId) {
  const { data, error } = await withSourceColumns((cols) => db.from('tender_supply_sources').select(cols)
    .eq('tender_id', mainId).order('estimate_name', { ascending: true }))
  if (error) fail(error)
  return data || []
}

// Сохранить список позиций ВОР: новый — вставка (уже есть — conflict), прежний — по версии строки.
export async function saveSource({ existing, mainId, estimateName, source, doc, sheetName, columnMap, sourceVersion, positions }) {
  const payload = {
    source,
    s3_document_id: doc?.id || null,
    file_name: doc?.file_name || null,
    sheet_name: sheetName || null,
    column_map: columnMap || null,
    source_version: sourceVersion || null,
    positions,
  }
  if (existing) {
    const { data, error } = await withSourceColumns((cols) => db.from('tender_supply_sources').update(payload)
      .eq('id', existing.id).eq('row_version', existing.row_version).select(cols))
    if (error) fail(error)
    if (!data?.length) fail({ code: '23505', message: 'Список позиций этого ВОР уже обновил другой пользователь' })
    return data[0]
  }
  const { data, error } = await withSourceColumns((cols) => db.from('tender_supply_sources')
    .insert({ tender_id: mainId, estimate_name: estimateName, ...payload }).select(cols))
  if (error) fail(error)
  return data[0]
}

export async function deleteSource(src) {
  const { data, error } = await db.from('tender_supply_sources').delete()
    .eq('id', src.id).eq('row_version', src.row_version).select('id')
  if (error) fail(error)
  if (!data?.length) fail({ code: '23505', message: 'Список позиций этого ВОР уже изменил другой пользователь' })
}

// ── Расценки ────────────────────────────────────────────────────────────────────────────────────────
export async function loadRates(mainId) {
  const all = () => fetchAllRows((from, to) => db.from('tender_vor_supply_rates').select(rateColumns())
    .eq('tender_id', mainId).order('id', { ascending: true }).range(from, to))
  try {
    return await all()
  } catch (e) {
    if (!reuseColumns || !isMissingColumn(e)) throw e
    reuseColumns = false
    return all()
  }
}

async function currentRate(where) {
  const { data } = await withRateColumns((cols) => {
    let q = db.from('tender_vor_supply_rates').select(cols)
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v)
    return q.limit(1)
  })
  return data?.[0] || null
}

// Ед. изм. позиции для расценки; у позиции с разными единицами — все через запятую.
export const positionUnit = (p) => (p.units ? p.units.map((u) => u.unit).filter(Boolean).join(', ') : p.unit) || null

// Записать цену (mode 'unit') или сумму (mode 'total') позиции. rate — текущая расценка позиции (или null).
// source — цена другого тендера ({ rateId, kind: 'pick' | 'auto' }): день расценки и отметку копии ставит база.
// Ответ: { status: 'ok', row } | { status: 'conflict', current } — значение не записано, current — что в базе.
export async function saveRate({ rate, mainId, estimateName, position, mode, value, source = null }) {
  const payload = {
    price_input: mode,
    input_value: value,
    volume_at_input: position.units ? null : position.volume,
    unit: positionUnit(position),
    ...(source?.rateId ? { source_rate_id: source.rateId, source_kind: source.kind || 'pick' } : {}),
  }
  if (rate) {
    const { data, error } = await withRateColumns((cols) => db.from('tender_vor_supply_rates').update(payload)
      .eq('id', rate.id).eq('row_version', rate.row_version).select(cols))
    if (error) fail(error)
    if (data?.length) return { status: 'ok', row: data[0] }
    return { status: 'conflict', current: await currentRate({ id: rate.id }) }
  }
  const { data, error } = await withRateColumns((cols) => db.from('tender_vor_supply_rates')
    .insert({ tender_id: mainId, estimate_name: estimateName, material_name: position.name, ...payload }).select(cols))
  if (error?.code === '23505') {
    return { status: 'conflict', current: await currentRate({ tender_id: mainId, estimate_name: estimateName, material_name: position.name }) }
  }
  if (error) fail(error)
  return { status: 'ok', row: data[0] }
}

// Убрать цену позиции (очистили поле). Ответ — как у saveRate; row: null.
export async function clearRate(rate) {
  const { data, error } = await db.from('tender_vor_supply_rates').delete()
    .eq('id', rate.id).eq('row_version', rate.row_version).select('id')
  if (error) fail(error)
  if (data?.length) return { status: 'ok', row: null }
  return { status: 'conflict', current: await currentRate({ id: rate.id }) }
}

// ── Ссылки на документы (чек, счёт, КП поставщика) к позициям (миграция 20261022) ─────────────────────
// Ссылка живёт отдельно от цены: одна на позицию ВОР — (тендер, ВОР, ключ наименования), как у цен. С миграцией
// 20261025 документ — адрес или файл (s3_document_id, файл в хранилище документов тендера); колонки ещё нет — только
// адрес, как раньше (проверяется один раз за сеанс).
export const LINK_COLUMNS = 'id, tender_id, estimate_name, material_name, material_key, url, updated_by, updated_at'
let linkFiles = true
const linkColumns = () => (linkFiles ? `${LINK_COLUMNS}, s3_document_id` : LINK_COLUMNS)
// Можно ли прикреплять к позициям файлы (колонка s3_document_id есть в базе).
export const linkFilesEnabled = () => linkFiles
// Файлы документов поставщиков — в хранилище документов основного тендера, своей категорией: другие списки файлов
// тендера (ВОРы и РД, пакет, КП) их не показывают, подрядчику они закрыты (правило s3_documents по категориям).
export const SUPPLY_DOC_CATEGORY = 'supply_doc'
const DOC_COLUMNS = 'id, owner_id, file_name, s3_key, mime_type, size_bytes, created_at, uploaded_by_name'

// Адрес http(s) или сетевой путь \\сервер\папка (как проверяет база). Ответ: { url } | { error }.
export function normalizeLinkUrl(raw) {
  const url = String(raw ?? '').trim()
  if (!url) return { error: 'Вставьте ссылку на документ' }
  if (url.length > 2000) return { error: 'Ссылка длиннее 2000 знаков' }
  if (/^https?:\/\/\S/i.test(url) || /^\\\\\S/.test(url)) return { url }
  return { error: 'Нужна ссылка вида https://… или сетевой путь \\\\сервер\\папка' }
}
export const isWebLink = (url) => /^https?:\/\//i.test(String(url || ''))

// Ссылки тендера. Таблицы ещё нет (миграция не применена или шлюз её не знает) — null: таблица расценки
// работает как раньше, без колонки «Документ».
export async function loadLinks(mainId) {
  const all = () => fetchAllRows((from, to) => db.from('tender_supply_links').select(linkColumns())
    .eq('tender_id', mainId).order('id', { ascending: true }).range(from, to))
  try {
    return await all()
  } catch (e) {
    if (linkFiles && isMissingColumn(e)) {
      linkFiles = false
      return loadLinks(mainId)
    }
    if (classifyError(e)?.kind === 'missing') return null
    fail(e)
  }
}

// Признак «ссылки менялись»: сколько их и когда последняя правка (удаление меняет число, правка — время).
export async function loadLinksMarker(mainId) {
  const [cnt, last] = await Promise.all([
    db.from('tender_supply_links').select('id', { count: 'exact', head: true }).eq('tender_id', mainId),
    db.from('tender_supply_links').select('updated_at').eq('tender_id', mainId).order('updated_at', { ascending: false }).limit(1),
  ])
  if (cnt.error) fail(cnt.error)
  if (last.error) fail(last.error)
  return `${cnt.count ?? 0}|${last.data?.[0]?.updated_at || ''}`
}

// Один документ — нескольким позициям сразу (у кого был — заменяется). targets: [{ estimateName, name }]; doc —
// { url } (адрес) или { docId } (файл из хранилища документов тендера).
export async function saveLinks(mainId, targets, doc) {
  const target = doc?.docId ? { url: null, s3_document_id: doc.docId } : { url: doc?.url ?? null, ...(linkFiles ? { s3_document_id: null } : {}) }
  const out = []
  for (const chunk of chunkList(targets, 200)) {
    const { data, error } = await db.from('tender_supply_links')
      .upsert(chunk.map((t) => ({ tender_id: mainId, estimate_name: t.estimateName, material_name: t.name, ...target })),
        { onConflict: 'tender_id,estimate_name,material_key' })
      .select(linkColumns())
    if (error) {
      if (doc?.docId && isMissingColumn(error)) {
        linkFiles = false
        fail({ code: '42703', message: 'Прикрепить файл к позиции нельзя: на сервере не применено обновление базы. Сообщите администратору.' })
      }
      fail(error)
    }
    out.push(...(data || []))
  }
  return out
}

// ── Файлы документов поставщиков (миграция 20261025) ─────────────────────────────────────────────────
export async function loadSupplyDocs(mainId) {
  const { data, error } = await db.from('s3_documents').select(DOC_COLUMNS)
    .eq('owner_type', 'tender').eq('owner_id', mainId).eq('doc_category', SUPPLY_DOC_CATEGORY)
    .order('created_at', { ascending: false })
  if (error) fail(error)
  return data || []
}

// Файлы по id — для колонки «Документ»: у позиции бывает и файл другого тендера (цена взята из похожих вместе с
// документом). Порциями — длинный .in() не проходит шлюз.
export async function loadDocsByIds(ids) {
  const out = []
  for (const chunk of chunkList([...new Set(ids)].filter(Boolean))) {
    const { data, error } = await db.from('s3_documents').select(DOC_COLUMNS).in('id', chunk)
    if (error) fail(error)
    out.push(...(data || []))
  }
  return out
}

// Загрузить файл документа поставщика в хранилище документов основного тендера.
export async function uploadSupplyDoc(mainId, file) {
  return uploadFile({ file, ownerType: 'tender', ownerId: mainId, category: SUPPLY_DOC_CATEGORY })
}

// Удалить файл: пропадает у всех позиций, где он документ (ON DELETE CASCADE).
export async function deleteSupplyDoc(doc) {
  await deleteDocument(doc)
}

export async function removeLinks(ids) {
  for (const chunk of chunkList(ids)) {
    const { error } = await db.from('tender_supply_links').delete().in('id', chunk)
    if (error) fail(error)
  }
}

// ── Цены из других тендеров (миграция 20261023) ─────────────────────────────────────────────────────
// Источник — свои (не скопированные) цены снабжения всех тендеров не старше 3 месяцев по дням, по Москве; та же
// ед. изм. Считает и пишет база. Функций ещё нет (миграция не применена, шлюз их не знает) — null: таблица
// работает как раньше.
async function reuseRpc(name, args) {
  const { data, error } = await db.rpc(name, args)
  if (error) {
    if (classifyError(error)?.kind === 'missing') return null
    fail(error)
  }
  return data
}

// Одинаковым позициям без цены (то же наименование по ключу и та же ед. изм.) — самая свежая цена другого
// тендера. Цену не перезаписывает, убранную вручную не возвращает. Ответ — сколько подставлено.
export async function autofillFromOtherTenders(mainId) {
  const n = await reuseRpc('supply_autofill', { p_tender: mainId })
  return n == null ? null : Number(n) || 0
}

// Сколько похожих цен у позиций: items — [{ doc, k, name, unit }], порциями по 200 (база больше не берёт).
// Ответ — [{ estimate_name, k, n }] только у позиций, где похожие есть.
export const SUGGEST_BATCH = 200
export async function loadSuggestionCounts(mainId, items) {
  const out = []
  for (const chunk of chunkList(items, SUGGEST_BATCH)) {
    const rows = await reuseRpc('supply_suggestion_counts', { p_tender: mainId, p_items: chunk })
    if (rows == null) return null
    out.push(...rows)
  }
  return out
}

// Похожие цены одной позиции — для меню: от самых недавних, до 15. Ответ держится 5 минут (меню открывают и
// закрывают); fresh — заново.
const SUGGEST_TTL_MS = 5 * 60 * 1000
const suggestCache = new Map()
export async function loadRateSuggestions(mainId, { estimateName, name, unit }, { fresh = false } = {}) {
  const key = JSON.stringify([mainId, estimateName, name, unit])
  const hit = suggestCache.get(key)
  if (!fresh && hit && Date.now() - hit.at < SUGGEST_TTL_MS) return hit.rows
  const rows = await reuseRpc('supply_rate_suggestions', { p_tender: mainId, p_estimate: estimateName, p_name: name, p_unit: unit, p_limit: 15 })
  if (rows == null) return null
  if (suggestCache.size > 500) suggestCache.clear()
  suggestCache.set(key, { rows, at: Date.now() })
  return rows
}

// Откуда скопированы цены тендера: тендер, объект, ВОР, наименование и документ исходной цены, день расценки.
// Постранично: строка на каждую скопированную цену (у больших ВОР — тысячи), а шлюз отдаёт не больше 1000 строк.
export async function loadRateOrigins(mainId) {
  try {
    return await fetchAllRows((from, to) => db
      .rpc('supply_rate_origins', { p_tender: mainId })
      .order('rate_id', { ascending: true })
      .range(from, to))
  } catch (error) {
    if (classifyError(error)?.kind === 'missing') return null
    fail(error)
  }
}

// ── Синхронизация и история ─────────────────────────────────────────────────────────────────────────
// Признак «что-то изменилось»: последний номер в журнале расценок тендера и версии списков позиций.
export async function loadLogMarker(mainId) {
  const { data, error } = await db.from('tender_supply_rate_log').select('id')
    .eq('tender_id', mainId).order('id', { ascending: false }).limit(1)
  if (error) fail(error)
  return data?.[0]?.id ?? 0
}

export const sourcesSignature = (sources) => (sources || []).map((s) => `${s.id}:${s.row_version}`).sort().join(',')

export async function loadSourceVersions(mainId) {
  const { data, error } = await db.from('tender_supply_sources').select('id, row_version').eq('tender_id', mainId)
  if (error) fail(error)
  return data || []
}

export async function loadChangeMarker(mainId) {
  const [logId, src] = await Promise.all([loadLogMarker(mainId), loadSourceVersions(mainId)])
  return { logId, sources: sourcesSignature(src) }
}

// Что менялось после номера fromId: id расценок (без повторов). Больше limit записей — null (перечитать всё).
export async function loadChangedRateIds(mainId, fromId, limit = 1000) {
  const { data, error } = await db.from('tender_supply_rate_log').select('id, rate_id')
    .eq('tender_id', mainId).gt('id', fromId).order('id', { ascending: true }).limit(limit)
  if (error) fail(error)
  const rows = data || []
  if (rows.length >= limit) return null
  return { ids: [...new Set(rows.map((r) => r.rate_id))], lastId: rows.length ? rows[rows.length - 1].id : fromId }
}

// Текущие строки расценок по id (порциями — длинный .in() не проходит шлюз). Удалённых в ответе нет.
export async function loadRatesByIds(mainId, ids) {
  const out = []
  for (const chunk of chunkList(ids)) {
    const { data, error } = await withRateColumns((cols) => db.from('tender_vor_supply_rates').select(cols).eq('tender_id', mainId).in('id', chunk))
    if (error) fail(error)
    out.push(...(data || []))
  }
  return out
}

export async function loadRateHistory(mainId, { rateId, estimateName, materialName }) {
  let q = db.from('tender_supply_rate_log')
    .select('id, op, estimate_name, old_estimate_name, material_name, unit, old_price, new_price, old_total, new_total, old_input, new_input, input_value, volume_at_input, changed_by_name, changed_at')
    .eq('tender_id', mainId)
  q = rateId ? q.eq('rate_id', rateId) : q.eq('estimate_name', estimateName).eq('material_name', materialName)
  const { data, error } = await q.order('id', { ascending: false }).limit(30)
  if (error) fail(error)
  return data || []
}

// Состояние разбора позиций ВОР службой osp-api (миграция 20261024): разбирает ли она тендер, что вышло и какие
// файлы не разобрались. Таблицы ещё нет — null: страница работает как раньше (сама разбирает файлы).
export async function loadImportState(mainId) {
  const { data, error } = await db.from('tender_supply_import_state')
    .select('tender_id, status, issues, positions_count, checked_at').eq('tender_id', mainId).maybeSingle()
  if (error) return null
  return data || { tender_id: mainId, status: null, issues: [] }
}

// Прогресс по основным тендерам для реестра тендеров на материалы: Map(mainId → { positions, priced, status, issues,
// changes }). status — состояние разбора службой osp-api (ok | no_vor | issues | locked | pending): статус виден и у
// тендера, расценку которого ещё не открывали; changes — непросмотренные версии ВОР («ВОР изменён»). Нет представления
// (миграция не применена) — пустая карта; нет таблицы состояния или версий — без них, реестр работает по-старому.
export async function loadSupplyProgress(mainIds) {
  const out = new Map()
  const ids = [...new Set(mainIds.filter(Boolean))]
  const entry = (id) => {
    if (!out.has(id)) out.set(id, { positions: 0, priced: 0, status: null, issues: [], changes: [] })
    return out.get(id)
  }
  let statesOn = true
  let revisionsOn = true
  for (const chunk of chunkList(ids)) {
    const [progress, states, revisions] = await Promise.all([
      db.from('tender_supply_progress').select('tender_id, positions_count, priced_count').in('tender_id', chunk),
      statesOn ? db.from('tender_supply_import_state').select('tender_id, status, issues').in('tender_id', chunk) : { data: [] },
      // Непросмотренные версии ВОР (миграция 20261029): «ВОР изменён» в реестре. Таблицы нет — без этого.
      // Постранично: шлюз отдаёт не больше 1000 строк.
      revisionsOn
        ? fetchAllRows((from, to) => db.from('tender_supply_revisions').select(REVISION_COLUMNS).in('tender_id', chunk)
          .is('reviewed_at', null).order('id', { ascending: true }).range(from, to))
          .then((data) => ({ data, error: null }), (error) => ({ data: null, error }))
        : { data: [] },
    ])
    if (progress.error) {
      if (classifyError(progress.error)?.kind === 'missing') return out
      throw progress.error
    }
    if (states.error) statesOn = false
    if (revisions.error) revisionsOn = false
    for (const r of revisions.data || []) entry(r.tender_id).changes.push(r)
    for (const r of progress.data || []) {
      const cur = entry(r.tender_id)
      cur.positions += r.positions_count || 0
      cur.priced += r.priced_count || 0
    }
    for (const r of states.data || []) Object.assign(entry(r.tender_id), { status: r.status, issues: r.issues || [] })
  }
  return out
}

// ── Версии ВОР (миграция 20261029) ──────────────────────────────────────────────────────────────────
// Версия — что изменилось в позициях ВОР (сметный отдел заменил файл, перезагрузил вкладку «ВОР», добавил или удалил
// файл) и снимок цен на тот момент. Пишет база (триггер), страница только читает и отмечает «просмотрено». Таблицы ещё
// нет — null: таблица расценки работает как раньше (без подсветки, вопросов и истории версий).
export const REVISION_COLUMNS = 'id, tender_id, estimate_name, kind, source, old_document_id, new_document_id, old_file_name, new_file_name, '
  + 'uploaded_by_name, uploaded_at, positions_before, positions_after, added, removed, volume_changed, unit_changed, priced_removed, '
  + 'created_by, created_at, reviewed_at, reviewed_by'

// Непросмотренные версии тендера — с тем, что изменилось (подсветка в таблице и уведомление в шапке ВОР).
export async function loadRevisions(mainId) {
  const { data, error } = await db.from('tender_supply_revisions').select(`${REVISION_COLUMNS}, changes`)
    .eq('tender_id', mainId).is('reviewed_at', null).order('id', { ascending: true }).limit(500)
  if (error) {
    if (classifyError(error)?.kind === 'missing') return null
    fail(error)
  }
  return data || []
}

// Признак «версии менялись»: номера непросмотренных (новая версия — новый номер, «просмотрено» — номер ушёл).
export async function loadRevisionsMarker(mainId) {
  const { data, error } = await db.from('tender_supply_revisions').select('id')
    .eq('tender_id', mainId).is('reviewed_at', null).order('id', { ascending: true }).limit(500)
  if (error) fail(error)
  return (data || []).map((r) => r.id).join(',')
}

// История версий ВОР тендера (окно «Версии ВОР»): без изменений и снимков — их по одной версии, по требованию.
export async function loadRevisionHistory(mainId) {
  const { data, error } = await db.from('tender_supply_revisions').select(REVISION_COLUMNS)
    .eq('tender_id', mainId).order('id', { ascending: false }).limit(300)
  if (error) fail(error)
  return data || []
}

export async function loadRevisionDetail(id) {
  const { data, error } = await db.from('tender_supply_revisions').select(`${REVISION_COLUMNS}, changes, prices`).eq('id', id).maybeSingle()
  if (error) fail(error)
  return data || null
}

export async function reviewRevisions(mainId, ids) {
  const { data, error } = await db.rpc('supply_revisions_review', { p_tender: mainId, p_ids: ids })
  if (error) fail(error)
  return Number(data) || 0
}

// Файл ВОР с другим именем — новая версия прежнего ВОР: прежний ВОР получает файл и позиции нового, цены и документы
// нового переходят в прежний, список нового убирается. Ответ базы: { moved, replaced, dropped, links }.
export async function adoptVersion(mainId, newName, oldName) {
  const { data, error } = await db.rpc('supply_vor_adopt', { p_tender: mainId, p_new: newName, p_old: oldName })
  if (error) fail(error)
  return data || {}
}

// «Отдельный ВОР» — больше не спрашивать, новая ли это версия другого ВОР (время и автор ответа ставит база).
export async function markSeparate(src) {
  const { data, error } = await withSourceColumns((cols) => db.from('tender_supply_sources').update({ separate_at: new Date().toISOString() })
    .eq('id', src.id).eq('row_version', src.row_version).select(cols))
  if (error) fail(error)
  if (!data?.length) fail({ code: '23505', message: 'Список позиций этого ВОР уже изменил другой пользователь — обновите страницу' })
  return data[0]
}

// Перенести цену (и документ) убранной позиции на позицию ВОР: та же строка цены — день расценки и история прежние.
// Ответ: { rate (строка), dropped (id убранных подставленных цен у цели), links }.
export async function carryRate(rate, estimateName, position) {
  const { data, error } = await db.rpc('supply_rate_carry', {
    p_rate: rate.id, p_version: rate.row_version, p_estimate: estimateName, p_name: position.name, p_unit: positionUnit(position),
  })
  if (error) fail(error)
  return data || {}
}

// Цена верна и для новой ед. изм. позиции: у цены — ед. изм. позиции (цена и день расценки не меняются).
// Ответ — как у saveRate.
export async function confirmRateUnit(rate, position) {
  const { data, error } = await withRateColumns((cols) => db.from('tender_vor_supply_rates').update({ unit: positionUnit(position) })
    .eq('id', rate.id).eq('row_version', rate.row_version).select(cols))
  if (error) fail(error)
  if (data?.length) return { status: 'ok', row: data[0] }
  return { status: 'conflict', current: await currentRate({ id: rate.id }) }
}

export async function renameEstimate(mainId, from, to) {
  const { data, error } = await db.rpc('supply_estimate_rename', { p_tender: mainId, p_from: from, p_to: to })
  if (error) fail(error)
  return data
}

// Строки вкладки «ВОР»: материалы для позиций (без работ и разделов). Признак isWorkItem — в utils/vorMaterials.
export { isWorkItem } from '../utils/vorMaterials'
