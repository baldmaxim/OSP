// Заявки на доступ и связи с СУ-10 — экземпляр клиента (своя сессия: fetch с отметкой защиты, sessionClient.js).
import { sessionFetch } from './sessionClient'
import { createIdentityAdminClient } from './identityAdminClient'

export const identityAdmin = createIdentityAdminClient({ fetchImpl: sessionFetch })
