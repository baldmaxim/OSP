import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { cardCountsById } from '../utils/docCheckHelpers'

// Запросы карточки заявки на проверку ДП/ДС: обсуждение и шаги (миграция 20261124).
//
// Автора и время сообщения ставит база (триггер), клиент их не шлёт. Правка и удаление шага, не задевшие строку (нет
// права, шаг уже удалили), — ошибка, а не молчание: правила по строкам в этом случае отвечают «0 строк» без ошибки.

const COMMENTS = 'doc_check_request_comments'
const STEPS = 'doc_check_request_steps'

const touched = ({ data, error }) => {
  if (error) throw error
  if (!data?.length) throw new Error('Шаг уже удалён или нет права его менять')
  return data[0]
}

// Счётчики на карточках доски: всё разом, а не запросом на заявку. Потолок 1000 строк на ответ — поэтому постранично.
export async function fetchCardCounts() {
  const [steps, comments] = await Promise.all([
    fetchAllRows((from, to) => db.from(STEPS).select('request_id, is_done')
      .order('request_id', { ascending: true }).order('id', { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => db.from(COMMENTS).select('request_id')
      .order('request_id', { ascending: true }).order('id', { ascending: true }).range(from, to)),
  ])
  return cardCountsById(steps, comments)
}

export async function fetchCardDetails(requestId) {
  const [steps, comments] = await Promise.all([
    fetchAllRows((from, to) => db.from(STEPS).select('*').eq('request_id', requestId)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
      .order('id', { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => db.from(COMMENTS).select('*').eq('request_id', requestId)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)),
  ])
  return { steps, comments }
}

export async function addComment(requestId, body) {
  const { data, error } = await db.from(COMMENTS).insert({ request_id: requestId, body }).select('*').single()
  if (error) throw error
  return data
}

export async function addSteps(requestId, titles, startOrder) {
  const { data, error } = await db.from(STEPS)
    .insert(titles.map((title, idx) => ({ request_id: requestId, title, sort_order: startOrder + idx * 10 })))
    .select('*')
  if (error) throw error
  return data || []
}

export async function updateStep(id, patch) {
  return touched(await db.from(STEPS).update(patch).eq('id', id).select('id'))
}

export async function deleteStep(id) {
  return touched(await db.from(STEPS).delete().eq('id', id).select('id'))
}

// Новый порядок: только шаги, чей номер изменился.
export async function saveStepOrder(updates) {
  const results = await Promise.all(updates.map(u => db.from(STEPS)
    .update({ sort_order: u.sort_order }).eq('id', u.id).select('id')))
  results.forEach(touched)
}
