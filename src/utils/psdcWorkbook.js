// ПСДЦ / ВОР: работа с однолистовым XLSX.
//
// Здесь НЕТ финансовой логики. Модуль:
//   • безопасно открывает книгу (лимиты архива, защита от zip-бомб и XML-сущностей);
//   • находит лист ведомости и отдаёт СЫРЫЕ значения ячеек A:U — разбор чисел,
//     проверку структуры и весь расчёт выполняет база (supabase/migrations/20260908_psdc.sql);
//   • строит копию исходного файла с подсвеченными ошибочными ячейками;
//   • собирает XLSX для экспорта из уже рассчитанных базой строк: формулы пишутся
//     для удобства человека, кэш ячеек — значения системы.
//
// Модуль не зависит от Supabase и браузерного окружения — его используют и тесты.
import * as XLSXNs from 'xlsx'
import XLSXStyleNs from 'xlsx-js-style'
import PizZipNs from 'pizzip'

const XLSX = XLSXNs.read ? XLSXNs : XLSXNs.default
const XLSXStyle = XLSXStyleNs.utils ? XLSXStyleNs : XLSXStyleNs.default
const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default

export const PSDC_SHEET_NAME = 'Ведомость объёмов работ'

export const PSDC_HEADERS = [
  '№ п/п', 'Тип ресурса', 'Шифр', 'Давальческий материал', 'Статья затрат', 'Наименование работы',
  'Ед. изм.', 'Норма расхода', 'Объём', 'Цена за материал', 'Стоимость за материал', 'Цена за работу',
  'Стоимость за работу', 'Единичная расценка', 'Общая стоимость', 'Завод-изготовитель',
  'Применяемые материалы', 'Место проведения работ', 'Комментарий', 'ID строки в системе',
]

export const PSDC_LIMITS = {
  fileBytes: 30 * 1024 * 1024,          // сам XLSX
  entries: 3000,                        // файлов внутри архива
  entryBytes: 200 * 1024 * 1024,        // один распакованный файл архива
  totalBytes: 400 * 1024 * 1024,        // весь архив в распакованном виде
  sharedStringsBytes: 100 * 1024 * 1024,
  rows: 25000,                          // строк ведомости (тот же предел в базе, psdc_add_rows)
}

const COLS = 'ABCDEFGHIJKLMNOPQRSTU'.split('')
const COMPUTED_COLS = new Set(['K', 'M', 'N', 'O'])
const SECTION = 'Секция'
const PROCESS = 'Комплексный процесс'
const ERR_TEXT = 'Ошибка в цене\\объёме'

export class PsdcFileError extends Error {}

const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input))

// Точное десятичное представление числа ячейки. Кратчайшая запись JS однозначно
// восстанавливает двоичное значение Excel и не несёт «хвостов» вида 0.30000000000000004.
export function exactNumberString(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Object.is(value, -0) ? '0' : String(value)
}

const normText = (value) => String(value ?? '')
  .replace(/ё/g, 'е').replace(/Ё/g, 'Е')
  .replace(/[\s\u00A0\u2007\u202F]+/g, ' ')
  .trim()
  .toLowerCase()

// ── 1. Безопасность архива ─────────────────────────────────────────────────

async function inflatedSize(data, method, declared, scanXml) {
  if (method === 0) {
    if (scanXml && /<!(DOCTYPE|ENTITY)/i.test(new TextDecoder().decode(data))) {
      throw new PsdcFileError('Книга содержит XML-объявления сущностей — такой файл не принимается')
    }
    return data.length
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const decoder = scanXml ? new TextDecoder() : null
  let total = 0
  let tail = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > declared || total > PSDC_LIMITS.entryBytes) {
        throw new PsdcFileError('Архив XLSX повреждён или распаковывается в недопустимо большой объём')
      }
      if (decoder) {
        const chunk = tail + decoder.decode(value, { stream: true })
        if (/<!(DOCTYPE|ENTITY)/i.test(chunk)) {
          throw new PsdcFileError('Книга содержит XML-объявления сущностей — такой файл не принимается')
        }
        tail = chunk.slice(-16)
      }
    }
  } catch (e) {
    try { await reader.cancel() } catch { /* поток уже закрыт */ }
    if (e instanceof PsdcFileError) throw e
    throw new PsdcFileError('Архив XLSX повреждён')
  }
  return total
}

