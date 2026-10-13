// Данные: таблицы и RPC. Построитель запросов и ответ { data, error, count, status } — ровно как у
// supabase-js:
//   db.from('tenders').select('*').eq('id', id)
//   db.rpc('psdc_validate', { p_psdc_id: id })
//
// Два пути; выбор — флагом ospDb в момент вызова (config.json — всем, ?features=ospDb — одному браузеру):
//   выключен — PostgREST Supabase, как раньше;
//   включён  — свой шлюз /api/db: osp-api → PostgREST на нашем сервере → база Яндекса (ownDb.js).
// Страницы разницы не видят. Откат — выключить флаг, без пересборки.
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { observingFetch } from './clientErrors'
import { createOwnDb, OSP_DB_FLAG, OSP_DB_PATH } from './ownDb'

let own = null
export const ownDb = () => (own ??= createOwnDb({
  baseUrl: `${window.location.origin}${OSP_DB_PATH}`,
  getToken: async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null,
  fetchImpl: observingFetch,
}))
export const ownDbEnabled = () => isFeatureEnabled(OSP_DB_FLAG)
const target = () => (ownDbEnabled() ? ownDb() : supabase)

export const db = {
  from: (table) => target().from(table),
  rpc: (fn, args, options) => target().rpc(fn, args, options),
}
