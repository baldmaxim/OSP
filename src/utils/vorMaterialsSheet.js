// Лист «Материалы» файла ВОР (из «ВОРов и РД» тендера) → строки { name, unit, volume } для расценки снабжением.
//
// Шапку ищем сами: в первых 30 строках — строка, где есть «Наименование» и «Кол-во / Количество / Объём /
// Расход» (единица — «Ед. изм.», необязательна). Цены и суммы файла не читаются: их вводит снабжение.
// Не нашли — страница предлагает сопоставить колонки вручную (тот же разбор с явной картой колонок).
//
// Листа «Материалы» нет — запасной разбор самого листа ВОР (readMaterialsByCodeBytes): шапка с колонкой «КОД»,
// материалы — строки с кодом «мат.» / «мат» (isSupplyMaterial, как у вкладки «ВОР» карточки), объём — «Общий
// расход». Листы читаются по одному (сначала с «ВОР» в имени) до первого подходящего; результат автозагрузка
// хранит в базе (список позиций, карта колонок mode: 'code') — при следующих открытиях файл не разбирается.
import * as XLSX from 'xlsx'
import { buildSupplyPositions, isSupplyMaterial } from './vorMaterials.js'

export const HEADER_SCAN_ROWS = 30
export const MATERIALS_COLUMN_FIELDS = [
  { key: 'name', label: 'Наименование', required: true },
  { key: 'unit', label: 'Ед. изм.', required: false },
  { key: 'volume', label: 'Объём (кол-во)', required: true },
]

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

// Лист «Материалы» (без учёта регистра и пробелов; «Материалы ВОР» тоже подходит). Нет — null.
export function findMaterialsSheet(workbook) {
  const names = workbook?.SheetNames || []
  return names.find((n) => /^материал/.test(norm(n))) || null
}

// Признак колонки по тексту шапки. Объём важнее количества и расхода; «Кол-во позиций» (выгрузка карточки) —
// счётчик строк, а не объём.
function headerKind(text) {
  const t = norm(text)
  if (!t) return null
  if (/наименован/.test(t)) return { field: 'name', rank: 1 }
  if (/^ед\.?(\s|$)|ед\.?\s*изм|единиц/.test(t)) return { field: 'unit', rank: 1 }
  if (/позиц/.test(t)) return null
  if (/цена|стоимост|расценк/.test(t)) return null
  if (/объ[её]м/.test(t)) return { field: 'volume', rank: 1 }
  if (/кол-?во|количеств/.test(t)) return { field: 'volume', rank: 2 }
  if (/расход/.test(t)) return { field: 'volume', rank: 3 }
  return null
}

const sheetRange = (ws) => (ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null)
const cellValue = (ws, r, c) => {
  const cell = ws[XLSX.utils.encode_cell({ r, c })]
  return cell ? (cell.v ?? '') : ''
}

// Шапка листа: { headerRow (1-based), columns: { name, unit, volume } (0-based, unit может быть null) } | null.
export function detectMaterialsColumns(ws) {
  const range = sheetRange(ws)
  if (!range) return null
  const lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1)
  for (let r = range.s.r; r <= lastRow; r++) {
    const found = {}
    for (let c = range.s.c; c <= range.e.c; c++) {
      const kind = headerKind(cellValue(ws, r, c))
      if (!kind) continue
      const prev = found[kind.field]
      if (!prev || kind.rank < prev.rank) found[kind.field] = { col: c, rank: kind.rank }
    }
    if (found.name && found.volume) {
      return { headerRow: r + 1, columns: { name: found.name.col, unit: found.unit?.col ?? null, volume: found.volume.col } }
    }
  }
  return null
}

// Строка шапки (1-based) по одной колонке наименования; нет — 0 (данные с начала листа).
function findHeaderRowInColumn(ws, col) {
  const range = sheetRange(ws)
  if (!range || col == null) return 0
  const lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1)
  for (let r = range.s.r; r <= lastRow; r++) {
    if (headerKind(cellValue(ws, r, col))?.field === 'name') return r + 1
  }
  return 0
}

