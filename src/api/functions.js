// Серверные функции (s3-presign, ai-assist). Ответ { data, error }, как у functions.invoke.
// Свой флаг на каждую часть (config.json или ?features= в одном браузере): включён — свой API osp-api,
// выключен — Edge Functions Supabase. Откат — выключить флаг, без пересборки; явное false в config.json
// выключает и пилотные браузеры (config/features.js).
// С данными в базе Яндекса (флаг ospDb) файлы идут только через свой API — правило в serverPath.js.
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { callOspFunction } from './ospApi'
import { createOspFiles, sha256Hex } from './ospFiles'
import { observingFetch } from './clientErrors'
import { ownDbEnabled } from './db'
import { functionPath, filesPath } from './serverPath'
import { uuidv7 } from '../utils/uuid'

export { OSP_API_FLAG, OSP_FILES_FLAG } from './serverPath'

const ospToken = async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null

export function invokeFunction(name, options) {
  const path = functionPath(name, { ownDb: ownDbEnabled(), enabled: isFeatureEnabled })
  if (path === 'osp') return callOspFunction(name, options, { getToken: ospToken, fetchImpl: observingFetch })
  if (path === 'refuse') {
    const error = new Error('Действие недоступно: данные портала перенесены, обновите страницу')
    error.name = 'FunctionsFetchError'
    return Promise.resolve({ data: null, error })
  }
  return supabase.functions.invoke(name, options)
}

// Путь файлов выбирается один раз, в начале операции: начатая загрузка заканчивается тем же путём.
export function filesViaOspApi() {
  return filesPath({
    ownDb: ownDbEnabled(),
    enabled: isFeatureEnabled,
    hasDigest: typeof globalThis.crypto?.subtle?.digest === 'function',
  }) === 'osp'
}

export const ospFiles = createOspFiles({
  call: (body) => callOspFunction('s3-presign', { body }, { getToken: ospToken, fetchImpl: observingFetch }),
  fetchImpl: (url, init) => fetch(url, init),
  digest: sha256Hex,
  newId: () => uuidv7(),
})
