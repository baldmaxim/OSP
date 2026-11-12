// Смета КП / ПЗ объекта (вкладка «Смета» карточки объекта): разбор двух файлов в строки сметы.
//
//   • файл КП («… - КП до перекидок.xlsx», лист «Комм. затраты») — укрупнённые позиции по системам: разделы, группы,
//     позиции; у группы и укрупнённой позиции суммы — формулой SUBTOTAL(9, диапазон), у позиции — Кол-во ГП × за единицу.
//     Вложенность берётся из диапазонов SUBTOTAL, а не из кодов: в файле К14 у подробных позиций укрупнённой
//     «1.8.4.1 Отделка пола автостоянки» коды 1.8.2.8.x, а у вставленных строк («584.1 Люк потолочный») кода нет вовсе.
//   • файл «Смета» (листы «Паспорт», «Сводка», «Смета», «Освоение», «Коэффициенты», «Вне итога», «Детализация») — те же
//     позиции КП с прямыми затратами ПЗ (основные и вспомогательные материалы, работы) и коммерцией после коэффициентов.
//     Строка сметы связана со строкой КП по «№ п/п» = «Номер позиции» КП (у К14 совпали 3144 из 3145, последняя —
//     техническая «Округление до копеек»).
//
// Результат — одна таблица строк: строка КП со своими данными ПЗ (kp / pz). Отметки и распределения экономистов
// привязаны к строке, поэтому в видах «КП» и «ПЗ» они одни и те же. Формулы файла сверяются при разборе
// (formulaCheck), коэффициенты и паспорт — как в файле (meta). Модуль чистый: XLSX передаётся снаружи (в браузере
// грузится лениво), тесты — tests/tender/kp-estimate.test.mjs.

export const KP_ESTIMATE_PARSER_VERSION = 1

// ── Мелочи ──────────────────────────────────────────────────────────────────
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s\u00a0]+/g, ' ').trim()
const text = (v) => {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\u00a0/g, ' ').trim()
}

// Число из ячейки: число как есть; строка «1 234,5 ₽» — тоже число; пусто и «—» — null.
export function cellNumber(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).replace(/[₽\s\u00a0\u2007\u202f]/g, '').replace(',', '.')
  if (!s || s === '—' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Номер позиции («584.1» — вставленная строка): число без хвоста двоичной дроби, строка — как есть.
export function posText(v) {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6)
  return text(v)
}

// Код позиции: в листе «Смета» Excel превратил часть кодов в числа (7.4, 3791.1).
export const codeText = (v) => (typeof v === 'number' ? posText(v) : text(v))