// Проверяет архив ДО разбора книги: заявленные размеры по центральному каталогу
// и фактические — потоковой распаковкой с остановкой при превышении. После
// проверки распаковка внутри XLSX-парсера заведомо ограничена.
export async function inspectXlsxArchive(input) {
  const bytes = toBytes(input)
  if (bytes.length > PSDC_LIMITS.fileBytes) {
    throw new PsdcFileError(`Файл больше ${Math.round(PSDC_LIMITS.fileBytes / 1024 / 1024)} МБ`)
  }
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new PsdcFileError('Файл не является книгой XLSX (старый .xls или книга, защищённая паролем, не принимаются)')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (o) => dv.getUint16(o, true)
  const u32 = (o) => dv.getUint32(o, true)

  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new PsdcFileError('Архив XLSX повреждён')
  const count = u16(eocd + 10)
  const cdSize = u32(eocd + 12)
  const cdOffset = u32(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PsdcFileError('Архив XLSX в формате ZIP64 не поддерживается')
  }
  if (count > PSDC_LIMITS.entries) throw new PsdcFileError('В архиве XLSX слишком много файлов')
  if (cdOffset + cdSize > bytes.length) throw new PsdcFileError('Архив XLSX повреждён')

  const names = new TextDecoder()
  const entries = []
  let total = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(p) !== 0x02014b50) throw new PsdcFileError('Архив XLSX повреждён')
    const flags = u16(p + 8)
    const method = u16(p + 10)
    const csize = u32(p + 20)
    const usize = u32(p + 24)
    const nameLen = u16(p + 28)
    const extraLen = u16(p + 30)
    const commentLen = u16(p + 32)
    const offset = u32(p + 42)
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    if (flags & 1) throw new PsdcFileError('Книга защищена паролем')
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
      throw new PsdcFileError('Архив XLSX в формате ZIP64 не поддерживается')
    }
    if (method !== 0 && method !== 8) throw new PsdcFileError('Неподдерживаемое сжатие внутри XLSX')
    if (usize > PSDC_LIMITS.entryBytes) throw new PsdcFileError('Файл внутри XLSX слишком велик')
    if (/sharedStrings\.xml$/i.test(name) && usize > PSDC_LIMITS.sharedStringsBytes) {
      throw new PsdcFileError('Таблица строк книги слишком велика')
    }
    total += usize
    if (total > PSDC_LIMITS.totalBytes) throw new PsdcFileError('XLSX распаковывается в недопустимо большой объём')
    entries.push({ name, method, csize, usize, offset })
    p += 46 + nameLen + extraLen + commentLen
  }

  for (const e of entries) {
    if (e.offset + 30 > bytes.length || u32(e.offset) !== 0x04034b50) throw new PsdcFileError('Архив XLSX повреждён')
    const start = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28)
    if (start + e.csize > bytes.length) throw new PsdcFileError('Архив XLSX повреждён')
    const scanXml = /\.(xml|rels|vml)$/i.test(e.name)
    const actual = await inflatedSize(bytes.subarray(start, start + e.csize), e.method, e.usize, scanXml)
    if (actual !== e.usize) throw new PsdcFileError('Архив XLSX повреждён')
  }
  return { entries: entries.length, uncompressedBytes: total }
}

// ── 2. Чтение ведомости ────────────────────────────────────────────────────

function cellText(cell) {
  if (!cell) return ''
  if (cell.w != null) return String(cell.w)
  if (cell.v == null) return ''
  return String(cell.v)
}

function headerOf(ws) {
  return PSDC_HEADERS.map((_, i) => cellText(ws[`${COLS[i]}1`]))
}

function headerMatches(ws) {
  const header = headerOf(ws)
  return PSDC_HEADERS.every((h, i) => normText(header[i]) === normText(h))
}

export function pickPsdcSheet(wb) {
  const canonical = normText(PSDC_SHEET_NAME)
  const exact = wb.SheetNames.find((name) => normText(name) === canonical)
  if (exact) return { name: exact }
  const byHeader = wb.SheetNames.filter((name) => wb.Sheets[name] && headerMatches(wb.Sheets[name]))
  if (byHeader.length === 1) return { name: byHeader[0] }
  if (byHeader.length > 1) {
    return { error: `В книге несколько листов с шапкой ведомости (${byHeader.join(', ')}) — лист не определяется однозначно` }
  }
  return { error: `Не найден лист «${PSDC_SHEET_NAME}» и нет листа с шапкой ведомости A:T` }
}

