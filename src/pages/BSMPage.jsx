import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useRole } from '../contexts/RoleContext'
import './BSMPage.css'

// Поля, которые подтягиваются из Excel. Пользователь сам выбирает столбец для каждого
// в панели «Столбцы» (внутри карточки документа). Дефолтная раскладка — A/B/C/D/E/F/G/H/L.
const COLUMN_FIELDS = [
  { key: 'num',            label: '№ п/п',           default: 0 },
  { key: 'code',           label: 'КОД (мат./Р)',    default: 1 },
  { key: 'name',           label: 'Наименование',    default: 2 },
  { key: 'unit',           label: 'Ед. изм.',        default: 3 },
  { key: 'workVolume',     label: 'Объём работ',     default: 4 },
  { key: 'materialVolume', label: 'Объем материалов', default: 5 },
  { key: 'priceMaterial',  label: 'Цена материалов', default: 6 },
  { key: 'priceWork',      label: 'Цена работ',      default: 7 },
  { key: 'notes',          label: 'Примечания',      default: 11 },
]

const DEFAULT_COLUMN_MAP = Object.fromEntries(COLUMN_FIELDS.map(f => [f.key, f.default]))

// Сколько столбцов показывать в выпадающем списке (A…Z покрывает все реальные КП).
const COLUMN_CHOICES_COUNT = 26

const COLUMN_MAP_STORAGE_KEY = 'analysis-kp-column-map'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// Excel-числа с разделителями/валютой/пробелами → JS number.
// Учитываем все виды пробелов: обычный, табуляция, неразрывный (U+00A0),
// figure space (U+2007), narrow no-break (U+202F), zero-width (U+200B).
function cleanNumeric(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return value
  let str = String(value)
  // 1) Убираем все виды пробелов СНАЧАЛА — иначе «1 234,56» парсится как «1».
  str = str.replace(/[\s\u00A0\u2007\u202F\u200B]+/g, '')
  // 2) Символы валют.
  str = str.replace(/[₽$€¥£]/g, '')
  // 3) Валютные суффиксы (после удаления пробелов уже без границ).
  str = str.replace(/(руб\.?|rub|usd|eur|тыс\.?|млн\.?)$/i, '')
  str = str.replace(',', '.')
  str = str.replace(/[^\d.-]/g, '')
  const n = parseFloat(str)
  return isNaN(n) ? 0 : n
}

// Определение типа строки по полю КОД.
// «мат.» / «мат» → материал, «Р» / «Р-…» → работа, иначе пусто.
// Нормализуем whitespace: КОД из Excel может прийти с неразрывными пробелами и табуляциями.
function detectKind(rawCode) {
  const code = String(rawCode || '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!code) return null
  if (code === 'мат' || code === 'мат.' || code.startsWith('мат.') || code.startsWith('мат ')) {
    return 'material'
  }
  // Любой код, начинающийся с «р» (после нормализации регистра): «Р», «р», «Р-…», «раб», «раб.», «Работа», «работы», «РАБОТА».
  if (code === 'р' || code.startsWith('р-') || code.startsWith('р ') || code.startsWith('раб')) {
    return 'work'
  }
  return null
}

const fmtRub = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n)) + ' ₽'
const fmtNum = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n))

// Резолвинг простых формул-ссылок: «=Лист!G15», «=G15», «='Цены'!$G$15», «+G15».
// Возвращает { value, source } — value уже прошёл cleanNumeric.
// Защита от циклов: visited (set ссылок).
function resolveFormula(workbook, currentSheetName, formula, visited = new Set(), depth = 0) {
  if (depth > 10 || !formula) return null
  // Чистим: убираем ведущие =/+/-, окружающие пробелы.
  let f = String(formula).trim().replace(/^[=+]/, '').trim()
  // Поддерживаем варианты: 'Лист'!$G$15, Лист!G15, G15.
  const m = f.match(/^(?:'([^']+)'|([^!\s]+))?!?\$?([A-Z]+)\$?(\d+)$/i)
  if (!m) return null
  const sheetName = (m[1] || m[2] || currentSheetName)
  const col = m[3].toUpperCase()
  const row = m[4]
  const refKey = `${sheetName}!${col}${row}`
  if (visited.has(refKey)) return null
  visited.add(refKey)
  const targetSheet = workbook.Sheets[sheetName]
  if (!targetSheet) return null
  const cell = targetSheet[`${col}${row}`]
  if (!cell) return null
  const a = cleanNumericLocal(cell.v)
  if (a > 0) return { value: a, source: refKey, raw: cell.v }
  const b = cleanNumericLocal(cell.w)
  if (b > 0) return { value: b, source: refKey, raw: cell.w }
  // Цепная формула: ячейка тоже содержит формулу со ссылкой.
  if (cell.f) {
    const rec = resolveFormula(workbook, sheetName, cell.f, visited, depth + 1)
    if (rec) return { ...rec, source: `${refKey} → ${rec.source}` }
  }
  return null
}

// Локальный clone cleanNumeric (тот же код, нужен для использования внутри resolveFormula).
function cleanNumericLocal(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return value
  let str = String(value)
  str = str.replace(/[\s\u00A0\u2007\u202F\u200B]+/g, '')
  str = str.replace(/[₽$€¥£]/g, '')
  str = str.replace(/(руб\.?|rub|usd|eur|тыс\.?|млн\.?)$/i, '')
  str = str.replace(',', '.')
  str = str.replace(/[^\d.-]/g, '')
  const n = parseFloat(str)
  return isNaN(n) ? 0 : n
}

