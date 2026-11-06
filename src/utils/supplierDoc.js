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
// переносится на две строки), поэтому — по словам и линиям таблицы. Колонка — между вертикальными линиями рамки, а
// без рамки — от шапки (у текстовой колонки рядом с числовой граница прижата к числовой: наименование пишут от
// левого края, а шапку — по центру; две текстовые — по просвету в строках данных). Строка таблицы — полоса между
// горизонтальными линиями, а без них — между широкими межстрочными промежутками; внутри полосы — по строкам с ценой
// («якорям»): цифры по центру двухстрочной ячейки, строки вплотную без отступов, номер строки в колонке «№».
//
// Доставка: отдельной строкой («Доставка», «Транспортные услуги» — delivery) или колонкой («Доставка», «Стоимость
// доставки» — сумма по строке, «Доставка за ед.» — за единицу): deliveryUnitWithVat.
//
// Что поставщики пишут по-разному, а цена из-за этого вышла бы неверной (02.11.2026, спецификации ЭТМ и то, что
// встречается у других):
//  • две цены — «Цена» и «Цена со скидкой» (берём со скидкой), «РРЦ» / «прайс» и «ваша цена» (берём вашу);
//  • цена в валюте — columns.currency / currencyFromText: без курса в расценку не идёт;
//  • цена за 100 или 1000 единиц: в шапке («Цена за 1000 шт», «руб./км») или видно по сумме (цена × количество в 10, 100,
//    1000 раз больше суммы); цена × количество не сходится с суммой иначе — пометка sumOff, сама не ставится;
//  • два наименования — «по запросу» и «предлагаемое» (name и name2, ищем по обоим), колонка «Марка» — как артикул;
//  • колонка «В упаковке» (packQty) вместо «(50шт)» в наименовании;
//  • таблицы на нескольких листах и несколько таблиц в PDF, «Итого по разделу» посреди таблицы;
//  • итог документа не сходится с прочитанными строками (totalsCheck) — потерялись строки или скидка на весь заказ.

