// task 346: парсинг Excel-КП в записи tender_counterparty_proposals.
// Два формата:
//   A. «По позициям ВОР»  — Excel совпадает с нашим ВОРом построчно, матчинг
//                            по row_number из колонки № п/п.
//   B. «По агрегатам»     — Excel в формате name+unit+price (Материалы / Работы);
//                            одна цена применяется ко ВСЕМ позициям ВОРа с тем
//                            же (name, unit).
//
// Возвращают: { records: [...], warnings: [...], unmatched: [...] }.

import * as XLSX from 'xlsx'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// Регулярка всех видов пробелов через unicode escape — иначе lint ругается
// на «irregular whitespace» если эти символы есть в исходнике.
const SPACES_RE = new RegExp('[\\s\\u00A0\\u2007\\u202F\\u200B]+', 'g')


// Чистка числа из Excel: валюта, неразрывные пробелы, запятая → точка.
export function cleanNumeric(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return value
  let s = String(value)
  s = s.replace(SPACES_RE, '')
  s = s.replace(/[₽$€¥£]/g, '')
  s = s.replace(/(руб\.?|rub|usd|eur)$/i, '')
  s = s.replace(',', '.')
  s = s.replace(/[^\d.-]/g, '')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

// Нормализация name/unit для match: trim, lowercase, схлопывание пробелов и точек.
export function normalizeKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Определение типа позиции по КОД («Р» / «р-…» → работа, иначе материал).
function isWorkRow(item) {
  const c = String(item.code || '').trim().toLowerCase()
  return c === 'р' || c.startsWith('р-') || c.startsWith('р ') || c.startsWith('раб')
}

// task 347: иерархическая нумерация позиций ВОР — точно та же логика, что
// показывается в UI (EstimateTable). Работы «1, 2, 3…», материалы под работой
// «1.1, 1.2…». Возвращает Map<displayNum, item>. Контрагент в Excel видит эту
// нумерацию и заполняет цены по ней.
export function buildDisplayNumberMap(itemsOfVor) {
  const map = new Map()
  let workCount = 0
  let matCount = 0
  for (const it of itemsOfVor) {
    if (it.is_section) continue
    let key
    if (isWorkRow(it)) {
      workCount++
      matCount = 0
      key = String(workCount)
    } else {
      matCount++
      key = workCount > 0 ? `${workCount}.${matCount}` : String(matCount)
    }
    map.set(key, it)
  }
  return map
}

// ===== Формат A: по позициям ВОР =====
// columnMap: { num, code, name, priceMaterial, priceWork, note }.
// rowRange: { start: 1-based, end: 1-based|null }.
//
// task 347 + 348: матчинг устойчив к тому, что в реальных КП материалы
// часто идут БЕЗ № в колонке А (нумерованы только работы). Поэтому:
//   - если есть № — матчим по нему (приоритет, hierarchical displayNum);
//   - если нет — берём следующую позицию ВОР по порядку (sequential cursor);
//   - если указаны код/наименование — дополнительно сверяем (warning при mismatch);
//   - строки-разделы (нет num, нет кода, нет цен) пропускаются автоматически.
export function parseByPosition({
  workbook,
  sheetName,
  columnMap,
  rowRange,
  estimateItems,
  docName,
}) {
  const records = []
  const warnings = []
  const unmatched = []

  const sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    return { records, warnings: ['Лист не найден'], unmatched }
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
  const start = Math.max(0, (parseInt(rowRange.start) || 2) - 1)
  const end = rowRange.end ? Math.min(rows.length, parseInt(rowRange.end)) : rows.length

  // Только позиции этого ВОРа, исключая разделы. Sorted by row_number (как fetched).
  const itemsOfVor = estimateItems.filter(
    it => (it.estimate_name || 'Основная смета') === docName && !it.is_section
  )
  const itemsByDisplay = buildDisplayNumberMap(itemsOfVor)
  const itemsByRowNum = new Map(itemsOfVor.map(it => [String(it.row_number), it]))

  const cell = (row, idx) => (idx != null && row[idx] != null) ? row[idx] : null
  const seenItemIds = new Set()
  let cursor = -1 // индекс в itemsOfVor последней матченной позиции

  const normalizeNum = (s) => {
    if (s == null || s === '') return ''
    return String(s).trim().replace(',', '.').replace(/\.$/, '').replace(/^0+(\d)/, '$1')
  }

  for (let i = start; i < end; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue

    const rawNum = cell(row, columnMap.num)
    const rawCode = columnMap.code != null ? cell(row, columnMap.code) : null
    const rawName = columnMap.name != null ? cell(row, columnMap.name) : null
    const priceMat = round2(cleanNumeric(cell(row, columnMap.priceMaterial)))
    const priceWork = round2(cleanNumeric(cell(row, columnMap.priceWork)))
    const note = columnMap.note != null
      ? String(cell(row, columnMap.note) || '').trim() || null
      : null

    const hasNum = rawNum != null && String(rawNum).trim() !== ''
    const hasCode = rawCode != null && String(rawCode).trim() !== ''
    const hasName = rawName != null && String(rawName).trim() !== ''
    const hasPrice = priceMat > 0 || priceWork > 0

    // Строка-раздел: нет ни №, ни кода, ни цен — типично «Часть 10…» или
    // «10.03Б.02.01.07.01.02. Монтаж…». Пропускаем без unmatched.
    if (!hasNum && !hasCode && !hasPrice) continue

    let item = null

    // 1. Приоритет: матчинг по явному № (если он есть).
    if (hasNum) {
      const key = normalizeNum(rawNum)
      item = itemsByDisplay.get(key) || itemsByRowNum.get(key)
      if (item) {
        cursor = itemsOfVor.indexOf(item)
      } else {
        // № указан, но не нашлось — НЕ переходим на sequential
        // (может это была опечатка или нумерация другая) — отчёт в unmatched.
        unmatched.push({ row: i + 1, rowNumber: key, reason: 'нет позиции с таким №' })
        continue
      }
    } else {
      // 2. Нет № — берём следующий ВОР-item.
      cursor++
      item = itemsOfVor[cursor]
      if (!item) {
        unmatched.push({ row: i + 1, name: hasName ? String(rawName) : '', reason: 'строк в Excel больше, чем позиций в ВОР' })
        continue
      }

      // Опциональная сверка наименования (warning при сильном расхождении).
      if (hasName) {
        const want = normalizeKey(item.cost_name)
        const got = normalizeKey(String(rawName))
        // Простая мера схожести: совпадение по началу или общему фрагменту.
        const matches = want === got
          || want.includes(got)
          || got.includes(want)
          || (got.length >= 8 && want.length >= 8 && want.slice(0, 8) === got.slice(0, 8))
        if (!matches) {
          warnings.push(
            `Строка ${i + 1}: наименование «${String(rawName).slice(0, 40)}…» не похоже на ВОР-позицию «${item.cost_name.slice(0, 40)}…» — возможно, сбился порядок строк.`
          )
        }
      }
    }

    if (seenItemIds.has(item.id)) {
      warnings.push(
        `Строка ${i + 1}: позиция «${item.cost_name.slice(0, 40)}…» уже была — повторное вхождение пропущено.`
      )
      continue
    }

    if (priceMat === 0 && priceWork === 0 && !note) continue

    const workVol = Number(item.work_volume) || 0
    const matVol = Number(item.material_consumption) || 0
    const totalMaterials = round2(priceMat * matVol)
    const totalWorks = round2(priceWork * workVol)

    records.push({
      estimate_item_id: item.id,
      unit_price_materials: priceMat,
      unit_price_works: priceWork,
      total_unit_price: round2(priceMat + priceWork),
      total_materials: totalMaterials,
      total_works: totalWorks,
      total_cost: round2(totalMaterials + totalWorks),
      participant_note: note,
    })
    seenItemIds.add(item.id)
  }

  if (records.length === 0 && unmatched.length === 0) {
    warnings.push('Не распознано ни одной строки. Проверьте столбцы и диапазон.')
  }
  return { records, warnings, unmatched }
}

// ===== Формат B: по агрегатам (Материалы / Работы) =====
// columnMap: { name, unit, price, kind } — kind опциональный (колонка с типом),
//   если нет — определяем по имени листа.
// kindHint: 'materials' | 'works' | 'auto' (по имени листа) | 'column' (читать из columnMap.kind).
export function parseByAggregate({
  workbook,
  sheetName,
  columnMap,
  rowRange,
  estimateItems,
  docName,
  kindHint = 'auto',
}) {
  const warnings = []
  const unmatched = []
  const recordsByItemId = new Map() // estimate_item_id → record

  const sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    return { records: [], warnings: ['Лист не найден'], unmatched }
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
  const start = Math.max(0, (parseInt(rowRange.start) || 2) - 1)
  const end = rowRange.end ? Math.min(rows.length, parseInt(rowRange.end)) : rows.length

  const itemsOfVor = estimateItems.filter(
    it => (it.estimate_name || 'Основная смета') === docName && !it.is_section
  )
  // Группируем позиции по (normalizedName + normalizedUnit) — одна цена может
  // примениться ко множеству строк ВОР с тем же name/unit.
  const itemsByKey = new Map()
  for (const it of itemsOfVor) {
    const key = `${normalizeKey(it.cost_name)}|${normalizeKey(it.unit)}`
    if (!itemsByKey.has(key)) itemsByKey.set(key, [])
    itemsByKey.get(key).push(it)
  }

  const detectKindFromSheet = (name) => {
    const n = String(name || '').toLowerCase()
    if (/материал/.test(n)) return 'materials'
    if (/работ/.test(n)) return 'works'
    return null
  }

  const sheetKind = kindHint === 'auto'
    ? detectKindFromSheet(sheetName)
    : (kindHint === 'materials' || kindHint === 'works' ? kindHint : null)

  const cell = (row, idx) => (idx != null && row[idx] != null) ? row[idx] : null

  for (let i = start; i < end; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue

    const name = String(cell(row, columnMap.name) || '').trim()
    if (!name) continue
    const unit = String(cell(row, columnMap.unit) || '').trim()
    const price = round2(cleanNumeric(cell(row, columnMap.price)))
    if (price <= 0) continue

    // Тип строки: либо из колонки kind, либо из листа.
    let rowKind = sheetKind
    if (columnMap.kind != null) {
      const k = String(cell(row, columnMap.kind) || '').toLowerCase()
      if (/мат/.test(k)) rowKind = 'materials'
      else if (/раб|^р$/.test(k.trim())) rowKind = 'works'
    }
    if (!rowKind) {
      unmatched.push({ row: i + 1, name, reason: 'не определён тип (мат/работа)' })
      continue
    }

    const key = `${normalizeKey(name)}|${normalizeKey(unit)}`
    const matchingItems = itemsByKey.get(key)
    if (!matchingItems || matchingItems.length === 0) {
      unmatched.push({ row: i + 1, name, unit, reason: 'нет совпадений в ВОР' })
      continue
    }

    if (matchingItems.length > 1) {
      warnings.push(
        `«${name}» (${unit || '—'}) встречается в ВОР ${matchingItems.length} раз — ` +
        `цена применена ко всем позициям.`
      )
    }

    for (const item of matchingItems) {
      const workVol = Number(item.work_volume) || 0
      const matVol = Number(item.material_consumption) || 0
      const existing = recordsByItemId.get(item.id) || {
        estimate_item_id: item.id,
        unit_price_materials: 0,
        unit_price_works: 0,
        participant_note: null,
      }
      if (rowKind === 'materials') existing.unit_price_materials = price
      else existing.unit_price_works = price

      existing.total_unit_price = round2(existing.unit_price_materials + existing.unit_price_works)
      existing.total_materials = round2(existing.unit_price_materials * matVol)
      existing.total_works = round2(existing.unit_price_works * workVol)
      existing.total_cost = round2(existing.total_materials + existing.total_works)

      recordsByItemId.set(item.id, existing)
    }
  }

  const records = [...recordsByItemId.values()]
  if (records.length === 0 && unmatched.length === 0) {
    warnings.push('Не распознано ни одной строки. Проверьте столбцы и диапазон.')
  }
  return { records, warnings, unmatched }
}

// Превью первой непустой ячейки каждой колонки — для подсказок в select.
export function getColumnPreviews(workbook, sheetName, count = 26) {
  const empty = Array(count).fill('')
  if (!workbook || !sheetName) return empty
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return empty
  const out = []
  for (let c = 0; c < count; c++) {
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
    out.push(preview)
  }
  return out
}

// task 367: merge two aggregate parse results (материалы + работы from separate sheets).
// Combines records by estimate_item_id, merging price fields:
// - If item appears in both sheets, sets both unit_price_materials and unit_price_works
// - If only in one sheet, keeps that sheet's price
// - Recalculates totals based on merged data
export function mergeAggregateRecords(matRecords, workRecords) {
  const byId = new Map()
  // First pass: collect materials
  for (const r of matRecords) {
    byId.set(r.estimate_item_id, { ...r })
  }
  // Second pass: merge works
  for (const r of workRecords) {
    const existing = byId.get(r.estimate_item_id)
    if (existing) {
      existing.unit_price_works = r.unit_price_works
      existing.total_works = r.total_works
      existing.total_unit_price = round2((existing.unit_price_materials || 0) + (r.unit_price_works || 0))
      existing.total_cost = round2((existing.total_materials || 0) + (r.total_works || 0))
    } else {
      byId.set(r.estimate_item_id, { ...r })
    }
  }
  return [...byId.values()]
}
