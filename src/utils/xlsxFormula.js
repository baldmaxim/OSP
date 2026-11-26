// Результаты формул книги ВОР после того, как в неё вписаны цены подрядчика (просьба пользователя 25.11.2026: «проверь, что работают
// формулы и корректно лист КП отображается»). Excel открывает скачанный с сайта файл в защищённом просмотре и книгу не пересчитывает —
// видны сохранённые результаты формул; без них «КП» был пустым (нулями), пока подрядчик не нажмёт «Разрешить редактирование». Почтовый
// предпросмотр и разборщики портала (SheetJS) тоже читают только сохранённые результаты.
//
// Здесь — маленький вычислитель для того набора функций, что есть в шаблоне ВОР отдела (выгрузка Estimat: «КП» — XLOOKUP по
// «МАТЕРИАЛАМ» / «РАБОТАМ», SUMPRODUCT, SUM, SUBTOTAL(9), произведения; «МАТЕРИАЛЫ» / «РАБОТЫ» — SUMIFS по «КП»), и ещё нескольких
// простых. Правило — «посчитано наверняка или никак»: любая незнакомая функция, имя, ссылка на внешнюю книгу или на незагруженный лист,
// массив, скрытая строка под SUBTOTAL, кольцевая ссылка — ячейка «не посчитана», и все, что от неё зависят, тоже (исключение летит вверх по
// цепочке). Такие ячейки вызывающий оставляет как раньше (результат убирается, книгу считает программа при открытии). Ошибка Excel
// (#ДЕЛ/0!, #Н/Д…) — тоже значение: IFERROR её ловит; итог-ошибку вызывающий не записывает.
//
// Модуль без библиотеки Excel: книгу (SheetJS, cellFormula) передаёт вызывающий. Проверяется в node: tests/tender/bid-vor-fill.test.mjs
// (сверка с результатами LibreOffice на настоящем ВОР — вручную, файлы подрядчиков в репозиторий не кладём).

export class NotComputable extends Error {}
const fail = (why) => { throw new NotComputable(why) }

