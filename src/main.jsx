// Первым: запоминает параметры ссылки из письма Supabase до того, как клиент
// Supabase (он создаётся при импорте App) их прочитает и сотрёт из адреса.
import './utils/authRedirect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { uuidv4Manual } from './utils/uuid'
import { loadRuntimeConfig } from './config/runtime'
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
  await loadRuntimeConfig()
  const root = document.getElementById('root')
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