// Чтение/запись «шаблона» раскладки столбцов в localStorage.
// Первый документ сессии наследует этот шаблон; каждый следующий — раскладку предыдущего документа.
function loadColumnTemplate() {
  try {
    const saved = localStorage.getItem(COLUMN_MAP_STORAGE_KEY)
    if (!saved) return { ...DEFAULT_COLUMN_MAP }
    const parsed = JSON.parse(saved)
    // Валидация: все ключи из COLUMN_FIELDS, значения — null или 0..COLUMN_CHOICES_COUNT-1.
    const result = { ...DEFAULT_COLUMN_MAP }
    for (const f of COLUMN_FIELDS) {
      const v = parsed?.[f.key]
      if (v === null) result[f.key] = null
      else if (Number.isInteger(v) && v >= 0 && v < COLUMN_CHOICES_COUNT) result[f.key] = v
    }
    return result
  } catch {
    return { ...DEFAULT_COLUMN_MAP }
  }
}

function saveColumnTemplate(map) {
  try {
    localStorage.setItem(COLUMN_MAP_STORAGE_KEY, JSON.stringify(map))
  } catch { /* localStorage может быть недоступен (приватный режим) — игнорируем */ }
}

// Парсинг одного листа по заданной раскладке столбцов. Чистая функция —
// используется независимо для каждого документа.
// Возвращает { rows, defaultFrom } — defaultFrom — первая строка с непустым наименованием (1-based).
function parseSheetRows(workbook, sheetName, columnMap) {
  const empty = { rows: [], defaultFrom: 1 }
  if (!workbook || !sheetName) return empty
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return empty
  const COL = columnMap
  let maxR = 0
  for (const k of Object.keys(sheet)) {
    if (k.startsWith('!')) continue
    const cell = XLSX.utils.decode_cell(k)
    if (cell.r > maxR) maxR = cell.r
  }
  // pickCell: 1) .v 2) .w 3) если есть .f — резолвим ссылку на ячейку другого листа.
  const pickCell = (rowIdx, colIdx) => {
    if (colIdx === null || colIdx === undefined) return { value: 0, raw: '' }
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
    const cell = sheet[ref]
    if (!cell) return { value: 0, raw: '' }
    const rawV = cell.v
    const a = cleanNumeric(rawV)
    if (a > 0) return { value: a, raw: rawV }
    const b = cleanNumeric(cell.w)
    if (b > 0) return { value: b, raw: cell.w }
    // Формула со ссылкой на другую ячейку/лист — пробуем разрешить вручную.
    if (cell.f) {
      const r = resolveFormula(workbook, sheetName, cell.f)
      if (r && r.value > 0) return { value: r.value, raw: `${r.raw} (← ${r.source})` }
    }
    const display = (rawV !== undefined && rawV !== '' ? rawV : cell.w) ?? ''
    return { value: 0, raw: display }
  }
  const getText = (rowIdx, colIdx) => {
    if (colIdx === undefined || colIdx === null) return ''
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
    const cell = sheet[ref]
    if (!cell) return ''
    return cell.v !== undefined && cell.v !== '' ? String(cell.v) : String(cell.w || '')
  }
  const parsed = []
  for (let r = 0; r <= maxR; r++) {
    const pm = pickCell(r, COL.priceMaterial)
    const pw = pickCell(r, COL.priceWork)
    const codeText = getText(r, COL.code)
    const wv = pickCell(r, COL.workVolume)
    const mv = pickCell(r, COL.materialVolume)
    parsed.push({
      excelRow: r + 1,
      num: getText(r, COL.num),
      code: codeText,
      name: getText(r, COL.name).trim(),
      unit: getText(r, COL.unit).trim(),
      workVolume: wv.value,
      materialVolume: mv.value,
      priceMaterial: pm.value,
      priceWork: pw.value,
      rawPriceMaterial: pm.raw,
      rawPriceWork: pw.raw,
      rawWorkVolume: wv.raw,
      rawMaterialVolume: mv.raw,
      notes: getText(r, COL.notes).trim(),
      kind: detectKind(codeText),
    })
  }
  const firstDataRow = parsed.findIndex(r => r.name) + 1
  return { rows: parsed, defaultFrom: firstDataRow > 0 ? firstDataRow : 1 }
}

// Превью первой непустой ячейки в каждом столбце (по первым 6 строкам) — подсказка
// в выпадающем списке: «A — № п/п», «C — Наименование» и т. д.
function computeColumnPreviews(workbook, sheetName) {
  const empty = Array(COLUMN_CHOICES_COUNT).fill('')
  if (!workbook || !sheetName) return empty
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return empty
  const result = []
  for (let c = 0; c < COLUMN_CHOICES_COUNT; c++) {
    let preview = ''
    for (let r = 0; r < 6; r++) {
      const ref = XLSX.utils.encode_cell({ r, c })
      const cell = sheet[ref]
      if (cell && cell.v !== undefined && cell.v !== '') {
        preview = String(cell.v).replace(/\s+/g, ' ').trim()
        if (preview) break
      }
    }
    if (preview.length > 28) preview = preview.slice(0, 28) + '…'
    result.push(preview)
  }
  return result
}

// Собирает объект документа из прочитанного workbook (первый лист, переданная раскладка столбцов).
function makeDocument(id, fileName, workbook, columnMap) {
  const sheetNames = workbook.SheetNames || []
  const selectedSheet = sheetNames[0] || ''
  const { rows, defaultFrom } = parseSheetRows(workbook, selectedSheet, columnMap)
  return {
    id,
    fileName,
    workbook,
    sheetNames,
    selectedSheet,
    columnMap,
    allRows: rows,
    rangeFrom: defaultFrom,
    rangeTo: rows.length || 1,
    showColumnPanel: false,
  }
}

