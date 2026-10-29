// Ключи API — запросы к своему серверу: при своём входе сессия в cookie и отметка защиты (sessionFetch),
// при входе Supabase — токен в заголовке.
import { auth } from './auth'
import { sessionFetch } from './sessionClient'
import { createApiKeysClient } from './apiKeysClient'

export const apiKeys = createApiKeysClient({ fetchImpl: sessionFetch, getToken: () => auth.getAccessToken() })
