// ДГП объекта (вкладка «Смета» карточки объекта): единый ПСДЦ договора генподряда в двух видах.
//
//  • Комплектный — одна строка на позицию: «№ позиции», «Период / НДС», «Цена за ед.», «Прежн.»,
//    «Актуально», «Изменение», «Статус», «Основание», «Дата основания»; над шапкой — «Актуальная цена
//    договора».
//  • Полный — позиции с разбивкой на ресурсы КП: «Подраздел», «Код позиции», «Материалы КП», «Работы КП»,
//    «Связь с ПСДЦ», «UID КП», «Вид ресурса», «Норма расхода», «Базовая цена…»; в первой строке — «ПСДЦ, ₽».
//
// Вид определяется по шапке таблицы: колонки, которые есть только у одного вида, набирают ему очки.
// Читаются только первые строки листа (sheetRows) — у полного ДГП тысячи строк и десятки колонок,
// а вид, заголовок и сумма договора есть в самом начале.

export const DGP_KINDS = [
  { kind: 'compact', category: 'dgp_compact', label: 'Комплектный', hint: 'одна строка на позицию: статус, основание, изменение цены' },
  { kind: 'full', category: 'dgp_full', label: 'Полный', hint: 'позиции с ресурсами КП: материалы, работы, нормы расхода' },
]
export const DGP_BY_KIND = Object.fromEntries(DGP_KINDS.map(k => [k.kind, k]))
export const DGP_CATEGORIES = DGP_KINDS.map(k => k.category)
export const dgpKindOfCategory = (category) => DGP_KINDS.find(k => k.category === category)?.kind || null

// Сколько строк листа читать: шапка у обоих видов — в первых двух десятках строк.
export const DGP_SCAN_ROWS = 60

const norm = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[\u00a0\u2007\u202f]/g, ' ')
  .replace(/\s*\/\s*/g, ' / ')
  .replace(/\s+/g, ' ')
  .trim()

// Колонки, которые есть только у своего вида.
const COMPACT_MARKERS = ['№ позиции', 'период / ндс', 'актуально', 'статус', 'дата основания',
  'что фактически изменилось', 'в итог фильтра', 'подраздел / место работ']
const FULL_MARKERS = ['код позиции', 'материалы кп', 'работы кп', 'материалы за ед', 'работы за ед',
  'связь с псдц', 'проверка источника', 'в итог кп', 'uid кп', 'вид ресурса', 'норма расхода',
  'базовый объем', 'базовая цена', 'прямые затраты', 'производитель']

// Число из ячейки: само число или текст из одних цифр («5 932 993 892,39», «15 783 711 735,72 ₽»).
// Текст с буквами числом не считается: «Цена в тексте ДС №10» — не сумма 10.
export function cellNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v ?? '').replace(/[\s\u00a0\u2007\u202f₽]/g, '').replace(/[−–]/g, '-')
  if (!/^-?\d+(?:[.,]\d+)?$/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const firstText = (row) => (row || []).map(c => String(c ?? '').trim()).find(Boolean) || ''

// Первое число правее ячейки с подписью (подпись — начало текста ячейки).
function numberAfter(rows, label, maxRow) {
  for (let r = 0; r < Math.min(rows.length, maxRow); r++) {
    const row = rows[r] || []
    for (let c = 0; c < row.length; c++) {
      if (!norm(row[c]).startsWith(label)) continue
      for (let k = c + 1; k < row.length; k++) {
        const n = cellNumber(row[k])
        if (n != null) return n
      }
    }
  }
  return null
}

// Шапка таблицы: строка, где есть и «Раздел», и «Наименование…».
function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, DGP_SCAN_ROWS); r++) {
    const cells = (rows[r] || []).map(norm)
    if (cells.some(c => c === 'раздел') && cells.some(c => c.startsWith('наименование'))) return r
  }
  return -1
}

/**
 * Вид ДГП и сводка по первым строкам листа (массив строк, как sheet_to_json с header: 1).
 * @returns {{ kind: 'compact'|'full'|null, title: string, subtitle: string, total: number|null,
 *            totalLabel: string, headerRow: number, scores: { compact: number, full: number } }}
 */
