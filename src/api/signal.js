// «Signal» — экземпляр клиента (своя сессия: fetch с отметкой защиты, sessionClient.js; тело — signalClient.js).
// Токен — как у «Ключей API» (apiKeys.js): при своём входе его нет (сессия в cookie), при входе Supabase — заголовком (В-13).
import { auth } from './auth'
import { sessionFetch } from './sessionClient'
import { createSignalClient } from './signalClient'

export { SignalApiError } from './signalClient'
export const signal = createSignalClient({ fetchImpl: sessionFetch, getToken: () => auth.getAccessToken() })
