// Выгрузка сметы КП / ПЗ в Excel (13.11.2026 — как на экране, одной таблицей): выбранные строки (или найденные, или
// вся смета) с формулами и заливкой.
//   • «Смета» — КП до перекидок и план затрат в одной строке: стоимость = материалы + работы (=F+G), цена = стоимость /
//     кол-во ГП, группа — SUBTOTAL(9, …) по своим выгруженным строкам, ИТОГО — SUBTOTAL; справа — актуальный объём,
//     причина, распределено, свободно (=N−P), тендер и подрядчик, примечание;
//   • «Распределение» — каждая строка «тендер + подрядчик + объём», сумма = объём × цена;
//   • «Коэффициенты» и «Паспорт» — как в загруженном файле.
// Заливка строки и ячеек переносится; xlsx-js-style грузится лениво. Сборка — чистая (tests/tender/kp-estimate.test.mjs).
import { allocQty, allocationText, ancestorsOf, hasVolume, isPosition, originalQty, unitPrice } from './kpEstimate.js'

const hex = (c) => `FF${String(c || '').replace('#', '').toUpperCase()}`
const border = { style: 'thin', color: { rgb: 'FFD0D5DD' } }
const borders = { top: border, bottom: border, left: border, right: border }
const HEAD = { font: { bold: true }, fill: { fgColor: { rgb: 'FFE8ECF2' } }, border: borders, alignment: { wrapText: true, vertical: 'center', horizontal: 'center' } }

// Строки выгрузки по порядку сметы: выбранные и их предки (группы — для структуры и SUBTOTAL).
export function exportRowIds(tree, picked) {
  if (!picked) return tree.rows.map((r) => r.id)
  const keep = new Set()
  for (const id of picked) {
    keep.add(id)
    for (const a of ancestorsOf(tree, id)) keep.add(a)
  }
  return tree.rows.filter((r) => keep.has(r.id)).map((r) => r.id)
}

// Ячейка: значение, формула (с вычисленным значением), стиль.
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
function cell(v, f) {
  if (f) return { t: 'n', f, v: n(v) ?? 0 }
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return { t: 'n', v }
  return { t: 's', v: String(v) }
}

// Таблица листа: [[ячейки]], заливки по строкам, жирные строки, ширины.
function sheetFrom(XLSX, { headers, rows, widths, fills = [], bold = [], numFmt = {}, red = [], wrap = [] }) {
  const ws = {}
  const put = (r, c, value) => {
    const ref = XLSX.utils.encode_cell({ r, c })
    ws[ref] = value || { t: 's', v: '' }
    return ws[ref]
  }
  headers.forEach((h, c) => { put(0, c, { t: 's', v: h }).s = HEAD })
  rows.forEach((row, i) => {
    const r = i + 1
    for (let c = 0; c < headers.length; c++) {
      const ref = put(r, c, row[c])
      const style = { border: borders, alignment: { vertical: 'top', wrapText: wrap.includes(c) } }
      if (numFmt[c] && ref.t === 'n') ref.z = numFmt[c]
      const fill = fills[i]?.cells?.[c] || fills[i]?.row
      if (fill) style.fill = { fgColor: { rgb: hex(fill) } }
      if (bold[i]) style.font = { bold: true }
      if (red[i]?.includes(c)) style.font = { ...(style.font || {}), color: { rgb: 'FFC62828' } }
      ref.s = style
    }
  })
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: headers.length - 1 } })
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) }
  ws['!freeze'] = { xSplit: 3, ySplit: 1 }
  return ws
}

const MONEY = '#,##0.00'
const QTY = '#,##0.####'

// ── Смета ───────────────────────────────────────────────────────────────────
export const ESTIMATE_HEAD = ['Код', '№ п/п', 'Наименование', 'Ед.', 'Кол-во (ГП)', 'Материалы, ₽', 'Работы, ₽', 'Стоимость КП, ₽',
  'Цена за ед., ₽', 'Прямые затраты, ₽', 'Прямые: осн. материалы', 'Прямые: вспом. материалы', 'Прямые: работы',
  'Актуальный объём', 'Причина изменения', 'Распределено', 'Свободно', 'Тендер и подрядчик', 'Примечание',
  'Примечание заказчика', 'Примечание ГП']
