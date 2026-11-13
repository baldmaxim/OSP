import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { DOC_CHECK_CHAT_CATEGORY, cardCountsById, isMissingBoardColumn } from '../utils/docCheckHelpers'
import { deleteDocument, fetchDocuments, uploadFile } from './s3'

// Запросы карточки заявки на проверку ДП/ДС: обсуждение (миграция 20261124), файлы в нём и «прочитано» (20270216). Шагов в
// заявке нет с 11.11.2026 — их таблицу не читаем. Автора и время сообщения ставит база (триггер), клиент их не шлёт.

const COMMENTS = 'doc_check_request_comments'

// Число сообщений на карточках доски: всё разом, а не запросом на заявку. Потолок 1000 строк на ответ — поэтому постранично.
// Автор и время — для непрочитанных (myId — вошедший: свои сообщения не новые). Текст не читаем.
export async function fetchCardCounts(myId = null) {
  const comments = await fetchAllRows((from, to) => db.from(COMMENTS).select('request_id, author_user_id, created_at')
    .order('request_id', { ascending: true }).order('id', { ascending: true }).range(from, to))
  return cardCountsById(comments, myId)
}

// Кто и когда удалил заявку: id → { name, at }. Берём из истории (событие soft_deleted) — так видно и уже удалённые, колонка
// в таблице не нужна. Заявку могли удалить, восстановить и удалить снова: важна последняя запись.
export async function fetchDeletions(ids) {
  const out = new Map()
  for (const part of chunkList(ids)) {
    const rows = await fetchAllRows((from, to) => db.from('doc_check_request_audit_log')
      .select('id, request_id, changed_by_name, changed_at')
      .eq('event_type', 'soft_deleted')
      .in('request_id', part)
      .order('changed_at', { ascending: false }).order('id', { ascending: true }).range(from, to))
    for (const r of rows) {
      if (!out.has(r.request_id)) out.set(r.request_id, { name: r.changed_by_name, at: r.changed_at })
    }
  }
  return out
}

// Кто создал заявку — id учётки (created_by, миграция 20270102; ставит база). Нужен окну заявки: автор с правом создания меняет
// файлы своей заявки, пока она в «Новых». В выборке доски этой колонки нет — читаем по одной заявке. Нет колонки — null.
export async function fetchRequestAuthor(requestId) {
  const { data, error } = await db.from('doc_check_requests').select('created_by').eq('id', requestId).maybeSingle()
  if (error) {
    if (isMissingBoardColumn(error)) return null
    throw error
  }
  return data?.created_by || null
}

export async function fetchComments(requestId) {
  return fetchAllRows((from, to) => db.from(COMMENTS).select('*').eq('request_id', requestId)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to))
}

// Чтение окна заявки — заранее (13.11.2026: «окно медленно открывается»): кнопку мыши на карточке нажали — переписка и файлы
// уже читаются, пока её не отпустили; окно берёт готовый ответ (takePrefetched) вместо своего запроса. Ответ годен PREFETCH_MS
// и берётся один раз: дальше (возврат на вкладку, после загрузки файла) окно читает само. comments — есть ли таблица обсуждения.
const PREFETCH_MS = 15000
const prefetched = new Map() // id заявки → { at, comments, files } (обещания)
export function prefetchCard(requestId, { comments = true } = {}) {
  if (!requestId) return
  const now = Date.now()
  for (const [id, hit] of prefetched) if (now - hit.at >= PREFETCH_MS) prefetched.delete(id)
  if (prefetched.has(requestId)) return
  const entry = { at: now, comments: comments ? fetchComments(requestId) : null, files: fetchDocuments('doc_check_request', requestId) }
  // Ошибка — забота окна: оно возьмёт отказ и покажет «Повторить», как при своём запросе.
  entry.comments?.catch(() => {})
  entry.files.catch(() => {})
  prefetched.set(requestId, entry)
}
export function takePrefetched(requestId, part) {
  const hit = prefetched.get(requestId)
  if (!hit || Date.now() - hit.at >= PREFETCH_MS || !hit[part]) return null
  const promise = hit[part]
  hit[part] = null
  if (!hit.comments && !hit.files) prefetched.delete(requestId)
  return promise
}

// fileIds — файлы сообщения (миграция 20270216): база запишет их снимок (имя, размер, отпечаток, ключ) сама, по id. Без файлов
// поле не шлётся — так сообщение пишется и в базу до миграции.
export async function addComment(requestId, body, fileIds = []) {
  const row = { request_id: requestId, body }
  if (fileIds.length) row.attachments = fileIds
  const { data, error } = await db.from(COMMENTS).insert(row).select('*').single()
  if (error) throw error
  return data
}

// Файл для сообщения — черновик вложения: строка s3_documents заявки категории «обсуждение». Пока сообщение не ушло, автор
// может его убрать (removeChatDraft); отправленный не меняется и не удаляется (триггер базы).
export function uploadChatFile(requestId, file) {
  return uploadFile({ file, ownerType: 'doc_check_request', ownerId: requestId, category: DOC_CHECK_CHAT_CATEGORY })
}

export async function removeChatDraft(doc) {
  await deleteDocument(doc)
}

// «Прочитано» в обсуждении — в базе, своё у каждого сотрудника (20270216). local — отметки этого браузера (прежние): первый
// вызов переносит их в базу, дальше они не меняют ничего. Ответ — { since, seen } в мс, как у отметок браузера.
export async function fetchTalkReads(local = null) {
  const { data, error } = await db.rpc('doc_check_talk_state', {
    p_since: Number.isFinite(local?.since) ? Math.floor(local.since) : null,
    p_seen: local?.seen && Object.keys(local.seen).length ? local.seen : null,
  })
  if (error) throw error
  return data
}

export async function saveTalkRead(requestId, at) {
  const { error } = await db.rpc('doc_check_talk_mark', { p_request: requestId, p_at: Math.floor(at) })
  if (error) throw error
}
