// «Скачать всё» в разделах окна «ВОРы и РД» тендера (TenderVorRdPanel): у РД и у ВОР — своя
// кнопка, архив — файлы одного раздела, без папок. Имена файлов — исходные, как их загрузили
// (в «Проверке КП» файл переименовывается, здесь — нет): меняются только знаки, недопустимые
// в Windows, и совпадения — «(2)». Скачивание и сборка — общие с «Участниками» (buildTenderArchive).
// Проверяет tests/tender/vor-rd-archive.test.mjs.
import { safeFileName } from './fileNames.js'
import { ENTRY_PATH_MAX, archiveBaseName, uniqueName } from './tenderFilesArchive.js'

// Кнопка подгружает этот модуль по нажатию (с ним — pizzip), поэтому сборка — отсюда же.
export { buildTenderArchive, FAILED_LIST_NAME } from './tenderFilesArchive.js'

export const VOR_RD_FAILED_HINT =
  'В архив не попали файлы — скачайте их по одному в окне «ВОРы и РД» тендера:'

// Разделы окна: поле ответа loadVorRd и хвост имени архива — рядом с архивом участников
// того же тендера в «Загрузках» не путается.
export const VOR_RD_ARCHIVE_SECTIONS = {
  rd: { key: 'rdDocs', title: 'Рабочая документация', suffix: ' — РД' },
  vor: { key: 'vorDocs', title: 'Ведомость объёмов работ', suffix: ' — ВОР' },
  legacy: { key: 'legacyDocs', title: 'Загружены ранее', suffix: ' — ВОР и РД (загружены ранее)' },
}

// «125 Устройство монолитных конструкций — РД»; хвост не обрезается.
export function vorRdArchiveName(tender, section) {
  return archiveBaseName(tender, 'Тендер', { suffix: VOR_RD_ARCHIVE_SECTIONS[section].suffix })
}

// docs — файлы раздела (строки s3_documents из loadVorRd), section — ключ VOR_RD_ARCHIVE_SECTIONS.
export function planVorRdArchive(docs, section) {
  const { title } = VOR_RD_ARCHIVE_SECTIONS[section]
  const entries = []
  const used = new Set()
  let totalBytes = 0
  for (const doc of docs || []) {
    // Предел — путь внутри архива (ENTRY_PATH_MAX), а не FILE_NAME_MAX участников: папок нет,
    // длинные имена файлов РД остаются целыми.
    const name = uniqueName(safeFileName(doc.file_name, ENTRY_PATH_MAX), used, { isFile: true })
    const size = Number(doc.size_bytes) || 0
    totalBytes += size
    entries.push({
      path: name,
      s3Key: doc.s3_key || null,
      size,
      createdAt: doc.created_at || null,
      section: title,
      fileName: doc.file_name || name,
    })
  }
  return { entries, totalBytes }
}