import { canonUnit } from './supplySimilarity.js'

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
// field: num, name, code, unit, qty, price, sum, vat (сумма НДС), vatRate, delivery (доставка: perUnit — за единицу,
// иначе сумма по строке), skip (известная, но не нужная).
export function classifyHeader(text) {
  const t = norm(text)
  if (!t) return null
  const discounted = /(со|с\s*уч[её]том|после)\s*скидк/.test(t)
  if ((!discounted && /скидк/.test(t)) || /акциз|страна|декларац|прослеживаем|масса|вес\b|брутто|нетто|склад|наличи|срок|гарант|примечан|комментар/.test(t)) return { field: 'skip' }
  if (/в\s*упак|упаковк|фасовк|кратност/.test(t) && !/цена|сумм|стоимост/.test(t)) return { field: 'pack' }
  const gross = /(^|[^а-я])(с|включая|вкл\.?|в т\.? ?ч\.?|в том числе)\s*(ндс|налог)/.test(t)
  const net = /без\s*(ндс|налог)/.test(t)
  const vat = gross ? 'gross' : net ? 'net' : null
  if (/(^|[^а-я])ставк/.test(t) && /ндс|налог/.test(t)) return { field: 'vatRate' }
  // «Цена с доставкой», «с учётом доставки» — цена (доставка уже в ней); «Доставка», «Стоимость доставки» — отдельно.
  if (/доставк|транспортн|перевозк/.test(t) && !/(^|[^а-я])(с|включая|вкл\.?|с\s*уч[её]том|в т\.? ?ч\.?)\s*(стоимост\S*\s*)?(доставк|транспортн|перевозк)/.test(t)) {
    return { field: 'delivery', perUnit: /цена|за\s*(1\s*)?(ед|шт|м\b|кг|т\b)|на\s*(1\s*)?ед/.test(t), vat }
  }
  if (/цена|расценк|за\s*(1\s*)?ед(\.|иниц|\s|$)|стоимост\S*\s*(за\s*)?(1\s*)?ед/.test(t) && !/всего/.test(t)) {
    return { field: 'price', vat, best: discounted, listPrice: /прайс|ррц|розничн|рекоменд/.test(t), currency: currencyOf(t), per: perOf(t) }
  }
  if (/сумм|стоимост|всего|итого/.test(t)) {
    if (/ндс|налог/.test(t) && !gross && !net) return { field: 'vat' }
    return { field: 'sum', vat, best: discounted, currency: currencyOf(t) }
  }
  if (/(^|[^а-я])(ндс|налог)/.test(t)) return { field: 'vat' }
  if (/^(№|n|#|no\.?)(\s|$|\s*п\/?\s?п)|^№|^п\/п|^поз\.?$|^позиция$/.test(t) && !/наимен|товар/.test(t)) return { field: 'num' }
  // «Код товара / работ, услуг» (УПД) — артикул, а не наименование; «Единица измерения: код» — не нужна. Рядом с
  // «Артикулом» «Код товара» — внутренний код поставщика (ЭТМ): в ВОР его нет, важнее артикул (internal).
  if (/^код(?![а-я])|артикул|каталожн/.test(t)) {
    if (/ед\.|единиц|измер|окей/.test(t)) return { field: 'skip' }
    return { field: 'code', internal: !/артикул|каталожн/.test(t) }
  }
  if (/(^|[^а-я])код(?![а-я])/.test(t) && /единиц|измер|окей/.test(t)) return { field: 'skip' }
  if (/наименован|товар|номенклатур|продукц|описани|материал|оборудован|услуг|предмет/.test(t)) return { field: 'name' }
  // «Eg.» — так распознаватель читает «Ед.» на скане.
  if (/^ед(\.|\s|$)|ед\.?\s*изм|единиц|измерен|^eg\.?$/.test(t)) return { field: 'unit' }
  if (/кол-?во|количеств|^кол\.?(\s|$)|объ[её]м/.test(t)) return { field: 'qty' }
  if (/(^|[^а-я])(марка|модель|обозначени)/.test(t)) return { field: 'code', internal: false }
  return null
}

const NUMERIC_FIELDS = new Set(['num', 'qty', 'price', 'sum', 'vat', 'vatRate', 'delivery'])

// Валюта колонки или фразы: не рубли — код, рубли и не сказано — null.
const CURRENCY_RE = [['USD', /usd|доллар|\$/], ['EUR', /eur|евро|€/], ['CNY', /cny|юан|¥/], ['у.е.', /(^|[^а-я])у\.?\s?е\.?($|[^а-я])/]]
export function currencyOf(text) {
  const t = norm(text)
  if (/руб|₽|(^|[^a-z])(rub|rur)/.test(t)) return null
  return CURRENCY_RE.find(([, re]) => re.test(t))?.[0] || null
}
// «Цены указаны в долларах США», «цена в евро» — вся таблица в валюте, хотя колонка молчит.
export function currencyFromText(text) {
  const m = /цен\S*\s*(указан\S*\s*|даны\s*)?в\s*(долл\S*|евро|юан\S*|usd|eur|cny|у\.?\s?е\.?)/.exec(norm(text))
  return m ? currencyOf(m[2]) : null
}

// Цена не за единицу: «Цена за 1000 шт», «руб./100 м», «Цена за км», «руб/т». Ответ: { n, unit } или null («за 1 шт» — обычная).
const PER_RE = /(?:за|\/)\s*([0-9][0-9 ]*)?\s*(шт|км|кг|тн|тонн\S*|т|м|л|уп\S*)(?![а-яa-z0-9])/
function perOf(t) {
  const m = PER_RE.exec(t)
  if (!m) return null
  const n = m[1] ? Number(m[1].replace(/ /g, '')) : 1
  const unit = canonUnit(m[2])
  return n > 1 || unit === 'км' || unit === 'т' ? { n, unit } : null
}

// Из колонок шапки — нужные: одна на поле (кроме цен и сумм — с НДС и без бывают обе; артикул и код поставщика —
// code и code2; два разных наименования — name и name2). Нет наименования или ни цены, ни суммы — не шапка (null).
// Из нескольких цен — со скидкой, а не прайсовая, и в рублях, а не в валюте (если есть такие).
const REQUESTED_NAME_RE = /запрос|заказчик|по\s*вор|по\s*проект|требу|спецификац|ваш/
const preferred = (list) => {
  let out = list
  for (const test of [(c) => c.best, (c) => !c.listPrice, (c) => !c.currency]) {
    const good = out.filter(test)
    if (good.length) out = good
  }
  return out
}
export function pickColumns(cols) {
  const out = { prices: [], sums: [] }
  const codes = []
  const names = []
  for (const c of cols) {
    if (!c || c.field === 'skip') continue
    if (c.field === 'price') out.prices.push(c)
    else if (c.field === 'sum') out.sums.push(c)
    else if (c.field === 'code') codes.push(c)
    else if (c.field === 'name') names.push(c)
    else if (out[c.field] == null) out[c.field] = c
  }
  if (codes.length) {
    out.code = codes.find((c) => !c.internal) || codes[0]
    const other = codes.find((c) => c !== out.code)
    if (other) out.code2 = other
  }
  if (names.length) {
    const distinct = names.filter((c, i) => names.findIndex((x) => norm(x.text) === norm(c.text)) === i)
    out.name = distinct.find((c) => !REQUESTED_NAME_RE.test(norm(c.text))) || distinct[0]
    const other = distinct.find((c) => c !== out.name)
    if (other) out.name2 = other
  }
  if (!out.name || (!out.prices.length && !out.sums.length)) return null
  out.prices = preferred(out.prices)
  out.sums = preferred(out.sums)
  out.currency = out.prices[0]?.currency || (out.prices.length ? null : out.sums[0]?.currency) || null
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
//
// Шапка бывает глубоко: «Счёт на оплату» из 1С — это реквизиты банка, условия поставки и пустые строки вёрстки над таблицей (тендер
// № 902: шапка в 50-й строке, и файл считался «нет таблицы»). Текст условий сам похож на шапку («…товара», «…стоимости…»),
// поэтому: ячейка длиннее HEADER_CELL_MAX — абзац, а не заголовок колонки; и шапка из двух колонок (WEAK_HEADER_SCORE) поиск
// не останавливает: дальше может быть настоящая. Вид каждой надписи запоминается: объединённая ячейка повторяет её по всей ширине.
export const HEADER_SCAN_ROWS = 200
const HEADER_CELL_MAX = 120
const WEAK_HEADER_SCORE = 2
export function detectGridHeader(grid, scanRows = HEADER_SCAN_ROWS) {
  let best = null
  const last = Math.min(grid.length, scanRows)
  const kinds = new Map()
  const kindOf = (text) => {
    if (!kinds.has(text)) kinds.set(text, classifyHeader(text))
    return kinds.get(text)
  }
  for (let r = 0; r < last; r++) {
    if (best && best.score > WEAK_HEADER_SCORE && r > best.headerRow + best.span + 2) break
    for (let span = 1; span <= 3 && r + span <= grid.length; span++) {
      const rows = grid.slice(r, r + span)
      const width = Math.max(0, ...rows.map((row) => row?.length || 0))
      const cols = []
      for (let c = 0; c < width; c++) {
        const parts = []
        for (const row of rows) {
          const v = cellText(row?.[c])
          if (v && v.length <= HEADER_CELL_MAX && parts[parts.length - 1] !== v) parts.push(v)
        }
        const text = parts.join(' ')
        const k = kindOf(text)
        if (k) cols.push({ index: c, text, ...k })
      }
      const picked = pickColumns(cols)
      if (!picked) continue
      const score = columnScore(picked)
      // При равной оценке — без лишних строк сверху: пустая строка над шапкой ничего не даёт, а реквизиты покупателя над ней могли бы
      // приписаться к колонкам.
      const tighter = !!best && score === best.score && r + span === best.headerRow + best.span && span < best.span
      if (!best || score > best.score || tighter) best = { headerRow: r, span, score, columns: picked }
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
    for (const f of ['num', 'name', 'name2', 'code', 'code2', 'unit', 'qty', 'pack', 'vat', 'vatRate', 'delivery']) if (cols[f]) cells[f] = row[cols[f].index]
    cells.prices = cols.prices.map((c) => row[c.index])
    cells.sums = cols.sums.map((c) => row[c.index])
    // Строка таблицы на две строки листа (объединённые ячейки, gridFromSheet заполняет обе) — одна строка документа.
    const prev = out[out.length - 1]
    if (prev && cellText(cells.name) && JSON.stringify(prev.cells) === JSON.stringify(cells)) continue
    out.push({ cells, row: r + 1 })
  }
  return out
}

// Итоговые строки: «Итого», «Всего», «Всего к оплате» — но не «Итого по разделу» и не «В том числе НДС». Ответ — числа.
const FINAL_TOTAL_RE = /^(итого|итог|всего|к оплате)/
const SUBTOTAL_RE = /^(итого|всего)\s+(по|за)\s/
const isFinalTotal = (t) => FINAL_TOTAL_RE.test(t) && !SUBTOTAL_RE.test(t)
export function gridTotals(grid, header) {
  const out = []
  for (let r = header.headerRow + header.span; r < grid.length; r++) {
    const cells = grid[r] || []
    const label = cells.map(cellText).find((v) => v && parseNum(v) == null)
    if (!label || !isFinalTotal(norm(label))) continue
    for (const v of cells) {
      const n = parseNum(v)
      if (n > 0) out.push(n)
    }
  }
  return out
}

// Сверка строк с итогом документа. Ответ: null — сверять не с чем; { ok, read, doc }: read — сумма прочитанных строк,
// doc — итог документа. Сходится с любым из итогов (без НДС, с НДС), с точностью до округления или с НДС сверху.
const VAT_FACTORS = [1, 1.22, 1.2, 1.1, 1.07, 1.05]
export function totalsCheck(items, totals) {
  if (!totals?.length) return null
  const read = items.reduce((s, it) => s + (it.sum ?? (it.price != null && it.qty > 0 ? it.price * it.qty : 0)), 0)
  if (!(read > 0)) return null
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.002)
  const ok = totals.some((t) => VAT_FACTORS.some((f) => near(read * f, t)))
  return { ok, read: Math.round(read * 100) / 100, doc: Math.max(...totals) }
}

// Дата документа: «от 02.11.2026», «от 02 ноября 2026 г.», «от 27.10.26»; иначе первая дата в тексте. Ответ: 'ГГГГ-ММ-ДД' или null.
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']
export function docDateFromText(text) {
  const t = norm(text)
  const fmt = (d, m, y) => {
    const year = y < 100 ? 2000 + y : y
    if (year < 2000 || year > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
    return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const num = /(?:^|[^0-9.])([0-9]{1,2})[.\-/]([0-9]{1,2})[.\-/]([0-9]{4}|[0-9]{2})(?![0-9])/
  const word = /(?:^|[^0-9.])([0-9]{1,2})\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\s+([0-9]{4})/
  const parse = (s) => {
    const a = num.exec(s)
    const b = word.exec(s)
    const first = a && (!b || a.index <= b.index) ? a : b
    if (!first) return null
    if (first === a) return fmt(Number(a[1]), Number(a[2]), Number(a[3]))
    return fmt(Number(b[1]), MONTHS.findIndex((m) => b[2].startsWith(m)) + 1, Number(b[3]))
  }
  const at = t.search(/(?:^|[^а-я])от\s+[0-9]/)
  return (at >= 0 ? parse(t.slice(at + 1)) : null) || parse(t)
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
// Вертикальная линия рамки между словами (cuts — её x) — всегда разные ячейки, как бы близко они ни стояли («№» и
// «Артикул» в узких ячейках; бывает, что pdf.js отдаёт их одним куском, и место слова внутри куска — оценка, отсюда
// допуск).
const ruleBetweenWords = (cuts, a, b) => !!cuts?.some((x) => x >= a.x1 - 0.35 * a.h && x <= b.x0 + 0.35 * b.h)
function lineClusters(line, cuts = null) {
  const out = []
  for (const w of line.words) {
    const c = out[out.length - 1]
    const cut = !!c && ruleBetweenWords(cuts, c, w)
    if (c && !cut && (w.item === c.item || w.x0 - c.x1 < 0.6 * Math.min(w.h, c.h))) {
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
export function headerColumnsFromLines(lines, cutsOf = null) {
  let cols = []
  for (const line of lines) {
    const clusters = lineClusters(line, cutsOf?.(line))
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

// ── PDF: линии таблицы ───────────────────────────────────────────────────────────────────────────────
// Рамки ячеек — самое надёжное в PDF: по ним видно, где кончается строка таблицы (цифры по центру двухстрочной
// ячейки, строки вплотную без отступов) и где граница двух текстовых колонок (артикул и наименование). Рисуют их
// по-разному: 1С и большинство программ — отрезками (обводка), Chromium и Excel — тонкими закрашенными
// прямоугольниками; берём оба. Команды страницы pdf.js (getOperatorList) → { h: [{ y, x0, x1 }], v: [{ x, y0, y1 }] },
// y — от верха страницы, как у слов. Отрезки на одной прямой, стык в стык (каждая ячейка — своя рамка), — одной линией.
const RULE_THICK = 2.5
const RULE_MIN = 3
const mulMatrix = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]

function mergeRules(list, pos, a, b) {
  const sorted = [...list].sort((p, q) => p[pos] - q[pos] || p[a] - q[a])
  const out = []
  for (const r of sorted) {
    let prev = null
    for (let k = out.length - 1; k >= 0 && r[pos] - out[k][pos] <= 1; k--) if (r[a] <= out[k][b] + 2) { prev = out[k]; break }
    if (prev) prev[b] = Math.max(prev[b], r[b])
    else out.push({ ...r })
  }
  return out
}

export function rulingsFromOps(opList, OPS, { pageHeight }) {
  const h = []
  const v = []
  const fnArray = opList?.fnArray
  const argsArray = opList?.argsArray
  if (!fnArray || !argsArray || !OPS) return { h, v }
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  const at = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], pageHeight - (ctm[1] * x + ctm[3] * y + ctm[5])]
  const segment = (p, q) => {
    const dx = Math.abs(p[0] - q[0])
    const dy = Math.abs(p[1] - q[1])
    if (dy < 0.6 && dx >= RULE_MIN) h.push({ y: (p[1] + q[1]) / 2, x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]) })
    else if (dx < 0.6 && dy >= RULE_MIN) v.push({ x: (p[0] + q[0]) / 2, y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) })
  }
  // Закрашенный прямоугольник со сторонами по осям: тонкий — линия, толстый (заливка шапки, фон) — нет.
  const filledBox = (pts) => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const near = (u, a, b) => Math.abs(u - a) < 0.3 || Math.abs(u - b) < 0.3
    if (!pts.every((p) => near(p[0], x0, x1) && near(p[1], y0, y1))) return
    const w = x1 - x0
    const ht = y1 - y0
    if (ht <= RULE_THICK && w >= RULE_MIN && w > ht) h.push({ y: (y0 + y1) / 2, x0, x1 })
    else if (w <= RULE_THICK && ht >= RULE_MIN && ht > w) v.push({ x: (x0 + x1) / 2, y0, y1 })
  }
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() || ctm
    else if (fn === OPS.transform) { if (args?.length === 6) ctm = mulMatrix(ctm, args) }
    else if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginGroup) {
      stack.push(ctm)
      const m = fn === OPS.beginGroup ? args?.[0]?.matrix : args?.[0]
      if (m?.length === 6) ctm = mulMatrix(ctm, m)
    } else if (fn === OPS.paintFormXObjectEnd || fn === OPS.endGroup) ctm = stack.pop() || ctm
    else if (fn === OPS.constructPath) {
      // pdf.js 5+: [команда отрисовки, [Float32Array moveTo/lineTo/curveTo/…/closePath], рамка].
      const op = args?.[0]
      const data = args?.[1]?.[0]
      const stroke = STROKE.has(op)
      const fill = FILL.has(op)
      if ((!stroke && !fill) || !data || typeof data.length !== 'number') continue
      let start = null
      let cur = null
      let pts = []
      let curved = false
      const endSub = () => {
        if (fill && !curved && pts.length >= 4 && pts.length <= 5) filledBox(pts)
        pts = []
        curved = false
      }
      for (let k = 0; k < data.length;) {
        const o = data[k++]
        if (o === 0) { endSub(); cur = start = at(data[k], data[k + 1]); pts = [cur]; k += 2 }
        else if (o === 1) { const p = at(data[k], data[k + 1]); k += 2; if (stroke && cur) segment(cur, p); cur = p; pts.push(p) }
        else if (o === 2) { cur = at(data[k + 4], data[k + 5]); k += 6; curved = true; pts.push(cur) }
        else if (o === 3) { cur = at(data[k + 2], data[k + 3]); k += 4; curved = true; pts.push(cur) }
        else if (o === 4) { if (stroke && cur && start) segment(cur, start); cur = start }
        else break
      }
      endSub()
    }
  }
  return { h: mergeRules(h, 'y', 'x0', 'x1'), v: mergeRules(v, 'x', 'y0', 'y1') }
}

const NO_RULES = { h: [], v: [] }
const rulesOf = (rules, page) => rules?.[page] || NO_RULES
// Середина букв строки (top — базовая линия): линия выше — над строкой, ниже — под ней.
const midOf = (line) => line.top - 0.3 * line.h

// Зоны колонок по шапке: граница между соседними — вертикальная линия между их надписями, если есть (fixed), иначе
// середина промежутка; рядом с числовой колонкой текстовая граница прижата к числовой (не дальше половины высоты
// шрифта): шапку наименования пишут по центру широкой колонки, а само наименование — от левого края, к самому номеру
// строки. numeric — колонки с неузнанной шапкой, где в строках числа («Длина, мм»).
function columnZones(cols, { fixed = new Map(), numeric = new Set() } = {}) {
  const zones = cols.map((c, index) => ({ ...c, index, from: -Infinity, to: Infinity, fixedTo: false }))
  const isNum = (z) => NUMERIC_FIELDS.has(z.field) || numeric.has(z.index)
  for (let i = 0; i + 1 < zones.length; i++) {
    const a = zones[i]
    const b = zones[i + 1]
    let edge
    if (fixed.has(i)) {
      edge = fixed.get(i)
      a.fixedTo = true
    } else {
      const gap = Math.max(0, b.x0 - a.x1)
      const pad = 0.5 * Math.min(a.h, b.h)
      edge = (a.x1 + b.x0) / 2
      if (isNum(a) && !isNum(b)) edge = a.x1 + Math.min(gap / 2, pad)
      else if (!isNum(a) && isNum(b)) edge = b.x0 - Math.min(gap / 2, pad)
    }
    a.to = edge
    b.from = edge
  }
  for (const z of zones) z.numeric = isNum(z)
  return zones
}

// Вертикальные линии между надписями соседних колонок шапки (линия идёт через полосу шапки; допуск — как у
// ruleBetweenWords). Две линии между надписями — пустая колонка без шапки: граница — линия у текстовой колонки (её
// текст — от левого края ячейки).
function ruledEdges(cols, vRules, band) {
  const fixed = new Map()
  const crossing = vRules.filter((r) => r.y0 <= band[1] && r.y1 >= band[0])
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i]
    const b = cols[i + 1]
    const xs = crossing.filter((r) => r.x >= a.x1 - 0.35 * a.h && r.x <= b.x0 + 0.35 * b.h).map((r) => r.x)
    if (!xs.length) continue
    fixed.set(i, NUMERIC_FIELDS.has(b.field) ? Math.min(...xs) : Math.max(...xs))
  }
  return fixed
}

