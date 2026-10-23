// Кабинет подрядчика: расценка ВОР на сайте, заявки на участие, анкета (миграция 20261102_contractor_bids).
//
// Подрядчик видит открытые тендеры и тендеры, где он участник (bid_contractor_tenders); расценивать может после
// заявки (bid_request) или как участник. Цены — одна на уникальную позицию тендера (вид + наименование + ед. изм.),
// пишутся только функцией bid_rates_save; анкета — bid_form_save. Инженер видит заявки и решает, сделать ли
// подрядчика участником (bid_decide). Цены и анкету читает администратор (bid_admin_overview) и сама организация.
//
// Пока миграции нет, функции и таблицы отвечают «не найдено» — сервис возвращает null, страницы работают как раньше.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { fetchFileBytes } from './s3'

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

// Заявка на участие → доступ: 'invited' | 'pending' | 'accepted' | 'rejected'.
export async function requestParticipation(tenderId) {
  return unwrap(await db.rpc('bid_request', { p_tender: tenderId }))
}

export const BID_DOC_CATEGORIES = ['tender_package', 'vor', 'rd', 'vor_statement']
export const VOR_CATEGORIES = ['vor_statement', 'vor']

// Файлы тендера, видимые подрядчику (правило s3_documents: свои тендеры и тендеры с заявкой).
export async function loadTenderFiles(tenderId) {
  return unwrap(await db
    .from('s3_documents')
    .select('id, owner_id, doc_category, file_name, s3_key, mime_type, size_bytes, created_at')
    .eq('owner_type', 'tender')
    .eq('owner_id', tenderId)
    .in('doc_category', BID_DOC_CATEGORIES)
    .order('created_at', { ascending: false })) || []
}

// Байты файла ВОР — по подписанной ссылке (её выдаёт сервер, только если строка файла видна).
export const downloadFileBytes = (s3Key) => fetchFileBytes(s3Key)

const RATE_COLUMNS = 'id, tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_at'

export async function loadMyRates(tenderId) {
  return fetchAllRows((from, to) => db
    .from('tender_bid_rates')
    .select(RATE_COLUMNS)
    .eq('tender_id', tenderId)
    .order('id', { ascending: true })
    .range(from, to))
}

// Свои цены из других тендеров — подсказки «ваша цена в тендере № …». Самые свежие первыми, не больше limit.
export async function loadMyRateHistory(excludeTenderId, limit = 20000, page = 1000) {
  const rows = []
  for (let from = 0; from < limit; from += page) {
    const { data, error } = await db
      .from('tender_bid_rates')
      .select('tender_id, kind, item_key, unit_key, name, unit, price, updated_at')
      .neq('tender_id', excludeTenderId)
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

// Запись цен порциями (функция принимает до 2000 строк). rows — [{ kind, key, unit_key, name, unit, volume, price,
// note, source }]; price = null и пустое примечание — цена убирается.
export const SAVE_CHUNK = 500
export async function saveRates(tenderId, rows) {
  let saved = 0
  for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
    saved += unwrap(await db.rpc('bid_rates_save', { p_tender: tenderId, p_rows: rows.slice(i, i + SAVE_CHUNK) })) || 0
  }
  return saved
}

// Поля анкеты (активные — подрядчику; все — администратору).
export async function loadFormFields({ all = false } = {}) {
  let q = db.from('bid_form_fields').select('id, label, hint, kind, options, code, sort_order, is_active, updated_at')
  if (!all) q = q.eq('is_active', true)
  const { data, error } = await q.order('sort_order', { ascending: true }).order('created_at', { ascending: true })
  if (error) {
    if (isMissingBids(error)) return null
    throw error
  }
  return data || []
}

// Анкета организации по тендеру и последняя заполненная (для подстановки в новый тендер).
export async function loadMyForm(tenderId) {
  const [own, last] = await Promise.all([
    db.from('tender_bid_forms').select('answers, updated_at').eq('tender_id', tenderId).maybeSingle(),
    db.from('tender_bid_forms').select('tender_id, answers, updated_at').neq('tender_id', tenderId)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (own.error) throw own.error
  return { form: own.data || null, previous: last.error ? null : (last.data || null) }
}

export async function saveForm(tenderId, answers) {
  return unwrap(await db.rpc('bid_form_save', { p_tender: tenderId, p_answers: answers }))
}

// ── Инженер: заявки с сайта ──────────────────────────────────────────────────────────────────────────
const REQUEST_COLUMNS = 'id, tender_id, counterparty_id, status, requested_by_name, requested_at, decided_by_name, decided_at, counterparties(id, name, inn)'

// Заявки тендеров (порциями id). null — таблицы ещё нет.
export async function loadBidRequests(tenderIds, { status = null } = {}) {
  const ids = [...new Set(tenderIds || [])].filter(Boolean)
  if (!ids.length) return []
  const out = []
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60)
    let q = db.from('tender_bid_requests').select(REQUEST_COLUMNS).in('tender_id', chunk)
    if (status) q = q.eq('status', status)
    const { data, error } = await q.order('requested_at', { ascending: true })
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

export async function createFormField({ label, hint, kind = 'text', options = null, sort_order }) {
  return unwrap(await db.from('bid_form_fields')
    .insert([{ label, hint: hint || null, kind, options: kind === 'select' ? options : null, sort_order }]).select('id').single())
}

export async function updateFormField(id, patch) {
  return unwrap(await db.from('bid_form_fields').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id))
}

export async function deleteFormField(id) {
  return unwrap(await db.from('bid_form_fields').delete().eq('id', id))
}
