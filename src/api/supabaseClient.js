// Единственный клиент Supabase в приложении. Импортируют его только адаптеры src/api/
// (db, auth, files, functions, realtime) — остальной код ходит через них, это проверяют
// ESLint (no-restricted-imports) и npm run check:transport. Так переход на свой API
// (этап 3 плана migration/PLAN.md) меняет адаптеры, а не страницы.
//
// Клиент создаётся при первом обращении, а не при импорте: при своём входе (tender.su10.ru, authMode.js)
// к Supabase не обращается никто, и сайт работает без VITE_SUPABASE_* в сборке. Если клиент всё же нужен
// при своём входе, он создаётся без хранения и обновления сессии — прежняя сессия Supabase из хранилища
// браузера не читается и не продлевается.
import { createClient } from '@supabase/supabase-js'
import { getRuntimeConfig } from '../config/runtime'
import { observingFetch } from './clientErrors'
import { isOwnAuth } from './authMode'

// Ключ сессии в localStorage. supabase-js по умолчанию выводит его из адреса
// проекта (sb-<первая часть хоста>-auth-token); закрепляем по адресу из сборки,
// чтобы смена адреса через config.json не разлогинила всех пользователей.
function defaultStorageKey(url) {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
}

let client = null

function getSupabase() {
  if (client) return client
  // Адрес и ключ: из /config.json, если он есть, иначе из сборки (.env.local → VITE_*). К этому моменту
  // main.jsx уже прочитал конфиг и режим входа.
  const { supabaseUrl, supabaseAnonKey, authStorageKey } = getRuntimeConfig()
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables. Please check your .env.local file.')
  }
  const storageKey = authStorageKey || defaultStorageKey(import.meta.env.VITE_SUPABASE_URL || supabaseUrl)
  const auth = isOwnAuth()
    ? { storageKey, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    : { storageKey }
  client = createClient(supabaseUrl, supabaseAnonKey, { auth, global: { fetch: observingFetch } })
  return client
}

// Прежние импорты (`supabase.from`, `supabase.auth` …) работают как раньше; клиент появляется при первом
// обращении. Методы привязываются к клиенту — внутри supabase-js this остаётся им.
export const supabase = new Proxy({}, {
  get(_, prop) {
    const c = getSupabase()
    const value = c[prop]
    return typeof value === 'function' ? value.bind(c) : value
  },
})
