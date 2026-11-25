// Файл ВОР отдела + цены подрядчика → тот же файл с ценами (просьба пользователя 25.11.2026: «ВОРы должны скачиваться в том же
// оформлении, что они подгружены на сайт», каждый ВОР — своим файлом; «Главный лист» тоже заполняется).
//
// Книга не пересобирается: меняются только ячейки цен, примечаний и анкеты (utils/xlsxXml.js), всё остальное — оформление, формулы,
// выпадающие списки, скрытые листы — как в файле отдела. Формулы остаются, их сохранённые результаты убираются (прежние итоги после
// вписанных цен неверны; LibreOffice с ними показывал старый итог листа), и Excel пересчитывает книгу при открытии (fullCalcOnLoad):
// итоги листов, цены «КП» (в шаблоне отдела это ВПР/XLOOKUP по «Материалам» и «Работам») и «ИТОГО с НДС» встанут сами. Программа,
// которая книгу не считает (просмотр SheetJS), покажет на месте формул пустые ячейки, а не неверные суммы.
//
// Куда вписывается:
//   • «Материалы» / «Работы» — колонка «Цена…» (не «Итого», не «Стоимость») строки позиции; «Примечание…» — примечание подрядчика;
//   • «КП» — колонки «Цена … материалы/оборудование» и «Цена … СМР» (шапка в одну или две строки), только если в ячейке нет формулы:
//     так ВОР без листов «Материалы» / «Работы» тоже заполняется, а формулы шаблона не перебиваются;
//   • анкета — блок «Квалификационная и контактная информация» («Главный лист» или «КП»): строка ищется по подписи поля анкеты
//     кабинета, ответ — в ячейку ответа блока (объединённая ячейка справа от подписи, выпадающий список или колонка, где уже стоит
//     значение); «Наименование контрагента», «ИНН»… над таблицей «КП» — только при точном совпадении подписи и в пустую ячейку.
// Позиция без цены не трогается (в шаблоне там ноль или пусто). Ключ позиции — тот же, что у разбора (bidVor.js): вид + наименование
// + ед. изм.
import * as XLSXNs from 'xlsx'
import PizZipNs from 'pizzip'
import { findBidSheets, detectKpColumns, parseKpSheet } from './bidVor.js'
import { detectMaterialsColumns, parseMaterialsSheet } from './vorMaterialsSheet.js'
import { bidKey } from './bidPrice.js'
import { parseVatAnswer, VAT_FIELD_CODE } from './bidForm.js'
import { sheetPaths, patchSheetXml, setFullCalcOnLoad, dataValidationRanges, stripFormulaValues } from './xlsxXml.js'

const XLSX = XLSXNs.read ? XLSXNs : XLSXNs.default
const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

// Файлы ВОР отдела — сотни килобайт; больше — не книга для расценки, и страница бы надолго встала.
export const FILL_MAX_BYTES = 30 * 1024 * 1024

export const FILL_ERROR_TEXT = {
  format: 'это не книга .xlsx — цены в такой файл не вписать',
  broken: 'файл не открылся',
  too_large: 'файл слишком большой',
  no_columns: 'не нашли в файле колонку цен',
}

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const toBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b))

