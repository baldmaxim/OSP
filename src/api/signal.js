// «Signal» — экземпляр клиента (своя сессия: fetch с отметкой защиты, sessionClient.js; тело — signalClient.js).
import { sessionFetch } from './sessionClient'
import { createSignalClient } from './signalClient'

export { SignalApiError } from './signalClient'
export const signal = createSignalClient({ fetchImpl: sessionFetch })
