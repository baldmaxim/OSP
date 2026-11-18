// Формулы Excel без сохранённого значения. Файлы ВОР из Estimat пишут на листе «Материалы» объём формулой
// SUMIFS(КП!G:G, КП!D:D, B4, КП!B:B, "Мат"), а значения формулы в файле нет: Excel считает её только после «Разрешить
// редактирование», а в защищённом просмотре и у библиотеки чтения ячейка пустая (18.11.2026, тендер № 772: объёмов не было,
// пока человек не вставил их руками значениями). Здесь — небольшой расчёт таких ячеек: числа, строки, ссылки на ячейки и
// диапазоны (в том числе других листов и целых колонок), + − * / ^ & %, сравнения, SUM, SUMIF, SUMIFS, SUMPRODUCT, ROUND,
// ROUNDUP, ROUNDDOWN, IF, IFERROR, IFNA, MIN, MAX, ABS, AVERAGE, COUNT, COUNTA, COUNTIF, AND, OR, NOT. Чего не умеет (другая
// функция, ошибка, цикл, слишком долгий расчёт) — null: ячейка остаётся пустой, как раньше.
//
// Ячейка со значением — значение (Excel его уже посчитал); формула без значения — расчёт. Листы читаются по требованию:
// getSheet(имя) → лист или null. Модуль без библиотеки Excel (адреса — свои), чтобы годился и службе osp-api (копия в
// server/osp-api/src/shared, scripts/sync-osp-api-shared.mjs).

class CalcError extends Error {}
const fail = (msg = 'formula') => { throw new CalcError(msg) }
// Сколько ячеек можно перебрать за один расчёт листа: дальше — не считаем (null), чтобы не подвесить страницу.
const VISIT_LIMIT = 4_000_000
const DEPTH_LIMIT = 60