// ── Ячейки ───────────────────────────────────────────────────────────────────────────────────────────
const cellAt = (ws, r, c) => ws[XLSX.utils.encode_cell({ r, c })]
const hasFormula = (ws, r, c) => !!cellAt(ws, r, c)?.f
const isBlank = (cell) => !cell || cell.v == null || String(cell.v).trim() === ''
const mergeAt = (ws, r, c) => (ws['!merges'] || []).find((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) || null
// Текст шапки: у объединённой ячейки — текст её левой верхней.
const headText = (ws, r, c) => {
  const m = mergeAt(ws, r, c)
  const cell = m ? cellAt(ws, m.s.r, m.s.c) : cellAt(ws, r, c)
  return cell ? clean(cell.v) : ''
}

// ── Колонки цен ──────────────────────────────────────────────────────────────────────────────────────
// Шапка — строка headerRow (с нуля) и следующая (двухстрочная шапка «Цена за единицу» → «Материалы» / «СМР»).
// taken — колонки (с 1), уже занятые наименованием, ед. изм., объёмом: ими колонка цен быть не может.
// → { price: [{ col, kind: 'material' | 'work' | null }], note: col | null }
export function priceColumns(ws, headerRow, taken = new Set()) {
  const range = XLSX.utils.decode_range(ws['!ref'])
  const out = { price: [], note: null }
  for (let c = range.s.c; c <= range.e.c; c++) {
    if (taken.has(c + 1)) continue
    const top = headText(ws, headerRow, c)
    const sub = headerRow + 1 <= range.e.r ? headText(ws, headerRow + 1, c) : ''
    const t = norm(top === sub ? top : `${top} ${sub}`)
    if (!t) continue
    if (/примечан|комментар/.test(t)) { if (out.note == null) out.note = c; continue }
    // Цена за единицу: «Цена…», «Расценка…», «Стоимость за ед.»; итоговые («Итого», «Стоимость», «Сумма», «Всего») — нет.
    const unitCost = /стоимост[а-я]*\s+(за\s+)?(1\s+)?ед/.test(t)
    if (!(unitCost || /цен[аы]|расценк/.test(t)) || /итог|сумм|всего/.test(t) || (!unitCost && /стоимост/.test(t))) continue
    let kind = null
    if (/материал|оборудован|(^|\s)мат\.?(\s|$)/.test(t)) kind = 'material'
    else if (/смр|пнр|работ|монтаж|услуг/.test(t)) kind = 'work'
    out.price.push({ col: c, kind })
  }
  return out
}

// ── Анкета ───────────────────────────────────────────────────────────────────────────────────────────
const FORM_HEAD = /квалификац|контактн[а-я]*\s+информац/
const labelNorm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9%]+/g, ' ').trim()
const labelWords = (s) => new Set(labelNorm(s).split(' ').filter((w) => w.length >= 3 || /[\d%]/.test(w)))
const isVatLabel = (s) => /ндс/.test(labelNorm(s)) && /%|ставк|процент|размер/.test(labelNorm(s))

// Похожесть подписи поля анкеты и строки файла: 1 — одинаковы, 0,9 — одна начинается с другой, иначе доля общих слов.
export function labelScore(fieldLabel, rowLabel) {
  const a = labelNorm(fieldLabel)
  const b = labelNorm(rowLabel)
  if (!a || !b) return 0
  if (a === b) return 1
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length >= 8 && long.startsWith(short)) return 0.9
  const wa = labelWords(a)
  const wb = labelWords(b)
  if (!wa.size || !wb.size) return 0
  let both = 0
  for (const w of wa) if (wb.has(w)) both += 1
  return both / (wa.size + wb.size - both)
}

// Подпись строки: первая ячейка с буквами (номер «1», «4.» — не подпись). → { col, end, text } | null; end — конец объединения.
function rowLabel(ws, r, fromCol, toCol) {
  for (let c = fromCol; c <= toCol; c++) {
    const cell = cellAt(ws, r, c)
    if (!cell || typeof cell.v !== 'string' || !/[a-zа-яё]/i.test(cell.v)) continue
    const m = mergeAt(ws, r, c)
    return { col: c, end: m && m.s.c === c ? m.e.c : c, text: clean(cell.v) }
  }
  return null
}

// Поля анкеты ↔ строки: сначала НДС (поле с кодом vat — строка про ставку НДС), остальные — по подписи, лучшие пары первыми.
function matchFields(rows, fields, answers, minScore) {
  const pairs = []
  for (const f of fields) {
    const value = clean(answers?.[f.id])
    if (!value) continue
    rows.forEach((row, i) => {
      const vatRow = isVatLabel(row.label.text)
      const score = f.code === VAT_FIELD_CODE ? (vatRow ? 1 : 0) : (vatRow ? 0 : labelScore(f.label, row.label.text))
      if (score >= minScore) pairs.push({ f, i, score, value })
    })
  }
  pairs.sort((a, b) => b.score - a.score)
  const usedF = new Set()
  const usedR = new Set()
  const out = []
  for (const p of pairs) {
    if (usedF.has(p.f.id) || usedR.has(p.i)) continue
    usedF.add(p.f.id)
    usedR.add(p.i)
    out.push(p)
  }
  return out
}

