// Заявки на подготовку ВОР без привязки к тендеру (миграция 20261003_vor_requests).
//
// Поля ВОР названы так же, как у тендера (vor_status, vor_division, vor_sto_*,
// vor_end_date, vor_link), поэтому страница «ВОРы и РД» ведёт заявки и тендеры
// одними и теми же обработчиками — отличается только таблица.
// Файлы — s3_documents с owner_type='general', owner_id = id заявки.
import { supabase } from '../supabase'

export const VOR_REQUESTS_TABLE = 'vor_requests'
export const REQUEST_RD_CATEGORY = 'vor_request_rd'
export const REQUEST_VOR_CATEGORY = 'vor_request_vor'
export const REQUEST_DOC_CATEGORIES = [REQUEST_RD_CATEGORY, REQUEST_VOR_CATEGORY]
export const REQUEST_OWNER_TYPE = 'general'

export const VOR_REQUESTS_MIGRATION_HINT =
  'Заявки на ВОР недоступны: в базе не применена миграция 20261003_vor_requests.'

export function isMissingVorRequestsTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes('vor_requests') && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Заявки направления ('construction' | 'joint'), включая удалённые — для вкладки
// «Удалённые». Можно передать массив направлений: страница «ВОРы и РД» берёт
// оба разом, чтобы переключатель направления не ходил в базу.
// → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchVorRequests(department) {
  const departments = Array.isArray(department) ? department : [department]
  const { data, error } = await supabase
    .from(VOR_REQUESTS_TABLE)
    .select('*, objects(name, status)')
    .in('department', departments)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) {
    if (isMissingVorRequestsTable(error)) return { rows: [], supported: false }
    throw error
  }
  return { rows: data || [], supported: true }
}

export async function createVorRequest(payload) {
  const { data, error } = await supabase
    .from(VOR_REQUESTS_TABLE)
    .insert([payload])
    .select('*, objects(name, status)')
    .single()
  if (error) throw error
  return data
}

export async function updateVorRequest(id, patch) {
  const { error } = await supabase.from(VOR_REQUESTS_TABLE).update(patch).eq('id', id)
  if (error) throw error
}

// Число файлов заявок — для бейджа «РД и ВОР» и статус-гейта «Завершён».
export async function fetchVorRequestDocCounts(ids) {
  const counts = {}
  if (!ids?.length) return counts
  const chunks = []
  for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150))
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await supabase
      .from('s3_documents')
      .select('owner_id')
      .eq('owner_type', REQUEST_OWNER_TYPE)
      .in('doc_category', REQUEST_DOC_CATEGORIES)
      .in('owner_id', chunk)
      .limit(10000)
    if (error) throw error
    return data || []
  }))
  for (const row of parts.flat()) counts[row.owner_id] = (counts[row.owner_id] || 0) + 1
  return counts
}

export async function countVorRequestDocs(id) {
  const { count, error } = await supabase
    .from('s3_documents')
    .select('id', { count: 'exact', head: true })
    .eq('owner_type', REQUEST_OWNER_TYPE)
    .eq('owner_id', id)
    .in('doc_category', REQUEST_DOC_CATEGORIES)
  if (error) throw error
  return count || 0
}
