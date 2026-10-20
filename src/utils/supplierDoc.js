// Документ поставщика (счёт на оплату, КП, УПД, прайс) → строки { name, code, unit, qty, price, sum } для расценки
// снабжением. Только разбор, без чтения файла: таблица Excel приходит сеткой ячеек (supplierDocRead → gridFromSheet),
// PDF — словами с координатами (pdf.js). Модуль чистый — tests/supply/supplier-doc.test.mjs.
//
// Шапку ищем сами: строка (или 2–4 строки — перенос и двухъярусная шапка), где есть наименование и цена или сумма.
// Колонки — по словам шапки: «Цена», «Цена с НДС», «Цена (тариф) за единицу», «Сумма без НДС», «Стоимость … с
// налогом — всего», «Кол-во», «Ед.», «Артикул»… Строки таблицы — до «Итого / Всего»; разделы (наименование без чисел),
// строка номеров колонок (1 | 1а | 2 …) и подписи — не позиции.
//
// PDF: у pdf.js кусок текста не равен ячейке («4 шт» — одним куском из двух колонок, «18 450,00» в узкой колонке
// переносится на две строки), поэтому — по словам: зона каждой колонки — от шапки (у текстовой колонки рядом с
// числовой граница прижата к числовой: наименование пишут от левого края, а шапку — по центру), строка таблицы —
// строки текста между широкими межстрочными промежутками (перенос внутри ячейки — узкий) и по колонке «№».

const SPACE_RE = /[\s\u00a0\u2007\u202f]+/g
export const cellText = (v) => String(v ?? '').replace(SPACE_RE, ' ').trim()
const norm = (v) => cellText(v).toLowerCase().replace(/ё/g, 'е')

