// «Скачать всё» в разделе «Участники» карточки тендера: имена, план и сборка ZIP.
// К серверу модуль не обращается — байты файлов приходят через fetchBytes
// (services/s3.js → fetchFileBytes), поэтому всё здесь проверяет node --test
// (tests/tender/files-archive.test.mjs).
//
// Архив «<№ тендера> <выполняемые работы>.zip», внутри — папка на каждого участника
// (наименование компании): текущие версии КП и документы, старые версии КП — в подпапке.
// У каждого участника и своя «Скачать всё» — в ячейке «КП / Документы» рядом с «+ Документ»:
// «<№ тендера> <работы> — <компания>.zip», только его файлы (planCounterpartyArchive).
// Корневой папки внутри нет: проводник Windows распаковывает архив в папку с его именем
// (…\Downloads\<имя архива>\), и с корневой папкой название тендера стояло бы в пути
// дважды. Путь при распаковке не длиннее 260 знаков — отсюда пределы ниже.
import PizZipNs from 'pizzip'
import { FILE_NAME_MAX, safeName, safeFileName, splitExtension } from './fileNames.js'

// Помощники имён живут в fileNames.js (ими пользуется и «Проверка КП»); отсюда —
// прежние экспорты, чтобы не менять импорты и тест.
export { FILE_NAME_MAX, safeName, safeFileName }

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

export const ARCHIVE_NAME_MAX = 100
export const COMPANY_NAME_MAX = 60
// Путь внутри архива: «компания/[Прежние версии КП/]файл».
export const ENTRY_PATH_MAX = 130
export const OLDER_VERSIONS_FOLDER = 'Прежние версии КП'
export const FAILED_LIST_NAME = 'Не скачано.txt'

