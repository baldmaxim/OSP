// Файл .md документа объекта — столбец справа от «Подписанный» (карточка объекта → «Документы», миграция 20261202).
// У документа один такой файл: object_documents.md_s3_document_id → s3_documents. Удалили строку файла — связь
// обнуляет база (ON DELETE SET NULL). Столбца нет, пока миграция не применена (fetchObjectDocuments → mdEnabled: false).
import { db } from '../api'
import { uploadFile, deleteDocument } from './s3'

export const DOC_MD_CATEGORY = 'object_doc_md'

const DOC_COLUMNS = '*, signed:s3_documents!signed_s3_document_id(*), editable:s3_documents!editable_s3_document_id(*)'
const DOC_COLUMNS_MD = `${DOC_COLUMNS}, md:s3_documents!md_s3_document_id(*)`

// Связи ещё нет: PostgREST не находит её в схеме (PGRST200), колонку — 42703.
const noMdColumn = (error) => error?.code === 'PGRST200' || error?.code === '42703'

export const isMdFileName = (name) => /\.md$/i.test(String(name || '').trim())

// Документы объекта с файлами. Порядок: при равных order_number — по дате создания (task 329: у документов без
// ручного порядка все order_number по умолчанию 0).
export async function fetchObjectDocuments(objectId) {
  const read = (columns) => db
    .from('object_documents')
    .select(columns)
    .eq('object_id', objectId)
    .order('order_number', { ascending: true })
    .order('created_at', { ascending: true })

  const withMd = await read(DOC_COLUMNS_MD)
  if (!withMd.error) return { rows: withMd.data || [], mdEnabled: true }
  if (!noMdColumn(withMd.error)) throw withMd.error

  const { data, error } = await read(DOC_COLUMNS)
  if (error) throw error
  return { rows: data || [], mdEnabled: false }
}

// Загрузить файл и привязать к документу; прежний файл удаляется только после привязки нового. Не привязался (нет
// права, документ уже удалён) — загруженный файл убирается, а прежний остаётся. Ответ — новая строка s3_documents.
export async function attachDocMd(doc, file) {
  const uploaded = await uploadFile({ file, ownerType: 'object', ownerId: doc.object_id, category: DOC_MD_CATEGORY })
  const { data, error } = await db
    .from('object_documents')
    .update({ md_s3_document_id: uploaded.id })
    .eq('id', doc.id)
    .select('id')
  if (error || !data?.length) {
    await deleteDocument(uploaded).catch(() => { /* лучшее усилие: файл ни к чему не привязан */ })
    throw error || new Error('нет права или документ уже удалён')
  }
  if (doc.md) {
    await deleteDocument(doc.md).catch((e) => console.warn('Прежний файл .md не удалён:', e?.message))
  }
  return uploaded
}

export const removeDocMd = (doc) => deleteDocument(doc.md)