const recognized = (text) => {
  const k = classifyHeader(text)
  return !!k && k.field !== 'skip'
}
const isNumericCluster = (text) => parseNum(text) != null
const lineExtent = (line) => [Math.min(...line.words.map((w) => w.x0)), Math.max(...line.words.map((w) => w.x1))]
// Горизонтальная линия между двумя строками текста, через бо́льшую часть [x0, x1] — граница строки таблицы.
const ruleBetween = (hRules, upper, lower, [x0, x1], frac = 0.6) => hRules.some((r) => r.y > upper.top && r.y < lower.top - 0.6 * lower.h
  && Math.min(r.x1, x1) - Math.max(r.x0, x0) >= frac * (x1 - x0))

// Шапка PDF: начинается со строки, где узнаются хотя бы две колонки, и тянется вниз (перенос, второй ярус), пока
// строки идут плотно (шаг до 2,5 высоты шрифта), в них нет чисел и цифр в колонке наименования (это уже данные:
// «Шов … ДШКА-75-» при цифрах по центру строки ниже), и нет линии через всю таблицу (низ шапки); не больше 8 строк.
// Из вариантов длины — где больше узнанных колонок (неузнанные — в минус: так в шапку не попадают заголовок
// документа и реквизиты над таблицей). Нужны наименование и цена или сумма. rules — линии страниц (rulingsFromOps).
export const HEADER_MAX_LINES = 8
export function detectLinesHeader(lines, from = 0, rules = null) {
  let best = null
  for (let i = from; i < lines.length; i++) {
    if (best && i > best.line + best.span + 2) break
    const pageRules = rulesOf(rules, lines[i].page)
    const cutsOf = (line) => pageRules.v.filter((r) => r.y0 <= midOf(line) && r.y1 >= midOf(line)).map((r) => r.x)
    if (lineClusters(lines[i], cutsOf(lines[i])).filter((c) => recognized(c.text)).length < 2) continue
    const hRules = pageRules.h
    const extent = lineExtent(lines[i])
    // tight — все строки окна идут вплотную (перенос, второй ярус): такое окно при той же оценке длиннее — лучше
    // (остаток шапки не уходит в данные); первая строка данных отстоит дальше, её шапка не забирает.
    let tight = true
    let nameCol = null
    for (let span = 1; span <= HEADER_MAX_LINES && i + span <= lines.length; span++) {
      const last = lines[i + span - 1]
      if (span > 1) {
        const prev = lines[i + span - 2]
        if (last.page !== prev.page || last.top - prev.top > 2.5 * last.h) break
        const clusters = lineClusters(last, cutsOf(last))
        if (clusters.some((c) => isNumericCluster(c.text))) break
        if (nameCol && clusters.some((c) => overlaps(c, nameCol) && /[0-9]/.test(c.text))) break
        if (ruleBetween(hRules, prev, last, extent)) break
        if (last.top - prev.top > 1.35 * last.h) tight = false
      }
      const cols = headerColumnsFromLines(lines.slice(i, i + span), cutsOf).map((c) => ({ ...c, ...(classifyHeader(c.text) || { field: null }) }))
      const picked = pickColumns(cols.filter((c) => c.field))
      if (!picked) continue
      nameCol = picked.name
      const score = columnScore(picked) - 0.25 * cols.filter((c) => !c.field).length
      if (!best || score > best.score || (score === best.score && tight && best.line === i)) best = { line: i, span, score, cols }
    }
  }
  if (!best) return null
  const first = lines[best.line]
  const lastLine = lines[best.line + best.span - 1]
  const fixed = ruledEdges(best.cols, rulesOf(rules, first.page).v, [first.top - first.h, lastLine.top])
  const zones = columnZones(best.cols, { fixed })
  return { line: best.line, span: best.span, cols: best.cols, fixed, zones, columns: pickColumns(zones.filter((z) => z.field && z.field !== 'skip')) }
}

