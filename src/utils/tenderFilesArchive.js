// «Скачать всё» в разделе «Участники» карточки тендера: имена, план и сборка ZIP.
// К серверу модуль не обращается — байты файлов приходят через fetchBytes
// (services/s3.js → fetchFileBytes), поэтому всё здесь проверяет node --test
// (tests/tender/files-archive.test.mjs).
//
// Архив «<№ тендера> <выполняемые работы>.zip», внутри — папка на каждого участника
// (наименование компании): текущие версии КП и документы, старые версии КП — в подпапке.
// Корневой папки внутри нет: проводник Windows распаковывает архив в папку с его именем
// (…\Downloads\<имя архива>\), и с корневой папкой название тендера стояло бы в пути
// дважды. Путь при распаковке не длиннее 260 знаков — отсюда пределы ниже.
import PizZipNs from 'pizzip'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

export const ARCHIVE_NAME_MAX = 100
export const COMPANY_NAME_MAX = 60
export const FILE_NAME_MAX = 80
// Путь внутри архива: «компания/[Прежние версии КП/]файл».
export const ENTRY_PATH_MAX = 130
export const OLDER_VERSIONS_FOLDER = 'Прежние версии КП'
export const FAILED_LIST_NAME = 'Не скачано.txt'

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const FORBIDDEN_CHAR = /[\\/:*?<>|]/g
const EXTENSION = /\.[^.\s]{1,10}$/

function stripControl(text) {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

// Обрезка по границе слова с «…»; слово режется, только если пробел слишком далеко.
function cutText(text, max) {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  const cut = space >= max * 0.6 ? head.slice(0, space) : head
  return cut.replace(/[\s.,;:–—-]+$/, '') + '…'
}

// Имя папки или файла, допустимое в Windows: без \ / : * ? " < > | и управляющих
// символов, без точек и пробелов в конце, не CON/NUL/…, не длиннее max.
export function safeName(value, { max = FILE_NAME_MAX, fallback = 'Без названия' } = {}) {
  const clean = stripControl(String(value ?? ''))
    .replace(/"/g, "'")
    .replace(FORBIDDEN_CHAR, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let name = cutText(clean, max).replace(/[. ]+$/, '')
  if (!name) name = fallback
  if (RESERVED_NAME.test(name.split('.')[0])) name = `_${name}`
  return name
}

function splitExtension(fileName) {
  const match = fileName.match(EXTENSION)
  if (!match || match.index === 0) return [fileName, '']
  return [fileName.slice(0, match.index), match[0]]
}

// То же для файла: расширение сохраняется, обрезается только имя.
export function safeFileName(value, max = FILE_NAME_MAX) {
  const [base, ext] = splitExtension(safeName(value, { max: Number.MAX_SAFE_INTEGER, fallback: 'Файл' }))
  return safeName(base, { max: Math.max(max - ext.length, 8), fallback: 'Файл' }) + ext
}

// Windows не различает регистр, поэтому совпадения ищутся без учёта регистра.
export function uniqueName(name, used, { isFile = false } = {}) {
  const [base, ext] = isFile ? splitExtension(name) : [name, '']
  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

// «125 Устройство монолитных конструкций…»; без работ — объект, без номера — одно название.
export function archiveBaseName(tender, fallbackTitle = 'Тендер') {
  const number = tender?.public_tender_number
  const works = String(tender?.work_description ?? '').trim() || fallbackTitle
  const title = number != null ? `${number} ${works}` : works
  return safeName(title, { max: ARCHIVE_NAME_MAX, fallback: 'Тендер' })
}

const newestFirst = (a, b) =>
  new Date(b.created_at) - new Date(a.created_at) || String(a.id).localeCompare(String(b.id))

function withLabel(fileName, label) {
  const text = String(label ?? '').trim()
  if (!text) return fileName
  const [base, ext] = splitExtension(fileName)
  return `${base} (${text})${ext}`
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

    // Группы КП — как в ячейке «КП / Документы» (fetchProposalFiles): последняя версия
    // группы — текущая, остальные — прежние.
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

    const company = safeName(participant.name, { max: COMPANY_NAME_MAX, fallback: 'Без названия' })
    const folder = uniqueName(company, usedFolders)
    const usedInFolder = new Set()
    const usedInOlder = new Set()

    const add = (row, prefix, used, rawName) => {
      const fileMax = Math.min(FILE_NAME_MAX, ENTRY_PATH_MAX - prefix.length)
      const name = uniqueName(safeFileName(rawName, fileMax), used, { isFile: true })
      const size = Number(row.s3?.size_bytes) || 0
      totalBytes += size
      entries.push({
        path: prefix + name,
        s3Key: row.s3?.s3_key || null,
        size,
        createdAt: row.created_at || null,
        company: participant.name || company,
        fileName: row.s3?.file_name || name,
      })
    }
    for (const row of [...current, ...attachments]) add(row, `${folder}/`, usedInFolder, row.s3?.file_name)
    for (const row of older) {
      add(row, `${folder}/${OLDER_VERSIONS_FOLDER}/`, usedInOlder, withLabel(row.s3?.file_name || '', row.version_label))
    }
  }

  return { entries, totalBytes }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new Error('пустой ответ хранилища')
}

function failedListText(failed) {
  const lines = [
    'В архив не попали файлы — скачайте их по одному в карточке тендера (Участники → КП / Документы):',
    '',
    ...failed.map(({ entry, error }) => `${entry.company} — ${entry.fileName}: ${error}`),
  ]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

// Скачивает файлы плана (не больше concurrency одновременно, сбой — повтор) и собирает ZIP.
// Не скачавшийся файл архив не останавливает: он попадает в «Не скачано.txt» и в failed,
// чтобы неполный архив не выглядел полным.
export async function buildTenderArchive(entries, fetchBytes, {
  onProgress = null,
  concurrency = 4,
  retries = 1,
  retryDelayMs = 1000,
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
  if (failed.length) zip.file(FAILED_LIST_NAME, failedListText(failed))
  // xlsx, pdf, docx уже сжаты — DEFLATE лишь замедлил бы сборку.
  return { bytes: zip.generate({ type: 'uint8array', compression: 'STORE' }), added, failed }
}
