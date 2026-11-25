// Кабинет подрядчика: расценка ВОР на сайте, заявки на участие, анкета (миграция 20261102_contractor_bids).
//
// Подрядчик видит открытые тендеры и тендеры, где он участник (bid_contractor_tenders); расценивать может после
// заявки (bid_request) или как участник. Цены — одна на уникальную позицию тендера (вид + наименование + ед. изм.),
// пишутся только функцией bid_rates_save; анкета — bid_form_save. Инженер видит заявки и решает, сделать ли
// подрядчика участником (bid_decide). Цены и анкету читает администратор (bid_admin_overview) и сама организация.
//
// Пока миграции нет, функции и таблицы отвечают «не найдено» — сервис возвращает null, страницы работают как раньше.
import { db, requestBidFile, requestBidFileAdmin, requestBidSupplyDoc } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { fetchFileBytes, requestDownloadUrl, unwrapFunction } from './s3'
import { cabinetSandbox, setCabinetPreview } from './cabinetPreview'

export const BIDS_MIGRATION_HINT = 'Расценка на сайте появится после обновления базы (миграция 20261102_contractor_bids).'

// Нет таблицы или функции (миграция не применена; на новом портале — не в списке шлюза).
export function isMissingBids(err) {
  const code = String(err?.code || '')
  if (['42P01', 'PGRST205', '42883', 'PGRST202'].includes(code)) return true
  const msg = String(err?.message || '')
  return /bid_|tender_bid/.test(msg) && /does not exist|schema cache|Could not find/.test(msg)
}

const unwrap = ({ data, error }) => {
  if (error) throw error
  return data
}

// ── Просмотр кабинета от имени подрядчика ────────────────────────────────────────────────────────────
// Администратор смотрит кабинет глазами организации («Посмотреть как подрядчик»). Решение пользователя 25.11.2026: кабинет — 1 в 1 как у
// подрядчика, а не упрощённая версия (раньше цены, анкета, просьба о ценах снабжения, «Отказаться» были только для чтения). Запросы идут
// под учёткой администратора, поэтому записи кабинета на сервер не уходят: здесь они ложатся в черновик в памяти страницы (до
// перезагрузки или выхода из просмотра), а чтения кабинета его подмешивают — интерфейс и поведение те же, что у подрядчика, а в
// базе ничего не меняется (страница включает черновик setCabinetPreview(id организации) на время просмотра).
// Черновик — в отдельном модуле (cabinetPreview.js): его снимает RoleContext, когда просмотр заканчивается.
export { setCabinetPreview }
const inSandbox = (counterpartyId = null) => !!cabinetSandbox() && (counterpartyId == null || counterpartyId === cabinetSandbox().cp)
const sandboxRates = (tenderId) => {
  if (!cabinetSandbox().rates.has(tenderId)) cabinetSandbox().rates.set(tenderId, new Map())
  return cabinetSandbox().rates.get(tenderId)
}
const rateRowKey = (r) => `${r.kind}|${r.item_key}|${r.unit_key || ''}`
const withSandboxRates = (tenderId, rows) => {
  const over = cabinetSandbox()?.rates.get(tenderId)
  if (!over?.size) return rows
  const out = new Map(rows.map((r) => [rateRowKey(r), r]))
  for (const [k, r] of over) {
    if (r.deleted) out.delete(k)
    else out.set(k, { ...(out.get(k) || {}), ...r })
  }
  return [...out.values()]
}
const withSandboxAnswers = (answers, patch) => {
  const out = { ...(answers || {}) }
  for (const [id, v] of Object.entries(patch || {})) {
    if (String(v ?? '').trim()) out[id] = { ...(out[id] || {}), value: String(v).trim() }
    else delete out[id]
  }
  return out
}

// Учётка организации для просмотра: кому кабинет показывается на деле — ФИО, телефон и почта входа (как contractor_org_card) и
// заведена ли учётка регистрацией на сайте (тогда в кабинете нет файлов тендера и «Отказаться»). Учёток несколько — первая; признак
// регистрации — только если так заведены все. Учёток нет — null (кабинет как у подрядчика, заведённого отделом).
export async function loadPreviewAccount(counterpartyId) {
  if (!counterpartyId) return null
  const read = (cols) => db.from('user_roles').select(cols).eq('counterparty_id', counterpartyId).eq('is_approved', true)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(20)
  let { data, error } = await read('id, full_name, work_phone, email, self_registered')
  if (error?.code === '42703') ({ data, error } = await read('id, full_name, work_phone, email'))
  if (error) throw error
  if (!data?.length) return null
  const first = data[0]
  return {
    contact_name: first.full_name || null,
    contact_phone: first.work_phone || null,
    contact_email: first.email || null,
    selfRegistered: data.every((r) => r.self_registered === true),
  }
}

