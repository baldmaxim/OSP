// ДГП объекта (вкладка «Смета» карточки объекта): файлы единого ПСДЦ договора генподряда.
//
// Единый ПСДЦ собирают по-разному, и строгих видов у него нет:
//  • одна таблица, строка на позицию со статусом, основанием и прежней ценой (ЖК STORIES);
//  • позиции с ресурсами КП, частями НДС 20 % / 22 % и историей цен (Корпус 14, итоги и «действующая
//    редакция» — в самом конце листа);
//  • несколько таблиц на одном листе: контроль цены, хронология ДС, разбивка с ценами материалов и работ,
//    основные материалы, справочные приложения (ALIA).
// Поэтому вид не выбирается: из файла читается «паспорт» — заголовок, договор, какие ДС учтены, цена
// договора — и состав (что есть в таблицах). Всё — по словам подписей и шапок, а не по номерам строк и
// колонок: шапок на листе может быть несколько, цена — в первой строке или под заголовком, редакция — в
// подзаголовке, в примечаниях внизу листа или только в имени файла.

// Новые файлы — в одной категории. dgp_compact / dgp_full — файлы, загруженные, пока было два вида:
// показываются в том же списке, переносить их не нужно.
export const DGP_CATEGORY = 'dgp'
export const DGP_CATEGORIES = [DGP_CATEGORY, 'dgp_compact', 'dgp_full']

// Сколько файлов можно выбрать за раз.
export const DGP_MAX_FILES = 10

// Книгу больше этого размера читаем только сверху (разбор целиком подвешивает страницу на секунды):
// паспорт почти всегда в начале листа, без примечаний внизу теряется разве что «действующая редакция».
export const DGP_FULL_READ_BYTES = 12 * 1024 * 1024
export const DGP_TOP_ROWS = 300

// Сверху листа — заголовок, подзаголовок, контроль цены; дальше — таблицы.
const TOP_ROWS = 60

export const DGP_FEATURES = [
  { key: 'history', label: 'история изменений по ДС', hint: 'прежние цены, изменения, статус или редакция позиции' },
  { key: 'matWork', label: 'материалы и работы отдельно', hint: 'цены или суммы материалов и работ в своих колонках' },
  { key: 'resources', label: 'ресурсы КП', hint: 'расшифровка позиций ресурсами коммерческого предложения' },
  { key: 'mainMaterials', label: 'основные материалы', hint: 'основные материалы и оборудование, коэффициенты расхода' },
  { key: 'vatSplit', label: 'НДС 20 % и 22 %', hint: 'цена разделена по ставкам НДС' },
]
const FEATURE_KEYS = new Set(DGP_FEATURES.map(f => f.key))

const norm = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[\u00a0\u2007\u202f]/g, ' ')
  .replace(/\s*\/\s*/g, ' / ')
  .replace(/\s+/g, ' ')
  .trim()

