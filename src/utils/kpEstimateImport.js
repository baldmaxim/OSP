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
//   • один файл (13.11.2026: «переработанный файл совмещает КП до перекидок и план затрат») — книга, где есть и лист КП,
//     и лист «Смета», или лист КП, у которого рядом со столбцами КП — прямые затраты («Прямые затраты», «Прямые:
//     основные материалы» …): тогда план затрат берётся из той же строки.
//
//   • КП с ресурсами ПЗ одним листом (26.11.2026, «Алия — КП до перекидок после ДС1–8», лист «КП до перекидок») — те же
//     строки КП (раздел, подраздел, работа), но под каждой работой — её ресурсы ПЗ (мат / суб-мат / раб / суб-раб,
//     добавки ДС «Материалы» / «Работы»); вид строки — столбец «Тип строки / затрат». Вложенность — группировка строк
//     Excel (кнопки слева), формулы SUBTOTAL там многодиапазонные. Ресурсы строками сметы не становятся: их сумма —
//     прямые затраты работы (основные / вспомогательные материалы по «Типу материала», работы). Над деревом — итоги
//     файла (в паспорт), под деревом — «Контрольные расчёты» (оттуда берутся только коэффициенты): дерево кончается на
//     первой строке без типа.
//     Та же раскладка с другими подписями (27.11.2026, «King_Sons_КП_до_перекидок_единый_ДС1-14»): строки КП — «Раздел» /
//     «Подраздел» / «Позиция», прямые затраты — «ПЗ · материалы / работы / всего», итоги файла — над шапкой.
//
//   • КП с этапами договора (27.11.2026, «Событие_6_2_КП_до_перекидок,_ДГП,_Допники», лист «Комм. затраты») — номера
//     позиции нет, код раздела у каждой строки; справа — те же суммы по этапам («ДГП 12.01.2026 Материалы, руб.», «ДС №1 …»).
//     Вложенность — SUBTOTAL материалов и работ (итог строки — SUM(материалы:работы)). Этапы в строки сметы не идут: их итоги —
//     в паспорт, цены этапа ставит администратор окном «Цены по документу» (kpEstimatePrices.js).
//
// Результат — одна таблица строк: строка КП со своими данными ПЗ (kp / pz). Формулы файла сверяются при разборе
// (formulaCheck), коэффициенты и паспорт — как в файле (meta). Модуль чистый: XLSX передаётся снаружи (в браузере
// грузится лениво), тесты — tests/tender/kp-estimate.test.mjs.

export const KP_ESTIMATE_PARSER_VERSION = 2

// Как читать книгу (окно загрузки и тесты — одинаково): формулы — для вложенности по SUBTOTAL и сверки, cellStyles —
// ради уровней группировки строк (без него SheetJS не читает ws['!rows'], и дерево листа с ресурсами стало бы плоским).
// Передавать копией ({ ...ESTIMATE_READ_OPTIONS }): XLSX.read дописывает в объект параметров свои поля (type).
export const ESTIMATE_READ_OPTIONS = { cellFormula: true, cellStyles: true }

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
// Ячейки листа построчно: { r (номер строки Excel, с 1), level (уровень группировки), cells: [{ v, f }] }. Пустые
// строки пропускаются. Прочитанный лист запоминается: книгу смотрят определение вида, разбор КП и разбор ПЗ.
const sheetCache = new WeakMap()
function sheetRows(XLSX, ws, maxCols = 40) {
  if (!ws || !ws['!ref']) return []
  let byCols = sheetCache.get(ws)
  if (!byCols) { byCols = new Map(); sheetCache.set(ws, byCols) }
  if (!byCols.has(maxCols)) byCols.set(maxCols, readSheetRows(XLSX, ws, maxCols))
  return byCols.get(maxCols)
}
function readSheetRows(XLSX, ws, maxCols) {
  const range = XLSX.utils.decode_range(ws['!ref'])
  const props = ws['!rows'] || []
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
    if (any) out.push({ r: r + 1, level: props[r]?.level || 0, cells })
  }
  return out
}

const val = (row, i) => (i === undefined || i < 0 ? null : row.cells[i]?.v ?? null)
const formula = (row, i) => (i === undefined || i < 0 ? null : row.cells[i]?.f ?? null)

