import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { chunkList } from '../utils/inChunks'
import { cardCountsById } from '../utils/docCheckHelpers'

// Запросы карточки заявки на проверку ДП/ДС: обсуждение (миграция 20261124). Шагов в заявке нет с 11.11.2026 — их таблицу не
// читаем. Автора и время сообщения ставит база (триггер), клиент их не шлёт.

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

export async function fetchComments(requestId) {
  return fetchAllRows((from, to) => db.from(COMMENTS).select('*').eq('request_id', requestId)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to))
}

export async function addComment(requestId, body) {
  const { data, error } = await db.from(COMMENTS).insert({ request_id: requestId, body }).select('*').single()
  if (error) throw error
  return data
}
