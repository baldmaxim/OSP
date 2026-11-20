// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel»: разбор файла и распознавание (модуль чистый —
// tests/supply/registry-import.test.mjs). Окно — components/rates/SupplyRegistryImportDialog, запись — services/supplyRegistryImport,
// таблицы — миграция 20270224_supply_registry_import.
//
// Файл — как выгрузка этой вкладки (кнопка «Excel»): № п/п, Источник, Объект, Наименование, Ед. изм., Цена, Тендер, Дата
// расценки. Как в «Счетах и КП» расценки снабжения (utils/supplierDoc, supplierDocRead): лист → сетка ячеек, шапку ищем сами
// (не обязательно в первой строке, колонки — по словам, в любом порядке), числа — parseNum («18 450,00», «95 руб.»).
// Обязательны наименование и цена; источника, объекта, тендера и даты может не быть — тогда их задают в окне для всех строк.
//
// Объект пишут как придётся: «18 19 27», «injoy», «king&sons», «Алия», «дом56(не реновация)», «Зил33» (просьба пользователя
// 20.11.2026). Распознаём по словам и числам названия объекта портала (resolveObject): только однозначно — у «ЗИЛ 33»,
// «ЗИЛ 31» и «ЗИЛ 18; 19; 27» разница в одном числе, Primavera — три объекта, у «Дом 56» и «Реновация» один адрес, поэтому
// ни похожести, ни адреса: не нашли один — объект выбирают в окне.
import { cellText, parseNum } from './supplierDoc.js'
import { gridFromSheet } from './supplierDocRead.js'
import { normUnit } from './supplySimilarity.js'
import { normName } from './supplyRateHelpers.js'

export const REGISTRY_IMPORT_ACCEPT = '.xlsx,.xlsm,.xlsb,.xls,.ods,.csv'
export const DEFAULT_SOURCE = 'СУ-10'
// Больше строк за одну загрузку не принимаем (разбор и окно подвисли бы); порция записи — services/supplyRegistryImport.
export const ROWS_MAX = 20000
const HEADER_SCAN_ROWS = 60
const SHEETS_MAX = 12

const SPACES = /[\s\u00a0\u2007\u202f]+/g
const low = (v) => cellText(v).toLowerCase().replace(/ё/g, 'е').replace(SPACES, ' ')

// ── Шапка ────────────────────────────────────────────────────────────────────────────────────────────
// Порядок важен: «Цена за материал, ₽» — цена, а не наименование; «Описание работ (тендер)» — тендер; «Дата расценки» — дата.
const HEADER_RULES = [
  ['num', /^(№|n|no|номер)(\s|$|\.)|п\s*\/\s*п/],
  ['date', /дата/],
  ['price', /цена|стоимост|^руб|₽/],
  ['source', /источник|откуда/],
  ['object', /объект|^жк$/],
  ['tender', /тендер|описание работ/],
  ['unit', /^ед(\.|\s|$)|ед\.?\s*изм|единиц/],
  ['name', /наименован|материал|позици|номенклатур/],
]
export function classifyRegistryHeader(text) {
  const s = low(text)
  if (!s || s.length > 80) return null
  for (const [field, re] of HEADER_RULES) if (re.test(s)) return field
  return null
}

// Строка шапки: есть наименование и цена. Колонка поля — первая подходящая. Ответ: { row, columns: { поле: индекс } } | null.
export function detectRegistryHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, HEADER_SCAN_ROWS); r++) {
    const columns = {}
    ;(grid[r] || []).forEach((v, c) => {
      const field = classifyRegistryHeader(v)
      if (field && columns[field] == null) columns[field] = c
    })
    if (columns.name != null && columns.price != null) return { row: r, columns }
  }
  return null
}

