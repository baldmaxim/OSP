// Runtime-конфиг: /config.json рядом с сайтом, читается один раз до старта
// приложения (main.jsx). Позволяет переключать адреса и флаги без пересборки —
// это нужно на этапах переезда (свой API, вход через Keycloak) и для отката новых
// операций флагом.
//
// Файла может не быть — тогда всё как раньше: адрес и ключ Supabase из сборки
// (VITE_*), флаги выключены. Битый файл, чужие поля, HTML вместо JSON (nginx без
// отдельного location отдаёт index.html) — тоже не ошибка, берутся значения сборки.

const LOAD_TIMEOUT_MS = 3000

const config = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  // Ключ сессии в localStorage; пусто — берётся по адресу из сборки (src/api/supabaseClient.js).
  authStorageKey: null,
  // features.<имя>: включение новых операций; выключенный флаг = прежний путь.
  features: {},
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

// Принимаем только известные поля нужного типа; остальное молча игнорируем.
function apply(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  if (isNonEmptyString(raw.supabaseUrl)) config.supabaseUrl = raw.supabaseUrl.trim()
  if (isNonEmptyString(raw.supabaseAnonKey)) config.supabaseAnonKey = raw.supabaseAnonKey.trim()
  if (isNonEmptyString(raw.authStorageKey)) config.authStorageKey = raw.authStorageKey.trim()
  if (raw.features && typeof raw.features === 'object' && !Array.isArray(raw.features)) {
    const features = {}
    for (const [name, value] of Object.entries(raw.features)) {
      if (typeof value === 'boolean') features[name] = value
    }
    config.features = features
  }
}

export async function loadRuntimeConfig() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS) : null
  try {
    const res = await fetch('/config.json', { cache: 'no-store', signal: controller?.signal })
    if (!res.ok) return
    if (!/json/i.test(res.headers.get('content-type') || '')) return
    apply(await res.json())
  } catch {
    // нет файла / таймаут / не JSON — работаем со значениями сборки
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function getRuntimeConfig() {
  return config
}

// Флаги одного браузера — проверить новый путь на проде, прежде чем включать всем в config.json:
//   /?features=ospApiFunctions   — включить в этом браузере;
//   /?features=-ospApiFunctions  — снять своё значение (снова как в config.json).
// Хранятся в localStorage 'osp.features'; параметр убирается из адресной строки.
const LOCAL_FEATURES_KEY = 'osp.features'

function readLocalFeatures() {
  try {
    const v = JSON.parse(window.localStorage.getItem(LOCAL_FEATURES_KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function applyFeatureParam() {
  try {
    const url = new URL(window.location.href)
    const raw = url.searchParams.get('features')
    if (raw === null) return
    const local = readLocalFeatures()
    for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = item.replace(/^[-+]/, '')
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) continue
      if (item.startsWith('-')) delete local[name]
      else local[name] = true
    }
    window.localStorage.setItem(LOCAL_FEATURES_KEY, JSON.stringify(local))
    url.searchParams.delete('features')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch {
    // нет хранилища (приватный режим) — флаг просто не применится
  }
}

export function isFeatureEnabled(name, fallback = false) {
  const local = readLocalFeatures()
  if (typeof local[name] === 'boolean') return local[name]
  const value = config.features[name]
  return typeof value === 'boolean' ? value : fallback
}
