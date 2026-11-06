// Чтение файла документа поставщика (счёт, КП, УПД) для распознавания цен: Excel — библиотекой xlsx, PDF — pdf.js
// (текст страниц со словами и координатами). Сам разбор таблицы — utils/supplierDoc.js. Обе библиотеки тяжёлые и
// подгружаются только здесь, по требованию: таблица расценки открывается без них.
//
// Скан и фото — распознаванием в браузере (utils/supplierOcr, подгружается только для них): файл никуда не уходит.
//
// Ответ readSupplierDoc: { kind: 'excel' | 'pdf' | 'image', items, vat, date, currency, total, ocr, sheetName | pages } или { error, message }
// (date — дата документа, currency — цены не в рублях, total — сверка с итогом документа, supplierDoc.totalsCheck; ocr — строки
// со скана: у них unsure, если цифры не сошлись между собой):
//  unsupported — не Excel, не PDF и не картинка; broken — файл не читается; encrypted — PDF под паролем; scan — текст не
//  распознался (пустая страница, плохое качество); no_table — не нашли шапку (наименование и цена / сумма); empty — шапка есть, а
//  строк с ценой нет; ocr_failed — распознаватель не загрузился (сбой сети, браузера): файл не виноват, прочитаем в следующий раз.
import {
  cellText, currencyFromText, detectGridHeader, detectLinesHeader, docDateFromText, gridRows, gridTotals, itemsFromRows, linesFromWords, pdfRows,
  rulingsFromOps, totalsCheck, vatFromText, wordsFromTextItems,
} from './supplierDoc.js'
import { ocrChecked } from './supplierOcrPage.js'

export const SUPPLIER_DOC_ACCEPT = '.xlsx,.xlsm,.xlsb,.xls,.ods,.csv,.pdf,.jpg,.jpeg,.png,.webp'
export const isPdfFile = (name) => /\.pdf$/i.test(String(name || ''))
export const isSheetFile = (name) => /\.(xlsx|xlsm|xlsb|xls|ods|csv)$/i.test(String(name || ''))
export const isImageFile = (name) => /\.(jpe?g|png|webp)$/i.test(String(name || ''))
// Больше — не разбираем: столько страниц / листов у счёта не бывает, а разбор подвесил бы страницу.
export const PDF_MAX_PAGES = 40
const SHEETS_MAX = 12
const VAT_TEXT_MAX = 200000
// Объединённые ячейки заполняются там, где может быть шапка (supplierDoc.HEADER_SCAN_ROWS и её три строки).
const MERGE_FILL_ROWS = 204

// Лист Excel → сетка значений (строки × колонки, от A1); объединённые ячейки там, где может быть шапка, получают
// значение левой верхней — «Цена» над «без НДС» и «с НДС» относится к обеим.
export function gridFromSheet(XLSX, ws) {
  if (!ws?.['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true })
  const grid = []
  rows.forEach((row, i) => {
    const r = range.s.r + i
    grid[r] = []
    row.forEach((v, j) => { grid[r][range.s.c + j] = v })
  })
  for (let r = 0; r < grid.length; r++) if (!grid[r]) grid[r] = []
  for (const m of ws['!merges'] || []) {
    if (m.s.r > MERGE_FILL_ROWS) continue
    const v = grid[m.s.r]?.[m.s.c]
    if (v == null || v === '') continue
    for (let r = m.s.r; r <= Math.min(m.e.r, m.s.r + 5); r++) {
      for (let c = m.s.c; c <= m.e.c; c++) if (grid[r] && (grid[r][c] == null || grid[r][c] === '')) grid[r][c] = v
    }
  }
  return grid
}

// Байты файла → книга. CSV — текстом (UTF-8, а не он — Windows-1251, как сохраняет русский Excel) и без разбора
// чисел библиотекой: «250,00» она прочла бы как 25000 (запятая — разряды); числа разбирает parseNum.
export function readWorkbookBytes(XLSX, bytes, fileName) {
  if (/\.csv$/i.test(String(fileName || ''))) {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('windows-1251').decode(bytes)
    }
    return XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string', raw: true })
  }
  return XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false })
}

