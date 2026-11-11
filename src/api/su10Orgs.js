// «Организации СУ-10» — экземпляр клиента (своя сессия: fetch с отметкой защиты, sessionClient.js).
import { sessionFetch } from './sessionClient'
import { createSu10OrgsClient } from './su10OrgsClient'

export const su10Orgs = createSu10OrgsClient({ fetchImpl: sessionFetch })