const clean = (v) => String(v ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim()

// Число из ячейки: само число или текст из одних цифр («5 932 993 892,39», «15 783 711 735,72 ₽»).
// Текст с буквами числом не считается: «Цена в тексте ДС №10» — не сумма 10.
export function cellNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v ?? '').replace(/[\s\u00a0\u2007\u202f₽]/g, '').replace(/[−–]/g, '-')
  if (!/^-?\d+(?:[.,]\d+)?$/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Разные непустые значения строки (объединённые ячейки бывают записаны в каждую клетку объединения).
function rowValues(row) {
  const out = []
  for (const c of row || []) {
    if (c === '' || c == null) continue
    if (!out.includes(c)) out.push(c)
  }
  return out
}

// Строка-надпись: один текст на всю строку (заголовок, подзаголовок, примечание, название раздела).
function rowNote(row) {
  const vals = rowValues(row)
  return vals.length === 1 && typeof vals[0] === 'string' && clean(vals[0]).length >= 3 ? clean(vals[0]) : ''
}

// Слова шапки таблицы. Шапка — строка, где не меньше четырёх таких подписей и есть наименование или код.
const COLUMN_WORDS = [/^№/, /^код/, /^раздел/, /^подраздел/, /^наименование/, /^работа$/, /^ед\.? ?изм/,
  /^количество/, /^кол-во/, /^объ[её]м/, /^цена/, /^стоимость/, /^сумма/, /^изменени/, /^статус/, /^основание/,
  /^редакция/, /^источник/, /^прежн/, /^δ/, /^тип строки/, /^комментарий/, /^примечание/]
const KEY_COLUMN = /^(наименование|работа$|код|№)/

function headerCells(row) {
  const vals = rowValues(row)
  // В шапке чисел нет (номер колонки — бывает один); строки данных отсекаются, не доходя до разбора текста.
  if (vals.filter(c => typeof c === 'number').length > 1) return null
  const cells = []
  let words = 0
  let key = false
  for (const c of vals) {
    if (typeof c !== 'string') continue
    const n = norm(c)
    if (!n || n.length > 60) continue
    cells.push(n)
    if (COLUMN_WORDS.some(re => re.test(n))) words++
    if (KEY_COLUMN.test(n)) key = true
  }
  return words >= 4 && key ? cells : null
}

// Подписи цены договора — по старшинству. Сумма — первое число правее подписи в той же строке.
// «По фильтру», «КП · справочно», «без НДС» ценой договора не считаются.
const PRICE_LABELS = [
  { re: /^актуальная цена договора/, label: 'Актуальная цена договора' },
  { re: /^цена договора,? с ндс/, label: 'Цена договора с НДС' },
  { re: /^договорный итог/, label: 'Договорный итог' },
  { re: /^(итого )?псдц(,? ₽)?$/, label: 'ПСДЦ' },
  { re: /^цена договора(?!.*без ндс)/, label: 'Цена договора' },
]
// Быстрая проверка до разбора текста: в листе десятки тысяч ячеек, подписи цены — единицы.
const PRICE_HINT = /цена|итог|псдц/i

const rankBefore = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

function findPrice(rows, topEnd) {
  let best = null
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || []
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] !== 'string' || !PRICE_HINT.test(row[c])) continue
      const n = norm(row[c])
      if (!n || n.length > 80) continue
      const p = PRICE_LABELS.findIndex(l => l.re.test(n))
      if (p < 0) continue
      let value = null
      for (let k = c + 1; k < row.length && value == null; k++) value = cellNumber(row[k])
      if (value == null) continue
      // Верх листа важнее итогов внизу, внутри — старшая подпись, затем первая по порядку.
      const rank = [r < topEnd ? 0 : 1, p, r]
      if (!best || rankBefore(rank, best.rank)) best = { rank, total: value, totalLabel: PRICE_LABELS[p].label }
      break
    }
  }
  return best ? { total: best.total, totalLabel: best.totalLabel } : { total: null, totalLabel: '' }
}

// ДС, учтённые в файле: «ДС №1–8», «с учётом ДС №1–10», «(ДС 1-14)». Дата после номера («ДС №4 · 01.10.2025»,
// «ДС №4 - 01.10.2025») — не диапазон.
// «ДС» — отдельным словом: в «средств 1-2» его нет.
const DS_RANGE = /(?<![а-яёa-z])дс\s*(?:№\s*)*(\d{1,3})\s*[-–—]\s*(?:дс\s*)?(?:№\s*)*(\d{1,3})(?![\d.,])/i
// По какому ДС действует цена: «действующая редакция ДС №8», «Основание актуальной цены: ДС №8».
const DS_CURRENT = /(?:действующ\S*\s+редакци\S*|основание актуальной цены)\s*[:\-–—]?\s*дс\s*№?\s*(\d{1,3})(?!\d)/i
const DS_SINGLE = /(?:редакци\S*|с уч[её]том)\s+(?:с уч[её]том\s+)?дс\s*№?\s*(\d{1,3})(?![\d\s]*[-–—]\s*\d)/i

export function dgpRevisionFromText(text) {
  const s = String(text || '')
  const m = DS_RANGE.exec(s)
  if (m) {
    const from = Number(m[1])
    const to = Number(m[2])
    if (to >= from) return { from, to }
  }
  const one = DS_SINGLE.exec(s)
  return one ? { from: null, to: Number(one[1]) } : null
}

export function dgpRevisionLabel(rev) {
  if (!rev?.to) return ''
  return rev.from != null && rev.from !== rev.to ? `ДС №${rev.from}–${rev.to}` : `ДС №${rev.to}`
}

