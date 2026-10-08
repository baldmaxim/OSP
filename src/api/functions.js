// Серверные функции: сейчас Edge Functions Supabase (s3-presign, ai-assist), на этапе 3 —
// маршруты osp-api по тем же именам. Ответ { data, error }, как у functions.invoke.
import { supabase } from './supabaseClient'

export function invokeFunction(name, options) {
  return supabase.functions.invoke(name, options)
}