class XlError { constructor(code) { this.code = code } }
const ERR = Object.fromEntries(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'].map((c) => [c, new XlError(c)]))
export const isXlError = (v) => v instanceof XlError

// Шаг вычисления (ячейка, клетка диапазона): больше — книга не наша, вычислитель сдаётся целиком.
const MAX_STEPS = 3_000_000

// ── Разбор ───────────────────────────────────────────────────────────────────────────────────────────
const colNum = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }
const RE = {
  space: /\s+/y,
  string: /"((?:[^"]|"")*)"/y,
  number: /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y,
  error: /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/y,
  external: /\[[^\]]*\]/y,
  quotedSheet: /'((?:[^']|'')+)'!/y,
  sheet: /([^\s!'"(),;:+\-*/^&=<>{}[\]#%]+)!/y,
  colRange: /\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![A-Za-z0-9_(])/y,
  cell: /\$?([A-Z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/y,
  func: /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/y,
  bool: /(TRUE|FALSE)(?![A-Za-z0-9_.(])/iy,
  op: /<>|<=|>=|[-+*/^&=<>%(),:;]/y,
}
const at = (re, s, i) => { re.lastIndex = i; return re.exec(s) }

function tokenize(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    let m
    if ((m = at(RE.space, src, i))) { i += m[0].length; continue }
    if ((m = at(RE.string, src, i))) { out.push({ t: 'str', v: m[1].replace(/""/g, '"') }); i += m[0].length; continue }
    if ((m = at(RE.error, src, i))) { out.push({ t: 'err', v: m[0] }); i += m[0].length; continue }
    if (at(RE.external, src, i)) fail('ссылка на другую книгу')
    let sheet = null
    if ((m = at(RE.quotedSheet, src, i))) { sheet = m[1].replace(/''/g, "'"); i += m[0].length }
    else if ((m = at(RE.sheet, src, i)) && !/^\d+(\.\d+)?$/.test(m[1])) { sheet = m[1]; i += m[0].length }
    if ((m = at(RE.colRange, src, i))) {
      out.push({ t: 'cols', sheet, c1: colNum(m[1]), c2: colNum(m[2]) }); i += m[0].length; continue
    }
    if ((m = at(RE.cell, src, i))) { out.push({ t: 'cell', sheet, c: colNum(m[1]), r: Number(m[2]) - 1 }); i += m[0].length; continue }
    if (sheet != null) fail('ссылка на лист без ячейки')
    if ((m = at(RE.number, src, i))) { out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue }
    if ((m = at(RE.func, src, i))) {
      out.push({ t: 'func', v: m[1].toUpperCase().replace(/^(_XLFN\.|_XLWS\.)+/, '') }); i += m[0].length; continue
    }
    if ((m = at(RE.bool, src, i))) { out.push({ t: 'bool', v: m[1].toUpperCase() === 'TRUE' }); i += m[0].length; continue }
    if ((m = at(RE.op, src, i))) { out.push({ t: 'op', v: m[0] }); i += m[0].length; continue }
    fail(`не разобрано: ${src.slice(i, i + 12)}`)
  }
  return out
}

// Приоритеты Excel: сравнения < & < + - < * / < ^ < % < унарный минус < диапазон «:».
const BIN = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }

function parse(src) {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v) => peek()?.t === 'op' && peek().v === v
  const expect = (v) => { if (!isOp(v)) fail(`ожидалось «${v}»`); p += 1 }

  const primary = () => {
    const t = toks[p++]
    if (!t) fail('формула оборвана')
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool') return { k: 'lit', v: t.v }
    if (t.t === 'err') return { k: 'lit', v: ERR[t.v] }
    if (t.t === 'cols') return { k: 'range', sheet: t.sheet, r1: 0, c1: Math.min(t.c1, t.c2), r2: Infinity, c2: Math.max(t.c1, t.c2) }
    if (t.t === 'cell') {
      if (isOp(':') && toks[p + 1]?.t === 'cell' && toks[p + 1].sheet == null) {
        const e = toks[p + 1]
        p += 2
        return { k: 'range', sheet: t.sheet, r1: Math.min(t.r, e.r), c1: Math.min(t.c, e.c), r2: Math.max(t.r, e.r), c2: Math.max(t.c, e.c) }
      }
      return { k: 'ref', sheet: t.sheet, r: t.r, c: t.c }
    }
    if (t.t === 'func') {
      const args = []
      if (!isOp(')')) {
        for (;;) {
          // Пропущенный аргумент («XLOOKUP(a,b,c,,0)») — пустое значение.
          if (isOp(',') || isOp(';') || isOp(')')) args.push({ k: 'lit', v: null })
          else args.push(expr(0))
          if (isOp(',') || isOp(';')) { p += 1; continue }
          break
        }
      }
      expect(')')
      return { k: 'call', name: t.v, args }
    }
    if (t.t === 'op' && t.v === '(') { const e = expr(0); expect(')'); return e }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      const e = postfix(primary())
      return t.v === '-' ? { k: 'neg', e } : { k: 'pos', e }
    }
    return fail(`лишний знак «${t.v}»`)
  }
  const postfix = (e) => {
    let out = e
    while (isOp('%')) { p += 1; out = { k: 'pct', e: out } }
    return out
  }
  const expr = (minPrec) => {
    let left = postfix(primary())
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op' || !(t.v in BIN) || BIN[t.v] < minPrec) break
      p += 1
      // Все двуместные в Excel — слева направо (и «^» тоже).
      const right = expr(BIN[t.v] + 1)
      left = { k: 'bin', op: t.v, a: left, b: right }
    }
    return left
  }
  const tree = expr(1)
  if (p < toks.length) fail('лишнее в конце формулы')
  return tree
}

// ── Значения ─────────────────────────────────────────────────────────────────────────────────────────
// Пусто — null; ячейка-результат «пусто» показывается нулём.
const num = (v) => {
  if (isXlError(v)) throw v
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const s = String(v).trim()
  if (/^[-+]?(\d+[.,]?\d*|[.,]\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s.replace(',', '.'))
  throw ERR['#VALUE!']
}
const bool = (v) => {
  if (isXlError(v)) throw v
  if (typeof v === 'boolean') return v
  if (v == null) return false
  if (typeof v === 'number') return v !== 0
  const s = String(v).toUpperCase()
  if (s === 'TRUE') return true
  if (s === 'FALSE') return false
  throw ERR['#VALUE!']
}
const text = (v) => {
  if (isXlError(v)) throw v
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15))).replace('.', ',')
  return String(v)
}
const fold = (s) => String(s).toLowerCase()
const finite = (x) => { if (!Number.isFinite(x)) throw ERR['#NUM!']; return x }

