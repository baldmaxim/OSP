// Цены из файла подрядчика → позиции расценки в кабинете (миграция 20261102). Файл — что угодно с таблицей
// «наименование + цена / сумма»: свой прайс («база расценок»), КП, счёт (Excel, CSV, PDF с текстом) или
// заполненный ВОР отдела (листы «Материалы» и «Работы» — их строки сопоставляются только с позициями своего вида).
//
// Разбор строк — тот же, что у расценки снабжением (utils/supplierDoc + supplierDocRead), сопоставление — тот же
// расчёт похожести (utils/supplyDocMatch): сначала точно по наименованию, затем самые похожие; каждое
// сопоставление видит и может поменять человек.
import { cellText, detectGridHeader, gridRows, itemsFromRows, vatFromText } from './supplierDoc.js'
import { gridFromSheet, isSheetFile, readSupplierDoc, readWorkbookBytes, parseSupplierWorkbook } from './supplierDocRead.js'
import { matchDocItems, searchGroups } from './supplyDocMatch.js'
import { nameParts } from './supplySimilarity.js'
import { findBidSheets } from './bidVor.js'

export { SUPPLIER_DOC_ACCEPT as BID_DOC_ACCEPT } from './supplierDocRead.js'

const VAT_TEXT_MAX = 200000

// Заполненный ВОР отдела: строки листов «Материалы» и «Работы» с видом. Нет таких листов или в них нет цен — null.
export function itemsFromBidWorkbook(XLSX, wb) {
  const sheets = findBidSheets(wb.SheetNames || [])
  const out = []
  let text = ''
  for (const [kind, name] of [['material', sheets.materials], ['work', sheets.works]]) {
    if (!name || !wb.Sheets[name]) continue
    const grid = gridFromSheet(XLSX, wb.Sheets[name])
    if (text.length < VAT_TEXT_MAX) text += ` ${grid.map((row) => (row || []).map(cellText).filter(Boolean).join(' ')).join(' ')}`
    const header = detectGridHeader(grid)
    if (!header) continue
    for (const it of itemsFromRows(gridRows(grid, header), header.columns)) out.push({ ...it, kindHint: kind, sheet: name })
  }
  if (!out.length) return null
  return { kind: 'excel', items: out, sheetName: [sheets.materials, sheets.works].filter(Boolean).join(' + '), vat: vatFromText(text) }
}

// Файл → { kind, items, vat, sheetName | pages } | { error } (коды ошибок — как у readSupplierDoc).
export async function readBidPriceDoc(bytes, fileName) {
  if (isSheetFile(fileName) && !/\.csv$/i.test(fileName)) {
    const XLSX = await import('xlsx')
    let wb
    try {
      wb = readWorkbookBytes(XLSX, bytes, fileName)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
    try {
      return itemsFromBidWorkbook(XLSX, wb) || parseSupplierWorkbook(XLSX, wb)
    } catch (e) {
      return { error: 'broken', message: String(e?.message || e) }
    }
  }
  return readSupplierDoc(bytes, fileName)
}

export const DOC_ERROR_TEXT = {
  unsupported: 'Такой файл не читается: нужен Excel (.xlsx, .xls), CSV или PDF.',
  broken: 'Файл не открылся — возможно, он повреждён.',
  encrypted: 'PDF защищён паролем — сохраните его без пароля.',
  scan: 'В PDF нет текста (скан или фото) — распознать нечем. Нужен Excel или PDF с текстом.',
  no_table: 'Не нашли таблицу: нужна шапка с колонками «Наименование» и «Цена» (или «Сумма»).',
  empty: 'Шапку нашли, а строк с ценой нет.',
}

// Позиции расценки → группы для сопоставления (как positionGroups у снабжения): одна позиция — одна группа.
export function bidGroups(positions) {
  return positions.map((p) => ({
    key: p.key, k: p.itemKey, name: p.name, unit: p.unit, units: null, parts: nameParts(p.name), kind: p.kind, position: p,
  }))
}

// Строки документа → [{ item, match, candidates }]. Строки с видом (лист «Материалы» / «Работы») ищут только
// среди позиций своего вида; одна позиция — одной строке внутри своей группы поиска.
export function matchBidItems(items, groups) {
  const out = new Array(items.length)
  const run = (filterItem, filterGroup) => {
    const idx = []
    items.forEach((it, i) => { if (filterItem(it)) idx.push(i) })
    if (!idx.length) return
    const res = matchDocItems(idx.map((i) => items[i]), groups.filter(filterGroup))
    res.forEach((r, j) => { out[idx[j]] = r })
  }
  run((it) => it.kindHint === 'material', (g) => g.kind === 'material')
  run((it) => it.kindHint === 'work', (g) => g.kind === 'work')
  run((it) => !it.kindHint, () => true)
  return out
}

export const searchBidGroups = (query, groups, kind = null, limit = 20) =>
  searchGroups(query, kind ? groups.filter((g) => g.kind === kind) : groups, limit)
