// Имя, под которым «Проверка КП» скачивает файл КП:
// «<№ тендера>_<контрагент>_<тендер>_<объект>.<расширение исходного файла>».
// Части без данных пропускаются; если нет ни одной — остаётся исходное имя.
// Пределы частей держат имя в ~170 знаках: вместе с «C:\Users\…\Downloads\» путь
// укладывается в 260 знаков Windows. Проверяет tests/tender/kp-download-name.test.mjs.
import { safeName, safeFileName, splitExtension } from './fileNames.js'

export const KP_PART_MAX = { counterparty: 50, tender: 60, object: 40 }
export const KP_NAME_SEPARATOR = '_'

function part(value, max) {
  const text = String(value ?? '').trim()
  return text ? safeName(text, { max, fallback: '' }) : ''
}

// row — строка очереди «Проверка КП» (services/tenderProposalFiles.js →
// fetchProposalFilesForReview): s3, counterparties, tenders с objects.
export function kpDownloadName(row) {
  const original = String(row?.s3?.file_name ?? '')
  const [, ext] = splitExtension(safeName(original, { max: Number.MAX_SAFE_INTEGER, fallback: '' }))
  const number = row?.tenders?.public_tender_number
  const parts = [
    number != null && number !== '' ? part(number, 20) : '',
    part(row?.counterparties?.name, KP_PART_MAX.counterparty),
    part(row?.tenders?.work_description, KP_PART_MAX.tender),
    part(row?.tenders?.objects?.name, KP_PART_MAX.object),
  ].filter(Boolean)
  if (!parts.length) return safeFileName(original || 'КП')
  return parts.join(KP_NAME_SEPARATOR) + ext
}
