// Правка книги .xlsx на уровне XML: меняются только нужные ячейки, всё остальное — оформление, формулы, проверки данных
// (выпадающие списки), ширины, скрытые листы, печать — остаётся байт в байт. Библиотека Excel тут не нужна: модуль работает с
// текстом XML, архив открывает вызывающий (pizzip). Проверяется в node без браузера.
//
// Помощники attr / setAttr / путь листа — те же, что у копии с ошибками ПСДЦ (psdcWorkbook.js); здесь отдельно, чтобы кабинет
// подрядчика не подгружал с ними xlsx-js-style.

export const xmlDecode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// Текст в XML: экранирование и без управляющих символов (кроме табуляции и переводов строки) — их XML не допускает.
export const xmlEscape = (s) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function attr(tag, name) {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? xmlDecode(m[1] ?? m[2]) : null
}

export function setAttr(tag, name, value) {
  const re = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`)
  if (re.test(tag)) return tag.replace(re, ` ${name}="${value}"`)
  return tag.replace(/^(<[\w:]+)/, `$1 ${name}="${value}"`)
}

// «A» → 1, «AA» → 27.
export function colIndex(letters) {
  let n = 0
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

// 1 → «A», 27 → «AA».
export function colLetters(n) {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

const resolvePath = (base, target) => {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `${base}/${target}`.split('/')
  const out = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p && p !== '.') out.push(p)
  }
  return out.join('/')
}

// Имя листа → путь его XML в архиве (по xl/workbook.xml и его связям).
export function sheetPaths(zip) {
  const workbook = zip.file('xl/workbook.xml')?.asText()
  const rels = zip.file('xl/_rels/workbook.xml.rels')?.asText()
  const out = new Map()
  if (!workbook || !rels) return out
  const targets = new Map()
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id'), attr(m[0], 'Target') || '')
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const idMatch = /\s[\w]+:id=(?:"([^"]*)"|'([^']*)')/.exec(m[0])
    const target = idMatch ? targets.get(idMatch[1] ?? idMatch[2]) : null
    if (target) out.set(attr(m[0], 'name'), resolvePath('xl', target))
  }
  return out
}

// Excel пересчитывает все формулы при открытии: суммы, ВПР/XLOOKUP и итоги книги встанут по вписанным ценам. Нет calcPr — ставим его на
// место по схеме (после definedNames / externalReferences / functionGroups / sheets), иначе Excel предложит «восстановить» книгу.
export function setFullCalcOnLoad(xml) {
  const calc = /<((?:\w+:)?)calcPr\b[^>]*?\/?>/.exec(xml)
  if (calc) {
    const closing = calc[0].endsWith('/>') ? '/>' : '>'
    const open = calc[0].slice(0, -closing.length)
    return xml.replace(calc[0], setAttr(open, 'fullCalcOnLoad', '1') + closing)
  }
  const prefix = (/<((?:\w+:)?)workbook\b/.exec(xml) || [])[1] || ''
  for (const tag of ['definedNames', 'externalReferences', 'functionGroups', 'sheets']) {
    const m = new RegExp(`</${prefix}${tag}>|<${prefix}${tag}\\b[^>]*/>`).exec(xml)
    if (m) {
      const at = m.index + m[0].length
      return `${xml.slice(0, at)}<${prefix}calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`
    }
  }
  return xml
}

// Убрать сохранённые результаты формул листа (сами формулы остаются): после правки входных ячеек прежние итоги неверны, а LibreOffice и
// просмотрщики, в отличие от Excel, не пересчитывают книгу с сохранёнными результатами (проверено: итог листа оставался старым).
// Формулу без результата считает любая программа при открытии. shouldStrip({ col, formula }) — убирать ли результат этой ячейки (col —
// номер колонки с 1 или null, formula — текст формулы; у продолжения общей формулы он пустой): результаты, от цен не зависящие (объёмы),
// лучше оставить — их видит и программа, которая книгу не считает (защищённый просмотр Excel, предпросмотр письма). → { xml, cleared }.
export function stripFormulaValues(xml, shouldStrip = () => true) {
  let cleared = 0
  // Открывающий тег — не пустая ячейка «<c …/>»; до «<f» не выходим за «</c>» своей ячейки.
  const out = String(xml).replace(/<((?:\w+:)?)c\b([^>]*?)(?<!\/)>((?:(?!<\/\1c>)[\s\S])*?<\1f\b[\s\S]*?)<\/\1c>/g, (whole, p, attrs, body) => {
    const v = new RegExp(`<${p}v>[\\s\\S]*?</${p}v>|<${p}v/>`)
    if (!v.test(body)) return whole
    const letters = (/^([A-Z]+)/i.exec(attr(`<c${attrs}>`, 'r') || '') || [])[1]
    const formula = xmlDecode((new RegExp(`<${p}f\\b[^>]*>([\\s\\S]*?)</${p}f>`).exec(body) || [])[1] || '')
    if (!shouldStrip({ col: letters ? colIndex(letters) : null, formula })) return whole
    cleared += 1
    // Тип сохранённого результата (t="str" / "b" / "e") без результата не нужен.
    const cAttrs = attrs.replace(/\st=(?:"[^"]*"|'[^']*')/, '')
    return `<${p}c${cAttrs}>${body.replace(v, '')}</${p}c>`
  })
  return { xml: out, cleared }
}

// Результаты формул листа (ВОР с ценами, 25.11.2026): decide({ ref, col, formula }) → { value: число } — записать посчитанный результат
// (сама формула остаётся; защищённый просмотр Excel, почта и разборщики видят верные итоги без пересчёта), { strip: true } — убрать
// сохранённый результат (книгу посчитает программа при открытии), null — оставить как есть. → { xml, written, cleared }.
export function setFormulaValues(xml, decide) {
  let written = 0
  let cleared = 0
  const out = String(xml).replace(/<((?:\w+:)?)c\b([^>]*?)(?<!\/)>((?:(?!<\/\1c>)[\s\S])*?<\1f\b[\s\S]*?)<\/\1c>/g, (whole, p, attrs, body) => {
    const ref = attr(`<c${attrs}>`, 'r') || ''
    const letters = (/^([A-Z]+)/i.exec(ref) || [])[1]
    const formula = xmlDecode((new RegExp(`<${p}f\\b[^>]*>([\\s\\S]*?)</${p}f>`).exec(body) || [])[1] || '')
    const d = decide({ ref, col: letters ? colIndex(letters) : null, formula })
    if (!d) return whole
    const v = new RegExp(`<${p}v>[\\s\\S]*?</${p}v>|<${p}v/>`)
    // Тип прежнего результата (t="str" / "b" / "e") новому числу (и пустоте) не подходит.
    const cAttrs = attrs.replace(/\st=(?:"[^"]*"|'[^']*')/, '')
    if (d.strip) {
      if (!v.test(body)) return whole
      cleared += 1
      return `<${p}c${cAttrs}>${body.replace(v, '')}</${p}c>`
    }
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) return whole
    written += 1
    const value = `<${p}v>${String(d.value)}</${p}v>`
    if (v.test(body)) return `<${p}c${cAttrs}>${body.replace(v, value)}</${p}c>`
    // Результата не было — сразу после формулы (порядок по схеме: f, v, is).
    return `<${p}c${cAttrs}>${body.replace(new RegExp(`<${p}f\\b[^>]*/>|<${p}f\\b[^>]*>[\\s\\S]*?</${p}f>`), (f) => f + value)}</${p}c>`
  })
  return { xml: out, written, cleared }
}

// Скрытые строки листа (номера с нуля) — SUBTOTAL по ним считает программа, не мы.
export function hiddenRowNumbers(xml) {
  const out = new Set()
  for (const m of String(xml).matchAll(/<(?:\w+:)?row\b[^>]*>/g)) {
    const h = attr(m[0], 'hidden')
    if (h === '1' || h === 'true') out.add(Number(attr(m[0], 'r')) - 1)
  }
  return out
}

// Проверки данных листа (выпадающие списки) → [{ s: { r, c }, e: { r, c } }] (с нуля, как у SheetJS).
export function dataValidationRanges(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<(?:\w+:)?dataValidation\b[^>]*>/g)) {
    for (const ref of String(attr(m[0], 'sqref') || '').split(/\s+/).filter(Boolean)) {
      const [a, b = a] = ref.replace(/\$/g, '').split(':')
      const pa = /^([A-Z]+)(\d+)$/i.exec(a)
      const pb = /^([A-Z]+)(\d+)$/i.exec(b)
      if (!pa || !pb) continue
      out.push({ s: { r: Number(pa[2]) - 1, c: colIndex(pa[1]) - 1 }, e: { r: Number(pb[2]) - 1, c: colIndex(pb[1]) - 1 } })
    }
  }
  return out
}

// Стиль колонки (<cols><col min max style>) — для ячейки, которой в строке ещё нет.
function colStyles(xml, p) {
  const list = []
  const cols = new RegExp(`<${p}cols\\b[^>]*>([\\s\\S]*?)</${p}cols>`).exec(xml)
  if (cols) {
    for (const m of cols[1].matchAll(new RegExp(`<${p}col\\b[^>]*>`, 'g'))) {
      const style = attr(m[0], 'style')
      if (style != null) list.push({ min: Number(attr(m[0], 'min')), max: Number(attr(m[0], 'max')), style })
    }
  }
  return (col) => list.find((c) => col >= c.min && col <= c.max)?.style ?? null
}

const numberText = (v) => {
  const s = String(v)
  return /e/i.test(s) ? v.toFixed(10).replace(/\.?0+$/, '') : s
}

function cellXml(p, ref, style, value) {
  const s = style != null ? ` s="${style}"` : ''
  if (typeof value === 'number') return `<${p}c r="${ref}"${s}><${p}v>${numberText(value)}</${p}v></${p}c>`
  return `<${p}c r="${ref}"${s} t="inlineStr"><${p}is><${p}t xml:space="preserve">${xmlEscape(value)}</${p}t></${p}is></${p}c>`
}

// Вписать значения в лист. edits — Map(номер строки с 1 → Map(номер колонки с 1 → число | строка)). Ячейка с формулой не трогается
// (её считает книга) — она попадает в skipped. Стиль ячейки (s) сохраняется; новой ячейке — стиль строки (customFormat) или колонки.
// Один проход по строкам листа: недостающие строки и ячейки встают на место по порядку. → { xml, written, skipped }.
export function patchSheetXml(xml, edits) {
  const sd = /<((?:\w+:)?)sheetData\b[^>]*?(\/>|>)/.exec(xml)
  if (!sd) throw new Error('в листе нет таблицы ячеек')
  const p = sd[1]
  const styleOfCol = colStyles(xml, p)
  const pending = [...edits.keys()].filter((r) => edits.get(r)?.size).sort((a, b) => a - b)
  let pi = 0
  let written = 0
  const skipped = []

  const newCell = (rowNum, col, value, rowStyle) => {
    written += 1
    return { col, xml: cellXml(p, `${colLetters(col)}${rowNum}`, rowStyle ?? styleOfCol(col), value) }
  }
  const buildRow = (rowNum) => {
    const cells = [...edits.get(rowNum)].sort((a, b) => a[0] - b[0]).map(([col, v]) => newCell(rowNum, col, v, null).xml)
    return `<${p}row r="${rowNum}">${cells.join('')}</${p}row>`
  }
  const rewriteRow = (rowNum, attrs, inner) => {
    const want = edits.get(rowNum)
    const rowTag = `<row${attrs}>`
    const rowStyle = attr(rowTag, 'customFormat') === '1' || attr(rowTag, 'customFormat') === 'true' ? attr(rowTag, 's') : null
    const cells = []
    const seen = new Set()
    let lastCol = 0
    const cellRe = new RegExp(`<${p}c\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${p}c>)`, 'g')
    const rest = String(inner || '').replace(cellRe, (whole, cAttrs, _tail, body) => {
      const ref = attr(`<c${cAttrs}>`, 'r')
      const letters = ref ? (/^([A-Z]+)/i.exec(ref) || [])[1] : null
      const col = letters ? colIndex(letters) : lastCol + 1
      lastCol = col
      if (!want.has(col)) { cells.push({ col, xml: whole }); return '' }
      seen.add(col)
      if (new RegExp(`<${p}f[\\s>/]`).test(body || '')) {
        skipped.push(`${colLetters(col)}${rowNum}`)
        cells.push({ col, xml: whole })
        return ''
      }
      written += 1
      cells.push({ col, xml: cellXml(p, `${colLetters(col)}${rowNum}`, attr(`<c${cAttrs}>`, 's'), want.get(col)) })
      return ''
    })
    let added = false
    for (const [col, v] of want) {
      if (seen.has(col)) continue
      cells.push(newCell(rowNum, col, v, rowStyle))
      added = true
    }
    cells.sort((a, b) => a.col - b.col)
    // spans — подсказка Excel о крайних ячейках строки; новая ячейка может выйти за неё — тогда подсказку убираем.
    const outAttrs = added ? attrs.replace(/\sspans=(?:"[^"]*"|'[^']*')/, '') : attrs
    return `<${p}row${outAttrs}>${cells.map((c) => c.xml).join('')}${rest}</${p}row>`
  }

  if (sd[2] === '/>') {
    const rows = pending.map(buildRow).join('')
    return { xml: xml.replace(sd[0], `${sd[0].slice(0, -2)}>${rows}</${p}sheetData>`), written, skipped }
  }
  const start = sd.index + sd[0].length
  const end = xml.indexOf(`</${p}sheetData>`, start)
  if (end < 0) throw new Error('лист повреждён')
  let lastRow = 0
  const rowRe = new RegExp(`<${p}row\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${p}row>)`, 'g')
  const body = xml.slice(start, end).replace(rowRe, (whole, attrs, _tail, inner) => {
    const rowNum = Number(attr(`<row${attrs}>`, 'r')) || lastRow + 1
    lastRow = rowNum
    let before = ''
    while (pi < pending.length && pending[pi] < rowNum) before += buildRow(pending[pi++])
    if (pi < pending.length && pending[pi] === rowNum) {
      pi += 1
      return before + rewriteRow(rowNum, attrs, inner)
    }
    return before + whole
  })
  let after = ''
  while (pi < pending.length) after += buildRow(pending[pi++])
  return { xml: xml.slice(0, start) + body + after + xml.slice(end), written, skipped }
}