const colIndex = (letters) => {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
const colName = (c) => {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
export const cellAddress = (r, c) => `${colName(c)}${r + 1}`
const usedRange = (ws) => {
  const m = /^\$?([A-Z]+)\$?([0-9]+)(?::\$?([A-Z]+)\$?([0-9]+))?$/i.exec(ws?.['!ref'] || '')
  if (!m) return null
  return { s: { r: Number(m[2]) - 1, c: colIndex(m[1]) }, e: { r: Number(m[4] || m[2]) - 1, c: colIndex(m[3] || m[1]) } }
}

// ── Разбор формулы ───────────────────────────────────────────────────────────────────────────────────
const SHEET_RE = String.raw`(?:'((?:[^']|'')+)'|([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_.]*))!`
const TOKEN_RE = new RegExp([
  String.raw`(?<space>\s+)`,
  String.raw`(?<str>"(?:[^"]|"")*")`,
  `(?<ref>(?:${SHEET_RE})?(?:\\$?[A-Za-z]{1,3}\\$?[0-9]+(?::\\$?[A-Za-z]{1,3}\\$?[0-9]+)?|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}|\\$?[0-9]+:\\$?[0-9]+))(?![A-Za-z0-9_(])`,
  String.raw`(?<num>[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)`,
  String.raw`(?<fn>[A-Za-z_][A-Za-z0-9_.]*)\s*\(`,
  String.raw`(?<bool>TRUE|FALSE)(?![A-Za-z0-9_])`,
  String.raw`(?<op><>|<=|>=|[-+*/^&=<>%(),;])`,
].join('|'), 'yi')

function tokenize(text) {
  const out = []
  TOKEN_RE.lastIndex = 0
  let i = 0
  while (i < text.length) {
    TOKEN_RE.lastIndex = i
    const m = TOKEN_RE.exec(text)
    if (!m || m.index !== i) fail('token')
    i = TOKEN_RE.lastIndex
    const g = m.groups
    if (g.space) continue
    if (g.str) out.push({ t: 'str', v: g.str.slice(1, -1).replace(/""/g, '"') })
    else if (g.ref) out.push({ t: 'ref', v: g.ref })
    else if (g.num) out.push({ t: 'num', v: Number(g.num) })
    else if (g.fn) out.push({ t: 'fn', v: g.fn.toUpperCase().replace(/^_XLFN\.|^_XLWS\./, '') })
    else if (g.bool) out.push({ t: 'bool', v: g.bool.toUpperCase() === 'TRUE' })
    else out.push({ t: 'op', v: g.op === ';' ? ',' : g.op })
  }
  return out
}

// Ссылка «Лист!A1:B5», «G:G», «$D$4» → { sheet, s: { r, c }, e: { r, c }, col?, row? } (col / row — целые колонки / строки).
function parseRef(text, ownSheet) {
  let sheet = ownSheet
  let rest = text
  const bang = text.lastIndexOf('!')
  if (bang >= 0) {
    sheet = text.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'")
    rest = text.slice(bang + 1)
  }
  const [a, b = a] = rest.replace(/\$/g, '').split(':')
  const cell = (x) => {
    const m = /^([A-Za-z]{1,3})([0-9]+)$/.exec(x)
    return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null
  }
  const ca = cell(a)
  const cb = cell(b)
  if (ca && cb) return { sheet, s: { r: Math.min(ca.r, cb.r), c: Math.min(ca.c, cb.c) }, e: { r: Math.max(ca.r, cb.r), c: Math.max(ca.c, cb.c) } }
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
    const c1 = colIndex(a)
    const c2 = colIndex(b)
    return { sheet, col: true, s: { r: 0, c: Math.min(c1, c2) }, e: { r: Infinity, c: Math.max(c1, c2) } }
  }
  if (/^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) {
    return { sheet, row: true, s: { r: Math.min(a, b) - 1, c: 0 }, e: { r: Math.max(a, b) - 1, c: Infinity } }
  }
  fail('ref')
}

// Токены → дерево. Приоритет как в Excel: сравнение < & < + − < * / < ^ < унарный минус < %.
function parse(tokens, ownSheet) {
  let i = 0
  const peek = () => tokens[i]
  const isOp = (v) => peek()?.t === 'op' && peek().v === v
  const take = (v) => { if (!isOp(v)) fail(`expected ${v}`); i += 1 }
  const binary = (next, ops) => () => {
    let left = next()
    while (peek()?.t === 'op' && ops.includes(peek().v)) {
      const op = tokens[i++].v
      left = { k: 'bin', op, a: left, b: next() }
    }
    return left
  }
  const primary = () => {
    const tok = tokens[i++]
    if (!tok) fail('end')
    if (tok.t === 'num') return { k: 'val', v: tok.v }
    if (tok.t === 'str') return { k: 'val', v: tok.v }
    if (tok.t === 'bool') return { k: 'val', v: tok.v }
    if (tok.t === 'ref') return { k: 'ref', ref: parseRef(tok.v, ownSheet) }
    if (tok.t === 'fn') {
      const args = []
      if (isOp(')')) { i += 1; return { k: 'fn', name: tok.v, args } }
      for (;;) {
        args.push(isOp(',') || isOp(')') ? { k: 'val', v: null } : compare())
        if (isOp(',')) { i += 1; continue }
        take(')')
        return { k: 'fn', name: tok.v, args }
      }
    }
    if (tok.t === 'op' && tok.v === '(') { const e = compare(); take(')'); return e }
    fail('primary')
  }
  const postfix = () => {
    let e = primary()
    while (isOp('%')) { i += 1; e = { k: 'bin', op: '/', a: e, b: { k: 'val', v: 100 } } }
    return e
  }
  const unary = () => {
    if (isOp('-')) { i += 1; return { k: 'neg', a: unary() } }
    if (isOp('+')) { i += 1; return unary() }
    return postfix()
  }
  const power = binary(unary, ['^'])
  const mul = binary(power, ['*', '/'])
  const add = binary(mul, ['+', '-'])
  const concat = binary(add, ['&'])
  const compare = binary(concat, ['=', '<>', '<', '>', '<=', '>='])
  const tree = compare()
  if (i < tokens.length) fail('tail')
  return tree
}

// ── Значения ─────────────────────────────────────────────────────────────────────────────────────────
const toNumber = (v) => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(String(v).trim().replace(',', '.'))
  if (Number.isFinite(n)) return n
  return fail('value')
}
const toText = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))
const toBool = (v) => (typeof v === 'boolean' ? v : typeof v === 'string' ? fail('value') : toNumber(v) !== 0)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
// Округление Excel: половина — от нуля.
const roundTo = (x, digits, mode) => {
  const k = 10 ** digits
  const y = Math.abs(x) * k
  const z = mode === 'up' ? Math.ceil(y - 1e-9) : mode === 'down' ? Math.floor(y + 1e-9) : Math.round(y + 1e-9)
  return (Math.sign(x) * z) / k
}

