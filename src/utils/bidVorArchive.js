// «Скачать все ВОР» и «Скачать все ВОР с моими ценами» в кабинете подрядчика (просьба пользователя 25.11.2026): каждый ВОР — своим
// файлом, все — одним ZIP. С ценами — исходная книга отдела, в которую вписаны цены и анкета (bidVorFill.js), оформление как на сайте.
// Модуль подгружается по нажатию: с ним pizzip и библиотека Excel. Байты файлов приходят через fetchBytes — сервер модуль не зовёт.
import PizZipNs from 'pizzip'
import { safeFileName, splitExtension } from './fileNames.js'
import { archiveBaseName, uniqueName, ENTRY_PATH_MAX, FAILED_LIST_NAME } from './tenderFilesArchive.js'
import { fillBidVorBytes, FILL_ERROR_TEXT } from './bidVorFill.js'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

export { FAILED_LIST_NAME, FILL_ERROR_TEXT }
export const NOT_FILLED_NAME = 'Цены не вписаны.txt'

// «Примавера 14 ВОР СКЗ v1 — ООО Альфа.xlsx»: отдел, получив файл письмом, сразу видит, чей он.
export function pricedFileName(fileName, company) {
  const [base, ext] = splitExtension(String(fileName || 'ВОР'))
  const who = String(company || '').trim() || 'с ценами'
  return safeFileName(`${base} — ${who}${ext || '.xlsx'}`, ENTRY_PATH_MAX)
}

export const vorArchiveName = (tender, priced) => `${archiveBaseName(tender, 'Тендер', { suffix: priced ? ' — ВОР с ценами' : ' — ВОР' })}.zip`

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Учётке с регистрации служба отдаёт название ведомости без расширения — его подсказывают байты (старый .xls начинается с D0 CF).
const withExtension = (name, bytes) => (/\.(xlsx|xlsm|xls)$/i.test(name) ? name : `${name}${bytes?.[0] === 0xd0 && bytes?.[1] === 0xcf ? '.xls' : '.xlsx'}`)
const listText = (head, lines) => `﻿${[head, '', ...lines].join('\r\n')}\r\n`

// Один ВОР с ценами: bytes — файл отдела, fill — { rates, fields, answers }. → { bytes, name } | { error, text }.
export function pricedVor(file, bytes, fill, company) {
  const res = fillBidVorBytes(bytes, fill)
  if (res.error) return { error: res.error, text: FILL_ERROR_TEXT[res.error] || 'цены вписать не удалось' }
  return { bytes: res.bytes, name: pricedFileName(file.file_name, company), stats: res.stats }
}

// files — [{ id, file_name, … }]; fetchBytes(file) → байты. fill — опции fillBidVorBytes (с ценами) или null (файлы отдела как есть).
// Скачивание — не больше concurrency сразу (ссылки выдаёт сервер с пределом запросов), сбой — один повтор; заполнение — по одному, со
// вздохом для страницы. Не скачавшийся файл архив не останавливает — он в «Не скачано.txt»; книга, в которую цены не вписались (.xls,
// нет колонки цен), кладётся как есть и называется в «Цены не вписаны.txt» — архив не выглядит заполненным, когда это не так.
// → { bytes | null, added, failed: [{ file, error }], unfilled: [{ file, text }] }.
export async function buildVorArchive(files, fetchBytes, { fill = null, company = '', onProgress = null, concurrency = 4, retries = 1 } = {}) {
  const results = new Array(files.length)
  const failed = []
  const unfilled = []
  let next = 0
  let done = 0
  let filling = Promise.resolve()

  const fetchWithRetry = async (file) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchBytes(file)
      } catch (e) {
        if (attempt >= retries) throw e
        await pause(1000)
      }
    }
  }
  const finish = (index, entry) => {
    results[index] = entry
    done += 1
    onProgress?.({ done, total: files.length })
  }
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]
      let bytes
      try {
        bytes = await fetchWithRetry(file)
      } catch (e) {
        failed.push({ index, file, error: e?.message || String(e) })
        finish(index, null)
        continue
      }
      if (!fill) { finish(index, { name: withExtension(file.file_name, bytes), bytes }); continue }
      // Заполнение нагружает страницу — по одному файлу, с паузой перед каждым, чтобы она успевала отрисоваться.
      filling = filling.then(async () => {
        await pause(0)
        const res = pricedVor(file, bytes, fill, company)
        if (res.error) {
          unfilled.push({ index, file, text: res.text })
          finish(index, { name: withExtension(file.file_name, bytes), bytes })
        } else {
          finish(index, { name: res.name, bytes: res.bytes })
        }
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  await filling

  const zip = new PizZip()
  const used = new Set()
  const date = new Date()
  let added = 0
  results.forEach((entry) => {
    if (!entry) return
    zip.file(uniqueName(safeFileName(entry.name, ENTRY_PATH_MAX), used, { isFile: true }), entry.bytes, { binary: true, date })
    added += 1
  })
  if (!added) return { bytes: null, added, failed, unfilled }
  failed.sort((a, b) => a.index - b.index)
  unfilled.sort((a, b) => a.index - b.index)
  if (failed.length) {
    zip.file(FAILED_LIST_NAME, listText('Не скачались — скачайте их по одному в кабинете (значок у ведомости):',
      failed.map((f) => `${f.file.file_name}: ${f.error}`)), { date })
  }
  if (unfilled.length) {
    zip.file(NOT_FILLED_NAME, listText('В эти файлы цены не вписаны — они в архиве как есть, расценку по ним видно на сайте:',
      unfilled.map((f) => `${f.file.file_name}: ${f.text}`)), { date })
  }
  // xlsx уже сжаты — DEFLATE лишь замедлил бы сборку.
  return { bytes: zip.generate({ type: 'uint8array', compression: 'STORE' }), added, failed, unfilled }
}
