// «Скачать всё» в окне «ВОРы и РД» тендера (TenderVorRdPanel): все файлы окна одним ZIP.
// Имена файлов — исходные, как их загрузили (в «Проверке КП» файл переименовывается, здесь —
// нет): меняются только знаки, недопустимые в Windows, и совпадения внутри папки — «(2)».
// Папка на раздел окна; скачивание и сборка — общие с «Участниками» (buildTenderArchive).
// Проверяет tests/tender/vor-rd-archive.test.mjs.
import { safeFileName } from './fileNames.js'
import { ENTRY_PATH_MAX, archiveBaseName, uniqueName } from './tenderFilesArchive.js'

// Кнопка подгружает этот модуль по нажатию (с ним — pizzip), поэтому сборка — отсюда же.
export { buildTenderArchive, FAILED_LIST_NAME } from './tenderFilesArchive.js'

export const VOR_RD_ARCHIVE_SUFFIX = ' — ВОР и РД'
export const VOR_RD_FAILED_HINT =
  'В архив не попали файлы — скачайте их по одному в окне «ВОРы и РД» тендера:'

// Разделы окна в его порядке: поле ответа loadVorRd → папка архива.
export const VOR_RD_ARCHIVE_FOLDERS = [
  { key: 'rdDocs', folder: 'Рабочая документация' },
  { key: 'vorDocs', folder: 'Ведомость объёмов работ' },
  { key: 'legacyDocs', folder: 'Загружены ранее' },
]

// «125 Устройство монолитных конструкций — ВОР и РД»: рядом с архивом участников
// того же тендера в «Загрузках» не путается.
export function vorRdArchiveName(tender) {
  return archiveBaseName(tender, 'Тендер', { suffix: VOR_RD_ARCHIVE_SUFFIX })
}

// data — то, что показывает окно (services/tenderVorRd.js → loadVorRd): строки s3_documents
// в разделах rdDocs / vorDocs / legacyDocs. Пустой раздел папки в архиве не даёт.
export function planVorRdArchive(data) {
  const entries = []
  let totalBytes = 0
  for (const { key, folder } of VOR_RD_ARCHIVE_FOLDERS) {
    const prefix = `${folder}/`
    // Предел — путь целиком (ENTRY_PATH_MAX), а не FILE_NAME_MAX участников: длинные имена
    // файлов РД остаются целыми, имя режется, только если путь не влезает.
    const fileMax = ENTRY_PATH_MAX - prefix.length
    const used = new Set()
    for (const doc of data?.[key] || []) {
      const name = uniqueName(safeFileName(doc.file_name, fileMax), used, { isFile: true })
      const size = Number(doc.size_bytes) || 0
      totalBytes += size
      entries.push({
        path: prefix + name,
        s3Key: doc.s3_key || null,
        size,
        createdAt: doc.created_at || null,
        section: folder,
        fileName: doc.file_name || name,
      })
    }
  }
  return { entries, totalBytes }
}
