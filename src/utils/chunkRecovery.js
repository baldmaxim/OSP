/* global __BUILD_ID__ */
// Восстановление после ошибки загрузки чанка.
//
// Страницы грузятся лениво (React.lazy). Вкладка, открытая до деплоя, при
// переходе на ещё не открытую страницу просит файл своей сборки — если его на
// сервере уже нет, раньше был белый экран. Теперь вкладка один раз сама
// перезагружается и получает новую сборку.
//
// Без цикла: метка в sessionStorage ставится на id сборки, которая упала. После
// перезагрузки работает уже новая сборка с другим id — если упадёт и она, у неё
// будет своя одна попытка. Повторная ошибка в той же сборке перезагрузку не
// вызывает: ошибка уходит в ChunkErrorBoundary, который показывает сообщение.

const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'
const KEY = `osp-chunk-reload:${BUILD_ID}`

const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .* failed|ChunkLoadError/i

export function isChunkLoadError(err) {
  return CHUNK_ERROR_RE.test(`${err?.name || ''} ${err?.message || err || ''}`)
}

// true — перезагрузка запущена; false — в этой сборке уже пробовали (или
// sessionStorage недоступен: тогда не рискуем зациклиться).
export function reloadOnceForThisBuild() {
  try {
    if (sessionStorage.getItem(KEY)) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}

// Vite сообщает о неудачной загрузке чанка (и его зависимостей) событием
// vite:preloadError. preventDefault — ошибка не всплывает, страница перезагружается.
export function installChunkRecovery() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForThisBuild()) event.preventDefault()
  })
}