// ── Дата ─────────────────────────────────────────────────────────────────────────────────────────────
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']
const pad = (n) => String(n).padStart(2, '0')
const isoOf = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}
// Ячейка даты → 'ГГГГ-ММ-ДД'; пусто — ''; не дата — null. Excel хранит дату числом дней от 30.12.1899 (так её отдаёт
// библиотека без cellDates), выгрузка реестра — текстом «20.11.2026», CSV — текстом в любом виде.
export function parseRateDate(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date) return isNaN(v.getTime()) ? null : isoOf(v.getFullYear(), v.getMonth() + 1, v.getDate())
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1 || v > 2958465) return null
    const t = new Date(Math.round((Math.floor(v) - 25569) * 86400000))
    return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
  }
  const s = low(v)
  if (!s) return ''
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return isoOf(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/.exec(s)
  if (m) return isoOf(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
  m = /^(\d{1,2})\s+([а-я]+)\s+(\d{4})/.exec(s)
  if (m) {
    const month = MONTHS.findIndex((p) => m[2].startsWith(p))
    if (month >= 0) return isoOf(+m[3], month + 1, +m[1])
  }
  // Одно число без разделителей («45981») — тот же номер дня Excel, только текстом (CSV).
  if (/^\d{5}(\.0+)?$/.test(s)) return parseRateDate(Number(s))
  return null
}

// День по Москве ('ГГГГ-ММ-ДД') для даты реестра (rate_date — полночь дня расценки по Москве).
const MSK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' })
export const moscowDay = (iso) => {
  const d = iso instanceof Date ? iso : new Date(iso)
  return isNaN(d.getTime()) ? '' : MSK_DAY.format(d)
}

// ── Строки файла ─────────────────────────────────────────────────────────────────────────────────────
const TOTAL_RE = /^(итого|итог|всего)(\s|$|:)/
// Сетка листа → строки: { sheet, rowNo (строка листа, с 1), source, object, name, unit, price (число | null), priceText,
// tender, date ('ГГГГ-ММ-ДД' | '' | null), dateText }.
export function registryGridRows(grid, header, sheet = '') {
  const { row, columns: c } = header
  const out = []
  const at = (cells, field) => (c[field] == null ? '' : cells[c[field]])
  for (let r = row + 1; r < grid.length; r++) {
    const cells = grid[r] || []
    const name = cellText(at(cells, 'name'))
    const priceCell = at(cells, 'price')
    const rest = ['source', 'object', 'unit', 'tender', 'date'].some((f) => cellText(at(cells, f)))
    if (!name && (priceCell === '' || priceCell == null) && !rest) continue
    if (TOTAL_RE.test(low(name)) || (!name && TOTAL_RE.test(low(cells.find((v) => cellText(v)) ?? '')))) continue
    const dateCell = at(cells, 'date')
    out.push({
      sheet,
      rowNo: r + 1,
      source: cellText(at(cells, 'source')),
      object: cellText(at(cells, 'object')),
      name,
      unit: cellText(at(cells, 'unit')),
      price: parseNum(priceCell),
      priceText: cellText(priceCell),
      tender: cellText(at(cells, 'tender')),
      date: parseRateDate(dateCell),
      dateText: cellText(dateCell),
    })
  }
  return out
}

// Книга → строки всех видимых листов с шапкой. Ответ: { rows, sheetName, columns } | { error: 'no_table' | 'empty' | 'too_many' }.
export function parseRegistryWorkbook(XLSX, wb) {
  const names = wb.SheetNames || []
  const hidden = wb.Workbook?.Sheets || []
  const visible = names.filter((_, i) => !hidden[i]?.Hidden)
  const rows = []
  const used = []
  let columns = null
  let anyHeader = false
  for (const name of (visible.length ? visible : names).slice(0, SHEETS_MAX)) {
    const grid = gridFromSheet(XLSX, wb.Sheets[name])
    const header = detectRegistryHeader(grid)
    if (!header) continue
    anyHeader = true
    const part = registryGridRows(grid, header, name)
    if (!part.length) continue
    used.push(name)
    columns = { ...header.columns, ...(columns || {}) }
    rows.push(...part)
    if (rows.length > ROWS_MAX) return { error: 'too_many', count: rows.length }
  }
  if (!rows.length) return { error: anyHeader ? 'empty' : 'no_table' }
  return { rows, sheetName: used.join(', '), columns }
}

export const PARSE_ERROR_TEXT = {
  no_table: 'Не нашли шапку таблицы: нужны колонки «Наименование» и «Цена» (как в выгрузке реестра кнопкой «Excel»).',
  empty: 'Шапка есть, а строк под ней нет.',
  too_many: `Слишком много строк — за один раз не больше ${ROWS_MAX.toLocaleString('ru-RU')}. Разделите файл.`,
  broken: 'Файл не читается — это точно Excel или CSV?',
}

// ── Объект ───────────────────────────────────────────────────────────────────────────────────────────
const OBJECT_STOP = new Set(['жк', 'жилой', 'комплекс', 'объект', 'ооо', 'ао'])
// Одно и то же латиницей и кириллицей — с обеих сторон к одному написанию.
const OBJECT_ALIAS = {
  примавера: 'primavera', приммавера: 'primavera', инджой: 'injoy', инжой: 'injoy', кинг: 'king', сонс: 'sons', санс: 'sons',
  сторис: 'stories', вейв: 'wave', уэйв: 'wave', вэйв: 'wave', сити: 'city', бей: 'bay', бэй: 'bay', топхиллс: 'tophills',
  дискавери: 'discovery', лайф: 'life', life: 'life', and: '', энд: '',
}
// Однобуквенное латиницей — как кириллицей: «k14» = «к14».
const LETTER_LAT = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }

function tokensOf(text) {
  const out = new Set()
  for (let t of low(text).normalize('NFC').match(/[a-z]+|[а-я]+|\d+/g) || []) {
    if (/^\d+$/.test(t)) t = String(Number(t))
    if (t.length === 1 && LETTER_LAT[t]) t = LETTER_LAT[t]
    if (OBJECT_ALIAS[t] !== undefined) t = OBJECT_ALIAS[t]
    if (t && !OBJECT_STOP.has(t)) out.add(t)
  }
  return out
}
// «дом56(не реновация)», «Дом 56, не реновация» — то, чем объект НЕ является: убрать из названия и исключить объекты с этими словами.
const NEGATION_RE = /\(\s*не\s+([^)]*)\)|(?:^|[\s,;])не\s+([^,;()]+)/gi
export function objectLabelTokens(label) {
  const exclude = new Set()
  const rest = String(label || '').replace(NEGATION_RE, (_, a, b) => {
    for (const t of tokensOf(a || b)) exclude.add(t)
    return ' '
  })
  return { tokens: tokensOf(rest), exclude }
}

// Объекты портала → для распознавания (слова названия считаются один раз).
export const objectIndex = (objects) => (objects || [])
  .map((o) => ({ id: o.id, name: o.name, tokens: tokensOf(o.name) }))
  .filter((o) => o.tokens.size)

const subset = (a, b) => [...a].every((t) => b.has(t))
const sameSet = (a, b) => a.size === b.size && subset(a, b)

// Название из файла → { status: 'found' | 'many' | 'none' | 'empty', object, candidates }. Только однозначно:
//  1) все слова и числа из файла есть в названии объекта («Зил33» → «ЖК ЗИЛ 33», «18 19 27» → «ЖК ЗИЛ 18; 19; 27»); таких
//     несколько — тот, у кого в названии ровно эти слова, иначе выбор в окне («primavera» — три объекта);
//  2) иначе все слова названия объекта есть в файле (в файле длиннее: «ЖК Primavera к14 корпус 22»).
export function resolveObject(label, index) {
  const { tokens, exclude } = objectLabelTokens(label)
  if (!tokens.size) return { status: 'empty', object: null, candidates: [] }
  const pool = index.filter((o) => ![...exclude].some((t) => o.tokens.has(t)))
  const wide = pool.filter((o) => subset(tokens, o.tokens))
  if (wide.length === 1) return { status: 'found', object: wide[0], candidates: wide }
  if (wide.length > 1) {
    const exact = wide.filter((o) => sameSet(tokens, o.tokens))
    if (exact.length === 1) return { status: 'found', object: exact[0], candidates: wide }
    return { status: 'many', object: null, candidates: wide }
  }
  const narrow = pool.filter((o) => subset(o.tokens, tokens))
  if (narrow.length === 1) return { status: 'found', object: narrow[0], candidates: narrow }
  return { status: narrow.length ? 'many' : 'none', object: null, candidates: narrow }
}

