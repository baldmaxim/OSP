// Запросы раздела «Заявка на заключение ДП» (миграции 20261227, 20261231). Правила — utils/dpRequests.js, запреты — в базе.
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'
import { DP_CONCEPT_CATEGORY, DP_DOCS_CATEGORY, DP_OWNER_TYPE, isDpMigrationMissing } from '../utils/dpRequests'
import { deleteDocument, uploadFile } from './s3'

const unwrap = ({ data, error }) => {
  if (error) throw error
  return data
}

// Черновики в реестр не идут: автор видит свой только секунды, пока грузятся файлы.
export const loadDpRequests = () => fetchAllRows((from, to) => db
  .from('dp_requests')
  .select('*, objects(name)')
  .neq('status', 'draft')
  .order('created_at', { ascending: false })
  .order('id', { ascending: false })
  .range(from, to))

export const loadDpDocs = () => fetchAllRows((from, to) => db
  .from('s3_documents')
  .select('*')
  .eq('owner_type', DP_OWNER_TYPE)
  .order('created_at', { ascending: true })
  .order('id', { ascending: true })
  .range(from, to))

// Сотрудник с привязкой к объектам выбирает только их: остальное база всё равно не примет.
export async function loadDpObjects(scopedObjectIds) {
  const rows = await fetchAllRows((from, to) => {
    let q = db.from('objects').select('id, name, status')
    if (scopedObjectIds?.length) q = q.in('id', scopedObjectIds)
    return q.order('status', { ascending: true }).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)
  })
  return rows
}

export const loadDpStaff = () => fetchAllRows((from, to) => db
  .from('object_staff')
  .select('id, object_id, contact_id, staff_role, sort_order, contacts(full_name, position)')
  .order('id', { ascending: true })
  .range(from, to))

const uploadDpFile = (requestId, file, category) => uploadFile({
  file, ownerType: 'dp_request', ownerId: requestId, category,
})

// Создание: файл можно загрузить только к существующей строке, поэтому сначала черновик, затем файлы, затем подача — база на этом
// шаге проверяет понятийное соглашение, ставит номер и заводит уведомления. Сбой — черновик и загруженное убираются: заявка либо
// создана целиком, либо её нет, и форма остаётся заполненной для повтора. Вкладку закрыли в эти секунды — черновик остаётся
// невидимым для всех, кроме автора, и в реестр не попадает.
export async function createDpRequest({ fields, conceptFiles, docFiles }) {
  const draft = unwrap(await db.from('dp_requests').insert(fields).select('id').single())
  const uploaded = []
  try {
    for (const file of conceptFiles) uploaded.push(await uploadDpFile(draft.id, file, DP_CONCEPT_CATEGORY))
    for (const file of docFiles) uploaded.push(await uploadDpFile(draft.id, file, DP_DOCS_CATEGORY))
    const rows = unwrap(await db.from('dp_requests').update({ status: 'new' }).eq('id', draft.id).select('id, request_number'))
    if (!rows?.length) throw new Error('Заявка не подана: нет права')
    return rows[0]
  } catch (err) {
    await Promise.allSettled(uploaded.map((doc) => deleteDocument(doc)))
    await db.from('dp_requests').delete().eq('id', draft.id).then(() => {}, () => {})
    throw err
  }
}

// Правка, не задевшая строку (нет права, заявку уже взяли в работу), — ошибка, а не молчание.
async function updateRow(id, fields, noRowText) {
  const rows = unwrap(await db.from('dp_requests').update(fields).eq('id', id).select('id'))
  if (!rows?.length) throw new Error(noRowText)
}

export const updateDpRequest = (id, fields) => updateRow(id, fields, 'Заявка не сохранена: нет права или её уже взяли в работу')
export const setDpStatus = (id, status) => updateRow(id, { status }, 'Статус не изменён: нет права')
export const softDeleteDpRequest = (id) => updateRow(id, { deleted_at: new Date().toISOString() }, 'Заявка не удалена: нет права или её уже взяли в работу')
export const restoreDpRequest = (id) => updateRow(id, { deleted_at: null }, 'Заявка не восстановлена: нет права')

export const addDpFile = (requestId, file, category) => uploadDpFile(requestId, file, category)
export const removeDpFile = (doc) => deleteDocument(doc)

// Замена: сначала новый файл, потом прежние — соглашение не остаётся без файла ни на миг.
export async function replaceDpFiles(requestId, file, category, oldDocs) {
  const fresh = await uploadDpFile(requestId, file, category)
  for (const doc of oldDocs) await deleteDocument(doc)
  return fresh
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