// Ключ наименования: без регистра, ё, лишних пробелов и знаков по краям — для связи строк при новой версии файла.
export const nameKey = (s) => norm(s).replace(/["«»'`]/g, '').replace(/\s*([,.;:()])\s*/g, '$1')

// Ключ строки в базе — не длиннее 1000 знаков (kp_estimate_rows_row_key_check). У К14 наименования видеосерверов —
// по 1,2–1,4 тыс. знаков, ключ «номер + наименование» в базу не проходил. Длинный ключ — начало и отпечаток всего
// ключа: тот же текст даёт тот же ключ (перенос отметок на новую версию файла), короткие ключи — как раньше.
export const ROW_KEY_MAX = 400
function keyHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}
export const fitRowKey = (key) => (key.length <= ROW_KEY_MAX ? key : `${key.slice(0, ROW_KEY_MAX - 18)}~${keyHash(key)}`)

// Допуск сверки формул: копейка или миллионная доля суммы (у К14 J = G × O считается Excel в double).
const close = (a, b) => Math.abs((a || 0) - (b || 0)) <= Math.max(0.011, Math.abs(b || 0) * 1e-9)

// ── Чтение листа ────────────────────────────────────────────────────────────
// Ячейки листа построчно: { r (номер строки Excel, с 1), cells: [{ v, f }] }. Пустые строки пропускаются.
function sheetRows(XLSX, ws, maxCols = 40) {
  if (!ws || !ws['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const out = []
  const lastC = Math.min(range.e.c, maxCols - 1)
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells = []
    let any = false
    for (let c = 0; c <= lastC; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (!cell) { cells.push(null); continue }
      const v = cell.v === undefined ? null : cell.v
      if (v !== null && v !== '') any = true
      cells.push({ v, f: cell.f || null })
    }
    if (any) out.push({ r: r + 1, cells })
  }
  return out
}

const val = (row, i) => (i === undefined || i < 0 ? null : row.cells[i]?.v ?? null)
const formula = (row, i) => (i === undefined || i < 0 ? null : row.cells[i]?.f ?? null)

// Строка шапки: первая из первых 15, где нашлись все обязательные столбцы. map — { ключ: [подписи] }.
function findHeader(rows, map, required) {
  for (const row of rows.slice(0, 15)) {
    const cols = {}
    row.cells.forEach((cell, i) => {
      const h = norm(cell?.v)
      if (!h) return
      for (const [key, labels] of Object.entries(map)) {
        if (cols[key] === undefined && labels.some((l) => h === l)) cols[key] = i
      }
    })
    if (required.every((k) => cols[k] !== undefined)) return { headerRow: row.r, cols }
  }
  return null
}

// ── КП ──────────────────────────────────────────────────────────────────────
const KP_COLUMNS = {
  code: ['номер раздела', 'код', 'код позиции'],
  pos: ['номер позиции', '№ п/п', '№'],
  name: ['название', 'наименование', 'наименование затрат'],
  customerNote: ['примечание заказчика'],
  gpNote: ['примечание гп', 'примечание'],
  unit: ['единица', 'ед. изм.', 'ед. изм', 'ед.изм.'],
  qtyGp: ['количество (гп)', 'кол-во гп', 'количество гп'],
  qtyCustomer: ['кол-во заказчика', 'количество заказчика', 'количество (заказчика)'],
  base: ['базовая стоимость'],
  materials: ['итого материалов (кп), руб', 'итого материалов (кп)', 'итого материалов'],
  works: ['итого работ (кп), руб', 'итого работ (кп)', 'итого работ'],
  total: ['коммерческая стоимость', 'итого (кп), руб', 'итого'],
  unitBase: ['за единицу (база)'],
  unitCommercial: ['за единицу (коммерч.)', 'за единицу (коммерч)'],
  unitMaterials: ['за единицу материалов'],
  unitWorks: ['за единицу работ'],
}
const KP_REQUIRED = ['code', 'pos', 'name', 'unit', 'total']

const SUBTOTAL_RE = /SUBTOTAL\(\s*9\s*,\s*\$?[A-Z]+\$?(\d+)\s*:\s*\$?[A-Z]+\$?(\d+)\s*\)/i

// Лист КП в книге: шапка с номером раздела, номером позиции, названием, единицей и коммерческой стоимостью.
export function findKpSheet(XLSX, wb) {
  for (const name of wb.SheetNames) {
    const rows = sheetRows(XLSX, wb.Sheets[name])
    const header = findHeader(rows, KP_COLUMNS, KP_REQUIRED)
    // «Смета» тоже содержит «Код», «Наименование», «Ед. изм.» — но не «Номер позиции» + «Коммерческая стоимость».
    if (header && norm(val(rows.find((r) => r.r === header.headerRow), header.cols.total)) !== 'коммерция итого') {
      return { sheetName: name, rows, header }
    }
  }
  return null
}

export function parseKpWorkbook(XLSX, wb) {
  const found = findKpSheet(XLSX, wb)
  if (!found) return { error: 'kp_header', message: 'Не найден лист КП: нужны столбцы «Номер раздела», «Номер позиции», «Название», «Единица», «Коммерческая стоимость».' }
  const { sheetName, rows, header } = found
  const c = header.cols
  const data = rows.filter((r) => r.r > header.headerRow)
  const items = []
  let fileTotals = null
  let hasSubtotals = false
  for (const row of data) {
    const name = text(val(row, c.name))
    const code = codeText(val(row, c.code))
    const pos = posText(val(row, c.pos))
    if (!code && !pos && /^итого/i.test(name)) {
      fileTotals = {
        qtyGp: cellNumber(val(row, c.qtyGp)), qtyCustomer: cellNumber(val(row, c.qtyCustomer)), base: cellNumber(val(row, c.base)),
        materials: cellNumber(val(row, c.materials)), works: cellNumber(val(row, c.works)), total: cellNumber(val(row, c.total)),
      }
      continue
    }
    if (!name && !code && !pos) continue
    const f = formula(row, c.total) || formula(row, c.materials) || ''
    const sub = SUBTOTAL_RE.exec(f)
    if (sub) hasSubtotals = true
    items.push({
      sheetRow: row.r,
      code, pos, name,
      unit: text(val(row, c.unit)),
      customerNote: text(val(row, c.customerNote)),
      gpNote: text(val(row, c.gpNote)),
      kp: {
        qty_gp: cellNumber(val(row, c.qtyGp)),
        qty_customer: cellNumber(val(row, c.qtyCustomer)),
        base: cellNumber(val(row, c.base)),
        materials: cellNumber(val(row, c.materials)),
        works: cellNumber(val(row, c.works)),
        total: cellNumber(val(row, c.total)),
        unit_base: cellNumber(val(row, c.unitBase)),
        unit_commercial: cellNumber(val(row, c.unitCommercial)),
        unit_materials: cellNumber(val(row, c.unitMaterials)),
        unit_works: cellNumber(val(row, c.unitWorks)),
      },
      formulas: {
        materials: formula(row, c.materials),
        works: formula(row, c.works),
        total: formula(row, c.total),
      },
      range: sub ? [Number(sub[1]), Number(sub[2])] : null,
    })
  }
  if (!items.length) return { error: 'kp_empty', message: `На листе «${sheetName}» нет строк КП под шапкой.` }

  // Вложенность: строка входит в самый узкий диапазон SUBTOTAL, который её покрывает (диапазоны вложены).
  // Без формул (книга сохранена значениями) — по коду: родитель — ближайшая выше строка с кодом-префиксом.
  if (hasSubtotals) {
    const stack = []
    items.forEach((it, index) => {
      while (stack.length && stack[stack.length - 1].range[1] < it.sheetRow) stack.pop()
      it.parentIndex = stack.length ? stack[stack.length - 1].index : null
      if (it.range) stack.push({ range: it.range, index })
    })
  } else {
    const lastByCode = new Map()
    let lastParent = null
    items.forEach((it, index) => {
      if (it.code) {
        const parts = it.code.split('.')
        let parent = null
        for (let k = parts.length - 1; k > 0 && parent === null; k--) {
          const p = lastByCode.get(parts.slice(0, k).join('.'))
          if (p !== undefined) parent = p
        }
        it.parentIndex = parent
        lastByCode.set(it.code, index)
        lastParent = parent
      } else {
        it.parentIndex = lastParent
      }
    })
    // Группа без формулы — строка, у которой есть дети.
    for (const it of items) if (it.parentIndex !== null) items[it.parentIndex].range = items[it.parentIndex].range || [0, 0]
  }
  items.forEach((it, index) => { it.index = index })
  return { sheetName, headerRow: header.headerRow, items, fileTotals, hasSubtotals }
}

// ── Смета (ПЗ) ──────────────────────────────────────────────────────────────
const PZ_COLUMNS = {
  code: ['код'],
  pos: ['№ п/п'],
  sectionCode: ['код раздела'],
  section: ['раздел'],
  name: ['наименование'],
  note: ['примечание'],
  unit: ['ед. изм.', 'ед. изм', 'единица'],
  qtyCustomer: ['кол-во заказчика'],
  qtyGp: ['кол-во гп'],
  direct: ['прямые затраты'],
  directMain: ['прямые: основные материалы'],
  directAux: ['прямые: вспом. материалы'],
  directWorks: ['прямые: работы'],
  commMaterials: ['коммерция: материалы'],
  commWorks: ['коммерция: работы'],
  commTotal: ['коммерция итого'],
  unitPrice: ['цена за ед. коммерч.'],
  vat: ['ндс'],
  taken: ['забрано'],
  rest: ['остаток'],
  status: ['статус'],
}
const PZ_REQUIRED = ['code', 'name', 'direct', 'commTotal']

// Лист «Паспорт» / «Коэффициенты» / «Вне итога» / «Детализация» — как в файле: непустые строки значениями.
function rawSheet(XLSX, ws, maxCols = 12) {
  return sheetRows(XLSX, ws, maxCols).map((row) => {
    const cells = row.cells.map((cell) => (cell?.v === undefined ? null : cell?.v ?? null))
    while (cells.length && (cells[cells.length - 1] === null || cells[cells.length - 1] === '')) cells.pop()
    return cells
  })
}

const sheetByName = (wb, wanted) => wb.SheetNames.find((n) => norm(n) === norm(wanted))

export function parsePzWorkbook(XLSX, wb) {
  let sheetName = sheetByName(wb, 'Смета')
  let rows = sheetName ? sheetRows(XLSX, wb.Sheets[sheetName]) : []
  let header = sheetName ? findHeader(rows, PZ_COLUMNS, PZ_REQUIRED) : null
  if (!header) {
    for (const name of wb.SheetNames) {
      const r = sheetRows(XLSX, wb.Sheets[name])
      const h = findHeader(r, PZ_COLUMNS, PZ_REQUIRED)
      if (h) { sheetName = name; rows = r; header = h; break }
    }
  }
  if (!header) return { error: 'pz_header', message: 'Не найден лист «Смета»: нужны столбцы «Код», «Наименование», «Прямые затраты», «Коммерция итого».' }
  const c = header.cols
  const positions = []
  for (const row of rows.filter((r) => r.r > header.headerRow)) {
    const name = text(val(row, c.name))
    const code = codeText(val(row, c.code))
    if (!name && !code) continue
    positions.push({
      sheetRow: row.r,
      code,
      pos: posText(val(row, c.pos)),
      name,
      unit: text(val(row, c.unit)),
      pz: {
        code,
        pos: posText(val(row, c.pos)),
        section_code: codeText(val(row, c.sectionCode)),
        section: text(val(row, c.section)),
        note: text(val(row, c.note)),
        qty_customer: cellNumber(val(row, c.qtyCustomer)),
        qty_gp: cellNumber(val(row, c.qtyGp)),
        direct: cellNumber(val(row, c.direct)),
        direct_main: cellNumber(val(row, c.directMain)),
        direct_aux: cellNumber(val(row, c.directAux)),
        direct_works: cellNumber(val(row, c.directWorks)),
        comm_materials: cellNumber(val(row, c.commMaterials)),
        comm_works: cellNumber(val(row, c.commWorks)),
        comm_total: cellNumber(val(row, c.commTotal)),
        vat: text(val(row, c.vat)),
      },
    })
  }
  // «Освоение»: списания бюджета (дата, код раздела, код позиции, наименование, документ, сумма, комментарий).
  const mastering = []
  const mName = sheetByName(wb, 'Освоение')
  if (mName) {
    const mRows = sheetRows(XLSX, wb.Sheets[mName], 8)
    for (const row of mRows.slice(1)) {
      const sum = cellNumber(row.cells[5]?.v)
      const code = codeText(row.cells[2]?.v)
      if (!code || sum === null) continue
      mastering.push({
        date: row.cells[0]?.v ?? null, sectionCode: codeText(row.cells[1]?.v), code, name: text(row.cells[3]?.v),
        document: text(row.cells[4]?.v), sum, comment: text(row.cells[6]?.v),
      })
    }
  }
  const passportName = sheetByName(wb, 'Паспорт')
  const passport = passportName ? rawSheet(XLSX, wb.Sheets[passportName], 2) : []
  const coefName = sheetByName(wb, 'Коэффициенты')
  const summaryName = sheetByName(wb, 'Сводка')
  const outName = sheetByName(wb, 'Вне итога')
  const detName = sheetByName(wb, 'Детализация')
  let summaryTotals = null
  if (summaryName) {
    for (const r of rawSheet(XLSX, wb.Sheets[summaryName], 9)) {
      if (norm(r[1]) === 'итого') summaryTotals = { count: cellNumber(r[2]), direct: cellNumber(r[3]), materials: cellNumber(r[4]), works: cellNumber(r[5]), total: cellNumber(r[6]), taken: cellNumber(r[7]), rest: cellNumber(r[8]) }
    }
  }
  return {
    sheetName,
    headerRow: header.headerRow,
    positions,
    mastering,
    passport,
    coefficients: coefName ? rawSheet(XLSX, wb.Sheets[coefName], 6) : [],
    outOfTotal: outName ? rawSheet(XLSX, wb.Sheets[outName], 10) : [],
    detail: detName ? rawSheet(XLSX, wb.Sheets[detName], 10) : [],
    summaryTotals,
  }
}

// Какой это файл: 'kp' | 'pz' | null. У сметы есть лист «Смета» с «Прямыми затратами».
export function detectEstimateWorkbook(XLSX, wb) {
  const pz = parsePzWorkbook(XLSX, wb)
  if (!pz.error && pz.positions.length) return 'pz'
  if (findKpSheet(XLSX, wb)) return 'kp'
  return null
}

// ── Сборка строк сметы ──────────────────────────────────────────────────────
// kind: title — заголовок без сумм («Корпус 14»); section — раздел (верхний уровень); group — группа; aggregate —
// укрупнённая позиция КП (своя единица и объём, состав — подробные позиции ниже); position — позиция; note — строка
// без единицы и сумм; adjust — техническая строка ПЗ вне КП («Округление до копеек»).
export const ROW_KINDS = ['title', 'section', 'group', 'aggregate', 'position', 'note', 'adjust']

function kindOf(it, hasChildren) {
  if (hasChildren || it.range) {
    if (it.unit) return 'aggregate'
    return it.parentIndex === null ? 'section' : 'group'
  }
  if (it.unit) return 'position'
  const k = it.kp
  const empty = [k.total, k.materials, k.works, k.qty_gp, k.qty_customer].every((v) => !v)
  if (empty && it.parentIndex === null) return 'title'
  return empty ? 'note' : 'position'
}

// Сверка формул файла: позиция — материалы = Кол-во ГП × за ед. материалов, работы = Кол-во ГП × за ед. работ,
// итог = материалы + работы; группа — сумма вложенных строк; итог файла — сумма позиций.
function checkFormulas(items, children, fileTotals) {
  const issues = []
  const sumOf = (index, key) => (children.get(index) || []).reduce((s, ch) => s + (items[ch].kp[key] || 0), 0)
  for (const it of items) {
    const k = it.kp
    if (children.has(it.index)) {
      for (const key of ['materials', 'works', 'total']) {
        if (!close(sumOf(it.index, key), k[key])) issues.push({ row: it.sheetRow, code: it.code, key, expected: sumOf(it.index, key), actual: k[key] })
      }
    } else if (it.unit) {
      if (k.unit_materials !== null && k.qty_gp !== null && it.formulas.materials && !close(k.qty_gp * k.unit_materials, k.materials)) {
        issues.push({ row: it.sheetRow, code: it.code, key: 'materials', expected: k.qty_gp * k.unit_materials, actual: k.materials })
      }
      if (k.unit_works !== null && k.qty_gp !== null && it.formulas.works && !close(k.qty_gp * k.unit_works, k.works)) {
        issues.push({ row: it.sheetRow, code: it.code, key: 'works', expected: k.qty_gp * k.unit_works, actual: k.works })
      }
      if (!close((k.materials || 0) + (k.works || 0), k.total)) {
        issues.push({ row: it.sheetRow, code: it.code, key: 'total', expected: (k.materials || 0) + (k.works || 0), actual: k.total })
      }
    }
  }
  const leafSum = (key) => items.filter((it) => !children.has(it.index)).reduce((s, it) => s + (it.kp[key] || 0), 0)
  const totals = { materials: leafSum('materials'), works: leafSum('works'), total: leafSum('total') }
  if (fileTotals) {
    for (const key of ['materials', 'works', 'total']) {
      if (fileTotals[key] !== null && Math.abs(totals[key] - fileTotals[key]) > 0.05) issues.push({ row: null, code: 'ИТОГО', key, expected: totals[key], actual: fileTotals[key] })
    }
  }
  return { issues, totals }
}

// Строки сметы из КП и/или сметы ПЗ. Возвращает { rows, meta, stats } или { error, message }.
export function buildEstimateRows({ kp = null, pz = null, kpFileName = '', pzFileName = '' } = {}) {
  if (!kp && !pz) return { error: 'no_files', message: 'Нужен файл КП, файл сметы ПЗ или оба.' }
  const rows = []
  const stats = { kpRows: 0, pzPositions: pz?.positions?.length || 0, linked: 0, pzOnly: 0, kpLeavesWithoutPz: 0 }
  let formulaCheck = { issues: [], totals: null }

  if (kp) {
    const children = new Map()
    for (const it of kp.items) {
      if (it.parentIndex === null || it.parentIndex === undefined) continue
      if (!children.has(it.parentIndex)) children.set(it.parentIndex, [])
      children.get(it.parentIndex).push(it.index)
    }
    formulaCheck = checkFormulas(kp.items, children, kp.fileTotals)
    // ПЗ к строке КП: по «№ п/п» = «Номер позиции»; не нашлось — по коду и наименованию.
    const pzByPos = new Map()
    const pzByCodeName = new Map()
    for (const p of pz?.positions || []) {
      if (p.pos) pzByPos.set(p.pos, p)
      pzByCodeName.set(`${p.code}|${nameKey(p.name)}`, p)
    }
    const used = new Set()
    const level = new Map()
    for (const it of kp.items) {
      const parent = it.parentIndex ?? null
      const lv = parent === null ? 1 : (level.get(parent) || 1) + 1
      level.set(it.index, lv)
      const hasChildren = children.has(it.index)
      const kind = kindOf(it, hasChildren)
      let p = null
      if (!hasChildren && kind !== 'title') {
        p = (it.pos && pzByPos.get(it.pos)) || pzByCodeName.get(`${it.code}|${nameKey(it.name)}`) || null
        if (p && used.has(p)) p = null
        if (p) { used.add(p); stats.linked++ } else if (kind === 'position') stats.kpLeavesWithoutPz++
      }
      rows.push({
        row_no: rows.length + 1,
        parent_row_no: parent === null ? null : parent + 1,
        level: lv,
        kind,
        code: it.code || null,
        pos_no: it.pos || null,
        name: it.name,
        unit: it.unit || null,
        customer_note: it.customerNote || null,
        gp_note: it.gpNote || null,
        kp: { ...it.kp, sheet_row: it.sheetRow },
        pz: p ? slimPz(p, it) : null,
      })
    }
    stats.kpRows = kp.items.length
    // Строки ПЗ без КП — в конец (техническое округление и т. п.); в КП их нет — и в его суммах тоже.
    for (const p of pz?.positions || []) {
      if (used.has(p)) continue
      stats.pzOnly++
      rows.push({ ...pzOnlyRow(p, rows.length + 1, null, 1), kp: null })
    }
  } else {
    // Только смета ПЗ: разделы — по «Коду раздела», позиции под ними.
    const sections = new Map()
    for (const p of pz.positions) {
      const isAdjust = /^округл/i.test(p.code)
      if (isAdjust) continue
      const key = p.pz.section_code || '—'
      if (!sections.has(key)) {
        rows.push({
          row_no: rows.length + 1, parent_row_no: null, level: 1, kind: 'section', code: key === '—' ? null : key, pos_no: null,
          name: p.pz.section || `Раздел ${key}`, unit: null, customer_note: null, gp_note: null, kp: null, pz: null,
        })
        sections.set(key, rows.length)
      }
      rows.push(pzOnlyRow(p, rows.length + 1, sections.get(key), 2))
    }
    for (const p of pz.positions.filter((x) => /^округл/i.test(x.code))) rows.push(pzOnlyRow(p, rows.length + 1, null, 1))
    stats.pzOnly = pz.positions.length
  }

  // Ключ строки — для переноса отметок на новую версию файла: номер позиции + наименование (+ код для строк без номера).
  const seen = new Map()
  for (const r of rows) {
    let key = fitRowKey(r.pos_no ? `p:${r.pos_no}|${nameKey(r.name)}` : `c:${r.code || ''}|${nameKey(r.name)}|${r.kind}`)
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    if (n > 1) key += `#${n}`
    r.row_key = key
  }

  const meta = {
    parser: KP_ESTIMATE_PARSER_VERSION,
    title: titleFrom(pz, kp, kpFileName || pzFileName),
    kp_file: kp ? { name: kpFileName, sheet: kp.sheetName, header_row: kp.headerRow, has_subtotals: kp.hasSubtotals, totals: kp.fileTotals } : null,
    pz_file: pz ? { name: pzFileName, sheet: pz.sheetName, header_row: pz.headerRow, totals: pz.summaryTotals } : null,
    passport: pz?.passport || [],
    coefficients: pz?.coefficients || [],
    out_of_total: pz?.outOfTotal || [],
    detail: pz?.detail || [],
    vat: vatFrom(pz),
    pz_sections: pzSections(pz),
    formula_check: { issues: formulaCheck.issues.slice(0, 50), issue_count: formulaCheck.issues.length, totals: formulaCheck.totals },
    stats,
    row_count: rows.length,
  }
  for (const r of rows) if (r.pz && r.pz.vat === meta.vat) delete r.pz.vat
  return { rows, meta, stats, mastering: pz?.mastering || [] }
}

function pzOnlyRow(p, rowNo, parentRowNo, level) {
  const isAdjust = /^округл/i.test(p.code)
  return {
    row_no: rowNo,
    parent_row_no: parentRowNo,
    level,
    kind: isAdjust ? 'adjust' : 'position',
    code: p.code || null,
    pos_no: p.pos || null,
    name: p.name,
    unit: p.unit || null,
    customer_note: null,
    gp_note: null,
    kp: {
      qty_gp: p.pz.qty_gp, qty_customer: p.pz.qty_customer, base: p.pz.direct, materials: p.pz.comm_materials, works: p.pz.comm_works,
      total: p.pz.comm_total, unit_base: null, unit_commercial: null, unit_materials: null, unit_works: null, sheet_row: null,
    },
    pz: slimPz(p, null),
  }
}

// ПЗ строки без повторов: код и номер — только если отличаются от КП, название раздела — один раз в meta.pz_sections
// (у К14 полное название раздела в каждой позиции — треть всего объёма), НДС — только если не как у сметы.
function slimPz(p, kpItem) {
  const { code, pos, ...rest } = p.pz
  delete rest.section
  const out = { ...rest, sheet_row: p.sheetRow }
  if (!kpItem || code !== (kpItem.code || '')) out.code = code
  if (!kpItem || pos !== (kpItem.pos || '')) out.pos = pos
  return out
}

function pzSections(pz) {
  const out = {}
  for (const p of pz?.positions || []) if (p.pz.section_code && p.pz.section && !(p.pz.section_code in out)) out[p.pz.section_code] = p.pz.section
  return out
}

function titleFrom(pz, kp, fileName) {
  const pass = (pz?.passport || []).find((r) => norm(r[0]) === 'объект')
  if (pass?.[1]) return text(pass[1])
  if (pz?.passport?.[0]?.[0] && pz.passport[0].length === 1) return text(pz.passport[0][0])
  const title = kp?.items?.find((it) => kindOf(it, false) === 'title' && it.parentIndex === null)
  if (title?.name) return title.name
  return String(fileName || 'Смета').replace(/\.(xlsx|xlsm|xls)$/i, '')
}

function vatFrom(pz) {
  const pass = (pz?.passport || []).find((r) => norm(r[0]) === 'ндс в этой смете')
  if (pass?.[1]) return text(pass[1])
  const first = pz?.positions?.find((p) => p.pz.vat)
  return first?.pz.vat || null
}

// Списания листа «Освоение» → распределения: объём = сумма / цена за единицу позиции (бюджет у сметы — в рублях,
// распределения у портала — в объёме). Документ — подписью тендера, комментарий — примечанием.
export function masteringToAllocations(mastering, rows) {
  const byCode = new Map()
  // Код позиции ПЗ: свой, если отличается от КП, иначе код строки (slimPz не повторяет одинаковый).
  for (const r of rows) if (r.pz && (r.pz.code ?? r.code)) byCode.set(r.pz.code ?? r.code, r)
  const out = []
  const skipped = []
  for (const m of mastering || []) {
    const row = byCode.get(m.code)
    const qty = row ? rowQuantity(row) : null
    const total = row?.pz?.comm_total ?? row?.kp?.total
    if (!row || !qty || !total) { skipped.push(m); continue }
    const price = total / qty
    out.push({
      row_no: row.row_no,
      tender_label: m.document || 'Освоение',
      pz_qty: Math.round((m.sum / price) * 1e6) / 1e6,
      note: [m.comment, m.date ? `из листа «Освоение» от ${m.date}` : 'из листа «Освоение»'].filter(Boolean).join('; '),
    })
  }
  return { allocations: out, skipped }
}

// Объём позиции, по которому считана её цена: Кол-во ГП, иначе Кол-во заказчика (как «Цена за ед. коммерч.» сметы).
export function rowQuantity(row) {
  const gp = row?.kp?.qty_gp ?? row?.pz?.qty_gp
  if (gp) return gp
  const cust = row?.kp?.qty_customer ?? row?.pz?.qty_customer
  return cust || 0
}