// Слова строки для колонок: число с пробелами-разрядами («1 234 567,89») — одним словом, даже если части — разные
// куски текста pdf.js (вплотную, не дальше трети высоты шрифта); через линию рамки (cuts) — нет: «48» и «500,00»
// соседних ячеек — два числа.
function lineTokens(line, cuts = null) {
  const out = []
  for (const w of line.words) {
    const prev = out[out.length - 1]
    if (prev && prev.groups && (prev.item === w.item || w.x0 - prev.x1 < 0.35 * w.h) && /^[0-9]{3}([.,][0-9]+)?$/.test(w.text)
      && !ruleBetweenWords(cuts, prev, w)) {
      out[out.length - 1] = { ...prev, text: `${prev.text} ${w.text}`, x1: w.x1, item: w.item, groups: /^[0-9]{3}$/.test(w.text) }
    } else {
      out.push({ ...w, groups: /^[-−]?[0-9]{1,3}$/.test(w.text) })
    }
  }
  return out
}

// Слова строки → колонки по зонам: текст — по середине слова, число — у правого края (числа пишут по правому краю
// колонки, и левая часть широкого числа заходит в соседнюю зону). Граница по линии таблицы (или просвету) — точная:
// число за ней — по середине.
const zoneAt = (zones, x) => zones.find((z) => x >= z.from && x < z.to) || zones[zones.length - 1]
function assignWords(line, zones) {
  const cells = new Map()
  const cuts = zones.filter((z) => z.fixedTo).map((z) => z.to)
  for (const w of lineTokens(line, cuts)) {
    let z = zoneAt(zones, (w.x0 + w.x1) / 2)
    if (parseNum(w.text) != null && !z.fixedTo) z = zoneAt(zones, w.x1 - 0.25 * w.h)
    if (!cells.has(z.index)) cells.set(z.index, [])
    cells.get(z.index).push(w)
  }
  return cells
}