// Windows не различает регистр, поэтому совпадения ищутся без учёта регистра.
export function uniqueName(name, used, { isFile = false } = {}) {
  const [base, ext] = isFile ? splitExtension(name) : [name, '']
  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

// «125 Устройство монолитных конструкций…»; без работ — объект, без номера — одно название.
// suffix — хвост имени («… — ВОР и РД»): обрезаются работы, хвост остаётся целым.
export function archiveBaseName(tender, fallbackTitle = 'Тендер', { suffix = '' } = {}) {
  const number = tender?.public_tender_number
  const works = String(tender?.work_description ?? '').trim() || fallbackTitle
  const title = number != null ? `${number} ${works}` : works
  return safeName(title, { max: ARCHIVE_NAME_MAX - suffix.length, fallback: 'Тендер' }) + suffix
}

const newestFirst = (a, b) =>
  new Date(b.created_at) - new Date(a.created_at) || String(a.id).localeCompare(String(b.id))

function withLabel(fileName, label) {
  const text = String(label ?? '').trim()
  if (!text) return fileName
  const [base, ext] = splitExtension(fileName)
  return `${base} (${text})${ext}`
}

const companyFolderName = (name) => safeName(name, { max: COMPANY_NAME_MAX, fallback: 'Без названия' })

// Файлы одного участника — в план: текущие версии КП и документы — в folder («» — корень
// архива), прежние версии КП — в его подпапку. Группы КП — как в ячейке «КП / Документы»
// (fetchProposalFiles): последняя версия группы — текущая, остальные — прежние.
// company — подпись участника в «Не скачано.txt». Возвращает сумму размеров файлов.
function addParticipantEntries(entries, files, company, folder) {
  const groups = new Map()
  const attachments = []
  for (const row of [...files].sort(newestFirst)) {
    if (row.file_kind === 'attachment') { attachments.push(row); continue }
    const key = row.proposal_group_id || row.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const current = [...groups.values()].map((g) => g[0])
  const older = [...groups.values()].flatMap((g) => g.slice(1))

  const usedInFolder = new Set()
  const usedInOlder = new Set()
  let bytes = 0
  const add = (row, prefix, used, rawName) => {
    const fileMax = Math.min(FILE_NAME_MAX, ENTRY_PATH_MAX - prefix.length)
    const name = uniqueName(safeFileName(rawName, fileMax), used, { isFile: true })
    const size = Number(row.s3?.size_bytes) || 0
    bytes += size
    entries.push({
      path: prefix + name,
      s3Key: row.s3?.s3_key || null,
      size,
      createdAt: row.created_at || null,
      company,
      fileName: row.s3?.file_name || name,
    })
  }
  const prefix = folder ? `${folder}/` : ''
  for (const row of [...current, ...attachments]) add(row, prefix, usedInFolder, row.s3?.file_name)
  for (const row of older) {
    add(row, `${prefix}${OLDER_VERSIONS_FOLDER}/`, usedInOlder, withLabel(row.s3?.file_name || '', row.version_label))
  }
  return bytes
}

// rows — строки tender_proposal_files с s3: { s3_key, file_name, size_bytes };
// participants — [{ counterpartyId, name }] в порядке таблицы участников.
// Файлы тех, кого уже нет среди участников, в архив не попадают (их нет и в таблице).
export function planTenderArchive(rows, participants) {
  const byCounterparty = new Map()
  for (const row of rows || []) {
    if (!byCounterparty.has(row.counterparty_id)) byCounterparty.set(row.counterparty_id, [])
    byCounterparty.get(row.counterparty_id).push(row)
  }

  const entries = []
  const usedFolders = new Set()
  let totalBytes = 0

  for (const participant of participants || []) {
    const files = byCounterparty.get(participant.counterpartyId)
    if (!files?.length) continue
    byCounterparty.delete(participant.counterpartyId)   // участник дважды — файлы один раз

    const company = companyFolderName(participant.name)
    const folder = uniqueName(company, usedFolders)
    totalBytes += addParticipantEntries(entries, files, participant.name || company, folder)
  }

  return { entries, totalBytes }
}

// «Скачать всё» одного участника (ячейка «КП / Документы»): только его файлы и без папки
// компании — компания уже в имени архива (counterpartyArchiveName), а проводник распаковывает
// архив в папку с его именем. participant — { counterpartyId, name }.
export function planCounterpartyArchive(rows, participant) {
  const files = (rows || []).filter((row) => row.counterparty_id === participant?.counterpartyId)
  const entries = []
  const company = participant?.name || companyFolderName(participant?.name)
  const totalBytes = files.length ? addParticipantEntries(entries, files, company, '') : 0
  return { entries, totalBytes }
}

// «125 Устройство кровли — ООО Альфа»: обрезаются работы, название компании остаётся
// (не длиннее, чем у папки компании в общем архиве).
export function counterpartyArchiveName(tender, companyName, fallbackTitle = 'Тендер') {
  return archiveBaseName(tender, fallbackTitle, { suffix: ` — ${companyFolderName(companyName)}` })
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new Error('пустой ответ хранилища')
}

const PARTICIPANTS_FAILED_HINT =
  'В архив не попали файлы — скачайте их по одному в карточке тендера (Участники → КП / Документы):'

// Строка пропуска: «компания — файл» у участников, «раздел — файл» в «ВОРах и РД».
function failedListText(failed, hint) {
  const lines = [
    hint,
    '',
    ...failed.map(({ entry, error }) => `${entry.section ?? entry.company} — ${entry.fileName}: ${error}`),
  ]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

// Скачивает файлы плана (не больше concurrency одновременно, сбой — повтор) и собирает ZIP.
// Не скачавшийся файл архив не останавливает: он попадает в «Не скачано.txt» и в failed,
// чтобы неполный архив не выглядел полным. failedHint — первая строка «Не скачано.txt»:
// где скачать пропущенное по одному.
export async function buildTenderArchive(entries, fetchBytes, {
  onProgress = null,
  concurrency = 4,
  retries = 1,
  retryDelayMs = 1000,
  failedHint = PARTICIPANTS_FAILED_HINT,
} = {}) {
  const results = new Array(entries.length)
  const failed = []
  let next = 0
  let done = 0

  const fetchWithRetry = async (entry) => {
    if (!entry.s3Key) throw new Error('файл не найден в хранилище')
    for (let attempt = 0; ; attempt++) {
      try {
        return toBytes(await fetchBytes(entry))
      } catch (e) {
        if (attempt >= retries) throw e
        await pause(retryDelayMs)
      }
    }
  }

  const worker = async () => {
    while (next < entries.length) {
      const index = next++
      try {
        results[index] = await fetchWithRetry(entries[index])
      } catch (e) {
        failed.push({ index, entry: entries[index], error: e?.message || String(e) })
      }
      done++
      onProgress?.({ done, total: entries.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker))

  failed.sort((a, b) => a.index - b.index)
  const zip = new PizZip()
  let added = 0
  entries.forEach((entry, index) => {
    if (!results[index]) return
    const uploaded = new Date(entry.createdAt)
    const date = Number.isNaN(uploaded.getTime()) ? new Date() : uploaded
    zip.file(entry.path, results[index], { binary: true, createFolders: true, date })
    added++
  })
  if (!added) return { bytes: null, added, failed }
  if (failed.length) zip.file(FAILED_LIST_NAME, failedListText(failed, failedHint))
  // xlsx, pdf, docx уже сжаты — DEFLATE лишь замедлил бы сборку.
  return { bytes: zip.generate({ type: 'uint8array', compression: 'STORE' }), added, failed }
}