function compare(a, b) {
  // Порядок типов Excel: числа < строки < логические; пусто — как 0 или "" по другой стороне.
  const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)
  let x = a
  let y = b
  if (x == null) x = typeof y === 'string' ? '' : typeof y === 'boolean' ? false : 0
  if (y == null) y = typeof x === 'string' ? '' : typeof x === 'boolean' ? false : 0
  if (rank(x) !== rank(y)) return rank(x) - rank(y)
  if (typeof x === 'string') { const fx = fold(x); const fy = fold(y); return fx < fy ? -1 : fx > fy ? 1 : 0 }
  return x < y ? -1 : x > y ? 1 : 0
}

// Строка-образец (SUMIFS, VLOOKUP точного совпадения): * и ? — подстановка, ~ — сам знак; без учёта регистра.
function wildcard(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '~' && i + 1 < pattern.length && '*?~'.includes(pattern[i + 1])) { re += `\\${pattern[++i]}`; continue }
    re += ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const rx = new RegExp(`^${re}$`, 'i')
  return (v) => typeof v === 'string' && rx.test(v)
}

// Условие SUMIFS / SUMIF / COUNTIFS: «Мат», «>5», «<>», «Сетка 1000*500» (* и ? — подстановка, ~ — сам знак).
function criterion(raw) {
  if (isXlError(raw)) return (v) => isXlError(v) && v.code === raw.code
  if (raw == null) fail('условие — пустая ячейка')
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return (v) => (typeof raw === 'number' ? (typeof v === 'number' ? v === raw : typeof v === 'string' && v.trim() !== '' && Number(v) === raw) : v === raw)
  }
  const s = String(raw)
  if (s.length > 255) throw ERR['#VALUE!']
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(s)
  const op = m[1] || '='
  const rest = m[2]
  const asNum = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(rest) ? Number(rest) : null
  if (asNum != null) {
    const test = { '=': (d) => d === 0, '<>': (d) => d !== 0, '<': (d) => d < 0, '>': (d) => d > 0, '<=': (d) => d <= 0, '>=': (d) => d >= 0 }[op]
    return (v) => {
      if (typeof v === 'number') return test(v - asNum)
      if (op === '<>') return true
      return op === '=' && typeof v === 'string' && v.trim() !== '' && Number(v) === asNum
    }
  }
  if (op === '=' || op === '<>') {
    if (rest === '') return op === '=' ? (v) => v == null || v === '' : (v) => !(v == null || v === '')
    const eq = wildcard(rest)
    return op === '=' ? eq : (v) => !eq(v)
  }
  // Сравнение строк «<abc»: только со строками.
  const sign = { '<': (d) => d < 0, '>': (d) => d > 0, '<=': (d) => d <= 0, '>=': (d) => d >= 0 }[op]
  return (v) => typeof v === 'string' && sign(compare(v, rest))
}