// Диапазон строк документа с клампом к фактической длине.
function docRange(doc) {
  const len = doc.allRows.length
  if (!len) return { from: 1, to: 0 }
  const from = Math.max(1, Math.min(Number(doc.rangeFrom) || 1, len))
  const to = Math.max(from, Math.min(Number(doc.rangeTo) || len, len))
  return { from, to }
}

function BSMPage() {
  const { canEdit } = useRole()
  const canEditKp = canEdit('analysis_kp')

  const [documents, setDocuments] = useState([])
  const nextDocId = useRef(1)                 // стабильные id без Math.random
  const [mainTab, setMainTab] = useState('material')
  const [subTab, setSubTab] = useState('summary')
  const [error, setError] = useState(null)
  const [isDragActive, setIsDragActive] = useState(false)

  const fileInputRef = useRef(null)
  // Куда применить выбранный файл: добавить новый документ или заменить файл конкретного.
  const pendingAction = useRef({ mode: 'add', id: null })

  // Шаблон раскладки для пустого состояния (последняя использованная / дефолт).
  const startTemplate = useMemo(() => loadColumnTemplate(), [])

  const hasDocuments = documents.length > 0

  // ----- Загрузка / добавление документов -----

  const readWorkbook = async (file) => {
    const buf = await file.arrayBuffer()
    return XLSX.read(buf, { type: 'array' })
  }

  const addDocument = async (file) => {
    if (!file) return
    setError(null)
    try {
      const wb = await readWorkbook(file)
      const id = nextDocId.current++
      setDocuments(prev => {
        // Новый документ наследует раскладку последнего; первый — сохранённый шаблон.
        const template = prev.length ? prev[prev.length - 1].columnMap : loadColumnTemplate()
        return [...prev, makeDocument(id, file.name, wb, { ...template })]
      })
    } catch (err) {
      console.error('Ошибка чтения Excel:', err)
      setError('Не удалось прочитать файл. Проверьте формат (нужен .xlsx или .xls).')
    }
  }

  const replaceDocumentFile = async (id, file) => {
    if (!file) return
    setError(null)
    try {
      const wb = await readWorkbook(file)
      setDocuments(prev => prev.map(d =>
        d.id === id ? makeDocument(id, file.name, wb, { ...d.columnMap }) : d
      ))
    } catch (err) {
      console.error('Ошибка чтения Excel:', err)
      setError('Не удалось прочитать файл. Проверьте формат (нужен .xlsx или .xls).')
    }
  }

  const openFilePicker = (mode, id = null) => {
    pendingAction.current = { mode, id }
    fileInputRef.current?.click()
  }

  const handleFileInput = async (event) => {
    const file = event.target.files?.[0]
    const { mode, id } = pendingAction.current
    try {
      if (file) {
        if (mode === 'replace' && id != null) await replaceDocumentFile(id, file)
        else await addDocument(file)
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ----- Настройка документа -----

  const removeDocument = (id) => setDocuments(prev => prev.filter(d => d.id !== id))

  const setDocumentSheet = (id, sheet) => {
    setDocuments(prev => prev.map(d => {
      if (d.id !== id) return d
      const { rows, defaultFrom } = parseSheetRows(d.workbook, sheet, d.columnMap)
      return { ...d, selectedSheet: sheet, allRows: rows, rangeFrom: defaultFrom, rangeTo: rows.length || 1 }
    }))
  }

  const updateDocumentColumn = (id, fieldKey, value) => {
    const nextValue = value === '' ? null : Number(value)
    setDocuments(prev => prev.map(d => {
      if (d.id !== id) return d
      const columnMap = { ...d.columnMap, [fieldKey]: nextValue }
      const { rows } = parseSheetRows(d.workbook, d.selectedSheet, columnMap)
      // Диапазон сохраняем, но клампим к новой длине.
      const rangeTo = Math.max(1, Math.min(Number(d.rangeTo) || rows.length || 1, rows.length || 1))
      const rangeFrom = Math.max(1, Math.min(Number(d.rangeFrom) || 1, rangeTo))
      saveColumnTemplate(columnMap)
      return { ...d, columnMap, allRows: rows, rangeFrom, rangeTo }
    }))
  }

  const resetDocumentColumnMap = (id) => {
    setDocuments(prev => prev.map(d => {
      if (d.id !== id) return d
      const columnMap = { ...DEFAULT_COLUMN_MAP }
      const { rows, defaultFrom } = parseSheetRows(d.workbook, d.selectedSheet, columnMap)
      saveColumnTemplate(columnMap)
      return { ...d, columnMap, allRows: rows, rangeFrom: defaultFrom, rangeTo: rows.length || 1 }
    }))
  }

  const setDocumentRange = (id, patch) =>
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, ...patch } : d))

  const toggleDocumentColumnPanel = (id) =>
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, showColumnPanel: !d.showColumnPanel } : d))

  const handleClear = () => {
    setDocuments([])
    setError(null)
  }

  // ----- Drag & drop (только для пустого состояния) -----

  const handleDragOver = (e) => {
    if (!canEditKp) return
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    if (!isDragActive) setIsDragActive(true)
  }

  const handleDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return
    setIsDragActive(false)
  }

  const handleDrop = (e) => {
    if (!canEditKp) return
    e.preventDefault()
    setIsDragActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setError('Поддерживаются только файлы .xlsx и .xls.')
      return
    }
    addDocument(file)
  }

  // ----- Объединённый датасет по всем документам -----

  // Строки всех документов в выбранных диапазонах, помеченные источником.
  const combinedRangeRows = useMemo(() => {
    const out = []
    for (const doc of documents) {
      const { from, to } = docRange(doc)
      if (to < from) continue
      for (const r of doc.allRows.slice(from - 1, to)) {
        out.push({ ...r, sourceFile: doc.fileName, sourceId: doc.id })
      }
    }
    return out
  }, [documents])

  // Группировка по наименованию для текущей вкладки (материалы/работы).
  // Для материалов берём materialVolume × priceMaterial, для работ — workVolume × priceWork.
  const grouped = useMemo(() => {
    if (combinedRangeRows.length === 0) return []
    const isMaterial = mainTab === 'material'
    const filtered = combinedRangeRows.filter(r => r.kind === (isMaterial ? 'material' : 'work') && r.name)
    const map = new Map()
    for (const r of filtered) {
      const key = r.name.toLowerCase()
      const volume = isMaterial ? r.materialVolume : r.workVolume
      const price = isMaterial ? r.priceMaterial : r.priceWork
      const rawVolume = isMaterial ? r.rawMaterialVolume : r.rawWorkVolume
      const rawPrice = isMaterial ? r.rawPriceMaterial : r.rawPriceWork
      if (!map.has(key)) {
        map.set(key, {
          name: r.name,
          unitsSet: new Set(),
          pricesSet: new Set(),
          sourcesSet: new Set(),
          totalVolume: 0,
          count: 0,
          items: [],
          lastPrice: 0,
        })
      }
      const g = map.get(key)
      if (r.unit) g.unitsSet.add(r.unit)
      if (price > 0) g.pricesSet.add(round2(price))
      if (r.sourceFile) g.sourcesSet.add(r.sourceFile)
      g.totalVolume = round2(g.totalVolume + volume)
      g.count += 1
      g.lastPrice = price > 0 ? round2(price) : g.lastPrice
      g.items.push({
        excelRow: r.excelRow,
        sourceFile: r.sourceFile,
        unit: r.unit,
        volume,
        price,
        rawVolume,
        rawPrice,
        sum: round2(volume * price),
        notes: r.notes,
      })
    }
    return Array.from(map.values())
      .map(g => {
        // Если все цены одинаковые — это и есть «единичная расценка».
        // Иначе берём среднюю взвешенную (по объёму), чтобы итог был согласован.
        const prices = Array.from(g.pricesSet)
        const totalSum = round2(g.items.reduce((s, it) => s + it.sum, 0))
        const unitPrice = prices.length === 1
          ? prices[0]
          : (g.totalVolume > 0 ? round2(totalSum / g.totalVolume) : 0)
        return {
          name: g.name,
          units: Array.from(g.unitsSet),
          prices,
          sources: Array.from(g.sourcesSet),
          unitPrice,
          totalVolume: g.totalVolume,
          totalSum,
          count: g.count,
          items: g.items,
          hasDifferentUnits: g.unitsSet.size > 1,
          hasDifferentPrices: g.pricesSet.size > 1,
        }
      })
      .sort((a, b) => b.totalSum - a.totalSum)
  }, [combinedRangeRows, mainTab])

  const differentPrices = useMemo(() => grouped.filter(g => g.hasDifferentPrices), [grouped])
  const differentUnits = useMemo(() => grouped.filter(g => g.hasDifferentUnits), [grouped])
  // Позиции без цены: цена не указана ни в одной из исходных строк (pricesSet пуст).
  const notPriced = useMemo(() => grouped.filter(g => g.prices.length === 0), [grouped])

  const stats = useMemo(() => {
    const totalRows = combinedRangeRows.length
    const matched = grouped.length
    const totalSum = round2(grouped.reduce((s, g) => s + g.totalSum, 0))
    const totalVolume = round2(grouped.reduce((s, g) => s + g.totalVolume, 0))
    const sourcePositions = grouped.reduce((s, g) => s + g.count, 0)
    return { totalRows, matched, totalSum, totalVolume, sourcePositions }
  }, [grouped, combinedRangeRows])

  const hasData = combinedRangeRows.length > 0
  const subTabsAvailable = hasData
  const multipleDocs = documents.length > 1

  // Экспорт текущего состояния анализа в Excel: все 4 раздела в отдельных листах.
  const handleExportExcel = () => {
    if (!hasData || grouped.length === 0) {
      alert('Нет данных для выгрузки. Сначала загрузите файл и проверьте, что в диапазоне есть позиции.')
      return
    }
    const tabLabel = mainTab === 'material' ? 'Материалы' : 'Работы'
    const volumeHeader = mainTab === 'material' ? 'Объём (расход)' : 'Объём работ'
    const priceHeader = mainTab === 'material' ? 'Цена за ед., ₽' : 'Расценка СМР, ₽'

    const wb = XLSX.utils.book_new()

    // Лист 1: «Сводная»
    const summaryRows = [
      ['№', 'Наименование', 'Ед. изм.', volumeHeader, priceHeader, 'Сумма, ₽', 'Позиций', 'Документы', 'Предупреждения'],
      ...grouped.map((g, idx) => [
        idx + 1,
        g.name,
        g.units.join(', '),
        round2(g.totalVolume),
        round2(g.unitPrice),
        round2(g.totalSum),
        g.count,
        g.sources.join(', '),
        [
          g.hasDifferentPrices ? 'разные цены' : null,
          g.hasDifferentUnits ? 'разные ед.' : null,
          g.prices.length === 0 ? 'не расценено' : null,
        ].filter(Boolean).join('; '),
      ]),
      [],
      ['', 'ИТОГО', '', round2(grouped.reduce((s, r) => s + r.totalVolume, 0)), '',
        round2(grouped.reduce((s, r) => s + r.totalSum, 0)),
        grouped.reduce((s, r) => s + r.count, 0), '', ''],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
    summarySheet['!cols'] = [{ wch: 5 }, { wch: 55 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 9 }, { wch: 28 }, { wch: 24 }]
    XLSX.utils.book_append_sheet(wb, summarySheet, `${tabLabel} — Сводная`)

    // Лист 2: «Разные цены»
    if (differentPrices.length > 0) {
      const rows = [['Наименование', 'Стр. Excel', 'Документ', 'Ед. изм.', 'Объём', 'Цена, ₽', 'Сумма, ₽']]
      for (const g of differentPrices) {
        rows.push([g.name, '', '', '', round2(g.totalVolume), '', round2(g.totalSum)])
        for (const it of g.items) {
          rows.push(['  → исходная строка', it.excelRow, it.sourceFile, it.unit, round2(it.volume), round2(it.price), round2(it.sum)])
        }
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 10 }, { wch: 28 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Разные цены`)
    }

    // Лист 3: «Разные ед.изм.»
    if (differentUnits.length > 0) {
      const rows = [['Наименование', 'Стр. Excel', 'Документ', 'Ед. изм.', 'Объём', 'Цена, ₽', 'Сумма, ₽']]
      for (const g of differentUnits) {
        rows.push([g.name, '', '', '', round2(g.totalVolume), '', round2(g.totalSum)])
        for (const it of g.items) {
          rows.push(['  → исходная строка', it.excelRow, it.sourceFile, it.unit, round2(it.volume), round2(it.price), round2(it.sum)])
        }
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 10 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Разные ед.`)
    }

    // Лист 4: «Не расценены»
    if (notPriced.length > 0) {
      const rows = [['Наименование', 'Ед. изм.', 'Объём', 'Позиций', 'Документы', 'Стр. Excel']]
      for (const g of notPriced) {
        rows.push([
          g.name,
          g.units.join(', '),
          round2(g.totalVolume),
          g.count,
          g.sources.join(', '),
          g.items.map(it => it.excelRow).join(', '),
        ])
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 28 }, { wch: 30 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Не расценены`)
    }

    // Имя файла: «Анализ КП - <имя первого источника>[ (+N)] - <Материалы|Работы>.xlsx»
    const baseName = (documents[0]?.fileName || '').replace(/\.(xlsx|xls)$/i, '') || 'без имени'
    const suffix = multipleDocs ? ` (+${documents.length - 1})` : ''
    const outName = `Анализ КП - ${baseName}${suffix} - ${tabLabel}.xlsx`
    XLSX.writeFile(wb, outName)
  }

  return (
    <div className="bsm-page">
      <header className="bsm-header">
        <div className="bsm-header-text">
          <h2>📊 Анализ ВОР/КП</h2>
          <p className="bsm-subtitle">
            Загрузите один или несколько Excel-файлов с расценками, для каждого задайте лист, столбцы и диапазон строк — получите общую сводную таблицу по наименованиям.
          </p>
        </div>

        <div className="bsm-header-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileInput}
            style={{ display: 'none' }}
          />
          {canEditKp && (
            <button className="bsm-btn-primary" onClick={() => openFilePicker('add')}>
              {hasDocuments ? '➕ Добавить документ' : '📂 Загрузить Excel'}
            </button>
          )}
          {hasDocuments && (
            <>
              <button
                className="bsm-btn-secondary"
                onClick={handleExportExcel}
                disabled={!hasData || grouped.length === 0}
                title="Выгрузить текущий анализ (Сводная + расхождения + не расценены) в Excel"
              >
                📥 Скачать Excel
              </button>
              {canEditKp && (
                <button className="bsm-btn-ghost" onClick={handleClear}>
                  Очистить
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {error && <div className="bsm-error">{error}</div>}

      {!hasDocuments && (
        <div
          className={`bsm-empty${isDragActive ? ' bsm-drag-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="bsm-empty-icon" aria-hidden>{isDragActive ? '⬇️' : '📥'}</div>
          <div className="bsm-empty-title">{isDragActive ? 'Отпустите файл для загрузки' : 'Нет данных'}</div>
          <div className="bsm-empty-text">
            {isDragActive
              ? 'Файл будет загружен и обработан автоматически.'
              : 'Загрузите Excel-документ или перетащите его сюда. Можно добавить несколько документов — данные объединятся в один анализ. Сопоставление колонок настраивается для каждого документа отдельно.'}
          </div>
          <table className="bsm-format-table">
            <thead>
              <tr>
                <th>Колонка</th><th>Назначение</th>
              </tr>
            </thead>
            <tbody>
              {COLUMN_FIELDS.map(f => {
                const idx = startTemplate[f.key]
                const letter = (idx === null || idx === undefined) ? '—' : XLSX.utils.encode_col(idx)
                return (
                  <tr key={f.key}>
                    <td>{letter}</td>
                    <td>
                      {f.label}
                      {f.key === 'code' && (
                        <> (<code>мат.</code> — материал, <code>Р</code>/<code>Р-…</code> — работа)</>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasDocuments && (
        <>
          <section className="bsm-docs">
            {documents.map((doc, i) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                index={i}
                canEdit={canEditKp}
                onSheetChange={(sheet) => setDocumentSheet(doc.id, sheet)}
                onColumnChange={(key, value) => updateDocumentColumn(doc.id, key, value)}
                onResetColumns={() => resetDocumentColumnMap(doc.id)}
                onTogglePanel={() => toggleDocumentColumnPanel(doc.id)}
                onRangeChange={(patch) => setDocumentRange(doc.id, patch)}
                onReplace={() => openFilePicker('replace', doc.id)}
                onRemove={() => removeDocument(doc.id)}
              />
            ))}
            {canEditKp && (
              <button type="button" className="bsm-doc-add" onClick={() => openFilePicker('add')}>
                ➕ Добавить ещё документ
              </button>
            )}
          </section>

          {hasData ? (
            <>
              <section className="bsm-controls">
                <div className="bsm-tabs-main" role="tablist" aria-label="Тип позиций">
                  <button
                    role="tab"
                    aria-selected={mainTab === 'material'}
                    className={`bsm-tab-main ${mainTab === 'material' ? 'active' : ''}`}
                    onClick={() => setMainTab('material')}
                  >
                    <span aria-hidden>📦</span> Материалы
                  </button>
                  <button
                    role="tab"
                    aria-selected={mainTab === 'work'}
                    className={`bsm-tab-main ${mainTab === 'work' ? 'active' : ''}`}
                    onClick={() => setMainTab('work')}
                  >
                    <span aria-hidden>🔧</span> Работы
                  </button>
                </div>
              </section>

              <section className="bsm-stats">
                <div className="bsm-stat">
                  <div className="bsm-stat-label">Строк в диапазоне</div>
                  <div className="bsm-stat-value">{stats.totalRows}</div>
                </div>
                <div className="bsm-stat">
                  <div className="bsm-stat-label">Уникальных позиций</div>
                  <div className="bsm-stat-value">{stats.matched}</div>
                </div>
                <div className="bsm-stat">
                  <div className="bsm-stat-label">Исходных строк {mainTab === 'material' ? '«мат.»' : '«Р»'}</div>
                  <div className="bsm-stat-value">{stats.sourcePositions}</div>
                </div>
                <div className="bsm-stat">
                  <div className="bsm-stat-label">Объём (итог)</div>
                  <div className="bsm-stat-value">{fmtNum(stats.totalVolume)}</div>
                </div>
                <div className="bsm-stat bsm-stat-accent">
                  <div className="bsm-stat-label">Сумма (итог)</div>
                  <div className="bsm-stat-value">{fmtRub(stats.totalSum)}</div>
                </div>
              </section>

              {subTabsAvailable && (
                <nav className="bsm-tabs-sub" role="tablist" aria-label="Разделы анализа">
                  <button
                    role="tab"
                    aria-selected={subTab === 'summary'}
                    className={`bsm-tab-sub ${subTab === 'summary' ? 'active' : ''}`}
                    onClick={() => setSubTab('summary')}
                  >
                    Сводная
                    <span className="bsm-tab-count">{grouped.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={subTab === 'different_prices'}
                    className={`bsm-tab-sub ${subTab === 'different_prices' ? 'active' : ''} ${differentPrices.length > 0 ? 'has-warning' : ''}`}
                    onClick={() => setSubTab('different_prices')}
                  >
                    Разные цены
                    <span className="bsm-tab-count">{differentPrices.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={subTab === 'different_units'}
                    className={`bsm-tab-sub ${subTab === 'different_units' ? 'active' : ''} ${differentUnits.length > 0 ? 'has-warning' : ''}`}
                    onClick={() => setSubTab('different_units')}
                  >
                    Разные ед.&nbsp;изм.
                    <span className="bsm-tab-count">{differentUnits.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={subTab === 'not_priced'}
                    className={`bsm-tab-sub ${subTab === 'not_priced' ? 'active' : ''} ${notPriced.length > 0 ? 'has-warning' : ''}`}
                    onClick={() => setSubTab('not_priced')}
                  >
                    Не расценены
                    <span className="bsm-tab-count">{notPriced.length}</span>
                  </button>
                </nav>
              )}

              <section className="bsm-content">
                {subTab === 'summary' && (
                  <SummaryTable rows={grouped} mainTab={mainTab} showSources={multipleDocs} />
                )}
                {subTab === 'different_prices' && (
                  <DifferentPricesTable rows={differentPrices} mainTab={mainTab} />
                )}
                {subTab === 'different_units' && (
                  <DifferentUnitsTable rows={differentUnits} mainTab={mainTab} />
                )}
                {subTab === 'not_priced' && (
                  <NotPricedTable rows={notPriced} mainTab={mainTab} />
                )}
              </section>
            </>
          ) : (
            <div className="bsm-empty-block">
              Документы загружены, но в выбранных диапазонах нет позиций. Проверьте сопоставление столбцов («⚙️ Столбцы») и диапазон строк в карточках выше.
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Карточка одного документа: имя файла, выбор листа, диапазон строк, панель сопоставления столбцов.
function DocumentCard({
  doc, index, canEdit,
  onSheetChange, onColumnChange, onResetColumns, onTogglePanel, onRangeChange, onReplace, onRemove,
}) {
  const columnPreviews = useMemo(
    () => computeColumnPreviews(doc.workbook, doc.selectedSheet),
    [doc.workbook, doc.selectedSheet]
  )
  const maxRows = doc.allRows.length

  return (
    <div className="bsm-doc-card">
      <div className="bsm-doc-card-head">
        <span className="bsm-doc-index" aria-hidden>{index + 1}</span>
        <span className="bsm-file-chip" title={doc.fileName}>
          <span aria-hidden>📎</span> {doc.fileName}
        </span>

        {doc.sheetNames.length > 0 && (
          <label className="bsm-sheet-select-wrap" title="Лист с данными">
            <span aria-hidden>📑</span>
            <select
              className="bsm-sheet-select"
              value={doc.selectedSheet}
              onChange={(e) => onSheetChange(e.target.value)}
              disabled={!canEdit}
            >
              {doc.sheetNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="bsm-doc-range">
          <span className="bsm-label">Строки</span>
          <div className="bsm-range-inputs">
            <label>
              С
              <input
                type="number"
                min={1}
                max={maxRows || 1}
                value={doc.rangeFrom}
                disabled={!canEdit}
                onChange={(e) => onRangeChange({ rangeFrom: e.target.value === '' ? '' : Number(e.target.value) })}
                onBlur={(e) => {
                  const v = Number(e.target.value) || 1
                  onRangeChange({ rangeFrom: Math.max(1, Math.min(maxRows || 1, v)) })
                }}
              />
            </label>
            <span className="bsm-range-sep">—</span>
            <label>
              По
              <input
                type="number"
                min={1}
                max={maxRows || 1}
                value={doc.rangeTo}
                disabled={!canEdit}
                onChange={(e) => onRangeChange({ rangeTo: e.target.value === '' ? '' : Number(e.target.value) })}
                onBlur={(e) => {
                  const v = Number(e.target.value) || (maxRows || 1)
                  onRangeChange({ rangeTo: Math.max(1, Math.min(maxRows || 1, v)) })
                }}
              />
            </label>
            <span className="bsm-range-total">из {maxRows}</span>
          </div>
        </div>

        <div className="bsm-doc-card-actions">
          <button
            type="button"
            className={`bsm-btn-secondary bsm-column-map-toggle ${doc.showColumnPanel ? 'active' : ''}`}
            onClick={onTogglePanel}
            title="Какой столбец Excel содержит какие данные"
          >
            ⚙️ Столбцы {doc.showColumnPanel ? '▴' : '▾'}
          </button>
          {canEdit && (
            <button type="button" className="bsm-btn-secondary" onClick={onReplace}>
              Заменить
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="bsm-doc-remove"
              onClick={onRemove}
              title="Удалить документ из анализа"
              aria-label="Удалить документ"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {doc.showColumnPanel && (
        <div className="bsm-column-map-panel bsm-column-map-panel--inline" role="region" aria-label="Сопоставление колонок">
          <div className="bsm-column-map-title">Из какого столбца брать данные</div>
          <div className="bsm-column-map-grid">
            {COLUMN_FIELDS.map(f => (
              <label key={f.key} className="bsm-column-map-row">
                <span className="bsm-column-map-label">{f.label}</span>
                <select
                  className="bsm-column-map-select"
                  value={doc.columnMap[f.key] ?? ''}
                  onChange={(e) => onColumnChange(f.key, e.target.value)}
                  disabled={!canEdit}
                >
                  <option value="">— не использовать</option>
                  {Array.from({ length: COLUMN_CHOICES_COUNT }, (_, idx) => {
                    const letter = XLSX.utils.encode_col(idx)
                    const preview = columnPreviews[idx]
                    return (
                      <option key={idx} value={idx}>
                        {letter}{preview ? ` — ${preview}` : ''}
                      </option>
                    )
                  })}
                </select>
              </label>
            ))}
          </div>
          {canEdit && (
            <div className="bsm-column-map-actions">
              <button type="button" className="bsm-btn-ghost" onClick={onResetColumns}>
                Сбросить к стандартной (A/B/C/D/E/F/G/H/L)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SummaryTable({ rows, mainTab, showSources }) {
  if (rows.length === 0) {
    return (
      <div className="bsm-empty-block">
        Нет строк типа «{mainTab === 'material' ? 'мат.' : 'Р'}» в выбранном диапазоне.
      </div>
    )
  }
  return (
    <div className="bsm-table-wrap">
      <table className="bsm-table">
        <thead>
          <tr>
            <th style={{ width: '52px' }} className="num">№</th>
            <th>Наименование</th>
            <th style={{ width: '88px' }}>Ед. изм.</th>
            <th className="num" style={{ width: '130px' }}>
              {mainTab === 'material' ? 'Объём (расход)' : 'Объём работ'}
            </th>
            <th className="num" style={{ width: '140px' }}>
              {mainTab === 'material' ? 'Цена за ед., ₽' : 'Расценка СМР, ₽'}
            </th>
            <th className="num" style={{ width: '160px' }}>Сумма, ₽</th>
            <th className="num" style={{ width: '110px' }} title="Сколько исходных строк агрегировано">
              Позиций
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g, idx) => (
            <tr key={g.name} className={(g.hasDifferentUnits || g.hasDifferentPrices) ? 'has-warning' : ''}>
              <td className="num muted">{idx + 1}</td>
              <td>
                <div className="bsm-name">{g.name}</div>
                {(g.hasDifferentPrices || g.hasDifferentUnits) && (
                  <div className="bsm-name-warning">
                    {g.hasDifferentPrices && <span>⚠ разные цены</span>}
                    {g.hasDifferentUnits && <span>⚠ разные ед.</span>}
                  </div>
                )}
                {showSources && g.sources.length > 1 && (
                  <div className="bsm-name-sources" title={g.sources.join(', ')}>
                    📎 {g.sources.length} докум.
                  </div>
                )}
              </td>
              <td>{g.units.join(', ') || '—'}</td>
              <td className="num">{fmtNum(g.totalVolume)}</td>
              <td className="num">{g.unitPrice > 0 ? fmtRub(g.unitPrice) : '—'}</td>
              <td className="num strong">{fmtRub(g.totalSum)}</td>
              <td className="num">{g.count}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} className="bsm-foot-label">Итого</td>
            <td className="num strong">
              {fmtRub(rows.reduce((s, r) => s + r.totalSum, 0))}
            </td>
            <td className="num">{rows.reduce((s, r) => s + r.count, 0)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function DifferentPricesTable({ rows, mainTab }) {
  if (rows.length === 0) {
    return (
      <div className="bsm-empty-block bsm-empty-block--success">
        Расхождений по ценам нет. Все цены на одинаковые наименования совпадают.
      </div>
    )
  }
  return (
    <div className="bsm-table-wrap">
      <table className="bsm-table bsm-table-detail">
        <thead>
          <tr>
            <th>Наименование</th>
            <th style={{ width: '90px' }}>Стр. Excel</th>
            <th style={{ width: '160px' }}>Документ</th>
            <th style={{ width: '90px' }}>Ед. изм.</th>
            <th className="num" style={{ width: '120px' }}>Объём</th>
            <th className="num" style={{ width: '140px' }}>
              Цена {mainTab === 'material' ? '(мат.)' : '(СМР)'}, ₽
            </th>
            <th className="num" style={{ width: '160px' }}>Сумма, ₽</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <RowGroup key={g.name} group={g} priceField />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NotPricedTable({ rows, mainTab }) {
  if (rows.length === 0) {
    return (
      <div className="bsm-empty-block bsm-empty-block--success">
        Все позиции ({mainTab === 'material' ? 'материалы' : 'работы'}) расценены — цены проставлены.
      </div>
    )
  }
  const priceColLabel = mainTab === 'material' ? 'G (цена мат.)' : 'H (цена СМР)'
  return (
    <div className="bsm-table-wrap">
      <table className="bsm-table bsm-table-detail">
        <thead>
          <tr>
            <th>Наименование / Стр. Excel</th>
            <th style={{ width: '160px' }}>Документ</th>
            <th style={{ width: '90px' }}>Ед. изм.</th>
            <th className="num" style={{ width: '130px' }}>Объём</th>
            <th className="num" style={{ width: '160px' }} title="Сырое значение из ячейки Excel">
              {priceColLabel} <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(сырое)</span>
            </th>
            <th className="num" style={{ width: '120px' }}>Распознано как</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <RowNotPriced key={g.name} group={g} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="bsm-foot-label">Итого позиций без цены</td>
            <td className="num strong">{fmtNum(rows.reduce((s, r) => s + r.totalVolume, 0))}</td>
            <td className="num">{rows.reduce((s, r) => s + r.count, 0)} строк</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function RowNotPriced({ group }) {
  const formatRaw = (v) => {
    if (v === null || v === undefined || v === '') return <span className="muted">(пусто)</span>
    return <code className="bsm-raw">{String(v)}</code>
  }
  return (
    <>
      <tr className="bsm-row-group-head">
        <td colSpan={6}>
          <span className="bsm-name">{group.name}</span>
          <span className="bsm-group-hint">
            строк в Excel: {group.items.length} · итого объём: {fmtNum(group.totalVolume)}
          </span>
        </td>
      </tr>
      {group.items.map((it, idx) => (
        <tr key={`${group.name}-${idx}`}>
          <td className="muted bsm-indent">стр. {it.excelRow}</td>
          <td className="muted bsm-source" title={it.sourceFile}>{it.sourceFile || '—'}</td>
          <td>{it.unit || '—'}</td>
          <td className="num">{fmtNum(it.volume)}</td>
          <td className="num">{formatRaw(it.rawPrice)}</td>
          <td className="num">{it.price > 0 ? fmtRub(it.price) : <span className="muted">0</span>}</td>
        </tr>
      ))}
    </>
  )
}

function DifferentUnitsTable({ rows, mainTab }) {
  if (rows.length === 0) {
    return (
      <div className="bsm-empty-block bsm-empty-block--success">
        Расхождений по единицам измерения нет. Все одинаковые наименования имеют одну ед. изм.
      </div>
    )
  }
  return (
    <div className="bsm-table-wrap">
      <table className="bsm-table bsm-table-detail">
        <thead>
          <tr>
            <th>Наименование</th>
            <th style={{ width: '90px' }}>Стр. Excel</th>
            <th style={{ width: '160px' }}>Документ</th>
            <th style={{ width: '110px' }}>Ед. изм.</th>
            <th className="num" style={{ width: '120px' }}>Объём</th>
            <th className="num" style={{ width: '140px' }}>
              Цена {mainTab === 'material' ? '(мат.)' : '(СМР)'}, ₽
            </th>
            <th className="num" style={{ width: '160px' }}>Сумма, ₽</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <RowGroup key={g.name} group={g} unitsField />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowGroup({ group, priceField, unitsField }) {
  return (
    <>
      <tr className="bsm-row-group-head">
        <td colSpan={7}>
          <span className="bsm-name">{group.name}</span>
          {priceField && (
            <span className="bsm-group-hint">
              разные цены: {group.prices.map(p => fmtRub(p)).join(' / ')}
            </span>
          )}
          {unitsField && (
            <span className="bsm-group-hint">
              разные ед.: {group.units.join(' / ')}
            </span>
          )}
        </td>
      </tr>
      {group.items.map((it, idx) => (
        <tr key={`${group.name}-${idx}`}>
          <td className="muted bsm-indent">— исходная строка</td>
          <td>{it.excelRow}</td>
          <td className="muted bsm-source" title={it.sourceFile}>{it.sourceFile || '—'}</td>
          <td>{it.unit || '—'}</td>
          <td className="num">{fmtNum(it.volume)}</td>
          <td className="num">{it.price > 0 ? fmtRub(it.price) : '—'}</td>
          <td className="num">{fmtRub(it.sum)}</td>
        </tr>
      ))}
    </>
  )
}

export default BSMPage
