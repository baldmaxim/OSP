// «Скачать всё» в списке документов (components/S3DocumentList.jsx, проп downloadAllOwner) — сейчас у
// «Должной осмотрительности» в карточке контрагента: все файлы раздела одним ZIP, без папок. Имена — исходные,
// как их загрузили: меняются только знаки, недопустимые в Windows, и совпадения — «(2)». Скачивание и сборка —
// общие с «Участниками» тендера (buildTenderArchive). Проверяет tests/tender/counterparty-docs-zip.test.mjs.
import { safeFileName, safeName } from './fileNames.js'
import { ARCHIVE_NAME_MAX, ENTRY_PATH_MAX, uniqueName } from './tenderFilesArchive.js'

// Кнопка подгружает этот модуль по нажатию (с ним — pizzip), поэтому сборка — отсюда же.
export { buildTenderArchive, FAILED_LIST_NAME } from './tenderFilesArchive.js'

// Первая строка «Не скачано.txt»: где скачать пропущенное по одному.
export function docListFailedHint(title) {
  return `В архив не попали файлы — скачайте их по одному в разделе «${title}»:`
}

// «ООО Альфа — Должная осмотрительность»: обрезается владелец, название раздела остаётся целым.
export function docListArchiveName(ownerName, title) {
  const suffix = ` — ${safeName(title, { fallback: 'Документы' })}`
  return safeName(ownerName, { max: ARCHIVE_NAME_MAX - suffix.length, fallback: 'Документы' }) + suffix
}

// docs — строки s3_documents раздела (services/s3.js → fetchDocuments), title — название раздела.
export function planDocListArchive(docs, title) {
  const entries = []
  const used = new Set()
  let totalBytes = 0
  for (const doc of docs || []) {
    const name = uniqueName(safeFileName(doc.file_name, ENTRY_PATH_MAX), used, { isFile: true })
    const size = Number(doc.size_bytes) || 0
    totalBytes += size
    entries.push({
      path: name,
      s3Key: doc.s3_key || null,
      size,
      createdAt: doc.created_at || null,
      section: title, // подпись строки в «Не скачано.txt»
      fileName: doc.file_name || name,
    })
  }
  return { entries, totalBytes }
}