// Самый широкий просвет по x в [lo, hi], которого не касается ни одно слово строк данных.
function widestHole(words, lo, hi) {
  const spans = words.filter((w) => w.x1 > lo && w.x0 < hi).map((w) => [Math.max(lo, w.x0), Math.min(hi, w.x1)]).sort((p, q) => p[0] - q[0])
  let best = null
  let x = lo
  for (const [a, b] of spans) {
    if (a > x && (!best || a - x > best.w)) best = { w: a - x, mid: (x + a) / 2, edge: x }
    x = Math.max(x, b)
  }
  return best
}

// Зоны по строкам данных: колонка с неузнанной шапкой, где под надписью шапки почти одни числа («Длина, мм»), —
// числовая (слова у края — это наименование, заехавшее из соседней колонки, их не считаем); граница двух текстовых
// колонок без линии — по самому широкому просвету в данных между началами их надписей (артикул «0805033-М» шире
// шапки «Артикул», а наименование начинается левее шапки «Наименование» — середина промежутка шапок резала слово).
// Шапка колонки ед. изм. не узнана («Изм.», на скане — чепуха), а под ней единицы — это она: без единицы цена не сравнится.
const UNIT_CELL_RE = /^(теор\.?\s?т|[тt]|тн|тонн\S*|шт|штук\S*|м|мп|м\.п|п\.м|пог\.?\s?м|м2|м3|м²|м³|кг|л|уп|упак\S*|компл\S*|кмп|рул\S*|бухт\S*|пар\S*|набор\S*)\.?$/
function refineZones(first, body) {
  const words = body.flatMap(({ line }) => lineTokens(line))
  const numeric = new Set()
  let cols = first.cols
  const under = (c) => words.filter((w) => (w.x0 + w.x1) / 2 >= c.x0 - c.h && (w.x0 + w.x1) / 2 <= c.x1 + c.h)
  cols.forEach((c, i) => {
    if (c.field) return
    const list = under(c)
    const num = list.filter((w) => parseNum(w.text) != null).length
    if (num >= 2 && num >= 0.6 * list.length) numeric.add(i)
  })
  if (!cols.some((c) => c.field === 'unit')) {
    const k = cols.findIndex((c, i) => {
      if (c.field || numeric.has(i)) return false
      const list = under(c)
      return list.length >= 1 && list.filter((w) => UNIT_CELL_RE.test(norm(w.text))).length >= 0.6 * list.length
    })
    if (k >= 0) cols = cols.map((c, i) => (i === k ? { ...c, field: 'unit' } : c))
  }
  const header = { ...first, cols }
  const fixed = new Map(header.fixed)
  const isNum = (i) => NUMERIC_FIELDS.has(header.cols[i].field) || numeric.has(i)
  for (let i = 0; i + 1 < header.cols.length; i++) {
    if (fixed.has(i) || isNum(i) || isNum(i + 1)) continue
    const a = header.cols[i]
    const b = header.cols[i + 1]
    const hole = widestHole(words, a.x0 + 0.5, b.x0)
    if (hole && hole.w >= 0.3 * Math.min(a.h, b.h)) fixed.set(i, hole.mid)
  }
  const zones = columnZones(header.cols, { fixed, numeric })
  return { ...header, zones, columns: pickColumns(zones.filter((z) => z.field && z.field !== 'skip')) }
}

