// Данные: таблицы и RPC. Сейчас — PostgREST Supabase, на этапе 3 — свой API за osp-api.
// Построитель запросов и ответ { data, error, count, status } — ровно как у supabase-js:
//   db.from('tenders').select('*').eq('id', id)
//   db.rpc('psdc_validate', { p_psdc_id: id })
import { supabase } from './supabaseClient'

export const db = {
  from: (table) => supabase.from(table),
  rpc: (fn, args, options) => supabase.rpc(fn, args, options),
}
