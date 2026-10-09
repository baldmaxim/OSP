// Серверные функции (s3-presign, ai-assist). Ответ { data, error }, как у functions.invoke.
// Свой флаг на каждую функцию (config.json или ?features= в одном браузере): включён — свой API
// osp-api по тем же именам, выключен — Edge Functions Supabase. Откат — выключить флаг, без пересборки;
// явное false в config.json выключает и пилотные браузеры (config/features.js).
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { callOspFunction } from './ospApi'
import { observingFetch } from './clientErrors'

export const OSP_API_FLAG = {
  'ai-assist': 'ospApiAi',
  's3-presign': 'ospApiFiles',
}

export function invokeFunction(name, options) {
  const flag = OSP_API_FLAG[name]
  if (flag && isFeatureEnabled(flag)) {
    return callOspFunction(name, options, {
      getToken: async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null,
      fetchImpl: observingFetch,
    })
  }
  return supabase.functions.invoke(name, options)
}
