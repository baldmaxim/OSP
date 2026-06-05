// Frontend-сервис для работы с S3 через Edge Function `s3-presign` (task 277).
// Frontend никогда не получает access_key/secret — только presigned URL-ы.
import { supabase } from '../supabase'

const FUNCTION_NAME = 's3-presign'

async function invokePresign(action, payload) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: { action, ...payload }
  })
  if (error) throw error
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
