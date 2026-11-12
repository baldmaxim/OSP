// Выгрузка сметы КП / ПЗ в Excel: выбранные строки (или найденные, или вся смета) с формулами и заливкой.
//   • «КП» — столбцы файла КП (A–P): позиция — материалы = G×O, работы = G×P, итог = J+K; группа — SUBTOTAL(9, …) по
//     своим строкам; ИТОГО — SUBTOTAL. Справа — актуальный объём, разница (=Q−G), распределено, свободно (=Q−T), тендеры,
//     подрядчики, ответственный, примечание;
//   • «Смета» — столбцы сметы ПЗ (A–U) с её формулами: цена = итог / кол-во, «Забрано» = СУММЕСЛИ по «Освоению»,
//     остаток = P−S, статус; справа — отметки;
//   • «Освоение» — распределения в рублях (группа «тендер + договоры по нему» — одной строкой, как в остатке): так
//     «Забрано» сметы считает то же, что портал;
//   • «Распределение» — каждая строка распределения; «Коэффициенты» и «Паспорт» — как в загруженном файле.
// Заливка строки и ячеек переносится; xlsx-js-style грузится лениво. Сборка — чистая (tests/tender/kp-estimate.test.mjs).
import { allocationGroupKey, ancestorsOf, isPosition, originalQty, round2, unitPrice } from './kpEstimate.js'

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

// Код, который Excel хранит числом (7.4, 3791.1), — числом и в «Смете», и в «Освоении»: СУММЕСЛИ сравнивает их как есть.
const codeCell = (code) => (code !== '' && code !== null && code !== undefined && /^\d+(\.\d+)?$/.test(String(code)) && String(Number(code)) === String(code)
  ? { t: 'n', v: Number(code) } : cell(code))

