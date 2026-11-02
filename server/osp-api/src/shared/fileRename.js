// КОПИЯ src/utils/fileRename.js — не править здесь: правка в оригинале, затем node scripts/sync-osp-api-shared.mjs
// Переименование файла (окно просмотра S3DocumentPreview, действие rename в osp-api). Меняется только подпись —
// s3_documents.file_name, ключ объекта в хранилище прежний. Расширение менять нельзя: по нему просмотр выбирает PDF или
// картинку, а расценка снабжением узнаёт Excel-файл ВОР. Модуль чистый, один на страницу и службу (sync-osp-api-shared).

export const FILE_NAME_MAX = 255

// Расширение — латиница и цифры, хотя бы одна буква (.pdf, .7z). «ред.2» и «от 10.10.2026» — продолжение имени.
const EXT_RE = /\.(?=[0-9a-z]*[a-z])[0-9a-z]{1,10}$/i
// Запрещённые в именах файлов Windows (иначе такой файл не сохранить) и невидимые: управляющие и знаки направления письма.
const FORBIDDEN_RE = /[\\/:*?"<>|\p{Cc}\p{Cf}]/u

export function splitFileName(name) {
  const text = String(name ?? '')
  const ext = text.match(EXT_RE)?.[0] || ''
  return { stem: text.slice(0, text.length - ext.length), ext }
}

// Имя целиком из того, что ввёл человек. Невидимое из вставленного текста убирается молча; расширение, дописанное
// вручную, не удваивается («КП.pdf» у файла .pdf — «КП.pdf», а не «КП.pdf.pdf»). Пустая основа — пустая строка.
export function composeFileName(stem, ext = '') {
  const text = String(stem ?? '').replace(/\p{Cc}/gu, ' ').replace(/\p{Cf}/gu, '')
  const typedExt = ext && text.trimEnd().toLowerCase().endsWith(ext.toLowerCase())
  const clean = (typedExt ? text.trimEnd().slice(0, -ext.length) : text).replace(/^\s+|[.\s]+$/g, '')
  return clean ? clean + ext : ''
}

// Что не так с новым именем (текст для человека) или null.
export function fileNameProblem(name, currentName) {
  const { stem, ext } = splitFileName(name)
  if (!stem.trim()) return 'Укажите имя файла'
  if (name.length > FILE_NAME_MAX) return `Имя файла длиннее ${FILE_NAME_MAX} знаков`
  if (FORBIDDEN_RE.test(name)) return 'В имени файла нельзя использовать знаки \\ / : * ? " < > |'
  if (ext.toLowerCase() !== splitFileName(currentName).ext.toLowerCase()) return 'Расширение файла менять нельзя'
  return null
}
