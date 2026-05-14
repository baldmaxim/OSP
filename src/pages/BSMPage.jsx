import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import './BSMPage.css'

// Структура колонок Excel:
// A(0) — № п/п
// B(1) — КОД (мат./Р/Р-…)
// C(2) — Наименование затрат
// D(3) — Ед. изм.
// E(4) — Объём по виду работ
// F(5) — Общий расход по материалу
// G(6) — Цена, руб. с НДС за материалы/оборудование
// H(7) — Цена, руб. с НДС за СМР/ПНР
// L(11) — Примечания

const COL = {
  num: 0,
  code: 1,
  name: 2,
  unit: 3,
  workVolume: 4,
  materialVolume: 5,
  priceMaterial: 6,
  priceWork: 7,
  notes: 11,
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// Excel-числа с разделителями/валютой/пробелами → JS number.
// Учитываем все виды пробелов: обычный, табуляция, неразрывный (U+00A0),
// figure space (U+2007), narrow no-break (U+202F), zero-width (U+200B).
function cleanNumeric(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return value
  let str = String(value)
  // 1) Убираем все виды пробелов СНАЧАЛА — иначе «1 234,56» парсится как «1».
  str = str.replace(/[\s   ​]+/g, '')
  // 2) Символы валют.
  str = str.replace(/[₽$€¥£]/g, '')
  // 3) Валютные суффиксы (после удаления пробелов уже без границ).
  str = str.replace(/(руб\.?|rub|usd|eur|тыс\.?|млн\.?)$/i, '')
  str = str.replace(',', '.')
  str = str.replace(/[^\d.\-]/g, '')
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
  if (code === 'р' || code.startsWith('р-') || code.startsWith('р ') || code === 'раб' || code === 'раб.') {
    return 'work'
  }
  return null
}

const fmtRub = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n)) + ' ₽'
const fmtNum = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n))

function BSMPage() {
  const [fileName, setFileName] = useState('')
  const [allRows, setAllRows] = useState([]) // [{ excelRow, num, code, name, unit, workVolume, materialVolume, priceMaterial, priceWork, notes, kind }]
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(1)
  const [mainTab, setMainTab] = useState('material') // 'material' | 'work'
  const [subTab, setSubTab] = useState('summary')    // 'summary' | 'different_prices' | 'different_units'
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      // sheet_to_json читает только в пределах sheet['!ref'], а он часто обрезан.
      // Поэтому идём напрямую по ячейкам — берём фактический максимум по ключам листа.
      let maxR = 0
      for (const k of Object.keys(sheet)) {
        if (k.startsWith('!')) continue
        const cell = XLSX.utils.decode_cell(k)
        if (cell.r > maxR) maxR = cell.r
      }
      // pickCell: достаёт «лучшее» значение — сначала raw .v, потом formatted .w.
      const pickCell = (rowIdx, colIdx) => {
        const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
        const cell = sheet[ref]
        if (!cell) return { value: 0, raw: '' }
        const rawV = cell.v
        const a = cleanNumeric(rawV)
        if (a > 0) return { value: a, raw: rawV }
        const b = cleanNumeric(cell.w)
        if (b > 0) return { value: b, raw: cell.w }
        const display = (rawV !== undefined && rawV !== '' ? rawV : cell.w) ?? ''
        return { value: 0, raw: display }
      }
      const getText = (rowIdx, colIdx) => {
        const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
        const cell = sheet[ref]
        if (!cell) return ''
        return cell.v !== undefined && cell.v !== '' ? String(cell.v) : String(cell.w || '')
      }
      const parsed = []
      for (let r = 0; r <= maxR; r++) {
        const wv = pickCell(r, COL.workVolume)
        const mv = pickCell(r, COL.materialVolume)
        const pm = pickCell(r, COL.priceMaterial)
        const pw = pickCell(r, COL.priceWork)
        const codeText = getText(r, COL.code)
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
      setFileName(file.name)
      setAllRows(parsed)
      // По умолчанию пытаемся пропустить шапку: первая строка с непустым наименованием.
      const firstDataRow = parsed.findIndex(r => r.name) + 1
      setRangeFrom(firstDataRow > 0 ? firstDataRow : 1)
      setRangeTo(parsed.length)
    } catch (err) {
      console.error('Ошибка чтения Excel:', err)
      setError('Не удалось прочитать файл. Проверьте формат (нужен .xlsx или .xls).')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleClear = () => {
    setFileName('')
    setAllRows([])
    setRangeFrom(1)
    setRangeTo(1)
    setError(null)
  }

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
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          {!hasData ? (
            <button className="bsm-btn-primary" onClick={() => fileInputRef.current?.click()}>
              📂 Загрузить Excel
            </button>
          ) : (
            <>
              <span className="bsm-file-chip" title={fileName}>
                <span aria-hidden>📎</span> {fileName}
              </span>
              <button className="bsm-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                Заменить
              </button>
              <button className="bsm-btn-ghost" onClick={handleClear}>
                Очистить
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="bsm-error">{error}</div>}

      {!hasData && (
        <div className="bsm-empty">
          <div className="bsm-empty-icon" aria-hidden>📥</div>
          <div className="bsm-empty-title">Нет данных</div>
          <div className="bsm-empty-text">
            Загрузите Excel-документ. Ожидается следующая структура колонок:
          </div>
          <table className="bsm-format-table">
            <thead>
              <tr>
                <th>Колонка</th><th>Назначение</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>A</td><td>№ п/п</td></tr>
              <tr><td>B</td><td>КОД (<code>мат.</code> — материал, <code>Р</code>/<code>Р-…</code> — работа)</td></tr>
              <tr><td>C</td><td>Наименование затрат</td></tr>
              <tr><td>D</td><td>Ед. изм.</td></tr>
              <tr><td>E</td><td>Объём по виду работ</td></tr>
              <tr><td>F</td><td>Общий расход по материалу</td></tr>
              <tr><td>G</td><td>Цена, руб. с НДС за материалы/оборудование</td></tr>
              <tr><td>H</td><td>Цена, руб. с НДС за СМР/ПНР</td></tr>
              <tr><td>L</td><td>Примечания</td></tr>
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
