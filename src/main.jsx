// Первым: запоминает параметры ссылки из письма Supabase до того, как клиент
// Supabase (он создаётся при импорте App) их прочитает и сотрёт из адреса.
import './utils/authRedirect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { uuidv4Manual } from './utils/uuid'
import { applyFeatureParam, loadRuntimeConfig, getRuntimeConfig, isFeatureEnabled, forceFeatures } from './config/runtime'
import { loadAuthMode, setAuthMode, isOwnAuth, OWN_AUTH_FEATURES } from './api/authMode'
import { installChunkRecovery, isChunkLoadError, reloadOnceForThisBuild } from './utils/chunkRecovery'

// Полифил crypto.randomUUID — на http:// и в старых браузерах метод отсутствует,
// и любая сторонняя зависимость, дёргающая его напрямую, падает с TypeError.
// Важно: используем uuidv4Manual (а НЕ generateUUID), чтобы не получить
// бесконечную рекурсию — generateUUID проверяет crypto.randomUUID и вызывал бы себя.
if (typeof globalThis !== 'undefined') {
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {}
  }
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = uuidv4Manual
  }
}

// Вкладка, открытая до деплоя, при ошибке загрузки чанка один раз перезагружается.
installChunkRecovery()

// Сначала runtime-конфиг (/config.json: адреса и флаги), потом приложение: клиент
// Supabase создаётся при импорте App и должен увидеть уже прочитанный конфиг.
async function start() {
  applyFeatureParam()
  await loadRuntimeConfig()
  const root = document.getElementById('root')
  // Режим входа — до приложения: от него зависят форма входа и пути к серверу (src/api/authMode.js). Только где
  // свой вход есть (config.json: authServer); без ответа сервера портал не стартует на прежнем входе молча.
  if (getRuntimeConfig().authServer) {
    try {
      setAuthMode(await loadAuthMode({ fetchImpl: (url, init) => fetch(url, init) }), isFeatureEnabled)
      if (isOwnAuth()) forceFeatures(OWN_AUTH_FEATURES)
    } catch (err) {
      console.error('Режим входа не получен:', err)
      root.textContent = 'Сервер портала недоступен. Обновите страницу через минуту.'
      return
    }
  }
  try {
    const { default: App } = await import('./App.jsx')
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch (err) {
    if (isChunkLoadError(err) && reloadOnceForThisBuild()) return
    console.error('Не удалось запустить приложение:', err)
    root.textContent = 'Не удалось загрузить портал. Обновите страницу.'
  }
}

start()
