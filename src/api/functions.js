// Серверные функции (s3-presign, ai-assist). Ответ { data, error }, как у functions.invoke.
// Свой флаг на каждую часть (config.json или ?features= в одном браузере): включён — свой API osp-api,
// выключен — Edge Functions Supabase. Откат — выключить флаг, без пересборки; явное false в config.json
// выключает и пилотные браузеры (config/features.js).
// С данными в базе Яндекса (флаг ospDb) файлы идут только через свой API — правило в serverPath.js.
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { callOspFunction } from './ospApi'
import { createOspFiles, sha256Hex } from './ospFiles'
import { putToStorage } from './storagePut'
import { auth } from './auth'
import { sessionFetch } from './sessionClient'
import { ownDbEnabled } from './db'
import { functionPath, filesPath } from './serverPath'
import { uuidv7 } from '../utils/uuid'

export { OSP_API_FLAG, OSP_FILES_FLAG } from './serverPath'

const ospToken = () => auth.getAccessToken()

export function invokeFunction(name, options) {
  const path = functionPath(name, { ownDb: ownDbEnabled(), enabled: isFeatureEnabled })
  if (path === 'osp') return callOspFunction(name, options, { getToken: ospToken, fetchImpl: sessionFetch })
  if (path === 'refuse') {
    const error = new Error('Действие недоступно: данные портала перенесены, обновите страницу')
    error.name = 'FunctionsFetchError'
    return Promise.resolve({ data: null, error })
  }
  return supabase.functions.invoke(name, options)
}

// Файл ВОР для расценки — только свой API: учётка с регистрации бывает только на новом портале, строк s3_documents она не видит.
export const requestBidVorFile = (fileId) => callOspFunction('bid-vor-file', { body: { file_id: fileId } }, { getToken: ospToken, fetchImpl: sessionFetch })

// Счёт снабжения к цене, взятой подрядчиком у снабжения (миграция 20270302) — только свой API: строки s3_documents подрядчику закрыты.
// view — ссылка для окна просмотра (PDF и картинки; служба отвечает inline: true, если подписала её «показать»).
export const requestBidSupplyDoc = (tenderId, documentId, view = false) => callOspFunction('bid-supply-doc',
  { body: { tender_id: tenderId, document_id: documentId, ...(view ? { view: true } : {}) } },
  { getToken: ospToken, fetchImpl: sessionFetch })

// Свой ВОР подрядчика с расценками (миграция 20270113): загрузка, скачивание, удаление — только свой API, решают функции базы.
export const requestBidFile = (body) => callOspFunction('bid-file', { body }, { getToken: ospToken, fetchImpl: sessionFetch })
// Тот же файл администратору (сводка расценок подрядчиков) — маршрут /api/admin/bid-file, ответ в том же виде.
export const requestBidFileAdmin = (fileId) => callOspFunction('bid-file', { body: { file_id: fileId } }, {
  getToken: ospToken,
  fetchImpl: (url, init) => sessionFetch(String(url).replace('/api/fn/', '/api/admin/'), init),
})

// Путь файлов выбирается один раз, в начале операции: начатая загрузка заканчивается тем же путём.
export function filesViaOspApi() {
  return filesPath({
    ownDb: ownDbEnabled(),
    enabled: isFeatureEnabled,
    hasDigest: typeof globalThis.crypto?.subtle?.digest === 'function',
  }) === 'osp'
}

// Шаги загрузки — с пределом ожидания и повтором (19.11.2026: загрузка «зависала» на одном из файлов): ответ сервера — до 60 с,
// отправка в хранилище — пока идёт; встала на 60 с — обрыв и повтор с новой ссылкой (storagePut.js). Повтор безопасен: ключ
// операции один на файл. Откат отправки на прежний fetch без хода — убрать putImpl ниже.
export const FILES_CALL_TIMEOUT_MS = 60 * 1000
export const ospFiles = createOspFiles({
  call: (body) => callOspFunction('s3-presign', { body, timeoutMs: FILES_CALL_TIMEOUT_MS }, { getToken: ospToken, fetchImpl: sessionFetch }),
  fetchImpl: (url, init) => fetch(url, init),
  putImpl: putToStorage,
  digest: sha256Hex,
  newId: () => uuidv7(),
})