// Порог «перенос внутри ячейки / новая строка таблицы»: шаги между строками (в высотах шрифта) делятся на две
// группы по самому большому скачку. Шаги меньше 0,9 (цифры по центру двухстрочной ячейки — между строками
// наименования) — всегда перенос и в поиске скачка не участвуют. Двух групп нет (строки вплотную или каждая
// строка — своя строка таблицы) — порога нет: строки делит цена (anchorRows).
function wrapLimit(steps) {
  const r = steps.filter((s) => s >= 0.9 && s < 6).sort((p, q) => p - q)
  let best = null
  for (let i = 0; i + 1 < r.length; i++) {
    const jump = r[i + 1] / r[i]
    if (jump > 1.12 && r[i] <= 1.4 && (!best || jump > best.jump)) best = { jump, limit: Math.sqrt(r[i] * r[i + 1]) }
  }
  return best ? best.limit : Infinity
}

// Строки текста одной полосы (между линиями таблицы или промежутками) → строки таблицы. Строка таблицы держится
// на «якоре» — строке текста с числами в колонках количества, цены и суммы (хвост перенесённого числа — «450,00» под
// «18» — не якорь); у одного якоря полоса — одна строка. Несколько якорей: номер строки в первой строке полосы —
// каждая строка с номером начинает строку таблицы (по верху); иначе граница между соседними якорями — по самому
// широкому промежутку, а при равных — по выравниванию полосы: текста над первым якорем нет — по верху (всё между
// якорями — продолжение верхнего), под последним нет — по низу, есть и там и там — по центру (пополам). Полоса между
// линиями рамки (ruled) делится только по номерам строк: линии уже разделили строки, а несколько якорей в ячейке —
// это переносы.
function anchorRows(block, isAnchor, isNumbered, ruled) {
  const anchors = block.map((b, k) => (isAnchor(b, block[k - 1]) ? k : -1)).filter((k) => k >= 0)
  if (anchors.length <= 1) return [block]
  const numbered = block.map((b, k) => (isNumbered(b) ? k : -1)).filter((k) => k >= 0)
  const starts = new Set([0])
  if (numbered.length >= 2 && numbered[0] === 0) {
    for (const k of numbered) starts.add(k)
  } else if (ruled) {
    return [block]
  } else {
    const step = (k) => (block[k + 1].line.top - block[k].line.top) / block[k + 1].line.h
    const prefix = anchors[0]
    const suffix = block.length - 1 - anchors[anchors.length - 1]
    for (let j = 0; j + 1 < anchors.length; j++) {
      const a = anchors[j]
      const b = anchors[j + 1]
      const m = b - a - 1
      let cut = a + 1
      if (m > 0) {
        const gaps = []
        for (let k = a; k < b; k++) gaps.push({ k, s: step(k) })
        const sorted = [...gaps].sort((p, q) => q.s - p.s)
        if (sorted[0].s >= 1.2 * sorted[1].s) cut = sorted[0].k + 1
        else cut = a + 1 + (prefix === 0 ? m : suffix === 0 ? 0 : Math.round((m * suffix) / (prefix + suffix)))
      }
      starts.add(cut)
    }
  }
  const out = []
  let cur = null
  block.forEach((b, k) => {
    if (starts.has(k) || !cur) { cur = []; out.push(cur) }
    cur.push(b)
  })
  return out
}