// ── Подрядчик ────────────────────────────────────────────────────────────────────────────────────────
// Тендеры кабинета или null (миграции нет).
export async function loadCabinetTenders() {
  const { data, error } = await db.rpc('bid_contractor_tenders')
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

// Тендеры кабинета в просмотре от имени подрядчика (администратор, «Посмотреть как подрядчик»): запросы идут под его учёткой, у
// него нет организации, и функция кабинета отказывает. Поэтому те же строки — чтением таблиц, тот же отбор, что bid_tender_open
// (идёт процедура, не удалён, основной, объект стройки или гарантии), и только идущие: прошлые кабинет всё равно не показывает.
const OPEN_OBJECT_STATUSES = new Set(['main_construction', 'warranty_service'])
export const TENDER_OPEN_STATUS = 'Идет тендерная процедура'

// Таблиц заявок и цен может ещё не быть (база раньше миграции 20261102) — это не ошибка кабинета.
const readOptional = async (read) => {
  try {
    return await read()
  } catch (e) {
    if (isMissingBids(e)) return []
    throw e
  }
}

export async function loadCabinetTendersPreview(counterpartyId) {
  const tenders = await fetchAllRows((from, to) => db
    .from('tenders')
    .select('id, public_tender_number, work_description, status, tender_type, custom_object_name, tender_start_date, tender_end_date, start_date, end_date, tender_package_link, objects(name, address, status), responsible:contacts!responsible_contact_id(full_name, phone)')
    .eq('status', TENDER_OPEN_STATUS)
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, to))
  const open = (tenders || []).filter((t) => (t.tender_type == null || t.tender_type === 'main') && OPEN_OBJECT_STATUSES.has(t.objects?.status))
  const mine = (table, columns) => fetchAllRows((from, to) => db
    .from(table)
    .select(columns)
    .eq('counterparty_id', counterpartyId)
    .order('id', { ascending: true })
    .range(from, to))
  const [invites, requests, rates] = await Promise.all([
    mine('tender_counterparties', 'id, tender_id, status'),
    readOptional(() => mine('tender_bid_requests', 'id, tender_id, status')),
    readOptional(() => mine('tender_bid_rates', 'id, tender_id, price, total')),
  ])
  const inviteOf = new Map(invites.map((r) => [r.tender_id, r.status]))
  const requestOf = new Map(requests.map((r) => [r.tender_id, r.status]))
  const pricedOf = new Map()
  for (const r of rates) {
    const sum = pricedOf.get(r.tender_id) || { cnt: 0, total: 0 }
    if (r.price != null) sum.cnt += 1
    sum.total += Number(r.total || 0)
    pricedOf.set(r.tender_id, sum)
  }
  const clean = (v) => String(v ?? '').trim() || null
  return open.map((t) => ({
    id: t.id,
    public_tender_number: t.public_tender_number,
    work_description: t.work_description,
    tender_status: t.status,
    is_open: true,
    object_name: t.objects?.name || t.custom_object_name || null,
    object_address: t.objects?.address || null,
    responsible_name: clean(t.responsible?.full_name),
    responsible_phone: clean(t.responsible?.phone),
    tender_start_date: t.tender_start_date,
    tender_end_date: t.tender_end_date,
    start_date: t.start_date,
    end_date: t.end_date,
    tender_package_link: t.tender_package_link,
    access: inviteOf.has(t.id) ? 'invited' : (requestOf.get(t.id) || cabinetSandbox()?.access.get(t.id) || null),
    invite_status: (inviteOf.has(t.id) && cabinetSandbox()?.participation.get(t.id)) || inviteOf.get(t.id) || null,
    request_status: requestOf.get(t.id) || null,
    priced_count: pricedOf.get(t.id)?.cnt || 0,
    priced_total: pricedOf.get(t.id)?.total || 0,
  }))
}

// Заявка на участие → доступ: 'invited' | 'pending' | 'accepted' | 'rejected'.
export async function requestParticipation(tenderId) {
  if (inSandbox()) { cabinetSandbox().access.set(tenderId, 'pending'); return 'pending' }
  return unwrap(await db.rpc('bid_request', { p_tender: tenderId }))
}

// Отметка участия: 'proposal_provided' | 'declined'. Функции ещё нет — прямая запись, как раньше.
export async function setParticipationStatus(tenderId, counterpartyId, status) {
  if (inSandbox()) { cabinetSandbox().participation.set(tenderId, status); return }
  const { error } = await db.rpc('contractor_set_participation', { p_tender: tenderId, p_status: status })
  if (!error) return
  if (!isMissingBids(error)) throw error
  const direct = await db
    .from('tender_counterparties')
    .update({ status })
    .eq('tender_id', tenderId)
    .eq('counterparty_id', counterpartyId)
  if (direct.error) throw direct.error
}

