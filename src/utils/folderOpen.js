// Путь к папке → ссылка, которую открывает помощник «Открыть папку» (public/tools/osp-folder.cmd).
//
// Браузер сам на file:// и на сетевой путь со страницы по https не переходит: Chrome и Edge блокируют это молча,
// со стороны сайта не обойти. Поэтому — своя схема osp-folder:<путь>: её на компьютере обрабатывает помощник
// (ставится один раз, без прав администратора), он проверяет путь и открывает проводник. Модуль без зависимостей:
// его проверяют тесты (tests/tender/folder-open.test.mjs).

export const FOLDER_SCHEME = 'osp-folder'
export const FOLDER_HELPER_FILE = 'osp-folder.cmd'
export const FOLDER_HELPER_URL = `/tools/${FOLDER_HELPER_FILE}`

// Путь к папке Windows: сетевой \\сервер\папка… или диск X:\… — только такие помощник и откроет.
export function isFolderPath(value) {
  const v = String(value ?? '').trim()
  return /^\\\\[^\\\s]+\\\S/.test(v) || /^[A-Za-z]:\\/.test(v)
}

// Ссылка для помощника: путь целиком закодирован — в ней нет ни пробелов, ни кавычек, ни обратных косых.
export function folderOpenUrl(path) {
  return `${FOLDER_SCHEME}:${encodeURIComponent(String(path ?? '').trim())}`
}

// Помощник — только для Windows: на телефоне и Mac проводника нет, там путь, как раньше, копируют.
export function canOpenFolders(userAgent = globalThis.navigator?.userAgent || '') {
  return /Windows/i.test(userAgent)
}
