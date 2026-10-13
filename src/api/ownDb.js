// Данные через свой шлюз /api/db (osp-api → PostgREST на нашем сервере → база Яндекса).
// Построитель запросов — тот же, которым пользуется supabase-js (@supabase/postgrest-js): страницы
// получают тот же интерфейс и тот же ответ { data, error, count, status }.
// Модуль чистый — проверяется в tests/osp-api/client-db.test.mjs.
import { PostgrestClient } from '@supabase/postgrest-js'

export const OSP_DB_FLAG = 'ospDb'
export const OSP_DB_PATH = '/api/db'

// getToken() — токен входа на момент запроса (сессию продлевает клиент входа) либо null: без токена
// заголовка нет, и шлюз считает запрос анонимным (публичная витрина).
export function createOwnDb({ baseUrl, getToken, fetchImpl }) {
  return new PostgrestClient(baseUrl, {
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers)
      headers.delete('apikey')
      const token = await getToken()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      else headers.delete('Authorization')
      return fetchImpl(input, { ...init, headers })
    },
  })
}
