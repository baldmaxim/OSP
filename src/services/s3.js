// Frontend-сервис для работы с S3 через Edge Function `s3-presign` (task 277).
// Frontend никогда не получает access_key/secret — только presigned URL-ы.
import { supabase } from '../supabase'

const FUNCTION_NAME = 's3-presign'

async function invokePresign(action, payload) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: { action, ...payload }
  })
  if (error) {
    // supabase-js оборачивает non-2xx ответ в FunctionsHttpError, у которого message —
    // общий («non-2xx status code»). Достаём реальную причину из тела ответа функции
    // (например «Unsupported owner_type: general_document»), чтобы UI показал точную ошибку.
    let detail = ''
    try {
      const ctx = error.context
      if (ctx && typeof ctx.clone === 'function') {
        const body = await ctx.clone().json().catch(() => null)
        detail = body?.error || ''
      }
    } catch { /* тело недоступно или не JSON */ }
    throw new Error(detail || error.message || 'Ошибка запроса presigned URL')
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export async function requestUploadUrl({ ownerType, ownerId, fileName, mimeType }) {
  return invokePresign('upload', {
    owner_type: ownerType,
    owner_id: ownerId,
    file_name: fileName,
    mime_type: mimeType || 'application/octet-stream'
  })
}

export async function requestDownloadUrl(s3Key) {
  return invokePresign('download', { s3_key: s3Key })
}

export async function deleteS3Object(s3Key) {
  return invokePresign('delete', { s3_key: s3Key })
}

// Полный сценарий загрузки: presigned PUT в S3 + INSERT в s3_documents.
// Возвращает созданную запись. Если PUT упал, запись в БД не создаётся.
// `category` (task 370) — опциональная категория документа (например 'final').
// Если не передана, в БД пишется default 'general'.
export async function uploadFile({ file, ownerType, ownerId, notes = null, category = null }) {
  const mimeType = file.type || 'application/octet-stream'

  const { s3_key, presigned_url } = await requestUploadUrl({
    ownerType,
    ownerId,
    fileName: file.name,
    mimeType
  })

  const putResp = await fetch(presigned_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: file
  })
  if (!putResp.ok) {
    throw new Error(`S3 PUT не удался (${putResp.status} ${putResp.statusText})`)
  }

  // Снимок имени загрузившего — чтобы в UI не делать join каждый раз.
  let uploaded_by = null
  let uploaded_by_name = null
  try {
    const { data: { user } } = await supabase.auth.getUser()
    uploaded_by = user?.id || null
    if (user) {
      const { data: profile } = await supabase
        .from('user_roles')
        .select('full_name')
        .eq('user_id', user.id)
        .maybeSingle()
      uploaded_by_name = profile?.full_name || null
    }
  } catch { /* без user — оставим null */ }

  const { data, error } = await supabase
    .from('s3_documents')
    .insert({
      owner_type: ownerType,
      owner_id: ownerId,
      s3_key,
      file_name: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      notes,
      ...(category ? { doc_category: category } : {}),
      uploaded_by,
      uploaded_by_name
    })
    .select('*')
    .single()
  if (error) {
    // Откат: пробуем удалить уже загруженный объект, чтобы не оставлять «сирот».
    try { await deleteS3Object(s3_key) } catch { /* лучшее усилие */ }
    throw error
  }
  return data
}

// Удаление: сначала из S3, потом из БД. Если S3 упал — DB-запись не трогаем,
// чтобы её можно было повторно удалить.
export async function deleteDocument(doc) {
  await deleteS3Object(doc.s3_key)
  const { error } = await supabase.from('s3_documents').delete().eq('id', doc.id)
  if (error) throw error
}

// Список документов по владельцу.
// `category` (необязательно) — фильтр по `doc_category` (например 'vor').
export async function fetchDocuments(ownerType, ownerId, category = null) {
  let query = supabase
    .from('s3_documents')
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
  if (category) query = query.eq('doc_category', category)
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Сводка документов контрагентов по категориям «Согласование СБ» и «Должная
// осмотрительность» (doc_category 'sb_approval'/'other'). Возвращает
// Map<counterpartyId, { sb: {date}|null, other: {date, count}|null }>, где date —
// created_at последнего документа категории. `ids` (необязательно) ограничивает
// выборку конкретными контрагентами (для реестра договоров); без ids — по всем.
export async function fetchCounterpartyDocSummary(ids = null) {
  if (Array.isArray(ids) && ids.length === 0) return new Map()
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('s3_documents')
      .select('owner_id, doc_category, created_at')
      .eq('owner_type', 'counterparty')
      .in('doc_category', ['sb_approval', 'other'])
    if (Array.isArray(ids)) query = query.in('owner_id', ids)
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
  }

  const map = new Map()
  for (const r of rows) {
    let entry = map.get(r.owner_id)
    if (!entry) { entry = { sb: null, other: null }; map.set(r.owner_id, entry) }
    if (r.doc_category === 'sb_approval') {
      // created_at desc → первый встреченный = последний по дате.
      if (!entry.sb) entry.sb = { date: r.created_at }
    } else if (r.doc_category === 'other') {
      if (!entry.other) entry.other = { date: r.created_at, count: 1 }
      else entry.other.count += 1
    }
  }
  return map
}