function compareValues(op, a, b) {
  let x = a ?? ''
  let y = b ?? ''
  if (x === '' && isNum(y)) x = 0
  if (y === '' && isNum(x)) y = 0
  let c
  if (isNum(x) && isNum(y)) c = x - y
  else if (typeof x === 'string' && typeof y === 'string') c = x.toLowerCase().localeCompare(y.toLowerCase())
  else c = (isNum(x) ? 0 : typeof x === 'string' ? 1 : 2) - (isNum(y) ? 0 : typeof y === 'string' ? 1 : 2)
  return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0
}

// Подстановка Excel: * — любые знаки, ? — один знак, ~* ~? ~~ — сами знаки.
const SPECIAL_RE = /[.+^$()|[\]{}\\]/
function wildcardRe(text) {
  let src = '^'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '~' && i + 1 < text.length && '*?~'.includes(text[i + 1])) { src += '\\' + text[i + 1]; i += 1 }
    else if (ch === '*') src += '[\\s\\S]*'
    else if (ch === '?') src += '[\\s\\S]'
    else src += SPECIAL_RE.test(ch) ? '\\' + ch : ch
  }
  return new RegExp(src + '$', 'i')
}

// Условие SUMIF / SUMIFS / COUNTIF: число — равенство; строка — «>0», «<>Мат», «Мат*» (подстановка * ? ~), без учёта регистра.
function criterion(raw) {
  if (isNum(raw) || typeof raw === 'boolean') return { eq: raw, test: (v) => compareValues('=', v, raw) }
  const s = toText(raw)
  const m = /^(<>|<=|>=|=|<|>)?([\s\S]*)$/.exec(s)
  const op = m[1] || '='
  const text = m[2]
  const n = text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null
  if (n != null) return { test: (v) => (isNum(v) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) ? compareValues(op, Number(v), n) : op === '<>') }
  if ((op === '=' || op === '<>') && /[*?]/.test(text)) {
    const re = wildcardRe(text)
    return { test: (v) => re.test(toText(v)) === (op === '=') }
  }
  if (op === '=') {
    const key = text.toLowerCase()
    if (text === '') return { test: (v) => v == null || v === '' }
    return { eq: key, test: (v) => typeof v === 'string' && v.toLowerCase() === key }
  }
  if (op === '<>') return { test: (v) => (text === '' ? !(v == null || v === '') : toText(v).toLowerCase() !== text.toLowerCase()) }
  return { test: (v) => typeof v === 'string' && compareValues(op, v, text) }
}