// Число из ячейки: «1 250,5», «1250.5», 1250.5 → 1250.5; пусто или не число → null.
export function parseVolume(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '')
  if (!s || s === '.' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// \b в JS — граница только латинских слов: для кириллицы — явная проверка, что дальше не буква.
const TOTAL_ROW = /^(итого|всего)(?![а-яё])/

// Разбор листа по карте колонок. map: { headerRow (1-based), columns: { name, unit, volume }, startRow?, endRow? }.
// Возвращает { rows: [{ name, unit, volume, row }], skipped: { sections, totals, empty } }.
// Раздел — строка с наименованием, но без ед. изм. и без объёма (заголовок группы материалов).
export function parseMaterialsSheet(ws, map) {
  const range = sheetRange(ws)
  const out = { rows: [], skipped: { sections: 0, totals: 0, empty: 0 } }
  if (!range || !map?.columns || map.columns.name == null || map.columns.volume == null) return out
  const first = Math.max(range.s.r, (map.startRow ? map.startRow - 1 : map.headerRow ?? 0))
  const last = Math.min(range.e.r, map.endRow ? map.endRow - 1 : range.e.r)
  for (let r = first; r <= last; r++) {
    const name = String(cellValue(ws, r, map.columns.name) ?? '').replace(/\s+/g, ' ').trim()
    const unit = map.columns.unit == null ? '' : String(cellValue(ws, r, map.columns.unit) ?? '').replace(/\s+/g, ' ').trim()
    const rawVolume = cellValue(ws, r, map.columns.volume)
    const volume = parseVolume(rawVolume)
    if (!name) { out.skipped.empty += 1; continue }
    if (TOTAL_ROW.test(name.toLowerCase())) { out.skipped.totals += 1; continue }
    // Строка номеров колонок под шапкой (1 | 2 | 3 | 4 …, часто с фильтрами) — наименование из одних цифр.
    if (/^\d+$/.test(name)) { out.skipped.empty += 1; continue }
    // Повтор шапки (лист из нескольких таблиц) — не позиция.
    if (headerKind(name)?.field === 'name') { out.skipped.empty += 1; continue }
    if (!unit && volume == null) { out.skipped.sections += 1; continue }
    out.rows.push({ name, unit, volume, row: r + 1 })
  }
  return out
}

// ── Лист ВОР целиком: колонка «КОД», материалы — строки «мат.» ──────────────────────────────────────
// Признак колонки шапки ВОР. Объём материала — «Общий расход» (в ВОР рядом «Объём по виду работ» — объём работы).
function codeHeaderKind(text) {
  const t = norm(text)
  if (!t) return null
  if (/^код(?![а-яё])/.test(t)) return { field: 'code', rank: 1 }
  if (/наименован/.test(t)) return { field: 'name', rank: 1 }
  if (/^ед\.?(\s|$)|ед\.?\s*изм|единиц/.test(t)) return { field: 'unit', rank: 1 }
  if (/цена|стоимост|расценк|сумм/.test(t)) return null
  if (/расход/.test(t)) return { field: 'volume', rank: 1 }
  if (/объ[её]м|кол-?во|количеств/.test(t)) return { field: 'volume', rank: 2 }
  return null
}

// Шапка листа ВОР: { headerRow (1-based), consumption, columns: { code, name, unit, volume } } | null.
// consumption — объём взят из «расхода»: только тогда строку без кода можно счесть материалом (по расходу > 0).
export function detectCodeColumns(ws) {
  const range = sheetRange(ws)
  if (!range) return null
  const lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1)
  for (let r = range.s.r; r <= lastRow; r++) {
    const found = {}
    let consumption = false
    for (let c = range.s.c; c <= range.e.c; c++) {
      const text = cellValue(ws, r, c)
      const kind = codeHeaderKind(text)
      if (!kind) continue
      const prev = found[kind.field]
      if (!prev || kind.rank < prev.rank) {
        found[kind.field] = { col: c, rank: kind.rank }
        if (kind.field === 'volume') consumption = /расход/.test(norm(text))
      }
    }
    if (found.code && found.name && found.volume) {
      return { headerRow: r + 1, consumption, columns: { code: found.code.col, name: found.name.col, unit: found.unit?.col ?? null, volume: found.volume.col } }
    }
  }
  return null
}