// Столбец таблицы портала → столбец листа (для заливки ячеек).
const CELL = { code: 0, name: 2, qty_gp: 4, total: 7, direct: 9, actual: 13, free: 16, alloc: 17, note: 18 }
const SUM_COLS = [['F', 5, 'materials'], ['G', 6, 'works'], ['H', 7, 'total'], ['J', 9, 'direct'], ['K', 10, 'directMain'], ['L', 11, 'directAux'], ['M', 12, 'directWorks']]

const allocText = (allocs) => (allocs || []).map((a) => `${allocationText(a)}: ${allocQty(a)}`).join('; ')

function estimateSheetRows(ctx, ids) {
  const { tree, marks, allocsByRow, states, sums } = ctx
  const rowsOut = []
  const fills = []
  const bold = []
  const red = []
  // Последняя строка ветки в выгрузке — для SUBTOTAL группы.
  const lastOf = new Map()
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (!lastOf.has(id)) lastOf.set(id, i + 2)
    for (const a of ancestorsOf(tree, id)) if (!lastOf.has(a)) lastOf.set(a, i + 2)
  }
  ids.forEach((id, i) => {
    const r = tree.byId.get(id)
    const k = r.kp || {}
    const p = r.pz || {}
    const R = i + 2
    const mark = marks.get(id)
    const s = states.get(id)
    const group = tree.children.has(id)
    const out = []
    out[0] = cell(r.code)
    out[1] = cell(r.pos_no && Number.isFinite(Number(r.pos_no)) ? Number(r.pos_no) : r.pos_no)
    out[2] = cell(r.name)
    out[3] = cell(r.unit)
    out[4] = r.unit ? cell(originalQty(r)) : null
    if (group) {
      const last = lastOf.get(id)
      const sum = sums.get(id) || {}
      for (const [col, c, key] of SUM_COLS) out[c] = last > R ? cell(sum[key], `SUBTOTAL(9,${col}${R + 1}:${col}${last})`) : null
    } else {
      out[5] = cell(n(k.materials))
      out[6] = cell(n(k.works))
      const totalV = n(k.total)
      out[7] = r.unit && (out[5] || out[6]) ? cell(totalV, `F${R}+G${R}`) : cell(totalV)
      out[9] = cell(n(p.direct))
      out[10] = cell(n(p.direct_main))
      out[11] = cell(n(p.direct_aux))
      out[12] = cell(n(p.direct_works))
    }
    if (r.unit) out[8] = cell(unitPrice(r) || null, `IF(E${R}<>0,H${R}/E${R},"")`)
    if (isPosition(r) && s) {
      out[13] = cell(s.actual)
      out[14] = cell(mark?.actual_reason)
      out[15] = cell(s.distributed)
      out[16] = cell(s.free, `N${R}-P${R}`)
      out[17] = cell(allocText(allocsByRow.get(id)))
      if (s.status === 'over') red[i] = [16]
    } else if (hasVolume(r) && mark?.actual_qty !== null && mark?.actual_qty !== undefined) {
      out[13] = cell(Number(mark.actual_qty))
      out[14] = cell(mark?.actual_reason)
    }
    out[18] = cell(mark?.note)
    out[19] = cell(r.customer_note)
    out[20] = cell(r.gp_note || p.note)
    rowsOut.push(out)
    fills[i] = { row: mark?.fill, cells: mapCellFills(mark?.cell_fills, CELL) }
    bold[i] = group
  })
  const T = ids.length + 2
  const total = []
  total[2] = cell('ИТОГО')
  for (const [col, c, key] of SUM_COLS) total[c] = cell(ctx.total?.[key], `SUBTOTAL(9,${col}2:${col}${T - 1})`)
  rowsOut.push(total)
  bold[ids.length] = true
  return { rows: rowsOut, fills, bold, red }
}

