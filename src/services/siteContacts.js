// Контакты площадки (миграция 20261030_site_contacts): кто встречает подрядчика на
// объекте, если потребуется выезд. Строка — объект + подразделение ВОР (одна на пару):
// ФИО, телефон, Telegram. Подставляются в письмо подрядчикам по объекту и подразделению
// тендера; без контакта письмо по тендеру основного строительства не формируется.
//
// Права — в базе: читает сотрудник, назначает только администратор (is_admin()).
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'

export const SITE_CONTACTS_TABLE = 'object_site_contacts'

export const SITE_CONTACTS_MIGRATION_HINT =
  'Контакты площадки появятся после обновления базы (миграция 20261030_site_contacts).'

const COLUMNS = 'id, object_id, division, full_name, phone, telegram, updated_at'

export function isMissingSiteContactsTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(SITE_CONTACTS_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Все контакты разом: их немного (объекты × подразделения), а вкладке нужна сводка
// «назначено N из M» по каждому объекту в списке выбора.
// → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchSiteContacts() {
  try {
    const rows = await fetchAllRows((from, to) => db
      .from(SITE_CONTACTS_TABLE)
      .select(COLUMNS)
      .order('id', { ascending: true })
      .range(from, to))
    return { rows, supported: true }
  } catch (err) {
    if (isMissingSiteContactsTable(err)) return { rows: [], supported: false }
    throw err
  }
}

// Контакт для письма — читается в момент формирования, чтобы письмо не взяло
// устаревший контакт из открытой давно страницы.
// → { contact, supported }; contact=null — не назначен.
export async function fetchSiteContact(objectId, division) {
  const { data, error } = await db
    .from(SITE_CONTACTS_TABLE)
    .select(COLUMNS)
    .eq('object_id', objectId)
    .eq('division', division)
    .maybeSingle()
  if (error) {
    if (isMissingSiteContactsTable(error)) return { contact: null, supported: false }
    throw error
  }
  return { contact: data || null, supported: true }
}

// Назначить или заменить контакт подразделения на объекте (одна строка на пару).
// value — проверенный validateSiteContact; → строка после записи (пробелы выравнивает триггер).
export async function saveSiteContact(objectId, division, value) {
  const { data, error } = await db
    .from(SITE_CONTACTS_TABLE)
    .upsert({ object_id: objectId, division, ...value }, { onConflict: 'object_id,division' })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteSiteContact(id) {
  const { error } = await db.from(SITE_CONTACTS_TABLE).delete().eq('id', id)
  if (error) throw error
}