// Строки-материалы листа ВОР по карте колонок с кодом. Разделы, работы («Р»), шапка, номера колонок, итоги и
// анкета претендента — не материалы (isSupplyMaterial); строка без кода — материал только при объёме из расхода.
export function parseCodeSheet(ws, map) {
  const range = sheetRange(ws)
  const out = { rows: [], skipped: { sections: 0, totals: 0, empty: 0 } }
  if (!range || !map?.columns || map.columns.code == null || map.columns.name == null || map.columns.volume == null) return out
  const first = Math.max(range.s.r, map.headerRow ?? 0)
  for (let r = first; r <= range.e.r; r++) {
    const name = String(cellValue(ws, r, map.columns.name) ?? '').replace(/\s+/g, ' ').trim()
    if (!name) { out.skipped.empty += 1; continue }
    if (TOTAL_ROW.test(name.toLowerCase())) { out.skipped.totals += 1; continue }
    const code = String(cellValue(ws, r, map.columns.code) ?? '').trim()
    const unit = map.columns.unit == null ? '' : String(cellValue(ws, r, map.columns.unit) ?? '').replace(/\s+/g, ' ').trim()
    const volume = parseVolume(cellValue(ws, r, map.columns.volume))
    if (!isSupplyMaterial({ code, unit, volume: code || map.consumption ? volume : null })) { out.skipped.sections += 1; continue }
    out.rows.push({ name, unit, volume, row: r + 1 })
  }
  return out
}

const codeResult = (sheetName, det, parsed) => ({
  sheetName,
  map: { mode: 'code', sheetName, headerRow: det.headerRow, startRow: null, endRow: null, consumption: det.consumption, columns: det.columns },
  ...parsed,
})

// Листа «Материалы» нет: листы книги по одному (сначала с «ВОР» в имени, не больше CODE_SHEETS_MAX) — первый с
// колонкой «КОД» и строками-материалами. Нет такого → { error: 'no_sheet', codeTried: true }; колонка «КОД» есть,
// а материалов нет → { error: 'no_material_codes', sheetName }.
const CODE_SHEETS_MAX = 6
export function readMaterialsByCodeBytes(bytes, sheetNames) {
  const isVor = (n) => (/вор/i.test(n) ? 1 : 0)
  const order = [...sheetNames].sort((a, b) => isVor(b) - isVor(a)).slice(0, CODE_SHEETS_MAX)
  let noCodes = null
  for (const name of order) {
    const ws = XLSX.read(bytes, { ...READ_OPTIONS, sheets: [name] }).Sheets[name]
    const det = ws && detectCodeColumns(ws)
    if (!det) continue
    const parsed = parseCodeSheet(ws, det)
    if (parsed.rows.length) return codeResult(name, det, parsed)
    noCodes = noCodes || { error: 'no_material_codes', sheetName: name, sheetNames }
  }
  return noCodes || { error: 'no_sheet', codeTried: true, sheetNames }
}