// «Моя компания» в просмотре от имени подрядчика: функция ищет компанию по учётке вошедшего, а у администратора её нет. Поэтому
// строка контрагента и его контакты читаются напрямую; показывает вкладка только свой перечень полей, сведений учётки здесь нет.
export async function loadOrgCardPreview(counterpartyId) {
  const [company, contacts] = await Promise.all([
    db.from('counterparties').select('*').eq('id', counterpartyId).maybeSingle(),
    db.from('counterparty_contacts').select('id, full_name, position, phone, email').eq('counterparty_id', counterpartyId)
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
  ])
  if (company.error) throw company.error
  if (contacts.error) throw contacts.error
  return company.data ? { ...company.data, contacts: contacts.data || [] } : null
}

// Сведения о своей компании (миграции 20261204, 20261226). null — функции ещё нет.
export async function loadOrgCard() {
  const { data, error } = await db.rpc('contractor_org_card')
  if (error) {
    if (isMissingBids(error) || /contractor_org_card/.test(String(error.message || ''))) return null
    throw error
  }
  return (Array.isArray(data) ? data[0] : data) || null
}

// Позиции ВОР, разобранные сервером (миграция 20261204): подрядчику с регистрации файлы не отдаются.
// → [{ id, file_name, parsed: { status, result?, error? } }], в том же виде, что разбор файла в браузере.
export async function loadServerPositions(tenderId) {
  const { data, error } = await db.rpc('bid_positions', { p_tender: tenderId })
  if (error) throw error
  return (data || []).map((row) => {
    const positions = row.positions || []
    const parsed = row.status === 'ok'
      ? { status: 'ok', result: {
        materials: positions.filter((p) => p.kind === 'material'),
        works: positions.filter((p) => p.kind === 'work'),
        structure: row.structure || [],
        conditions: row.conditions || [],
      } }
      : row.status === 'pending' ? { status: 'pending' } : { status: 'error', error: row.error || 'broken' }
    return { id: row.file_id, file_name: row.title, parsed }
  })
}

export const BID_DOC_CATEGORIES = ['tender_package', 'vor', 'rd', 'vor_statement']
export const VOR_CATEGORIES = ['vor_statement', 'vor']

// Файлы тендера, видимые подрядчику (правило s3_documents: свои тендеры и тендеры с заявкой).
// Список читают и страница кабинета («Документы тендера»), и расценка (ведомости ВОР) — одним запросом: с организацией (counterpartyId)
// ответ помнится TENDER_FILES_TTL_MS, второй вызов получает тот же. Правило строк — по организации, поэтому и ключ с ней. Ошибка не
// запоминается.
const TENDER_FILES_TTL_MS = 15_000
const tenderFilesShared = new Map() // `${организация}|${тендер}` → { at, promise }
const readTenderFiles = async (tenderId) => unwrap(await db
  .from('s3_documents')
  .select('id, owner_id, doc_category, file_name, s3_key, mime_type, size_bytes, created_at')
  .eq('owner_type', 'tender')
  .eq('owner_id', tenderId)
  .in('doc_category', BID_DOC_CATEGORIES)
  .order('created_at', { ascending: false })) || []
export function loadTenderFiles(tenderId, counterpartyId = null) {
  if (!counterpartyId) return readTenderFiles(tenderId)
  const key = `${counterpartyId}|${tenderId}`
  const hit = tenderFilesShared.get(key)
  if (hit && Date.now() - hit.at < TENDER_FILES_TTL_MS) return hit.promise
  const promise = readTenderFiles(tenderId)
  tenderFilesShared.set(key, { at: Date.now(), promise })
  promise.catch(() => { if (tenderFilesShared.get(key)?.promise === promise) tenderFilesShared.delete(key) })
  return promise
}

// Байты файла ВОР — по подписанной ссылке (её выдаёт сервер, только если строка файла видна).
export const downloadFileBytes = (s3Key) => fetchFileBytes(s3Key)

// Ведомости, заменённые новой версией (миграция 20270114, тендер № 847): [{ file_id, current_file_id }] — по отметке снабжения, как
// «Сравнение КП». null — функции ещё нет или ответ не пришёл: тогда кабинет показывает все файлы, как раньше (лишний файл лучше, чем
// пропавшая ведомость).
export async function loadVorSuperseded(tenderId) {
  try {
    const { data, error } = await db.rpc('bid_vor_superseded', { p_tender: tenderId })
    if (error) {
      if (!isMissingBids(error)) console.error('Заменённые ведомости ВОР:', error)
      return null
    }
    return Array.isArray(data) ? data.filter((r) => r?.file_id) : null
  } catch (e) {
    console.error('Заменённые ведомости ВОР:', e)
    return null
  }
}

