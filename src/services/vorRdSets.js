// Комплекты РД тендера или заявки на ВОР (миграция 20261027_vor_rd_sets) — список,
// раскрывающийся под строкой в «ВОРах и РД»: комплект РД, «ВОР готов», срок выдачи
// ВОРа, ссылка на РД и ВОР, примечание. № п/п не хранится — порядковый номер в списке.
//
// Владелец — тендер (tender_id) или заявка на ВОР без тендера (vor_request_id).
// Права — в базе: читает сотрудник, пишет правка «Тендеров» или «ВОРов и РД».
import { db } from '../api'
import { fetchAllRows } from '../utils/fetchAllRows'

export const VOR_RD_SETS_TABLE = 'vor_rd_sets'

export const VOR_RD_SETS_MIGRATION_HINT =
  'Комплекты РД появятся после обновления базы (миграция 20261027_vor_rd_sets).'

const COLUMNS = 'id, tender_id, vor_request_id, sort_order, rd_set, vor_ready, vor_due_date, link, note, created_at, updated_at'

// Шаг порядка: новая строка — max + шаг, а не «количество × шаг»: после
// удалений порядок иначе начал бы совпадать.
const SORT_STEP = 10

export function isMissingVorRdSetsTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(VOR_RD_SETS_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Все комплекты разом: их немного (единицы на тендер), а сводка «ВОР готов N из M»
// нужна в каждой строке реестра без раскрытия.
// → { rows, supported }; supported=false — таблицы ещё нет.
export async function fetchVorRdSets() {
  try {
    const rows = await fetchAllRows((from, to) => db
      .from(VOR_RD_SETS_TABLE)
      .select(COLUMNS)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to))
    return { rows, supported: true }
  } catch (err) {
    if (isMissingVorRdSetsTable(err)) return { rows: [], supported: false }
    throw err
  }
}

// owner: { kind: 'tender' | 'request', id }; siblings — уже имеющиеся комплекты владельца.
export async function createVorRdSet(owner, siblings = []) {
  const sortOrder = siblings.reduce((max, s) => Math.max(max, s.sort_order || 0), 0) + SORT_STEP
  const { data, error } = await db
    .from(VOR_RD_SETS_TABLE)
    .insert([{
      tender_id: owner.kind === 'request' ? null : owner.id,
      vor_request_id: owner.kind === 'request' ? owner.id : null,
      sort_order: sortOrder,
    }])
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data
}

// → строка после записи (пробелы по краям и пустые значения выравнивает триггер).
export async function updateVorRdSet(id, patch) {
  const { data, error } = await db
    .from(VOR_RD_SETS_TABLE)
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteVorRdSet(id) {
  const { error } = await db.from(VOR_RD_SETS_TABLE).delete().eq('id', id)
  if (error) throw error
}