// Ответ в ячейку: ставка НДС — числом, как в выпадающем списке шаблона («22»), если там не текст с «%»; прочее — текстом.
function answerValue(field, value, cell) {
  if (field.code !== VAT_FIELD_CODE) return value
  const vat = parseVatAnswer(value)
  if (!vat || vat.exempt) return value
  if (cell?.t === 's' && /%/.test(String(cell.v))) return value
  return vat.rate
}

// Колонка ответа блока анкеты: чаще всего встречающаяся из (1) объединённых ячеек справа от подписи, (2) выпадающих списков,
// (3) колонок, где у строк блока уже стоит число; нет ни того, ни другого — ячейка сразу за подписью.
function answerColumn(ws, rows, validations) {
  const votes = new Map()
  const vote = (c) => votes.set(c, (votes.get(c) || 0) + 1)
  const best = () => [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null
  for (const { r, label } of rows) {
    const m = (ws['!merges'] || []).filter((x) => x.s.r <= r && x.e.r >= r && x.s.c > label.end).sort((a, b) => a.s.c - b.s.c)[0]
    if (m) vote(m.s.c)
  }
  if (votes.size) return best()
  for (const { r, label } of rows) {
    for (const v of validations) if (v.s.r <= r && v.e.r >= r && v.s.c > label.end) vote(v.s.c)
  }
  if (votes.size) return best()
  for (const { r, label } of rows) {
    for (let c = label.end + 1; c <= label.end + 6; c++) if (typeof cellAt(ws, r, c)?.v === 'number') { vote(c); break }
  }
  if (votes.size) return best()
  for (const { label } of rows) vote(label.end + 1)
  return best()
}

// Блок «Квалификационная и контактная информация» → правки ответов. → { edits: [{ r, c, value, field }], headRow } | null.
function formBlockEdits(ws, fields, answers, validations) {
  const range = XLSX.utils.decode_range(ws['!ref'])
  let head = null
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 2000) && !head; r++) {
    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 20); c++) {
      const v = cellAt(ws, r, c)?.v
      if (typeof v === 'string' && FORM_HEAD.test(norm(v))) { head = { r, c }; break }
    }
  }
  if (!head) return null
  const rows = []
  let empty = 0
  for (let r = head.r + 1; r <= Math.min(range.e.r, head.r + 60) && empty < 3; r++) {
    const label = rowLabel(ws, r, range.s.c, Math.min(range.e.c, head.c + 12))
    if (!label) { empty += 1; continue }
    empty = 0
    rows.push({ r, label })
  }
  if (!rows.length) return { edits: [], headRow: head.r }
  const col = answerColumn(ws, rows, validations)
  const edits = []
  for (const { f, i, value } of matchFields(rows.map((x) => ({ label: x.label })), fields, answers, 0.6)) {
    const { r, label } = rows[i]
    let c = col
    const m = mergeAt(ws, r, c)
    if (m && m.s.c !== c) c = m.s.c
    if (c <= label.end || hasFormula(ws, r, c)) continue
    edits.push({ r, c, value: answerValue(f, value, cellAt(ws, r, c)), field: f.id })
  }
  return { edits, headRow: head.r }
}

// Подписи вне блока (над таблицей «КП», «Главный лист» без блока): только точное совпадение и только в пустую ячейку справа.
function formLabelEdits(ws, fields, answers, fromRow, toRow, usedFields) {
  const range = XLSX.utils.decode_range(ws['!ref'])
  const rows = []
  for (let r = Math.max(range.s.r, fromRow); r <= Math.min(range.e.r, toRow); r++) {
    const label = rowLabel(ws, r, range.s.c, Math.min(range.e.c, range.s.c + 8))
    if (label) rows.push({ r, label })
  }
  const free = fields.filter((f) => !usedFields.has(f.id))
  const edits = []
  for (const { f, i, value } of matchFields(rows.map((x) => ({ label: x.label })), free, answers, 0.9)) {
    const { r, label } = rows[i]
    for (let c = label.end + 1; c <= Math.min(range.e.c, label.end + 3); c++) {
      const m = mergeAt(ws, r, c)
      if (m && m.s.c !== c) continue
      const cell = cellAt(ws, r, c)
      if (!isBlank(cell)) break
      if (!cell?.f) edits.push({ r, c, value: answerValue(f, value, cell), field: f.id })
      break
    }
  }
  return edits
}

