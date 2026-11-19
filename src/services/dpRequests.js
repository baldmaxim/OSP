// «Заявка на заключение ДП»: с 19.11.2026 сами заявки — карточки «Заключение ДП» доски проверки ДП/ДС (services/docCheckRequests.js,
// миграция 20270219 перенесла прежние с тем же id). Здесь осталось большое окно о новой заявке (DpRequestAlert) и список его
// получателей (DpRecipientsModal): уведомление заводит база при создании заявки на доске.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { isDpMigrationMissing } from '../utils/dpRequests'

const unwrap = ({ data, error }) => {
  if (error) throw error
  return data
}

// ── Большое окно о новой заявке ──────────────────────────────────────────────────────────────────────
// Получатель ли вошедший: остальным опрашивать базу незачем. Таблицы нет (база раньше миграции) — нет и окна.
export async function isDpAlertRecipient(userId) {
  const { data, error } = await db.from('dp_request_alert_recipients').select('user_id').eq('user_id', userId).maybeSingle()
  if (error) {
    if (!isDpMigrationMissing(error)) console.warn('Получатели заявок на ДП не загружены:', error.message)
    return false
  }
  return !!data
}

// GET — проходит и при барьере записи (режим «только чтение»).
export const fetchDpAlerts = async () => unwrap(await db.rpc('dp_request_my_alerts', {}, { get: true })) || []
export const ackDpAlerts = async (requestIds) => unwrap(await db.rpc('dp_request_alerts_ack', { p_requests: requestIds }))

// Список получателей — администратор, окно на странице заявок.
export const loadDpRecipients = () => fetchAllRows((from, to) => db
  .from('dp_request_alert_recipients')
  .select('user_id, added_at')
  .order('added_at', { ascending: true })
  .order('user_id', { ascending: true })
  .range(from, to))

export async function addDpRecipient(userId) {
  const { error } = await db.from('dp_request_alert_recipients').insert({ user_id: userId })
  if (error && error.code !== '23505') throw error
}

export async function removeDpRecipient(userId) {
  const rows = unwrap(await db.from('dp_request_alert_recipients').delete().eq('user_id', userId).select('user_id'))
  if (!rows?.length) throw new Error('Получатель не убран: нет права')
}
