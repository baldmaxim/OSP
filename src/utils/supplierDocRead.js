// Чтение файла документа поставщика (счёт, КП, УПД) для распознавания цен: Excel — библиотекой xlsx, PDF — pdf.js
// (текст страниц со словами и координатами). Сам разбор таблицы — utils/supplierDoc.js. Обе библиотеки тяжёлые и
// подгружаются только здесь, по требованию: таблица расценки открывается без них.
//
// Ответ readSupplierDoc: { kind: 'excel' | 'pdf', items, vat, sheetName | pages } или { error, message }:
//  unsupported — не Excel и не PDF; broken — файл не читается; encrypted — PDF под паролем; scan — в PDF нет текста
//  (скан, фото): распознать нечем; no_table — не нашли шапку (наименование и цена / сумма); empty — шапка есть, а
//  строк с ценой нет.
import {
  cellText, detectGridHeader, detectLinesHeader, gridRows, itemsFromRows, linesFromWords, pdfRows, vatFromText,
  wordsFromTextItems,
} from './supplierDoc.js'

export const SUPPLIER_DOC_ACCEPT = '.xlsx,.xlsm,.xls,.csv,.pdf'
export const isPdfFile = (name) => /\.pdf$/i.test(String(name || ''))
export const isSheetFile = (name) => /\.(xlsx|xlsm|xls|csv)$/i.test(String(name || ''))
// Больше — не разбираем: столько страниц / листов у счёта не бывает, а разбор подвесил бы страницу.
export const PDF_MAX_PAGES = 40
const SHEETS_MAX = 12
const VAT_TEXT_MAX = 200000

// Лист Excel → сетка значений (строки × колонки, от A1); объединённые ячейки в первых 60 строках (шапка) получают
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
    if (m.s.r > 60) continue
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

// Книга Excel → лучший лист: тот, где распозналось больше строк с ценой.
export function parseSupplierWorkbook(XLSX, wb) {
  let best = null
  let anyHeader = false
  let text = ''
  for (const name of (wb.SheetNames || []).slice(0, SHEETS_MAX)) {
    const grid = gridFromSheet(XLSX, wb.Sheets[name])
    if (text.length < VAT_TEXT_MAX) text += ` ${grid.map((row) => (row || []).map(cellText).filter(Boolean).join(' ')).join(' ')}`
    const header = detectGridHeader(grid)
    if (!header) continue
    anyHeader = true
    const items = itemsFromRows(gridRows(grid, header), header.columns)
    if (!best || items.length > best.items.length) best = { sheetName: name, items }
  }
  if (!best) return { error: 'no_table', sheetNames: wb.SheetNames || [] }
  if (!best.items.length) return { error: anyHeader ? 'empty' : 'no_table', sheetName: best.sheetName }
  return { kind: 'excel', items: best.items, sheetName: best.sheetName, vat: vatFromText(text) }
}

// Страницы PDF (текст pdf.js) → строки документа. pages: [{ items, height }]. Шапок может быть несколько (таблица
// на каждой странице, второй документ в файле) — берётся первая, у которой есть строки с ценой.
export function parseSupplierPdfPages(pages) {
  const words = []
  let text = ''
  pages.forEach((p, page) => {
    words.push(...wordsFromTextItems(p.items, { pageHeight: p.height, page }))
    if (text.length < VAT_TEXT_MAX) text += ` ${(p.items || []).map((it) => it.str || '').join(' ')}`
  })
  if (text.replace(/\s+/g, '').length < 20) return { error: 'scan', pages: pages.length }
  const lines = linesFromWords(words)
  let from = 0
  let header = null
  let found = false
  for (let guard = 0; guard < 10; guard++) {
    header = detectLinesHeader(lines, from)
    if (!header) break
    found = true
    const items = itemsFromRows(pdfRows(lines, header), header.columns)
    if (items.length) return { kind: 'pdf', items, pages: pages.length, vat: vatFromText(text) }
    from = header.line + header.span
  }
  return { error: found ? 'empty' : 'no_table', pages: pages.length }
}

// Текст страниц PDF: pdfjs — модуль pdf.js (в браузере — с отдельным потоком разбора, в тестах — как есть).
export async function readPdfPages(pdfjs, bytes) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false })
  const doc = await task.promise
  try {
    const pages = []
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const page = await doc.getPage(i)
      const { height } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      pages.push({ items: content.items, height })
      page.cleanup?.()
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

// Файл (байты и имя) → распознанные строки.
export async function readSupplierDoc(bytes, fileName) {
  if (isPdfFile(fileName)) {
    const pdfjs = await loadPdfjs()
    let pages
    try {
      pages = await readPdfPages(pdfjs, bytes.slice())
    } catch (e) {
      if (e?.name === 'PasswordException') return { error: 'encrypted' }
      return { error: 'broken', message: String(e?.message || e) }
    }
    try {
      return parseSupplierPdfPages(pages)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
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
      return parseSupplierWorkbook(XLSX, wb)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
  }
  return { error: 'unsupported' }
}