// Сырое значение ячейки в том виде, в каком его принимает база.
function serializeCell(cell) {
  if (!cell) return null
  const out = {}
  if (cell.f) out.f = 1
  switch (cell.t) {
    case 'n': {
      const v = exactNumberString(cell.v)
      if (v == null) return null
      out.t = 'n'
      out.v = v
      if (cell.w != null) out.w = String(cell.w)
      break
    }
    case 'b':
      out.t = 'b'
      out.v = cell.v ? 'TRUE' : 'FALSE'
      break
    case 'e':
      out.t = 'e'
      out.v = String(cell.w ?? '#ERROR')
      break
    case 'd':
      out.t = 's'
      out.v = String(cell.w ?? cell.v)
      break
    case 'z':
      if (!out.f) return null
      out.t = 'z'
      out.v = ''
      break
    default:
      out.t = 's'
      out.v = String(cell.v ?? '')
  }
  if (out.v === '' && !out.f) return null
  return out
}

function hasValue(cell) {
  if (!cell) return false
  if (cell.t === 'e') return true
  if (cell.v == null) return false
  return typeof cell.v !== 'string' || cell.v.trim() !== ''
}

// Полностью пустая строка: нет значений в исходных столбцах. Формулы K/M/N/O без
// исходных данных (типичный заготовленный шаблон до 500-й строки) строку не
// делают содержательной.
function rowHasContent(row) {
  return COLS.some((col) => !COMPUTED_COLS.has(col) && hasValue(row[col]))
}

function rowTexts(row) {
  return COLS.slice(0, 10).map((col) => normText(cellText(row[col]))).filter(Boolean)
}

const fatalResult = (message) => ({ fatal: [message], sheetName: null, hasU: false, header: [], rows: [], totals: {} })

export async function readPsdcWorkbook(input) {
  const bytes = toBytes(input)
  try {
    await inspectXlsxArchive(bytes)
  } catch (e) {
    if (e instanceof PsdcFileError) return fatalResult(e.message)
    throw e
  }

  let wb
  try {
    // Формулы читаются как текст и не вычисляются; макросы и лишние части книги не грузим.
    wb = XLSX.read(bytes, {
      type: 'array', cellFormula: true, cellHTML: false, cellNF: false, cellStyles: false,
      cellDates: false, bookVBA: false, bookFiles: false, sheetStubs: false,
    })
  } catch {
    return fatalResult('Не удалось прочитать книгу XLSX')
  }

  const pick = pickPsdcSheet(wb)
  if (pick.error) return fatalResult(pick.error)
  const ws = wb.Sheets[pick.name]

  const byRow = new Map()
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue
    const addr = XLSX.utils.decode_cell(key)
    if (addr.c > 20) continue
    let target = byRow.get(addr.r)
    if (!target) {
      target = {}
      byRow.set(addr.r, target)
    }
    target[COLS[addr.c]] = ws[key]
  }

  const header = headerOf(ws)
  const order = [...byRow.keys()].filter((r) => r > 0).sort((a, b) => a - b)
  const rows = []
  const totals = {}
  let hasU = hasValue(byRow.get(0)?.U)

  for (let idx = 0; idx < order.length; idx++) {
    const r = order[idx]
    const source = byRow.get(r)
    if (!rowHasContent(source)) continue
    const texts = rowTexts(source)

    // Итоговые строки старого файла распознаются по содержанию, не по номеру строки.
    if (texts.some((t) => t.startsWith('итого по всей ведомости'))) {
      totals.row = r + 1
      for (const col of ['K', 'M', 'O']) {
        const c = serializeCell(source[col])
        if (c) totals[col.toLowerCase()] = c
      }
      for (let next = idx + 1; next < order.length; next++) {
        const nextRow = byRow.get(order[next])
        if (!rowHasContent(nextRow)) continue
        const vat = rowTexts(nextRow).find((t) => t.includes('в том числе ндс'))
        if (vat) {
          totals.vat_text = vat
          totals.vat_row = order[next] + 1
        }
        break
      }
      break
    }
    if (texts.some((t) => t.startsWith('в том числе ндс'))) {
      totals.vat_text = texts.find((t) => t.startsWith('в том числе ндс'))
      totals.vat_row = r + 1
      break
    }

    if (rows.length >= PSDC_LIMITS.rows) {
      return fatalResult(`В ведомости больше ${PSDC_LIMITS.rows} строк`)
    }
    const cells = {}
    for (const col of COLS) {
      const c = serializeCell(source[col])
      if (c) cells[col] = c
    }
    if (cells.U) hasU = true
    rows.push({ r: r + 1, c: cells })
  }

  return { fatal: [], sheetName: pick.name, hasU, header, rows, totals }
}

