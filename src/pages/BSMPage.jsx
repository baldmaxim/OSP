import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useRole } from '../contexts/RoleContext'
import './BSMPage.css'

// Поля, которые подтягиваются из Excel. Пользователь сам выбирает столбец для каждого
// в панели «Столбцы» (шапка страницы). Дефолтная раскладка — A/B/C/D/E/F/G/H/L.
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

function BSMPage() {
  const { canEdit } = useRole()
  const canEditKp = canEdit('analysis_kp')
  const [fileName, setFileName] = useState('')
  const [workbook, setWorkbook] = useState(null)         // Сам workbook — храним, чтобы переключать листы и резолвить формулы.
  const [sheetNames, setSheetNames] = useState([])       // Список листов в файле.
  const [selectedSheet, setSelectedSheet] = useState('') // Активный лист.
  const [allRows, setAllRows] = useState([])
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(1)
  const [mainTab, setMainTab] = useState('material')
  const [subTab, setSubTab] = useState('summary')
  const [error, setError] = useState(null)
  const [isDragActive, setIsDragActive] = useState(false)
  // Маппинг полей анализа КП на столбцы Excel. Пользователь меняет в панели «Столбцы».
  const [columnMap, setColumnMap] = useState(() => {
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
  })
  const [showColumnPanel, setShowColumnPanel] = useState(false)
  const fileInputRef = useRef(null)

  // Сохраняем маппинг в localStorage при каждом изменении.
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_MAP_STORAGE_KEY, JSON.stringify(columnMap))
    } catch { /* localStorage может быть недоступен (приватный режим) — игнорируем */ }
  }, [columnMap])

  const processFile = async (file) => {
    if (!file) return
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      setWorkbook(wb)
      setSheetNames(wb.SheetNames)
      setFileName(file.name)
      setSelectedSheet(wb.SheetNames[0] || '')
    } catch (err) {
      console.error('Ошибка чтения Excel:', err)
      setError('Не удалось прочитать файл. Проверьте формат (нужен .xlsx или .xls).')
    }
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    try {
      await processFile(file)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

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
    processFile(file)
  }

  // Парсим выбранный лист. Запускается при изменении workbook, selectedSheet или columnMap.
  useEffect(() => {
    if (!workbook || !selectedSheet) return
    const sheet = workbook.Sheets[selectedSheet]
    if (!sheet) return
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
        const r = resolveFormula(workbook, selectedSheet, cell.f)
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
    setAllRows(parsed)
    // По умолчанию пытаемся пропустить шапку: первая строка с непустым наименованием.
    const firstDataRow = parsed.findIndex(r => r.name) + 1
    setRangeFrom(firstDataRow > 0 ? firstDataRow : 1)
    setRangeTo(parsed.length || 1)
  }, [workbook, selectedSheet, columnMap])

  const handleClear = () => {
    setFileName('')
    setWorkbook(null)
    setSheetNames([])
    setSelectedSheet('')
    setAllRows([])
    setRangeFrom(1)
    setRangeTo(1)
    setError(null)
  }

  // Превью первой непустой ячейки в каждом столбце (по первым 6 строкам) — для
  // подсказки в выпадающем списке: «A — № п/п», «C — Наименование» и т. д.
  const columnPreviews = useMemo(() => {
    const empty = Array(COLUMN_CHOICES_COUNT).fill('')
    if (!workbook || !selectedSheet) return empty
    const sheet = workbook.Sheets[selectedSheet]
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
  }, [workbook, selectedSheet])

  const updateColumnMap = (fieldKey, value) => {
    setColumnMap(prev => ({
      ...prev,
      [fieldKey]: value === '' ? null : Number(value)
    }))
  }

  const handleResetColumnMap = () => setColumnMap({ ...DEFAULT_COLUMN_MAP })

  // Строки, попавшие в выбранный диапазон.
  const rangeRows = useMemo(() => {
    if (allRows.length === 0) return []
    const from = Math.max(1, Math.min(rangeFrom, allRows.length))
    const to = Math.max(from, Math.min(rangeTo, allRows.length))
    return allRows.slice(from - 1, to)
  }, [allRows, rangeFrom, rangeTo])

  // Группировка по наименованию для текущей вкладки (материалы/работы).
  // Для материалов берём materialVolume × priceMaterial.
  // Для работ — workVolume × priceWork.
  const grouped = useMemo(() => {
    if (rangeRows.length === 0) return []
    const isMaterial = mainTab === 'material'
    const filtered = rangeRows.filter(r => r.kind === (isMaterial ? 'material' : 'work') && r.name)
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
          totalVolume: 0,
          count: 0,
          items: [],
          lastPrice: 0,
        })
      }
      const g = map.get(key)
      if (r.unit) g.unitsSet.add(r.unit)
      if (price > 0) g.pricesSet.add(round2(price))
      g.totalVolume = round2(g.totalVolume + volume)
      g.count += 1
      g.lastPrice = price > 0 ? round2(price) : g.lastPrice
      g.items.push({
        excelRow: r.excelRow,
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
  }, [rangeRows, mainTab])

  const differentPrices = useMemo(() => grouped.filter(g => g.hasDifferentPrices), [grouped])
  const differentUnits = useMemo(() => grouped.filter(g => g.hasDifferentUnits), [grouped])
  // Позиции без цены: цена не указана ни в одной из исходных строк (pricesSet пуст).
  const notPriced = useMemo(() => grouped.filter(g => g.prices.length === 0), [grouped])

  const stats = useMemo(() => {
    const totalRows = rangeRows.length
    const matched = grouped.length
    const totalSum = round2(grouped.reduce((s, g) => s + g.totalSum, 0))
    const totalVolume = round2(grouped.reduce((s, g) => s + g.totalVolume, 0))
    const sourcePositions = grouped.reduce((s, g) => s + g.count, 0)
    return { totalRows, matched, totalSum, totalVolume, sourcePositions }
  }, [grouped, rangeRows])

  const hasData = allRows.length > 0
  const subTabsAvailable = hasData

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
      ['№', 'Наименование', 'Ед. изм.', volumeHeader, priceHeader, 'Сумма, ₽', 'Позиций', 'Предупреждения'],
      ...grouped.map((g, idx) => [
        idx + 1,
        g.name,
        g.units.join(', '),
        round2(g.totalVolume),
        round2(g.unitPrice),
        round2(g.totalSum),
        g.count,
        [
          g.hasDifferentPrices ? 'разные цены' : null,
          g.hasDifferentUnits ? 'разные ед.' : null,
          g.prices.length === 0 ? 'не расценено' : null,
        ].filter(Boolean).join('; '),
      ]),
      [],
      ['', 'ИТОГО', '', round2(grouped.reduce((s, r) => s + r.totalVolume, 0)), '',
        round2(grouped.reduce((s, r) => s + r.totalSum, 0)),
        grouped.reduce((s, r) => s + r.count, 0), ''],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
    summarySheet['!cols'] = [{ wch: 5 }, { wch: 55 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 9 }, { wch: 24 }]
    XLSX.utils.book_append_sheet(wb, summarySheet, `${tabLabel} — Сводная`)

    // Лист 2: «Разные цены»
    if (differentPrices.length > 0) {
      const rows = [['Наименование', 'Стр. Excel', 'Ед. изм.', 'Объём', 'Цена, ₽', 'Сумма, ₽']]
      for (const g of differentPrices) {
        rows.push([g.name, '', '', round2(g.totalVolume), '', round2(g.totalSum)])
        for (const it of g.items) {
          rows.push(['  → исходная строка', it.excelRow, it.unit, round2(it.volume), round2(it.price), round2(it.sum)])
        }
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Разные цены`)
    }

    // Лист 3: «Разные ед.изм.»
    if (differentUnits.length > 0) {
      const rows = [['Наименование', 'Стр. Excel', 'Ед. изм.', 'Объём', 'Цена, ₽', 'Сумма, ₽']]
      for (const g of differentUnits) {
        rows.push([g.name, '', '', round2(g.totalVolume), '', round2(g.totalSum)])
        for (const it of g.items) {
          rows.push(['  → исходная строка', it.excelRow, it.unit, round2(it.volume), round2(it.price), round2(it.sum)])
        }
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Разные ед.`)
    }

    // Лист 4: «Не расценены»
    if (notPriced.length > 0) {
      const rows = [['Наименование', 'Ед. изм.', 'Объём', 'Позиций', 'Стр. Excel']]
      for (const g of notPriced) {
        rows.push([
          g.name,
          g.units.join(', '),
          round2(g.totalVolume),
          g.count,
          g.items.map(it => it.excelRow).join(', '),
        ])
      }
      const sh = XLSX.utils.aoa_to_sheet(rows)
      sh['!cols'] = [{ wch: 55 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 30 }]
      XLSX.utils.book_append_sheet(wb, sh, `${tabLabel} — Не расценены`)
    }

    // Имя файла: «Анализ КП - <имя источника без расширения> - <Материалы|Работы>.xlsx»
    const baseName = fileName.replace(/\.(xlsx|xls)$/i, '') || 'без имени'
    const outName = `Анализ КП - ${baseName} - ${tabLabel}.xlsx`
    XLSX.writeFile(wb, outName)
  }

  return (
    <div className="bsm-page">
      <header className="bsm-header">
        <div className="bsm-header-text">
          <h2>📊 Анализ КП</h2>
          <p className="bsm-subtitle">
            Загрузите Excel с расценками, задайте диапазон строк — получите сводную таблицу по наименованиям.
          </p>
        </div>

        <div className="bsm-header-actions">
          <div className="bsm-column-map-wrap">
            <button
              type="button"
              className={`bsm-btn-secondary bsm-column-map-toggle ${showColumnPanel ? 'active' : ''}`}
              onClick={() => setShowColumnPanel(s => !s)}
              title="Какой столбец Excel содержит какие данные"
            >
              ⚙️ Столбцы {showColumnPanel ? '▴' : '▾'}
            </button>
            {showColumnPanel && (
              <div className="bsm-column-map-panel" role="dialog" aria-label="Сопоставление колонок">
                <div className="bsm-column-map-title">Из какого столбца брать данные</div>
                <div className="bsm-column-map-grid">
                  {COLUMN_FIELDS.map(f => (
                    <label key={f.key} className="bsm-column-map-row">
                      <span className="bsm-column-map-label">{f.label}</span>
                      <select
                        className="bsm-column-map-select"
                        value={columnMap[f.key] ?? ''}
                        onChange={(e) => updateColumnMap(f.key, e.target.value)}
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
                <div className="bsm-column-map-actions">
                  <button
                    type="button"
                    className="bsm-btn-ghost"
                    onClick={handleResetColumnMap}
                  >
                    Сбросить к стандартной (A/B/C/D/E/F/G/H/L)
                  </button>
                </div>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          {!workbook ? (
            canEditKp && (
              <button className="bsm-btn-primary" onClick={() => fileInputRef.current?.click()}>
                📂 Загрузить Excel
              </button>
            )
          ) : (
            <>
              <span className="bsm-file-chip" title={fileName}>
                <span aria-hidden>📎</span> {fileName}
              </span>
              {sheetNames.length > 0 && (
                <label className="bsm-sheet-select-wrap" title="Лист с данными">
                  <span aria-hidden>📑</span>
                  <select
                    className="bsm-sheet-select"
                    value={selectedSheet}
                    onChange={(e) => setSelectedSheet(e.target.value)}
                  >
                    {sheetNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
              {canEditKp && (
                <button className="bsm-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                  Заменить
                </button>
              )}
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

      {!hasData && (
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
              : 'Загрузите Excel-документ или перетащите его сюда. Сопоставление колонок можно изменить кнопкой «⚙️ Столбцы» в шапке.'}
          </div>
          <table className="bsm-format-table">
            <thead>
              <tr>
                <th>Колонка</th><th>Назначение</th>
              </tr>
            </thead>
            <tbody>
              {COLUMN_FIELDS.map(f => {
                const idx = columnMap[f.key]
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

      {hasData && (
        <>
          <section className="bsm-controls">
            <div className="bsm-range">
              <span className="bsm-label">Диапазон строк</span>
              <div className="bsm-range-inputs">
                <label>
                  С
                  <input
                    type="number"
                    min={1}
                    max={allRows.length}
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={(e) => {
                      const v = Number(e.target.value) || 1
                      setRangeFrom(Math.max(1, Math.min(allRows.length, v)))
                    }}
                  />
                </label>
                <span className="bsm-range-sep">—</span>
                <label>
                  По
                  <input
                    type="number"
                    min={1}
                    max={allRows.length}
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={(e) => {
                      const v = Number(e.target.value) || allRows.length
                      setRangeTo(Math.max(1, Math.min(allRows.length, v)))
                    }}
                  />
                </label>
                <span className="bsm-range-total">из {allRows.length}</span>
              </div>
            </div>

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
              <SummaryTable rows={grouped} mainTab={mainTab} />
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
      )}
    </div>
  )
}

function SummaryTable({ rows, mainTab }) {
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
            <td colSpan={2} className="bsm-foot-label">Итого позиций без цены</td>
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
        <td colSpan={5}>
          <span className="bsm-name">{group.name}</span>
          <span className="bsm-group-hint">
            строк в Excel: {group.items.length} · итого объём: {fmtNum(group.totalVolume)}
          </span>
        </td>
      </tr>
      {group.items.map((it, idx) => (
        <tr key={`${group.name}-${idx}`}>
          <td className="muted bsm-indent">стр. {it.excelRow}</td>
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
        <td colSpan={6}>
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