// ── Свой ВОР с расценками (миграция 20270113, решение пользователя 11.11.2026) ─────────────────────────
// С 24.11.2026 расценка — на сайте; 25.11.2026 загрузка файла закрыта (/api/fn/bid-file отвечает на upload и confirm 410). Ранее
// загруженные файлы читают организация (свои) и администратор; ссылку выдаёт служба, ключа файла браузер не видит.
const BID_FILE_COLUMNS = 'id, tender_id, counterparty_id, vor_file_id, vor_name, file_name, size_bytes, summary, uploaded_by_name, created_at, updated_at'

// Свои файлы по тендеру. null — таблицы ещё нет (база раньше миграции): кабинет показывает прежнюю расценку на сайте.
// counterpartyId — всегда своя организация: администратору (просмотр от имени подрядчика) правило показывает файлы всех.
export async function loadBidFiles(tenderId, counterpartyId) {
  const { data, error } = await db
    .from('tender_bid_files')
    .select(BID_FILE_COLUMNS)
    .eq('tender_id', tenderId)
    .eq('counterparty_id', counterpartyId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

// Все файлы подрядчиков — администратору (сводка). null — таблицы ещё нет.
export async function loadAllBidFiles() {
  try {
    return await fetchAllRows((from, to) => db
      .from('tender_bid_files')
      .select(BID_FILE_COLUMNS)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))
  } catch (e) {
    if (isMissingBids(e)) return null
    throw e
  }
}

const bidFileCall = async (body) => unwrapFunction(await requestBidFile(body))

export const removeBidFile = (fileId) => bidFileCall({ action: 'delete', file_id: fileId })
// { presigned_url, file_name } — ссылка на скачивание своего файла; администратору — свой маршрут.
export const bidFileUrl = (fileId) => bidFileCall({ action: 'download', file_id: fileId })
export const bidFileUrlAdmin = async (fileId) => unwrapFunction(await requestBidFileAdmin(fileId))

const RATE_COLUMNS = 'id, tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_at'

// counterpartyId — просмотр от имени подрядчика: администратору правило показывает цены всех организаций тендера.
export async function loadMyRates(tenderId, counterpartyId = null) {
  const rows = await fetchAllRows((from, to) => {
    let q = db
      .from('tender_bid_rates')
      .select(RATE_COLUMNS)
      .eq('tender_id', tenderId)
    if (counterpartyId) q = q.eq('counterparty_id', counterpartyId)
    return q.order('id', { ascending: true }).range(from, to)
  })
  return counterpartyId && inSandbox(counterpartyId) ? withSandboxRates(tenderId, rows) : rows
}

// Свои цены из других тендеров — подсказки «ваша цена в тендере № …». Самые свежие первыми, не больше limit. Взятые у снабжения
// (source = 'supply', миграция 20270301) — не цена подрядчика: в другой тендер не подставляются.
export async function loadMyRateHistory(excludeTenderId, limit = 20000, page = 1000) {
  const rows = []
  for (let from = 0; from < limit; from += page) {
    let q = db
      .from('tender_bid_rates')
      .select('tender_id, kind, item_key, unit_key, name, unit, price, updated_at')
    // Просмотр от имени подрядчика: администратору правило показывает цены всех организаций — только этой.
    if (cabinetSandbox()) q = q.eq('counterparty_id', cabinetSandbox().cp)
    const { data, error } = await q
      .neq('tender_id', excludeTenderId)
      .neq('source', 'supply')
      .not('price', 'is', null)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, Math.min(from + page, limit) - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < page) break
  }
  return rows
}

// Последняя своя цена по каждой позиции тендера в других тендерах (миграция 20270302): один запрос на порцию в 1000 ключей (ответ — не
// больше строки на ключ, в пределах 1000 строк PostgREST); порции — по очереди (у учётки с регистрации предел одновременных запросов
// шлюза, а обычно порция и так одна). Раньше — постранично все свои цены (до 20 запросов подряд на каждое открытие тендера); функции
// нет — так и остаётся. keys — ключи позиций «вид|наименование|ед. изм.».
const HISTORY_CHUNK = 1000
export async function loadRateHistory(tenderId, keys) {
  const list = [...new Set(keys || [])]
  if (!list.length) return []
  // Просмотр от имени подрядчика: функция берёт организацию вошедшего, у администратора её нет — прежний путь по этой организации.
  if (cabinetSandbox()) return loadMyRateHistory(tenderId)
  const rows = []
  for (let i = 0; i < list.length; i += HISTORY_CHUNK) {
    const { data, error } = await db.rpc('bid_rate_history', { p_tender: tenderId, p_keys: list.slice(i, i + HISTORY_CHUNK) })
    if (error) {
      if (isMissingBids(error)) return loadMyRateHistory(tenderId)
      throw error
    }
    rows.push(...(data || []))
  }
  return rows
}

