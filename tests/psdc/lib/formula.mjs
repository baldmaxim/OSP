// Минимальный вычислитель формул Excel для тестов экспорта ПСДЦ.
// Поддерживает ровно то, что генерирует система: числа, строки, ссылки и
// диапазоны, + - * / &, сравнения, IF, IFERROR, ROUND, SUMIFS (с шаблонами * ?).
// ROUND — как в Excel: половина от нуля с поправкой на двоичную погрешность.

class XlError {
  constructor(code) { this.code = code }
}

function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '"') {
      let j = i + 1
      let s = ''
      for (;;) {
        if (src[j] === '"' && src[j + 1] === '"') { s += '"'; j += 2; continue }
        if (src[j] === '"') break
        s += src[j++]
      }
      tokens.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const ref = /^\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?/.exec(src.slice(i))
    if (ref && !/^[A-Z]+\(/.test(src.slice(i))) { tokens.push({ t: 'ref', v: ref[0].replace(/\$/g, '') }); i += ref[0].length; continue }
    const fn = /^[A-Z]+(?=\()/.exec(src.slice(i))
    if (fn) { tokens.push({ t: 'fn', v: fn[0] }); i += fn[0].length; continue }
    const op = /^(<>|<=|>=|[-+*/&=<>(),])/.exec(src.slice(i))
    if (op) { tokens.push({ t: 'op', v: op[0] }); i += op[0].length; continue }
    throw new Error(`Неизвестный символ в формуле: ${src.slice(i)}`)
  }
  return tokens
}

function parse(src) {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const take = (v) => {
    const tk = tokens[pos]
    if (v && (!tk || tk.v !== v)) throw new Error(`Ожидалось ${v} в ${src}`)
    pos++
    return tk
  }
  const primary = () => {
    const tk = take()
    if (tk.t === 'num' || tk.t === 'str') return { k: 'lit', v: tk.v }
    if (tk.t === 'ref') return { k: 'ref', v: tk.v }
    if (tk.t === 'op' && tk.v === '(') { const e = expr(); take(')'); return e }
    if (tk.t === 'op' && tk.v === '-') return { k: 'neg', a: primary() }
    if (tk.t === 'fn') {
      take('(')
      const args = []
      if (peek().v !== ')') {
        args.push(expr())
        while (peek().v === ',') { take(','); args.push(expr()) }
      }
      take(')')
      return { k: 'fn', name: tk.v, args }
    }
    throw new Error(`Неожиданный токен ${JSON.stringify(tk)} в ${src}`)
  }
  const bin = (next, ops) => () => {
    let left = next()
    while (peek() && peek().t === 'op' && ops.includes(peek().v)) {
      const op = take().v
      left = { k: 'bin', op, a: left, b: next() }
    }
    return left
  }
  const term = bin(primary, ['*', '/'])
  const additive = bin(term, ['+', '-'])
  const concat = bin(additive, ['&'])
  const expr = bin(concat, ['=', '<>', '<', '>', '<=', '>='])
  const ast = expr()
  if (pos !== tokens.length) throw new Error(`Лишние токены в ${src}`)
  return ast
}

const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

function expandRange(ref) {
  const [a, b] = ref.split(':')
  const pa = /^([A-Z]+)(\d+)$/.exec(a)
  const pb = /^([A-Z]+)(\d+)$/.exec(b)
  const out = []
  for (let r = Number(pa[2]); r <= Number(pb[2]); r++) {
    for (let c = colNum(pa[1]); c <= colNum(pb[1]); c++) out.push(`${colName(c)}${r}`)
  }
  return out
}

export function excelRound(x, n) {
  const f = 10 ** n
  const scaled = Number((Math.abs(x) * f).toPrecision(15))
  return (Math.sign(x) * Math.round(scaled)) / f
}

function wildcardMatch(value, pattern) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return re.test(value)
}

function criterionMatches(cellValue, criterion) {
  const m = /^(<>|<=|>=|=|<|>)?(.*)$/.exec(String(criterion))
  const op = m[1] || '='
  const target = m[2]
  const text = cellValue == null ? '' : String(cellValue)
  if (op === '=') return wildcardMatch(text, target)
  if (op === '<>') return !wildcardMatch(text, target)
  const a = Number(cellValue)
  const b = Number(target)
  if (op === '<') return a < b
  if (op === '>') return a > b
  if (op === '<=') return a <= b
  return a >= b
}

// ws — лист SheetJS, прочитанный с cellFormula: true.
export function createEvaluator(ws) {
  const memo = new Map()
  const cellValue = (ref) => {
    if (memo.has(ref)) return memo.get(ref)
    const cell = ws[ref]
    let v = null
    if (cell?.f) v = evaluate(parse(cell.f))
    else if (cell) v = cell.v === '' ? null : cell.v
    memo.set(ref, v)
    return v
  }
  const num = (v) => {
    if (v instanceof XlError) throw v
    if (v == null || v === '') return 0
    if (typeof v === 'number') return v
    const n = Number(v)
    if (Number.isNaN(n)) throw new XlError('#VALUE!')
    return n
  }
  function evaluate(node) {
    switch (node.k) {
      case 'lit': return node.v
      case 'ref': return cellValue(node.v)
      case 'neg': return -num(evaluate(node.a))
      case 'bin': {
        const a = evaluate(node.a)
        const b = evaluate(node.b)
        if (a instanceof XlError) throw a
        if (b instanceof XlError) throw b
        switch (node.op) {
          case '+': return num(a) + num(b)
          case '-': return num(a) - num(b)
          case '*': return num(a) * num(b)
          case '/': if (num(b) === 0) throw new XlError('#DIV/0!'); return num(a) / num(b)
          case '&': return `${a ?? ''}${b ?? ''}`
          case '=': return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
          case '<>': return String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase()
          default: throw new Error(`Оператор ${node.op} не поддержан`)
        }
      }
      case 'fn': {
        const args = node.args
        switch (node.name) {
          case 'IFERROR':
            try {
              const v = evaluate(args[0])
              if (v instanceof XlError) return evaluate(args[1])
              return v
            } catch (e) {
              if (e instanceof XlError) return evaluate(args[1])
              throw e
            }
          case 'IF': return evaluate(args[0]) ? evaluate(args[1]) : evaluate(args[2])
          case 'ROUND': return excelRound(num(evaluate(args[0])), num(evaluate(args[1])))
          case 'SUMIFS': {
            const sumCells = expandRange(args[0].v)
            const pairs = []
            for (let i = 1; i < args.length; i += 2) pairs.push([expandRange(args[i].v), evaluate(args[i + 1])])
            let total = 0
            sumCells.forEach((ref, idx) => {
              if (pairs.every(([cells, crit]) => criterionMatches(cellValue(cells[idx]), crit))) {
                const v = cellValue(ref)
                if (typeof v === 'number') total += v
              }
            })
            return total
          }
          default: throw new Error(`Функция ${node.name} не поддержана`)
        }
      }
      default: throw new Error('Неизвестный узел')
    }
  }
  return { value: cellValue }
}