export function detectDgp(rows) {
  const headerRow = findHeaderRow(rows)
  const header = headerRow >= 0 ? (rows[headerRow] || []).map(norm).filter(Boolean) : []
  const score = (markers) => markers.filter(m => header.some(h => h.startsWith(m))).length
  const scores = { compact: score(COMPACT_MARKERS), full: score(FULL_MARKERS) }
  let kind = null
  if (scores.full >= 2 && scores.full > scores.compact) kind = 'full'
  else if (scores.compact >= 2 && scores.compact > scores.full) kind = 'compact'

  const title = firstText(rows[0])
  // Подзаголовок комплектного: «Редакция с учётом ДС №1–10 · один лист · 2 438 конечных позиций…».
  const second = firstText(rows[1])
  const subtitle = headerRow > 1 && second && !norm(second).startsWith('актуальная') ? second : ''

  const limit = headerRow >= 0 ? headerRow : Math.min(rows.length, 20)
  let total = null
  let totalLabel = ''
  if (kind !== 'full') {
    total = numberAfter(rows, 'актуальная цена договора', limit)
    if (total != null) totalLabel = 'Актуальная цена договора'
  }
  if (total == null && kind !== 'compact') {
    // У полного подпись «ПСДЦ, ₽» — в той же строке, что заголовок; «КП · справочно» правее не берём.
    total = numberAfter(rows, 'псдц', Math.max(limit, 1))
    if (total != null) totalLabel = 'ПСДЦ'
  }
  return { kind, title, subtitle, total, totalLabel, headerRow, scores }
}

// Лист с ПСДЦ: по имени («Единый ПСДЦ»), иначе первый.
function pickSheet(wb) {
  const name = wb.SheetNames.find(n => /псдц/i.test(n)) || wb.SheetNames[0]
  return name ? wb.Sheets[name] : null
}

// Книга Excel по первым байтам: .xlsx / .xlsm — архив ZIP («PK»), .xls — составной документ (D0 CF 11 E0).
// Без проверки SheetJS читал бы любой текст как таблицу из одной колонки.
function isExcelBytes(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4))
  if (b.length < 4) return false
  return (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)
}

/** Прочитать файл ДГП (ArrayBuffer) — вид, заголовок, сумма. Не Excel — ошибка с понятным текстом. */
export async function readDgpWorkbook(buffer) {
  if (!isExcelBytes(buffer)) throw new Error('файл не читается как книга Excel')
  const XLSX = await import('xlsx')
  let wb
  try {
    wb = XLSX.read(buffer, { type: 'array', sheetRows: DGP_SCAN_ROWS, cellFormula: false, cellHTML: false })
  } catch {
    throw new Error('файл не читается как книга Excel')
  }
  const ws = pickSheet(wb)
  if (!ws) throw new Error('в книге нет листов')
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
  return detectDgp(rows)
}

// Сводка хранится в s3_documents.notes (JSON): чтобы показать заголовок и сумму, файл не скачивается.
export function dgpNotes(info) {
  return JSON.stringify({
    v: 1,
    title: info.title || '',
    subtitle: info.subtitle || '',
    total: info.total ?? null,
    totalLabel: info.totalLabel || '',
    detected: !!info.detected,
  })
}

export function parseDgpNotes(notes) {
  if (!notes) return null
  try {
    const d = JSON.parse(notes)
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
}

/**
 * Куда положить выбранные файлы. files — [{ name, kind }] (kind — определённый вид или null).
 * Возвращает { assign: [kind…] по порядку файлов, ok }: ok = false, если вид не определился,
 * два файла одного вида или файлов больше двух — тогда человек выбирает вид сам.
 */
export function planDgpUpload(files) {
  if (files.length > DGP_KINDS.length) return { assign: files.map(f => f.kind), ok: false }
  const assign = files.map(f => f.kind)
  // Не определился один из двух, а второй определился — неизвестному достаётся оставшийся вид.
  if (files.length === 2 && assign.filter(Boolean).length === 1) {
    const known = assign.find(Boolean)
    const other = DGP_KINDS.find(k => k.kind !== known).kind
    return { assign: assign.map(k => k || other), ok: false }
  }
  const ok = assign.every(Boolean) && new Set(assign).size === assign.length
  return { assign, ok }
}