// Запись цен порциями (функция принимает до 2000 строк). rows — [{ kind, key, unit_key, name, unit, volume, price,
// note, source }]; price = null и пустое примечание — цена убирается.
export const SAVE_CHUNK = 500
export async function saveRates(tenderId, rows) {
  if (inSandbox()) {
    const over = sandboxRates(tenderId)
    const at = new Date().toISOString()
    for (const r of rows) {
      const k = `${r.kind}|${r.key}|${r.unit_key || ''}`
      if (r.price == null && !String(r.note || '').trim()) { over.set(k, { deleted: true }); continue }
      over.set(k, {
        kind: r.kind, item_key: r.key, unit_key: r.unit_key || '', name: r.name, unit: r.unit, volume: r.volume, price: r.price,
        total: r.price == null ? null : Math.round(r.price * Number(r.volume || 0) * 100) / 100, note: r.note || null,
        source: r.source || 'manual', updated_at: at,
      })
    }
    return rows.length
  }
  let saved = 0
  for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
    saved += unwrap(await db.rpc('bid_rates_save', { p_tender: tenderId, p_rows: rows.slice(i, i + SAVE_CHUNK) })) || 0
  }
  return saved
}

// ── Расценка на сайте: цены снабжения и изменения ВОР (миграция 20270301) ─────────────────────────────
// Подрядчик берёт цены снабжения материалов тендера только с разрешения отдела: просит (bid_supply_request), инженер ОСП или
// администратор в «Тендерах на материалы» открывает позиции (bid_supply_grant, миграция 20270303: по одной или все сразу) или
// запрещает (bid_supply_decide). Цены отдаёт bid_supply_prices (ключ позиции и цена открытых позиций, без ВОР и документов),
// записывает bid_supply_take — цену берёт база, браузер её не присылает.

// Разрешение своей организации по тендеру: { status, requested_at, decided_at } | null (не просили); undefined — таблицы ещё нет.
export async function loadSupplyAccess(tenderId, counterpartyId) {
  if (!counterpartyId) return undefined
  const { data, error } = await db.from('tender_bid_supply_access')
    .select('status, requested_at, decided_at')
    .eq('tender_id', tenderId)
    .eq('counterparty_id', counterpartyId)
    .limit(1)
  if (error) {
    if (isMissingBids(error)) return undefined
    throw error
  }
  const row = data?.[0] || null
  const asked = inSandbox(counterpartyId) ? cabinetSandbox().supply.get(tenderId) : null
  return asked && row?.status !== 'granted' && row?.status !== 'requested' ? { ...(row || {}), ...asked } : row
}

export async function requestSupplyPrices(tenderId) {
  if (inSandbox()) {
    cabinetSandbox().supply.set(tenderId, { status: 'requested', requested_at: new Date().toISOString(), decided_at: null })
    return 'requested'
  }
  return unwrap(await db.rpc('bid_supply_request', { p_tender: tenderId }))
}

// Цены снабжения → Map(`${item_key}|${unit_key}` → цена) — только позиции, которые отдел открыл (20270303). Постранично: у тендера
// № 38 цен снабжения больше 1000 (предел ответа). previewCounterpartyId — просмотр от имени подрядчика (администратор).
export async function loadSupplyPrices(tenderId, previewCounterpartyId = null) {
  const args = { p_tender: tenderId }
  if (previewCounterpartyId) args.p_counterparty = previewCounterpartyId
  const rows = await fetchAllRows((from, to) => db.rpc('bid_supply_prices', args).range(from, to))
  return new Map(rows.map((r) => [`${r.item_key}|${r.unit_key || ''}`, Number(r.price)]))
}

// Счета снабжения к ценам, которые организация взяла у снабжения (миграция 20270302): Map(`${item_key}|${unit_key}` →
// [{ id, file_name, uploaded_at }]) — у позиции бывает несколько файлов (разные ВОР). Только с разрешением отдела, пока идёт приём, и
// только у цены снабжения, которую не меняли. null — функции ещё нет (база раньше миграции): счетов просто нет.
export async function loadSupplyDocs(tenderId, previewCounterpartyId = null) {
  const args = { p_tender: tenderId }
  if (previewCounterpartyId) args.p_counterparty = previewCounterpartyId
  let rows
  try {
    rows = await fetchAllRows((from, to) => db.rpc('bid_supply_docs', args).range(from, to))
  } catch (e) {
    if (isMissingBids(e)) return null
    throw e
  }
  const map = new Map()
  for (const r of rows) {
    const k = `${r.item_key}|${r.unit_key || ''}`
    if (!map.has(k)) map.set(k, [])
    if (!map.get(k).some((d) => d.id === r.document_id)) map.get(k).push({ id: r.document_id, file_name: r.file_name, uploaded_at: r.uploaded_at })
  }
  return map
}