function mapCellFills(cf, map) {
  if (!cf) return null
  const out = {}
  for (const [key, color] of Object.entries(cf)) if (key in map) out[map[key]] = color
  return Object.keys(out).length ? out : null
}

export async function buildEstimateWorkbook(ctx, { ids, scopeLabel = '' } = {}) {
  const mod = await import('xlsx-js-style')
  const XLSX = mod.utils ? mod : mod.default
  return buildWith(XLSX, ctx, { ids, scopeLabel })
}

export function buildWith(XLSX, ctx, { ids, scopeLabel = '' }) {
  const wb = XLSX.utils.book_new()
  const e = estimateSheetRows(ctx, ids)
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
    headers: ESTIMATE_HEAD, rows: e.rows, fills: e.fills, bold: e.bold, red: e.red, wrap: [14, 17, 18, 19, 20],
    numFmt: { 4: QTY, 5: MONEY, 6: MONEY, 7: MONEY, 8: MONEY, 9: MONEY, 10: MONEY, 11: MONEY, 12: MONEY, 13: QTY, 15: QTY, 16: QTY },
    widths: [10, 8, 80, 7, 12, 16, 16, 18, 13, 18, 16, 16, 16, 12, 26, 12, 12, 34, 34, 24, 24],
  }), 'Смета')

  const rows = []
  for (const id of ids) {
    const r = ctx.tree.byId.get(id)
    const price = unitPrice(r)
    for (const a of ctx.allocsByRow.get(id) || []) {
      const R = rows.length + 2
      const q = allocQty(a)
      rows.push([cell(r.code || r.pos_no), cell(r.name), cell(r.unit), cell(a.tender_label), cell(a.counterparty_name), cell(q),
        cell(price || null), cell(q * price, `F${R}*G${R}`), cell([a.note, a.contract_label].filter(Boolean).join('; ')),
        cell(a.updated_by_name || a.created_by_name), cell(a.updated_at ? new Date(a.updated_at).toLocaleString('ru-RU') : '')])
    }
  }
  XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
    headers: ['Код', 'Наименование', 'Ед.', 'Тендер', 'Подрядчик', 'Объём', 'Цена за ед., ₽', 'Сумма, ₽', 'Примечание', 'Изменил', 'Когда'],
    rows, numFmt: { 5: QTY, 6: MONEY, 7: MONEY }, wrap: [1, 8], widths: [12, 60, 7, 14, 34, 12, 14, 16, 30, 22, 18],
  }), 'Распределение')

  if (ctx.meta?.coefficients?.length) {
    const ws = XLSX.utils.aoa_to_sheet(ctx.meta.coefficients)
    ws['!cols'] = [{ wch: 40 }, { wch: 60 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(wb, ws, 'Коэффициенты')
  }
  const est = ctx.estimate || {}
  const lines = [...(ctx.meta?.passport || [])]
  lines.push([], ['Портал: версия загружена', [est.created_by_name, est.activated_at || est.created_at ? new Date(est.activated_at || est.created_at).toLocaleString('ru-RU') : ''].filter(Boolean).join(', ')],
    ['Портал: файлы', [...new Set([est.kp_file_name, est.pz_file_name].filter(Boolean))].join('; ')],
    ['Портал: выгрузка', `${new Date().toLocaleString('ru-RU')}${scopeLabel ? `, ${scopeLabel}` : ''}`],
    ['Как считается остаток', 'Объём — «Количество (ГП)» КП до перекидок (уточнённый — «Актуальный объём»). Свободно = актуальный объём − сумма распределений «тендер + подрядчик».'])
  const ws = XLSX.utils.aoa_to_sheet(lines)
  ws['!cols'] = [{ wch: 34 }, { wch: 110 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Паспорт')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}