// ── Вычислитель книги ─────────────────────────────────────────────────────────────────────────────────
// XLSX — библиотека SheetJS (utils.encode_cell / decode_range), wb — книга, прочитанная с cellFormula (листы, которых в ней нет, —
// «не посчитано»). overrides — Map(лист → Map(«строка,колонка» с нуля → значение)): вписанные цены и ответы анкеты.
// hiddenRows — Map(лист → Set(строка с нуля)): скрытые строки (SUBTOTAL по ним не считаем).
// → { value(sheet, r, c) → { ok: true, value } | { ok: false, why } }.
export function workbookEvaluator(XLSX, wb, { overrides = new Map(), hiddenRows = new Map() } = {}) {
  const memo = new Map()
  const busy = new Set()
  const parsed = new Map()
  const columnCache = new Map()
  const indexCache = new Map()
  let steps = 0
  let broken = null
  const UNKNOWN = Symbol('unknown')

  const step = () => { if (++steps > MAX_STEPS) { broken = 'книга слишком большая для расчёта'; fail(broken) } }
  const sheetOf = (name) => {
    const ws = wb.Sheets[name]
    if (!ws) fail(`лист «${name}» не загружен`)
    return ws
  }
  const lastRow = (name) => {
    const ref = sheetOf(name)['!ref']
    return ref ? XLSX.utils.decode_range(ref).e.r : -1
  }
  const treeOf = (f) => {
    if (!parsed.has(f)) {
      try { parsed.set(f, parse(f)) } catch (e) { parsed.set(f, e instanceof NotComputable ? e : new NotComputable(String(e?.message || e))) }
    }
    const t = parsed.get(f)
    if (t instanceof NotComputable) throw t
    return t
  }

  // Значение ячейки: вписанное, иначе — формула (посчитанная), иначе — как в файле.
  const cellValue = (sheet, r, c) => {
    step()
    const ov = overrides.get(sheet)?.get(`${r},${c}`)
    if (ov !== undefined) return ov
    const ws = sheetOf(sheet)
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    if (!cell) return null
    if (cell.f || cell.F) return formulaValue(sheet, r, c, cell)
    if (cell.t === 'e') return ERR[cell.w] || ERR['#VALUE!']
    if (cell.t === 'z' || cell.v == null) return null
    if (cell.t === 'd') fail('дата в ячейке')
    return cell.v
  }
  const formulaValue = (sheet, r, c, cell) => {
    const key = `${sheet}!${r},${c}`
    if (memo.has(key)) {
      const m = memo.get(key)
      if (m === UNKNOWN) fail('зависит от непосчитанной ячейки')
      return m
    }
    if (busy.has(key)) fail('кольцевая ссылка')
    busy.add(key)
    try {
      if (cell.F) fail('формула массива')
      let v
      try {
        v = evaluate(treeOf(cell.f), sheet)
        if (v && v.k === 'range') v = single(v)
      } catch (e) {
        if (isXlError(e)) v = e
        else throw e
      }
      // Формула, вернувшая пустую ячейку (XLOOKUP на пустую цену), в Excel — ноль.
      if (v == null) v = 0
      memo.set(key, v)
      return v
    } catch (e) {
      memo.set(key, UNKNOWN)
      throw e
    } finally {
      busy.delete(key)
    }
  }

  // Диапазон → конкретные границы (колонка целиком — до последней строки листа; whole — колонка целиком).
  const bounds = (rg) => (rg.r2 === Infinity ? { ...rg, r2: Math.max(lastRow(rg.sheet), rg.r1), whole: true } : rg)
  const rangeOf = (node, sheet) => (node.k === 'range' ? bounds({ ...node, sheet: node.sheet ?? sheet })
    : node.k === 'ref' ? { sheet: node.sheet ?? sheet, r1: node.r, c1: node.c, r2: node.r, c2: node.c } : null)
  // Значения диапазона построчно одним списком; с кэшем (SUMIFS по одной колонке «КП» — у каждой строки «МАТЕРИАЛОВ»).
  const flat = (rg) => {
    const key = `${rg.sheet}!${rg.r1},${rg.c1},${rg.r2},${rg.c2}`
    if (columnCache.has(key)) return columnCache.get(key)
    sheetOf(rg.sheet)
    const out = []
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) out.push(cellValue(rg.sheet, r, c))
    columnCache.set(key, out)
    return out
  }
  // Одна ячейка из диапазона (результат XLOOKUP / ссылка в выражении): диапазон больше ячейки — неявное пересечение, не считаем.
  const single = (rg) => {
    if (rg.r1 !== rg.r2 || rg.c1 !== rg.c2) fail('диапазон вместо значения')
    return cellValue(rg.sheet, rg.r1, rg.c1)
  }

  // Аргумент функции: { range } или { value }.
  const arg = (node, sheet) => {
    const rg = rangeOf(node, sheet)
    if (rg) return { range: rg }
    const v = evaluate(node, sheet)
    if (v && v.k === 'range') return { range: v }
    return { value: v }
  }
  const scalar = (node, sheet) => {
    const v = evaluate(node, sheet)
    return v && v.k === 'range' ? single(v) : v
  }

  const sumArgs = (args, sheet) => {
    let s = 0
    for (const a of args) {
      const x = arg(a, sheet)
      if (x.range) { for (const v of flat(x.range)) { if (isXlError(v)) throw v; if (typeof v === 'number') s += v } } else s += num(x.value)
    }
    return s
  }
  const lookupIndex = (rg, last) => {
    const key = `${rg.sheet}!${rg.r1},${rg.c1},${rg.r2},${rg.c2}|${last ? 1 : 0}`
    if (indexCache.has(key)) return indexCache.get(key)
    const map = new Map()
    flat(rg).forEach((v, i) => {
      if (v == null || isXlError(v)) return
      const k = typeof v === 'string' ? `s:${fold(v)}` : typeof v === 'number' ? `n:${v}` : `b:${v}`
      if (last || !map.has(k)) map.set(k, i)
    })
    indexCache.set(key, map)
    return map
  }
  const lookupKey = (v) => {
    if (v == null) fail('искомое — пустая ячейка')
    if (isXlError(v)) throw v
    return typeof v === 'string' ? `s:${fold(v)}` : typeof v === 'number' ? `n:${v}` : `b:${v}`
  }
  const isLine = (rg) => rg.r1 === rg.r2 || rg.c1 === rg.c2
  const cellAtOffset = (rg, i) => (rg.c1 === rg.c2 ? cellValue(rg.sheet, rg.r1 + i, rg.c1) : cellValue(rg.sheet, rg.r1, rg.c1 + i))
  const lineLength = (rg) => (rg.c1 === rg.c2 ? rg.r2 - rg.r1 + 1 : rg.c2 - rg.c1 + 1)
  const ifsPairs = (args, from, sheet, size) => {
    const out = []
    for (let i = from; i < args.length; i += 2) {
      const x = arg(args[i], sheet)
      if (!x.range) fail('условие не по диапазону')
      const rg = x.range
      if (size && (rg.r2 - rg.r1 !== size.r2 - size.r1 || rg.c2 - rg.c1 !== size.c2 - size.c1)) throw ERR['#VALUE!']
      if (i + 1 >= args.length) throw ERR['#VALUE!']
      out.push({ values: flat(rg), test: criterion(scalar(args[i + 1], sheet)) })
    }
    return out
  }

  const FUNCS = {
    SUM: (args, sheet) => sumArgs(args, sheet),
    SUBTOTAL: (args, sheet) => {
      const fn = num(scalar(args[0], sheet))
      if (fn !== 9 && fn !== 109) fail(`SUBTOTAL(${fn})`)
      let s = 0
      for (const a of args.slice(1)) {
        const rg = rangeOf(a, sheet)
        if (!rg) fail('SUBTOTAL не по диапазону')
        const ws = sheetOf(rg.sheet)
        const hidden = hiddenRows.get(rg.sheet)
        for (let r = rg.r1; r <= rg.r2; r++) {
          if (hidden?.has(r)) fail('скрытые строки под SUBTOTAL')
          for (let c = rg.c1; c <= rg.c2; c++) {
            // Вложенные промежуточные итоги SUBTOTAL не складывает — иначе раздел посчитался бы дважды.
            const f = ws[XLSX.utils.encode_cell({ r, c })]?.f
            if (f && /(^|[^A-Z_.])(_xlfn\.)?(SUBTOTAL|AGGREGATE)\s*\(/i.test(f)) continue
            const v = cellValue(rg.sheet, r, c)
            if (isXlError(v)) throw v
            if (typeof v === 'number') s += v
          }
        }
      }
      return s
    },
    SUMPRODUCT: (args, sheet) => {
      const arrays = args.map((a) => {
        const x = arg(a, sheet)
        if (x.range) return { dims: [x.range.r2 - x.range.r1, x.range.c2 - x.range.c1], values: flat(x.range) }
        if (x.value != null && typeof x.value === 'object') fail('массив в SUMPRODUCT')
        return { dims: [0, 0], values: [x.value] }
      })
      if (!arrays.length) throw ERR['#VALUE!']
      const [d0, d1] = arrays[0].dims
      if (arrays.some((a) => a.dims[0] !== d0 || a.dims[1] !== d1)) throw ERR['#VALUE!']
      let s = 0
      for (let i = 0; i < arrays[0].values.length; i++) {
        let prod = 1
        for (const a of arrays) {
          const v = a.values[i]
          if (isXlError(v)) throw v
          prod *= typeof v === 'number' ? v : 0
        }
        s += prod
      }
      return s
    },
    IFERROR: (args, sheet) => {
      try {
        const v = scalar(args[0], sheet)
        return isXlError(v) ? scalar(args[1], sheet) : v
      } catch (e) {
        if (isXlError(e)) return scalar(args[1], sheet)
        throw e
      }
    },
    IF: (args, sheet) => (bool(scalar(args[0], sheet)) ? scalar(args[1], sheet) : args.length > 2 ? scalar(args[2], sheet) : false),
    AND: (args, sheet) => args.every((a) => bool(scalar(a, sheet))),
    OR: (args, sheet) => args.some((a) => bool(scalar(a, sheet))),
    NOT: (args, sheet) => !bool(scalar(args[0], sheet)),
    ABS: (args, sheet) => Math.abs(num(scalar(args[0], sheet))),
    ROUND: (args, sheet) => {
      // Половина — от нуля, как в Excel; 15 значащих цифр снимают двоичный хвост (1,005 → 1,01).
      const x = num(scalar(args[0], sheet))
      const d = Math.trunc(num(scalar(args[1], sheet)))
      const r = Math.round(Number((Math.abs(x) * 10 ** d).toPrecision(15)))
      return Math.sign(x) * Number((d >= 0 ? r / 10 ** d : r * 10 ** -d).toPrecision(15))
    },
    MIN: (args, sheet) => {
      const xs = []
      for (const a of args) {
        const x = arg(a, sheet)
        if (x.range) { for (const v of flat(x.range)) { if (isXlError(v)) throw v; if (typeof v === 'number') xs.push(v) } } else xs.push(num(x.value))
      }
      return xs.length ? Math.min(...xs) : 0
    },
    MAX: (args, sheet) => {
      const xs = []
      for (const a of args) {
        const x = arg(a, sheet)
        if (x.range) { for (const v of flat(x.range)) { if (isXlError(v)) throw v; if (typeof v === 'number') xs.push(v) } } else xs.push(num(x.value))
      }
      return xs.length ? Math.max(...xs) : 0
    },
    XLOOKUP: (args, sheet) => {
      if (args.length < 3) throw ERR['#VALUE!']
      const opt = (i, d) => (args.length > i && !(args[i].k === 'lit' && args[i].v == null) ? num(scalar(args[i], sheet)) : d)
      const look = scalar(args[0], sheet)
      const where = arg(args[1], sheet).range
      const ret = arg(args[2], sheet).range
      if (!where || !ret || !isLine(where) || !isLine(ret)) fail('XLOOKUP не по строке / колонке')
      if ((where.c1 === where.c2) !== (ret.c1 === ret.c2)) fail('XLOOKUP: строка и колонка')
      // Колонки целиком («B:B», «E:E») в Excel одной длины; иначе длины должны совпадать.
      if (!(where.whole && ret.whole) && lineLength(where) !== lineLength(ret)) throw ERR['#VALUE!']
      const mode = opt(4, 0)
      const search = opt(5, 1)
      if (mode !== 0 || (search !== 1 && search !== -1)) fail('XLOOKUP не точного совпадения')
      const i = lookupIndex(where, search === -1).get(lookupKey(look))
      if (i == null) {
        if (args.length > 3 && !(args[3].k === 'lit' && args[3].v == null)) return scalar(args[3], sheet)
        throw ERR['#N/A']
      }
      return cellAtOffset(ret, i)
    },
    VLOOKUP: (args, sheet) => {
      const look = scalar(args[0], sheet)
      const table = arg(args[1], sheet).range
      if (!table) fail('VLOOKUP не по диапазону')
      const col = Math.trunc(num(scalar(args[2], sheet)))
      const approx = args.length > 3 ? bool(scalar(args[3], sheet)) : true
      if (approx) fail('VLOOKUP приблизительного совпадения')
      if (col < 1) throw ERR['#VALUE!']
      if (col > table.c2 - table.c1 + 1) throw ERR['#REF!']
      if (look == null) fail('искомое — пустая ячейка')
      if (isXlError(look)) throw look
      const first = { ...table, c2: table.c1 }
      const keys = flat(first)
      let hit = -1
      if (typeof look === 'string') {
        if (look.length > 255) fail('длинная строка VLOOKUP')
        const test = wildcard(look)
        hit = keys.findIndex((v) => test(v))
      } else {
        hit = lookupIndex(first, false).get(lookupKey(look)) ?? -1
      }
      if (hit < 0) throw ERR['#N/A']
      return cellValue(table.sheet, table.r1 + hit, table.c1 + col - 1)
    },
    SUMIFS: (args, sheet) => {
      const sum = arg(args[0], sheet).range
      if (!sum) fail('SUMIFS не по диапазону')
      const values = flat(sum)
      const pairs = ifsPairs(args, 1, sheet, sum)
      let s = 0
      for (let i = 0; i < values.length; i++) {
        if (!pairs.every((pr) => pr.test(pr.values[i]))) continue
        const v = values[i]
        if (isXlError(v)) throw v
        if (typeof v === 'number') s += v
      }
      return s
    },
    COUNTIFS: (args, sheet) => {
      const pairs = ifsPairs(args, 0, sheet, rangeOf(args[0], sheet))
      let n = 0
      for (let i = 0; i < pairs[0].values.length; i++) if (pairs.every((pr) => pr.test(pr.values[i]))) n += 1
      return n
    },
    SUMIF: (args, sheet) => {
      const where = arg(args[0], sheet).range
      if (!where) fail('SUMIF не по диапазону')
      const test = criterion(scalar(args[1], sheet))
      const sumTop = args.length > 2 ? arg(args[2], sheet).range : where
      if (!sumTop) fail('SUMIF не по диапазону')
      // Диапазон сумм — от левой верхней ячейки размером с диапазон условия (как в Excel).
      const sum = { sheet: sumTop.sheet, r1: sumTop.r1, c1: sumTop.c1, r2: sumTop.r1 + (where.r2 - where.r1), c2: sumTop.c1 + (where.c2 - where.c1) }
      const keys = flat(where)
      const values = flat(sum)
      let s = 0
      keys.forEach((k, i) => {
        if (!test(k)) return
        const v = values[i]
        if (isXlError(v)) throw v
        if (typeof v === 'number') s += v
      })
      return s
    },
  }
  FUNCS.COUNTIF = (args, sheet) => FUNCS.COUNTIFS(args, sheet)

  function evaluate(node, sheet) {
    step()
    switch (node.k) {
      case 'lit': return node.v
      case 'ref': return cellValue(node.sheet ?? sheet, node.r, node.c)
      case 'range': return { k: 'range', ...bounds({ ...node, sheet: node.sheet ?? sheet }) }
      case 'neg': return -num(scalar(node.e, sheet))
      case 'pos': return scalar(node.e, sheet)
      case 'pct': return num(scalar(node.e, sheet)) / 100
      case 'call': {
        const f = FUNCS[node.name]
        if (!f) fail(`функция ${node.name}`)
        return f(node.args, sheet)
      }
      case 'bin': {
        const a = scalar(node.a, sheet)
        const b = scalar(node.b, sheet)
        if (isXlError(a)) throw a
        if (isXlError(b)) throw b
        switch (node.op) {
          case '+': return finite(num(a) + num(b))
          case '-': return finite(num(a) - num(b))
          case '*': return finite(num(a) * num(b))
          case '/': { const d = num(b); if (d === 0) throw ERR['#DIV/0!']; return finite(num(a) / d) }
          case '^': return finite(num(a) ** num(b))
          case '&': return text(a) + text(b)
          case '=': return compare(a, b) === 0
          case '<>': return compare(a, b) !== 0
          case '<': return compare(a, b) < 0
          case '>': return compare(a, b) > 0
          case '<=': return compare(a, b) <= 0
          case '>=': return compare(a, b) >= 0
          default: return fail(`знак ${node.op}`)
        }
      }
      default: return fail('узел')
    }
  }

  return {
    value(sheet, r, c) {
      if (broken) return { ok: false, why: broken }
      try {
        return { ok: true, value: cellValue(sheet, r, c) }
      } catch (e) {
        if (isXlError(e)) return { ok: true, value: e }
        if (e instanceof NotComputable) return { ok: false, why: e.message }
        // Переполнение стека (цепочка в тысячи ячеек) и прочее — не считаем, книгу посчитает программа.
        return { ok: false, why: String(e?.message || e) }
      }
    },
  }
}
