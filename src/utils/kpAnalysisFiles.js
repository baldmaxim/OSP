// «Анализ ВОР/КП»: какие файлы он читает. Отдельно от окна: кнопке-приёмнику в «Проверке КП»
// нужна эта проверка, а окно с библиотекой Excel грузится только при открытии.
export const ANALYSIS_FILE_ACCEPT = '.xlsx,.xls'

export const isAnalysisFile = (file) => /\.(xlsx|xls)$/i.test(String(file?.name || ''))

// Перетаскивают ли файлы (а не текст или ссылку со страницы).
export const dragHasFiles = (e) => Array.from(e?.dataTransfer?.types || []).includes('Files')