function tendersText(state) {
  return (state?.groups || []).filter((g) => g.tender_id || g.tender_label).map((g) => `${g.tender_label || 'тендер'}: ${g.pzQty}`).join('; ')
}
function contractorsText(allocs) {
  return (allocs || []).filter((a) => a.counterparty_name || a.contract_label)
    .map((a) => [a.counterparty_name, a.contract_label, `закреплено ${Number(a.contract_qty) || 0}`].filter(Boolean).join(', ')).join('; ')
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
function sheetFrom(XLSX, { headers, rows, widths, fills = [], bold = [], numFmt = {}, autofilter = true, red = [] }) {
  const ws = {}
  const put = (r, c, value) => {
    const ref = XLSX.utils.encode_cell({ r, c })
    if (!value) { ws[ref] = { t: 's', v: '' } } else ws[ref] = value
    return ws[ref]
  }
  headers.forEach((h, c) => { put(0, c, { t: 's', v: h }).s = HEAD })
  rows.forEach((row, i) => {
    const r = i + 1
    for (let c = 0; c < headers.length; c++) {
      const value = row[c]
      const ref = put(r, c, value)
      const style = { border: borders, alignment: { vertical: 'top', wrapText: c === 2 || c === 4 } }
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
  if (autofilter) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) }
  ws['!freeze'] = { xSplit: 3, ySplit: 1 }
  return ws
}

const MONEY = '#,##0.00'
const QTY = '#,##0.####'

// ── КП ──────────────────────────────────────────────────────────────────────
const KP_HEAD = ['Номер раздела', 'Номер позиции', 'Название', 'Примечание Заказчика', 'Примечание ГП', 'Единица', 'Количество (ГП)',
  'Кол-во Заказчика', 'Базовая стоимость', 'Итого материалов (КП), руб', 'Итого работ (КП), руб', 'Коммерческая стоимость',
  'За единицу (база)', 'За единицу (коммерч.)', 'За единицу материалов', 'За единицу работ',
  'Актуальный объём', 'Разница объёма', 'Причина изменения', 'Распределено (объём)', 'Свободно (объём)', 'Тендеры (объём в ПЗ)',
  'Подрядчики и договоры', 'Ответственный', 'Примечание экономиста']
// Столбец таблицы портала → столбец листа (для заливки ячеек).
const KP_CELL = { code: 0, name: 2, unit: 5, qty_gp: 6, qty_customer: 7, materials: 9, works: 10, total: 11, price: 13, actual: 16, diff: 17, distributed: 19, free: 20, tenders: 21, contractors: 22, responsible: 23, note: 24 }

function kpSheetRows(ctx, ids) {
  const { tree, marks, allocsByRow, states } = ctx
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
    const R = i + 2
    const mark = marks.get(id)
    const s = states.get(id)
    const group = tree.children.has(id)
    const out = []
    out[0] = cell(r.code)
    out[1] = cell(r.pos_no && Number.isFinite(Number(r.pos_no)) ? Number(r.pos_no) : r.pos_no)
    out[2] = cell(r.name)
    out[3] = cell(r.customer_note)
    out[4] = cell(r.gp_note)
    out[5] = cell(r.unit)
    out[6] = cell(n(k.qty_gp))
    out[7] = cell(n(k.qty_customer))
    out[8] = cell(n(k.base))
    if (group) {
      const last = lastOf.get(id)
      const range = (c) => (last > R ? `SUBTOTAL(9,${c}${R + 1}:${c}${last})` : null)
      out[9] = range('J') ? cell(k.materials ?? ctx.sums.get(id)?.materials, range('J')) : cell(n(k.materials))
      out[10] = range('K') ? cell(k.works ?? ctx.sums.get(id)?.works, range('K')) : cell(n(k.works))
      out[11] = range('L') ? cell(k.total ?? ctx.sums.get(id)?.total, range('L')) : cell(n(k.total))
    } else if (r.unit && (k.unit_materials !== null && k.unit_materials !== undefined)) {
      out[9] = cell(k.materials, `G${R}*O${R}`)
      out[10] = cell(k.works, `G${R}*P${R}`)
      out[11] = cell(k.total, `J${R}+K${R}`)
    } else {
      out[9] = cell(n(k.materials))
      out[10] = cell(n(k.works))
      out[11] = r.unit ? cell(k.total, `J${R}+K${R}`) : cell(n(k.total))
    }
    out[12] = cell(n(k.unit_base))
    out[13] = cell(n(k.unit_commercial))
    out[14] = cell(n(k.unit_materials))
    out[15] = cell(n(k.unit_works))
    if (isPosition(r) && s) {
      out[16] = cell(s.actual)
      out[17] = cell(s.diff, `Q${R}-G${R}`)
      out[18] = cell(mark?.actual_reason)
      out[19] = cell(s.distributed)
      out[20] = cell(s.free, `Q${R}-T${R}`)
      out[21] = cell(tendersText(s))
      out[22] = cell(contractorsText(allocsByRow.get(id)))
      if (s.status === 'over') red[i] = [20]
    } else if (r.kind === 'aggregate' && mark?.actual_qty !== null && mark?.actual_qty !== undefined) {
      out[16] = cell(Number(mark.actual_qty))
      out[17] = cell(Number(mark.actual_qty) - originalQty(r), `Q${R}-G${R}`)
      out[18] = cell(mark?.actual_reason)
    }
    out[23] = cell(mark?.responsible_name)
    out[24] = cell(mark?.note)
    rowsOut.push(out)
    fills[i] = { row: mark?.fill, cells: mapCellFills(mark?.cell_fills, KP_CELL) }
    bold[i] = group
  })
  const T = ids.length + 2
  const total = []
  total[2] = cell('ИТОГО')
  total[9] = cell(ctx.total?.materials, `SUBTOTAL(9,J2:J${T - 1})`)
  total[10] = cell(ctx.total?.works, `SUBTOTAL(9,K2:K${T - 1})`)
  total[11] = cell(ctx.total?.total, `SUBTOTAL(9,L2:L${T - 1})`)
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

// ── Смета (ПЗ) ──────────────────────────────────────────────────────────────
const PZ_HEAD = ['Код', '№ п/п', 'Код раздела', 'Раздел', 'Наименование', 'Примечание', 'Ед. изм.', 'Кол-во заказчика', 'Кол-во ГП',
  'Прямые затраты', 'Прямые: основные материалы', 'Прямые: вспом. материалы', 'Прямые: работы', 'Коммерция: материалы',
  'Коммерция: работы', 'Коммерция итого', 'Цена за ед. коммерч.', 'НДС', 'Забрано', 'Остаток', 'Статус',
  'Актуальный объём', 'Разница объёма', 'Причина изменения', 'Распределено (объём)', 'Свободно (объём)', 'Тендеры (объём в ПЗ)',
  'Подрядчики и договоры', 'Ответственный', 'Примечание экономиста']
const PZ_CELL = { code: 0, name: 4, unit: 6, qty_gp: 8, direct: 9, direct_main: 10, direct_aux: 11, direct_works: 12, comm_materials: 13, comm_works: 14, comm_total: 15, price: 16, taken: 18, rest: 19, status: 20, actual: 21, diff: 22, distributed: 24, free: 25, tenders: 26, contractors: 27, responsible: 28, note: 29 }

const pzCode = (r) => r.pz?.code ?? r.code ?? r.pos_no ?? ''

function sectionOf(ctx, r) {
  const code = r.pz?.section_code
  if (code && ctx.meta?.pz_sections?.[code]) return { code, name: ctx.meta.pz_sections[code] }
  const top = ancestorsOf(ctx.tree, r.id).pop()
  const root = top ? ctx.tree.byId.get(top) : null
  return { code: code || root?.code || '', name: root?.name || code || '' }
}

function pzSheetRows(ctx, ids) {
  const { tree, marks, allocsByRow, states } = ctx
  const list = ids.map((id) => tree.byId.get(id)).filter((r) => r.pz)
  const rows = []
  const fills = []
  const red = []
  list.forEach((r, i) => {
    const R = i + 2
    const p = r.pz
    const mark = marks.get(r.id)
    const s = states.get(r.id)
    const sec = sectionOf(ctx, r)
    const code = pzCode(r)
    const out = []
    out[0] = codeCell(code)
    out[1] = cell(r.pos_no && Number.isFinite(Number(r.pos_no)) ? Number(r.pos_no) : (p.pos ?? r.pos_no))
    out[2] = codeCell(sec.code)
    out[3] = cell(sec.name)
    out[4] = cell(r.name)
    out[5] = cell(p.note)
    out[6] = cell(r.unit)
    out[7] = cell(n(p.qty_customer ?? r.kp?.qty_customer))
    out[8] = cell(n(p.qty_gp ?? r.kp?.qty_gp))
    out[9] = cell(n(p.direct))
    out[10] = cell(n(p.direct_main))
    out[11] = cell(n(p.direct_aux))
    out[12] = cell(n(p.direct_works))
    out[13] = cell(n(p.comm_materials))
    out[14] = cell(n(p.comm_works))
    out[15] = cell(n(p.comm_total))
    out[16] = cell(unitPrice(r), `IF(I${R}<>0,P${R}/I${R},IF(H${R}<>0,P${R}/H${R},""))`)
    out[17] = cell(p.vat || ctx.meta?.vat || '')
    out[18] = cell(s?.distributedMoney || 0, `SUMIF(Освоение!C:C,A${R},Освоение!F:F)`)
    out[19] = cell((n(p.comm_total) || 0) - (s?.distributedMoney || 0), `P${R}-S${R}`)
    out[20] = { t: 's', v: !s?.distributedMoney ? 'не начато' : ((n(p.comm_total) || 0) - s.distributedMoney > 0.5 ? 'частично' : 'выбрано'), f: `IF(S${R}=0,"не начато",IF(T${R}>0.5,"частично","выбрано"))` }
    if (s) {
      out[21] = cell(s.actual)
      out[22] = cell(s.diff, `V${R}-I${R}`)
      out[23] = cell(mark?.actual_reason)
      out[24] = cell(s.distributed)
      out[25] = cell(s.free, `V${R}-Y${R}`)
      out[26] = cell(tendersText(s))
      out[27] = cell(contractorsText(allocsByRow.get(r.id)))
      if (s.status === 'over') red[i] = [19, 25]
    }
    out[28] = cell(mark?.responsible_name)
    out[29] = cell(mark?.note)
    rows.push(out)
    fills[i] = { row: mark?.fill, cells: mapCellFills(mark?.cell_fills, PZ_CELL) }
  })
  return { rows, fills, red, list }
}

// «Освоение»: на позицию — строка на группу распределения (тендер с договорами по нему; договор без тендера).
export function masteringRows(ctx, rowsList) {
  const out = []
  for (const r of rowsList) {
    const s = ctx.states.get(r.id)
    if (!s?.groups?.length) continue
    const price = unitPrice(r)
    const allocs = ctx.allocsByRow.get(r.id) || []
    for (const g of s.groups) {
      const items = allocs.filter((a) => allocationGroupKey(a) === g.key)
      const doc = [g.tender_label, ...items.map((a) => [a.counterparty_name, a.contract_label].filter(Boolean).join(' ')).filter(Boolean)].filter(Boolean).join('; ')
      const date = items.map((a) => a.updated_at || a.created_at).filter(Boolean).sort().pop()
      out.push({
        date: date ? new Date(date).toLocaleDateString('ru-RU') : '',
        sectionCode: r.pz?.section_code || '',
        code: pzCode(r),
        name: r.name,
        document: doc,
        sum: round2(g.volume * price),
        comment: [`объём ${g.volume} ${r.unit || ''}`.trim(), ...items.map((a) => a.note).filter(Boolean)].join('; '),
      })
    }
  }
  return out
}

export async function buildEstimateWorkbook(ctx, { ids, sheets = { kp: true, pz: true, mastering: true, allocations: true, coefficients: true, passport: true }, scopeLabel = '' } = {}) {
  const mod = await import('xlsx-js-style')
  const XLSX = mod.utils ? mod : mod.default
  return buildWith(XLSX, ctx, { ids, sheets, scopeLabel })
}

export function buildWith(XLSX, ctx, { ids, sheets, scopeLabel = '' }) {
  const wb = XLSX.utils.book_new()
  const kpNum = { 6: QTY, 7: QTY, 8: MONEY, 9: MONEY, 10: MONEY, 11: MONEY, 12: MONEY, 13: MONEY, 14: MONEY, 15: MONEY, 16: QTY, 17: QTY, 19: QTY, 20: QTY }
  if (sheets.kp) {
    const k = kpSheetRows(ctx, ids)
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
      headers: KP_HEAD, rows: k.rows, fills: k.fills, bold: k.bold, red: k.red, numFmt: kpNum,
      widths: [10, 9, 60, 24, 24, 8, 12, 12, 16, 16, 16, 18, 12, 12, 12, 12, 12, 12, 26, 12, 12, 26, 34, 20, 34],
    }), 'КП')
  }
  const pz = pzSheetRows(ctx, ids)
  if (sheets.pz && pz.list.length) {
    const pzNum = { 7: QTY, 8: QTY, 9: MONEY, 10: MONEY, 11: MONEY, 12: MONEY, 13: MONEY, 14: MONEY, 15: MONEY, 16: MONEY, 18: MONEY, 19: MONEY, 21: QTY, 22: QTY, 24: QTY, 25: QTY }
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
      headers: PZ_HEAD, rows: pz.rows, fills: pz.fills, red: pz.red, numFmt: pzNum,
      widths: [12, 9, 10, 30, 60, 30, 8, 12, 12, 16, 16, 16, 16, 16, 16, 18, 14, 7, 16, 16, 12, 12, 12, 26, 12, 12, 26, 34, 20, 34],
    }), 'Смета')
  }
  if (sheets.mastering || (sheets.pz && pz.list.length)) {
    // Без «Освоения» формулы «Забрано» сметы ссылались бы в пустоту — лист есть всегда, когда есть смета.
    const m = masteringRows(ctx, pz.list.length ? pz.list : ids.map((id) => ctx.tree.byId.get(id)).filter(isPosition))
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
      headers: ['Дата', 'Код раздела', 'Код позиции', 'Наименование', 'Документ', 'Сумма', 'Комментарий'],
      rows: m.map((x) => [cell(x.date), codeCell(x.sectionCode), codeCell(x.code), cell(x.name), cell(x.document), cell(x.sum), cell(x.comment)]),
      numFmt: { 5: MONEY }, widths: [11, 11, 14, 50, 40, 16, 40],
    }), 'Освоение')
  }
  if (sheets.allocations) {
    const rows = []
    for (const id of ids) {
      const r = ctx.tree.byId.get(id)
      for (const a of ctx.allocsByRow.get(id) || []) {
        rows.push([cell(r.code || r.pos_no), cell(r.name), cell(r.unit), cell(a.tender_label), cell(n(a.pz_qty)), cell(a.counterparty_name), cell(a.contract_label),
          cell(n(a.contract_qty)), cell(a.note), cell(a.updated_by_name || a.created_by_name), cell(a.updated_at ? new Date(a.updated_at).toLocaleString('ru-RU') : '')])
      }
    }
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, {
      headers: ['Код', 'Наименование', 'Ед.', 'Тендер', 'Объём в расчёте ПЗ', 'Подрядчик', 'Договор', 'Закреплённый объём', 'Примечание', 'Изменил', 'Когда'],
      rows, numFmt: { 4: QTY, 7: QTY }, widths: [12, 60, 8, 16, 14, 34, 28, 14, 34, 22, 18],
    }), 'Распределение')
  }
  if (sheets.coefficients && ctx.meta?.coefficients?.length) {
    const ws = XLSX.utils.aoa_to_sheet(ctx.meta.coefficients)
    ws['!cols'] = [{ wch: 40 }, { wch: 60 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(wb, ws, 'Коэффициенты')
  }
  if (sheets.passport) {
    const est = ctx.estimate || {}
    const lines = [...(ctx.meta?.passport || [])]
    lines.push([], ['Портал: версия загружена', [est.created_by_name, est.activated_at || est.created_at ? new Date(est.activated_at || est.created_at).toLocaleString('ru-RU') : ''].filter(Boolean).join(', ')],
      ['Портал: файлы', [est.kp_file_name, est.pz_file_name].filter(Boolean).join('; ')],
      ['Портал: выгрузка', `${new Date().toLocaleString('ru-RU')}${scopeLabel ? `, ${scopeLabel}` : ''}`],
      ['Как считается остаток', 'Свободно = актуальный объём − распределённый. Объём тендера и договоры по нему — один объём (учитывается по большему из двух).'])
    const ws = XLSX.utils.aoa_to_sheet(lines)
    ws['!cols'] = [{ wch: 34 }, { wch: 110 }]
    XLSX.utils.book_append_sheet(wb, ws, 'Паспорт')
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}
