// Серверные функции (s3-presign, ai-assist). Ответ { data, error }, как у functions.invoke.
// Флаг ospApiFunctions (config.json или ?features= в одном браузере) — свой API osp-api по тем же
// именам; выключен — Edge Functions Supabase. Откат — выключить флаг, без пересборки.
import { supabase } from './supabaseClient'
import { isFeatureEnabled } from '../config/runtime'
import { callOspFunction } from './ospApi'
import { observingFetch } from './clientErrors'

export function invokeFunction(name, options) {
  if (isFeatureEnabled('ospApiFunctions')) {
    return callOspFunction(name, options, {
      getToken: async () => (await supabase.auth.getSession()).data?.session?.access_token ?? null,
      fetchImpl: observingFetch,
    })
  }
  return supabase.functions.invoke(name, options)
}