// Число из ячейки документа: «18 450,00», «1.234,56», «1,234.56», «95,00 руб.», «22%» → число; иначе null.
export function parseNum(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).replace(/[\s\u00a0\u2007\u202f']/g, '').replace(/(руб\.?|р\.?|₽|rub|rur|%)$/i, '')
  if (!/^[-−–]?[0-9][0-9.,]*$/.test(s)) return null
  const negative = /^[-−–]/.test(s)
  s = s.replace(/^[-−–]/, '')
  const dot = s.lastIndexOf('.')
  const comma = s.lastIndexOf(',')
  if (dot >= 0 && comma >= 0) {
    const dec = dot > comma ? '.' : ','
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.')
  } else if (comma >= 0) {
    s = (s.match(/,/g) || []).length > 1 ? s.split(',').join('') : s.replace(',', '.')
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.split('.').join('')
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null
  const n = Number(s)
  return negative ? -n : n
}

// ── Шапка ────────────────────────────────────────────────────────────────────────────────────────────
// Колонка по тексту шапки: { field, vat } | null. vat — 'gross' (с НДС), 'net' (без НДС) или null (не сказано).
// field: num, name, code, unit, qty, price, sum, vat (сумма НДС), vatRate, skip (известная, но не нужная).
export function classifyHeader(text) {
  const t = norm(text)
  if (!t) return null
  if (/акциз|скидк|страна|декларац|прослеживаем|масса|вес\b|брутто|нетто|склад|наличи|срок|гарант|примечан|комментар/.test(t)) return { field: 'skip' }
  const gross = /(^|[^а-я])(с|включая|вкл\.?|в т\.? ?ч\.?|в том числе)\s*(ндс|налог)/.test(t)
  const net = /без\s*(ндс|налог)/.test(t)
  const vat = gross ? 'gross' : net ? 'net' : null
  if (/ставк/.test(t) && /ндс|налог/.test(t)) return { field: 'vatRate' }
  if (/цена|расценк|за\s*(1\s*)?ед(\.|иниц|\s|$)|стоимост\S*\s*(за\s*)?(1\s*)?ед/.test(t) && !/всего/.test(t)) return { field: 'price', vat }
  if (/сумм|стоимост|всего|итого/.test(t)) {
    if (/ндс|налог/.test(t) && !gross && !net) return { field: 'vat' }
    return { field: 'sum', vat }
  }
  if (/(^|[^а-я])(ндс|налог)/.test(t)) return { field: 'vat' }
  if (/^(№|n|#|no\.?)(\s|$|\s*п\/?\s?п)|^№|^п\/п|^поз\.?$|^позиция$/.test(t) && !/наимен|товар/.test(t)) return { field: 'num' }
  // «Код товара / работ, услуг» (УПД) — артикул, а не наименование; «Единица измерения: код» — не нужна.
  if (/^код(?![а-я])|артикул|каталожн/.test(t)) return /ед\.|единиц|измер|окей/.test(t) ? { field: 'skip' } : { field: 'code' }
  if (/(^|[^а-я])код(?![а-я])/.test(t) && /единиц|измер|окей/.test(t)) return { field: 'skip' }
  if (/наименован|товар|номенклатур|продукц|описани|материал|оборудован|услуг|предмет/.test(t)) return { field: 'name' }
  if (/^ед(\.|\s|$)|ед\.?\s*изм|единиц|измерен/.test(t)) return { field: 'unit' }
  if (/кол-?во|количеств|^кол\.?(\s|$)|объ[её]м/.test(t)) return { field: 'qty' }
  return null
}

const NUMERIC_FIELDS = new Set(['num', 'qty', 'price', 'sum', 'vat', 'vatRate'])

// Из колонок шапки — нужные: одна на поле (кроме цен и сумм — с НДС и без бывают обе). Нет наименования или ни цены,
// ни суммы — не шапка (null).
export function pickColumns(cols) {
  const out = { prices: [], sums: [] }
  for (const c of cols) {
    if (!c || c.field === 'skip') continue
    if (c.field === 'price') out.prices.push(c)
    else if (c.field === 'sum') out.sums.push(c)
    else if (out[c.field] == null) out[c.field] = c
  }
  if (!out.name || (!out.prices.length && !out.sums.length)) return null
  return out
}

// Оценка шапки: сколько нужных колонок узнано; цена и сумма «с НДС» / «без НДС» — ещё и сказан НДС (второй ярус
// шапки «Цена, руб.» → «без НДС» | «с НДС» лучше одного первого).
const columnScore = (p) => ['num', 'name', 'code', 'unit', 'qty', 'vat', 'vatRate'].filter((f) => p[f]).length
  + Math.min(2, p.prices.length) + Math.min(2, p.sums.length)
  + 0.5 * [...p.prices, ...p.sums].filter((c) => c.vat).length

// ── Таблица Excel: сетка ячеек ───────────────────────────────────────────────────────────────────────
// grid — массив строк, строка — массив значений ячеек (как sheet_to_json header:1, объединённые ячейки уже
// заполнены значением левой верхней). Ответ: { headerRow (0-based), span, columns } | null.
export const HEADER_SCAN_ROWS = 40
export function detectGridHeader(grid, scanRows = HEADER_SCAN_ROWS) {
  let best = null
  const last = Math.min(grid.length, scanRows)
  for (let r = 0; r < last; r++) {
    if (best && r > best.headerRow + best.span + 2) break
    for (let span = 1; span <= 3 && r + span <= grid.length; span++) {
      const rows = grid.slice(r, r + span)
      const width = Math.max(0, ...rows.map((row) => row?.length || 0))
      const cols = []
      for (let c = 0; c < width; c++) {
        const parts = []
        for (const row of rows) {
          const v = cellText(row?.[c])
          if (v && parts[parts.length - 1] !== v) parts.push(v)
        }
        const k = classifyHeader(parts.join(' '))
        if (k) cols.push({ index: c, text: parts.join(' '), ...k })
      }
      const picked = pickColumns(cols)
      if (!picked) continue
      const score = columnScore(picked)
      if (!best || score > best.score) best = { headerRow: r, span, score, columns: picked }
    }
  }
  return best && { headerRow: best.headerRow, span: best.span, columns: best.columns }
}

const TOTAL_RE = /^(итого|итог|всего|в том числе|в т\.? ?ч\.?|ндс\b|сумма ндс|к оплате)/
const COLUMN_NUMBERS_RE = /^[0-9]{1,2}[а-яa-z]?$/

// Строки таблицы Excel после шапки → строки документа: [{ [поле]: текст | число, row }].
export function gridRows(grid, header) {
  const cols = header.columns
  const out = []
  for (let r = header.headerRow + header.span; r < grid.length; r++) {
    const row = grid[r] || []
    const cells = {}
    for (const f of ['num', 'name', 'code', 'unit', 'qty', 'vat', 'vatRate']) if (cols[f]) cells[f] = row[cols[f].index]
    cells.prices = cols.prices.map((c) => row[c.index])
    cells.sums = cols.sums.map((c) => row[c.index])
    out.push({ cells, row: r + 1 })
  }
  return out
}

// ── PDF: слова с координатами ────────────────────────────────────────────────────────────────────────
// Куски текста pdf.js → слова { text, x0, x1, top, h, page }: кусок делится по пробелам, ширина символа — средняя по
// куску. Повёрнутый текст (печати, вертикальные подписи) пропускается. top — расстояние от верха страницы.
export function wordsFromTextItems(items, { pageHeight, page = 0 }) {
  const words = []
  ;(items || []).forEach((it, item) => {
    const str = String(it.str ?? '')
    if (!str.trim()) return
    const [a, b, c, d, e, f] = it.transform || [1, 0, 0, 1, 0, 0]
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) return
    const h = Math.abs(d) || it.height || 10
    const cw = (it.width || str.length * h * 0.5) / str.length
    const re = /\S+/g
    let m
    while ((m = re.exec(str))) {
      const x0 = e + m.index * cw
      words.push({ text: m[0], x0, x1: x0 + m[0].length * cw, top: pageHeight - f, h, page, item: `${page}:${item}` })
    }
  })
  return words
}

// Слова → строки текста (по высоте, слева направо). Строки разных страниц не смешиваются.
export function linesFromWords(words) {
  const sorted = [...words].sort((p, q) => p.page - q.page || p.top - q.top || p.x0 - q.x0)
  const lines = []
  for (const w of sorted) {
    const line = lines[lines.length - 1]
    if (line && line.page === w.page && Math.abs(w.top - line.top) <= 0.4 * Math.min(w.h, line.h)) {
      line.words.push(w)
      line.h = Math.max(line.h, w.h)
    } else {
      lines.push({ page: w.page, top: w.top, h: w.h, words: [w] })
    }
  }
  for (const l of lines) l.words.sort((p, q) => p.x0 - q.x0)
  return lines
}

const lineText = (line) => line.words.map((w) => w.text).join(' ')

// Слова одной строки → надписи ячеек: слова одного куска текста pdf.js — всегда вместе (средняя ширина символа
// неточна, и промежуток внутри куска не мерило), разных кусков — если ближе 0,6 высоты шрифта.
function lineClusters(line) {
  const out = []
  for (const w of line.words) {
    const c = out[out.length - 1]
    if (c && (w.item === c.item || w.x0 - c.x1 < 0.6 * Math.min(w.h, c.h))) {
      c.x1 = Math.max(c.x1, w.x1)
      c.text += ` ${w.text}`
      c.item = w.item
    } else {
      out.push({ x0: w.x0, x1: w.x1, h: w.h, text: w.text, item: w.item })
    }
  }
  return out
}

const overlaps = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0
// Перенос в шапке: «Кол-» + «во» → «Кол-во», «Цена без» + «НДС» → «Цена без НДС».
const joinWrapped = (texts) => texts.reduce((s, t) => (!s ? t : /[-‐]$/.test(s) ? s + t : `${s} ${t}`), '')

// Шапка из нескольких строк текста: перенос внутри ячейки дописывается к своей колонке, а ячейка над несколькими
// (двухъярусная шапка: «Единица измерения» над «код» и «обозначение») делится — каждая получает её текст.
export function headerColumnsFromLines(lines) {
  let cols = []
  for (const line of lines) {
    const clusters = lineClusters(line)
    const next = cols.map((c) => ({ ...c, kids: [] }))
    const added = []
    for (const cl of clusters) {
      const owners = next.filter((c) => overlaps(c, cl))
      if (!owners.length) added.push({ x0: cl.x0, x1: cl.x1, h: cl.h, texts: [cl.text] })
      else for (const o of owners) o.kids.push(cl)
    }
    cols = []
    for (const c of next) {
      if (c.kids.length <= 1) {
        const k = c.kids[0]
        cols.push(k ? { x0: Math.min(c.x0, k.x0), x1: Math.max(c.x1, k.x1), h: c.h, texts: [...c.texts, k.text] } : { x0: c.x0, x1: c.x1, h: c.h, texts: c.texts })
      } else {
        for (const k of c.kids) cols.push({ x0: k.x0, x1: k.x1, h: k.h, texts: [...c.texts, k.text] })
      }
    }
    cols.push(...added)
    cols.sort((p, q) => p.x0 - q.x0)
  }
  return cols.map((c) => ({ x0: c.x0, x1: c.x1, h: c.h, text: joinWrapped(c.texts) }))
}

// Зоны колонок по шапке: граница между соседними — середина промежутка; рядом с числовой колонкой текстовая
// граница прижата к числовой (не дальше 1,5 высоты шрифта): шапку наименования пишут по центру широкой колонки, а
// само наименование — от левого края, к самому номеру строки.
function columnZones(cols) {
  const zones = cols.map((c) => ({ ...c, from: -Infinity, to: Infinity }))
  for (let i = 0; i + 1 < zones.length; i++) {
    const a = zones[i]
    const b = zones[i + 1]
    const gap = Math.max(0, b.x0 - a.x1)
    const pad = 0.5 * Math.min(a.h, b.h)
    const aNum = NUMERIC_FIELDS.has(a.field)
    const bNum = NUMERIC_FIELDS.has(b.field)
    let edge = (a.x1 + b.x0) / 2
    if (aNum && !bNum) edge = a.x1 + Math.min(gap / 2, pad)
    else if (!aNum && bNum) edge = b.x0 - Math.min(gap / 2, pad)
    a.to = edge
    b.from = edge
  }
  return zones
}

const recognized = (text) => {
  const k = classifyHeader(text)
  return !!k && k.field !== 'skip'
}
const isNumericCluster = (text) => parseNum(text) != null

// Шапка PDF: начинается со строки, где узнаются хотя бы две колонки, и тянется вниз (перенос, второй ярус), пока
// строки идут плотно (шаг до 2,5 высоты шрифта) и в них нет чисел — дальше уже строка номеров колонок или данные;
// не больше 8 строк. Из вариантов длины — где больше узнанных колонок (неузнанные — в минус: так в шапку не
// попадают заголовок документа и реквизиты над таблицей). Нужны наименование и цена или сумма.
export const HEADER_MAX_LINES = 8
export function detectLinesHeader(lines, from = 0) {
  let best = null
  for (let i = from; i < lines.length; i++) {
    if (best && i > best.line + best.span + 2) break
    if (lineClusters(lines[i]).filter((c) => recognized(c.text)).length < 2) continue
    // tight — все строки окна идут вплотную (перенос, второй ярус): такое окно при той же оценке длиннее — лучше
    // (остаток шапки не уходит в данные); первая строка данных отстоит дальше, её шапка не забирает.
    let tight = true
    for (let span = 1; span <= HEADER_MAX_LINES && i + span <= lines.length; span++) {
      const last = lines[i + span - 1]
      if (span > 1) {
        const prev = lines[i + span - 2]
        if (last.page !== prev.page || last.top - prev.top > 2.5 * last.h) break
        if (lineClusters(last).some((c) => isNumericCluster(c.text))) break
        if (last.top - prev.top > 1.35 * last.h) tight = false
      }
      const cols = headerColumnsFromLines(lines.slice(i, i + span)).map((c) => ({ ...c, ...(classifyHeader(c.text) || { field: null }) }))
      const picked = pickColumns(cols.filter((c) => c.field))
      if (!picked) continue
      const score = columnScore(picked) - 0.25 * cols.filter((c) => !c.field).length
      if (!best || score > best.score || (score === best.score && tight && best.line === i)) best = { line: i, span, score, cols }
    }
  }
  if (!best) return null
  const zones = columnZones(best.cols)
  zones.forEach((z, index) => { z.index = index })
  return { line: best.line, span: best.span, zones, columns: pickColumns(zones.filter((z) => z.field && z.field !== 'skip')) }
}

// Слова строки для колонок: число с пробелами-разрядами («1 234 567,89») — одним словом.
function lineTokens(line) {
  const out = []
  for (const w of line.words) {
    const prev = out[out.length - 1]
    if (prev && prev.item === w.item && prev.groups && /^[0-9]{3}([.,][0-9]+)?$/.test(w.text)) {
      out[out.length - 1] = { ...prev, text: `${prev.text} ${w.text}`, x1: w.x1, groups: /^[0-9]{3}$/.test(w.text) }
    } else {
      out.push({ ...w, groups: /^[-−]?[0-9]{1,3}$/.test(w.text) })
    }
  }
  return out
}

// Слова строки → колонки по зонам: текст — по середине слова, число — у правого края (числа пишут по правому краю
// колонки, и левая часть широкого числа заходит в соседнюю зону).
function assignWords(line, zones) {
  const cells = new Map()
  for (const w of lineTokens(line)) {
    const at = parseNum(w.text) != null ? w.x1 - 0.25 * w.h : (w.x0 + w.x1) / 2
    const z = zones.find((x) => at >= x.from && at < x.to) || zones[zones.length - 1]
    if (!cells.has(z.index)) cells.set(z.index, [])
    cells.get(z.index).push(w)
  }
  return cells
}

// Порог «перенос внутри ячейки / новая строка таблицы»: шаги между строками (в высотах шрифта) делятся на две
// группы по самому большому скачку. Двух групп нет — каждая строка текста отдельно.
function wrapLimit(steps) {
  const r = steps.filter((s) => s > 0.9 && s < 6).sort((p, q) => p - q)
  let best = null
  for (let i = 0; i + 1 < r.length; i++) {
    const jump = r[i + 1] / r[i]
    if (jump > 1.12 && r[i] <= 1.4 && (!best || jump > best.jump)) best = { jump, limit: Math.sqrt(r[i] * r[i + 1]) }
  }
  return best ? best.limit : 0
}

// Строки PDF после шапки → строки документа: строки текста собираются в строки таблицы (по промежуткам и номеру
// строки), тексты колонки складываются сверху вниз. Таблица кончается на «Итого / Всего»; на следующей странице —
// повтор шапки (пропускается) или продолжение без шапки.
export function pdfRows(lines, header) {
  const out = []
  const zones = header.zones
  const cols = header.columns
  const numIndex = cols.num?.index
  let i = header.line + header.span
  let headerPage = lines[header.line]?.page
  const body = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const text = norm(lineText(line))
    if (line.page !== headerPage) {
      // Новая страница: та же шапка — пропустить её строки.
      const again = detectLinesHeader(lines.slice(i, i + 6))
      if (again && again.line === 0 && again.columns.name) { i += again.span - 1; headerPage = line.page; continue }
      headerPage = line.page
    }
    const cells = assignWords(line, zones)
    const nameText = norm((cells.get(cols.name.index) || []).map((w) => w.text).join(' '))
    if (TOTAL_RE.test(text) || TOTAL_RE.test(nameText)) break
    body.push({ line, cells })
  }
  // Шаги между строками текста — в высотах шрифта (на одной странице).
  const steps = []
  for (let k = 1; k < body.length; k++) {
    if (body[k].line.page === body[k - 1].line.page) steps.push((body[k].line.top - body[k - 1].line.top) / body[k].line.h)
  }
  const limit = wrapLimit(steps)
  let cur = null
  const flush = () => { if (cur) out.push(cur) }
  for (let k = 0; k < body.length; k++) {
    const { line, cells } = body[k]
    const prev = body[k - 1]?.line
    const step = prev && prev.page === line.page ? (line.top - prev.top) / line.h : Infinity
    const numWords = numIndex != null ? (cells.get(numIndex) || []) : []
    const startsNumbered = numWords.length === 1 && /^[0-9]{1,4}\.?$/.test(numWords[0].text)
    const wrapped = step <= limit
    let start = !cur || !wrapped
    // Номер строки в колонке «№» — новая строка таблицы, даже если промежуток узкий; у строки без номера при
    // колонке «№» (перенос, выравнивание по низу) — нет.
    if (numIndex != null && cur && startsNumbered && cur.hasNum) start = true
    if (start) {
      flush()
      cur = { words: new Map(), hasNum: false, page: line.page }
    }
    for (const [idx, ws] of cells) {
      if (!cur.words.has(idx)) cur.words.set(idx, [])
      cur.words.get(idx).push(ws.map((w) => w.text).join(' '))
    }
    if (startsNumbered) cur.hasNum = true
  }
  flush()
  // Текст колонки — строки сверху вниз; перенос по дефису склеивается («Сигмавент-90-» + «НО» → «Сигмавент-90-НО»).
  const text = (row, col) => (col ? joinWrapped(row.words.get(col.index) || []) : undefined)
  return out.map((row) => ({
    cells: {
      num: text(row, cols.num), name: text(row, cols.name), code: text(row, cols.code), unit: text(row, cols.unit),
      qty: text(row, cols.qty), vat: text(row, cols.vat), vatRate: text(row, cols.vatRate),
      prices: cols.prices.map((c) => text(row, c)), sums: cols.sums.map((c) => text(row, c)),
    },
    page: row.page + 1,
  }))
}

// ── Строки документа → позиции ───────────────────────────────────────────────────────────────────────
// Ответ: [{ name, code, unit, qty, price, priceVat, sum, sumVat, vatRate, delivery, source }]: price / sum — как в
// документе (первая колонка с НДС, иначе первая указанная), priceVat / sumVat — их 'gross' / 'net' / null.
export function itemsFromRows(rows, columns) {
  const pick = (values, cols) => {
    const list = cols.map((c, i) => ({ v: parseNum(values?.[i]), vat: c.vat }))
    return list.find((x) => x.v != null && x.vat === 'gross') || list.find((x) => x.v != null && x.vat !== 'net')
      || list.find((x) => x.v != null) || { v: null, vat: null }
  }
  const items = []
  for (const r of rows) {
    const c = r.cells
    const name = cellText(c.name)
    if (!name || COLUMN_NUMBERS_RE.test(name) || TOTAL_RE.test(name.toLowerCase())) continue
    const price = pick(c.prices, columns.prices)
    const sum = pick(c.sums, columns.sums)
    const qty = parseNum(c.qty)
    if (price.v == null && sum.v == null) continue
    if ((price.v ?? 0) < 0 || (sum.v ?? 0) < 0) continue
    const rate = parseNum(c.vatRate)
    items.push({
      name,
      code: cellText(c.code) || null,
      unit: cellText(c.unit) || null,
      qty: qty != null && qty > 0 ? qty : null,
      price: price.v,
      priceVat: price.vat,
      sum: sum.v,
      sumVat: sum.vat,
      vatRate: rate != null && rate > 0 && rate < 50 ? rate : null,
      delivery: /доставк|транспортн|перевозк|разгрузк|погрузк|экспедир/.test(name.toLowerCase()),
      source: r.row ? `строка ${r.row}` : r.page ? `стр. ${r.page}` : null,
    })
  }
  return items
}

// ── НДС ──────────────────────────────────────────────────────────────────────────────────────────────
// По тексту документа: цены с НДС («в том числе НДС», «цены с НДС»), без НДС и НДС сверху («сумма НДС», «итого без
// НДС»), НДС не облагается. Ставка — «НДС 22 %», «(20%)». Ответ: { mode: 'gross' | 'net' | 'none' | null, rate, cue }.
export function vatFromText(text) {
  const t = norm(text)
  const rateM = /ндс[^0-9%]{0,16}([0-9]{1,2}(?:[.,][0-9])?)\s*%/.exec(t) || /([0-9]{1,2})\s*%\s*ндс/.exec(t)
  const rate = rateM ? parseNum(rateM[1]) : null
  const cue = (re) => { const m = re.exec(t); return m ? m[0] : null }
  let c
  if ((c = cue(/ндс\s*не\s*облага\S*|не\s*облага\S*\s*ндс|без\s*налога\s*\(?ндс\)?|применяет\s*упрощ\S*/))) return { mode: 'none', rate: null, cue: c }
  if ((c = cue(/в\s*т(ом)?\.?\s*ч(исле)?\.?\s*(сумма\s*)?ндс|включая\s*ндс|с\s*учет\S*\s*ндс|ндс\s*включ\S*|цен\S*\s*(указан\S*\s*)?с\s*ндс/))) return { mode: 'gross', rate, cue: c }
  if ((c = cue(/цен\S*\s*(указан\S*\s*)?без\s*ндс|итого\s*без\s*ндс|без\s*учет\S*\s*ндс|ндс\s*сверху|сумма\s*ндс|ндс\s*[0-9]{1,2}\s*%\s*:|всего\s*с\s*ндс/))) return { mode: 'net', rate, cue: c }
  return { mode: null, rate, cue: null }
}

// Ставка НДС, если ни строка, ни документ её не называют (2026 год).
export const DEFAULT_VAT_RATE = 22

// Цена за единицу с НДС для расценки (как «Цена за ед. с доставкой и НДС» листа «Материалы»):
//  1) колонка цены с НДС; 2) сумма с НДС / количество — их не переспросить;
//  3) иначе цена (нет — сумма / количество): «НДС не облагается» — как есть; колонка «без НДС» — плюс НДС; колонка
//     молчит — как говорит документ («в т. ч. НДС» — как есть, «сумма НДС» сверху — плюс НДС), не говорит — как есть.
// vat: { mode: 'gross' | 'net' | 'none' | null, rate, force } — по документу; force — выбрал человек (и для колонок
// «без НДС»: поставщик без НДС тоже пишет «цена без НДС»).
export function unitPriceWithVat(item, vat) {
  const rate = ((vat?.force ? vat.rate : null) ?? item.vatRate ?? vat?.rate ?? DEFAULT_VAT_RATE) / 100
  const fromSum = item.sum != null && item.qty > 0 ? item.sum / item.qty : null
  if (item.price != null && item.priceVat === 'gross') return item.price
  if (fromSum != null && item.sumVat === 'gross') return fromSum
  const base = item.price ?? fromSum
  if (base == null) return null
  const baseVat = item.price != null ? item.priceVat : item.sumVat
  let mode = vat?.mode ?? null
  if (!vat?.force && mode !== 'none' && baseVat === 'net') mode = 'net'
  return mode === 'net' ? base * (1 + rate) : base
}