// «Договор генерального строительного подряда № ДГСП-13АВ от 07.02.2025», «ДОГОВОР №165/9/2024»,
// «договор №К14 от 25.04.2025».
const CONTRACT = /договор\S*(?:\s+[а-яё]+){0,4}\s*№\s*([^\s,;·|()]+)(?:\s+от\s+(\d{1,2}\.\d{1,2}\.\d{2,4}))?/i

export function dgpContractFromText(text) {
  const m = CONTRACT.exec(String(text || ''))
  if (!m) return null
  const number = m[1].replace(/[.,;:]+$/, '')
  return number ? { number, date: m[2] || '' } : null
}

// Ключ договора для сравнения файлов: регистр, пробелы, латиница вместо похожей кириллицы («K14» = «К14»).
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }
export const dgpContractKey = (number) => norm(number).replace(/\s+/g, '').replace(/[a-z]/g, ch => LOOKALIKE[ch] || ch)

/**
 * Паспорт единого ПСДЦ по строкам листа (массив строк, как sheet_to_json с header: 1).
 * @returns {{ title, subtitle, contract: {number,date}|null, revision: {from,to}|null, priceBasis: number|null,
 *            total: number|null, totalLabel: string, features: string[], recognized: boolean }}
 */
export function analyzeDgp(rows, fileName = '') {
  rows = rows || []
  // Шапки таблиц по всему листу: у ALIA их несколько, у полного ДГП — одна во второй строке.
  const headers = []
  let firstHeader = -1
  for (let r = 0; r < rows.length; r++) {
    const cells = headerCells(rows[r])
    if (!cells) continue
    headers.push(...cells)
    if (firstHeader < 0) firstHeader = r
  }
  const topEnd = Math.min(firstHeader >= 0 ? firstHeader : rows.length, TOP_ROWS)

  // Заголовок — первая непустая строка, подзаголовок — следующая надпись над первой шапкой.
  let title = ''
  let subtitle = ''
  let titleRow = -1
  for (let r = 0; r < Math.min(rows.length, TOP_ROWS); r++) {
    const vals = rowValues(rows[r])
    const text = vals.find(v => typeof v === 'string' && clean(v))
    if (!text) continue
    title = clean(text)
    titleRow = r
    break
  }
  for (let r = titleRow + 1; titleRow >= 0 && r < topEnd; r++) {
    if (!rowValues(rows[r]).length) continue
    const note = rowNote(rows[r])
    if (note && !PRICE_LABELS.some(l => l.re.test(norm(note)))) subtitle = note
    break
  }

  // Надписи листа: сверху (заголовок, подзаголовок, пояснения) и остальные — названия разделов, примечания внизу.
  const topNotes = []
  const otherNotes = []
  for (let r = 0; r < rows.length; r++) {
    const note = r === titleRow ? title : rowNote(rows[r])
    if (note) (r < topEnd ? topNotes : otherNotes).push(note)
  }

  const findIn = (texts, fn) => { for (const t of texts) { const v = fn(t); if (v) return v } return null }
  const contract = findIn(topNotes, dgpContractFromText) || findIn(otherNotes, dgpContractFromText)
  const revision = findIn(topNotes, dgpRevisionFromText) || dgpRevisionFromText(fileName)
    || findIn(otherNotes, dgpRevisionFromText)
  const basisText = [...topNotes, ...otherNotes].find(t => DS_CURRENT.test(t))
  const basis = basisText ? Number(DS_CURRENT.exec(basisText)[1]) : null
  const priceBasis = basis != null && basis !== revision?.to ? basis : null

  const { total, totalLabel } = findPrice(rows, topEnd)

  // Состав — по шапкам; история и основные материалы — ещё и по надписям («с историей изменений»,
  // «3.3 | Основные материалы»); ставки НДС — по коротким подписям верха листа.
  const notes = [...topNotes, ...otherNotes].map(norm)
  const topCells = []
  for (let r = 0; r < Math.min(rows.length, TOP_ROWS); r++) {
    for (const c of rowValues(rows[r])) if (typeof c === 'string' && c.length <= 80) topCells.push(norm(c))
  }
  const some = (list, re) => list.some(t => re.test(t))
  const features = []
  if (some(headers, /^(прежн|изменени|δ|статус$|редакция)/) || some(notes, /истори\S* изменени|хронологи/)) features.push('history')
  if (some(headers, /^(цена|сумма|стоимость) (материал|работ)|^(материалы|работы) (кп|за ед)|^базовая цена (мат|работ)/)) features.push('matWork')
  if (some(headers, /^uid кп|^вид ресурса|^норма расхода/)) features.push('resources')
  if (some(headers, /^основн\S* материал|^коэф\S* осн/) || some(notes, /основн\S* материал/)) features.push('mainMaterials')
  if (some(topCells, /(^|\D)20 ?%/) && some(topCells, /(^|\D)22 ?%/)) features.push('vatSplit')

  const recognized = total != null || features.length > 0 || /псдц/.test(norm(title)) || some(notes, /псдц/)
  return { title, subtitle, contract, revision, priceBasis, total, totalLabel, features, recognized }
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

/** Прочитать файл ДГП (ArrayBuffer) — паспорт и состав. Не Excel — ошибка с понятным текстом. */
export async function readDgpWorkbook(buffer, fileName = '') {
  if (!isExcelBytes(buffer)) throw new Error('файл не читается как книга Excel')
  const XLSX = await import('xlsx')
  let wb
  try {
    // dense — строки массивами: у полного ДГП (16 тыс. строк, 36 колонок) чтение вдвое быстрее.
    wb = XLSX.read(buffer, {
      type: 'array',
      dense: true,
      cellFormula: false,
      cellHTML: false,
      ...(buffer.byteLength > DGP_FULL_READ_BYTES ? { sheetRows: DGP_TOP_ROWS } : {}),
    })
  } catch {
    throw new Error('файл не читается как книга Excel')
  }
  const ws = pickSheet(wb)
  if (!ws) throw new Error('в книге нет листов')
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
  return analyzeDgp(rows, fileName)
}

// Паспорт хранится в s3_documents.notes (JSON): чтобы показать его, файл не скачивается.
export function dgpNotes(info) {
  return JSON.stringify({
    v: 2,
    title: info.title || '',
    subtitle: info.subtitle || '',
    contract: info.contract || null,
    revision: info.revision || null,
    priceBasis: info.priceBasis ?? null,
    total: info.total ?? null,
    totalLabel: info.totalLabel || '',
    features: (info.features || []).filter(k => FEATURE_KEYS.has(k)),
    recognized: !!info.recognized,
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

// Паспорт загруженного файла. У файлов, загруженных раньше (notes v1: заголовок и сумма), редакция — из
// имени файла, состава нет.
export function describeDgpDoc(doc) {
  const d = parseDgpNotes(doc?.notes) || {}
  return {
    title: d.title || '',
    subtitle: d.subtitle || '',
    contract: d.contract?.number ? d.contract : null,
    revision: d.revision?.to ? d.revision : dgpRevisionFromText(doc?.file_name),
    priceBasis: d.priceBasis ?? null,
    total: typeof d.total === 'number' ? d.total : null,
    totalLabel: d.totalLabel || '',
    features: Array.isArray(d.features) ? d.features.filter(k => FEATURE_KEYS.has(k)) : [],
  }
}

/**
 * Порядок списка: действующие сверху (новые загрузки — первыми), под ними прежние редакции. Прежняя — файл того
 * же договора, у которого учтено меньше ДС, чем у другого загруженного. Без номера договора или ДС — не сравнивается.
 * @returns {Array<{ doc, info, newer: object|null }>} newer — паспорт более новой редакции.
 */
export function orderDgpDocs(docs) {
  const items = (docs || []).map(doc => ({ doc, info: describeDgpDoc(doc), newer: null }))
  for (const item of items) {
    const key = item.info.contract ? dgpContractKey(item.info.contract.number) : ''
    const to = item.info.revision?.to
    if (!key || !to) continue
    for (const other of items) {
      if (other === item || !other.info.contract || dgpContractKey(other.info.contract.number) !== key) continue
      if ((other.info.revision?.to || 0) > (item.newer?.revision?.to || to)) item.newer = other.info
    }
  }
  const time = (d) => Date.parse(d.created_at || '') || 0
  return items.sort((a, b) => (!!a.newer - !!b.newer) || time(b.doc) - time(a.doc))
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

/** Какие загруженные файлы заменит новый: с тем же именем (прежняя выгрузка того же файла). */
export function dgpReplaced(fileName, docs) {
  return (docs || []).filter(d => sameName(d.file_name, fileName))
}