// Счёт снабжения: подрядчику — ссылка от службы (строки s3_documents ему закрыты), сотруднику в просмотре от имени подрядчика — обычным
// путём файлов по ключу из строки документа (её ему показывает правило базы).
export async function supplyDocUrl(tenderId, documentId, view = false) {
  return unwrapFunction(await requestBidSupplyDoc(tenderId, documentId, view))
}
export async function supplyDocKey(documentId) {
  const { data, error } = await db.from('s3_documents').select('s3_key, file_name').eq('id', documentId).maybeSingle()
  if (error) throw error
  if (!data?.s3_key) throw new Error('файл не найден')
  return data
}
// Окно просмотра счёта (просьба пользователя 25.11.2026 «посмотреть счёт»). PDF и картинка — по ссылке «показать», как окно просмотра
// файлов (S3DocumentPreview): подрядчику её подписывает служба (view; inline: false — прежняя служба или не PDF/картинка: окно
// предлагает «Скачать»), сотруднику в просмотре — обычный путь файлов по ключу. Не из памяти страницы (blob:): такой документ
// наследует политику содержимого портала (object-src 'none'), и Chrome может не показать в нём PDF. → { url, inline }
export async function supplyDocView(tenderId, documentId, preview = false) {
  if (preview) {
    const { presigned_url } = await requestDownloadUrl((await supplyDocKey(documentId)).s3_key)
    return { url: presigned_url, inline: true }
  }
  const r = await supplyDocUrl(tenderId, documentId, true)
  return { url: r.presigned_url, inline: r.inline === true }
}
// Байты счёта — Excel в окне просмотра читает страница (листами): подрядчику — по ссылке службы, сотруднику — по ключу.
export async function supplyDocBytes(tenderId, documentId, preview = false) {
  if (preview) return fetchFileBytes((await supplyDocKey(documentId)).s3_key)
  const { presigned_url } = await supplyDocUrl(tenderId, documentId)
  const res = await fetch(presigned_url)
  if (!res.ok) throw new Error(res.status === 404 ? 'файла нет в хранилище' : `хранилище ответило ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// Взять цены снабжения для позиций материалов: [{ key, unit_key, name, unit, volume }]; replace — заменить и свою цену. → сколько записано.
export async function takeSupplyPrices(tenderId, rows, replace = false) {
  if (inSandbox()) {
    // Как bid_supply_take: цену берёт «база» (здесь — открытые организации цены снабжения), своя цена — только при replace.
    const [prices, current] = await Promise.all([loadSupplyPrices(tenderId, cabinetSandbox().cp), loadMyRates(tenderId, cabinetSandbox().cp)])
    const own = new Map(current.map((r) => [rateRowKey(r), r]))
    const take = []
    for (const r of rows) {
      const price = prices.get(`${r.key}|${r.unit_key || ''}`)
      const cur = own.get(`material|${r.key}|${r.unit_key || ''}`)
      if (price == null || (!replace && cur?.price != null && cur.source !== 'supply')) continue
      take.push({ kind: 'material', key: r.key, unit_key: r.unit_key || '', name: r.name, unit: r.unit, volume: r.volume, price, note: cur?.note || null, source: 'supply' })
    }
    return take.length ? saveRates(tenderId, take) : 0
  }
  let n = 0
  for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
    n += unwrap(await db.rpc('bid_supply_take', { p_tender: tenderId, p_rows: rows.slice(i, i + SAVE_CHUNK), p_replace: replace })) || 0
  }
  return n
}

// Ведомости тендера: когда загружены, что о них знает снабжение и прежняя версия (позиции без цен). null — функции ещё нет.
export async function loadVorChanges(tenderId) {
  const { data, error } = await db.rpc('bid_vor_changes', { p_tender: tenderId })
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

// Инженеру: подрядчики тендеров с учёткой кабинета и их разрешение на цены снабжения (без цен). null — функции ещё нет.
export async function loadSupplyList(tenderIds) {
  const ids = [...new Set(tenderIds || [])].filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await db.rpc('bid_supply_list', { p_tenders: ids })
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

export async function decideSupplyAccess(tenderId, counterpartyId, allow) {
  return unwrap(await db.rpc('bid_supply_decide', { p_tender: tenderId, p_counterparty: counterpartyId, p_allow: allow }))
}

// Инженер ОСП (миграция 20270303): позиции тендера с ценой снабжения и открыты ли они организации —
// [{ item_key, unit_key, name, unit, price, vors, granted, taken }]. Постранично: позиций бывает больше 1000.
export async function loadSupplyItems(tenderId, counterpartyId) {
  return fetchAllRows((from, to) => db.rpc('bid_supply_items', { p_tender: tenderId, p_counterparty: counterpartyId }).range(from, to))
}

// Открыть организации позиции: items — [{ key, unit_key }] (набор заменяется целиком) или all — все нынешние позиции с ценой
// снабжения (список берёт база). → сколько позиций открыто; ни одной — разрешение снимается.
export async function grantSupplyItems(tenderId, counterpartyId, { items = [], all = false } = {}) {
  return unwrap(await db.rpc('bid_supply_grant', { p_tender: tenderId, p_counterparty: counterpartyId, p_items: all ? [] : items, p_all: all }))
}

// Сколько подрядчиков просят цены снабжения — по тендерам реестра (лёгкий запрос). null — таблицы ещё нет.
export async function loadSupplyRequestCounts(tenderIds) {
  const ids = [...new Set(tenderIds || [])].filter(Boolean)
  const counts = {}
  if (!ids.length) return counts
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await db.from('tender_bid_supply_access').select('tender_id')
      .in('tender_id', ids.slice(i, i + 60)).eq('status', 'requested')
    if (error) {
      if (isMissingBids(error)) return null
      throw error
    }
    for (const r of data || []) counts[r.tender_id] = (counts[r.tender_id] || 0) + 1
  }
  return counts
}

// Поля анкеты (активные — подрядчику; все — администратору). scope / source — вид поля и связь с «Моей компанией» (миграция
// 20270115); колонок ещё нет — поля без них, анкета как раньше: каждый тендер отдельно.
const FIELD_COLUMNS = 'id, label, hint, kind, options, code, sort_order, is_active, updated_at'
let fieldLinks = true
export async function loadFormFields({ all = false } = {}) {
  const read = () => {
    let q = db.from('bid_form_fields').select(fieldLinks ? `${FIELD_COLUMNS}, scope, source` : FIELD_COLUMNS)
    if (!all) q = q.eq('is_active', true)
    return q.order('sort_order', { ascending: true }).order('created_at', { ascending: true })
  }
  let { data, error } = await read()
  if (error?.code === '42703' && fieldLinks) {
    fieldLinks = false
    ;({ data, error } = await read())
  }
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}
export const formFieldLinksEnabled = () => fieldLinks

// Ответы организации на поля о компании (миграция 20270115): { answers, updated_at } | { answers: {} } (ещё не отвечали) | null — таблицы
// ещё нет. counterpartyId — своя организация (администратору в просмотре правило показывает ответы всех).
export async function loadCompanyAnswers(counterpartyId) {
  if (!counterpartyId) return null
  const { data, error } = await db.from('bid_company_answers').select('answers, updated_at').eq('counterparty_id', counterpartyId).maybeSingle()
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  const row = data || { answers: {}, updated_at: null }
  return inSandbox(counterpartyId) && cabinetSandbox().company ? { ...row, answers: withSandboxAnswers(row.answers, cabinetSandbox().company) } : row
}

// Записать ответы о компании: { id поля: значение }, пустое — убрать. Те же ответы база пишет в анкеты идущих тендеров организации.
export async function saveCompanyAnswers(answers) {
  if (inSandbox()) { cabinetSandbox().company = { ...(cabinetSandbox().company || {}), ...answers }; return Object.keys(answers || {}).length }
  return unwrap(await db.rpc('bid_company_save', { p_answers: answers }))
}

// Анкета организации по тендеру и последняя заполненная (для подстановки в новый тендер). counterpartyId — как в loadMyRates.
export async function loadMyForm(tenderId, counterpartyId = null) {
  const ofOrg = (q) => (counterpartyId ? q.eq('counterparty_id', counterpartyId) : q)
  const [own, last] = await Promise.all([
    ofOrg(db.from('tender_bid_forms').select('answers, updated_at').eq('tender_id', tenderId)).maybeSingle(),
    ofOrg(db.from('tender_bid_forms').select('tender_id, answers, updated_at').neq('tender_id', tenderId))
      .order('updated_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (own.error) throw own.error
  let form = own.data || null
  const draft = counterpartyId && inSandbox(counterpartyId) ? cabinetSandbox().forms.get(tenderId) : null
  if (draft) form = { ...(form || {}), answers: withSandboxAnswers(form?.answers, draft) }
  return { form, previous: last.error ? null : (last.data || null) }
}

export async function saveForm(tenderId, answers) {
  if (inSandbox()) { cabinetSandbox().forms.set(tenderId, { ...(cabinetSandbox().forms.get(tenderId) || {}), ...answers }); return Object.keys(answers || {}).length }
  return unwrap(await db.rpc('bid_form_save', { p_tender: tenderId, p_answers: answers }))
}

// ── Инженер: заявки с сайта ──────────────────────────────────────────────────────────────────────────
const REQUEST_COLUMNS = 'id, tender_id, counterparty_id, status, requested_by_name, requested_at, decided_by_name, decided_at, counterparties(id, name, inn)'
// С пометкой «регистрация с сайта» (миграция 20261203). Колонки ещё нет (база раньше миграции) — без неё.
const REQUEST_COLUMNS_SELF = REQUEST_COLUMNS.replace('counterparties(id, name, inn)', 'counterparties(id, name, inn, registered_via)')
let requestColumns = REQUEST_COLUMNS_SELF

// Заявки тендеров (порциями id). null — таблицы ещё нет.
export async function loadBidRequests(tenderIds, { status = null } = {}) {
  const ids = [...new Set(tenderIds || [])].filter(Boolean)
  if (!ids.length) return []
  const out = []
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60)
    const read = () => {
      let q = db.from('tender_bid_requests').select(requestColumns).in('tender_id', chunk)
      if (status) q = q.eq('status', status)
      return q.order('requested_at', { ascending: true })
    }
    let { data, error } = await read()
    if (error?.code === '42703' && requestColumns !== REQUEST_COLUMNS) {
      requestColumns = REQUEST_COLUMNS
      ;({ data, error } = await read())
    }
    if (error) {
      if (isMissingBids(error)) return null
      throw error
    }
    out.push(...(data || []))
  }
  return out
}

// Сколько заявок ждут решения — по тендерам реестра (лёгкий запрос: только id тендера).
export async function loadPendingRequestCounts(tenderIds) {
  const ids = [...new Set(tenderIds || [])].filter(Boolean)
  const counts = {}
  if (!ids.length) return counts
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await db.from('tender_bid_requests').select('tender_id')
      .in('tender_id', ids.slice(i, i + 60)).eq('status', 'pending')
    if (error) {
      if (isMissingBids(error)) return null
      throw error
    }
    for (const r of data || []) counts[r.tender_id] = (counts[r.tender_id] || 0) + 1
  }
  return counts
}

export async function decideBidRequest(requestId, accept) {
  return unwrap(await db.rpc('bid_decide', { p_request: requestId, p_accept: accept }))
}

// ── Администратор ────────────────────────────────────────────────────────────────────────────────────
// Статус завершённого тендера: его цены с сайта — уже в реестре «Расценки от подрядчиков (КП)» (миграция 20261103),
// во вкладке «Расценки подрядчиков (актуальные тендеры)» он не показывается.
export const BID_TENDER_DONE = 'Завершен'

// Позиции с ценой по актуальным (не завершённым) тендерам — страница списка. null — таблицы ещё нет.
export async function loadCurrentBidRates({ kind, search = '', page = 0, pageSize = 100 }) {
  let q = db.from('tender_bid_rates')
    .select('id, kind, name, unit, volume, price, total, note, source, updated_at, tender_id, counterparty_id, tenders!inner(public_tender_number, work_description, status), counterparties(name)', { count: 'exact' })
    .eq('kind', kind)
    .neq('tenders.status', BID_TENDER_DONE)
    .not('price', 'is', null)
  const s = search.trim()
  if (s) q = q.ilike('name', `%${s}%`)
  const { data, error, count } = await q
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1)
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return { rows: data || [], count: count ?? (data || []).length }
}

export async function loadBidOverview() {
  const { data, error } = await db.rpc('bid_admin_overview')
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

export async function loadBidRates(tenderId, counterpartyId) {
  return fetchAllRows((from, to) => db
    .from('tender_bid_rates')
    .select(RATE_COLUMNS)
    .eq('tender_id', tenderId)
    .eq('counterparty_id', counterpartyId)
    .order('kind', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}

export async function loadBidForm(tenderId, counterpartyId) {
  return unwrap(await db.from('tender_bid_forms').select('answers, updated_at')
    .eq('tender_id', tenderId).eq('counterparty_id', counterpartyId).maybeSingle())
}

export async function createFormField({ label, hint, kind = 'text', options = null, sort_order, scope = null, source = null }) {
  const row = { label, hint: hint || null, kind, options: kind === 'select' ? options : null, sort_order }
  // Вид и связь — только если колонки есть (миграция 20270115).
  if (fieldLinks && scope) Object.assign(row, { scope: source ? 'company' : scope, source: source || null })
  return unwrap(await db.from('bid_form_fields').insert([row]).select('id').single())
}

export async function updateFormField(id, patch) {
  return unwrap(await db.from('bid_form_fields').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id))
}

export async function deleteFormField(id) {
  return unwrap(await db.from('bid_form_fields').delete().eq('id', id))
}