// Строки PDF после шапки → строки документа. Таблица кончается на «Итого / Всего»; на следующей странице — повтор
// шапки (пропускается) или продолжение без шапки. Строки таблицы: на странице с линиями между строками данных —
// по линиям (полоса между соседними линиями — строка таблицы); без линий — по промежуткам (wrapLimit). Внутри
// полосы — по якорям (anchorRows). Тексты колонки складываются сверху вниз.
export function pdfRows(lines, first, rules = null) {
  const out = []
  let i = first.line + first.span
  let headerPage = lines[first.line]?.page
  const body = []
  // «Итого по разделу» посреди таблицы — пропустить, если ниже есть ещё строки с ценами; итог всего документа — конец.
  const moreRowsBelow = (from) => {
    const numCols = [...first.columns.prices, ...first.columns.sums]
    for (let k = from + 1; k < Math.min(lines.length, from + 60); k++) {
      if (FINAL_TOTAL_RE.test(norm(lineText(lines[k])))) return !SUBTOTAL_RE.test(norm(lineText(lines[k]))) && k > from + 1
      const cells = assignWords(lines[k], first.zones)
      if (numCols.some((c) => (cells.get(c.index) || []).some((w) => parseNum(w.text) != null))) return true
    }
    return false
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const text = norm(lineText(line))
    if (line.page !== headerPage) {
      // Новая страница: та же шапка — пропустить её строки.
      const again = detectLinesHeader(lines.slice(i, i + 6), 0, rules)
      if (again && again.line === 0 && again.columns.name) { i += again.span - 1; headerPage = line.page; continue }
      headerPage = line.page
    }
    const cells = assignWords(line, first.zones)
    const nameText = norm((cells.get(first.columns.name.index) || []).map((w) => w.text).join(' '))
    if (TOTAL_RE.test(text) || TOTAL_RE.test(nameText)) {
      if ((SUBTOTAL_RE.test(text) || SUBTOTAL_RE.test(nameText)) && moreRowsBelow(i)) continue
      break
    }
    body.push({ line })
  }
  // Итоги — строки сразу под таблицей (числа: «83 067,54» — два слова, поэтому по тексту строки).
  const totals = []
  for (let k = i; k < Math.min(lines.length, i + 8); k++) {
    const t = norm(lineText(lines[k]))
    if (!isFinalTotal(t)) continue
    for (const m of lineText(lines[k]).matchAll(/[0-9]{1,3}(?:[ \u00a0][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?/g)) {
      const n = parseNum(m[0])
      if (n > 0) totals.push(n)
    }
  }
  const header = refineZones(first, body)
  const zones = header.zones
  const cols = header.columns
  for (const b of body) b.cells = assignWords(b.line, zones)

  // Якорь — числа хотя бы в двух из колонок количества, цены и суммы (в одной, если такая колонка одна). Хвост
  // перенесённого числа («450,00» под «18», «000,00» под «5») — продолжение строки выше, не якорь.
  const numCols = [cols.qty, ...cols.prices, ...cols.sums].filter(Boolean)
  const need = Math.min(2, numCols.length)
  const numbersIn = (b, c) => (b.cells.get(c.index) || []).filter((w) => parseNum(w.text) != null)
  const isAnchor = (b, prev) => {
    const filled = numCols.filter((c) => numbersIn(b, c).length)
    if (filled.length < need) return false
    return !prev || !filled.every((c) => {
      const head = numbersIn(prev, c)
      const tail = numbersIn(b, c)
      return head.length && /^[-−]?[0-9]{1,3}$/.test(head[head.length - 1].text) && /^[0-9]{3}([.,][0-9]+)?$/.test(tail[0].text)
    })
  }
  const numIndex = cols.num?.index
  const isNumbered = (b) => {
    const ws = numIndex != null ? (b.cells.get(numIndex) || []) : []
    return ws.length === 1 && /^[0-9]{1,4}\.?$/.test(ws[0].text)
  }

  const nameCenter = (cols.name.x0 + cols.name.x1) / 2
  const blocks = []
  const ruledBlocks = new Set()
  for (const page of [...new Set(body.map((b) => b.line.page))]) {
    const onPage = body.filter((b) => b.line.page === page)
    const hRules = rulesOf(rules, page).h.filter((r) => r.x0 <= nameCenter && r.x1 >= nameCenter)
    const inside = onPage.length > 1 && hRules.some((r) => r.y > midOf(onPage[0].line) && r.y < midOf(onPage[onPage.length - 1].line))
    let limit = Infinity
    if (!inside) {
      const steps = []
      for (let k = 1; k < onPage.length; k++) steps.push((onPage[k].line.top - onPage[k - 1].line.top) / onPage[k].line.h)
      limit = wrapLimit(steps)
    }
    let cur = null
    onPage.forEach((b, k) => {
      const prev = onPage[k - 1]
      const split = !prev || (inside
        ? hRules.some((r) => r.y > midOf(prev.line) && r.y < midOf(b.line))
        : (b.line.top - prev.line.top) / b.line.h > limit)
      if (split) { cur = []; blocks.push(cur); if (inside) ruledBlocks.add(cur) }
      cur.push(b)
    })
  }
  const rows = blocks.flatMap((block) => anchorRows(block, isAnchor, isNumbered, ruledBlocks.has(block)))
  for (const row of rows) {
    const words = new Map()
    for (const { cells } of row) {
      for (const [idx, ws] of cells) {
        if (!words.has(idx)) words.set(idx, [])
        words.get(idx).push(ws.map((w) => w.text).join(' '))
      }
    }
    out.push({ words, page: row[0].line.page })
  }
  // Текст колонки — строки сверху вниз; перенос по дефису склеивается («Сигмавент-90-» + «НО» → «Сигмавент-90-НО»).
  const text = (row, col) => (col ? joinWrapped(row.words.get(col.index) || []) : undefined)
  const result = out.map((row) => ({
    cells: {
      num: text(row, cols.num), name: text(row, cols.name), name2: text(row, cols.name2), code: text(row, cols.code), code2: text(row, cols.code2), unit: text(row, cols.unit),
      qty: text(row, cols.qty), pack: text(row, cols.pack), vat: text(row, cols.vat), vatRate: text(row, cols.vatRate), delivery: text(row, cols.delivery),
      prices: cols.prices.map((c) => text(row, c)), sums: cols.sums.map((c) => text(row, c)),
    },
    page: row.page + 1,
  }))
  // Где таблица кончилась (искать следующую) и её итоги.
  result.end = i
  result.totals = totals
  return result
}

// ── Строки документа → позиции ───────────────────────────────────────────────────────────────────────
// Ответ: [{ name, name2, code, code2, unit, qty, packQty, price, priceVat, sum, sumVat, sumOff, per, vatRate, delivery, deliveryDoc, source }]:
// name2 — второе наименование строки («по запросу»); code — артикул, code2 — второй код той же строки (внутренний код
// поставщика, если есть и артикул); packQty — сколько в упаковке (колонка); per — цена в документе была за столько
// единиц, price уже за одну; sumOff — цена × количество не сходится с суммой; price /
// sum — как в документе (первая колонка с НДС, иначе первая указанная), priceVat / sumVat — их 'gross' / 'net' /
// null; delivery — сама строка — доставка; deliveryDoc — колонка доставки строки { value, perUnit, vat } или null.
// Строка доставки: «Доставка …» где угодно, «Транспортные услуги», «Услуги по перевозке», «Разгрузка …» — а не
// товар со словом «транспортная» («Тележка транспортная»).
const DELIVERY_ROW_RE = /доставк|транспортн\S*\s+(услуг|расход)|услуг\S*\s+(по\s+)?(перевоз|транспорт|экспедир|разгруз|погруз)|^(перевозк|экспедир|разгрузк|погрузк)/
// keepBlank — оставить строки с ед. изм. и без цены (незаполненный ВОР: по ним можно показать договорные цены).
// Цена не за единицу (шапка) или не сходится с суммой: { per, off, unit }. per — за сколько единиц цена в документе;
// ед. изм. шапки («Цена за км») важнее пустой колонки. Сравниваем цену × количество с суммой: в пределах 0,7…1,4 — та же
// цена (колонки бывают с НДС и без); в 10, 100, 1000 раз больше — цена за столько единиц; иначе off. skip — сумма не
// только за эту цену (материалы и работы, доставка отдельно).
function priceScale(price, qty, sum, unit, skip) {
  let per = 1
  let u = unit
  if (price.per) {
    const same = !unit || canonUnit(unit) === price.per.unit
    if (same && price.per.n > 1) per = price.per.n
    if (!unit) u = price.per.n > 1 ? price.per.unit : price.per.unit
    else if (!same && price.per.n === 1) u = price.per.unit
  }
  if (skip || !(price.v > 0 && qty > 0 && sum > 0)) return { per, off: false, unit: u }
  const r = ((price.v / per) * qty) / sum
  if (r >= 0.7 && r <= 1.4) return { per, off: false, unit: u }
  if (per === 1) {
    for (const k of [10, 100, 1000]) if (r / k >= 0.7 && r / k <= 1.4) return { per: k, off: false, unit: u }
  }
  return { per, off: true, unit: u }
}

// Две колонки цены или суммы — материалы и работы — у строки есть и parts: { material, work } (сравнение с договорными
// расценками: у них тоже две цены), цена строки остаётся прежней, первой.
const PART_RE = { material: /материал|оборудован/, work: /работ|смр|пнр|монтаж|услуг/ }
export function itemsFromRows(rows, columns, { keepBlank = false } = {}) {
  const pick = (values, cols) => {
    const list = cols.map((c, i) => ({ v: parseNum(values?.[i]), vat: c.vat, per: c.per }))
    return list.find((x) => x.v != null && x.vat === 'gross') || list.find((x) => x.v != null && x.vat !== 'net')
      || list.find((x) => x.v != null) || { v: null, vat: null, per: null }
  }
  // Колонка одного вида: «Стоимость материалов и работ» — обе сразу, это не разбивка.
  const ofKind = (list, kind) => list.map((col, i) => ({ col, i })).filter(({ col }) => {
    const t = norm(col.text || '')
    return PART_RE[kind].test(t) && !PART_RE[kind === 'work' ? 'material' : 'work'].test(t)
  })
  const twoParts = ['material', 'work'].every((kind) => ofKind(columns.prices, kind).length + ofKind(columns.sums, kind).length > 0)
  const partOf = (c, kind) => {
    const prices = ofKind(columns.prices, kind)
    const sums = ofKind(columns.sums, kind)
    const price = pick(prices.map((x) => c.prices?.[x.i]), prices.map((x) => x.col))
    const sum = pick(sums.map((x) => c.sums?.[x.i]), sums.map((x) => x.col))
    return { price: price.v, priceVat: price.vat, sum: sum.v, sumVat: sum.vat }
  }
  const items = []
  for (const r of rows) {
    const c = r.cells
    const name = cellText(c.name)
    if (!name || COLUMN_NUMBERS_RE.test(name) || TOTAL_RE.test(name.toLowerCase())) continue
    const price = pick(c.prices, columns.prices)
    const sum = pick(c.sums, columns.sums)
    const qty = parseNum(c.qty)
    if (price.v == null && sum.v == null && !(keepBlank && cellText(c.unit))) continue
    if ((price.v ?? 0) < 0 || (sum.v ?? 0) < 0) continue
    const rate = parseNum(c.vatRate)
    const del = columns.delivery ? parseNum(c.delivery) : null
    const unit = cellText(c.unit) || null
    const scaled = priceScale(price, qty, sum.v, unit, twoParts || del != null)
    const packMatch = /[0-9]+(?:[.,][0-9]+)?/.exec(cellText(c.pack))
    const packQty = packMatch ? parseNum(packMatch[0]) : null
    items.push({
      name,
      name2: cellText(c.name2) || null,
      code: cellText(c.code) || null,
      code2: cellText(c.code2) || null,
      unit: scaled.unit,
      qty: qty != null && qty > 0 ? qty : null,
      packQty: packQty > 1 ? packQty : null,
      price: price.v != null && scaled.per > 1 ? price.v / scaled.per : price.v,
      priceVat: price.vat,
      per: scaled.per > 1 ? scaled.per : null,
      sum: sum.v,
      sumVat: sum.vat,
      sumOff: scaled.off,
      vatRate: rate != null && rate > 0 && rate < 50 ? rate : null,
      delivery: DELIVERY_ROW_RE.test(name.toLowerCase()),
      deliveryDoc: del != null && del > 0 ? { value: del, perUnit: !!columns.delivery.perUnit, vat: columns.delivery.vat || null } : null,
      source: r.row ? `строка ${r.row}` : r.page ? `стр. ${r.page}` : null,
      ...(twoParts ? { parts: { material: partOf(c, 'material'), work: partOf(c, 'work') } } : {}),
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

// Доставка строки за единицу с НДС (колонка доставки документа): сумма по строке — на количество; НДС — как у цены
// (своя пометка колонки «с НДС» / «без НДС» — по ней). Нет колонки или значения — null.
export function deliveryUnitWithVat(item, vat) {
  const d = item.deliveryDoc
  if (!d || !(d.value > 0)) return null
  const unit = d.perUnit ? d.value : item.qty > 0 ? d.value / item.qty : null
  if (unit == null) return null
  return unitPriceWithVat({ price: unit, priceVat: d.vat ?? (item.price != null ? item.priceVat : item.sumVat), sum: null, sumVat: null, qty: null, vatRate: item.vatRate }, vat)
}
