import { createClient } from '@supabase/supabase-js'
import { getRuntimeConfig } from '../config/runtime'
import { observingFetch } from './clientErrors'

// Адрес и ключ: из /config.json, если он есть, иначе из сборки (.env.local → VITE_*).
// Клиент создаётся при импорте App — к этому моменту main.jsx уже прочитал конфиг.
const { supabaseUrl, supabaseAnonKey, authStorageKey } = getRuntimeConfig()

// Validate environment variables
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Please check your .env.local file.'
  )
}

// Ключ сессии в localStorage. supabase-js по умолчанию выводит его из адреса
// проекта (sb-<первая часть хоста>-auth-token); закрепляем по адресу из сборки,
// чтобы смена адреса через config.json не разлогинила всех пользователей.
function defaultStorageKey(url) {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
}
const storageKey = authStorageKey || defaultStorageKey(import.meta.env.VITE_SUPABASE_URL || supabaseUrl)

// Create Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey },
  global: { fetch: observingFetch },
})