// ── 3. Копия исходного файла с подсветкой ошибок ───────────────────────────
//
// Та же книга: те же листы, шапка, строки и значения. Меняются только стили
// ошибочных ячеек (светло-красная заливка). Никаких новых столбцов, листов,
// комментариев и примечаний.

const ERROR_FILL = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>'

const xmlDecode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? xmlDecode(m[1]) : null
}

function setAttr(tag, name, value) {
  const re = new RegExp(`\\s${name}="[^"]*"`)
  if (re.test(tag)) return tag.replace(re, ` ${name}="${value}"`)
  return tag.replace(/^(<[\w:]+)/, `$1 ${name}="${value}"`)
}

function colIndex(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

function resolveSheetPath(zip, sheetName) {
  const workbook = zip.file('xl/workbook.xml')?.asText()
  const rels = zip.file('xl/_rels/workbook.xml.rels')?.asText()
  if (!workbook || !rels) return null
  let relId = null
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    if (attr(m[0], 'name') === sheetName) {
      const idMatch = /\s[\w]+:id="([^"]*)"/.exec(m[0])
      relId = idMatch ? idMatch[1] : null
      break
    }
  }
  if (!relId) return null
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    if (attr(m[0], 'Id') === relId) {
      const target = attr(m[0], 'Target') || ''
      return target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/')
    }
  }
  return null
}