// Строка шапки: первая из первых 15, где нашлись все обязательные столбцы. map — { ключ: [подписи] }; подпись —
// точный текст или выражение (подпись с датой или номером ДС).
const labelHit = (h, l) => (l instanceof RegExp ? l.test(h) : h === l)
function findHeader(rows, map, required) {
  for (const row of rows.slice(0, 15)) {
    const cols = {}
    row.cells.forEach((cell, i) => {
      const h = norm(cell?.v)
      if (!h) return
      for (const [key, labels] of Object.entries(map)) {
        if (cols[key] === undefined && labels.some((l) => labelHit(h, l))) cols[key] = i
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
  // План затрат в той же строке (один файл «КП + ПЗ»).
  direct: ['прямые затраты', 'прямые затраты, руб', 'прямые затраты (пз)', 'пз: прямые затраты'],
  directMain: ['прямые: основные материалы', 'основные материалы (пз)', 'прямые затраты: основные материалы'],
  directAux: ['прямые: вспом. материалы', 'вспомогательные материалы (пз)', 'прямые затраты: вспомогательные материалы'],
  directWorks: ['прямые: работы', 'работы (пз)', 'прямые затраты: работы'],
  pzNote: ['примечание пз', 'примечание (пз)'],
}
const KP_REQUIRED = ['code', 'pos', 'name', 'unit', 'total']

const SUBTOTAL_RE = /SUBTOTAL\(\s*9\s*,\s*\$?[A-Z]+\$?(\d+)\s*:\s*\$?[A-Z]+\$?(\d+)\s*\)/i
// Диапазон SUBTOTAL строки — в итоге, материалах или работах: у «События 6.2» итог строки — SUM(материалы:работы), а SUBTOTAL
// стоит у материалов и работ (без этого вложенность молча собиралась бы по кодам).
function subtotalOf(row, c) {
  for (const key of ['total', 'materials', 'works']) {
    const m = SUBTOTAL_RE.exec(formula(row, c[key]) || '')
    if (m) return m
  }
  return null
}
// Строка входит в самый узкий диапазон SUBTOTAL, который её покрывает (диапазоны вложены).
function nestBySubtotal(items) {
  const stack = []
  items.forEach((it, index) => {
    while (stack.length && stack[stack.length - 1].range[1] < it.sheetRow) stack.pop()
    it.parentIndex = stack.length ? stack[stack.length - 1].index : null
    if (it.range) stack.push({ range: it.range, index })
  })
}
// Буква столбца по номеру (0 — A): какой столбец кол-ва умножает формула суммы строки.
const colName = (i) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// КП с ресурсами ПЗ одним листом (раскладка «Алия — КП до перекидок после ДС1–8»). Отдельная карта шапки: подписи
// К14 не трогаем. Столбцы справа (расценки, ссылки, «Код в ПЗ», «Кол-во ГП (ПЗ)») не нужны: строка КП берёт кол-во и
// суммы из основных столбцов, ресурс — сумму ПЗ и «ПЗ × коэфф.».
const TREE_COLUMNS = {
  code: ['код раздела'],
  pos: ['№ позиции'],
  name: ['наименование раздела / работы / ресурса'],
  type: ['тип строки / затрат'],
  unit: ['ед. изм.'],
  qtyCustomer: ['кол-во заказчика'],
  qtyGp: ['кол-во гп / ресурса'],
  materials: ['кп · материалы, ₽'],
  works: ['кп · работы, ₽'],
  total: ['кп · всего, ₽'],
  direct: ['пз · известная часть, ₽'],
  coefTotal: ['пз × коэфф., ₽'],
  status: ['статус / примечание'],
  base: ['база по кп, ₽'],
  unitBase: ['база кп за ед., ₽'],
  unitMaterials: ['кп · мат. за ед., ₽'],
  unitWorks: ['кп · раб. за ед., ₽'],
  unitCommercial: ['кп · всего за ед., ₽'],
  customerNote: ['примечание заказчика (кп)'],
  gpNote: ['примечание гп (кп)'],
  materialType: ['тип материала'],
  pzNote: ['примечание гп (пз)'],
}
const TREE_REQUIRED = ['code', 'pos', 'name', 'type', 'unit', 'total', 'direct']
// Та же раскладка «King & Sons» (27.11.2026): строки КП — «Раздел» / «Подраздел» / «Позиция», кода раздела в начале нет
// (столбец «№ раздела · КП» почти пуст), прямые затраты — «ПЗ · материалы / работы / всего» (у ресурса — его сумма).
const TREE_COLUMNS_KS = {
  code: ['№ раздела · кп'],
  pos: ['№ позиции'],
  name: ['наименование работ и ресурсов'],
  type: ['тип строки'],
  unit: ['ед. изм.'],
  qtyGp: ['количество гп'],
  qtyCustomer: ['количество заказчика'],
  materials: ['кп · материалы, ₽'],
  works: ['кп · работы, ₽'],
  total: ['кп · всего, ₽'],
  direct: ['пз · всего, ₽'],
  base: ['кп · базовая стоимость, ₽'],
  unitBase: ['кп · базовая цена за ед., ₽'],
  unitCommercial: ['кп · коммерческая цена за ед., ₽'],
  unitMaterials: ['кп · материалы за ед., ₽'],
  unitWorks: ['кп · работы за ед., ₽'],
  customerNote: ['примечание заказчика · кп'],
  gpNote: ['примечание гп · кп'],
  materialType: ['тип материала'],
  pzNote: ['примечание гп · пз'],
}
const TREE_LAYOUTS = [
  { cols: TREE_COLUMNS, required: TREE_REQUIRED },
  { cols: TREE_COLUMNS_KS, required: ['pos', 'name', 'type', 'unit', 'total', 'direct'] },
]
// Типы строк-ресурсов ПЗ — точно (не по началу слова: «Работа» — строка КП, «Работы» — ресурс-добавка ДС).
const RESOURCE_WORKS = new Set(['раб', 'суб-раб', 'работы'])
const RESOURCE_MATERIALS = new Set(['мат', 'суб-мат', 'материалы'])
const isResourceType = (t) => RESOURCE_WORKS.has(t) || RESOURCE_MATERIALS.has(t)

// КП с этапами договора («Событие 6.2»): номера позиции нет, суммы КП — «Итого материалы / работы», итог строки —
// «КП до перекидок Итого материалы + работы, руб.»; этапы (ДГП, ДС) — столбцы справа, их ищет stageColumns.
const STAGE_COLUMNS = {
  code: ['номер раздела'],
  name: ['наименование'],
  qtyCustomer: ['кол-во заказчика'],
  qtyGp: ['кол-во гп'],
  unit: ['ед. изм.', 'ед. изм', 'единица'],
  unitMaterials: ['цена за ед. мат-ал в кп', /^цена за ед\.? мат/],
  unitWorks: ['цена за ед. раб', /^цена за ед\.? раб/],
  materials: ['итого материалы'],
  works: ['итого работы'],
  gpNote: ['примечание гп'],
  total: [/^кп до перекидок.*итого/],
  psdcRef: [/^сопоставление с .*псдц/],
}
const STAGE_REQUIRED = ['code', 'name', 'unit', 'materials', 'works', 'total']

// Лист КП в книге: шапка листа КП с ресурсами ПЗ (layout: 'tree'), КП с этапами договора (layout: 'stages') или шапка
// с номером раздела, номером позиции, названием, единицей и коммерческой стоимостью (К14, «Лот 31»).
export function findKpSheet(XLSX, wb) {
  for (const name of wb.SheetNames) {
    const rows = sheetRows(XLSX, wb.Sheets[name])
    for (const layout of TREE_LAYOUTS) {
      const tree = findHeader(rows, layout.cols, layout.required)
      if (tree) return { sheetName: name, rows, header: tree, layout: 'tree' }
    }
    const stages = findHeader(rows, STAGE_COLUMNS, STAGE_REQUIRED)
    if (stages) return { sheetName: name, rows, header: stages, layout: 'stages' }
    const header = findHeader(rows, KP_COLUMNS, KP_REQUIRED)
    // «Смета» тоже содержит «Код», «Наименование», «Ед. изм.» — но не «Номер позиции» + «Коммерческая стоимость».
    if (header && norm(val(rows.find((r) => r.r === header.headerRow), header.cols.total)) !== 'коммерция итого') {
      return { sheetName: name, rows, header }
    }
  }
  return null
}

// Без формул SUBTOTAL и без группировки — по коду: родитель — ближайшая выше строка с кодом-префиксом; строка без
// кода — рядом с предыдущей строкой с кодом. Группа — строка, у которой есть дети.
function nestByCodes(items) {
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
  for (const it of items) if (it.parentIndex !== null) items[it.parentIndex].range = items[it.parentIndex].range || [0, 0]
}

export function parseKpWorkbook(XLSX, wb) {
  const found = findKpSheet(XLSX, wb)
  if (!found) return { error: 'kp_header', message: 'Не найден лист КП: нужны столбцы «Номер раздела», «Номер позиции», «Название», «Единица», «Коммерческая стоимость».' }
  if (found.layout === 'tree') return parseKpTreeSheet(found)
  if (found.layout === 'stages') return parseKpStagesSheet(found)
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
    const sub = subtotalOf(row, c)
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
      pzInline: c.direct === undefined ? null : {
        direct: cellNumber(val(row, c.direct)),
        direct_main: cellNumber(val(row, c.directMain)),
        direct_aux: cellNumber(val(row, c.directAux)),
        direct_works: cellNumber(val(row, c.directWorks)),
        comm_materials: cellNumber(val(row, c.materials)),
        comm_works: cellNumber(val(row, c.works)),
        comm_total: cellNumber(val(row, c.total)),
        note: text(val(row, c.pzNote)),
        qty_gp: cellNumber(val(row, c.qtyGp)),
      },
    })
  }
  if (!items.length) return { error: 'kp_empty', message: `На листе «${sheetName}» нет строк КП под шапкой.` }

  // Вложенность: строка входит в самый узкий диапазон SUBTOTAL, который её покрывает (диапазоны вложены).
  // Без формул (книга сохранена значениями) — по коду: родитель — ближайшая выше строка с кодом-префиксом.
  if (hasSubtotals) nestBySubtotal(items)
  else nestByCodes(items)
  items.forEach((it, index) => { it.index = index })
  return {
    sheetName, headerRow: header.headerRow, items, fileTotals, hasSubtotals, hasInlinePz: c.direct !== undefined,
    nesting: hasSubtotals ? 'subtotal' : 'codes',
  }
}

// ── КП с этапами договора («Событие 6.2») ───────────────────────────────────
// Сумма строки посчитана от «Кол-ва заказчика» (формула «C19*F19»), а «Кол-во ГП» пусто или 0 (у «События 6.2» — 70 позиций
// с деньгами): объём позиции — кол-во заказчика, иначе у позиции со стоимостью не было бы объёма и цены за единицу. Кол-во ГП
// файла остаётся в kp.qty_gp_file, признак — kp.qty_basis = 'customer'. Строки без денег (кол-во заказчика при «Учтено в …»)
// остаются с ГП, как у К14 (13.11.2026: «ориентируемся только на Количество (ГП)»). Выключатель — здесь.
const QTY_BY_CUSTOMER_FORMULA = true
const QTY_FORMULA_RE = /^\s*=?\s*\$?([A-Z]{1,3})\$?\d+\s*\*/i

// Столбцы этапов справа от КП: «<этап> Материалы, руб.» / «… Работы, руб.» / «… Итого, руб.»; подпись короче — в строке над
// шапкой («ДС №1 01.03.2026»). Процент изменения и пустые столбцы между этапами не нужны.
const STAGE_HEAD_RE = /^(.+?)\s+(материалы|работы|итого)(?:,\s*руб\.?)?$/i
const STAGE_PART = { материалы: 'materials', работы: 'works', итого: 'total' }
export function stageColumns(rows, header) {
  const head = rows.find((r) => r.r === header.headerRow)
  const above = rows.find((r) => r.r === header.headerRow - 1)
  const used = new Set(Object.values(header.cols))
  const byLabel = new Map()
  head?.cells.forEach((cell, i) => {
    if (used.has(i)) return
    const raw = text(cell?.v).replace(/\s+/g, ' ')
    const m = STAGE_HEAD_RE.exec(raw)
    if (!m || /^кп до перекидок/i.test(m[1])) return
    let s = byLabel.get(m[1])
    if (!s) {
      s = { label: m[1], short: text(above?.cells[i]?.v) || m[1], cols: {} }
      byLabel.set(m[1], s)
    }
    const part = STAGE_PART[m[2].toLowerCase()]
    if (s.cols[part] === undefined) s.cols[part] = i
  })
  return [...byLabel.values()].filter((s) => s.cols.total !== undefined || (s.cols.materials !== undefined && s.cols.works !== undefined))
}
function stageValues(row, stages) {
  return stages.map((s) => {
    const m = cellNumber(val(row, s.cols.materials))
    const w = cellNumber(val(row, s.cols.works))
    const t = s.cols.total !== undefined ? cellNumber(val(row, s.cols.total)) : (m === null && w === null ? null : (m || 0) + (w || 0))
    return { materials: m, works: w, total: t }
  })
}

function parseKpStagesSheet({ sheetName, rows, header }) {
  const c = header.cols
  const stages = stageColumns(rows, header)
  const custCol = c.qtyCustomer === undefined ? null : colName(c.qtyCustomer)
  const items = []
  const after = []
  let fileTotals = null
  let fileStages = null
  let ended = false
  let hasSubtotals = false
  let byCustomer = 0
  for (const row of rows) {
    if (row.r <= header.headerRow) continue
    const name = text(val(row, c.name))
    const code = codeText(val(row, c.code))
    if (ended) {
      // Под итогом: строки вне КП («Новые позиции ПСДЦ, отсутствующие в КП») и пояснения этапов под их столбцами.
      if (name) after.push(name)
      for (const s of stages) {
        const note = row.cells[s.cols.materials ?? s.cols.total]?.v
        if (typeof note === 'string' && note.trim() && !s.note) s.note = text(note)
      }
      continue
    }
    if (!code && /^итого/i.test(name)) {
      fileTotals = { materials: cellNumber(val(row, c.materials)), works: cellNumber(val(row, c.works)), total: cellNumber(val(row, c.total)) }
      fileStages = stageValues(row, stages)
      ended = true
      continue
    }
    if (!name && !code) continue
    const sub = subtotalOf(row, c)
    if (sub) hasSubtotals = true
    const qtyGpFile = cellNumber(val(row, c.qtyGp))
    const qtyCustomer = cellNumber(val(row, c.qtyCustomer))
    const total = cellNumber(val(row, c.total))
    const qf = sub ? null : QTY_FORMULA_RE.exec(formula(row, c.materials) || formula(row, c.works) || '')
    const customerBasis = QTY_BY_CUSTOMER_FORMULA && !!qf && qf[1].toUpperCase() === custCol && !qtyGpFile && !!total && !!qtyCustomer
    if (customerBasis) byCustomer++
    const psdcRef = text(val(row, c.psdcRef))
    items.push({
      sheetRow: row.r,
      code, pos: '', name,
      unit: text(val(row, c.unit)),
      customerNote: '',
      gpNote: text(val(row, c.gpNote)),
      kp: {
        qty_gp: customerBasis ? qtyCustomer : qtyGpFile,
        qty_customer: qtyCustomer,
        base: null,
        materials: cellNumber(val(row, c.materials)),
        works: cellNumber(val(row, c.works)),
        total,
        unit_base: null,
        unit_commercial: null,
        unit_materials: sub ? null : cellNumber(val(row, c.unitMaterials)),
        unit_works: sub ? null : cellNumber(val(row, c.unitWorks)),
        ...(customerBasis ? { qty_basis: 'customer', qty_gp_file: qtyGpFile } : {}),
        ...(psdcRef ? { psdc_ref: psdcRef } : {}),
      },
      formulas: { materials: formula(row, c.materials), works: formula(row, c.works), total: formula(row, c.total) },
      range: sub ? [Number(sub[1]), Number(sub[2])] : null,
      stages: stageValues(row, stages),
      pzInline: null,
    })
  }
  if (!items.length) return { error: 'kp_empty', message: `На листе «${sheetName}» нет строк КП под шапкой.` }
  if (hasSubtotals) nestBySubtotal(items)
  else nestByCodes(items)
  items.forEach((it, index) => { it.index = index })

  const money = (t) => (t ? `${fmtRub(t.total || 0)}${t.materials !== null || t.works !== null ? ` (материалы ${fmtRub(t.materials || 0)}, работы ${fmtRub(t.works || 0)})` : ''}` : '—')
  const passport = []
  if (fileTotals) passport.push(['КП до перекидок', `итог ${money(fileTotals)}`])
  stages.forEach((s, i) => passport.push([s.label, [`итог ${money(fileStages?.[i])}`, s.note].filter(Boolean).join(' — ')]))
  if (byCustomer) passport.push(['Объём по кол-ву заказчика', `${byCustomer} поз.: «Кол-во ГП» пусто, сумма в файле посчитана от кол-ва заказчика — объём позиции взят тот же`])
  if (after.length) passport.push(['Ниже итога файла (в смету не вошло)', `${after[0]}${after.length > 1 ? ` и ещё строк: ${after.length - 1}` : ''}`])
  return {
    sheetName, headerRow: header.headerRow, items, fileTotals, hasSubtotals, hasInlinePz: false,
    layout: 'stages', nesting: hasSubtotals ? 'subtotal' : 'codes', passport,
    stages: stages.map((s, i) => ({ label: s.label, short: s.short, totals: fileStages?.[i] || null, note: s.note || null })),
    qtyByCustomer: byCustomer,
  }
}

// ── КП с ресурсами ПЗ одним листом ──────────────────────────────────────────
const fmtRub = (v) => `${(Math.round(v * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
// Примечания без повторов: пустые и совпавшие с уже показанным (примечанием ГП КП) не повторяются.
const distinctNotes = (list, shown = '') => [...new Set(list.filter((s) => s && s !== shown))].join('\n')

function addResource(item, type, row, c) {
  const r = item.res
  r.count++
  const sum = cellNumber(val(row, c.direct))
  const coef = cellNumber(val(row, c.coefTotal))
  const isWork = RESOURCE_WORKS.has(type)
  if (sum === null) {
    r.unpriced++
  } else {
    r.priced++
    r.direct += sum
    if (isWork) r.works += sum
    else if (norm(val(row, c.materialType)).startsWith('вспомогат')) r.aux += sum
    else r.main += sum
  }
  if (coef !== null) {
    r.hasCoef = true
    r.coefTotal += coef
    if (isWork) r.coefWorks += coef
    else r.coefMaterials += coef
  }
}

// Таблица коэффициентов из «Контрольных расчётов» (строка с «раб», «мат», «суб-раб», «суб-мат» и значения под ней) —
// как лист «Коэффициенты» у К14. Пустые во всём блоке столбцы убираются.
function coefficientBlock(tail) {
  const labels = ['раб', 'мат', 'суб-раб', 'суб-мат']
  const at = tail.findIndex((row) => labels.filter((l) => row.cells.some((cell) => norm(cell?.v) === l)).length >= 3)
  if (at < 0) return []
  const block = [tail[at]]
  for (const row of tail.slice(at + 1, at + 6)) {
    if (row.r !== block[block.length - 1].r + 1 || !row.cells.some((cell) => typeof cell?.v === 'number')) break
    block.push(row)
  }
  const width = Math.max(...block.map((row) => row.cells.length))
  const keep = []
  for (let i = 0; i < width; i++) if (block.some((row) => text(row.cells[i]?.v))) keep.push(i)
  const out = block.map((row) => {
    const cells = keep.map((i) => row.cells[i]?.v ?? null)
    while (cells.length && (cells[cells.length - 1] === null || cells[cells.length - 1] === '')) cells.pop()
    return cells
  })
  // Название таблицы — строка прямо над ней с одним текстом («Коэффициенты Alia · версия 1 · …»).
  const prev = tail[at - 1]
  const prevText = prev && prev.r === tail[at].r - 1 ? prev.cells.map((cell) => cell?.v).filter((v) => text(v)) : []
  if (prevText.length === 1 && typeof prevText[0] === 'string') out.unshift([text(prevText[0])])
  return out
}

function parseKpTreeSheet({ sheetName, rows, header }) {
  const c = header.cols
  const items = []
  const preamble = []
  const passport = []
  const resources = { count: 0, unpriced: 0, orphan: 0 }
  let started = false
  let endIndex = rows.length
  let last = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.r <= header.headerRow) {
      if (row.r === header.headerRow) continue
      // Над шапкой — название и пояснения файла; у «King & Sons» там же итоги («ИТОГО ПО РЕСУРСНОМУ РАСЧЁТУ», «Цена договора
      // · рабочая редакция ДС №14») — строка с наименованием и суммами идёт в итоги файла, как строки без типа у «Алии».
      const name = text(val(row, c.name))
      if (name && [c.total, c.direct, c.materials, c.works].some((k) => typeof val(row, k) === 'number')) {
        preamble.push({
          name,
          materials: cellNumber(val(row, c.materials)), works: cellNumber(val(row, c.works)), total: cellNumber(val(row, c.total)),
          direct: cellNumber(val(row, c.direct)), coefTotal: cellNumber(val(row, c.coefTotal)), note: text(val(row, c.status)),
        })
        continue
      }
      const line = row.cells.map((cell) => text(cell?.v)).filter(Boolean).join(' ')
      if (line) passport.push([line])
      continue
    }
    const type = norm(val(row, c.type))
    if (!type) {
      // Строка без типа: до дерева — итог файла («КП после ДС8, с опционом» …), после — начало контрольных расчётов.
      if (started) { endIndex = i; break }
      const name = text(val(row, c.name))
      if (name) {
        preamble.push({
          name,
          materials: cellNumber(val(row, c.materials)), works: cellNumber(val(row, c.works)), total: cellNumber(val(row, c.total)),
          direct: cellNumber(val(row, c.direct)), coefTotal: cellNumber(val(row, c.coefTotal)), note: text(val(row, c.status)),
        })
      }
      continue
    }
    started = true
    if (isResourceType(type)) {
      resources.count++
      if (last) addResource(last, type, row, c)
      else resources.orphan++
      continue
    }
    const gpNote = text(val(row, c.gpNote))
    last = {
      sheetRow: row.r,
      level: row.level,
      type,
      code: codeText(val(row, c.code)),
      pos: posText(val(row, c.pos)),
      name: text(val(row, c.name)),
      unit: text(val(row, c.unit)),
      customerNote: text(val(row, c.customerNote)),
      gpNote,
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
      range: null,
      res: { count: 0, priced: 0, unpriced: 0, direct: 0, main: 0, aux: 0, works: 0, hasCoef: false, coefTotal: 0, coefMaterials: 0, coefWorks: 0 },
      fileDirect: cellNumber(val(row, c.direct)),
      // «Статус / примечание» и «Примечание ГП (ПЗ)» — примечанием ПЗ, если не повторяют примечание ГП КП.
      pzNote: distinctNotes([text(val(row, c.pzNote)), text(val(row, c.status))], gpNote),
    }
    items.push(last)
  }
  if (!items.length) return { error: 'kp_empty', message: `На листе «${sheetName}» нет строк КП под шапкой.` }

  // План затрат строки — сумма её ресурсов. «Прямые затраты» — известная часть: у ресурса без цены суммы нет.
  // Коммерция — стоимость КП той же строки, как у файла «КП + ПЗ» со столбцами прямых затрат (по ней считается цена за
  // единицу); «ПЗ × коэфф.» — отдельно (coef_*): это расчёт по известным ресурсам, со стоимостью КП он не сведён.
  for (const it of items) {
    const r = it.res
    const k = it.kp
    it.resDirect = r.priced ? r.direct : null
    it.pzInline = {
      // Ни у одного ресурса нет цены — прямые затраты неизвестны, а не 0 (SUBTOTAL пустых ячеек в файле даёт 0; у «Алии»
      // так у 1318 работ; файл: «пустые цены — неизвестные, а не нулевые»).
      direct: r.count && !r.priced ? null : (it.fileDirect ?? it.resDirect),
      direct_main: r.priced ? r.main : null,
      direct_aux: r.priced ? r.aux : null,
      direct_works: r.priced ? r.works : null,
      comm_materials: k.materials,
      comm_works: k.works,
      comm_total: k.total,
      coef_materials: r.hasCoef ? r.coefMaterials : null,
      coef_works: r.hasCoef ? r.coefWorks : null,
      coef_total: r.hasCoef ? r.coefTotal : null,
      note: it.pzNote,
      qty_gp: k.qty_gp,
    }
    if (r.count) {
      it.pzInline.resources = r.count
      if (r.unpriced) it.pzInline.unpriced = r.unpriced
    }
    if (r.unpriced) resources.unpriced += r.unpriced
    delete it.res
    delete it.fileDirect
    delete it.pzNote
  }

  // Вложенность — группировка строк Excel (строка КП — внутри ближайшей выше строки КП с меньшим уровнем). Глубже 7
  // уровней Excel не группирует: там ресурсы стоят на уровне своей работы, поэтому ресурс всегда относится к строке КП
  // над ним, а не по уровню. По кодам такой лист не собрать: у работы тот же код, что у подраздела над ней, позиции ДС
  // стоят после старых строк (у «Алии» по кодам — 105 строк не на месте и итог на 1,2 млрд больше), поэтому без
  // группировки (книга пересохранена без неё) — отказ, а не неверное дерево.
  if (!items.some((it) => it.level > 0)) {
    return { error: 'kp_outline', message: `На листе «${sheetName}» нет группировки строк (кнопок «+» слева) — без неё не понять, что во что вложено. Загрузите файл в том виде, как он сохранён в Excel с группировкой.` }
  }
  const stack = []
  items.forEach((it, index) => {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop()
    it.parentIndex = stack.length ? stack[stack.length - 1].index : null
    stack.push({ level: it.level, index })
  })
  // Группа — строка с вложенными (как у книги без формул): раздел с нулевыми суммами — не заголовок файла.
  for (const it of items) if (it.parentIndex !== null) items[it.parentIndex].range = [0, 0]
  items.forEach((it, index) => { it.index = index })

  // Итог для сверки — строка над деревом в той же базе, что и строки («… в сопоставимой базе НДС 20% …»), иначе
  // первая; прямые затраты — первая строка с ними.
  const withTotal = preamble.filter((p) => p.total !== null)
  const base = withTotal.find((p) => /сопоставим/i.test(p.name)) || withTotal[0] || null
  const fileTotals = base ? {
    label: base.name, materials: base.materials, works: base.works, total: base.total,
    direct: preamble.find((p) => p.direct !== null)?.direct ?? null,
  } : null
  for (const p of preamble) {
    const parts = [
      p.total !== null && `всего ${fmtRub(p.total)}${p.materials !== null || p.works !== null ? ` (материалы ${fmtRub(p.materials || 0)}, работы ${fmtRub(p.works || 0)})` : ''}`,
      p.direct !== null && `ПЗ, известная часть ${fmtRub(p.direct)}`,
      p.coefTotal !== null && `ПЗ × коэфф. ${fmtRub(p.coefTotal)}`,
    ].filter(Boolean)
    passport.push([p.name, [parts.join('; '), p.note].filter(Boolean).join(' — ')])
  }
  const vat = preamble.find((p) => /ндс/i.test(p.note))?.note || passport.find((r) => /ндс/i.test(r[0]))?.[0] || null
  return {
    sheetName, headerRow: header.headerRow, items, fileTotals, hasSubtotals: false, hasInlinePz: true,
    layout: 'tree', nesting: 'outline',
    resources: { ...resources, positions: items.filter((it) => it.pzInline.resources).length },
    passport, coefficients: coefficientBlock(rows.slice(endIndex)), vat,
  }
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

// Какой это файл: 'both' (КП и план затрат в одной книге: лист КП + лист «Смета», или лист КП с прямыми затратами) |
// 'kp' | 'pz' | null. У сметы есть лист «Смета» с «Прямыми затратами».
export function detectEstimateWorkbook(XLSX, wb) {
  const pz = parsePzWorkbook(XLSX, wb)
  const pzOk = !pz.error && pz.positions.length > 0
  const kp = findKpSheet(XLSX, wb)
  // Лист «Смета» сам похож на КП («Код», «Наименование», «Ед. изм.»), но не им: КП — другой лист книги.
  const kpOk = !!kp && (!pzOk || kp.sheetName !== pz.sheetName)
  if (kpOk && (pzOk || kp.header.cols.direct !== undefined)) return 'both'
  if (pzOk) return 'pz'
  if (kpOk) return 'kp'
  return null
}

// ── Сборка строк сметы ──────────────────────────────────────────────────────
// kind: title — заголовок без сумм («Корпус 14»); section — раздел (верхний уровень); group — группа; aggregate —
// укрупнённая позиция КП (своя единица и объём, состав — подробные позиции ниже); position — позиция; note — строка
// без единицы и сумм; adjust — техническая строка ПЗ вне КП («Округление до копеек»).
export const ROW_KINDS = ['title', 'section', 'group', 'aggregate', 'position', 'note', 'adjust']

// Раздел листа с ресурсами ПЗ — раздел, даже с единицей («King & Sons»: «Планировочная организация земельного участка» —
// «компл», 1). Подраздел с единицей — укрупнённая позиция, как раньше (у «Алии» — «Фундаменты»).
const GROUP_TYPES = new Set(['раздел'])
function kindOf(it, hasChildren) {
  if (hasChildren || it.range) {
    if (it.unit && !GROUP_TYPES.has(it.type)) return 'aggregate'
    return it.parentIndex === null ? 'section' : 'group'
  }
  if (it.unit) return 'position'
  const k = it.kp
  const empty = [k.total, k.materials, k.works, k.qty_gp, k.qty_customer].every((v) => !v)
  if (empty && it.parentIndex === null) return 'title'
  return empty ? 'note' : 'position'
}

// Сверка формул файла: позиция — материалы = Кол-во ГП × за ед. материалов, работы = Кол-во ГП × за ед. работ,
// итог = материалы + работы; группа — сумма вложенных строк; итог файла — сумма позиций; у листа с ресурсами ПЗ —
// ещё «ПЗ · известная часть» строки = сумма её ресурсов и итог прямых затрат.
const GROUP_KEYS = ['materials', 'works', 'total']
function checkFormulas(items, children, fileTotals) {
  const issues = []
  // Сумма группы — снизу вверх: у вложенной группы берётся её посчитанная сумма, а не значение в файле. Иначе одна
  // группа, неверная в файле (у «Алии» — заголовок подраздела с постоянным 0 над оценённой работой), давала бы
  // расхождение ещё и у всех предков, хотя их SUBTOTAL верны. У книги с верными суммами групп результат тот же.
  const computed = new Map()
  for (let i = items.length - 1; i >= 0; i--) {
    const ch = children.get(items[i].index)
    if (!ch) continue
    const s = { materials: 0, works: 0, total: 0 }
    for (const c of ch) {
      const sub = computed.get(c)
      for (const key of GROUP_KEYS) s[key] += sub ? sub[key] : (items[c].kp[key] || 0)
    }
    computed.set(items[i].index, s)
  }
  for (const it of items) {
    const k = it.kp
    if (it.resDirect !== undefined && it.resDirect !== null && !close(it.resDirect, it.pzInline?.direct)) {
      issues.push({ row: it.sheetRow, code: it.code, key: 'direct', expected: it.resDirect, actual: it.pzInline?.direct ?? null })
    }
    if (children.has(it.index)) {
      const s = computed.get(it.index)
      for (const key of GROUP_KEYS) {
        if (!close(s[key], k[key])) issues.push({ row: it.sheetRow, code: it.code, key, expected: s[key], actual: k[key] })
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
  const leaves = items.filter((it) => !children.has(it.index))
  const leafSum = (key) => leaves.reduce((s, it) => s + (it.kp[key] || 0), 0)
  const totals = { materials: leafSum('materials'), works: leafSum('works'), total: leafSum('total') }
  if (items.some((it) => it.resDirect !== undefined)) totals.direct = leaves.reduce((s, it) => s + (it.pzInline?.direct || 0), 0)
  if (fileTotals) {
    for (const key of ['materials', 'works', 'total', 'direct']) {
      if (fileTotals[key] === null || fileTotals[key] === undefined || totals[key] === undefined) continue
      if (Math.abs(totals[key] - fileTotals[key]) > 0.05) issues.push({ row: null, code: 'ИТОГО', key, expected: totals[key], actual: fileTotals[key] })
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
        if (!pz && it.pzInline) {
          // Один файл: план затрат — столбцами той же строки.
          if (it.pzInline.direct !== null || it.pzInline.comm_total) p = { pz: { ...it.pzInline }, sheetRow: it.sheetRow, inline: true }
        } else {
          p = (it.pos && pzByPos.get(it.pos)) || pzByCodeName.get(`${it.code}|${nameKey(it.name)}`) || null
          if (p && used.has(p)) p = null
        }
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
    kp_file: kp ? {
      name: kpFileName, sheet: kp.sheetName, header_row: kp.headerRow, has_subtotals: kp.hasSubtotals, totals: kp.fileTotals,
      inline_pz: !pz && !!kp.hasInlinePz,
      ...(kp.layout ? { layout: kp.layout, nesting: kp.nesting, resources: kp.resources } : {}),
      ...(kp.stages?.length ? { stages: kp.stages } : {}),
    } : null,
    pz_file: pz ? { name: pzFileName, sheet: pz.sheetName, header_row: pz.headerRow, totals: pz.summaryTotals } : null,
    // Лист КП с ресурсами ПЗ несёт паспорт (итоги над деревом) и коэффициенты сам.
    passport: pz?.passport?.length ? pz.passport : (kp?.passport || []),
    coefficients: pz?.coefficients?.length ? pz.coefficients : (kp?.coefficients || []),
    out_of_total: pz?.outOfTotal || [],
    detail: pz?.detail || [],
    vat: vatFrom(pz) || kp?.vat || null,
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
  if (p.inline) {
    const rest = { ...p.pz }
    delete rest.qty_gp
    return { ...rest, sheet_row: p.sheetRow }
  }
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
  // Имя файла: «Событие_6_2_КП_до_перекидок,_ДГП,_Допники» — подчёркивания пробелами.
  return String(fileName || 'Смета').replace(/\.(xlsx|xlsm|xls)$/i, '').replace(/_+/g, ' ').trim()
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

// Объём позиции, по которому считана её цена: только «Количество (ГП)» (13.11.2026: кол-во заказчика — другое, у К14
// позиции без ГП — с нулевой стоимостью).
export function rowQuantity(row) {
  return row?.kp?.qty_gp ?? row?.pz?.qty_gp ?? 0
}
