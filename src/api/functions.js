// Серверные функции (s3-presign, ai-assist). Ответ { data, error }, как у functions.invoke.
// Свой флаг на каждую часть (config.json или ?features= в одном браузере): включён — свой API osp-api,
// выключен — Edge Functions Supabase. Откат — выключить флаг, без пересборки; явное false в config.json
// выключает и пилотные браузеры (config/features.js).
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { callOspFunction } from './ospApi'
import { createOspFiles, sha256Hex } from './ospFiles'
import { observingFetch } from './clientErrors'
import { uuidv7 } from '../utils/uuid'

// ИИ — тот же запрос и ответ, что у функции. Файлы идут не через invokeFunction, а потоком с ключом
// операции (ospFiles ниже, флаг OSP_FILES_FLAG).
export const OSP_API_FLAG = {
  'ai-assist': 'ospApiAi',
}

// Файлы через osp-api. Прежний флаг ospApiFiles (сборки до захода Б, без ключа операции) не включать:
// новый сервер прежний протокол загрузки не принимает.
export const OSP_FILES_FLAG = 'ospApiFilesV2'

const ospToken = async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null

export function invokeFunction(name, options) {
  const flag = OSP_API_FLAG[name]
  if (flag && isFeatureEnabled(flag)) {
    return callOspFunction(name, options, { getToken: ospToken, fetchImpl: observingFetch })
  }
  return supabase.functions.invoke(name, options)
}

// Путь файлов выбирается один раз, в начале операции: начатая загрузка заканчивается тем же путём.
// Без SubtleCrypto (не HTTPS) — прежний путь.
export function filesViaOspApi() {
  return isFeatureEnabled(OSP_FILES_FLAG) && typeof globalThis.crypto?.subtle?.digest === 'function'
}

export const ospFiles = createOspFiles({
  call: (body) => callOspFunction('s3-presign', { body }, { getToken: ospToken, fetchImpl: observingFetch }),
  fetchImpl: (url, init) => fetch(url, init),
  digest: sha256Hex,
  newId: () => uuidv7(),
})