// getSheet(имя) → лист (объект ячеек, как у библиотеки xlsx: { A1: { v, f, t }, '!ref' }) или null.
export function createSheetCalc(getSheet) {
  const sheets = new Map()
  const sheetOf = (name) => {
    const key = String(name).toLowerCase()
    if (!sheets.has(key)) sheets.set(key, getSheet(name) || null)
    return sheets.get(key)
  }
  const parsed = new Map()
  const results = new Map()
  const busy = new Set()
  const columns = new Map()
  const indexes = new Map()
  let visits = 0
  let depth = 0

  // Значение ячейки: сохранённое, иначе формула без значения — расчёт; ошибка — исключение.
  function cell(sheetName, r, c) {
    if ((visits += 1) > VISIT_LIMIT) fail('limit')
    const ws = sheetOf(sheetName)
    if (!ws) fail('sheet')
    const x = ws[cellAddress(r, c)]
    if (!x) return null
    const stored = x.t !== 'z' && x.v !== undefined
    if (stored && x.t === 'e') fail('error')
    if (stored || !x.f) return stored ? x.v : null
    const key = `${String(sheetName).toLowerCase()}!${r}:${c}`
    if (results.has(key)) {
      const got = results.get(key)
      if (got instanceof CalcError) throw got
      return got
    }
    if (busy.has(key) || depth > DEPTH_LIMIT) fail('cycle')
    busy.add(key)
    depth += 1
    try {
      const v = evaluate(formulaTree(x.f, sheetName), sheetName)
      const scalar = v?.range ? fail('range') : v
      results.set(key, scalar)
      return scalar
    } catch (e) {
      if (e instanceof CalcError && e.message !== 'limit') results.set(key, e)
      throw e
    } finally {
      busy.delete(key)
      depth -= 1
    }
  }
  function formulaTree(f, sheetName) {
    const key = `${sheetName}\u0000${f}`
    if (!parsed.has(key)) parsed.set(key, parse(tokenize(String(f).replace(/^=/, '')), sheetName))
    return parsed.get(key)
  }
  // Диапазон → границы по заполненной части листа (целая колонка G:G — только до последней строки листа).
  function bounds(ref) {
    const ws = sheetOf(ref.sheet)
    if (!ws) fail('sheet')
    const used = usedRange(ws)
    if (!used) return null
    const s = { r: Math.max(ref.s.r, used.s.r), c: Math.max(ref.s.c, used.s.c) }
    const e = { r: Math.min(ref.e.r, used.e.r), c: Math.min(ref.e.c, used.e.c) }
    return s.r > e.r || s.c > e.c ? null : { s, e }
  }
  // Колонка диапазона значениями (память на расчёт: SUMIFS по одной колонке зовут сотни раз).
  function column(sheet, c, r0, r1) {
    const key = `${String(sheet).toLowerCase()}!${c}:${r0}:${r1}`
    let list = columns.get(key)
    if (!list) {
      list = []
      for (let r = r0; r <= r1; r++) {
        try { list.push(cell(sheet, r, c)) } catch (e) { if (!(e instanceof CalcError) || e.message === 'limit') throw e; list.push(e) }
      }
      columns.set(key, list)
    }
    return list
  }
  // Диапазон → значения построчно: [[...], ...]; ошибка ячейки — объект ошибки в списке (SUM на ней падает, как Excel).
  function rangeValues(ref) {
    const b = bounds(ref)
    if (!b) return { rows: 0, cols: 0, at: () => null, b: null }
    const cols = []
    for (let c = b.s.c; c <= b.e.c; c++) cols.push(column(ref.sheet, c, b.s.r, b.e.r))
    return { rows: b.e.r - b.s.r + 1, cols: b.e.c - b.s.c + 1, at: (i, j) => cols[j][i], b }
  }
  const flat = (v) => {
    if (v?.range) {
      const rv = rangeValues(v.range)
      const out = []
      for (let j = 0; j < rv.cols; j++) for (let i = 0; i < rv.rows; i++) out.push(rv.at(i, j))
      return { list: out, fromRange: true }
    }
    return { list: [v], fromRange: false }
  }
  // Числа аргументов: в диапазоне текст и пустые не считаются; ошибка — ошибка.
  const numbersOf = (args) => {
    const out = []
    for (const a of args) {
      const { list, fromRange } = flat(a)
      for (const v of list) {
        if (v instanceof CalcError) throw v
        if (fromRange) { if (isNum(v)) out.push(v) } else if (v != null) out.push(toNumber(v))
      }
    }
    return out
  }
  const scalar = (v) => {
    if (v?.range) {
      const b = bounds(v.range)
      if (!b || b.s.r !== b.e.r || b.s.c !== b.e.c) fail('range')
      return cell(v.range.sheet, b.s.r, b.s.c)
    }
    return v
  }
  // SUMIFS: пары (диапазон, условие) одного размера с диапазоном сумм. Равенство текста — по указателю значений колонки.
  function sumIfs(sumRef, pairs, count = false) {
    const sum = sumRef ? rangeValues(sumRef) : null
    const crits = pairs.map(([ref, raw]) => ({ rv: rangeValues(ref), ref, c: criterion(scalar(raw)) }))
    // Диапазоны сравниваются по номеру строки листа: целые колонки, обрезанные по заполненной части, остаются согласованы.
    const rows = sum ? sum.rows : crits[0]?.rv.rows || 0
    const startOf = (x) => x.rv.b?.s.r ?? 0
    const base = sum ? sum.b?.s.r ?? 0 : startOf(crits[0] || { rv: {} })
    let candidates = null
    const eqCrit = crits.find((x) => x.c.eq != null && typeof x.c.eq === 'string' && x.rv.cols === 1)
    if (eqCrit) {
      const key = `${String(eqCrit.ref.sheet).toLowerCase()}!${eqCrit.rv.b?.s.c}:${eqCrit.rv.b?.s.r}:${eqCrit.rv.b?.e.r}`
      let index = indexes.get(key)
      if (!index) {
        index = new Map()
        for (let i = 0; i < eqCrit.rv.rows; i++) {
          const v = eqCrit.rv.at(i, 0)
          if (typeof v !== 'string') continue
          const k = v.toLowerCase()
          if (!index.has(k)) index.set(k, [])
          index.get(k).push(startOf(eqCrit) + i)
        }
        indexes.set(key, index)
      }
      candidates = index.get(eqCrit.c.eq) || []
    }
    let total = 0
    const check = (row) => {
      for (const x of crits) {
        const i = row - startOf(x)
        if (i < 0 || i >= x.rv.rows) return false
        const v = x.rv.at(i, 0)
        if (v instanceof CalcError || !x.c.test(v)) return false
      }
      return true
    }
    const rowsList = candidates || Array.from({ length: rows }, (_, i) => base + i)
    for (const row of rowsList) {
      if ((visits += crits.length) > VISIT_LIMIT) fail('limit')
      if (!check(row)) continue
      if (count) { total += 1; continue }
      const i = row - base
      if (!sum || i < 0 || i >= sum.rows) continue
      const v = sum.at(i, 0)
      if (v instanceof CalcError) throw v
      if (isNum(v)) total += v
    }
    return total
  }

  const FUNCS = {
    SUM: (args) => numbersOf(args).reduce((s, x) => s + x, 0),
    MIN: (args) => { const l = numbersOf(args); return l.length ? Math.min(...l) : 0 },
    MAX: (args) => { const l = numbersOf(args); return l.length ? Math.max(...l) : 0 },
    AVERAGE: (args) => { const l = numbersOf(args); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : fail('div0') },
    COUNT: (args) => numbersOf(args).length,
    COUNTA: (args) => args.reduce((n, a) => n + flat(a).list.filter((v) => v != null && v !== '').length, 0),
    ABS: ([a]) => Math.abs(toNumber(scalar(a))),
    ROUND: ([a, n]) => roundTo(toNumber(scalar(a)), toNumber(scalar(n ?? 0)), 'half'),
    ROUNDUP: ([a, n]) => roundTo(toNumber(scalar(a)), toNumber(scalar(n ?? 0)), 'up'),
    ROUNDDOWN: ([a, n]) => roundTo(toNumber(scalar(a)), toNumber(scalar(n ?? 0)), 'down'),
    SUMIF: ([range, crit, sumRange]) => {
      if (!range?.range) fail('range')
      return sumIfs((sumRange?.range || range.range), [[range.range, crit]])
    },
    SUMIFS: ([sumRange, ...rest]) => {
      if (!sumRange?.range || rest.length < 2 || rest.length % 2) fail('args')
      const pairs = []
      for (let k = 0; k < rest.length; k += 2) { if (!rest[k]?.range) fail('range'); pairs.push([rest[k].range, rest[k + 1]]) }
      return sumIfs(sumRange.range, pairs)
    },
    COUNTIF: ([range, crit]) => (range?.range ? sumIfs(null, [[range.range, crit]], true) : fail('range')),
    SUMPRODUCT: (args) => {
      const lists = args.map((a) => flat(a).list)
      const n = lists[0]?.length || 0
      if (lists.some((l) => l.length !== n)) fail('value')
      let s = 0
      for (let i = 0; i < n; i++) {
        let p = 1
        for (const l of lists) { const v = l[i]; if (v instanceof CalcError) throw v; p *= isNum(v) ? v : 0 }
        s += p
      }
      return s
    },
    AND: (args) => args.every((a) => toBool(scalar(a))),
    OR: (args) => args.some((a) => toBool(scalar(a))),
    NOT: ([a]) => !toBool(scalar(a)),
  }

  function evaluate(node, sheetName) {
    switch (node.k) {
      case 'val': return node.v
      case 'ref': return { range: node.ref }
      case 'neg': return -toNumber(scalar(evaluate(node.a, sheetName)))
      case 'bin': {
        const a = scalar(evaluate(node.a, sheetName))
        const b = scalar(evaluate(node.b, sheetName))
        if (node.op === '&') return toText(a) + toText(b)
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) return compareValues(node.op, a, b)
        const x = toNumber(a)
        const y = toNumber(b)
        if (node.op === '+') return x + y
        if (node.op === '-') return x - y
        if (node.op === '*') return x * y
        if (node.op === '/') return y === 0 ? fail('div0') : x / y
        if (node.op === '^') return x ** y
        return fail('op')
      }
      case 'fn': {
        if (node.name === 'IF') {
          const cond = toBool(scalar(evaluate(node.args[0] || { k: 'val', v: false }, sheetName)))
          const branch = cond ? node.args[1] : node.args[2]
          return branch ? evaluate(branch, sheetName) : cond
        }
        if (node.name === 'IFERROR' || node.name === 'IFNA') {
          try {
            const v = scalar(evaluate(node.args[0], sheetName))
            return v
          } catch (e) {
            if (!(e instanceof CalcError) || e.message === 'limit') throw e
            return node.args[1] ? evaluate(node.args[1], sheetName) : 0
          }
        }
        const fn = FUNCS[node.name]
        if (!fn) return fail(`fn ${node.name}`)
        return fn(node.args.map((a) => evaluate(a, sheetName)))
      }
      default: return fail('node')
    }
  }

  // Значение ячейки (0-based строка и колонка) или null: формулу не удалось посчитать.
  return {
    value(sheetName, r, c) {
      try {
        const v = cell(sheetName, r, c)
        return v instanceof CalcError ? null : v
      } catch (e) {
        if (e instanceof CalcError) return null
        throw e
      }
    },
  }
}

// Листы, на которые ссылаются формулы листа (кроме него самого): их нужно прочитать для расчёта.
export function referencedSheets(ws, ownName) {
  const out = new Set()
  const re = new RegExp(SHEET_RE, 'g')
  for (const key of Object.keys(ws || {})) {
    const f = key[0] === '!' ? null : ws[key]?.f
    if (!f) continue
    for (const m of String(f).matchAll(re)) {
      const name = (m[1] ? m[1].replace(/''/g, "'") : m[2])
      if (name && name.toLowerCase() !== String(ownName).toLowerCase()) out.add(name)
    }
  }
  return [...out]
}

// Есть ли на листе формулы без значения (только тогда нужен расчёт и соседние листы).
export const hasUncalculated = (ws) => Object.keys(ws || {}).some((k) => k[0] !== '!' && ws[k]?.f && (ws[k].t === 'z' || ws[k].v === undefined))