// ── Разово: «Primavera» без корпуса = ЖК Primavera к14 ────────────────────────────────────────────────
// Просьба пользователя 20.11.2026: в первом загружаемом файле «primavera» — это к14, но так будет не всегда. Правило
// предлагается, пока нет загрузки с options.primavera = 'k14' (её пишет окно); потом его нет, и «primavera» выбирают в
// окне, как любой неоднозначный объект. Пользователь уберёт правило сам — весь этот блок и строки с PRIMAVERA_ONCE в окне.
export const PRIMAVERA_ONCE = { key: 'primavera', value: 'k14' }
export const primaveraOnceUsed = (imports) => (imports || []).some((i) => i?.options?.[PRIMAVERA_ONCE.key] === PRIMAVERA_ONCE.value)
export const isBarePrimavera = (label) => sameSet(objectLabelTokens(label).tokens, new Set(['primavera']))
export function primaveraK14(index) {
  const hit = index.filter((o) => subset(new Set(['primavera', 'к', '14']), o.tokens))
  return hit.length === 1 ? hit[0] : null
}

// ── Тендер ───────────────────────────────────────────────────────────────────────────────────────────
// Вся ячейка — «№ 1157», «тендер 1157» или одно число — номер тендера (у тендера другого объекта, чем у строки, — не он);
// иначе описание работ: то же описание у одного тендера (на объекте строки, если он распознан); у основного тендера и
// тендера на материалы описание одно — берём основной (расценка снабжения — его). «№» внутри описания («корпус № 2») —
// не номер тендера. Не нашли один — тендер остаётся текстом из файла, без ссылки.
const TENDER_NUMBER_RE = /^(?:тендер\s*)?№?\s*(\d{1,7})$/
export function resolveTender(label, tenders, objectId = null) {
  const text = cellText(label)
  if (!text) return null
  const num = TENDER_NUMBER_RE.exec(low(text))
  if (num) {
    const byNum = (tenders || []).filter((t) => Number(t.public_tender_number) === Number(num[1]))
    return byNum.length === 1 && (!objectId || !byNum[0].object_id || byNum[0].object_id === objectId) ? byNum[0] : null
  }
  const key = normName(text)
  if (!key) return null
  let same = (tenders || []).filter((t) => t.work_description && normName(t.work_description) === key)
  if (objectId) same = same.filter((t) => t.object_id === objectId)
  if (same.length > 1) {
    const main = same.filter((t) => t.tender_type !== 'materials')
    if (main.length === 1) return main[0]
  }
  return same.length === 1 ? same[0] : null
}