// Книга Excel → строки всех видимых листов с таблицей (кабель на одном листе, лотки на другом): лист-копия и сводная —
// без повторов (то же наименование, ед. изм. и цена). Скрытые листы — черновики, их не читаем (если видимые есть).
export function parseSupplierWorkbook(XLSX, wb) {
  const names = wb.SheetNames || []
  const hidden = wb.Workbook?.Sheets || []
  const visible = names.filter((_, i) => !hidden[i]?.Hidden)
  const sheets = []
  let anyHeader = false
  let text = ''
  for (const name of (visible.length ? visible : names).slice(0, SHEETS_MAX)) {
    const grid = gridFromSheet(XLSX, wb.Sheets[name])
    // Текст листа для даты и НДС. Объединённая ячейка — один раз: иначе абзац условий над таблицей, повторённый по всей ширине,
    // вытеснил бы дату «Счёт № … от …» за предел, где её ищут.
    if (text.length < VAT_TEXT_MAX) {
      text += ` ${grid.map((row) => (row || []).map(cellText).filter((v, i, all) => v && v !== all[i - 1]).join(' ')).join(' ')}`
    }
    const header = detectGridHeader(grid)
    if (!header) continue
    anyHeader = true
    const items = itemsFromRows(gridRows(grid, header), header.columns)
    if (items.length) sheets.push({ name, items, currency: header.columns.currency, total: totalsCheck(items, gridTotals(grid, header)) })
  }
  if (!sheets.length) return { error: anyHeader ? 'empty' : 'no_table', sheetNames: names }
  const seen = new Set()
  const items = []
  for (const sheet of sheets) {
    for (const it of sheet.items) {
      const key = `${it.name}|${it.unit}|${it.price ?? it.sum}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(sheets.length > 1 ? { ...it, source: `лист «${sheet.name}», ${it.source}` } : it)
    }
  }
  return {
    kind: 'excel', items, sheetName: sheets.map((s) => s.name).join(', '), vat: vatFromText(text), date: docDateFromText(text.slice(0, 4000)),
    currency: sheets.find((s) => s.currency)?.currency || currencyFromText(text),
    total: sheets.map((s) => s.total).find((t) => t && !t.ok) || sheets.map((s) => s.total).find(Boolean) || null,
  }
}

// Страницы PDF (текст pdf.js) → строки документа. pages: [{ items, height, rulings }] (rulings — линии рамок таблицы,
// supplierDoc.rulingsFromOps; нет — разбор по одному тексту). Таблиц может быть несколько (разделы со своей шапкой, счёт и
// спецификация в одном файле): читаем все, повторы (то же наименование, ед. изм. и цена) — один раз.
export function parseSupplierPdfPages(pages) {
  const words = []
  let text = ''
  pages.forEach((p, page) => {
    words.push(...wordsFromTextItems(p.items, { pageHeight: p.height, page }))
    if (text.length < VAT_TEXT_MAX) text += ` ${(p.items || []).map((it) => it.str || '').join(' ')}`
  })
  if (text.replace(/\s+/g, '').length < 20) return { error: 'scan', pages: pages.length }
  const lines = linesFromWords(words)
  const rules = pages.map((p) => p.rulings || null)
  let from = 0
  let found = false
  let currency = null
  let total = null
  const seen = new Set()
  const items = []
  for (let guard = 0; guard < 10 && from < lines.length; guard++) {
    const header = detectLinesHeader(lines, from, rules)
    if (!header) break
    found = true
    const rows = pdfRows(lines, header, rules)
    const part = itemsFromRows(rows, header.columns)
    for (const it of part) {
      const key = `${it.name}|${it.unit}|${it.price ?? it.sum}`
      if (!seen.has(key)) { seen.add(key); items.push(it) }
    }
    if (part.length) {
      currency ||= header.columns.currency || null
      const check = totalsCheck(part, rows.totals)
      if (check && (!total || !check.ok)) total = check
    }
    from = Math.max(rows.end, header.line + header.span)
  }
  if (!items.length) return { error: found ? 'empty' : 'no_table', pages: pages.length }
  return {
    kind: 'pdf', items, pages: pages.length, vat: vatFromText(text), date: docDateFromText(text.slice(0, 4000)),
    currency: currency || currencyFromText(text), total,
  }
}

// Текст страниц PDF и линии рамок таблиц: pdfjs — модуль pdf.js (в браузере — с отдельным потоком разбора, в тестах —
// как есть). Линии (команды рисования страницы) — только если в файле есть текст: у скана линий нет, они в самой картинке.
export async function readPdfPages(pdfjs, bytes) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false })
  const doc = await task.promise
  try {
    const pages = []
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const page = await doc.getPage(i)
      const { height } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      pages.push({ page, items: content.items, height })
    }
    const hasText = pages.some((p) => p.items.some((it) => String(it.str || '').trim()))
    const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].filter((op) => op != null))
    for (const p of pages) {
      if (hasText) {
        try {
          const ops = await p.page.getOperatorList()
          p.rulings = rulingsFromOps(ops, pdfjs.OPS, { pageHeight: p.height })
          p.images = ops.fnArray.filter((fn) => imageOps.has(fn)).length
        } catch {
          p.rulings = null // рисунок страницы не прочитался — разбор по одному тексту
        }
      }
      p.page.cleanup?.()
      delete p.page
    }
    return pages
  } finally {
    // Документ закрывается через задачу загрузки (у самого документа в pdf.js 6 закрытия нет).
    await task.destroy()
  }
}

let pdfjsPromise = null
function loadPdfjs() {
  // Сборка legacy — и для браузеров постарше. Поток разбора собирает Vite (?worker) в обычный .js: файл .mjs из
  // пакета nginx портала отдал бы с типом application/octet-stream, и браузер не запустил бы его как скрипт.
  pdfjsPromise ||= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'),
  ]).then(([pdfjs, worker]) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) pdfjs.GlobalWorkerOptions.workerPort = new worker.default()
    return pdfjs
  }).catch((e) => {
    pdfjsPromise = null
    throw e
  })
  return pdfjsPromise
}

// Скан и фото: тот же разбор, что у PDF с текстом, но цифрам со скана доверия меньше (ocrChecked). Распознаватель тяжёлый (10 МБ,
// секунды на страницу) — только для них, по требованию. Не загрузился — ocr_failed, а не «файл не читается»: прочитаем в следующий
// раз. onProgress({ page, pages }).
async function readScan(bytes, fileName, kind, onProgress) {
  let pages
  try {
    const ocr = await import('./supplierOcr.js')
    pages = kind === 'image'
      ? await ocr.readScanImage(bytes, fileName, { onProgress })
      : await ocr.readScanPdf(await loadPdfjs(), bytes.slice(), { onProgress })
  } catch (e) {
    return { error: 'ocr_failed', message: String(e?.message || e) }
  }
  try {
    const r = parseSupplierPdfPages(pages)
    if (r.error) return r
    return { ...r, kind, ocr: true, items: ocrChecked(r.items), date: r.date || docDateFromText(fileName) }
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
}

// Файл (байты и имя) → распознанные строки. PDF: текст есть и таблица в нём нашлась — как есть; иначе, если на страницах есть
// картинки, — распознаём их: скан целиком или скан с текстовым колонтитулом. opts.onProgress — ход распознавания.
export async function readSupplierDoc(bytes, fileName, { onProgress = null } = {}) {
  if (isImageFile(fileName)) return readScan(bytes, fileName, 'image', onProgress)
  if (isPdfFile(fileName)) {
    const pdfjs = await loadPdfjs()
    let pages
    try {
      pages = await readPdfPages(pdfjs, bytes.slice())
    } catch (e) {
      if (e?.name === 'PasswordException') return { error: 'encrypted' }
      return { error: 'broken', message: String(e?.message || e) }
    }
    let r
    try {
      r = parseSupplierPdfPages(pages)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
    if (r.error === 'scan' || ((r.error === 'no_table' || r.error === 'empty') && pages.some((p) => p.images > 0))) {
      const scan = await readScan(bytes, fileName, 'pdf', onProgress)
      // В тексте таблицы нет и на картинках не нашлось — причина прежняя, но уже после попытки.
      return scan.error && scan.error !== 'ocr_failed' && r.error !== 'scan' ? r : scan
    }
    return r.error || r.date ? r : { ...r, date: docDateFromText(fileName) }
  }
  if (isSheetFile(fileName)) {
    const XLSX = await import('xlsx')
    let wb
    try {
      wb = readWorkbookBytes(XLSX, bytes, fileName)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
    try {
      const r = parseSupplierWorkbook(XLSX, wb)
      return r.error || r.date ? r : { ...r, date: docDateFromText(fileName) }
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
  }
  return { error: 'unsupported' }
}
