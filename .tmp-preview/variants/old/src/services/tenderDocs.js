// Сервис реестра документов тендера (вкладка «Документы» + блок «Итоговый документ»
// в зоне победителя). Модель зеркалит general_documents:
//   tender_docs        — карточка (наименование + описание + is_final)
//   tender_doc_links   — ссылки карточки
//   s3_documents       — файлы карточки, owner_type='tender', owner_id = tender_docs.id
//
// owner_id здесь — id КАРТОЧКИ, а не тендера, поэтому файлы карточек не пересекаются с
// VOR/пакетными файлами тендера (owner_id = tenders.id). Отдельный owner_type и правка
// edge-функции s3-presign не нужны.
import { supabase } from '../supabase'
import { deleteDocument } from './s3'

const OWNER_TYPE = 'tender'

// Подтягиваем файлы из s3_documents для набора карточек и группируем по owner_id (=id карточки).
async function attachFiles(docs) {
  const ids = (docs || []).map((d) => d.id)
  if (!ids.length) return docs.map((d) => ({ ...d, links: sortLinks(d), files: [] }))
  const { data: files, error } = await supabase
    .from('s3_documents')
    .select('id, owner_id, s3_key, file_name, size_bytes, created_at, uploaded_by_name')
    .eq('owner_type', OWNER_TYPE)
    .in('owner_id', ids)
    .order('created_at', { ascending: true })
  if (error) throw error
  const byDoc = (files || []).reduce((acc, f) => {
    (acc[f.owner_id] = acc[f.owner_id] || []).push(f)
    return acc
  }, {})
  return docs.map((d) => ({ ...d, links: sortLinks(d), files: byDoc[d.id] || [] }))
}

function sortLinks(d) {
  return [...(d.tender_doc_links || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

// Все карточки документов тендера (итоговый — первым), с ссылками и файлами.
export async function fetchTenderDocs(tenderId) {
  const { data, error } = await supabase
    .from('tender_docs')
    .select('*, tender_doc_links(*)')
    .eq('tender_id', tenderId)
    .order('is_final', { ascending: false })
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (error) throw error
  return attachFiles(data || [])
}

// Итоговая карточка (is_final) с ссылками и файлами, либо null.
export async function fetchTenderFinalDoc(tenderId) {
  const { data, error } = await supabase
    .from('tender_docs')
    .select('*, tender_doc_links(*)')
    .eq('tender_id', tenderId)
    .eq('is_final', true)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const [withFiles] = await attachFiles([data])
  return withFiles
}

// Get-or-create итоговой карточки (для загрузки итогового документа из зоны победителя).
export async function ensureTenderFinalDoc(tenderId, { userId = null, userName = null } = {}) {
  const existing = await fetchTenderFinalDoc(tenderId)
  if (existing) return existing
  const { data, error } = await supabase
    .from('tender_docs')
    .insert({
      tender_id: tenderId,
      title: 'Итоговый документ (решение о выборе подрядчика)',
      is_final: true,
      created_by: userId,
      created_by_name: userName,
      updated_by: userId,
      updated_by_name: userName,
    })
    .select('*')
    .single()
  if (error) throw error
  return { ...data, links: [], files: [] }
}

// Удаление карточки: сначала файлы из S3 (иначе останутся orphan), затем запись
// (ссылки удалятся каскадом).
export async function deleteTenderDoc(doc) {
  for (const f of (doc.files || [])) {
    await deleteDocument(f)
  }
  const { error } = await supabase.from('tender_docs').delete().eq('id', doc.id)
  if (error) throw error
}