// Книга → разбор листа «Материалы» со своей шапкой. Нет листа → { error: 'no_sheet' };
// шапка не распознана → { error: 'no_header', sheetName } (тогда — ручное сопоставление).
// Сохранённая карта mode: 'code' — тот же лист ВОР с колонкой «КОД» (новая версия файла разбирается сразу).
export function readMaterialsFromWorkbook(workbook, manualMap = null) {
  const sheetName = manualMap?.sheetName || findMaterialsSheet(workbook)
  if (!sheetName || !workbook.Sheets[sheetName]) return { error: 'no_sheet', sheetNames: workbook?.SheetNames || [] }
  const ws = workbook.Sheets[sheetName]
  if (manualMap?.mode === 'code') {
    const det = detectCodeColumns(ws)
    if (!det) return { error: 'no_header', sheetName, sheetNames: workbook.SheetNames }
    const parsed = parseCodeSheet(ws, det)
    return parsed.rows.length ? codeResult(sheetName, det, parsed) : { error: 'no_material_codes', sheetName, sheetNames: workbook.SheetNames }
  }
  let map = manualMap?.columns ? manualMap : detectMaterialsColumns(ws)
  if (!map) return { error: 'no_header', sheetName, sheetNames: workbook.SheetNames }
  // Колонки заданы вручную, а строка начала — нет: данные после строки с «Наименование» в колонке наименования.
  if (manualMap?.columns && !manualMap.startRow && !manualMap.headerRow) {
    map = { ...map, headerRow: findHeaderRowInColumn(ws, manualMap.columns.name) }
  }
  const parsed = parseMaterialsSheet(ws, map)
  return { sheetName, map: { sheetName, headerRow: map.headerRow ?? null, startRow: map.startRow ?? null, endRow: map.endRow ?? null, columns: map.columns }, ...parsed }
}

// Чтение файла как в ПСДЦ: без формул-вычислений, без макросов.
const READ_OPTIONS = { type: 'array', cellFormula: false, cellStyles: false, bookVBA: false, cellHTML: false }
export function readWorkbookBytes(bytes) {
  return XLSX.read(bytes, READ_OPTIONS)
}

// Только лист «Материалы» (и extraSheets — лист из сохранённой карты колонок): сначала имена листов, затем
// разбор нужных. Соседние «КП» / «Работы» в ВОР бывают на десятки тысяч строк — полный разбор занимал секунды
// и подвешивал страницу. SheetNames — все листы книги (для подсказки «листы: …»), Sheets — только нужные.
export function readMaterialsWorkbookBytes(bytes, extraSheets = []) {
  const names = XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames || []
  const wanted = [...new Set([findMaterialsSheet({ SheetNames: names }), ...extraSheets])].filter((n) => n && names.includes(n))
  if (!wanted.length) return { SheetNames: names, Sheets: {} }
  return XLSX.read(bytes, { ...READ_OPTIONS, sheets: wanted })
}

// Один файл ВОР → позиции для расценки — так их загружает автозагрузка: и страница расценки, и служба osp-api
// (server/osp-api/src/shared — копия этого модуля, scripts/sync-osp-api-shared.mjs). Лист «Материалы» со своей шапкой
// или по сохранённой карте колонок saved (column_map прежнего списка); листа «Материалы» нет — сам лист ВОР по
// колонке «КОД». Ответ: { positions, sheetName, map } | { error, sheetNames, sheetName, codeTried, message }; error —
// причина из файла (broken, no_sheet, no_header, no_material_codes, empty).
export function parseVorFileBytes(bytes, saved = null) {
  let wb
  try {
    wb = readMaterialsWorkbookBytes(bytes, saved?.sheetName ? [saved.sheetName] : [])
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
  try {
    let result = readMaterialsFromWorkbook(wb)
    if ((result.error === 'no_header' || result.error === 'no_sheet') && saved?.columns && wb.Sheets[saved.sheetName]) result = readMaterialsFromWorkbook(wb, saved)
    if (result.error === 'no_sheet') result = readMaterialsByCodeBytes(bytes, wb.SheetNames)
    const positions = result.error ? [] : buildSupplyPositions(result.rows)
    if (result.error || !positions.length) {
      return { error: result.error || 'empty', sheetNames: result.sheetNames || wb.SheetNames, sheetName: result.sheetName, codeTried: result.codeTried }
    }
    return { positions, sheetName: result.sheetName, map: result.map }
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
}

// Файл ВОР из «ВОРов и РД» годится, если это книга Excel — проверка в модуле без библиотеки Excel.
export { isWorkbookFileName } from './vorFiles.js'
