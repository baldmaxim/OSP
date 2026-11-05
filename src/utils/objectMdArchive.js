// «Скачать все» над столбцом «.md» в «Документах» карточки объекта: файлы .md всех документов объекта одним ZIP, без
// папок. Имена — исходные, как их загрузили: меняются только знаки, недопустимые в Windows, и совпадения — «(2)».
// Скачивание и сборка — общие с «Участниками» тендера (buildTenderArchive).
// Проверяет tests/tender/object-doc-md.test.mjs.
import { safeFileName, safeName } from './fileNames.js'
import { ARCHIVE_NAME_MAX, ENTRY_PATH_MAX, uniqueName } from './tenderFilesArchive.js'

// Кнопка подгружает этот модуль по нажатию (с ним — pizzip), поэтому сборка — отсюда же.
export { buildTenderArchive, FAILED_LIST_NAME } from './tenderFilesArchive.js'

export const OBJECT_MD_FAILED_HINT =
  'В архив не попали файлы — скачайте их по одному в карточке объекта («Документы», столбец «.md»):'

const ARCHIVE_SUFFIX = ' — файлы md'

// «ЖК Южный — файлы md»; обрезается название объекта, хвост остаётся целым.
export function objectMdArchiveName(objectName) {
  return safeName(objectName, { max: ARCHIVE_NAME_MAX - ARCHIVE_SUFFIX.length, fallback: 'Объект' }) + ARCHIVE_SUFFIX
}

// documents — строки object_documents со встроенным файлом md (services/objectDocMd.js → fetchObjectDocuments).
export function planObjectMdArchive(documents) {
  const used = new Set()
  const entries = []
  for (const { md, name, document_number: number } of documents || []) {
    if (!md) continue
    entries.push({
      path: uniqueName(safeFileName(md.file_name, ENTRY_PATH_MAX), used, { isFile: true }),
      s3Key: md.s3_key || null,
      size: Number(md.size_bytes) || 0,
      createdAt: md.created_at || null,
      section: name || number || 'Документ', // подпись строки в «Не скачано.txt»
      fileName: md.file_name,
    })
  }
  return { entries }
}
