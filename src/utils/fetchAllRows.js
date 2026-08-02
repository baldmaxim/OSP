import { supabase } from '../supabase'

// Обход потолка PostgREST в 1000 строк: тянем ВСЕ строки постранично.
// `makeQuery(from, to)` должен КАЖДЫЙ раз создавать НОВЫЙ запрос с `.range(from, to)`
// и стабильной сортировкой (иначе строки между страницами теряются/дублируются).
//
// Пример:
//   const all = await fetchAllRows((from, to) => supabase
//     .from('object_estimate_items').select('*').eq('object_id', id)
//     .order('row_number').order('id').range(from, to))
export async function fetchAllRows(makeQuery, page = 1000) {
  const all = []
  for (let from = 0; ; from += page) {
    const { data, error } = await makeQuery(from, from + page - 1)
    if (error) throw error
    if (data?.length) all.push(...data)
    if (!data || data.length < page) break
  }
  return all
}

// Частый случай: все активные контрагенты для выпадашки (таблица >1000 строк).
export async function fetchAllActiveCounterparties(select = 'id, name') {
  return fetchAllRows((from, to) => supabase
    .from('counterparties')
    .select(select)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}