// ── Книга ────────────────────────────────────────────────────────────────────────────────────────────
// bytes — файл ВОР отдела; rates — Map(ключ позиции → { price, note }) (как в кабинете); fields / answers — анкета (поля и ответы
// по id поля). → { bytes, stats: { prices, notes, answers, skipped } } | { error: ключ FILL_ERROR_TEXT, message? }.
export function fillBidVorBytes(input, { rates = new Map(), fields = [], answers = {} } = {}) {
  const bytes = toBytes(input)
  if (bytes.length > FILL_MAX_BYTES) return { error: 'too_large' }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return { error: 'format' }
  let zip
  let wb
  let names
  try {
    zip = new PizZip(bytes)
    const book = XLSX.read(bytes, { type: 'array', bookSheets: true })
    const hidden = new Set((book.Workbook?.Sheets || []).filter((s) => s.Hidden).map((s) => s.name))
    names = (book.SheetNames || []).filter((n) => !hidden.has(n))
    const s = findBidSheets(names)
    const wanted = s.kp ? [s.materials, s.works, s.kp, s.main].filter(Boolean) : names
    // sheetStubs — чтобы формула без сохранённого результата (файлы из Estimat) была видна как формула и не перезаписывалась.
    wb = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true, cellStyles: false, cellHTML: false, bookVBA: false, sheets: wanted })
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
  const paths = sheetPaths(zip)
  const sheets = findBidSheets(names)
  const edits = new Map() // имя листа → Map(строка с 1 → Map(колонка с 1 → значение))
  const put = (sheet, r, c, value) => {
    if (!edits.has(sheet)) edits.set(sheet, new Map())
    const rows = edits.get(sheet)
    if (!rows.has(r + 1)) rows.set(r + 1, new Map())
    rows.get(r + 1).set(c + 1, value)
  }
  const stats = { prices: 0, notes: 0, answers: 0, skipped: 0, fields: [] }
  const rateOf = (kind, name, unit) => {
    const r = rates.get(bidKey(kind, clean(name), clean(unit)))
    const price = r?.price == null ? null : Number(r.price)
    return price != null && Number.isFinite(price) ? { price, note: clean(r.note) } : null
  }
  let priceTargets = 0
  // Колонки (с 1), результаты формул в которых от цен не зависят и остаются: наименование, ед. изм., объём, расход, код, номер.
  const keepCols = new Map()
  const keepOf = (columns) => new Set(Object.values(columns).filter((c) => c != null).map((c) => c + 1))

  // «Материалы» / «Работы».
  const listed = {}
  for (const [kind, name] of [['material', sheets.materials], ['work', sheets.works]]) {
    const ws = name && wb.Sheets[name]
    if (!ws?.['!ref']) continue
    const det = detectMaterialsColumns(ws)
    if (!det) continue
    keepCols.set(name, keepOf(det.columns))
    const cols = priceColumns(ws, det.headerRow - 1, keepOf(det.columns))
    const priceCol = cols.price[0]?.col
    const { rows } = parseMaterialsSheet(ws, det)
    if (!rows.length) continue
    listed[kind] = true
    if (priceCol == null) continue
    priceTargets += 1
    for (const row of rows) {
      const rate = rateOf(kind, row.name, row.unit)
      if (!rate) continue
      if (hasFormula(ws, row.row - 1, priceCol)) { stats.skipped += 1; continue }
      put(name, row.row - 1, priceCol, rate.price)
      stats.prices += 1
      if (rate.note && cols.note != null && cols.note !== priceCol && !hasFormula(ws, row.row - 1, cols.note)) {
        put(name, row.row - 1, cols.note, rate.note)
        stats.notes += 1
      }
    }
  }

  // «КП»: лист по имени, нет — первый лист с шапкой «КОД» (как у разбора).
  let kpName = sheets.kp && wb.Sheets[sheets.kp] ? sheets.kp : null
  let kpDet = kpName ? detectKpColumns(wb.Sheets[kpName]) : null
  if (!kpDet) {
    kpName = null
    for (const n of names) {
      if (n === sheets.materials || n === sheets.works || n === sheets.main || !wb.Sheets[n]?.['!ref']) continue
      const det = detectKpColumns(wb.Sheets[n])
      if (det) { kpName = n; kpDet = det; break }
    }
  }
  const usedFields = new Set()
  const validationsOf = (sheet) => {
    const path = paths.get(sheet)
    return path && zip.file(path) ? dataValidationRanges(zip.file(path).asText()) : []
  }
  if (kpName) {
    const ws = wb.Sheets[kpName]
    keepCols.set(kpName, keepOf(kpDet.columns))
    const cols = priceColumns(ws, kpDet.headerRow - 1, keepOf(kpDet.columns))
    const generic = cols.price.filter((p) => !p.kind)
    const colFor = (kind) => cols.price.find((p) => p.kind === kind)?.col ?? (generic.length === 1 ? generic[0].col : null)
    const target = { material: colFor('material'), work: colFor('work') }
    for (const kind of ['material', 'work']) if (target[kind] != null && !listed[kind]) priceTargets += 1
    for (const row of parseKpSheet(ws, kpDet).rows) {
      if (row.type !== 'material' && row.type !== 'work') continue
      const col = target[row.type]
      if (col == null || hasFormula(ws, row.row - 1, col)) continue
      const rate = rateOf(row.type, row.name, row.unit)
      if (!rate) continue
      put(kpName, row.row - 1, col, rate.price)
      stats.prices += 1
    }
    // Анкета: блок после таблицы (ВОР прежнего вида) и подписи над таблицей («Наименование контрагента», «ИНН»).
    const block = formBlockEdits(ws, fields, answers, validationsOf(kpName))
    for (const e of block?.edits || []) { put(kpName, e.r, e.c, e.value); usedFields.add(e.field) }
    for (const e of formLabelEdits(ws, fields, answers, 0, kpDet.headerRow - 2, usedFields)) { put(kpName, e.r, e.c, e.value); usedFields.add(e.field) }
  }

  // «Главный лист»: блок анкеты; подписи вне блока — только выше него (ниже — условия и прочий текст отдела).
  const mainWs = sheets.main && wb.Sheets[sheets.main]
  if (mainWs?.['!ref']) {
    const block = formBlockEdits(mainWs, fields, answers, validationsOf(sheets.main))
    for (const e of block?.edits || []) { put(sheets.main, e.r, e.c, e.value); usedFields.add(e.field) }
    const above = block ? block.headRow - 1 : 80
    for (const e of formLabelEdits(mainWs, fields, answers, 0, above, usedFields)) { put(sheets.main, e.r, e.c, e.value); usedFields.add(e.field) }
  }
  stats.answers = usedFields.size
  stats.fields = [...usedFields]

  if (!priceTargets) return { error: 'no_columns' }

  try {
    for (const [sheet, rows] of edits) {
      const path = paths.get(sheet)
      const file = path && zip.file(path)
      if (!file) continue
      const res = patchSheetXml(file.asText(), rows)
      stats.skipped += res.skipped.length
      zip.file(path, res.xml)
    }
    // Результаты формул, зависящих от цен (суммы, цены «КП», итоги, ссылки «Главного листа» на другие листы), убираются — их посчитает
    // программа при открытии; объёмы, расход и наименования (SUMIFS по «КП» и т. п.) от цен не зависят — их результаты остаются, чтобы
    // книга читалась и без пересчёта. Прочие листы книги не трогаются. Excel к тому же пересчитывает книгу целиком (fullCalcOnLoad).
    if (edits.size) {
      const rules = new Map()
      for (const [sheet, keep] of keepCols) rules.set(sheet, ({ col }) => !keep.has(col))
      if (sheets.main && !rules.has(sheets.main)) rules.set(sheets.main, ({ formula }) => formula.includes('!'))
      for (const [sheet, shouldStrip] of rules) {
        const path = paths.get(sheet)
        const file = path && zip.file(path)
        if (!file) continue
        const res = stripFormulaValues(file.asText(), shouldStrip)
        if (res.cleared) zip.file(path, res.xml)
      }
      const wbXml = zip.file('xl/workbook.xml')
      if (wbXml) zip.file('xl/workbook.xml', setFullCalcOnLoad(wbXml.asText()))
    }
    return { bytes: zip.generate({ type: 'uint8array', compression: 'DEFLATE' }), stats }
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
}
