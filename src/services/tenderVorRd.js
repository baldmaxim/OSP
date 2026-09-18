// «ВОРы и РД» тендера: рабочая документация (PDF) с шифрами РД и ведомости
// объёмов работ (миграция 20260918_tender_rd_documents).
//
// Файлы — в s3_documents (owner_type='tender'), различаются категорией:
//   'rd'            — рабочая документация, PDF, у каждого файла ≥1 шифр РД;
//   'vor_statement' — ведомость объёмов работ;
//   'vor'           — прежняя общая категория, файлы загружены до разделения.
// Шифры — существующая таблица tender_rd_codes, связь — tender_rd_document_codes.
import { supabase } from '../supabase'
import { deleteDocument, uploadFile } from './s3'

export const RD_CATEGORY = 'rd'
export const VOR_STATEMENT_CATEGORY = 'vor_statement'
export const LEGACY_VOR_CATEGORY = 'vor'
// Все категории раздела — для счётчиков «Документы (N)» в реестрах.
export const VOR_RD_CATEGORIES = [RD_CATEGORY, VOR_STATEMENT_CATEGORY, LEGACY_VOR_CATEGORY]

const SORT_STEP = 10

export function isPdfFile(file) {
  if (!file) return false
  if (file.type === 'application/pdf') return true
  return /\.pdf$/i.test(file.name || '')
}

// 42P01 — таблицы нет (миграция не применена). Отличаем, чтобы показать понятное
// сообщение, а не «пустой раздел».
export function isMissingTableError(err, table) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(table) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Сколько ждём каждый запрос окна. Повисший запрос (например, таблица занята
// незавершённой транзакцией миграции) иначе держал «Загрузка…» до обрыва
// соединения и заканчивался невнятным «TypeError: Failed to fetch».
const LOAD_TIMEOUT_MS = 15000

// Поля файла, которые читают панель, превью и удаление.
const DOC_COLUMNS = 'id, owner_type, owner_id, doc_category, file_name, s3_key, mime_type, size_bytes, created_at, uploaded_by_name'

// Ошибка сети / таймаута, а не ответа базы: postgrest-js отдаёт её сообщением
// «TypeError: Failed to fetch», «TimeoutError: …», «AbortError: …».
export function isNetworkError(err) {
  const text = `${err?.name || ''} ${err?.message || ''}`
  return /Failed to fetch|NetworkError|Load failed|TimeoutError|AbortError|aborted|timed out/i.test(text)
}

// Текст для человека: что именно не загрузилось и почему.
export function describeLoadError(err, what) {
  if (isNetworkError(err)) {
    return `Нет ответа от сервера при загрузке: ${what}. Повторите через минуту — если не поможет, сообщите администратору.`
  }
  return `Не удалось загрузить ${what}: ${err?.message || err}`
}

export async function loadVorRd(tenderId) {
  const withTimeout = (builder) => builder.abortSignal(AbortSignal.timeout(LOAD_TIMEOUT_MS))
  // Части окна независимы: зависшие шифры не должны прятать уже загруженные
  // файлы. Запросы supabase не бросают исключений (ошибка — в .error), поэтому
  // Promise.all дожидается обоих, а разбираем каждую часть отдельно.
  const [docsRes, codesRes] = await Promise.all([
    withTimeout(supabase
      .from('s3_documents')
      .select(DOC_COLUMNS)
      .eq('owner_type', 'tender')
      .eq('owner_id', tenderId)
      .in('doc_category', VOR_RD_CATEGORIES)
      .order('created_at', { ascending: false })),
    withTimeout(supabase
      .from('tender_rd_codes')
      .select('id, code, title, sort_order, created_at')
      .eq('tender_id', tenderId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })),
  ])
  // Без файлов показывать нечего — это ошибка всего окна.
  if (docsRes.error) {
    const e = new Error(describeLoadError(docsRes.error, 'файлы'))
    e.cause = docsRes.error
    throw e
  }
  // Таблицы шифров нет — раздел не настроен (миграция 20260901): как раньше, ошибка окна.
  if (codesRes.error && isMissingTableError(codesRes.error, 'tender_rd_codes')) throw codesRes.error
  const codesError = codesRes.error ? describeLoadError(codesRes.error, 'шифры РД') : null

  const docs = docsRes.data || []
  const rdDocs = docs.filter(d => d.doc_category === RD_CATEGORY)

  // Связи тянем отдельно: у s3_documents нет FK на них, embed PostgREST не
  // построит. Отсутствие таблицы связей (миграция 20260918 не применена)
  // не роняет раздел — возвращаем флаг, панель предупредит.
  let links = []
  let linksMissing = false
  let linksError = null
  if (rdDocs.length > 0) {
    const { data, error } = await withTimeout(supabase
      .from('tender_rd_document_codes')
      .select('document_id, rd_code_id')
      .in('document_id', rdDocs.map(d => d.id)))
    if (error) {
      if (isMissingTableError(error, 'tender_rd_document_codes')) linksMissing = true
      else linksError = describeLoadError(error, 'шифры у файлов РД')
    } else {
      links = data || []
    }
  }

  const codeIdsByDoc = new Map()
  for (const l of links) {
    if (!codeIdsByDoc.has(l.document_id)) codeIdsByDoc.set(l.document_id, [])
    codeIdsByDoc.get(l.document_id).push(l.rd_code_id)
  }

  return {
    codes: codesRes.data || [],
    rdDocs: rdDocs.map(d => ({ ...d, codeIds: codeIdsByDoc.get(d.id) || [] })),
    vorDocs: docs.filter(d => d.doc_category === VOR_STATEMENT_CATEGORY),
    legacyDocs: docs.filter(d => d.doc_category === LEGACY_VOR_CATEGORY),
    linksMissing,
    // Частичные сбои: файлы видны, но без шифров — правка шифров закрыта.
    codesError,
    linksError,
  }
}