// ── Повторы ──────────────────────────────────────────────────────────────────────────────────────────
// kp_norm_name базы — ключ уникального индекса загруженных строк; здесь — та же нормализация для показа «уже в реестре».
export const kpNormName = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/²/g, '2').replace(/³/g, '3')
  .replace(/[acepxyo]/g, (ch) => ({ a: 'а', c: 'с', e: 'е', p: 'р', x: 'х', y: 'у', o: 'о' })[ch])
  .replace(/[«»"'`()]/g, '')
  .replace(/[\s.]+/g, ' ')
  .trim()
// Та же расценка: наименование, ед. изм., цена (копейки), день, объект. Источник не входит: выгрузка реестра обратно
// («СУ-10» — цены с сайта) не должна добавить их второй раз.
export const rateKey = ({ name, unit, price, day, objectId }) =>
  `${kpNormName(name)}|${normUnit(unit)}|${Number(price).toFixed(2)}|${day}|${objectId || ''}`
export const registryRowKey = (r) =>
  rateKey({ name: r.item_name, unit: r.unit, price: r.price, day: moscowDay(r.rate_date), objectId: r.object_id })

// ── Итог для окна и записи ───────────────────────────────────────────────────────────────────────────
// rows — из parseRegistryWorkbook; ctx: { index (objectIndex), tenders, existing (Set ключей реестра), choices (Map название
// объекта → id | '' — без объекта; нет — как распознано), primaveraOnce (применить разовое правило), defaults: { source,
// date }, today ('ГГГГ-ММ-ДД' по Москве) }.
// Ответ: { lines, labels, counts }. lines — строки с итогом: status 'ok' (к загрузке) | 'exists' (уже в реестре) | 'dup' (повтор
// в файле) | 'error' (problem — что не так). labels — названия объектов из файла: { label, count, resolution, objectId, auto }.
export function prepareRegistryImport(rows, ctx) {
  const { index = [], tenders = [], existing = new Set(), choices = new Map(), primaveraOnce = false, defaults = {}, today } = ctx
  const k14 = primaveraOnce ? primaveraK14(index) : null
  const labels = new Map()
  for (const r of rows) {
    const label = r.object
    if (!labels.has(label)) {
      const resolution = resolveObject(label, index)
      let auto = resolution.object?.id || ''
      let once = false
      if (!auto && k14 && isBarePrimavera(label)) {
        auto = k14.id
        once = true
      }
      const chosen = choices.has(label) ? choices.get(label) : auto
      labels.set(label, { label, count: 0, resolution, auto, once, objectId: chosen || '' })
    }
    labels.get(label).count++
  }
  const seen = new Set()
  const counts = { total: rows.length, ok: 0, exists: 0, dup: 0, error: 0 }
  const lines = rows.map((r) => {
    const objectId = labels.get(r.object).objectId || null
    const source = r.source || cellText(defaults.source) || DEFAULT_SOURCE
    const day = r.date === '' ? (defaults.date || '') : r.date
    const tender = resolveTender(r.tender, tenders, objectId)
    const line = { ...r, objectId, sourceName: source, day, tenderId: tender?.id || null, tenderNumber: tender?.public_tender_number ?? null }
    let problem = ''
    if (!r.name) problem = 'нет наименования'
    else if (r.price == null) problem = r.priceText ? `цена не число: «${r.priceText}»` : 'нет цены'
    else if (!(r.price > 0)) problem = 'цена не больше нуля'
    else if (r.price >= 1e12) problem = 'цена слишком большая'
    else if (r.date === null) problem = `дата не распознана: «${r.dateText}»`
    else if (!day) problem = 'нет даты'
    else if (day < '2000-01-01') problem = 'дата раньше 2000 года'
    else if (today && day > today) problem = 'дата из будущего'
    if (problem) {
      counts.error++
      return { ...line, status: 'error', problem }
    }
    const price = Math.round(r.price * 100) / 100
    const key = rateKey({ name: r.name, unit: r.unit, price, day, objectId })
    if (existing.has(key)) {
      counts.exists++
      return { ...line, price, status: 'exists' }
    }
    const fileKey = `${key}|${source.toLowerCase()}`
    if (seen.has(fileKey)) {
      counts.dup++
      return { ...line, price, status: 'dup' }
    }
    seen.add(fileKey)
    counts.ok++
    return { ...line, price, status: 'ok' }
  })
  return { lines, labels: [...labels.values()], counts }
}

// Строка для записи (supply_registry_import): только то, что идёт в базу.
export const importPayload = (l) => ({
  source_name: l.sourceName,
  item_name: l.name,
  unit: l.unit || null,
  price: l.price,
  object_id: l.objectId || null,
  object_label: l.object || null,
  tender_id: l.tenderId || null,
  tender_label: l.tender || null,
  rate_date: l.day,
  row_no: l.rowNo,
})
