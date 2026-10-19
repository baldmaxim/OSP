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
import { fetchFileBytes } from './s3'
import { VOR_STATEMENT_CATEGORY, LEGACY_VOR_CATEGORY, isNetworkError } from './tenderVorRd'
import { isWorkbookFileName } from '../utils/vorFiles'
// Библиотека Excel (vorMaterialsSheet → xlsx, 430 КБ) — только по требованию: сервис импортирует и реестр
// тендеров (прогресс расценки), которому она не нужна.

// Статусы тендера на материалы, после которых расценки только для чтения (как supply_rates_locked в базе).
export const MATERIALS_LOCK_STATUSES = ['Завершён', 'Завершен']

export const RATE_COLUMNS = 'id, tender_id, estimate_name, material_name, unit, supply_price, supply_price_exact, supply_total, '
  + 'price_input, input_value, volume_at_input, row_version, updated_by, updated_at, created_at, material_key'
export const SOURCE_COLUMNS = 'id, tender_id, estimate_name, source, s3_document_id, file_name, sheet_name, column_map, '
  + 'source_version, positions, positions_count, row_version, parsed_by, parsed_at'
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
// номер журнала и (если карточка их не дала) строки вкладки «ВОР».
export async function loadPricingData(mainId, { withItems = false } = {}) {
  const [files, sources, rates, logId, items] = await Promise.all([
    loadVorFiles(mainId), loadSources(mainId), loadRates(mainId), loadLogMarker(mainId),
    withItems ? loadEstimateItems(mainId) : null,
  ])
  return { files, sources, rates, logId, items }
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
  const { data, error } = await db.from('tender_supply_sources').select(SOURCE_COLUMNS)
    .eq('tender_id', mainId).order('estimate_name', { ascending: true })
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
    const { data, error } = await db.from('tender_supply_sources').update(payload)
      .eq('id', existing.id).eq('row_version', existing.row_version).select(SOURCE_COLUMNS)
    if (error) fail(error)
    if (!data?.length) fail({ code: '23505', message: 'Список позиций этого ВОР уже обновил другой пользователь' })
    return data[0]
  }
  const { data, error } = await db.from('tender_supply_sources')
    .insert({ tender_id: mainId, estimate_name: estimateName, ...payload }).select(SOURCE_COLUMNS)
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
  return fetchAllRows((from, to) => db.from('tender_vor_supply_rates').select(RATE_COLUMNS)
    .eq('tender_id', mainId).order('id', { ascending: true }).range(from, to))
}

async function currentRate(where) {
  let q = db.from('tender_vor_supply_rates').select(RATE_COLUMNS)
  for (const [k, v] of Object.entries(where)) q = q.eq(k, v)
  const { data } = await q.limit(1)
  return data?.[0] || null
}

// Ед. изм. позиции для расценки; у позиции с разными единицами — все через запятую.
export const positionUnit = (p) => (p.units ? p.units.map((u) => u.unit).filter(Boolean).join(', ') : p.unit) || null

// Записать цену (mode 'unit') или сумму (mode 'total') позиции. rate — текущая расценка позиции (или null).
// Ответ: { status: 'ok', row } | { status: 'conflict', current } — значение не записано, current — что в базе.
export async function saveRate({ rate, mainId, estimateName, position, mode, value }) {
  const payload = {
    price_input: mode,
    input_value: value,
    volume_at_input: position.units ? null : position.volume,
    unit: positionUnit(position),
  }
  if (rate) {
    const { data, error } = await db.from('tender_vor_supply_rates').update(payload)
      .eq('id', rate.id).eq('row_version', rate.row_version).select(RATE_COLUMNS)
    if (error) fail(error)
    if (data?.length) return { status: 'ok', row: data[0] }
    return { status: 'conflict', current: await currentRate({ id: rate.id }) }
  }
  const { data, error } = await db.from('tender_vor_supply_rates')
    .insert({ tender_id: mainId, estimate_name: estimateName, material_name: position.name, ...payload }).select(RATE_COLUMNS)
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
    const { data, error } = await db.from('tender_vor_supply_rates').select(RATE_COLUMNS).eq('tender_id', mainId).in('id', chunk)
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

// Прогресс по основным тендерам для реестра тендеров на материалы: Map(mainId → { positions, priced }).
// Нет представления (миграция не применена) — пустая карта, реестр работает по-старому.
export async function loadSupplyProgress(mainIds) {
  const out = new Map()
  const ids = [...new Set(mainIds.filter(Boolean))]
  for (const chunk of chunkList(ids)) {
    const { data, error } = await db.from('tender_supply_progress')
      .select('tender_id, positions_count, priced_count').in('tender_id', chunk)
    if (error) {
      if (classifyError(error)?.kind === 'missing') return out
      throw error
    }
    for (const r of data || []) {
      const cur = out.get(r.tender_id) || { positions: 0, priced: 0 }
      cur.positions += r.positions_count || 0
      cur.priced += r.priced_count || 0
      out.set(r.tender_id, cur)
    }
  }
  return out
}

export async function renameEstimate(mainId, from, to) {
  const { data, error } = await db.rpc('supply_estimate_rename', { p_tender: mainId, p_from: from, p_to: to })
  if (error) fail(error)
  return data
}

// Строки вкладки «ВОР»: материалы для позиций (без работ и разделов). Признак isWorkItem — в utils/vorMaterials.
export { isWorkItem } from '../utils/vorMaterials'