// Новый шифр в общий список тендера (та же таблица, что во вкладке «Шифр РД»).
export async function addRdCode(tenderId, { code, title }, existingCodes, byName) {
  const trimmed = String(code || '').trim()
  if (!trimmed) throw new Error('Укажите шифр РД')
  const dup = existingCodes.find(c => c.code.trim().toLowerCase() === trimmed.toLowerCase())
  if (dup) return dup
  const maxSort = existingCodes.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
  const { data, error } = await supabase
    .from('tender_rd_codes')
    .insert([{
      tender_id: tenderId,
      code: trimmed,
      title: String(title || '').trim() || null,
      sort_order: maxSort + SORT_STEP,
      created_by_name: byName || null,
    }])
    .select('id, code, title, sort_order, created_at')
    .single()
  if (error) throw error
  return data
}

// Загрузка PDF рабочей документации с шифрами. Файлы грузятся по одному: если
// привязка шифров к файлу не удалась, файл удаляем — PDF без шифра в разделе
// «РД» быть не должно.
export async function uploadRdDocuments(tenderId, files, codeIds, byName, onProgress) {
  if (!codeIds?.length) throw new Error('Выберите хотя бы один шифр РД')
  const bad = files.filter(f => !isPdfFile(f))
  if (bad.length) throw new Error(`Рабочая документация принимается только в PDF: ${bad.map(f => f.name).join(', ')}`)

  const created = []
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i + 1, files.length)
    const doc = await uploadFile({ file: files[i], ownerType: 'tender', ownerId: tenderId, category: RD_CATEGORY })
    const { error } = await supabase
      .from('tender_rd_document_codes')
      .insert(codeIds.map(id => ({ document_id: doc.id, rd_code_id: id, created_by_name: byName || null })))
    if (error) {
      try { await deleteDocument(doc) } catch { /* лучшее усилие */ }
      throw error
    }
    created.push(doc)
  }
  return created
}

// Заменить набор шифров у файла.
export async function setDocumentCodes(documentId, nextCodeIds, prevCodeIds, byName) {
  if (!nextCodeIds?.length) throw new Error('У документа РД должен остаться хотя бы один шифр')
  const next = new Set(nextCodeIds)
  const prev = new Set(prevCodeIds || [])
  const toAdd = [...next].filter(id => !prev.has(id))
  const toRemove = [...prev].filter(id => !next.has(id))
  // Сначала добавляем, потом удаляем: при сбое между шагами у файла не останется
  // пустого набора шифров.
  if (toAdd.length) {
    const { error } = await supabase
      .from('tender_rd_document_codes')
      .insert(toAdd.map(id => ({ document_id: documentId, rd_code_id: id, created_by_name: byName || null })))
    if (error) throw error
  }
  if (toRemove.length) {
    const { error } = await supabase
      .from('tender_rd_document_codes')
      .delete()
      .eq('document_id', documentId)
      .in('rd_code_id', toRemove)
    if (error) throw error
  }
}

// Счётчики документов раздела по тендерам — для реестров. Порции по 150 id:
// сотни UUID одним IN-списком в URL роняют запрос.
export async function fetchVorRdDocCounts(tenderIds) {
  const counts = {}
  if (!tenderIds?.length) return counts
  const chunks = []
  for (let i = 0; i < tenderIds.length; i += 150) chunks.push(tenderIds.slice(i, i + 150))
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await supabase
      .from('s3_documents')
      .select('owner_id')
      .eq('owner_type', 'tender')
      .in('doc_category', VOR_RD_CATEGORIES)
      .in('owner_id', chunk)
      .limit(10000)
    if (error) throw error
    return data || []
  }))
  for (const row of parts.flat()) counts[row.owner_id] = (counts[row.owner_id] || 0) + 1
  return counts
}

export async function countVorRdDocs(tenderId) {
  const { count, error } = await supabase
    .from('s3_documents')
    .select('id', { count: 'exact', head: true })
    .eq('owner_type', 'tender')
    .eq('owner_id', tenderId)
    .in('doc_category', VOR_RD_CATEGORIES)
  if (error) throw error
  return count || 0
}