function prepareStyles(zip) {
  const path = 'xl/styles.xml'
  const xml = zip.file(path)?.asText()
  if (!xml) throw new Error('В книге нет таблицы стилей')
  const fillsMatch = /<((?:\w+:)?)fills\b([^>]*)>([\s\S]*?)<\/\1fills>/.exec(xml)
  const xfsMatch = /<((?:\w+:)?)cellXfs\b([^>]*)>([\s\S]*?)<\/\1cellXfs>/.exec(xml)
  if (!fillsMatch || !xfsMatch) throw new Error('Не удалось разобрать стили книги')

  const prefix = fillsMatch[1]
  const fillCount = (fillsMatch[3].match(new RegExp(`<${prefix}fill[\\s>/]`, 'g')) || []).length
  const fill = prefix ? ERROR_FILL.replace(/<(\/?)(\w)/g, `<$1${prefix}$2`) : ERROR_FILL
  const xfPrefix = xfsMatch[1]
  const xfs = xfsMatch[3].match(new RegExp(`<${xfPrefix}xf\\b[^>]*/>|<${xfPrefix}xf\\b[^>]*>[\\s\\S]*?</${xfPrefix}xf>`, 'g')) || []

  const added = []
  const map = new Map()
  const styleFor = (base) => {
    const idx = Number.isInteger(base) && base >= 0 && base < xfs.length ? base : 0
    if (map.has(idx)) return map.get(idx)
    const source = xfs[idx] || `<${xfPrefix}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    const open = /^<[^>]*?\/?>/.exec(source)[0]
    let tag = setAttr(open.replace(/\/?>$/, ''), 'fillId', String(fillCount))
    tag = setAttr(tag, 'applyFill', '1')
    const cloned = source.replace(open, tag + (open.endsWith('/>') ? '/>' : '>'))
    const newIndex = xfs.length + added.length
    added.push(cloned)
    map.set(idx, newIndex)
    return newIndex
  }

  const finish = () => {
    let out = xml.replace(fillsMatch[0], `<${prefix}fills${setAttr(`<x${fillsMatch[2]}`, 'count', String(fillCount + 1)).slice(2)}>${fillsMatch[3]}${fill}</${prefix}fills>`)
    const xfsNow = /<((?:\w+:)?)cellXfs\b([^>]*)>([\s\S]*?)<\/\1cellXfs>/.exec(out)
    out = out.replace(xfsNow[0], `<${xfPrefix}cellXfs${setAttr(`<x${xfsNow[2]}`, 'count', String(xfs.length + added.length)).slice(2)}>${xfsNow[3]}${added.join('')}</${xfPrefix}cellXfs>`)
    zip.file(path, out)
  }
  return { styleFor, finish }
}

// issues: [{ excel_row, cell }]; ячейка «I15» — подсветить ячейку, только строка — A:T строки.
export function buildErrorCopy(input, sheetName, issues) {
  const zip = new PizZip(toBytes(input))
  const sheetPath = resolveSheetPath(zip, sheetName)
  const sheetFile = sheetPath && zip.file(sheetPath)
  if (!sheetFile) throw new Error('Не найден лист ведомости в исходном файле')

  const targets = new Map() // row → Set(col)
  for (const issue of issues || []) {
    const m = /^([A-U])(\d+)$/.exec(issue.cell || '')
    if (m) {
      const r = Number(m[2])
      if (!targets.has(r)) targets.set(r, new Set())
      targets.get(r).add(m[1])
    } else if (issue.excel_row) {
      const r = Number(issue.excel_row)
      if (!targets.has(r)) targets.set(r, new Set())
      COLS.slice(0, 20).forEach((c) => targets.get(r).add(c))
    }
  }
  if (targets.size === 0) return zip.generate({ type: 'uint8array', compression: 'DEFLATE' })

  const styles = prepareStyles(zip)
  let xml = sheetFile.asText()
  const seenRows = new Set()

  xml = xml.replace(/<((?:\w+:)?)row\b([^>]*?)(\/>|>([\s\S]*?)<\/\1row>)/g, (whole, prefix, attrs, _tail, inner) => {
    const rowNum = Number(attr(`<row${attrs}>`, 'r'))
    if (!rowNum || !targets.has(rowNum)) return whole
    seenRows.add(rowNum)
    const wanted = targets.get(rowNum)
    const rowStyle = Number(attr(`<row${attrs}>`, 's'))
    const found = new Set()
    const cells = []
    let rest = inner || ''
    rest = rest.replace(new RegExp(`<${prefix}c\\b([^>]*?)(/>|>([\\s\\S]*?)</${prefix}c>)`, 'g'), (cellXml, cAttrs) => {
      const ref = attr(`<c${cAttrs}>`, 'r') || ''
      const col = (/^([A-Z]+)/.exec(ref) || [])[1]
      let out = cellXml
      if (col && wanted.has(col)) {
        found.add(col)
        const base = Number(attr(`<c${cAttrs}>`, 's'))
        const open = /^<[^>]*?\/?>/.exec(cellXml)[0]
        const closing = open.endsWith('/>') ? '/>' : '>'
        const tag = setAttr(open.slice(0, -closing.length), 's', String(styles.styleFor(Number.isFinite(base) ? base : 0)))
        out = cellXml.replace(open, tag + closing)
      }
      cells.push({ col: col ? colIndex(col) : Number.MAX_SAFE_INTEGER, xml: out })
      return ''
    })
    for (const col of wanted) {
      if (found.has(col)) continue
      const s = styles.styleFor(Number.isFinite(rowStyle) ? rowStyle : 0)
      cells.push({ col: colIndex(col), xml: `<${prefix}c r="${col}${rowNum}" s="${s}"/>` })
    }
    cells.sort((a, b) => a.col - b.col)
    const rowAttrs = attrs.replace(/\sspans="[^"]*"/, '')
    return `<${prefix}row${rowAttrs}>${cells.map((c) => c.xml).join('')}${rest}</${prefix}row>`
  })

  const missing = [...targets.keys()].filter((r) => !seenRows.has(r)).sort((a, b) => a - b)
  if (missing.length) {
    const sdMatch = /<((?:\w+:)?)sheetData\b[^>]*?(\/>|>)/.exec(xml)
    if (sdMatch) {
      const prefix = sdMatch[1]
      const build = (r) => {
        const s = styles.styleFor(0)
        const cells = [...targets.get(r)].sort((a, b) => colIndex(a) - colIndex(b))
          .map((col) => `<${prefix}c r="${col}${r}" s="${s}"/>`).join('')
        return `<${prefix}row r="${r}">${cells}</${prefix}row>`
      }
      if (sdMatch[2] === '/>') {
        xml = xml.replace(sdMatch[0], `<${prefix}sheetData>${missing.map(build).join('')}</${prefix}sheetData>`)
      } else {
        for (const r of missing) {
          let inserted = false
          xml = xml.replace(new RegExp(`<${prefix}row\\b[^>]*\\sr="(\\d+)"`, 'g'), (m, num) => {
            if (!inserted && Number(num) > r) {
              inserted = true
              return build(r) + m
            }
            return m
          })
          if (!inserted) xml = xml.replace(`</${prefix}sheetData>`, `${build(r)}</${prefix}sheetData>`)
        }
      }
    }
  }

  zip.file(sheetPath, xml)
  styles.finish()
  return zip.generate({ type: 'uint8array', compression: 'DEFLATE' })
}

// ── 4. Экспорт ─────────────────────────────────────────────────────────────

const BORDER = { style: 'thin', color: { rgb: 'FFD0D5DD' } }
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER }
const FMT_MONEY = '#,##0.00'
const FMT_VOLUME = '#,##0.00000'
const FMT_NORM = '#,##0.00'

const STYLE = {
  header: { font: { bold: true }, fill: { fgColor: { rgb: 'FFE8ECF2' } }, alignment: { wrapText: true, vertical: 'center', horizontal: 'center' }, border: BORDERS },
  text: { alignment: { vertical: 'top', wrapText: true }, border: BORDERS },
  number: { alignment: { vertical: 'top' }, border: BORDERS },
  sectionText: { font: { bold: true }, fill: { fgColor: { rgb: 'FFF3F5F9' } }, alignment: { vertical: 'top', wrapText: true }, border: BORDERS },
  sectionNumber: { font: { bold: true }, fill: { fgColor: { rgb: 'FFF3F5F9' } }, alignment: { vertical: 'top' }, border: BORDERS },
  total: { font: { bold: true }, border: BORDERS },
  deleted: { font: { color: { rgb: 'FF98A2B3' } }, alignment: { vertical: 'top', wrapText: true }, border: BORDERS },
}

// Пользовательский текст всегда пишется строковой ячейкой: «=…», «+…», «-…»,
// «@…» остаются текстом и не превращаются в формулу.
const textCell = (value, s = STYLE.text) => (value == null || value === '' ? { t: 's', v: '', s } : { t: 's', v: String(value), s })
const numberCell = (value, z, s = STYLE.number) => (value == null || value === '' ? { t: 's', v: '', s } : { t: 'n', v: Number(value), z, s })
const formulaCell = (f, cached, z, s = STYLE.number) => ({ t: 'n', f, v: cached == null ? 0 : Number(cached), z, s })

const rateLabel = (rate) => String(rate).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')

// rows — строки из psdc_get_rows (числа текстом), psdc — сведения ПСДЦ (итоги текстом).
export function buildPsdcWorkbook({ rows = [], psdc = {} }) {
  const ws = {}
  const put = (col, r, c) => { ws[`${col}${r}`] = c }
  const hasU = rows.some((row) => row.legacy_deleted)
  const first = 2
  const last = Math.max(first, rows.length + 1)
  const range = (col) => `$${col}$${first}:$${col}$${last}`
  const uCrit = hasU ? `,${range('U')},"<>deleted"` : ''

  PSDC_HEADERS.forEach((h, i) => put(COLS[i], 1, { t: 's', v: h, s: STYLE.header }))

  rows.forEach((row, idx) => {
    const r = idx + 2
    const isSection = row.row_kind === 'section'
    const deleted = !!row.legacy_deleted
    const ts = deleted ? STYLE.deleted : (isSection ? STYLE.sectionText : STYLE.text)
    const ns = deleted ? STYLE.deleted : (isSection ? STYLE.sectionNumber : STYLE.number)

    put('A', r, textCell(row.number, ts))
    put('B', r, textCell(row.row_kind === 'section' ? SECTION : row.row_kind === 'process' ? PROCESS : row.resource_type, ts))
    put('C', r, textCell(row.code, ts))
    put('D', r, textCell(row.is_customer_material ? 'ДМ' : row.customer_material, ts))
    put('E', r, textCell(row.cost_item, ts))
    put('F', r, textCell(row.name, ts))
    put('G', r, textCell(row.unit, ts))
    put('P', r, textCell(row.manufacturer, ts))
    put('Q', r, textCell(row.materials, ts))
    put('R', r, textCell(row.work_location, ts))
    put('S', r, textCell(row.comment, ts))
    put('T', r, textCell(row.logical_line_id, ts))
    if (hasU) put('U', r, textCell(deleted ? 'deleted' : '', ts))

    if (isSection) {
      for (const col of ['H', 'I', 'J', 'L', 'N']) put(col, r, textCell('', ns))
      if (deleted) {
        for (const col of ['K', 'M', 'O']) put(col, r, textCell('', ns))
      } else {
        put('K', r, formulaCell(`IFERROR(ROUND(SUMIFS(${range('K')},${range('A')},A${r}&".*",${range('B')},"${PROCESS}",${range('D')},"<>ДМ"${uCrit}),2),"${ERR_TEXT}")`, row.material_cost, FMT_MONEY, ns))
        put('M', r, formulaCell(`IFERROR(ROUND(SUMIFS(${range('M')},${range('A')},A${r}&".*",${range('B')},"${PROCESS}"${uCrit}),2),"${ERR_TEXT}")`, row.work_cost, FMT_MONEY, ns))
        put('O', r, formulaCell(`IFERROR(ROUND(K${r}+M${r},2),"${ERR_TEXT}")`, row.total_cost, FMT_MONEY, ns))
      }
      return
    }

    put('H', r, numberCell(row.consumption_norm, FMT_NORM, ns))
    put('I', r, numberCell(row.volume, FMT_VOLUME, ns))
    put('J', r, numberCell(row.material_price, FMT_MONEY, ns))
    put('L', r, numberCell(row.work_price, FMT_MONEY, ns))
    if (deleted || row.row_kind !== 'process') {
      for (const col of ['K', 'M', 'N', 'O']) put(col, r, textCell('', ns))
      return
    }
    put('K', r, formulaCell(`IFERROR(ROUND(ROUND(I${r},5)*ROUND(J${r},2),2),"${ERR_TEXT}")`, row.material_cost, FMT_MONEY, ns))
    put('M', r, formulaCell(`IFERROR(ROUND(ROUND(I${r},5)*ROUND(L${r},2),2),"${ERR_TEXT}")`, row.work_cost, FMT_MONEY, ns))
    put('N', r, formulaCell(`IFERROR(ROUND(ROUND(J${r},2)+ROUND(L${r},2),2),"${ERR_TEXT}")`, row.unit_price, FMT_MONEY, ns))
    put('O', r, formulaCell(`IFERROR(IF(D${r}="ДМ",ROUND(M${r},2),ROUND(K${r}+M${r},2)),"${ERR_TEXT}")`, row.total_cost, FMT_MONEY, ns))
  })

  const t = rows.length + 2
  const vr = t + 1
  put('A', t, textCell('', STYLE.total))
  put('B', t, textCell('Итого по всей ведомости, руб.', STYLE.total))
  put('C', t, textCell('', STYLE.total))
  put('K', t, formulaCell(`IFERROR(ROUND(SUMIFS(${range('K')},${range('B')},"${PROCESS}",${range('D')},"<>ДМ"${uCrit}),2),"${ERR_TEXT}")`, psdc.total_material, FMT_MONEY, STYLE.total))
  put('M', t, formulaCell(`IFERROR(ROUND(SUMIFS(${range('M')},${range('B')},"${PROCESS}"${uCrit}),2),"${ERR_TEXT}")`, psdc.total_work, FMT_MONEY, STYLE.total))
  put('O', t, formulaCell(`IFERROR(ROUND(K${t}+M${t},2),"${ERR_TEXT}")`, psdc.total, FMT_MONEY, STYLE.total))

  const rate = psdc.vat_rate != null && Number(psdc.vat_rate) > 0 && psdc.vat_included !== false ? rateLabel(psdc.vat_rate) : null
  put('B', vr, textCell(rate ? `в том числе НДС ${rate}%` : 'в том числе НДС', STYLE.total))
  put('C', vr, textCell('', STYLE.total))
  put('O', vr, rate
    ? formulaCell(`IFERROR(ROUND(O${t}*${rate}/(100+${rate}),2),"${ERR_TEXT}")`, psdc.vat_amount, FMT_MONEY, STYLE.total)
    : numberCell('0', FMT_MONEY, STYLE.total))

  ws['!ref'] = `A1:${hasU ? 'U' : 'T'}${vr}`
  ws['!merges'] = [
    { s: { r: t - 1, c: 1 }, e: { r: t - 1, c: 2 } },
    { s: { r: vr - 1, c: 1 }, e: { r: vr - 1, c: 2 } },
  ]
  ws['!cols'] = [
    { wch: 9 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 48 }, { wch: 9 }, { wch: 12 },
    { wch: 14 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 18 }, { wch: 20 },
    { wch: 24 }, { wch: 22 }, { wch: 28 }, { wch: 38, hidden: true },
    ...(hasU ? [{ wch: 10, hidden: true }] : []),
  ]
  ws['!rows'] = [{ hpt: 36 }]

  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, ws, PSDC_SHEET_NAME)
  return XLSXStyle.write(wb, { type: 'array', bookType: 'xlsx' })
}

// Шаблон для ручного заполнения: шапка A:T и заготовленные формулы на 499 строк,
// итоговые строки после них. Формулы — те же правила, что у системы (ДМ исключает
// только материал). Сам шаблон ничего не считает для системы: при импорте
// значения K/M/N/O и итогов игнорируются.
export function buildPsdcTemplate(lastRow = 500) {
  const ws = {}
  const put = (ref, c) => { ws[ref] = c }
  PSDC_HEADERS.forEach((h, i) => put(`${COLS[i]}1`, { t: 's', v: h, s: STYLE.header }))
  const R = (col) => `$${col}$2:$${col}$${lastRow}`
  for (let r = 2; r <= lastRow; r++) {
    put(`K${r}`, { t: 's', v: '', f: `IF(B${r}="${PROCESS}",IFERROR(ROUND(ROUND(I${r},5)*ROUND(J${r},2),2),""),IF(B${r}="${SECTION}",IFERROR(ROUND(SUMIFS(${R('K')},${R('A')},A${r}&".*",${R('B')},"${PROCESS}",${R('D')},"<>ДМ"),2),""),""))`, z: FMT_MONEY })
    put(`M${r}`, { t: 's', v: '', f: `IF(B${r}="${PROCESS}",IFERROR(ROUND(ROUND(I${r},5)*ROUND(L${r},2),2),""),IF(B${r}="${SECTION}",IFERROR(ROUND(SUMIFS(${R('M')},${R('A')},A${r}&".*",${R('B')},"${PROCESS}"),2),""),""))`, z: FMT_MONEY })
    put(`N${r}`, { t: 's', v: '', f: `IF(B${r}="${PROCESS}",IFERROR(ROUND(ROUND(J${r},2)+ROUND(L${r},2),2),""),"")`, z: FMT_MONEY })
    put(`O${r}`, { t: 's', v: '', f: `IF(B${r}="${PROCESS}",IFERROR(ROUND(IF(D${r}="ДМ",M${r},K${r}+M${r}),2),""),IF(B${r}="${SECTION}",IFERROR(ROUND(K${r}+M${r},2),""),""))`, z: FMT_MONEY })
  }
  const t = lastRow + 2
  put(`B${t}`, { t: 's', v: 'Итого по всей ведомости, руб.', s: STYLE.total })
  put(`K${t}`, { t: 'n', v: 0, f: `IFERROR(ROUND(SUMIFS(${R('K')},${R('B')},"${PROCESS}",${R('D')},"<>ДМ"),2),"${ERR_TEXT}")`, z: FMT_MONEY, s: STYLE.total })
  put(`M${t}`, { t: 'n', v: 0, f: `IFERROR(ROUND(SUMIFS(${R('M')},${R('B')},"${PROCESS}"),2),"${ERR_TEXT}")`, z: FMT_MONEY, s: STYLE.total })
  put(`O${t}`, { t: 'n', v: 0, f: `IFERROR(ROUND(K${t}+M${t},2),"${ERR_TEXT}")`, z: FMT_MONEY, s: STYLE.total })
  put(`B${t + 1}`, { t: 's', v: 'в том числе НДС', s: STYLE.total })
  ws['!ref'] = `A1:T${t + 1}`
  ws['!merges'] = [{ s: { r: t - 1, c: 1 }, e: { r: t - 1, c: 2 } }, { s: { r: t, c: 1 }, e: { r: t, c: 2 } }]
  ws['!cols'] = [
    { wch: 9 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 48 }, { wch: 9 }, { wch: 12 },
    { wch: 14 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 18 }, { wch: 20 },
    { wch: 24 }, { wch: 22 }, { wch: 28 }, { wch: 38, hidden: true },
  ]
  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, ws, PSDC_SHEET_NAME)
  return XLSXStyle.write(wb, { type: 'array', bookType: 'xlsx' })
}

// ── 5. Отображение значений из базы без двоичного float ────────────────────

// «1234567.8» → «1 234 567,80». Значение приходит из базы уже округлённым.
export function formatDecimal(value, scale = 2) {
  if (value == null || value === '') return ''
  let s = String(value).trim()
  const neg = s.startsWith('-')
  if (neg || s.startsWith('+')) s = s.slice(1)
  const [intRaw, fracRaw = ''] = s.split('.')
  const frac = (fracRaw + '0'.repeat(scale)).slice(0, scale)
  const int = (intRaw.replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')
  const isZero = !/[1-9]/.test(int + frac)
  return `${neg && !isZero ? '−' : ''}${int}${scale ? `,${frac}` : ''}`
}
