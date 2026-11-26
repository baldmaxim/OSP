// Реестр «Расценки от снабжения СУ-10»: строки счетов и КП, загруженных в тендер (миграция 20270306). Сами строки приходят в
// выборке вкладки (source_type 'supply_doc', файл — doc_id, «файл удалён из тендера» — doc_deleted_at); здесь — то, что
// дочитывается для показанных строк и окна «Расценка»: применена ли строка в тендере и номер тендера.
import { db } from '../api'
import { chunkList } from '../utils/inChunks'

export const SUPPLY_DOC_SOURCE = 'supply_doc'
export const isSupplyDocRow = (row) => row?.source_type === SUPPLY_DOC_SOURCE

// Применена ли строка в тендере: цена позиции тендера, у которой этот файл — документ, взята из этой строки (функция
// supply_doc_rates_status). ids — id строк реестра (берутся только строки счетов). Ответ — Map id → true / false; функции ещё нет
// (база раньше миграции) или чтение не удалось — null: статус не показывается, остальное работает.
export async function loadDocLineStatus(rows) {
  const ids = [...new Set((rows || []).filter(isSupplyDocRow).map((r) => r.id))]
  const out = new Map()
  if (!ids.length) return out
  try {
    for (const chunk of chunkList(ids, 200)) {
      const { data, error } = await db.rpc('supply_doc_rates_status', { p_ids: chunk })
      if (error) return null
      for (const r of data || []) out.set(r.id, r.applied === true)
    }
  } catch {
    return null
  }
  return out
}

// Номер тендера (public_tender_number) — для окна «Расценка». Нет тендера или номера — null.
export async function loadTenderNumber(tenderId) {
  if (!tenderId) return null
  const { data, error } = await db.from('tenders').select('public_tender_number').eq('id', tenderId).maybeSingle()
  if (error) throw error
  return data?.public_tender_number ?? null
}
